/**
 * 通用消息小工具:消息去重、对象判定、文本归一、JSON 安全解析与截断。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { type SessionMessage } from './session-types.js';

export function deduplicateSessionMessages(messages: SessionMessage[]): SessionMessage[] {
  const deduped: SessionMessage[] = [];
  const seen = new Set<string>();
  // Content-based dedup for assistant messages: Codex can emit the same text
  // via multiple event types (event_msg.agent_message, response_item.message,
  // event_msg.task_complete). Keep only the first occurrence per unique content.
  const seenAssistantContent = new Set<string>();

  for (const message of messages) {
    const toolInputSignature = message.toolInput ? JSON.stringify(message.toolInput) : '';
    const key = [
      message.type,
      message.timestamp,
      message.uuid,
      message.content,
      message.toolName ?? '',
      message.toolUseId ?? '',
      toolInputSignature,
    ].join('\u241f');

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (message.type === 'assistant') {
      if (seenAssistantContent.has(message.content)) {
        continue;
      }
      seenAssistantContent.add(message.content);
    }

    deduped.push(message);
  }

  return deduped;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (typeof content === 'object') return JSON.stringify(content, null, 2);
  return String(content);
}

export function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
