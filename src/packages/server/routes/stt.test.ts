/**
 * 语音转文字路由:云通道决策四路契约(真 express + 真 HTTP)。
 * 决策矩阵/云链路细节见 services/stt-volcengine.test.ts —— 这里只测路由接线:
 * 云优先成功不再 spawn、云失败回退本地、仅云端失败 500、仅本地直接 spawn。
 * 云端凭据加载整体替换(绝不读真实 config.json/真实云)。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

vi.mock('child_process', () => ({ spawn: vi.fn() }));

vi.mock('../services/voice-companion-service.js', () => ({
  loadVolcengineSttConfig: vi.fn(),
}));

vi.mock('../services/stt-volcengine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stt-volcengine.js')>();
  return { ...actual, loadSttCloudMode: vi.fn(() => 'auto'), transcribeViaVolcengine: vi.fn() };
});

import { spawn } from 'child_process';
import * as sttCloud from '../services/stt-volcengine.js';
import * as companion from '../services/voice-companion-service.js';
import sttRoutes from './stt.js';

const spawnMock = vi.mocked(spawn);

/** fake whisper:下一拍吐一行 stdout(带时间戳,走路由的 stdout 解析兜底)并以 0 退出。 */
function whisperResponds(text = '本地识别结果'): void {
  spawnMock.mockImplementation(() => {
    const p = new FakeProc();
    setTimeout(() => {
      p.stdout.emit('data', Buffer.from(`[00:00.000 --> 00:01.000] ${text}\n`));
      p.emit('close', 0);
    }, 0);
    return p as unknown as ReturnType<typeof spawn>;
  });
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/stt', sttRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sttCloud.loadSttCloudMode).mockReturnValue('auto');
  vi.mocked(companion.loadVolcengineSttConfig).mockReturnValue({
    apiKey: 'k', appId: '', accessToken: '', resourceId: '', endpoint: 'bigmodel_async',
  });
  vi.mocked(sttCloud.transcribeViaVolcengine).mockResolvedValue({ text: '云端结果', durationMs: 5 });
  whisperResponds();
});

async function post(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/stt/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: Buffer.from('fake-audio').toString('base64'), language: 'Chinese', model: 'medium' }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/stt/transcribe 云通道决策', () => {
  it('自动模式:云成功 → 返回火山结果,不 spawn 本地', async () => {
    const { status, json } = await post();
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.text).toBe('云端结果');
    expect(json.engine).toBe('volcengine');
    expect(sttCloud.transcribeViaVolcengine).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('自动模式:云失败 → 回退本地 whisper', async () => {
    vi.mocked(sttCloud.transcribeViaVolcengine).mockRejectedValue(new Error('握手失败'));
    const { status, json } = await post();
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.text).toBe('本地识别结果');
    expect(json.engine).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('仅云端模式:云失败 → 500,不回退', async () => {
    vi.mocked(sttCloud.loadSttCloudMode).mockReturnValue('cloud');
    vi.mocked(sttCloud.transcribeViaVolcengine).mockRejectedValue(new Error('凭据无效'));
    const { status, json } = await post();
    expect(status).toBe(500);
    expect(json.error).toBe('Cloud transcription failed');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('仅本地模式:跳过云,直接 spawn', async () => {
    vi.mocked(sttCloud.loadSttCloudMode).mockReturnValue('local');
    const { status, json } = await post();
    expect(status).toBe(200);
    expect(json.text).toBe('本地识别结果');
    expect(sttCloud.transcribeViaVolcengine).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('自动模式但无凭据:不碰云,直接本地', async () => {
    vi.mocked(companion.loadVolcengineSttConfig).mockReturnValue({
      apiKey: '', appId: '', accessToken: '', resourceId: '', endpoint: 'bigmodel_async',
    });
    const { status, json } = await post();
    expect(status).toBe(200);
    expect(json.text).toBe('本地识别结果');
    expect(sttCloud.transcribeViaVolcengine).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
