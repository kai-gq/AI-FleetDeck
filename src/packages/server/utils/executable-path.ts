/**
 * Cross-platform "is this CLI on PATH?" resolution.
 *
 * Written for the runtime-availability probe (GET /api/runtimes): it must
 * answer "installed or not" reliably on any user machine — Windows included,
 * where `which` does not exist and cmd resolves bare names with PATHEXT
 * extensions (.exe, .cmd, …) that a plain fs check would miss. The existing
 * helper in test-runner-service.ts is POSIX-only (X_OK, no file check) and
 * stays untouched; this one is deliberately a superset:
 *
 *   - Windows: exact name first, then one candidate per PATHEXT entry
 *     (builtin default .COM;.EXE;.BAT;.CMD when PATHEXT is unset), and a
 *     `where.exe` last resort — it applies the same lookup rules cmd does,
 *     including AppX execution aliases.
 *   - Unix: the file must exist *and* be executable (X_OK); a directory with
 *     the same name is skipped.
 *
 * The function NEVER throws: callers treat "unresolved" as unknown, never as
 * an error. Both platform branches are testable on any host by injecting
 * `platform`, `pathValue`, `pathext`, `probe` and `whichFallback`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProbeResult = 'file' | 'dir' | 'missing' | 'not-executable';

export interface PathScanDeps {
  platform?: NodeJS.Platform;
  /** PATH value to search; defaults to process.env.PATH. */
  pathValue?: string;
  /** Windows PATHEXT; defaults to process.env.PATHEXT, else cmd's builtin list. */
  pathext?: string;
  /** Defaults to fs stat/access. Tests inject to assert candidate order. */
  probe?: (candidate: string, platform: NodeJS.Platform) => ProbeResult;
  /** Windows-only fallback on a full miss; inject `() => null` in tests. */
  whichFallback?: (name: string) => string | null;
}

/** True for names that carry a path (separators or a drive prefix). */
export function isPathLike(value: string): boolean {
  return /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
}

function defaultProbe(candidate: string, platform: NodeJS.Platform): ProbeResult {
  try {
    if (!fs.statSync(candidate).isFile()) return 'dir';
    // On Windows cmd decides runnability by extension, not mode bits.
    if (platform === 'win32') return 'file';
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return 'file';
    } catch {
      return 'not-executable';
    }
  } catch {
    return 'missing';
  }
}

function defaultWhichFallback(name: string): string | null {
  try {
    const out = execFileSync('where', [name], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* listed but not a file — keep looking */
      }
    }
  } catch {
    /* where.exe missing or nothing found */
  }
  return null;
}

function parseExtensions(pathext: string | undefined): string[] {
  const raw = pathext?.trim();
  if (!raw) return ['.COM', '.EXE', '.BAT', '.CMD']; // cmd.exe's builtin default
  return raw.split(';');
}

function candidatesInDir(
  dir: string,
  base: string,
  platform: NodeJS.Platform,
  pathext: string | undefined,
  scandir: typeof path.win32
): string[] {
  const exact = scandir.join(dir, base);
  if (platform !== 'win32') return [exact];
  const exts = parseExtensions(pathext).filter(Boolean);
  // A name that already carries a known extension is used verbatim by cmd.
  const lower = base.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) return [exact];
  // Exact name first (covers extensionless shims), then one candidate per
  // PATHEXT entry — a superset of what cmd would try, biased toward finding.
  return [exact, ...exts.map((ext) => scandir.join(dir, base + ext))];
}

/**
 * Resolve an executable on PATH (or a path-like name as-is). Returns the
 * first candidate that matches, or null. Never throws.
 */
export function resolveExecutableOnPath(name: string, deps: PathScanDeps = {}): string | null {
  try {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;

    const platform = deps.platform ?? process.platform;
    const scandir = platform === 'win32' ? path.win32 : path.posix;
    const probe = deps.probe ?? defaultProbe;

    let dirs: string[];
    let base: string;
    if (isPathLike(trimmed)) {
      // A path resolves in its own directory, with the same extension probing.
      dirs = [scandir.dirname(trimmed)];
      base = scandir.basename(trimmed);
    } else {
      const separator = platform === 'win32' ? ';' : ':';
      const pathValue = deps.pathValue ?? process.env.PATH ?? '';
      const seen = new Set<string>();
      dirs = [];
      for (const raw of pathValue.split(separator)) {
        // An empty entry means "current directory" (POSIX execvp and cmd agree).
        const dir = raw.trim() || '.';
        if (seen.has(dir)) continue;
        seen.add(dir);
        dirs.push(dir);
      }
      base = trimmed;
    }

    for (const dir of dirs) {
      for (const candidate of candidatesInDir(dir, base, platform, deps.pathext, scandir)) {
        try {
          if (probe(candidate, platform) === 'file') return candidate;
        } catch {
          /* injected probe blew up — keep looking, never throw */
        }
      }
    }

    if (platform === 'win32') {
      const fallback = deps.whichFallback ?? defaultWhichFallback;
      try {
        const found = fallback(base);
        if (found) return found;
      } catch {
        /* never throw */
      }
    }
    return null;
  } catch {
    return null;
  }
}
