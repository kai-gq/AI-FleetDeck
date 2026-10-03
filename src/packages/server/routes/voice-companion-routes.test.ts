/**
 * 语音伙伴路由层测试
 *
 * 照 trigger-routes.test.ts 的模式:整体替换服务模块(路由只做参数校验与
 * 错误映射,这层契约就是要测的东西),用真 express + 真 HTTP 请求验证 ——
 * 包括流式分支的 NDJSON 行序与客户端断开时的静默收尾。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../services/voice-companion-service.js', () => {
  class VoiceCompanionAbortedError extends Error {
    constructor() {
      super('VoiceCompanion call aborted');
      this.name = 'VoiceCompanionAborted';
    }
  }
  return {
    VoiceCompanionAbortedError,
    processVoiceInput: vi.fn(),
    getCompanionStatus: vi.fn(),
    resetCompanion: vi.fn(),
    getCompanionMemory: vi.fn(),
    updateCompanionMemory: vi.fn(),
  };
});

import * as service from '../services/voice-companion-service.js';
import voiceCompanionRoutes from './voice-companion.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/voice-companion', voiceCompanionRoutes);
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

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/voice-companion/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(cond: () => boolean, label: string, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`waitFor 超时:${label}`);
}

describe('POST /process 参数校验', () => {
  it('rejects missing, non-string, and blank text with 400', async () => {
    for (const body of [{}, { text: 42 }, { text: '' }, { text: '   ' }]) {
      const { status, json } = await post(body);
      expect(status).toBe(400);
      expect(json.error).toBe('Text is required');
      expect(json.code).toBe('TEXT_REQUIRED');
    }
    expect(service.processVoiceInput).not.toHaveBeenCalled();
  });

  it('rejects text over 4000 chars with 400', async () => {
    const { status, json } = await post({ text: 'a'.repeat(4_001) });
    expect(status).toBe(400);
    expect(json.error).toBe('Text too long');
    expect(json.code).toBe('TEXT_TOO_LONG');
    expect(service.processVoiceInput).not.toHaveBeenCalled();
  });
});

describe('POST /process 非流式', () => {
  it('passes trimmed text to the service and spreads the result into the response', async () => {
    vi.mocked(service.processVoiceInput).mockResolvedValue({
      action: 'general_response',
      response: '好的。',
      elapsedMs: 42,
    });

    const { status, json } = await post({ text: '  你好  ' });
    expect(status).toBe(200);
    expect(service.processVoiceInput).toHaveBeenCalledWith('你好', { isEvent: false });
    expect(json).toEqual({ success: true, action: 'general_response', response: '好的。', elapsedMs: 42 });
  });

  it('forwards the event flag', async () => {
    vi.mocked(service.processVoiceInput).mockResolvedValue({ action: 'noop', response: '', elapsedMs: 1 });
    const { status } = await post({ text: '[系统事件] 全部完成', event: true });
    expect(status).toBe(200);
    expect(service.processVoiceInput).toHaveBeenCalledWith('[系统事件] 全部完成', { isEvent: true });
  });

  it('maps ENOENT to 500 Claude CLI not found', async () => {
    vi.mocked(service.processVoiceInput).mockRejectedValue(
      Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    );
    const { status, json } = await post({ text: '你好' });
    expect(status).toBe(500);
    expect(json).toEqual({ error: 'Claude CLI not found', code: 'CLAUDE_NOT_FOUND', details: 'spawn claude ENOENT' });
  });

  it('maps other failures to 500 Failed to process', async () => {
    vi.mocked(service.processVoiceInput).mockRejectedValue(new Error('boom'));
    const { status, json } = await post({ text: '你好' });
    expect(status).toBe(500);
    expect(json).toEqual({ error: 'Failed to process', code: 'PROCESS_FAILED', details: 'boom' });
  });
});

describe('POST /process 流式(NDJSON)', () => {
  it('streams sentence lines in order, then a final line with spoke', async () => {
    let seenSignalAborted: boolean | undefined;
    vi.mocked(service.processVoiceInput).mockImplementation(async (_text, opts) => {
      seenSignalAborted = opts?.signal?.aborted;
      opts?.onSentence?.('第一句。');
      opts?.onSentence?.('第二句。');
      return { action: 'general_response', response: '第一句。第二句。', spoke: true, elapsedMs: 5 };
    });

    const res = await fetch(`${baseUrl}/api/voice-companion/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ' 讲讲进展 ', stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');

    const lines = parseNdjson(await res.text());
    expect(lines).toEqual([
      { type: 'sentence', text: '第一句。' },
      { type: 'sentence', text: '第二句。' },
      { type: 'final', result: { success: true, action: 'general_response', response: '第一句。第二句。', spoke: true, elapsedMs: 5 }, spoke: true },
    ]);
    expect(service.processVoiceInput).toHaveBeenCalledWith(
      '讲讲进展',
      expect.objectContaining({ isEvent: false, onSentence: expect.any(Function) }),
    );
    expect(seenSignalAborted).toBe(false);
  });

  it('writes an error line for ENOENT and for generic failures', async () => {
    vi.mocked(service.processVoiceInput)
      .mockRejectedValueOnce(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
      .mockRejectedValueOnce(new Error('boom'));

    const request = () =>
      fetch(`${baseUrl}/api/voice-companion/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好', stream: true }),
      });

    const first = await (await request()).text();
    expect(parseNdjson(first)).toEqual([
      { type: 'error', error: 'Claude CLI not found', code: 'CLAUDE_NOT_FOUND', details: 'spawn claude ENOENT' },
    ]);

    const second = await (await request()).text();
    expect(parseNdjson(second)).toEqual([
      { type: 'error', error: 'Failed to process', code: 'PROCESS_FAILED', details: 'boom' },
    ]);
  });

  it('aborts the service signal silently when the client disconnects mid-stream', async () => {
    let aborted = false;
    vi.mocked(service.processVoiceInput).mockImplementation((_text, opts) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new service.VoiceCompanionAbortedError());
        });
      });
    });

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/voice-companion/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '说到一半就走', stream: true }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort(); // 客户端断开

    await waitFor(() => aborted, '服务端 signal 被中止');
    // 静默收尾(不写 error 行、不抛):服务端仍健康,后续请求照常
    const status = await fetch(`${baseUrl}/api/voice-companion/status`);
    expect(status.status).toBe(200);
  });
});

describe('状态 / 重置 / 记忆接口', () => {
  it('GET /status wraps the service status with available:true', async () => {
    vi.mocked(service.getCompanionStatus).mockReturnValue({
      hasSession: true,
      turns: 3,
      sessionStartedAt: 111,
      lastUsedAt: 222,
      model: 'haiku',
      memory: { summary: 's', notes: [], updatedAt: 0, droppedCount: 0 },
    });
    const res = await fetch(`${baseUrl}/api/voice-companion/status`);
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json).toEqual({
      available: true,
      hasSession: true,
      turns: 3,
      sessionStartedAt: 111,
      lastUsedAt: 222,
      model: 'haiku',
      memory: { summary: 's', notes: [], updatedAt: 0, droppedCount: 0 },
    });
  });

  it('POST /reset keeps memory by default and honors keepMemory:false', async () => {
    const first = await fetch(`${baseUrl}/api/voice-companion/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(await first.json()).toEqual({ success: true, keepMemory: true });
    expect(service.resetCompanion).toHaveBeenCalledWith({ keepMemory: true });

    const second = await fetch(`${baseUrl}/api/voice-companion/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepMemory: false }),
    });
    expect(await second.json()).toEqual({ success: true, keepMemory: false });
    expect(service.resetCompanion).toHaveBeenLastCalledWith({ keepMemory: false });
  });

  it('GET /memory returns the stored memory', async () => {
    vi.mocked(service.getCompanionMemory).mockReturnValue({
      summary: '',
      notes: [{ id: 'm1', text: '叫我老板', createdAt: 1, source: 'user' }],
      updatedAt: 1,
      droppedCount: 0,
    });
    const res = await fetch(`${baseUrl}/api/voice-companion/memory`);
    const json = (await res.json()) as { success: boolean; memory: { notes: unknown[] } };
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.memory.notes).toHaveLength(1);
  });

  it('POST /memory rejects a non-array ops payload with 400', async () => {
    const res = await fetch(`${baseUrl}/api/voice-companion/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'ops must be an array', code: 'OPS_NOT_ARRAY' });
    expect(service.updateCompanionMemory).not.toHaveBeenCalled();
  });

  it('POST /memory forwards ops and clear', async () => {
    const memory = { summary: '', notes: [], updatedAt: 0, droppedCount: 0 };
    vi.mocked(service.updateCompanionMemory).mockReturnValue(memory);

    const res = await fetch(`${baseUrl}/api/voice-companion/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'add', text: '叫我老板' }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, memory });
    expect(service.updateCompanionMemory).toHaveBeenCalledWith({
      ops: [{ op: 'add', text: '叫我老板' }],
      clear: false,
    });

    const cleared = await fetch(`${baseUrl}/api/voice-companion/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    expect(cleared.status).toBe(200);
    expect(service.updateCompanionMemory).toHaveBeenLastCalledWith({ ops: undefined, clear: true });
  });
});
