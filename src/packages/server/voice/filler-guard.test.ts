/**
 * 垫话承诺护栏 —— 单测。
 *
 * 正例矩阵(必须拦):四类违规 × 各种句式(含事故原句「好嘞,两分钟后喊你」);
 * 负例矩阵(必须放行):「好嘞/我看看/这就办/马上办」类过程应答 + 易误伤词
 * (十分抱歉/个人建议/半点问题/不一定/好了解了/一件事)。
 * 宁缺毋滥:误拦一句只少句垫话(重生成/静默兜底),漏拦一句 = 再次食言。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  FILLER_RULE_GUIDANCE,
  checkFillerSafety,
  isFillerGuardEnabled,
  type FillerGuardRule,
} from './filler-guard.js';

// ============================================================================
// 正例矩阵:必须拦下
// ============================================================================

describe('checkFillerSafety —— 违规必拦', () => {
  const positives: Array<[string, string]> = [
    // ①时间承诺:时长 / 时刻 / 待办时点 / 加急完成
    ['好嘞,两分钟后喊你', 'time-promise'], // 2026-10-05 23:56 事故原句
    ['三分钟后叫你', 'time-promise'],
    ['我五分钟后提醒你', 'time-promise'],
    ['半小时后办', 'time-promise'],
    ['两天后提醒你', 'time-promise'],
    ['给我一分钟', 'time-promise'],
    ['等我几秒', 'time-promise'],
    ['等我十分钟', 'time-promise'],
    ['一小时后回你', 'time-promise'],
    ['十分内给你看', 'time-promise'],
    ['３分钟后叫你', 'time-promise'], // 全角数字先归一
    ['稍后叫你', 'time-promise'],
    ['明早叫你', 'time-promise'],
    ['明天叫你', 'time-promise'],
    ['今晚通知你', 'time-promise'],
    ['待会儿喊你', 'time-promise'],
    ['回头告诉你', 'time-promise'],
    ['下午叫你', 'time-promise'],
    ['两点半提醒你', 'time-promise'],
    ['三点钟提醒你', 'time-promise'],
    ['8:30叫你', 'time-promise'],
    ['1点半喊你', 'time-promise'],
    ['马上就好', 'time-promise'],
    ['马上办好', 'time-promise'],
    ['马上弄完', 'time-promise'],
    ['这就好了', 'time-promise'],
    ['马上回你', 'time-promise'],
    // ②完成宣告
    ['已经办好了', 'done-claim'],
    ['搞定了', 'done-claim'],
    ['办好啦', 'done-claim'],
    ['弄好了', 'done-claim'],
    ['完事儿了', 'done-claim'],
    ['查到了', 'done-claim'],
    ['看到了看到了', 'done-claim'],
    ['找到了', 'done-claim'],
    ['拿到了', 'done-claim'],
    ['问过了', 'done-claim'],
    ['好了,这就去', 'done-claim'],
    ['妥了', 'done-claim'],
    ['完成了', 'done-claim'],
    // ③结果断言
    ['三条都出来了', 'result-claim'],
    ['查到 5 条', 'result-claim'],
    ['有 3 个结果', 'result-claim'],
    ['两份都改好', 'result-claim'],
    ['四份都通知了', 'result-claim'],
    ['两件事我看看', 'result-claim'],
    ['八位都在忙', 'result-claim'],
    // ④保证类
    ['一定给你办', 'guarantee'],
    ['保证办到位', 'guarantee'],
    ['肯定没问题', 'guarantee'],
    ['绝对查清楚', 'guarantee'],
    ['包在我身上', 'guarantee'],
  ];

  for (const [text, rule] of positives) {
    it(`拦「${text}」→ ${rule}`, () => {
      const violation = checkFillerSafety(text);
      expect(violation, `应拦下:${text}`).not.toBeNull();
      expect(violation?.rule).toBe(rule);
      expect(violation?.matched).toBeTruthy();
    });
  }
});

// ============================================================================
// 负例矩阵:必须放行
// ============================================================================

describe('checkFillerSafety —— 过程应答放行', () => {
  const negatives = [
    // 允许句式:收到 + 马上要做的过程动作
    '好嘞',
    '好嘞,这就办',
    '好嘞,马上办',
    '嗯,收到',
    '我看看',
    '我先瞅瞅',
    '我瞅瞅团队一',
    '我看看天气',
    '行,这就叫',
    '收到,我问问',
    '我去看一眼',
    '我去问问',
    '这就看',
    '我来处理',
    '好,我去看',
    '好嘞,这就查',
    '马上办',
    '这就去办',
    '我这就去',
    '我去问一下主管',
    // 一般应声
    '明白',
    '嗯嗯',
    '让我想想',
    '我查查',
    '让我核对核对',
    '我先捋一下',
    '我先确认一下',
    '我看看怎么回事',
    '好的,稍等',
    '稍等我看看',
    '收到,给您瞅瞅',
    '卡片那个我去问问',
    '这事儿我知道',
    '好嘞,我记下了',
    // 易误伤词边界
    '十分抱歉,我看看', // 「十分」不是时间量
    '个人建议我先看板', // 「个人」不是数量
    '半点问题没有', // 「半点」不是时刻
    '不一定,我看看', // 诚实的对冲,放行
    '好了解了,我看看', // 「好了解」是理解型应声,不是完成宣告
    '一条心先办事', // 「一条」不拦(一/个/次组合不误伤)
    '我待会儿看看', // 无承诺动作词(看看),不是定时承诺
    '马上看看', // 过程,不是完成
    '差不多就行了', // 「差不多」不是时间/数量
  ];

  for (const text of negatives) {
    it(`放行「${text}」`, () => {
      expect(checkFillerSafety(text), `不应拦:${text}`).toBeNull();
    });
  }
});

// ============================================================================
// 规则归属 / 优先级 / 开关
// ============================================================================

describe('规则归属与优先级', () => {
  it('多条命中按优先级报首个:时间 > 完成 > 结果 > 保证', () => {
    expect(checkFillerSafety('两分钟后都能办好三条')?.rule).toBe('time-promise');
    expect(checkFillerSafety('已经查到 5 条')?.rule).toBe('done-claim');
  });

  it('命中片段回传(matched 供日志与负例回灌)', () => {
    const v = checkFillerSafety('好嘞,两分钟后喊你');
    expect(v?.matched).toContain('两分钟');
  });

  it('空串/无 hit → null', () => {
    expect(checkFillerSafety('')).toBeNull();
  });

  it('四类违规都有重生成反馈口径(防缺条目)', () => {
    for (const rule of ['time-promise', 'done-claim', 'result-claim', 'guarantee'] as FillerGuardRule[]) {
      expect(FILLER_RULE_GUIDANCE[rule]).toBeTruthy();
    }
  });
});

describe('开关', () => {
  afterEach(() => {
    delete process.env.TC_VOICE_FILLER_GUARD;
  });

  it('TC_VOICE_FILLER_GUARD=0 关,其余开着', () => {
    const original = process.env.TC_VOICE_FILLER_GUARD;
    try {
      process.env.TC_VOICE_FILLER_GUARD = '0';
      expect(isFillerGuardEnabled()).toBe(false);
      delete process.env.TC_VOICE_FILLER_GUARD;
      expect(isFillerGuardEnabled()).toBe(true);
      process.env.TC_VOICE_FILLER_GUARD = '1';
      expect(isFillerGuardEnabled()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TC_VOICE_FILLER_GUARD;
      else process.env.TC_VOICE_FILLER_GUARD = original;
    }
  });
});
