/**
 * Git 状态与工作区路由:/git-status、add/discard/original/diff。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, looksLikeBinaryBuffer, binaryContentTypeForExtension, toPosixSeparators, resolveAndValidateFilePath } from './fs-utils.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';

// Git file status type
interface GitFileStatus {
  path: string;
  name: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflict';
  oldPath?: string; // For renamed files
}

// GET /api/files/git-status - Get git status for a directory
export const handleGetGitStatus = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;

    if (!dirPath) {
      res.status(400).json({ error: 'Missing path parameter' });
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

    // Check if directory is a git repo and get the git root
    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      res.json({ isGitRepo: false, files: [] });
      return;
    }

    // Check if a merge is in progress
    const mergeInProgress = fs.existsSync(path.join(gitRoot, '.git', 'MERGE_HEAD'));

    // Get git status with porcelain format for easy parsing
    let statusOutput = '';
    try {
      statusOutput = execSync('git status --porcelain -uall', {
        cwd: dirPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });
    } catch (err) {
      log.error(' Git status failed:', err);
      res.json({ isGitRepo: true, files: [], error: 'Failed to get git status' });
      return;
    }

    const files: GitFileStatus[] = [];
    const orphanedIndexFiles: string[] = []; // AD files: staged add but deleted from disk
    const lines = statusOutput.replace(/\n$/, '').split('\n').filter(Boolean);

    for (const line of lines) {
      // Porcelain v1 format: "XY PATH" or "XY ORIG -> NEW" for renames
      // X = index status (pos 0), Y = worktree status (pos 1),
      // space separator (pos 2), path starts at pos 3.
      // Paths are always relative to the git root.
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePart = line.substring(3);

      let status: GitFileStatus['status'];
      let filePath: string;
      let oldPath: string | undefined;

      // Check for rename (contains ' -> ')
      // Emit '/'-separated absolute paths: git returns forward-slash relatives
      // but path.join yields backslashes on Windows, which would break the
      // client's git tree (it splits on '/').
      if (filePart.includes(' -> ')) {
        const [old, newPath] = filePart.split(' -> ');
        filePath = toPosixSeparators(path.join(gitRoot, newPath));
        oldPath = toPosixSeparators(path.join(gitRoot, old));
        status = 'renamed';
      } else {
        filePath = toPosixSeparators(path.join(gitRoot, filePart));

        // Determine status from XY codes
        // Check for conflicts first (both modified, both added, both deleted, etc.)
        const conflictCodes = ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'];
        const xyCode = indexStatus + workTreeStatus;

        if (conflictCodes.includes(xyCode)) {
          status = 'conflict';
        } else if (xyCode === 'AD') {
          // File was staged (git add) but then deleted from disk.
          // Auto-unstage the orphaned index entry and skip it.
          orphanedIndexFiles.push(filePart);
          continue;
        } else if (indexStatus === '?' || workTreeStatus === '?') {
          status = 'untracked';
        } else if (indexStatus === 'A' || workTreeStatus === 'A') {
          status = 'added';
        } else if (indexStatus === 'D' || workTreeStatus === 'D') {
          status = 'deleted';
        } else if (indexStatus === 'R' || workTreeStatus === 'R') {
          status = 'renamed';
        } else {
          status = 'modified';
        }
      }

      files.push({
        path: filePath,
        name: path.basename(filePath),
        status,
        oldPath,
      });
    }

    // Auto-unstage orphaned AD files (staged add but file deleted from disk)
    if (orphanedIndexFiles.length > 0) {
      try {
        const quotedPaths = orphanedIndexFiles.map(p => `"${p}"`).join(' ');
        execSync(`git rm --cached --ignore-unmatch ${quotedPaths}`, {
          cwd: gitRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Best effort — if unstaging fails, files are simply excluded from results
      }
    }

    // Sort by status priority: modified > added > deleted > untracked
    const statusOrder: Record<string, number> = { conflict: 0, modified: 1, added: 2, deleted: 3, renamed: 4, untracked: 5 };
    files.sort((a, b) => {
      const orderDiff = statusOrder[a.status] - statusOrder[b.status];
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name);
    });

    // Get branch name
    let branch = 'unknown';
    try {
      branch = execSync('git branch --show-current', {
        cwd: dirPath,
        encoding: 'utf-8',
      }).trim() || 'HEAD';
    } catch {
      // Ignore
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      isGitRepo: true,
      branch,
      files,
      mergeInProgress,
      counts: {
        conflict: files.filter(f => f.status === 'conflict').length,
        modified: files.filter(f => f.status === 'modified').length,
        added: files.filter(f => f.status === 'added').length,
        deleted: files.filter(f => f.status === 'deleted').length,
        untracked: files.filter(f => f.status === 'untracked').length,
        renamed: files.filter(f => f.status === 'renamed').length,
      },
    });
  } catch (err: any) {
    log.error(' Failed to get git status:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-add - Stage files with git add
export const handlePostGitAdd = async (req: Request, res: Response) => {
  try {
    const { paths, directory } = req.body as { paths?: string[]; directory?: string };

    if (!directory || typeof directory !== 'string') {
      res.status(400).json({ error: 'Missing directory parameter' });
      return;
    }

    if (!path.isAbsolute(directory)) {
      res.status(400).json({ error: 'Directory must be absolute' });
      return;
    }

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: 'Missing or empty paths array' });
      return;
    }

    // Validate all paths are absolute and don't contain traversal
    for (const p of paths) {
      if (!path.isAbsolute(p)) {
        res.status(400).json({ error: `Path must be absolute: ${p}` });
        return;
      }
      if (p.includes('..')) {
        res.status(400).json({ error: `Path traversal not allowed: ${p}` });
        return;
      }
    }

    // Find git root
    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: directory,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    // Convert absolute paths to relative paths from git root and validate they're within the repo
    const relativePaths: string[] = [];
    for (const p of paths) {
      const rel = path.relative(gitRoot, p);
      if (rel.startsWith('..')) {
        res.status(400).json({ error: `Path is outside the git repository: ${p}` });
        return;
      }
      relativePaths.push(rel);
    }

    // Stage the files
    const quotedPaths = relativePaths.map(p => `"${p}"`).join(' ');
    try {
      execSync(`git add ${quotedPaths}`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: any) {
      log.error(' Git add failed:', err);
      res.status(500).json({ error: `Git add failed: ${err.message}` });
      return;
    }

    res.json({ success: true, staged: paths.length });
  } catch (err: any) {
    log.error(' Failed to stage files:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-discard - Discard working tree changes for files
export const handlePostGitDiscard = async (req: Request, res: Response) => {
  try {
    const { files, directory } = req.body as {
      files?: Array<{ path: string; status: string }>;
      directory?: string;
    };

    if (!directory || typeof directory !== 'string') {
      res.status(400).json({ error: 'Missing directory parameter' });
      return;
    }

    if (!path.isAbsolute(directory)) {
      res.status(400).json({ error: 'Directory must be absolute' });
      return;
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'Missing or empty files array' });
      return;
    }

    // Validate all paths
    for (const f of files) {
      if (!f.path || !path.isAbsolute(f.path)) {
        res.status(400).json({ error: `Path must be absolute: ${f.path}` });
        return;
      }
      if (f.path.includes('..')) {
        res.status(400).json({ error: `Path traversal not allowed: ${f.path}` });
        return;
      }
    }

    // Find git root
    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: directory,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    let discarded = 0;

    for (const f of files) {
      const rel = path.relative(gitRoot, f.path);
      if (rel.startsWith('..')) {
        res.status(400).json({ error: `Path is outside the git repository: ${f.path}` });
        return;
      }

      try {
        if (f.status === 'untracked') {
          // Untracked files: just delete from disk
          if (fs.existsSync(f.path)) {
            fs.unlinkSync(f.path);
          }
        } else if (f.status === 'added') {
          // Staged new files: unstage then delete
          try {
            execSync(`git rm --cached "${rel}"`, {
              cwd: gitRoot,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {
            // May not be staged, ignore
          }
          if (fs.existsSync(f.path)) {
            fs.unlinkSync(f.path);
          }
        } else {
          // modified, deleted, renamed, conflict: restore from HEAD
          execSync(`git checkout HEAD -- "${rel}"`, {
            cwd: gitRoot,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          });
        }
        discarded++;
      } catch (err: any) {
        log.error(` Git discard failed for ${f.path}:`, err);
        res.status(500).json({ error: `Failed to discard ${f.path}: ${err.message}` });
        return;
      }
    }

    res.json({ success: true, discarded });
  } catch (err: any) {
    log.error(' Failed to discard files:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-discard-all - Discard ALL uncommitted changes in one repo.
// Destructive & irreversible. `git reset --hard HEAD` restores every tracked file
// (staged + unstaged) to HEAD; `git clean -fd` removes untracked files AND
// directories. `-fd` respects .gitignore, so ignored paths (node_modules, .env,
// build output) are intentionally left untouched — this matches the untracked set
// shown by `git status`. Scoped to the git root resolved from `directory`, so it
// can never touch another repo.
export const handlePostGitDiscardAll = async (req: Request, res: Response) => {
  try {
    const { directory } = req.body as { directory?: string };

    if (!directory || typeof directory !== 'string') {
      res.status(400).json({ error: 'Missing directory parameter' });
      return;
    }
    if (!path.isAbsolute(directory)) {
      res.status(400).json({ error: 'Directory must be absolute' });
      return;
    }

    // Resolve the git root so both commands are scoped to exactly this repo.
    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: directory,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    // Count changes first so the response can report how many were discarded.
    let discarded = 0;
    try {
      const statusOut = execSync('git status --porcelain -uall', {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      discarded = statusOut.split('\n').filter((l) => l.trim().length > 0).length;
    } catch {
      // Non-fatal: if counting fails, still proceed with the discard.
    }

    try {
      // Restore all tracked files (staged + unstaged) to HEAD.
      execSync('git reset --hard HEAD', {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      // Remove untracked files and directories (respects .gitignore).
      execSync('git clean -fd', {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: any) {
      log.error(' Git discard-all failed:', err);
      res.status(500).json({ error: `Failed to discard all changes: ${err.message}` });
      return;
    }

    res.json({ success: true, discarded });
  } catch (err: any) {
    log.error(' Failed to discard all changes:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-original - Get original file content from git HEAD
export const handleGetGitOriginal = async (req: Request, res: Response) => {
  try {
    const resolution = resolveAndValidateFilePath(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    const filePath = resolution.path;

    // Find git root
    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: path.dirname(filePath),
        encoding: 'utf-8',
      }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    // Get relative path from git root
    const relativePath = path.relative(gitRoot, filePath);

    // Get original content from HEAD
    let originalBuffer: Buffer;
    try {
      // cat-file, not `git show`: a new file whose name has glob characters
      // (`app/[slug]/page.tsx`) makes show fall back to a pathspec and print
      // the HEAD commit with exit 0, which rendered as the "original" content.
      originalBuffer = execFileSync('git', ['cat-file', 'blob', `HEAD:${relativePath}`], {
        cwd: gitRoot,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
    } catch (err: any) {
      // File might be new (not in HEAD)
      if (err.message?.includes('does not exist') || err.message?.includes('fatal')) {
        res.json({
          path: filePath,
          filename: path.basename(filePath),
          extension: path.extname(filePath).toLowerCase(),
          content: '',
          isNew: true,
        });
        return;
      }
      throw err;
    }

    if (looksLikeBinaryBuffer(originalBuffer)) {
      res.status(415).json({
        path: filePath,
        filename: path.basename(filePath),
        extension: path.extname(filePath).toLowerCase(),
        binary: true,
        isNew: false,
        error: 'Binary file cannot be read as text',
      });
      return;
    }

    res.json({
      path: filePath,
      filename: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      content: originalBuffer.toString('utf-8'),
      isNew: false,
    });
  } catch (err: any) {
    log.error(' Failed to get git original:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-original-binary - Stream the HEAD version of a binary
// file. This keeps deleted image/PDF/STL/FCStd previews useful in the Git modal.
export const handleGetGitOriginalBinary = async (req: Request, res: Response) => {
  try {
    const resolution = resolveAndValidateFilePath(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    const filePath = resolution.path;
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(filePath),
      encoding: 'utf-8',
    }).trim();
    const relativePath = path.relative(gitRoot, filePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      res.status(400).json({ error: 'Path is outside the git repository' });
      return;
    }
    const buffer = execFileSync('git', ['cat-file', 'blob', `HEAD:${relativePath}`], {
      cwd: gitRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
    const extension = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', binaryContentTypeForExtension(extension));
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(buffer);
  } catch (err: any) {
    log.error(' Failed to get original binary from git:', err);
    res.status(404).json({ error: 'Original binary file not found' });
  }
};

// GET /api/files/git-diff - Get unified diff for a file
export const handleGetGitDiff = async (req: Request, res: Response) => {
  try {
    const resolution = resolveAndValidateFilePath(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    const filePath = resolution.path;

    // Find git root
    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: path.dirname(filePath),
        encoding: 'utf-8',
      }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    // Get relative path from git root
    const relativePath = path.relative(gitRoot, filePath);

    // Get diff
    let diff: string;
    try {
      diff = execSync(`git diff HEAD -- "${relativePath}"`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      diff = '';
    }

    res.json({
      path: filePath,
      diff,
    });
  } catch (err: any) {
    log.error(' Failed to get git diff:', err);
    res.status(500).json({ error: err.message });
  }
};
