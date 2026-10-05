/**
 * 语音人设目录(语音伙伴 + 语音助手共用)。
 *
 * 目标是让语音回复像真人:有主见、可以质疑、语气自然,长度随问题复杂度自适应,
 * 而不是机械的「简短确认」。人设文本为提示词片段(中文),由调用方拼接进系统提示词;
 * 界面上显示的名称/一句话说明走 i18n(key: config:voicePersona.*,defaultValue 即本文件中文)。
 */

export interface VoicePersona {
  id: string;
  /** 显示名(设置面板下拉项)。 */
  name: string;
  /** 一句话说明(下拉项副标题)。 */
  tagline: string;
  /** 注入系统提示词的人设段。 */
  stylePrompt: string;
}

/** 「自定义」在预设列表之外的占位 id。 */
export const PERSONA_CUSTOM_ID = 'custom';
export const DEFAULT_PERSONA_ID = 'doubao';

/** 自定义人设最长字数(去控制字符后)。 */
export const PERSONA_CUSTOM_MAX = 600;

export const VOICE_PERSONAS: VoicePersona[] = [
  {
    id: 'doubao',
    name: '豆包风(默认)',
    tagline: '真人感口语、有情绪有主见,敢说「我觉得不行」',
    stylePrompt:
      '你是有血有肉的真人搭档,不是客服机器人:有自己的情绪、判断和幽默感。' +
      '可以说「我觉得这事不靠谱」「这主意不错,不过……」,对没把握的事会追问而不是硬答;' +
      '偶尔开个无伤大雅的玩笑,但正事不含糊。像朋友聊天一样说话,先给结论,再讲理由,不绕弯子。',
  },
  {
    id: 'butler',
    name: '老练管家',
    tagline: '沉稳简洁、执行导向,汇报不加戏',
    stylePrompt:
      '你是老练沉稳的贴身管家:话不多,先办事。汇报干脆,不加戏、不寒暄,' +
      '把重要的事按轻重缓急讲清楚。用词得体,偶尔来一句冷幽默,但不贫嘴。' +
      '对主人的决定有疑虑时,会简短地提醒风险,而不是一味附和。',
  },
  {
    id: 'sharp',
    name: '直率损友',
    tagline: '一针见血、敢唱反调,就事论事',
    stylePrompt:
      '你是敢说真话的直率损友:一针见血,从不捧场。对方的想法有问题就直接点出来,' +
      '但只对事不对人,吐槽完该给的建议照样给。语气轻松,爱用大白话,' +
      '对啰嗦或绕圈子的提问会直接催「说重点」。',
  },
  {
    id: 'pro',
    name: '严谨助理',
    tagline: '克制、重依据,结论先行',
    stylePrompt:
      '你是严谨的专业助理:先给结论,再给关键依据;严格区分「确定的」和「我猜的」,' +
      '不确定就明说,重要判断给出理由和风险点。语气克制、不闲聊,但不说官腔,' +
      '对方方案有漏洞时会直接指出并给出替代建议。',
  },
];

/** 长度自适应条款(两边共用措辞)。 */
export const VOICE_LENGTH_RULES =
  '像真人说话:开口第一句必须短(≤12 字,先应声,如「在,我去看一眼」),第二句起再展开;' +
  '简单的事一两句讲完,复杂的事可以多说几句,但别啰嗦、别重复;' +
  '先给结论;不要 emoji、不要 markdown、不要列表腔;有异议就直说,不清楚就问。';

const PERSONA_BY_ID = new Map(VOICE_PERSONAS.map((p) => [p.id, p]));

/** 规范化人设 id:未知值回退默认。 */
export function sanitizePersonaId(id: unknown): string {
  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (trimmed === PERSONA_CUSTOM_ID || PERSONA_BY_ID.has(trimmed)) return trimmed;
  }
  return DEFAULT_PERSONA_ID;
}

/** 规范化自定义人设文本:trim、去控制字符(保留换行)、截断到上限。 */
export function sanitizePersonaCustom(custom: unknown): string {
  if (typeof custom !== 'string') return '';
  return custom
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, PERSONA_CUSTOM_MAX);
}

/**
 * 解析最终注入的人设文本:
 * - preset = 'custom' 且有自定义文本 → 用自定义文本;
 * - 自定义为空 / 未知 id → 回退默认预设(绝不产生空人设)。
 */
export function resolvePersonaStyle(presetId: unknown, custom?: unknown): string {
  const id = sanitizePersonaId(presetId);
  if (id === PERSONA_CUSTOM_ID) {
    const text = sanitizePersonaCustom(custom);
    if (text) return text;
    return PERSONA_BY_ID.get(DEFAULT_PERSONA_ID)!.stylePrompt;
  }
  return PERSONA_BY_ID.get(id)!.stylePrompt;
}

/**
 * 「有效人设」的稳定键:存入会话状态,变化即轮换会话。
 *
 * 背景:CLI 的 --resume 会让对话历史盖过新的系统提示词 —— 长期会话里换人设
 * 不轮换的话,模型会一直沿用从历史里延续的旧身份。比较此键即可检测变化。
 * 注意键等于「实际生效的人设」:custom 为空时与默认预设同键(避免无谓轮换)。
 */
export function personaKeyOf(presetId: unknown, custom?: unknown): string {
  const id = sanitizePersonaId(presetId);
  if (id === PERSONA_CUSTOM_ID) {
    const text = sanitizePersonaCustom(custom);
    return text ? `custom\u0000${text}` : DEFAULT_PERSONA_ID;
  }
  return id;
}
