/**
 * 语音伙伴 · 持续聆听 Hook
 *
 * 职责(纯客户端,零新依赖):
 *   - 常开麦克风(参数同 useSTT)+ AudioWorklet 采集 16k PCM(不可用回退 ScriptProcessor);
 *   - VAD(voice/vad.ts)自动断句:起说/静音判停/超长强制切段,播报中支持抢话;
 *   - 双通道转写:
 *       stream  —— WS /ws/voice-companion → 火山引擎流式识别,partial 实时上屏;
 *       segment —— 帧拼 16k WAV(段首含预滚)→ 既有 /api/stt/transcribe(批量回退,
 *                  凭据缺失/流式出错/手动指定时使用,不再依赖 MediaRecorder);
 *   - 文本后处理:唤醒词过滤、结束词剥离、autoSubmit(vad.ts 纯函数);
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
import { createSileroRunner, loadSileroVad, type SileroRunner } from '../voice/sileroVad';
import { WAV_HEADER_BYTES, pcm16FramesToWav } from '../voice/wav';
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
/** 预滚环缓冲:480ms(确认开段时补发,覆盖最坏确认 400ms + 模型滞后 ~2 帧,不吞第一个字)。 */
const PREROLL_FRAMES = 16;
/** 流式终稿等待上限(超过视为失败;下一段自动回退批量通道)。 */
const STREAM_FINAL_TIMEOUT_MS = 12_000;
/** 握手期发送队列上限(30ms 帧 ≈ 36s 音频;超限丢最旧,极端情况兜底)。 */
const WS_SEND_QUEUE_MAX = 1200;
/** 批量回退的转写参数(与 useSTT 默认一致:中文 + turbo)。 */
const BATCH_LANGUAGE = 'Chinese';
const BATCH_MODEL = 'turbo';

export type ListeningPhase = 'off' | 'starting' | 'listening' | 'hearing' | 'transcribing' | 'paused' | 'error';
export type ActiveSttMode = 'stream' | 'segment' | null;
/** 实际生效的判停引擎:model=小模型就绪;loading/failed 期间回退能量通路。 */
export type VadEngineState = 'energy' | 'loading' | 'model' | 'failed';

export interface FinalTranscriptMeta {
  /** true = 提交到大脑;false = 仅上屏(组件提供手动提交入口)。 */
  submit: boolean;
  matchedEndWord: boolean;
  /**
   * 手动提交回放(commitPending):同一文本此前以 submit=false 已上屏过一次,
   * 组件不必再 push 用户条目(避免重复;P11)。
   */
  fromPending?: boolean;
}

export interface ContinuousListeningOptions {
  /** 总开关(组件层判定:配置 enabled && 用户开启 && 本标签页是 leader)。 */
  enabled: boolean;
  /** 转写通道:auto = 先流式,失败自动回退批量;stream/segment = 强制。 */
  mode: SttMode;
  config: ListeningConfig;
  /** 播报中(组件注入;用于 barge-in 判定与 VAD 防自激)。 */
  ttsSpeaking: boolean;
  /** 上一回合仍在途(思考中;组件注入)。与 ttsSpeaking 并列触发 latest-wins 打断(HC-B8)。 */
  turnInFlight?: boolean;
  /** 实时部分结果(流式);空串 = 清掉实时行。 */
  onPartial: (text: string) => void;
  /** W7:垫话预生成就绪提示(服务端在说话期间推来)→ 组件提前合成音频,正式句到达零等待。 */
  onFillerHint?: (text: string) => void;
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
  /** 实际生效的判停引擎(观测/设置面板显示用)。 */
  vadEngine: VadEngineState;
  /** autoSubmit=false 且未命中结束词时,最近一条只上屏的终稿(待手动提交)。 */
  pendingSubmit: string | null;
  commitPending: () => void;
  /** 重建流式连接(设置里刚填完凭据 / 想重试时调用)。 */
  reconnect: () => void;
  /** 仅 DEV:E2E 注入合成音频帧驱动音频管线(无真麦也能测 VAD 全链路)。 */
  devFeed: (rms: number, frames: number, opts?: { bypassModel?: boolean }) => void;
}

// ============================================================================
// 引擎状态(全部在 ref 里,音频回调不触发渲染)
// ============================================================================

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
  /** 握手期(WS 尚未 OPEN)待发队列:帧与 finish 依序补发,连接失败即清空。 */
  wsQueue: Array<string | ArrayBuffer>;
  wsReady: boolean;
  /** 流式已判失败:auto 模式下后续段直接走批量,直到 reconnect()/重启。 */
  wsBroken: boolean;
  activeMode: 'stream' | 'segment' | null;
  vad: VadState;
  /** Silero 小模型 runner(null = 未启用/未就绪,判停走能量)。 */
  silero: SileroRunner | null;
  sileroLoading: boolean;
  sileroFailed: boolean;
  /** 仅 DEV:devFeed 正在注入合成帧(无音频图也放行 onFrame)。 */
  devFeeding: boolean;
  /** 仅 DEV:本段合成帧绕过小模型(模型会把方波判成非语音)。 */
  devBypassSilero: boolean;
  preRoll: ArrayBuffer[];
  /** 批量通道当前段的 PCM16 帧(开段时以预滚帧初始化);null = 不在采段。 */
  segmentFrames: ArrayBuffer[] | null;
  /** 当前语音段正在采集(流式=已开始发帧;批量=帧累加中)。 */
  hearing: boolean;
  /** 本段丢弃(转写中打进的新语音)。 */
  dropSegment: boolean;
  /** 批量转写请求在途(与 awaitingFinal 同义,只是走 /api/stt/transcribe)。 */
  batchBusy: boolean;
  /** 在途批量结果作废(暂停/关闭时清段,迟到转写不再提交)。 */
  discardBatch: boolean;
  /** 已发 finish,等终稿。 */
  awaitingFinal: boolean;
  /** 下一份终稿丢弃(暂停/关闭时补发 finish 收尾用)。 */
  discardFinal: boolean;
  finalTimer: number | null;
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
    wsQueue: [],
    wsReady: false,
    wsBroken: false,
    activeMode: null,
    vad: createVadState(),
    silero: null,
    sileroLoading: false,
    sileroFailed: false,
    devFeeding: false,
    devBypassSilero: false,
    preRoll: [],
    segmentFrames: null,
    hearing: false,
    dropSegment: false,
    batchBusy: false,
    discardBatch: false,
    awaitingFinal: false,
    discardFinal: false,
    finalTimer: null,
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

/** 字节 → base64(分包避免超长参数;批量转写请求体用)。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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
  setVadEngine: (s: VadEngineState) => void;
}

interface Controller {
  start: () => Promise<void>;
  teardown: () => void;
  abortSegment: () => void;
  commitPending: () => void;
  reconnect: () => void;
  devFeed: (rms: number, frames: number, opts?: { bypassModel?: boolean }) => void;
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

  /**
   * WS 发送:OPEN 直发;CONNECTING 时入有界队列,onopen 依序补发。
   * 浏览器在 CONNECTING 阶段 send() 会抛 InvalidStateError —— 旧实现把
   * finish 静默丢掉,只能干等 12s 超时(P12);现在握手期帧与 finish 都不丢。
   */
  function sendWs(ws: WebSocket | null, data: string | ArrayBuffer): boolean {
    if (!ws) return false;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
        return true;
      } catch {
        return false; // 连接瞬断:交给 onclose 处理
      }
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      if (e.wsQueue.length >= WS_SEND_QUEUE_MAX) e.wsQueue.shift();
      e.wsQueue.push(data);
      return true;
    }
    return false;
  }

  function sendJson(ws: WebSocket | null, obj: Record<string, unknown>): void {
    sendWs(ws, JSON.stringify(obj));
  }

  function sendBinary(ws: WebSocket | null, frame: ArrayBuffer): boolean {
    return sendWs(ws, frame);
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
    if (e.suspended) return; // 切后台暂停中:迟到终稿只收尾,绝不重启采集(幽灵段,P13)
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
      const wasDiscard = e.discardFinal;
      e.discardFinal = false;
      e.wsQueue = [];
      // 超时即作废本段使用的 WS 会话:迟到终稿无处到达,不可能再被误提交(P2)
      const ws = e.ws;
      e.ws = null;
      e.wsReady = false;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      if (o.mode !== 'stream') {
        e.wsBroken = true;
        deps.setMode('segment');
      }
      if (!wasDiscard) o.onError('流式识别超时(未收到终稿)'); // 丢弃段的收尾超时不打扰用户
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
    if (msg.type === 'filler') {
      // W7:垫话预生成就绪(可能先于 final 到达)→ 提前合成;段已作废则忽略,免白合成。
      // 注意不查 awaitingFinal:等待 final 期间收到 hint 照样有用(回合马上要开始)。
      if (!e.discardFinal) o.onFillerHint?.(typeof msg.text === 'string' ? msg.text : '');
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
    e.wsQueue = [];
    ws.onopen = () => {
      if (e.ws !== ws) return;
      const queued = e.wsQueue;
      e.wsQueue = [];
      for (const item of queued) {
        try {
          ws.send(item);
        } catch {
          break; // 余下丢弃:交给 onclose / 终稿超时收尾
        }
      }
    };
    ws.onmessage = (ev) => handleWsMessage(ev);
    ws.onclose = () => {
      if (e.ws !== ws) return;
      e.ws = null;
      e.wsQueue = [];
      if (!optsRef.current.enabled) return;
      onStreamFailure('流式通道连接断开');
    };
    ws.onerror = () => {
      /* 紧接 onclose;错误细节由服务端 error 消息或 onclose 兜底 */
    };
    return ws;
  }

  // ---- 批量回退通道(帧拼 WAV,经既有 /api/stt/transcribe) ----

  async function transcribeBatch(wav: Uint8Array): Promise<void> {
    const o = optsRef.current;
    e.batchBusy = true;
    e.discardBatch = false;
    try {
      if (wav.byteLength <= WAV_HEADER_BYTES) return; // 只有头 = 无音频,当噪声
      const base64 = bytesToBase64(wav);
      const res = await authFetch(apiUrl('/api/stt/transcribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64, language: BATCH_LANGUAGE, model: BATCH_MODEL }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; text?: string; error?: string };
      if (e.discardBatch || e.suspended) return; // 段已作废(暂停/关闭):迟到转写丢弃,不提交
      if (data.success && typeof data.text === 'string') {
        handleRawTranscript(data.text);
      } else if (data.error) {
        o.onError(`转写失败:${data.error}`);
      }
    } catch (err) {
      if (!e.discardBatch && !e.suspended) {
        console.warn('[VoiceCompanion] 批量转写请求失败:', err);
        o.onError('转写请求失败(网络或服务端不可用)');
      }
    } finally {
      e.batchBusy = false;
      e.discardBatch = false;
      if (optsRef.current.enabled) finishSegmentCycle();
    }
  }

  // ---- 段生命周期 ----

  /** 开始一段采集:流式=补发预滚;批量=以预滚帧初始化段缓冲。 */
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
      // onFrame 已把当前帧放进 preRoll:整段含 480ms 预滚,首字不丢
      e.segmentFrames = e.preRoll.slice();
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
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        // CONNECTING 时 finish 入队、onopen 补发:不再被静默丢弃干等超时(P12)
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

    const frames = e.segmentFrames;
    e.segmentFrames = null;
    if (!frames || frames.length === 0) {
      finishSegmentCycle();
      return;
    }
    void transcribeBatch(pcm16FramesToWav(frames));
  }

  /** 丢弃当前段(暂停/关闭时),不产生任何提交。 */
  function abortSegment(): void {
    e.hearing = false;
    e.dropSegment = false;
    if (e.batchBusy) e.discardBatch = true; // 在途批量结果作废(与流式 discardFinal 对齐)
    if (e.segmentFrames) {
      e.segmentFrames = null;
    }
    if (
      e.activeMode === 'stream' &&
      e.ws &&
      (e.ws.readyState === WebSocket.OPEN || e.ws.readyState === WebSocket.CONNECTING) &&
      !e.awaitingFinal
    ) {
      // 段中途暂停:补发 finish 让服务端/火山会话收尾(终稿丢弃),通道本身保留
      e.discardFinal = true;
      e.awaitingFinal = true;
      e.wsQueue = []; // 丢弃段不再补发握手期已缓冲的音频
      sendJson(e.ws, { type: 'finish' });
      startFinalTimer();
    } else if (e.awaitingFinal) {
      e.discardFinal = true;
    }
  }

  // ---- 判停引擎(Silero 小模型懒加载;失败只回退能量,绝不打断聆听) ----

  function ensureSilero(): void {
    const mode = optsRef.current.config.engine ?? DEFAULT_VAD_CONFIG.engine;
    if (mode === 'energy' || e.silero || e.sileroLoading || e.sileroFailed) return;
    e.sileroLoading = true;
    deps.setVadEngine('loading');
    void loadSileroVad()
      .then(() => {
        e.sileroLoading = false;
        if (!optsRef.current.enabled || e.silero) return; // 已关闭/已建:不重复
        e.silero = createSileroRunner();
        deps.setVadEngine(e.silero ? 'model' : 'energy');
      })
      .catch((err) => {
        e.sileroLoading = false;
        e.sileroFailed = true; // 本次聆听内不再重试(重启后恢复)
        deps.setVadEngine('failed');
        console.warn('[VoiceCompanion] 小模型加载失败,回退能量判停:', err);
        optsRef.current.onNotice?.('小模型加载失败,已用能量判停');
      });
  }

  /** 仅 DEV:E2E 用合成帧驱动整条音频管线(真麦不便/不可用时测 VAD 链路)。 */
  function devFeed(rms: number, frames: number, opts?: { bypassModel?: boolean }): void {
    if (!import.meta.env.DEV) return;
    const count = Math.max(0, Math.min(600, Math.floor(frames)));
    const pcm = new Int16Array(CHUNK_SAMPLES);
    const amp = Math.round(Math.max(0, Math.min(1, rms)) * 0x7000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 === 0 ? amp : -amp;
    e.devFeeding = true;
    e.devBypassSilero = opts?.bypassModel === true;
    try {
      for (let f = 0; f < count; f++) onFrame(rms, pcm.buffer);
    } finally {
      e.devFeeding = false;
      e.devBypassSilero = false;
    }
  }

  /** 音频帧入口:~33Hz。 */
  function onFrame(rms: number, pcm16: ArrayBuffer): void {
    const o = optsRef.current;
    if (!o.enabled || e.suspended) return;
    if (!e.ctx && !e.devFeeding) return; // 真机帧只在音频图运行时到达;devFeed 允许无麦

    // 预滚:始终维护最近 300ms(语音起点补发,不吞第一个字)
    e.preRoll.push(pcm16);
    if (e.preRoll.length > PREROLL_FRAMES) e.preRoll.shift();

    const cfg: VadConfig = {
      ...DEFAULT_VAD_CONFIG,
      engine: o.config.engine ?? DEFAULT_VAD_CONFIG.engine,
      silenceMs: o.config.silenceMs,
      confirmMs: o.config.confirmMs,
      maxSegmentMs: o.config.maxSegmentMs,
      startThreshold: o.config.startThreshold,
    };
    if (cfg.engine !== 'energy') ensureSilero();
    // 小模型就绪后以语音概率替代能量迟滞(推入 30ms 帧,返回最近完成窗的概率)
    let speechProb: number | null = null;
    if (cfg.engine !== 'energy' && e.silero && !e.devBypassSilero) {
      speechProb = e.silero.pushFrame(pcm16);
    }
    const updated = updateVad({ ...e.vad, ttsActive: o.ttsSpeaking }, rms, FRAME_MS, cfg, speechProb);
    e.vad = updated.state;
    const ev = updated.event;

    if (ev === 'speech-start') {
      if (o.ttsSpeaking && !o.config.bargeIn) {
        // 播报中且未开抢话:整体忽略(复位,避免扬声器自激攒出一段)
        e.vad = createVadState();
        return;
      }
      // latest-wins(HC-B8):播报中,或上一回合仍在途(思考中),新语音开口即打断上一轮
      if ((o.ttsSpeaking || o.turnInFlight) && o.config.bargeIn) o.onBargeIn();
      if (e.awaitingFinal || e.hearing || e.batchBusy) {
        e.dropSegment = true; // 转写中(流式终稿/批量请求在途)打进的新语音:整段丢弃
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

    // 防御网:VAD 已判定不在段内,但 hook 仍在采集(事件丢失/状态漂移)= 收尾,
    // 最坏丢一段音频,绝不把会话卡在 hearing(旧缺陷的整类问题从此不可达)。
    if (!ev && !updated.state.speaking && e.hearing && !e.awaitingFinal) {
      abortSegment();
      if (o.enabled) deps.setPhase('listening');
      return;
    }

    // 进行中的段:流式通道逐帧发;批量通道累加帧(结束时段拼 WAV)
    if (e.hearing) {
      if (e.activeMode === 'stream') sendBinary(e.ws, pcm16);
      else e.segmentFrames?.push(pcm16);
    }
  }

  // ---- 启动 / 关闭 ----

  function teardown(): void {
    e.generation++;
    clearFinalTimer();
    e.suspended = false;
    e.hearing = false;
    e.dropSegment = false;
    e.batchBusy = false;
    e.discardBatch = false;
    e.awaitingFinal = false;
    e.discardFinal = false;
    e.wsQueue = [];

    e.segmentFrames = null;
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
    e.silero = null;
    e.sileroLoading = false;
    e.sileroFailed = false;
    e.devFeeding = false;
    e.devBypassSilero = false;
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
    ensureSilero(); // 引擎=自动/小模型时后台预热(失败回退能量,不影响已启动的聆听)
    console.log('[VoiceCompanion] 持续聆听已启动', { sampleRate: ctx.sampleRate, worklet: usedWorklet });
  }

  function commitPending(): void {
    const text = e.pendingText;
    if (!text) return;
    e.pendingText = null;
    deps.setPending(null);
    optsRef.current.onFinal(text, { submit: true, matchedEndWord: false, fromPending: true });
  }

  function reconnect(): void {
    e.wsBroken = false;
    e.wsQueue = [];
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

  return { start, teardown, abortSegment, commitPending, reconnect, devFeed };
}

// ============================================================================
// Hook
// ============================================================================

export function useContinuousListening(opts: ContinuousListeningOptions): ContinuousListeningHandle {
  const [phase, setPhase] = useState<ListeningPhase>('off');
  const [activeMode, setActiveMode] = useState<ActiveSttMode>(null);
  const [pendingSubmit, setPendingSubmit] = useState<string | null>(null);
  const [vadEngine, setVadEngine] = useState<VadEngineState>('energy');

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
  const setVadEngineSafe = useCallback((s: VadEngineState) => {
    if (mountedRef.current) setVadEngine(s);
  }, []);

  const controllerRef = useRef<Controller | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createController({
      engine,
      optsRef,
      setPhase: setPhaseSafe,
      setMode: setModeSafe,
      setPending: setPendingSafe,
      setVadEngine: setVadEngineSafe,
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
    vadEngine,
    pendingSubmit,
    commitPending: ctrl.commitPending,
    reconnect: ctrl.reconnect,
    devFeed: ctrl.devFeed,
  };
}
