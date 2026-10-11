/**
 * 输出分类与命令文本切分(简单视图 / 可读性 / 聊天视图 / 错误判定 / 文件链接切分 / tool 行解析)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

/**
 * The part of a file a Read/Edit row touched: `lines 450–889`, `3 edits`,
 * `line 128`. Five consecutive reads of one file are otherwise identical rows,
 * and pi/Codex send the range in the tool input already.
 */
export function getFileToolDetail(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (toolName === 'Read' || toolName === 'NotebookEdit') {
    const offset = typeof record.offset === 'number' ? record.offset : undefined;
    const limit = typeof record.limit === 'number' ? record.limit : undefined;
    if (offset !== undefined && limit !== undefined) return `lines ${offset}–${offset + limit - 1}`;
    if (offset !== undefined) return `from line ${offset}`;
    if (limit !== undefined) return `first ${limit} lines`;
    return null;
  }
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    const edits = Array.isArray(record.edits) ? record.edits.length : 0;
    if (edits > 1) return `${edits} edits`;
    const line = typeof record.first_changed_line === 'number' ? record.first_changed_line : undefined;
    if (line !== undefined) return `line ${line}`;
    return null;
  }
  return null;
}

/**
 * Determine if output text should be shown in simple/chat view
 * Filters out technical details like tool inputs, tokens, costs
 */
export function isSimpleViewOutput(text: string): boolean {
  // SHOW tool names (will render with nice icons)
  if (text.startsWith('Using tool:')) return true;

  // HIDE technical details
  if (text.startsWith('Tool input:')) return false;
  if (text.startsWith('Tool result:')) return false;
  if (text.startsWith('Tokens:')) return false;
  if (text.startsWith('Cost:')) return false;
  if (text.startsWith('[thinking]')) return true;
  if (text.startsWith('Session started:')) return false;

  // SHOW everything else (actual content)
  return true;
}

export interface CommandTextSegment {
  text: string;
  fileRef?: string;
}

// Path segments allow Unicode letters/marks (not just ASCII) so paths with
// accented folders like "Operación"/"Documentación" linkify fully instead of
// breaking at the first non-ASCII character. Requires the `u` flag.
export const COMMAND_FILE_REF_REGEX = /(^|[\s("'`])((?:\.{1,2}\/|~\/|\/)?[\p{L}\p{M}\p{N}._-]+(?:\/[\p{L}\p{M}\p{N}._-]+)*\.[\p{L}\p{M}\p{N}._-]+(?::\d+(?::\d+)?)?)/gu;

function isLikelyCommandFileRef(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('-')) return false;
  if (value.includes('://')) return false;
  if (value.includes('*')) return false;
  // Keep command linking focused on local-ish paths and filenames with extension.
  return value.includes('.') && !value.endsWith('.');
}

/**
 * Split a shell command into text/file segments so file refs can be rendered as clickable links.
 */
export function splitCommandForFileLinks(command: string): CommandTextSegment[] {
  if (!command) return [{ text: '' }];

  const segments: CommandTextSegment[] = [];
  let lastIndex = 0;
  COMMAND_FILE_REF_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = COMMAND_FILE_REF_REGEX.exec(command)) !== null) {
    const full = match[0];
    const prefix = match[1] || '';
    const candidate = match[2] || '';
    const start = match.index;

    if (start > lastIndex) {
      segments.push({ text: command.slice(lastIndex, start) });
    }
    if (prefix) {
      segments.push({ text: prefix });
    }

    if (isLikelyCommandFileRef(candidate)) {
      segments.push({ text: candidate, fileRef: candidate });
    } else {
      segments.push({ text: candidate });
    }

    lastIndex = start + full.length;
  }

  if (lastIndex < command.length) {
    segments.push({ text: command.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ text: command }];
}

/**
 * Determine if output is human-readable (not tool calls/results/stats)
 * Used by Commander view for filtering
 */
export function isHumanReadableOutput(text: string): boolean {
  if (text.startsWith('Using tool:')) return false;
  if (text.startsWith('Tool result:')) return false;
  if (text.startsWith('Tokens:')) return false;
  if (text.startsWith('Cost:')) return false;
  if (text.startsWith('[thinking]')) return false;
  if (text.startsWith('Session started:')) return false;
  if (text.startsWith('Tool input:')) return false;
  return true;
}

/**
 * Determine if output should be shown in chat view (user messages + final responses only)
 */
export function isChatViewOutput(text: string): boolean {
  // Hide tool-related messages
  if (text.startsWith('Using tool:')) return false;
  if (text.startsWith('Tool input:')) return false;
  if (text.startsWith('Tool result:')) return false;
  if (text.startsWith('Tokens:')) return false;
  if (text.startsWith('Cost:')) return false;
  if (text.startsWith('[thinking]')) return false;
  if (text.startsWith('Session started:')) return false;

  // Show actual content
  return true;
}

/**
 * Check if a tool result indicates an error
 */
export function isErrorResult(content: string): boolean {
  const lower = content.toLowerCase();
  return lower.includes('error') || lower.includes('failed');
}

/**
 * Format tool input JSON for display
 * Returns formatted JSON string or original content if not valid JSON
 */
export function formatToolInput(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

/**
 * Parse tool name from "Using tool: ToolName" format
 */
export function parseToolName(text: string): string | null {
  if (!text.startsWith('Using tool:')) return null;
  return text.replace('Using tool:', '').trim();
}

/**
 * Parse tool result content from "Tool result: content" format
 */
export function parseToolResult(text: string): string | null {
  if (!text.startsWith('Tool result:')) return null;
  return text.replace('Tool result:', '').trim();
}

/**
 * Parse tool input content from "Tool input: content" format
 */
export function parseToolInput(text: string): string | null {
  if (!text.startsWith('Tool input:')) return null;
  return text.replace('Tool input:', '').trim();
}
