/**
 * 搜索路由:文件名与内容搜索(单区 + 跨区)。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, type TreeNode } from './fs-utils.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { DEFAULT_FILE_SEARCH_EXCLUDE_DIRS, parseExcludeDirNames } from '../../../shared/file-search.js';
import { searchFilesGlobal, searchFileContentsGlobal, FILE_SEARCH_MIN_QUERY, FILE_CONTENT_SEARCH_MIN_QUERY } from '../../services/global-file-search.js';

// Directories skipped during file/content search unless the request supplies
// `exclude`. Kept as a Set for O(1) lookups (checked once per directory entry).
const SEARCH_SKIP_DIRS = new Set<string>(DEFAULT_FILE_SEARCH_EXCLUDE_DIRS);

const MAX_SEARCH_DEPTH = 10;

/** Request `exclude` (comma list or repeated) overrides the default skip set. */
function skipDirsFromQuery(req: Request): Set<string> {
  if (req.query.exclude === undefined) return SEARCH_SKIP_DIRS;
  return new Set(parseExcludeDirNames(req.query.exclude));
}

// Helper function to search files recursively (async / non-blocking).
// Uses fs.promises so a deep tree walk never blocks the event loop, which
// matters on a shared multi-agent server. `queryLower` must be pre-lowercased.
export async function searchFilesAsync(
  dirPath: string,
  queryLower: string,
  results: TreeNode[],
  maxResults: number,
  depth: number = 0,
  skipDirs: Set<string> = SEARCH_SKIP_DIRS,
): Promise<void> {
  if (results.length >= maxResults || depth > MAX_SEARCH_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // Skip directories we can't read
  }

  const subdirs: string[] = [];

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    const isDir = entry.isDirectory();
    // Skip configured non-essential directories
    if (isDir && skipDirs.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);

    // Check if name matches query (case-insensitive)
    if (entry.name.toLowerCase().includes(queryLower)) {
      let size = 0;
      try {
        size = (await fs.promises.stat(fullPath)).size;
      } catch {
        // Keep size 0 if stat fails (broken symlink etc.) but still surface it
      }
      results.push({
        name: entry.name,
        path: fullPath,
        isDirectory: isDir,
        size,
        extension: isDir ? '' : path.extname(entry.name).toLowerCase(),
      });
    }

    if (isDir) subdirs.push(fullPath);
  }

  // Recurse after listing this level so match/recurse order stays bounded.
  for (const sub of subdirs) {
    if (results.length >= maxResults) break;
    await searchFilesAsync(sub, queryLower, results, maxResults, depth + 1, skipDirs);
  }
}

// GET /api/files/search - Search for files
export const handleGetSearch = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    const query = req.query.q as string;
    const maxResults = parseInt(req.query.limit as string) || 50;

    if (!dirPath || !query) {
      res.status(400).json({ error: 'Missing path or query parameter' });
      return;
    }

    if (!path.isAbsolute(dirPath)) {
      res.status(400).json({ error: 'Path must be absolute' });
      return;
    }

    if (!fs.existsSync(dirPath)) {
      res.status(404).json({ error: 'Directory not found' });
      return;
    }

    const results: TreeNode[] = [];
    await searchFilesAsync(dirPath, query.toLowerCase(), results, maxResults, 0, skipDirsFromQuery(req));

    // Sort: files first (more likely what user wants), then by name
    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json({ results });
  } catch (err: any) {
    log.error(' Failed to search files:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/search-global - Filename search across every area directory
export const handleGetSearchGlobal = async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (query.trim().length < FILE_SEARCH_MIN_QUERY) {
      res.json({ files: [] });
      return;
    }
    const limit = parseInt(String(req.query.limit ?? ''), 10);
    const files = await searchFilesGlobal({
      query,
      exclude: req.query.exclude,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    res.json({ files });
  } catch (err: any) {
    log.error(' Global file search failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/search-content-global - Content search across every area directory
export const handleGetSearchContentGlobal = async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (query.trim().length < FILE_CONTENT_SEARCH_MIN_QUERY) {
      res.json({ files: [] });
      return;
    }
    const limit = parseInt(String(req.query.limit ?? ''), 10);
    const files = await searchFileContentsGlobal({
      query,
      exclude: req.query.exclude,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    res.json({ files });
  } catch (err: any) {
    log.error(' Global file content search failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Content search result type
interface ContentMatch {
  path: string;
  name: string;
  extension: string;
  matches: {
    line: number;
    content: string;
    context?: { before: string; after: string };
  }[];
}

// Text file extensions for content search
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs',
  '.swift', '.kt', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml', '.fs',
  '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.gitignore', '.dockerignore',
  '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc',
  '.log', '.csv', '.tsv', '.svg', '.vue', '.svelte',
]);

// Max matches surfaced per file (both search paths respect this).
const MAX_MATCHES_PER_FILE = 5;

// Skip files larger than 1MB for content search.
const MAX_CONTENT_FILE_SIZE = 1024 * 1024;

// Primary content search: shell out to ripgrep. It runs off the event loop as
// a child process (never blocking the server) and is orders of magnitude faster
// than a JS tree walk. Resolves { ok:false } when rg is missing or errors, so
// the caller can fall back to the pure-JS walker.
function searchFileContentsRipgrep(
  dirPath: string,
  query: string,
  maxResults: number,
  skipDirs: Set<string> = SEARCH_SKIP_DIRS,
): Promise<{ ok: boolean; results: ContentMatch[] }> {
  return new Promise((resolve) => {
    const args = [
      '--json',
      '--ignore-case',
      '--fixed-strings',              // treat the query as a literal substring
      '--max-count', String(MAX_MATCHES_PER_FILE),
      '--max-filesize', String(MAX_CONTENT_FILE_SIZE),
      '--max-depth', String(MAX_SEARCH_DEPTH + 1),
      '--hidden',                     // include dotfiles (.env, .github, ...)
      '--no-ignore',                  // don't honor .gitignore (match old behavior)
      '--no-messages',                // suppress permission/binary warnings on stderr
      ...[...skipDirs].flatMap((d) => ['--glob', `!**/${d}/**`]),
      '--',
      query,
      dirPath,
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, results: [] });
      return;
    }

    const byFile = new Map<string, ContentMatch>();
    let buffer = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, results: [...byFile.values()] });
    };

    // Spawn failure (e.g. rg not installed) → fall back to the JS walker.
    child.on('error', () => finish(false));

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type !== 'match') continue;

        const filePath: string | undefined = evt.data?.path?.text;
        if (!filePath) continue;

        let cm = byFile.get(filePath);
        if (!cm) {
          // Cap the number of distinct files we track.
          if (byFile.size >= maxResults) {
            child.kill();
            break;
          }
          cm = {
            path: filePath,
            name: path.basename(filePath),
            extension: path.extname(filePath).toLowerCase(),
            matches: [],
          };
          byFile.set(filePath, cm);
        }

        if (cm.matches.length >= MAX_MATCHES_PER_FILE) continue;
        const text: string = (evt.data?.lines?.text ?? '').replace(/\r?\n$/, '');
        cm.matches.push({
          line: evt.data?.line_number ?? 0,
          content: text.slice(0, 200),
        });
      }
    });

    // rg exit codes: 0 = matches, 1 = no matches, 2 = error. Only a real error
    // (or a kill, code null) that produced nothing should trigger the fallback.
    child.on('close', (code) => finish(!(code === 2 && byFile.size === 0)));
  });
}

// Fallback content search (async / non-blocking) used only when ripgrep is
// unavailable. Mirrors the old behavior but with fs.promises so it never
// blocks the event loop.
async function searchFileContentsAsync(
  dirPath: string,
  queryLower: string,
  results: ContentMatch[],
  maxResults: number,
  depth: number = 0,
  skipDirs: Set<string> = SEARCH_SKIP_DIRS,
): Promise<void> {
  if (results.length >= maxResults || depth > MAX_SEARCH_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // Skip directories we can't read
  }

  const subdirs: string[] = [];

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) subdirs.push(path.join(dirPath, entry.name));
      continue;
    }

    // Check if it's a text file we can search
    const ext = path.extname(entry.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && ext !== '') continue;

    const fullPath = path.join(dirPath, entry.name);
    try {
      const stats = await fs.promises.stat(fullPath);
      if (stats.size > MAX_CONTENT_FILE_SIZE) continue;

      const content = await fs.promises.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const matches: ContentMatch['matches'] = [];

      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
        const line = lines[i];
        if (line.toLowerCase().includes(queryLower)) {
          matches.push({
            line: i + 1,
            content: line.slice(0, 200), // Truncate long lines
          });
        }
      }

      if (matches.length > 0) {
        results.push({ path: fullPath, name: entry.name, extension: ext, matches });
      }
    } catch {
      // Skip files we can't read (binary, permission issues)
    }
  }

  for (const sub of subdirs) {
    if (results.length >= maxResults) break;
    await searchFileContentsAsync(sub, queryLower, results, maxResults, depth + 1, skipDirs);
  }
}

// GET /api/files/search-content - Search file contents
export const handleGetSearchContent = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    const query = req.query.q as string;
    const maxResults = parseInt(req.query.limit as string) || 30;

    if (!dirPath || !query) {
      res.status(400).json({ error: 'Missing path or query parameter' });
      return;
    }

    if (query.length < 2) {
      res.status(400).json({ error: 'Query must be at least 2 characters' });
      return;
    }

    if (!path.isAbsolute(dirPath)) {
      res.status(400).json({ error: 'Path must be absolute' });
      return;
    }

    if (!fs.existsSync(dirPath)) {
      res.status(404).json({ error: 'Directory not found' });
      return;
    }

    let results: ContentMatch[] = [];
    const skipDirs = skipDirsFromQuery(req);
    const rg = await searchFileContentsRipgrep(dirPath, query, maxResults, skipDirs);
    if (rg.ok) {
      results = rg.results;
    } else {
      // ripgrep unavailable — fall back to the pure-JS async walker.
      await searchFileContentsAsync(dirPath, query.toLowerCase(), results, maxResults, 0, skipDirs);
    }

    res.json({ results });
  } catch (err: any) {
    log.error(' Failed to search content:', err);
    res.status(500).json({ error: err.message });
  }
};
