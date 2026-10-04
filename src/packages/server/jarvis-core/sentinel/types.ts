/**
 * jarvis-core · 活动监视器与自愈闭环（任务 33，06-11 §11.2 / §13.4 / 台阶三⑧）
 * · 公共类型 / 阈值 / 开关
 *
 * 波内形态（W10 冻结）：**纯模块、零接线**（接线 W11 预点名 `signal-queue.ts:180`
 * setStats / proactiveReporter gatesConfig / vcs 出口 / cron 模板）。本目录只被
 * 按路径直导入；不改 jarvis-core/index.ts 与任何既有 barrel。
 *
 * 分工边界（两层旋钮，**不叠加**，冻结）：
 * - 本模块 = **循环级熔断**：按本地自然日统计每日主动播报次数 / 忽略率 /
 *   采纳率 / 投诉（口径 06-11 §13.4），跨天做相位迁移
 *   （normal → warning → degraded → recovering → normal），只产出「降级指令对象」；
 * - 09·A 闸门内自适应（`src/packages/shared/broadcast-gates.ts:42-47`：窗口忽略率
 *   >50% 降预算 30% / 采纳率 >80% 提 20%）是**单次决策**的另一旋钮——本模块指令
 *   不含绝对预算数值（只给 maxTier / speakAllowed / speechFactor 相对系数），
 *   消费方不得把两层预算数值相加或相乘传回闸门。
 *
 * 数据源（如实登记，禁造口径）：忽略 / 采纳 / 投诉**暂无生产数据源**
 * （client proactiveReporter.ts:318-325 客户端恒 0；interrupted
 * activity-log.ts:128 语义＝秘书打断下属，**不消费**，已裁定）；StatsProvider
 * 端口就绪，生产采集延后。
 *
 * 阈值：初始值非实测（§13.4「忽略率目标 <40% / 采纳率 >30% / 投诉 0」）；
 * 滞回带 / 最小相位驻留 / 恢复天数 N 为保守初值，登记待 ⑭ 观测 / ⑮ 标定回写
 * 06-12 §8.2。
 *
 * 隔离：本目录不 import services/**、不 import client/**；`TC_JARVIS_SENTINEL`
 * 开关（W11 接线时生效；本波模块内可注入配置）。
 */

import type { BroadcastTier } from '../../../shared/broadcast-gates.js';

// ============================================================================
// 开关（形态对齐 TC_JARVIS_MORNING_REPORT / TC_JARVIS_PROJECT_ROUTING）
// ============================================================================

/** 活动监视器总开关（缺省开；'0'/'off'/'false' 关）。 */
export const SENTINEL_ENV_KEY = 'TC_JARVIS_SENTINEL';

/**
 * 开关判定（环境变量形态）。缺省 / 空白 = 开；'0' / 'off' / 'false'（忽略
 * 大小写与空白）= 关。与 isMorningReportEnabled / isSenseEnabled 同口径。
 */
export function isSentinelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SENTINEL_ENV_KEY]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

/** 由「配置入参 ∞ 环境变量」解析启用标志（入参优先，便于测试/接线）。 */
export function resolveSentinelEnabled(enabled: boolean | undefined, env?: NodeJS.ProcessEnv): boolean {
  if (typeof enabled === 'boolean') return enabled;
  return isSentinelEnabled(env);
}

// ============================================================================
// 相位 / 判词
// ============================================================================

/**
 * 熔断四相位（任务 33 ④/⑤.2）：正常 → 警告 → 降级 → 恢复。
 * - normal     = 指标健康，无降级指令；
 * - warning    = 亚健康（忽略率进入警告带 / 采纳率不达标 / 有投诉），只减频率；
 * - degraded   = 熔断（忽略率超 §13.4 阈值），只 STORE 不 SPEAK；
 * - recovering = 降级后连续 N 天回正，处于观察恢复期（仍保守减频率）。
 *
 * 迁移规则（state-machine.ts）：**恶化立即（不设驻留门槛），恢复缓慢
 * （滞回 + 最小驻留 + 连续 N 天回正）**——保护要快、松闸要慢。
 */
export type SentinelPhase = 'normal' | 'warning' | 'degraded' | 'recovering';

/** 规范顺序（观测/单测遍历用）。 */
export const SENTINEL_PHASES: readonly SentinelPhase[] = ['normal', 'warning', 'degraded', 'recovering'];

export function isSentinelPhase(value: unknown): value is SentinelPhase {
  return typeof value === 'string' && (SENTINEL_PHASES as readonly string[]).includes(value);
}

/**
 * 单日判词（state-machine 据此迁移）：
 * - healthy     = 有数据且全部指标达标（忽略率 ≤ 恢复线、采纳率 ≥ 目标、投诉 = 0）；
 * - warning     = 有数据但进入警告带（忽略率 > 警告线 / 采纳率 < 目标 / 投诉 > 0）；
 * - critical    = 忽略率 > 降级线（§13.4 目标 <40%，严格大于即熔断）；
 * - insufficient= 缺源（关键指标为 null），**不判**：相位保持、续链清零。
 */
export type SentinelDayVerdict = 'healthy' | 'warning' | 'critical' | 'insufficient';

// ============================================================================
// 阈值（初始值非实测；抄 06-11 §13.4，登记待 ⑭/⑮ 标定回写 06-12 §8.2）
// ============================================================================

export interface SentinelThresholds {
  /**
   * 忽略率进入警告带阈值（**严格大于**）：缺省 0.3 = 降级线 0.4 的 3/4。
   * §13.4 未给警告线（只给目标 <40%），本值为保守初值、非实测。
   */
  ignoreRateWarning: number;
  /** 忽略率熔断阈值（**严格大于**）：缺省 0.4（§13.4「目标 <40%」，非实测）。 */
  ignoreRateDegrade: number;
  /**
   * 忽略率恢复线（**小于等于**）：缺省 0.3。与 ignoreRateWarning 同值构成
   * 0.3–0.4 滞回带：>0.4 进降级、≤0.3 才算回正，带内不恢复（防抖动）。
   */
  ignoreRateRecover: number;
  /** 采纳率目标（**大于等于**视为达标）：缺省 0.3（§13.4「目标 >30%」，非实测）。 */
  adoptRateHealthy: number;
  /** 投诉允许值：缺省 0（§13.4「目标 0」）；超过即进入警告带。 */
  complaintsAllowed: number;
  /**
   * 恢复所需连续回正天数 N（degraded → recovering 的条件）。
   * 保守初值 3、非实测；待 ⑭ 观测 / ⑮ 标定（06-12 §8.2 回写）。
   */
  recoverHealthyDays: number;
  /**
   * 最小相位驻留（天）：**恢复性**迁移（warning→normal、recovering→normal）
   * 需同时满足 ① 本相位已驻留 ≥ 该天数；② 连续回正 ≥ 该天数（防「好一天坏
   * 一天」的交替抖动——交替永远攒不够第二条）。恶化迁移不受限制（保护要快）。
   * 保守初值 2、非实测；0 = 关闭驻留（仅单测用）。
   */
  minPhaseDwellDays: number;
  /** warning 相位「减频率」的相对系数（消费方自行应用；缺省 0.5，非实测）。 */
  speechFactorWhenWarning: number;
  /** recovering 相位「减频率」的相对系数（缺省 0.5，非实测）。 */
  speechFactorWhenRecovering: number;
}

export const DEFAULT_SENTINEL_THRESHOLDS: SentinelThresholds = {
  ignoreRateWarning: 0.3,
  ignoreRateDegrade: 0.4,
  ignoreRateRecover: 0.3,
  adoptRateHealthy: 0.3,
  complaintsAllowed: 0,
  recoverHealthyDays: 3,
  minPhaseDwellDays: 2,
  speechFactorWhenWarning: 0.5,
  speechFactorWhenRecovering: 0.5,
};

/** 有限数兜底（非法 → 缺省；纯函数不抛）。 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 非负整数兜底（天/次数类；非法 → 缺省）。 */
function countOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

/** 合并阈值覆盖项（非法值回落缺省，不抛——接线配置错误不致熔断器失效）。 */
export function resolveSentinelThresholds(partial: Partial<SentinelThresholds> = {}): SentinelThresholds {
  return {
    ignoreRateWarning: finiteOr(partial.ignoreRateWarning, DEFAULT_SENTINEL_THRESHOLDS.ignoreRateWarning),
    ignoreRateDegrade: finiteOr(partial.ignoreRateDegrade, DEFAULT_SENTINEL_THRESHOLDS.ignoreRateDegrade),
    ignoreRateRecover: finiteOr(partial.ignoreRateRecover, DEFAULT_SENTINEL_THRESHOLDS.ignoreRateRecover),
    adoptRateHealthy: finiteOr(partial.adoptRateHealthy, DEFAULT_SENTINEL_THRESHOLDS.adoptRateHealthy),
    complaintsAllowed: countOr(partial.complaintsAllowed, DEFAULT_SENTINEL_THRESHOLDS.complaintsAllowed),
    recoverHealthyDays: Math.max(1, countOr(partial.recoverHealthyDays, DEFAULT_SENTINEL_THRESHOLDS.recoverHealthyDays)),
    minPhaseDwellDays: countOr(partial.minPhaseDwellDays, DEFAULT_SENTINEL_THRESHOLDS.minPhaseDwellDays),
    speechFactorWhenWarning: finiteOr(partial.speechFactorWhenWarning, DEFAULT_SENTINEL_THRESHOLDS.speechFactorWhenWarning),
    speechFactorWhenRecovering: finiteOr(partial.speechFactorWhenRecovering, DEFAULT_SENTINEL_THRESHOLDS.speechFactorWhenRecovering),
  };
}

// ============================================================================
// 统计快照（口径见 stats.ts：每日主动播报次数 / 忽略率 / 采纳率 / 投诉）
// ============================================================================

/** 单日原始统计（各计数可缺——缺源如实，不造数）。 */
export interface SentinelDayStats {
  /** 本地日键（YYYY-M-D，本地时区自然日）。 */
  day: string;
  /** 当日主动播报总条数（忽略率/采纳率分母）；null = 缺源。 */
  proactiveBroadcasts: number | null;
  /** 当日被忽略条数（30s 内无回应 / 主动打断）；null = 缺源。 */
  ignored: number | null;
  /** 当日被采纳条数；null = 缺源。 */
  adopted: number | null;
  /** 当日用户显式否定（投诉）次数；null = 缺源。 */
  complaints: number | null;
}

/** 统计口径里的指标键（缺源清单用）。 */
export type SentinelMetricKey = 'proactiveBroadcasts' | 'ignored' | 'adopted' | 'complaints';

/** 归一化后的单日指标（比率由计数派生；分母为 0 = 无样本 → 比率 null）。 */
export interface SentinelMetrics {
  day: string;
  proactiveBroadcasts: number | null;
  ignored: number | null;
  adopted: number | null;
  complaints: number | null;
  /** 被忽略条数 ÷ 播报条数（钳到 [0,1]）；null = 缺源或分母为 0。 */
  ignoreRate: number | null;
  /** 被采纳条数 ÷ 播报条数（钳到 [0,1]）；null = 缺源或分母为 0。 */
  adoptRate: number | null;
  /** 缺源指标键（如实登记；缺源不判）。 */
  missing: readonly SentinelMetricKey[];
}

/** 统计端口失败原因（照 senses 降级记因形态）。 */
export type SentinelStatsDegradeReason = 'port_not_wired' | 'port_error' | 'malformed_data';

/** 统计端口降级标记（只降级不抛调用方）。 */
export interface SentinelStatsDegrade {
  reason: SentinelStatsDegradeReason;
  detail?: string;
  error?: unknown;
}

/** 采集结果：有数据 → metrics；缺源/失败 → null + degraded 记因。 */
export interface SentinelMetricsResult {
  metrics: SentinelMetrics | null;
  degraded?: SentinelStatsDegrade;
}

// ============================================================================
// 降级指令（复用 09 四档语义；只给相对系数，不给绝对预算）
// ============================================================================

/**
 * 降级动作（复用 09 档位语义，**不自造新档**）：
 * - reduce-frequency = 减频率（仍可开口，消费方按 speechFactor 压低自己的频率/预算）；
 * - store-only      = 只 STORE 不 SPEAK（最高档压到 STORE：只上屏/沉淀，不开口）。
 */
export type SentinelDegradeAction = 'reduce-frequency' | 'store-only';

/** 指令证据快照（观测/复盘用；缺源为 null，不造数）。 */
export interface SentinelDirectiveEvidence {
  day: string;
  proactiveBroadcasts: number | null;
  ignoreRate: number | null;
  adoptRate: number | null;
  complaints: number | null;
}

/** 跨天降级指令对象（消费方 W11 注入 09·B / 心跳；与闸门内自适应**不叠加数值**）。 */
export interface SentinelDegradeDirective {
  action: SentinelDegradeAction;
  /**
   * 允许的最高播报档位（09·A BroadcastTier 语义）：
   * reduce-frequency → 'SPEAK'（可开口，压低频率）；store-only → 'STORE'（不开口）。
   */
  maxTier: BroadcastTier;
  /** 是否允许高于 STORE（即允许开口）。 */
  speakAllowed: boolean;
  /** 相对频率系数（消费方自行应用到自己的预算/队列；本模块不产绝对预算）。 */
  speechFactor: number;
  /** 产出于哪个相位（指令随相位，不随单日判词）。 */
  phase: SentinelPhase;
  /** 生效日（本地日键）。 */
  day: string;
  /** 产出时刻（epoch ms，显式注入）。 */
  at: number;
  /** 产出依据（最近一次有数据的判词）。 */
  verdict: SentinelDayVerdict;
  evidence: SentinelDirectiveEvidence;
}

/**
 * 09 四档可开口程度排序（数字越小越优先开口）：SPEAK(0) > PREPARE(1) > STORE(2) > SILENT(3)。
 * 仅用于本模块「档位上限」判定，不改 09·A 任何语义。
 */
export const BROADCAST_TIER_RANK: Readonly<Record<BroadcastTier, number>> = {
  SPEAK: 0,
  PREPARE: 1,
  STORE: 2,
  SILENT: 3,
};

/** 取两档中更保守的一个：clampBroadcastTier('SPEAK', 'STORE') === 'STORE'。 */
export function clampBroadcastTier(tier: BroadcastTier, maxTier: BroadcastTier): BroadcastTier {
  return BROADCAST_TIER_RANK[tier] >= BROADCAST_TIER_RANK[maxTier] ? tier : maxTier;
}

// ============================================================================
// 自愈闭环（"问三遍 / 反复误判" → 降级道歉建议对象）
// ============================================================================

/** 交互事件类别：用户请求 / 已确认的误判。 */
export type SentinelInteractionKind = 'user-request' | 'misjudge';

/**
 * 一条交互事件（自愈检测输入；由接线层从会话/回执通道抽取，本模块只做纯检测）。
 */
export interface SentinelInteractionEvent {
  /** 事件时刻（epoch ms）。 */
  at: number;
  kind: SentinelInteractionKind;
  /** 原始文本（证据样本；检测用归一化后的文本）。 */
  text: string;
  /** 稳定意图键（同一请求「问三遍」优先按它归组；如意图 id / 任务 id）。 */
  intentKey?: string;
  /** 误判主题键（同一误判重复按它归组；缺省按文本相似归组）。 */
  topicKey?: string;
}

/** 检测出的自愈模式。 */
export type SentinelSelfHealReason = 'repeated-request' | 'repeated-misjudge';

/**
 * 降级道歉**建议对象**（文案生成不在本波——W11/后续消费）。
 * 文案原则（台阶三⑧）：**说清哪里错、不狡辩**——先复述用户原始诉求，再指出这次
 * 错在哪一步，最后给纠正动作；不找借口、不堆歉词、不反问他"是不是你说得不清"。
 */
export interface SentinelSelfHealSuggestion {
  reason: SentinelSelfHealReason;
  /** 建议动作：降级 + 道歉（文案与出口由消费方 W11 接）。 */
  action: 'degrade-and-apologize';
  /** 建议档位上限（09 语义；'STORE' = 只上屏/沉淀，不再开口追问）。 */
  maxTier: BroadcastTier;
  /** 检测时刻（显式注入的 now）。 */
  at: number;
  /** 触发次数（簇内事件数）。 */
  count: number;
  /** 归组键：intentKey / topicKey，或相似簇代表文本（归一化后）。 */
  key: string;
  /** 证据样本（原文，去重、时间升序，≤ maxSamples）。 */
  samples: readonly string[];
  /** 簇内最早 / 最晚事件时刻。 */
  firstAt: number;
  lastAt: number;
  /** 相似簇的最小相似度（保守）；键归组为 null。 */
  similarity: number | null;
  /** 检测窗口（ms）。 */
  windowMs: number;
}

/** 自愈检测调参（词面「问三遍」→ 3；其余为保守初值、非实测，登记待标定）。 */
export interface SelfHealTuning {
  /** 同一请求重复 N 次触发（词面「问三遍」= 3）。 */
  repeatThreshold: number;
  /** 同一误判重复 M 次触发（「反复」= ≥2）。 */
  misjudgeRepeatThreshold: number;
  /**
   * 文本相似度阈值（0–1，**大于等于**计入同簇）；缺省 0.7（非实测，待标定）。
   * 取值依据：bigram Dice 下「同一句重打一遍」≈0.9+、「换几个字的复述」≈0.7–0.8、
   * 无关语句 ≈0.1 以下——0.7 兼顾「问三遍的近似重复」与误聚。
   */
  similarityThreshold: number;
  /** 检测窗口（ms）：只看 windowMs 内的交互；缺省 30 分钟（非实测）。 */
  windowMs: number;
  /** 建议对象携带的证据样本上限；缺省 3。 */
  maxSamples: number;
}

export const DEFAULT_SELF_HEAL_TUNING: SelfHealTuning = {
  repeatThreshold: 3,
  misjudgeRepeatThreshold: 2,
  similarityThreshold: 0.7,
  windowMs: 30 * 60 * 1000,
  maxSamples: 3,
};

export function resolveSelfHealTuning(partial: Partial<SelfHealTuning> = {}): SelfHealTuning {
  return {
    repeatThreshold: Math.max(2, countOr(partial.repeatThreshold, DEFAULT_SELF_HEAL_TUNING.repeatThreshold)),
    misjudgeRepeatThreshold: Math.max(
      2,
      countOr(partial.misjudgeRepeatThreshold, DEFAULT_SELF_HEAL_TUNING.misjudgeRepeatThreshold),
    ),
    similarityThreshold: Math.min(
      1,
      finiteOr(partial.similarityThreshold, DEFAULT_SELF_HEAL_TUNING.similarityThreshold),
    ),
    windowMs: countOr(partial.windowMs, DEFAULT_SELF_HEAL_TUNING.windowMs),
    maxSamples: Math.max(1, countOr(partial.maxSamples, DEFAULT_SELF_HEAL_TUNING.maxSamples)),
  };
}

// ============================================================================
// 配置（W11 接线注入；本波模块内可注入）
// ============================================================================

export interface SentinelConfig {
  /** 开关；缺省读 TC_JARVIS_SENTINEL（缺省开）。关 = 相位机不迁移、无降级指令。 */
  enabled?: boolean;
  /** 开关判定用环境（测试）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  thresholds?: Partial<SentinelThresholds>;
  selfHeal?: Partial<SelfHealTuning>;
}

export interface ResolvedSentinelConfig {
  enabled: boolean;
  thresholds: SentinelThresholds;
  selfHeal: SelfHealTuning;
}

/** 解析配置（入参 ∞ 环境变量；缺省全开 + 缺省阈值）。 */
export function resolveSentinelConfig(config: SentinelConfig = {}): ResolvedSentinelConfig {
  return {
    enabled: resolveSentinelEnabled(config.enabled, config.env),
    thresholds: resolveSentinelThresholds(config.thresholds),
    selfHeal: resolveSelfHealTuning(config.selfHeal),
  };
}

// ============================================================================
// ⑭ 观测事件（适配器见 observability.ts；纯数据产出，接线层送 sink）
// ============================================================================

export type SentinelEventKind =
  | 'sentinel.phase.transition'
  | 'sentinel.directive'
  | 'sentinel.self-heal.suggested'
  | 'sentinel.stats.degraded';

/** ⑭ system/sentinel 事件（纯数据；由 observability 适配器映射落盘）。 */
export interface SentinelEvent {
  kind: SentinelEventKind;
  level: 'info' | 'warn';
  /** 事件时刻（epoch ms，显式注入）。 */
  at: number;
  /** 评估日（本地日键）。 */
  day?: string;
  /** 事件产出后的相位。 */
  phase?: SentinelPhase;
  fromPhase?: SentinelPhase;
  toPhase?: SentinelPhase;
  transitionReason?: SentinelTransitionReason;
  verdict?: SentinelDayVerdict;
  directive?: SentinelDegradeDirective;
  suggestion?: SentinelSelfHealSuggestion;
  degradeReason?: SentinelStatsDegradeReason;
  detail?: string;
  /** 透传补充字段（观测分析用；保持 JSON 可序列化）。 */
  extra?: Record<string, unknown>;
}

export type SentinelEventSink = (event: SentinelEvent) => void;

// ============================================================================
// 相位机类型（实现见 state-machine.ts；类型集中于此，便于 barrel/观测复用）
// ============================================================================

/** 迁移原因（观测/单测断言用）。 */
export type SentinelTransitionReason =
  | 'ignore-rate-critical' // 忽略率 > 降级线 → 熔断（normal/warning/recovering → degraded）
  | 'warning-threshold' // 忽略率警告带 / 采纳率不达标 / 投诉 → normal → warning
  | 'warning-cleared' // warning 驻留期满且回正 → normal
  | 'healthy-recovery' // 连续 N 天回正 → degraded → recovering
  | 'recovering-stabilized' // recovering 驻留期满且续链达 N → normal
  | 'recovering-relapse'; // recovering 期回跌 → degraded（立即重熔断）

/** 跳过原因（未迁移时的记录）。 */
export type SentinelSkipReason =
  | 'disabled' // 开关关：零行为变化
  | 'out-of-order' // 评估日早于上次评估（防回灌倒序数据）
  | 'already-evaluated-today' // 同日重复评估：幂等无操作
  | 'insufficient-metrics'; // 缺源：不判（相位保持、续链清零）

/** 相位机状态（显式、可序列化；now 由调用方注入，机器自身不读时钟）。 */
export interface SentinelPhaseState {
  phase: SentinelPhase;
  /** 进入当前相位的时刻（epoch ms）。 */
  since: number;
  /** 进入当前相位的本地日键。 */
  sinceDay: string;
  /** 连续回正天数（healthy 判词累加；非回正/缺源清零；进入 degraded 清零）。 */
  healthyStreakDays: number;
  /** 最近一次**有判词**评估的本地日键（同日幂等用）。 */
  lastEvaluatedDay: string | null;
  /** 最近一次判词（含 insufficient；观测用）。 */
  lastVerdict: SentinelDayVerdict | null;
  /** 最近一次**有判词**评估的时刻（epoch ms）。 */
  updatedAt: number;
}

/** 一次相位迁移记录。 */
export interface SentinelPhaseTransition {
  from: SentinelPhase;
  to: SentinelPhase;
  day: string;
  at: number;
  verdict: SentinelDayVerdict;
  reason: SentinelTransitionReason;
}

/** 一次跨天评估结果（纯数据；消费方按需送 ⑭ sink / 注入指令）。 */
export interface SentinelPhaseEvaluation {
  /** 评估后的状态（未迁移 = 计数更新后的状态；跳过 = 原状态）。 */
  state: SentinelPhaseState;
  /** 本次是否发生相位迁移。 */
  transition: SentinelPhaseTransition | null;
  /** 评估后的当前指令（normal = null；跳过/缺源时输出**当前相位的存量指令**，保护不中断）。 */
  directive: SentinelDegradeDirective | null;
  /** 本次判词（缺源/关闭时为 null）。 */
  verdict: SentinelDayVerdict | null;
  skippedReason?: SentinelSkipReason;
}
