import { describe, it, expect } from 'vitest';
import {
  decideBroadcast,
  createGatesState,
  applyGatesDelta,
  adaptiveDailyBudget,
  computeRelevanceScore,
  evaluateDisruption,
  minutesOfDay,
  isWithinWindow,
  DEFAULT_GATES_CONFIG,
  DISRUPTION_FACTORS,
  RELEVANCE_THRESHOLD,
  DISRUPTION_THRESHOLD,
  BASE_DAILY_BUDGET,
  SPEECH_SUB_QUOTA,
  type BroadcastDecision,
  type GatesState,
  type GatesStateOverrides,
  type Signal,
} from './broadcast-gates.js';

// 全部用本地时区构造,保证任意时区下断言一致。
const DAY = new Date(2026, 5, 3, 14, 0).getTime(); // 周三 14:00
const NIGHT = new Date(2026, 5, 3, 23, 30).getTime(); // 深夜
const FOCUS = new Date(2026, 5, 3, 9, 30).getTime(); // focus time(09:00–11:00)内

function sig(overrides: Partial<Signal> = {}): Signal {
  return { source: 'agent', kind: 'agent_completed', ts: DAY, dedupeKey: 'k1', score: 70, ...overrides };
}

function st(overrides: GatesStateOverrides = {}): GatesState {
  return createGatesState({ now: DAY, ...overrides });
}

/** 「降级不丢」:被②③④拦下的出口至少是 PREPARE/STORE。 */
function expectNotDropped(d: BroadcastDecision): void {
  expect(['PREPARE', 'STORE']).toContain(d.tier);
}

describe('broadcast-gates · 06-11 §13.1 决策矩阵', () => {
  it('低分信号:score=40 → SILENT(闸门① 直接沉默)', () => {
    const d = decideBroadcast(sig({ score: 40 }), st());
    expect(d.tier).toBe('SILENT');
    expect(d.reason).toBe('low_relevance');
    expect(d.delta.dailySpokenDelta).toBe(0);
    expect(d.delta.instantSpeechDelta).toBe(0);
    // 仍记账 dedupeKey(事件被处理过一次)
    expect(d.delta.seenKeysToAdd).toEqual(['k1']);
  });

  it('高打扰:score=90 + 播报中 → 延后攒批(进队列),不丢弃', () => {
    const d = decideBroadcast(sig({ score: 90 }), st({ env: { speaking: true } }));
    expect(d.tier).toBe('PREPARE');
    expect(d.reason).toBe('high_disruption');
    expectNotDropped(d);
    expect(d.delta.dailySpokenDelta).toBe(1);
  });

  it('预算耗尽:已达日配额 + 普通事件 → STORE(降级不丢)', () => {
    const d = decideBroadcast(sig({ score: 70 }), st({ spokenToday: BASE_DAILY_BUDGET }));
    expect(d.tier).toBe('STORE');
    expect(d.reason).toBe('budget_exhausted');
    expect(d.delta.dailySpokenDelta).toBe(0);
    expect(d.delta.instantSpeechDelta).toBe(0);
  });

  it('紧急事件:score=92 + 深夜 → SPEAK(>90 破例)', () => {
    const d = decideBroadcast(sig({ score: 92 }), st({ now: NIGHT }));
    expect(d.tier).toBe('SPEAK');
    expect(d.reason).toBe('urgent');
    expect(d.disruption).toBe(90); // 深夜系数照常上报
    expect(d.delta.instantSpeechDelta).toBe(1);
  });

  it('幂等:同一 dedupeKey 两次 → 只处理一次,不重复记账', () => {
    const s0 = st();
    const first = decideBroadcast(sig({ dedupeKey: 'same-key' }), s0);
    expect(first.duplicate).toBe(false);
    expect(first.delta.seenKeysToAdd).toEqual(['same-key']);

    const s1 = applyGatesDelta(s0, first.delta);
    const second = decideBroadcast(sig({ dedupeKey: 'same-key' }), s1);
    expect(second.tier).toBe('SILENT');
    expect(second.reason).toBe('duplicate');
    expect(second.duplicate).toBe(true);
    expect(second.delta.seenKeysToAdd).toHaveLength(0);
    expect(second.delta.dailySpokenDelta).toBe(0);
    expect(second.delta.instantSpeechDelta).toBe(0);
    // 状态只见一次消费
    expect(s1.spokenToday).toBe(s0.spokenToday + 1);
  });

  it('预算自适应:周忽略率 60% → 配额降 30% 并参与判定', () => {
    const stats = { broadcasts: 10, ignored: 6, adopted: 1 };
    expect(adaptiveDailyBudget(stats)).toBe(7);
    // 默认预算下 spokenToday=7 还能攒批;自适应用尽后 → STORE
    expect(decideBroadcast(sig(), st({ spokenToday: 7 })).tier).toBe('PREPARE');
    expect(decideBroadcast(sig(), st({ spokenToday: 7, stats })).tier).toBe('STORE');
  });
});

describe('broadcast-gates · 闸门② 打扰度(含深夜)', () => {
  it('环境系数:各因素取最大,空闲基线 20', () => {
    expect(evaluateDisruption({})).toBe(DISRUPTION_FACTORS.idle);
    expect(evaluateDisruption({ speaking: true })).toBe(100);
    expect(evaluateDisruption({ videoMeeting: true })).toBe(85);
    expect(evaluateDisruption({ fullscreen: true })).toBe(80);
    expect(evaluateDisruption({ recentInput: true })).toBe(75);
    expect(evaluateDisruption({ justSpokeSecondsAgo: 10 })).toBe(60);
    expect(evaluateDisruption({ justSpokeSecondsAgo: 11 })).toBe(20);
    expect(evaluateDisruption({ fullscreen: true, recentInput: true })).toBe(80);
  });

  it('夜间事件被拦截 → 攒批而非丢弃', () => {
    const d = decideBroadcast(sig({ score: 80 }), st({ now: NIGHT }));
    expect(d.tier).toBe('PREPARE');
    expect(d.reason).toBe('deep_night');
    expectNotDropped(d);
    expect(d.delta.dailySpokenDelta).toBe(1);
  });

  it('忙碌事件(播报中)被拦截 → 攒批而非丢弃', () => {
    const d = decideBroadcast(sig({ score: 88 }), st({ env: { speaking: true } }));
    expect(d.tier).toBe('PREPARE');
    expect(d.reason).toBe('high_disruption');
    expectNotDropped(d);
  });

  it('深夜破例是严格 >90:90 拦、92 放', () => {
    expect(decideBroadcast(sig({ score: 90 }), st({ now: NIGHT })).tier).toBe('PREPARE');
    expect(decideBroadcast(sig({ score: 92 }), st({ now: NIGHT })).tier).toBe('SPEAK');
  });

  it('绝不插话优先于深夜破例:播报中 + 深夜 + 95 → 仍攒批', () => {
    const d = decideBroadcast(sig({ score: 95 }), st({ now: NIGHT, env: { speaking: true } }));
    expect(d.tier).toBe('PREPARE');
    expect(d.reason).toBe('high_disruption');
  });

  it('深夜窗口跨午夜:23:00–07:00(可配)', () => {
    const night = DEFAULT_GATES_CONFIG.deepNight;
    expect(isWithinWindow(23 * 60 + 30, night)).toBe(true);
    expect(isWithinWindow(6 * 60 + 59, night)).toBe(true);
    expect(isWithinWindow(7 * 60, night)).toBe(false);
    expect(isWithinWindow(12 * 60, night)).toBe(false);
    // 白天报告打扰度 = 环境系数,不加深夜系数
    expect(decideBroadcast(sig(), st({ now: DAY })).disruption).toBe(DISRUPTION_FACTORS.idle);
  });
});

describe('broadcast-gates · focus time 与闸门④ 时机', () => {
  it('focus time 内不主动播报:本应立即(88)的事件降级攒批;评分 >90 破例', () => {
    // 88 分非 focus 时立即说,focus 内被拦成攒批
    expect(decideBroadcast(sig({ score: 88 }), st()).tier).toBe('SPEAK');
    const blocked = decideBroadcast(sig({ score: 88 }), st({ now: FOCUS }));
    expect(blocked.tier).toBe('PREPARE');
    expect(blocked.reason).toBe('focus_time');
    expect(blocked.delta.dailySpokenDelta).toBe(1);
    // 普通事件(focus 不改变决策)仍是普通攒批,reason 如实报 batched
    expect(decideBroadcast(sig({ score: 80 }), st({ now: FOCUS })).reason).toBe('batched');
    // 破例线严格 >90
    expect(decideBroadcast(sig({ score: 90 }), st({ now: FOCUS })).reason).toBe('focus_time');
    expect(decideBroadcast(sig({ score: 92 }), st({ now: FOCUS })).tier).toBe('SPEAK');
  });

  it('focus 时段可配:自定义窗口生效,默认窗口不受影响', () => {
    const custom = { focusWindows: [{ startMinutes: 14 * 60, endMinutes: 15 * 60 }] };
    const d = decideBroadcast(sig({ score: 88 }), st({ config: custom }));
    expect(d.tier).toBe('PREPARE');
    expect(d.reason).toBe('focus_time');
    // 同一时刻、默认配置 → 无 focus,正常立即
    expect(decideBroadcast(sig({ score: 88 }), st()).tier).toBe('SPEAK');
  });

  it('闸门④:普通事件攒批,紧急(>85)立即,timeSensitive 立即', () => {
    expect(decideBroadcast(sig({ score: 70 }), st()).reason).toBe('batched');
    expect(decideBroadcast(sig({ score: 85 }), st()).reason).toBe('batched');
    expect(decideBroadcast(sig({ score: 86 }), st()).reason).toBe('urgent');
    expect(decideBroadcast(sig({ score: 70, timeSensitive: true }), st()).reason).toBe(
      'time_sensitive',
    );
    expect(decideBroadcast(sig({ score: 70, timeSensitive: true }), st()).tier).toBe('SPEAK');
  });
});

describe('broadcast-gates · 闸门③ 预算与口播子配额', () => {
  it('记账口径:SPEAK 占主预算 + 子配额,PREPARE 只占主预算,STORE 不占', () => {
    const speak = decideBroadcast(sig({ score: 92 }), st());
    expect(speak.tier).toBe('SPEAK');
    expect(speak.delta.dailySpokenDelta).toBe(1);
    expect(speak.delta.instantSpeechDelta).toBe(1);

    const prepare = decideBroadcast(sig({ score: 70 }), st());
    expect(prepare.tier).toBe('PREPARE');
    expect(prepare.delta.dailySpokenDelta).toBe(1);
    expect(prepare.delta.instantSpeechDelta).toBe(0);

    const store = decideBroadcast(sig({ score: 70 }), st({ spokenToday: BASE_DAILY_BUDGET }));
    expect(store.tier).toBe('STORE');
    expect(store.delta.dailySpokenDelta).toBe(0);
    expect(store.delta.instantSpeechDelta).toBe(0);
  });

  it('口播子配额用尽 → 紧急事件降级攒批(攒批不占子配额)', () => {
    const d = decideBroadcast(sig({ score: 92 }), st({ instantSpeakToday: SPEECH_SUB_QUOTA }));
    expect(d.tier).toBe('PREPARE');
    expect(d.reason).toBe('speech_quota_exhausted');
    expect(d.delta.dailySpokenDelta).toBe(1);
    expect(d.delta.instantSpeechDelta).toBe(0);
    // 还剩一格 → 正常口播
    const ok = decideBroadcast(sig({ score: 92 }), st({ instantSpeakToday: SPEECH_SUB_QUOTA - 1 }));
    expect(ok.tier).toBe('SPEAK');
  });

  it('预算用尽对紧急事件同样生效(无预算豁免)→ STORE', () => {
    const d = decideBroadcast(sig({ score: 95 }), st({ spokenToday: BASE_DAILY_BUDGET }));
    expect(d.tier).toBe('STORE');
    expect(d.reason).toBe('budget_exhausted');
  });

  it('预算硬顶优先于打扰分支:at-quota + 忙碌(speaking)→ STORE,不超发', () => {
    const d = decideBroadcast(
      sig({ score: 92 }),
      st({ spokenToday: BASE_DAILY_BUDGET, env: { speaking: true } }),
    );
    expect(d.tier).toBe('STORE');
    expect(d.reason).toBe('budget_exhausted');
    expect(d.delta.dailySpokenDelta).toBe(0);
    expect(d.delta.instantSpeechDelta).toBe(0);
  });

  it('预算硬顶优先于深夜分支:at-quota + 深夜 → STORE,不超发', () => {
    const d = decideBroadcast(
      sig({ score: 80 }),
      st({ now: NIGHT, spokenToday: BASE_DAILY_BUDGET }),
    );
    expect(d.tier).toBe('STORE');
    expect(d.reason).toBe('budget_exhausted');
    expect(d.delta.dailySpokenDelta).toBe(0);
    expect(d.delta.instantSpeechDelta).toBe(0);
  });

  it('at-quota + 忙碌连发 5 条:全部 STORE 且预算不再增长(无界超发回归)', () => {
    let s = st({ spokenToday: BASE_DAILY_BUDGET, env: { speaking: true } });
    for (let i = 1; i <= 5; i++) {
      const d = decideBroadcast(sig({ dedupeKey: `busy${i}`, score: 92 }), s);
      expect(d.tier).toBe('STORE');
      expect(d.delta.dailySpokenDelta).toBe(0);
      s = applyGatesDelta(s, d.delta);
    }
    expect(s.spokenToday).toBe(BASE_DAILY_BUDGET);
  });

  it('自适应预算:降 30% / 提 20% / 阈值边界 / 上限钳制', () => {
    expect(adaptiveDailyBudget({ broadcasts: 10, ignored: 6, adopted: 1 })).toBe(7); // 60% → 10×0.7
    expect(adaptiveDailyBudget({ broadcasts: 10, ignored: 1, adopted: 9 })).toBe(12); // 90% → 10×1.2
    expect(adaptiveDailyBudget({ broadcasts: 10, ignored: 5, adopted: 1 })).toBe(10); // 恰好 50% 不降(严格 >)
    expect(adaptiveDailyBudget({ broadcasts: 10, ignored: 0, adopted: 8 })).toBe(10); // 恰好 80% 不提(严格 >)
    expect(adaptiveDailyBudget({ broadcasts: 0, ignored: 0, adopted: 0 })).toBe(10); // 无样本不动
    // 上限 50
    expect(
      adaptiveDailyBudget(
        { broadcasts: 10, ignored: 0, adopted: 10 },
        { ...DEFAULT_GATES_CONFIG, baseDailyBudget: 50 },
      ),
    ).toBe(50);
  });

  it('喂状态循环 11 条普通事件:第 11 条因预算用尽落 STORE', () => {
    let s = st();
    for (let i = 1; i <= BASE_DAILY_BUDGET; i++) {
      const d = decideBroadcast(sig({ dedupeKey: `e${i}` }), s);
      expect(d.tier).toBe('PREPARE');
      s = applyGatesDelta(s, d.delta);
    }
    expect(s.spokenToday).toBe(BASE_DAILY_BUDGET);
    const eleventh = decideBroadcast(sig({ dedupeKey: 'e11' }), s);
    expect(eleventh.tier).toBe('STORE');
    expect(eleventh.reason).toBe('budget_exhausted');
  });
});

describe('broadcast-gates · 评分与状态工具', () => {
  it('显式 score 优先;分量按 0.5/0.3/0.2 加权;缺省分量取中性 50', () => {
    expect(computeRelevanceScore({ score: 40, urgency: 100, relevance: 100, certainty: 100 })).toBe(40);
    expect(computeRelevanceScore({ urgency: 90, relevance: 100, certainty: 100 })).toBe(95); // 45+30+20
    expect(computeRelevanceScore({})).toBe(50); // 中性默认 → 仍低于阈值
    expect(decideBroadcast(sig({ score: 40 }), st()).tier).toBe('SILENT');
  });

  it('评分钳制到 0–100,非法值按 0', () => {
    expect(computeRelevanceScore({ score: 150 })).toBe(100);
    expect(computeRelevanceScore({ score: -5 })).toBe(0);
    expect(computeRelevanceScore({ score: Number.NaN })).toBe(0);
    expect(computeRelevanceScore({ urgency: 999, relevance: -3, certainty: 50 })).toBe(
      Math.round(0.5 * 100 + 0.3 * 0 + 0.2 * 50),
    );
  });

  it('分钟工具:minutesOfDay 与窗口边界', () => {
    expect(minutesOfDay(DAY)).toBe(14 * 60);
    const focus = DEFAULT_GATES_CONFIG.focusWindows[0];
    expect(isWithinWindow(9 * 60, focus)).toBe(true);
    expect(isWithinWindow(11 * 60, focus)).toBe(false); // [start, end)
    expect(isWithinWindow(0, { startMinutes: 0, endMinutes: 0 })).toBe(false); // 空窗口
  });

  it('createGatesState:默认值可覆盖,嵌套 config 合并不丢其余默认', () => {
    const s = createGatesState();
    expect(s.config.relevanceThreshold).toBe(RELEVANCE_THRESHOLD);
    expect(s.config.disruptionThreshold).toBe(DISRUPTION_THRESHOLD);
    expect(s.config.baseDailyBudget).toBe(BASE_DAILY_BUDGET);
    expect(s.config.speechSubQuota).toBe(SPEECH_SUB_QUOTA);
    expect(s.stats).toEqual({ broadcasts: 0, ignored: 0, adopted: 0 });

    const custom = createGatesState({ config: { relevanceThreshold: 80 } });
    expect(custom.config.relevanceThreshold).toBe(80);
    expect(custom.config.focusWindows).toEqual(DEFAULT_GATES_CONFIG.focusWindows);
  });

  it('applyGatesDelta:纯函数(不改原状态),计数与去重键正确累加', () => {
    const s0 = st({ seenKeys: ['old'], spokenToday: 3, instantSpeakToday: 1 });
    const s1 = applyGatesDelta(s0, { seenKeysToAdd: ['x'], dailySpokenDelta: 1, instantSpeechDelta: 1 });
    expect(s0.seenKeys).toEqual(['old']);
    expect(s0.spokenToday).toBe(3);
    expect(s0.instantSpeakToday).toBe(1);
    expect(s1.seenKeys).toEqual(['old', 'x']);
    expect(s1.spokenToday).toBe(4);
    expect(s1.instantSpeakToday).toBe(2);
  });
});

describe('broadcast-gates · 沉默 ≠ 丢弃(降级不丢不变量)', () => {
  it('被②③④拦下的事件至少落 PREPARE/STORE,绝不 SILENT', () => {
    const scenarios: Array<[string, Signal, GatesState]> = [
      ['高打扰', sig({ score: 90 }), st({ env: { speaking: true } })],
      ['深夜', sig({ score: 80 }), st({ now: NIGHT })],
      ['focus time', sig({ score: 80 }), st({ now: FOCUS })],
      ['预算用尽', sig({ score: 70 }), st({ spokenToday: BASE_DAILY_BUDGET })],
      ['子配额用尽', sig({ score: 92 }), st({ instantSpeakToday: SPEECH_SUB_QUOTA })],
    ];
    for (const [name, signal, state] of scenarios) {
      const d = decideBroadcast(signal, state);
      expect(['PREPARE', 'STORE'], name).toContain(d.tier);
      expect(d.delta.seenKeysToAdd, name).toEqual([signal.dedupeKey]);
    }
  });

  it('SILENT 仅限两种理由:相关性过低 / 重复(其余一律有出口)', () => {
    expect(decideBroadcast(sig({ score: 40 }), st()).reason).toBe('low_relevance');
    const first = decideBroadcast(sig({ dedupeKey: 'dup' }), st());
    const s1 = applyGatesDelta(st(), first.delta);
    expect(decideBroadcast(sig({ dedupeKey: 'dup' }), s1).reason).toBe('duplicate');
  });
});
