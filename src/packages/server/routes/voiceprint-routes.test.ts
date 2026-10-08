/**
 * 声纹门禁路由层测试
 *
 * 照 voice-companion-routes.test.ts 的模式:整体替换服务模块(路由只做参数
 * 校验与错误映射),用真 express + 真 HTTP 请求验证状态码与错误码契约。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../voice/voiceprint-enroll-service.js', () => {
  class VoiceprintEnrollError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'VoiceprintEnrollError';
    }
  }
  return {
    VoiceprintEnrollError,
    getVoiceprintStatus: vi.fn(),
    setVoiceprintEnabled: vi.fn(),
    enrollVoiceprint: vi.fn(),
    deleteVoiceprint: vi.fn(),
    MAX_BASE64_CHARS: 4 * 1024 * 1024,
  };
});

vi.mock('../utils/index.js', () => ({
  logger: { server: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import * as svc from '../voice/voiceprint-enroll-service.js';
import type { VoiceprintStatus, VoiceprintEnrollErrorCode } from '../voice/voiceprint-enroll-service.js';
import voiceprintRoutes from './voiceprint.js';

let server: http.Server;
let baseUrl: string;

function fakeStatus(over: Partial<VoiceprintStatus> = {}): VoiceprintStatus {
  return {
    exists: false,
    corrupt: false,
    registered: false,
    enabled: false,
    speakId: '',
    speakerName: '主人',
    endpoint: 'bigmodel_async',
    endpointSupported: true,
    hasCredentials: true,
    ...over,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/voice-companion/voiceprint', voiceprintRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.resetAllMocks();
});

async function post(pathname: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/voice-companion/voiceprint${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('GET /status', () => {
  it('透传服务状态', async () => {
    const status = fakeStatus({ exists: true, registered: true, enabled: true, speakId: 'sp-1' });
    vi.mocked(svc.getVoiceprintStatus).mockReturnValue(status);

    const res = await fetch(`${baseUrl}/api/voice-companion/voiceprint/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status });
  });

  it('服务抛错 → 500 INTERNAL', async () => {
    vi.mocked(svc.getVoiceprintStatus).mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await fetch(`${baseUrl}/api/voice-companion/voiceprint/status`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('INTERNAL');
  });
});

describe('POST /toggle', () => {
  it('enabled 非布尔 → 400 ENABLED_INVALID,不触服务', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }]) {
      const { status, json } = await post('/toggle', body);
      expect(status).toBe(400);
      expect(json.code).toBe('ENABLED_INVALID');
    }
    expect(svc.setVoiceprintEnabled).not.toHaveBeenCalled();
  });

  it('未注册要开 → 400 NOT_REGISTERED(服务错误码透传)', async () => {
    vi.mocked(svc.setVoiceprintEnabled).mockImplementation(() => {
      throw new svc.VoiceprintEnrollError('NOT_REGISTERED', '还没注册声纹');
    });
    const { status, json } = await post('/toggle', { enabled: true });
    expect(status).toBe(400);
    expect(json).toEqual({ error: '还没注册声纹', code: 'NOT_REGISTERED' });
  });

  it('成功 → 200 + 新状态', async () => {
    const status = fakeStatus({ registered: true, enabled: true, speakId: 'sp-1' });
    vi.mocked(svc.setVoiceprintEnabled).mockReturnValue(status);
    const { status: code, json } = await post('/toggle', { enabled: true });
    expect(code).toBe(200);
    expect(json).toEqual({ success: true, status });
    expect(svc.setVoiceprintEnabled).toHaveBeenCalledWith(true);
  });
});

describe('POST /enroll', () => {
  it('缺音频/空串 → 400 AUDIO_REQUIRED,不触服务', async () => {
    for (const body of [{}, { audioBase64: '' }, { audioBase64: '   ' }, { audioBase64: 42 }]) {
      const { status, json } = await post('/enroll', body);
      expect(status).toBe(400);
      expect(json.code).toBe('AUDIO_REQUIRED');
    }
    expect(svc.enrollVoiceprint).not.toHaveBeenCalled();
  });

  it('超长 → 400 AUDIO_TOO_LARGE,不触服务(长度闸在路由层)', async () => {
    const { status, json } = await post('/enroll', { audioBase64: 'a'.repeat(4 * 1024 * 1024 + 1) });
    expect(status).toBe(400);
    expect(json.code).toBe('AUDIO_TOO_LARGE');
    expect(svc.enrollVoiceprint).not.toHaveBeenCalled();
  });

  it('成功 → 200 speakId + 状态;姓名透传(缺省 undefined)', async () => {
    const status = fakeStatus({ registered: true, enabled: true, speakId: 'sp-9' });
    vi.mocked(svc.enrollVoiceprint).mockResolvedValue({ speakId: 'sp-9', speakerName: '主人', status });

    const { status: code, json } = await post('/enroll', { audioBase64: 'AAAA', speakerName: ' 主人 ' });
    expect(code).toBe(200);
    expect(json).toEqual({ success: true, speakId: 'sp-9', status });
    expect(svc.enrollVoiceprint).toHaveBeenCalledWith({ audioBase64: 'AAAA', speakerName: ' 主人 ' });

    await post('/enroll', { audioBase64: 'AAAA' });
    expect(svc.enrollVoiceprint).toHaveBeenLastCalledWith({ audioBase64: 'AAAA', speakerName: undefined });
  });

  it('错误码映射:WAV 非法/无凭据 → 400;上传/注册失败 → 502', async () => {
    const cases: Array<[VoiceprintEnrollErrorCode, number]> = [
      ['AUDIO_INVALID', 400],
      ['NOT_CONFIGURED', 400],
      ['UPLOAD_FAILED', 502],
      ['REGISTER_FAILED', 502],
    ];
    for (const [code, expected] of cases) {
      vi.mocked(svc.enrollVoiceprint).mockRejectedValue(new svc.VoiceprintEnrollError(code, `err ${code}`));
      const { status, json } = await post('/enroll', { audioBase64: 'AAAA' });
      expect(status).toBe(expected);
      expect(json).toEqual({ error: `err ${code}`, code });
    }
  });
});

describe('POST /delete', () => {
  it('成功 → 200 状态 + 云端结果透传', async () => {
    const status = fakeStatus();
    vi.mocked(svc.deleteVoiceprint).mockResolvedValue({ cloudDeleted: false, cloudError: 'HTTP 500', status });

    const { status: code, json } = await post('/delete');
    expect(code).toBe(200);
    expect(json).toEqual({ success: true, status, cloudDeleted: false, cloudError: 'HTTP 500' });
  });

  it('未预期异常 → 500 INTERNAL(带 details)', async () => {
    vi.mocked(svc.deleteVoiceprint).mockRejectedValue(new Error('disk full'));
    const { status, json } = await post('/delete');
    expect(status).toBe(500);
    expect(json).toMatchObject({ code: 'INTERNAL', details: 'disk full' });
  });
});
