/**
 * jarvis-core · 触发词扫描规则表（任务 27 ⑤.3，06-11 §6.2）
 *
 * 服务端确定性规则（不靠 LLM）：每轮对话扫描「纠正（'不是X'）、专名、偏好、
 * 决定、数值」五类信号。规则表与命中/不误报矩阵一一对应（write-engine.test.ts
 * 的矩阵单测钉死行为；改规则必须同步改矩阵）。
 *
 * 设计取向：宁缺毋滥——没有把握的句式不命中（英文普通大小写词、裸数字、
 * 疑问句「是不是」等一律不报），由夜间反思从会话摘要补召回，而不是在
 * 写入侧误报。规则顺序 = 命中优先级（一条话语含多类信号时，主 kind 取先者）。
 */

import type { MemoryTriggerKind } from './types.js';

export interface TriggerRule {
  kind: MemoryTriggerKind;
  /** 命中模式（/g；有捕获组时以捕获内容为命中文本）。 */
  patterns: readonly RegExp[];
  /** 整条规则级排除（命中任一 = 该规则不命中；防问句/假设语气误报）。 */
  excludes?: readonly RegExp[];
}

// ============================================================================
// 专名词典（本机高频栈 + 模型名；小写匹配，可扩充）
// ============================================================================

export const DEFAULT_PROPER_NOUN_LEXICON: readonly string[] = [
  'claude',
  'node',
  'npm',
  'pnpm',
  'vite',
  'vitest',
  'obsidian',
  'mem0',
  'tide-commander',
  'edge-tts',
  'whisper',
  'tmux',
  'bolba',
  'sonnet',
  'haiku',
  'opus',
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 词典词 → 词边界匹配（字母数字/连字符视为词内，中文相邻不算边界内）。 */
function buildLexiconPatterns(words: readonly string[]): readonly RegExp[] {
  return words.map((word) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(word)}(?![A-Za-z0-9_-])`, 'gi'));
}

// ============================================================================
// 规则表（顺序 = 优先级：纠正 > 决定 > 偏好 > 数值 > 专名）
// ============================================================================

export const TRIGGER_RULES: readonly TriggerRule[] = [
  {
    kind: 'correction',
    patterns: [
      // 「不是X」——排除「是不是」（问句）与「不是吗/吧/呢」反问
      /(?<!是)不是(?!吗|嘛|吧|呢|？|\?)/g,
      // 强修正句式；「不对」后顾防「对不对」（问句）、前瞻防「对不起」（道歉）
      /(?:(?<!对)不对(?![对起])|错了|搞错(?:了)?|弄错(?:了)?|记错(?:了)?|我是说|我说的是|更正(?:一下)?|纠正(?:一下)?|不是这样)/g,
    ],
  },
  {
    kind: 'decision',
    patterns: [
      /(?:就这么|就按这个|按这个|那就这么)(?:定|办|来|做|写|用|走)/g,
      /(?:敲定|拍板|拍定)/g,
      // 「定了」排除「确定了吗」这类疑问
      /(?<!确)定了(?![吗嘛呢？?])/g,
      /最终(?:就)?(?:用|选|定|走|采用)/g,
      /决定(?:就)?(?:用|走|按|采用|选)/g,
      /(?:以后|今后)就(?:用|走|按|这么)/g,
    ],
    // 未决/询问语气不记决定
    excludes: [/(?:没|不|尚未|还没)(?:决定|确定|敲定|定下来)/, /(?:怎么|如何|谁)(?:决定|定)/],
  },
  {
    kind: 'preference',
    patterns: [
      /我(?:更|比较|挺|很)?(?:喜欢|偏好|习惯|讨厌|不喜欢|爱用|常用|想要|希望)/g,
      /(?:以后|下次|之后|从今往后|今后)(?:都|要|请|别|不要|用|走|按|默认)/g,
      /(?:记住|记一下|记下来|别忘了|要记得)/g,
      /(?:请|麻烦)?(?:默认|统一)(?:用|走|按|采用|设置)/g,
      /我(?:通常|一般|平时|总是)/g,
    ],
    excludes: [/以后(?:再说|再看|再讲|再议)/],
  },
  {
    kind: 'numeric',
    patterns: [
      // 关键词 + 数值（阈值/上限/预算/配额/超时…是 60）
      /(?:阈值|上限|下限|容量|预算|配额|超时|间隔|周期|最多|最少|不超过|超过|保留|过期|默认)\s*(?:是|为|设成?|：|:)?\s*\d+(?:\.\d+)?/g,
      // 数值 + 中文单位（7 天 / 80% / 30 分钟）
      /\d+(?:\.\d+)?\s*(?:分钟|小时|天|周|个月|毫秒|秒|元|万|%|％)/g,
      // 数值 + 拉丁单位（1000ms / 30min / 80s；排除「10st」这类误切）
      /\d+(?:\.\d+)?\s*(?:ms|min|h|s)(?![A-Za-z])/g,
    ],
  },
  {
    kind: 'proper-noun',
    patterns: [
      // 命名句式：叫/名字是…（前瞻排除「叫什么/啥」疑问句）
      /(?:叫|叫作|名字是|名称是|称为|简称)\s*["「“']?(?!什么|啥)([^，。；,.;！!？?\s"」”']{1,30})/g,
      // 引号包裹的专名（「潮汐指挥官」/“tide-commander”/《…》）
      /["「“《]([^"」”》]{2,30})["」”》]/g,
      // 带数字/点/连字符的拉丁 token（tide-commander / Mem0 / a1 / i18n）
      /(?<![A-Za-z0-9._-])[A-Za-z][A-Za-z0-9._-]*[-_.0-9][A-Za-z0-9._-]*(?![A-Za-z0-9._-])/g,
      ...buildLexiconPatterns(DEFAULT_PROPER_NOUN_LEXICON),
    ],
  },
];

// ============================================================================
// 扫描
// ============================================================================

export interface TriggerHit {
  kind: MemoryTriggerKind;
  /** 命中文本（有捕获组取捕获内容，否则取整段匹配）。 */
  text: string;
  /** 在原文中的起始下标。 */
  index: number;
}

export interface ScanTriggerOptions {
  /** 命中上限（去重/排序后截取）；缺省 10。 */
  maxHits?: number;
}

/** 对一轮文本跑全部规则；返回去重、按出现位置排序的命中（确定性）。 */
export function scanTriggers(text: string, opts: ScanTriggerOptions = {}): TriggerHit[] {
  if (!text || !text.trim()) return [];
  const maxHits = opts.maxHits ?? 10;
  const hits: TriggerHit[] = [];
  const seen = new Set<string>();
  for (const rule of TRIGGER_RULES) {
    if (rule.excludes?.some((re) => re.test(text))) continue;
    for (const pattern of rule.patterns) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[1] ?? match[0];
        const matched = raw.trim();
        if (!matched) continue;
        const key = `${rule.kind}:${matched.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ kind: rule.kind, text: matched, index: match.index ?? 0 });
      }
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.slice(0, Math.max(0, maxHits));
}

/** 命中涉及的信号种类（去重，按规则优先级顺序）。 */
export function triggerKinds(hits: readonly TriggerHit[]): MemoryTriggerKind[] {
  const kinds: MemoryTriggerKind[] = [];
  for (const rule of TRIGGER_RULES) {
    if (hits.some((h) => h.kind === rule.kind)) kinds.push(rule.kind);
  }
  return kinds;
}
