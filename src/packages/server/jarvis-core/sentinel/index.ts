/**
 * jarvis-core/sentinel 模块出口（任务 33，W10 纯模块；接线 W11）
 *
 * 只导出本层（新目录自己的 index，**不改 jarvis-core/index.ts 与任何既有 barrel**）。
 * 接线尾按路径直导入：
 *   import { createSentinelPhaseState, evaluateSentinelPhase, collectDayMetricsSafely,
 *            buildSentinelDirective, detectSelfHeal, createSentinelLogObserver }
 *     from './jarvis-core/sentinel/index.js';
 *
 * W11 接线预点名（本波零接线，**不碰**）：
 * - `signal-queue.ts:180` setStats / proactiveReporter gatesConfig：喂当日指标 + 注入降级指令；
 * - vcs 出口：用户显式否定 → stats 计数（投诉口径）；
 * - cron 模板：每日一次 `collectDayMetricsSafely(port, day, …)` → `evaluateSentinelPhase(…)`
 *   （同一天重复触发由相位机同日幂等保护）；相位迁移/指令 → ⑭ `createSentinelLogObserver(logEvent)`。
 * 开关 `TC_JARVIS_SENTINEL`（缺省开；W11 接线时生效，本波模块内可注入配置）。
 *
 * 分工（冻结）：本模块只产跨天相位 + 降级指令（复用 09 四档语义「减频率 /
 * 只 STORE 不 SPEAK」），**不与 09·A 闸门内自适应叠加预算数值**。
 */

export {
  SENTINEL_ENV_KEY,
  SENTINEL_PHASES,
  DEFAULT_SENTINEL_THRESHOLDS,
  DEFAULT_SELF_HEAL_TUNING,
  BROADCAST_TIER_RANK,
  isSentinelEnabled,
  isSentinelPhase,
  resolveSentinelEnabled,
  resolveSentinelThresholds,
  resolveSelfHealTuning,
  resolveSentinelConfig,
  clampBroadcastTier,
} from './types.js';
export type {
  SentinelPhase,
  SentinelDayVerdict,
  SentinelThresholds,
  SentinelDayStats,
  SentinelMetricKey,
  SentinelMetrics,
  SentinelStatsDegradeReason,
  SentinelStatsDegrade,
  SentinelMetricsResult,
  SentinelDegradeAction,
  SentinelDirectiveEvidence,
  SentinelDegradeDirective,
  SentinelInteractionKind,
  SentinelInteractionEvent,
  SentinelSelfHealReason,
  SentinelSelfHealSuggestion,
  SelfHealTuning,
  SentinelConfig,
  ResolvedSentinelConfig,
  SentinelEventKind,
  SentinelEvent,
  SentinelEventSink,
  SentinelTransitionReason,
  SentinelSkipReason,
  SentinelPhaseState,
  SentinelPhaseTransition,
  SentinelPhaseEvaluation,
} from './types.js';

export {
  DAY_MS,
  startOfLocalDay,
  localDayKey,
  localDayDiff,
  emptyDayStats,
  normalizeDayStats,
  computeSentinelMetrics,
  computeDayVerdict,
  collectDayMetricsSafely,
  createStaticStatsProvider,
  createUnavailableStatsProvider,
} from './stats.js';
export type { SentinelStatsPort, CollectDayMetricsOptions, StaticStatsInput } from './stats.js';

export { createSentinelPhaseState, buildSentinelDirective, evaluateSentinelPhase } from './state-machine.js';
export type { SentinelDirectiveInput } from './state-machine.js';

export {
  normalizeRequestText,
  textSimilarity,
  detectRepeatedRequests,
  detectRepeatedMisjudges,
  detectSelfHeal,
} from './self-heal.js';

export {
  SENTINEL_SOURCE,
  SENTINEL_LOG_CAT,
  createSentinelLogObserver,
  phaseTransitionEvent,
  directiveEvent,
  selfHealEvent,
  statsDegradedEvent,
} from './observability.js';
export type { SentinelLogObserverOptions } from './observability.js';
