/**
 * 语音伙伴 · 垫话承诺护栏(纯函数;2026-10-05 事故第二道防线)
 *
 * 事故:垫话(慢档)在 23:56:44 吐出「好嘞,两分钟后喊你」,而系统当时并没有
 * 分钟级提醒机制 —— 纯提示词方案(C18 已写「不承诺时间、不保证结果、不编进展」)
 * 被证伪,故加出口硬闸:按「承诺类别」拦,不按句子拦(否则只是补一句话,治标)。
 *
 * 四类违规(违规即拦,调用方重生成一次;仍违规 → 静默):
 *   1. time-promise  时间承诺:时长(两分钟后/给我一分钟)、时刻(三点半/8:30)、
 *                    待办时点(稍后叫你/明早喊你)、马上就好(含完成语义的加急);
 *   2. done-claim    完成宣告:已经/搞定了/办好了/查到了/看过了;
 *   3. result-claim  结果断言:数量(三条/5 份/两页)、产出断言;
 *   4. guarantee     保证类:一定/保证/肯定/绝对/包在我身上。
 * 放行(正例):「好嘞」「嗯,收到」「我看看」「我去问问」「这就办」「马上办」——
 * 只含「收到 + 马上要做的过程动作」,不含时间量、不含完成/结果断言。
 *
 * 边界抉择(宁缺毋滥:漏拦一句 = 再次食言,误拦一句 = 少句垫话,代价不对称):
 *   - 「马上办/这就办/这就叫」(过程)放行;「马上好/马上办完/这就好了」(含完成)拦;
 *   - 「不一定」(诚实对冲)放行;「一定给你办」拦;
 *   - 「十分抱歉」「个人建议」「半点问题」「待会儿看看」「马上看看」放行;
 *   - 「几分钟」不带「后」也拦(「给我一分钟」同属时间量承诺);
 *   - 「两分钟前」不拦(回溯,非承诺)——靠单位后 (?!前) 排除。
 * 开关:TC_VOICE_FILLER_GUARD=0 关(调用方判定);本模块只做纯匹配。
 */

export type FillerGuardRule = 'time-promise' | 'done-claim' | 'result-claim' | 'guarantee';

export interface FillerGuardViolation {
  rule: FillerGuardRule;
  /** 命中的原句片段(日志/回灌负例用)。 */
  matched: string;
}

/** 数量词:阿拉伯数字(全角先归一)与中文数字;「几」按不确定量一并拦(几秒/几分钟)。 */
const NUM = '[\\d一二两三四五六七八九十半几]{1,4}';

/**
 * 时间量:数字+时间单位。「分/天」单用歧义大(十分抱歉/今天),须带后缀;
 * 「秒/分钟/小时/钟头」后缀可选(「给我一分钟」「等我几秒」也是承诺);
 * (?!前) 排除「十分钟前」这类回溯表述(不是承诺)。
 */
const TIME_AMOUNT_SRC =
  `${NUM}\\s*(?:个)?\\s*(?:秒|秒钟|分钟|小时|钟头)(?!前)(?:钟|之?后|以后|以内|内)?` +
  `|${NUM}\\s*(?:个)?\\s*(?:分|天)(?:钟|之?后|以后|以内|内)`;

/**
 * 时刻:阿拉伯 3:30/3点(半/整/钟/多 可选);中文「一点」只认 点半/点整/点钟
 * (「差一点/轻一点」不误伤),其余中文数字「两点半」「三点钟」直认。
 */
const CLOCK_SRC =
  '\\d{1,2}\\s*[:：]\\s*\\d{1,2}' +
  '|\\d{1,2}\\s*点(?:半|整|钟|多)?' +
  '|(?:[二两三四五六七八九十]{1,2})\\s*点(?:半|整|钟|多)?' +
  '|一点\\s*(?:半|整|钟)';

/** 待办时点:时间词 + 承诺动作(叫/喊/提醒/通知/回头告诉你)。「回头再说/待会儿看看」不在此列(非承诺)。 */
const SCHEDULE_SRC =
  '(?:明早|明晚|明天|今晚|今早|早上|上午|中午|下午|晚上|稍后|到时|待会儿?|等会儿?|过会儿?|回头)' +
  '[^,，。!！?？;；]{0,4}(?:叫|喊|提醒|通知|告诉你|回你|回您|回复|答复)';

/** 加急+完成/回话语义:「马上就好/马上办完/这就好了/马上回你」拦;「马上办/看看」放行。 */
const HURRY_SRC = '(?:马上|立刻|立马|这就)[^,，。!！?？]{0,2}(?:好|完|妥|成|搞定|回|答复|回复)';

/** ①时间承诺(四类时间表述合一)。 */
const TIME_PROMISE_RE = new RegExp(`(?:${TIME_AMOUNT_SRC})|(?:${CLOCK_SRC})|(?:${SCHEDULE_SRC})|(?:${HURRY_SRC})`);

/** ②完成宣告;「好了(?!解)」排除「好了解/好了解了」这种理解型应声。 */
const DONE_CLAIM_RE =
  /(?:已经|完事儿?|搞定|办好|办妥|办完|弄好|弄妥|弄完|搞完|妥了|完成|好了(?!解)|好啦|查到了|看到了|拿到了|找到了|问过了|看过了|查过了|找过了|做过了|弄过了)/;

/** ③结果断言:阿拉伯数字+量词(3个/5条);中文数字+具体量词(两件/四份),
 *  排除「一/个/次」这类高频非数量组合(「一件事/几个/第一次」不误伤)。 */
const RESULT_CLAIM_RE =
  /(?:\d{1,4}\s*(?:条|个|项|位|份|件|人|次|页|张|台|字))|(?:[两三四五六七八九十几]{1,2}\s*(?:条|项|份|件|页|位|台))/;

/** ④保证类;「不一定」是诚实对冲,放行。 */
const GUARANTEE_RE = /(?<!不)一定|保证|肯定|绝对|包在我身上|包你满意/;

const RULES: ReadonlyArray<readonly [FillerGuardRule, RegExp]> = [
  ['time-promise', TIME_PROMISE_RE],
  ['done-claim', DONE_CLAIM_RE],
  ['result-claim', RESULT_CLAIM_RE],
  ['guarantee', GUARANTEE_RE],
];

/** 全角数字 → 半角(「３分钟」按「3分钟」拦)。 */
function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 纯函数:检查一句垫话是否含承诺类表述。
 * 返回 null = 安全可播;否则给出违规类别与命中片段(首个命中,rule 顺序即优先级)。
 */
export function checkFillerSafety(text: string): FillerGuardViolation | null {
  if (!text) return null;
  const normalized = normalizeDigits(text);
  for (const [rule, re] of RULES) {
    const m = re.exec(normalized);
    if (m) return { rule, matched: m[0] };
  }
  return null;
}

/** 开关:TC_VOICE_FILLER_GUARD=0 → 关。 */
export function isFillerGuardEnabled(): boolean {
  return process.env.TC_VOICE_FILLER_GUARD !== '0';
}

/** 违规类别的中文说明(重生成反馈/日志用;只给类别与正解,不给整句示例——防照抄)。 */
export const FILLER_RULE_GUIDANCE: Record<FillerGuardRule, string> = {
  'time-promise': '你承诺了时间(时长/时刻/待办时点/加急完成)',
  'done-claim': '你把事说成已经办完了',
  'result-claim': '你编了结果数量/产出',
  guarantee: '你用了保证类措辞',
};
