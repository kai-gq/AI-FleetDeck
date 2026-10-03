/**
 * 语音伙伴服务 · 编排集成测试(hop1/hop2 全流程)
 *
 * 与 voice-companion-service.test.ts(纯函数)互补:这里跑真实的 processVoiceInput
 * 流程,只把系统边界换成可控替身 ——
 *   - child_process.spawn:假 claude 子进程(EventEmitter),按脚本吐 stream-json 行;
 *   - agent-service / data(index) / services(index) / websocket command-handler:
 *     记录并返回测试夹具。
 *
 * 三保险防误写真实数据:
 *   1) src/test-setup.ts 已把 XDG_DATA_HOME 指向进程级临时沙箱(模块加载前);
 *   2) 本文件 beforeAll 先 chdir 到临时工程目录再动态 import 服务
 *      (CONFIG_FILE 在模块加载时按 cwd 解析),afterAll 还原;
 *   3) beforeAll 调 resetCompanion() 后硬断言状态文件确实落在 XDG 沙箱内,
 *      断言失败立即抛错终止 —— 绝不让测试继续跑在真实状态文件上。
 *
 * 注意:必须用 vi.mock + 动态 import(不能静态 import 服务再 mock),且本文件
 * 独立成文件(vitest 默认 pool=forks,每文件独立进程,chdir 不外溢)。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VoiceProcessOptions, VoiceProcessResult } from './voice-companion-service.js';

// ============================================================================
// 假 claude 子进程
// ============================================================================

interface SpawnOpts {
  shell?: boolean;
  windowsHide?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: SpawnOpts;
  child: FakeChild;
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  readonly kills: Array<string | undefined> = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.stdinWrites.push(chunk);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  kill(signal?: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

const spawnCalls: SpawnCall[] = [];
let throwOnNextSpawn: Error | null = null;

function fakeSpawn(cmd: string, args: string[], opts: SpawnOpts): FakeChild {
  if (throwOnNextSpawn) {
    const err = throwOnNextSpawn;
    throwOnNextSpawn = null;
    throw err;
  }
  const child = new FakeChild();
  spawnCalls.push({ cmd, args, opts, child });
  // 真实 spawn 的 'spawn' 事件在监听器挂上之后才触发,这里用 nextTick 对齐。
  process.nextTick(() => child.emit('spawn'));
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: fakeSpawn };
});

// ============================================================================
// 其余系统边界(agent 世界 / 数据目录 / services 入口 / websocket 配置)
// ============================================================================

interface MockAgent {
  id: string;
  name: string;
  class?: string;
  status: string;
  isBoss?: boolean;
  taskLabel?: string;
  lastAssignedTask?: string;
  lastError?: string;
  lastWorkedAt?: number;
}

const mockAgents: MockAgent[] = [];
let mockHistory: Array<{ type: string; content: string }> = [];

vi.mock('./agent-service.js', () => ({
  getAllAgents: () => mockAgents,
  getAgent: (id: string) => mockAgents.find((a) => a.id === id),
  getAgentHistory: async () => ({ messages: mockHistory }),
}));

vi.mock('../data/index.js', async () => {
  // 展开真实模块:同图内 backend/runner 还以命名导入引用了 isProcessRunning 等,
  // 只把 loadAreas 换成确定性空数组(测试不从磁盘读区域数据)。
  const actual = await vi.importActual<typeof import('../data/index.js')>('../data/index.js');
  return { ...actual, loadAreas: () => [] };
});

const stopAgentMock = vi.fn(async (_agentId: string) => {});
const sendCommandMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('./index.js', () => ({
  runtimeService: {
    stopAgent: (...args: [string]) => stopAgentMock(...args),
    sendCommand: (...args: unknown[]) => sendCommandMock(...args),
  },
  bossMessageService: {
    buildBossMessage: async (id: string, message: string) => ({
      message: `BOSS:${message}`,
      systemPrompt: `sys:${id}`,
    }),
  },
}));

vi.mock('../websocket/handlers/command-handler.js', () => ({
  buildCustomAgentConfig: (id: string, cls?: string) => ({ __custom: id, cls }),
}));

// ============================================================================
// 沙箱、临时工程目录与状态文件
// ============================================================================

const dataHome = process.env.XDG_DATA_HOME;
if (!dataHome) throw new Error('XDG_DATA_HOME 未设置:test-setup 沙箱失效,拒绝加载本测试文件');

const stateFilePath = path.join(dataHome, 'tide-commander', 'voice-companion.json');

interface StateFile {
  sessionId: string | null;
  sessionStartedAt: number | null;
  turns: number;
  lastUsedAt: number | null;
  personaKey: string | null;
  memory: {
    summary: string;
    notes: Array<{ id: string; text: string; createdAt: number; source: string }>;
    updatedAt: number;
    droppedCount: number;
  };
}

let service: typeof import('./voice-companion-service.js');
let projectDir = '';
let originalCwd = '';

function configPath(): string {
  return path.join(projectDir, 'tools', 'voice-companion', 'config.json');
}

const DEFAULT_TEST_CONFIG = {
  model: 'haiku',
  persona: { preset: 'doubao', custom: '' },
  brain: { hop1TimeoutMs: 5_000, hop2TimeoutMs: 5_000, maxTurns: 10, sessionMaxAgeDays: 7, maxNotes: 5 },
};

function writeConfig(overrides: {
  model?: string;
  persona?: { preset: string; custom?: string };
  brain?: Partial<typeof DEFAULT_TEST_CONFIG.brain>;
} = {}): void {
  const cfg = {
    ...DEFAULT_TEST_CONFIG,
    ...overrides,
    persona: { ...DEFAULT_TEST_CONFIG.persona, ...(overrides.persona ?? {}) },
    brain: { ...DEFAULT_TEST_CONFIG.brain, ...(overrides.brain ?? {}) },
  };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg));
}

function writeState(partial: Partial<StateFile> = {}): void {
  const state: StateFile = {
    sessionId: null,
    sessionStartedAt: null,
    turns: 0,
    lastUsedAt: null,
    personaKey: null,
    memory: { summary: '', notes: [], updatedAt: 0, droppedCount: 0 },
    ...partial,
  };
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
}

function readStateFile(): StateFile {
  return JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as StateFile;
}

beforeAll(async () => {
  originalCwd = process.cwd();
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-integration-'));
  fs.mkdirSync(path.join(projectDir, 'tools', 'voice-companion'), { recursive: true });
  process.chdir(projectDir);

  service = await import('./voice-companion-service.js');

  // 安全闸:状态文件必须落在 XDG 沙箱内,否则立即终止(防误写真实数据)。
  if (!path.resolve(stateFilePath).startsWith(path.resolve(dataHome))) {
    throw new Error(`状态文件路径逃出沙箱:${stateFilePath}`);
  }
  service.resetCompanion();
  if (!fs.existsSync(stateFilePath)) {
    throw new Error(`沙箱失效:resetCompanion 未写入 ${stateFilePath},拒绝继续`);
  }
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

beforeEach(() => {
  spawnCalls.length = 0;
  throwOnNextSpawn = null;
  mockAgents.length = 0;
  mockHistory = [];
  stopAgentMock.mockReset();
  sendCommandMock.mockReset();
  sendCommandMock.mockImplementation(async () => {});
  fs.rmSync(stateFilePath, { force: true });
  writeConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// 驱动假子进程的 helpers
// ============================================================================

function emitLine(child: FakeChild, obj: unknown): void {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
}

function emitRaw(child: FakeChild, chunk: string | Buffer): void {
  child.stdout.emit('data', typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
}

function emitStderr(child: FakeChild, text: string): void {
  child.stderr.emit('data', Buffer.from(text));
}

async function drainMicrotasks(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

async function waitFor(cond: () => boolean, label: string, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`waitFor 超时:${label}`);
}

async function waitSpawn(n: number): Promise<SpawnCall> {
  await waitFor(() => spawnCalls.length >= n, `spawn #${n}`);
  const call = spawnCalls[n - 1];
  if (!call) throw new Error(`spawn #${n} 缺失`);
  // 让一个宏任务周期通过:假子进程的 'spawn'(nextTick)会在此写入 stdin。
  await new Promise((r) => setTimeout(r, 0));
  return call;
}

async function closeChild(child: FakeChild, code = 0): Promise<void> {
  child.emit('close', code);
  await drainMicrotasks();
}

function startProcess(text: string, opts: VoiceProcessOptions = {}): Promise<VoiceProcessResult> {
  return service.processVoiceInput(text, opts);
}

interface TestContract {
  action: string;
  responseToUser?: string;
  targetAgentId?: string | null;
  targetAgentName?: string | null;
  messageToAgent?: string;
  delivery?: string;
  query?: string;
  memoryOps?: Array<Record<string, unknown>>;
}

function contractText(c: TestContract): string {
  return JSON.stringify({
    action: c.action,
    responseToUser: c.responseToUser ?? '',
    targetAgentId: c.targetAgentId ?? null,
    targetAgentName: c.targetAgentName ?? null,
    messageToAgent: c.messageToAgent ?? '',
    delivery: c.delivery ?? 'queue',
    query: c.query ?? '',
    memoryOps: c.memoryOps ?? [],
  });
}

type TextChannel = 'assistant' | 'delta' | 'result';

function emitText(child: FakeChild, text: string, via: TextChannel): void {
  if (via === 'assistant') {
    emitLine(child, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  } else if (via === 'delta') {
    emitLine(child, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  } else {
    emitLine(child, { type: 'result', result: text });
  }
}

async function completeWith(
  child: FakeChild,
  text: string,
  opts: { sessionId?: string; via?: TextChannel; code?: number } = {},
): Promise<void> {
  if (opts.sessionId) emitLine(child, { type: 'system', subtype: 'init', session_id: opts.sessionId });
  emitText(child, text, opts.via ?? 'assistant');
  await closeChild(child, opts.code ?? 0);
}

function flagValue(call: SpawnCall, flag: string): string | null {
  const i = call.args.indexOf(flag);
  return i === -1 ? null : call.args[i + 1];
}

function resumeIdOf(call: SpawnCall): string | null {
  return flagValue(call, '--resume');
}

function promptFileOf(call: SpawnCall): string {
  const file = flagValue(call, '--system-prompt-file');
  if (!file) throw new Error('spawn 参数缺少 --system-prompt-file');
  return file;
}

/** 从 stdin 首条消息里取用户文本(含 REMINDER 追加段)。 */
function stdinUserContent(call: SpawnCall): string {
  const raw = call.child.stdinWrites[0];
  if (!raw) throw new Error('子进程没有收到 stdin 写入');
  const parsed = JSON.parse(raw.trim()) as { message?: { content?: string } };
  return parsed.message?.content ?? '';
}

// ============================================================================
// G1 契约解析与三源防翻倍
// ============================================================================

describe('G1 契约解析与三源防翻倍', () => {
  it('G1-1 parses a contract delivered only through stream deltas(+reminder on a fresh turn)', async () => {
    writeState({ personaKey: 'doubao' });
    const p = startProcess('帮我看看大家在干嘛');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '大家都好。' }), { via: 'delta' });

    const r = await p;
    expect(r.action).toBe('general_response');
    expect(r.response).toBe('大家都好。');
    expect(r.degraded).toBeUndefined();
    // 非事件、无 resume 的首轮:REMINDER 追加
    expect(stdinUserContent(call)).toContain('帮我看看大家在干嘛');
    expect(stdinUserContent(call)).toContain('[REMINDER');
  });

  it('G1-2 parses a contract delivered only through the assistant event', async () => {
    const p = startProcess('你好');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '你好呀。' }), { via: 'assistant' });
    const r = await p;
    expect(r.response).toBe('你好呀。');
  });

  it('G1-3 parses a contract delivered only through the result event', async () => {
    const p = startProcess('你好');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '收到。' }), { via: 'result' });
    const r = await p;
    expect(r.response).toBe('收到。');
  });

  it('G1-4 does not double the text when delta + assistant + result all carry the same JSON', async () => {
    // 三源若被拼接,JSON.parse 必失败 → processVoiceInput 抛错;能解析且只有一份即通过。
    const p = startProcess('重复三遍也别翻倍');
    const call = await waitSpawn(1);
    const text = contractText({ action: 'general_response', responseToUser: '单份。' });
    emitLine(call.child, { type: 'system', subtype: 'init', session_id: 'sess-1' });
    emitText(call.child, text, 'delta');
    emitText(call.child, text, 'assistant');
    emitText(call.child, text, 'result');
    await closeChild(call.child, 0);

    const r = await p;
    expect(r.response).toBe('单份。');
    expect(readStateFile().sessionId).toBe('sess-1');
  });

  it('G1-5 decodes multibyte UTF-8 split across chunks and skips a dirty line', async () => {
    const p = startProcess('念一下标题');
    const call = await waitSpawn(1);
    // 一整行 assistant 事件,JSON 里的中文保持原文;在「节」的首字节之后切开
    const line = `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: contractText({ action: 'general_response', responseToUser: '节目《你好》已上线。' }) }] },
    })}\n`;
    const bytes = Buffer.from(line, 'utf8');
    const cut = bytes.indexOf(Buffer.from('节目', 'utf8')) + 1;
    expect(cut).toBeGreaterThan(1);
    emitRaw(call.child, bytes.subarray(0, cut));
    emitRaw(call.child, bytes.subarray(cut, bytes.length - 1)); // 不含尾换行
    emitRaw(call.child, '\n这不是 JSON\n');
    await closeChild(call.child, 0);

    const r = await p;
    expect(r.response).toBe('节目《你好》已上线。');
  });

  it('G1-6 persists the session id, resumes it next turn, and cleans the prompt file', async () => {
    writeState({ personaKey: 'doubao' });
    const p1 = startProcess('第一轮');
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBeNull();
    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), { sessionId: 'sess-1' });
    const r1 = await p1;
    expect(r1.response).toBe('一。');
    expect(readStateFile().sessionId).toBe('sess-1');

    const p2 = startProcess('第二轮');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-1');
    const promptPath = promptFileOf(call2);
    const prompt = fs.readFileSync(promptPath, 'utf-8');
    expect(prompt).toContain('【长期记忆】');
    expect(prompt).toContain('【agent 列表】');
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }));
    const r2 = await p2;
    expect(r2.response).toBe('二。');
    expect(fs.existsSync(promptPath)).toBe(false); // close 后临时提示词文件已清理
    expect(readStateFile().turns).toBe(2);
  });

  it('G1-7 ignores a trailing partial line at close', async () => {
    const p = startProcess('半行');
    const call = await waitSpawn(1);
    emitText(call.child, contractText({ action: 'general_response', responseToUser: '好了。' }), 'assistant');
    emitRaw(call.child, '{"type":"system","session_id":"half'); // 无换行的半行,close 时只剩它
    await closeChild(call.child, 0);

    const r = await p;
    expect(r.response).toBe('好了。');
    expect(readStateFile().sessionId).toBeNull(); // 半行里的 session_id 不被采信
  });
});

// ============================================================================
// G2 记忆与人设
// ============================================================================

describe('G2 记忆与人设', () => {
  it('G2-1 persists memoryOps and injects memory + persona + agent snapshot into the next prompt', async () => {
    writeState({ personaKey: 'doubao' });
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });

    const p1 = startProcess('以后叫我老板');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'general_response',
      responseToUser: '好的,记住了。',
      memoryOps: [{ op: 'add', text: '叫我老板' }],
    }));
    const r1 = await p1;
    expect(r1.memoryOpsApplied).toBe(1);

    const stored = readStateFile();
    expect(stored.memory.notes).toHaveLength(1);
    expect(stored.memory.notes[0]?.text).toBe('叫我老板');
    expect(stored.memory.notes[0]?.source).toBe('user');

    const p2 = startProcess('我们聊到哪了');
    const call2 = await waitSpawn(2);
    const prompt = fs.readFileSync(promptFileOf(call2), 'utf-8');
    expect(prompt).toContain('叫我老板');
    expect(prompt).toContain('- 小美 | id: a1 | claude | idle');
    expect(prompt).toContain('【人设】');
    expect(prompt).toContain('【长期记忆】');
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '聊记忆。' }));
    await p2;
  });

  it('G2-2 keeps --resume while the persona is unchanged and rotates when it changes', async () => {
    writeState({ sessionId: 'sess-old', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao' });

    const p1 = startProcess('同一人设');
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBe('sess-old');
    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), { sessionId: 'sess-new' });
    await p1;
    expect(readStateFile().sessionId).toBe('sess-new');

    // 换人设:--resume 的历史会盖过新提示词,必须轮换会话
    writeConfig({ persona: { preset: 'butler' } });
    const p2 = startProcess('换个风格');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBeNull();
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-2' });
    await p2;

    const stored = readStateFile();
    expect(stored.personaKey).toBe('butler');
    expect(stored.sessionId).toBe('sess-2');
    expect(stored.turns).toBe(1);
  });
});

// ============================================================================
// G3 会话轮换
// ============================================================================

describe('G3 会话轮换', () => {
  it('G3-1 rotates at the turn limit without --resume and resets the counter', async () => {
    writeState({ sessionId: 'sess-old', sessionStartedAt: Date.now(), turns: 10, personaKey: 'doubao' });
    const p = startProcess('到点了');
    const call = await waitSpawn(1);
    expect(resumeIdOf(call)).toBeNull();
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '轮换。' }), { sessionId: 'sess-rot' });
    await p;

    const stored = readStateFile();
    expect(stored.sessionId).toBe('sess-rot');
    expect(stored.turns).toBe(1);
  });

  it('G3-2 rotates when the session is older than sessionMaxAgeDays', async () => {
    writeState({
      sessionId: 'sess-old',
      sessionStartedAt: Date.now() - 8 * 86_400_000,
      turns: 2,
      personaKey: 'doubao',
    });
    const p = startProcess('好久不见');
    const call = await waitSpawn(1);
    expect(resumeIdOf(call)).toBeNull();
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '过期。' }), { sessionId: 'sess-young' });
    await p;
    expect(readStateFile().turns).toBe(1);
  });

  it('G3-3 rotates a legacy state with a null personaKey exactly once', async () => {
    writeState({ sessionId: 'sess-old', sessionStartedAt: Date.now(), turns: 3, personaKey: null });

    const p1 = startProcess('旧状态');
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBeNull();
    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), { sessionId: 'sess-1' });
    await p1;
    expect(readStateFile().personaKey).toBe('doubao');

    const p2 = startProcess('新状态');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-1'); // 只轮换这一次
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }));
    await p2;
  });
});

// ============================================================================
// G4 --resume 被拒重试
// ============================================================================

describe('G4 --resume 被拒重试', () => {
  it('G4-1 clears the session and retries exactly once without --resume', async () => {
    writeState({ sessionId: 'sess-dead', sessionStartedAt: Date.now(), turns: 5, personaKey: 'doubao' });
    const p = startProcess('还在吗');
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBe('sess-dead');
    emitStderr(call1.child, 'No conversation found with session ID: sess-dead');
    await closeChild(call1.child, 1);

    const call2 = await waitSpawn(2);
    expect(spawnCalls).toHaveLength(2); // 恰好重试一次
    expect(resumeIdOf(call2)).toBeNull();
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '我在。' }), { sessionId: 'sess-fresh' });

    const r = await p;
    expect(r.response).toBe('我在。');
    expect(readStateFile().sessionId).toBe('sess-fresh');
    expect(readStateFile().turns).toBe(6);
  });

  it('G4-2 degrades without retry on a non-signature failure', async () => {
    writeState({ sessionId: 'sess-ok', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao' });
    const p = startProcess('崩了吗');
    const call = await waitSpawn(1);
    emitStderr(call.child, 'boom');
    await closeChild(call.child, 1);

    const r = await p;
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('没听清');
    expect(spawnCalls).toHaveLength(1); // 非特征错误不重试
    const stored = readStateFile();
    expect(stored.sessionId).toBe('sess-ok'); // 超时/失败不重置会话
    expect(stored.turns).toBe(1);
  });

  it('G4-3 never retries when no session id is stored', async () => {
    writeState({ personaKey: 'doubao' });
    const p = startProcess('首轮失败');
    const call = await waitSpawn(1);
    emitStderr(call.child, 'No conversation found with session ID: nope');
    await closeChild(call.child, 1);

    const r = await p;
    expect(r.degraded).toBe(true);
    expect(spawnCalls).toHaveLength(1); // 没有 session 可清,不做「清会话重试」
  });
});

// ============================================================================
// G5 降级与抛错
// ============================================================================

describe('G5 降级与抛错', () => {
  it('G5-1 times out with SIGTERM, degrades, and keeps the session', async () => {
    writeState({ sessionId: 'sess-keep', sessionStartedAt: Date.now(), turns: 4, personaKey: 'doubao' });
    vi.useFakeTimers();
    const p = startProcess('假装没听见');
    while (spawnCalls.length === 0) await Promise.resolve();
    const call = spawnCalls[0]!;
    const promptPath = promptFileOf(call);

    await vi.advanceTimersByTimeAsync(5_001);
    const r = await p;

    expect(r.degraded).toBe(true);
    expect(r.response).toContain('没听清');
    expect(call.child.kills).toContain('SIGTERM');
    expect(spawnCalls).toHaveLength(1);
    expect(fs.existsSync(promptPath)).toBe(false);
    const stored = readStateFile();
    expect(stored.sessionId).toBe('sess-keep'); // 超时不重置会话
    expect(stored.turns).toBe(4); // 轮数不计
  });

  it('G5-2 degrades when the process exits non-zero with no text', async () => {
    const p = startProcess('退出异常');
    const call = await waitSpawn(1);
    await closeChild(call.child, 1);
    const r = await p;
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('没听清');
  });

  it('G5-3 degrades when the process closes cleanly with no text', async () => {
    const p = startProcess('空手而归');
    const call = await waitSpawn(1);
    await closeChild(call.child, 0);
    const r = await p;
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('没听清');
  });

  it('G5-4 rejects with ENOENT (claude 未安装) and leaves the state untouched', async () => {
    writeState({ sessionId: 'sess-keep', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    throwOnNextSpawn = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });

    await expect(startProcess('没装 claude')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawnCalls).toHaveLength(0);
    const stored = readStateFile();
    expect(stored.sessionId).toBe('sess-keep');
    expect(stored.turns).toBe(2);
  });

  it('G5-5 degrades on contract parse failures instead of throwing(P4)', async () => {
    writeState({ personaKey: 'doubao' });
    const p = startProcess('解析不了');
    const call = await waitSpawn(1);
    await completeWith(call.child, '抱歉,我不会说 JSON。');

    const r = await p; // 旧行为:穿透成 500;新行为:降级
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('没听清');
    const stored = readStateFile();
    expect(stored.turns).toBe(0); // 解析失败早于轮数记账
    expect(stored.sessionId).toBeNull();
  });

  it('G5-5b keeps the session id on parse failure (no reset, next turn can resume)', async () => {
    writeState({ sessionId: 'sess-old', sessionStartedAt: Date.now(), turns: 3, personaKey: 'doubao' });
    const p = startProcess('又来一次解析不了');
    const call = await waitSpawn(1);
    await completeWith(call.child, '还是不说 JSON。', { sessionId: 'sess-parse' });

    const r = await p;
    expect(r.degraded).toBe(true);
    const stored = readStateFile();
    expect(stored.sessionId).toBe('sess-parse'); // 降级不重置会话(与超时一致)
    expect(stored.turns).toBe(3); // 轮数不计
  });

  it('G5-6 aborts on signal: pre-aborted never spawns, mid-flight kills the child', async () => {
    writeState({ personaKey: 'doubao' });

    // 中途 abort:kill 子进程并以 VoiceCompanionAborted 拒绝
    const controller = new AbortController();
    const p1 = startProcess('按下去就停', { signal: controller.signal });
    const call = await waitSpawn(1);
    controller.abort();
    await expect(p1).rejects.toMatchObject({ name: 'VoiceCompanionAborted' });
    expect(call.child.kills).toContain('SIGTERM');

    // 预中止:连 spawn 都不发生
    const aborted = new AbortController();
    aborted.abort();
    await expect(startProcess('先中止再调用', { signal: aborted.signal })).rejects.toMatchObject({
      name: 'VoiceCompanionAborted',
    });
    expect(spawnCalls).toHaveLength(1);
  });
});

// ============================================================================
// G6 派发 / 第二跳 / 互斥 / 流式
// ============================================================================

describe('G6 派发 / 第二跳 / 互斥 / 流式', () => {
  it('G6-1 queues a task for a non-boss agent with the custom config', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });
    const p = startProcess('让小美做登录页');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'a1',
      messageToAgent: '做登录页',
      delivery: 'queue',
      responseToUser: '已让小美去做。',
    }));

    const r = await p;
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('a1', '做登录页', undefined, undefined, { __custom: 'a1', cls: 'claude' });
    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(r.response).toBe('已让小美去做。');
    expect(r.messageSent).toBe('做登录页');
    expect(r.delivery).toBe('queue');
    expect(r.interrupted).toBe(false);
    expect(r.targetAgent).toEqual({ id: 'a1', name: '小美' });
  });

  it('G6-2 routes boss agents through buildBossMessage', async () => {
    mockAgents.push({ id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'idle' });
    const p = startProcess('向老板汇报');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'b1',
      messageToAgent: '汇报进度',
      responseToUser: '好的。',
    }));
    const r = await p;

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('b1', 'BOSS:汇报进度', 'sys:b1');
    expect(r.response).toBe('好的。');
  });

  it('G6-3 interrupts before dispatching(stopAgent strictly before sendCommand)', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'working' });
    const p = startProcess('停下小美改做别的');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'a1',
      messageToAgent: '改用方案B',
      delivery: 'interrupt',
      responseToUser: '',
    }));
    const r = await p;

    expect(stopAgentMock).toHaveBeenCalledWith('a1');
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(stopAgentMock.mock.invocationCallOrder[0]).toBeLessThan(sendCommandMock.mock.invocationCallOrder[0]!);
    expect(r.interrupted).toBe(true);
    expect(r.response).toContain('已打断');
    expect(r.response).toContain('小美');
  });

  it('G6-4 falls back when the target agent does not exist(discarding the streamed confirmation)', async () => {
    const sentences: string[] = [];
    const p = startProcess('让幽灵干活', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'nope',
      targetAgentName: '幽灵',
      messageToAgent: '干活',
      responseToUser: '已让幽灵去做。',
    }), { via: 'delta' });

    const r = await p;
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(sentences).toEqual([]); // 流式缓冲被丢弃(禁止播「已让 X 去做」)
    expect(r.spoke).toBeUndefined();
    // 模型给了话术:整段保留,由客户端按 spoke=false 整段补播(行为锁定)
    expect(r.response).toBe('已让幽灵去做。');

    // 模型没给话术 → 确定性兜底
    const p2 = startProcess('让幽灵干活');
    const call2 = await waitSpawn(2);
    await completeWith(call2.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'nope',
      targetAgentName: '幽灵',
      messageToAgent: '干活',
      responseToUser: '',
    }));
    const r2 = await p2;
    expect(r2.response).toBe('没找到这个 agent(幽灵)。');
  });

  it('G6-5 falls back when messageToAgent is empty', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });
    const sentences: string[] = [];
    const p = startProcess('让小美做那个', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'a1',
      messageToAgent: '',
      responseToUser: '',
    }), { via: 'delta' });

    const r = await p;
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(sentences).toEqual([]);
    expect(r.response).toContain('没听清要让它做什么');
  });

  it('G6-6 answers query_agent_output with a second hop(no resume, hop2 prompt, hop1 speech discarded)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle', taskLabel: '登录页' });
    mockHistory = [
      { type: 'assistant', content: '完成了登录页' },
      { type: 'assistant', content: '又修了一个 bug' },
      { type: 'user', content: '用户消息应被忽略' },
    ];

    const sentences: string[] = [];
    const p = startProcess('小美最近干了什么', { onSentence: (s) => sentences.push(s) });
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBe('sess-1');
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'a1',
      query: '最近干了什么',
      responseToUser: '（hop1 不该播报）好的。',
    }), { via: 'delta' });

    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBeNull(); // 第二跳独立会话
    expect(fs.readFileSync(promptFileOf(call2), 'utf-8')).toContain('结果查询模块');
    const hop2User = stdinUserContent(call2);
    expect(hop2User).toContain('完成了登录页');
    expect(hop2User).toContain('---'); // 多条输出以分隔线拼接
    expect(hop2User).not.toContain('用户消息应被忽略');

    await completeWith(call2.child, '{"responseToUser":"小美刚完成了登录页,还修了一个 bug。"}', { via: 'delta' });

    const r = await p;
    expect(r.response).toBe('小美刚完成了登录页,还修了一个 bug。');
    expect(typeof r.secondHopMs).toBe('number');
    expect(r.targetAgent).toEqual({ id: 'a1', name: '小美' });
    expect(sentences).toEqual(['小美刚完成了登录页,还修了一个 bug。']); // 只播 hop2
  });

  it('G6-7 degrades hop2 failures into a deterministic excerpt summary', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });
    mockHistory = [
      { type: 'assistant', content: '完成了登录页' },
      { type: 'assistant', content: '又修了一个 bug' },
    ];

    const p = startProcess('小美最近干了什么');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'a1',
      query: '最近干了什么',
    }));
    const call2 = await waitSpawn(2);
    await closeChild(call2.child, 1); // 第二跳失败

    const r = await p;
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('「小美」最近的输出:');
    expect(r.response).toContain('完成了登录页');
    expect(typeof r.secondHopMs).toBe('number');
  });

  it('G6-8 stays silent on noop events(fresh event turn carries no reminder)', async () => {
    const sentences: string[] = [];
    const p = startProcess('[系统事件] 一切正常', { isEvent: true, onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'noop', responseToUser: '不该出声。' }), { via: 'delta' });

    const r = await p;
    expect(r.action).toBe('noop');
    expect(r.response).toBe('');
    expect(sentences).toEqual([]);
    const stdin = stdinUserContent(call);
    expect(stdin).toContain('系统事件');
    expect(stdin).not.toContain('[REMINDER'); // isEvent 且无 resume → 不追加
  });

  it('G6-9 falls back to a deterministic roster for an empty list_agents reply', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'working' });
    mockAgents.push({ id: 'a2', name: '阿强', class: 'claude', status: 'idle' });
    const p = startProcess('现在谁在忙');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'list_agents', responseToUser: '' }));

    const r = await p;
    expect(r.action).toBe('list_agents');
    expect(r.response).toContain('2 个 agent');
    expect(r.response).toContain('1 个在忙:小美');
    expect(r.response).toContain('其余 1 个空闲');
  });

  it('G6-10 streams general_response sentences as soon as they complete', async () => {
    const sentences: string[] = [];
    const p = startProcess('聊两句', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    emitLine(call.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"action":"general_response","responseToUser":"你好。' } },
    });
    emitLine(call.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '再见。","targetAgentId":null}' } },
    });
    expect(sentences).toEqual(['你好。', '再见。']); // 闭合引号一到就整句出闸
    await closeChild(call.child, 0);

    const r = await p;
    expect(r.response).toBe('你好。再见。');
    expect(r.spoke).toBe(true);
  });

  it('G6-11 gates the send_to_agent confirmation until dispatch succeeds', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });
    const order: string[] = [];
    sendCommandMock.mockImplementation(async () => {
      order.push('send');
    });
    const p = startProcess('让小美去做', { onSentence: (s) => order.push(`sentence:${s}`) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'a1',
      messageToAgent: '做登录页',
      responseToUser: '已让小美去做。',
    }), { via: 'delta' });

    const r = await p;
    expect(order).toEqual(['send', 'sentence:已让小美去做。']); // 派发成功后才出声
    expect(r.spoke).toBe(true);
  });

  it('G6-12 serializes concurrent calls through the mutex(single spawn while the first is in flight)', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    const p2 = startProcess('第二句');
    await drainMicrotasks();
    expect(spawnCalls).toHaveLength(1); // 第一条未 close 前不并发 spawn

    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }));
    const r1 = await p1;
    expect(r1.response).toBe('一。');

    const call2 = await waitSpawn(2);
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }));
    const r2 = await p2;
    expect(r2.response).toBe('二。');
  });

  it('G6-13 a rejected call does not block the next one', async () => {
    throwOnNextSpawn = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    await expect(startProcess('坏消息')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawnCalls).toHaveLength(0);

    const p = startProcess('好消息');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '好的。' }));
    const r = await p;
    expect(r.response).toBe('好的。');
  });
});
