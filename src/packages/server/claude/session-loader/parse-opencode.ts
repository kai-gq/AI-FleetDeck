/**
 * OpenCode 消息解析:DB 行/part 解析与新旧两种存储布局。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, OPENCODE_MESSAGE_DIR, OPENCODE_PART_DIR } from './paths.js';
import { normalizeOpencodeToolName } from './tool-names.js';
import { type SessionMessage } from './session-types.js';
import { getOpencodeDb } from './opencode-db.js';
import { deduplicateSessionMessages, isObject, safeParseJson } from './message-utils.js';
import { type SessionActivityMessageType } from './parse-claude.js';
import * as fs from 'fs';
import * as path from 'path';

function safeReadJsonFile(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface OpencodeDbMessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface OpencodeDbPartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

function parseOpencodePart(
  part: Record<string, unknown>,
  role: 'user' | 'assistant' | null,
  partId: string,
  timestamp: string,
  toolUseIdToName: Map<string, string>,
  messages: SessionMessage[]
): void {
  const partType = part.type;

  if (partType === 'text' && typeof part.text === 'string' && part.text.trim()) {
    if (role === null) return;
    messages.push({
      type: role,
      content: part.text,
      timestamp,
      uuid: partId,
    });
    return;
  }

  if (partType === 'tool') {
    const rawToolName = typeof part.tool === 'string' ? part.tool : 'unknown';
    const toolName = normalizeOpencodeToolName(rawToolName);
    const callId = typeof part.callID === 'string' ? part.callID : undefined;
    const state = isObject(part.state) ? part.state : null;
    const rawInput = state && isObject(state.input) ? state.input : {};

    if (callId) {
      toolUseIdToName.set(callId, toolName);
    }

    messages.push({
      type: 'tool_use',
      content: JSON.stringify(rawInput, null, 2),
      timestamp,
      uuid: partId,
      toolName,
      toolInput: rawInput,
      toolUseId: callId,
    });

    const status = state && typeof state.status === 'string' ? state.status : undefined;
    if (status === 'completed') {
      const output = state && typeof state.output === 'string' ? state.output : '';
      messages.push({
        type: 'tool_result',
        content: output,
        timestamp,
        uuid: `${partId}-result`,
        toolName,
        toolUseId: callId,
      });
    }
    return;
  }

  // Skip: reasoning, step-start, step-finish, patch (mirrors Claude/Codex history behavior).
}

export async function parseOpencodeDbSessionMessages(
  sessionId: string
): Promise<{ messages: SessionMessage[]; lastMessageType: SessionActivityMessageType; lastMessageTimestamp: Date | null }> {
  const db = getOpencodeDb();
  if (!db) {
    return { messages: [], lastMessageType: null, lastMessageTimestamp: null };
  }

  const messages: SessionMessage[] = [];
  const toolUseIdToName = new Map<string, string>();

  let messageRows: OpencodeDbMessageRow[];
  let partRows: OpencodeDbPartRow[];
  try {
    messageRows = db
      .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC')
      .all(sessionId) as OpencodeDbMessageRow[];
    partRows = db
      .prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC')
      .all(sessionId) as OpencodeDbPartRow[];
  } catch (err) {
    log.warn(`Opencode DB message/part query failed for ${sessionId}: ${String(err)}`);
    return { messages: [], lastMessageType: null, lastMessageTimestamp: null };
  }

  const partsByMessageId = new Map<string, OpencodeDbPartRow[]>();
  for (const part of partRows) {
    const bucket = partsByMessageId.get(part.message_id);
    if (bucket) {
      bucket.push(part);
    } else {
      partsByMessageId.set(part.message_id, [part]);
    }
  }

  for (const msgRow of messageRows) {
    const msgJson = safeParseJson(msgRow.data);
    if (!isObject(msgJson)) continue;

    const role = msgJson.role === 'user' ? 'user' : msgJson.role === 'assistant' ? 'assistant' : null;
    const createdMs = isObject(msgJson.time) && typeof msgJson.time.created === 'number'
      ? msgJson.time.created
      : msgRow.time_created;
    const timestamp = createdMs > 0 ? new Date(createdMs).toISOString() : new Date(0).toISOString();

    const messageParts = partsByMessageId.get(msgRow.id);
    if (!messageParts || messageParts.length === 0) continue;

    for (const partRow of messageParts) {
      const part = safeParseJson(partRow.data);
      if (!isObject(part)) continue;
      const partId = partRow.id;
      parseOpencodePart(part, role, partId, timestamp, toolUseIdToName, messages);
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

export async function parseOpencodeSessionMessages(
  sessionFilePath: string
): Promise<{ messages: SessionMessage[]; lastMessageType: SessionActivityMessageType; lastMessageTimestamp: Date | null }> {
  const messages: SessionMessage[] = [];
  const toolUseIdToName = new Map<string, string>();

  const sessionId = path.basename(sessionFilePath, '.json');
  const messagesDir = path.join(OPENCODE_MESSAGE_DIR, sessionId);

  if (!fs.existsSync(messagesDir)) {
    return { messages: [], lastMessageType: null, lastMessageTimestamp: null };
  }

  let messageFiles: string[];
  try {
    messageFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { messages: [], lastMessageType: null, lastMessageTimestamp: null };
  }

  for (const msgFile of messageFiles) {
    const msgJson = safeReadJsonFile(path.join(messagesDir, msgFile));
    if (!isObject(msgJson)) continue;

    const msgId = typeof msgJson.id === 'string' ? msgJson.id : msgFile.replace(/\.json$/, '');
    const role = msgJson.role === 'user' ? 'user' : msgJson.role === 'assistant' ? 'assistant' : null;
    const createdMs = isObject(msgJson.time) && typeof msgJson.time.created === 'number'
      ? msgJson.time.created
      : 0;
    const timestamp = createdMs > 0 ? new Date(createdMs).toISOString() : new Date(0).toISOString();

    const partsDir = path.join(OPENCODE_PART_DIR, msgId);
    if (!fs.existsSync(partsDir)) continue;

    let partFiles: string[];
    try {
      partFiles = fs.readdirSync(partsDir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }

    for (const partFile of partFiles) {
      const part = safeReadJsonFile(path.join(partsDir, partFile));
      if (!isObject(part)) continue;
      const partId = typeof part.id === 'string' ? part.id : `${timestamp}-${partFile}`;
      parseOpencodePart(part, role, partId, timestamp, toolUseIdToName, messages);
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
