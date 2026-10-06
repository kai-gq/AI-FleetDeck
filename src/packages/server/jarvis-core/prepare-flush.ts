/**
 * jarvis-core · PREPARE 攒批出口（任务 31 前置：flush 接通）
 *
 * 背景（2026-10-06 接线缺口登记）：09·A 的 PREPARE 档语义是「攒批，到下一个自然
 * 开口点再说（不打断当下）」。此前三处队列（jarvis-core 主脑 / 任务 13 Bolba 到期提醒 /
 * 任务 29 晨报）过闸后 PREPARE 条目落在各自 SignalQueue 的 prepared 缓冲里，
 * **没有任何消费者**——攒了永远不说。本模块提供统一的「开口点 flush 注册表」：
 *
 *   - 各队列持有方在接线层注册 `{ name, getQueue, speak }`（懒取队列，未初始化返回 null 即跳过）；
 *   - 自然开口点（用户正在场/刚说过话）由触发方调用 `flushPreparedAtOpeningPoint(reason)`：
 *     逐个注册项 `queue.flushPrepared()` 出队 → 交给该项自己的 `speak` 交付；
 *   - flushPrepared 契约（signal-queue）：只出队绝不再判定/复扣预算（预扣在 consume 时已完成）；
 *   - 交付口径由各队列自持（如 logProactiveBroadcast），多条目建议在 speak 内合并为一条；
 *   - 交付失败 = 该批条目丢弃（已出队，无回插 API），如实记 failures 供 ⑭ 观测——绝不假装送达。
 *
 * 触发点（接线层）：
 *   ① 语音路由用户回合（用户刚开口 = 最强开口点，回合应答完成后 fire-and-forget）；
 *   ② 心跳 act 相位（用户活跃窗口内 = 心搏兜底，覆盖「用户在场但没说话」）。
 *
 * 安全：本模块任何函数不上抛（注册表/队列/交付逐项 try-catch 隔离），
 * flush 失败绝不阻塞语音或心跳主链路。
 */

import { jarvisLogger, type JarvisLogger } from './executors.js';
import type { ConsumedSignal, SignalQueue } from './signal-queue.js';

// ============================================================================
// 注册表
// ============================================================================

export interface PreparedFlushRegistration {
  /** 注册名（日志/观测/测试用；同名重复注册 = 覆盖，便于接线幂等 re-init）。 */
  name: string;
  /** 懒取队列；返回 null = 该队列尚未初始化（如服务未扫描过），跳过不报错。 */
  getQueue: () => SignalQueue | null;
  /** 批量交付（条目已出队）。多条目建议在此合并为一条播报。失败即整批丢弃并记 failures。 */
  speak: (entries: readonly ConsumedSignal[]) => void | Promise<void>;
}

const registrations = new Map<string, PreparedFlushRegistration>();

/** 注册一个待 flush 的 PREPARE 队列（同名覆盖）。 */
export function registerPreparedQueue(registration: PreparedFlushRegistration): void {
  registrations.set(registration.name, registration);
}

/** 注销（停机/测试）。 */
export function unregisterPreparedQueue(name: string): void {
  registrations.delete(name);
}

/** 当前注册名快照（观测/测试）。 */
export function listPreparedQueues(): string[] {
  return [...registrations.keys()];
}

/** 测试专用：清空注册表。 */
export function resetPreparedFlushForTests(): void {
  registrations.clear();
}

// ============================================================================
// flush
// ============================================================================

export interface PreparedFlushFailure {
  name: string;
  error: unknown;
}

export interface PreparedFlushReport {
  reason: string;
  at: number;
  /** 实际出队并成功交付的条数。 */
  delivered: number;
  /** 有出队条目的注册名。 */
  queues: string[];
  /** 取队列/交付失败的注册项（如实登记，绝不假装送达）。 */
  failures: PreparedFlushFailure[];
}

export interface PreparedFlushOptions {
  logger?: JarvisLogger;
  now?: () => number;
}

/**
 * 到自然开口点：把各注册队列的 PREPARE 攒批全部出队并交付。
 * 逐项隔离，任何子失败不影响其它队列；本函数永不上抛。
 */
export async function flushPreparedAtOpeningPoint(
  reason: string,
  options: PreparedFlushOptions = {},
): Promise<PreparedFlushReport> {
  const logger = options.logger ?? jarvisLogger;
  const now = options.now ?? Date.now;
  const report: PreparedFlushReport = { reason, at: now(), delivered: 0, queues: [], failures: [] };

  for (const registration of registrations.values()) {
    let entries: ConsumedSignal[];
    try {
      const queue = registration.getQueue();
      if (!queue) continue;
      entries = queue.flushPrepared();
    } catch (error) {
      report.failures.push({ name: registration.name, error });
      logger.warn(`PREPARE flush 取队列失败（${registration.name}，隔离）:`, error);
      continue;
    }
    if (entries.length === 0) continue;

    try {
      await registration.speak(entries);
      report.delivered += entries.length;
      report.queues.push(registration.name);
    } catch (error) {
      // 条目已出队：交付失败 = 该批丢弃（无回插 API），如实记录，不假装送达。
      report.failures.push({ name: registration.name, error });
      logger.error(`PREPARE flush 交付失败（${registration.name}，丢弃 ${entries.length} 条）:`, error);
    }
  }

  if (report.delivered > 0 || report.failures.length > 0) {
    logger.log(
      `PREPARE flush（${reason}）：交付 ${report.delivered} 条` +
        (report.queues.length > 0 ? ` [${report.queues.join(',')}]` : '') +
        (report.failures.length > 0 ? ` 失败 ${report.failures.length} 项` : ''),
    );
  } else {
    logger.debug(`PREPARE flush（${reason}）：无攒批条目`);
  }
  return report;
}
