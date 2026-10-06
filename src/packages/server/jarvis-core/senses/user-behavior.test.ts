/**
 * jarvis-core · 感知层信号源 6/6：用户行为单测（任务 30 第 6 路补齐）
 *
 * 覆盖：首次基线（在场/无记录两种）不产信号；离开 → 回来产一条 user_returned
 * （text/dedupeKey/payload/评分形状齐备）；在场持续活动、窗口外、持续离开均不产；
 * 与 time-context 的分工（语音回来的 ≥2h 长离开/时长不详不产，非语音回来照常产）；
 * 阈值可覆盖；注入时钟；端口抛错/畸形数据安全降级；独立开关（环境变量）。
 *
 * 评分档位（重要，见源文件头「评分与播报档位」）：本信号 61 分 = 0.5*40 + 0.3*75
 * + 0.2*90，≥ relevanceThreshold(60) 不至于 SILENT、≤ immediateScore(85) 且非
 * timeSensitive 永不 SPEAK。真实公式（shared/broadcast-gates.ts decideBroadcast）里
 * STORE 的唯一入口是预算耗尽（budget_exhausted）：缺省预算用满 → STORE（只登记），
 * 预算充足 → PREPARE（攒批）——两种都不抢即时口播，这是有意选择。
 * 证据等级 L1（mock 注入；真链路未接）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeRelevanceScore, createGatesState, decideBroadcast } from '../../../shared/broadcast-gates.js';
import { normalizeSignal } from '../signal-queue.js';
import { SENSE_ENV_KEYS } from './types.js';
import { createUserBehaviorSense, type UserBehaviorPort } from './user-behavior.js';

const MIN = 60_000;

/** 本地 2026-01-15（周四）14:00 —— 避开深夜（23:00–07:00）与 focus（09:00–11:00）降级分支。 */
const T0 = new Date(2026, 0, 15, 14, 0, 0).getTime();

afterEach(() => {
  vi.unstubAllEnvs();
});

interface MutablePort {
  port: UserBehaviorPort;
  /** 模拟用户又有活动（同时更新说话时戳）。 */
  set(activityAt: number | null, speechAt?: number | null): void;
  calls(): number;
}

/** 可变探针：读账本快照的 mock（activityAt 可控，模拟「用户又动了」/「一直没动」）。 */
function mutablePort(initialActivityAt: number | null): MutablePort {
  let activityAt = initialActivityAt;
  let speechAt: number | null = initialActivityAt;
  let calls = 0;
  return {
    calls: () => calls,
    set: (nextActivityAt, nextSpeechAt = nextActivityAt) => {
      activityAt = nextActivityAt;
      speechAt = nextSpeechAt;
    },
    port: {
      read: () => {
        calls++;
        return { lastActivityAt: activityAt, lastSpeechAt: speechAt };
      },
    },
  };
}

describe('信号源 user-behavior（活动账本端口）', () => {
  it('源元信息：name/source/trigger/缺省 enabled', () => {
    const sense = createUserBehaviorSense(mutablePort(T0).port);
    expect(sense.name).toBe('user-behavior');
    expect(sense.source).toBe('user');
    expect(sense.trigger).toBe('heartbeat');
    expect(sense.enabled).toBe(true);
  });

  it('首次采集只建基线（在场基线不产信号）；持续活动不产', async () => {
    const { port, set } = mutablePort(T0);
    const sense = createUserBehaviorSense(port);
    expect(await sense.collect(T0)).toEqual({ signals: [] }); // 基线：gap=0 → 在场

    set(T0 + MIN);
    expect(await sense.collect(T0 + MIN)).toEqual({ signals: [] });
    set(T0 + 2 * MIN);
    expect(await sense.collect(T0 + 2 * MIN)).toEqual({ signals: [] });
  });

  it('无记录基线（重启期账本空）→ 离开态；再活动即报 user_returned（时长不详）', async () => {
    const { port, set } = mutablePort(null);
    const sense = createUserBehaviorSense(port);
    expect(await sense.collect(T0)).toEqual({ signals: [] }); // 基线：无记录 → 离开态

    set(T0 + 5 * MIN, null); // 回来是输入类活动（没说话）→ 归本源
    const at = T0 + 5 * MIN + 1_000;
    const reading = await sense.collect(at);
    expect(reading.signals).toHaveLength(1);
    const signal = reading.signals[0]!;
    expect(signal.source).toBe('user');
    expect(signal.kind).toBe('user_returned');
    expect(signal.ts).toBe(at);
    expect(signal.dedupeKey).toBe(`user-returned@${Math.floor(at / MIN)}`);
    expect(signal.text).toBe('老板回来了(离开时长不详)');
    expect(signal.payload).toEqual({ awayMs: null });
  });

  it('离开 → 回来产一条（text/dedupeKey/payload/评分）；回来后在场不重复产', async () => {
    const { port, set } = mutablePort(T0);
    const sense = createUserBehaviorSense(port);
    await sense.collect(T0); // 在场基线

    // 用户不再活动：31 分钟后心跳 → 记「离开」，不产信号
    expect((await sense.collect(T0 + 31 * MIN)).signals).toEqual([]);

    // 用户回来（活动在 T0+45min），心跳在 30 秒后看到 → 产 user_returned
    set(T0 + 45 * MIN);
    const at = T0 + 45 * MIN + 30_000;
    const reading = await sense.collect(at);
    expect(reading.signals).toHaveLength(1);
    const signal = reading.signals[0]!;
    expect(signal.source).toBe('user');
    expect(signal.kind).toBe('user_returned');
    expect(signal.ts).toBe(at);
    expect(signal.text).toBe('老板回来了(离开了约 45 分钟)'); // 两次活动间隔 T0 → T0+45min
    expect(signal.dedupeKey).toBe(`user-returned@${Math.floor(at / MIN)}`);
    expect(signal.payload).toEqual({ awayMs: 45 * MIN });
    expect(signal.urgency).toBe(40);
    expect(signal.relevance).toBe(75);
    expect(signal.certainty).toBe(90);

    // 回来后持续在场：不再产
    set(T0 + 46 * MIN);
    expect((await sense.collect(T0 + 46 * MIN)).signals).toEqual([]);
  });

  it('与 time-context 分工（防双报）：语音回来的 ≥2h 长离开不产；非语音回来照常产', async () => {
    // ① 语音证据（活动=说话，同一爆发内）+ 离开 ≥2h → 归 time-context 的 time_user_returned
    const voiceA = mutablePort(T0);
    const senseA = createUserBehaviorSense(voiceA.port);
    await senseA.collect(T0); // 在场基线
    await senseA.collect(T0 + 31 * MIN); // → 离开态（preAway=T0）
    voiceA.set(T0 + 130 * MIN); // 语音回来
    expect((await senseA.collect(T0 + 130 * MIN + 30_000)).signals).toEqual([]);
    // 离开态已消：随后继续在场不再补报
    voiceA.set(T0 + 131 * MIN);
    expect((await senseA.collect(T0 + 131 * MIN)).signals).toEqual([]);

    // ② 同类长离开但回来没说话（输入/焦点）→ 归本源，照常产
    const voiceB = mutablePort(T0);
    const senseB = createUserBehaviorSense(voiceB.port);
    await senseB.collect(T0);
    await senseB.collect(T0 + 31 * MIN);
    voiceB.set(T0 + 130 * MIN, null);
    const reading = await senseB.collect(T0 + 130 * MIN + 30_000);
    expect(reading.signals).toHaveLength(1);
    expect(reading.signals[0]!.text).toBe('老板回来了(离开了约 130 分钟)');

    // ③ 时长不详（重启期账本空）+ 语音回来 → 也归 time-context（信息量低，宁缺）
    const voiceC = mutablePort(null);
    const senseC = createUserBehaviorSense(voiceC.port);
    await senseC.collect(T0); // 无记录 → 离开态
    voiceC.set(T0 + 5 * MIN); // 语音回来
    expect((await senseC.collect(T0 + 5 * MIN + 1_000)).signals).toEqual([]);
  });

  it('窗口外（activeWindow 与 awayThreshold 之间）不产信号', async () => {
    // 在场态：gap 10 分钟（>2 分钟、<30 分钟）→ 不产
    const present = mutablePort(T0);
    const sense = createUserBehaviorSense(present.port);
    await sense.collect(T0);
    expect((await sense.collect(T0 + 10 * MIN)).signals).toEqual([]);

    // 离开态：用户 10 分钟前有活动但不在 2 分钟窗口内 → 仍不报（回来要「刚发生」才算）
    const away = mutablePort(T0);
    const awaySense = createUserBehaviorSense(away.port);
    await awaySense.collect(T0);
    await awaySense.collect(T0 + 31 * MIN); // → 离开态
    away.set(T0 + 50 * MIN);
    expect((await awaySense.collect(T0 + 55 * MIN)).signals).toEqual([]); // gap=5min
    away.set(T0 + 55 * MIN + 1_000);
    const back = await awaySense.collect(T0 + 55 * MIN + 1_000); // gap≈0 → 补报
    expect(back.signals.map((s) => s.kind)).toEqual(['user_returned']);
    expect(back.signals[0]!.payload).toEqual({ awayMs: 55 * MIN + 1_000 });
  });

  it('持续离开不重复产信号（同一离开事件只报回来一次）', async () => {
    const { port } = mutablePort(T0);
    const sense = createUserBehaviorSense(port);
    await sense.collect(T0);
    expect((await sense.collect(T0 + 31 * MIN)).signals).toEqual([]);
    expect((await sense.collect(T0 + 61 * MIN)).signals).toEqual([]);
    expect((await sense.collect(T0 + 91 * MIN)).signals).toEqual([]);
  });

  it('阈值可覆盖（awayThresholdMs / activeWindowMs）', async () => {
    const { port, set } = mutablePort(T0);
    const sense = createUserBehaviorSense(port, { awayThresholdMs: 5 * MIN, activeWindowMs: 30_000 });
    await sense.collect(T0); // 在场基线
    expect((await sense.collect(T0 + 6 * MIN)).signals).toEqual([]); // 6min ≥ 5min → 离开
    set(T0 + 7 * MIN);
    const reading = await sense.collect(T0 + 7 * MIN + 10_000); // gap=10s ≤ 30s
    expect(reading.signals).toHaveLength(1);
    expect(reading.signals[0]!.text).toBe('老板回来了(离开了约 7 分钟)');
  });

  it('注入时钟优先（options.now 覆盖 collect 入参；接线层同源时二者一致）', async () => {
    const { port, set } = mutablePort(T0);
    const clockAt = T0 + 45 * MIN;
    const sense = createUserBehaviorSense(port, { now: () => clockAt });
    await sense.collect(T0); // 基线按注入时钟：gap=45min → 离开态
    set(clockAt);
    const reading = await sense.collect(T0); // collect 入参被注入时钟覆盖
    expect(reading.signals).toHaveLength(1);
    expect(reading.signals[0]!.ts).toBe(clockAt);
    expect(reading.signals[0]!.dedupeKey).toBe(`user-returned@${Math.floor(clockAt / MIN)}`);
  });

  it('端口抛错 / 畸形数据 → 安全缺省 + 记因（永不抛出，且不推进基线）', async () => {
    const boom = createUserBehaviorSense({
      read: () => {
        throw new Error('ledger boom');
      },
    });
    expect(await boom.collect(T0)).toMatchObject({ signals: [], degraded: { reason: 'port_error' } });

    const notRecord = createUserBehaviorSense({ read: () => 'nope' as never });
    expect(await notRecord.collect(T0)).toMatchObject({ signals: [], degraded: { reason: 'malformed_data' } });

    const badStamp = createUserBehaviorSense({
      read: () => ({ lastActivityAt: 'soon', lastSpeechAt: null }) as never,
    });
    expect(await badStamp.collect(T0)).toMatchObject({ signals: [], degraded: { reason: 'malformed_data' } });

    // 首次采集畸形 = 未建基线：修好后首次成功采集仍按「首次」处理（只建基线，不产信号）
    let broken = true;
    const flaky = createUserBehaviorSense({
      read: () => {
        if (broken) throw new Error('boom');
        return { lastActivityAt: T0, lastSpeechAt: T0 };
      },
    });
    await flaky.collect(T0);
    broken = false;
    expect(await flaky.collect(T0 + MIN)).toEqual({ signals: [] });
  });

  it('独立开关：TC_JARVIS_SENSE_USER_BEHAVIOR=0 → enabled=false，零采集零产出', async () => {
    vi.stubEnv(SENSE_ENV_KEYS['user-behavior'], '0');
    const spy = vi.fn(() => ({ lastActivityAt: T0, lastSpeechAt: T0 }));
    const sense = createUserBehaviorSense({ read: spy });
    expect(sense.enabled).toBe(false);
    expect(await sense.collect(T0)).toEqual({ signals: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('评分与播报档位：61 分；预算充足落 PREPARE、预算耗尽落 STORE（真实公式下不抢口播）', async () => {
    const { port, set } = mutablePort(T0 - 40 * MIN);
    const sense = createUserBehaviorSense(port);
    await sense.collect(T0 - 40 * MIN); // 在场基线
    expect((await sense.collect(T0 - 5 * MIN)).signals).toEqual([]); // gap=35min → 离开态
    set(T0);
    const reading = await sense.collect(T0); // 刚回来（gap=0）
    expect(reading.signals).toHaveLength(1);
    const signal = normalizeSignal(reading.signals[0]!, T0);

    // 真实评分公式：0.5*urgency + 0.3*relevance + 0.2*certainty
    expect(computeRelevanceScore(signal)).toBe(61); // 0.5*40 + 0.3*75 + 0.2*90 = 60.5 → 61

    // 预算充足（缺省配置）：非 urgent、非 timeSensitive → PREPARE（攒批），永不 SPEAK
    const fresh = decideBroadcast(signal, createGatesState({ now: T0 }));
    expect(fresh.tier).toBe('PREPARE');
    expect(fresh.reason).toBe('batched');

    // 预算耗尽（缺省 baseDailyBudget 用满）：STORE —— 真实公式里 STORE 的唯一入口。
    // 「你回来了」只登记不口播的有意选择：61 分先过闸门①（≥60，不 SILENT），
    // 再由预算硬顶落 STORE；若预算尚未耗尽只会攒批（PREPARE），绝不即时 SPEAK。
    const defaultState = createGatesState({ now: T0 });
    const exhausted = { ...defaultState, spokenToday: defaultState.config.baseDailyBudget };
    const stored = decideBroadcast(signal, exhausted);
    expect(stored.tier).toBe('STORE');
    expect(stored.reason).toBe('budget_exhausted');
    expect(stored.score).toBe(61);
  });
});
