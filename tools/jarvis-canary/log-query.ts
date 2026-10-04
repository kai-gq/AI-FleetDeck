/**
 * 只读 system_log 查询
 *
 * 取舍说明（任务书要求报告里写清）：
 *   - 首选本可复用 src/packages/server/data/system-log.ts 的 querySystemLog()，但它依赖
 *     event-db 的模块级连接（getDb() 需要先 initEventDb()）。initEventDb() 属于"写打开"：
 *     会跑 schema 迁移、设置 WAL pragma，对运行中的 dev server 有并发写/迁移副作用，
 *     违反"脚本自身不删改任何数据"的边界。
 *   - 因此本模块用 better-sqlite3 `readonly: true, fileMustExist: true` 直读同一个
 *     events.db，SQL 过滤语义与 system-log.ts:buildFilter / querySystemLog 逐条对齐
 *     （含 ts/id 双向排序与 limit/offset）。这样不触迁移、不写 WAL、不锁服务器。
 *   - 代价：schema 字段映射在此镜像一份；若 system-log.ts 表结构变更，此处需同步
 *     （selftest 会检查表列存在性，缺失时给出明确报错）。
 *
 * 已知限制：WAL 模式数据库的只读连接在"无其他进程持有 -shm"时可能打不开
 * （SQLITE_CANTOPEN）。dev server 在线时 -shm 存在，正常可用；报错文案会提示这一点。
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CanaryEntry, LogQueryFilter, LogQueryFn } from './types.js';

/** 与 src/packages/server/data/event-db.ts:22-27 相同的路径解析（XDG_DATA_HOME 可重定向） */
export function resolveDbPath(dbOverride?: string): string {
  if (dbOverride) return path.resolve(dbOverride);
  const dataDir = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'tide-commander',
  );
  return path.join(dataDir, 'events.db');
}

interface SystemLogDbRow {
  id: number;
  ts: number;
  category: string;
  source: string | null;
  agent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  task_id: string | null;
  level: string;
  body: string | null;
}

function rowToEntry(row: SystemLogDbRow): CanaryEntry {
  let body: Record<string, unknown> | undefined;
  if (row.body !== null && row.body !== undefined) {
    try {
      const parsed = JSON.parse(row.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      } else {
        body = { value: parsed };
      }
    } catch {
      // 非 JSON 原文（logEvent 允许字符串 body）——保留原文，不抛
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    category: row.category,
    source: row.source ?? undefined,
    agentId: row.agent_id ?? undefined,
    projectId: row.project_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    level: row.level,
    body,
    bodyRaw: row.body ?? undefined,
  };
}

export interface ReadOnlyLogQuery {
  dbPath: string;
  query: LogQueryFn;
  /** 全表行数（连通性/前置检查用） */
  countAll(): number;
  /** 最近窗口行数（dry-run 判断埋点管线是否活跃） */
  countSince(sinceMs: number): number;
  /** 最近一行的时间（无行返回 undefined） */
  latestTs(): number | undefined;
  close(): void;
}

/**
 * 以只读方式打开 events.db 并返回查询闭包。失败时抛出的 Error 带中文处置建议。
 */
export function openReadOnlyLogQuery(dbPath: string): ReadOnlyLogQuery {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `EventDB 不存在: ${dbPath}\n` +
      `可能原因：dev server 从未启动过（server 启动时会 initEventDb 建库），或 XDG_DATA_HOME 不同。`,
    );
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  } catch (err) {
    throw new Error(
      `只读打开 EventDB 失败: ${dbPath}\n` +
      `原因: ${err instanceof Error ? err.message : String(err)}\n` +
      `提示：WAL 模式下只读连接需要 -shm 文件（dev server 在线时存在）；请确认服务端正在运行。`,
    );
  }

  // 列存在性自检：表结构漂移（如未来 system_log 改名/改列）时立刻给明确错误
  const cols = db.prepare(`PRAGMA table_info(system_log)`).all() as Array<{ name: string }>;
  if (!Array.isArray(cols) || cols.length === 0) {
    db.close();
    throw new Error(
      `EventDB 中不存在 system_log 表: ${dbPath}\n` +
      `可能原因：dev server 未加载任务01/02 代码（表未建），或连到了错误的数据库文件。`,
    );
  }
  const required = ['id', 'ts', 'category', 'source', 'agent_id', 'project_id', 'session_id', 'task_id', 'level', 'body'];
  const present = new Set(cols.map((c) => c.name));
  const missing = required.filter((c) => !present.has(c));
  if (missing.length > 0) {
    db.close();
    throw new Error(`system_log 表结构缺列: ${missing.join(', ')}（EventDB: ${dbPath}）—— 请确认任务01 迁移已应用。`);
  }

  const stmtCache = new Map<string, Database.Statement>();

  const query: LogQueryFn = (filter: LogQueryFilter = {}) => {
    const { where, params } = buildFilter(filter);
    const direction = filter.order === 'asc' ? 'ASC' : 'DESC';
    const sql = `SELECT * FROM system_log${where} ORDER BY ts ${direction}, id ${direction} LIMIT ? OFFSET ?`;
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    const args = [...params, filter.limit ?? 200, filter.offset ?? 0];
    return (stmt.all(...args) as SystemLogDbRow[]).map(rowToEntry);
  };

  return {
    dbPath,
    query,
    countAll: () => (db.prepare('SELECT COUNT(*) AS c FROM system_log').get() as { c: number }).c,
    countSince: (sinceMs: number) =>
      (db.prepare('SELECT COUNT(*) AS c FROM system_log WHERE ts >= ?').get(sinceMs) as { c: number }).c,
    latestTs: () => {
      const row = db.prepare('SELECT MAX(ts) AS ts FROM system_log').get() as { ts: number | null };
      return row.ts ?? undefined;
    },
    close: () => {
      stmtCache.clear();
      db.close();
    },
  };
}

/**
 * WHERE 构造——与 src/packages/server/data/system-log.ts:301-317 buildFilter 逐条对齐。
 * eslint-disable-next-line 仅为保持两侧代码形似、便于人工比对。
 */
export function buildFilter(opts: LogQueryFilter): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.category) { conditions.push('category = ?'); params.push(opts.category); }
  if (opts.taskId) { conditions.push('task_id = ?'); params.push(opts.taskId); }
  if (opts.sessionId) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
  if (opts.source) { conditions.push('source = ?'); params.push(opts.source); }
  if (opts.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
  if (opts.projectId) { conditions.push('project_id = ?'); params.push(opts.projectId); }
  if (opts.level) { conditions.push('level = ?'); params.push(opts.level); }
  if (opts.since !== undefined) { conditions.push('ts >= ?'); params.push(opts.since); }
  if (opts.until !== undefined) { conditions.push('ts <= ?'); params.push(opts.until); }

  return { where: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '', params };
}
