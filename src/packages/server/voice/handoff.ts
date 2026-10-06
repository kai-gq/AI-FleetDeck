/**
 * 语音伙伴 · 长会话治理:最近轮次环缓冲(交接材料源;任务39·F2)
 *
 * 背景(06-10 §1e 实测):长会话退化主因 = 会话历史(同句新会话 3.6s vs
 * 长会话 74.4s,thinking ~140×),轮换是唯一杠杆;但轮换 = 新会话从零开始,
 * 必须把「刚才在聊什么」交接过去 —— 本模块维护交接素材的**有界**环缓冲。
 *
 * 语义:
 *   - 只记进入模型的语义文本(用户句 / 助手最终回复),不记思考、不记事件 payload;
 *   - 事件回合(主动汇报等)也记,event:true 标记(是语境,渲染时可区分);
 *   - 逐条 240 字、最多 8 条、总量 1600 字,超限丢最旧(交接材料宁短勿长);
 *   - 落盘随既有整状态文件(loadCompanionState 逐条 sanitize);轮换时清空。
 *
 * 开关:TC_VOICE_HANDOFF=0 关(调用方判定;本模块只做纯函数 + 开关读取)。
 */

export interface RecentTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  /** 系统事件回合(非用户开口;如「XX 办好了」主动汇报)。 */
  event?: true;
}

/** 环缓冲上限:最多 8 条。 */
export const RECENT_TURNS_MAX = 8;
/** 逐条截断:240 字(L3 参数表)。 */
export const RECENT_TURN_MAX_CHARS = 240;
/** 总量上限:1600 字(超限丢最旧)。 */
export const RECENT_TURNS_TOTAL_CHARS = 1600;
/** 交接笔记时效:72h(超时不再渲染;L3 参数表)。 */
export const HANDOFF_TTL_MS = 72 * 3_600_000;

export function isHandoffEnabled(): boolean {
  return process.env.TC_VOICE_HANDOFF !== '0';
}

/** 归一:压平空白(念白/多行 → 单空格)、trim、截断到 240 字;非法输入 → 空串。 */
export function normalizeTurnText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, RECENT_TURN_MAX_CHARS);
}

/** 应用条数/总量上限(丢最旧);输入按旧→新排列。 */
function boundRecentTurns(list: RecentTurn[]): RecentTurn[] {
  const out = list.slice(-RECENT_TURNS_MAX);
  let total = out.reduce((n, t) => n + t.text.length, 0);
  while (out.length > 0 && total > RECENT_TURNS_TOTAL_CHARS) {
    total -= out[0]!.text.length;
    out.shift();
  }
  return out;
}

/**
 * 追加一条(返回新数组,不改入参)。空文本不留痕(不占位,避免把「(无)」类
 * 噪声当材料);随后统一应用条数/总量上限。
 */
export function appendRecentTurn(list: RecentTurn[] | undefined, turn: RecentTurn): RecentTurn[] {
  const text = normalizeTurnText(turn.text);
  if (!text) return [...(list ?? [])];
  return boundRecentTurns([...(list ?? []), { ...turn, text }]);
}

/** 状态文件加载容错:逐条校验 role/text/at;坏条目丢弃;统一应用上限。 */
export function sanitizeRecentTurns(raw: unknown): RecentTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const text = normalizeTurnText(r.text);
    if (!text) continue;
    out.push({
      role: r.role,
      text,
      at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
      ...(r.event === true ? { event: true as const } : {}),
    });
  }
  return boundRecentTurns(out);
}
