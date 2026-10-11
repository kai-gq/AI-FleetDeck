/**
 * OpenCode SQLite 直读:数据库惰性打开与失败缓存、会话行类型与按 id 查库。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, OPENCODE_DB_PATH } from './paths.js';
import { foldAccents } from './search-plan.js';
import * as fs from 'fs';
import Database from 'better-sqlite3';

export const codexSessionFileById = new Map<string, string>();

export const opencodeSessionFileById = new Map<string, string>();

export const piSessionFileById = new Map<string, string>();

let cachedOpencodeDb: Database.Database | null = null;

let opencodeDbOpenFailed = false;

export function getOpencodeDb(): Database.Database | null {
  if (cachedOpencodeDb) {
    return cachedOpencodeDb;
  }
  if (opencodeDbOpenFailed) {
    return null;
  }
  if (!fs.existsSync(OPENCODE_DB_PATH)) {
    return null;
  }
  try {
    // Readonly: opencode owns this DB and may have it open in WAL mode.
    // fileMustExist guards against silent DB creation if the file vanishes.
    cachedOpencodeDb = new Database(OPENCODE_DB_PATH, { readonly: true, fileMustExist: true });
    // Accent-blind search: SQL LIKE can't fold accents, so the same fold the
    // file engines use is exposed as a deterministic connection-level UDF.
    cachedOpencodeDb.function('tc_fold', { deterministic: true }, (v: unknown) =>
      foldAccents(String(v ?? '').toLowerCase()));
    return cachedOpencodeDb;
  } catch (err) {
    opencodeDbOpenFailed = true;
    log.warn(`Failed to open opencode sqlite DB at ${OPENCODE_DB_PATH}: ${String(err)}`);
    return null;
  }
}

interface OpencodeDbSessionRow {
  id: string;
  directory: string;
  time_updated: number;
}

export function findOpencodeDbSession(sessionId: string): OpencodeDbSessionRow | null {
  const db = getOpencodeDb();
  if (!db) return null;
  try {
    const row = db
      .prepare('SELECT id, directory, time_updated FROM session WHERE id = ? LIMIT 1')
      .get(sessionId) as OpencodeDbSessionRow | undefined;
    return row ?? null;
  } catch (err) {
    log.warn(`Opencode DB session lookup failed for ${sessionId}: ${String(err)}`);
    return null;
  }
}
