/**
 * 语音伙伴 · 分钟级提醒 —— 确定性命令解析(纯函数;IO 在 voice-reminder-service / 路由)。
 *
 * 动机(2026-10-05 23:56 事故):「两分钟后叫我一下」被 hop1(42s 后)路由到天级
 * bolba 板,两分钟到点全链路寂静,而垫话已承诺「好嘞,两分钟后喊你」。修复:
 * 分钟级提醒走确定性快通道(毫秒解析,pre-hop1),不再依赖 LLM 解析 —— 见
 * obsidian-docs 06-10 与计划「垫话承诺护栏 + 分钟级提醒」。
 *
 * 设计取向(与 trigger-rules 同款「宁缺毋滥」):
 *   - 只收「N(阿拉伯/中文数字|半)(秒|分钟|小时|钟头)(后|之后|以后)」确定式时间;
 *     模糊时间(一会儿/待会儿)、绝对时刻(三点半)一律不命中,落回普通回合;
 *   - 疑问(吗/为什么/要不要…)、假设(要是/如果…)、否定(别/不用 → cancel)分道;
 *   - 参数边界(>24h、<15s)之外不命中,回落 hop1(长时事项本就走天级板);
 *   - 取消/列表为独立 op,回执话术由上层结合存储状态拼装。
 *
 * 本模块不 import 任何服务(防循环依赖);命中/不误报矩阵见 reminder-parse.test.ts,
 * 改规则必须同步改矩阵。
 */

// ============================================================================
// 常量与类型
// ============================================================================

/** 最短提前量:秒级预告解析器不接(误报/失真成本高于收益,回落普通回合)。 */
export const REMINDER_MIN_LEAD_MS = 15_000;

/** 最长提前量:24h 之外属天级事项,走 bolba 板,不进本通道。 */
export const REMINDER_MAX_LEAD_MS = 24 * 60 * 60 * 1000;

/** 事项文本展示上限(超长截断;只影响到点播报,不丢提醒本身)。 */
export const REMINDER_ITEM_MAX_CHARS = 40;

/** 建一条提醒(参数已过边界校验,可直接落库)。 */
export interface ReminderCreateCommand {
  op: 'create';
  /** 到点时刻(epoch ms;= now + delayMs,测试注入 now 钉死)。 */
  fireAt: number;
  /** 距 now 的毫秒数。 */
  delayMs: number;
  /** 原话时长文本(去「后」,如「两分钟」「半个小时」「30分钟」)——回执镜像用。 */
  durationSpoken: string;
  /** 事项文本(剥掉触发词/时间/礼貌语后的剩余,可能为空串 → 到点只报「到点了」)。 */
  itemText: string;
  /** 确定性回执话术(注册成功的默认播报;被上限拒绝时由上层换话术)。 */
  say: string;
}

/** 一次语音命中提醒通道的三种意图;null = 不命中(走原 hop 链路)。 */
export type ReminderCommand =
  | ReminderCreateCommand
  | { op: 'cancel' }
  | { op: 'list' };

// ============================================================================
// 词表与模式
// ============================================================================

/** 全角数字归一(ASR 偶发全角)。 */
const FULLWIDTH_DIGITS_RE = /[０-９]/g;

/**
 * 时长:数字(阿拉伯 ≤4 位 / 中文 1-4 字含「半」)+ 可选「个」+ 单位 + 后缀。
 * 单位备选顺序敏感:秒钟在秒前、分钟在分前(否则早退分支截短单位)。
 */
const DURATION_RE = /(\d{1,4}|[一二两三四五六七八九十半]{1,4})\s*(?:个)?\s*(小时|钟头|分钟|秒钟|秒|分)\s*(?:之后|以后|后)/;

const UNIT_MS: ReadonlyMap<string, number> = new Map([
  ['秒', 1_000],
  ['秒钟', 1_000],
  ['分', 60_000],
  ['分钟', 60_000],
  ['小时', 3_600_000],
  ['钟头', 3_600_000],
]);

/** 提醒触发短语:提醒/叫/喊/通知 + (一下)? + 我。 */
const TRIGGER_RE = /(?:提醒|叫|喊|通知)(?:一下)?我/;

/** 抽取事项时整段剥除触发短语(含尾随语气垫词「一下/下/一声」)。 */
const TRIGGER_STRIP_RE = /(?:提醒|叫|喊|通知)(?:一下)?我(?:一下|下|一声|个|吧|啊|呀)?/g;

/** 取消:「取消/撤销/撤掉/停掉 [(那个|刚才|这条…)] [的] (提醒|闹钟)」或「别/不用/不要再/别再 + 提醒我|叫我|…」。 */
const CANCEL_RE =
  /(?:取消|撤销|撤掉|停掉)(?:那个|刚才|刚刚|这条|那条)?(?:的)?(?:提醒|闹钟)|(?:别|不用|不要再|别再)(?:再)?(?:提醒我|提醒了|叫我|叫了|喊我|喊了|通知我|通知了)/;

/** 列表查询(在疑问守卫之前判,「有哪些提醒」这类疑问不算提问)。 */
const LIST_RE =
  /提醒(?:列表|清单)|(?:有|还有)(?:哪些|什么|几个|几条)(?:的)?提醒|(?:看看|看一下|瞧瞧|查看|查一下|查查)(?:我的|我)?(?:的)?提醒|我的提醒/;

/** 疑问守卫:提问/求确认一律不当作命令(落原链路,由 hop1 理解)。 */
const QUESTION_RE = /[？?]|吗|嘛|呢|为什么|怎么|咋|什么|是不是|要不要|用不用|该不该|好吗|行吗|对吗/;

/** 假设守卫(「要是…就好了」式愿望不是命令)。 */
const HYPOTHETICAL_RE = /要是|如果|假如|万一|的话/;

/**
 * 事项抽取用:起始/结尾礼貌语(含「别忘了/不要忘记」这类口语前缀;备选顺序敏感——
 * 「别忘记/不要忘记」必须排在「别忘了?」前,否则「别忘」先吃掉 记 留出残渣;
 * 「请」带后顾防「请假/请求」误剥)。
 */
const LEAD_POLITE_RE =
  /^(?:(?:不(?:要|用)忘(?:记|了)?|别忘记|别忘了?|记着|记得|帮我|给我|麻烦(?:你|您)?|谢谢|多谢|谢了|请(?!假|求|问|教|示)))+/;
const TAIL_POLITE_RE = /(?:谢谢|多谢|谢了)+$/;

/** 标点/空白剥除与首尾语气字(不剥「了」——「把火关了」的 了 有语义)。 */
const PUNCT_STRIP_RE = /[\s，。．.,!！?？、;；:："'“”‘’「」『』【】()（）]/g;
const EDGE_PARTICLE_RE = /^[吧啊呀哈呢嗯哦噢喔嘛嘞]+|[吧啊呀哈呢嗯哦噢喔嘛嘞]+$/;

const ZH_DIGITS: Readonly<Record<string, number>> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

// ============================================================================
// 数字解析
// ============================================================================

/**
 * 中文数字 → 数值(仅收本通道需要的形态:0.5(半)/1-9/十/十X/X十/X十Y,≤99)。
 * 不支持(一百/零/多段)返回 null → 整条不命中(宁缺毋滥)。
 */
export function parseChineseNumber(raw: string): number | null {
  if (raw === '半') return 0.5;
  if (!/^[一二两三四五六七八九十]+$/.test(raw)) return null;
  const tenIdx = raw.indexOf('十');
  if (tenIdx === -1) {
    return raw.length === 1 ? ZH_DIGITS[raw] ?? null : null;
  }
  const head = raw.slice(0, tenIdx);
  const tail = raw.slice(tenIdx + 1);
  if (head.length > 1 || tail.length > 1) return null;
  const tens = head === '' ? 1 : ZH_DIGITS[head];
  const ones = tail === '' ? 0 : ZH_DIGITS[tail];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/** 时长文本(如「两分钟」/「30分钟」/「半个小时」)与数字段 → 毫秒;不可解析 → null。 */
function durationTextToMs(numberPart: string, unit: string): number | null {
  const unitMs = UNIT_MS.get(unit);
  if (unitMs === undefined) return null;
  const value = /^\d+$/.test(numberPart) ? Number(numberPart) : parseChineseNumber(numberPart);
  if (value === null || Number.isNaN(value) || value <= 0) return null;
  return Math.round(value * unitMs);
}

// ============================================================================
// 事项抽取
// ============================================================================

/** 从原话剥出「事项」文本(显示/到点播报用;剥不干净无害,只影响播报措辞)。 */
export function extractReminderItem(text: string): string {
  let item = text;
  item = item.replace(DURATION_RE, '');
  item = item.replace(TRIGGER_STRIP_RE, '');
  item = item.replace(PUNCT_STRIP_RE, '');
  item = item.replace(LEAD_POLITE_RE, '').replace(TAIL_POLITE_RE, '');
  item = item.replace(EDGE_PARTICLE_RE, '');
  if (item.length > REMINDER_ITEM_MAX_CHARS) item = item.slice(0, REMINDER_ITEM_MAX_CHARS);
  return item.trim();
}

// ============================================================================
// 回执话术(确定性,纯函数)
// ============================================================================

/** 到点播报话术(服务端生成,随推送/轮询下发;客户端不自行拼)。 */
export function buildReminderFirePhrase(itemText: string): string {
  const item = itemText.trim();
  return item ? `老大,到点了:${item}。` : '老大,到点了。';
}

/** 取消回执(0 条 → 没有挂着可取消的;多条如实报数)。 */
export function buildReminderCancelSay(count: number): string {
  if (count <= 0) return '现在没有挂着的提醒。';
  return count === 1 ? '行,那条不提醒了。' : `行,那 ${count} 条都不提醒了。`;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 解析一段老板原话是否命中提醒通道。返回 null = 不命中(调用方照常走 hop1)。
 * now 可注入(测试钉 fireAt)。
 */
export function matchReminderCommand(text: string, now: number = Date.now()): ReminderCommand | null {
  const normalized = text
    .replace(FULLWIDTH_DIGITS_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .replace(/^[\s「『“"']+|[\s」』”"']+$/g, '')
    .trim();
  if (!normalized) return null;

  // 取消/列表先判(它们可带疑问语气:「取消提醒」问句化「有哪些提醒」也要接住)
  if (CANCEL_RE.test(normalized)) return { op: 'cancel' };
  if (LIST_RE.test(normalized)) return { op: 'list' };
  if (QUESTION_RE.test(normalized)) return null;
  if (HYPOTHETICAL_RE.test(normalized)) return null;

  const duration = DURATION_RE.exec(normalized);
  if (!duration) return null;
  if (!TRIGGER_RE.test(normalized)) return null;

  const delayMs = durationTextToMs(duration[1], duration[2]);
  if (delayMs === null) return null;
  if (delayMs < REMINDER_MIN_LEAD_MS || delayMs > REMINDER_MAX_LEAD_MS) return null;

  const rawDurationText = duration[0].replace(/(?:之后|以后|后)$/, '').replace(/\s+/g, '');
  const itemText = extractReminderItem(normalized);
  const say = `好嘞,${rawDurationText}后${itemText ? `提醒你${itemText}` : '喊你'}。`;
  return {
    op: 'create',
    fireAt: now + delayMs,
    delayMs,
    durationSpoken: rawDurationText,
    itemText,
    say,
  };
}
