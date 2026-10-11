/**
 * Pi 会话解析:内容文本抽取与 parsePiSessionMessages。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { normalizePiToolName } from './tool-names.js';
import { type SessionMessage } from './session-types.js';
import { deduplicateSessionMessages } from './message-utils.js';
import { type SessionActivityMessageType } from './parse-claude.js';
import * as fs from 'fs';
import { normalizePiToolInput } from '../../pi/tool-input.js';
import { extractPiReasoningMetadata } from '../../pi/reasoning-metadata.js';

/** Extract plain text from a pi content value (string or content-block array). */
function extractPiContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: string }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse a pi session JSONL file (~/.pi/agent/sessions/…) into SessionMessages.
 * Entries normally have type 'message' with an AgentMessage payload. Native
 * compaction entries are also rendered as a compact history marker; remaining
 * metadata (model_change, labels, …) is skipped. Entries form a tree via
 * id/parentId but TC-driven sessions are linear appends, so file order is used.
 */
export function parsePiSessionMessages(
  sessionFilePath: string
): { messages: SessionMessage[]; lastMessageType: SessionActivityMessageType; lastMessageTimestamp: Date | null } {
  const messages: SessionMessage[] = [];
  const toolUseIdToName = new Map<string, string>();
  const toolUseById = new Map<string, SessionMessage>();

  let content = '';
  try {
    content = fs.readFileSync(sessionFilePath, 'utf-8');
  } catch {
    return { messages, lastMessageType: null, lastMessageTimestamp: null };
  }

  let lineIndex = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    lineIndex += 1;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = typeof entry.type === 'string' ? entry.type : '';
    const entryId = typeof entry.id === 'string' ? entry.id : `pi-line-${lineIndex}`;
    const baseTsMs = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))
      ? Date.parse(entry.timestamp)
      : Date.now();
    // Rows derived from ONE entry (thinking + text + toolCalls) must carry
    // strictly increasing timestamps: the client's merged history+live sort
    // tie-breaks equal timestamps by uuid lex order, which would put the
    // `pi-assistant-…` text row BEFORE its `pi-thinking-…` block.
    let rowOffset = 0;
    const stamp = () => new Date(baseTsMs + rowOffset++).toISOString();

    if (entryType === 'compaction') {
      messages.push({
        type: 'assistant',
        content: '<local-command-stdout>Compacted</local-command-stdout>',
        timestamp: stamp(),
        uuid: `pi-compaction-${entryId}`,
      });
      continue;
    }

    if (entryType !== 'message') continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') continue;

    const role = typeof message.role === 'string' ? message.role : '';

    if (role === 'user') {
      const text = extractPiContentText(message.content);
      if (!text.trim()) continue;
      messages.push({
        type: 'user',
        content: text,
        timestamp: stamp(),
        uuid: `pi-user-${entryId}`,
      });
      continue;
    }

    if (role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const usage = message.usage && typeof message.usage === 'object'
        ? message.usage as { reasoning?: unknown }
        : undefined;
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi] as { type?: string; text?: string; thinking?: string; thinkingSignature?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
        if (block?.type === 'thinking' && block.thinking?.trim()) {
          messages.push({
            type: 'assistant',
            content: `[thinking] ${block.thinking}`,
            timestamp: stamp(),
            uuid: `pi-thinking-${entryId}-${bi}`,
            ...extractPiReasoningMetadata(block.thinkingSignature, usage?.reasoning),
          });
        } else if (block?.type === 'text' && block.text?.trim()) {
          messages.push({
            type: 'assistant',
            content: block.text,
            timestamp: stamp(),
            uuid: `pi-assistant-${entryId}-${bi}`,
          });
        } else if (block?.type === 'toolCall') {
          const callId = block.id || `pi-call-${entryId}-${bi}`;
          const toolName = normalizePiToolName(block.name || 'unknown');
          const toolUse: SessionMessage = {
            type: 'tool_use',
            content: '',
            timestamp: stamp(),
            uuid: callId,
            toolName,
            toolInput: normalizePiToolInput(toolName, block.arguments || {}),
            toolUseId: callId,
          };
          toolUseIdToName.set(callId, toolName);
          toolUseById.set(callId, toolUse);
          messages.push(toolUse);
        }
      }
      continue;
    }

    if (role === 'toolResult') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : `pi-result-${entryId}`;
      const toolName = typeof message.toolName === 'string'
        ? normalizePiToolName(message.toolName)
        : toolUseIdToName.get(callId) || 'unknown';
      let output = extractPiContentText(message.content);
      if (message.isError && output) {
        output = `Error: ${output}`;
      }
      const toolUse = toolUseById.get(callId);
      if (toolName === 'Edit' && toolUse) {
        const details = message.details && typeof message.details === 'object'
          ? message.details as { patch?: unknown; firstChangedLine?: unknown }
          : undefined;
        toolUse.toolInput = normalizePiToolInput(toolName, toolUse.toolInput, details);
      }
      messages.push({
        type: 'tool_result',
        content: output,
        timestamp: stamp(),
        uuid: `${callId}-result`,
        toolUseId: callId,
        toolName,
      });
      continue;
    }

    if (role === 'bashExecution') {
      // User-invoked `!command` — render as a Bash tool round.
      const callId = `pi-bash-${entryId}`;
      messages.push({
        type: 'tool_use',
        content: '',
        timestamp: stamp(),
        uuid: callId,
        toolName: 'Bash',
        toolInput: { command: typeof message.command === 'string' ? message.command : '' },
        toolUseId: callId,
      });
      messages.push({
        type: 'tool_result',
        content: typeof message.output === 'string' ? message.output : '',
        timestamp: stamp(),
        uuid: `${callId}-result`,
        toolUseId: callId,
        toolName: 'Bash',
      });
      continue;
    }

    if (role === 'compactionSummary' && typeof message.summary === 'string' && message.summary.trim()) {
      messages.push({
        type: 'assistant',
        content: `[compaction] ${message.summary}`,
        timestamp: stamp(),
        uuid: `pi-compaction-${entryId}`,
      });
      continue;
    }

    // custom / branchSummary / other extension roles — not part of the chat view
  }

  const dedupedMessages = deduplicateSessionMessages(messages);
  const last = dedupedMessages.length > 0 ? dedupedMessages[dedupedMessages.length - 1] : null;
  return {
    messages: dedupedMessages,
    lastMessageType: last?.type ?? null,
    lastMessageTimestamp: last?.timestamp ? new Date(last.timestamp) : null,
  };
}
