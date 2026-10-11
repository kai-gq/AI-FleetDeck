/**
 * 热词库(asr-hotwords)单测:清洗 / 合并 / 提及刷新 / 淘汰 / 有效词表(分层) /
 * 注入窗口 / corpus 构造 / 增删 / 读写沙箱往返。全部不碰真实路径(TC_VOICE_HOTWORDS_SOURCE)。
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_NAME_WEIGHT,
  BLOCKED_CAP,
  DEFAULT_WEIGHT,
  HOTWORDS_SOURCE_ENV,
  HOTWORDS_TOPN_ENV,
  INJECT_TOP_N,
  addManualWord,
  blockWord,
  buildCorpusContext,
  buildEffectiveWords,
  countOccurrences,
  emptyHotwordsFile,
  evictToCap,
  getAgentNames,
  mergeCandidates,
  pickAsrCorpus,
  pickInjectionWords,
  readHotwordsFile,
  removeWord,
  resolveInjectTopN,
  sanitizeHotwordsFile,
  setAgentNamesProvider,
  stripLockedDuplicates,
  touchSeenWords,
  writeHotwordsFile,
  type HotwordEntry,
  type HotwordsFile,
  type InjectionWord,
} from './asr-hotwords.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-hotwords-'));
afterAll(() => {
  setAgentNamesProvider(null); // 全局 provider 复位(防泄漏到其它测试文件)
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const T = '2026-10-07T02:00:00.000Z';

function entry(over: Partial<HotwordEntry>): HotwordEntry {
  return {
    word: 'x',
    weight: 6,
    count: 1,
    source: 'agent',
    addedAt: T,
    lastSeenAt: T,
    ...over,
  };
}

describe('sanitizeHotwordsFile', () => {
  it('垃圾输入 → 空表,永不抛', () => {
    expect(sanitizeHotwordsFile(null)).toEqual(emptyHotwordsFile());
    expect(sanitizeHotwordsFile('x')).toEqual(emptyHotwordsFile());
    expect(sanitizeHotwordsFile({})).toEqual(emptyHotwordsFile());
  });

  it('词条:忽略大小写去重、clamp weight/count、丢弃非法形态', () => {
    const file = sanitizeHotwordsFile({
      lastAnalyzedAt: 'not-a-date',
      blocked: [' bolba ', 'BOLBA', 42],
      words: [
        { word: 'bolba', weight: 99, count: -3, source: 'manual', addedAt: T, lastSeenAt: T },
        { word: 'BOLBA', weight: 5 }, // 大小写重复 → 丢
        { word: '', weight: 5 }, // 空词 → 丢
        { word: 'x'.repeat(41) }, // 超长 → 丢
        'garbage',
        { word: ' tRPC ' }, // trim 保留
      ],
    });
    expect(file.lastAnalyzedAt).toBeNull();
    expect(file.blocked).toEqual(['bolba']); // 去重 + trim;数字忽略
    expect(file.words).toHaveLength(2);
    expect(file.words[0]).toMatchObject({ word: 'bolba', weight: 10, count: 0, source: 'manual' });
    expect(file.words[1].word).toBe('tRPC');
    expect(file.words[1].weight).toBe(DEFAULT_WEIGHT);
  });

  it('blocked 上限', () => {
    const blocked = Array.from({ length: BLOCKED_CAP + 10 }, (_, i) => `w${i}`);
    expect(sanitizeHotwordsFile({ blocked }).blocked).toHaveLength(BLOCKED_CAP);
  });
});

describe('mergeCandidates / touchSeenWords', () => {
  it('新词入库(count=本批出现数);已有 agent 词更新 weight 不重复计 count;manual 词 weight 免疫', () => {
    const file: HotwordsFile = {
      lastAnalyzedAt: null,
      blocked: [],
      words: [
        entry({ word: 'bolba', source: 'agent', weight: 4, count: 2 }),
        entry({ word: 'tRPC', source: 'manual', weight: 9, count: 1 }),
      ],
    };
    const stats = mergeCandidates(
      file,
      [
        { word: 'tide-commander', weight: 8, count: 3 },
        { word: 'bolba', weight: 7, count: 5 },
        { word: 'trpc', weight: 2, count: 1 }, // 大小写命中 manual tRPC
      ],
      '2026-10-07T03:00:00.000Z',
    );
    expect(stats).toEqual({ added: 1, updated: 2, skippedBlocked: 0 });
    const byWord = new Map(file.words.map((e) => [e.word, e]));
    expect(byWord.get('tide-commander')).toMatchObject({ weight: 8, count: 3, source: 'agent' });
    expect(byWord.get('bolba')).toMatchObject({ weight: 7, count: 2 }); // count 不动(归 touch)
    expect(byWord.get('tRPC')).toMatchObject({ weight: 9, count: 1 }); // manual 权重免疫
    expect(byWord.get('tRPC')?.lastSeenAt).toBe('2026-10-07T03:00:00.000Z');
  });

  it('blocked 命中 → 丢弃并计数', () => {
    const file = emptyHotwordsFile();
    file.blocked = ['bolba'];
    const stats = mergeCandidates(file, [{ word: 'BOLBA', weight: 6, count: 1 }], T);
    expect(stats.skippedBlocked).toBe(1);
    expect(file.words).toHaveLength(0);
  });

  it('touchSeenWords:按出现次数累加 count、刷新 lastSeenAt,返回被刷新词数', () => {
    const file = emptyHotwordsFile();
    file.words = [entry({ word: 'bolba', count: 2 }), entry({ word: 'tRPC', count: 0 })];
    const touched = touchSeenWords(file, '[用户] 打开 bolba 看板,bolba 任务', '2026-10-07T04:00:00.000Z');
    expect(touched).toBe(1);
    expect(file.words[0]).toMatchObject({ count: 4, lastSeenAt: '2026-10-07T04:00:00.000Z' });
    expect(file.words[1].count).toBe(0);
  });

  it('countOccurrences:非重叠计数,大小写由调用方归一', () => {
    expect(countOccurrences('bolba bolba xbolba', 'bolba')).toBe(3);
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});

describe('evictToCap', () => {
  it('溢出时先挤 agent 弱词(weight 低 → lastSeenAt 老),manual 最后', () => {
    const file = emptyHotwordsFile();
    file.words = [
      entry({ word: 'keep-manual', source: 'manual', weight: 1 }),
      entry({ word: 'keep-agent', source: 'agent', weight: 9 }),
      entry({ word: 'drop-agent-old', source: 'agent', weight: 3, lastSeenAt: '2026-01-01T00:00:00.000Z' }),
      entry({ word: 'drop-agent-new', source: 'agent', weight: 3, lastSeenAt: '2026-10-01T00:00:00.000Z' }),
    ];
    expect(evictToCap(file, 3)).toBe(1);
    expect(file.words.map((e) => e.word).sort()).toEqual(['drop-agent-new', 'keep-agent', 'keep-manual']);
  });

  it('未超限不动', () => {
    const file = emptyHotwordsFile();
    file.words = [entry({ word: 'a' })];
    expect(evictToCap(file, 200)).toBe(0);
  });
});

describe('pickInjectionWords / buildCorpusContext / pickAsrCorpus', () => {
  it('分层:agent 名必进 > manual > 动态(按权重,同权重比 count/新鲜度)', () => {
    const words: InjectionWord[] = [
      { word: 'agent-hot', weight: 10, count: 100, source: 'agent', lastSeenAt: '' },
      { word: 'manual-zero', weight: 6, count: 0, source: 'manual', lastSeenAt: '' },
      { word: 'agent-cold', weight: 2, count: 1, source: 'agent', lastSeenAt: '' },
    ];
    // manual(tier1)先于动态词(即便对方 weight 10 / count 100);层内按 weight
    expect(pickInjectionWords(words, 2)).toEqual(['manual-zero', 'agent-hot']);

    const layered: InjectionWord[] = [
      { word: '一名', weight: 10, count: 0, source: 'agent-name', lastSeenAt: '' },
      { word: '手动', weight: 6, count: 0, source: 'manual', lastSeenAt: '' },
      { word: '动态低', weight: 3, count: 5, source: 'agent', lastSeenAt: '' },
      { word: '动态同权', weight: 8, count: 99, source: 'agent', lastSeenAt: '' },
      { word: '动态新', weight: 8, count: 1, source: 'agent', lastSeenAt: '2026-10-07T00:00:00.000Z' },
    ];
    // tier0 agent 名 → tier1 手动 → tier2 动态:同权重 8 先比 count(99 > 1),再落到权重 3
    expect(pickInjectionWords(layered, 5)).toEqual(['一名', '手动', '动态同权', '动态新', '动态低']);
  });

  it('corpus:无词 → null;有词 → {"context":"{\\"hotwords\\":[{\\"word\\":…}]}"}(LMHotWord 对象)', () => {
    expect(buildCorpusContext([])).toBeNull();
    const corpus = buildCorpusContext(['bolba', 'tRPC']);
    expect(corpus).not.toBeNull();
    expect(JSON.parse(corpus!.context)).toEqual({ hotwords: [{ word: 'bolba' }, { word: 'tRPC' }] });
  });

  it('pickAsrCorpus:agent 名必进(文件缺失也返回);无词 → null;手动词置次', () => {
    // 文件缺失:仅 agent 名层仍构造 corpus
    setAgentNamesProvider(() => ['主管']);
    try {
      const missing = pickAsrCorpus({ [HOTWORDS_SOURCE_ENV]: path.join(sandbox, 'no-file.json') });
      expect(missing).not.toBeNull();
      expect(missing!.count).toBe(1);
      const only = (JSON.parse(missing!.context) as { hotwords: Array<{ word: string }> }).hotwords.map((h) => h.word);
      expect(only).toEqual(['主管']);

      // 无 agent 名且池空 → null(热词是加成,绝不阻断识别)
      setAgentNamesProvider(() => []);
      expect(pickAsrCorpus({ [HOTWORDS_SOURCE_ENV]: path.join(sandbox, 'no-file.json') })).toBeNull();

      // agent 名 + 手动词:agent 名(tier0)在前,manual(tier1)随后
      setAgentNamesProvider(() => ['主管']);
      const filePath = path.join(sandbox, 'corpus.json');
      fs.writeFileSync(filePath, JSON.stringify({ words: [{ word: 'bolba', weight: 6, count: 3, source: 'manual' }] }));
      const corpus = pickAsrCorpus({ [HOTWORDS_SOURCE_ENV]: filePath });
      expect(corpus).not.toBeNull();
      expect(corpus!.count).toBe(2);
      const words = (JSON.parse(corpus!.context) as { hotwords: Array<{ word: string }> }).hotwords.map((h) => h.word);
      expect(words).toEqual(['主管', 'bolba']);
    } finally {
      setAgentNamesProvider(null);
    }
  });
});

describe('有效词表(buildEffectiveWords / stripLockedDuplicates / agent 名 provider)', () => {
  it('层序 agent 名 > 文件池,忽略大小写去重(agent 名赢)', () => {
    const file = emptyHotwordsFile();
    file.words = [
      entry({ word: '主管', weight: 3 }), // 与 agent 名同名 → agent 名赢
      entry({ word: 'TRPC', weight: 9 }), // 与 agent 名 trpc 重复(大小写)→ agent 名赢
      entry({ word: '自定义词', weight: 7 }),
    ];
    const eff = buildEffectiveWords(file, { agentNames: ['主管', 'trpc'] });
    expect(eff.map((w) => [w.word, w.source])).toEqual([
      ['主管', 'agent-name'],
      ['trpc', 'agent-name'],
      ['自定义词', 'agent'],
    ]);
    expect(eff[0].weight).toBe(AGENT_NAME_WEIGHT);
    expect(eff[2].weight).toBe(7); // 池内权重原样
  });

  it('stripLockedDuplicates:清池内与 agent 名重复的条目,不拉黑,返回移除数', () => {
    const file = emptyHotwordsFile();
    file.words = [entry({ word: '主管' }), entry({ word: 'bolba' })]; // 主管与 agent 名重复 → 清
    const stripped = stripLockedDuplicates(file, { agentNames: ['主管'] });
    expect(stripped).toBe(1);
    expect(file.words.map((e) => e.word)).toEqual(['bolba']);
    expect(file.blocked).toEqual([]); // 不拉黑(锁定层仍在注入)
  });

  it('agent 名 provider:实时读取;未注册/抛错 → 空表(热词永不阻断识别)', () => {
    expect(getAgentNames()).toEqual([]);
    setAgentNamesProvider(() => [' 主管 ', '', '小刘']);
    expect(getAgentNames()).toEqual(['主管', '小刘']); // trim + 空名过滤
    setAgentNamesProvider(() => {
      throw new Error('boom');
    });
    expect(getAgentNames()).toEqual([]);
    setAgentNamesProvider(null);
    expect(getAgentNames()).toEqual([]);
  });

  it('resolveInjectTopN:默认 INJECT_TOP_N;覆写夹取 1..60;非法回默认', () => {
    expect(resolveInjectTopN({})).toBe(INJECT_TOP_N);
    expect(resolveInjectTopN({ [HOTWORDS_TOPN_ENV]: '30' })).toBe(30);
    expect(resolveInjectTopN({ [HOTWORDS_TOPN_ENV]: '999' })).toBe(60);
    expect(resolveInjectTopN({ [HOTWORDS_TOPN_ENV]: '0' })).toBe(INJECT_TOP_N);
    expect(resolveInjectTopN({ [HOTWORDS_TOPN_ENV]: 'abc' })).toBe(INJECT_TOP_N);
  });

  it('blockWord:池外也能拉黑;已存在 → false;上限不重复', () => {
    const file = emptyHotwordsFile();
    expect(blockWord(file, '旧名')).toBe(true);
    expect(blockWord(file, '旧名')).toBe(false);
    expect(blockWord(file, '   ')).toBe(false);
    expect(file.blocked).toEqual(['旧名']);
  });
});

describe('读写沙箱往返 / 增删', () => {
  it('write→read 往返;损坏文件 → 空表 existed=true;缺失 → existed=false', () => {
    const filePath = path.join(sandbox, 'roundtrip', 'hotwords.local.json');
    const env = { [HOTWORDS_SOURCE_ENV]: filePath };
    const file = emptyHotwordsFile();
    file.lastAnalyzedAt = T;
    file.words.push(entry({ word: 'bolba' }));
    writeHotwordsFile(file, env);

    const read = readHotwordsFile(env);
    expect(read.existed).toBe(true);
    expect(read.file.lastAnalyzedAt).toBe(T);
    expect(read.file.words[0].word).toBe('bolba');

    fs.writeFileSync(filePath, '{broken');
    expect(readHotwordsFile(env).file).toEqual(emptyHotwordsFile());
    expect(readHotwordsFile(env).existed).toBe(true);
    expect(readHotwordsFile({ [HOTWORDS_SOURCE_ENV]: path.join(sandbox, 'nope.json') }).existed).toBe(false);
  });

  it('removeWord:移出词表并拉黑;blocked 去重;不存在的词返回 false', () => {
    const file = emptyHotwordsFile();
    file.words.push(entry({ word: 'bolba' }));
    expect(removeWord(file, 'BOLBA')).toBe(true);
    expect(file.words).toHaveLength(0);
    expect(file.blocked).toEqual(['BOLBA']);
    expect(removeWord(file, 'bolba')).toBe(false);
    expect(file.blocked).toHaveLength(1);
  });

  it('addManualWord:新增 manual;已在 blocked → 解除并入库;已存在的 agent → 升级 manual;repeat → false', () => {
    const file = emptyHotwordsFile();
    file.blocked = ['bolba'];
    expect(addManualWord(file, 'bolba', T)).toBe(true);
    expect(file.blocked).toHaveLength(0);
    expect(file.words[0]).toMatchObject({ word: 'bolba', source: 'manual', weight: DEFAULT_WEIGHT });
    expect(addManualWord(file, 'bolba', T)).toBe(false);

    file.words.push(entry({ word: 'tRPC', source: 'agent' }));
    expect(addManualWord(file, 'tRPC', T)).toBe(true);
    expect(file.words.find((e) => e.word === 'tRPC')?.source).toBe('manual');
    expect(addManualWord(file, '有 空格', T)).toBe(false);
  });
});
