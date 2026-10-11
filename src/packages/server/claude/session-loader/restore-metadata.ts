/**
 * 恢复元数据:从会话尾部提取 --resume 相关元信息(尾部字节读取)。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './paths.js';
import { type SessionProvider } from './session-types.js';
import { getOpencodeDb } from './opencode-db.js';
import { resolveSessionFile } from './session-files.js';
import * as fs from 'fs';

export interface SessionRestoreMetadata {
  provider: SessionProvider;
  /** Runtime-specific model id suitable for the new-agent model picker. */
  model?: string;
  /** Best-effort reasoning/thinking level from the latest turn. */
  effort?: string;
}

const RESTORE_METADATA_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Extract the latest runtime/model settings from session JSONL. Exported as a
 * pure helper so the provider-specific shapes can be covered without touching
 * a user's real session store.
 */
export function extractSessionRestoreMetadata(
  provider: Exclude<SessionProvider, 'opencode'>,
  jsonl: string,
): SessionRestoreMetadata {
  const metadata: SessionRestoreMetadata = { provider };
  const lines = jsonl.split('\n');
  let piModelProvider: string | undefined;
  let piModelId: string | undefined;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (provider === 'claude') {
      if (!metadata.model && entry.type === 'assistant' && typeof entry.message?.model === 'string') {
        metadata.model = entry.message.model;
      }
      if (!metadata.effort && typeof entry.effort === 'string') metadata.effort = entry.effort;
    } else if (provider === 'codex') {
      if (entry.type === 'turn_context') {
        if (!metadata.model && typeof entry.payload?.model === 'string') metadata.model = entry.payload.model;
        if (!metadata.effort) {
          const effort = entry.payload?.effort ?? entry.payload?.collaboration_mode?.settings?.reasoning_effort;
          if (typeof effort === 'string') metadata.effort = effort;
        }
      }
    } else if (provider === 'grok') {
      if (!metadata.model && entry.type === 'assistant' && typeof entry.model_id === 'string') {
        // Grok's transcript reports CLI build ids (grok-4.5-build), while the
        // agent configuration accepts the public model id (grok-4.5).
        metadata.model = entry.model_id.replace(/-build$/, '');
      }
      if (!metadata.effort && typeof entry.reasoning_effort === 'string') {
        metadata.effort = entry.reasoning_effort;
      }
    } else if (provider === 'pi') {
      if (!metadata.effort && entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') {
        metadata.effort = entry.thinkingLevel;
      }
      if (entry.type === 'model_change') {
        if (!piModelProvider && typeof entry.provider === 'string') piModelProvider = entry.provider;
        if (!piModelId && typeof entry.modelId === 'string') piModelId = entry.modelId;
      }
      if (!piModelProvider && typeof entry.message?.provider === 'string') piModelProvider = entry.message.provider;
      if (!piModelId && typeof entry.message?.model === 'string') piModelId = entry.message.model;
      if (piModelId) metadata.model = piModelProvider ? `${piModelProvider}/${piModelId}` : piModelId;
    }

    if (metadata.model && metadata.effort) break;
  }

  return metadata;
}

/** Read only the recent tail: current model settings live on the latest turn. */
function readSessionTail(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - RESTORE_METADATA_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Resolve the native runtime plus its most recent model/effort so Restore to
 * new agent can prefill an editable deployment modal instead of guessing.
 */
export function getSessionRestoreMetadata(cwd: string, sessionId: string): SessionRestoreMetadata | null {
  const resolved = resolveSessionFile(cwd, sessionId);
  if (!resolved) return null;

  if (resolved.provider === 'opencode') {
    const metadata: SessionRestoreMetadata = { provider: 'opencode' };
    const db = getOpencodeDb();
    if (!db) return metadata;
    try {
      const row = db.prepare(
        'SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1'
      ).get(resolved.opencodeDbSessionId ?? sessionId) as { data?: string } | undefined;
      if (row?.data) {
        const data = JSON.parse(row.data) as { providerID?: unknown; modelID?: unknown };
        if (typeof data.modelID === 'string') {
          metadata.model = typeof data.providerID === 'string'
            ? `${data.providerID}/${data.modelID}`
            : data.modelID;
        }
      }
    } catch (err) {
      log.warn(`Opencode restore metadata lookup failed for ${sessionId}: ${String(err)}`);
    }
    return metadata;
  }

  try {
    return extractSessionRestoreMetadata(resolved.provider, readSessionTail(resolved.filePath));
  } catch (err) {
    log.warn(`Restore metadata lookup failed for ${sessionId}: ${String(err)}`);
    return { provider: resolved.provider };
  }
}
