/**
 * Git 历史路由:log/commit-files/file-history/branches-list/authors(含 git 参数助手)。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './fs-utils.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ============================================================
// Git History Endpoints
// ============================================================

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolveGitRootOrThrow(dirPath: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: dirPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function resolveGitRelativePath(gitRoot: string, inputPath: string): string | null {
  const resolvedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(gitRoot, inputPath);
  const relativePath = path.relative(gitRoot, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return relativePath.split(path.sep).join('/');
}

function parseGitRefs(refsValue: string): { branches: string[]; tags: string[]; isHead: boolean } {
  const branches: string[] = [];
  const tags: string[] = [];
  let isHead = false;

  const normalizedRefs = refsValue.trim().replace(/^\((.*)\)$/, '$1');
  if (!normalizedRefs) {
    return { branches, tags, isHead };
  }

  for (const rawPart of normalizedRefs.split(',')) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    if (part === 'HEAD') {
      isHead = true;
      continue;
    }
    if (part.startsWith('HEAD -> ')) {
      isHead = true;
      branches.push(part.slice('HEAD -> '.length).trim());
      continue;
    }
    if (part.startsWith('tag: ')) {
      tags.push(part.slice('tag: '.length).trim());
      continue;
    }
    branches.push(part);
  }

  return { branches, tags, isHead };
}

function buildGitLogFilterArgs(params: {
  branch?: string;
  author?: string;
  since?: string;
  until?: string;
  search?: string;
  searchPath?: string;
}) {
  const revision = params.branch?.trim() || 'HEAD';
  const args = [shellEscape(revision)];

  if (params.author?.trim()) {
    args.push(`--author=${shellEscape(params.author.trim())}`);
  }
  if (params.since?.trim()) {
    args.push(`--since=${shellEscape(params.since.trim())}`);
  }
  if (params.until?.trim()) {
    args.push(`--until=${shellEscape(params.until.trim())}`);
  }
  if (params.search?.trim()) {
    args.push(`--grep=${shellEscape(params.search.trim())}`);
  }
  if (params.searchPath) {
    args.push('--', shellEscape(params.searchPath));
  }

  return args;
}

// GET /api/files/git-log - Commit history with pagination and filters
export const handleGetGitLog = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    if (!dirPath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (!fs.existsSync(dirPath)) { res.status(404).json({ error: 'Directory not found' }); return; }

    const gitRoot = resolveGitRootOrThrow(dirPath);
    if (!gitRoot) {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    const parsedLimit = Number.parseInt(req.query.limit as string, 10);
    const parsedOffset = Number.parseInt(req.query.offset as string, 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    const offset = Number.isFinite(parsedOffset) ? parsedOffset : 0;
    if (limit <= 0) { res.status(400).json({ error: 'Limit must be greater than 0' }); return; }
    if (offset < 0) { res.status(400).json({ error: 'Offset must be 0 or greater' }); return; }

    const branch = req.query.branch as string | undefined;
    const author = req.query.author as string | undefined;
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const search = req.query.search as string | undefined;
    const searchPathInput = req.query.searchPath as string | undefined;

    let searchPath: string | undefined;
    if (searchPathInput) {
      const resolvedSearchPath = resolveGitRelativePath(gitRoot, searchPathInput);
      if (!resolvedSearchPath) {
        res.status(400).json({ error: 'searchPath is outside the git repository' });
        return;
      }
      searchPath = resolvedSearchPath;
    }

    const filterArgs = buildGitLogFilterArgs({ branch, author, since, until, search, searchPath });
    const logFormat = '%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%D';
    const logCommand = [
      'git log',
      `--format=${shellEscape(logFormat)}`,
      `--skip=${offset}`,
      `--max-count=${limit}`,
      ...filterArgs,
    ].join(' ');

    let logOutput = '';
    try {
      logOutput = execSync(logCommand, {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('does not have any commits yet')) {
        res.json({ commits: [], total: 0, hasMore: false });
        return;
      }
      if (stderr.includes('unknown revision') || stderr.includes('bad revision') || stderr.includes('ambiguous argument')) {
        res.status(400).json({ error: stderr.trim() || 'Invalid branch or revision' });
        return;
      }
      throw err;
    }

    const lines = logOutput ? logOutput.trim().split('\n').filter(l => l) : [];
    const commits: Array<{
      hash: string;
      shortHash: string;
      author: string;
      authorEmail: string;
      date: string;
      subject: string;
      refs: { branches: string[]; tags: string[]; isHead: boolean };
    }> = [];

    for (const line of lines) {
      const fields = line.split('\x00');
      if (fields.length < 6) continue;
      commits.push({
        hash: fields[0] || '',
        shortHash: fields[1] || '',
        author: fields[2] || '',
        authorEmail: fields[3] || '',
        date: fields[4] || '',
        subject: fields[5] || '',
        refs: parseGitRefs(fields[6] || ''),
      });
    }

    let total = 0;
    try {
      const countCommand = ['git rev-list --count', ...filterArgs].join(' ');
      total = Number.parseInt(execSync(countCommand, {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      }).trim(), 10) || 0;
    } catch {
      total = offset + commits.length;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.json({ commits, total, hasMore: offset + commits.length < total });
  } catch (err: any) {
    log.error(' Failed to get git log:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-commit-files - Files changed in a specific commit
export const handleGetGitCommitFiles = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    const hash = req.query.hash as string;
    if (!dirPath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (!fs.existsSync(dirPath)) { res.status(404).json({ error: 'Directory not found' }); return; }
    if (!hash) { res.status(400).json({ error: 'Missing hash parameter' }); return; }
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) { res.status(400).json({ error: 'Invalid commit hash format' }); return; }

    const gitRoot = resolveGitRootOrThrow(dirPath);
    if (!gitRoot) {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    let parentLine = '';
    try {
      parentLine = execSync(`git rev-list --parents -n 1 ${shellEscape(hash)}`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('unknown revision') || stderr.includes('bad object') || stderr.includes('ambiguous argument')) {
        res.status(404).json({ error: 'Commit not found' });
        return;
      }
      throw err;
    }

    const parentCount = parentLine ? parentLine.split(/\s+/).length - 1 : 0;
    const diffTreeCommand = parentCount === 0
      ? `git diff-tree --no-commit-id -r --name-status --root ${shellEscape(hash)}`
      : `git diff-tree --no-commit-id -r --name-status ${shellEscape(hash)}`;

    const output = execSync(diffTreeCommand, {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });

    const files: Array<{ path: string; status: 'modified' | 'added' | 'deleted' | 'renamed'; oldPath?: string }> = [];
    for (const line of output.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const statusCode = parts[0] || '';

      if (statusCode.startsWith('R') && parts.length >= 3) {
        files.push({
          path: parts[2],
          status: 'renamed',
          oldPath: parts[1],
        });
        continue;
      }

      if (parts.length < 2) {
        continue;
      }

      let status: 'modified' | 'added' | 'deleted' | 'renamed' = 'modified';
      if (statusCode.startsWith('A')) status = 'added';
      else if (statusCode.startsWith('D')) status = 'deleted';
      else if (statusCode.startsWith('R')) status = 'renamed';

      files.push({
        path: parts[1],
        status,
      });
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.json({ files });
  } catch (err: any) {
    log.error(' Failed to get commit files:', err);
    res.status(500).json({ error: err.message });
  }
};

// Simple extension-based language detection for the diff viewer
function detectLanguageFromPath(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = path.extname(base);
  const mapping: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.json': 'json', '.jsonc': 'json',
    '.html': 'html', '.htm': 'html',
    '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
    '.md': 'markdown', '.mdx': 'markdown',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp', '.php': 'php',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
    '.sql': 'sql', '.lua': 'lua', '.dart': 'dart',
    '.svelte': 'svelte', '.vue': 'vue',
    '.dockerfile': 'dockerfile', '.ini': 'ini', '.env': 'shell',
  };
  return mapping[ext] || 'plaintext';
}

// GET /api/files/git-file-history - History of commits that touched a single file (with --follow)
export const handleGetGitFileHistory = async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    const cwd = req.query.cwd as string;
    const limitParam = req.query.limit as string | undefined;

    if (!filePath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!cwd) { res.status(400).json({ error: 'Missing cwd parameter' }); return; }
    if (!path.isAbsolute(cwd)) { res.status(400).json({ error: 'cwd must be absolute' }); return; }
    if (!fs.existsSync(cwd)) { res.status(404).json({ error: 'cwd not found' }); return; }

    let limit = 100;
    if (limitParam !== undefined) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
      limit = Math.min(parsed, 1000);
    }

    const gitRoot = resolveGitRootOrThrow(cwd);
    if (!gitRoot) { res.status(400).json({ error: 'Not in a git repository' }); return; }

    const relativePath = resolveGitRelativePath(gitRoot, filePath);
    if (!relativePath) { res.status(400).json({ error: 'path is outside the git repository' }); return; }

    // NUL-delimited fields, newline-separated commits (git log default)
    const logFormat = '%H%x00%h%x00%an%x00%ae%x00%aI%x00%s';
    const cmd = [
      'git log',
      '--follow',
      `--format=${shellEscape(logFormat)}`,
      `-n ${limit}`,
      '--',
      shellEscape(relativePath),
    ].join(' ');

    let output = '';
    try {
      output = execSync(cmd, {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('does not have any commits yet')) {
        res.json({ commits: [] });
        return;
      }
      if (stderr.includes('unknown revision') || stderr.includes('bad revision') || stderr.includes('ambiguous argument')) {
        res.status(404).json({ error: 'file not tracked' });
        return;
      }
      throw err;
    }

    const commits: Array<{
      sha: string;
      shortSha: string;
      author: string;
      email: string;
      date: string;
      subject: string;
    }> = [];

    for (const line of output.split('\n')) {
      if (!line) continue;
      const fields = line.split('\x00');
      if (fields.length < 6) continue;
      commits.push({
        sha: fields[0] || '',
        shortSha: fields[1] || '',
        author: fields[2] || '',
        email: fields[3] || '',
        date: fields[4] || '',
        subject: fields[5] || '',
      });
    }

    if (commits.length === 0) {
      // Distinguish "tracked but no history" (rare) from "not tracked at all" (404).
      try {
        execSync(`git ls-files --error-unmatch -- ${shellEscape(relativePath)}`, {
          cwd: gitRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        res.status(404).json({ error: 'file not tracked' });
        return;
      }
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.json({ commits });
  } catch (err: any) {
    log.error(' Failed to get git file history:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-file-commit-diff - File contents at <sha> vs its parent, for the
// per-file history diff viewer (GitFileHistoryModal). Distinct from the older
// /git-commit-file-diff endpoint above, which serves the FileExplorerPanel commit-log
// view with a different param/shape contract.
export const handleGetGitFileCommitDiff = async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    const cwd = req.query.cwd as string;
    const sha = req.query.sha as string;

    if (!filePath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!cwd) { res.status(400).json({ error: 'Missing cwd parameter' }); return; }
    if (!sha) { res.status(400).json({ error: 'Missing sha parameter' }); return; }
    if (!path.isAbsolute(cwd)) { res.status(400).json({ error: 'cwd must be absolute' }); return; }
    if (!fs.existsSync(cwd)) { res.status(404).json({ error: 'cwd not found' }); return; }
    if (!/^[a-f0-9]{4,40}$/i.test(sha)) { res.status(400).json({ error: 'Invalid commit SHA' }); return; }

    const gitRoot = resolveGitRootOrThrow(cwd);
    if (!gitRoot) { res.status(400).json({ error: 'Not in a git repository' }); return; }

    const relativePath = resolveGitRelativePath(gitRoot, filePath);
    if (!relativePath) { res.status(400).json({ error: 'path is outside the git repository' }); return; }

    // Determine if this commit has a parent (root commits don't)
    let hasParent = false;
    try {
      const parentLine = execSync(`git rev-list --parents -n 1 ${shellEscape(sha)}`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      hasParent = parentLine.split(/\s+/).length > 1;
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('unknown revision') || stderr.includes('bad object') || stderr.includes('ambiguous argument')) {
        res.status(404).json({ error: 'Commit not found' });
        return;
      }
      throw err;
    }

    // Read raw bytes so we can sniff for binary content. execSync without encoding returns Buffer.
    const showBytes = (ref: string): { buf: Buffer | null; missing: boolean } => {
      try {
        const buf = execSync(`git show ${shellEscape(`${ref}:${relativePath}`)}`, {
          cwd: gitRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 50 * 1024 * 1024,
        }) as Buffer;
        return { buf, missing: false };
      } catch {
        // git show fails when the path doesn't exist at that ref — treat as missing.
        return { buf: null, missing: true };
      }
    };

    const original = hasParent ? showBytes(`${sha}~1`) : { buf: null, missing: true };
    const modified = showBytes(sha);

    let changeType: 'added' | 'modified' | 'deleted';
    if (original.missing && !modified.missing) changeType = 'added';
    else if (!original.missing && modified.missing) changeType = 'deleted';
    else if (!original.missing && !modified.missing) changeType = 'modified';
    else {
      res.status(404).json({ error: 'File not present in commit or its parent' });
      return;
    }

    const filename = path.basename(relativePath);

    // Binary sniff: scan first 8KB of either side for NUL byte.
    const looksBinary = (b: Buffer | null): boolean => {
      if (!b || b.length === 0) return false;
      const sample = b.subarray(0, Math.min(b.length, 8192));
      return sample.includes(0);
    };
    const binary = looksBinary(original.buf) || looksBinary(modified.buf);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    if (binary) {
      res.json({ binary: true, filename, changeType });
      return;
    }

    res.json({
      originalContent: original.buf ? original.buf.toString('utf-8') : '',
      modifiedContent: modified.buf ? modified.buf.toString('utf-8') : '',
      filename,
      language: detectLanguageFromPath(filename),
      changeType,
      binary: false,
    });
  } catch (err: any) {
    log.error(' Failed to get git commit file diff:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-branches-list - Simple branch list for filters
export const handleGetGitBranchesList = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    if (!dirPath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (!fs.existsSync(dirPath)) { res.status(404).json({ error: 'Directory not found' }); return; }

    const gitRoot = resolveGitRootOrThrow(dirPath);
    if (!gitRoot) {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    let currentBranch = 'HEAD';
    try {
      currentBranch = execSync('git branch --show-current', {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || 'HEAD';
    } catch {
      currentBranch = 'HEAD';
    }

    const branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean }> = [];

    try {
      const localOutput = execSync(
        "git branch --format='%(refname:short)' --sort=refname",
        { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }
      );
      for (const branchName of localOutput.split('\n').map(line => line.trim()).filter(Boolean)) {
        branches.push({ name: branchName, isCurrent: branchName === currentBranch, isRemote: false });
      }
    } catch {
      // Ignore local branch listing errors and continue with empty result.
    }

    try {
      const remoteOutput = execSync(
        "git branch -r --format='%(refname:short)' --sort=refname",
        { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }
      );
      for (const branchName of remoteOutput.split('\n').map(line => line.trim()).filter(Boolean)) {
        if (branchName.includes('/HEAD')) {
          continue;
        }
        branches.push({ name: branchName, isCurrent: false, isRemote: true });
      }
    } catch {
      // No remotes configured.
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.json({ branches, currentBranch });
  } catch (err: any) {
    log.error(' Failed to get git branches list:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-authors - Unique author list for filter dropdown
export const handleGetGitAuthors = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    if (!dirPath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (!fs.existsSync(dirPath)) { res.status(404).json({ error: 'Directory not found' }); return; }

    const gitRoot = resolveGitRootOrThrow(dirPath);
    if (!gitRoot) {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    let output = '';
    try {
      output = execSync('git log --format=%an | sort -u', {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('does not have any commits yet')) {
        res.json({ authors: [] });
        return;
      }
      throw err;
    }

    const authors = output.split('\n').map(authorName => authorName.trim()).filter(Boolean);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.json({ authors });
  } catch (err: any) {
    log.error(' Failed to get git authors:', err);
    res.status(500).json({ error: err.message });
  }
};
