/**
 * 声纹注册服务(页面版)单测
 *
 * 全部网络调用经 fetch 打桩(上传文件床 + 火山 invoke);本地配置写进
 * TC_VOICE_VOICEPRINT_SOURCE 指向的 mkdtemp 沙箱,绝不碰真实
 * tools/voice-companion/voiceprint.local.json。
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  loadVolcengineSttConfig: vi.fn(),
}));

vi.mock('../services/voice-companion-service.js', () => ({
  loadVolcengineSttConfig: h.loadVolcengineSttConfig,
}));

// 日志静音(服务里 logger.server.log/warn)
vi.mock('../utils/index.js', () => ({
  logger: { server: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  getVoiceprintStatus,
  setVoiceprintEnabled,
  enrollVoiceprint,
  deleteVoiceprint,
  parseWav16kMono,
  VoiceprintEnrollError,
} from './voiceprint-enroll-service.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceprint-enroll-'));
const configPath = path.join(sandbox, 'voiceprint.local.json');

// ---------------------------------------------------------------------------
// 打桩:fetch / 配置
// ---------------------------------------------------------------------------

interface StubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function jsonResponse(obj: unknown, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}

function textResponse(text: string, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

let fetchImpl: (url: string, init?: RequestInit) => Promise<StubResponse>;

const fetchMock = vi.fn((url: string, init?: RequestInit) => fetchImpl(url, init));

interface FetchCall {
  url: string;
  body: Record<string, unknown> | null;
}

function calls(): FetchCall[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    let body: Record<string, unknown> | null = null;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    return { url: url as string, body };
  });
}

function invokeCalls(): FetchCall[] {
  return calls().filter((c) => c.url.includes('openspeech'));
}

/** 默认:litterbox 上传成功 + 声纹注册成功(返回 sp-new)。 */
function defaultFetchImpl(): void {
  fetchImpl = async (url) => {
    if (url.includes('litterbox')) return textResponse('https://litter.catbox.moe/abc123.wav');
    if (url.includes('openspeech')) {
      return jsonResponse({
        ResponseMetadata: { Error: { Code: 0, Message: '' } },
        Result: { Code: '1000', SpeakId: 'sp-new' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  defaultFetchImpl();
  process.env.TC_VOICE_VOICEPRINT_SOURCE = configPath;
  fs.rmSync(configPath, { force: true });
  h.loadVolcengineSttConfig.mockReturnValue({
    apiKey: 'test-key',
    appId: '',
    accessToken: '',
    resourceId: '',
    endpoint: 'bigmodel_async',
  });
});

afterAll(() => {
  delete process.env.TC_VOICE_VOICEPRINT_SOURCE;
  fs.rmSync(sandbox, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 工具:构造 WAV
// ---------------------------------------------------------------------------

function makeWav(
  seconds: number,
  o: { channels?: number; sampleRate?: number; bits?: number; declaredDataBytes?: number } = {},
): Buffer {
  const channels = o.channels ?? 1;
  const sampleRate = o.sampleRate ?? 16_000;
  const bits = o.bits ?? 16;
  const dataBytes = Math.round((seconds * sampleRate * channels * bits) / 8);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(o.declaredDataBytes ?? dataBytes, 40);
  return buf;
}

function b64(buf: Buffer): string {
  return buf.toString('base64');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

function expectEnrollError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VoiceprintEnrollError);
    expect((err as VoiceprintEnrollError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

async function expectAsyncEnrollError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(VoiceprintEnrollError);
    expect((err as VoiceprintEnrollError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

// ---------------------------------------------------------------------------
// WAV 校验
// ---------------------------------------------------------------------------

describe('parseWav16kMono', () => {
  it('合法 20 秒 → seconds 约 20', () => {
    expect(parseWav16kMono(makeWav(20)).seconds).toBeCloseTo(20, 5);
  });

  it('太短(3s)→ AUDIO_INVALID', () => {
    expectEnrollError(() => parseWav16kMono(makeWav(3)), 'AUDIO_INVALID');
  });

  it('太长(>60s)→ AUDIO_INVALID', () => {
    expectEnrollError(() => parseWav16kMono(makeWav(61)), 'AUDIO_INVALID');
  });

  it('立体声 → AUDIO_INVALID(格式不符)', () => {
    expectEnrollError(() => parseWav16kMono(makeWav(10, { channels: 2 })), 'AUDIO_INVALID');
  });

  it('不是 WAV → AUDIO_INVALID', () => {
    expectEnrollError(() => parseWav16kMono(Buffer.from('这不是 wav')), 'AUDIO_INVALID');
  });

  it('头声明 20s 但数据截断到 2s → 按实际算 → 太短', () => {
    const truncated = makeWav(20, { declaredDataBytes: 20 * 32_000 }).subarray(0, 44 + 2 * 32_000);
    expectEnrollError(() => parseWav16kMono(Buffer.from(truncated)), 'AUDIO_INVALID');
  });
});

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

describe('getVoiceprintStatus', () => {
  it('无文件:registered=false,凭据/端点支持性透出且不含 apiKey', () => {
    const s = getVoiceprintStatus();
    expect(s).toMatchObject({
      exists: false,
      corrupt: false,
      registered: false,
      enabled: false,
      speakerName: '主人',
      endpoint: 'bigmodel_async',
      endpointSupported: true,
      hasCredentials: true,
    });
    expect('apiKey' in s).toBe(false);
  });

  it('文件损坏:corrupt=true 且按未注册处理', () => {
    fs.writeFileSync(configPath, '{ 坏掉的 json');
    const s = getVoiceprintStatus();
    expect(s.corrupt).toBe(true);
    expect(s.registered).toBe(false);
  });

  it('已注册:registered/enabled/speakId/createdAt 齐', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ enabled: true, speakId: 'sp-1', speakerName: '主人', createdAt: '2026-10-08T00:00:00.000Z' }),
    );
    const s = getVoiceprintStatus();
    expect(s).toMatchObject({ exists: true, registered: true, enabled: true, speakId: 'sp-1', createdAt: '2026-10-08T00:00:00.000Z' });
  });

  it('enabled 但无 speakId → 未生效(registered=false, enabled=false)', () => {
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, speakerName: '主人' }));
    const s = getVoiceprintStatus();
    expect(s.registered).toBe(false);
    expect(s.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 开关
// ---------------------------------------------------------------------------

describe('setVoiceprintEnabled', () => {
  it('未注册要打开 → NOT_REGISTERED(不落文件)', () => {
    expectEnrollError(() => setVoiceprintEnabled(true), 'NOT_REGISTERED');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('翻转保留其余字段,原子写无 .tmp 残留', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ enabled: true, speakId: 'sp-1', speakerName: '主人', ssdVersion: '200' }),
    );
    const s = setVoiceprintEnabled(false);
    expect(s.enabled).toBe(false);
    expect(s.registered).toBe(true);
    expect(readConfig()).toMatchObject({ enabled: false, speakId: 'sp-1', ssdVersion: '200' });
    expect(fs.readdirSync(sandbox)).toEqual(['voiceprint.local.json']);
  });

  it('关闭一个不存在的门禁 = 幂等空操作(不凭空造文件)', () => {
    const s = setVoiceprintEnabled(false);
    expect(s.enabled).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

describe('enrollVoiceprint', () => {
  it('成功:上传 → 注册 → 落盘(enabled/speakId/名称);返回状态不含 apiKey', async () => {
    const r = await enrollVoiceprint({ audioBase64: b64(makeWav(20)), speakerName: '主人' });
    expect(r.speakId).toBe('sp-new');
    expect(r.status).toMatchObject({ registered: true, enabled: true, speakId: 'sp-new' });
    expect('apiKey' in r.status).toBe(false);
    const saved = readConfig();
    expect(saved).toMatchObject({ enabled: true, speakId: 'sp-new', speakerName: '主人' });
    expect(typeof saved.createdAt).toBe('string');
    expect(fs.readdirSync(sandbox)).toEqual(['voiceprint.local.json']);

    const reg = invokeCalls()[0]!;
    expect(reg.url).toContain('Action=UpdateVoiceprint');
    expect(reg.body).toEqual({ Action: 0, AudioUrl: 'https://litter.catbox.moe/abc123.wav', SpeakerName: '主人' });
  });

  it('重注册保留旧配置其余字段(ssdVersion),并软删旧 SpeakId', async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ enabled: false, speakId: 'sp-old', speakerName: '旧名', ssdVersion: '200' }),
    );
    const r = await enrollVoiceprint({ audioBase64: b64(makeWav(20)) });
    expect(r.speakId).toBe('sp-new');
    expect(readConfig()).toMatchObject({ enabled: true, speakId: 'sp-new', ssdVersion: '200' });

    const invoke = invokeCalls();
    expect(invoke).toHaveLength(2);
    expect(invoke[1]!.body).toEqual({ Action: 2, SpeakId: 'sp-old' });
  });

  it('缺 ApiKey → NOT_CONFIGURED,不上传不注册', async () => {
    h.loadVolcengineSttConfig.mockReturnValue({ apiKey: '', appId: 'a', accessToken: 't', resourceId: '', endpoint: 'bigmodel_async' });
    await expectAsyncEnrollError(enrollVoiceprint({ audioBase64: b64(makeWav(20)) }), 'NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('空音频 → AUDIO_REQUIRED;非 WAV → AUDIO_INVALID', async () => {
    await expectAsyncEnrollError(enrollVoiceprint({ audioBase64: '' }), 'AUDIO_REQUIRED');
    await expectAsyncEnrollError(
      enrollVoiceprint({ audioBase64: Buffer.from('随便的内容').toString('base64') }),
      'AUDIO_INVALID',
    );
  });

  it('Result.Code=177 → REGISTER_FAILED(不落盘)', async () => {
    fetchImpl = async (url) => {
      if (url.includes('litterbox')) return textResponse('https://litter.catbox.moe/x.wav');
      return jsonResponse({ ResponseMetadata: { Error: { Code: 0 } }, Result: { Code: 177, Message: '提取失败' } });
    };
    await expectAsyncEnrollError(enrollVoiceprint({ audioBase64: b64(makeWav(20)) }), 'REGISTER_FAILED');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('litterbox 失败 → uguu 兜底成功', async () => {
    fetchImpl = async (url) => {
      if (url.includes('litterbox')) return textResponse('server exploded', 500);
      if (url.includes('uguu')) return textResponse('https://uguu.se/xyz.wav');
      return jsonResponse({ ResponseMetadata: { Error: { Code: 0 } }, Result: { Code: '1000', SpeakId: 'sp-u' } });
    };
    const r = await enrollVoiceprint({ audioBase64: b64(makeWav(20)) });
    expect(r.speakId).toBe('sp-u');
    const reg = invokeCalls()[0]!;
    expect(reg.body).toMatchObject({ AudioUrl: 'https://uguu.se/xyz.wav' });
  });

  it('三个文件床全失败 → UPLOAD_FAILED,不进注册', async () => {
    fetchImpl = async () => textResponse('nope', 500);
    await expectAsyncEnrollError(enrollVoiceprint({ audioBase64: b64(makeWav(20)) }), 'UPLOAD_FAILED');
    expect(invokeCalls()).toHaveLength(0);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

describe('deleteVoiceprint', () => {
  it('云端成功 → cloudDeleted=true,本地文件清除', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, speakId: 'sp-1', speakerName: '主人' }));
    const r = await deleteVoiceprint();
    expect(r.cloudDeleted).toBe(true);
    expect(r.cloudError).toBeNull();
    expect(fs.existsSync(configPath)).toBe(false);
    expect(r.status.registered).toBe(false);

    const call = invokeCalls()[0]!;
    expect(call.body).toEqual({ Action: 2, SpeakId: 'sp-1' });
  });

  it('云端失败 → 本地仍然清除(cloudError 有值)', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, speakId: 'sp-1', speakerName: '主人' }));
    fetchImpl = async () => jsonResponse({ ResponseMetadata: { Error: { Code: '1001', Message: '签名错误' } } });
    const r = await deleteVoiceprint();
    expect(r.cloudDeleted).toBe(false);
    expect(r.cloudError).toContain('1001');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('无凭据 → 跳过云端但本地照删', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, speakId: 'sp-1', speakerName: '主人' }));
    h.loadVolcengineSttConfig.mockReturnValue({ apiKey: '', appId: '', accessToken: '', resourceId: '', endpoint: 'bigmodel_async' });
    const r = await deleteVoiceprint();
    expect(r.cloudDeleted).toBe(false);
    expect(r.cloudError).toBeTruthy();
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
