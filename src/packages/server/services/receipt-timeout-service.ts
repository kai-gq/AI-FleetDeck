/**
 * 任务17·A2 回执超时提醒（v1 = 提醒，不自动重派）
 *
 * 职责：经 08② 的待回执登记表（pending-receipt-registry.listPendingReceipts）扫
 * `matchedAt === undefined && now - registeredAt > 阈值` 的派活 → 走 ⑩ 主动播报出口
 * （logProactiveBroadcast，action='receipt_timeout'）+ 结构化日志（source='receipt-timeout'）。
 *
 * 宿主为 cron-service 第 5 job（每 5 分钟）而非 watchdog——层级已核：watchdog 看进程健康，
 * 看不见 ws 层内存登记表（登记在 websocket/handlers 进程内，跨进程不可达，见任务02 限制）。
 *
 * 口径（任务17 开工登记 2026-10-04）：
 *   - v1 只提醒，不自动重派（重派阈值/策略待 ⑭ 任务卡状态机观测 → ⑮ 标定后回写 §8.2）；
 *   - 阈值 TC_JARVIS_RECEIPT_TIMEOUT_MIN（缺省 30 分钟；负数/NaN/Infinity 兜底 30 + 警告）；
 *   - 开关 TC_JARVIS_RECEIPT_TIMEOUT（缺省开；关 = 零扫描零调用）；
 *   - 同一回执（targetAgentId + registeredAt）幂等单次提醒（服务内记账；失败不算已提醒，可重试）；
 *   - 失败隔离：本体永不上抛（调度层安全）；单条播报异常不阻断其余条目。
 *
 * 边界：只读登记表（不增删改条目——16 面文件零改动）；不接委派通道、不进 ⑫ 配额。
 */

import { logEvent } from '../data/system-log.js';
import { createLogger } from '../utils/logger.js';
import {
  listPendingReceipts,
  type PendingReceipt,
} from '../websocket/handlers/pending-receipt-registry.js';
import { logProactiveBroadcast } from './voice-companion-service.js';

const log = createLogger('ReceiptTimeout');

// ─── 常量 ───

/** ⑩ 播报动作标识（写进主动播报的 action 字段，便于 ⑭ 观测筛选）。 */
export const RECEIPT_TIMEOUT_ACTION = 'receipt_timeout';
/** 🟡 埋点来源标识（category='system' + source + body.cat='receipt-timeout'；不改任何枚举）。 */
export const RECEIPT_TIMEOUT_LOG_SOURCE = 'receipt-timeout';
/** 阈值缺省值（分钟；初始值待 ⑭/⑮ 标定）。 */
export const DEFAULT_RECEIPT_TIMEOUT_MIN = 30;
/** 阈值 env 名。 */
export const RECEIPT_TIMEOUT_MIN_ENV = 'TC_JARVIS_RECEIPT_TIMEOUT_MIN';
/** 开关 env 名。 */
export const RECEIPT_TIMEOUT_ENV = 'TC_JARVIS_RECEIPT_TIMEOUT';

const MINUTE_MS = 60_000;

// ─── 开关与阈值（最小形态，同 ⑨ 晨报/日报款；测试用 vi.stubEnv 注入） ───

/** 开关：TC_JARVIS_RECEIPT_TIMEOUT，缺省开；'0' / 'off' / 'false'（忽略大小写空白）关。 */
export function isReceiptTimeoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RECEIPT_TIMEOUT_ENV]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

export interface ReceiptTimeoutConfig {
  /** 生效阈值（毫秒）。 */
  ms: number;
  /** 是否走了非法值兜底（true 时调用方记警告）。 */
  fallback: boolean;
  /** 原始 env 值（仅诊断用）。 */
  raw?: string;
}

/**
 * 阈值解析：TC_JARVIS_RECEIPT_TIMEOUT_MIN 分钟数。
 * 缺省 30；负数 / NaN / Infinity（含任意非数值串）兜底 30 并标 fallback。
 */
export function resolveReceiptTimeoutMs(env: NodeJS.ProcessEnv = process.env): ReceiptTimeoutConfig {
  const raw = env[RECEIPT_TIMEOUT_MIN_ENV]?.trim();
  if (!raw) return { ms: DEFAULT_RECEIPT_TIMEOUT_MIN * MINUTE_MS, fallback: false };
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { ms: DEFAULT_RECEIPT_TIMEOUT_MIN * MINUTE_MS, fallback: true, raw };
  }
  return { ms: minutes * MINUTE_MS, fallback: false, raw };
}

// ─── 幂等账本（服务内；失败不记账 → 下次可重试） ───

/** 已提醒键集合（targetAgentId + registeredAt；注册表条目替换/TTL 过期即裁剪，账本有界）。 */
const remindedReceipts = new Set<string>();

function receiptKey(receipt: PendingReceipt): string {
  return `${receipt.targetAgentId}:${receipt.registeredAt}`;
}

/** 只保留当前登记表中仍存在的键（上限 = 注册表容量 100）。 */
function pruneReminded(set: Set<string>, receipts: readonly PendingReceipt[]): void {
  const live = new Set(receipts.map(receiptKey));
  for (const key of set) {
    if (!live.has(key)) set.delete(key);
  }
}

/** 测试专用：清空进程内幂等账本。 */
export function resetReceiptTimeoutStateForTests(): void {
  remindedReceipts.clear();
}

// ─── 🟡 埋点（不改任何枚举/不改他人文件） ───

interface ReceiptTimeoutLogFields {
  op: 'scan' | 'remind';
  ok: boolean;
  at: number;
  reason?: 'disabled';
  scanned?: number;
  unmatched?: number;
  timedOut?: number;
  reminded?: number;
  duplicates?: number;
  timeoutMs?: number;
  agentId?: string;
  bossId?: string;
  ageMs?: number;
  error?: string;
}

/** 事件登记（append-only；logEvent 自身静默降级，绝不影响主链路）。 */
function logReceiptTimeout(fields: ReceiptTimeoutLogFields): void {
  try {
    logEvent('system', {
      source: RECEIPT_TIMEOUT_LOG_SOURCE,
      level: fields.ok ? undefined : 'warn',
      body: {
        cat: 'receipt-timeout',
        op: fields.op,
        ok: fields.ok,
        at: fields.at,
        reason: fields.reason,
        scanned: fields.scanned,
        unmatched: fields.unmatched,
        timedOut: fields.timedOut,
        reminded: fields.reminded,
        duplicates: fields.duplicates,
        timeoutMs: fields.timeoutMs,
        agentId: fields.agentId,
        bossId: fields.bossId,
        ageMs: fields.ageMs,
        error: fields.error,
      },
    });
  } catch {
    // 失败隔离：观测写入绝不打断扫描
  }
}

// ─── 提醒文本 ───

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 提醒文本（中文；taskSummary 登记时已截断 ≤80 字）。 */
function remindText(receipt: PendingReceipt, ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / MINUTE_MS));
  return `委派提醒：${receipt.targetAgentId} 的任务「${receipt.taskSummary}」已 ${minutes} 分钟未见回执，请跟进。`;
}

// ─── 扫描主流程 ───

export interface ReceiptTimeoutScanDeps {
  /** 待回执枚举（测试注入；缺省 listPendingReceipts 模块单例）。 */
  listReceipts?: (at?: number) => PendingReceipt[];
  /** 时刻注入（测试用；缺省进程时钟）。 */
  now?: () => Date;
  /** 播报出口（测试注入；缺省 logProactiveBroadcast——⑩ 通道）。 */
  broadcast?: (input: { text: string; action: string }) => void;
  /** 阈值覆盖（测试用；缺省 env 解析）。 */
  timeoutMs?: number;
  /** 幂等账本覆盖（测试用；缺省进程内单例）。 */
  reminded?: Set<string>;
}

export interface ReceiptTimeoutScanResult {
  /** 开关关闭 → 零扫描零调用。 */
  disabled?: boolean;
  /** 枚举到的回执总数（含已匹配）。 */
  scanned: number;
  /** 未匹配（matchedAt===undefined）数。 */
  unmatched: number;
  /** 超阈值的未匹配回执数。 */
  timedOut: number;
  /** 本次新提醒数。 */
  reminded: number;
  /** 幂等跳过数（此前已提醒过）。 */
  duplicates: number;
  /** 扫描段异常降级。 */
  degraded: boolean;
  /** 本次生效阈值（毫秒）。 */
  timeoutMs: number;
}

const EMPTY_RESULT: Omit<ReceiptTimeoutScanResult, 'timeoutMs'> = {
  scanned: 0,
  unmatched: 0,
  timedOut: 0,
  reminded: 0,
  duplicates: 0,
  degraded: false,
};

/**
 * 扫一次回执超时（cron 每 5 分钟触发）。任何异常都不上抛（调度层安全）。
 */
export async function runReceiptTimeoutScan(
  deps: ReceiptTimeoutScanDeps = {},
): Promise<ReceiptTimeoutScanResult> {
  let timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MIN * MINUTE_MS;
  try {
    return scan(deps, (ms) => { timeoutMs = ms; });
  } catch (err) {
    // 兜底：扫描段任何意外异常（含注入实现抛错）→ 记 warn + degraded，绝不上抛。
    log.warn(`回执超时扫描异常降级：${errMessage(err)}`);
    logReceiptTimeout({ op: 'scan', ok: false, at: Date.now(), timeoutMs, error: errMessage(err) });
    return { ...EMPTY_RESULT, degraded: true, timeoutMs };
  }
}

function scan(
  deps: ReceiptTimeoutScanDeps,
  reportTimeoutMs: (ms: number) => void,
): ReceiptTimeoutScanResult {
  const at = (deps.now ?? (() => new Date()))().getTime();
  const config = deps.timeoutMs !== undefined
    ? { ms: deps.timeoutMs, fallback: false }
    : resolveReceiptTimeoutMs();
  reportTimeoutMs(config.ms);

  // 开关在入口读：关 = 不枚举登记表、不播报（零扫描零调用）。
  if (!isReceiptTimeoutEnabled()) {
    logReceiptTimeout({ op: 'scan', ok: true, at, reason: 'disabled', timeoutMs: config.ms });
    return { ...EMPTY_RESULT, disabled: true, timeoutMs: config.ms };
  }
  if (config.fallback) {
    log.warn(
      `${RECEIPT_TIMEOUT_MIN_ENV} 非法（${config.raw}），回退 ${DEFAULT_RECEIPT_TIMEOUT_MIN} 分钟`,
    );
  }

  let receipts: PendingReceipt[];
  try {
    receipts = (deps.listReceipts ?? listPendingReceipts)(at);
  } catch (err) {
    log.warn(`待回执枚举失败，跳过本轮：${errMessage(err)}`);
    logReceiptTimeout({ op: 'scan', ok: false, at, timeoutMs: config.ms, error: errMessage(err) });
    return { ...EMPTY_RESULT, degraded: true, timeoutMs: config.ms };
  }

  const reminded = deps.reminded ?? remindedReceipts;
  const broadcast = deps.broadcast ?? logProactiveBroadcast;
  let unmatched = 0;
  let timedOut = 0;
  let remindedCount = 0;
  let duplicates = 0;

  for (const receipt of receipts) {
    // 已匹配（完成事件消费过）→ 不是超时，跳过（条目保留供第二入口去重是注册表职责）。
    if (receipt.matchedAt !== undefined) continue;
    unmatched += 1;
    const ageMs = at - receipt.registeredAt;
    if (ageMs <= config.ms) continue;
    timedOut += 1;

    const key = receiptKey(receipt);
    if (reminded.has(key)) {
      duplicates += 1;
      continue;
    }

    try {
      broadcast({ text: remindText(receipt, ageMs), action: RECEIPT_TIMEOUT_ACTION });
      // 播报成功才记账（失败不算已提醒，下轮可重试）。
      reminded.add(key);
      remindedCount += 1;
      logReceiptTimeout({
        op: 'remind',
        ok: true,
        at,
        agentId: receipt.targetAgentId,
        bossId: receipt.bossId,
        ageMs,
        timeoutMs: config.ms,
      });
    } catch (err) {
      // 单条播报异常不阻断其余条目（失败隔离）。
      logReceiptTimeout({
        op: 'remind',
        ok: false,
        at,
        agentId: receipt.targetAgentId,
        bossId: receipt.bossId,
        ageMs,
        timeoutMs: config.ms,
        error: errMessage(err),
      });
    }
  }

  pruneReminded(reminded, receipts);
  logReceiptTimeout({
    op: 'scan',
    ok: true,
    at,
    scanned: receipts.length,
    unmatched,
    timedOut,
    reminded: remindedCount,
    duplicates,
    timeoutMs: config.ms,
  });

  return { scanned: receipts.length, unmatched, timedOut, reminded: remindedCount, duplicates, degraded: false, timeoutMs: config.ms };
}
