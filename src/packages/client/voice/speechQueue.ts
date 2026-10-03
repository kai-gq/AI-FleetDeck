/**
 * 播报队列:分句流水线的客户端半边 —— 句子进,音频顺序出。
 *
 * 「播当前句时预取下一句」:合成与播放是两个独立串行泵;播放第一句时,
 * 第二句已经在合成。合成最多领先 2 句,不会整段抢跑占用 TTS。
 *
 * 与 React/DOM 完全解耦(deps 注入)→ 单测用假 deps 锁行为;
 * 真实的 fetch/Audio 实现在 useSpeechQueue。
 *
 * 代际(gen):stop() 时 ++gen;迟到的合成结果(旧代)直接丢弃,绝不插队播放。
 */

export interface SpeechQueueDeps {
  /** 合成一句为音频 Blob(失败请抛)。 */
  synthesize(text: string, lang: string | undefined, signal: AbortSignal): Promise<Blob>;
  /** 播放 Blob,播放完/被打断才 settle。 */
  play(blob: Blob, signal: AbortSignal): Promise<void>;
  /** speaking 状态翻转回调(仅变化时)。 */
  onSpeakingChange?(speaking: boolean): void;
}

interface QueueItem {
  text: string;
  lang?: string;
}

/** 合成领先播放的上限(句数)。 */
const SYNTH_AHEAD_MAX = 2;

export class SpeechQueue {
  private readonly deps: SpeechQueueDeps;
  private textQueue: QueueItem[] = [];
  private blobQueue: Blob[] = [];
  private synthRunning = false;
  private playRunning = false;
  private synthController: AbortController | null = null;
  private playController: AbortController | null = null;
  private gen = 0;
  private speakingState = false;
  private idleWaiters: Array<() => void> = [];

  constructor(deps: SpeechQueueDeps) {
    this.deps = deps;
  }

  /** 追加一句待播文本(空白串忽略)。 */
  enqueue(text: string, lang?: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.textQueue.push({ text: trimmed, lang });
    this.pumpSynth();
    this.updateSpeaking();
  }

  /** 立即静音并清空:中止在进行的合成/播放,丢弃全部排队内容。 */
  stop(): void {
    this.gen++;
    this.textQueue = [];
    this.blobQueue = [];
    this.synthController?.abort();
    this.playController?.abort();
    this.updateSpeaking();
  }

  /** 全部播完(或被打断/失败清空)后 resolve;已空闲则立即 resolve。 */
  drain(): Promise<void> {
    if (!this.speakingState) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  get speaking(): boolean {
    return this.speakingState;
  }

  // --------------------------------------------------------------------------
  // 内部:两个泵
  // --------------------------------------------------------------------------

  private pumpSynth(): void {
    if (this.synthRunning) return;
    this.synthRunning = true;
    void this.synthLoop();
  }

  private async synthLoop(): Promise<void> {
    try {
      while (this.textQueue.length > 0 && this.blobQueue.length < SYNTH_AHEAD_MAX) {
        const item = this.textQueue[0];
        const generation = this.gen;
        const controller = new AbortController();
        this.synthController = controller;
        let blob: Blob | null = null;
        try {
          blob = await this.deps.synthesize(item.text, item.lang, controller.signal);
        } catch {
          blob = null; // 单句失败:跳过,不阻塞后续
        } finally {
          this.synthController = null;
        }
        if (generation !== this.gen) continue; // 期间被 stop():旧句作废,别动新队列
        this.textQueue.shift();
        if (blob) {
          this.blobQueue.push(blob);
          this.pumpPlay();
        }
        this.updateSpeaking();
      }
    } finally {
      this.synthRunning = false;
      this.updateSpeaking();
    }
  }

  private pumpPlay(): void {
    if (this.playRunning) return;
    this.playRunning = true;
    void this.playLoop();
  }

  private async playLoop(): Promise<void> {
    try {
      while (this.blobQueue.length > 0) {
        const blob = this.blobQueue[0];
        const generation = this.gen;
        const controller = new AbortController();
        this.playController = controller;
        try {
          await this.deps.play(blob, controller.signal);
        } catch {
          // 播放失败:跳过该句;被打断靠 gen 判断
        } finally {
          this.playController = null;
        }
        if (generation !== this.gen) continue;
        this.blobQueue.shift();
        this.pumpSynth(); // 腾出预取额度,继续合成后面的句子
        this.updateSpeaking();
      }
    } finally {
      this.playRunning = false;
      this.updateSpeaking();
    }
  }

  private updateSpeaking(): void {
    const next = this.textQueue.length > 0 || this.blobQueue.length > 0
      || this.synthRunning || this.playRunning;
    if (next !== this.speakingState) {
      this.speakingState = next;
      try {
        this.deps.onSpeakingChange?.(next);
      } catch {
        // 回调异常不影响队列
      }
    }
    if (!next && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
