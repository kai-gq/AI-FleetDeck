/**
 * jarvis-core/sentinel · 熔断相位机（任务 33 ④/⑤.2/⑥.1-③.4）· 全边界矩阵
 *
 * 覆盖：正常→警告→降级→恢复全链、**恰好阈值**（0.4/0.3）、滞回（0.35 不恢复）、
 * 抖动不翻相位（交替判词）、最小驻留边界（dwell 1 vs 2）、连续 N 天回正、
 * 缺源不判（相位保持 + 续链清零 + 存量指令不中断）、同日幂等、乱序、
 * 开关关、指令映射与 09 四档 clamp、跨月/跨年日界。
 */

import { describe, expect, it } from 'vitest';

import {
  buildSentinelDirective,
  clampBroadcastTier,
  computeSentinelMetrics,
  createSentinelPhaseState,
  evaluateSentinelPhase,
  localDayKey,
} from './index.js';
import type {
  SentinelConfig,
  SentinelDayStats,
  SentinelMetrics,
  SentinelPhaseEvaluation,
  SentinelPhaseState,
} from './index.js';

/** 2026-10-d 12:00（本地时区）。 */
function T(day: number, hour = 12): number {
  return new Date(2026, 9, day, hour, 0, 0, 0).getTime();
}

const KEY = (day: number): string => localDayKey(T(day));

/** 构造指标：默认健康（100 播报 / 20 忽略 / 40 采纳 / 0 投诉）。 */
function metrics(day: string, over: Partial<SentinelDayStats> = {}): SentinelMetrics {
  return computeSentinelMetrics({
    day,
    proactiveBroadcasts: 100,
    ignored: 20,
    adopted: 40,
    complaints: 0,
    ...over,
  });
}

const HEALTHY = (day: string): SentinelMetrics => metrics(day);
/** 警告带（忽略 0.35：>0.3 且 ≤0.4）。 */
const WARN_BAND = (day: string): SentinelMetrics => metrics(day, { ignored: 35 });
/** 熔断（忽略 0.5：>0.4）。 */
const CRITICAL = (day: string): SentinelMetrics => metrics(day, { ignored: 50 });
/** 全缺源（判词 insufficient）。 */
const MISSING = (day: string): SentinelMetrics =>
  computeSentinelMetrics({ day, proactiveBroadcasts: null, ignored: null, adopted: null, complaints: null });

function evaluate(
  state: SentinelPhaseState,
  dayMetrics: SentinelMetrics | null,
  now: number,
  config?: SentinelConfig,
): SentinelPhaseEvaluation {
  return evaluateSentinelPhase(state, dayMetrics, now, config);
}

/** 依次评估多日，返回末次结果（每条 = { now, metrics }）。 */
function runChain(
  state: SentinelPhaseState,
  steps: Array<{ now: number; metrics: SentinelMetrics | null }>,
  config?: SentinelConfig,
): { state: SentinelPhaseState; results: SentinelPhaseEvaluation[] } {
  const results: SentinelPhaseEvaluation[] = [];
  let current = state;
  for (const step of steps) {
    const result = evaluate(current, step.metrics, step.now, config);
    results.push(result);
    current = result.state;
  }
  return { state: current, results };
}

describe('初始状态与正常日', () => {
  it('createSentinelPhaseState：normal 起始，日键/时刻显式注入', () => {
    const t1 = T(1);
    expect(createSentinelPhaseState(t1)).toEqual({
      phase: 'normal',
      since: t1,
      sinceDay: '2026-10-1',
      healthyStreakDays: 0,
      lastEvaluatedDay: null,
      lastVerdict: null,
      updatedAt: t1,
    });
  });

  it('正常日：无迁移、无指令、续链 +1', () => {
    const t1 = T(1);
    const result = evaluate(createSentinelPhaseState(t1), HEALTHY(KEY(1)), t1);
    expect(result.verdict).toBe('healthy');
    expect(result.transition).toBeNull();
    expect(result.directive).toBeNull();
    expect(result.state).toMatchObject({
      phase: 'normal',
      healthyStreakDays: 1,
      lastEvaluatedDay: '2026-10-1',
      lastVerdict: 'healthy',
      updatedAt: t1,
    });
  });
});

describe('恰好阈值（验收矩阵 ③.4 边界）', () => {
  it('忽略率恰好 40% → 警告带（严格大于才熔断）', () => {
    const t1 = T(1);
    const result = evaluate(createSentinelPhaseState(t1), metrics(KEY(1), { ignored: 40 }), t1);
    expect(result.verdict).toBe('warning');
    expect(result.transition).toMatchObject({ from: 'normal', to: 'warning', reason: 'warning-threshold' });
    expect(result.directive).toMatchObject({ action: 'reduce-frequency', maxTier: 'SPEAK', speakAllowed: true });
  });

  it('忽略率 41% → 直接熔断（恶化不设驻留门槛）', () => {
    const t1 = T(1);
    const result = evaluate(createSentinelPhaseState(t1), metrics(KEY(1), { ignored: 41 }), t1);
    expect(result.verdict).toBe('critical');
    expect(result.transition).toMatchObject({ from: 'normal', to: 'degraded', reason: 'ignore-rate-critical' });
    expect(result.state.healthyStreakDays).toBe(0);
    expect(result.directive).toMatchObject({ action: 'store-only', maxTier: 'STORE', speakAllowed: false, speechFactor: 0 });
  });

  it('警告相位下一日熔断 → 立即降级（不因驻留延迟保护）', () => {
    const first = evaluate(createSentinelPhaseState(T(1)), WARN_BAND(KEY(1)), T(1));
    const second = evaluate(first.state, CRITICAL(KEY(2)), T(2));
    expect(second.transition).toMatchObject({ from: 'warning', to: 'degraded', reason: 'ignore-rate-critical' });
  });
});

describe('滞回与恢复条件（验收矩阵 ③.1/③.4）', () => {
  it('0.3–0.4 滞回带内不恢复：0.35 落回仍 degraded，恰好 0.3 才算回正日', () => {
    const chain = runChain(createSentinelPhaseState(T(1)), [
      { now: T(1), metrics: CRITICAL(KEY(1)) }, // normal → degraded
      { now: T(2), metrics: WARN_BAND(KEY(2)) }, // 0.35：带内，不恢复
      { now: T(3), metrics: metrics(KEY(3), { ignored: 30 }) }, // 恰好 0.3 → healthy，续链 1
    ]);
    const [degrade, bandDay, recoverDay] = chain.results;
    expect(degrade.transition).toMatchObject({ to: 'degraded' });
    expect(bandDay.transition).toBeNull();
    expect(bandDay.verdict).toBe('warning');
    expect(bandDay.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 0 });
    expect(recoverDay.verdict).toBe('healthy');
    expect(recoverDay.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 1 });
  });

  it('连续 N 天回正（N=3）才进 recovering；随后驻留期满才回 normal', () => {
    const chain = runChain(createSentinelPhaseState(T(1)), [
      { now: T(1), metrics: CRITICAL(KEY(1)) }, // degraded
      { now: T(2), metrics: HEALTHY(KEY(2)) }, // streak 1
      { now: T(3), metrics: HEALTHY(KEY(3)) }, // streak 2
      { now: T(4), metrics: HEALTHY(KEY(4)) }, // streak 3 → recovering
      { now: T(5), metrics: HEALTHY(KEY(5)) }, // 驻留 1 < 2 → 仍 recovering
      { now: T(6), metrics: HEALTHY(KEY(6)) }, // 驻留 2 + 续链 5 → normal
    ]);
    const [d1, d2, d3, d4, d5, d6] = chain.results;
    expect(d1.transition).toMatchObject({ to: 'degraded' });
    expect(d2.transition).toBeNull();
    expect(d2.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 1 });
    expect(d3.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 2 });
    expect(d4.transition).toMatchObject({ from: 'degraded', to: 'recovering', reason: 'healthy-recovery' });
    expect(d4.directive).toMatchObject({ action: 'reduce-frequency', maxTier: 'SPEAK', speechFactor: 0.5 });
    expect(d5.transition).toBeNull();
    expect(d5.state.phase).toBe('recovering');
    expect(d6.transition).toMatchObject({ from: 'recovering', to: 'normal', reason: 'recovering-stabilized' });
    expect(d6.directive).toBeNull();
    expect(chain.state.phase).toBe('normal');
  });

  it('非回正日打断续链：degraded 攒 2 天后回跌一天，重新从 0 数', () => {
    const chain = runChain(createSentinelPhaseState(T(1)), [
      { now: T(1), metrics: CRITICAL(KEY(1)) },
      { now: T(2), metrics: HEALTHY(KEY(2)) }, // 1
      { now: T(3), metrics: HEALTHY(KEY(3)) }, // 2
      { now: T(4), metrics: WARN_BAND(KEY(4)) }, // 打断 → 0
      { now: T(5), metrics: HEALTHY(KEY(5)) }, // 1（不足 N=3）
    ]);
    expect(chain.results[3].state).toMatchObject({ phase: 'degraded', healthyStreakDays: 0 });
    expect(chain.results[4].state).toMatchObject({ phase: 'degraded', healthyStreakDays: 1 });
    expect(chain.results[4].transition).toBeNull();
  });

  it('恢复期回跌 → 立即重熔断（不等驻留）', () => {
    const chain = runChain(createSentinelPhaseState(T(1)), [
      { now: T(1), metrics: CRITICAL(KEY(1)) },
      { now: T(2), metrics: HEALTHY(KEY(2)) },
      { now: T(3), metrics: HEALTHY(KEY(3)) },
      { now: T(4), metrics: HEALTHY(KEY(4)) }, // → recovering
      { now: T(5), metrics: WARN_BAND(KEY(5)) }, // 回跌 → degraded
    ]);
    expect(chain.results[4].transition).toMatchObject({
      from: 'recovering',
      to: 'degraded',
      reason: 'recovering-relapse',
    });
    expect(chain.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 0 });
  });
});

describe('最小相位驻留边界（防抖）', () => {
  it('缺省 dwell=2：warning 至少驻留 2 天且连续回正 2 天才回 normal（边界日恰好放行）', () => {
    const chain = runChain(createSentinelPhaseState(T(1)), [
      { now: T(1), metrics: WARN_BAND(KEY(1)) }, // → warning
      { now: T(2), metrics: HEALTHY(KEY(2)) }, // 驻留 1 / 续链 1 → 仍 warning
      { now: T(3), metrics: HEALTHY(KEY(3)) }, // 驻留 2 / 续链 2 → normal（边界日）
    ]);
    expect(chain.results[0].transition).toMatchObject({ to: 'warning' });
    expect(chain.results[1].transition).toBeNull();
    expect(chain.results[1].state.phase).toBe('warning');
    expect(chain.results[2].transition).toMatchObject({ from: 'warning', to: 'normal', reason: 'warning-cleared' });
  });

  it('dwell=1：第二天回正即放行（阈值可注入）', () => {
    const config: SentinelConfig = { thresholds: { minPhaseDwellDays: 1 } };
    const chain = runChain(
      createSentinelPhaseState(T(1)),
      [
        { now: T(1), metrics: WARN_BAND(KEY(1)) },
        { now: T(2), metrics: HEALTHY(KEY(2)) },
      ],
      config,
    );
    expect(chain.results[1].transition).toMatchObject({ from: 'warning', to: 'normal' });
  });

  it('抖动不翻相位：好一天/坏一天交替，warning 与 degraded 都不迁移', () => {
    const warningChain = runChain(createSentinelPhaseState(T(1)), [
      { now: T(1), metrics: WARN_BAND(KEY(1)) }, // → warning
      { now: T(2), metrics: HEALTHY(KEY(2)) },
      { now: T(3), metrics: WARN_BAND(KEY(3)) },
      { now: T(4), metrics: HEALTHY(KEY(4)) },
      { now: T(5), metrics: WARN_BAND(KEY(5)) },
    ]);
    for (const result of warningChain.results.slice(1)) {
      expect(result.transition).toBeNull();
      expect(result.state.phase).toBe('warning');
    }

    const degradedChain = runChain(
      createSentinelPhaseState(T(1)),
      [CRITICAL, WARN_BAND, CRITICAL, WARN_BAND].map((make, index) => ({
        now: T(index + 1),
        metrics: make(KEY(index + 1)),
      })),
    );
    for (const result of degradedChain.results.slice(1)) {
      expect(result.transition).toBeNull();
      expect(result.state.phase).toBe('degraded');
    }
    expect(degradedChain.results[1].state.healthyStreakDays).toBe(0);
  });
});

describe('缺源不判（端口未接线/无数据日）', () => {
  it('缺源日：相位保持、续链清零、判词 insufficient、存量指令不中断', () => {
    const first = evaluate(createSentinelPhaseState(T(1)), CRITICAL(KEY(1)), T(1));
    const healthy = evaluate(first.state, HEALTHY(KEY(2)), T(2)); // streak 1
    const gap = evaluate(healthy.state, null, T(3)); // 缺源
    expect(gap.skippedReason).toBe('insufficient-metrics');
    expect(gap.verdict).toBe('insufficient');
    expect(gap.transition).toBeNull();
    expect(gap.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 0, lastVerdict: 'insufficient' });
    expect(gap.state.lastEvaluatedDay).toBe('2026-10-2'); // 缺源日不登记评估
    // 存量降级指令继续输出（保护不中断）
    expect(gap.directive).toMatchObject({ action: 'store-only', maxTier: 'STORE' });

    // 缺源后再连 2 天才够 N=3（被清零重数）
    const later = runChain(gap.state, [
      { now: T(4), metrics: HEALTHY(KEY(4)) },
      { now: T(5), metrics: HEALTHY(KEY(5)) },
    ]);
    expect(later.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 2 });
  });

  it('全缺源指标（端口返回 null 的日）与 null metrics 同判', () => {
    const first = evaluate(createSentinelPhaseState(T(1)), CRITICAL(KEY(1)), T(1));
    const gap = evaluate(first.state, MISSING(KEY(2)), T(2));
    expect(gap.skippedReason).toBe('insufficient-metrics');
    expect(gap.state.phase).toBe('degraded');
  });
});

describe('同日幂等与乱序防护', () => {
  it('同日重复评估：幂等无操作 + 存量指令', () => {
    const t1 = T(1);
    const first = evaluate(createSentinelPhaseState(t1), CRITICAL(KEY(1)), t1);
    const second = evaluate(first.state, HEALTHY(KEY(1)), t1 + 60 * 60 * 1000); // 同日 13:00
    expect(second.skippedReason).toBe('already-evaluated-today');
    expect(second.transition).toBeNull();
    expect(second.state).toEqual(first.state);
    expect(second.verdict).toBe('critical'); // lastVerdict
    expect(second.directive).toMatchObject({ maxTier: 'STORE' });
  });

  it('乱序（评估日早于上次）：跳过、原状态不动、无迁移', () => {
    const chain = runChain(createSentinelPhaseState(T(1)), [
      { now: T(1), metrics: HEALTHY(KEY(1)) },
      { now: T(5), metrics: HEALTHY(KEY(5)) },
    ]);
    const backfill = evaluate(chain.state, CRITICAL(KEY(4)), T(4));
    expect(backfill.skippedReason).toBe('out-of-order');
    expect(backfill.state).toEqual(chain.state);
    expect(backfill.transition).toBeNull();
    expect(backfill.state.phase).toBe('normal');
  });

  it('未评估过的状态不做乱序判定：首评放行（回归钉·10-06 日期炸弹）', () => {
    // 服务首启 load() 用真实时钟播种 updatedAt，而 runDailyScan 注入的 now 可早于它；
    // 从未评估过就没有「上次评估」可倒灌，首评必须放行——不许出现 out-of-order。
    const fresh: SentinelPhaseState = { ...createSentinelPhaseState(T(4)), updatedAt: T(5) }; // 播种日 10-5 > 注入日 10-4
    const ev = evaluate(fresh, CRITICAL(KEY(4)), T(4));
    expect(ev.skippedReason).not.toBe('out-of-order');
    expect(ev.verdict).toBe('critical');
    expect(ev.transition).toMatchObject({ from: 'normal', to: 'degraded' });
  });
});

describe('开关与配置注入', () => {
  it('开关关（enabled=false / 环境变量 0）：零迁移、无指令（含已在 degraded）', () => {
    const t1 = T(1);
    const disabled = evaluate(createSentinelPhaseState(t1), CRITICAL(KEY(1)), t1, { enabled: false });
    expect(disabled.skippedReason).toBe('disabled');
    expect(disabled.state).toEqual(createSentinelPhaseState(t1));
    expect(disabled.directive).toBeNull();
    expect(disabled.verdict).toBeNull();

    const first = evaluate(createSentinelPhaseState(t1), CRITICAL(KEY(1)), t1);
    const envOff = evaluate(first.state, CRITICAL(KEY(2)), T(2), { env: { TC_JARVIS_SENTINEL: '0' } });
    expect(envOff.skippedReason).toBe('disabled');
    expect(envOff.state).toEqual(first.state);
    expect(envOff.directive).toBeNull();
  });

  it('阈值注入：自定义降级线 0.2 生效；N=2 + dwell=0 的快速恢复链', () => {
    const strict = evaluate(createSentinelPhaseState(T(1)), metrics(KEY(1), { ignored: 25 }), T(1), {
      thresholds: { ignoreRateDegrade: 0.2, ignoreRateWarning: 0.1 },
    });
    expect(strict.transition).toMatchObject({ to: 'degraded' });

    const fast = runChain(
      createSentinelPhaseState(T(1)),
      [
        { now: T(1), metrics: CRITICAL(KEY(1)) },
        { now: T(2), metrics: HEALTHY(KEY(2)) },
        { now: T(3), metrics: HEALTHY(KEY(3)) },
        { now: T(4), metrics: HEALTHY(KEY(4)) },
      ],
      { thresholds: { recoverHealthyDays: 2, minPhaseDwellDays: 0 } },
    );
    expect(fast.results[2].transition).toMatchObject({ to: 'recovering' });
    expect(fast.results[3].transition).toMatchObject({ to: 'normal' });
  });
});

describe('降级指令（复用 09 档位语义，不自造新档）', () => {
  const input = {
    day: '2026-10-1',
    at: T(1),
    verdict: 'warning' as const,
    metrics: metrics('2026-10-1', { ignored: 35 }),
  };

  it('相位 → 指令映射：normal 无指令 / warning 减频率 / degraded 只 STORE 不 SPEAK / recovering 减频率', () => {
    expect(buildSentinelDirective('normal', input)).toBeNull();

    const warning = buildSentinelDirective('warning', input)!;
    expect(warning).toMatchObject({
      action: 'reduce-frequency',
      maxTier: 'SPEAK',
      speakAllowed: true,
      speechFactor: 0.5,
      phase: 'warning',
      day: '2026-10-1',
      at: T(1),
      verdict: 'warning',
    });
    expect(warning.evidence).toMatchObject({
      day: '2026-10-1',
      proactiveBroadcasts: 100,
      ignoreRate: 0.35,
      adoptRate: 0.4,
      complaints: 0,
    });

    const degraded = buildSentinelDirective('degraded', input)!;
    expect(degraded).toMatchObject({ action: 'store-only', maxTier: 'STORE', speakAllowed: false, speechFactor: 0 });

    const recovering = buildSentinelDirective('recovering', input)!;
    expect(recovering).toMatchObject({ action: 'reduce-frequency', maxTier: 'SPEAK', speechFactor: 0.5 });
  });

  it('指令可注入系数；缺源 metrics → 证据全 null（不造数）', () => {
    const custom = buildSentinelDirective('warning', {
      ...input,
      metrics: null,
      thresholds: { speechFactorWhenWarning: 0.25 },
    })!;
    expect(custom.speechFactor).toBe(0.25);
    expect(custom.evidence).toMatchObject({
      proactiveBroadcasts: null,
      ignoreRate: null,
      adoptRate: null,
      complaints: null,
    });
  });

  it('消费方用 clampBroadcastTier 压 09 四档：degraded 时 SPEAK/PREPARE 都压到 STORE', () => {
    const degraded = buildSentinelDirective('degraded', input)!;
    expect(clampBroadcastTier('SPEAK', degraded.maxTier)).toBe('STORE');
    expect(clampBroadcastTier('PREPARE', degraded.maxTier)).toBe('STORE');
    expect(clampBroadcastTier('SILENT', degraded.maxTier)).toBe('SILENT');

    const warning = buildSentinelDirective('warning', input)!;
    expect(clampBroadcastTier('SPEAK', warning.maxTier)).toBe('SPEAK');
    expect(clampBroadcastTier('PREPARE', warning.maxTier)).toBe('PREPARE');
  });
});

describe('跨月/跨年日界', () => {
  it('10-31 进 warning → 11-01 驻留 1 天不放行 → 11-02 放行', () => {
    const oct31 = new Date(2026, 9, 31, 12).getTime();
    const nov1 = new Date(2026, 10, 1, 12).getTime();
    const nov2 = new Date(2026, 10, 2, 12).getTime();
    const chain = runChain(createSentinelPhaseState(oct31), [
      { now: oct31, metrics: WARN_BAND(localDayKey(oct31)) },
      { now: nov1, metrics: HEALTHY(localDayKey(nov1)) },
      { now: nov2, metrics: HEALTHY(localDayKey(nov2)) },
    ]);
    expect(chain.results[0].transition).toMatchObject({ to: 'warning' });
    expect(chain.results[1].transition).toBeNull();
    expect(chain.results[2].transition).toMatchObject({ from: 'warning', to: 'normal' });
  });

  it('12-31 熔断 → 次年 01-01 起连续回正，跨年日键连续', () => {
    const dec31 = new Date(2026, 11, 31, 12).getTime();
    const jan1 = new Date(2027, 0, 1, 12).getTime();
    const first = evaluate(createSentinelPhaseState(dec31), CRITICAL(localDayKey(dec31)), dec31);
    expect(first.transition).toMatchObject({ to: 'degraded' });
    expect(first.state.sinceDay).toBe('2026-12-31');
    const second = evaluate(first.state, HEALTHY(localDayKey(jan1)), jan1);
    expect(second.state).toMatchObject({ phase: 'degraded', healthyStreakDays: 1, lastEvaluatedDay: '2027-1-1' });
  });
});
