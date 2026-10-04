/**
 * jarvis-core 模块出口（任务 26）。
 *
 * 只导出本模块（新目录自己的 index，不改任何现有 index/barrel）。
 * server/index.ts 的启动接线由主脑在波次屏障统一执行（最后一厘米，不在本任务）。
 */

export {
  Heartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_INTERVAL_MS,
  MIN_HEARTBEAT_INTERVAL_MS,
  normalizeHeartbeatIntervalMs,
} from './heartbeat.js';
export type {
  HeartbeatCycleContext,
  HeartbeatCycleSummary,
  HeartbeatHooks,
  HeartbeatOptions,
  HeartbeatPhaseError,
  HeartbeatPhaseName,
  HeartbeatPhases,
  HeartbeatStats,
  HeartbeatTrigger,
} from './heartbeat.js';

export {
  SignalQueue,
  DEFAULT_MAX_SEEN_KEYS,
  DEFAULT_SEEN_KEY_TTL_MS,
  SEEN_TRIM_OPS_INTERVAL,
  SIGNAL_SOURCES,
  isSignalSource,
  normalizeSignal,
} from './signal-queue.js';
export type { ConsumedSignal, RawSignal, SignalQueueOptions } from './signal-queue.js';

export {
  IdempotentExecutor,
  createMutex,
  collectSignalsSafely,
  deliverDecision,
  decideSafely,
  conservativeDecide,
  validateGatesConfig,
  retryWithBackoff,
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  DEFAULT_MAX_REMEMBERED_KEYS,
  jarvisLogger,
} from './executors.js';
export type {
  ExecutorStatus,
  ExecutionRequest,
  ExecutorResult,
  IdempotentExecutorOptions,
  JarvisLogger,
  JarvisEvent,
  JarvisEventSink,
  Mutex,
  RetryPolicy,
  RetryOptions,
  SignalSource,
  ObserveFailure,
  ObserveResult,
  DeliveryChannel,
  DeliveryDegradeReason,
  DeliveryPorts,
  DeliveryResult,
  DeliveryOptions,
  GuardedDecision,
} from './executors.js';
