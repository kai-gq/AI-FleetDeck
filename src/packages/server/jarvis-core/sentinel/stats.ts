/**
 * jarvis-core · 活动监视器（任务 33）· 统计口径与 StatsProvider 注入端口
 *
 * 口径照任务 33 ②（06-11 §13.4「开口质量指标」）：
 * - **每日主动播报次数**：本地自然日内的主动播报总条数（忽略率/采纳率分母）；
 * - **忽略率**：被忽略条数（30s 内无回应 / 主动打断）÷ 播报总条数；目标 <40%；
 * - **采纳率**：被采纳条数 ÷ 播报总条数；目标 >30%。与 09·A `GatesStats`
 *   （broadcast-gates.ts，adopted/broadcasts）同口径——§13.4 字面为「PREPARE
 *   提议被采纳占比」；v1 无提议数数据源，**不另造分母**（登记见回执，待 W11 标定）；
 * - **投诉**：用户显式否定次数（任务 33 ⑤.1）；目标 0。（§13.4 同段「骚扰投诉
 *   ＝每日播报超配额次数」的另一读法归 09·A 预算层已有的 `budget_exhausted`
 *   记因，本模块不重复计。）
 *
 * 缺源如实（禁造口径）：忽略 / 采纳 / 投诉无生产数据源（client
 * proactiveReporter.ts:318-325 客户端恒 0）——端口就绪即可；缺源日判词
 * `insufficient` → 相位机相位保持（保守，不因缺数据误恢复）。
 *
 * 失败隔离（照 senses 先例）：端口未接线 `port_not_wired` / 抛错 `port_error` /
 * 畸形 `malformed_data`；`collectDayMetricsSafely` **永不上抛**（缺省安全读数）。
 *
 * 纯函数显式 now 注入：日界/日键全部由入参时刻计算，不读机器时钟。
 */

import type { JarvisLogger } from '../executors.js';
import { createOnceLogger } from '../senses/safe.js';
import type {
  SentinelDayStats,
  SentinelDayVerdict,
  SentinelMetricKey,
  SentinelMetrics,
  SentinelMetricsResult,
  SentinelThresholds,
} from './types.js';
import { DEFAULT_SENTINEL_THRESHOLDS } from './types.js';

// ============================================================================
// 本地日界工具（与 senses/safe.ts、reflection/gate.ts 同口径，避免跨模块耦合）
// ============================================================================

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 判定某时刻所属本地自然日的起始（本地时区 0 点）。 */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日键（YYYY-M-D，本地时区；与 senses/safe.ts localDayKey 同形）。 */
export function localDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 整日差 `to - from`（本地时区自然日边界计数）。用两日 0 点之差除以 24h
 * 再四舍五入：夏令时切换日相差 23/25h，四舍五入抵消（误差 < 0.5 天）。
 * 注意：入参用「时刻」，不是日键字符串（避免 YYYY-M-D 字面排序坑）。
 */
export function localDayDiff(from: number, to: number): number {
  return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / DAY_MS);
}

// ============================================================================
// 端口
// ============================================================================

/**
 * 统计注入端口（v1 接口；生产采集延后——见文件头「缺源如实」登记）。
 * 契约：返回该日快照；**该日无数据返回 null**（不是错误）；抛错按 port_error
 * 隔离。可返回 Promise（采集实现可为异步）。
 */
export interface SentinelStatsPort {
  readDay: (day: string) => SentinelDayStats | null | Promise<SentinelDayStats | null>;
}

/** 全缺源的日快照（端口无该日数据时使用；判词 insufficient）。 */
export function emptyDayStats(day: string): SentinelDayStats {
  return { day, proactiveBroadcasts: null, ignored: null, adopted: null, complaints: null };
}

interface SanitizedCount {
  value: number | null;
  malformed: boolean;
}

/** 计数清洗：缺省/undefined = 缺源（null，不算畸形）；非法值 = 畸形（落 null 并记因）。 */
function sanitizeCount(raw: unknown): SanitizedCount {
  if (raw === undefined || raw === null) return { value: null, malformed: false };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return { value: null, malformed: true };
  }
  return { value: Math.trunc(raw), malformed: false };
}

/** 归一化单日原始统计（畸形计数落 null + malformed 标记，不抛）。 */
export function normalizeDayStats(
  day: string,
  raw: Partial<SentinelDayStats> | null | undefined,
): { stats: SentinelDayStats; malformed: boolean } {
  const source = raw ?? {};
  const broadcasts = sanitizeCount(source.proactiveBroadcasts);
  const ignored = sanitizeCount(source.ignored);
  const adopted = sanitizeCount(source.adopted);
  const complaints = sanitizeCount(source.complaints);
  const malformed = broadcasts.malformed || ignored.malformed || adopted.malformed || complaints.malformed;
  return {
    stats: {
      day,
      proactiveBroadcasts: broadcasts.value,
      ignored: ignored.value,
      adopted: adopted.value,
      complaints: complaints.value,
    },
    malformed,
  };
}

// ============================================================================
// 指标派生
// ============================================================================

/**
 * 计数 → 指标（比率派生；缺源/分母为 0 → 比率 null）。
 * - 分母为 0 = 当日无播报样本 → 比率不判（**不算回正日**，保守）；
 * - 比率钳到 [0,1]（数据不一致时不让噪声放大到 >100%）。
 */
export function computeSentinelMetrics(stats: SentinelDayStats): SentinelMetrics {
  const missing: SentinelMetricKey[] = [];
  if (stats.proactiveBroadcasts === null) missing.push('proactiveBroadcasts');
  if (stats.ignored === null) missing.push('ignored');
  if (stats.adopted === null) missing.push('adopted');
  if (stats.complaints === null) missing.push('complaints');

  const denominator = stats.proactiveBroadcasts !== null && stats.proactiveBroadcasts > 0 ? stats.proactiveBroadcasts : null;
  const ratio = (numerator: number | null): number | null => {
    if (denominator === null || numerator === null) return null;
    return Math.min(1, numerator / denominator);
  };

  return {
    day: stats.day,
    proactiveBroadcasts: stats.proactiveBroadcasts,
    ignored: stats.ignored,
    adopted: stats.adopted,
    complaints: stats.complaints,
    ignoreRate: ratio(stats.ignored),
    adoptRate: ratio(stats.adopted),
    missing,
  };
}

/**
 * 单日判词（阈值口径见 types.ts；**严格大于/大于等于**边界即验收矩阵要求）：
 * 1. 忽略率 > 降级线 → critical（§13.4「目标 <40%」）；
 * 2. 忽略率 > 警告线 / 采纳率 < 目标 / 投诉 > 允许值 → warning；
 * 3. 有忽略率样本且未触线 → healthy（采纳率/投诉缺源时不作为否决项——缺源不判）；
 * 4. 其余（无忽略率样本）→ insufficient。
 * 「有忽略率样本」= 当日有播报（分母 > 0）且 ignored 有源；缺一样都不判健康。
 */
export function computeDayVerdict(
  metrics: SentinelMetrics,
  thresholds: SentinelThresholds = DEFAULT_SENTINEL_THRESHOLDS,
): SentinelDayVerdict {
  const { ignoreRate, adoptRate, complaints } = metrics;

  if (ignoreRate !== null && ignoreRate > thresholds.ignoreRateDegrade) return 'critical';

  const elevated = ignoreRate !== null && ignoreRate > thresholds.ignoreRateWarning;
  const adoptLow = adoptRate !== null && adoptRate < thresholds.adoptRateHealthy;
  const complained = complaints !== null && complaints > thresholds.complaintsAllowed;
  if (elevated || adoptLow || complained) return 'warning';

  if (ignoreRate !== null) return 'healthy';
  return 'insufficient';
}

// ============================================================================
// 采集（失败隔离，永不上抛）
// ============================================================================

export interface CollectDayMetricsOptions {
  logger?: JarvisLogger;
}

/**
 * 从注入端口安全采集单日指标（**永不抛出**）：
 * - 端口未接线 → metrics=null + degraded('port_not_wired')（登记：生产数据源延后）；
 * - 端口抛错 → metrics=null + degraded('port_error')；
 * - 端口返回非对象 → metrics=null + degraded('malformed_data')；
 * - 端口返回 null（该日无数据）→ 全缺源指标（判词 insufficient），不算降级；
 * - 记录为对象但个别计数畸形 → 该计数落 null + degraded('malformed_data')（保留可解析部分）。
 */
export async function collectDayMetricsSafely(
  port: SentinelStatsPort | undefined,
  day: string,
  options: CollectDayMetricsOptions = {},
): Promise<SentinelMetricsResult> {
  const logOnce = createOnceLogger(options.logger);

  if (!port) {
    logOnce(
      'warn',
      'port_not_wired',
      '活动监视器统计端口未接线：本日不判（忽略/采纳/投诉暂无生产数据源，登记延后）',
    );
    return {
      metrics: null,
      degraded: {
        reason: 'port_not_wired',
        detail: '统计端口未接线（忽略/采纳/投诉生产采集延后；见任务 33 开工前登记）',
      },
    };
  }

  let raw: unknown;
  try {
    raw = await port.readDay(day);
  } catch (error) {
    logOnce('error', 'port_error', '活动监视器统计端口读取失败（隔离，不吞循环）:', error);
    return { metrics: null, degraded: { reason: 'port_error', error } };
  }

  if (raw === null || raw === undefined) {
    // 该日无数据：是「缺源」而不是故障——全缺源指标 → insufficient → 相位保持。
    return { metrics: computeSentinelMetrics(emptyDayStats(day)) };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logOnce('error', 'malformed', '活动监视器统计读数形态非法（隔离）');
    return { metrics: null, degraded: { reason: 'malformed_data', detail: '统计读数不是对象' } };
  }

  const { stats, malformed } = normalizeDayStats(day, raw as Partial<SentinelDayStats>);
  const metrics = computeSentinelMetrics(stats);
  if (!malformed) return { metrics };
  return {
    metrics,
    degraded: { reason: 'malformed_data', detail: '部分计数畸形已按缺源落 null（保留可解析部分）' },
  };
}

// ============================================================================
// 替身/测试端口（生产采集延后；mock 先行）
// ============================================================================

export type StaticStatsInput = readonly SentinelDayStats[] | Readonly<Record<string, Partial<SentinelDayStats>>>;

/**
 * 静态统计端口（测试/接线替身）：按日键返回快照；无该日 → null。
 * 数组入参按 `day` 字段索引；对象入参键即日键（值里的 day 以键为准）。
 */
export function createStaticStatsProvider(days: StaticStatsInput): SentinelStatsPort {
  const table = new Map<string, SentinelDayStats>();
  if (Array.isArray(days)) {
    for (const item of days as readonly SentinelDayStats[]) {
      const { stats } = normalizeDayStats(item.day, item);
      table.set(stats.day, stats);
    }
  } else {
    for (const [day, partial] of Object.entries(days as Readonly<Record<string, Partial<SentinelDayStats>>>)) {
      const { stats } = normalizeDayStats(day, partial);
      table.set(day, stats);
    }
  }
  return {
    readDay: (day: string): SentinelDayStats | null => {
      const stats = table.get(day);
      return stats ? { ...stats } : null;
    },
  };
}

/** 恒缺省端口（生产未接线形态）：任何日 → null（判词 insufficient，相位保持）。 */
export function createUnavailableStatsProvider(): SentinelStatsPort {
  return { readDay: () => null };
}
