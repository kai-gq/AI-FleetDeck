/**
 * jarvis-core/sentinel · 自愈闭环检测（任务 33 ⑤.4 / 台阶三⑧）
 *
 * 正例：「问三遍」（同键/高相似重复 ≥3）→ 降级道歉建议对象；
 *       「反复误判」（同键/高相似重复 ≥2）→ 建议；
 * 反例：次数不足、相似度不足、窗口外、未来事件、开关关、畸形事件。
 * 边界：窗口边界（恰好 windowMs 计入）、相似阈值（可注入，越高越不聚）、
 * 样本上限、归组键优先级（intentKey/topicKey > 文本相似）。
 */

import { describe, expect, it } from 'vitest';

import {
  detectRepeatedMisjudges,
  detectRepeatedRequests,
  detectSelfHeal,
  normalizeRequestText,
  textSimilarity,
} from './index.js';
import type { SentinelInteractionEvent } from './index.js';

const NOW = new Date(2026, 9, 1, 12, 0, 0, 0).getTime();
const MIN = 60 * 1000;

function request(at: number, text: string, intentKey?: string): SentinelInteractionEvent {
  return { at, kind: 'user-request', text, ...(intentKey !== undefined ? { intentKey } : {}) };
}

function misjudge(at: number, text: string, topicKey?: string): SentinelInteractionEvent {
  return { at, kind: 'misjudge', text, ...(topicKey !== undefined ? { topicKey } : {}) };
}

describe('文本归一化与相似度（零依赖 bigram Dice）', () => {
  it('归一化：trim + 空白压缩 + 小写', () => {
    expect(normalizeRequestText('  帮我   查一下\n天气 ')).toBe('帮我 查一下 天气');
    expect(normalizeRequestText('ABC')).toBe('abc');
  });

  it('相同 = 1；近似重复 > 0.7；无关 < 0.2；单字只认完全相同', () => {
    const a = '帮我查一下明天的天气';
    expect(textSimilarity(a, a)).toBe(1);
    expect(textSimilarity(a, `${a}！`)).toBeGreaterThan(0.9);
    expect(textSimilarity(a, '帮我查一下明天天气')).toBeGreaterThan(0.7);
    expect(textSimilarity(a, '把会议室预定改到下午三点')).toBeLessThan(0.2);
    expect(textSimilarity('好', '好')).toBe(1);
    expect(textSimilarity('好', '好的')).toBe(0);
    expect(textSimilarity('', '')).toBe(0);
    expect(textSimilarity('', a)).toBe(0);
  });
});

describe('问三遍检测（repeated-request）', () => {
  it('同一请求 3 次 → 建议对象（去重样本/档位上限 STORE/动作降级道歉）', () => {
    const text = '帮我查一下明天的天气';
    const events = [request(NOW - 3 * MIN, text), request(NOW - 2 * MIN, text), request(NOW - 1 * MIN, text)];
    const suggestions = detectRepeatedRequests(events, NOW);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      reason: 'repeated-request',
      action: 'degrade-and-apologize',
      maxTier: 'STORE',
      at: NOW,
      count: 3,
      key: text,
      samples: [text], // 相同文本去重
      similarity: 1,
      windowMs: 30 * MIN,
    });
    expect(suggestions[0].firstAt).toBe(NOW - 3 * MIN);
    expect(suggestions[0].lastAt).toBe(NOW - 1 * MIN);
  });

  it('2 次不足（词面「问三遍」= 3）→ 无建议', () => {
    const text = '帮我查一下明天的天气';
    expect(detectRepeatedRequests([request(NOW - 2 * MIN, text), request(NOW - 1 * MIN, text)], NOW)).toEqual([]);
  });

  it('近似重复（换字/加标点）按阈值聚簇；阈值调高 → 不聚', () => {
    const events = [
      request(NOW - 3 * MIN, '帮我查一下明天的天气'),
      request(NOW - 2 * MIN, '帮我查一下明天的天气！'),
      request(NOW - 1 * MIN, '帮我查一下明天天气'),
    ];
    const clustered = detectRepeatedRequests(events, NOW);
    expect(clustered).toHaveLength(1);
    expect(clustered[0].count).toBe(3);
    expect(clustered[0].samples).toHaveLength(3); // 三个不同原文
    expect(clustered[0].similarity).toBeGreaterThan(0.7);
    expect(clustered[0].similarity).toBeLessThanOrEqual(1);

    const strict = detectRepeatedRequests(events, NOW, { selfHeal: { similarityThreshold: 0.95 } });
    expect(strict).toEqual([]); // 只剩「完全相同」的一对，不足 3
  });

  it('intentKey 优先：不同措辞同键也聚簇（similarity=null），样本受 maxSamples 限制', () => {
    const events = [
      request(NOW - 5 * MIN, '看看那个报表', '报表-请求'),
      request(NOW - 4 * MIN, '报表给我一下', '报表-请求'),
      request(NOW - 3 * MIN, '我要看报表', '报表-请求'),
      request(NOW - 2 * MIN, '把报表发我', '报表-请求'),
      request(NOW - 1 * MIN, '报表呢', '报表-请求'),
    ];
    const suggestions = detectRepeatedRequests(events, NOW);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ count: 5, key: '报表-请求', similarity: null });
    expect(suggestions[0].samples).toHaveLength(3); // DEFAULT maxSamples
    expect(suggestions[0].samples).toEqual(['看看那个报表', '报表给我一下', '我要看报表']);
  });

  it('窗口边界：恰好 30 分钟前计入；再早 1ms 出窗；未来事件排除', () => {
    const text = '现在几点了';
    const onEdge = [
      request(NOW - 30 * MIN, text),
      request(NOW - 2 * MIN, text),
      request(NOW - 1 * MIN, text),
    ];
    expect(detectRepeatedRequests(onEdge, NOW)).toHaveLength(1);

    const outOfWindow = [request(NOW - 30 * MIN - 1, text), request(NOW - 2 * MIN, text), request(NOW - 1 * MIN, text)];
    expect(detectRepeatedRequests(outOfWindow, NOW)).toEqual([]);

    const future = [request(NOW + MIN, text), request(NOW - 2 * MIN, text), request(NOW - 1 * MIN, text)];
    expect(detectRepeatedRequests(future, NOW)).toEqual([]);
  });

  it('畸形事件静默丢弃（时刻非有限数 / 空文本）；无关请求各自成簇', () => {
    const text = '帮我查一下明天的天气';
    const events: SentinelInteractionEvent[] = [
      { at: Number.NaN, kind: 'user-request', text },
      { at: NOW - MIN, kind: 'user-request', text: '   ' },
      request(NOW - 3 * MIN, text),
      request(NOW - 2 * MIN, text),
      request(NOW - 1 * MIN, text),
      request(NOW - 4 * MIN, '把会议室预定改到下午三点'),
    ];
    const suggestions = detectRepeatedRequests(events, NOW);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].count).toBe(3);
  });

  it('开关关 → 恒空（零行为变化）', () => {
    const text = '帮我查一下明天的天气';
    const events = [request(NOW - 3 * MIN, text), request(NOW - 2 * MIN, text), request(NOW - 1 * MIN, text)];
    expect(detectRepeatedRequests(events, NOW, { enabled: false })).toEqual([]);
    expect(detectRepeatedRequests(events, NOW, { env: { TC_JARVIS_SENTINEL: '0' } })).toEqual([]);
  });
});

describe('反复误判检测（repeated-misjudge）', () => {
  it('同一误判 2 次 → 建议；1 次不足', () => {
    const topic = '把「周五」听成了「周二」';
    const twice = detectRepeatedMisjudges([misjudge(NOW - 2 * MIN, topic, 'date-mishear'), misjudge(NOW - MIN, topic, 'date-mishear')], NOW);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ reason: 'repeated-misjudge', action: 'degrade-and-apologize', maxTier: 'STORE', count: 2 });

    expect(detectRepeatedMisjudges([misjudge(NOW - MIN, topic, 'date-mishear')], NOW)).toEqual([]);
  });

  it('无 topicKey 时按文本高相似聚簇', () => {
    const twice = detectRepeatedMisjudges(
      [misjudge(NOW - 2 * MIN, '把项目A认成了项目B'), misjudge(NOW - MIN, '把项目A认成项目B了')],
      NOW,
    );
    expect(twice).toHaveLength(1);
    expect(twice[0].similarity).toBeGreaterThan(0.7);

    const different = detectRepeatedMisjudges(
      [misjudge(NOW - 2 * MIN, '把项目A认成了项目B'), misjudge(NOW - MIN, '把周五听成了周二')],
      NOW,
    );
    expect(different).toEqual([]);
  });
});

describe('detectSelfHeal（合并输出）', () => {
  it('两类模式合并、稳定排序（lastAt 升序）', () => {
    const events = [
      request(NOW - 10 * MIN, '帮我查一下明天的天气'),
      request(NOW - 9 * MIN, '帮我查一下明天的天气'),
      request(NOW - 8 * MIN, '帮我查一下明天的天气'),
      misjudge(NOW - 3 * MIN, '把项目A认成了项目B', 'proj-misjudge'),
      misjudge(NOW - 2 * MIN, '把项目A认成了项目B', 'proj-misjudge'),
    ];
    const suggestions = detectSelfHeal(events, NOW);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].reason).toBe('repeated-request');
    expect(suggestions[1].reason).toBe('repeated-misjudge');
    expect(suggestions[0].lastAt).toBeLessThan(suggestions[1].lastAt);
  });
});
