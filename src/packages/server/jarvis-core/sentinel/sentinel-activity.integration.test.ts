/**
 * jarvis-core/sentinel · 模块级集成（任务 33 ⑥ 证据口径 L2）
 *
 * mock 统计事件流（逐日快照端口）→ 采集 → 相位迁移 → 降级指令输出 → ⑭ 事件
 * （createSentinelLogObserver 收集），全链走 barrel 公开 API（不 mock 模块内部）。
 *
 * 覆盖：完整生命周期（normal → degraded → recovering → normal）、滞回与连续回正、
 * 数据缺口（缺源不判 + 续链清零 + 存量指令不中断）、失败隔离（端口未接线/抛错）、
 * 自愈闭环（问三遍/反复误判 → 降级道歉建议）、开关关（零行为变化）。
 * L3（真实接线）天然无——本波零接线，登记见回执。
 */

import { describe, expect, it } from 'vitest';

import {
  clampBroadcastTier,
  collectDayMetricsSafely,
  createSentinelLogObserver,
  createSentinelPhaseState,
  createStaticStatsProvider,
  createUnavailableStatsProvider,
  detectSelfHeal,
  directiveEvent,
  evaluateSentinelPhase,
  localDayKey,
  phaseTransitionEvent,
  selfHealEvent,
  statsDegradedEvent,
} from './index.js';
import type {
  JarvisLogger,
  SentinelConfig,
  SentinelDayStats,
  SentinelEvent,
  SentinelPhaseState,
  SentinelStatsPort,
} from './index.js';

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/** 2026-10-d 12:00（本地）。 */
const T = (day: number): number => new Date(2026, 9, day, 12, 0, 0, 0).getTime();
const KEY = (day: number): string => localDayKey(T(day));

/** 逐日快照（health: 健康 / warn: 忽略 35% / crit: 忽略 50%）。 */
function dayStats(day: number, kind: 'healthy' | 'warn' | 'crit'): SentinelDayStats {
  const ignored = kind === 'healthy' ? 20 : kind === 'warn' ? 35 : 50;
  return { day: KEY(day), proactiveBroadcasts: 100, ignored, adopted: 40, complaints: 0 };
}

interface Row {
  category: string;
  fields: { source: string; level?: string; body: Record<string, unknown> };
}

/** ⑭ 收集器：真实适配器 + 内存 logEvent（不落 EventDB，保持模块级集成纯快）。 */
function createCollector(channel: string): { rows: Row[]; emit: (event: SentinelEvent) => void } {
  const rows: Row[] = [];
  const logEvent = (
    category: 'system',
    fields: { source: string; level?: 'info' | 'warn'; body: Record<string, unknown> },
  ): void => {
    rows.push({ category, fields });
  };
  return { rows, emit: createSentinelLogObserver(logEvent, { channel }) };
}

/** 一天：采集（失败隔离）→ 评估 → ⑭ 事件输出（迁移/指令/端口降级）。 */
async function runDay(
  state: SentinelPhaseState,
  port: SentinelStatsPort | undefined,
  now: number,
  emit: (event: SentinelEvent) => void,
  config?: SentinelConfig,
): Promise<ReturnType<typeof evaluateSentinelPhase>> {
  const day = localDayKey(now);
  const collected = await collectDayMetricsSafely(port, day, { logger: silentLogger });
  if (collected.degraded) emit(statsDegradedEvent(collected.degraded, now, day));
  const evaluation = evaluateSentinelPhase(state, collected.metrics, now, config);
  if (evaluation.transition) emit(phaseTransitionEvent(evaluation.transition));
  if (evaluation.directive) emit(directiveEvent(evaluation.directive));
  return evaluation;
}

describe('活动监视器全链（mock 事件流 → 相位迁移 → 降级指令 → ⑭）', () => {
  it('8 天生命周期：normal → degraded → recovering → normal，指令随相位、事件可按 source=sentinel 读回', async () => {
    const script: Array<'healthy' | 'warn' | 'crit'> = [
      'healthy',
      'crit',
      'warn',
      'healthy',
      'healthy',
      'healthy',
      'healthy',
      'healthy',
    ];
    const port = createStaticStatsProvider(script.map((kind, index) => dayStats(index + 1, kind)));
    const { rows, emit } = createCollector('sentinel-int');
    let state = createSentinelPhaseState(T(1));

    const evaluations = [];
    for (let day = 1; day <= script.length; day++) {
      const evaluation = await runDay(state, port, T(day), emit);
      evaluations.push(evaluation);
      state = evaluation.state;
    }

    // 相位轨迹（滞回 + 连续回正 + 驻留共同决定）
    expect(evaluations.map((e) => e.state.phase)).toEqual([
      'normal',
      'degraded',
      'degraded',
      'degraded',
      'degraded',
      'recovering',
      'recovering',
      'normal',
    ]);

    // 迁移只在 3 个日子发生
    const transitions = evaluations.map((e) => e.transition).filter((t): t is NonNullable<typeof t> => t !== null);
    expect(transitions).toEqual([
      expect.objectContaining({ from: 'normal', to: 'degraded', reason: 'ignore-rate-critical', day: '2026-10-2' }),
      expect.objectContaining({ from: 'degraded', to: 'recovering', reason: 'healthy-recovery', day: '2026-10-6' }),
      expect.objectContaining({ from: 'recovering', to: 'normal', reason: 'recovering-stabilized', day: '2026-10-8' }),
    ]);

    // 降级指令（消费方 W11 按 clampBroadcastTier 压 09 四档）
    const directives = evaluations.map((e) => e.directive);
    expect(directives[0]).toBeNull(); // D1 normal
    expect(directives[1]).toMatchObject({ action: 'store-only', maxTier: 'STORE', speakAllowed: false });
    expect(directives[2]).toMatchObject({ action: 'store-only' }); // 滞回带内不松闸
    expect(directives[5]).toMatchObject({ action: 'reduce-frequency', maxTier: 'SPEAK', speechFactor: 0.5 });
    expect(directives[7]).toBeNull();

    expect(directives[1] && clampBroadcastTier('SPEAK', directives[1].maxTier)).toBe('STORE');
    expect(directives[1] && clampBroadcastTier('PREPARE', directives[1].maxTier)).toBe('STORE');

    // ⑭ 通道：全部行 source=sentinel / body.cat=sentinel；迁移 3 + 指令 6（D2..D7 每天一次）
    expect(rows.length).toBe(3 + 6);
    expect(rows.every((row) => row.category === 'system')).toBe(true);
    expect(rows.every((row) => row.fields.source === 'sentinel')).toBe(true);
    expect(rows.every((row) => row.fields.body.cat === 'sentinel' && row.fields.body.channel === 'sentinel-int')).toBe(true);

    const transitionRows = rows.filter((row) => row.fields.body.kind === 'sentinel.phase.transition');
    expect(transitionRows).toHaveLength(3);
    expect(transitionRows[0].fields.level).toBe('warn'); // 进入 degraded 记 warn
    expect(transitionRows[0].fields.body).toMatchObject({ fromPhase: 'normal', toPhase: 'degraded', verdict: 'critical' });

    const directiveRows = rows.filter((row) => row.fields.body.kind === 'sentinel.directive');
    expect(directiveRows).toHaveLength(6);
    expect(directiveRows[0].fields.body.directive).toMatchObject({ action: 'store-only' });
  });

  it('数据缺口（端口无该日数据）：缺源不判、续链清零、存量指令不中断、恢复被如实推后', async () => {
    // D1 crit 进降级；D2/D3 回正；**D4 缺数据（快照表里缺这一天）**；D5/D6/D7 回正。
    // 无缺口时 D2..D4 攒满 3 天、D4 即可进 recovering；缺口清零后最早 D7 才恢复。
    const days = [1, 2, 3, 5, 6, 7]; // 第 4 天缺席
    const kinds: Array<'healthy' | 'crit'> = ['crit', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy'];
    const port = createStaticStatsProvider(days.map((day, index) => dayStats(day, kinds[index])));
    const { rows, emit } = createCollector('sentinel-gap');
    let state = createSentinelPhaseState(T(1));
    const phases: string[] = [];

    for (let day = 1; day <= 7; day++) {
      const evaluation = await runDay(state, port, T(day), emit);
      state = evaluation.state;
      phases.push(state.phase);
      if (day === 4) {
        expect(evaluation.skippedReason).toBe('insufficient-metrics');
        expect(evaluation.state.healthyStreakDays).toBe(0); // D2/D3 攒的 2 天被缺口清零
        expect(evaluation.directive).toMatchObject({ action: 'store-only' }); // 保护不中断
      }
      if (day === 6) {
        expect(evaluation.state.phase).toBe('degraded'); // 不误恢复（streak 2 < N=3）
        expect(evaluation.transition).toBeNull();
      }
    }

    expect(phases).toEqual([
      'degraded',
      'degraded',
      'degraded',
      'degraded', // 缺口日：保持
      'degraded',
      'degraded',
      'recovering', // 缺口后重新攒满 3 天（D5..D7）才恢复
    ]);
    expect(state).toMatchObject({ phase: 'recovering', healthyStreakDays: 3 });
    const transitions = rows.filter((row) => row.fields.body.kind === 'sentinel.phase.transition');
    expect(transitions).toHaveLength(2); // D1 进 degraded、D7 进 recovering
    expect(transitions[1].fields.body).toMatchObject({
      day: '2026-10-7',
      toPhase: 'recovering',
      transitionReason: 'healthy-recovery',
    });
  });

  it('失败隔离：端口未接线 → 全链不缺数据也不抛；⑭ 上报 stats.degraded（缺源如实）', async () => {
    const { rows, emit } = createCollector('sentinel-unwired');
    let state = createSentinelPhaseState(T(1));

    const first = await runDay(state, createUnavailableStatsProvider(), T(1), emit);
    state = first.state;
    expect(first.skippedReason).toBe('insufficient-metrics');
    expect(state.phase).toBe('normal');

    const boom = await runDay(
      state,
      {
        readDay: () => {
          throw new Error('stats db down');
        },
      },
      T(2),
      emit,
    );
    expect(boom.skippedReason).toBe('insufficient-metrics');
    expect(boom.state.phase).toBe('normal');
    expect(boom.state.updatedAt).toBe(T(1)); // 失败不登记评估

    const degradedRows = rows.filter((row) => row.fields.body.kind === 'sentinel.stats.degraded');
    expect(degradedRows).toHaveLength(1);
    expect(degradedRows[0].fields.body).toMatchObject({ degradeReason: 'port_error' });
  });

  it('自愈闭环：mock「问三遍 + 反复误判」→ 降级道歉建议 → ⑭ warn 事件', () => {
    const now = T(3);
    const events = [
      { at: now - 9 * 60_000, kind: 'user-request' as const, text: '帮我查一下明天的天气' },
      { at: now - 8 * 60_000, kind: 'user-request' as const, text: '帮我查一下明天的天气！' },
      { at: now - 7 * 60_000, kind: 'user-request' as const, text: '帮我查一下明天天气' },
      { at: now - 5 * 60_000, kind: 'misjudge' as const, text: '把项目A认成了项目B', topicKey: 'proj-mixup' },
      { at: now - 4 * 60_000, kind: 'misjudge' as const, text: '又把项目A当成项目B了', topicKey: 'proj-mixup' },
    ];
    const suggestions = detectSelfHeal(events, now);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({ reason: 'repeated-request', count: 3, maxTier: 'STORE' });
    expect(suggestions[1]).toMatchObject({ reason: 'repeated-misjudge', count: 2, maxTier: 'STORE' });
    // 建议对象只带事实与方向；文案生成不在本波（"说清哪里错、不狡辩"见 self-heal.ts 注释）

    const { rows, emit } = createCollector('sentinel-selfheal');
    for (const suggestion of suggestions) emit(selfHealEvent(suggestion));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.fields.level === 'warn')).toBe(true);
    expect(rows[0].fields.body).toMatchObject({ kind: 'sentinel.self-heal.suggested', selfHealCount: 3 });
  });

  it('开关关：整日循环零行为变化（相位不动、无指令、无 ⑭）', async () => {
    const port = createStaticStatsProvider([dayStats(1, 'crit')]);
    const { rows, emit } = createCollector('sentinel-off');
    const state = createSentinelPhaseState(T(1));
    const evaluation = await runDay(state, port, T(1), emit, { enabled: false });
    expect(evaluation.skippedReason).toBe('disabled');
    expect(evaluation.state).toEqual(state);
    expect(evaluation.directive).toBeNull();
    expect(rows).toEqual([]);
  });
});
