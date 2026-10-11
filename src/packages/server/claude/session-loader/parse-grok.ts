/**
 * Grok 会话解析:内容/展示文本/工具参数解析与主解析入口。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { normalizeGrokToolName } from './tool-names.js';
import { type SessionMessage } from './session-types.js';
import { deduplicateSessionMessages } from './message-utils.js';
import { type SessionActivityMessageType } from './parse-claude.js';
import * as fs from 'fs';

function extractGrokTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('\n');
}

/** Prefer the Tide-injected <user_query> body when present. */
export function extractGrokUserDisplayText(content: unknown): string {
  const raw = extractGrokTextContent(content).trim();
  if (!raw) return '';
  const queryMatch = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (queryMatch?.[1]) {
    return queryMatch[1].trim();
  }
  return raw;
}

function parseGrokToolArguments(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { raw: args };
    } catch {
      return { raw: args };
    }
  }
  return {};
}

/**
 * Parse Grok chat_history.jsonl into Tide SessionMessages.
 * chat_history has no per-line timestamps — we synthesize monotonic ISO times
 * so the client sort order matches file order.
 */
export function parseGrokSessionMessages(
  chatHistoryPath: string
): { messages: SessionMessage[]; lastMessageType: SessionActivityMessageType; lastMessageTimestamp: Date | null } {
  const messages: SessionMessage[] = [];
  if (!fs.existsSync(chatHistoryPath)) {
    return { messages: [], lastMessageType: null, lastMessageTimestamp: null };
  }

  // Timestamps: assign AFTER parse so the LAST message is file mtime and each
  // prior message is 1s earlier. Using (mtime - 1h + lineIndex) put the whole
  // history page ~50min behind wall-clock live events, so the merged
  // history+live list buried all tools ABOVE the live stream (user pin-to-
  // bottom only saw thinking + final text).
  let fileMtimeMs = Date.now();
  try {
    fileMtimeMs = fs.statSync(chatHistoryPath).mtimeMs;
  } catch {
    // ignore
  }

  const content = fs.readFileSync(chatHistoryPath, 'utf-8');
  const lines = content.split('\n');
  let lineIndex = 0;
  const toolUseIdToName = new Map<string, string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    lineIndex += 1;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof entry.type === 'string' ? entry.type : '';
    // Placeholder — rewritten below from file mtime once we know message count.
    const ts = new Date(fileMtimeMs).toISOString();

    // Skip system prompt and synthetic MCP/system-reminder injections
    if (type === 'system') continue;
    if (type === 'user' && entry.synthetic_reason === 'system_reminder') continue;

    if (type === 'user') {
      const text = extractGrokUserDisplayText(entry.content);
      if (!text) continue;
      // Skip pure scaffolding (user_info / system-reminder without user_query)
      if (
        text.startsWith('<user_info>') ||
        text.startsWith('<system-reminder>') ||
        (text.includes('<system-reminder>') && !text.includes('<user_query>'))
      ) {
        continue;
      }
      messages.push({
        type: 'user',
        content: text,
        timestamp: ts,
        uuid: `grok-user-${lineIndex}`,
      });
      continue;
    }

    if (type === 'reasoning') {
      // Optional thinking summaries — surface as assistant thinking lines
      const summary = entry.summary;
      let thinking = '';
      if (Array.isArray(summary)) {
        thinking = summary
          .map((s) => {
            if (s && typeof s === 'object' && typeof (s as { text?: string }).text === 'string') {
              return (s as { text: string }).text;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }
      if (thinking) {
        messages.push({
          type: 'assistant',
          content: `[thinking] ${thinking}`,
          timestamp: ts,
          uuid: typeof entry.id === 'string' ? entry.id : `grok-reasoning-${lineIndex}`,
        });
      }
      continue;
    }

    if (type === 'assistant') {
      const text = typeof entry.content === 'string' ? entry.content : extractGrokTextContent(entry.content);
      if (text.trim()) {
        messages.push({
          type: 'assistant',
          content: text,
          timestamp: ts,
          uuid: `grok-assistant-${lineIndex}`,
        });
      }

      const toolCalls = entry.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (let ti = 0; ti < toolCalls.length; ti++) {
          const call = toolCalls[ti] as {
            id?: string;
            name?: string;
            arguments?: unknown;
          };
          const callId = call.id || `grok-call-${lineIndex}-${ti}`;
          const toolName = normalizeGrokToolName(call.name || 'unknown');
          toolUseIdToName.set(callId, toolName);
          messages.push({
            type: 'tool_use',
            content: '',
            timestamp: ts,
            uuid: callId,
            toolName,
            toolInput: parseGrokToolArguments(call.arguments),
            toolUseId: callId,
          });
        }
      }
      continue;
    }

    if (type === 'tool_result') {
      const callId = typeof entry.tool_call_id === 'string' ? entry.tool_call_id : `grok-result-${lineIndex}`;
      const content =
        typeof entry.content === 'string'
          ? entry.content
          : entry.content != null
            ? JSON.stringify(entry.content)
            : '';
      messages.push({
        type: 'tool_result',
        content,
        timestamp: ts,
        uuid: `${callId}-result`,
        toolUseId: callId,
        toolName: toolUseIdToName.get(callId) || 'unknown',
      });
    }
  }

  const dedupedMessages = deduplicateSessionMessages(messages);

  // Restamp so last message ≈ file mtime and order is preserved (1s steps).
  const n = dedupedMessages.length;
  if (n > 0) {
    for (let i = 0; i < n; i++) {
      dedupedMessages[i] = {
        ...dedupedMessages[i],
        timestamp: new Date(fileMtimeMs - (n - 1 - i) * 1000).toISOString(),
      };
    }
  }

  const last = n > 0 ? dedupedMessages[n - 1] : null;
  return {
    messages: dedupedMessages,
    lastMessageType: last?.type ?? null,
    lastMessageTimestamp: last?.timestamp ? new Date(last.timestamp) : null,
  };
}
