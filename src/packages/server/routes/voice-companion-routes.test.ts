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

// 任务33:路由层事件闸口依赖 sentinel-service;默认放行,闸口测试里改返回值。
vi.mock('../services/sentinel-service.js', () => ({
  evaluateVoiceEventGate: vi.fn(() => ({ decision: 'pass', directive: null })),
  logSuppressedVoiceEvent: vi.fn(),
}));

// 分钟级提醒:纯粹函数/话术走真实现(importOriginal),只替换单例与开关
// (绝不能碰真实 XDG 存储文件;service 实例一律用测试替身)。
vi.mock('../services/voice-reminder-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/voice-reminder-service.js')>();
  return {
    ...actual,
    getVoiceReminderService: vi.fn(),
    isVoiceReminderEnabled: vi.fn(() => true),
  };
});

import * as service from '../services/voice-companion-service.js';
import * as sentinel from '../services/sentinel-service.js';
import * as reminderSvc from '../services/voice-reminder-service.js';
import voiceCompanionRoutes from './voice-companion.js';
import type { SentinelEventGateResult } from '../services/sentinel-service.js';
import type { VoiceReminder, VoiceReminderService } from '../services/voice-reminder-service.js';

/** store-only 指令替身(字段齐即可,路由只看 decision)。 */
function degradedDirective(): NonNullable<SentinelEventGateResult['directive']> {
  return {
    action: 'store-only',
    maxTier: 'STORE',
    speakAllowed: false,
    speechFactor: 0,
    phase: 'degraded',
    day: '2026-10-5',
    at: 0,
    verdict: 'critical',
    evidence: { day: '2026-10-4', proactiveBroadcasts: 10, ignoreRate: 0.7, adoptRate: null, complaints: 0 },
  };
}

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
  // resetAllMocks 会清掉工厂默认实现,这里重置:默认闸口放行(旧测试语义不变,
  // 闸口抑制用例在自己的 it 内显式改返回值)。
  vi.mocked(sentinel.evaluateVoiceEventGate).mockReturnValue({ decision: 'pass', directive: null });
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

// ─── 分钟级提醒测试工具 ───

function fakeReminder(over: Partial<VoiceReminder> = {}): VoiceReminder {
  return {
    id: 'vr-1',
    itemText: '',
    sourceText: '两分钟后叫我一下',
    createdAt: 0,
    fireAt: 1_800_000_000_000,
    status: 'pending',
    ...over,
  };
}

/** 把提醒服务单例替换为测试替身,并打开开关。 */
function useReminderService(over: Partial<VoiceReminderService> = {}): VoiceReminderService {
  const stub = {
    register: vi.fn(() => ({ ok: false, reason: 'cap' as const })),
    cancelActive: vi.fn(() => 0),
    listActive: vi.fn(() => [] as VoiceReminder[]),
    listDue: vi.fn(() => [] as VoiceReminder[]),
    ack: vi.fn(() => true),
    rearm: vi.fn(),
    dispose: vi.fn(),
    ...over,
  } as unknown as VoiceReminderService;
  vi.mocked(reminderSvc.isVoiceReminderEnabled).mockReturnValue(true);
  vi.mocked(reminderSvc.getVoiceReminderService).mockReturnValue(stub);
  return stub;
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
    const { status } = await post({ text: '⟦系统事件⟧ 全部完成', event: true });
    expect(status).toBe(200);
    expect(service.processVoiceInput).toHaveBeenCalledWith('⟦系统事件⟧ 全部完成', { isEvent: true });
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

describe('POST /process 事件闸口(任务33 活动监视器)', () => {
  it('store-only:抑制事件——不调 LLM、返回 noop 形应答、落 suppressed 日志', async () => {
    vi.mocked(sentinel.evaluateVoiceEventGate).mockReturnValue({
      decision: 'store-only',
      directive: degradedDirective(),
    });

    const { status, json } = await post({ text: '⟦系统事件⟧ 过去 3 分钟:① x 完成', event: true });
    expect(status).toBe(200);
    expect(json).toEqual({ success: true, action: 'noop', response: '', elapsedMs: 0 });
    expect(service.processVoiceInput).not.toHaveBeenCalled();
    expect(sentinel.logSuppressedVoiceEvent).toHaveBeenCalledWith(
      '⟦系统事件⟧ 过去 3 分钟:① x 完成',
      expect.objectContaining({ decision: 'store-only' }),
    );
  });

  it('store-only + stream:NDJSON 单行 final(spoke:false,noop 形)', async () => {
    vi.mocked(sentinel.evaluateVoiceEventGate).mockReturnValue({
      decision: 'store-only',
      directive: degradedDirective(),
    });

    const res = await fetch(`${baseUrl}/api/voice-companion/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '⟦系统事件⟧ 有事件', event: true, stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(parseNdjson(await res.text())).toEqual([
      { type: 'final', result: { success: true, action: 'noop', response: '', elapsedMs: 0 }, spoke: false },
    ]);
    expect(service.processVoiceInput).not.toHaveBeenCalled();
  });

  it('throttle:确定性降频被丢的事件同样抑制(不调 LLM)', async () => {
    vi.mocked(sentinel.evaluateVoiceEventGate).mockReturnValue({
      decision: 'throttle',
      directive: { ...degradedDirective(), action: 'reduce-frequency', maxTier: 'SPEAK', speakAllowed: true, speechFactor: 0.5, phase: 'recovering', verdict: 'healthy' },
    });

    const { json } = await post({ text: '⟦系统事件⟧ 又一个事件', event: true });
    expect(json.action).toBe('noop');
    expect(service.processVoiceInput).not.toHaveBeenCalled();
    expect(sentinel.logSuppressedVoiceEvent).toHaveBeenCalledTimes(1);
  });

  it('放行:闸口 pass 时事件照常进 LLM(isEvent=true)', async () => {
    // 默认 mock 即 pass
    vi.mocked(service.processVoiceInput).mockResolvedValue({ action: 'noop', response: '', elapsedMs: 1 });

    const { status, json } = await post({ text: '⟦系统事件⟧ 一切正常', event: true });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, action: 'noop' });
    expect(service.processVoiceInput).toHaveBeenCalledWith('⟦系统事件⟧ 一切正常', { isEvent: true });
    expect(sentinel.logSuppressedVoiceEvent).not.toHaveBeenCalled();
  });

  it('非事件不过闸:老板说话永不受活动监视器影响', async () => {
    vi.mocked(service.processVoiceInput).mockResolvedValue({ action: 'general_response', response: '嗯', elapsedMs: 1 });

    await post({ text: '你好' });
    expect(sentinel.evaluateVoiceEventGate).not.toHaveBeenCalled();
    expect(service.processVoiceInput).toHaveBeenCalledWith('你好', { isEvent: false });
  });
});

describe('POST /process 流式(NDJSON)', () => {
  it('streams sentence lines in order, then a final line with spoke', async () => {
    let seenSignalAborted: boolean | undefined;
    vi.mocked(service.processVoiceInput).mockImplementation(async (_text, opts) => {
      seenSignalAborted = opts?.signal?.aborted;
      opts?.onSentence?.('在,我去看一眼。', { pre: true }); // W4:过渡句带 pre 标记透传
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
    expect(lines[0]).toMatchObject({ type: 'sentence', text: '在,我去看一眼。', tMs: expect.any(Number), pre: true });
    expect(lines[1]).toMatchObject({ type: 'sentence', text: '第一句。', tMs: expect.any(Number) });
    expect(lines[1]).not.toHaveProperty('pre'); // 非过渡句不带标记
    expect(lines[2]).toMatchObject({ type: 'sentence', text: '第二句。', tMs: expect.any(Number) });
    expect(lines.slice(3)).toEqual([
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

describe('POST /process 分钟级提醒快通道', () => {
  it('非流式 create:毫秒回执、注册入服务、不进 LLM 也不过事件闸口', async () => {
    const stub = useReminderService({
      register: vi.fn(() => ({ ok: true as const, reminder: fakeReminder({ itemText: '喝水' }) })),
    });

    const { status, json } = await post({ text: '三分钟后提醒我喝水' });
    expect(status).toBe(200);
    expect(json).toEqual({
      success: true,
      action: 'noop',
      response: '好嘞,三分钟后提醒你喝水。',
      elapsedMs: 0,
      spoke: true,
    });
    expect(stub.register).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'create', itemText: '喝水', delayMs: 180_000 }),
      '三分钟后提醒我喝水',
    );
    expect(service.processVoiceInput).not.toHaveBeenCalled();
    expect(sentinel.evaluateVoiceEventGate).not.toHaveBeenCalled();
  });

  it('流式 create:NDJSON sentence + final(spoke:true),客户端不再整段补播', async () => {
    useReminderService({
      register: vi.fn(() => ({ ok: true as const, reminder: fakeReminder() })),
    });

    const res = await fetch(`${baseUrl}/api/voice-companion/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '两分钟后叫我一下', stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(parseNdjson(await res.text())).toEqual([
      { type: 'sentence', text: '好嘞,两分钟后喊你。', tMs: 0 },
      {
        type: 'final',
        result: { success: true, action: 'noop', response: '好嘞,两分钟后喊你。', elapsedMs: 0 },
        spoke: true,
      },
    ]);
    expect(service.processVoiceInput).not.toHaveBeenCalled();
  });

  it('上限:register 拒绝 cap → 换话术,仍秒回', async () => {
    useReminderService({ register: vi.fn(() => ({ ok: false as const, reason: 'cap' as const })) });
    const { json } = await post({ text: '两分钟后提醒我喝水' });
    expect(json.response).toBe(reminderSvc.buildReminderCapSay());
    expect(json.spoke).toBe(true);
    expect(service.processVoiceInput).not.toHaveBeenCalled();
  });

  it('取消:按在挂条数回执(1 条/多条/0 条)', async () => {
    const stub = useReminderService({ cancelActive: vi.fn(() => 1) });
    const first = await post({ text: '取消提醒' });
    expect(first.json.response).toBe('行,那条不提醒了。');

    vi.mocked(stub.cancelActive).mockReturnValue(2);
    const multi = await post({ text: '别提醒我了' });
    expect(multi.json.response).toBe('行,那 2 条都不提醒了。');

    vi.mocked(stub.cancelActive).mockReturnValue(0);
    const none = await post({ text: '别再叫我了' });
    expect(none.json.response).toBe('现在没有挂着的提醒。');
    expect(service.processVoiceInput).not.toHaveBeenCalled();
  });

  it('列表:走 listActive + 确定性话术(空/单条)', async () => {
    const stub = useReminderService();
    const empty = await post({ text: '有哪些提醒' });
    expect(empty.json.response).toBe('现在没有挂着的提醒。');

    vi.mocked(stub.listActive).mockReturnValue([fakeReminder({ itemText: '喝水', fireAt: Date.now() + 120_000 })]);
    const one = await post({ text: '提醒列表' });
    expect(one.json.response).toMatch(/^有 1 条:1\)2 分钟后提醒你喝水。?$/);
    expect(service.processVoiceInput).not.toHaveBeenCalled();
  });

  it('负例/事件/开关关:一律不抢原链路', async () => {
    vi.mocked(reminderSvc.isVoiceReminderEnabled).mockReturnValue(true);
    vi.mocked(service.processVoiceInput).mockResolvedValue({ action: 'general_response', response: '嗯', elapsedMs: 1 });

    // 疑问负例(事故后追问原句)→ 原链路
    await post({ text: '两分钟后喊我了吗' });
    expect(service.processVoiceInput).toHaveBeenCalledTimes(1);

    // 事件回合(带提醒式文本)不注册
    await post({ text: '⟦系统事件⟧ 两分钟后提醒我喝水', event: true });
    expect(service.processVoiceInput).toHaveBeenCalledTimes(2);

    // 开关关 → 快通道不生效
    vi.mocked(reminderSvc.isVoiceReminderEnabled).mockReturnValue(false);
    await post({ text: '三分钟后提醒我喝水' });
    expect(service.processVoiceInput).toHaveBeenCalledTimes(3);

    expect(reminderSvc.getVoiceReminderService).not.toHaveBeenCalled();
  });
});

describe('提醒轮询与回执接口', () => {
  it('GET /reminders/due:空数组与 due 载荷(话术服务端拼好)', async () => {
    const stub = useReminderService();
    const empty = await fetch(`${baseUrl}/api/voice-companion/reminders/due`);
    expect(await empty.json()).toEqual({ success: true, reminders: [] });

    const record = fakeReminder({ itemText: '喝水', status: 'due' });
    vi.mocked(stub.listDue).mockReturnValue([record]);
    const res = await fetch(`${baseUrl}/api/voice-companion/reminders/due`);
    expect(await res.json()).toEqual({
      success: true,
      reminders: [{ id: 'vr-1', itemText: '喝水', fireAt: record.fireAt, say: '老大,到点了:喝水。' }],
    });
  });

  it('GET /reminders/due:开关关 → 空且不触服务', async () => {
    vi.mocked(reminderSvc.isVoiceReminderEnabled).mockReturnValue(false);
    const res = await fetch(`${baseUrl}/api/voice-companion/reminders/due`);
    expect(await res.json()).toEqual({ success: true, reminders: [] });
    expect(reminderSvc.getVoiceReminderService).not.toHaveBeenCalled();
  });

  it('POST /reminders/ack:幂等结果透传;缺 id → 400 ID_REQUIRED', async () => {
    const stub = useReminderService({ ack: vi.fn(() => true) });
    const res = await fetch(`${baseUrl}/api/voice-companion/reminders/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'vr-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, acked: true });
    expect(stub.ack).toHaveBeenCalledWith('vr-1');

    const missing = await fetch(`${baseUrl}/api/voice-companion/reminders/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json() as Record<string, unknown>).code).toBe('ID_REQUIRED');
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
      // 任务18:上下文占用与常驻进程 pid 随状态接口透出(路由原样 spread)。
      context: { tokensUsed: 1234, windowTokens: 200000, percent: 0.00617, updatedAt: 333 },
      residentPid: 4242,
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
      context: { tokensUsed: 1234, windowTokens: 200000, percent: 0.00617, updatedAt: 333 },
      residentPid: 4242,
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
