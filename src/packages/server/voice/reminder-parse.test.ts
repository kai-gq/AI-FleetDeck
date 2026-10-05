/**
 * 分钟级提醒解析 —— 纯函数单测(命中/不误报矩阵,改规则必须同步改矩阵)。
 *
 * 覆盖:时长式(阿拉伯/中文/半/个)、守卫(疑问/假设/边界/无触发词)、
 * 取消/列表意图、事项抽取(剥时间/触发/礼貌语)、回执与到点话术、中文数字解析。
 * 正例含 2026-10-05 事故原句「两分钟后叫我一下。」(ASR 带尾标点形态)。
 */
import { describe, expect, it } from 'vitest';
import {
  REMINDER_ITEM_MAX_CHARS,
  REMINDER_MAX_LEAD_MS,
  REMINDER_MIN_LEAD_MS,
  buildReminderCancelSay,
  buildReminderFirePhrase,
  extractReminderItem,
  matchReminderCommand,
  parseChineseNumber,
  type ReminderCreateCommand,
} from './reminder-parse.js';

const NOW = 1_700_000_000_000;

/** 断言命中 create 并返回其结果(便于逐字段钉)。 */
function expectCreate(text: string, delayMs: number): ReminderCreateCommand {
  const cmd = matchReminderCommand(text, NOW);
  expect(cmd, `应命中 create: ${text}`).not.toBeNull();
  expect(cmd!.op).toBe('create');
  const create = cmd as ReminderCreateCommand;
  expect(create.delayMs, `延迟不符: ${text}`).toBe(delayMs);
  expect(create.fireAt).toBe(NOW + delayMs);
  return create;
}

// ============================================================================
// 正例:创建(≥25)
// ============================================================================

describe('matchReminderCommand —— 创建正例', () => {
  it('事故原句与基本式(分钟)', () => {
    const a = expectCreate('两分钟后叫我一下。', 2 * 60_000);
    expect(a.durationSpoken).toBe('两分钟');
    expect(a.itemText).toBe('');
    expect(a.say).toBe('好嘞,两分钟后喊你。');

    const b = expectCreate('三分钟后提醒我喝水', 3 * 60_000);
    expect(b.itemText).toBe('喝水');
    expect(b.say).toBe('好嘞,三分钟后提醒你喝水。');
  });

  it('阿拉伯数字与不同单位', () => {
    expect(expectCreate('30分钟后提醒我开会', 30 * 60_000).itemText).toBe('开会');
    expect(expectCreate('1小时后提醒我', 60 * 60_000).durationSpoken).toBe('1小时');
    expect(expectCreate('90秒后叫我', 90 * 1_000).itemText).toBe('');
    expect(expectCreate('60秒后叫我', 60_000).durationSpoken).toBe('60秒');
    expect(expectCreate('15秒后提醒我', REMINDER_MIN_LEAD_MS).delayMs).toBe(15_000);
  });

  it('中文数字(含十位复合)与「半」', () => {
    expect(expectCreate('十分钟后喊我', 10 * 60_000).itemText).toBe('');
    expect(expectCreate('十五分钟后提醒我一下', 15 * 60_000).itemText).toBe('');
    expect(expectCreate('十一分钟后叫我', 11 * 60_000).delayMs).toBe(11 * 60_000);
    expect(expectCreate('二十分钟后提醒我开会', 20 * 60_000).delayMs).toBe(20 * 60_000);
    expect(expectCreate('二十五分钟后提醒我开会', 25 * 60_000).delayMs).toBe(25 * 60_000);
    expect(expectCreate('三十分钟后提醒我', 30 * 60_000).delayMs).toBe(30 * 60_000);
    expect(expectCreate('45分钟后提醒我站起来活动', 45 * 60_000).itemText).toBe('站起来活动');
    const halfHour = expectCreate('半个小时后叫我', 30 * 60_000);
    expect(halfHour.durationSpoken).toBe('半个小时');
    expect(expectCreate('半小时后叫我', 30 * 60_000).durationSpoken).toBe('半小时');
    expect(expectCreate('一个小时后提醒我吃药', 60 * 60_000).itemText).toBe('吃药');
    expect(expectCreate('两个小时后提醒我收衣服', 2 * 60 * 60_000).itemText).toBe('收衣服');
  });

  it('「之后/以后」变体与语序变体(时间在前/在后)', () => {
    expect(expectCreate('五分钟之后提醒我', 5 * 60_000).durationSpoken).toBe('五分钟');
    expect(expectCreate('两分钟以后叫我', 2 * 60_000).delayMs).toBe(120_000);
    expect(expectCreate('一小时之后叫我', 60 * 60_000).durationSpoken).toBe('一小时');
    expect(expectCreate('提醒我三分钟后喝水', 3 * 60_000).itemText).toBe('喝水');
    expect(expectCreate('提醒我两分钟后喝水', 2 * 60_000).itemText).toBe('喝水');
  });

  it('礼貌语/口语前后缀(帮我/记得/别忘了),且不残留在事项里', () => {
    expect(expectCreate('帮我两分钟后叫我一下', 2 * 60_000).itemText).toBe('');
    expect(expectCreate('记得五分钟后提醒我关火', 5 * 60_000).itemText).toBe('关火');
    expect(expectCreate('别忘了十分钟后提醒我取快递', 10 * 60_000).itemText).toBe('取快递');
    expect(expectCreate('不要忘记两分钟后提醒我喝水', 2 * 60_000).itemText).toBe('喝水');
    expect(expectCreate('两分钟后提醒我别忘记喝水', 2 * 60_000).itemText).toBe('喝水');
    expect(expectCreate('两分钟后叫我一下，谢谢', 2 * 60_000).itemText).toBe('');
  });

  it('其它触发词(喊/通知)与引号/全角数字归一', () => {
    expect(expectCreate('两分钟后通知我', 2 * 60_000).itemText).toBe('');
    expect(expectCreate('「两分钟后叫我一下」', 2 * 60_000).itemText).toBe('');
    expect(expectCreate('３０分钟后提醒我开会', 30 * 60_000).durationSpoken).toBe('30分钟');
  });

  it('边界:恰 24h 命中(≤上限),超一点/近一点即不命中', () => {
    expect(expectCreate('二十四小时后提醒我', 24 * 60 * 60_000).fireAt).toBe(NOW + REMINDER_MAX_LEAD_MS);
    expect(matchReminderCommand('二十五小时后提醒我', NOW)).toBeNull();
    expect(matchReminderCommand('十秒后提醒我', NOW)).toBeNull();
  });
});

// ============================================================================
// 正例:取消 / 列表
// ============================================================================

describe('matchReminderCommand —— 取消/列表意图', () => {
  it('取消句式(取消+提醒/闹钟、别/不用+动词)', () => {
    for (const text of [
      '取消提醒',
      '取消闹钟',
      '取消刚才的提醒',
      '撤销那个提醒',
      '别提醒我了',
      '别叫我了',
      '别再叫我了',
      '不用叫我了',
      '别喊我了',
    ]) {
      expect(matchReminderCommand(text, NOW), `应命中 cancel: ${text}`).toEqual({ op: 'cancel' });
    }
  });

  it('列表句式(有哪些/提醒列表/看看/我的提醒)', () => {
    for (const text of ['有哪些提醒', '还有哪些提醒', '有什么提醒', '提醒列表', '看看我的提醒', '我的提醒']) {
      expect(matchReminderCommand(text, NOW), `应命中 list: ${text}`).toEqual({ op: 'list' });
    }
  });
});

// ============================================================================
// 负例:不命中(≥20)
// ============================================================================

describe('matchReminderCommand —— 负例(不误报)', () => {
  it('疑问/追问(事故后的「你为什么没叫我」原句)一律不命中', () => {
    for (const text of [
      '两分钟后喊我了吗',
      '两分钟后提醒我了吗',
      '为什么没叫我',
      '为什么两分钟后不叫我',
      '两分钟后提醒我好吗',
      '三分钟后提醒我什么',
      '十分钟后要不要提醒我',
      '几点叫我呢？',
    ]) {
      expect(matchReminderCommand(text, NOW), `不应命中: ${text}`).toBeNull();
    }
  });

  it('假设/愿望语气不命中', () => {
    expect(matchReminderCommand('要是两分钟后提醒我就好了', NOW)).toBeNull();
    expect(matchReminderCommand('如果两分钟后提醒我就好了', NOW)).toBeNull();
    expect(matchReminderCommand('万一五分钟后提醒我就好了', NOW)).toBeNull();
  });

  it('无触发词 / 无时长 / 模糊时间 / 绝对时刻 不命中', () => {
    for (const text of [
      '我两分钟后出门',
      '五分钟',
      '提醒我',
      '提醒我喝水',
      '一会儿提醒我',
      '待会儿叫我',
      '三点半叫我',
      '明天早上七点叫我',
      '一小时后到',
    ]) {
      expect(matchReminderCommand(text, NOW), `不应命中: ${text}`).toBeNull();
    }
  });

  it('第三人不命中 / 无关「别叫」不误判为取消', () => {
    expect(matchReminderCommand('五分钟后提醒他', NOW)).toBeNull();
    expect(matchReminderCommand('他提醒我了', NOW)).toBeNull();
    expect(matchReminderCommand('别叫外卖', NOW)).toBeNull();
    expect(matchReminderCommand('取消订单', NOW)).toBeNull();
    expect(matchReminderCommand('帮我把提醒删了', NOW)).toBeNull();
  });

  it('空串/纯标点不命中', () => {
    expect(matchReminderCommand('', NOW)).toBeNull();
    expect(matchReminderCommand('  。 ', NOW)).toBeNull();
    expect(matchReminderCommand('「」', NOW)).toBeNull();
  });
});

// ============================================================================
// 事项抽取 / 话术 / 数字解析
// ============================================================================

describe('extractReminderItem —— 事项剥离', () => {
  it('剥时间/触发/礼貌语,保留事项本体;无事项 → 空串', () => {
    expect(extractReminderItem('三分钟后提醒我喝水')).toBe('喝水');
    expect(extractReminderItem('提醒我三分钟后喝水')).toBe('喝水');
    expect(extractReminderItem('记得五分钟后提醒我关火')).toBe('关火');
    expect(extractReminderItem('两分钟后叫我一下')).toBe('');
    expect(extractReminderItem('两分钟后叫我一下，谢谢')).toBe('');
  });

  it('语义字不误剥(「了」「请假」)与超长截断', () => {
    expect(extractReminderItem('五分钟后提醒我把火关了')).toBe('把火关了');
    expect(extractReminderItem('十分钟后提醒我请假')).toBe('请假');
    const long = extractReminderItem(`五分钟后提醒我${'写'.repeat(60)}`);
    expect(Array.from(long).length).toBe(REMINDER_ITEM_MAX_CHARS);
  });
});

describe('话术构建(确定性)', () => {
  it('到点话术:有事项报事项,无事项只报「到点了」', () => {
    expect(buildReminderFirePhrase('喝水')).toBe('老大,到点了:喝水。');
    expect(buildReminderFirePhrase('')).toBe('老大,到点了。');
  });

  it('取消话术按条数区分(0/1/多条)', () => {
    expect(buildReminderCancelSay(0)).toBe('现在没有挂着的提醒。');
    expect(buildReminderCancelSay(1)).toBe('行,那条不提醒了。');
    expect(buildReminderCancelSay(3)).toBe('行,那 3 条都不提醒了。');
  });
});

describe('parseChineseNumber', () => {
  it('基本/十位复合/半', () => {
    expect(parseChineseNumber('半')).toBe(0.5);
    expect(parseChineseNumber('一')).toBe(1);
    expect(parseChineseNumber('两')).toBe(2);
    expect(parseChineseNumber('十')).toBe(10);
    expect(parseChineseNumber('十五')).toBe(15);
    expect(parseChineseNumber('二十')).toBe(20);
    expect(parseChineseNumber('二十五')).toBe(25);
    expect(parseChineseNumber('九十九')).toBe(99);
  });

  it('不支持形态返回 null(一百/空/多段)', () => {
    expect(parseChineseNumber('一百')).toBeNull();
    expect(parseChineseNumber('')).toBeNull();
    expect(parseChineseNumber('二十三十')).toBeNull();
  });
});
