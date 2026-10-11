/**
 * 火山引擎「大模型流式语音识别」(SAUC)WebSocket 客户端
 *
 * 官方文档:https://www.volcengine.com/docs/6561/1354869
 *   - 端点:wss://openspeech.bytedance.com/api/v3/sauc/{bigmodel_async|bigmodel|bigmodel_nostream}
 *   - 鉴权(握手 header):新版 X-Api-Key,或旧版 X-Api-App-Key + X-Api-Access-Key;
 *     另需 X-Api-Resource-Id,建议带 X-Api-Connect-Id;响应头 X-Tt-Logid 用于排障。
 *   - 二进制协议(大端):4B header + [4B sequence(仅当 flags 含 0b0001)] + 4B payload size + payload。
 *     header[0]=版本<<4|头长, header[1]=消息类型<<4|flags, header[2]=序列化<<4|压缩, header[3]=保留。
 *     消息:全量请求 0b0001 / 音频请求 0b0010 / 服务端结果 0b1001 / 错误 0b1111;
 *     flags:0b0000 无序号, 0b0001 正序号, 0b0010 末包无序号, 0b0011 末包带负序号。
 *     压缩:0b0000 不压缩 / 0b0001 gzip;序列化:0b0000 raw / 0b0001 JSON。
 *     错误帧布局:header + 4B 错误码 + 4B 消息长度 + 消息体。
 *
 * 会话模型:一段话 = 一个会话(懒连接:首帧音频才建连)。
 *   start → 发全量请求(JSON:audio 元数据 + request 参数)→ 持续 sendAudio(100~200ms/包)
 *   → 客户端 VAD 判停调用 finish()(发负序号空末包)→ 服务端回末包响应 → onFinal。
 * 计费只按真实发送的音频时长(不发静音);空闲超时或出错即断开。
 *
 * 纯函数(buildHeader/buildFullClientRequest/buildAudioOnlyRequest/parseServerFrame/
 * describeVolcError)导出以便单测;网络部分保持薄。
 */

import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import type { VolcengineEndpoint, VolcengineSttConfig } from '../services/voice-companion-service.js';
import { pickAsrCorpus } from './asr-hotwords.js';
import {
  buildVoiceprintRequestFields,
  createVoiceprintTracker,
  readVoiceprintConfig,
  type VoiceprintSignal,
  type VoiceprintTracker,
} from './voiceprint-gate.js';

// ============================================================================
// 协议常量
// ============================================================================

export const PROTOCOL_VERSION = 0b0001;
export const DEFAULT_HEADER_SIZE = 0b0001;

export const MSG_TYPE = {
  CLIENT_FULL_REQUEST: 0b0001,
  CLIENT_AUDIO_ONLY_REQUEST: 0b0010,
  SERVER_FULL_RESPONSE: 0b1001,
  SERVER_ACK: 0b1011,
  SERVER_ERROR_RESPONSE: 0b1111,
} as const;

export const FLAGS = {
  NO_SEQUENCE: 0b0000,
  POS_SEQUENCE: 0b0001,
  NEG_SEQUENCE: 0b0010,
  NEG_WITH_SEQUENCE: 0b0011,
} as const;

export const SERIALIZATION = {
  NONE: 0b0000,
  JSON: 0b0001,
} as const;

export const COMPRESSION = {
  NONE: 0b0000,
  GZIP: 0b0001,
} as const;

const VOLC_WS_BASE = 'wss://openspeech.bytedance.com/api/v3/sauc/';

/** 单包音频上限(100ms @16k/16bit/mono);超出则拆分,匹配官方 100~200ms 建议。 */
const MAX_AUDIO_PACKET_BYTES = 3200;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_FINISH_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

// ============================================================================
// 纯函数:组帧 / 解帧
// ============================================================================

export function buildHeader(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE;
  header[1] = (messageType << 4) | flags;
  header[2] = (serialization << 4) | compression;
  header[3] = 0x00;
  return header;
}

/** 全量请求(含音频元数据与识别参数):header + 4B 序号 + 4B 长度 + gzip(JSON)。 */
export function buildFullClientRequest(seq: number, payload: unknown): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    buildHeader(MSG_TYPE.CLIENT_FULL_REQUEST, FLAGS.POS_SEQUENCE, SERIALIZATION.JSON, COMPRESSION.GZIP),
    seqBuf,
    sizeBuf,
    body,
  ]);
}

/** 音频请求:末包用负序号 + 0b0011;payload 是原始音频(gzip 压缩)。 */
export function buildAudioOnlyRequest(seq: number, audio: Buffer, isLast: boolean): Buffer {
  const body = gzipSync(audio);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(isLast ? -seq : seq, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    buildHeader(
      MSG_TYPE.CLIENT_AUDIO_ONLY_REQUEST,
      isLast ? FLAGS.NEG_WITH_SEQUENCE : FLAGS.POS_SEQUENCE,
      SERIALIZATION.NONE,
      COMPRESSION.GZIP,
    ),
    seqBuf,
    sizeBuf,
    body,
  ]);
}

export interface ParsedServerFrame {
  messageType: number;
  flags: number;
  sequence: number | null;
  isLast: boolean;
  /** 结果帧解出的 JSON 对象;错误帧为 null。 */
  payload: unknown | null;
  errorCode?: number;
  errorMessage?: string;
}

function decodePayload(serialization: number, compression: number, raw: Buffer): unknown {
  let buf = raw;
  if (compression === COMPRESSION.GZIP && buf.length > 0) {
    buf = gunzipSync(buf);
  }
  if (serialization === SERIALIZATION.JSON && buf.length > 0) {
    return JSON.parse(buf.toString('utf-8'));
  }
  return buf.length > 0 ? buf.toString('utf-8') : null;
}

/** 解析服务端帧(结果 / 错误;ACK 等其它类型只回元信息)。 */
export function parseServerFrame(frame: Buffer): ParsedServerFrame {
  if (frame.length < 4) throw new Error('帧长度不足 4 字节');

  const headerSize = frame[0] & 0x0f;
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  let offset = Math.max(headerSize, 1) * 4;

  let sequence: number | null = null;
  if (flags & FLAGS.POS_SEQUENCE) {
    sequence = frame.readInt32BE(offset);
    offset += 4;
  }
  const isLast = (flags & FLAGS.NEG_SEQUENCE) !== 0;

  if (messageType === MSG_TYPE.SERVER_FULL_RESPONSE) {
    const size = frame.readUInt32BE(offset);
    offset += 4;
    const raw = frame.subarray(offset, offset + size);
    return { messageType, flags, sequence, isLast, payload: decodePayload(serialization, compression, raw) };
  }

  if (messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
    const errorCode = frame.readInt32BE(offset);
    offset += 4;
    const size = frame.readUInt32BE(offset);
    offset += 4;
    const raw = frame.subarray(offset, offset + size);
    let errorMessage = '';
    try {
      const decoded = decodePayload(serialization, compression, raw);
      errorMessage = typeof decoded === 'string' ? decoded : JSON.stringify(decoded ?? '');
    } catch {
      errorMessage = raw.toString('utf-8');
    }
    return { messageType, flags, sequence, isLast, payload: null, errorCode, errorMessage };
  }

  return { messageType, flags, sequence, isLast, payload: null };
}

const VOLC_ERROR_MESSAGES: Record<number, string> = {
  20000000: '成功',
  45000001: '请求参数无效',
  45000002: '音频为空',
  45000081: '等待音频包超时',
  45000151: '音频格式不正确',
  55000031: '服务端繁忙,请稍后再试',
};

/** 错误码 → 中文说明(未知码保留原始码便于查文档)。 */
export function describeVolcError(code: number, detail?: string): string {
  const base =
    VOLC_ERROR_MESSAGES[code] ??
    (code >= 55000000 && code < 56000000 ? '服务端内部处理错误' : '未知错误');
  const tail = detail ? `(${detail.slice(0, 160)})` : '';
  return `火山引擎识别错误 ${code}:${base}${tail}`;
}

// ============================================================================
// 会话
// ============================================================================

export interface VolcengineAsrError extends Error {
  code?: string;
}

export interface VolcengineAsrOptions {
  /** 来自 config.json 的 stt.volcengine(apiKey 优先,否则 appId+accessToken)。 */
  credentials: VolcengineSttConfig;
  /** 覆盖 WS 基地址,仅测试/自架调试用;默认官方 openspeech.bytedance.com。 */
  wsUrl?: string;
  /** 设备/应用标识,仅用于服务端日志过滤。 */
  uid?: string;
  connectTimeoutMs?: number;
  /** finish() 后等待末包结果的上限;超时用最后一次 partial 兜底。 */
  finishTimeoutMs?: number;
  /** 会话内持续无音频多久后静默断开(不计费,仅释放并发位)。 */
  idleTimeoutMs?: number;
  onPartial?: (text: string) => void;
  /** meta.voiceprint 仅在门禁启用且拿到稳定判定时携带(matched/rejected);unknown 不传。 */
  onFinal?: (text: string, meta?: { voiceprint?: VoiceprintSignal }) => void;
  onError?: (err: VolcengineAsrError) => void;
  onLog?: (line: string) => void;
}

function makeError(message: string, code?: string): VolcengineAsrError {
  const err = new Error(message) as VolcengineAsrError;
  if (code) err.code = code;
  return err;
}

function extractResultText(payload: unknown): string {
  const result = (payload as { result?: { text?: unknown } } | null)?.result;
  return typeof result?.text === 'string' ? result.text : '';
}

export class VolcengineAsrSession {
  private readonly opts: VolcengineAsrOptions;
  private ws: WebSocket | null = null;
  private seq = 1;
  private lastText = '';
  private connecting = false;
  private started = false;
  private finishing = false;
  private done = false;
  private closed = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private finishTimer: NodeJS.Timeout | null = null;
  private logId = '';
  /** 声纹门禁追踪器;未启用/端点不支持 = null(零行为变化)。 */
  private voiceprintTracker: VoiceprintTracker | null = null;

  constructor(opts: VolcengineAsrOptions) {
    this.opts = opts;
  }

  get lastPartial(): string {
    return this.lastText;
  }

  get isDone(): boolean {
    return this.done;
  }

  /** 懒连接:首帧音频时调用;幂等。 */
  ensureStarted(): void {
    if (this.started || this.connecting || this.closed || this.done) return;
    this.connecting = true;
    const url = this.opts.wsUrl || `${VOLC_WS_BASE}${this.opts.credentials.endpoint}`;
    const connectId = randomUUID();
    const headers: Record<string, string> = {
      'X-Api-Connect-Id': connectId,
    };
    // 资源 ID 留空 = 不发送该头(平台预置模型不需要);发送错版本会 403 resource not granted
    if (this.opts.credentials.resourceId) {
      headers['X-Api-Resource-Id'] = this.opts.credentials.resourceId;
    }
    if (this.opts.credentials.apiKey) {
      headers['X-Api-Key'] = this.opts.credentials.apiKey;
    } else {
      headers['X-Api-App-Key'] = this.opts.credentials.appId;
      headers['X-Api-Access-Key'] = this.opts.credentials.accessToken;
    }

    const connectTimeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const ws = new WebSocket(url, { headers, handshakeTimeout: connectTimeoutMs });
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      if (!this.started && !this.done) {
        this.fail(makeError(`连接火山引擎超时(${connectTimeoutMs}ms)`, 'connect_timeout'));
      }
    }, connectTimeoutMs + 500);
    this.connectTimer.unref?.();

    ws.on('upgrade', (res) => {
      const logid = res.headers['x-tt-logid'];
      if (typeof logid === 'string' && logid) this.logId = logid;
      this.opts.onLog?.(`已连接 ${url} (logid=${this.logId || '-'})`);
    });

    ws.on('open', () => {
      if (this.closed || this.done) {
        ws.close();
        return;
      }
      this.clearTimer('connect');
      this.connecting = false;
      this.started = true;
      this.opts.onLog?.(`会话建立,开始发送音频 (logid=${this.logId || '-'})`);
      this.sendFullRequestAndFlush();
      this.resetIdleTimer();
    });

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8').slice(0, 200);
        // resource not granted = 资源 ID 与账号开通的版本不一致(凭据本身有效)
        const notGranted = /resource not granted/i.test(body);
        const hint =
          status === 403 && notGranted
            ? '资源 ID 与账号已开通的版本不一致:小时版 = volc.bigasr.sauc.duration,并发版 = volc.bigasr.sauc.concurrent;也可留空(平台预置模型不发送该头)。请在火山控制台确认「流式语音识别大模型」开通的版本'
            : status === 401 || status === 403
              ? '凭据无效或未开通「大模型流式语音识别」服务'
              : '请检查网络与端点到控制台配置';
        this.fail(makeError(`火山引擎握手失败(HTTP ${status}):${hint}${body ? ` ${body}` : ''}`, 'handshake_failed'));
      });
    });

    ws.on('message', (data) => {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.handleFrame(frame);
    });

    ws.on('error', (err) => {
      if (this.done || this.closed) return;
      this.fail(makeError(`火山引擎连接错误:${err.message}`, 'ws_error'));
    });

    ws.on('close', (code) => {
      this.clearTimer('connect');
      this.clearTimer('finish');
      if (this.done || this.closed) return;
      // 未收到末包就断开:有 partial 则视为降级终稿,否则报错
      if (this.lastText) {
        this.emitFinal(this.lastText);
      } else {
        this.fail(makeError(`火山引擎连接中断(code=${code})`, 'ws_closed'));
      }
    });
  }

  /** 发送一段 PCM16LE/16k/mono 音频;连接未就绪时进有界队列。 */
  sendAudio(chunk: Buffer): void {
    if (this.closed || this.done || this.finishing) return;
    if (chunk.length === 0) return;
    this.ensureStarted();
    this.resetIdleTimer();

    for (let offset = 0; offset < chunk.length; offset += MAX_AUDIO_PACKET_BYTES) {
      const piece = chunk.subarray(offset, Math.min(offset + MAX_AUDIO_PACKET_BYTES, chunk.length));
      if (this.started && this.ws?.readyState === WebSocket.OPEN) {
        this.sendAudioFrame(piece, false);
      } else {
        this.pending.push(piece);
        this.pendingBytes += piece.length;
        // 有界:最多攒 30s 音频,超了丢最旧的(连接基本不可能拖这么久)
        while (this.pendingBytes > 30 * 32_000 && this.pending.length > 1) {
          this.pendingBytes -= this.pending.shift()!.length;
        }
      }
    }
  }

  /** 客户端 VAD 判停:发负序号空末包,等服务端末包结果。 */
  finish(): void {
    if (this.closed || this.done || this.finishing) return;
    this.finishing = true;
    this.clearTimer('idle');

    if (!this.started && !this.connecting) {
      // 从未发过音频:直接给出空结果,避免为一段空气去建连
      this.emitFinal('');
      return;
    }

    if (this.started && this.ws?.readyState === WebSocket.OPEN) {
      this.sendLastFrame();
    }
    // 否则等 open 回调里的 sendFullRequestAndFlush 收尾时补发

    const timeoutMs = this.opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS;
    this.finishTimer = setTimeout(() => {
      if (this.done) return;
      if (this.lastText) {
        this.opts.onLog?.(`末包等待超时(${timeoutMs}ms),用最后一次部分结果兜底`);
        this.emitFinal(this.lastText);
      } else {
        this.fail(makeError(`等待识别结果超时(${timeoutMs}ms)`, 'finish_timeout'));
      }
    }, timeoutMs);
    this.finishTimer.unref?.();
  }

  /** 中止会话(不产出终稿),用于客户端断开或切段。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer('connect');
    this.clearTimer('finish');
    this.clearTimer('idle');
    this.pending = [];
    this.pendingBytes = 0;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  // --------------------------------------------------------------------------

  private sendFullRequestAndFlush(): void {
    // 热词(官方 request.corpus 内联,优先于控制台词表):「热词」面板/管家写
    // hotwords.local.json,每段话建会话时现读 —— 一段话 = 一个新会话,改词下一句生效。
    const hotwords = pickAsrCorpus();
    // 声纹门禁(SSD 短音频声纹,「只认主人」):与热词同款 —— 每段话建会话现读配置,
    // 未启用 = 请求零变化;启用但端点不支持 → 记一行日志后照常识别。
    const voiceprintCfg = readVoiceprintConfig();
    const voiceprint = buildVoiceprintRequestFields(voiceprintCfg, this.opts.credentials.endpoint);
    this.voiceprintTracker =
      voiceprint.active && voiceprintCfg ? createVoiceprintTracker(voiceprintCfg) : null;
    const payload = {
      user: { uid: this.opts.uid || 'tide-commander' },
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
        result_type: 'full',
        ...(hotwords ? { corpus: { context: hotwords.context } } : {}),
        ...voiceprint.fields,
      },
    };
    if (hotwords) this.opts.onLog?.(`注入热词 ${hotwords.count} 个`);
    if (voiceprint.reason) this.opts.onLog?.(`声纹门禁未生效:${voiceprint.reason}`);
    else if (voiceprint.active) this.opts.onLog?.('声纹门禁已启用(ssd_mode=2,仅放行已注册声纹)');
    this.sendFrame(buildFullClientRequest(this.seq, payload));
    this.seq += 1;

    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const piece of queued) {
      if (this.done || this.ws?.readyState !== WebSocket.OPEN) break;
      this.sendAudioFrame(piece, false);
    }

    if (this.finishing && !this.done) {
      this.sendLastFrame();
    }
  }

  private sendAudioFrame(piece: Buffer, isLast: boolean): void {
    const seq = this.seq;
    this.seq += 1;
    this.sendFrame(buildAudioOnlyRequest(seq, piece, isLast));
  }

  private sendLastFrame(): void {
    // 末包:负序号 + 空 payload(音频已全部发完)
    this.sendFrame(buildAudioOnlyRequest(this.seq, Buffer.alloc(0), true));
  }

  private sendFrame(frame: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(frame, (err) => {
      if (err && !this.done && !this.closed) {
        this.fail(makeError(`发送音频失败:${err.message}`, 'send_failed'));
      }
    });
  }

  private handleFrame(frame: Buffer): void {
    if (this.done || this.closed) return;
    let parsed: ParsedServerFrame;
    try {
      parsed = parseServerFrame(frame);
    } catch (err) {
      this.opts.onLog?.(`帧解析失败:${(err as Error).message}`);
      return;
    }

    if (parsed.messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
      this.fail(makeError(describeVolcError(parsed.errorCode ?? -1, parsed.errorMessage), 'volc_error'));
      return;
    }

    if (parsed.messageType !== MSG_TYPE.SERVER_FULL_RESPONSE) return;

    this.voiceprintTracker?.notePayload(parsed.payload);
    const text = extractResultText(parsed.payload);
    if (text && text !== this.lastText) {
      this.lastText = text;
      this.opts.onPartial?.(text);
    }

    if (parsed.isLast) {
      this.emitFinal(this.lastText || text);
    }
  }

  private resetIdleTimer(): void {
    this.clearTimer('idle');
    if (this.finishing || this.done || this.closed) return;
    const idleMs = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => {
      if (this.done || this.closed || this.finishing) return;
      this.opts.onLog?.(`会话空闲 ${idleMs}ms,静默断开`);
      this.close();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private clearTimer(which: 'connect' | 'finish' | 'idle'): void {
    const timer = which === 'connect' ? this.connectTimer : which === 'finish' ? this.finishTimer : this.idleTimer;
    if (timer) clearTimeout(timer);
    if (which === 'connect') this.connectTimer = null;
    else if (which === 'finish') this.finishTimer = null;
    else this.idleTimer = null;
  }

  private emitFinal(text: string): void {
    if (this.done || this.closed) return;
    this.done = true;
    this.clearTimer('connect');
    this.clearTimer('finish');
    this.clearTimer('idle');
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    const tracker = this.voiceprintTracker;
    const verdict = tracker?.verdict();
    if (tracker && verdict) {
      // 观测行(spike 实锤用):判定 + 收集到的 speaker_id + definite 分句数
      this.opts.onLog?.(
        `声纹判定 ${verdict} (speaker_id=[${tracker.speakerIds().join(',')}] definite=${tracker.definiteCount()})`,
      );
    }
    this.opts.onFinal?.(text, verdict && verdict !== 'unknown' ? { voiceprint: verdict } : undefined);
  }

  private fail(err: VolcengineAsrError): void {
    if (this.done || this.closed) return;
    this.done = true;
    this.clearTimer('connect');
    this.clearTimer('finish');
    this.clearTimer('idle');
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.opts.onError?.(err);
  }
}
