/**
 * 语音活动检测(VAD)——纯状态机,便于单测;浏览器侧由 useContinuousListening 驱动。
 *
 * 思路(零依赖、可解释):
 *   - 每帧算 RMS(能量通路)或接收 Silero 小模型给出的语音概率(模型通路);
 *   - 「候选 → 确认 → 段」三段式:疑似人声先进候选,有效人声累计达 confirmMs
 *     才发 speech-start 开段;候选不足直接丢弃(零事件、零副作用)。
 *   - 不变式:**已确认段的每次结束必然产出 speech-end 或 force-cut**,不存在
 *     「静默丢弃已开段」的路径——旧实现按 minSpeechMs 静默丢弃短段,曾导致
 *     上层会话开着永不收尾(短词「停」后整条链路卡死),此处从结构上根除;
 *   - 迟滞判定(能量通路):起说阈值 = max(startThreshold, 噪声底×3),停说阈值
 *     = 噪声底×1.8;噪声底用不对称 EMA:安静帧快(0.08),疑似人声帧慢(0.03)。
 *   - 静音累计 ≥ silenceMs 判停;段长 ≥ maxSegmentMs 强制切段(force-cut)。
 *   - 播报中(TTS)整体调低阈值、拉长确认时长(配合 echoCancellation,
 *     让用户能打断播报但不被自家扬声器自激)。
 */

/** 判停引擎:auto = 小模型可用则用、否则能量;model/energy = 强制。 */
export type VadEngineMode = 'auto' | 'model' | 'energy';

export interface VadConfig {
  /** 判停引擎。 */
  engine: VadEngineMode;
  /** 固定起说阈值(0 = 纯自适应)。 */
  startThreshold: number;
  /** 起说:噪声底倍数。 */
  noiseMultiplierStart: number;
  /** 停说:噪声底倍数。 */
  noiseMultiplierEnd: number;
  /** 静音判停(ms)。 */
  silenceMs: number;
  /** 确认时长(ms):候选内有效人声累计达此值才开段(取代旧的「起说帧数+最短语音段」双参数)。 */
  confirmMs: number;
  /** 候选内连续未过阈累计达此值 → 丢弃候选(ms)。 */
  candidateGapMs: number;
  /** 最长语音段(ms),超过强制切段。 */
  maxSegmentMs: number;
  /** 播报中阈值缩放(<1 更易触发)。 */
  ttsSuppressFactor: number;
  /** 播报中确认时长倍数(防自激)。 */
  ttsConfirmFactor: number;
  /** 模型通路:起说概率阈值。 */
  probStart: number;
  /** 模型通路:停说概率阈值。 */
  probEnd: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  engine: 'auto',
  startThreshold: 0,
  noiseMultiplierStart: 3,
  noiseMultiplierEnd: 1.8,
  silenceMs: 800,
  confirmMs: 250,
  candidateGapMs: 150,
  maxSegmentMs: 30_000,
  ttsSuppressFactor: 0.65,
  ttsConfirmFactor: 1.6,
  probStart: 0.5,
  probEnd: 0.35,
};

/** 模型通路的确认时长上限:小模型更可靠,180ms 即确认(更跟手)。 */
export const MODEL_CONFIRM_CAP_MS = 180;

export interface VadState {
  /** 噪声底 EMA(RMS)。 */
  noiseFloor: number;
  /** 当前是否处于已确认语音段。 */
  speaking: boolean;
  /** 是否处于候选期(疑似人声,尚未确认开段)。 */
  candidate: boolean;
  /** 候选期内有效人声累计(ms)。 */
  candidateVoicedMs: number;
  /** 候选期内连续未过阈累计(ms)。 */
  candidateQuietMs: number;
  /** 候选期总时长(ms,防慢速零散声响滴答累积成误确认)。 */
  candidateElapsedMs: number;
  /** 连续静音帧计数(判停用)。 */
  silenceFrames: number;
  /** 当前语音段已持续时长(ms,含尾部静音)。 */
  segmentMs: number;
  /** 段内实际「有声」时长(ms,仅统计未低于停说阈值的帧;观测用)。 */
  voicedMs: number;
  /** 外部注入:播报中。 */
  ttsActive: boolean;
}

export type VadEvent = 'speech-start' | 'speech-end' | 'force-cut' | null;

export function createVadState(): VadState {
  return {
    noiseFloor: 0.01,
    speaking: false,
    candidate: false,
    candidateVoicedMs: 0,
    candidateQuietMs: 0,
    candidateElapsedMs: 0,
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
 * 处理一帧。返回新状态与事件(纯函数:不改入参)。
 * frameMs 为该帧时长(默认 30ms);speechProb 为小模型给出的语音概率
 * (null/undefined = 走能量通路;engine='energy' 时忽略)。
 */
export function updateVad(
  state: VadState,
  rms: number,
  frameMs: number,
  cfg: VadConfig,
  speechProb?: number | null,
): VadUpdate {
  const next: VadState = { ...state };
  const modelActive = typeof speechProb === 'number' && cfg.engine !== 'energy';
  const ttsFactor = state.ttsActive ? cfg.ttsSuppressFactor : 1;

  let voiced: boolean;
  let quiet: boolean;
  if (modelActive) {
    voiced = (speechProb as number) >= cfg.probStart;
    quiet = (speechProb as number) < cfg.probEnd;
  } else {
    const startThreshold = Math.max(cfg.startThreshold, state.noiseFloor * cfg.noiseMultiplierStart) * ttsFactor;
    const endThreshold = Math.max(cfg.startThreshold * 0.6, state.noiseFloor * cfg.noiseMultiplierEnd) * ttsFactor;
    voiced = rms > startThreshold;
    quiet = rms < endThreshold;
  }
  // 迟滞带内(voiced=false 且 quiet=false):既不累计人声也不累计间隔,候选不因此复位
  const confirmNeedMs = Math.min(cfg.confirmMs, modelActive ? MODEL_CONFIRM_CAP_MS : cfg.confirmMs)
    * (state.ttsActive ? cfg.ttsConfirmFactor : 1);

  if (!state.speaking) {
    if (voiced) {
      next.candidate = true;
      next.candidateVoicedMs = (state.candidate ? state.candidateVoicedMs : 0) + frameMs;
      next.candidateElapsedMs = (state.candidate ? state.candidateElapsedMs : 0) + frameMs;
      next.candidateQuietMs = 0; // 过阈帧打断「连续未过阈」streak
      // 候选期冻结噪声底:确认窗口(250ms+)内若让底噪继续上探,低信噪比语音
      // 会把自己的阈值抬到说话声之上、自我取消确认(旧实现 90ms 即开段未暴露)。
      next.noiseFloor = state.noiseFloor;

      if (next.candidateVoicedMs >= confirmNeedMs) {
        // 确认开段:此后该段必然以 speech-end / force-cut 收尾(不变式)
        next.speaking = true;
        next.candidate = false;
        next.candidateVoicedMs = 0;
        next.candidateQuietMs = 0;
        next.candidateElapsedMs = 0;
        next.silenceFrames = 0;
        next.segmentMs = frameMs;
        next.voicedMs = frameMs;
        return { event: 'speech-start', state: next, segmentMs: frameMs };
      }
      return { event: null, state: next, segmentMs: 0 };
    }

    if (state.candidate) {
      // 候选内未过阈:累计间隔与总时长,超限则整体丢弃(零事件、零副作用)
      next.candidateElapsedMs = state.candidateElapsedMs + frameMs;
      if (quiet) next.candidateQuietMs = state.candidateQuietMs + frameMs;
      if (next.candidateQuietMs >= cfg.candidateGapMs || next.candidateElapsedMs > confirmNeedMs * 3) {
        next.candidate = false;
        next.candidateVoicedMs = 0;
        next.candidateQuietMs = 0;
        next.candidateElapsedMs = 0;
        if (quiet) next.noiseFloor = state.noiseFloor * 0.9 + rms * 0.1;
        else next.noiseFloor = state.noiseFloor;
        return { event: null, state: next, segmentMs: 0 };
      }
      return { event: null, state: next, segmentMs: 0 };
    }

    // 安静帧:快速自适应(稳态噪声/风扇声很快被吸收,不再误触发)
    next.noiseFloor = state.noiseFloor * 0.92 + rms * 0.08;
    return { event: null, state: next, segmentMs: 0 };
  }

  // speaking:噪声底冻结(段内不做自适应)
  next.segmentMs = state.segmentMs + frameMs;

  if (quiet) {
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
    next.voicedMs = 0;
    // 已确认段一律产出结束事件(不再按 voicedMs 静默丢弃)
    return { event: 'speech-end', state: next, segmentMs: duration };
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
  /** 处理后文本(唤醒词/结束词已剥离);未命中唤醒词时为空串(整段丢弃)。 */
  text: string;
  /** 命中结束词。 */
  matchedEndWord: boolean;
  /** 被唤醒词过滤(未包含唤醒词)。 */
  droppedByWakeWord: boolean;
}

/** 需剥离的标点/空白字符类(半角 + 全角;含全角逗号 ，与顿号 、)。 */
const PUNCT_CLASS = String.raw`\s,，、。,\.!！?？;；:：`;
const TRAILING_PUNCT = new RegExp(`[${PUNCT_CLASS}]+$`);
const LEADING_PUNCT = new RegExp(`^[${PUNCT_CLASS}]+`);

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
      // 配了唤醒词但没听到:整段丢弃(不上屏、不待提交,静默)
      result.droppedByWakeWord = true;
      result.text = '';
      return result;
    }
    // 剥离唤醒词及紧随的标点/空白
    text = normalizeTranscript(text.slice(0, idx) + text.slice(idx + cfg.wakeWord.length));
    text = text.replace(TRAILING_PUNCT, '').trim();
    // 前导标点也清掉(如 "，帮我查一下" —— 全角逗号/顿号同在剥离集里)
    text = text.replace(LEADING_PUNCT, '').trim();
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
