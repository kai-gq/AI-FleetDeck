/**
 * 任务33 接线 · 活动监视器生产 StatsPort（W11）
 *
 * 把 jarvis-core/sentinel 的统计端口接到 ⑭ 现有日志账上（模块本身零改动）；
 * 口径如实登记，禁造口径：
 * - proactiveBroadcasts = 当日 broadcast 日志 phase='server-sent' 条数
 *   （querySystemLog 按日窗查询 + 逐条 parse body 过滤；SystemLogQuery 无 body
 *   过滤能力，故必须客户端解析）；
 * - complaints = 当日负评价（delegation-history userRating='unsatisfied' 且
 *   ratedAt 落当日条数）+ 当日撤回（delegation 日志 phase='cancelled' 条数）。
 *   两个分量**任一读取失败 → complaints=null**（缺源如实；不用半个分量冒充全量）；
 * - ignored / adopted = null（无生产数据源，如实缺源；客户端 proactiveReporter
 *   的忽略/采纳计数恒 0，W10 模块注释已登记，本波不造源）。
 *
 * 失败隔离照模块契约：本端口抛错由 collectDayMetricsSafely 落 port_error；
 * 非法日键 → 返回 null（该日无数据，判词 insufficient，不算故障）。
 * 查询上限：当日超出 limit 行即截断（计数偏小）——初始值非实测，登记待 ⑮ 标定。
 */

import { querySystemLog, type SystemLogEntry } from '../data/system-log.js';
import { loadDelegationHistory } from '../data/index.js';
import type { SentinelDayStats, SentinelStatsPort } from '../jarvis-core/sentinel/index.js';

/** 单类日志查询上限（当日行数超出即截断；初始值非实测，登记待标定）。 */
export const SENTINEL_QUERY_LIMIT = 5000;

export interface SentinelStatsProviderDeps {
  /** 日志查询（测试注入；缺省 data/system-log querySystemLog）。 */
  queryLog?: typeof querySystemLog;
  /** 委派历史读取（测试注入；缺省 data/index loadDelegationHistory）。 */
  loadHistory?: typeof loadDelegationHistory;
  /** 单类日志查询上限（缺省 SENTINEL_QUERY_LIMIT）。 */
  queryLimit?: number;
}

/** 本地日键（YYYY-M-D）→ [since, until] 闭区间毫秒窗；非法 → null。 */
export function resolveDayBounds(day: string): { since: number; until: number } | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(day.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const start = new Date(y, mo, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, mo, d + 1, 0, 0, 0, 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  // 校验日期存在（如 2 月 31 日会被 Date 归一化到下月——回读对不上即非法）
  const back = new Date(start);
  if (back.getFullYear() !== y || back.getMonth() !== mo || back.getDate() !== d) return null;
  return { since: start, until: end - 1 };
}

/** body 落库为 JSON 串（偶有纯文本行）；解析失败返回 null。 */
function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 当日 server-sent 播报条数（broadcast 日志逐条 parse；查询抛错上抛 → port_error）。 */
function countServerSentBroadcasts(
  queryLog: typeof querySystemLog,
  bounds: { since: number; until: number },
  limit: number,
): number {
  const rows: SystemLogEntry[] = queryLog({
    category: 'broadcast',
    since: bounds.since,
    until: bounds.until,
    limit,
    order: 'asc',
  });
  let count = 0;
  for (const row of rows) {
    if (parseBody(row.body)?.phase === 'server-sent') count += 1;
  }
  return count;
}

/** 当日负评价条数（userRating='unsatisfied' 且 ratedAt 落当日；读取抛错 → null 缺源）。 */
function countNegativeRatings(
  loadHistory: typeof loadDelegationHistory,
  bounds: { since: number; until: number },
): number | null {
  try {
    let count = 0;
    for (const decisions of loadHistory().values()) {
      for (const d of decisions) {
        if (
          d.userRating === 'unsatisfied' &&
          typeof d.ratedAt === 'number' &&
          d.ratedAt >= bounds.since &&
          d.ratedAt <= bounds.until
        ) {
          count += 1;
        }
      }
    }
    return count;
  } catch {
    return null; // 评价源不可得：缺源如实（不用撤回分量冒充全量）
  }
}

/** 当日撤回条数（delegation 日志 phase='cancelled'；读取抛错 → null 缺源）。 */
function countCancellations(
  queryLog: typeof querySystemLog,
  bounds: { since: number; until: number },
  limit: number,
): number | null {
  try {
    const rows = queryLog({
      category: 'delegation',
      since: bounds.since,
      until: bounds.until,
      limit,
      order: 'asc',
    });
    let count = 0;
    for (const row of rows) {
      if (parseBody(row.body)?.phase === 'cancelled') count += 1;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * 生产 StatsPort 工厂（同步读；缺省接真账，测试可注入替身）。
 * 语义：该日无任何来源错误时返回快照（无播报即 0）；非法日键 → null。
 */
export function createSentinelStatsProvider(deps: SentinelStatsProviderDeps = {}): SentinelStatsPort {
  const queryLog = deps.queryLog ?? querySystemLog;
  const loadHistory = deps.loadHistory ?? loadDelegationHistory;
  const limit = deps.queryLimit ?? SENTINEL_QUERY_LIMIT;

  return {
    readDay(day: string): SentinelDayStats | null {
      const bounds = resolveDayBounds(day);
      if (!bounds) return null;

      const proactiveBroadcasts = countServerSentBroadcasts(queryLog, bounds, limit);
      const ratings = countNegativeRatings(loadHistory, bounds);
      const cancellations = countCancellations(queryLog, bounds, limit);
      const complaints = ratings !== null && cancellations !== null ? ratings + cancellations : null;

      return {
        day,
        proactiveBroadcasts,
        ignored: null, // 无生产数据源（如实缺源，登记 W11）
        adopted: null, // 同上
        complaints,
      };
    },
  };
}

/** 生产单例（默认路径懒加载由 sentinel-service 持有；此处仅工厂，便于测试注入）。 */
export function defaultSentinelStatsPort(): SentinelStatsPort {
  return createSentinelStatsProvider({ queryLog: querySystemLog, loadHistory: loadDelegationHistory });
}
