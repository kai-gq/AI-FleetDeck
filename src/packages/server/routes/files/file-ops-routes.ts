/**
 * 文件操作路由:编辑器打开/定位/写入/上传/临时文件/删除/补全。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, TEMP_DIR, binaryContentTypeForExtension, validateRevealPath, revealPathInFileExplorer } from './fs-utils.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';

// POST /api/files/open-in-editor - Open file in specified or default editor
export const handlePostOpenInEditor = async (req: Request, res: Response) => {
  try {
    const { path: filePath, editorCommand } = req.body as { path?: string; editorCommand?: string };
    if (!filePath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(filePath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (filePath.includes('..')) { res.status(400).json({ error: 'Path traversal not allowed' }); return; }
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found' }); return; }

    const platform = process.platform;
    let cmd: string;
    let args: string[];

    // If custom editor command is provided, use it
    if (editorCommand && editorCommand.trim()) {
      // Parse the command string to separate command and arguments
      const parts = editorCommand.trim().split(/\s+/);
      cmd = parts[0];
      args = [...parts.slice(1), filePath];
    } else {
      // Use platform default
      if (platform === 'linux') {
        cmd = 'xdg-open';
        args = [filePath];
      } else if (platform === 'darwin') {
        cmd = 'open';
        args = [filePath];
      } else if (platform === 'win32') {
        cmd = 'cmd';
        args = ['/c', 'start', '', filePath];
      } else {
        res.status(500).json({ error: `Unsupported platform: ${platform}` });
        return;
      }
    }

    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();

    res.json({ success: true });
  } catch (err: any) {
    log.error(' Failed to open in editor:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/reveal - Reveal a file in the system file explorer
export const handlePostReveal = async (req: Request, res: Response) => {
  try {
    const validation = validateRevealPath((req.body as { path?: unknown })?.path);
    if (!validation.ok) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }

    const method = await revealPathInFileExplorer(validation.path);
    res.json({ success: true, method });
  } catch (err: any) {
    log.error(' Failed to reveal file in explorer:', err);
    const message = err?.message || 'Failed to reveal file in explorer';
    if (message.startsWith('Unsupported platform:')) {
      res.status(500).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
};

// POST /api/files/write - Write content to an existing file
export const handlePostWrite = async (req: Request, res: Response) => {
  try {
    const { path: filePath, content } = req.body as { path?: string; content?: string };
    if (!filePath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (typeof content !== 'string') { res.status(400).json({ error: 'Missing content parameter' }); return; }
    if (!path.isAbsolute(filePath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    if (filePath.includes('..')) { res.status(400).json({ error: 'Path traversal not allowed' }); return; }
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found' }); return; }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) { res.status(400).json({ error: 'Cannot write to a directory' }); return; }

    // Limit write size to 2MB
    const MAX_WRITE_SIZE = 2 * 1024 * 1024;
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_SIZE) {
      res.status(400).json({ error: 'Content exceeds maximum size (2MB)' });
      return;
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true });
  } catch (err: any) {
    log.error(' Failed to write file:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/by-path - Load and return a file by its path (for clipboard paste)
export const handlePostByPath = async (req: Request, res: Response) => {
  try {
    const { path: filePath } = req.body as { path?: string };

    if (!filePath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    // Expand ~ to home directory
    let expandedPath = filePath;
    if (filePath.startsWith('~')) {
      expandedPath = path.join(os.homedir(), filePath.slice(1));
    }

    // Security: ensure path is absolute
    if (!path.isAbsolute(expandedPath)) {
      res.status(400).json({ error: 'Path must be absolute' });
      return;
    }

    if (!fs.existsSync(expandedPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stats = fs.statSync(expandedPath);

    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory' });
      return;
    }

    // Limit file size to 50MB for binary files
    if (stats.size > 50 * 1024 * 1024) {
      res.status(400).json({ error: 'File too large (max 50MB)' });
      return;
    }

    const extension = path.extname(expandedPath).toLowerCase();
    const _filename = path.basename(expandedPath);

    // Determine if it's an image
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'];
    const _isImage = imageExtensions.includes(extension);

    res.setHeader('Content-Type', binaryContentTypeForExtension(extension));
    res.setHeader('Content-Length', stats.size);

    // Stream the file
    const stream = fs.createReadStream(expandedPath);
    stream.pipe(res);

    stream.on('error', (err) => {
      log.error(' Failed to stream file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read file' });
      }
    });
  } catch (err: any) {
    log.error(' Failed to load file by path:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/upload - Upload a file to temp directory
export const handlePostUpload = async (req: Request, res: Response) => {
  try {
    const contentType = req.headers['content-type'] || '';
    let filename = req.headers['x-filename'] as string;
    const isImage = contentType.startsWith('image/');

    // Decode filename if it's URL-encoded (handles special characters like –, é, etc.)
    if (filename) {
      try {
        filename = decodeURIComponent(filename);
      } catch {
        // If decoding fails, use as-is
      }
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);

    let finalFilename: string;
    let extension: string;

    if (filename) {
      // Use provided filename with unique prefix
      extension = path.extname(filename);
      const baseName = path.basename(filename, extension);
      finalFilename = `${baseName}-${randomId}${extension}`;
    } else if (isImage) {
      // Determine extension from content type
      const extMap: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
      };
      extension = extMap[contentType] || '.png';
      finalFilename = `image-${timestamp}-${randomId}${extension}`;
    } else {
      // Default to txt
      extension = '.txt';
      finalFilename = `file-${timestamp}-${randomId}${extension}`;
    }

    const filePath = path.join(TEMP_DIR, finalFilename);

    // Collect body data
    const chunks: Buffer[] = [];
    let received = 0;
    const startedAt = Date.now();
    const declaredLength = Number(req.headers['content-length'] || 0);

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
    });

    req.on('end', () => {
      const buffer = Buffer.concat(chunks);

      // Write file
      fs.writeFileSync(filePath, buffer);

      log.log(` Uploaded: ${filePath} (${buffer.length} bytes)`);

      res.json({
        success: true,
        path: `/uploads/${finalFilename}`,
        absolutePath: filePath,
        filename: finalFilename,
        size: buffer.length,
        isImage,
        tempDir: TEMP_DIR,
      });
    });

    // A bare "Upload error: ECONNRESET" says nothing about WHERE the transfer
    // died, which is the only thing that separates a client abort from a
    // connection torn down under us. Record how far the body got, so the log
    // line alone distinguishes "never sent a byte" (socket was already dead —
    // e.g. a keep-alive reuse race) from "stalled at N bytes" (network/size).
    const describeTransfer = () => {
      const elapsed = Date.now() - startedAt;
      const pct = declaredLength > 0 ? ` (${Math.round((received / declaredLength) * 100)}%)` : '';
      return `${received}/${declaredLength || '?'} bytes${pct} after ${elapsed}ms`
        + ` · type=${contentType || 'none'} · secure=${req.secure} · peer=${req.socket.remoteAddress || '?'}`;
    };

    req.on('aborted', () => {
      log.error(` Upload aborted by client: ${describeTransfer()}`);
    });

    req.on('error', (err) => {
      log.error(` Upload error (${(err as NodeJS.ErrnoException).code || err.message}): ${describeTransfer()}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Upload failed' });
      }
    });
  } catch (err: any) {
    log.error(' Failed to upload file:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/temp-dir - Get the temp directory path
export const handleGetTempDir = (_req: Request, res: Response) => {
  res.json({ path: TEMP_DIR });
};

// GET /api/files/autocomplete - Autocomplete paths for folder/file input
export const handleGetAutocomplete = async (req: Request, res: Response) => {
  try {
    const inputPath = req.query.path as string;
    const directoriesOnly = req.query.dirs === 'true';
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

    if (!inputPath) {
      // Return common starting points
      const homedir = os.homedir();
      const suggestions = [
        { name: '~', path: homedir, isDirectory: true },
        { name: '/', path: '/', isDirectory: true },
      ];
      res.json({ suggestions, basePath: '', partial: '' });
      return;
    }

    // Expand ~ to home directory
    let expandedPath = inputPath;
    if (inputPath.startsWith('~')) {
      expandedPath = path.join(os.homedir(), inputPath.slice(1));
    }

    // Determine base directory and partial name being typed
    let basePath: string;
    let partial: string;

    if (expandedPath.endsWith('/') || expandedPath === '/') {
      // User ended with / - list contents of that directory
      basePath = expandedPath === '/' ? '/' : expandedPath.slice(0, -1);
      partial = '';
    } else {
      // User is typing a partial name - get parent directory
      basePath = path.dirname(expandedPath);
      partial = path.basename(expandedPath).toLowerCase();
    }

    // Check if base path exists
    if (!fs.existsSync(basePath)) {
      // Try to find the closest existing parent
      let checkPath = basePath;
      while (checkPath !== '/' && !fs.existsSync(checkPath)) {
        checkPath = path.dirname(checkPath);
      }
      res.json({ suggestions: [], basePath: checkPath, partial, error: 'Path not found' });
      return;
    }

    // Check if it's a directory
    const stats = fs.statSync(basePath);
    if (!stats.isDirectory()) {
      res.json({ suggestions: [], basePath, partial, error: 'Not a directory' });
      return;
    }

    // Read directory entries
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    const suggestions: Array<{ name: string; path: string; isDirectory: boolean }> = [];

    for (const entry of entries) {
      // Skip hidden files unless user is explicitly typing a dot
      if (entry.name.startsWith('.') && !partial.startsWith('.')) continue;

      // Filter by partial match
      if (partial && !entry.name.toLowerCase().startsWith(partial)) continue;

      // Filter by directories only if requested
      if (directoriesOnly && !entry.isDirectory()) continue;

      const fullPath = path.join(basePath, entry.name);

      suggestions.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
      });

      if (suggestions.length >= limit) break;
    }

    // Sort: directories first, then alphabetically
    suggestions.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json({ suggestions, basePath, partial });
  } catch (err: any) {
    log.error(' Failed to autocomplete path:', err);
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/files/temp/:filename - Delete a temp file
export const handleDeleteTempFilename = (req: Request<{ filename: string }>, res: Response) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(TEMP_DIR, filename);

    // Security: ensure file is in temp dir
    if (!filePath.startsWith(TEMP_DIR)) {
      res.status(403).json({ error: 'Invalid path' });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err: any) {
    log.error(' Failed to delete temp file:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/delete - Delete a file or (with recursive: true) a directory
export const handlePostDelete = (req: Request, res: Response) => {
  try {
    const { path: filePath, recursive } = req.body as { path?: string; recursive?: boolean };
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }
    if (!path.isAbsolute(filePath)) {
      res.status(400).json({ error: 'Path must be absolute' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (!recursive) {
        res.status(400).json({ error: 'Pass recursive: true to delete directories' });
        return;
      }
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err: any) {
    log.error(' Failed to delete path:', err);
    res.status(500).json({ error: err.message });
  }
};
