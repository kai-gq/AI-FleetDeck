/**
 * 读取目标提取(shell 读文件目标 / 图片查看目标 / codex exec 文件目标)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { codexExecScript, extractJavaScriptStringField, normalizeShellWrapper } from './internal';
import { getCodexExecPresentation } from './codex';
import { type ShellReadStep, analyzeShellInspection } from '../../../shared/shell-file-writes';

export interface CodexExecFileTarget {
  path: string;
  highlightRange?: { offset: number; limit: number };
}

/** Locate the file/lines represented by a Codex READ or GREP exec card. */
export function getCodexExecFileTarget(input: unknown, output?: string): CodexExecFileTarget | null {
  const script = codexExecScript(input);
  const rawCommand = extractJavaScriptStringField(script, 'cmd') || extractJavaScriptStringField(script, 'command') || '';
  const readTarget = getShellReadTarget(rawCommand);
  if (readTarget) return readTarget;

  // rg --line-number output normally starts `path:line:text` (or path-line-text
  // when context mode is enabled). Open the first concrete match.
  if (output) {
    const match = output.match(/(?:^|\n)([^\n:]+?):(\d+):/);
    if (match) return { path: match[1].trim(), highlightRange: { offset: Number(match[2]), limit: 1 } };
  }
  return null;
}

/** Resolve a direct shell file-read command to the file and exact line range. */
export function getShellReadTarget(rawCommand: string): CodexExecFileTarget | null {
  return getShellReadTargets(rawCommand)[0] || null;
}

/** All sed/head/cat read targets in a possibly chained shell command. */
export function getShellReadTargets(rawCommand: string): CodexExecFileTarget[] {
  const command = normalizeShellWrapper(rawCommand);
  // Lexer first: it resolves paths against a leading `cd` and ignores `echo`
  // separators, so the click target matches the chip the row shows.
  const inspected = analyzeShellInspection(command);
  if (inspected) {
    const reads = inspected.filter((step): step is ShellReadStep => step.kind === 'read');
    if (reads.length > 0) {
      return reads.map((read) => ({
        path: read.path,
        ...(read.range ? { highlightRange: { offset: read.range.start, limit: Math.max(1, read.range.end - read.range.start + 1) } } : {}),
      }));
    }
  }
  const targets: CodexExecFileTarget[] = [];
  for (const sed of command.matchAll(/\bsed\s+-n\s+["']?(\d+)\s*,\s*(\d+)p["']?\s+(?:--\s+)?["']?([^"';&|]+?)["']?(?=\s*(?:;|&&|\||$))/g)) {
    const start = Number(sed[1]);
    const end = Number(sed[2]);
    targets.push({ path: sed[3].trim(), highlightRange: { offset: start, limit: Math.max(1, end - start + 1) } });
  }
  if (targets.length > 0) return targets;

  const simpleRead = command.match(/^\s*(?:cat|head|tail)\b[^;&|]*?\s+(?:--\s+)?["']?([^"'\s;&|]+)["']?\s*$/);
  if (simpleRead) return [{ path: simpleRead[1] }];
  return [];
}

/** The image a direct `view_image` tool call renders. */
export interface ImageViewTarget {
  path: string;
  /** Rendering hint the agent passed along (`original`, `low`, …). */
  detail?: string;
}

/** True for tool ids that display a single image file (Codex `view_image`). */
export function isImageViewTool(toolName: string): boolean {
  const lower = (toolName || '').toLowerCase();
  return lower === 'view_image' || lower === 'viewimage';
}

/**
 * Resolve the image a `view_image` call targets. Codex sends `{path, detail}`;
 * the path aliases keep other runtimes' spellings working. Unlike the exec
 * wrapper (getCodexExecPresentation), these calls arrive as a plain tool input.
 */
export function getImageViewTarget(input: unknown): ImageViewTarget | null {
  let record: Record<string, unknown> | null = null;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
    } catch { /* not JSON */ }
    // A bare, non-JSON string is the path itself.
    if (!record) return input.trim() ? { path: input.trim() } : null;
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    record = input as Record<string, unknown>;
  }
  if (!record) return null;
  const raw = record.path ?? record.image_path ?? record.imagePath ?? record.file_path ?? record.filePath ?? record.url;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const detail = typeof record.detail === 'string' && record.detail.trim() ? record.detail.trim() : undefined;
  return { path: raw.trim(), detail };
}
