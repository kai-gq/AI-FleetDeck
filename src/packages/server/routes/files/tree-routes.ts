/**
 * 目录树与文件操作路由:/list、/tree、/rename、/create、/copy、/paste。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, type FileEntry, type TreeNode, toPosixSeparators, resolveAndValidateFilePath } from './fs-utils.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { detectRunnerType, mightBeTestFile, mightBeVitestFile, mightBePhpTestFile } from '../../services/test-runner-service.js';
import { TestRunnerType } from '../../../shared/types.js';

// GET /api/files/list - List directory contents
export const handleGetList = async (req: Request, res: Response) => {
  try {
    const resolution = resolveAndValidateFilePath(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    const dirPath = resolution.path;

    if (!fs.existsSync(dirPath)) {
      res.status(404).json({ error: 'Directory not found', path: dirPath });
      return;
    }

    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' });
      return;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files: FileEntry[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        const entryStats = fs.statSync(fullPath);
        files.push({
          name: entry.name,
          path: toPosixSeparators(fullPath),
          isDirectory: entry.isDirectory(),
          size: entryStats.size,
          modified: entryStats.mtime,
          extension: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
        });
      } catch {
        // Skip files we can't stat (permission issues, etc.)
      }
    }

    // Sort: directories first, then alphabetically
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json({
      path: toPosixSeparators(dirPath),
      parent: toPosixSeparators(path.dirname(dirPath)),
      files,
    });
  } catch (err: any) {
    log.error(' Failed to list directory:', err);
    res.status(500).json({ error: err.message });
  }
};

// Helper function to build tree recursively
function buildTree(
  dirPath: string,
  depth: number,
  maxDepth: number,
  runnerMemo: Map<string, TestRunnerType | undefined> = new Map(),
): TreeNode[] {
  if (depth > maxDepth) return [];

  const nodes: TreeNode[] = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Skip common non-essential directories (but keep 'build' for APK access)
      if (['node_modules', 'dist', '.git', '__pycache__', 'venv', '.venv'].includes(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);

      try {
        const stats = fs.statSync(fullPath);
        const node: TreeNode = {
          name: entry.name,
          // API boundary: emit '/' so the browser can split/join the tree paths.
          // fs recursion below still uses the native `fullPath`.
          path: toPosixSeparators(fullPath),
          isDirectory: entry.isDirectory(),
          size: stats.size,
          extension: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
        };

        if (entry.isDirectory()) {
          // Annotate testable folders so the explorer can offer "Run Tests".
          const runnerType = detectRunnerType(fullPath, runnerMemo);
          if (runnerType) node.runnerType = runnerType;
          node.children = buildTree(fullPath, depth + 1, maxDepth, runnerMemo);
        } else if (mightBeTestFile(entry.name) || mightBeVitestFile(entry.name) || mightBePhpTestFile(entry.name)) {
          // Annotate individual test files so "Run Tests" can scope to one class/file.
          const runnerType = detectRunnerType(fullPath, runnerMemo);
          if (runnerType) node.runnerType = runnerType;
        }

        nodes.push(node);
      } catch {
        // Skip files we can't access
      }
    }

    // Sort: directories first, then alphabetically
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch {
    // Return empty if can't read directory
  }

  return nodes;
}

function ensureAbsoluteExistingPath(targetPath: string): string | null {
  if (!targetPath || !path.isAbsolute(targetPath)) return null;
  return fs.existsSync(targetPath) ? targetPath : null;
}

function resolveUniqueCopyPath(targetDir: string, sourceName: string): string {
  const extension = path.extname(sourceName);
  const baseName = extension ? sourceName.slice(0, -extension.length) : sourceName;

  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? ' copy' : ` copy ${attempt + 1}`;
    const candidateName = `${baseName}${suffix}${extension}`;
    const candidatePath = path.join(targetDir, candidateName);
    if (!fs.existsSync(candidatePath)) return candidatePath;
    attempt++;
  }
}

function copyPathToDirectory(sourcePath: string, targetDir: string): string {
  const sourceName = path.basename(sourcePath);
  const directTarget = path.join(targetDir, sourceName);
  const destinationPath = fs.existsSync(directTarget)
    ? resolveUniqueCopyPath(targetDir, sourceName)
    : directTarget;

  const sourceStats = fs.statSync(sourcePath);
  if (sourceStats.isDirectory()) {
    const rel = path.relative(sourcePath, targetDir);
    const targetInsideSource = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (targetInsideSource) {
      throw new Error('Cannot copy a folder into itself');
    }
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: false, errorOnExist: true });
  } else {
    fs.copyFileSync(sourcePath, destinationPath);
  }

  return destinationPath;
}

// GET /api/files/tree - Get recursive directory tree
export const handleGetTree = async (req: Request, res: Response) => {
  try {
    const resolution = resolveAndValidateFilePath(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    const dirPath = resolution.path;
    const maxDepth = parseInt(req.query.depth as string) || 5;

    if (!fs.existsSync(dirPath)) {
      res.status(404).json({ error: 'Directory not found', path: dirPath });
      return;
    }

    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' });
      return;
    }

    const tree = buildTree(dirPath, 0, maxDepth);
    // Also report the runner for the requested directory itself, so the client
    // can offer "Run Tests" on the tree's root node (built client-side).
    const runnerType = detectRunnerType(dirPath);

    res.json({
      path: toPosixSeparators(dirPath),
      name: path.basename(dirPath),
      tree,
      ...(runnerType ? { runnerType } : {}),
    });
  } catch (err: any) {
    log.error(' Failed to build tree:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/rename - Rename file or folder in place
export const handlePostRename = (req: Request, res: Response) => {
  try {
    const { path: sourcePath, newName } = req.body as { path?: string; newName?: string };

    const validatedSource = sourcePath && ensureAbsoluteExistingPath(sourcePath);
    if (!validatedSource) {
      res.status(400).json({ error: 'Invalid or missing source path' });
      return;
    }

    const nextName = (newName || '').trim();
    if (!nextName || nextName === '.' || nextName === '..') {
      res.status(400).json({ error: 'Invalid new name' });
      return;
    }
    if (nextName.includes('/') || nextName.includes('\\')) {
      res.status(400).json({ error: 'Name must not contain path separators' });
      return;
    }

    const destinationPath = path.join(path.dirname(validatedSource), nextName);
    if (validatedSource === destinationPath) {
      res.json({ success: true, newPath: destinationPath });
      return;
    }

    if (fs.existsSync(destinationPath)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }

    fs.renameSync(validatedSource, destinationPath);
    res.json({ success: true, oldPath: validatedSource, newPath: destinationPath });
  } catch (err: any) {
    log.error(' Failed to rename path:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/create - Create a new file or folder inside a target directory
export const handlePostCreate = (req: Request, res: Response) => {
  try {
    const { parentDir, name, isDirectory } = req.body as {
      parentDir?: string;
      name?: string;
      isDirectory?: boolean;
    };

    const validatedParent = parentDir && ensureAbsoluteExistingPath(parentDir);
    if (!validatedParent) {
      res.status(400).json({ error: 'Invalid or missing parent directory' });
      return;
    }

    const parentStats = fs.statSync(validatedParent);
    if (!parentStats.isDirectory()) {
      res.status(400).json({ error: 'Parent path is not a directory' });
      return;
    }

    const nextName = (name || '').trim();
    if (!nextName || nextName === '.' || nextName === '..') {
      res.status(400).json({ error: 'Invalid name' });
      return;
    }
    if (nextName.includes('/') || nextName.includes('\\')) {
      res.status(400).json({ error: 'Name must not contain path separators' });
      return;
    }

    const destinationPath = path.join(validatedParent, nextName);
    if (fs.existsSync(destinationPath)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }

    if (isDirectory) {
      fs.mkdirSync(destinationPath);
    } else {
      fs.writeFileSync(destinationPath, '', { flag: 'wx' });
    }

    res.json({ success: true, path: destinationPath, isDirectory: !!isDirectory });
  } catch (err: any) {
    log.error(' Failed to create path:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/copy - Copy file/folder into target directory
export const handlePostCopy = (req: Request, res: Response) => {
  try {
    const { sourcePath, targetDir } = req.body as { sourcePath?: string; targetDir?: string };

    const validatedSource = sourcePath && ensureAbsoluteExistingPath(sourcePath);
    if (!validatedSource) {
      res.status(400).json({ error: 'Invalid or missing source path' });
      return;
    }
    const validatedTargetDir = targetDir && ensureAbsoluteExistingPath(targetDir);
    if (!validatedTargetDir) {
      res.status(400).json({ error: 'Invalid or missing target directory' });
      return;
    }

    const targetStats = fs.statSync(validatedTargetDir);
    if (!targetStats.isDirectory()) {
      res.status(400).json({ error: 'Target must be a directory' });
      return;
    }

    const destinationPath = copyPathToDirectory(validatedSource, validatedTargetDir);
    res.json({ success: true, sourcePath: validatedSource, destinationPath });
  } catch (err: any) {
    log.error(' Failed to copy path:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/paste - Alias for copy operation from clipboard source
export const handlePostPaste = (req: Request, res: Response) => {
  try {
    const { sourcePath, targetDir } = req.body as { sourcePath?: string; targetDir?: string };

    const validatedSource = sourcePath && ensureAbsoluteExistingPath(sourcePath);
    if (!validatedSource) {
      res.status(400).json({ error: 'Invalid or missing source path' });
      return;
    }
    const validatedTargetDir = targetDir && ensureAbsoluteExistingPath(targetDir);
    if (!validatedTargetDir) {
      res.status(400).json({ error: 'Invalid or missing target directory' });
      return;
    }

    const targetStats = fs.statSync(validatedTargetDir);
    if (!targetStats.isDirectory()) {
      res.status(400).json({ error: 'Target must be a directory' });
      return;
    }

    const destinationPath = copyPathToDirectory(validatedSource, validatedTargetDir);
    res.json({ success: true, sourcePath: validatedSource, destinationPath });
  } catch (err: any) {
    log.error(' Failed to paste path:', err);
    res.status(500).json({ error: err.message });
  }
};
