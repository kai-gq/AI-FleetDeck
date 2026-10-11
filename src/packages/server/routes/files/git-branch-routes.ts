/**
 * Git 分支与远端路由:branch/checkout/pull/push/commit/fetch。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './fs-utils.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// GET /api/files/git-branch - Get current branch name for a directory (lightweight)
export const handleGetGitBranch = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    if (!dirPath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (!fs.existsSync(dirPath)) { res.json({ branch: null }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: dirPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.json({ branch: null });
      return;
    }

    let branch = '';
    try {
      branch = execSync('git branch --show-current', { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || 'HEAD';
    } catch {
      branch = 'HEAD';
    }

    // Get ahead/behind counts relative to upstream
    let ahead = 0;
    let behind = 0;
    if (branch && branch !== 'HEAD') {
      try {
        const revList = execSync(
          `git rev-list --left-right --count ${branch}...@{upstream}`,
          { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        const parts = revList.split(/\s+/);
        if (parts.length === 2) {
          ahead = parseInt(parts[0], 10) || 0;
          behind = parseInt(parts[1], 10) || 0;
        }
      } catch {
        // No upstream configured or error — leave at 0
      }
    }

    res.json({ branch, ahead, behind });
  } catch {
    res.json({ branch: null, ahead: 0, behind: 0 });
  }
};

// GET /api/files/git-branches - List all local and remote branches
export const handleGetGitBranches = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    if (!dirPath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (!fs.existsSync(dirPath)) { res.status(404).json({ error: 'Directory not found' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: dirPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    let currentBranch = '';
    try {
      currentBranch = execSync('git branch --show-current', { cwd: gitRoot, encoding: 'utf-8' }).trim() || 'HEAD';
    } catch { currentBranch = 'HEAD'; }

    interface BranchInfo {
      name: string;
      isCurrent: boolean;
      isRemote: boolean;
      remote?: string;
      lastCommit?: string;
      lastMessage?: string;
    }
    const branches: BranchInfo[] = [];

    try {
      const localOutput = execSync(
        "git branch --format='%(refname:short)|%(objectname:short)|%(subject)' --sort=-committerdate",
        { cwd: gitRoot, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
      );
      for (const line of localOutput.trim().split('\n').filter(Boolean)) {
        const [name, commit, ...msgParts] = line.split('|');
        branches.push({
          name: name.trim(),
          isCurrent: name.trim() === currentBranch,
          isRemote: false,
          lastCommit: commit?.trim(),
          lastMessage: msgParts.join('|').trim(),
        });
      }
    } catch (err) {
      log.error(' Failed to list local branches:', err);
    }

    try {
      const remoteOutput = execSync(
        "git branch -r --format='%(refname:short)|%(objectname:short)|%(subject)' --sort=-committerdate",
        { cwd: gitRoot, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
      );
      for (const line of remoteOutput.trim().split('\n').filter(Boolean)) {
        const [name, commit, ...msgParts] = line.split('|');
        const trimmedName = name.trim();
        if (trimmedName.includes('/HEAD')) continue;
        const slashIndex = trimmedName.indexOf('/');
        const remote = slashIndex > -1 ? trimmedName.substring(0, slashIndex) : undefined;
        branches.push({
          name: trimmedName,
          isCurrent: false,
          isRemote: true,
          remote,
          lastCommit: commit?.trim(),
          lastMessage: msgParts.join('|').trim(),
        });
      }
    } catch {
      // No remote branches or not configured
    }

    let remotes: string[] = [];
    try {
      remotes = execSync('git remote', { cwd: gitRoot, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    } catch { /* no remotes */ }

    res.json({ branches, currentBranch, remotes });
  } catch (err: any) {
    log.error(' Failed to list branches:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-checkout - Switch to a different branch
export const handlePostGitCheckout = async (req: Request, res: Response) => {
  try {
    const { directory, branch } = req.body as { directory?: string; branch?: string };
    if (!directory || !branch) { res.status(400).json({ error: 'Missing directory or branch parameter' }); return; }
    if (!path.isAbsolute(directory)) { res.status(400).json({ error: 'Directory must be absolute' }); return; }
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(branch)) { res.status(400).json({ error: 'Invalid branch name' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    try {
      const isRemote = branch.includes('/');
      if (isRemote) {
        const localName = branch.substring(branch.indexOf('/') + 1);
        try {
          execSync(`git rev-parse --verify "${localName}"`, { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          execSync(`git checkout "${localName}"`, { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
          execSync(`git checkout -b "${localName}" "${branch}"`, { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        }
        res.json({ success: true, branch: localName });
      } else {
        execSync(`git checkout "${branch}"`, { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        res.json({ success: true, branch });
      }
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('Your local changes')) {
        res.status(409).json({ success: false, error: 'Uncommitted changes would be overwritten. Commit or stash first.' });
      } else if (stderr.includes('pathspec')) {
        res.status(404).json({ success: false, error: `Branch not found: ${branch}` });
      } else {
        res.status(500).json({ success: false, error: stderr.trim() || err.message });
      }
    }
  } catch (err: any) {
    log.error(' Failed to checkout branch:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-branch-create - Create a new branch and switch to it
export const handlePostGitBranchCreate = async (req: Request, res: Response) => {
  try {
    const { directory, name, startPoint } = req.body as { directory?: string; name?: string; startPoint?: string };
    if (!directory || !name) { res.status(400).json({ error: 'Missing directory or name parameter' }); return; }
    if (!path.isAbsolute(directory)) { res.status(400).json({ error: 'Directory must be absolute' }); return; }
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(name)) { res.status(400).json({ error: 'Invalid branch name. Use only letters, numbers, dots, hyphens, underscores, and slashes.' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    try {
      const cmd = startPoint
        ? `git checkout -b "${name}" "${startPoint}"`
        : `git checkout -b "${name}"`;
      execSync(cmd, { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      res.json({ success: true, branch: name });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('already exists')) {
        res.status(409).json({ success: false, error: `Branch "${name}" already exists.` });
      } else {
        res.status(500).json({ success: false, error: stderr.trim() || err.message });
      }
    }
  } catch (err: any) {
    log.error(' Failed to create branch:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-pull - Pull from remote
export const handlePostGitPull = async (req: Request, res: Response) => {
  try {
    const { directory, remote, branch } = req.body as { directory?: string; remote?: string; branch?: string };
    if (!directory) { res.status(400).json({ error: 'Missing directory parameter' }); return; }
    if (!path.isAbsolute(directory)) { res.status(400).json({ error: 'Directory must be absolute' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    const buildPullCmd = () => {
      let cmd = 'git pull --no-rebase';
      if (remote) cmd += ` "${remote}"`;
      if (branch) cmd += ` "${branch}"`;
      return cmd;
    };

    const parseConflicts = (text: string): string[] => {
      const conflicts: string[] = [];
      const conflictRegex = /CONFLICT \([^)]+\): Merge conflict in (.+)/g;
      let match;
      while ((match = conflictRegex.exec(text)) !== null) {
        conflicts.push(path.join(gitRoot, match[1].trim()));
      }
      const bothRegex = /CONFLICT \([^)]+\):.+?(?:both modified|both added):\s*(.+)/g;
      while ((match = bothRegex.exec(text)) !== null) {
        const conflictPath = path.join(gitRoot, match[1].trim());
        if (!conflicts.includes(conflictPath)) {
          conflicts.push(conflictPath);
        }
      }
      return conflicts;
    };

    const execOpts = { cwd: gitRoot, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 10 * 1024 * 1024 };

    try {
      const output = execSync(buildPullCmd(), execOpts);
      res.json({ success: true, output: output.trim() });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || '';
      const stdout = err.stdout?.toString() || '';
      const combined = stdout + '\n' + stderr;

      // Check if failure is due to local changes conflicting with incoming
      const needsStash = combined.includes('Your local changes') ||
        combined.includes('untracked working tree files would be overwritten');

      if (needsStash) {
        // Auto-stash local changes and retry
        try {
          execSync('git stash push --include-untracked -m "auto-stash before pull"', execOpts);
        } catch (stashErr: any) {
          res.status(500).json({ success: false, error: 'Failed to stash local changes: ' + (stashErr.stderr?.toString() || stashErr.message) });
          return;
        }

        // Retry pull
        try {
          const pullOutput = execSync(buildPullCmd(), execOpts);

          // Restore stashed changes
          try {
            execSync('git stash pop', execOpts);
            res.json({ success: true, output: pullOutput.trim(), stashed: true, message: 'Local changes were auto-stashed and restored.' });
          } catch (popErr: any) {
            const popStderr = popErr.stderr?.toString() || '';
            const popStdout = popErr.stdout?.toString() || '';
            const popCombined = popStdout + '\n' + popStderr;
            const stashConflicts = parseConflicts(popCombined);
            res.json({
              success: true,
              output: pullOutput.trim(),
              stashed: true,
              stashConflicts: stashConflicts.length > 0 ? stashConflicts : undefined,
              message: 'Pull succeeded but stash pop had conflicts. Resolve manually.',
            });
          }
        } catch (retryErr: any) {
          // Pull failed even after stash — restore stash and report error
          try { execSync('git stash pop', execOpts); } catch { /* best effort */ }
          const retryStderr = retryErr.stderr?.toString() || '';
          const retryStdout = retryErr.stdout?.toString() || '';
          const retryCombined = retryStdout + '\n' + retryStderr;

          if (retryCombined.includes('CONFLICT') || retryCombined.includes('Automatic merge failed')) {
            res.json({ success: false, output: retryCombined.trim(), conflicts: parseConflicts(retryCombined), stashed: true });
          } else if (retryCombined.includes('ETIMEDOUT') || retryCombined.includes('Could not resolve')) {
            res.status(504).json({ success: false, error: 'Network error. Check your connection.' });
          } else {
            res.status(500).json({ success: false, error: (retryStderr || retryStdout).trim() || retryErr.message });
          }
        }
      } else if (combined.includes('CONFLICT') || combined.includes('Automatic merge failed')) {
        res.json({ success: false, output: combined.trim(), conflicts: parseConflicts(combined) });
      } else if (combined.includes('ETIMEDOUT') || combined.includes('Could not resolve')) {
        res.status(504).json({ success: false, error: 'Network error. Check your connection.' });
      } else {
        res.status(500).json({ success: false, error: (stderr || stdout).trim() || err.message });
      }
    }
  } catch (err: any) {
    log.error(' Failed to pull:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-push - Push to remote
export const handlePostGitPush = async (req: Request, res: Response) => {
  try {
    const { directory, remote, branch, setUpstream } = req.body as { directory?: string; remote?: string; branch?: string; setUpstream?: boolean };
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
      let cmd = 'git push';
      if (setUpstream) cmd += ' -u';
      if (remote) cmd += ` "${remote}"`;
      if (branch) cmd += ` "${branch}"`;
      const output = execSync(cmd, { cwd: gitRoot, encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
      res.json({ success: true, output: output.trim() });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('rejected')) {
        res.status(409).json({ success: false, error: 'Push rejected. Pull first to integrate remote changes.' });
      } else if (stderr.includes('no upstream')) {
        res.status(400).json({ success: false, error: 'No upstream branch configured. Use "Set Upstream" option.' });
      } else if (stderr.includes('ETIMEDOUT') || stderr.includes('Could not resolve')) {
        res.status(504).json({ success: false, error: 'Network error. Check your connection.' });
      } else {
        res.status(500).json({ success: false, error: stderr.trim() || err.message });
      }
    }
  } catch (err: any) {
    log.error(' Failed to push:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/git-log-message - Get last commit message (for amend)
export const handleGetGitLogMessage = async (req: Request, res: Response) => {
  try {
    const dirPath = req.query.path as string;
    if (!dirPath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: dirPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    try {
      const message = execSync('git log -1 --format=%B', { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      res.json({ message });
    } catch {
      res.json({ message: '' });
    }
  } catch (err: any) {
    log.error(' Failed to get log message:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-commit - Commit staged changes
export const handlePostGitCommit = async (req: Request, res: Response) => {
  try {
    const { directory, message, amend, paths } = req.body as {
      directory?: string;
      message?: string;
      amend?: boolean;
      paths?: string[];
    };

    if (!directory || typeof directory !== 'string') {
      res.status(400).json({ error: 'Missing directory parameter' });
      return;
    }
    if (!path.isAbsolute(directory)) {
      res.status(400).json({ error: 'Directory must be absolute' });
      return;
    }
    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Commit message cannot be empty' });
      return;
    }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not in a git repository' });
      return;
    }

    // If specific paths are provided, stage them first
    if (paths && Array.isArray(paths) && paths.length > 0) {
      const relativePaths: string[] = [];
      for (const p of paths) {
        if (!path.isAbsolute(p)) {
          res.status(400).json({ error: `Path must be absolute: ${p}` });
          return;
        }
        const rel = path.relative(gitRoot, p);
        if (rel.startsWith('..')) {
          res.status(400).json({ error: `Path is outside the git repository: ${p}` });
          return;
        }
        relativePaths.push(rel);
      }
      const quotedPaths = relativePaths.map(p => `"${p}"`).join(' ');
      try {
        execSync(`git add ${quotedPaths}`, { cwd: gitRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      } catch (err: any) {
        res.status(500).json({ success: false, error: `Failed to stage files: ${err.message}` });
        return;
      }
    }

    // Build commit command - write message to a temp file to avoid shell escaping issues
    const tmpFile = path.join(gitRoot, '.git', 'TIDE_COMMIT_MSG');
    try {
      fs.writeFileSync(tmpFile, message, 'utf-8');
      let cmd = `git commit -F "${tmpFile}"`;
      if (amend) cmd = `git commit --amend -F "${tmpFile}"`;

      const output = execSync(cmd, { cwd: gitRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      res.json({ success: true, output: output.trim() });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message || '';
      if (stderr.includes('nothing to commit') || stderr.includes('nothing added to commit')) {
        res.status(400).json({ success: false, error: 'Nothing to commit. Stage files first.' });
      } else {
        res.status(500).json({ success: false, error: stderr.trim() || err.message });
      }
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch (err: any) {
    log.error(' Failed to commit:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/git-fetch - Run git fetch in a directory
export const handlePostGitFetch = async (req: Request, res: Response) => {
  try {
    const dirPath = (req.body as { path?: string }).path;
    if (!dirPath || typeof dirPath !== 'string') { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(dirPath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (!fs.existsSync(dirPath)) { res.status(404).json({ error: 'Directory not found' }); return; }

    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { cwd: dirPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      res.status(400).json({ error: 'Not a git repository' });
      return;
    }

    try {
      execSync('git fetch --prune', { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
    } catch (err: any) {
      res.status(500).json({ error: `git fetch failed: ${err.message}` });
      return;
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
