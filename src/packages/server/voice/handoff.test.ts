import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECENT_TURNS_MAX,
  RECENT_TURN_MAX_CHARS,
  RECENT_TURNS_TOTAL_CHARS,
  normalizeTurnText,
  appendRecentTurn,
  sanitizeRecentTurns,
  isHandoffEnabled,
  type RecentTurn,
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
