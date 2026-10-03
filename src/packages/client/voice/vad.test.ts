import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VAD_CONFIG,
  createVadState,
  computeRms,
  updateVad,
  processFinalTranscript,
  normalizeTranscript,
  type VadState,
} from './vad.js';

const FRAME_MS = 30;

/** 以固定 RMS 推 n 帧,返回事件序列、末状态与最后一次的段时长。 */
function feed(state: VadState, rms: number, frames: number, cfg = DEFAULT_VAD_CONFIG, tts = false) {
  let s: VadState = { ...state, ttsActive: tts };
  const events: string[] = [];
  let segmentMs = 0; // 有事件时 = 最后一个事件携带的段时长;否则 = 最后一次更新的值
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

const LOUD = 0.5;
const QUIET = 0.001;

describe('computeRms', () => {
  it('computes the quadratic mean', () => {
    expect(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 5);
    expect(computeRms(new Float32Array(0))).toBe(0);
  });
});

describe('updateVad', () => {
  it('emits speech-start after the required consecutive frames and speech-end after silenceMs', () => {
    let state = createVadState();
    let out = feed(state, LOUD, 2);
    expect(out.events).toEqual([]); // 2 帧不够(需 3 帧)
    state = out.state;

    out = feed(state, LOUD, 2);
    expect(out.events).toEqual(['speech-start']);
    state = out.state;

    // 起说后 500ms 语音,再 700ms 静音(不够 800ms 判停)
    out = feed(state, LOUD, 17);
    state = out.state;
    out = feed(state, QUIET, 20);
    expect(out.events).toEqual([]);
    state = out.state;

    // 再 300ms 静音 → 累计 1500ms > 800ms,判停
    out = feed(state, QUIET, 10);
    expect(out.events).toEqual(['speech-end']);
    expect(out.segmentMs).toBeGreaterThanOrEqual(400);
  });

  it('discards segments shorter than minSpeechMs without an event', () => {
    let state = createVadState();
    state = feed(state, LOUD, 3).state; // speech-start
    // 只说了 ~90ms 就静音判停
    const out = feed(state, QUIET, 30);
    expect(out.events).toEqual([]);
    expect(out.state.speaking).toBe(false);
  });

  it('force-cuts when the segment exceeds maxSegmentMs but keeps speaking', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, maxSegmentMs: 300 };
    let state = createVadState();
    state = feed(state, LOUD, 3, cfg).state;
    const out = feed(state, LOUD, 12, cfg); // 继续 360ms
    expect(out.events).toEqual(['force-cut']);
    expect(out.state.speaking).toBe(true);
    expect(out.state.segmentMs).toBeLessThan(300);
  });

  it('requires more frames to trigger while TTS is speaking (self-echo guard)', () => {
    // 3 帧在正常模式会触发;播报中需要 5 帧
    let state = createVadState();
    const out = feed(state, LOUD, 3, DEFAULT_VAD_CONFIG, true);
    expect(out.events).toEqual([]);
    const out2 = feed(out.state, LOUD, 2, DEFAULT_VAD_CONFIG, true);
    expect(out2.events).toEqual(['speech-start']);
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
    const out = feed(state, 0.3, 3);
    expect(out.events).toEqual(['speech-start']);
  });

  it('honours an explicit startThreshold when set', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, startThreshold: 0.2 };
    let state = createVadState();
    const quietSpeech = feed(state, 0.1, 10, cfg); // 低于固定阈值
    expect(quietSpeech.events).toEqual([]);
    const loudEnough = feed(quietSpeech.state, 0.3, 3, cfg);
    expect(loudEnough.events).toEqual(['speech-start']);
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
