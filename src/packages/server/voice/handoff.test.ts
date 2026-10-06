import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECENT_TURNS_MAX,
  RECENT_TURN_MAX_CHARS,
  RECENT_TURNS_TOTAL_CHARS,
  HANDOFF_TEXT_MAX_CHARS,
  HANDOFF_TTL_MS,
  normalizeTurnText,
  appendRecentTurn,
  sanitizeRecentTurns,
  isHandoffEnabled,
  shouldPregenHandoff,
  buildHandoffUserContent,
  cleanHandoffText,
  handoffRenderable,
  handoffObservation,
  type RecentTurn,
  type HandoffNote,
  type HandoffPregenRuntime,
} from './handoff.js';

function turn(role: 'user' | 'assistant', text: string, extra: Partial<RecentTurn> = {}): RecentTurn {
  return { role, text, at: 1, ...extra };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeTurnText', () => {
  it('压平空白(多行 → 单空格)并 trim', () => {
    expect(normalizeTurnText('  一\n二\t三  ')).toBe('一 二 三');
  });
  it('截断到 240 字', () => {
    const long = 'x'.repeat(500);
    expect(normalizeTurnText(long)).toHaveLength(RECENT_TURN_MAX_CHARS);
  });
  it('非字符串 → 空串', () => {
    expect(normalizeTurnText(undefined)).toBe('');
    expect(normalizeTurnText(42)).toBe('');
  });
});

describe('appendRecentTurn(任务39·F2 环缓冲)', () => {
  it('按旧→新追加', () => {
    const list = appendRecentTurn(undefined, turn('user', '第一句'));
    const next = appendRecentTurn(list, turn('assistant', '第二句'));
    expect(next.map((t) => t.text)).toEqual(['第一句', '第二句']);
  });
  it('空文本不留痕(不占位)且不抛', () => {
    const list = appendRecentTurn([turn('user', '有')], turn('assistant', '   '));
    expect(list).toHaveLength(1);
    expect(appendRecentTurn(undefined, turn('user', ''))).toEqual([]);
  });
  it('返回新数组,不改入参', () => {
    const orig: RecentTurn[] = [turn('user', 'a')];
    const next = appendRecentTurn(orig, turn('assistant', 'b'));
    expect(orig).toHaveLength(1);
    expect(next).not.toBe(orig);
  });
  it(`超 ${RECENT_TURNS_MAX} 条丢最旧`, () => {
    let list: RecentTurn[] = [];
    for (let i = 1; i <= RECENT_TURNS_MAX + 2; i++) list = appendRecentTurn(list, turn('user', `第${i}句`));
    expect(list).toHaveLength(RECENT_TURNS_MAX);
    expect(list[0]!.text).toBe('第3句');
    expect(list[list.length - 1]!.text).toBe('第10句');
  });
  it(`总量超 ${RECENT_TURNS_TOTAL_CHARS} 字丢最旧(7×240=1680 → 保 6 条)`, () => {
    let list: RecentTurn[] = [];
    for (let i = 1; i <= 7; i++) {
      list = appendRecentTurn(list, turn('user', `${i}`.padEnd(RECENT_TURN_MAX_CHARS, 'x')));
    }
    expect(list).toHaveLength(6);
    expect(list[0]!.text.startsWith('2')).toBe(true);
  });
  it('event:true 透传(事件回合是语境)', () => {
    const list = appendRecentTurn(undefined, turn('user', 'XX 办好了', { event: true }));
    expect(list[0]!.event).toBe(true);
  });
});

describe('sanitizeRecentTurns(状态文件容错)', () => {
  it('非数组 → []', () => {
    expect(sanitizeRecentTurns(undefined)).toEqual([]);
    expect(sanitizeRecentTurns({ role: 'user', text: 'x' })).toEqual([]);
  });
  it('坏条目逐条丢弃(角色非法/文本非串或空/非对象)', () => {
    const out = sanitizeRecentTurns([
      { role: 'system', text: '角色非法' },
      { role: 'user', text: 42 },
      { role: 'user', text: '   ' },
      null,
      { role: 'assistant', text: '合法' },
    ]);
    expect(out.map((t) => t.text)).toEqual(['合法']);
  });
  it('at 非法 → 0;event 仅 true 保留', () => {
    const out = sanitizeRecentTurns([
      { role: 'user', text: 'a', at: 'not-a-number', event: 'yes' },
      { role: 'user', text: 'b', at: 123, event: true },
    ]);
    expect(out[0]).toMatchObject({ at: 0 });
    expect(out[0]!.event).toBeUndefined();
    expect(out[1]).toMatchObject({ at: 123, event: true });
  });
  it('加载时同样应用上限(超 8 条裁到 8)', () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `第${i}句`, at: i }));
    expect(sanitizeRecentTurns(raw)).toHaveLength(RECENT_TURNS_MAX);
  });
});

describe('isHandoffEnabled(开关)', () => {
  it('缺省开;TC_VOICE_HANDOFF=0 关', () => {
    expect(isHandoffEnabled()).toBe(true);
    vi.stubEnv('TC_VOICE_HANDOFF', '0');
    expect(isHandoffEnabled()).toBe(false);
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    expect(isHandoffEnabled()).toBe(true);
  });
});

describe('cleanHandoffText(任务39·F3 清洗)', () => {
  it('正常三行便签原样保留', () => {
    const raw = '在聊订单同步的事\n等 A 方案结果\n老大比较急';
    expect(cleanHandoffText(raw)).toBe(raw);
  });
  it('剥代码围栏,空行丢弃', () => {
    expect(cleanHandoffText('```text\n在聊订单\n\n等结果\n上下文:无\n```')).toBe('在聊订单\n等结果\n上下文:无');
  });
  it('逐行剥引号包裹', () => {
    expect(cleanHandoffText('「在聊订单同步的事」\n『等着 A 方案结果』')).toBe('在聊订单同步的事\n等着 A 方案结果');
  });
  it('超过 3 行只取前 3 行', () => {
    expect(cleanHandoffText('在聊订单同步\n等着结果\n老大比较急\n第四行\n第五行')).toBe('在聊订单同步\n等着结果\n老大比较急');
  });
  it(`总长超 ${HANDOFF_TEXT_MAX_CHARS} 字截断`, () => {
    const out = cleanHandoffText('x'.repeat(500));
    expect(out).toHaveLength(HANDOFF_TEXT_MAX_CHARS);
  });
  it('空/纯空白/太短(<10 字) → null', () => {
    expect(cleanHandoffText('')).toBeNull();
    expect(cleanHandoffText('  \n \n')).toBeNull();
    expect(cleanHandoffText('好的')).toBeNull();
    expect(cleanHandoffText(undefined)).toBeNull();
  });
});

describe('shouldPregenHandoff(任务39·F3 触发矩阵)', () => {
  const cfg = { contextCompactPercent: 0.3, contextCompactTokens: 0 };
  function rt(over: Partial<HandoffPregenRuntime> = {}): HandoffPregenRuntime {
    return { pending: null, inFlight: null, lastPregen: null, ...over };
  }
  function state(over: { sessionId?: string | null; turns?: number; percent?: number; tokensUsed?: number } = {}) {
    const { sessionId = 's1', turns = 5, percent = 0.25, tokensUsed = 50_000 } = over;
    return { sessionId, turns, context: percent == null ? null : { tokensUsed, percent } };
  }

  it('无会话 / 无 context → 不触发', () => {
    expect(shouldPregenHandoff(state({ sessionId: null }), cfg, rt())).toBe(false);
    expect(shouldPregenHandoff({ sessionId: 's1', turns: 5, context: null }, cfg, rt())).toBe(false);
  });
  it('预备线 0.2:0.19 不触发,0.20 触发(含等号)', () => {
    expect(shouldPregenHandoff(state({ percent: 0.19 }), cfg, rt())).toBe(false);
    expect(shouldPregenHandoff(state({ percent: 0.2 }), cfg, rt())).toBe(true);
  });
  it('在途生成 → 不触发(防重入)', () => {
    expect(shouldPregenHandoff(state(), cfg, rt({ inFlight: 's1' }))).toBe(false);
  });
  it('同会话冷却 <2 回合不触发;≥2 回合触发;换会话不受冷却限制', () => {
    const last = { sessionId: 's1', turns: 4 };
    expect(shouldPregenHandoff(state({ turns: 5 }), cfg, rt({ lastPregen: last }))).toBe(false);
    expect(shouldPregenHandoff(state({ turns: 6 }), cfg, rt({ lastPregen: last }))).toBe(true);
    expect(shouldPregenHandoff(state({ sessionId: 's2', turns: 5 }), cfg, rt({ lastPregen: last }))).toBe(true);
  });
  it('开关关 → 不触发(即使跨线)', () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '0');
    expect(shouldPregenHandoff(state({ percent: 0.9 }), cfg, rt())).toBe(false);
  });
  it('绝对值模式:大窗口 percent 很低,tokensUsed ≥ 0.8×cap 即触发(48K 边界)', () => {
    const absCfg = { contextCompactPercent: 0.3, contextCompactTokens: 60_000 };
    expect(shouldPregenHandoff(state({ percent: 0.05, tokensUsed: 48_000 }), absCfg, rt())).toBe(true);
    expect(shouldPregenHandoff(state({ percent: 0.05, tokensUsed: 47_999 }), absCfg, rt())).toBe(false);
    // 关掉绝对闸口后同样局面不触发(纯 percent 支,0.05 < 0.2)
    expect(shouldPregenHandoff(state({ percent: 0.05, tokensUsed: 48_000 }), cfg, rt())).toBe(false);
  });
});

describe('buildHandoffUserContent(任务39·F3 材料)', () => {
  it('三段齐:长期记忆 / 上一张便签 / 最近对话(旧→新,事件标注)', () => {
    const out = buildHandoffUserContent(
      [
        { role: 'user', text: '帮我看订单', at: 1 },
        { role: 'assistant', text: '好嘞,我这就看。', at: 2 },
        { role: 'user', text: 'XX 办好了', at: 3, event: true },
      ],
      { notes: [{ text: '老大喜欢先看结论' }], handoff: { text: '在聊订单同步' } },
    );
    expect(out).toContain('【长期记忆（不重复）】');
    expect(out).toContain('- 老大喜欢先看结论');
    expect(out).toContain('【上一张交接便签（未了事项优先保留）】');
    expect(out).toContain('在聊订单同步');
    expect(out).toContain('【最近对话（旧→新）】');
    expect(out.indexOf('帮我看订单')).toBeLessThan(out.indexOf('好嘞,我这就看。'));
    expect(out).toContain('系统事件: XX 办好了');
  });
  it('空材料有界输出(不抛,标注 (无))', () => {
    const out = buildHandoffUserContent([], {});
    expect(out).toContain('(无)');
    expect(out).not.toContain('【上一张交接便签');
  });
});

describe('handoffRenderable(任务39·F4 渲染门控)', () => {
  const NOW = 1_800_000_000_000;
  const note = (over: Partial<HandoffNote> = {}): HandoffNote => ({
    text: '在聊订单同步,等 A 方案结果',
    forSessionId: 's-old',
    at: NOW - 60_000,
    ...over,
  });

  it('会话不同 → 渲染(新会话才需要接手)', () => {
    expect(handoffRenderable(note(), 's-new', NOW)).toBe(true);
  });
  it('当前无会话(null)→ 渲染(轮换刚发生、新会话未建)', () => {
    expect(handoffRenderable(note(), null, NOW)).toBe(true);
  });
  it('同会话 → 不渲染(系统提示词每回合重发,防当前会话自看)', () => {
    expect(handoffRenderable(note({ forSessionId: 's-old' }), 's-old', NOW)).toBe(false);
  });
  it('72h 边界:恰好 72h 渲染;超 1ms 不渲染', () => {
    expect(handoffRenderable(note({ at: NOW - HANDOFF_TTL_MS }), 's-new', NOW)).toBe(true);
    expect(handoffRenderable(note({ at: NOW - HANDOFF_TTL_MS - 1 }), 's-new', NOW)).toBe(false);
  });
  it('空笔记/缺笔记/空文本 → 不渲染', () => {
    expect(handoffRenderable(null, 's-new', NOW)).toBe(false);
    expect(handoffRenderable(undefined, 's-new', NOW)).toBe(false);
    expect(handoffRenderable(note({ text: '  ' }), 's-new', NOW)).toBe(false);
  });
});

describe('handoffObservation(任务39·F4 观测态)', () => {
  const NOW = 1_800_000_000_000;
  const note = (over: Partial<HandoffNote> = {}): HandoffNote => ({
    text: '在聊订单同步',
    forSessionId: 's-old',
    at: NOW - 1_000,
    ...over,
  });

  it('可渲染的笔记 → attached(优先于 pending)', () => {
    expect(handoffObservation(note(), note(), 's-new', NOW)).toBe('attached');
  });
  it('只有待认领 → pending', () => {
    expect(handoffObservation(null, note(), 's-old', NOW)).toBe('pending');
  });
  it('笔记不可用(同会话/超时)→ stale;无笔记无待认领 → none', () => {
    expect(handoffObservation(note(), null, 's-old', NOW)).toBe('stale');
    expect(handoffObservation(note({ at: NOW - HANDOFF_TTL_MS - 1 }), null, 's-new', NOW)).toBe('stale');
    expect(handoffObservation(null, null, 's-new', NOW)).toBe('none');
  });
});
