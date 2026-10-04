/**
 * jarvis-core · 记忆层类型与接口契约（任务 27，06-11 §6.1 / §6.2 / §11.3）
 *
 * 四层（§6.1）：working 工作记忆 / long-term 长期知识 / growth-log 成长日志 /
 * reflections 反思产物。存储形态沿任务 20 决策 #5 预登记（抄 JARVIS vault 式）：
 * 纯 Markdown 文件 + 零依赖内存索引，不引向量库。接口与实现分离——实测语义
 * 检索不达标时，只需另写一个实现 MemoryStore 的 Mem0 适配器（mem0ai），
 * write-engine 与上层无需改动（可推翻路径见任务 20 §#5）。
 *
 * 来源分层（§11.3）：user-stated 用户陈述 / agent-confirmed 代理确认 / inferred
 * 推断。**推断只允许留在工作记忆**（长期知识与成长日志代码层拒收 inferred），
 * 与「预测/准备只存候选、不当作事实」配套。
 *
 * 边界：只管秘书个人四层；团队记忆（任务 23）与病历（任务 11）不混入本层。
 */

// ============================================================================
// 层 / 来源 / 状态 / 触发词
// ============================================================================

/** 四层（06-11 §6.1）；目录名见 LAYER_DIRS。 */
export type MemoryLayer = 'working' | 'long-term' | 'growth-log' | 'reflections';

export const MEMORY_LAYERS: readonly MemoryLayer[] = ['working', 'long-term', 'growth-log', 'reflections'];

/** 层 → vault 子目录名（磁盘布局；换实现时可改，接口不受影响）。 */
export const LAYER_DIRS: Readonly<Record<MemoryLayer, string>> = {
  working: 'working',
  'long-term': 'long-term',
  'growth-log': 'growth-log',
  reflections: 'reflections',
};

/** 来源分层（06-11 §11.3）。 */
export type MemorySource = 'user-stated' | 'agent-confirmed' | 'inferred';

/** 长期知识只收前两者（拒收规则见 assertSourceAllowedForLayer）。 */
export const LONG_TERM_ALLOWED_SOURCES: readonly MemorySource[] = ['user-stated', 'agent-confirmed'];

/** active=在役；pending-reflection=已过期/超容量，标记留给夜间反思（任务 28）提炼。 */
export type MemoryStatus = 'active' | 'pending-reflection';

/** 写入触发词五类（§6.2「纠正（'不是X'）、专名、偏好、决定、数值」）。 */
export type MemoryTriggerKind = 'correction' | 'proper-noun' | 'preference' | 'decision' | 'numeric';

export type MarkReason = 'expired' | 'capacity';

// ============================================================================
// 条目
// ============================================================================

/**
 * 一条记忆（vault 里 = 一个 Markdown 文件；frontmatter 承载元数据，正文承载 text）。
 * 必需元数据：层 / 来源 / 时间戳 / use_count（任务 27 ⑤.1）。
 */
export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  source: MemorySource;
  /** 来源类别：触发词 kind（correction/proper-noun/…）或显式 kind（session-summary/agent-note/…）。 */
  kind: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** 被引用次数（反思 meta：PROMOTE 的 use_count>10 判定依据，任务 28）。 */
  useCount: number;
  status: MemoryStatus;
  sessionId?: string;
  /** 命中/来源标签（扫描写作时=命中触发词 kinds）。 */
  tags?: string[];
  /** promote 记录：迁出层。 */
  promotedFrom?: MemoryLayer;
  /** pending-reflection 标记时刻。 */
  markedAt?: number;
  /** pending-reflection 标记原因（过期 / 超容量）。 */
  markReason?: MarkReason;
}

export interface MemoryAddInput {
  layer: MemoryLayer;
  source: MemorySource;
  text: string;
  kind?: string;
  sessionId?: string;
  tags?: string[];
  /** 显式时刻（epoch ms）；缺省取 store 时钟。 */
  at?: number;
  /** 默认 true：同层同文本（归一化）不重复落盘，返回既有条目并刷新 updatedAt。 */
  dedupe?: boolean;
}

export interface MemoryUpdatePatch {
  text?: string;
  source?: MemorySource;
  kind?: string;
  tags?: string[];
  status?: MemoryStatus;
}

export interface MemoryQuery {
  layer?: MemoryLayer | readonly MemoryLayer[];
  source?: MemorySource;
  /** 默认 'active'（标记留给反思的条目默认不可见）；'any' = 不限。 */
  status?: MemoryStatus | 'any';
  kind?: string;
  sessionId?: string;
  /** 正文子串（大小写不敏感）。 */
  text?: string;
  /** 结果上限（排序后截取）。 */
  limit?: number;
  /** 默认按 updatedAt 降序。 */
  order?: 'asc' | 'desc';
  /** true = 命中即 use_count+1（反思 meta 的「被引用」信号）。 */
  touchResults?: boolean;
}

export interface MemoryTotals {
  /** 在役（active）条数。 */
  active: number;
  /** 待反思（pending-reflection）条数——即被裁剪出工作集的总量。 */
  marked: number;
  /** 每层在役条数。 */
  byLayer: Record<MemoryLayer, number>;
}

// ============================================================================
// 生命周期（过期 / 容量裁剪）
// ============================================================================

export interface SweepOptions {
  /** 判定时刻（epoch ms）；缺省取 store 时钟。 */
  now?: number;
  /** 工作记忆 TTL；缺省 DEFAULT_WORKING_TTL_MS（7 天，初始值非实测）。 */
  workingTtlMs?: number;
  /** 工作记忆容量；缺省 DEFAULT_WORKING_CAPACITY（40，初始值非实测）。 */
  workingCapacity?: number;
}

export interface SweepResult {
  markedExpired: number;
  markedOverflow: number;
  /** 本次裁剪出工作集的条数（落 ⑭ 观测）。 */
  droppedCount: number;
  markedIds: string[];
  totals: MemoryTotals;
}

/** 工作记忆过期：初始 7 天（06-11 §6.1「几天」的建议起步值；非实测，待 ⑭→⑮ 标定）。 */
export const DEFAULT_WORKING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 工作记忆容量：初始 40（对齐 vcs maxNotes=40 的现有注入上限；非实测）。 */
export const DEFAULT_WORKING_CAPACITY = 40;

/** 单条正文长度上限（防误写超长文本；超出截断）。 */
export const DEFAULT_MAX_TEXT_LENGTH = 2000;

// ============================================================================
// 观测（⑭ 系统活动 2 记忆操作；注入式回调，模块不硬绑 activity-log）
// ============================================================================

export interface MemoryOpEvent {
  op: 'add' | 'update' | 'delete' | 'promote' | 'touch' | 'sweep' | 'capture';
  /** false = 去重/未找到/无命中导致的未生效操作。 */
  applied: boolean;
  at: number;
  layer?: MemoryLayer;
  source?: MemorySource;
  entryId?: string;
  sessionId?: string;
  /** 本次裁剪条数（sweep）——对齐 ⑭ 既有 droppedCount 语义。 */
  droppedCount?: number;
  totals?: MemoryTotals;
  /** 附加明细（capture 的命中词/kinds；sweep 的 expired/overflow 拆分；错误摘要等）。 */
  detail?: Record<string, unknown>;
  /** applied=false 的原因：duplicate / not-found / already-in-target / error 等。 */
  reason?: string;
}

/** 观测出口；实现侧保证自身异常不影响 store/engine（内部 try/catch）。 */
export type MemoryObserver = (event: MemoryOpEvent) => void;

// ============================================================================
// MemoryStore 契约
// ============================================================================

/**
 * 核心六方法（任务 27 ⑤.2）：add / update / delete / promote / query / list。
 * Mem0 适配只需实现本接口即可替换实现而不动上层；接口为异步以兼容 SDK/IO。
 */
export interface MemoryStore {
  add(input: MemoryAddInput): Promise<MemoryEntry>;
  /** 未找到返回 null。growth-log 为 append-only，默认拒改（AppendOnlyViolationError）。 */
  update(id: string, patch: MemoryUpdatePatch, opts?: { force?: boolean }): Promise<MemoryEntry | null>;
  /** 未找到返回 false。growth-log 为 append-only，默认拒删；force=true 供用户隐私清除。 */
  delete(id: string, opts?: { force?: boolean }): Promise<boolean>;
  /** 提升到 target（默认 long-term）；inferred 拒收、growth-log 拒搬（append-only）。 */
  promote(id: string, target?: MemoryLayer): Promise<MemoryEntry | null>;
  query(q?: MemoryQuery): Promise<MemoryEntry[]>;
  list(layer?: MemoryLayer): Promise<MemoryEntry[]>;
}

/** 生命周期扩展（JARVIS vault 文件实现；Mem0 适配按等价语义实现，上层不变）。 */
export interface MemoryLifecycleStore extends MemoryStore {
  /** use_count+1 并刷新 updatedAt（被引用信号）。未找到返回 null。 */
  touch(id: string): Promise<MemoryEntry | null>;
  /** 过期/超容量裁剪：标记 pending-reflection，返回 droppedCount（不物理删除，留给夜间反思）。 */
  sweep(opts?: SweepOptions): Promise<SweepResult>;
  /** 待反思条目（任务 28 INGEST 数据源），按标记时间升序。 */
  listMarkedForReflection(): Promise<MemoryEntry[]>;
  stats(): Promise<MemoryTotals>;
}

// ============================================================================
// 策略错误（代码层强制，⑥.4 验收）
// ============================================================================

/** 推断只允许留在工作记忆：长期知识/成长日志/反思产物拒收 inferred。 */
export class InferredMemoryRejectedError extends Error {
  readonly code = 'inferred-memory-rejected';
  constructor(
    readonly op: string,
    readonly layer: MemoryLayer,
    readonly source: MemorySource = 'inferred',
  ) {
    super(`记忆策略拒收：${op} 的 inferred 来源只允许留在 working（目标层 ${layer}）`);
    this.name = 'InferredMemoryRejectedError';
  }
}

/** 成长日志 append-only：update/delete/promote 默认拒绝（force=true 仅供用户隐私清除）。 */
export class AppendOnlyViolationError extends Error {
  readonly code = 'append-only-violation';
  constructor(
    readonly op: string,
    readonly id: string,
  ) {
    super(`成长日志 append-only：拒绝 ${op} 条目 ${id}（如需隐私清除传 force=true）`);
    this.name = 'AppendOnlyViolationError';
  }
}

/** inferred 只允许写入 working 层（其余层全部拒收）。 */
export function assertSourceAllowedForLayer(layer: MemoryLayer, source: MemorySource): void {
  if (source === 'inferred' && layer !== 'working') {
    throw new InferredMemoryRejectedError('add', layer, source);
  }
}
