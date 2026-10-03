/**
 * 播报闸门:把 responseToUser 的「已完成句子」按当前 action 的语义放行/缓冲/丢弃。
 *
 * 为什么需要它(而不是抽到句子就播):
 * - action 未解析出来之前,句子一律缓冲 —— 不能让 noop(主动汇报的无事发生)
 *   先出半个字;
 * - send_to_agent 的确认话术(「已让 X 去做」)要等真正派发成功再放行,
 *   目标不存在/指令为空时静默丢弃,由最终回复整段兜底;
 * - query_agent_output 的答案来自第二跳(hop2),hop1 的 responseToUser 丢弃;
 * - general_response / list_agents 一旦 action 确定就即时放行(低延迟路径)。
 */

export type GateAction =
  | 'general_response'
  | 'send_to_agent'
  | 'list_agents'
  | 'query_agent_output'
  | 'noop';

export class SpeechGate {
  private readonly emit: (sentence: string) => void;
  private mode: GateAction | null = null;
  private buffered: string[] = [];
  private emitted = 0;

  constructor(emit: (sentence: string) => void) {
    this.emit = emit;
  }

  /** 收到一个「完整句子」。action 未定 / send_to_agent 待派发时先缓冲。 */
  push(sentence: string): void {
    const text = sentence.trim();
    if (!text) return;
    if (this.mode === null || this.mode === 'send_to_agent') {
      this.buffered.push(text);
      return;
    }
    if (this.mode === 'noop' || this.mode === 'query_agent_output') return;
    this.flushEmit(text);
  }

  /**
   * action 已解析(流式扫描通常远早于契约解析完成)。
   * general/list → 立即放行缓冲;noop/query → 丢弃;send → 继续等 release/discard。
   */
  setAction(action: GateAction): void {
    this.mode = action;
    if (action === 'noop' || action === 'query_agent_output') {
      this.buffered = [];
    } else if (action !== 'send_to_agent') {
      this.release();
    }
  }

  /** 派发成功:放行缓冲的确认话术。 */
  release(): void {
    const pending = this.buffered;
    this.buffered = [];
    for (const sentence of pending) this.flushEmit(sentence);
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

  private flushEmit(sentence: string): void {
    this.emitted++;
    this.emit(sentence);
  }
}
