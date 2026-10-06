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

// ============================================================================
// F3 · 交接笔记预生成(纯函数)
// ============================================================================

/** 预生成便签(内存态;F4 在轮换点认领后写进 memory.handoff)。 */
export interface HandoffNote {
  forSessionId: string;
  text: string;
  at: number;
}

/**
 * F3 预生成运行时(模块级内存,不落盘——异步完成时若写状态文件,会与回合流的
 * 整文件保存竞态互相覆盖;认领只发生在串行轮换点,窗口内进程重启 = 丢预生成
 * = 降级现状,可接受)。
 */
export interface HandoffPregenRuntime {
  /** 已生成待认领的便签。 */
  pending: HandoffNote | null;
  /** 在途生成的会话 id(防重入;完成/失败后清)。 */
  inFlight: string | null;
  /** 上次预生成 {sessionId, turns}(同会话 ≥2 回合冷却,防每回合都生成)。 */
  lastPregen: { sessionId: string; turns: number } | null;
}

/** 预备线 = 触发线 − 0.1(缺省 0.3 → 0.2 = 40K@200K;留一段提前量给生成)。 */
export const HANDOFF_PREPARE_GAP = 0.1;
/** 同会话预生成冷却:≥2 回合(L3 参数表)。 */
export const HANDOFF_PREGEN_COOLDOWN_TURNS = 2;
/** 预生成独立上限 15s(不占回合关键路径;超时即降级现状)。 */
export const HANDOFF_PREGEN_TIMEOUT_MS = 15_000;
/** 便签上限 300 字 / 下限 10 字(下限以下视为没写出有效内容)。 */
export const HANDOFF_TEXT_MAX_CHARS = 300;
export const HANDOFF_TEXT_MIN_CHARS = 10;

/** 触发判定:开关 + 会话/上下文就绪 + 跨过预备线 + 无在途 + 冷却已过。 */
export function shouldPregenHandoff(
  state: { sessionId: string | null; turns: number; context?: { tokensUsed: number; percent: number } | null },
  cfg: { contextCompactPercent: number; contextCompactTokens: number },
  runtime: HandoffPregenRuntime,
): boolean {
  if (!isHandoffEnabled()) return false;
  if (!state.sessionId || !state.context) return false;
  if (runtime.inFlight) return false;
  const last = runtime.lastPregen;
  if (last && last.sessionId === state.sessionId && state.turns - last.turns < HANDOFF_PREGEN_COOLDOWN_TURNS) {
    return false;
  }
  // 与 isContextCompactionDue 同为「取或」:percent 支或绝对值支任一跨线即触发。
  if (state.context.percent >= cfg.contextCompactPercent - HANDOFF_PREPARE_GAP) return true;
  return cfg.contextCompactTokens > 0 && state.context.tokensUsed >= cfg.contextCompactTokens * 0.8;
}

/** buildHandoffUserContent 的记忆侧材料(结构类型,避免与 service 循环依赖)。 */
export interface HandoffMemoryMaterial {
  notes?: Array<{ text: string }>;
  handoff?: { text: string } | null;
}

/**
 * 预生成输入材料:长期记忆(不重复)+ 上一张便签(未了事项优先保留)+ 最近对话(旧→新)。
 * 有界:对话段已由环缓冲封顶 1600 字,此处再防御性截断一次。
 */
export function buildHandoffUserContent(recentTurns: RecentTurn[], memory: HandoffMemoryMaterial): string {
  const parts: string[] = [];
  const notes = (memory.notes ?? []).map((n) => `- ${n.text}`).join('\n');
  parts.push(`【长期记忆（不重复）】\n${notes || '(无)'}`);
  if (memory.handoff?.text) parts.push(`【上一张交接便签（未了事项优先保留）】\n${memory.handoff.text}`);
  const dialog = recentTurns
    .map((t) => `${t.role === 'user' ? (t.event ? '系统事件' : '用户') : '助手'}: ${t.text}`)
    .join('\n')
    .slice(0, RECENT_TURNS_TOTAL_CHARS);
  parts.push(`【最近对话（旧→新）】\n${dialog || '(无)'}`);
  return parts.join('\n\n');
}

/** 交接便签的系统提示词:≤3 行 + 只许写材料中出现过的事实(禁止推测编造)。 */
export const HANDOFF_SYSTEM_PROMPT = [
  '你是「交接便签」生成器:把材料压缩成不超过 3 行中文便签,供下一个全新会话的语音助手快速接手。',
  '三行内容:',
  '① 最近在谈/在办什么;',
  '② 没了结 / 等着结果 / 承诺过的事(没有写「无」);',
  '③ 继续对话必须知道的语境(称呼/口径/情绪;没有写「无」)。',
  '硬规则:只许写材料中出现过的事实,禁止推测、补全、编造;不客套、不解释、不加标题,直接输出便签。',
].join('\n');

/** 剥引号包裹(中英文引号/书名号/括号引号)。 */
function stripQuotes(line: string): string {
  return line.replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim();
}

/**
 * 清洗模型输出:剥代码围栏 → 去空行 → 取≤3 行 → 逐行剥引号 → 总长 >300 截断;
 * 结果 <10 字返回 null(视为没写出有效内容,调用方降级现状)。
 */
export function cleanHandoffText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  }
  const lines = s
    .split(/\r?\n/)
    .map((l) => stripQuotes(l))
    .filter(Boolean)
    .slice(0, 3);
  let out = lines.join('\n').trim();
  if (out.length > HANDOFF_TEXT_MAX_CHARS) out = out.slice(0, HANDOFF_TEXT_MAX_CHARS);
  if (out.length < HANDOFF_TEXT_MIN_CHARS) return null;
  return out;
}

// ============================================================================
// F4 · 认领与渲染(纯函数)
// ============================================================================

/**
 * F4 渲染门控:交接便签只在「非本会话 + 72h 内」渲染。
 *
 * 会话门控的理由(C23 副作用):系统提示词每回合重发,不加 `forSessionId !== 当前会话`
 * 的话,**当前会话会看到描述自己的便签**(冗余且浪费);轮换后的新会话(sessionId 为
 * null 或新 id)才需要接手。空笔记不渲染(别把空段塞进提示词)。
 */
export function handoffRenderable(
  handoff: HandoffNote | null | undefined,
  currentSessionId: string | null,
  now: number,
): boolean {
  if (!handoff || !handoff.text.trim()) return false;
  if (handoff.forSessionId === currentSessionId) return false;
  return now - handoff.at <= HANDOFF_TTL_MS;
}

/**
 * F4 观测(⑦ 观测点接入):本回合交接状态——`attached`(新会话已带)/ `pending`
 * (已生成待认领)/ `stale`(有笔记但不可用:同会话或超 72h)/ `none`。
 * 进 context_stats 采样,供 ⑮ 标定认领率与时效命中。
 */
export function handoffObservation(
  handoff: HandoffNote | null | undefined,
  pending: HandoffNote | null,
  currentSessionId: string | null,
  now: number,
): 'attached' | 'pending' | 'stale' | 'none' {
  if (handoffRenderable(handoff, currentSessionId, now)) return 'attached';
  if (pending) return 'pending';
  if (handoff) return 'stale';
  return 'none';
}
