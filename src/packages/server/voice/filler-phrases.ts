/**
 * 静态垫话池(垫话 v2 默认档,2026-10-06):垫话从「模型现编」改为「池内选一句」。
 *
 * 为什么改(真麦复盘,三条实锤根因):
 *   A. 现编的输入是**半句话**——预生成在首个 ≥6 字 partial 时触发,拿到的常是残缺语义,
 *      后续 final 与它不匹配时垫话已经「答非所问」;
 *   B. 生成输入没有任何上下文——只有一句原文 + 防重样提示,不知道人设、历史;
 *   C. 提示词逼模型「每次换说法 + 把话题带进句子」——越自由越容易出怪话。
 * 静态池把三条一并绕开:不读 partial、不喂上下文、不让模型造句。池句全部「场景无关」
 * (只表收到 + 过程动作,不带任何宾语/时间/结果),因此不可能「前言不搭」;
 * 每句都过 filler-guard(见 filler-phrases.test.ts 全池断言),不会食言。
 *
 * 行业口径:微软 Foundry 的 static_interim_response(静态过渡应答)即此路数——
 * 短、固定、可预合成,是官方首选而非降级方案。
 *
 * 历史备注:slow-filler.ts 早期注释「固定短语被明确否决(『固定的不好』)」系第一版
 * 真人反馈;本次(2026-10-06)用户拍板以「假/前言不搭」为主矛盾,方案反转为静态为主,
 * 动态生成降级为 TC_VOICE_FILLER_MODE=llm 实验档,原文保留在 slow-filler.ts 作沿革。
 */
export const STATIC_FILLER_PHRASES: readonly string[] = [
  '嗯，我在',
  '嗯，收到',
  '好嘞',
  '嗯嗯',
  '在呢',
  '我看看',
  '我瞅瞅',
  '我瞧瞧',
  '让我看看',
  '这就办',
  '马上办',
  '行，交给我',
  '好，我来',
];

/** 单句上限(字符数,含标点;池句设计与测试双重锁定,防后续加句失控)。 */
export const STATIC_FILLER_MAX_CHARS = 5;

/** 模式开关:TC_VOICE_FILLER_MODE=llm → 旧动态生成档;缺省/其它值 = 静态池(默认)。 */
export function isStaticFillerMode(): boolean {
  return process.env.TC_VOICE_FILLER_MODE !== 'llm';
}

export interface PickStaticFillerOptions {
  /** 最近已用过的句子(环缓冲;命中者从候选剔除,保证「别连续同款」)。 */
  exclude?: readonly string[];
  /** 随机源(测试注入;缺省 Math.random)。 */
  rng?: () => number;
}

/** 从池内随机选一句;全部被 exclude 时退化为全池随机(池远大于保留窗,实际不可达)。 */
export function pickStaticFiller(options: PickStaticFillerOptions = {}): string {
  const rng = options.rng ?? Math.random;
  const excluded = new Set(options.exclude ?? []);
  const preferred = STATIC_FILLER_PHRASES.filter((p) => !excluded.has(p));
  const pool = preferred.length > 0 ? preferred : STATIC_FILLER_PHRASES;
  const idx = Math.max(0, Math.min(pool.length - 1, Math.floor(rng() * pool.length)));
  return pool[idx]!;
}
