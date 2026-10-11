/**
 * 解析与装载入口:parseSessionMessages 分发、解析缓存、loadSession/loadSessionAroundMatch/searchSession 等对外 API 与 loadToolHistory。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './paths.js';
import { type ResolvedSessionFile, type SessionMessage, type SessionInfo, type ConversationHistory, type ToolExecution, type FileChange } from './session-types.js';
import { deduplicateSessionMessages } from './message-utils.js';
import { collectCodexPatchApplyDiffs } from './codex-normalize.js';
import { resolveSessionFile } from './session-files.js';
import { listSessions } from './session-index.js';
import { SNIPPET_RANK_RAW, extractReadableLineText } from './search-scan.js';
import { foldAccents } from './search-plan.js';
import { scanSessionFileForQuery } from './search-collect.js';
import { type SessionActivityMessageType, parseClaudeEntryMessages } from './parse-claude.js';
import { parseCodexEntryMessages } from './parse-codex.js';
import { parseOpencodeDbSessionMessages, parseOpencodeSessionMessages } from './parse-opencode.js';
import { parseGrokSessionMessages } from './parse-grok.js';
import { parsePiSessionMessages } from './parse-pi.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

/**
 * Wait for file to be stable (not actively being written)
 * Checks if file size remains constant over a small interval
 */
async function waitForFileStable(filePath: string, maxWaitMs: number = 500): Promise<void> {
  const checkInterval = 50;
  let lastSize = -1;
  let elapsed = 0;

  while (elapsed < maxWaitMs) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === lastSize) {
        // File size hasn't changed, consider stable
        return;
      }
      lastSize = stats.size;
    } catch {
      // File might not exist yet
      return;
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    elapsed += checkInterval;
  }
}

async function parseSessionMessages(
  resolved: ResolvedSessionFile
): Promise<{ messages: SessionMessage[]; lastMessageType: SessionActivityMessageType; lastMessageTimestamp: Date | null }> {
  if (resolved.provider === 'opencode') {
    if (resolved.opencodeDbSessionId) {
      return parseOpencodeDbSessionMessages(resolved.opencodeDbSessionId);
    }
    return parseOpencodeSessionMessages(resolved.filePath);
  }

  if (resolved.provider === 'grok') {
    return parseGrokSessionMessages(resolved.filePath);
  }

  if (resolved.provider === 'pi') {
    return parsePiSessionMessages(resolved.filePath);
  }

  const messages: SessionMessage[] = [];
  const toolUseIdToName = new Map<string, string>();

  const fileStream = fs.createReadStream(resolved.filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  if (resolved.provider === 'claude') {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        parseClaudeEntryMessages(JSON.parse(line), messages, toolUseIdToName);
      } catch {
        // Skip invalid/incomplete lines
      }
    }
  } else {
    // Codex: buffer entries first so we can pre-scan patch_apply_end events
    // (which arrive AFTER the apply_patch call) and attach their real unified
    // diffs to the Edit rows for a clean diff modal.
    const entries: unknown[] = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip invalid/incomplete lines
      }
    }
    const patchDiffsByCallId = collectCodexPatchApplyDiffs(entries);
    for (const entry of entries) {
      parseCodexEntryMessages(entry, messages, toolUseIdToName, patchDiffsByCallId);
    }
  }

  const dedupedMessages = deduplicateSessionMessages(messages);
  const last = dedupedMessages.length > 0 ? dedupedMessages[dedupedMessages.length - 1] : null;
  return {
    messages: dedupedMessages,
    lastMessageType: last?.type ?? null,
    lastMessageTimestamp: last?.timestamp ? new Date(last.timestamp) : null,
  };
}

type ParsedSession = Awaited<ReturnType<typeof parseSessionMessages>>;

// Parsed-session cache keyed by file path, invalidated by (mtimeMs, size).
// Every /history request previously re-parsed the full JSONL (and
// getAgentHistory parses the SAME file twice when the page references
// subagents) — with multi-MB sessions that parse dominated request latency.
// Callers MUST treat the returned messages as immutable (all current callers
// only read/slice them). Opencode sessions are excluded: their messages live
// outside the resolved file (sqlite / part dirs), so a stat key on filePath
// cannot see changes — and the sqlite path is cheap anyway.
const parsedSessionCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedSession }>();

const PARSED_SESSION_CACHE_MAX = 8;

// Only a file modified this recently may still be mid-write and warrant the
// stability wait. The old unconditional waitForFileStable slept >=50ms on
// EVERY request by construction (lastSize starts at -1, so the first check
// can never match).
const RECENT_WRITE_WINDOW_MS = 300;

export async function parseSessionMessagesCached(resolved: ResolvedSessionFile): Promise<ParsedSession> {
  if (resolved.provider === 'opencode') {
    return parseSessionMessages(resolved);
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved.filePath);
  } catch {
    return parseSessionMessages(resolved);
  }

  const cached = parsedSessionCache.get(resolved.filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // LRU touch: most recently used moves to the end of iteration order.
    parsedSessionCache.delete(resolved.filePath);
    parsedSessionCache.set(resolved.filePath, cached);
    return cached.parsed;
  }

  if (Date.now() - stats.mtimeMs < RECENT_WRITE_WINDOW_MS) {
    await waitForFileStable(resolved.filePath);
    try {
      stats = fs.statSync(resolved.filePath);
    } catch {
      return parseSessionMessages(resolved);
    }
  }

  const parsed = await parseSessionMessages(resolved);
  parsedSessionCache.set(resolved.filePath, { mtimeMs: stats.mtimeMs, size: stats.size, parsed });
  while (parsedSessionCache.size > PARSED_SESSION_CACHE_MAX) {
    const oldest = parsedSessionCache.keys().next().value;
    if (oldest === undefined) break;
    parsedSessionCache.delete(oldest);
  }
  return parsed;
}

/**
 * Load conversation history from a session file
 * @param cwd - Working directory
 * @param sessionId - Session ID
 * @param limit - Max messages to return
 * @param offset - Offset from the end (0 = most recent)
 */
export async function loadSession(
  cwd: string,
  sessionId: string,
  limit: number = 50,
  offset: number = 0
): Promise<ConversationHistory | null> {
  const resolved = resolveSessionFile(cwd, sessionId);
  if (!resolved) {
    log.log(` Session file not found for session ${sessionId}`);
    return null;
  }

  const { messages } = await parseSessionMessagesCached(resolved);

  const totalCount = messages.length;

  // Calculate slice indices from the end
  // offset 0, limit 50 -> slice(-50) = last 50 messages
  // offset 50, limit 50 -> slice(-100, -50) = messages 50-100 from end
  const endIndex = totalCount - offset;
  const startIndex = Math.max(0, endIndex - limit);
  const limitedMessages = messages.slice(startIndex, endIndex > 0 ? endIndex : undefined);

  return {
    sessionId,
    messages: limitedMessages,
    cwd,
    totalCount,
    hasMore: startIndex > 0,
  };
}

/**
 * Preview window anchored on the most recent message matching `query`.
 * The Session Finder preview must SHOW the match: the plain tail window made
 * the match navigator report "0/0" whenever the hit sat deeper in the session
 * than the last `limit` messages.
 */
export async function loadSessionAroundMatch(
  cwd: string,
  sessionId: string,
  limit: number,
  query: string,
): Promise<ConversationHistory | null> {
  const resolved = resolveSessionFile(cwd, sessionId);
  if (!resolved) {
    log.log(` Session file not found for session ${sessionId}`);
    return null;
  }
  const { messages } = await parseSessionMessagesCached(resolved);
  const totalCount = messages.length;
  const q = foldAccents(query.trim().toLowerCase());

  let anchor = -1;
  if (q) {
    for (let i = totalCount - 1; i >= 0; i--) {
      const m = messages[i];
      // Mirror what the preview renders (and what its match counter scans):
      // message content, plus the pretty-printed tool input of tool_use rows.
      let text = m.content || '';
      if (m.toolInput !== undefined) {
        try { text += ' ' + JSON.stringify(m.toolInput, null, 2); } catch { /* unstringifiable input */ }
      }
      if (foldAccents(text.toLowerCase()).includes(q)) {
        anchor = i;
        break;
      }
    }
  }

  if (anchor === -1) {
    // The hit lives in raw JSONL the preview doesn't render (subagent
    // sidechains, file snapshots, wire metadata). Surface the matching raw
    // lines as synthetic rows so the user still SEES — and can navigate —
    // what actually matched, instead of a lying empty "0/0" preview.
    if (resolved.filePath.endsWith('.jsonl')) {
      try {
        const rawScan = await scanSessionFileForQuery(resolved.filePath, q, undefined, 20);
        const rawLines = rawScan.firstLines ?? [];
        if (rawLines.length > 0) {
          const rows: SessionMessage[] = rawLines.map((line, i) => {
            // Prefer the readable text when it actually contains the hit;
            // otherwise show the (windowed) raw line — that's where it lives.
            const readable = extractReadableLineText(line);
            const content = readable.rank > SNIPPET_RANK_RAW && foldAccents(readable.text.toLowerCase()).includes(q)
              ? readable.text
              : line;
            let timestamp = '';
            try {
              const obj = JSON.parse(line) as { timestamp?: unknown };
              if (typeof obj.timestamp === 'string') timestamp = obj.timestamp;
            } catch { /* windowed/non-JSON line */ }
            return {
              type: 'tool_result',
              content,
              timestamp,
              uuid: `raw-match-${i}`,
              toolName: 'Session data',
            };
          });
          return { sessionId, messages: rows, cwd, totalCount, hasMore: false };
        }
      } catch { /* raw scan failed — fall through to the tail window */ }
    }
    const startIndex = Math.max(0, totalCount - limit);
    return { sessionId, messages: messages.slice(startIndex), cwd, totalCount, hasMore: startIndex > 0 };
  }

  // Put the anchor near the window's end with some trailing context, so the
  // window also covers as many EARLIER matches as possible.
  const contextAfter = Math.min(50, Math.floor(limit / 4));
  const endIndex = Math.min(totalCount, anchor + 1 + contextAfter);
  const startIndex = Math.max(0, endIndex - limit);
  return { sessionId, messages: messages.slice(startIndex, endIndex), cwd, totalCount, hasMore: startIndex > 0 };
}

/**
 * Search conversation history for matching messages
 * @param cwd - Working directory
 * @param sessionId - Session ID
 * @param query - Search query string
 * @param limit - Max results to return
 */
export async function searchSession(
  cwd: string,
  sessionId: string,
  query: string,
  limit: number = 50
): Promise<{ matches: SessionMessage[]; totalMatches: number } | null> {
  const resolved = resolveSessionFile(cwd, sessionId);
  if (!resolved) {
    return null;
  }

  const { messages } = await parseSessionMessagesCached(resolved);
  const queryLower = foldAccents(query.toLowerCase());
  const matches: SessionMessage[] = [];

  for (const message of messages) {
    const contentLower = foldAccents(message.content.toLowerCase());
    const toolNameLower = foldAccents(message.toolName?.toLowerCase() || '');
    const matched = contentLower.includes(queryLower) || toolNameLower.includes(queryLower);
    if (!matched) continue;
    matches.push(message);
  }

  const totalMatches = matches.length;

  return {
    matches: matches.slice(-limit), // Return most recent matches
    totalMatches,
  };
}

/**
 * Extract text content from Claude's message content blocks
 */
function _extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      }
    }

    return textParts.length > 0 ? textParts.join('\n') : null;
  }

  return null;
}

/**
 * Find the most recent session for a project
 */
export async function findLatestSession(cwd: string): Promise<string | null> {
  const sessions = await listSessions(cwd);

  if (sessions.length === 0) {
    return null;
  }

  // Return the most recently modified session
  return sessions[0].sessionId;
}

/**
 * Load history from a session, returning formatted messages for display
 */
export async function loadSessionHistory(
  cwd: string,
  sessionId: string,
  limit: number = 20
): Promise<{ role: 'user' | 'assistant' | 'tool_use' | 'tool_result'; content: string; timestamp: string; toolName?: string }[]> {
  const history = await loadSession(cwd, sessionId, limit);

  if (!history) {
    return [];
  }

  return history.messages.map(msg => ({
    role: msg.type,
    content: msg.content,
    timestamp: msg.timestamp,
    toolName: msg.toolName,
  }));
}

/**
 * Get session info summary
 */
export function getSessionSummary(sessions: SessionInfo[]): string {
  if (sessions.length === 0) {
    return 'No previous sessions found';
  }

  const latest = sessions[0];
  const age = Date.now() - latest.lastModified.getTime();
  const ageStr = age < 60000 ? 'just now'
    : age < 3600000 ? `${Math.floor(age / 60000)}m ago`
    : age < 86400000 ? `${Math.floor(age / 3600000)}h ago`
    : `${Math.floor(age / 86400000)}d ago`;

  return `${sessions.length} session(s), latest: ${ageStr} (${latest.messageCount} messages)`;
}

export async function loadToolHistory(
  cwd: string,
  sessionId: string,
  agentId: string,
  agentName: string,
  limit: number = 100
): Promise<{ toolExecutions: ToolExecution[]; fileChanges: FileChange[] }> {
  const toolExecutions: ToolExecution[] = [];
  const fileChanges: FileChange[] = [];

  const resolved = resolveSessionFile(cwd, sessionId);
  if (!resolved) {
    return { toolExecutions, fileChanges };
  }

  const { messages } = await parseSessionMessagesCached(resolved);

  for (const msg of messages) {
    if (msg.type !== 'tool_use' || !msg.toolName) continue;

    const timestamp = new Date(msg.timestamp).getTime();
    const toolInput = msg.toolInput;

    toolExecutions.push({
      agentId,
      agentName,
      toolName: msg.toolName,
      toolInput,
      timestamp,
    });

    if (!toolInput) continue;

    const filePath = (toolInput.file_path || toolInput.path) as string | undefined;
    if (!filePath) continue;

    let action: FileChange['action'] | null = null;
    if (msg.toolName === 'Write') {
      action = 'created';
    } else if (msg.toolName === 'Edit') {
      action = 'modified';
    } else if (msg.toolName === 'Read') {
      action = 'read';
    }
    if (action) {
      fileChanges.push({
        agentId,
        agentName,
        action,
        filePath,
        timestamp,
      });
    }
  }

  // Return most recent items (reversed so newest first)
  return {
    toolExecutions: toolExecutions.slice(-limit).reverse(),
    fileChanges: fileChanges.slice(-limit).reverse(),
  };
}
