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

  // ---- 阶段一补测:阈值/边界/TTS 抑制/候选细节 ----

  it('tts suppress: lowers the start threshold so quiet speech still opens a candidate (energy path)', () => {
    // 底噪 0.01:正常起说阈 3×=0.03;播报中 ×0.65=0.0195 → 0.02 的轻声也能进候选。
    // 确认窗 250×1.6=400ms(14 帧),第 14 帧才确认。
    let out = feed(createVadState(), 0.02, 13, DEFAULT_VAD_CONFIG, true);
    expect(out.events).toEqual([]);
    expect(out.state.candidate).toBe(true);
    out = feed(out.state, 0.02, 1, DEFAULT_VAD_CONFIG, true);
    expect(out.events).toEqual(['speech-start']);

    // 同一 rms 非播报时低于起说阈(0.03),连候选都不会出现。
    const normal = feed(createVadState(), 0.02, 40);
    expect(normal.events).toEqual([]);
    expect(normal.state.candidate).toBe(false);
  });

  it('tts suppress: lowers the end threshold so a fading tail keeps the segment alive', () => {
    const started = feed(createVadState(), LOUD, CONFIRM_FRAMES);
    expect(started.events).toEqual(['speech-start']);

    // 非播报:尾音 0.015 < 停说阈 0.018 → 27 帧后判停
    const ended = feed(started.state, 0.015, 30);
    expect(ended.events).toEqual(['speech-end']);

    // 播报中:停说阈 ×0.65=0.0117 → 同一尾音不算静音,段保持存活
    const alive = feed(started.state, 0.015, 30, DEFAULT_VAD_CONFIG, true);
    expect(alive.events).toEqual([]);
    expect(alive.state.speaking).toBe(true);
  });

  it('boundary: rms exactly at startThreshold is not voiced (strict >), one hair above is', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, startThreshold: 0.2 };
    // 恰在阈值:不进候选(0.2 落在迟滞带,只缓慢抬底噪)
    const at = feed(createVadState(), 0.2, 20, cfg);
    expect(at.events).toEqual([]);
    expect(at.state.candidate).toBe(false);

    // 高出一点点:严格大于 → 正常确认
    const above = feed(createVadState(), 0.201, CONFIRM_FRAMES, cfg);
    expect(above.events).toEqual(['speech-start']);
  });

  it('boundary: speech-end fires exactly at silenceMs (>=)', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, silenceMs: 300 };
    const started = feed(createVadState(), LOUD, CONFIRM_FRAMES, cfg);
    expect(started.events).toEqual(['speech-start']);
    const one = feed(started.state, LOUD, 1, cfg);
    const nine = feed(one.state, QUIET, 9, cfg); // 270ms < 300
    expect(nine.events).toEqual([]);
    const ten = feed(nine.state, QUIET, 1, cfg); // 恰好 300ms
    expect(ten.events).toEqual(['speech-end']);
    expect(ten.segmentMs).toBe(360);
  });

  it('boundary: force-cut fires exactly at maxSegmentMs; silence end wins when both hit', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, maxSegmentMs: 300 };
    const started = feed(createVadState(), LOUD, CONFIRM_FRAMES, cfg);
    const cut = feed(started.state, LOUD, 9, cfg); // segmentMs 30→300
    expect(cut.events).toEqual(['force-cut']);
    expect(cut.segmentMs).toBe(300);
    expect(cut.state.speaking).toBe(true);
    expect(cut.state.segmentMs).toBe(0); // 仍在说:新段从 0 重新累计

    // 同一帧两个条件同时满足时,先判静音结束(不会误报 force-cut)。
    // segmentMs 从确认帧(30ms)起算,故对齐点取 330:第 10 帧静音恰 300、
    // 同时 segmentMs 也刚到 330,两者同帧为真。
    const both = { ...DEFAULT_VAD_CONFIG, silenceMs: 300, maxSegmentMs: 330 };
    const s2 = feed(createVadState(), LOUD, CONFIRM_FRAMES, both);
    const out = feed(s2.state, QUIET, 10, both);
    expect(out.events).toEqual(['speech-end']);
    expect(out.segmentMs).toBe(330);
  });

  it('candidate: a voiced frame resets the quiet streak (two 120ms gaps do not discard)', () => {
    let out = feed(createVadState(), LOUD, 3); // 候选 90ms
    expect(out.state.candidate).toBe(true);
    out = feed(out.state, QUIET, 4); // 连续静 120ms < candidateGapMs(150)
    expect(out.state.candidate).toBe(true);
    out = feed(out.state, LOUD, 1); // 过阈帧把 quiet streak 清零
    expect(out.state.candidateQuietMs).toBe(0);
    out = feed(out.state, QUIET, 4); // 若未清零此处累计 240ms 会被丢弃
    expect(out.state.candidate).toBe(true);
    out = feed(out.state, LOUD, 5); // voiced 120+150=270 ≥ 250
    expect(out.events).toEqual(['speech-start']);
  });

  it('candidate discard (quiet path) updates the noise floor toward the quiet level', () => {
    const a = feed(createVadState(), LOUD, 3);
    expect(a.state.candidate).toBe(true);
    const b = feed(a.state, 0.005, 5); // 连续静 150ms ≥ candidateGapMs → 丢弃
    expect(b.events).toEqual([]);
    expect(b.state.candidate).toBe(false);
    expect(b.state.noiseFloor).toBeCloseTo(0.0095, 6); // 0.01*0.9 + 0.005*0.1
  });

  it('candidate elapsed cap: exactly 750ms survives; the next band frame discards and freezes the floor', () => {
    const a = feed(createVadState(), LOUD, 3); // elapsed 90
    const b = feed(a.state, 0.025, 22); // 迟滞带(0.018–0.03):elapsed 恰 750,存活且不抬底噪
    expect(b.state.candidate).toBe(true);
    expect(b.state.noiseFloor).toBeCloseTo(0.01, 6);
    const c = feed(b.state, 0.025, 1); // elapsed 780 > 750 → 丢弃
    expect(c.state.candidate).toBe(false);
    expect(c.events).toEqual([]);
    expect(c.state.noiseFloor).toBeCloseTo(0.01, 6); // 带内丢弃不更新底噪
  });

  it('speaking: noise floor stays frozen and voicedMs only counts non-quiet frames', () => {
    const started = feed(createVadState(), LOUD, CONFIRM_FRAMES);
    const loud = feed(started.state, LOUD, 5);
    expect(loud.state.noiseFloor).toBeCloseTo(0.01, 6); // 段内不做自适应
    expect(loud.state.voicedMs).toBe(30 + 5 * FRAME_MS); // 确认帧本身计为有声
    const tail = feed(loud.state, QUIET, 5);
    expect(tail.state.voicedMs).toBe(180); // 静音帧不计
    expect(tail.state.silenceFrames).toBe(5);
  });

  it('force-cut can fire repeatedly on one continuous segment', () => {
    const cfg = { ...DEFAULT_VAD_CONFIG, maxSegmentMs: 300 };
    const started = feed(createVadState(), LOUD, CONFIRM_FRAMES, cfg);
    const first = feed(started.state, LOUD, 9, cfg);
    expect(first.events).toEqual(['force-cut']);
    const second = feed(first.state, LOUD, 10, cfg);
    expect(second.events).toEqual(['force-cut']);
    expect(second.state.speaking).toBe(true);
  });

  it('model path + tts: confirm window becomes min(confirmMs,180)*1.6 = 288ms', () => {
    let out = feedProb(createVadState(), 0.9, 9, DEFAULT_VAD_CONFIG, true); // 270 < 288
    expect(out.events).toEqual([]);
    out = feedProb(out.state, 0.9, 1, DEFAULT_VAD_CONFIG, true); // 300 ≥ 288
    expect(out.events).toEqual(['speech-start']);
  });

  it('model path: candidate discarded by a low-probability run reaching candidateGapMs', () => {
    const a = feedProb(createVadState(), 0.9, 3); // 候选 90ms
    expect(a.state.candidate).toBe(true);
    const b = feedProb(a.state, 0.1, 5); // 0.1 < probEnd(0.35) 累计 150ms → 丢弃
    expect(b.events).toEqual([]);
    expect(b.state.candidate).toBe(false);
    const c = feedProb(b.state, 0.9, 6); // 模型确认上限 180ms → 6 帧
    expect(c.events).toEqual(['speech-start']);
  });

  it('model path boundaries: prob 0.5 is voiced (>=), 0.35 is band, 0.349 counts as silence', () => {
    // 恰 0.5:>= probStart → 确认
    const start = feedProb(createVadState(), 0.5, 6);
    expect(start.events).toEqual(['speech-start']);

    // 恰 0.35:不满足 < probEnd → 迟滞带,不累计、不确认
    const band = feedProb(createVadState(), 0.35, 30);
    expect(band.events).toEqual([]);
    expect(band.state.candidate).toBe(false);

    // 0.349:计入静音 — 段内累计 800ms 判停
    const ended = feedProb(start.state, 0.349, 27);
    expect(ended.events).toEqual(['speech-end']);
  });

  it('model path ignores rms entirely; energy path endThreshold honours startThreshold*0.6', () => {
    // 模型通路:概率低就是静音,哪怕 rms 很响
    let s = createVadState();
    const events: string[] = [];
    for (let i = 0; i < 20; i++) {
      const out = updateVad(s, 0.5, FRAME_MS, DEFAULT_VAD_CONFIG, 0.1);
      s = out.state;
      if (out.event) events.push(out.event);
    }
    expect(events).toEqual([]);
    expect(s.speaking).toBe(false);

    // 能量通路:固定阈值 0.2 → 停说阈 = max(0.2*0.6, 0.018) = 0.12
    const cfg = { ...DEFAULT_VAD_CONFIG, engine: 'energy' as const, startThreshold: 0.2 };
    const started = feed(createVadState(), 0.3, CONFIRM_FRAMES, cfg);
    expect(started.events).toEqual(['speech-start']);
    const above = feed(started.state, 0.15, 10, cfg); // 0.15 > 0.12:不算静音
    expect(above.events).toEqual([]);
    const below = feed(above.state, 0.1, 30, cfg); // 0.1 < 0.12:累计判停
    expect(below.events).toEqual(['speech-end']);
  });
});

describe('normalizeTranscript', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeTranscript('  你好   世界  ')).toBe('你好 世界');
  });

  it('collapses tabs, newlines and NBSP into single spaces', () => {
    expect(normalizeTranscript('a\t\n b')).toBe('a b');
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
    // 整段丢弃:文本置空,调用方不会上屏/待提交(S1a 红项修复)
    expect(r.text).toBe('');
  });

  it('wake word miss drops the whole utterance instead of leaving it pending', () => {
    const r = processFinalTranscript('今天天气怎么样', { ...base, wakeWord: '小助手', autoSubmit: false });
    expect(r).toEqual({ submit: false, text: '', matchedEndWord: false, droppedByWakeWord: true });
  });

  it('strips a leading full-width comma after the wake word (S1c 红项修复)', () => {
    const r = processFinalTranscript('小助手，帮我看看进度。', { ...base, wakeWord: '小助手' });
    expect(r.text).toBe('帮我看看进度');
    expect(r.submit).toBe(true);
  });

  it('strips a leading ideographic comma and repeated punctuation', () => {
    const r = processFinalTranscript('小助手、，帮我查一下', { ...base, wakeWord: '小助手' });
    expect(r.text).toBe('帮我查一下');
  });

  it('end word match tolerates a trailing full-width comma', () => {
    const r = processFinalTranscript('看看部署，发送，', { ...base, autoSubmit: false });
    expect(r.matchedEndWord).toBe(true);
    expect(r.text).toBe('看看部署');
    expect(r.submit).toBe(true);
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

  // ---- 阶段一补测:唤醒词/结束词边界 ----

  it('wake word: strips only the first occurrence', () => {
    const r = processFinalTranscript('帮我小助手查一下小助手', { ...base, wakeWord: '小助手' });
    expect(r.text).toBe('帮我查一下小助手');
    expect(r.droppedByWakeWord).toBe(false);
    expect(r.submit).toBe(true);
  });

  it('wake word + trailing punctuation only drops to empty and never submits', () => {
    const r = processFinalTranscript('小助手。', { ...base, wakeWord: '小助手' });
    expect(r.text).toBe('');
    expect(r.submit).toBe(false);
    expect(r.droppedByWakeWord).toBe(false);
  });

  it('wake word + end word leaving empty text: matchedEndWord true but submit stays false', () => {
    const r = processFinalTranscript('小助手,发送', { ...base, wakeWord: '小助手' });
    expect(r.text).toBe('');
    expect(r.matchedEndWord).toBe(true);
    expect(r.submit).toBe(false);
  });

  it('end word with trailing punctuation is matched and stripped', () => {
    const r = processFinalTranscript('让小美修登录页,发送。', { ...base, autoSubmit: false });
    expect(r.matchedEndWord).toBe(true);
    expect(r.text).toBe('让小美修登录页');
    expect(r.submit).toBe(true);
  });

  it('end words: empty entries are skipped and array order decides the first match', () => {
    const r = processFinalTranscript('干活就这些了', { ...base, endWords: ['', '就这些了', '了'] });
    expect(r.matchedEndWord).toBe(true);
    expect(r.text).toBe('干活'); // 「就这些了」在数组里先于「了」命中
  });

  it('no wake word configured never flags droppedByWakeWord', () => {
    const r = processFinalTranscript('随便什么内容', base);
    expect(r.droppedByWakeWord).toBe(false);
  });

  it('punctuation-only input is submitted as-is (behavior lock)', () => {
    const r = processFinalTranscript('，，', base);
    expect(r.submit).toBe(true);
    expect(r.text).toBe('，，');
  });
});
