/**
 * 任务33 接线 · 生产 StatsPort 单测（W11）
 *
 * 全替身注入（queryLog/loadHistory），不碰真库真盘；断言口径与「缺源如实」。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SENTINEL_QUERY_LIMIT,
  createSentinelStatsProvider,
  resolveDayBounds,
} from './sentinel-stats-provider.js';
import type { SentinelDayStats } from '../jarvis-core/sentinel/index.js';
import type { SystemLogEntry, SystemLogQuery } from '../data/system-log.js';
import type { DelegationDecision } from '../../shared/agent-types.js';

const DAY = '2026-10-4'; // localDayKey 口径（不补零）
const bounds = resolveDayBounds(DAY)!;
const inDay = (hour: number, minute = 0) => new Date(2026, 9, 4, hour, minute, 0, 0).getTime();
const outOfDay = new Date(2026, 9, 5, 1, 0, 0, 0).getTime();

function entry(category: string, ts: number, body: unknown): SystemLogEntry {
  return { ts, category, level: 'info', body: typeof body === 'string' ? body : JSON.stringify(body) };
}

/** 最小 DelegationDecision 替身（字段齐;评价字段按用例覆写）。 */
function decision(partial: Partial<DelegationDecision>): DelegationDecision {
  return {
    id: 'd1',
    timestamp: 0,
    bossId: 'boss',
    userCommand: 'x',
    selectedAgentId: 'a',
    selectedAgentName: 'A',
    reasoning: '',
    alternativeAgents: [],
    confidence: 'high',
    status: 'completed',
    ...partial,
  };
}

describe('resolveDayBounds', () => {
  it('按本地自然日解析闭区间;非法日键(含归一化陷阱)返回 null', () => {
    expect(bounds.since).toBe(new Date(2026, 9, 4, 0, 0, 0, 0).getTime());
    expect(bounds.until).toBe(new Date(2026, 9, 5, 0, 0, 0, 0).getTime() - 1);
    expect(resolveDayBounds('garbage')).toBeNull();
    expect(resolveDayBounds('2026-13-1')).toBeNull();
    expect(resolveDayBounds('2026-2-31')).toBeNull(); // Date 会归一化到 3 月——必须被拒
  });
});

describe('createSentinelStatsProvider · readDay', () => {
  it('proactiveBroadcasts 只数 body.phase=server-sent(broadcast 日志逐条解析);查询参数完整', () => {
    const queryLog = vi.fn((opts?: SystemLogQuery) => {
      if (opts?.category === 'broadcast') {
        return [
          entry('broadcast', inDay(9), { phase: 'server-sent', cat: 'broadcast', text: 'a' }),
          entry('broadcast', inDay(10), { phase: 'queued', cat: 'broadcast' }),
          entry('broadcast', inDay(11), '不是 JSON'),
          entry('broadcast', inDay(12), { phase: 'server-sent', cat: 'broadcast', text: 'b' }),
        ];
      }
      return [];
    });
    const port = createSentinelStatsProvider({ queryLog, loadHistory: () => new Map() });

    const stats = port.readDay(DAY) as SentinelDayStats;
    expect(stats).toEqual({
      day: DAY,
      proactiveBroadcasts: 2,
      ignored: null, // 如实缺源
      adopted: null, // 如实缺源
      complaints: 0, // 两个分量都读到 → 0
    });
    expect(queryLog).toHaveBeenCalledWith({
      category: 'broadcast',
      since: bounds.since,
      until: bounds.until,
      limit: SENTINEL_QUERY_LIMIT,
      order: 'asc',
    });
  });

  it('complaints = 当日负评价(ratedAt 落窗内) + 当日撤回(delegation phase=cancelled)', () => {
    const history = new Map([
      [
        'boss',
        [
          decision({ id: 'r1', userRating: 'unsatisfied', ratedAt: inDay(9) }),
          decision({ id: 'r2', userRating: 'unsatisfied', ratedAt: outOfDay }), // 窗外,不计
          decision({ id: 'r3', userRating: 'satisfied', ratedAt: inDay(9) }), // 非负,不计
          decision({ id: 'r4' }), // 无评价,不计
        ],
      ],
    ]);
    const queryLog = vi.fn((opts?: SystemLogQuery) => {
      if (opts?.category === 'delegation') {
        return [
          entry('delegation', inDay(9, 30), { phase: 'cancelled', cat: 'delegation' }),
          entry('delegation', inDay(10), { phase: 'dispatched', cat: 'delegation' }),
          entry('delegation', inDay(11), '坏行'),
        ];
      }
      return [];
    });
    const port = createSentinelStatsProvider({ queryLog, loadHistory: () => history });

    const stats = port.readDay(DAY) as SentinelDayStats;
    expect(stats.complaints).toBe(2); // 1 负评价 + 1 撤回
  });

  it('负评价源读取失败 → complaints=null 缺源如实(不用撤回分量冒充全量);播报计数不受影响', () => {
    const queryLog = vi.fn((opts?: SystemLogQuery) => {
      if (opts?.category === 'broadcast') {
        return [entry('broadcast', inDay(9), { phase: 'server-sent' })];
      }
      if (opts?.category === 'delegation') {
        return [entry('delegation', inDay(9), { phase: 'cancelled' })];
      }
      return [];
    });
    const port = createSentinelStatsProvider({
      queryLog,
      loadHistory: () => {
        throw new Error('history boom');
      },
    });

    const stats = port.readDay(DAY) as SentinelDayStats;
    expect(stats.proactiveBroadcasts).toBe(1);
    expect(stats.complaints).toBeNull();
  });

  it('日志查询抛错原样上抛(由 collectDayMetricsSafely 接成 port_error)', () => {
    const port = createSentinelStatsProvider({
      queryLog: () => {
        throw new Error('db down');
      },
      loadHistory: () => new Map(),
    });
    expect(() => port.readDay(DAY)).toThrow('db down');
  });

  it('非法日键 → null(该日无数据,不算故障),不触发任何查询', () => {
    const queryLog = vi.fn(() => []);
    const port = createSentinelStatsProvider({ queryLog, loadHistory: () => new Map() });
    expect(port.readDay('not-a-day')).toBeNull();
    expect(queryLog).not.toHaveBeenCalled();
  });
});
