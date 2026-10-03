/**
 * Silero VAD 的纯逻辑核心(零 ort 依赖,node 可单测)。
 *
 * 官方 v5 模型在 16k 采样率下的输入约定(已实测确认):
 *   每次推理喂 576 个样本 = 64 个「上下文」(上一窗末尾样本)+ 512 个「新跳距」;
 *   只喂 512 也能跑但概率会失真(实测静音概率反而更高)——必须按 64+512 拼接。
 *   LSTM 状态 2×1×128,随窗滚动回灌。
 *
 * 本核心负责三件事:
 *   1. 窗口组装:把 480 样本/30ms 的音频帧流按 512 跳距切窗、补 64 上下文;
 *   2. 单飞 + 丢最旧的异步推理队列:音频回调永不阻塞,推理积压时只保留最新窗
 *      (丢弃导致状态略微滞后,但 16 窗/s 且单窗推理 ~1ms,实际几乎不丢);
 *   3. 对外只暴露「最近一次完成」的语音概率:模型滞后有界,由上层作概率迟滞判定。
 */

/** 16k 采样率下的跳距(新增样本数)。 */
export const SILERO_WINDOW = 512;
/** 上下文样本数(上一窗末尾)。 */
export const SILERO_CONTEXT = 64;
/** 模型输入长度:576 = 64 上下文 + 512 跳距。 */
export const SILERO_INPUT_SIZE = SILERO_WINDOW + SILERO_CONTEXT;
/** LSTM 状态长度:2×1×128。 */
export const SILERO_STATE_SIZE = 2 * 1 * 128;

export interface WindowAssembler {
  /** 推入一帧音频(任意长度),返回本次凑齐的完整窗口(长度 576)。 */
  push(frame: Float32Array): Float32Array[];
  reset(): void;
}

/** 帧流 → 576 样本窗口(64 上下文 + 512 跳距),首窗上下文为零。 */
export function createWindowAssembler(
  windowSize = SILERO_WINDOW,
  contextSize = SILERO_CONTEXT,
): WindowAssembler {
  let pending = new Float32Array(0);
  let context = new Float32Array(contextSize);

  return {
    push(frame: Float32Array): Float32Array[] {
      const buf = new Float32Array(pending.length + frame.length);
      buf.set(pending, 0);
      buf.set(frame, pending.length);

      const out: Float32Array[] = [];
      let offset = 0;
      while (buf.length - offset >= windowSize) {
        const win = new Float32Array(windowSize + contextSize);
        win.set(context, 0);
        win.set(buf.subarray(offset, offset + windowSize), contextSize);
        out.push(win);
        // 下一窗的上下文 = 本窗末尾 contextSize 个样本
        context = buf.slice(offset + windowSize - contextSize, offset + windowSize);
        offset += windowSize;
      }
      pending = buf.slice(offset);
      return out;
    },
    reset(): void {
      pending = new Float32Array(0);
      context = new Float32Array(contextSize);
    },
  };
}

export interface SileroInferResult {
  /** 语音概率 0..1。 */
  prob: number;
  /** 新的 LSTM 状态(长度 SILERO_STATE_SIZE)。 */
  state: Float32Array;
}

/** 单窗推理(真实实现包 onnxruntime;测试注入假实现)。 */
export type SileroInfer = (input: Float32Array, state: Float32Array) => Promise<SileroInferResult>;

export interface SileroVadCore {
  /** 推入一帧音频;返回「最近完成」的语音概率(null = 尚无结果)。 */
  push(frame: Float32Array): number | null;
  /** 最近完成的概率。 */
  prob(): number | null;
  /** 观测:在途 + 排队中的窗口数(测试用)。 */
  pendingCount(): number;
  reset(): void;
}

export interface SileroVadCoreOptions {
  /** 排队上限(不含在途的 1 个);超出丢最旧。默认 2。 */
  maxQueue?: number;
}

/**
 * 异步推理核心:同一时刻至多 1 个推理在途,积压窗口按「丢最旧」截断,
 * reset() 后到达的旧结果一律作废(代数守卫)。
 */
export function createSileroVadCore(infer: SileroInfer, opts: SileroVadCoreOptions = {}): SileroVadCore {
  const maxQueue = Math.max(0, opts.maxQueue ?? 2);
  const assembler = createWindowAssembler();
  let state: Float32Array = new Float32Array(SILERO_STATE_SIZE);
  let queue: Float32Array[] = [];
  let inflight = false;
  let lastProb: number | null = null;
  let generation = 0;

  function drain(): void {
    if (inflight) return;
    const win = queue.shift();
    if (!win) return;
    inflight = true;
    const gen = generation;
    void infer(win, state)
      .then((res) => {
        if (gen !== generation) return; // reset 后到达:作废
        state = res.state;
        lastProb = res.prob;
      })
      .catch(() => {
        // 单窗失败:保持旧概率与旧状态,继续消费后续窗口(不打断整条链路)
      })
      .finally(() => {
        if (gen !== generation) return;
        inflight = false;
        drain();
      });
  }

  return {
    push(frame: Float32Array): number | null {
      for (const win of assembler.push(frame)) {
        queue.push(win);
        while (queue.length > maxQueue) queue.shift(); // 积压:丢最旧
      }
      drain();
      return lastProb;
    },
    prob: () => lastProb,
    pendingCount: () => queue.length + (inflight ? 1 : 0),
    reset(): void {
      generation++;
      assembler.reset();
      state = new Float32Array(SILERO_STATE_SIZE);
      queue = [];
      inflight = false;
      lastProb = null;
    },
  };
}
