/**
 * Codex 工具调用归一:function_call/web_search/MCP/patch 解析与纯读推断。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './paths.js';
import { isObject, normalizeTextContent, safeParseJson } from './message-utils.js';
import * as path from 'path';

let hasLoggedTurnAbortedHistoryWarning = false;

export function sanitizeCodexMessageText(text: string): string {
  const hadTurnAborted = /<turn_aborted>[\s\S]*?<\/turn_aborted>/.test(text);
  if (hadTurnAborted) {
    if (!hasLoggedTurnAbortedHistoryWarning) {
      log.warn('Filtered <turn_aborted> markers from Codex session history messages (suppressing repeat logs)');
      hasLoggedTurnAbortedHistoryWarning = true;
    } else {
      log.debug('Filtered <turn_aborted> marker from Codex session history message');
    }
  }
  const withoutTurnAborted = text.replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, '').trim();
  if (withoutTurnAborted === 'You') {
    return '';
  }
  return withoutTurnAborted;
}

export function parseFunctionCallArguments(raw: unknown): Record<string, unknown> {
  if (isObject(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return {};
  }
  const parsed = safeParseJson(raw);
  return isObject(parsed) ? parsed : { raw: raw };
}

function normalizeCodexImageReference(rawImageUrl: unknown): string {
  if (typeof rawImageUrl !== 'string') return '[Image attached]';

  const imageUrl = rawImageUrl.trim();
  if (!imageUrl) return '[Image attached]';

  // Avoid dumping inline base64 payloads into terminal history.
  if (imageUrl.startsWith('data:image/')) {
    return '[Image attached]';
  }

  return `[Image: ${imageUrl}]`;
}

export function extractCodexContentSegments(content: unknown): string[] {
  if (!Array.isArray(content)) {
    const normalized = sanitizeCodexMessageText(normalizeTextContent(content));
    return normalized ? [normalized] : [];
  }

  const segments: string[] = [];
  let sawUnrecognizedBlock = false;
  for (const block of content) {
    if (!isObject(block)) {
      sawUnrecognizedBlock = true;
      continue;
    }
    const type = block.type;

    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const maybeText = block.text;
      if (typeof maybeText === 'string' && maybeText.trim().length > 0) {
        segments.push(maybeText);
      }
      continue;
    }

    if (type === 'input_image') {
      segments.push(normalizeCodexImageReference(block.image_url));
      continue;
    }

    // A block shape we don't know how to render cleanly.
    sawUnrecognizedBlock = true;
  }

  if (segments.length > 0) {
    return segments;
  }

  // Only fall back to a raw stringified dump when the array contained block
  // shapes we didn't recognize. An array of recognized-but-empty blocks
  // (e.g. a Codex agent_message with empty output_text) must resolve to nothing
  // rather than rendering raw JSON like [{"type":"output_text","text":""}].
  if (!sawUnrecognizedBlock) {
    return [];
  }

  const fallback = sanitizeCodexMessageText(normalizeTextContent(content));
  return fallback ? [fallback] : [];
}

export function extractCodexUserMessageFromString(rawMessage: string): string {
  const parsed = safeParseJson(rawMessage);
  const normalizedFromJson = extractCodexContentSegments(parsed).join('\n');
  if (normalizedFromJson.trim()) {
    return normalizedFromJson;
  }
  return sanitizeCodexMessageText(rawMessage);
}

interface NormalizedCodexToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** Unwrap a `/bin/zsh -lc "<cmd>"` wrapper to the inner shell command. */
function extractCodexShellCommand(command: string): string {
  const doubleQuoted = command.match(/-lc\s+"([\s\S]*)"$/);
  if (doubleQuoted) {
    return doubleQuoted[1]
      .replace(/\\"/g, '"')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$')
      .replace(/\\\\/g, '\\');
  }
  const singleQuoted = command.match(/-lc\s+'([\s\S]*)'$/);
  if (singleQuoted) return singleQuoted[1];
  return command;
}

/**
 * If a Codex exec_command is a single, side-effect-free file read
 * (`sed -n 'A,Bp' file`, `cat file`, `head -n N file`),
 * return a Read tool input (file_path + optional offset/limit line range) so the
 * reloaded row renders as one Read entry whose modal highlights the read lines —
 * matching the live parser and avoiding a redundant Bash row. Returns null for
 * anything that writes, edits, pipes, or chains commands.
 */
function inferCodexPureRead(command: string | undefined): Record<string, unknown> | null {
  if (!command) return null;
  const shell = extractCodexShellCommand(command).trim();
  if (!shell) return null;
  if (/[;&|]|>>?/.test(shell)) return null;
  if (/\b(?:sed\s+-i|perl\s+-pi|tee|apply_patch)\b/.test(shell)) return null;

  const toRead = (rawFile: string, offset?: number, limit?: number): Record<string, unknown> | null => {
    const file = rawFile.trim().replace(/^['"]|['"]$/g, '');
    if (!file || file === '/' || file.startsWith('-')) return null;
    const input: Record<string, unknown> = { file_path: file };
    if (offset !== undefined) input.offset = offset;
    if (limit !== undefined) input.limit = limit;
    return input;
  };

  let m = shell.match(/^sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(.+)$/);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (end < start) return null;
    return toRead(m[3], start, end - start + 1);
  }
  m = shell.match(/^head\s+(?:-n\s*)?(\d+)\s+(\S+)$/);
  if (m) return toRead(m[2], 1, parseInt(m[1], 10));
  // cat FILE → whole file. (tail stays Bash: its range is counted from EOF.)
  m = shell.match(/^cat\s+(\S+)$/);
  if (m) return toRead(m[1]);
  return null;
}

export function normalizeCodexFunctionToolCall(
  rawToolName: string,
  rawToolInput: Record<string, unknown>
): NormalizedCodexToolCall {
  // Codex session history stores tool names as function identifiers (e.g. exec_command),
  // while live runtime events use normalized names (e.g. Bash). Align them so reload
  // renders identical rich tool rows in the UI.
  if (rawToolName === 'exec_command') {
    const cmd = typeof rawToolInput.cmd === 'string' ? rawToolInput.cmd : undefined;
    const command = typeof rawToolInput.command === 'string' ? rawToolInput.command : cmd;

    // Pure file reads render as a single Read row (with a highlighted line
    // range) rather than a Bash row — matching the live parser.
    const pureRead = inferCodexPureRead(command);
    if (pureRead) {
      return { toolName: 'Read', toolInput: pureRead };
    }

    return {
      toolName: 'Bash',
      toolInput: {
        ...rawToolInput,
        ...(command ? { command } : {}),
      },
    };
  }

  return {
    toolName: rawToolName,
    toolInput: rawToolInput,
  };
}

export function normalizeCodexWebSearchToolInput(payload: Record<string, unknown>): Record<string, unknown> {
  const action = isObject(payload.action) ? payload.action : {};
  const actionQueriesRaw = action.queries;
  const actionQueries = Array.isArray(actionQueriesRaw) && actionQueriesRaw.every((q) => typeof q === 'string')
    ? actionQueriesRaw as string[]
    : undefined;

  return {
    query: typeof payload.query === 'string'
      ? payload.query
      : typeof action.query === 'string' ? action.query : undefined,
    actionType: typeof action.type === 'string' ? action.type : undefined,
    actionQuery: typeof action.query === 'string' ? action.query : undefined,
    actionQueries,
    actionUrl: typeof action.url === 'string' ? action.url : undefined,
    status: typeof payload.status === 'string' ? payload.status : undefined,
  };
}

export function normalizeCodexMcpToolCall(payload: Record<string, unknown>): {
  toolName: string;
  toolInput: Record<string, unknown>;
} | null {
  if (!isObject(payload.invocation)) return null;
  const invocation = payload.invocation;
  const server = typeof invocation.server === 'string' ? invocation.server : 'mcp';
  const tool = typeof invocation.tool === 'string' ? invocation.tool : 'tool';
  const args = isObject(invocation.arguments) ? invocation.arguments : {};
  return {
    toolName: `mcp__${server}__${tool}`,
    toolInput: { ...args, server },
  };
}

export function normalizeCodexMcpToolOutput(result: unknown): string {
  if (!isObject(result)) return result === undefined ? '' : String(result);
  const envelope = isObject(result.Ok) ? result.Ok : isObject(result.Err) ? result.Err : result;
  if (Array.isArray(envelope.content)) {
    const texts = envelope.content
      .filter(isObject)
      .map((entry) => typeof entry.text === 'string' ? entry.text : undefined)
      .filter((text): text is string => !!text);
    if (texts.length > 0) {
      const output = texts.join('\n');
      return output.length > 4000 ? `${output.slice(0, 4000)}...` : output;
    }
  }
  try {
    const output = JSON.stringify(result);
    return output.length > 4000 ? `${output.slice(0, 4000)}...` : output;
  } catch {
    return String(result);
  }
}

export function normalizeCodexEventFallbackText(eventType: string, payload: unknown): string {
  let serialized = '';
  try {
    serialized = JSON.stringify(payload, null, 2);
  } catch {
    serialized = String(payload);
  }

  const MAX_LEN = 4000;
  if (serialized.length > MAX_LEN) {
    serialized = `${serialized.slice(0, MAX_LEN)}...`;
  }

  return `[codex-event] ${eventType}\n${serialized}`;
}

/**
 * A single file changed by a Codex apply_patch, taken from the matching
 * `event_msg.patch_apply_end` event (which carries a clean unified diff).
 */
export interface CodexPatchFileChange {
  path: string;
  unifiedDiff?: string;
  kind?: string; // 'add' | 'update' | 'delete'
}

/**
 * Pre-scan Codex session entries for `patch_apply_end` events and index their
 * per-file unified diffs by call_id. `patch_apply_end` arrives AFTER the
 * matching `apply_patch` custom_tool_call, so we collect it up front and then
 * attach the real diff to the rendered Edit rows — giving the file-viewer modal
 * a clean side-by-side / unified diff instead of the raw patch text.
 */
export function collectCodexPatchApplyDiffs(entries: unknown[]): Map<string, CodexPatchFileChange[]> {
  const byCallId = new Map<string, CodexPatchFileChange[]>();
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== 'event_msg') continue;
    const payload = entry.payload;
    if (!isObject(payload) || payload.type !== 'patch_apply_end') continue;
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    if (!callId) continue;
    const changes = payload.changes;
    if (!isObject(changes)) continue;

    const fileChanges: CodexPatchFileChange[] = [];
    for (const [filePath, change] of Object.entries(changes)) {
      if (!isObject(change)) continue;
      fileChanges.push({
        path: filePath,
        unifiedDiff: typeof change.unified_diff === 'string' ? change.unified_diff : undefined,
        kind: typeof change.type === 'string' ? change.type : undefined,
      });
    }
    if (fileChanges.length > 0) {
      byCallId.set(callId, fileChanges);
    }
  }
  return byCallId;
}
