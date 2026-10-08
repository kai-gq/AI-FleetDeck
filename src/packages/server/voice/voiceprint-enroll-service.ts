/**
 * 声纹门禁 · 注册/开关/删除(页面版;CLI 版在 tools/voiceprint/*.mjs)
 *
 * 供 工具箱 → 语音伙伴 →「声纹门禁」面板使用:
 *   - getVoiceprintStatus()     本地配置 + 端点/凭据支持性(绝不外传 apiKey)
 *   - setVoiceprintEnabled()    只改本地 enabled(下一段语音起生效)
 *   - enrollVoiceprint()        浏览器录的 16k WAV → 临时文件床 → 火山声纹注册接口 → 落盘
 *   - deleteVoiceprint()        云端软删(尽力)+ 本地配置清除(无论云端成败)
 *
 * 协议细节全部移植自 enroll.mjs / status.mjs(已实锤可用),差异:
 *   - 音频由浏览器直接产出 16k 单声道 WAV(不经 ffmpeg);
 *   - 上传失败不退出,按错误码抛给路由层映射 HTTP 状态。
 * 隐私:绝不打印 apiKey;日志只落采样 URL 与摘要。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Blob } from 'node:buffer';
import {
  resolveVoiceprintPath,
  sanitizeVoiceprintConfig,
  type VoiceprintConfig,
} from './voiceprint-gate.js';
import { loadVolcengineSttConfig } from '../services/voice-companion-service.js';
import { logger } from '../utils/index.js';

const log = logger.server;

const INVOKE_BASE = 'https://openspeech.bytedance.com/api/proxy/invoke';
/** 官方规格 5~30s;CLI 硬校验 4.5s 下限,页面同口径。 */
export const MIN_AUDIO_SECONDS = 4.5;
export const MAX_AUDIO_SECONDS = 60;
/** base64 字符上限(约 3MB 音频;60s 上限本身只需 ~2.6M 字符)。 */
export const MAX_BASE64_CHARS = 4 * 1024 * 1024;
const NAME_MAX_CHARS = 40;
const BYTES_PER_SECOND = 16_000 * 2; // 16kHz / 16bit / 单声道

// ---------------------------------------------------------------------------
// 错误(路由层按 code 映射 HTTP 状态)
// ---------------------------------------------------------------------------

export type VoiceprintEnrollErrorCode =
  | 'AUDIO_REQUIRED'
  | 'AUDIO_TOO_LARGE'
  | 'AUDIO_INVALID'
  | 'NOT_CONFIGURED'
  | 'NOT_REGISTERED'
  | 'UPLOAD_FAILED'
  | 'REGISTER_FAILED';

export class VoiceprintEnrollError extends Error {
  constructor(
    public readonly code: VoiceprintEnrollErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceprintEnrollError';
  }
}

// ---------------------------------------------------------------------------
// 本地配置读写(gate 的文件;读原始 JSON 以保留 createdAt/ssdVersion 等字段)
// ---------------------------------------------------------------------------

interface RawReadResult {
  raw: Record<string, unknown> | null;
  corrupt: boolean;
  exists: boolean;
}

function readRawConfig(env: NodeJS.ProcessEnv = process.env): RawReadResult {
  const target = resolveVoiceprintPath(env);
  let text: string;
  try {
    text = fs.readFileSync(target, 'utf-8');
  } catch {
    return { raw: null, corrupt: false, exists: false }; // 文件缺失 = 未注册
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw: null, corrupt: true, exists: true };
    }
    return { raw: parsed as Record<string, unknown>, corrupt: false, exists: true };
  } catch {
    return { raw: null, corrupt: true, exists: true };
  }
}

/** 原子写(tmp+rename;tmp 名带 pid 防并发互踩)。 */
function writeRawConfig(cfg: Record<string, unknown>): void {
  const target = resolveVoiceprintPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export interface VoiceprintStatus {
  /** 本地配置文件存在(含损坏)。 */
  exists: boolean;
  /** 文件存在但 JSON 不可用。 */
  corrupt: boolean;
  /** 注册过(spokeId 非空)——决定开关/删除是否可用。 */
  registered: boolean;
  /** 门禁实际生效中(enabled=true 且有 speakId)。 */
  enabled: boolean;
  speakId: string;
  speakerName: string;
  groupId?: string;
  createdAt?: string;
  ssdVersion?: string;
  /** 当前转写端点;声纹仅在 bigmodel_async 二遍链路上生效。 */
  endpoint: string;
  endpointSupported: boolean;
  /** 是否配置了新版 ApiKey(声纹管理接口必需;绝不外传 key 本身)。 */
  hasCredentials: boolean;
}

export function getVoiceprintStatus(env: NodeJS.ProcessEnv = process.env): VoiceprintStatus {
  const { raw, corrupt, exists } = readRawConfig(env);
  const clean: VoiceprintConfig | null = sanitizeVoiceprintConfig(raw);
  const stt = loadVolcengineSttConfig();
  const createdAt = typeof raw?.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : undefined;
  return {
    exists,
    corrupt,
    registered: !!clean?.speakId,
    enabled: clean?.enabled === true,
    speakId: clean?.speakId ?? '',
    speakerName: clean?.speakerName ?? '主人',
    ...(clean?.groupId ? { groupId: clean.groupId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(clean?.ssdVersion ? { ssdVersion: clean.ssdVersion } : {}),
    endpoint: stt.endpoint,
    endpointSupported: stt.endpoint === 'bigmodel_async',
    hasCredentials: !!stt.apiKey,
  };
}

// ---------------------------------------------------------------------------
// 开关(只改本地 enabled;识别链路每段话现读配置,立即生效)
// ---------------------------------------------------------------------------

export function setVoiceprintEnabled(enabled: boolean): VoiceprintStatus {
  const { raw, exists } = readRawConfig();
  if (enabled) {
    const speakId = typeof raw?.speakId === 'string' ? raw.speakId.trim() : '';
    if (!speakId) {
      throw new VoiceprintEnrollError(
        'NOT_REGISTERED',
        '还没注册声纹 —— 先录一段约 20 秒的声音完成注册,才能打开门禁',
      );
    }
  }
  if (!exists || !raw) {
    // 关闭一个本就不存在的门禁 = 幂等空操作(不凭空造文件);损坏文件不动(重注册覆盖修)
    return getVoiceprintStatus();
  }
  writeRawConfig({ ...raw, enabled });
  log.log(`[Voiceprint] 门禁已${enabled ? '打开' : '关闭'}(下一段语音起生效)`);
  return getVoiceprintStatus();
}

// ---------------------------------------------------------------------------
// WAV 校验(浏览器采集管线产物:16k / 单声道 / 16bit PCM)
// ---------------------------------------------------------------------------

export interface WavInfo {
  seconds: number;
}

export function parseWav16kMono(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new VoiceprintEnrollError('AUDIO_INVALID', '不是有效的 WAV 文件');
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataBytes = -1;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // 声明长度超过实际字节时按实际算(截断文件不炸)
      dataBytes = Math.max(0, Math.min(size, buf.length - body));
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new VoiceprintEnrollError('AUDIO_INVALID', 'WAV 缺少 fmt 块');
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16_000 || fmt.bits !== 16) {
    throw new VoiceprintEnrollError(
      'AUDIO_INVALID',
      `采样格式须为 16kHz/单声道/16bit PCM(当前 ${fmt.sampleRate}Hz / ${fmt.channels}声道 / ${fmt.bits}bit)`,
    );
  }
  if (dataBytes < 0) throw new VoiceprintEnrollError('AUDIO_INVALID', 'WAV 缺少 data 块');
  const seconds = dataBytes / BYTES_PER_SECOND;
  if (seconds < MIN_AUDIO_SECONDS) {
    throw new VoiceprintEnrollError(
      'AUDIO_INVALID',
      `录音太短(${seconds.toFixed(1)} 秒):至少要说满 ${MIN_AUDIO_SECONDS} 秒`,
    );
  }
  if (seconds > MAX_AUDIO_SECONDS) {
    throw new VoiceprintEnrollError(
      'AUDIO_INVALID',
      `录音太长(${Math.round(seconds)} 秒):请控制在 ${MAX_AUDIO_SECONDS} 秒以内`,
    );
  }
  return { seconds };
}

// ---------------------------------------------------------------------------
// 火山 openspeech 声纹管理接口(TOP invoke;移植自 enroll.mjs/status.mjs)
// ---------------------------------------------------------------------------

interface InvokeResponse {
  httpStatus: number;
  json: Record<string, unknown> | null;
  text: string;
}

async function invoke(apiKey: string, action: string, body: Record<string, unknown>): Promise<InvokeResponse> {
  const res = await fetch(`${INVOKE_BASE}?Action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    /* 保留原文 */
  }
  return { httpStatus: res.status, json, text };
}

function topError(json: Record<string, unknown> | null): string {
  const err = (json?.ResponseMetadata as { Error?: { Code?: unknown; Message?: unknown } } | undefined)?.Error;
  if (err && err.Code !== undefined && String(err.Code) !== '0') return `${err.Code}:${err.Message ?? ''}`;
  return '';
}

function extractString(json: Record<string, unknown> | null, keys: string[]): string {
  const result = json?.Result as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object') return '';
  for (const k of keys) {
    const v = result[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Result.Code 校验:缺省 = 成功;非 '1000' = 业务失败(176 不存在 / 177 提取失败 / 179 超上限)。 */
function resultCodeError(json: Record<string, unknown> | null): string {
  const code = (json?.Result as Record<string, unknown> | undefined)?.Code;
  if (code !== undefined && String(code) !== '1000') return String(code);
  return '';
}

// ---------------------------------------------------------------------------
// 上传:临时文件床兜底(公网可下载 URL;注册接口要求服务端自己去拉)
// ---------------------------------------------------------------------------

async function uploadLitterbox(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '1h');
  form.append('fileToUpload', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), filename);
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`litterbox HTTP ${res.status}:${text.slice(0, 120)}`);
  return text;
}

async function uploadUguu(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('files[]', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), filename);
  const res = await fetch('https://uguu.se/upload?output=text', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`uguu.se HTTP ${res.status}:${text.slice(0, 120)}`);
  return text;
}

async function upload0x0(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), filename);
  const res = await fetch('https://0x0.st', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`0x0.st HTTP ${res.status}:${text.slice(0, 120)}`);
  return text;
}

const UPLOAD_HOSTS: Array<{ label: string; upload: (buf: Buffer, filename: string) => Promise<string> }> = [
  { label: 'litterbox(1h 后自动删)', upload: uploadLitterbox },
  { label: 'uguu.se', upload: uploadUguu },
  { label: '0x0.st', upload: upload0x0 },
];

async function uploadSample(buf: Buffer): Promise<string> {
  const filename = `voiceprint-${Date.now()}.wav`;
  const errors: string[] = [];
  for (const host of UPLOAD_HOSTS) {
    try {
      const url = await host.upload(buf, filename);
      // 日志只落 URL,绝不落音频字节
      log.log(`[Voiceprint] 采样已上传(${host.label}):${url}`);
      return url;
    } catch (err) {
      errors.push(`${host.label}: ${(err as Error)?.message ?? String(err)}`);
    }
  }
  throw new VoiceprintEnrollError(
    'UPLOAD_FAILED',
    `所有临时文件床都上传失败(${errors.join('; ')})—— 稍后重试,或改用 CLI 自备公网 URL(node tools/voiceprint/enroll.mjs --file … --url …)`,
  );
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export interface VoiceprintEnrollResult {
  speakId: string;
  speakerName: string;
  status: VoiceprintStatus;
}

export async function enrollVoiceprint(input: {
  audioBase64: string;
  speakerName?: string;
}): Promise<VoiceprintEnrollResult> {
  const b64 = (input.audioBase64 ?? '').trim();
  if (!b64) throw new VoiceprintEnrollError('AUDIO_REQUIRED', '缺少录音数据');
  if (b64.length > MAX_BASE64_CHARS) {
    throw new VoiceprintEnrollError('AUDIO_TOO_LARGE', `录音数据过大(>${Math.round(MAX_BASE64_CHARS / 1024 / 1024)}M 字符)`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new VoiceprintEnrollError('AUDIO_INVALID', '录音数据为空');
  const { seconds } = parseWav16kMono(buf);

  const stt = loadVolcengineSttConfig();
  if (!stt.apiKey) {
    throw new VoiceprintEnrollError(
      'NOT_CONFIGURED',
      '声纹管理接口需要新版 ApiKey(旧版 appId/accessToken 不支持)—— 请先在本节上方把火山凭据配好',
    );
  }

  const speakerName = (input.speakerName ?? '').trim().slice(0, NAME_MAX_CHARS) || '主人';
  const { raw: oldRaw } = readRawConfig();
  const oldSpeakId = typeof oldRaw?.speakId === 'string' ? oldRaw.speakId.trim() : '';
  const oldGroupId = typeof oldRaw?.groupId === 'string' && oldRaw.groupId.trim() ? oldRaw.groupId.trim() : '';

  const audioUrl = await uploadSample(buf);

  // UpdateVoiceprint(Action=0):注册新声纹
  const body: Record<string, unknown> = { Action: 0, AudioUrl: audioUrl, SpeakerName: speakerName };
  if (oldGroupId) body.GroupId = oldGroupId;
  const r = await invoke(stt.apiKey, 'UpdateVoiceprint', body);
  if (!r.json) {
    throw new VoiceprintEnrollError('REGISTER_FAILED', `注册响应不是 JSON(HTTP ${r.httpStatus})`);
  }
  const topErr = topError(r.json);
  if (topErr) throw new VoiceprintEnrollError('REGISTER_FAILED', `注册被拒:${topErr}`);
  const bizErr = resultCodeError(r.json);
  if (bizErr) {
    throw new VoiceprintEnrollError(
      'REGISTER_FAILED',
      `注册失败:Result.Code=${bizErr}(176=不存在 / 177=提取失败 / 179=超上限)`,
    );
  }
  let speakId = extractString(r.json, ['SpeakId', 'speakId', 'SpeakID', 'speak_id']);
  if (!speakId) {
    const list =
      ((r.json.Result as Record<string, unknown> | undefined)?.SpeakIdList ??
        (r.json.Result as Record<string, unknown> | undefined)?.speakIdList) as unknown;
    if (Array.isArray(list) && list.length > 0) {
      const first = list[0];
      if (typeof first === 'string') speakId = first;
      else {
        const v = (first as { SpeakId?: unknown; speakId?: unknown; id?: unknown })?.SpeakId ??
          (first as { speakId?: unknown })?.speakId ??
          (first as { id?: unknown })?.id;
        if (typeof v === 'string') speakId = v;
      }
    }
  }
  if (!speakId) {
    throw new VoiceprintEnrollError(
      'REGISTER_FAILED',
      '注册响应里没找到 SpeakId(可能实际已注册成功,请用状态核对后再决定,勿重复提交)',
    );
  }

  // 落盘:保留旧配置其余字段(ssdVersion/groupId 等),enabled 置 true
  writeRawConfig({
    ...(oldRaw ?? {}),
    enabled: true,
    speakId,
    speakerName,
    createdAt: new Date().toISOString(),
  });
  log.log(`[Voiceprint] 注册成功:SpeakId=${speakId} 名称=${speakerName} 采样=${seconds.toFixed(1)}s`);

  // 旧声纹换新(best-effort 软删旧条目,防 179 超上限;失败仅告警)
  if (oldSpeakId && oldSpeakId !== speakId) {
    try {
      const del = await invoke(stt.apiKey, 'UpdateVoiceprint', { Action: 2, SpeakId: oldSpeakId });
      const delErr = topError(del.json) || resultCodeError(del.json) || (!del.json ? `HTTP ${del.httpStatus}` : '');
      if (delErr) log.warn(`[Voiceprint] 旧声纹(${oldSpeakId})云端软删失败(不影响新注册):${delErr}`);
      else log.log(`[Voiceprint] 旧声纹已云端软删:${oldSpeakId}`);
    } catch (err) {
      log.warn(`[Voiceprint] 旧声纹云端软删异常(忽略):${(err as Error)?.message}`);
    }
  }

  return { speakId, speakerName, status: getVoiceprintStatus() };
}

// ---------------------------------------------------------------------------
// 删除(云端尽力 + 本地必清)
// ---------------------------------------------------------------------------

export interface VoiceprintDeleteResult {
  cloudDeleted: boolean;
  cloudError: string | null;
  status: VoiceprintStatus;
}

export async function deleteVoiceprint(): Promise<VoiceprintDeleteResult> {
  const { raw } = readRawConfig();
  const speakId = typeof raw?.speakId === 'string' ? raw.speakId.trim() : '';
  const apiKey = loadVolcengineSttConfig().apiKey;

  let cloudDeleted = false;
  let cloudError: string | null = null;
  if (speakId && apiKey) {
    try {
      const r = await invoke(apiKey, 'UpdateVoiceprint', { Action: 2, SpeakId: speakId });
      const err = !r.json ? `HTTP ${r.httpStatus}(非 JSON 响应)` : topError(r.json) || resultCodeError(r.json);
      if (err) cloudError = err;
      else cloudDeleted = true;
    } catch (err) {
      cloudError = (err as Error)?.message ?? String(err);
    }
  } else if (speakId) {
    cloudError = '未配置 ApiKey,云端条目未删除';
  }

  // 无论云端成败都清本地:门禁立即失效,重录可再注册
  fs.rmSync(resolveVoiceprintPath(), { force: true });
  if (cloudDeleted) log.log('[Voiceprint] 已删除声纹(云端软删 + 本地配置清除)');
  else log.warn(`[Voiceprint] 本地配置已清除;云端删除未完成:${cloudError ?? '(无 SpeakId,跳过)'}`);

  return { cloudDeleted, cloudError, status: getVoiceprintStatus() };
}
