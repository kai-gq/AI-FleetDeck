/**
 * jarvis-core/reflection · 门槛校验（任务 28 ⑤.1）
 *
 * 防幻觉硬规则（06-11 §6.3/§11.3）：当天会话数 < 5 → 跳过反思（记 skipped 日志）。
 * 「5」为 Dream 硬规则，**保留不标定**——不随 ⑭→⑮ 调参。
 *
 * 纯函数：门槛判定与时间窗计算不访问任何 I/O；会话数由可注入数据源提供，
 * 数据源读取失败由引擎按 skipped（session-count-unavailable）如实处理。
 */

import {
  DEFAULT_MIN_SESSIONS_FOR_REFLECTION,
  type ReflectionGateOptions,
  type ReflectionGateResult,
} from './types.js';

/**
 * 判定当天起始时刻（本地时区 0 点；「当天」口径 = 自然日）。
 * 用本地时区而非 UTC：夜间反思在 02:00 本地时间触发，跨日界以用户日历为准。
 */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 门槛校验：会话数不足 → passed=false（引擎据此返回 skipped，不产生任何操作）。 */
export function checkReflectionGate(
  sessionCount: number,
  options: ReflectionGateOptions = {},
): ReflectionGateResult {
  const minSessions = options.minSessions ?? DEFAULT_MIN_SESSIONS_FOR_REFLECTION;
  const count = Number.isFinite(sessionCount) ? Math.max(0, Math.trunc(sessionCount)) : 0;
  if (count < minSessions) {
    return { passed: false, sessionCount: count, minSessions, reason: 'insufficient-sessions' };
  }
  return { passed: true, sessionCount: count, minSessions };
}
