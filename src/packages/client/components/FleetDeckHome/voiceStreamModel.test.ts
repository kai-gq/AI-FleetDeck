import { describe, expect, it } from 'vitest';
import {
  clampVoiceEntries,
  parseVoiceEntries,
  pickVoiceBubble,
  VOICE_STREAM_CLAMP,
  type VoiceEntryRow,
  type VoiceStreamEntry,
} from './voiceStreamModel';

/** 最小桩：className + 两个子选择器。 */
function row(classes: string, tag: string, text: string | null): VoiceEntryRow {
  return {
    className: classes,
    querySelector: (selector: string) => {
      if (selector === '.vc-entry__tag') return { textContent: tag };
      if (selector === '.vc-entry__text') return text === null ? null : { textContent: text };
      return null;
    },
  };
}

describe('voiceStreamModel · 解析（只读镜像，全容错）', () => {
  it('解析四类角色，tag/text 去空白', () => {
    const entries = parseVoiceEntries([
      row('vc-entry vc-entry--live', ' 实时 ', ' 在听 '),
      row('vc-entry vc-entry--user', '你说', '看下进度'),
      row('vc-entry vc-entry--assistant', '回复', '在看了'),
      row('vc-entry vc-entry--system', '…', '正在思考…'),
    ]);
    expect(entries.map((e) => e.role)).toEqual(['live', 'user', 'assistant', 'system']);
    expect(entries[0].text).toBe('在听');
    expect(entries[1].tag).toBe('你说');
  });

  it('未知角色回退 system；缺 className 也不抛', () => {
    expect(parseVoiceEntries([row('vc-entry vc-entry--weird', '标签', '文本')])[0].role).toBe('system');
    expect(parseVoiceEntries([{ className: undefined, querySelector: () => null }])).toEqual([]);
  });

  it('空文本行跳过（气泡里可能只有 tag）', () => {
    expect(parseVoiceEntries([row('vc-entry vc-entry--user', '你说', null)])).toEqual([]);
    expect(parseVoiceEntries([row('vc-entry vc-entry--user', '你说', '   ')])).toEqual([]);
  });

  it('超过 50 条只留最近 50（掐头）', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row('vc-entry vc-entry--user', '你说', `第${i}条`));
    const entries = parseVoiceEntries(rows);
    expect(entries).toHaveLength(VOICE_STREAM_CLAMP);
    expect(entries[0].text).toBe('第10条');
    expect(entries[49].text).toBe('第59条');
  });
});

describe('voiceStreamModel · clamp 与气泡选择', () => {
  const entry = (i: number): VoiceStreamEntry => ({ id: `e${i}`, role: 'user', tag: '', text: `t${i}` });

  it('clamp：不超限原样返回副本；非法 max → 空', () => {
    const small = [entry(1), entry(2)];
    const copy = clampVoiceEntries(small, 5);
    expect(copy).toEqual(small);
    expect(copy).not.toBe(small);
    expect(clampVoiceEntries(small, 0)).toEqual([]);
    expect(clampVoiceEntries(small, Number.NaN)).toEqual([]);
  });

  it('pickVoiceBubble：优先 .fab-rail 实例（双实例容错）', () => {
    const rail = { inFabRail: true, rows: [1] as number[] };
    const mobile = { inFabRail: false, rows: [1, 2, 3] as number[] };
    expect(pickVoiceBubble([mobile, rail])).toBe(rail);
  });

  it('pickVoiceBubble：无 rail 时取行数最多；空候选 → null', () => {
    const a = { inFabRail: false, rows: [1] as number[] };
    const b = { inFabRail: false, rows: [1, 2] as number[] };
    expect(pickVoiceBubble([a, b])).toBe(b);
    expect(pickVoiceBubble([])).toBeNull();
  });
});
