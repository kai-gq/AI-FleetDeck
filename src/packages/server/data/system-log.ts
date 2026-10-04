/**
 * System Log —— 统一事件流（⑭ 日志地基①，Spec §4.14）
 *
 * 所有关键行为（对话/播报/委派/系统活动/决策）经单一入口 logEvent() 追加写入 EventDB 的
 * system_log 表（append-only）。设计约束：
 *   - 写失败静默降级：不抛异常、不影响主链路，只记内存计数；
 *   - 分级写入：决策/错误（warn+）全量；高频 info 通道（HTTP、context_stats 轮询）按 1:10 采样
 *     （INFO_SAMPLE_RATE 为初始值非最优，Spec §8.2，待 ⑭ 磁盘/查询观测 → ⑮ 标定后回写）；
 *   - 隐私：body 落盘前密钥脱敏；events.db 权限收紧为仅当前用户可读写；保留期跟随 90 天策略
 *     （已登记进 event-retention-service 的 EVENT_TABLES）。
 *
 * 本任务只埋「地基通道」，各决策观测点（🔴 ①②④⑥⑦⑪⑬）随对应任务落地时接入。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { insertOne, queryMany, queryOne, execute } from './event-db.js';
import { createLogger } from '../utils/logger.js';
import { getCurrentAgentId } from '../utils/log-context.js';
import { getTraceContext } from '../utils/trace-context.js';

const log = createLogger('SystemLog');

// 与 event-db.ts / event-retention-service.ts 相同的数据目录解析（XDG_DATA_HOME 可重定向）
const DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'tide-commander'
);
const DB_PATH = path.join(DATA_DIR, 'events.db');

/** logEvent 未显式给 source 且链路上下文也无 source 时的兜底来源标识 */
const DEFAULT_SOURCE = 'server';

const REDACTED = '[REDACTED]';

// ─── 类型 ───

/** 基础四类（Spec §4.14）；后续改造点可扩展（如 decision / http / context_stats / voice / usage）。 */
export type SystemLogCategory = 'dialog' | 'broadcast' | 'delegation' | 'system' | (string & {});

export type SystemLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEventFields {
  /** 写入时刻（epoch 毫秒）；缺省 Date.now() */
  ts?: number;
  /** 来源标识（模块/服务名）：显式值 > 链路上下文 source > 'server' */
  source?: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  /** 缺省 'info'；warn/error（决策/错误）始终全量写入 */
  level?: SystemLogLevel;
  /** 正文：字符串原样存，对象 JSON 化；落盘前做密钥脱敏 */
  body?: unknown;
  /**
   * 高频通道标记（HTTP、context_stats 轮询等）：true 时按 INFO_SAMPLE_RATE 采样降频。
   * 仅对 debug/info 生效；业务链路（dialog/broadcast/delegation）默认全量，保证链路时间线完整。
   */
  sampled?: boolean;
}

export interface SystemLogEntry {
  id?: number;
  ts: number;
  category: SystemLogCategory;
  source?: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  level: SystemLogLevel;
  /** 落库原文（字符串或 JSON 串）；查询方按需解析 */
  body?: string;
}

export interface SystemLogQuery {
  category?: string;
  source?: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  level?: SystemLogLevel;
  /** ts >= since */
  since?: number;
  /** ts <= until */
  until?: number;
  limit?: number;
  offset?: number;
  /** 时间线查询用 'asc'；默认 'desc'（最近优先） */
  order?: 'asc' | 'desc';
}

/** 「可删自己的日志」入口（隐私边界）：仅面向用户/保留期清理，智能体不应调用（append-only 边界）。 */
export interface SystemLogDeleteFilter {
  /** 删除 ts < before 的行 */
  before?: number;
  taskId?: string;
  sessionId?: string;
  category?: string;
}

// ─── 采样 ───

/**
 * info 类高频通道采样率 1:10 —— 初始值非最优（Spec §8.2，行业常见 OTel 尾部采样 10%–25%），
 * 由 ⑭ 磁盘占用/查询性能观测 → ⑮ 分析标定后回写。
 */
export const INFO_SAMPLE_RATE = 10;

/** 天然视为高频通道的 category（配合 fields.sampled 使用，二者任一命中即参与采样）。 */
export const SAMPLED_CATEGORIES: ReadonlySet<string> = new Set(['http', 'context_stats']);

let sampleCounter = 0;
let writeFailureCount = 0;

/** 判定本条是否被采样丢弃：warn+ 全量；仅高频标记的 debug/info 参与 1:N 降频。 */
function isDroppedBySampling(category: string, level: SystemLogLevel, fields: LogEventFields): boolean {
  if (level === 'warn' || level === 'error') return false;
  if (!fields.sampled && !SAMPLED_CATEGORIES.has(category)) return false;
  // 确定性计数采样（第 N 条留 1 条），而非随机——便于测试与负载可预期
  sampleCounter += 1;
  return sampleCounter % INFO_SAMPLE_RATE !== 0;
}

// ─── 脱敏 ───

// 键名按词切分后判断，避免误伤 tokensUsed / tokenCount 这类用量字段
const SENSITIVE_WORDS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'credential', 'credentials',
  'authorization', 'cookie', 'token', 'apikey', 'privatekey', 'accesskey', 'secretkey',
]);
const KEY_PREFIX_WORDS = new Set(['api', 'private', 'public', 'secret', 'ssh', 'access', 'client']);

function keyIsSensitive(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some(w => SENSITIVE_WORDS.has(w))) return true;
  return words.some((w, i) => w === 'key' && i > 0 && KEY_PREFIX_WORDS.has(words[i - 1]));
}

/** 递归脱敏：对象中命中敏感键名的值整体替换为 [REDACTED]。 */
export function redactSensitive(value: unknown): unknown {
  return redactValue(value, 0);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return REDACTED; // 防御循环/超深结构
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = keyIsSensitive(key) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 敏感键名（字符串正文用，含 client_secret 这类前缀形态） */
const SENSITIVE_KEY_PATTERN = '(?:client[-_]?)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd)';

/** 字符串正文里的常见密钥形态：Bearer/Basic 头、JSON 键值、key=value、sk-/ghp_/xoxb-/AKIA 前缀。 */
function redactString(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(
      new RegExp(`"(${SENSITIVE_KEY_PATTERN})"(\\s*:\\s*)"[^"]{4,}"`, 'gi'),
      (_m, key: string, sep: string) => `"${key}"${sep}"${REDACTED}"`
    )
    .replace(
      new RegExp(`\\b(${SENSITIVE_KEY_PATTERN})\\b(\\s*[=:]\\s*)("?)([^\\s,;"'}\\]]{4,})\\3`, 'gi'),
      (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}${quote}`
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})/g, REDACTED);
}

function serializeBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return redactString(body);
  try {
    const redacted = redactSensitive(body);
    const json = JSON.stringify(redacted);
    return json === undefined ? String(redacted) : json;
  } catch {
    // BigInt / 循环引用等无法序列化的 body 不能影响主链路
    return '[Unserializable]';
  }
}

// ─── 权限收紧 ───

let dbPermissionsEnsured = false;

/** events.db（含 WAL/SHM）权限收紧为仅当前用户可读写（0600）——隐私边界（Spec §4.14）。 */
export function ensureEventDbFilePermissions(): void {
  if (dbPermissionsEnsured) return;
  dbPermissionsEnsured = true;
  if (process.platform === 'win32') return; // Windows 走 ACL，chmod 无意义
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    } catch {
      // 权限收紧失败不影响日志写入
    }
  }
}

// ─── 写入 ───

function normalizeLevel(level?: string): SystemLogLevel {
  return level === 'debug' || level === 'warn' || level === 'error' ? level : 'info';
}

/**
 * 统一事件写入入口（唯一写路径，append-only）。
 *
 * @returns 写入成功返回行 id；被采样丢弃或写入失败返回 undefined（失败不抛异常）。
 */
export function logEvent(category: SystemLogCategory, fields: LogEventFields = {}): number | undefined {
  try {
    const normalizedCategory = typeof category === 'string' && category.trim() ? category : 'system';
    const level = normalizeLevel(fields.level);

    if (isDroppedBySampling(normalizedCategory, level, fields)) return undefined;

    const trace = getTraceContext();
    const id = insertOne('system_log', {
      ts: fields.ts ?? Date.now(),
      category: normalizedCategory,
      source: fields.source ?? trace?.source ?? DEFAULT_SOURCE,
      agent_id: fields.agentId ?? trace?.agentId ?? getCurrentAgentId() ?? null,
      project_id: fields.projectId ?? trace?.projectId ?? null,
      session_id: fields.sessionId ?? trace?.sessionId ?? null,
      task_id: fields.taskId ?? trace?.taskId ?? null,
      level,
      body: serializeBody(fields.body),
    });

    ensureEventDbFilePermissions();
    return id;
  } catch (err) {
    writeFailureCount += 1;
    // 静默降级：首条与每 100 条告警一次，避免 EventDB 故障时刷爆 server.log
    if (writeFailureCount === 1 || writeFailureCount % 100 === 0) {
      log.warn(`system_log 写入失败（累计 ${writeFailureCount} 次，已忽略不影响主链路）：`,
        err instanceof Error ? err.message : err);
    }
    return undefined;
  }
}

/** 写入失败累计次数（内存计数；进程重启归零）——用于 ⑭/⑮ 观测写入健康度。 */
export function getLogEventWriteFailureCount(): number {
  return writeFailureCount;
}

/** 测试专用：重置采样计数与失败计数（避免用例间相互影响）。 */
export function resetSystemLogStateForTests(): void {
  sampleCounter = 0;
  writeFailureCount = 0;
}

// ─── 查询 ───

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

function rowToEntry(row: SystemLogDbRow): SystemLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    category: row.category as SystemLogCategory,
    source: row.source ?? undefined,
    agentId: row.agent_id ?? undefined,
    projectId: row.project_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    level: normalizeLevel(row.level),
    body: row.body ?? undefined,
  };
}

function buildFilter(opts: SystemLogQuery | SystemLogDeleteFilter): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if ('category' in opts && opts.category) { conditions.push('category = ?'); params.push(opts.category); }
  if ('taskId' in opts && opts.taskId) { conditions.push('task_id = ?'); params.push(opts.taskId); }
  if ('sessionId' in opts && opts.sessionId) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
  if ('source' in opts && opts.source) { conditions.push('source = ?'); params.push(opts.source); }
  if ('agentId' in opts && opts.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
  if ('projectId' in opts && opts.projectId) { conditions.push('project_id = ?'); params.push(opts.projectId); }
  if ('level' in opts && opts.level) { conditions.push('level = ?'); params.push(opts.level); }
  if ('since' in opts && opts.since !== undefined) { conditions.push('ts >= ?'); params.push(opts.since); }
  if ('until' in opts && opts.until !== undefined) { conditions.push('ts <= ?'); params.push(opts.until); }
  if ('before' in opts && opts.before !== undefined) { conditions.push('ts < ?'); params.push(opts.before); }

  return { where: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '', params };
}

/**
 * 按条件查询事件流。按 taskId 查询时用 order:'asc' 即得完整链路时间线（验收 1）。
 */
export function querySystemLog(opts: SystemLogQuery = {}): SystemLogEntry[] {
  const { where, params } = buildFilter(opts);
  const direction = opts.order === 'asc' ? 'ASC' : 'DESC';
  const sql = `SELECT * FROM system_log${where} ORDER BY ts ${direction}, id ${direction} LIMIT ? OFFSET ?`;
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  return queryMany<SystemLogDbRow>(sql, params).map(rowToEntry);
}

export function countSystemLog(opts: SystemLogQuery = {}): number {
  const { where, params } = buildFilter(opts);
  const row = queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM system_log${where}`, params);
  return row?.count ?? 0;
}

/**
 * 「可删自己的日志」：删除满足条件的行，返回删除条数。
 * 安全阀：必须至少一个过滤条件，空条件调用直接返回 0（不误清全表）。
 */
export function deleteSystemLog(opts: SystemLogDeleteFilter): number {
  const { where, params } = buildFilter(opts);
  if (!where) return 0;
  return execute(`DELETE FROM system_log${where}`, params).changes;
}
