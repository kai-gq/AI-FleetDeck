/**
 * 内容路由:文件信息、压缩包、表格、文档、二进制、目录下载与 Markdown PDF。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, binaryContentTypeForExtension, parseByteRange, resolveAndValidateFilePath } from './fs-utils.js';
import { findFileWithFallbacks, attachMissingDiagnosis } from './path-resolve.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';
import { Browser as PuppeteerBrowser } from 'puppeteer-core';
import { detectArchiveFormat, listArchive } from '../../services/archive-listing.js';
import { readSpreadsheet, detectSpreadsheetKind, UnsupportedSpreadsheetError, SPREADSHEET_DEFAULT_MAX_ROWS, SPREADSHEET_DEFAULT_MAX_COLS, SPREADSHEET_HARD_MAX_ROWS, SPREADSHEET_HARD_MAX_COLS, zipSourceFromFd } from '../../services/spreadsheet-parse.js';
import { readDocument, detectDocumentKind, UnsupportedDocumentError, DOCUMENT_DEFAULT_MAX_BLOCKS, DOCUMENT_HARD_MAX_BLOCKS } from '../../services/document-parse.js';

// Viewer metadata and model bytes must always reflect the file currently on
// disk. authFetch also requests `no-store`, but these response headers cover
// direct URLs, embedded previews, proxies, and browser revalidation.
export const handleUseInfoBinary = (_req: Request, res: Response, next: import('express').NextFunction) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};

// GET /api/files/info - Get file info without content
export const handleGetInfo = async (req: Request, res: Response) => {
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

    const extension = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    res.json({
      path: filePath,
      filename,
      extension,
      size: stats.size,
      modified: stats.mtime,
      strategy: resolution.strategy,
      areaId: resolution.areaId,
      areaName: resolution.areaName,
    });
  } catch (err: any) {
    log.error(' Failed to get file info:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/archive - List the entries of a compressed archive (zip/jar/
// tar.*/7z/rar/… — see archive-listing.ts) without extracting it. Used by the
// file viewers to render an archive as a browsable tree instead of "binary".
export const handleGetArchive = async (req: Request, res: Response) => {
  try {
    const resolution = findFileWithFallbacks(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      const body: Record<string, unknown> = { error: resolution.error };
      if (resolution.requested) body.path = resolution.requested;
      if (resolution.tried) body.triedRoots = resolution.tried;
      res.status(resolution.status).json(body);
      return;
    }
    const filePath = resolution.path;
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory', path: filePath });
      return;
    }
    const filename = path.basename(filePath);
    if (!detectArchiveFormat(filename)) {
      res.status(415).json({ error: 'Not a supported archive type', path: filePath });
      return;
    }
    const listing = await listArchive(filePath);
    let fileCount = 0;
    let dirCount = 0;
    let totalSize: number | null = 0;
    let totalCompressed: number | null = 0;
    for (const e of listing.entries) {
      if (e.isDir) dirCount++; else fileCount++;
      if (totalSize !== null) totalSize = e.size === null && !e.isDir ? null : totalSize + (e.size ?? 0);
      if (totalCompressed !== null) totalCompressed = e.compressedSize === null && !e.isDir ? null : totalCompressed + (e.compressedSize ?? 0);
    }
    res.json({
      path: filePath,
      filename,
      extension: path.extname(filePath).toLowerCase(),
      size: stats.size,
      modified: stats.mtime,
      format: listing.format,
      tool: listing.tool,
      entries: listing.entries,
      entryCount: listing.entries.length,
      fileCount,
      dirCount,
      totalSize,
      totalCompressed,
      truncated: listing.truncated,
    });
  } catch (err: any) {
    log.error(' Failed to list archive:', err);
    res.status(422).json({ error: err.message });
  }
};

/** Parsed spreadsheet windows, most-recently-used last (Map preserves order). */
const spreadsheetCache = new Map<string, Record<string, unknown>>();

const SPREADSHEET_CACHE_ENTRIES = 24;

// GET /api/files/spreadsheet - Parse a spreadsheet (xlsx/xlsm/csv/tsv — see
// spreadsheet-parse.ts) into a capped grid for the file viewers. One sheet per
// call (`sheet` index, default 0); `rows`/`cols` raise the caps up to a hard
// limit. Legacy formats (.xls/.ods) answer 415 with a human explanation.
export const handleGetSpreadsheet = async (req: Request, res: Response) => {
  try {
    const resolution = findFileWithFallbacks(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      const body: Record<string, unknown> = { error: resolution.error };
      if (resolution.requested) body.path = resolution.requested;
      if (resolution.tried) body.triedRoots = resolution.tried;
      res.status(resolution.status).json(body);
      return;
    }
    const filePath = resolution.path;
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory', path: filePath });
      return;
    }
    const filename = path.basename(filePath);
    if (!detectSpreadsheetKind(filename)) {
      res.status(415).json({ error: 'Not a supported spreadsheet type', path: filePath });
      return;
    }
    const num = (v: unknown, fallback: number, hardMax: number): number => {
      const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? Math.min(n, hardMax) : fallback;
    };
    const maxRows = num(req.query.rows, SPREADSHEET_DEFAULT_MAX_ROWS, SPREADSHEET_HARD_MAX_ROWS);
    const maxCols = num(req.query.cols, SPREADSHEET_DEFAULT_MAX_COLS, SPREADSHEET_HARD_MAX_COLS);
    const sheetIndex = num(req.query.sheet, 0, 10_000);
    // Tab switches / "load more" hit the same file seconds apart: serve the
    // parsed window from a small LRU keyed by identity + mtime + size + window.
    const cacheKey = `${filePath}|${stats.mtimeMs}|${stats.size}|${sheetIndex}|${maxRows}|${maxCols}`;
    const cached = spreadsheetCache.get(cacheKey);
    if (cached) {
      spreadsheetCache.delete(cacheKey);
      spreadsheetCache.set(cacheKey, cached);
      res.json(cached);
      return;
    }
    const parsed = await readSpreadsheet(filePath, { sheetIndex, maxRows, maxCols });
    const body = {
      path: filePath,
      filename,
      extension: path.extname(filePath).toLowerCase(),
      size: stats.size,
      modified: stats.mtime,
      format: parsed.format,
      delimiter: parsed.delimiter,
      sheets: parsed.sheets,
      sheetIndex: parsed.sheetIndex,
      sheet: parsed.sheet,
      maxRows,
      maxCols,
    };
    spreadsheetCache.set(cacheKey, body);
    while (spreadsheetCache.size > SPREADSHEET_CACHE_ENTRIES) {
      const oldest = spreadsheetCache.keys().next().value;
      if (oldest === undefined) break;
      spreadsheetCache.delete(oldest);
    }
    res.json(body);
  } catch (err: any) {
    if (err instanceof UnsupportedSpreadsheetError) {
      res.status(415).json({ error: err.message, extension: err.extension, unsupported: true });
      return;
    }
    log.error(' Failed to parse spreadsheet:', err);
    res.status(422).json({ error: err.message });
  }
};

/** Parsed documents, most-recently-used last (Map preserves order). */
const documentCache = new Map<string, Record<string, unknown>>();

const DOCUMENT_CACHE_ENTRIES = 12;

// GET /api/files/document - Parse a word-processing document (docx/docm/odt/
// doc/rtf — see document-parse.ts) into renderable blocks for the file
// viewers. `blocks` caps the payload; the response says how many exist.
export const handleGetDocument = async (req: Request, res: Response) => {
  try {
    const resolution = findFileWithFallbacks(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      const body: Record<string, unknown> = { error: resolution.error };
      if (resolution.requested) body.path = resolution.requested;
      if (resolution.tried) body.triedRoots = resolution.tried;
      res.status(resolution.status).json(body);
      return;
    }
    const filePath = resolution.path;
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory', path: filePath });
      return;
    }
    const filename = path.basename(filePath);
    if (!detectDocumentKind(filename)) {
      res.status(415).json({ error: 'Not a supported document type', path: filePath });
      return;
    }
    const rawBlocks = typeof req.query.blocks === 'string' ? parseInt(req.query.blocks, 10) : NaN;
    const maxBlocks = Number.isFinite(rawBlocks) && rawBlocks > 0
      ? Math.min(rawBlocks, DOCUMENT_HARD_MAX_BLOCKS)
      : DOCUMENT_DEFAULT_MAX_BLOCKS;

    const cacheKey = `${filePath}|${stats.mtimeMs}|${stats.size}|${maxBlocks}`;
    const cached = documentCache.get(cacheKey);
    if (cached) {
      documentCache.delete(cacheKey);
      documentCache.set(cacheKey, cached);
      res.json(cached);
      return;
    }
    const parsed = await readDocument(filePath, { maxBlocks });
    const body = {
      path: filePath,
      filename,
      extension: path.extname(filePath).toLowerCase(),
      size: stats.size,
      modified: stats.mtime,
      format: parsed.format,
      title: parsed.title,
      author: parsed.author,
      blocks: parsed.blocks,
      footnotes: parsed.footnotes,
      header: parsed.header,
      footer: parsed.footer,
      wordCount: parsed.wordCount,
      blockCount: parsed.blockCount,
      truncated: parsed.truncated,
      plainTextOnly: parsed.plainTextOnly,
      maxBlocks,
    };
    documentCache.set(cacheKey, body);
    while (documentCache.size > DOCUMENT_CACHE_ENTRIES) {
      const oldest = documentCache.keys().next().value;
      if (oldest === undefined) break;
      documentCache.delete(oldest);
    }
    res.json(body);
  } catch (err: any) {
    if (err instanceof UnsupportedDocumentError) {
      res.status(415).json({ error: err.message, extension: err.extension, unsupported: true });
      return;
    }
    log.error(' Failed to parse document:', err);
    res.status(422).json({ error: err.message });
  }
};

/** Image types that may be served out of a document container. */
const DOCUMENT_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.emf': 'image/emf', '.wmf': 'image/wmf', '.ico': 'image/x-icon',
};

// GET /api/files/document-media - Serve ONE embedded image out of a document
// container (docx/odt zip entry), so the viewer can render pictures inline
// without ever extracting the archive to disk.
export const handleGetDocumentMedia = async (req: Request, res: Response) => {
  let fd: fs.promises.FileHandle | undefined;
  try {
    const entry = typeof req.query.entry === 'string' ? req.query.entry : '';
    // Only media entries of the container — never an arbitrary zip member.
    if (!/^(?:word\/media\/|media\/|Pictures\/)[^/]+$/i.test(entry)) {
      res.status(400).json({ error: 'Invalid media entry' });
      return;
    }
    const resolution = findFileWithFallbacks(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    const filePath = resolution.path;
    const stats = fs.statSync(filePath);
    if (stats.isDirectory() || !detectDocumentKind(path.basename(filePath))) {
      res.status(415).json({ error: 'Not a supported document type' });
      return;
    }
    fd = await fs.promises.open(filePath, 'r');
    const src = await zipSourceFromFd(fd, stats.size);
    const data = await src.readMember(entry);
    if (!data) {
      res.status(404).json({ error: 'Media entry not found in document' });
      return;
    }
    const ext = path.extname(entry).toLowerCase();
    res.setHeader('Content-Type', DOCUMENT_MEDIA_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
  } catch (err: any) {
    log.error(' Failed to read document media:', err);
    if (!res.headersSent) res.status(422).json({ error: err.message });
  } finally {
    await fd?.close();
  }
};

// GET /api/files/binary - Read binary file (for images, PDFs, downloads)
export const handleGetBinary = async (req: Request, res: Response) => {
  try {
    const resolution = findFileWithFallbacks(
      req.query.path as string | undefined,
      req.query.baseDir as string | undefined,
    );
    if (!resolution.ok) {
      // A failed binary fetch is invisible to the user beyond a broken <img>,
      // so name the path that could not be resolved — otherwise every "broken
      // image in the client" report starts with guessing which URL was asked for.
      log.warn(` /binary ${resolution.status}: ${resolution.error} (requested: ${req.query.path})`);
      const body: Record<string, unknown> = { error: resolution.error };
      if (resolution.requested) body.path = resolution.requested;
      if (resolution.tried) body.triedRoots = resolution.tried;
      res.status(resolution.status).json(body);
      return;
    }
    const filePath = resolution.path;
    const download = req.query.download === 'true';

    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory', path: filePath });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    const contentType = binaryContentTypeForExtension(extension);

    // The 50MB cap guards the callers that swallow the whole response (image,
    // model and PDF viewers). Audio/video are exempt: the element streams them
    // in Range-sized chunks, and a 300MB screen capture is an ordinary file to
    // play — rejecting it would be the surprising behaviour.
    const isStreamableMedia = contentType.startsWith('video/') || contentType.startsWith('audio/');
    if (!isStreamableMedia && stats.size > 50 * 1024 * 1024) {
      res.status(400).json({ error: 'File too large (max 50MB)' });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    } else if (extension === '.pdf') {
      // Tell browsers to display the PDF inline rather than download it
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    }

    // Media elements scrub by asking for byte ranges rather than re-fetching the
    // whole file, so honour Range instead of always replying 200 with everything.
    const range = parseByteRange(req.headers.range, stats.size);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${stats.size}`);
      res.status(416).end();
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', stats.size);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err: any) {
    log.error(' Failed to read binary file:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/files/download-folder - Stream a whole directory as a .zip
//
// Streams rather than building the archive in memory, so a multi-GB source tree
// costs a constant amount of RAM. Auth accepts ?token= (see
// extractTokenFromRequest), which is what makes this usable as a plain browser
// download and as a native drag-out target — neither can send an auth header.
export const handleGetDownloadFolder = async (req: Request, res: Response) => {
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
    if (!fs.statSync(dirPath).isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory', path: dirPath });
      return;
    }

    const folderName = path.basename(dirPath) || 'folder';
    // Strip characters that would break the header or escape the filename quote.
    const safeName = folderName.replace(/["\\\r\n]/g, '_');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);

    // store-level for speed on already-compressed trees would be worse for
    // source code; 6 is the balanced default.
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('warning', (err) => {
      // ENOENT here is a file that vanished mid-walk (build output, temp file) —
      // not worth failing an otherwise good archive.
      if (err.code === 'ENOENT') {
        log.warn(` Skipped missing entry while zipping ${dirPath}: ${err.message}`);
      } else {
        log.error(' Archive warning:', err);
      }
    });

    archive.on('error', (err) => {
      log.error(' Failed to zip folder:', err);
      // Headers are already sent once streaming starts, so the only honest
      // signal left is to break the response rather than end it cleanly and
      // hand back a silently truncated archive.
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      } else {
        res.destroy(err);
      }
    });

    // Abandon the walk if the client goes away (cancelled download / drag), so a
    // big tree doesn't keep churning the disk with nowhere to write.
    res.on('close', () => {
      if (!res.writableEnded) void archive.abort();
    });

    archive.pipe(res);
    // Nest under the folder's own name so unzipping never scatters files
    // across the download directory.
    archive.directory(dirPath, folderName);
    await archive.finalize();
    log.log(` Zipped folder: ${dirPath} (${archive.pointer()} bytes)`);
  } catch (err: any) {
    log.error(' Failed to download folder:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
};

/** Chrome/Chromium used to print Markdown to PDF. Env override first. */
function findChromeBinary(): string | null {
  const fromEnv = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/**
 * Print styles for the Markdown → PDF export.
 *
 * Deliberately self-contained rather than reusing the app's stylesheet: the UI
 * theme is dark and tuned for a screen, which prints as a wall of ink. This is a
 * light, paper-first rendering of the same structure.
 */
const MARKDOWN_PDF_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 11pt/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    background: #fff;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; page-break-after: avoid; }
  h1 { font-size: 20pt; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  h2 { font-size: 16pt; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
  h3 { font-size: 13pt; }
  p, li { orphans: 2; widows: 2; }
  a { color: #0b5fff; text-decoration: none; }
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 9.5pt;
    background: #f4f4f6;
    padding: 0.15em 0.35em;
    border-radius: 3px;
  }
  pre {
    background: #f6f7f9;
    border: 1px solid #e3e5e9;
    border-radius: 5px;
    padding: 10px 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    page-break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: 9pt; }
  blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid #d6d8dd; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; page-break-inside: avoid; }
  th, td { border: 1px solid #d9dbe0; padding: 6px 9px; text-align: left; font-size: 10pt; }
  th { background: #f2f3f5; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 1.6em 0; }
  ul, ol { padding-left: 1.5em; }
`;

// POST /api/files/markdown-pdf - Render already-rendered Markdown HTML to a PDF
//
// The client sends the HTML it is ALREADY displaying, so the PDF matches what
// the user is looking at (same Markdown renderer, same tables, same code
// blocks) instead of re-parsing the source with a second, subtly different one.
export const handlePostMarkdownPdf = async (req: Request, res: Response) => {
  const chromePath = findChromeBinary();
  if (!chromePath) {
    res.status(501).json({
      error: 'No Chrome/Chromium found for PDF export. Install Google Chrome or set CHROME_PATH.',
    });
    return;
  }

  const { html, title } = req.body as { html?: string; title?: string };
  if (!html || typeof html !== 'string') {
    res.status(400).json({ error: 'html is required' });
    return;
  }

  const docTitle = (title || 'document').replace(/[<>]/g, '');
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8">`
    + `<title>${docTitle}</title><style>${MARKDOWN_PDF_CSS}</style></head>`
    + `<body>${html}</body></html>`;

  let browser: PuppeteerBrowser | null = null;
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      // A fresh, isolated profile: this must never attach to (or disturb) the
      // user's real Chrome, which the browser-bridge drives over CDP.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const tab = await browser.newPage();
    // The content is a local document, not an app — no scripts should run.
    await tab.setJavaScriptEnabled(false);
    // 'load' (not 'domcontentloaded') so images finish fetching before printing.
    await tab.setContent(page, { waitUntil: 'load', timeout: 20000 });

    const pdf = await tab.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:8pt;color:#888;padding:0 16mm;'
        + 'display:flex;justify-content:space-between;">'
        + `<span>${docTitle.replace(/[&<>"]/g, '')}</span>`
        + '<span class="pageNumber"></span></div>',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    log.log(` Markdown PDF generated: ${docTitle} (${pdf.length} bytes)`);
    res.end(Buffer.from(pdf));
  } catch (err: any) {
    log.error(' Failed to render Markdown to PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'PDF generation failed' });
    }
  } finally {
    // Always reap the browser — a leaked headless Chrome per export would pile
    // up invisibly and eat the box.
    if (browser) await browser.close().catch(() => { /* already gone */ });
  }
};
