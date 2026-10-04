/**
 * jarvis-core/sentinel · 统计口径与端口（任务 33 ②/⑤.1，06-11 §13.4）
 *
 * 钉死：口径（忽略率/采纳率分母、投诉 = 用户显式否定）；缺源如实（null 不造数、
 * 缺源不判）；比率边界（严格大于触发、恰好阈值不触发）；分母 0 不判；
 * 失败隔离（port_not_wired / port_error / malformed_data，永不上抛）；日期边界。
 */

import { describe, expect, it } from 'vitest';

import {
  DAY_MS,
  computeDayVerdict,
  computeSentinelMetrics,
  collectDayMetricsSafely,
  createStaticStatsProvider,
  createUnavailableStatsProvider,
  emptyDayStats,
  localDayDiff,
  localDayKey,
  normalizeDayStats,
  startOfLocalDay,
} from './index.js';
import type { JarvisLogger, SentinelDayStats } from './index.js';
import { DEFAULT_SENTINEL_THRESHOLDS } from './index.js';

/** 本地时刻构造（月 1 起）。 */
function at(y: number, m: number, d: number, h = 12): number {
  return new Date(y, m - 1, d, h, 0, 0, 0).getTime();
}

/** 健康默认值（需要聚焦某一项时再覆盖）。 */
function stats(day: string, over: Partial<SentinelDayStats> = {}): SentinelDayStats {
  return { day, proactiveBroadcasts: 100, ignored: 20, adopted: 40, complaints: 0, ...over };
}

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

describe('本地日界工具', () => {
  it('localDayKey / startOfLocalDay：本地自然日 0 点', () => {
    expect(DAY_MS).toBe(86_400_000);
    const noon = at(2026, 10, 4, 12);
    expect(localDayKey(noon)).toBe('2026-10-4');
    const start = new Date(startOfLocalDay(noon));
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getDate()).toBe(4);
  });

  it('localDayDiff：同日 0、跨日 1、**跨月/跨年边界** 1、逆向 -1', () => {
    expect(localDayDiff(at(2026, 10, 4, 8), at(2026, 10, 4, 23))).toBe(0);
    expect(localDayDiff(at(2026, 10, 4), at(2026, 10, 5))).toBe(1);
    expect(localDayDiff(at(2026, 10, 31), at(2026, 11, 1))).toBe(1); // 跨月
    expect(localDayDiff(at(2026, 12, 31), at(2027, 1, 1))).toBe(1); // 跨年
    expect(localDayDiff(at(2026, 10, 5), at(2026, 10, 4))).toBe(-1);
    expect(localDayDiff(at(2026, 10, 1), at(2026, 10, 31))).toBe(30);
  });
});

describe('normalizeDayStats（畸形 → null + 记因，不抛）', () => {
  it('缺省/undefined = 缺源（非畸形）；非法值 = 畸形落 null；小数截断', () => {
    const empty = normalizeDayStats('2026-10-4', undefined);
    expect(empty.malformed).toBe(false);
    expect(empty.stats).toEqual(emptyDayStats('2026-10-4'));

    const bad = normalizeDayStats('2026-10-4', {
      proactiveBroadcasts: -1,
      ignored: Number.NaN,
      adopted: Number.POSITIVE_INFINITY,
      complaints: '3' as unknown as number,
    });
    expect(bad.malformed).toBe(true);
    expect(bad.stats).toEqual(emptyDayStats('2026-10-4'));

    const fractional = normalizeDayStats('2026-10-4', { proactiveBroadcasts: 3.9 });
    expect(fractional.malformed).toBe(false);
    expect(fractional.stats.proactiveBroadcasts).toBe(3);
    expect(fractional.stats.ignored).toBeNull();
  });
});

describe('computeSentinelMetrics（口径派生）', () => {
  it('比率 = 计数/播报数；缺源进 missing', () => {
    const metrics = computeSentinelMetrics(stats('2026-10-4'));
    expect(metrics.ignoreRate).toBeCloseTo(0.2);
    expect(metrics.adoptRate).toBeCloseTo(0.4);
    expect(metrics.missing).toEqual([]);
  });

  it('分母为 0（当日无播报样本）→ 比率不判（null），不算回正日', () => {
    const metrics = computeSentinelMetrics(stats('2026-10-4', { proactiveBroadcasts: 0, ignored: 0, adopted: 0 }));
    expect(metrics.ignoreRate).toBeNull();
    expect(metrics.adoptRate).toBeNull();
    expect(metrics.missing).toEqual([]);
  });

  it('缺源如实：缺失项进 missing、比率 null；数据不一致时比率钳到 1', () => {
    const missing = computeSentinelMetrics(emptyDayStats('2026-10-4'));
    expect(missing.missing).toEqual(['proactiveBroadcasts', 'ignored', 'adopted', 'complaints']);
    expect(missing.ignoreRate).toBeNull();
    expect(missing.adoptRate).toBeNull();

    const clamped = computeSentinelMetrics(stats('2026-10-4', { ignored: 200 }));
    expect(clamped.ignoreRate).toBe(1);
  });
});

describe('computeDayVerdict（06-11 §13.4 口径边界矩阵）', () => {
  const verdict = (over: Partial<SentinelDayStats>): ReturnType<typeof computeDayVerdict> =>
    computeDayVerdict(computeSentinelMetrics(stats('2026-10-4', over)), DEFAULT_SENTINEL_THRESHOLDS);

  it('忽略率：>40% 熔断；恰好 40% 落警告带；恰好 30% 仍健康（滞回边界）', () => {
    expect(verdict({ ignored: 41 })).toBe('critical');
    expect(verdict({ ignored: 40 })).toBe('warning'); // 严格大于才熔断
    expect(verdict({ ignored: 31 })).toBe('warning');
    expect(verdict({ ignored: 30 })).toBe('healthy'); // 恰好恢复线 = 健康
    expect(verdict({ ignored: 29 })).toBe('healthy');
  });

  it('采纳率：恰好 30% 达标；<30% 警告带；缺源不作否决', () => {
    expect(verdict({ adopted: 30 })).toBe('healthy');
    expect(verdict({ adopted: 29 })).toBe('warning');
    expect(verdict({ ignored: 10, adopted: null })).toBe('healthy'); // 缺源不判
  });

  it('投诉：>0 即警告带（目标 0）；临界优先于警告', () => {
    expect(verdict({ complaints: 1 })).toBe('warning');
    expect(verdict({ complaints: 0 })).toBe('healthy');
    expect(verdict({ ignored: 50, complaints: 3 })).toBe('critical');
    expect(verdict({ ignored: null, complaints: 2 })).toBe('warning');
  });

  it('无忽略率样本 → insufficient（不判，保守）', () => {
    expect(verdict({ proactiveBroadcasts: 0, ignored: 0 })).toBe('insufficient');
    expect(verdict({ ignored: null })).toBe('insufficient');
    expect(verdict({ proactiveBroadcasts: null, ignored: null })).toBe('insufficient');
  });

  it('阈值可注入（自定义降级线）', () => {
    const custom = computeDayVerdict(computeSentinelMetrics(stats('2026-10-4', { ignored: 25 })), {
      ...DEFAULT_SENTINEL_THRESHOLDS,
      ignoreRateDegrade: 0.2,
      ignoreRateWarning: 0.1,
    });
    expect(custom).toBe('critical');
  });
});

describe('collectDayMetricsSafely（失败隔离，永不上抛）', () => {
  it('端口未接线 → metrics=null + port_not_wired；logger 抛错也被吞', async () => {
    const throwingLogger: JarvisLogger = {
      log: () => {},
      debug: () => {},
      warn: () => {
        throw new Error('logger down');
      },
      error: () => {
        throw new Error('logger down');
      },
    };
    const result = await collectDayMetricsSafely(undefined, '2026-10-4', { logger: throwingLogger });
    expect(result.metrics).toBeNull();
    expect(result.degraded).toMatchObject({ reason: 'port_not_wired' });
  });

  it('端口抛错（同步/异步同型）→ port_error', async () => {
    const boom = await collectDayMetricsSafely(
      {
        readDay: () => {
          throw new Error('db down');
        },
      },
      '2026-10-4',
    );
    expect(boom.metrics).toBeNull();
    expect(boom.degraded).toMatchObject({ reason: 'port_error' });

    const asyncBoom = await collectDayMetricsSafely(
      { readDay: async () => Promise.reject(new Error('timeout')) },
      '2026-10-4',
      { logger: silentLogger },
    );
    expect(asyncBoom.degraded).toMatchObject({ reason: 'port_error' });
  });

  it('读数非对象 → malformed_data；读数 null（该日无数据）→ 全缺源指标、不算降级', async () => {
    const malformed = await collectDayMetricsSafely(
      { readDay: () => 'oops' as unknown as SentinelDayStats },
      '2026-10-4',
      { logger: silentLogger },
    );
    expect(malformed.metrics).toBeNull();
    expect(malformed.degraded).toMatchObject({ reason: 'malformed_data' });

    const noData = await collectDayMetricsSafely(createUnavailableStatsProvider(), '2026-10-4');
    expect(noData.degraded).toBeUndefined();
    expect(noData.metrics?.missing).toEqual(['proactiveBroadcasts', 'ignored', 'adopted', 'complaints']);
  });

  it('部分缺源 → 保留可解析部分；个别计数畸形 → 落 null + malformed_data', async () => {
    const partial = await collectDayMetricsSafely(
      { readDay: () => ({ proactiveBroadcasts: 10, ignored: 2 }) as SentinelDayStats },
      '2026-10-4',
    );
    expect(partial.degraded).toBeUndefined();
    expect(partial.metrics).toMatchObject({ proactiveBroadcasts: 10, ignored: 2, adopted: null, complaints: null });

    const messy = await collectDayMetricsSafely(
      { readDay: () => ({ proactiveBroadcasts: 10, ignored: 'x' }) as unknown as SentinelDayStats },
      '2026-10-4',
      { logger: silentLogger },
    );
    expect(messy.degraded).toMatchObject({ reason: 'malformed_data' });
    expect(messy.metrics?.ignored).toBeNull();
    expect(messy.metrics?.proactiveBroadcasts).toBe(10);
  });

  it('采集全链可通：静态端口 → 指标 → 判词', async () => {
    const port = createStaticStatsProvider([stats('2026-10-4', { ignored: 50 })]);
    const result = await collectDayMetricsSafely(port, '2026-10-4', { logger: silentLogger });
    expect(result.degraded).toBeUndefined();
    expect(computeDayVerdict(result.metrics!)).toBe('critical');
  });
});

describe('替身端口（生产采集延后，mock 先行）', () => {
  it('静态端口：数组/对象两种入参、未知日 → null、返回副本不改源', () => {
    const arrayPort = createStaticStatsProvider([stats('2026-10-4')]);
    const objectPort = createStaticStatsProvider({ '2026-10-5': { proactiveBroadcasts: 5, ignored: 1 } });

    expect(arrayPort.readDay('2026-10-4')).toMatchObject({ proactiveBroadcasts: 100 });
    expect(arrayPort.readDay('2026-10-9')).toBeNull();
    expect(objectPort.readDay('2026-10-5')).toMatchObject({ day: '2026-10-5', proactiveBroadcasts: 5 });

    const first = arrayPort.readDay('2026-10-4')!;
    first.proactiveBroadcasts = 999;
    expect(arrayPort.readDay('2026-10-4')?.proactiveBroadcasts).toBe(100);
  });

  it('createUnavailableStatsProvider 恒 null（生产未接线形态）', async () => {
    const port = createUnavailableStatsProvider();
    expect(await port.readDay('2026-10-4')).toBeNull();
  });
});
