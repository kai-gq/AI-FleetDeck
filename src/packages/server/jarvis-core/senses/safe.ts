/**
 * jarvis-core · 感知层安全工具（任务 30）
 *
 * 各源共用的小工具：畸形数据判别、文本截断、单源超时、同因只记一次日志。
 * 纯函数/无状态，不 import 除类型外的任何现有实现。零新依赖。
 */

import type { JarvisLogger } from '../executors.js';

/** 单源采集默认超时（初始值非实测；待 ⑭ 观测 / ⑮ 标定）。 */
export const DEFAULT_SENSE_TIMEOUT_MS = 5_000;

/** 超时错误标记（聚合层据此把降级原因区分为 timeout，而非 port_error）。 */
export class SenseTimeoutError extends Error {
  readonly code = 'sense-timeout';
  constructor(
    readonly sourceName: string,
    readonly timeoutMs: number,
  ) {
    super(`信号源 ${sourceName} 采集超时（>${timeoutMs}ms）`);
    this.name = 'SenseTimeoutError';
  }
}

/**
 * 单源超时包装：超时报 SenseTimeoutError（由聚合层隔离）；端口正常抛错原样透传。
 * timeoutMs 非法（≤0/NaN）时退化为直通（测试可用 0 关闭超时）。
 * 定时器 unref，不把进程钉住。
 */
export function withTimeout<T>(task: Promise<T>, timeoutMs: number, sourceName: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SenseTimeoutError(sourceName, timeoutMs)), timeoutMs);
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 是否为普通对象（非 null / 非数组）——畸形数据判别用。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 有限数值提取；非法返回 undefined（不抛）。 */
export function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 非空字符串提取（trim 后）；非法返回 undefined。 */
export function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 单行截断（空白压缩 + 省略号），与 client proactiveReporter.truncate 同形。 */
export function truncateText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 本地日期键（YYYY-M-D，本地时区；跨日去重/每日一次信号用）。 */
export function localDayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 本地分钟数（0–1439，本地时区；时段划分用）。 */
export function localMinutesOfDay(now: number): number {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 日志门面防护：任一方法抛错都被吞掉（观测出口失败不能破坏「采集/聚合永不上抛」契约）。
 */
export function guardLogger(logger: JarvisLogger): JarvisLogger {
  const wrap =
    (level: keyof JarvisLogger) =>
    (message: string, ...args: unknown[]): void => {
      try {
        logger[level](message, ...args);
      } catch {
        // 观测出口抛错不能影响主链路
      }
    };
  return { log: wrap('log'), debug: wrap('debug'), warn: wrap('warn'), error: wrap('error') };
}

/**
 * 同因只记一次日志（避免心跳周期反复刷同一降级原因）。
 * 返回的 log 永不抛出（logger 自身异常也吞掉——观测失败不影响采集契约）。
 */
export function createOnceLogger(logger: JarvisLogger | undefined): (level: 'debug' | 'warn' | 'error', key: string, message: string, ...args: unknown[]) => void {
  const seen = new Set<string>();
  return (level, key, message, ...args) => {
    if (!logger || seen.has(key)) return;
    seen.add(key);
    try {
      logger[level](message, ...args);
    } catch {
      // 日志出口抛错不能破坏「采集永不上抛」契约
    }
  };
}
