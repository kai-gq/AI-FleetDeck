/**
 * 播报闸门:把 responseToUser 的「已完成句子」按当前 action 的语义放行/缓冲/丢弃。
 *
 * 为什么需要它(而不是抽到句子就播):
 * - action 未解析出来之前,句子一律缓冲 —— 不能让 noop(主动汇报的无事发生)
 *   先出半个字;
 * - 派发类动作(send_to_agent / delegate_to_boss)的确认话术(「已让 X 去做」/
 *   「已交给主管安排」)要等真正派发成功再放行,目标无效/指令为空时静默丢弃,
 *   由最终回复整段兜底;
 * - query_agent_output 的过渡话术(≤12 字先应声)同样缓冲,等确定要跑第二跳
 *   (hop2)时显式 release —— 带 pre 标记照播但不参与客户端最终对账;目标无效/
 *   无委派时 discard,由最终回复整段兜底(W4 感知提速:等待也有声);
 * - analyze_logs 的报告由分析 agent 产出(外部进程),hop1 的 responseToUser 同样丢弃;
 * - 任务13·⑩:query/create/complete/reopen_bolba_task 的结果由服务端 Bolba 桥确定性
 *   产出,hop1 的 responseToUser 一律丢弃(显式 GateAction 成员,不借别名);
 * - 任务16·⑬:cancel_delegation / rate_delegation 的结果同样由服务端确定性产出
 *   (撤回结论/评价确认),hop1 话术一律丢弃(显式 GateAction 成员);
 * - general_response / list_agents 一旦 action 确定就即时放行(低延迟路径)。
 */

export type GateAction =
  | 'general_response'
  | 'delegate_to_boss'
  | 'send_to_agent'
  | 'list_agents'
  | 'query_agent_output'
  | 'analyze_logs'
  // 任务13·⑩ 秘书 Bolba 桥:结果由服务端确定性产出,hop1 话术一律不出声(显式门)。
  | 'query_bolba_tasks'
  | 'create_bolba_task'
  | 'complete_bolba_task'
  | 'reopen_bolba_task'
  // 任务16·⑬ 撤回/评价:撤回结论与评价确认由服务端确定性产出,hop1 话术一律丢弃。
  | 'cancel_delegation'
  | 'rate_delegation'
  | 'noop';

/** 派发类动作:确认话术要等派发成功才放行(失败即丢弃)。 */
export function isDispatchGateAction(action: GateAction): boolean {
  return action === 'send_to_agent' || action === 'delegate_to_boss';
}

/** 句子元信息:pre=true 表示过渡/垫话句 —— 照播,但不参与客户端最终对账。 */
export interface SentenceMeta {
  pre?: boolean;
}

/**
 * 延迟裁决类动作:hop1 话术先缓冲,等显式 release/discard。
 * - 派发类:派发成功才放行;
 * - query_agent_output:确认要跑 hop2 时放行(带 pre 标记的过渡话术)。
 * 注意:list_agents 不在其中 —— 它慢在模型 TTFT,缓冲只会推迟出声。
 */
export function isDeferredGateAction(action: GateAction): boolean {
  return isDispatchGateAction(action) || action === 'query_agent_output';
}

/** 静默丢弃类动作:hop1 话术由服务端确定性产出/无话可说,一律不出声。 */
const SILENT_GATE_ACTIONS: ReadonlySet<GateAction> = new Set([
  'noop', 'analyze_logs',
  'query_bolba_tasks', 'create_bolba_task', 'complete_bolba_task', 'reopen_bolba_task',
  'cancel_delegation', 'rate_delegation',
]);

export class SpeechGate {
  private readonly emit: (sentence: string, meta?: SentenceMeta) => void;
  private mode: GateAction | null = null;
  private buffered: string[] = [];
  private emitted = 0;

  constructor(emit: (sentence: string, meta?: SentenceMeta) => void) {
    this.emit = emit;
  }

  /** 收到一个「完整句子」。action 未定 / 延迟裁决类动作时先缓冲。 */
  push(sentence: string): void {
    const text = sentence.trim();
    if (!text) return;
    if (this.mode === null || isDeferredGateAction(this.mode)) {
      this.buffered.push(text);
      return;
    }
    if (SILENT_GATE_ACTIONS.has(this.mode)) return;
    this.flushEmit(text);
  }

  /**
   * action 已解析(流式扫描通常远早于契约解析完成)。
   * general/list → 立即放行缓冲;静默丢弃类 → 清空;延迟裁决类 → 继续等 release/discard。
   */
  setAction(action: GateAction): void {
    this.mode = action;
    if (isDeferredGateAction(action)) return;
    if (SILENT_GATE_ACTIONS.has(action)) {
      this.buffered = [];
      return;
    }
    this.release();
  }

  /** 裁决通过:放行缓冲话术(meta 透传给消费端,如 query 过渡句的 pre 标记)。 */
  release(meta?: SentenceMeta): void {
    const pending = this.buffered;
    this.buffered = [];
    for (const sentence of pending) this.flushEmit(sentence, meta);
  }

  /** 派发失败/目标无效:静默丢弃缓冲(最终回复走 spoke=false 整段兜底)。 */
  discard(): void {
    this.buffered = [];
  }

  /** 已播出的句数(0 = 一字未出,作为 final 行的 spoke 标志)。 */
  get spokenCount(): number {
    return this.emitted;
  }

  get spoke(): boolean {
    return this.emitted > 0;
  }

  private flushEmit(sentence: string, meta?: SentenceMeta): void {
    this.emitted++;
    this.emit(sentence, meta);
  }
}
