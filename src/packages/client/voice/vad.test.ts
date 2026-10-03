import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VAD_CONFIG,
  MODEL_CONFIRM_CAP_MS,
  createVadState,
  computeRms,
  updateVad,
  processFinalTranscript,
  normalizeTranscript,
  type VadConfig,
  type VadState,
} from './vad.js';

const FRAME_MS = 30;

/** 以固定 RMS 推 n 帧,返回事件序列、末状态与最后一次的段时长。 */
function feed(state: VadState, rms: number, frames: number, cfg = DEFAULT_VAD_CONFIG, tts = false) {
  let s: VadState = { ...state, ttsActive: tts };
  const events: string[] = [];
  let segmentMs = 0;
  for (let i = 0; i < frames; i++) {
    const out = updateVad(s, rms, FRAME_MS, cfg);
    s = out.state;
    if (out.event) {
      events.push(out.event);
      segmentMs = out.segmentMs;
    } else if (events.length === 0) {
      segmentMs = out.segmentMs;
    }
  }
  return { state: s, events, segmentMs };
}

/** 以固定语音概率推 n 帧(模型通路;rms 随便给个安静值)。 */
function feedProb(state: VadState, prob: number, frames: number, cfg: VadConfig = DEFAULT_VAD_CONFIG, tts = false) {
  let s: VadState = { ...state, ttsActive: tts };
  const events: string[] = [];
  let segmentMs = 0;
  for (let i = 0; i < frames; i++) {
    const out = updateVad(s, 0.001, FRAME_MS, cfg, prob);
    s = out.state;
    if (out.event) {
      events.push(out.event);
      segmentMs = out.segmentMs;
    } else if (events.length === 0) {
      segmentMs = out.segmentMs;
    }
  }
  return { state: s, events, segmentMs };
}

const LOUD = 0.5;
const QUIET = 0.001;
/** 默认确认时长 250ms 需要的过阈帧数(向上取整)。 */
const CONFIRM_FRAMES = Math.ceil(DEFAULT_VAD_CONFIG.confirmMs / FRAME_MS); // 9

describe('computeRms', () => {
  it('computes the quadratic mean', () => {
    expect(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 5);
    expect(computeRms(new Float32Array(0))).toBe(0);
  });
});

describe('updateVad', () => {
  it('confirms a segment only after confirmMs of voiced audio, and ends it after silenceMs', () => {
    let state = createVadState();
    let out = feed(state, LOUD, CONFIRM_FRAMES - 1); // 240ms < 250ms
    expect(out.events).toEqual([]);
    state = out.state;

    out = feed(state, LOUD, 1); // 第 9 帧 → 270ms ≥ 250ms
    expect(out.events).toEqual(['speech-start']);
    state = out.state;

    // 继续 300ms 语音,再 600ms 静音(不足 800ms)
    out = feed(state, LOUD, 10);
    state = out.state;
    out = feed(state, QUIET, 20);
    expect(out.events).toEqual([]);
    state = out.state;

    // 再 300ms 静音 → 累计 900ms > 800ms,判停
    out = feed(state, QUIET, 10);
    expect(out.events).toEqual(['speech-end']);
    expect(out.segmentMs).toBeGreaterThanOrEqual(300);
  });

  it('回归:已确认的短促段(如「停」)必发 speech-end,且随后可立即开新段(卡死修复)', () => {
    // 旧实现:voiced < minSpeechMs 的段静默丢弃 → 上层会话永不收尾,后续全部被吞。
    let state = createVadState();
    let out = feed(state, LOUD, CONFIRM_FRAMES); // 确认开段(≈270ms)
    expect(out.events).toEqual(['speech-start']);
    state = out.state;

    // 只再持续 ~60ms 就静音:段本身很短,但已确认 → 必须产 speech-end
    out = feed(state, LOUD, 2);
    state = out.state;
    out = feed(state, QUIET, 30); // 900ms 静音
    expect(out.events).toEqual(['speech-end']);
    expect(out.segmentMs).toBeLessThan(1000); // 短促一段(含尾部静音到判停点)
    state = out.state;

    // 卡死回归的核心断言:紧接着的新语音必须能正常确认
    out = feed(state, LOUD, CONFIRM_FRAMES);
    expect(out.events).toEqual(['speech-start']);
  });

  it('discards a candidate that never reaches confirmMs — zero events, no poisoning', () => {
    let state = createVadState();
    let out = feed(state, LOUD, 3); // 候选 90ms
    expect(out.events).toEqual([]);
    state = out.state;
    out = feed(state, QUIET, 10); // 连续安静 300ms ≥ candidateGapMs(150) → 丢弃候选
    expect(out.events).toEqual([]);
    expect(out.state.speaking).toBe(false);
    expect(out.state.candidate).toBe(false);

    // 丢弃后不影响后续正常确认
    out = feed(out.state, LOUD, CONFIRM_FRAMES);
    expect(out.events).toEqual(['speech-start']);
  });

  it('discards a slow dribble of blips via the candidate elapsed cap', () => {
    // 每 120ms 一个 30ms 爆音:间隔 < candidateGapMs(150) 不会触发 gap 丢弃,
    // 但候选总时长超过 3×confirmMs(750ms)时必须整体丢弃,不得累积成误确认。
    let state = createVadState();
    const events: string[] = [];
    for (let i = 0; i < 12; i++) {
      const a = feed(state, LOUD, 1);
      state = a.state;
      const b = feed(state, QUIET, 4);
      state = b.state;
      events.push(...a.events, ...b.events);
    }
    expect(events).toEqual([]);
    expect(state.speaking).toBe(false);
    expect(state.candidate).toBe(false);
  });

  it('force-cuts when the segment exceeds maxSegmentMs but keeps speaking', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, maxSegmentMs: 300 };
    let state = createVadState();
    state = feed(state, LOUD, CONFIRM_FRAMES, cfg).state;
    const out = feed(state, LOUD, 12, cfg); // 继续 360ms
    expect(out.events).toEqual(['force-cut']);
    expect(out.state.speaking).toBe(true);
    expect(out.state.segmentMs).toBeLessThan(300);
  });

  it('requires a longer confirm window while TTS is speaking (self-echo guard)', () => {
    // 250ms × 1.6 = 400ms → 14 帧
    let out = feed(createVadState(), LOUD, 13, DEFAULT_VAD_CONFIG, true);
    expect(out.events).toEqual([]);
    out = feed(out.state, LOUD, 1, DEFAULT_VAD_CONFIG, true);
    expect(out.events).toEqual(['speech-start']);
  });

  it('adapts the noise floor upward in a noisy room so steady hiss does not trigger', () => {
    let state = createVadState();
    // 稳态噪声 0.02:EMA 爬升后 3×底噪 = 0.06 > 0.02,不应触发
    for (let i = 0; i < 200; i++) {
      state = updateVad(state, 0.02, FRAME_MS, DEFAULT_VAD_CONFIG).state;
    }
    expect(state.speaking).toBe(false);
    expect(state.noiseFloor).toBeGreaterThan(0.015);

    // 正常的说话声仍可触发
    const out = feed(state, 0.3, CONFIRM_FRAMES);
    expect(out.events).toEqual(['speech-start']);
  });

  it('honours an explicit startThreshold when set', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, startThreshold: 0.2 };
    let state = createVadState();
    const quietSpeech = feed(state, 0.1, 20, cfg); // 低于固定阈值
    expect(quietSpeech.events).toEqual([]);
    const loudEnough = feed(quietSpeech.state, 0.3, CONFIRM_FRAMES, cfg);
    expect(loudEnough.events).toEqual(['speech-start']);
  });

  it('model path: confirms on high probability (capped at 180ms) and ends on low probability', () => {
    let state = createVadState();
    // 模型通路确认上限 180ms → 6 帧
    const confirmFrames = Math.ceil(MODEL_CONFIRM_CAP_MS / FRAME_MS);
    let out = feedProb(state, 0.9, confirmFrames - 1);
    expect(out.events).toEqual([]);
    state = out.state;
    out = feedProb(state, 0.9, 1);
    expect(out.events).toEqual(['speech-start']);
    state = out.state;

    // 概率跌到 0.1(< probEnd 0.35)累计 900ms → speech-end
    out = feedProb(state, 0.1, 30);
    expect(out.events).toEqual(['speech-end']);
  });

  it('model path: probability in the hysteresis band (0.35–0.5) neither confirms nor counts as silence', () => {
    let out = feedProb(createVadState(), 0.4, 30); // 900ms 迟滞带
    expect(out.events).toEqual([]);
    expect(out.state.speaking).toBe(false);
    expect(out.state.candidate).toBe(false); // 带内不累计人声,候选不成立
  });

  it('engine=energy ignores an injected probability (falls back to the RMS path)', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, engine: 'energy' as const };
    // rms 安静但 prob 高:能量通路不看 prob → 不触发
    let out = feedProb(createVadState(), 0.99, 20, cfg);
    expect(out.events).toEqual([]);
    // 反之 rms 响亮即可确认(无论 prob)
    out = feed(createVadState(), LOUD, CONFIRM_FRAMES, cfg);
    expect(out.events).toEqual(['speech-start']);
  });

  it('falls back to the energy path while the probability is null (model still loading)', () => {
    let state = createVadState();
    const events: string[] = [];
    for (let i = 0; i < CONFIRM_FRAMES; i++) {
      const out = updateVad(state, LOUD, FRAME_MS, DEFAULT_VAD_CONFIG, null);
      state = out.state;
      if (out.event) events.push(out.event);
    }
    expect(events).toEqual(['speech-start']);
  });
});

describe('normalizeTranscript', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeTranscript('  你好   世界  ')).toBe('你好 世界');
  });
});

describe('processFinalTranscript', () => {
  const base = { wakeWord: '', endWords: ['发送', '就这些'], autoSubmit: true };

  it('submits plain text when autoSubmit is on', () => {
    const r = processFinalTranscript('帮我看看小美在干嘛', base);
    expect(r.submit).toBe(true);
    expect(r.text).toBe('帮我看看小美在干嘛');
    expect(r.matchedEndWord).toBe(false);
  });

  it('strips a trailing end word and submits even with autoSubmit off', () => {
    const r = processFinalTranscript('让小美修登录页,发送', { ...base, autoSubmit: false });
    expect(r.matchedEndWord).toBe(true);
    expect(r.text).toBe('让小美修登录页');
    expect(r.submit).toBe(true);
  });

  it('does not submit when autoSubmit is off and no end word', () => {
    const r = processFinalTranscript('随便说说', { ...base, autoSubmit: false });
    expect(r.submit).toBe(false);
    expect(r.text).toBe('随便说说');
  });

  it('drops text without the wake word when one is configured', () => {
    const r = processFinalTranscript('帮我查一下', { ...base, wakeWord: '小助手' });
    expect(r.droppedByWakeWord).toBe(true);
    expect(r.submit).toBe(false);
  });

  it('strips the wake word and keeps the rest', () => {
    const r = processFinalTranscript('小助手,让小美修登录页', { ...base, wakeWord: '小助手' });
    expect(r.droppedByWakeWord).toBe(false);
    expect(r.text).toBe('让小美修登录页');
    expect(r.submit).toBe(true);
  });

  it('drops empty or wake-word-only utterances', () => {
    expect(processFinalTranscript('   ', base).submit).toBe(false);
    const r = processFinalTranscript('小助手', { ...base, wakeWord: '小助手' });
    expect(r.submit).toBe(false);
    expect(r.text).toBe('');
  });

  it('ignores an end word in the middle of the sentence', () => {
    const r = processFinalTranscript('发送这个给小美', { ...base, autoSubmit: false });
    expect(r.matchedEndWord).toBe(false);
    expect(r.submit).toBe(false);
  });
});
