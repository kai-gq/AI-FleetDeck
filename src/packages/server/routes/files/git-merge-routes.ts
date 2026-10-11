/**
 * Git 合并与审阅路由:merge/conflict/compare/show/commit-file-diff。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './fs-utils.js';
import { resolveGitRelativePath } from './git-log-routes.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// POST /api/files/git-merge - Merge a branch into the current branch
export const handlePostGitMerge = async (req: Request, res: Response) => {
  try {
    const { directory, branch } = req.body as { directory?: string; branch?: string };
    if (!directory) { res.status(400).json({ error: 'Missing directory parameter' }); return; }
    if (!path.isAbsolute(directory)) { res.status(400).json({ error: 'Directory must be absolute' }); return; }
    if (!branch) { res.status(400).json({ error: 'Missing branch parameter' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    try {
      const output = execSync(`git merge "${branch}"`, { cwd: gitRoot, encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
      res.json({ success: true, output: output.trim() });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || '';
      const stdout = err.stdout?.toString() || '';
      const combined = stdout + '\n' + stderr;

      if (combined.includes('CONFLICT') || combined.includes('Automatic merge failed')) {
        // Parse conflict file paths from output
        const conflicts: string[] = [];
        const conflictRegex = /CONFLICT \([^)]+\): Merge conflict in (.+)/g;
        let match;
        while ((match = conflictRegex.exec(combined)) !== null) {
          conflicts.push(path.join(gitRoot, match[1].trim()));
        }
        // Also check for "both modified" / "both added" patterns
        const bothRegex = /CONFLICT \([^)]+\):.+?(?:both modified|both added):\s*(.+)/g;
        while ((match = bothRegex.exec(combined)) !== null) {
          const conflictPath = path.join(gitRoot, match[1].trim());
          if (!conflicts.includes(conflictPath)) {
            conflicts.push(conflictPath);
          }
        }
        res.json({ success: false, output: combined.trim(), conflicts });
      } else if (combined.includes('not something we can merge') || combined.includes('not a valid')) {
        res.status(400).json({ success: false, error: `Branch '${branch}' not found` });
      } else if (combined.includes('uncommitted changes') || combined.includes('not possible because you have unmerged')) {
        res.status(409).json({ success: false, error: 'You have uncommitted changes. Commit or stash them first.' });
      } else {
        res.status(500).json({ success: false, error: (stderr || stdout).trim() || err.message });
      }
    }
  } catch (err: any) {
    log.error(' Failed to merge:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-conflict-file - Get ours/theirs/merged versions of a conflict file
export const handleGetGitConflictFile = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    const filePath = req.query.file as string;
    if (!dirPath || !filePath) { res.status(400).json({ error: 'Missing path or file parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: dirPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    // Get the relative path from git root
    const absFilePath = path.isAbsolute(filePath) ? filePath : path.join(gitRoot, filePath);
    const relPath = path.relative(gitRoot, absFilePath);

    // Read the three versions
    let ours = '';
    let theirs = '';
    let merged = '';

    try {
      ours = execSync(`git show ":2:${relPath}"`, { cwd: gitRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch {
      ours = ''; // File may not exist in ours (e.g., added by both)
    }

    try {
      theirs = execSync(`git show ":3:${relPath}"`, { cwd: gitRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch {
      theirs = ''; // File may not exist in theirs
    }

    try {
      merged = fs.readFileSync(absFilePath, 'utf-8');
    } catch {
      res.status(404).json({ error: 'Conflict file not found on disk' });
      return;
    }

    res.json({ ours, theirs, merged, filename: path.basename(absFilePath) });
  } catch (err: any) {
    log.error(' Failed to get conflict file:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-resolve-conflict - Write resolved content and stage the file
export const handlePostGitResolveConflict = async (req: Request, res: Response) => {
  try {
    const { directory, file, content } = req.body as { directory?: string; file?: string; content?: string };
    if (!directory || !file) { res.status(400).json({ error: 'Missing directory or file parameter' }); return; }
    if (!path.isAbsolute(directory)) { res.status(400).json({ error: 'Directory must be absolute' }); return; }
    if (content === undefined || content === null) { res.status(400).json({ error: 'Missing content parameter' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    const absFilePath = path.isAbsolute(file) ? file : path.join(gitRoot, file);
    const relPath = path.relative(gitRoot, absFilePath);

    if (relPath.startsWith('..')) {
      res.status(400).json({ error: 'File is outside the git repository' });
      return;
    }

    // Write the resolved content
    fs.writeFileSync(absFilePath, content, 'utf-8');

    // Stage the resolved file
    execSync(`git add "${relPath}"`, { cwd: gitRoot, encoding: 'utf-8' });

    res.json({ success: true });
  } catch (err: any) {
    log.error(' Failed to resolve conflict:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-merge-continue - Complete the merge after all conflicts are resolved
export const handlePostGitMergeContinue = async (req: Request, res: Response) => {
  try {
    const { directory } = req.body as { directory?: string };
    if (!directory) { res.status(400).json({ error: 'Missing directory parameter' }); return; }
    if (!path.isAbsolute(directory)) { res.status(400).json({ error: 'Directory must be absolute' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    try {
      const output = execSync('git commit --no-edit', { cwd: gitRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      res.json({ success: true, output: output.trim() });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message || '';
      res.status(500).json({ success: false, error: stderr.trim() || err.message });
    }
  } catch (err: any) {
    log.error(' Failed to continue merge:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-merge-abort - Abort an in-progress merge
export const handlePostGitMergeAbort = async (req: Request, res: Response) => {
  try {
    const { directory } = req.body as { directory?: string };
    if (!directory) { res.status(400).json({ error: 'Missing directory parameter' }); return; }
    if (!path.isAbsolute(directory)) { res.status(400).json({ error: 'Directory must be absolute' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    try {
      const output = execSync('git merge --abort', { cwd: gitRoot, encoding: 'utf-8' });
      res.json({ success: true, output: (output || '').trim() });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      res.status(500).json({ success: false, error: stderr.trim() || err.message });
    }
  } catch (err: any) {
    log.error(' Failed to abort merge:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-branch-compare - Compare two branches and return changed files
export const handleGetGitBranchCompare = async (req: Request, res: Response) => {
  try {
    const directory = req.query.directory as string;
    const branch = req.query.branch as string;

    if (!directory) {
      res.status(400).json({ error: 'Missing directory parameter' });
      return;
    }

    if (!path.isAbsolute(directory)) {
      res.status(400).json({ error: 'Directory must be absolute' });
      return;
    }

    if (!branch) {
      res.status(400).json({ error: 'Missing branch parameter' });
      return;
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

    // Get current branch
    let currentBranch: string;
    try {
      currentBranch = execSync('git branch --show-current', {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      currentBranch = 'HEAD';
    }

    // Get diff between branches (three-dot diff: changes since branches diverged)
    let diffOutput: string;
    try {
      diffOutput = execSync(`git diff --name-status ${branch}...HEAD`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      res.status(400).json({ error: stderr.trim() || 'Failed to compare branches' });
      return;
    }

    const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0, conflict: 0 };
    const files: Array<{ path: string; name: string; status: string; oldPath?: string }> = [];

    const lines = diffOutput.trim().split('\n').filter((l: string) => l.trim());
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;

      const statusCode = parts[0].trim();
      let status: string;
      let filePath: string;
      let oldPath: string | undefined;

      if (statusCode === 'M') {
        status = 'modified';
        filePath = parts[1];
      } else if (statusCode === 'A') {
        status = 'added';
        filePath = parts[1];
      } else if (statusCode === 'D') {
        status = 'deleted';
        filePath = parts[1];
      } else if (statusCode.startsWith('R')) {
        status = 'renamed';
        oldPath = path.join(gitRoot, parts[1]);
        filePath = parts[2] || parts[1];
      } else if (statusCode.startsWith('C')) {
        status = 'modified';
        filePath = parts[2] || parts[1];
      } else {
        status = 'modified';
        filePath = parts[1];
      }

      const absolutePath = path.join(gitRoot, filePath);
      const entry: { path: string; name: string; status: string; oldPath?: string } = {
        path: absolutePath,
        name: path.basename(absolutePath),
        status,
      };
      if (oldPath) {
        entry.oldPath = oldPath;
      }
      files.push(entry);

      if (status === 'renamed') {
        counts.renamed++;
      } else if (status in counts) {
        (counts as any)[status]++;
      }
    }

    res.json({ files, counts, baseBranch: branch, currentBranch });
  } catch (err: any) {
    log.error(' Failed to compare branches:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-show - Get file content at a specific git ref
export const handleGetGitShow = async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    const ref = req.query.ref as string;

    if (!filePath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    if (!path.isAbsolute(filePath)) {
      res.status(400).json({ error: 'Path must be absolute' });
      return;
    }

    if (!ref) {
      res.status(400).json({ error: 'Missing ref parameter' });
      return;
    }

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

    // Get file content at the specified ref
    let content: string;
    try {
      content = execSync(`git show ${ref}:"${relativePath}"`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
    } catch (err: any) {
      // File doesn't exist at the given ref
      if (err.message?.includes('does not exist') || err.message?.includes('fatal')) {
        res.json({
          path: filePath,
          filename: path.basename(filePath),
          extension: path.extname(filePath).toLowerCase(),
          content: '',
          notFound: true,
        });
        return;
      }
      throw err;
    }

    res.json({
      path: filePath,
      filename: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      content,
      notFound: false,
    });
  } catch (err: any) {
    log.error(' Failed to get file at ref:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-commit-file-diff - Get before/after content for a file in a commit
export const handleGetGitCommitFileDiff = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    const hash = req.query.hash as string;
    const filePath = req.query.file as string;

    if (!dirPath || !hash || !filePath) {
      res.status(400).json({ error: 'Missing path, hash, or file parameter' });
      return;
    }

    if (!path.isAbsolute(dirPath)) {
      res.status(400).json({ error: 'Path must be absolute' });
      return;
    }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: dirPath,
        encoding: 'utf-8',
      }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    const relativePath = resolveGitRelativePath(gitRoot, filePath);
    if (!relativePath) {
      res.status(400).json({ error: 'File path is outside the git repository' });
      return;
    }

    const filename = path.basename(relativePath);
    const extension = path.extname(relativePath).toLowerCase();

    // Get file content after the commit
    let afterContent = '';
    try {
      afterContent = execSync(`git show "${hash}:${relativePath}"`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // File doesn't exist at this commit (was deleted)
      afterContent = '';
    }

    // Get file content before the commit (parent)
    let beforeContent = '';
    try {
      beforeContent = execSync(`git show "${hash}~1:${relativePath}"`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // File doesn't exist before this commit (was added)
      beforeContent = '';
    }

    res.json({
      filename,
      extension,
      filePath: relativePath,
      hash,
      beforeContent,
      afterContent,
    });
  } catch (err: any) {
    log.error(' Failed to get commit file diff:', err);
    res.status(500).json({ error: err.message });
  }
};
