/**
 * 读取与解析路由:/read、HTML 预览、/resolve、/exists、/recover。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, type TreeNode, looksLikeBinaryBuffer, resolveAndValidateFilePath } from './fs-utils.js';
import { findFileWithFallbacks, attachMissingDiagnosis } from './path-resolve.js';
import { HTML_PREVIEW_DOCUMENT_EXTENSIONS, HTML_PREVIEW_STYLESHEET_EXTENSIONS, HTML_PREVIEW_SCRIPT_EXTENSIONS, htmlPreviewUrl, rewriteHtmlPreviewCss, rewriteHtmlPreviewScript, rewriteHtmlPreviewDocument, resolveHtmlPreviewRequest } from './html-preview.js';
import { searchFilesAsync } from './search-routes.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { diagnoseMissingFile, findConversationSnapshots, gitHeadCopy, type RecoveredCopy } from '../../services/file-recovery.js';

// GET /api/files/read - Read file contents
export const handleGetRead = async (req: Request, res: Response) => {
  try {
    const resolution = findFileWithFallbacks(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      const body: Record<string, unknown> = { error: resolution.error };
      if (resolution.requested) body.path = resolution.requested;
      if (resolution.tried) body.triedRoots = resolution.tried;
      attachMissingDiagnosis(body, resolution);
      res.status(resolution.status).json(body);
      return;
    }
    const filePath = resolution.path;

    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory', path: filePath });
      return;
    }

    // Limit file size to 1MB
    if (stats.size > 1024 * 1024) {
      res.status(400).json({ error: 'File too large (max 1MB)' });
      return;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    const base = {
      path: filePath,
      filename,
      extension,
      size: stats.size,
      modified: stats.mtime,
      strategy: resolution.strategy,
      areaId: resolution.areaId,
      areaName: resolution.areaName,
    };

    if (looksLikeBinaryBuffer(fileBuffer)) {
      res.status(415).json({ ...base, binary: true, error: 'Binary file cannot be read as text' });
      return;
    }

    const content = fileBuffer.toString('utf-8');

    // Preview mode (Ctrl+hover tooltip in the terminal): return only the
    // requested line window. Reading the file is cheap; shipping a 1MB body
    // over the wire on every hover is not.
    const previewLines = Number(req.query.previewLines);
    if (Number.isFinite(previewLines) && previewLines > 0) {
      const allLines = content.split('\n');
      const rawOffset = Number(req.query.previewOffset);
      const startLine = Number.isFinite(rawOffset) && rawOffset >= 1
        ? Math.min(Math.floor(rawOffset), Math.max(allLines.length, 1))
        : 1;
      const slice = allLines.slice(startLine - 1, startLine - 1 + Math.floor(previewLines));
      res.json({
        ...base,
        content: slice.join('\n'),
        preview: {
          startLine,
          totalLines: allLines.length,
          truncated: startLine - 1 + slice.length < allLines.length,
        },
      });
      return;
    }

    res.json({ ...base, content });
  } catch (err: any) {
    log.error(' Failed to read file:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/html-preview - Render an HTML document with local dependencies rewritten.
export const handleGetHtmlPreview = (req: Request, res: Response) => {
  try {
    const preview = resolveHtmlPreviewRequest(req);
    if (!preview.ok) { res.status(preview.status).send(preview.error); return; }
    const stats = fs.statSync(preview.filePath);
    if (!stats.isFile() || !HTML_PREVIEW_DOCUMENT_EXTENSIONS.has(path.extname(preview.filePath).toLowerCase())) {
      res.status(400).send('HTML preview requires an .html or .htm file');
      return;
    }
    if (stats.size > 10 * 1024 * 1024) { res.status(400).send('HTML file too large (max 10MB)'); return; }
    const document = rewriteHtmlPreviewDocument(
      fs.readFileSync(preview.filePath, 'utf-8'),
      preview.filePath,
      preview.previewRoot,
      preview.token,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * data: blob:; frame-src * data: blob:;");
    res.send(document);
  } catch (err: any) {
    log.error(' Failed to render HTML preview:', err);
    res.status(500).send(err.message || 'Failed to render HTML preview');
  }
};

// GET /api/files/html-preview-resource - Serve/rewrite one dependency of the preview.
export const handleGetHtmlPreviewResource = (req: Request, res: Response) => {
  try {
    const preview = resolveHtmlPreviewRequest(req);
    if (!preview.ok) { res.status(preview.status).send(preview.error); return; }
    const stats = fs.statSync(preview.filePath);
    if (!stats.isFile()) { res.status(400).send('Preview resource is not a file'); return; }
    const extension = path.extname(preview.filePath).toLowerCase();
    if (HTML_PREVIEW_DOCUMENT_EXTENSIONS.has(extension)) {
      res.redirect(302, htmlPreviewUrl(preview.filePath, preview.previewRoot, preview.token, true));
      return;
    }
    if (HTML_PREVIEW_STYLESHEET_EXTENSIONS.has(extension)) {
      res.type('text/css').setHeader('Cache-Control', 'no-store');
      res.send(rewriteHtmlPreviewCss(fs.readFileSync(preview.filePath, 'utf-8'), preview.filePath, preview.previewRoot, preview.token));
      return;
    }
    if (HTML_PREVIEW_SCRIPT_EXTENSIONS.has(extension)) {
      res.type('application/javascript').setHeader('Cache-Control', 'no-store');
      res.send(rewriteHtmlPreviewScript(fs.readFileSync(preview.filePath, 'utf-8'), preview.filePath, preview.previewRoot, preview.token));
      return;
    }
    const params = new URLSearchParams({ path: preview.filePath });
    if (preview.token) params.set('token', preview.token);
    res.redirect(302, `/api/files/binary?${params.toString()}`);
  } catch (err: any) {
    log.error(' Failed to serve HTML preview resource:', err);
    res.status(500).send(err.message || 'Failed to serve HTML preview resource');
  }
};

// GET /api/files/resolve - Find a file by name/partial path within a project directory
export const handleGetResolve = async (req: Request, res: Response) => {
  try {
    const filename = req.query.name as string;
    const searchRoot = req.query.root as string;

    if (!filename) {
      res.status(400).json({ error: 'Missing name parameter' });
      return;
    }

    if (!searchRoot || !path.isAbsolute(searchRoot)) {
      res.status(400).json({ error: 'Missing or invalid root parameter (must be absolute)' });
      return;
    }

    if (!fs.existsSync(searchRoot)) {
      res.status(404).json({ error: 'Root directory not found' });
      return;
    }

    const results: TreeNode[] = [];
    const basename = path.basename(filename);
    const hasPathSeparator = filename.includes('/');

    // Check well-known locations first (e.g., .claude/ directory for config files)
    const wellKnownPaths = [
      path.join(searchRoot, '.claude', basename),
    ];
    for (const wkPath of wellKnownPaths) {
      try {
        if (fs.existsSync(wkPath)) {
          const stats = fs.statSync(wkPath);
          results.push({
            name: path.basename(wkPath),
            path: wkPath,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            extension: stats.isDirectory() ? '' : path.extname(wkPath).toLowerCase(),
          });
        }
      } catch { /* skip */ }
    }

    // Search for files matching the basename (searchFilesAsync may re-find .claude/ files)
    const existingPaths = new Set(results.map(r => r.path));
    const searchResults: TreeNode[] = [];
    await searchFilesAsync(searchRoot, basename.toLowerCase(), searchResults, 20);
    for (const r of searchResults) {
      if (!existingPaths.has(r.path)) results.push(r);
    }

    // If the query had path segments (e.g. "components/App.tsx"), rank results
    // that contain the full partial path higher
    if (hasPathSeparator) {
      const normalizedQuery = filename.replace(/^\.\//, '');
      results.sort((a, b) => {
        const aContains = a.path.includes(normalizedQuery) ? 1 : 0;
        const bContains = b.path.includes(normalizedQuery) ? 1 : 0;
        if (aContains !== bContains) return bContains - aContains;
        // Prefer files over directories
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? 1 : -1;
        // Shorter paths first (closer to project root = more likely the right file)
        return a.path.length - b.path.length;
      });
    } else {
      // Sort: exact basename match first, then files before dirs, then shorter paths
      results.sort((a, b) => {
        const aExact = a.name === basename ? 1 : 0;
        const bExact = b.name === basename ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? 1 : -1;
        return a.path.length - b.path.length;
      });
    }

    res.json({ results });
  } catch (err: any) {
    log.error(' Failed to resolve file:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/exists - Check if a file exists
export const handleGetExists = async (req: Request, res: Response) => {
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

    const exists = fs.existsSync(filePath);
    res.json({ exists, path: filePath });
  } catch (err: any) {
    log.error(' Failed to check file existence:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/files/exists-batch - Can these references still be opened? Backs
// the "dead link" styling of file chips in the conversation: one request per
// batch of visible chips. Uses the SAME resolver as the viewer (cheap
// strategies only), so a chip is marked dead only when clicking it could not
// open anything — a relative path the agent wrote from a workspace folder
// (`apps/x/y.ts` from ~/d) is alive if it resolves under one of its repos.
// Body: { items: [{ path, baseDir? }] } → { results: boolean[] } (same order).
const EXISTS_BATCH_MAX = 300;

export const handlePostExistsBatch = (req: Request, res: Response) => {
  const rawItems: unknown = req.body?.items;
  if (!Array.isArray(rawItems)) {
    res.status(400).json({ error: 'items must be an array' });
    return;
  }
  const results = rawItems.slice(0, EXISTS_BATCH_MAX).map((item) => {
    const rawPath = item && typeof item.path === 'string' ? item.path : '';
    const baseDir = item && typeof item.baseDir === 'string' ? item.baseDir : undefined;
    if (!rawPath) return false;
    try {
      return findFileWithFallbacks(rawPath, baseDir, { cheap: true }).ok
        // A directory reference is alive too (the viewer lists it).
        || fs.existsSync(rawPath);
    } catch {
      return false;
    }
  });
  res.json({ results });
};

// GET /api/files/recover - Copies of a missing file that can still be shown:
// the git HEAD version (tracked files) and the last copy an agent conversation
// recorded (Write body, full-file Read, image Read). Never touches the disk
// target — recovery is view/download only.
export const handleGetRecover = async (req: Request, res: Response) => {
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
    if (fs.existsSync(filePath)) {
      res.json({ path: filePath, exists: true, copies: [] });
      return;
    }
    const diagnosis = diagnoseMissingFile(filePath);
    const copies: RecoveredCopy[] = [];
    const head = diagnosis.git ? gitHeadCopy(filePath, diagnosis.git) : null;
    if (head) copies.push(head);
    copies.push(...await findConversationSnapshots(filePath, req.query.baseDir as string | undefined));
    res.json({ path: filePath, exists: false, diagnosis, copies });
  } catch (err: any) {
    log.error(' Failed to recover file:', err);
    res.status(500).json({ error: err.message });
  }
};
