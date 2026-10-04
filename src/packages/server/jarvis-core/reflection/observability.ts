/**
 * jarvis-core/reflection · ⑭ 观测适配（任务 28 ⑦，任务 02 埋点通道）
 *
 * 与任务 27 memory/observability.ts 同款注入式适配：反思模块不 import
 * activity-log/EventDB，只产出 ReflectionRunEvent；生产侧由主脑把真实
 * logEvent 传进来（`createReflectionLogObserver(logEvent)`），映射为
 *   logEvent('system', { source:'reflection', body:{ cat:'reflection', … } })
 * ——⑮ 可按 `querySystemLog({ source:'reflection' })` 筛选，用 body.tier2Rate
 * 消费 Tier2 拦截率。
 *
 * 说明：ACTIVITY_SOURCE 常量表（services/activity-log.ts，任务 02）暂无 reflection
 * 项；本轮不改该文件（主脑登记），先以 source='reflection' 纯加法落盘；
 * 后续如需并入常量表由主脑统一执行。
 *
 * 参数用结构型（SystemLogEventFn，复用任务 27 的类型），真实 logEvent 可直接赋值。
 */

import type { SystemLogEventFn } from '../memory/observability.js';
import type { ReflectionEventSink, ReflectionRunEvent } from './types.js';

export interface ReflectionLogObserverOptions {
  /** 观测渠道标签（body.channel）；缺省 'reflection'。 */
  channel?: string;
}

/** ReflectionRunEvent → ⑭ system/reflection 行；适配器自身不抛（观测失败不影响主链路）。 */
export function createReflectionLogObserver(
  logEvent: SystemLogEventFn,
  options: ReflectionLogObserverOptions = {},
): ReflectionEventSink {
  const channel = options.channel ?? 'reflection';
  return (event: ReflectionRunEvent): void => {
    try {
      logEvent('system', {
        source: 'reflection',
        level: event.level,
        body: {
          cat: 'reflection',
          channel,
          kind: event.kind,
          runId: event.runId,
          at: event.at,
          sessionCount: event.sessionCount,
          firstRun: event.firstRun,
          skippedReason: event.skippedReason,
          failReason: event.failReason,
          ingest: event.ingest,
          operationCounts: event.operationCounts,
          rejectedCount: event.rejectedCount,
          tier1Applied: event.tier1Applied,
          tier2Intercepted: event.tier2Intercepted,
          tier2Rate: event.tier2Rate,
          morningDraftWritten: event.morningDraftWritten,
          errors: event.errors,
        },
      });
    } catch {
      // 观测出口失败静默（与 memory/observability、system-log 写失败静默降级同型）
    }
  };
}
