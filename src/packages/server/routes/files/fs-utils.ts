/**
 * 文件系统与请求助手(日志、二进制判定、字节区间、路径校验、系统浏览器揭示)。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as os from 'os';
import { pathToFileURL } from 'url';
import { logger } from '../../utils/logger.js';
import { TestRunnerType } from '../../../shared/types.js';

export const log = logger.files;

// Get or create temp directory for tide-commander uploads. Exported so other
// modules (attachment-downloader, attachment-janitor) put their files under the
// same root that Express already serves statically at `/uploads/`.
export const TEMP_DIR = path.join(os.tmpdir(), 'tide-commander-uploads');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}
log.log(` Temp upload directory: ${TEMP_DIR}`);

// File entry for directory listing
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: Date;
  extension: string;
}

// Tree node for recursive listing
export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  children?: TreeNode[];
  // Set on directories that belong to a runnable test project (e.g. 'maven'),
  // so the file explorer can offer "Run Tests" on the right folders.
  runnerType?: TestRunnerType;
}

export function looksLikeBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  // NUL catches the common case. Invalid UTF-8 catches compressed or media
  // formats with no NUL in their first block. It must be INVALID bytes, not
  // U+FFFD characters: valid text can contain literal "�" (a JSON dump of
  // chat messages holding a mangled .docx preview had 760 of them), and
  // decoding with replacement then searching for U+FFFD called that binary.
  // `stream: true` tolerates a multi-byte character cut by the 8 KB sample.
  if (sample.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return false;
  } catch {
    return true;
  }
}

/**
 * Content type for every binary the file routes stream. Shared by /binary,
 * /by-path and /git-original-binary — the client turns these responses straight
 * into Blobs, and a media element refuses an `application/octet-stream` blob, so
 * a missing entry here shows up as "this audio won't play" in the viewer.
 */
const BINARY_MIME_TYPES: Record<string, string> = {
  // images
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  // documents
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  // archives
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  // audio
  '.wav': 'audio/wav', '.wave': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.weba': 'audio/webm', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  // video
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  // 3D / fabrication
  '.stl': 'model/stl', '.fcstd': 'application/vnd.freecad',
  '.glb': 'model/gltf-binary', '.gbl': 'model/gltf-binary',
  '.gcode': 'text/x-gcode', '.gco': 'text/x-gcode',
};

export function binaryContentTypeForExtension(extension: string): string {
  return BINARY_MIME_TYPES[extension] || 'application/octet-stream';
}

/**
 * Parse a single `Range: bytes=…` header against a known file size.
 *
 * Returns null when there is nothing to honour (absent/unsupported/multi-range
 * header — the caller replies 200 with the whole file), 'unsatisfiable' for a
 * range that starts past the end (416), or the inclusive byte window to stream.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    // Suffix form ("bytes=-500") = the LAST n bytes.
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size) return 'unsatisfiable';
  end = Math.min(end, size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

// Windows absolute paths — drive-letter (`C:\…` or `C:/…`) and UNC (`\\server\share`)
// — are NOT recognized by path.isAbsolute() when the server runs on POSIX. Without
// this, a configured Windows path is misclassified as relative and resolved into
// the server cwd (producing a bogus path). Detect them explicitly so they pass
// through unchanged on any platform. On Linux the path simply won't exist (honest
// 404) rather than silently resolving somewhere inside cwd.
const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

export function isAbsolutePathCrossPlatform(p: string): boolean {
  return path.isAbsolute(p) || WINDOWS_ABSOLUTE_RE.test(p);
}

// Normalize a path to forward-slash separators for the API boundary. The browser
// assumes '/' when it splits paths for trees/breadcrumbs, so every path we return
// must be canonical '/'. Node on Windows accepts '/' in fs calls, so a normalized
// path still round-trips when the client sends it back. No-op on POSIX (no '\').
export function toPosixSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve a path query against an optional baseDir. Absolute paths pass through
 * unchanged; relative paths are resolved via path.resolve(baseDir, rawPath).
 * If no usable baseDir is supplied, the server's own cwd is used so file-modal
 * links like `../../../tmp/foo.md` open even from contexts without an explicit
 * agent cwd (e.g. spotlight, flat view). The client should pass the agent cwd
 * as baseDir whenever it has one, which takes precedence.
 */
export function resolveAndValidateFilePath(
  rawPath: string | undefined,
  baseDir?: string,
  fallbackBaseDir: string = process.cwd(),
): { ok: true; path: string } | { ok: false; status: number; error: string } {
  if (!rawPath) {
    return { ok: false, status: 400, error: 'Missing path parameter' };
  }
  if (isAbsolutePathCrossPlatform(rawPath)) {
    return { ok: true, path: rawPath };
  }
  const effectiveBase = baseDir && isAbsolutePathCrossPlatform(baseDir) ? baseDir : fallbackBaseDir;
  if (!isAbsolutePathCrossPlatform(effectiveBase)) {
    return {
      ok: false,
      status: 400,
      error: 'Cannot resolve relative path: no absolute baseDir and server cwd is not absolute',
    };
  }
  return { ok: true, path: path.resolve(effectiveBase, rawPath) };
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function validateRevealPath(rawPath: unknown): { ok: true; path: string } | { ok: false; status: number; error: string } {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { ok: false, status: 400, error: 'Missing path parameter' };
  }

  if (!isAbsolutePathCrossPlatform(rawPath)) {
    return { ok: false, status: 400, error: 'Path must be absolute' };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(rawPath);
  } catch {
    return { ok: false, status: 404, error: 'File not found' };
  }

  const allowedRoots = [process.cwd(), os.homedir()]
    .filter(Boolean)
    .map(rootPath => {
      try {
        return fs.realpathSync(rootPath);
      } catch {
        return path.resolve(rootPath);
      }
    });

  if (!allowedRoots.some(rootPath => isPathInsideRoot(realPath, rootPath))) {
    return { ok: false, status: 400, error: 'Path is outside allowed roots' };
  }

  return { ok: true, path: realPath };
}

function execFileAsync(command: string, args: string[], timeout: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function revealPathInFileExplorer(filePath: string): Promise<string> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-R', filePath]);
    return 'open -R';
  }

  if (process.platform === 'win32') {
    await execFileAsync('explorer.exe', [`/select,${filePath}`]);
    return 'explorer.exe /select';
  }

  if (process.platform === 'linux') {
    const fileUri = pathToFileURL(filePath).toString();
    try {
      await execFileAsync('dbus-send', [
        '--session',
        '--dest=org.freedesktop.FileManager1',
        '--type=method_call',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowItems',
        `array:string:${fileUri}`,
        'string:',
      ], 3000);
      return 'org.freedesktop.FileManager1.ShowItems';
    } catch (err) {
      log.warn(' FileManager1 reveal failed, falling back to xdg-open:', err);
      const stat = fs.statSync(filePath);
      const directoryPath = stat.isDirectory() ? filePath : path.dirname(filePath);
      await execFileAsync('xdg-open', [directoryPath]);
      return 'xdg-open';
    }
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}
