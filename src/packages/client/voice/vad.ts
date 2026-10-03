/**
 * 语音活动检测(VAD)——纯状态机,便于单测;浏览器侧由 useContinuousListening 驱动。
 *
 * 思路(零依赖、可解释):
 *   - 每帧算 RMS,非语音帧用不对称 EMA 维护噪声底:安静帧快(0.08),
 *     疑似人声帧慢(0.03)——稳态噪声(风扇/空调)很快被吸收,而语音起始
 *     不会把自己的阈值抬上去;
 *   - 迟滞判定:起说阈值 = max(startThreshold, 噪声底×3),停说阈值 = 噪声底×1.8,
 *     避免在阈值边缘抖动(远场麦克风噪声波动大);
 *   - 起说需连续 N 帧过阈(默认 3 帧 ≈ 90ms),防敲击/爆音;
 *   - 静音累计 ≥ silenceMs 判停;段内「有声」时长 ≥ minSpeechMs 才产出
 *     speech-end(只按 voicedMs 判,避免爆音+长静音混成一句话),
 *     否则按噪声丢弃;段长 ≥ maxSegmentMs 强制切段(force-cut)。
 *   - 播报中(TTS)整体调低阈值、加长起说帧数(配合 echoCancellation,
 *     让用户能打断播报但不被自家扬声器自激)。
 */

export interface VadConfig {
  /** 固定起说阈值(0 = 纯自适应)。 */
  startThreshold: number;
  /** 起说:噪声底倍数。 */
  noiseMultiplierStart: number;
  /** 停说:噪声底倍数。 */
  noiseMultiplierEnd: number;
  /** 静音判停(ms)。 */
  silenceMs: number;
  /** 最短语音段(ms)。 */
  minSpeechMs: number;
  /** 最长语音段(ms),超过强制切段。 */
  maxSegmentMs: number;
  /** 起说需连续过阈帧数。 */
  speechStartFrames: number;
  /** 播报中阈值缩放(<1 更易触发)。 */
  ttsSuppressFactor: number;
  /** 播报中起说帧数。 */
  ttsStartFrames: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  startThreshold: 0,
  noiseMultiplierStart: 3,
  noiseMultiplierEnd: 1.8,
  silenceMs: 800,
  minSpeechMs: 400,
  maxSegmentMs: 30_000,
  speechStartFrames: 3,
  ttsSuppressFactor: 0.65,
  ttsStartFrames: 5,
};

export interface VadState {
  /** 噪声底 EMA(RMS)。 */
  noiseFloor: number;
  /** 当前是否处于语音段。 */
  speaking: boolean;
  /** 连续过阈帧计数(起说用)。 */
  speechFrames: number;
  /** 连续静音帧计数(判停用)。 */
  silenceFrames: number;
  /** 当前语音段已持续时长(ms,含尾部静音)。 */
  segmentMs: number;
  /** 段内实际「有声」时长(ms,仅统计高于停说阈值的帧)。 */
  voicedMs: number;
  /** 外部注入:播报中。 */
  ttsActive: boolean;
}

export type VadEvent = 'speech-start' | 'speech-end' | 'force-cut' | null;

export function createVadState(): VadState {
  return {
    noiseFloor: 0.01,
    speaking: false,
    speechFrames: 0,
    silenceFrames: 0,
    segmentMs: 0,
    voicedMs: 0,
    ttsActive: false,
  };
}

/** 计算一段 PCM(Float32,-1..1)的 RMS。 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

export interface VadUpdate {
  event: VadEvent;
  state: VadState;
  /** 事件发生时的段时长(ms)。 */
  segmentMs: number;
}

/**
 * 处理一帧 RMS。返回新状态与事件(纯函数:不改入参)。
 * frameMs 为该帧时长(默认 30ms)。
 */
export function updateVad(state: VadState, rms: number, frameMs: number, cfg: VadConfig): VadUpdate {
  const next: VadState = { ...state };
  const suppress = state.ttsActive;
  const factor = suppress ? cfg.ttsSuppressFactor : 1;
  const startThreshold = Math.max(cfg.startThreshold, state.noiseFloor * cfg.noiseMultiplierStart) * factor;
  const endThreshold = Math.max(cfg.startThreshold * 0.6, state.noiseFloor * cfg.noiseMultiplierEnd) * factor;
  const requiredFrames = suppress ? cfg.ttsStartFrames : cfg.speechStartFrames;

  if (!state.speaking) {
    if (rms > startThreshold) {
      // 疑似人声:噪声底只做缓慢上探,避免语音起始把底噪抬高而"吃掉"自己
      next.noiseFloor = state.noiseFloor * 0.97 + rms * 0.03;
      next.speechFrames = state.speechFrames + 1;
    } else {
      // 安静帧:快速自适应(稳态噪声/风扇声很快被吸收,不再误触发)
      next.noiseFloor = state.noiseFloor * 0.92 + rms * 0.08;
      next.speechFrames = Math.max(0, state.speechFrames - 1);
    }

    if (next.speechFrames >= requiredFrames) {
      next.speaking = true;
      next.speechFrames = 0;
      next.silenceFrames = 0;
      next.segmentMs = frameMs;
      next.voicedMs = rms >= endThreshold ? frameMs : 0;
      return { event: 'speech-start', state: next, segmentMs: frameMs };
    }
    next.silenceFrames = 0;
    next.segmentMs = 0;
    next.voicedMs = 0;
    return { event: null, state: next, segmentMs: 0 };
  }

  // speaking:噪声底冻结(段内不做自适应)
  next.speechFrames = 0;
  next.segmentMs = state.segmentMs + frameMs;

  if (rms < endThreshold) {
    next.silenceFrames = state.silenceFrames + 1;
  } else {
    next.silenceFrames = 0;
    next.voicedMs = state.voicedMs + frameMs;
  }

  const silentMs = next.silenceFrames * frameMs;
  if (silentMs >= cfg.silenceMs) {
    const duration = next.segmentMs;
    next.speaking = false;
    next.silenceFrames = 0;
    next.segmentMs = 0;
    const voiced = next.voicedMs;
    next.voicedMs = 0;
    // 按「有声」时长判断是否为有效语音段(避免一声爆音 + 长静音被当成一句话)
    if (voiced >= cfg.minSpeechMs) {
      return { event: 'speech-end', state: next, segmentMs: duration };
    }
    // 太短:按噪声丢弃(更新噪声底,便于快速自适应)
    next.noiseFloor = state.noiseFloor * 0.9 + rms * 0.1;
    return { event: null, state: next, segmentMs: duration };
  }

  if (next.segmentMs >= cfg.maxSegmentMs) {
    const duration = next.segmentMs;
    next.segmentMs = 0; // 仍在说话:继续累积新段
    next.voicedMs = 0;
    return { event: 'force-cut', state: next, segmentMs: duration };
  }

  return { event: null, state: next, segmentMs: next.segmentMs };
}

// ============================================================================
// 文本后处理(唤醒词/结束词/自动提交)——纯函数,单测覆盖
// ============================================================================

export interface FinalTextConfig {
  wakeWord: string;
  endWords: string[];
  autoSubmit: boolean;
}

export interface FinalTextResult {
  /** 是否提交到大脑。 */
  submit: boolean;
  /** 处理后文本(唤醒词/结束词已剥离)。 */
  text: string;
  /** 命中结束词。 */
  matchedEndWord: boolean;
  /** 被唤醒词过滤(未包含唤醒词)。 */
  droppedByWakeWord: boolean;
}

const TRAILING_PUNCT = /[\s,。,\.!！?？;；:：]+$/;

/** 规整文本:压缩空白、去首尾标点噪声。 */
export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 判停终稿处理:唤醒词过滤 → 结束词剥离 → 是否提交。 */
export function processFinalTranscript(raw: string, cfg: FinalTextConfig): FinalTextResult {
  let text = normalizeTranscript(raw);
  const result: FinalTextResult = { submit: false, text, matchedEndWord: false, droppedByWakeWord: false };

  if (!text) return result;

  if (cfg.wakeWord) {
    const idx = text.indexOf(cfg.wakeWord);
    if (idx < 0) {
      result.droppedByWakeWord = true;
      return result;
    }
    // 剥离唤醒词及紧随的标点/空白
    text = normalizeTranscript(text.slice(0, idx) + text.slice(idx + cfg.wakeWord.length));
    text = text.replace(TRAILING_PUNCT, '').trim();
    // 前导标点也清掉(如 "，帮我查一下")
    text = text.replace(/^[\s,。,\.!！?？;；:：]+/, '').trim();
    result.text = text;
    if (!text) return result;
  }

  for (const word of cfg.endWords) {
    if (!word) continue;
    const stripped = text.replace(TRAILING_PUNCT, '');
    if (stripped.endsWith(word)) {
      text = normalizeTranscript(stripped.slice(0, stripped.length - word.length));
      text = text.replace(TRAILING_PUNCT, '').trim();
      result.text = text;
      result.matchedEndWord = true;
      break;
    }
  }

  if (!result.text) return result;

  result.submit = cfg.autoSubmit || result.matchedEndWord;
  return result;
}
