/**
 * jarvis-core/sentinel · ⑭ 观测适配（任务 33 ⑦：熔断状态变更 / 忽略率 → ⑭ → ⑮）
 *
 * 与任务 27 memory/observability.ts、任务 28 reflection/observability.ts、
 * 任务 14 projects/observability.ts 同款注入式适配：sentinel 模块不 import
 * activity-log/EventDB，只产出 SentinelEvent（types.ts，纯数据）；生产侧由接线层
 * 把真实 logEvent 传进来（`createSentinelLogObserver(logEvent)`），映射为
 *   logEvent('system', { source:'sentinel', body:{ cat:'sentinel', … } })
 * ——⑮ 可按 `querySystemLog({ source:'sentinel' })` 筛选；body 里相位迁移
 * （fromPhase/toPhase/transitionReason/verdict）、降级指令（directive.maxTier /
 * speechFactor）与自愈建议（suggestion.count）供「熔断阈值 / 恢复天数标定」
 * （06-12 §8.2 回写依据）。
 *
 * 说明：services/activity-log.ts（任务 02）的 ACTIVITY_SOURCE 常量表无本项；
 * 本适配 **不改该文件**（主脑登记），先以 source='sentinel'（本模块自有的 source
 * 字符串）纯加法落盘。适配器自身不抛（观测失败不影响主链路）。
 *
 * 事件构造器（phaseTransitionEvent / directiveEvent / selfHealEvent /
 * statsDegradedEvent）是纯函数：接线层拿到评估结果后按需构造 + 送 sink；
 * 本模块（相位机/检测）不持有 sink、不产生副作用（纯模块纪律）。
 */

import type { SystemLogEventFn } from '../memory/observability.js';
import type {
  SentinelDegradeDirective,
  SentinelEvent,
  SentinelEventSink,
  SentinelPhaseTransition,
  SentinelSelfHealSuggestion,
  SentinelStatsDegrade,
} from './types.js';

/** ⑭ 观测 source（自发 source 字符串；不改 activity-log 常量表）。 */
export const SENTINEL_SOURCE = 'sentinel';

/** body.cat 常量（与 source 同值，便于 ⑮ 过滤）。 */
export const SENTINEL_LOG_CAT = 'sentinel';

export interface SentinelLogObserverOptions {
  /** 观测渠道标签（body.channel）；缺省 'sentinel'。 */
  channel?: string;
}

/** SentinelEvent → ⑭ system/sentinel 行；适配器自身不抛（观测失败不影响主链路）。 */
export function createSentinelLogObserver(
  logEvent: SystemLogEventFn,
  options: SentinelLogObserverOptions = {},
): SentinelEventSink {
  const channel = options.channel ?? SENTINEL_LOG_CAT;
  return (event: SentinelEvent): void => {
    try {
      logEvent('system', {
        source: SENTINEL_SOURCE,
        level: event.level,
        body: {
          cat: SENTINEL_LOG_CAT,
          channel,
          kind: event.kind,
          at: event.at,
          day: event.day,
          phase: event.phase,
          fromPhase: event.fromPhase,
          toPhase: event.toPhase,
          transitionReason: event.transitionReason,
          verdict: event.verdict,
          directive: event.directive,
          suggestion: event.suggestion,
          degradeReason: event.degradeReason,
          detail: event.detail,
          ...(event.extra ?? {}),
        },
      });
    } catch {
      // 观测出口失败静默（与 memory/reflection/projects observability 同型）
    }
  };
}

// ============================================================================
// 事件构造器（纯函数；供接线层把评估结果转成 ⑭ 事件）
// ============================================================================

/** 相位迁移 → 事件（进入 degraded 记 warn，其余 info）。 */
export function phaseTransitionEvent(transition: SentinelPhaseTransition): SentinelEvent {
  return {
    kind: 'sentinel.phase.transition',
    level: transition.to === 'degraded' ? 'warn' : 'info',
    at: transition.at,
    day: transition.day,
    phase: transition.to,
    fromPhase: transition.from,
    toPhase: transition.to,
    transitionReason: transition.reason,
    verdict: transition.verdict,
  };
}

/** 降级指令 → 事件（store-only 记 warn；normal 无指令不产事件）。 */
export function directiveEvent(directive: SentinelDegradeDirective): SentinelEvent {
  return {
    kind: 'sentinel.directive',
    level: directive.action === 'store-only' ? 'warn' : 'info',
    at: directive.at,
    day: directive.day,
    phase: directive.phase,
    verdict: directive.verdict,
    directive,
  };
}

/** 自愈建议 → 事件（降级道歉建议恒 warn——这是负反馈的最强信号之一）。 */
export function selfHealEvent(suggestion: SentinelSelfHealSuggestion): SentinelEvent {
  return {
    kind: 'sentinel.self-heal.suggested',
    level: 'warn',
    at: suggestion.at,
    suggestion,
    extra: {
      selfHealReason: suggestion.reason,
      selfHealCount: suggestion.count,
      selfHealKey: suggestion.key,
    },
  };
}

/** 统计端口降级 → 事件（缺源如实上报，供 ⑮ 判断是否可标定）。 */
export function statsDegradedEvent(degrade: SentinelStatsDegrade, at: number, day?: string): SentinelEvent {
  return {
    kind: 'sentinel.stats.degraded',
    level: 'warn',
    at,
    day,
    degradeReason: degrade.reason,
    detail: degrade.detail,
    extra: { error: degrade.error instanceof Error ? degrade.error.message : degrade.error },
  };
}
