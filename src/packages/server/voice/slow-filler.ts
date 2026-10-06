/**
 * 慢档续垫(W5 感知提速):回合等待超过阈值仍无声时,补一句安抚垫话。
 *
 * 背景:hop1 的 TTFT 波动大(实测典型 5–30s),首句迟迟不出时用户面对的是
 * 纯静默。沿革:初版真人反馈「固定短语不好」→ 改按需动态生成;2026-10-06 复盘
 * 动态句「假/前言不搭」(拿半句 partial 生成 + 无上下文 + 提示词逼换说法),
 * 方案反转为**静态池为主**(选句见 voice/filler-phrases.ts,本状态机不变),
 * 动态生成降级为 TC_VOICE_FILLER_MODE=llm 实验档。
 *
 * 状态机(每回合一份实例):
 *   arm() ──armMs──→ 取句(generate;静态档为池内选句,llm 档为一次性 claude 调用)
 *   arm() ──emitMs──→ 到点且已就绪 → 吐一句(pre 通道,照播不进对账)
 *   (W7:预生成命中时 armMs=0 —— generate 直接取用说话期间已备好的文本,emitMs 用 pregenEmitMs)
 *   任一条件晚到就等另一个:文本就绪但未到 emitMs → 等到点才吐;到点但生成
 *   还没回来 → 生成一回来就吐(如果仍未被取消)。
 *   cancel()(真实首句出声/回合收尾/中止/事件回合)→ 幂等取消,在途结果作废。
 *
 * 纪律:每回合最多一句;取句失败/超时/太长 → 静默(绝不念半成品);不碰常驻
 * 进程、不污染主会话(resumeId 恒 null)。
 */

export interface SlowFillerOptions {
  /** 总开关(配置 brain.slowFiller.enabled + env TC_VOICE_SLOW_FILLER=0 的合成结果)。 */
  enabled: boolean;
  /** 开始预生成的时间点(ms,自 arm 起)。 */
  armMs: number;
  /** 允许吐出的最早时间点(ms,自 arm 起)。 */
  emitMs: number;
  /**
   * 取一句垫话(默认静态档=池内选句;llm 档=一次性生成);
   * 失败/超时/内容不合格 → null(调用方兜底,绝不抛)。实现方自行控制超时与内容清洗。
   */
  generate: () => Promise<string | null>;
  /** 吐出一句(经 pre 通道:照播,不参与客户端最终对账)。 */
  emit: (sentence: string) => void;
}

export interface SlowFiller {
  /** 回合开始(仅用户回合调用;事件回合与无流式通道时不 arm)。 */
  arm: () => void;
  /** 取消:幂等;清计时器,在途生成结果作废,不会再吐。 */
  cancel: () => void;
  /** 是否已经吐过(观测/测试用)。 */
  readonly emitted: boolean;
}

export function createSlowFiller(opts: SlowFillerOptions): SlowFiller {
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let emitted = false;
  /** 生成就绪文本;null = 还没就绪(或失败作废)。 */
  let ready: string | null = null;
  /** emitMs 已到。 */
  let due = false;

  const clearTimers = () => {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
  };

  /** 两个条件(到点 + 就绪)都满足才吐;先到先等,后到即吐。 */
  const maybeEmit = () => {
    if (cancelled || emitted || !due || ready === null) return;
    emitted = true;
    opts.emit(ready);
  };

  return {
    arm() {
      if (!opts.enabled || cancelled || armTimer || emitTimer) return;
      const armDelay = Math.max(0, opts.armMs);
      // 语义上 emit 不得早于 arm(配置夹取之外的最后一道护栏)。
      const emitDelay = Math.max(armDelay, Math.max(0, opts.emitMs));
      armTimer = setTimeout(() => {
        armTimer = null;
        opts.generate()
          .then((text) => {
            if (cancelled) return;
            const t = text?.trim();
            if (!t) return; // 生成失败/空 → 静默
            ready = t;
            maybeEmit();
          })
          .catch(() => { /* 全路径失败静默 */ });
      }, armDelay);
      emitTimer = setTimeout(() => {
        emitTimer = null;
        due = true;
        maybeEmit();
      }, emitDelay);
      // 计时器不持有进程存活(回合收尾的 cancel 仍是主路径)。
      armTimer.unref?.();
      emitTimer.unref?.();
    },
    cancel() {
      cancelled = true;
      clearTimers();
    },
    get emitted() {
      return emitted;
    },
  };
}
