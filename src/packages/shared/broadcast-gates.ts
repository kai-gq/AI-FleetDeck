/**
 * 播报分级判断层 · 四闸门纯函数(任务 09·A,契约 = 06-11 §4 / §13.1)。
 *
 * 形态:Signal(事件信号)+ GatesState(显式状态) → BroadcastDecision(决策 + 状态增量)。
 * 无隐藏状态、不读时钟、不造队列、不接线:同一 (signal, state) 必得同一决策;
 * 调用方用 applyGatesDelta 把 delta 喂回 state 即得新状态(自适应预算/幂等去重
 * 可在单测里反复喂状态验证)。
 *
 * 四档语义(06-11 §4.2,对应任务卡 ⑤2「立即口播 / 上屏 / 攒批 / 沉默」):
 * - SPEAK   = 立即口播(行动层播报,口播 + 上屏);
 * - PREPARE = 攒批,到下一个自然开口点再说(不打断当下);
 * - STORE   = 上屏/沉淀的出口标记(本层只给决策,出口由调用方接现有上屏通道);
 * - SILENT  = 不处理。仅两种情形:相关性过低(闸门①,按矩阵「score=40 → SILENT」)、
 *   dedupeKey 重复(已处理过,不丢信息)。
 *
 * 沉默 ≠ 丢弃(M3):凡过闸门①、被②③④降级的事件至少落 PREPARE/STORE,绝不消失。
 *
 * 阈值全部取自 06-11 §4,标注「建议值非实测」,导出为常量,待 ⑭ 观测 / ⑮ 标定回写;
 * 判定用本地时区(Date 本地时间)取时刻,与桌面端用户时区一致。
 */

// ============================================================================
// 阈值常量(06-11 §4,建议值非实测)
// ============================================================================

/** 闸门① 相关性阈值:低于它直接沉默。 */
export const RELEVANCE_THRESHOLD = 60;
/** 闸门② 打扰度封顶:> 它不可开口(延后攒批)。 */
export const DISRUPTION_THRESHOLD = 70;
/** 深夜(23:00–07:00)打扰系数。 */
export const DEEP_NIGHT_DISRUPTION = 90;
/** 深夜 / focus time 的破例线:评分 > 90 才允许主动播报。 */
export const QUIET_BYPASS_SCORE = 90;
/** 闸门④ 立即播报线:评分 > 85 视为紧急,立即说;否则攒批。 */
export const IMMEDIATE_SCORE = 85;
/** 每日主动播报预算起点(条),可配 0–50;自适应在它基础上增减。 */
export const BASE_DAILY_BUDGET = 10;
/** 自适应预算上限(06-11 §4 闸门③「可配 0–50」)。 */
export const DAILY_BUDGET_MAX = 50;
/** 口播子配额(条/天):只计即时口播(SPEAK),上屏/攒批不占;区间 3–5,默认取上界。 */
export const SPEECH_SUB_QUOTA = 5;
/** 统计窗口忽略率 > 50% → 预算降 30%(严格大于)。 */
export const IGNORE_RATE_DOWNGRADE = 0.5;
/** 统计窗口采纳率 > 80% → 预算提 20%(严格大于)。 */
export const ADOPT_RATE_UPGRADE = 0.8;
/** 预算下调系数(降 30%)。 */
export const BUDGET_DOWN_FACTOR = 0.7;
/** 预算上调系数(提 20%)。 */
export const BUDGET_UP_FACTOR = 1.2;
/** 闸门① 权重(06-11 §4.2:urgency 0.5 / relevance 0.3 / certainty 0.2)。 */
export const SCORE_WEIGHTS = { urgency: 0.5, relevance: 0.3, certainty: 0.2 } as const;
/** 未提供的评分分量默认取中性 50(不全盘归零,也不抬过阈值)。 */
export const NEUTRAL_SCORE_COMPONENT = 50;
/** 闸门② 环境打扰系数(06-11 §4.2 表)。 */
export const DISRUPTION_FACTORS = {
  /** 播报/聆听/转写进行中:绝不插话。 */
  speaking: 100,
  /** 视频会议/播放媒体。 */
  videoMeeting: 85,
  /** 全屏应用/浏览器全屏。 */
  fullscreen: 80,
  /** 近 2 分钟连续键盘/鼠标输入。 */
  recentInput: 75,
  /** 你刚说完话 10s 内。 */
  justSpoke: 60,
  /** 空闲/正常桌面(基线下限)。 */
  idle: 20,
} as const;
/** 深夜默认窗口(23:00–07:00,可配)。 */
export const DEFAULT_DEEP_NIGHT = { startMinutes: 23 * 60, endMinutes: 7 * 60 } as const;
/** focus time 默认窗口(09:00–11:00,可配)。 */
export const DEFAULT_FOCUS_WINDOWS: readonly TimeWindow[] = [{ startMinutes: 9 * 60, endMinutes: 11 * 60 }];

// ============================================================================
// 类型
// ============================================================================

export type SignalSource = 'agent' | 'system' | 'project' | 'time' | 'user' | 'memory';

/** 感知层归一化后的信号包(06-11 §4.1 + 判定所需评分子项)。 */
export interface Signal {
  source: SignalSource;
  /** 事件类型,如 'agent_completed' | 'disk_low' | 'test_failed'。 */
  kind: string;
  /** 发生时间(epoch ms)。 */
  ts: number;
  /** 幂等去重键(06-11 §11.1,如 'agent-completed:{agentId}:{taskId}')。 */
  dedupeKey: string;
  /** 展示文本(供上屏/播报出口使用,本层原样透传)。 */
  text?: string;
  /** 项目归属(按项目聚合等后置能力用,本层不消费)。 */
  projectId?: string;
  /** 结构化内容(本层不消费)。 */
  payload?: unknown;
  /** 相关性总分(0–100);给了就直接用,否则由下面三个分量加权算。 */
  score?: number;
  /** 紧急度(0–100),如 任务出错=90 / 磁盘告警=85 / 任务完成=60。 */
  urgency?: number;
  /** 与当前关注点的相关度(0–100)。 */
  relevance?: number;
  /** 信号源确定性(0–100):agent 状态=高 / 日志启发=中 / 预测=低。 */
  certainty?: number;
  /** 强时效性(如「等你授权才能继续」):闸门④ 按紧急处理,但不豁免②③。 */
  timeSensitive?: boolean;
}

/** [start, end) 分钟窗口;start > end 表示跨午夜(如 23:00–07:00)。 */
export interface TimeWindow {
  startMinutes: number;
  endMinutes: number;
}

/** 判定配置(全部可配;默认值 = 06-11 §4 建议值)。 */
export interface GatesConfig {
  relevanceThreshold: number;
  disruptionThreshold: number;
  deepNightDisruption: number;
  quietBypassScore: number;
  immediateScore: number;
  baseDailyBudget: number;
  speechSubQuota: number;
  ignoreRateDowngrade: number;
  adoptRateUpgrade: number;
  budgetDownFactor: number;
  budgetUpFactor: number;
  deepNight: TimeWindow;
  focusWindows: readonly TimeWindow[];
}

/** 当前环境快照(闸门② 输入;由调用方在每次判定前刷新)。 */
export interface EnvironmentContext {
  /** 播报/聆听/转写进行中。 */
  speaking?: boolean;
  /** 视频会议/播放媒体。 */
  videoMeeting?: boolean;
  /** 全屏应用/浏览器全屏。 */
  fullscreen?: boolean;
  /** 近 2 分钟连续键盘/鼠标输入。 */
  recentInput?: boolean;
  /** 距你上次说完话的秒数(10s 内计 60)。 */
  justSpokeSecondsAgo?: number;
}

/** 忽略/采纳统计(自适应预算输入;窗口由调用方维护,如按周)。 */
export interface GatesStats {
  /** 窗口内主动播报总条数(忽略率/采纳率的分母)。 */
  broadcasts: number;
  /** 被忽略(30s 内无回应/被打断)条数。 */
  ignored: number;
  /** 被采纳条数。 */
  adopted: number;
}

/** 判定所需的全部显式状态。 */
export interface GatesState {
  /** 判定时刻(epoch ms)。显式传入,保证纯函数可复现。 */
  now: number;
  /** 今日已开口(SPEAK/PREPARE)条数,占每日主预算。 */
  spokenToday: number;
  /** 今日已即时口播(SPEAK)条数,占口播子配额。 */
  instantSpeakToday: number;
  /** 已处理过的 dedupeKey(幂等去重;裁剪由调用方负责)。 */
  seenKeys: readonly string[];
  stats: GatesStats;
  env: EnvironmentContext;
  config: GatesConfig;
}

/** 状态增量:applyGatesDelta 把它喂回 state 即得新状态。 */
export interface GatesStateDelta {
  /** 需追加到 seenKeys 的键(重复信号为空)。 */
  seenKeysToAdd: readonly string[];
  /** 主预算消耗(SPEAK/PREPARE = 1,STORE/SILENT = 0)。 */
  dailySpokenDelta: number;
  /** 口播子配额消耗(SPEAK = 1,其余 = 0)。 */
  instantSpeechDelta: number;
}

export type BroadcastTier = 'SPEAK' | 'PREPARE' | 'STORE' | 'SILENT';

/** 决策理由(观测点⑥ 直接上报,作为调 60/70 等阈值的依据)。 */
export type BroadcastReason =
  | 'urgent' // 评分 > 85,立即说
  | 'time_sensitive' // 信号自报强时效
  | 'batched' // 普通事件,攒批到自然开口点
  | 'deep_night' // 深夜(≤90)拦截,降级攒批
  | 'focus_time' // focus time(≤90)拦截,降级攒批
  | 'high_disruption' // 打扰度 > 70,延后攒批
  | 'speech_quota_exhausted' // 口播子配额用尽,降级攒批
  | 'budget_exhausted' // 每日预算用尽,降级落 STORE
  | 'low_relevance' // 相关性 < 60,直接沉默
  | 'duplicate'; // dedupeKey 已处理,幂等跳过

export interface BroadcastDecision {
  tier: BroadcastTier;
  reason: BroadcastReason;
  /** 相关性评分(0–100)。 */
  score: number;
  /** 打扰度:环境系数与深夜系数取大(0–100)。 */
  disruption: number;
  /** 本次判定生效的每日预算(自适应后的条数)。 */
  budget: number;
  /** 是否重复信号(幂等跳过)。 */
  duplicate: boolean;
  /** 状态增量。 */
  delta: GatesStateDelta;
}

// ============================================================================
// 默认值 / 工具
// ============================================================================

export const DEFAULT_GATES_CONFIG: GatesConfig = {
  relevanceThreshold: RELEVANCE_THRESHOLD,
  disruptionThreshold: DISRUPTION_THRESHOLD,
  deepNightDisruption: DEEP_NIGHT_DISRUPTION,
  quietBypassScore: QUIET_BYPASS_SCORE,
  immediateScore: IMMEDIATE_SCORE,
  baseDailyBudget: BASE_DAILY_BUDGET,
  speechSubQuota: SPEECH_SUB_QUOTA,
  ignoreRateDowngrade: IGNORE_RATE_DOWNGRADE,
  adoptRateUpgrade: ADOPT_RATE_UPGRADE,
  budgetDownFactor: BUDGET_DOWN_FACTOR,
  budgetUpFactor: BUDGET_UP_FACTOR,
  deepNight: { ...DEFAULT_DEEP_NIGHT },
  focusWindows: DEFAULT_FOCUS_WINDOWS.map((w) => ({ ...w })),
};

/** 空增量(重复信号直接返回它;冻结防误改)。 */
export const EMPTY_GATES_DELTA: GatesStateDelta = Object.freeze({
  seenKeysToAdd: Object.freeze([]) as readonly string[],
  dailySpokenDelta: 0,
  instantSpeechDelta: 0,
});

/** createGatesState 的覆盖项:嵌套字段允许只给一部分。 */
export interface GatesStateOverrides extends Omit<Partial<GatesState>, 'config' | 'stats' | 'env'> {
  stats?: Partial<GatesStats>;
  env?: EnvironmentContext;
  config?: Omit<Partial<GatesConfig>, 'deepNight'> & { deepNight?: Partial<TimeWindow> };
}

/** 构造带默认值的状态(嵌套 config/stats/env 浅合并;调用方按需覆盖)。 */
export function createGatesState(overrides: GatesStateOverrides = {}): GatesState {
  const config = overrides.config;
  return {
    now: overrides.now ?? Date.now(),
    spokenToday: overrides.spokenToday ?? 0,
    instantSpeakToday: overrides.instantSpeakToday ?? 0,
    seenKeys: overrides.seenKeys ?? [],
    stats: { broadcasts: 0, ignored: 0, adopted: 0, ...overrides.stats },
    env: { ...overrides.env },
    config: {
      ...DEFAULT_GATES_CONFIG,
      ...config,
      deepNight: { ...DEFAULT_GATES_CONFIG.deepNight, ...config?.deepNight },
      focusWindows: (config?.focusWindows ?? DEFAULT_GATES_CONFIG.focusWindows).map((w) => ({ ...w })),
    },
  };
}

/** 纯函数:把增量喂回状态(不改原对象)。 */
export function applyGatesDelta(state: GatesState, delta: GatesStateDelta): GatesState {
  return {
    ...state,
    spokenToday: state.spokenToday + delta.dailySpokenDelta,
    instantSpeakToday: state.instantSpeakToday + delta.instantSpeechDelta,
    seenKeys:
      delta.seenKeysToAdd.length > 0 ? [...state.seenKeys, ...delta.seenKeysToAdd] : state.seenKeys,
  };
}

// ============================================================================
// 闸门计算(全部导出,便于单测与观测)
// ============================================================================

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** 闸门① 评分:显式 score 优先;否则 = w_urgency·urgency + w_relevance·relevance + w_certainty·certainty。 */
export function computeRelevanceScore(
  signal: Pick<Signal, 'score' | 'urgency' | 'relevance' | 'certainty'>,
): number {
  if (typeof signal.score === 'number') return Math.round(clampScore(signal.score));
  const urgency = clampScore(signal.urgency ?? NEUTRAL_SCORE_COMPONENT);
  const relevance = clampScore(signal.relevance ?? NEUTRAL_SCORE_COMPONENT);
  const certainty = clampScore(signal.certainty ?? NEUTRAL_SCORE_COMPONENT);
  return Math.round(
    SCORE_WEIGHTS.urgency * urgency +
      SCORE_WEIGHTS.relevance * relevance +
      SCORE_WEIGHTS.certainty * certainty,
  );
}

/** 闸门② 环境打扰度:各因素取最大;无因素时空闲基线 20。 */
export function evaluateDisruption(env: EnvironmentContext): number {
  let level: number = DISRUPTION_FACTORS.idle;
  if (env.speaking) level = Math.max(level, DISRUPTION_FACTORS.speaking);
  if (env.videoMeeting) level = Math.max(level, DISRUPTION_FACTORS.videoMeeting);
  if (env.fullscreen) level = Math.max(level, DISRUPTION_FACTORS.fullscreen);
  if (env.recentInput) level = Math.max(level, DISRUPTION_FACTORS.recentInput);
  if (
    typeof env.justSpokeSecondsAgo === 'number' &&
    env.justSpokeSecondsAgo >= 0 &&
    env.justSpokeSecondsAgo <= 10
  ) {
    level = Math.max(level, DISRUPTION_FACTORS.justSpoke);
  }
  return level;
}

/** 本地时区的「当日第几分钟」(0–1439)。 */
export function minutesOfDay(now: number): number {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/** [start, end) 判定;start > end 表示跨午夜窗口;start === end 视为空窗口。 */
export function isWithinWindow(minute: number, window: TimeWindow): boolean {
  const start = window.startMinutes;
  const end = window.endMinutes;
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/** 闸门③ 自适应预算:忽略率 > 50% 降 30%,采纳率 > 80% 提 20%(降优先,保守)。 */
export function adaptiveDailyBudget(
  stats: GatesStats,
  config: GatesConfig = DEFAULT_GATES_CONFIG,
): number {
  let budget = config.baseDailyBudget;
  if (stats.broadcasts > 0) {
    if (stats.ignored / stats.broadcasts > config.ignoreRateDowngrade) {
      budget = Math.round(budget * config.budgetDownFactor);
    } else if (stats.adopted / stats.broadcasts > config.adoptRateUpgrade) {
      budget = Math.round(budget * config.budgetUpFactor);
    }
  }
  return Math.max(0, Math.min(DAILY_BUDGET_MAX, budget));
}

// ============================================================================
// 判定主体
// ============================================================================

function makeDelta(
  seenKeysToAdd: readonly string[],
  dailySpokenDelta: number,
  instantSpeechDelta: number,
): GatesStateDelta {
  return { seenKeysToAdd, dailySpokenDelta, instantSpeechDelta };
}

function decide(
  tier: BroadcastTier,
  reason: BroadcastReason,
  base: Pick<BroadcastDecision, 'score' | 'disruption' | 'budget'>,
  delta: GatesStateDelta,
  duplicate = false,
): BroadcastDecision {
  return { tier, reason, duplicate, delta, ...base };
}

/**
 * 四闸门判定主入口。
 *
 * 顺序:幂等去重 → ① 相关性 → ③ 预算(硬顶前置)→ ② 打扰度(含深夜)→ ④ 时机(含口播子配额)。
 * 预算硬顶:at-quota 时任何开口分支(含深夜/忙碌的降级攒批与紧急事件)一律 STORE、增量 0,
 * 防止会议/深夜的 N 条事件把预算记成 N 次超发。
 * 早停语义:① 不过 = SILENT(矩阵如此);②③④ 拦下一律降级到 PREPARE/STORE(不丢弃)。
 */
export function decideBroadcast(signal: Signal, state: GatesState): BroadcastDecision {
  const config = state.config;
  const score = computeRelevanceScore(signal);
  const minute = minutesOfDay(state.now);
  const deepNight = isWithinWindow(minute, config.deepNight);
  const baseDisruption = evaluateDisruption(state.env);
  // 深夜系数与当前环境取大,作为对外报告的打扰度(判定用 baseDisruption + 深夜窗口)
  const disruption = deepNight ? Math.max(baseDisruption, config.deepNightDisruption) : baseDisruption;
  const budget = adaptiveDailyBudget(state.stats, config);
  const numbers = { score, disruption, budget };

  // 幂等(06-11 §11.1):同一 dedupeKey 只处理一次,重复不重算、不重复记账。
  if (state.seenKeys.includes(signal.dedupeKey)) {
    return decide('SILENT', 'duplicate', numbers, EMPTY_GATES_DELTA, true);
  }
  const seen = [signal.dedupeKey];

  // 闸门① 相关性:低于阈值 → 直接沉默,不进后续闸门(06-11 §4.2)。
  if (score < config.relevanceThreshold) {
    return decide('SILENT', 'low_relevance', numbers, makeDelta(seen, 0, 0));
  }

  // 闸门③ 预算(硬顶前置):用尽 → STORE(降级不丢,矩阵「STORE/SILENT」取 STORE)。
  // 必须在②之前:否则 at-quota 时深夜/忙碌的降级攒批仍会 +1,预算被无界超发。
  if (state.spokenToday >= budget) {
    return decide('STORE', 'budget_exhausted', numbers, makeDelta(seen, 0, 0));
  }

  // 闸门② 打扰度:> 阈值 → 延后到下一个自然开口点(攒批,不丢弃)。
  if (baseDisruption > config.disruptionThreshold) {
    return decide('PREPARE', 'high_disruption', numbers, makeDelta(seen, 1, 0));
  }
  // 深夜不主动播报,除非评分 > 90 破例。
  if (deepNight && score <= config.quietBypassScore) {
    return decide('PREPARE', 'deep_night', numbers, makeDelta(seen, 1, 0));
  }

  // 闸门④ 时机:紧急立即说,普通攒到自然开口点。
  const urgent = score > config.immediateScore;
  if (!urgent && signal.timeSensitive !== true) {
    return decide('PREPARE', 'batched', numbers, makeDelta(seen, 1, 0));
  }
  // focus time 不主动播报,除非评分 > 90 破例。
  if (config.focusWindows.some((w) => isWithinWindow(minute, w)) && score <= config.quietBypassScore) {
    return decide('PREPARE', 'focus_time', numbers, makeDelta(seen, 1, 0));
  }
  // 口播子配额:即时口播用尽后降级攒批(攒批不占子配额)。
  if (state.instantSpeakToday >= config.speechSubQuota) {
    return decide('PREPARE', 'speech_quota_exhausted', numbers, makeDelta(seen, 1, 0));
  }
  return decide('SPEAK', urgent ? 'urgent' : 'time_sensitive', numbers, makeDelta(seen, 1, 1));
}
