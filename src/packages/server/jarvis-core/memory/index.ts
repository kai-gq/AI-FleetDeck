/**
 * jarvis-core · 记忆层模块出口（任务 27）
 *
 * 只导出本层（新目录自己的 index，不改 jarvis-core/index.ts 与任何既有 barrel）。
 * 接线尾从 `jarvis-core/memory/index.js` 导入 createMemoryStack 即可；
 * server/index.ts / voice-companion-service.ts 的挂点由主脑在热文件窗口执行。
 */

export {
  MEMORY_LAYERS,
  LAYER_DIRS,
  LONG_TERM_ALLOWED_SOURCES,
  DEFAULT_WORKING_TTL_MS,
  DEFAULT_WORKING_CAPACITY,
  DEFAULT_MAX_TEXT_LENGTH,
  InferredMemoryRejectedError,
  AppendOnlyViolationError,
  assertSourceAllowedForLayer,
} from './types.js';
export type {
  MemoryLayer,
  MemorySource,
  MemoryStatus,
  MemoryTriggerKind,
  MarkReason,
  MemoryEntry,
  MemoryAddInput,
  MemoryUpdatePatch,
  MemoryQuery,
  MemoryTotals,
  SweepOptions,
  SweepResult,
  MemoryOpEvent,
  MemoryObserver,
  MemoryStore,
  MemoryLifecycleStore,
} from './types.js';

export { FileMemoryStore, defaultMemoryBaseDir, serializeMemoryEntry, parseMemoryFile } from './file-store.js';
export type { FileMemoryStoreOptions, MemoryLoadError } from './file-store.js';

export { MemoryWriteEngine, DEFAULT_MAX_HITS_PER_CAPTURE } from './write-engine.js';
export type {
  CaptureResult,
  MemoryCaptureOptions,
  MemoryWriteEngineOptions,
  SessionSummaryInput,
  VoiceMemoryOpLike,
} from './write-engine.js';

export { TRIGGER_RULES, DEFAULT_PROPER_NOUN_LEXICON, scanTriggers, triggerKinds } from './trigger-rules.js';
export type { TriggerHit, TriggerRule, ScanTriggerOptions } from './trigger-rules.js';

export { createSystemLogObserver } from './observability.js';
export type { SystemLogEventFn, SystemLogObserverOptions } from './observability.js';

export { createMemoryStack } from './stack.js';
export type { MemoryStack, MemoryStackOptions } from './stack.js';
