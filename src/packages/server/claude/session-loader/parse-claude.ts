/**
 * Claude 消息解析:parseClaudeEntryMessages 与消息类型表。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { type SessionMessage } from './session-types.js';
import { serializeToolResultContent } from '../tool-result-content.js';

export type SessionActivityMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | null;

export function parseClaudeEntryMessages(
  entry: any,
  messages: SessionMessage[],
  toolUseIdToName: Map<string, string>
): void {
  // Messages typed while a turn is in flight are persisted as
  // attachment.queued_command rather than a top-level user entry, so emit
  // them as user messages to keep history chronologically intact.
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    const prompt = entry.attachment.prompt;
    if (typeof prompt === 'string' && prompt.trim()) {
      messages.push({
        type: 'user',
        content: prompt,
        timestamp: entry.timestamp,
        uuid: entry.uuid ?? `${entry.timestamp}-queued-user`,
      });
    }
    return;
  }

  if (entry.type === 'user' && entry.message?.content) {
    if (Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_result') {
          // Prefer raw tool_use_result stdout/stderr when available so history
          // preserves full command output (block.content can be summarized).
          let content: string;
          if (entry.tool_use_result?.stdout !== undefined) {
            content = String(entry.tool_use_result.stdout ?? '');
            if (entry.tool_use_result?.stderr) {
              content += (content ? '\n' : '') + `[stderr] ${String(entry.tool_use_result.stderr)}`;
            }
          } else {
            content = serializeToolResultContent(block.content);
          }
          const toolName = toolUseIdToName.get(block.tool_use_id) || 'unknown';
          messages.push({
            type: 'tool_result',
            content,
            timestamp: entry.timestamp,
            uuid: entry.uuid ?? `${entry.timestamp}-tool-result`,
            toolName,
            toolUseId: block.tool_use_id,
          });
        } else if (block.type === 'text' && block.text) {
          messages.push({
            type: 'user',
            content: block.text,
            timestamp: entry.timestamp,
            uuid: entry.uuid ?? `${entry.timestamp}-user`,
          });
        }
      }
      return;
    }

    messages.push({
      type: 'user',
      content: entry.message.content,
      timestamp: entry.timestamp,
      uuid: entry.uuid ?? `${entry.timestamp}-user`,
    });
    return;
  }

  if (entry.type === 'assistant' && entry.message?.content) {
    if (Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'text' && block.text) {
          messages.push({
            type: 'assistant',
            content: block.text,
            timestamp: entry.timestamp,
            uuid: entry.uuid ?? `${entry.timestamp}-assistant`,
          });
        } else if (block.type === 'tool_use' && block.name) {
          if (block.id) {
            toolUseIdToName.set(block.id, block.name);
          }
          messages.push({
            type: 'tool_use',
            content: JSON.stringify(block.input || {}, null, 2),
            timestamp: entry.timestamp,
            uuid: entry.uuid ?? `${entry.timestamp}-tool-use`,
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
          });
        }
      }
      return;
    }

    if (typeof entry.message.content === 'string') {
      messages.push({
        type: 'assistant',
        content: entry.message.content,
        timestamp: entry.timestamp,
        uuid: entry.uuid ?? `${entry.timestamp}-assistant`,
      });
    }
  }
}
