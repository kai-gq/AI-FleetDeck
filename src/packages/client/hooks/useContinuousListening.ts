/**
 * 语音伙伴 · 持续聆听 Hook
 *
 * 职责(纯客户端,零新依赖):
 *   - 常开麦克风(参数同 useSTT)+ AudioWorklet 采集 16k PCM(不可用回退 ScriptProcessor);
 *   - VAD(voice/vad.ts)自动断句:起说/静音判停/超长强制切段,播报中支持抢话;
 *   - 双通道转写:
 *       stream  —— WS /ws/voice-companion → 火山引擎流式识别,partial 实时上屏;
 *       segment —— MediaRecorder 分段 → 既有 /api/stt/transcribe(批量回退,
 *                  凭据缺失/流式出错/手动指定时使用);
 *   - 文本后处理:唤醒词过滤、结束词剥离、autoSubmit、最短语音段(vad.ts 纯函数);
 *   - barge-in:播报中检测到用户开口 → onBargeIn()(组件负责停播报),随后继续录;
 *   - pauseWhenHidden:页面切后台暂停,回前台复位 VAD 继续。
 *
 * 设计要点:
 *   - 音频回调 ~33Hz,全部走 ref,不驱动 React 渲染;只有低频的 phase/activeMode
 *     走 useState(值变化才 set);
 *   - 内部调用图存在环(finishSegmentCycle ↔ startSegment ↔ ensureWs ↔ handleWsMessage),
 *     故用 createController 一次性建好(闭包只读 ref),不依赖 useCallback 依赖数组;
 *   - 转写中(awaitingFinal/批量请求中)出现的新语音段整体丢弃(不做并发转写);
 *   - 强制切段(>maxSegmentMs)后若仍在说话,终稿回来立即开新段续录,不丢后文。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import workletUrl from '../voice/pcm-worklet.js?url';
import {
  DEFAULT_VAD_CONFIG,
  createVadState,
  updateVad,
  processFinalTranscript,
  type VadConfig,
  type VadState,
} from '../voice/vad';
import { apiUrl, authFetch } from '../utils/storage';
import {
  buildVoiceCompanionWsUrl,
  getVoiceCompanionAuthToken,
  type ListeningConfig,
  type SttMode,
} from '../api/voiceCompanion';

const FRAME_MS = 30;
const TARGET_RATE = 16_000;
const CHUNK_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000; // 480
/** 预滚环缓冲:300ms(语音起点先补发,避免吞掉第一个字)。 */
const PREROLL_FRAMES = 10;
/** 流式终稿等待上限(超过视为失败;下一段自动回退批量通道)。 */
const STREAM_FINAL_TIMEOUT_MS = 12_000;
/** 批量回退的转写参数(与 useSTT 默认一致:中文 + turbo)。 */
const BATCH_LANGUAGE = 'Chinese';
const BATCH_MODEL = 'turbo';

export type ListeningPhase = 'off' | 'starting' | 'listening' | 'hearing' | 'transcribing' | 'paused' | 'error';
export type ActiveSttMode = 'stream' | 'segment' | null;

export interface FinalTranscriptMeta {
  /** true = 提交到大脑;false = 仅上屏(组件提供手动提交入口)。 */
  submit: boolean;
  matchedEndWord: boolean;
}

export interface ContinuousListeningOptions {
  /** 总开关(组件层判定:配置 enabled && 用户开启 && 本标签页是 leader)。 */
  enabled: boolean;
  /** 转写通道:auto = 先流式,失败自动回退批量;stream/segment = 强制。 */
  mode: SttMode;
  config: ListeningConfig;
  /** 播报中(组件注入;用于 barge-in 判定与 VAD 防自激)。 */
  ttsSpeaking: boolean;
  /** 实时部分结果(流式);空串 = 清掉实时行。 */
  onPartial: (text: string) => void;
  /** 一句的最终文本(已过唤醒词/结束词处理)。 */
  onFinal: (text: string, meta: FinalTranscriptMeta) => void;
  /** 播报中用户开口(组件据此立即停播报)。 */
  onBargeIn: () => void;
  /** 硬错误(麦克风/转写请求),需要用户知晓。 */
  onError: (message: string) => void;
  /** 非致命提示(如流式不可用已自动回退批量转写)。 */
  onNotice?: (message: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

export interface ContinuousListeningHandle {
  phase: ListeningPhase;
  /** 当前实际通道(null = 未启动)。 */
  activeMode: ActiveSttMode;
  /** autoSubmit=false 且未命中结束词时,最近一条只上屏的终稿(待手动提交)。 */
  pendingSubmit: string | null;
  commitPending: () => void;
  /** 重建流式连接(设置里刚填完凭据 / 想重试时调用)。 */
  reconnect: () => void;
}

// ============================================================================
// 引擎状态(全部在 ref 里,音频回调不触发渲染)
// ============================================================================

interface RecorderBox {
  rec: MediaRecorder;
  chunks: Blob[];
}

interface Engine {
  /** 启停代数:异步 start/stop 交错时旧流程作废。 */
  generation: number;
  ctx: AudioContext | null;
  mic: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  worklet: AudioWorkletNode | null;
  script: ScriptProcessorNode | null;
  sink: GainNode | null;
  ws: WebSocket | null;
  wsReady: boolean;
  /** 流式已判失败:auto 模式下后续段直接走批量,直到 reconnect()/重启。 */
  wsBroken: boolean;
  activeMode: 'stream' | 'segment' | null;
  vad: VadState;
  preRoll: ArrayBuffer[];
  /** 当前语音段正在采集(流式=已开始发帧;批量=MediaRecorder 录制中)。 */
  hearing: boolean;
  /** 本段丢弃(转写中打进的新语音)。 */
  dropSegment: boolean;
  /** 已发 finish,等终稿。 */
  awaitingFinal: boolean;
  /** 下一份终稿丢弃(暂停/关闭时补发 finish 收尾用)。 */
  discardFinal: boolean;
  finalTimer: number | null;
  recorderBox: RecorderBox | null;
  suspended: boolean;
  pendingText: string | null;
}

function createEngine(): Engine {
  return {
    generation: 0,
    ctx: null,
    mic: null,
    source: null,
    worklet: null,
    script: null,
    sink: null,
    ws: null,
    wsReady: false,
    wsBroken: false,
    activeMode: null,
    vad: createVadState(),
    preRoll: [],
    hearing: false,
    dropSegment: false,
    awaitingFinal: false,
    discardFinal: false,
    finalTimer: null,
    recorderBox: null,
    suspended: false,
    pendingText: null,
  };
}

// ============================================================================
// 无依赖工具(与 pcm-worklet.js 逻辑镜像)
// ============================================================================

/** 线性插值降采样:输入任意采样率 Float32,每 chunkSamples 个 16k 样本回调一次。 */
function createDownsampler(
  inputRate: number,
  targetRate: number,
  chunkSamples: number,
  onChunk: (rms: number, pcm16: ArrayBuffer) => void,
): { push: (channel: Float32Array) => void } {
  const step = targetRate / inputRate;
  let pos = 0;
  let last = 0;
  let acc = new Float32Array(chunkSamples);
  let accLen = 0;

  const flush = (): void => {
    let sum = 0;
    for (let i = 0; i < acc.length; i++) sum += acc[i] * acc[i];
    const rms = Math.sqrt(sum / acc.length);
    const pcm16 = new Int16Array(acc.length);
    for (let i = 0; i < acc.length; i++) {
      const v = acc[i] < -1 ? -1 : acc[i] > 1 ? 1 : acc[i];
      pcm16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    onChunk(rms, pcm16.buffer);
    acc = new Float32Array(chunkSamples);
    accLen = 0;
  };

  return {
    push(channel: Float32Array) {
      for (let i = 0; i < channel.length; i++) {
        const cur = channel[i];
        while (pos < 1) {
          acc[accLen++] = last + (cur - last) * pos;
          if (accLen >= chunkSamples) flush();
          pos += step;
        }
        pos -= 1;
        last = cur;
      }
    },
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** MediaRecorder 可用编码阶梯(iOS Safari 无 webm;与 useSTT 一致)。 */
function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', ''];
  for (const mime of candidates) {
    if (!mime || (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime))) return mime;
  }
  return '';
}

function micErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') return '麦克风权限被拒绝';
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') return '未找到麦克风设备';
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') return '麦克风被其他程序占用';
    if (err.name === 'OverconstrainedError') return '麦克风不支持所需参数';
    return `麦克风错误:${err.message}`;
  }
  return '无法访问麦克风';
}

// ============================================================================
// 控制器(一次性创建,闭包只读 ref)
// ============================================================================

interface ControllerDeps {
  engine: Engine;
  optsRef: { current: ContinuousListeningOptions };
  setPhase: (p: ListeningPhase) => void;
  setMode: (m: ActiveSttMode) => void;
  setPending: (t: string | null) => void;
}

interface Controller {
  start: () => Promise<void>;
  teardown: () => void;
  abortSegment: () => void;
  commitPending: () => void;
  reconnect: () => void;
}

function createController(deps: ControllerDeps): Controller {
  const { engine: e, optsRef } = deps;

  // ---- 基础 ----

  function clearFinalTimer(): void {
    if (e.finalTimer !== null) {
      window.clearTimeout(e.finalTimer);
      e.finalTimer = null;
    }
  }

  function sendJson(ws: WebSocket | null, obj: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* 连接瞬断:交给 onclose 处理 */
      }
    }
  }

  function sendBinary(ws: WebSocket | null, frame: ArrayBuffer): boolean {
    // CONNECTING 时 send 会进浏览器缓冲,允许
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.send(frame);
        return true;
      } catch {
        /* fallthrough */
      }
    }
    return false;
  }

  // ---- 转写结果 ----

  /** 终稿处理:唤醒词/结束词/自动提交,再交给组件。 */
  function handleRawTranscript(raw: string): void {
    const o = optsRef.current;
    o.onPartial('');
    const result = processFinalTranscript(raw, {
      wakeWord: o.config.wakeWord,
      endWords: o.config.endWords,
      autoSubmit: o.config.autoSubmit,
    });
    if (!result.text) return; // 空文本 / 被唤醒词过滤
    e.pendingText = result.submit ? null : result.text;
    deps.setPending(result.submit ? null : result.text);
    o.onFinal(result.text, { submit: result.submit, matchedEndWord: result.matchedEndWord });
  }

  /** 一段结束后回落到等待状态;若 VAD 仍在说话(强制切段)则立即开新段续录。 */
  function finishSegmentCycle(): void {
    const o = optsRef.current;
    if (!o.enabled) {
      deps.setPhase('off');
      return;
    }
    if (e.dropSegment) {
      // 转写期间攒下的段已整体丢弃
      e.dropSegment = false;
      deps.setPhase('listening');
      return;
    }
    if (e.vad.speaking) {
      startSegment();
      return;
    }
    deps.setPhase('listening');
  }

  function startFinalTimer(): void {
    const o = optsRef.current;
    clearFinalTimer();
    e.finalTimer = window.setTimeout(() => {
      e.finalTimer = null;
      if (!e.awaitingFinal) return;
      e.awaitingFinal = false;
      if (o.mode !== 'stream') {
        e.wsBroken = true;
        deps.setMode('segment');
      }
      o.onError('流式识别超时(未收到终稿)');
      finishSegmentCycle();
    }, STREAM_FINAL_TIMEOUT_MS);
  }

  /** 流式通道失败:auto 模式静默回退批量;强制 stream 时报告错误。 */
  function onStreamFailure(message: string): void {
    const o = optsRef.current;
    e.wsReady = false;
    e.wsBroken = true;

    if (e.awaitingFinal) {
      e.awaitingFinal = false;
      e.discardFinal = false;
      clearFinalTimer();
      finishSegmentCycle();
    } else if (e.hearing) {
      // 本段音频随坏掉的通道一起丢(不做半段拼接),下一段起走新通道
      e.hearing = false;
      deps.setPhase('listening');
    }

    if (o.mode === 'stream') {
      deps.setMode('stream');
      o.onError(message);
      return;
    }
    deps.setMode('segment');
    console.warn('[VoiceCompanion] 流式识别不可用,已回退批量转写:', message);
    o.onNotice?.(`流式识别不可用,已回退批量转写:${message}`);
  }

  function handleWsMessage(ev: MessageEvent): void {
    let msg: { type?: string; text?: string; message?: string } | null = null;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    const o = optsRef.current;

    if (msg.type === 'ready') {
      e.wsReady = true;
      if (o.mode !== 'segment') deps.setMode('stream');
      return;
    }
    if (msg.type === 'partial') {
      if (e.awaitingFinal || e.discardFinal) return;
      o.onPartial(typeof msg.text === 'string' ? msg.text : '');
      return;
    }
    if (msg.type === 'final') {
      e.awaitingFinal = false;
      clearFinalTimer();
      if (e.discardFinal) {
        e.discardFinal = false;
        finishSegmentCycle();
        return;
      }
      handleRawTranscript(typeof msg.text === 'string' ? msg.text : '');
      finishSegmentCycle();
      return;
    }
    if (msg.type === 'error') {
      e.discardFinal = false;
      onStreamFailure(typeof msg.message === 'string' && msg.message ? msg.message : '流式识别出错');
    }
  }

  /** 建/复用流式 WS;不可用返回 null。 */
  function ensureWs(): WebSocket | null {
    const o = optsRef.current;
    if (e.ws && (e.ws.readyState === WebSocket.OPEN || e.ws.readyState === WebSocket.CONNECTING)) return e.ws;
    if (!o.enabled) return null;
    const url = buildVoiceCompanionWsUrl();
    let ws: WebSocket;
    try {
      const token = getVoiceCompanionAuthToken();
      ws = token ? new WebSocket(url, [`auth-${token}`]) : new WebSocket(url);
    } catch (err) {
      console.warn('[VoiceCompanion] 无法创建流式连接:', err);
      return null;
    }
    ws.binaryType = 'arraybuffer';
    e.ws = ws;
    e.wsReady = false;
    ws.onmessage = (ev) => handleWsMessage(ev);
    ws.onclose = () => {
      if (e.ws !== ws) return;
      e.ws = null;
      if (!optsRef.current.enabled) return;
      onStreamFailure('流式通道连接断开');
    };
    ws.onerror = () => {
      /* 紧接 onclose;错误细节由服务端 error 消息或 onclose 兜底 */
    };
    return ws;
  }

  // ---- 批量回退通道 ----

  function startRecorder(): void {
    const o = optsRef.current;
    if (!e.mic || typeof MediaRecorder === 'undefined') {
      o.onError('当前浏览器不支持 MediaRecorder,批量转写不可用');
      return;
    }
    const mime = pickRecorderMime();
    try {
      const rec = new MediaRecorder(e.mic, mime ? { mimeType: mime } : undefined);
      const box: RecorderBox = { rec, chunks: [] };
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) box.chunks.push(ev.data);
      };
      e.recorderBox = box;
      rec.start(100);
    } catch (err) {
      e.recorderBox = null;
      console.warn('[VoiceCompanion] MediaRecorder 启动失败:', err);
      o.onError('无法开始录音,批量转写不可用');
    }
  }

  async function transcribeBatch(blob: Blob): Promise<void> {
    const o = optsRef.current;
    try {
      if (blob.size < 1000) return; // 太短,当噪声
      const base64 = await blobToBase64(blob);
      const res = await authFetch(apiUrl('/api/stt/transcribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64, language: BATCH_LANGUAGE, model: BATCH_MODEL }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; text?: string; error?: string };
      if (data.success && typeof data.text === 'string') {
        handleRawTranscript(data.text);
      } else if (data.error) {
        o.onError(`转写失败:${data.error}`);
      }
    } catch (err) {
      console.warn('[VoiceCompanion] 批量转写请求失败:', err);
      o.onError('转写请求失败(网络或服务端不可用)');
    } finally {
      if (optsRef.current.enabled) finishSegmentCycle();
    }
  }

  // ---- 段生命周期 ----

  /** 开始一段采集:流式=补发预滚;批量=启动 MediaRecorder。 */
  function startSegment(): void {
    const o = optsRef.current;
    const useStream = o.mode === 'stream' ? true : o.mode === 'segment' ? false : !e.wsBroken;
    e.hearing = true;
    e.dropSegment = false;
    e.activeMode = useStream ? 'stream' : 'segment';
    deps.setMode(e.activeMode);
    deps.setPhase('hearing');
    o.onPartial('');
    o.onSpeechStart?.();

    if (useStream) {
      const ws = ensureWs();
      if (!ws) {
        // 建连失败:本段丢弃
        e.hearing = false;
        e.wsBroken = true;
        if (o.mode !== 'stream') {
          deps.setMode('segment');
          o.onNotice?.('流式通道不可用,已回退批量转写');
        } else {
          o.onError('流式通道不可用');
        }
        deps.setPhase('listening');
        return;
      }
      for (const frame of e.preRoll) {
        if (!sendBinary(ws, frame)) break;
      }
    } else {
      startRecorder();
    }
  }

  /** 结束一段采集并触发转写。 */
  function endSegment(): void {
    const o = optsRef.current;
    if (!e.hearing) return;
    e.hearing = false;
    deps.setPhase('transcribing');
    o.onSpeechEnd?.();

    if (e.activeMode === 'stream') {
      const ws = e.ws;
      if (ws && ws.readyState <= WebSocket.OPEN) {
        e.awaitingFinal = true;
        e.discardFinal = false;
        sendJson(ws, { type: 'finish' });
        startFinalTimer();
      } else {
        e.awaitingFinal = false;
        finishSegmentCycle();
      }
      return;
    }

    const box = e.recorderBox;
    e.recorderBox = null;
    if (!box || box.rec.state === 'inactive') {
      finishSegmentCycle();
      return;
    }
    box.rec.onstop = () => {
      const chunks = box.chunks;
      box.chunks = [];
      const type = chunks[0]?.type || 'audio/webm';
      void transcribeBatch(new Blob(chunks, { type }));
    };
    try {
      box.rec.stop();
    } catch {
      finishSegmentCycle();
    }
  }

  /** 丢弃当前段(暂停/关闭时),不产生任何提交。 */
  function abortSegment(): void {
    e.hearing = false;
    e.dropSegment = false;
    if (e.recorderBox) {
      const box = e.recorderBox;
      e.recorderBox = null;
      box.chunks = [];
      try {
        box.rec.stop();
      } catch {
        /* ignore */
      }
    }
    if (e.activeMode === 'stream' && e.ws && e.ws.readyState <= WebSocket.OPEN && !e.awaitingFinal) {
      // 段中途暂停:补发 finish 让服务端/火山会话收尾(终稿丢弃),通道本身保留
      e.discardFinal = true;
      e.awaitingFinal = true;
      sendJson(e.ws, { type: 'finish' });
      startFinalTimer();
    } else if (e.awaitingFinal) {
      e.discardFinal = true;
    }
  }

  /** 音频帧入口:~33Hz。 */
  function onFrame(rms: number, pcm16: ArrayBuffer): void {
    const o = optsRef.current;
    if (!o.enabled || e.suspended || !e.ctx) return;

    // 预滚:始终维护最近 300ms(语音起点补发,不吞第一个字)
    e.preRoll.push(pcm16);
    if (e.preRoll.length > PREROLL_FRAMES) e.preRoll.shift();

    const cfg: VadConfig = {
      ...DEFAULT_VAD_CONFIG,
      silenceMs: o.config.silenceMs,
      minSpeechMs: o.config.minSpeechMs,
      maxSegmentMs: o.config.maxSegmentMs,
      startThreshold: o.config.startThreshold,
    };
    const updated = updateVad({ ...e.vad, ttsActive: o.ttsSpeaking }, rms, FRAME_MS, cfg);
    e.vad = updated.state;
    const ev = updated.event;

    if (ev === 'speech-start') {
      if (o.ttsSpeaking && !o.config.bargeIn) {
        // 播报中且未开抢话:整体忽略(复位,避免扬声器自激攒出一段)
        e.vad = createVadState();
        return;
      }
      if (o.ttsSpeaking) o.onBargeIn();
      if (e.awaitingFinal || e.hearing) {
        e.dropSegment = true; // 转写中打进的新语音:整段丢弃
        return;
      }
      startSegment();
      return;
    }

    if (ev === 'speech-end') {
      if (e.dropSegment) {
        e.dropSegment = false;
        return;
      }
      if (!e.hearing) return;
      endSegment();
      return;
    }

    if (ev === 'force-cut') {
      if (e.dropSegment || !e.hearing) return;
      endSegment();
      return;
    }

    // 进行中的段:流式通道逐帧发;批量通道由 MediaRecorder 自行收集
    if (e.hearing && e.activeMode === 'stream') {
      sendBinary(e.ws, pcm16);
    }
  }

  // ---- 启动 / 关闭 ----

  function teardown(): void {
    e.generation++;
    clearFinalTimer();
    e.suspended = false;
    e.hearing = false;
    e.dropSegment = false;
    e.awaitingFinal = false;
    e.discardFinal = false;

    if (e.recorderBox) {
      const box = e.recorderBox;
      e.recorderBox = null;
      box.chunks = [];
      try {
        box.rec.stop();
      } catch {
        /* ignore */
      }
    }
    if (e.ws) {
      const ws = e.ws;
      e.ws = null;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (e.worklet) {
      const node = e.worklet;
      e.worklet = null;
      try {
        node.port.postMessage({ type: 'stop' });
        node.port.onmessage = null;
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (e.script) {
      const node = e.script;
      e.script = null;
      try {
        node.onaudioprocess = null;
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (e.source) {
      try {
        e.source.disconnect();
      } catch {
        /* ignore */
      }
      e.source = null;
    }
    if (e.sink) {
      try {
        e.sink.disconnect();
      } catch {
        /* ignore */
      }
      e.sink = null;
    }
    if (e.mic) {
      e.mic.getTracks().forEach((track) => track.stop());
      e.mic = null;
    }
    if (e.ctx) {
      const ctx = e.ctx;
      e.ctx = null;
      void ctx.close().catch(() => undefined);
    }
    e.vad = createVadState();
    e.preRoll = [];
    e.wsReady = false;
    e.wsBroken = false;
    e.activeMode = null;
    e.pendingText = null;
    deps.setPending(null);
  }

  async function start(): Promise<void> {
    if (e.ctx || e.mic) return; // 幂等
    const gen = ++e.generation;
    const stale = () => gen !== e.generation;
    const fail = (message: string) => {
      teardown();
      deps.setPhase('error');
      optsRef.current.onError(message);
    };

    deps.setPhase('starting');
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      fail('麦克风需要 HTTPS(或 localhost)环境');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      fail('当前浏览器不支持麦克风采集');
      return;
    }

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: TARGET_RATE },
      });
    } catch (err) {
      fail(micErrorMessage(err));
      return;
    }
    if (stale() || !optsRef.current.enabled) {
      mic.getTracks().forEach((track) => track.stop());
      return;
    }
    e.mic = mic;

    // AudioContext:优先 16k(免二次重采样),个别浏览器不支持时退回默认率
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: TARGET_RATE });
    } catch {
      try {
        ctx = new Ctor();
      } catch (err) {
        console.warn('[VoiceCompanion] 创建 AudioContext 失败:', err);
        fail('无法创建音频上下文');
        return;
      }
    }
    e.ctx = ctx;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      /* 允许后续点击/可见性兜底 */
    }
    if (stale()) return;

    const source = ctx.createMediaStreamSource(mic);
    e.source = source;
    const sink = ctx.createGain();
    sink.gain.value = 0; // 静音:仅为保持图连接,让 worklet/processor 持续被 pull
    sink.connect(ctx.destination);
    e.sink = sink;

    let usedWorklet = false;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule(workletUrl);
        if (stale()) return;
        const node = new AudioWorkletNode(ctx, 'pcm-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { targetRate: TARGET_RATE, frameMs: FRAME_MS },
        });
        node.port.onmessage = (ev: MessageEvent) => {
          const d = ev.data as { rms?: number; pcm16?: ArrayBuffer } | null;
          if (!d || typeof d.rms !== 'number' || !d.pcm16) return;
          try {
            onFrame(d.rms, d.pcm16);
          } catch (err) {
            console.warn('[VoiceCompanion] 音频帧处理出错:', err);
          }
        };
        source.connect(node);
        node.connect(sink);
        e.worklet = node;
        usedWorklet = true;
      } catch (err) {
        console.warn('[VoiceCompanion] AudioWorklet 不可用,回退 ScriptProcessor:', err);
      }
    }
    if (stale()) return;

    if (!usedWorklet) {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      const downsampler = createDownsampler(ctx.sampleRate, TARGET_RATE, CHUNK_SAMPLES, (rms, pcm16) => {
        try {
          onFrame(rms, pcm16);
        } catch (err) {
          console.warn('[VoiceCompanion] 音频帧处理出错:', err);
        }
      });
      node.onaudioprocess = (ev: AudioProcessingEvent) => {
        downsampler.push(ev.inputBuffer.getChannelData(0));
      };
      source.connect(node);
      node.connect(sink);
      e.script = node;
    }

    deps.setPhase('listening');
    console.log('[VoiceCompanion] 持续聆听已启动', { sampleRate: ctx.sampleRate, worklet: usedWorklet });
  }

  function commitPending(): void {
    const text = e.pendingText;
    if (!text) return;
    e.pendingText = null;
    deps.setPending(null);
    optsRef.current.onFinal(text, { submit: true, matchedEndWord: false });
  }

  function reconnect(): void {
    e.wsBroken = false;
    if (e.ws) {
      const ws = e.ws;
      e.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    deps.setMode(null);
    if (optsRef.current.enabled) ensureWs();
  }

  return { start, teardown, abortSegment, commitPending, reconnect };
}

// ============================================================================
// Hook
// ============================================================================

export function useContinuousListening(opts: ContinuousListeningOptions): ContinuousListeningHandle {
  const [phase, setPhase] = useState<ListeningPhase>('off');
  const [activeMode, setActiveMode] = useState<ActiveSttMode>(null);
  const [pendingSubmit, setPendingSubmit] = useState<string | null>(null);

  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine();
  const engine = engineRef.current;

  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setPhaseSafe = useCallback((p: ListeningPhase) => {
    if (mountedRef.current) setPhase(p);
  }, []);
  const setModeSafe = useCallback((m: ActiveSttMode) => {
    if (mountedRef.current) setActiveMode(m);
  }, []);
  const setPendingSafe = useCallback((t: string | null) => {
    if (mountedRef.current) setPendingSubmit(t);
  }, []);

  const controllerRef = useRef<Controller | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createController({
      engine,
      optsRef,
      setPhase: setPhaseSafe,
      setMode: setModeSafe,
      setPending: setPendingSafe,
    });
  }
  const ctrl = controllerRef.current;

  // 启停
  useEffect(() => {
    if (!opts.enabled) {
      ctrl.teardown();
      setPhaseSafe('off');
      setModeSafe(null);
      return;
    }
    void ctrl.start();
    return () => {
      ctrl.teardown();
    };
  }, [opts.enabled, ctrl, setPhaseSafe, setModeSafe]);

  // 页面可见性:后台暂停 / 回前台复位续听
  useEffect(() => {
    const onVisibility = () => {
      const o = optsRef.current;
      if (!o.enabled || !o.config.pauseWhenHidden) return;
      if (document.hidden) {
        if (engine.suspended) return;
        engine.suspended = true;
        ctrl.abortSegment();
        setPhaseSafe('paused');
      } else {
        if (!engine.suspended) return;
        engine.suspended = false;
        engine.vad = createVadState();
        setPhaseSafe(engine.ctx ? 'listening' : 'starting');
        if (engine.ctx && engine.ctx.state === 'suspended') {
          void engine.ctx.resume().catch(() => undefined);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [engine, ctrl, setPhaseSafe]);

  return {
    phase,
    activeMode,
    pendingSubmit,
    commitPending: ctrl.commitPending,
    reconnect: ctrl.reconnect,
  };
}
