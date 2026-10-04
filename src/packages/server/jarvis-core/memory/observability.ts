/**
 * jarvis-core · 记忆层 ⑭ 观测适配（任务 27 ⑦，任务 02 埋点通道）
 *
 * 注入式回调：记忆模块不 import activity-log/EventDB，只产出 MemoryOpEvent；
 * 生产侧由接线尾把真实 logEvent 传进来（`createSystemLogObserver(logEvent)`），
 * 本适配把事件映射为 `logEvent('system', { source:'memory', body:{cat:'memory',…} })`
 * ——与任务 02 `ACTIVITY_SOURCE.memory`（'memory'）同源，可按
 * `querySystemLog({ source:'memory' })` 筛选（⑮ 日志分析消费）。
 *
 * 参数用结构型（SystemLogEventFn），真实 system-log.logEvent 可直接赋值，
 * 测试/替身无需依赖具体模块。
 */

import type { MemoryObserver, MemoryOpEvent } from './types.js';

/** logEvent 的结构型镜像（category='system' 的调用形态）。 */
export type SystemLogEventFn = (
  category: 'system',
  fields: {
    source: string;
    sessionId?: string;
    level?: 'info' | 'warn';
    body: Record<string, unknown>;
  },
) => unknown;

export interface SystemLogObserverOptions {
  /** 观测渠道标签（body.channel）：voice / settings / reflection 等；缺省 'memory'。 */
  channel?: string;
}

/** MemoryOpEvent → ⑭ system/memory 行；适配器自身不抛（观测失败不影响主链路）。 */
export function createSystemLogObserver(logEvent: SystemLogEventFn, options: SystemLogObserverOptions = {}): MemoryObserver {
  const channel = options.channel ?? 'memory';
  return (event: MemoryOpEvent): void => {
    try {
      logEvent('system', {
        // 与 services/activity-log.ts 的 ACTIVITY_SOURCE.memory 一致（'memory'）
        source: 'memory',
        sessionId: event.sessionId,
        level: event.reason === 'error' ? 'warn' : 'info',
        body: {
          cat: 'memory',
          channel,
          op: event.op,
          applied: event.applied,
          layer: event.layer,
          source: event.source,
          entryId: event.entryId,
          droppedCount: event.droppedCount,
          activeTotal: event.totals?.active,
          markedTotal: event.totals?.marked,
          reason: event.reason,
          detail: event.detail,
          at: event.at,
        },
      });
    } catch {
      // 观测出口失败静默（与 system-log 的写失败静默降级同型）
    }
  };
}
