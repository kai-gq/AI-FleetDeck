/**
 * jarvis-core/reflection 模块出口（任务 28）
 *
 * 只导出本层（新目录自己的 index，**不改 jarvis-core/index.ts 与任何既有 barrel**）。
 * 接线尾按路径直导入：
 *   import { runNightlyReflection, Tier2ReviewQueue, createReflectionLogObserver }
 *     from './jarvis-core/reflection/index.js';
 * cron 02:00 注册由主脑在波次屏障统一接线（本任务只提供 runNightlyReflection(deps)）。
 */

export {
  DEFAULT_MIN_SESSIONS_FOR_REFLECTION,
  DEFAULT_DELETE_UNUSED_DAYS,
  DEFAULT_PROMOTE_USE_COUNT,
  CONFIDENCE_TAG_PREFIX,
  REFLECTION_OPERATION_KINDS,
  countIngest,
} from './types.js';
export type {
  KnowledgeConfidence,
  ReflectionOperationKind,
  ReflectionTier,
  ReflectionRunStatus,
  ReflectionSkipReason,
  ReflectionFailReason,
  ReflectionGateOptions,
  ReflectionGateResult,
  IngestedSessionSummary,
  IngestSourceName,
  IngestSourceError,
  ReflectionIngestBundle,
  ReflectionIngestCounts,
  ReflectionDataSource,
  ReflectionPrompt,
  ReflectionLlmPort,
  ReflectionNewProposal,
  ReflectionUpdateProposal,
  ReflectionDeleteProposal,
  ReflectionPromoteProposal,
  ReflectionProposalBundle,
  PlannedOperation,
  RejectedOperation,
  ReflectionPlan,
  ReflectionPlanOptions,
  AppliedOperationResult,
  ApplyReflectionOptions,
  ReviewStatus,
  Tier2ReviewItem,
  ReflectionRunResult,
  ReflectionRunEvent,
  ReflectionEventSink,
} from './types.js';

export { checkReflectionGate, startOfLocalDay } from './gate.js';

export {
  createMemoryReflectionDataSource,
  createStaticReflectionDataSource,
  countSessionsFromEntries,
} from './ingest.js';
export type { MemoryReflectionDataSourceOptions, StaticIngestInput } from './ingest.js';

export {
  planReflection,
  applyReflectionOperations,
  countOperationKinds,
  isDecisionText,
  isHighConfidenceEntry,
  findContradictions,
  confidenceTag,
  normalizeText,
} from './operations.js';

export {
  buildReflectionPrompt,
  parseReflectionProposals,
  createUnavailableReflectionLlm,
  createStaticReflectionLlm,
  ReflectionLlmUnavailableError,
  ReflectionProposalParseError,
  DEFAULT_PROMPT_MAX_ENTRIES,
  DEFAULT_PROMPT_MAX_TEXT_CHARS,
} from './llm.js';
export type { ReflectionPromptOptions } from './llm.js';

export { defaultReflectionBaseDir, defaultReviewQueuePath, defaultRunStatePath } from './paths.js';

export { Tier2ReviewQueue } from './review-queue.js';
export type { Tier2ReviewQueueOptions } from './review-queue.js';

export { FileReflectionRunState } from './run-state.js';
export type { ReflectionRunState, FileReflectionRunStateOptions } from './run-state.js';

export { createReflectionLogObserver } from './observability.js';
export type { ReflectionLogObserverOptions } from './observability.js';

export { runNightlyReflection } from './engine.js';
export type { ReflectionDeps } from './engine.js';
