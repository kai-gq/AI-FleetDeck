/**
 * 路径解析与缓存(回退查找、区域目录、后缀遍历、node_modules 锚点)。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, resolveAndValidateFilePath } from './fs-utils.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { loadAreas } from '../../data/index.js';
import { diagnoseMissingFile } from '../../services/file-recovery.js';

// Cache of (requested path → resolved absolute path) for successful fallback
// resolutions. Avoids repeating the walk-up search for the same stale path.
const resolvedPathCache = new Map<string, { path: string; strategy: ResolutionStrategy }>();

const RESOLVED_CACHE_MAX = 500;

function rememberResolution(key: string, found: string, strategy: ResolutionStrategy): void {
  if (resolvedPathCache.size >= RESOLVED_CACHE_MAX) {
    const firstKey = resolvedPathCache.keys().next().value;
    if (firstKey !== undefined) resolvedPathCache.delete(firstKey);
  }
  resolvedPathCache.set(key, { path: found, strategy });
}

export type ResolutionStrategy =
  | 'exact'
  | 'cached'
  | 'parent-walk'
  | 'git-root'
  | 'suffix-match'
  | 'node-modules-match'
  | 'area-root'
  | 'area-suffix-match'
  | 'child-anchor';

interface AreaDir { areaId: string; areaName: string; dir: string }

const AREA_DIR_TTL_MS = 30_000;

const AREA_DIR_MAX_AREAS = 5;

const AREA_DIR_MAX_PER_AREA = 10;

let areaDirCache: { entries: AreaDir[]; expiresAt: number } | null = null;

export function _resetAreaDirCacheForTests(): void {
  areaDirCache = null;
}

// Test seam: lets unit tests inject a deterministic area list without writing
// to ~/.local/share/tide-commander/areas.json. Production code uses loadAreas().
let areaLoaderForTests: (() => Array<{ id: string; name: string; directories?: string[] }>) | null = null;

export function _setAreaLoaderForTests(fn: typeof areaLoaderForTests): void {
  areaLoaderForTests = fn;
  areaDirCache = null;
}

function getAreaDirs(now: number = Date.now()): AreaDir[] {
  if (areaDirCache && areaDirCache.expiresAt > now) return areaDirCache.entries;
  const entries: AreaDir[] = [];
  let areas: Array<{ id: string; name: string; directories?: string[] }>;
  try {
    areas = areaLoaderForTests ? areaLoaderForTests() : loadAreas();
  } catch { areas = []; }
  let areaCount = 0;
  for (const area of areas) {
    if (areaCount >= AREA_DIR_MAX_AREAS) break;
    const dirs = Array.isArray(area.directories) ? area.directories : [];
    let perArea = 0;
    for (const raw of dirs) {
      if (perArea >= AREA_DIR_MAX_PER_AREA) break;
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const abs = path.isAbsolute(raw) ? raw : null;
      if (!abs) continue;
      entries.push({ areaId: area.id, areaName: area.name, dir: abs.replace(/\/+$/, '') });
      perArea++;
    }
    if (perArea > 0) areaCount++;
  }
  areaDirCache = { entries, expiresAt: now + AREA_DIR_TTL_MS };
  return entries;
}

// Recursive-walk cache for suffix-match: rooted at an absolute directory, value
// is the flat list of file absolute paths under that root. TTL keeps it warm
// across rapid clicks but lets edits propagate. Keys evict on TTL only — small
// LRU cap as a memory ceiling.
const SUFFIX_WALK_TTL_MS = 30_000;

const SUFFIX_WALK_MAX_ROOTS = 16;

const SUFFIX_WALK_MAX_DEPTH = 6;

const SUFFIX_WALK_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'target',
  '.cache', '.turbo', '.venv', '__pycache__',
]);

interface SuffixWalkEntry { files: string[]; expiresAt: number }

const suffixWalkCache = new Map<string, SuffixWalkEntry>();

export function _resetSuffixWalkCacheForTests(): void {
  suffixWalkCache.clear();
}

// Accumulates into ONE array. The previous `out.push(...listFilesShallow(child))`
// spread a whole subtree as call arguments, which throws "Maximum call stack
// size exceeded" on a workspace-sized tree (~480k files under ~/d) — the
// caller's try/catch swallowed it and suffix-match silently never matched.
function listFilesShallow(root: string, depth: number, out: string[] = []): string[] {
  if (depth > SUFFIX_WALK_MAX_DEPTH) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { return out; }
  for (const e of entries) {
    if (SUFFIX_WALK_IGNORE.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      listFilesShallow(full, depth + 1, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function getWalkedFiles(root: string, now: number = Date.now()): string[] {
  const cached = suffixWalkCache.get(root);
  if (cached && cached.expiresAt > now) return cached.files;
  const files = listFilesShallow(root, 0);
  if (suffixWalkCache.size >= SUFFIX_WALK_MAX_ROOTS) {
    const firstKey = suffixWalkCache.keys().next().value;
    if (firstKey !== undefined) suffixWalkCache.delete(firstKey);
  }
  suffixWalkCache.set(root, { files, expiresAt: now + SUFFIX_WALK_TTL_MS });
  return files;
}

function findBySuffixMatch(rawPath: string, walkRoot: string): string | null {
  const segments = rawPath.replace(/^\/+/, '').split(path.sep).filter(Boolean);
  if (segments.length === 0) return null;
  const files = getWalkedFiles(walkRoot);
  if (files.length === 0) return null;

  // Try the longest possible suffix first (most specific), shrinking down to
  // basename. The first suffix length with a UNIQUE hit wins — ambiguous suffix
  // means we'd guess wrong, so fall through.
  for (let take = Math.min(segments.length, 4); take >= 1; take--) {
    const suffix = path.sep + segments.slice(-take).join(path.sep);
    const matches = files.filter(f => f.endsWith(suffix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) continue;
  }
  return null;
}

// The suffix walk skips node_modules for cost, but locally linked / installed
// packages (e.g. a monorepo's own `tide-api`) legitimately live there — so a
// path like `tide-api/src/api-core.js` can only be found under a node_modules
// tree. Instead of walking all of node_modules (huge), we locate WHERE the
// node_modules dirs are (shallow — they sit at workspace roots, and we never
// descend INTO one) and then probe the requested path's tail-slices under each.
const NODE_MODULES_SCAN_MAX_DEPTH = 4;

const NODE_MODULES_MAX_DIRS = 24;

function collectNodeModulesDirs(base: string, depth: number, out: string[]): void {
  if (out.length >= NODE_MODULES_MAX_DIRS || depth > NODE_MODULES_SCAN_MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'node_modules') {
      out.push(path.join(base, e.name));
      if (out.length >= NODE_MODULES_MAX_DIRS) return;
      continue; // don't recurse into node_modules; tail-slice probing covers depth
    }
    if (e.name.startsWith('.') || SUFFIX_WALK_IGNORE.has(e.name)) continue;
    collectNodeModulesDirs(path.join(base, e.name), depth + 1, out);
    if (out.length >= NODE_MODULES_MAX_DIRS) return;
  }
}

// Probe the requested path (and each of its tail-slices) under every
// node_modules dir found beneath `base`. Uses the shared tryCandidate so hits
// are validated + recorded in `tried`. Returns the first existing file.
function findInNodeModules(
  rawPath: string,
  base: string,
  tryCandidate: (p: string) => string | null,
): string | null {
  if (!fs.existsSync(base)) return null;
  const segments = rawPath.replace(/^\/+/, '').split(path.sep).filter(Boolean);
  if (segments.length === 0) return null;
  const dirs: string[] = [];
  collectNodeModulesDirs(base, 0, dirs);
  for (const nm of dirs) {
    for (let i = 0; i < segments.length; i++) {
      const hit = tryCandidate(path.join(nm, ...segments.slice(i)));
      if (hit) return hit;
    }
  }
  return null;
}

// Workspace folders: an agent running in `~/d` cites `apps/agent/src/x.ts`
// meaning `~/d/<some-repo>/apps/agent/src/x.ts`. Instead of walking the whole
// workspace, anchor the relative part under each child (then grandchild)
// directory — a few hundred existsSync calls. Several hits (the repo plus
// scratch copies of it) resolve to the SHALLOWEST, then most recently modified.
const CHILD_ANCHOR_MAX_DIRS_PER_LEVEL = 400;

function listChildDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SUFFIX_WALK_IGNORE.has(e.name))
      .slice(0, CHILD_ANCHOR_MAX_DIRS_PER_LEVEL)
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function findByChildAnchor(relPath: string, base: string, tryCandidate: (p: string) => string | null): string | null {
  const rel = relPath.replace(/^\.?\/+/, '');
  // A bare basename is too ambiguous to anchor anywhere.
  if (!rel || !rel.includes('/')) return null;
  let level = listChildDirs(base);
  for (let depth = 1; depth <= 2 && level.length > 0; depth++) {
    const hits: Array<{ path: string; mtime: number }> = [];
    for (const dir of level) {
      const hit = tryCandidate(path.join(dir, rel));
      if (hit) {
        let mtime = 0;
        try { mtime = fs.statSync(hit).mtimeMs; } catch { /* raced away */ }
        hits.push({ path: hit, mtime });
      }
    }
    if (hits.length > 0) {
      hits.sort((a, b) => b.mtime - a.mtime);
      return hits[0].path;
    }
    if (depth === 1) {
      const next: string[] = [];
      for (const dir of level) {
        for (const child of listChildDirs(dir)) {
          next.push(child);
          if (next.length >= CHILD_ANCHOR_MAX_DIRS_PER_LEVEL * 4) break;
        }
        if (next.length >= CHILD_ANCHOR_MAX_DIRS_PER_LEVEL * 4) break;
      }
      level = next;
    }
  }
  return null;
}

/**
 * Resolve a requested file path to an existing file on disk, with fallbacks.
 * Tries (in order):
 *   1. exact              — resolved by resolveAndValidateFilePath() (absolute or baseDir+path)
 *   2. cached             — previously-resolved entry for the same requested key
 *   3. parent-walk        — tail slices anchored at baseDir AND each ancestor up to /
 *   4. git-root           — tail slices anchored at the git toplevel from baseDir
 *   4b. child-anchor      — the path relative to baseDir, anchored under baseDir's
 *                           child/grandchild dirs (agent cwd = a workspace folder)
 *   5. suffix-match       — depth-limited walk of baseDir, unique trailing-segment match
 *   6. node-modules-match — tail slices probed under each node_modules dir beneath baseDir
 *   7. area-root          — verbatim join against each user-configured area directory
 *   8. area-suffix-match  — same depth-limited walk but rooted at each area directory
 *   9. node-modules-match — same node_modules probe but rooted at each area directory
 * On miss, returns the absolute path requested AND the list of paths tried so
 * the caller can surface a clear, debuggable error.
 */
export function findFileWithFallbacks(
  rawPath: string | undefined,
  baseDir: string | undefined,
  /**
   * `cheap`: only strategies that cost a bounded number of stat calls (no git
   * subprocess, no directory walks). Used by the chip existence check, which
   * runs for every visible file reference every few seconds.
   */
  options: { cheap?: boolean } = {},
):
  | { ok: true; path: string; strategy: ResolutionStrategy; areaId?: string; areaName?: string }
  | { ok: false; status: number; error: string; requested?: string; tried?: string[] } {
  if (!rawPath) {
    return { ok: false, status: 400, error: 'Missing path parameter' };
  }
  const resolution = resolveAndValidateFilePath(rawPath, baseDir);
  if (!resolution.ok) {
    return resolution;
  }

  // A path that resolves directly to an existing directory is a "browse this
  // folder" request, not a missing file. Short-circuit here so we return a
  // clear directory signal instead of running the whole fallback walk — which
  // rejects the directory at every candidate (tryCandidate skips directories)
  // and would surface dozens of futile "tried" locations before 404-ing.
  try {
    if (fs.existsSync(resolution.path) && fs.statSync(resolution.path).isDirectory()) {
      return { ok: false, status: 400, error: 'Path is a directory', requested: resolution.path };
    }
  } catch { /* stat failed (perms/broken symlink) — fall through to normal resolution */ }

  const tried: string[] = [];
  const seen = new Set<string>();
  const tryCandidate = (p: string): string | null => {
    if (seen.has(p)) return null;
    seen.add(p);
    tried.push(p);
    try {
      if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) return p;
    } catch { /* permission denied, broken symlink — keep trying */ }
    return null;
  };

  const direct = tryCandidate(resolution.path);
  if (direct) return { ok: true, path: direct, strategy: 'exact' };

  const cached = resolvedPathCache.get(rawPath);
  if (cached) {
    const hit = tryCandidate(cached.path);
    if (hit) return { ok: true, path: hit, strategy: 'cached' };
    resolvedPathCache.delete(rawPath);
  }

  const absBase = baseDir && path.isAbsolute(baseDir) ? baseDir : null;
  if (absBase) {
    // Strip leading slashes so absolute and relative requested paths share one
    // segment list. Walking the tail anchors `<a>/<b>/<c>` not just at baseDir
    // but also at `<b>/<c>` and `<c>` against each ancestor — the file is
    // found regardless of which slice of the path moved.
    const tailSegments = rawPath.replace(/^\/+/, '').split(path.sep).filter(Boolean);
    let cur = absBase;
    // Bound the climb so a deep baseDir doesn't search the whole filesystem.
    for (let depth = 0; depth < 12; depth++) {
      for (let i = 0; i < tailSegments.length; i++) {
        const candidate = path.join(cur, ...tailSegments.slice(i));
        const hit = tryCandidate(candidate);
        if (hit) {
          rememberResolution(rawPath, hit, 'parent-walk');
          return { ok: true, path: hit, strategy: 'parent-walk' };
        }
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    try {
      if (!options.cheap && fs.existsSync(absBase)) {
        const gitTop = execSync('git rev-parse --show-toplevel', {
          cwd: absBase,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (gitTop) {
          for (let i = 0; i < tailSegments.length; i++) {
            const candidate = path.join(gitTop, ...tailSegments.slice(i));
            const hit = tryCandidate(candidate);
            if (hit) {
              rememberResolution(rawPath, hit, 'git-root');
              return { ok: true, path: hit, strategy: 'git-root' };
            }
          }
        }
      }
    } catch { /* baseDir is not in a git repo — skip */ }

    // The part of the reference relative to baseDir (the client sends relative
    // references already joined onto the agent cwd).
    const normalizedBase = absBase.replace(/\/+$/, '');
    const relToBase = path.isAbsolute(rawPath)
      ? (rawPath.startsWith(`${normalizedBase}/`) ? rawPath.slice(normalizedBase.length + 1) : null)
      : rawPath;
    if (relToBase) {
      // Probed without recording each of the (up to ~2000) candidates in
      // `tried` — one marker keeps the 404 payload small.
      const probe = (p: string): string | null => {
        try {
          return fs.existsSync(p) && !fs.statSync(p).isDirectory() ? p : null;
        } catch {
          return null;
        }
      };
      tried.push(`<child-anchor under ${normalizedBase}>`);
      const anchorHit = findByChildAnchor(relToBase, normalizedBase, probe);
      if (anchorHit) {
        rememberResolution(rawPath, anchorHit, 'child-anchor');
        return { ok: true, path: anchorHit, strategy: 'child-anchor' };
      }
    }

    if (options.cheap) {
      return { ok: false, status: 404, error: 'File not found', requested: resolution.path, tried };
    }

    // Last-resort suffix match: cheap depth-limited recursive walk, cached for
    // 30s. Helps when the requested path's segments don't anchor anywhere via
    // parent-walk (e.g. file moved between dirs while UI still cites old path).
    try {
      if (fs.existsSync(absBase)) {
        const suffixHit = findBySuffixMatch(rawPath, absBase);
        if (suffixHit) {
          tried.push(`<suffix-match in ${absBase}>`);
          rememberResolution(rawPath, suffixHit, 'suffix-match');
          return { ok: true, path: suffixHit, strategy: 'suffix-match' };
        }
      }
    } catch { /* walk failed entirely — fall through to node_modules/area strategies */ }

    // node_modules-anchored: the suffix walk above skips node_modules, so a
    // locally-linked package path (e.g. tide-api/src/api-core.js) is only
    // reachable here.
    try {
      const nmHit = findInNodeModules(rawPath, absBase, tryCandidate);
      if (nmHit) {
        rememberResolution(rawPath, nmHit, 'node-modules-match');
        return { ok: true, path: nmHit, strategy: 'node-modules-match' };
      }
    } catch { /* scan failed — fall through to area strategies */ }
  }

  // Area strategies: try the user's configured area directories. Runs whether
  // or not baseDir is set — area paths are independent. Capped to keep cold
  // requests cheap (5 areas × 10 dirs).
  const areaDirs = options.cheap ? [] : getAreaDirs();
  const tailSegmentsForArea = rawPath.replace(/^\/+/, '').split(path.sep).filter(Boolean);

  for (const { areaId, areaName, dir } of areaDirs) {
    if (!fs.existsSync(dir)) continue;
    // area-root: try the requested path joined verbatim against the area dir,
    // plus every tail-slice (so partial-prefix paths still resolve).
    for (let i = 0; i < tailSegmentsForArea.length; i++) {
      const candidate = path.join(dir, ...tailSegmentsForArea.slice(i));
      const hit = tryCandidate(candidate);
      if (hit) {
        rememberResolution(rawPath, hit, 'area-root');
        return { ok: true, path: hit, strategy: 'area-root', areaId, areaName };
      }
    }
  }

  for (const { areaId, areaName, dir } of areaDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const suffixHit = findBySuffixMatch(rawPath, dir);
      if (suffixHit) {
        tried.push(`<area-suffix-match in ${dir}>`);
        rememberResolution(rawPath, suffixHit, 'area-suffix-match');
        return {
          ok: true,
          path: suffixHit,
          strategy: 'area-suffix-match',
          areaId,
          areaName,
        };
      }
    } catch { /* walk failed for this area — try next */ }
  }

  // node_modules-anchored search within each area dir (same reasoning as the
  // baseDir pass above: locally-linked packages under an area's node_modules).
  for (const { areaId, areaName, dir } of areaDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const nmHit = findInNodeModules(rawPath, dir, tryCandidate);
      if (nmHit) {
        rememberResolution(rawPath, nmHit, 'node-modules-match');
        return { ok: true, path: nmHit, strategy: 'node-modules-match', areaId, areaName };
      }
    } catch { /* scan failed for this area — try next */ }
  }

  return {
    ok: false,
    status: 404,
    error: 'File not found',
    requested: resolution.path,
    tried,
  };
}

/**
 * A 404 for an absolute path gets a diagnosis (deleted vs. folder gone, similar
 * names, git tracking) so the viewer can explain the miss instead of listing
 * every fallback location it probed.
 */
export function attachMissingDiagnosis(
  body: Record<string, unknown>,
  resolution: { status: number; requested?: string },
): void {
  if (resolution.status !== 404 || !resolution.requested || !path.isAbsolute(resolution.requested)) return;
  try {
    body.diagnosis = diagnoseMissingFile(resolution.requested);
  } catch (err) {
    log.warn(' Missing-file diagnosis failed:', err);
  }
}
