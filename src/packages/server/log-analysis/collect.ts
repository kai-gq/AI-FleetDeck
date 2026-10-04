/**
 * 数据源收集（⑮ P1）：system_log / audit_log 查询 + server.log 尾部读取。
 *
 * 只读：全部走现有查询函数（querySystemLog / queryAuditLog）与 fs 只读读取，
 * 不写 EventDB、不改 server.log、不执行任何命令。
 *
 * 降级原则：单个数据源失败不阻断整体分析 —— 记 warning 后继续（查询函数本身
 * 在 EventDB 未初始化时会抛错，这里统一兜住，由 service 汇总为 collect-error）。
 */

import * as fs from 'fs';
import type { AuditLogEntry } from '../../shared/event-types.js';
import { querySystemLog, type SystemLogEntry, type SystemLogQuery } from '../data/system-log.js';
import { queryAuditLog } from '../data/event-queries.js';
import { getLogFilePath } from '../utils/logger.js';
import type { LogWindow } from './types.js';

// ─── server.log 行 ───

export interface ServerLogLine {
  /** 在本次读取尾部窗口内的行号（1 起，仅供人读/排错） */
  line: number;
  /** 解析出的时间戳；无时间戳的续行（堆栈）继承上一行 */
  ts?: number;
  level: 'error' | 'warn' | 'info';
  text: string;
  /** true = 无时间戳的续行（堆栈行）：计入摘录但不单独计入 error/warn 行数 */
  continuation?: boolean;
}

export interface ServerLogReadOptions {
  from: number;
  to: number;
  /** 缺省 getLogFilePath()（logs/server.log，含轮转后的当前文件） */
  filePath?: string;
  /** 只读文件尾部多少字节（缺省 2 MiB，防大文件全量载入） */
  maxBytes?: number;
  /** 窗口内最多保留多少行（缺省 200；error/warn 优先，其余按新近补齐） */
  maxLines?: number;
}

export interface ServerLogReadResult {
  lines: ServerLogLine[];
  /** 窗口内（截断前）的 ERROR / WARN 行数 */
  errorCount: number;
  warnCount: number;
  warnings: string[];
}

// 应用日志格式（utils/logger.ts formatMessage，ANSI 已剥离）：
// [Tide] 12345  - 10/04/2026, 03:15:22 PM  ERROR [Context] [agentId=x] message
const APP_LINE_RE = /^\[Tide\]\s+\d+\s+-\s+(\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2}\s+[AP]M)\s+([A-Z]+)\s+\[/;
// 启动/轮转标记：[2026-10-04T03:15:22.000Z] Server started ...
const ISO_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]/;

function parseLineTimestamp(text: string): number | undefined {
  const app = APP_LINE_RE.exec(text);
  if (app) {
    const t = Date.parse(app[1]);
    if (!Number.isNaN(t)) return t;
  }
  const iso = ISO_LINE_RE.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

function parseLineLevel(text: string): 'error' | 'warn' | 'info' {
  const app = APP_LINE_RE.exec(text);
  const label = app ? app[2] : '';
  if (label === 'ERROR') return 'error';
  if (label === 'WARN') return 'warn';
  // 兜底：正文关键词（无格式行/第三方输出）
  if (/\bERROR\b/.test(text)) return 'error';
  if (/\bWARN(?:ING)?\b/.test(text)) return 'warn';
  return 'info';
}

/** 读取文件尾部字节（不存在返回 null）。 */
function readTailBytes(filePath: string, maxBytes: number): string | null {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return '';
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读取 server.log 尾部并按时间窗过滤。
 *
 * 续行处理：无时间戳的行（多行堆栈等）若紧跟上一条被保留的行，则作为续行保留
 * （继承上一行 ts/level）；否则丢弃。窗口截断时 error/warn 行优先保留。
 */
export function readServerLogWindow(opts: ServerLogReadOptions): ServerLogReadResult {
  const warnings: string[] = [];
  const filePath = opts.filePath ?? getLogFilePath();
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxLines = opts.maxLines ?? 200;

  let raw: string | null = null;
  try {
    raw = readTailBytes(filePath, maxBytes);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    warnings.push(
      code === 'ENOENT'
        ? `server.log 不存在（${filePath}）；本次分析仅依据 EventDB。`
        : `server.log 读取失败（${filePath}）：${(err as Error).message}`
    );
    return { lines: [], errorCount: 0, warnCount: 0, warnings };
  }
  if (raw === null) return { lines: [], errorCount: 0, warnCount: 0, warnings };

  const rawLines = raw.split(/\r?\n/);
  const inWindow: ServerLogLine[] = [];
  let partialDropped = false;
  let prev: ServerLogLine | undefined;

  for (let i = 0; i < rawLines.length; i += 1) {
    const text = rawLines[i];
    if (!text.trim()) continue;
    const lineNo = i + 1;
    const ts = parseLineTimestamp(text);
    let row: ServerLogLine;
    if (ts !== undefined) {
      row = { line: lineNo, ts, level: parseLineLevel(text), text };
    } else if (prev) {
      // 续行：继承上一行的窗口判定与级别（标记 continuation，避免污染 error/warn 计数）
      row = { line: lineNo, ts: prev.ts, level: prev.level, text, continuation: true };
    } else {
      // 尾部切片可能从行中间开始：丢弃无法归属的首行
      partialDropped = true;
      continue;
    }
    if (row.ts !== undefined && row.ts >= opts.from && row.ts <= opts.to) {
      inWindow.push(row);
      prev = row;
    }
  }
  if (partialDropped) {
    warnings.push('server.log 尾部切片以不完整行开头，已丢弃该行。');
  }

  const errorCount = inWindow.filter(l => l.level === 'error' && !l.continuation).length;
  const warnCount = inWindow.filter(l => l.level === 'warn' && !l.continuation).length;

  let selected = inWindow;
  if (inWindow.length > maxLines) {
    // error/warn 优先，其余按新近补齐，再按原顺序还原时间线
    const severe = inWindow.filter(l => l.level !== 'info');
    const rest = inWindow.filter(l => l.level === 'info');
    const keep = new Set<ServerLogLine>(severe.slice(0, maxLines));
    for (let i = rest.length - 1; i >= 0 && keep.size < maxLines; i -= 1) keep.add(rest[i]);
    selected = inWindow.filter(l => keep.has(l));
    warnings.push(`server.log 窗口内 ${inWindow.length} 行，已按 error/warn 优先截取 ${selected.length} 行。`);
  }

  return { lines: selected, errorCount, warnCount, warnings };
}

// ─── 收集 ───

export interface LogAnalysisDeps {
  querySystemLog: (opts: SystemLogQuery) => SystemLogEntry[];
  queryAuditLog: (opts: {
    category?: string;
    level?: string;
    workflowInstanceId?: string;
    agentId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  }) => AuditLogEntry[];
  readServerLog: (opts: ServerLogReadOptions) => ServerLogReadResult;
}

/** 默认实现：现有查询函数 + fs 只读。测试可注入 stub 模拟查询报错。 */
export function createDefaultDeps(): LogAnalysisDeps {
  return {
    querySystemLog,
    queryAuditLog,
    readServerLog: readServerLogWindow,
  };
}

export interface CollectLimits {
  systemLog?: number;
  auditLog?: number;
  serverLogLines?: number;
}

export interface CollectedLogs {
  systemLog: SystemLogEntry[];
  auditLog: AuditLogEntry[];
  serverLog: ServerLogReadResult;
  warnings: string[];
  /** 每个数据源是否收集失败（用于区分「空窗」与「采集报错」） */
  errors: { systemLog: boolean; auditLog: boolean; serverLog: boolean };
}

/**
 * 收集三源数据。单源失败不抛出：throws → 记 warning + errors 标记，继续收集其余源。
 */
export function collectLogs(
  window: LogWindow,
  limits: CollectLimits = {},
  deps: LogAnalysisDeps = createDefaultDeps(),
  serverLogPath?: string,
): CollectedLogs {
  const warnings: string[] = [];
  const errors = { systemLog: false, auditLog: false, serverLog: false };

  let systemLog: SystemLogEntry[] = [];
  try {
    systemLog = deps.querySystemLog({
      since: window.from,
      until: window.to,
      order: 'asc',
      limit: limits.systemLog ?? 2000,
    });
    if (systemLog.length === (limits.systemLog ?? 2000)) {
      warnings.push('system_log 达到查询上限，窗口内事件可能被截断（可缩小时间窗重查）。');
    }
  } catch (err) {
    errors.systemLog = true;
    warnings.push(`system_log 查询失败：${(err as Error).message}`);
  }

  let auditLog: AuditLogEntry[] = [];
  try {
    auditLog = deps
      .queryAuditLog({ since: window.from, until: window.to, limit: limits.auditLog ?? 200 })
      .filter(e => e.createdAt <= window.to); // 保险带：防注入实现忽略 until 时越窗
  } catch (err) {
    errors.auditLog = true;
    warnings.push(`audit_log 查询失败：${(err as Error).message}`);
  }

  let serverLog: ServerLogReadResult = { lines: [], errorCount: 0, warnCount: 0, warnings: [] };
  try {
    serverLog = deps.readServerLog({
      from: window.from,
      to: window.to,
      maxLines: limits.serverLogLines ?? 200,
      filePath: serverLogPath,
    });
  } catch (err) {
    errors.serverLog = true;
    warnings.push(`server.log 读取失败：${(err as Error).message}`);
  }
  warnings.push(...serverLog.warnings);

  return { systemLog, auditLog, serverLog, warnings, errors };
}
