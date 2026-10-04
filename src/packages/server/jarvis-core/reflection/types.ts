/**
 * jarvis-core · 夜间反思类型与契约（任务 28，06-11 §6.3 / §13.3 / §12.1 P2）
 *
 * 本目录是反思循环的独立新模块：门槛校验 → INGEST → LLM 端口 → 四操作
 * （NEW/UPDATE/DELETE/PROMOTE）+ Tier 划分（纯函数）→ Tier1 自动应用 /
 * Tier2 进人工审查队列。**不改 jarvis-core/index.ts barrel，按路径直导入。**
 *
 * 治理闸门（抄 Dream 双层门，06-11 §6.3）：
 *   · Tier1 自动应用：新增低置信知识、PROMOTE（use_count>10）、DELETE
 *     （30 天 0 使用）、元数据整理；
 *   · Tier2 人工审查：决定类条目、删除高置信条目、新旧知识矛盾、**首次运行**；
 *   · 防幻觉硬规则：当天会话数 < 5 不跑反思（保留不标定，Dream 硬规则）。
 *
 * 边界：只读导入任务 27 记忆层（MemoryStore / MemoryEntry 等类型），不修改其
 * 任何文件；调度注册（cron 02:00）由主脑统一接线，本模块只导出
 * runNightlyReflection(deps) 供注册。
 */

import type { JarvisLogger } from '../executors.js';
import type {
  MemoryEntry,
  MemoryLayer,
  MemorySource,
  MemoryUpdatePatch,
} from '../memory/types.js';

// ============================================================================
// 基础枚举 / 常量
// ============================================================================

/** 知识置信度（记忆层无此字段：低置信落到 tags `confidence:<level>`，供回溯与筛选）。 */
export type KnowledgeConfidence = 'low' | 'medium' | 'high';

/** 置信度标签前缀（新增低置信知识自动应用时写入）。 */
export const CONFIDENCE_TAG_PREFIX = 'confidence:';

/** 四操作（06-11 §6.3）。 */
export type ReflectionOperationKind = 'NEW' | 'UPDATE' | 'DELETE' | 'PROMOTE';

/** 四操作的固定遍历顺序（计划/黄金序列的确定性来源）。 */
export const REFLECTION_OPERATION_KINDS: readonly ReflectionOperationKind[] = ['NEW', 'UPDATE', 'DELETE', 'PROMOTE'];

/** 治理双层门（Tier1 自动 / Tier2 人工）。 */
export type ReflectionTier = 1 | 2;

/** 单次反思运行的状态。 */
export type ReflectionRunStatus = 'completed' | 'skipped' | 'failed';

/** 跳过原因（防幻觉门槛类；事件 body 的 skippedReason）。 */
export type ReflectionSkipReason = 'insufficient-sessions' | 'session-count-unavailable';

/** 失败原因（通道/解析类；失败时不产生、不应用任何操作）。 */
export type ReflectionFailReason =
  | 'llm-port-unavailable'
  | 'llm-call-failed'
  | 'proposal-parse-failed'
  | 'ingest-failed'
  | 'internal-error';

/**
 * 防幻觉硬规则：少于 5 次会话不跑反思（06-11 §6.3/§11.3，Dream 硬规则）。
 * 保留不标定——不随 ⑭→⑮ 调参，未经主脑决策不得下调。
 */
export const DEFAULT_MIN_SESSIONS_FOR_REFLECTION = 5;

/**
 * DELETE 判定：30 天未被引用且 use_count=0（06-11 §6.3 建议值，**非实测**，
 * 待 ⑭→⑮ 标定后回写 06-12 §8.2）。
 */
export const DEFAULT_DELETE_UNUSED_DAYS = 30;

/**
 * PROMOTE 判定：use_count>10（06-11 §6.3 建议值，**非实测**，同上）。
 */
export const DEFAULT_PROMOTE_USE_COUNT = 10;

// ============================================================================
// ① 门槛校验
// ============================================================================

export interface ReflectionGateOptions {
  /** 会话数下限；缺省 DEFAULT_MIN_SESSIONS_FOR_REFLECTION（5，保留不标定）。 */
  minSessions?: number;
}

export interface ReflectionGateResult {
  /** true = 放行；false = 跳过（当前仅 insufficient-sessions）。 */
  passed: boolean;
  sessionCount: number;
  minSessions: number;
  reason?: 'insufficient-sessions';
}

// ============================================================================
// ② INGEST
// ============================================================================

/** 当天一条会话摘要（源自记忆层 kind='session-summary' 的工作记忆条目）。 */
export interface IngestedSessionSummary {
  sessionId?: string;
  summary: string;
  at: number;
}

/** INGEST 数据源名（降级登记粒度：哪个源读失败）。 */
export type IngestSourceName = 'session-count' | 'sessions' | 'working' | 'marked' | 'growth-log' | 'long-term';

/**
 * 单个数据源的读取失败登记（§11.4：只记日志不吞循环；**不吞、不假**——
 * 失败源对应的数据保持缺失并如实登记，绝不填充伪造数据）。
 */
export interface IngestSourceError {
  source: IngestSourceName;
  message: string;
}

/** INGEST 结果包：四路数据 + 降级登记。 */
export interface ReflectionIngestBundle {
  now: number;
  /** 数据窗口起点（当天 0 点，本地时区）。 */
  since: number;
  sessions: IngestedSessionSummary[];
  /** 当天工作记忆（含 pending-reflection 标记条目）。 */
  workingEntries: MemoryEntry[];
  /** 明确记号待反思的条目（sweep 标记；可能非当天）。 */
  markedEntries: MemoryEntry[];
  /** 成长日志新增（当天）。 */
  growthLogEntries: MemoryEntry[];
  /** 当前长期知识（active）。 */
  longTermEntries: MemoryEntry[];
  errors: IngestSourceError[];
}

/** INGEST 计数（观测/事件用；sourceErrors 单独计数，不掩盖缺失）。 */
export interface ReflectionIngestCounts {
  sessions: number;
  working: number;
  marked: number;
  growthLog: number;
  longTerm: number;
  sourceErrors: number;
}

/** INGEST 收集统计（纯函数，不访问数据源）。 */
export function countIngest(bundle: ReflectionIngestBundle): ReflectionIngestCounts {
  return {
    sessions: bundle.sessions.length,
    working: bundle.workingEntries.length,
    marked: bundle.markedEntries.length,
    growthLog: bundle.growthLogEntries.length,
    longTerm: bundle.longTermEntries.length,
    sourceErrors: bundle.errors.length,
  };
}

/**
 * 反思数据源（可注入；生产缺省实现包任务 27 MemoryLifecycleStore，测试注入 fixture）。
 * 所有方法只读；失败降级由实现登记进 bundle.errors（collect 侧逐源隔离）。
 */
export interface ReflectionDataSource {
  /** 当天会话数（门槛校验用；应为轻量查询）。失败时抛错 → 引擎按 skipped 处理。 */
  countSessionsToday(at: number): Promise<number>;
  /** INGEST：读当天工作记忆 + 会话摘要 + 成长日志新增 + 当前长期知识。 */
  ingest(input: { now: number; since: number }): Promise<ReflectionIngestBundle>;
}

// ============================================================================
// ③ LLM 端口与提案
// ============================================================================

/** 反思 prompt（system + user；由 buildReflectionPrompt 确定性构造）。 */
export interface ReflectionPrompt {
  system: string;
  user: string;
}

/**
 * 反思 LLM 端口（可注入）。生产真实通道（claude haiku / 契约通道）接线延后，
 * 由主脑在热文件窗口执行——本任务只留端口，不改任何现有文件。
 */
export type ReflectionLlmPort = (prompt: ReflectionPrompt) => Promise<string>;

/** LLM 提案：NEW（跨会话重复模式 → 新知识点）。 */
export interface ReflectionNewProposal {
  text: string;
  /** 缺省 'low'（反思产出保守缺省为低置信 → Tier1 自动应用）。 */
  confidence?: KnowledgeConfidence;
  /** 条目 kind；缺省 'reflection-pattern'。 */
  kind?: string;
  tags?: string[];
  /** 只允许 user-stated / agent-confirmed；inferred 会被拒（长期知识不收推断）。 */
  source?: MemorySource;
  evidenceSessionIds?: string[];
  /** LLM 显式指出的矛盾旧知识 id 列表（非空即 Tier2）。 */
  contradicts?: string[];
  note?: string;
}

/** LLM 提案：UPDATE（旧知识被新事实覆盖，保留 ID 记 diff）。 */
export interface ReflectionUpdateProposal {
  id: string;
  text?: string;
  kind?: string;
  tags?: string[];
  note?: string;
}

/** LLM 提案：DELETE（30 天未被引用且无价值）。 */
export interface ReflectionDeleteProposal {
  id: string;
  note?: string;
}

/** LLM 提案：PROMOTE（高价值知识提升优先级）。 */
export interface ReflectionPromoteProposal {
  id: string;
  /** 仅允许 'long-term'（缺省）；其余目标视为非法提案（拒绝登记）。 */
  target?: MemoryLayer;
  note?: string;
}

/** LLM 结构化提案包（严格 JSON 解析；morningDraft 为次日晨报草稿）。 */
export interface ReflectionProposalBundle {
  newEntries?: ReflectionNewProposal[];
  updates?: ReflectionUpdateProposal[];
  deletes?: ReflectionDeleteProposal[];
  promotes?: ReflectionPromoteProposal[];
  /** 次日晨报草稿（反思产物层，供任务 29）；写失败不阻断运行。 */
  morningDraft?: string;
}

// ============================================================================
// ④ 计划（纯函数输出）与应用
// ============================================================================

/** 一条已定级的操作计划（Tier 划分后的可执行载荷）。 */
export interface PlannedOperation {
  /** 确定性 id：`<kind小写>-<提案内序号>`（黄金对比的稳定锚点）。 */
  opId: string;
  kind: ReflectionOperationKind;
  tier: ReflectionTier;
  /** Tier 判定规则 id（如 new-low-confidence / decision-class / first-run）。 */
  tierReason: string;
  /** UPDATE/DELETE/PROMOTE 的目标条目 id。 */
  targetEntryId?: string;
  /** NEW 载荷。 */
  add?: {
    layer: MemoryLayer;
    source: MemorySource;
    kind: string;
    text: string;
    confidence: KnowledgeConfidence;
    tags: string[];
  };
  /** UPDATE 载荷（仅 text/kind/tags；text 与现存一致时已从 patch 移除）。 */
  patch?: MemoryUpdatePatch;
  /** PROMOTE 目标层。 */
  promoteTarget?: MemoryLayer;
  evidenceSessionIds?: string[];
  /** LLM 提案附注原样透传（供人工审查参考）。 */
  note?: string;
}

/** 被拒绝的提案（校验/适用性失败；如实登记，不产生操作）。 */
export interface RejectedOperation {
  kind: ReflectionOperationKind;
  /** 提案在同类数组中的序号。 */
  index: number;
  reason: string;
  targetEntryId?: string;
  text?: string;
}

/** 计划产物：操作序列 + 拒绝登记 + 分 Tier 计数。 */
export interface ReflectionPlan {
  operations: PlannedOperation[];
  rejected: RejectedOperation[];
  tier1Count: number;
  tier2Count: number;
  /** Tier2 拦截率 = tier2Count / operations.length（无操作时为 0；供 ⑮）。 */
  tier2Rate: number;
}

/** 计划选项（阈值可注入；缺省为 06-11 建议值，非实测）。 */
export interface ReflectionPlanOptions {
  /** 判定时刻（epoch ms；缺省由调用方必传，保证确定性）。 */
  now: number;
  /** 首次运行强制 Tier2（未审不下发/不应用）。 */
  firstRun?: boolean;
  /** DELETE 判定天数；缺省 DEFAULT_DELETE_UNUSED_DAYS（30，建议值非实测）。 */
  deleteUnusedDays?: number;
  /** PROMOTE 判定 use_count 下限（严格大于）；缺省 10，建议值非实测。 */
  promoteUseCount?: number;
}

/** 单条操作的应用结果（失败不抛：逐条捕获如实登记）。 */
export interface AppliedOperationResult {
  opId: string;
  kind: ReflectionOperationKind;
  tier: ReflectionTier;
  applied: boolean;
  entryId?: string;
  /** applied=false 的原因（not-found / 存储拒绝 / error）。 */
  reason?: string;
  error?: string;
}

/** 应用选择器：tiers 或 opIds 二选一（缺省执行传入的全部操作）。 */
export interface ApplyReflectionOptions {
  tiers?: readonly ReflectionTier[];
  opIds?: readonly string[];
  logger?: JarvisLogger;
}

// ============================================================================
// ⑤ Tier2 人工审查队列
// ============================================================================

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** 一条待审/已审记录（数据级；UI 由主脑登记延后，本轮不做）。 */
export interface Tier2ReviewItem {
  /** 确定性 id：`<runId>:<opId>`。 */
  id: string;
  runId: string;
  createdAt: number;
  status: ReviewStatus;
  /** Tier2 判定规则 id。 */
  tierReason: string;
  operation: PlannedOperation;
  decidedAt?: number;
  /** 审批时是否已应用（approveReview 带 store 时写入）。 */
  applied?: boolean;
  applyError?: string;
}

// ============================================================================
// ⑥ 运行结果与观测事件
// ============================================================================

/** 单次反思运行结果。 */
export interface ReflectionRunResult {
  runId: string;
  status: ReflectionRunStatus;
  at: number;
  sessionCount: number;
  firstRun: boolean;
  skippedReason?: ReflectionSkipReason;
  failReason?: ReflectionFailReason;
  ingest?: ReflectionIngestCounts;
  operations: PlannedOperation[];
  rejected: RejectedOperation[];
  applied: AppliedOperationResult[];
  /** 本次进入 Tier2 待审队列的记录 id。 */
  pendingReviewIds: string[];
  tier2Intercepted: number;
  tier2Rate: number;
  /** 晨报草稿落盘条目 id（写入 reflections 层；失败时不设）。 */
  morningDraftEntryId?: string;
  /** 降级/失败明细（如实记录；空数组 = 全绿）。 */
  errors: string[];
}

/** 反思运行事件（每次运行一条终态事件；system 类 → ⑭，Tier2 拦截率 → ⑮）。 */
export interface ReflectionRunEvent {
  kind: 'reflection.run.completed' | 'reflection.run.skipped' | 'reflection.run.failed';
  level: 'info' | 'warn';
  at: number;
  runId: string;
  sessionCount: number;
  firstRun: boolean;
  skippedReason?: ReflectionSkipReason;
  failReason?: ReflectionFailReason;
  ingest?: ReflectionIngestCounts;
  operationCounts?: Record<ReflectionOperationKind, number>;
  rejectedCount?: number;
  tier1Applied: number;
  tier2Intercepted: number;
  tier2Rate: number;
  morningDraftWritten?: boolean;
  errors?: string[];
}

/** 观测出口（注入式；实现侧保证自身异常不影响主链路）。 */
export type ReflectionEventSink = (event: ReflectionRunEvent) => void;
