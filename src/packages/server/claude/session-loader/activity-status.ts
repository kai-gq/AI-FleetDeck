/**
 * 会话活动状态:最后修改时间推导与活动状态(SessionActivityStatus)。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, OPENCODE_MESSAGE_DIR } from './paths.js';
import { type ResolvedSessionFile } from './session-types.js';
import { getOpencodeDb } from './opencode-db.js';
import { resolveSessionFile } from './session-files.js';
import { parseSessionMessagesCached } from './parse-dispatch.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Load tool history from a session file
 * Returns tool executions and file changes
 */
/**
 * Session activity status for determining if an agent is working
 */
export interface SessionActivityStatus {
  isActive: boolean;           // Recently modified AND waiting for response
  hasPendingWork: boolean;     // Last message indicates Claude should respond (regardless of time)
  lastModified: Date;
  lastMessageType: 'user' | 'assistant' | 'tool_use' | 'tool_result' | null;
  lastMessageTimestamp: Date | null;
  secondsSinceLastActivity: number;
}

/**
 * Check if a session is currently active (being worked on)
 * This checks the session file modification time and last message
 * to determine if Claude is actively processing
 *
 * @param cwd - Working directory
 * @param sessionId - Session ID
 * @param activeThresholdSeconds - Consider active if modified within this many seconds (default 60)
 */
async function getResolvedSessionLastModified(resolved: ResolvedSessionFile): Promise<Date> {
  // DB-backed opencode sessions: use the latest part/message/session timestamp
  // in the SQLite DB. File mtime on opencode.db shifts with any write from any
  // project, so it's too noisy to gate per-session activity on.
  if (resolved.provider === 'opencode' && resolved.opencodeDbSessionId) {
    const db = getOpencodeDb();
    if (db) {
      try {
        const row = db
          .prepare(
            `SELECT MAX(latest) AS latest FROM (
               SELECT time_updated AS latest FROM session WHERE id = ?
               UNION ALL
               SELECT MAX(time_created) AS latest FROM message WHERE session_id = ?
               UNION ALL
               SELECT MAX(time_created) AS latest FROM part WHERE session_id = ?
             )`
          )
          .get(
            resolved.opencodeDbSessionId,
            resolved.opencodeDbSessionId,
            resolved.opencodeDbSessionId
          ) as { latest: number | null } | undefined;
        if (row && typeof row.latest === 'number' && row.latest > 0) {
          return new Date(row.latest);
        }
      } catch (err) {
        log.warn(`Opencode DB activity timestamp query failed: ${String(err)}`);
      }
    }
    // Fall through to a mtime-based fallback if the DB query fails.
  }

  const sessionStats = await fs.promises.stat(resolved.filePath);
  let mtime = sessionStats.mtime;

  // Legacy opencode filesystem layout: fold message dir mtime in since the
  // session JSON isn't rewritten on every turn.
  if (resolved.provider === 'opencode' && !resolved.opencodeDbSessionId) {
    const sessionId = path.basename(resolved.filePath, '.json');
    const messagesDir = path.join(OPENCODE_MESSAGE_DIR, sessionId);
    try {
      const msgStats = await fs.promises.stat(messagesDir);
      if (msgStats.mtime > mtime) {
        mtime = msgStats.mtime;
      }
    } catch {
      // Message dir may not exist yet on a brand-new session; ignore.
    }
  }

  return mtime;
}

export async function getSessionActivityStatus(
  cwd: string,
  sessionId: string,
  activeThresholdSeconds: number = 60
): Promise<SessionActivityStatus | null> {
  const resolved = resolveSessionFile(cwd, sessionId);
  if (!resolved) {
    return null;
  }

  const lastModified = await getResolvedSessionLastModified(resolved);
  const now = new Date();
  const secondsSinceModified = (now.getTime() - lastModified.getTime()) / 1000;
  const { lastMessageType, lastMessageTimestamp } = await parseSessionMessagesCached(resolved);

  // Determine if work is pending based on last message type:
  // - Last message was from user (Claude should be processing) OR
  // - Last message was tool_use (Claude is waiting for tool result) OR
  // - Last message was tool_result (Claude should be processing the result)
  const waitingForResponse = lastMessageType === 'user' ||
                             lastMessageType === 'tool_use' ||
                             lastMessageType === 'tool_result';

  // isActive = recently modified AND waiting (for real-time status)
  // hasPendingWork = just waiting for response (for server restart detection)
  const recentlyModified = secondsSinceModified < activeThresholdSeconds;
  const isActive = recentlyModified && waitingForResponse;

  return {
    isActive,
    hasPendingWork: waitingForResponse,
    lastModified,
    lastMessageType,
    lastMessageTimestamp,
    secondsSinceLastActivity: secondsSinceModified,
  };
}
