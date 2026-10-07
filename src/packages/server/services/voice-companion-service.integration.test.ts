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
// 与服务的 log 同一实例(logger.server):spy 它就能断言体积告警这类日志副作用
import { logger } from '../utils/index.js';
// 违规直派告警断言(决策观测点①):走真实 EventDB(XDG 沙箱内)
import { closeEventDb, initEventDb } from '../data/event-db.js';
import { querySystemLog } from '../data/system-log.js';
// 任务07·④:委派史 fixture 走 bossService.init() 真实读取链路(沙箱内,不碰真实数据)
import * as bossService from './boss-service.js';
import type { DelegationCompletion, DelegationDecision, DelegationUserRating } from '../../shared/agent-types.js';
// 任务14·⑪:项目路由集成用例需要可变区域夹具(DrawingArea)
import type { DrawingArea } from '../../shared/common-types.js';
// 垫话 v2:静态默认档的池句断言(本文件既有 W5/C18/C21 用例走 llm 档,见 beforeEach)。
import { STATIC_FILLER_PHRASES } from '../voice/filler-phrases.js';

// ============================================================================
// 假 claude 子进程
// ============================================================================

interface SpawnOpts {
  shell?: boolean;
  windowsHide?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 任务19:中立 cwd(档案模块注入;缺省继承进程 cwd)。 */
  cwd?: string;
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
  /** 待岗(用户手动停用):语音侧不计入忙/闲,派发被确定性拒绝。 */
  standby?: boolean;
}

const mockAgents: MockAgent[] = [];
/** 任务14·⑪:可变区域夹具(默认空,既有用例逐字不变;项目卡用例自行 push)。 */
const mockAreas: DrawingArea[] = [];
let mockHistory: Array<{ type: string; content: string }> = [];
/** 任务07·④:按 agentId 区分历史(委派树要对每个下属各取其产出);未登记的回退全局 mockHistory。 */
const mockHistoryByAgent = new Map<string, Array<{ type: string; content: string }>>();
/** 任务07·④:记录 getAgentHistory 被查过哪些 agent(断言「查了下属而不是 Boss 自己」)。 */
const historyQueriedIds: string[] = [];

vi.mock('./agent-service.js', () => ({
  getAllAgents: () => mockAgents,
  getAgent: (id: string) => mockAgents.find((a) => a.id === id),
  getAgentHistory: async (id: string) => {
    historyQueriedIds.push(id);
    return { messages: mockHistoryByAgent.get(id) ?? mockHistory };
  },
}));

vi.mock('../data/index.js', async () => {
  // 展开真实模块:同图内 backend/runner 还以命名导入引用了 isProcessRunning 等,
  // 只把 loadAreas 换成可变夹具(缺省空数组,项目卡用例 push 区域;测试不从磁盘读区域数据)。
  const actual = await vi.importActual<typeof import('../data/index.js')>('../data/index.js');
  return { ...actual, loadAreas: () => mockAreas };
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
/** 任务07·④:委派史 fixture 文件(仅沙箱;真实文件绝不被本测试触碰)。 */
const delegationHistoryPath = path.join(dataHome, 'tide-commander', 'delegation-history.json');
/** 任务14·⑪:工作区 fixture 文件与别名表目录(仅沙箱;真实文件绝不被本测试触碰)。 */
const workspacesFilePath = path.join(dataHome, 'tide-commander', 'workspaces.json');
const jarvisProjectsDir = path.join(dataHome, 'tide-commander', 'jarvis-projects');

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
    /** 任务39·F4:交接便签(旧夹具不带键;渲染门控见 G12/G13)。 */
    handoff?: { text: string; forSessionId: string; at: number } | null;
  };
  /** 任务39:上下文快照/环缓冲(旧夹具不带键;按需 seed)。 */
  context?: { tokensUsed: number; windowTokens: number; percent: number; updatedAt: number } | null;
  recentTurns?: Array<{ role: string; text: string; at: number; event?: boolean }>;
}

let service: typeof import('./voice-companion-service.js');
let projectDir = '';
let originalCwd = '';
/** 任务19:档案模块的 MCP 源配置夹具路径(不读真实 ~/.claude.json,断言可确定)。 */
let mcpFixturePath = '';

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
  // W5:slowFiller 是可选子键(server 缺省 armMs/emitMs/pregenEmitMs;用例可压到下限做实时观测)。
  brain?: Partial<typeof DEFAULT_TEST_CONFIG.brain> & {
    slowFiller?: { enabled: boolean; armMs: number; emitMs: number; pregenEmitMs?: number };
    // 任务39:压缩阈值三键不在 DEFAULT_TEST_CONFIG.brain 里,但 loadServerConfig 从 brain 读,用例透传。
    contextCompactPercent?: number;
    contextWindowTokens?: number;
    contextCompactTokens?: number;
  };
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
  // 任务19:档案模块从「源配置」过滤出保留的 MCP 服务 —— 测试用夹具,杜绝环境依赖。
  mcpFixturePath = path.join(projectDir, 'mcp-fixture.json');
  fs.writeFileSync(mcpFixturePath, JSON.stringify({
    mcpServers: {
      'mcp-server-mysql': { command: 'npx', args: ['-y', '@benborla29/mcp-server-mysql'], env: { MYSQL_HOST: 'localhost' } },
      obsidian: { command: 'npx', args: ['-y', '@istrejo/obsidian-mcp'] },
      'obsidian-boshi': { command: 'npx', args: ['-y', '@istrejo/obsidian-mcp'] },
      'mcp-server-clickhouse': { command: 'should-not-appear' },
    },
  }));
  process.chdir(projectDir);
  initEventDb(); // 违规直派告警落 system_log,断言走真实读路径(XDG 沙箱)

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
  closeEventDb();
  process.chdir(originalCwd);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

beforeEach(() => {
  spawnCalls.length = 0;
  throwOnNextSpawn = null;
  mockAgents.length = 0;
  mockAreas.length = 0;
  mockHistory = [];
  mockHistoryByAgent.clear();
  historyQueriedIds.length = 0;
  stopAgentMock.mockReset();
  sendCommandMock.mockReset();
  sendCommandMock.mockImplementation(async () => {});
  fs.rmSync(stateFilePath, { force: true });
  // 委派史每用例回到空(沙箱内);需要 fixture 的用例自行 seedDelegationHistory。
  fs.rmSync(delegationHistoryPath, { force: true });
  // 任务14·⑪:工作区/别名表每用例回到空(沙箱内);项目路由内存态(最近提及/挂起反问)复位。
  fs.rmSync(workspacesFilePath, { force: true });
  fs.rmSync(jarvisProjectsDir, { recursive: true, force: true });
  service.resetProjectRoutingSession();
  // 任务39:预生成内存态跨用例隔离(未完成的在途生成会封住后续触发)。
  service.clearHandoffRuntime();
  bossService.init();
  writeConfig();
  // W3 预热点火:本文件回合均以 close 收尾(常驻进程死亡),预热会在测试间隙
  // 触发额外 spawn 污染计数 —— 统一关掉;预热语义由 resident.test.ts 的 P1-P6 专测。
  vi.stubEnv('TC_VOICE_PREWARM', '0');
  // 任务39:交接链路(环缓冲/预生成/渲染)默认关——既有用例的状态文件与 spawn
  // 计数逐字不变;交接专测(G10 等)在用例内自行 stubEnv 打开。
  vi.stubEnv('TC_VOICE_HANDOFF', '0');
  // 任务19:档案模块的 MCP 源固定到夹具(缺省档 allowlist;断言不依赖真实用户配置)。
  vi.stubEnv('TC_VOICE_MCP_SOURCE', mcpFixturePath);
  // 垫话 v2(2026-10-06):本文件既有垫话用例(W5/C18/C21)全部针对 llm 动态档的行为
  // (生成 spawn / 提示词 / 护栏重生成),统一钉 llm 保持断言逐字不变;
  // 静态默认档另设「静态垫话」用例(其内自行 stubEnv 覆盖)与 filler-phrases.test.ts。
  vi.stubEnv('TC_VOICE_FILLER_MODE', 'llm');
});

afterEach(() => {
  vi.unstubAllEnvs();
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
  /** 任务13·⑩：Bolba 动作的指代/事项（旧用例缺省空串，解析零影响）。 */
  bolbaTask?: string;
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
    bolbaTask: c.bolbaTask ?? '',
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

/** 带 usage 的回合收尾(任务39 G9/G11 共用;R5 同款 result 行)。 */
async function completeWithUsage(
  child: FakeChild,
  text: string,
  opts: { sessionId?: string; usage: Record<string, number>; modelUsage?: Record<string, unknown> },
): Promise<void> {
  if (opts.sessionId) emitLine(child, { type: 'system', subtype: 'init', session_id: opts.sessionId });
  emitText(child, text, 'assistant');
  emitLine(child, {
    type: 'result',
    subtype: 'success',
    result: text,
    usage: opts.usage,
    modelUsage: opts.modelUsage ?? { 'claude-haiku-4-5': { contextWindow: 200_000 } },
  });
  await closeChild(child);
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

/** 从 stdin 首条消息里取用户文本(含格式提醒追加段)。 */
function stdinUserContent(call: SpawnCall): string {
  const raw = call.child.stdinWrites[0];
  if (!raw) throw new Error('子进程没有收到 stdin 写入');
  const parsed = JSON.parse(raw.trim()) as { message?: { content?: string } };
  return parsed.message?.content ?? '';
}

/** system_log 行的 body 解析(违规直派告警断言用)。 */
function logBody(row: { body?: string }): Record<string, unknown> {
  return JSON.parse(row.body ?? '{}') as Record<string, unknown>;
}

// ============================================================================
// 任务07·④:委派史 fixture(沙箱内)与查询链路日志断言 helpers
// ============================================================================

interface DecisionFixture {
  timestamp: number;
  selectedAgentId: string;
  selectedAgentName: string;
  userCommand: string;
  bossId?: string;
  /** ⑦ 任务卡(可选;旧记录无卡) */
  taskCard?: { objective: string; projectId?: string; sourceProject?: string };
  /** ⑧ 病历完成事件(可选;旧记录无——任务11) */
  completion?: DelegationCompletion;
  /** ⑧ 病历用户评价(可选;任务11) */
  userRating?: DelegationUserRating;
}

function delegationDecision(f: DecisionFixture): DelegationDecision {
  return {
    id: `del-${f.timestamp}`,
    timestamp: f.timestamp,
    bossId: f.bossId ?? 'b1',
    userCommand: f.userCommand,
    selectedAgentId: f.selectedAgentId,
    selectedAgentName: f.selectedAgentName,
    reasoning: 'fixture',
    alternativeAgents: [],
    confidence: 'medium',
    status: f.completion ? f.completion.result : 'sent',
    taskCard: f.taskCard
      ? {
          objective: f.taskCard.objective,
          acceptanceCriteria: [],
          dependencies: [],
          status: 'running',
          // 任务14·⑪:项目卡派生的归属字段(缺省不加键,旧 fixture 逐字不变)
          ...(f.taskCard.projectId ? { projectId: f.taskCard.projectId } : {}),
          ...(f.taskCard.sourceProject ? { sourceProject: f.taskCard.sourceProject } : {}),
        }
      : undefined,
    ...(f.completion ? { completion: f.completion } : {}),
    ...(f.userRating ? { userRating: f.userRating } : {}),
  };
}

/** 沙箱内写委派史 fixture 并走 bossService.init() 真实读取链路(与 snapshot.test.ts 同范式)。 */
function seedDelegationHistory(histories: Record<string, DelegationDecision[]>): void {
  fs.mkdirSync(path.dirname(delegationHistoryPath), { recursive: true });
  fs.writeFileSync(delegationHistoryPath, JSON.stringify({ histories, savedAt: 0, version: '1.0.0' }));
  bossService.init();
}

/** 🔴④ 查询链路事件(最新在前):body.cat==='query-chain'。 */
function queryChainRows(): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'system', source: 'voice-companion', limit: 50 })
    .filter((row) => logBody(row).cat === 'query-chain')
    .map((row) => logBody(row));
}

/** 任务19·A·尾：会话生命周期事件(source='session',body.cat==='session')；sessionId 在列上,并入返回体。 */
function sessionRows(): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'system', source: 'session', limit: 200 })
    .filter((row) => logBody(row).cat === 'session')
    .map((row) => ({ ...logBody(row), sessionId: row.sessionId }));
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
    // 非事件、无 resume 的首轮:格式提醒追加(自然中文,消评测感)
    expect(stdinUserContent(call)).toContain('帮我看看大家在干嘛');
    expect(stdinUserContent(call)).toContain('【格式】');
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

  it('G2-3 warns once the injected memory grows past the size guard (P9)', async () => {
    const warnSpy = vi.spyOn(logger.server, 'warn');
    try {
      // 20 条 × 300 字符 ≈ 6k 字符 > MEMORY_WARN_CHARS(4000)
      const notes = Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        text: 'x'.repeat(300),
        createdAt: 1,
        source: 'auto',
      }));
      writeState({ sessionId: 'sess-big', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao', memory: { summary: '', notes, updatedAt: 1, droppedCount: 0 } });

      const p = startProcess('记忆好大');
      const call = await waitSpawn(1);
      await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '收到。' }));
      await p;

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('记忆注入体积偏大'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---- A13/H6-1:remove.id 误填笔记文本(事故形态)与未命中的如实可见 ----

  it('G2-4(A13/H6-1) remove.id 填了笔记文本:按文本兜底删掉,不再假成功', async () => {
    writeState({
      sessionId: 'sess-mem', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao',
      memory: {
        summary: '',
        notes: [
          { id: 'mkeep', text: '以后用中文', createdAt: 1, source: 'user' },
          { id: 'mtarget', text: '老板喜欢简洁汇报', createdAt: 2, source: 'user' },
        ],
        updatedAt: 1, droppedCount: 0,
      },
    });
    const p = startProcess('把喜欢简洁那条忘了吧');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'general_response',
      responseToUser: '好,撤了。',
      memoryOps: [{ op: 'remove', id: '老板喜欢简洁汇报' }], // 模型把文本当 id(事故形态)
    }));

    const r = await p;
    expect(r.response).toBe('好,撤了。');
    expect(r.memoryOpsApplied).toBe(1);
    expect(readStateFile().memory.notes.map((n) => n.text)).toEqual(['以后用中文']);
  });

  it('G2-5(A13/H6-1) remove 未命中任何笔记 → 不静默:logger.warn 如实告警且笔记不动', async () => {
    const warnSpy = vi.spyOn(logger.server, 'warn');
    try {
      writeState({
        sessionId: 'sess-mem', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao',
        memory: {
          summary: '',
          notes: [{ id: 'mkeep', text: '以后用中文', createdAt: 1, source: 'user' }],
          updatedAt: 1, droppedCount: 0,
        },
      });
      const p = startProcess('忘掉那条压根不存在的');
      const call = await waitSpawn(1);
      await completeWith(call.child, contractText({
        action: 'general_response',
        responseToUser: '好,撤了。',
        memoryOps: [{ op: 'remove', id: '压根不存在的条目' }],
      }));

      const r = await p;
      expect(r.memoryOpsApplied).toBe(0);
      expect(readStateFile().memory.notes.map((n) => n.text)).toEqual(['以后用中文']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('记忆删除未命中'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('id=压根不存在的条目'));
    } finally {
      warnSpy.mockRestore();
    }
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
// G9 上下文压缩阈值(任务39:缺省 0.3 + 绝对闸口)
// ============================================================================

describe('G9 上下文压缩阈值(任务39)', () => {
  it('G9-1 到缺省 0.3(62K/200K=31%)次回合轮换:不带 --resume + context-compact 留痕(0.31)', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    await completeWithUsage(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), {
      sessionId: 'sess-long',
      usage: { input_tokens: 31_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 11_000 },
    });
    await p1;
    expect(service.loadCompanionState().sessionId).toBe('sess-long');
    expect(service.loadCompanionState().context?.percent).toBeCloseTo(0.31, 5);

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBeNull(); // 轮换 = 新会话
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-2' });
    await p2;

    const compact = sessionRows().filter((r) => r.reason === 'context-compact' && r.sessionId === 'sess-long');
    expect(compact).toHaveLength(1);
    expect(compact[0]?.sessionId).toBe('sess-long');
    expect(compact[0]?.phase).toBe('rotated');
    const stored = readStateFile();
    expect(stored.sessionId).toBe('sess-2');
    expect(stored.turns).toBe(1);
  });

  it('G9-1b 低于阈值(58K/200K=29%)不轮换:次回合仍带旧会话 --resume(0.29)', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    await completeWithUsage(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), {
      sessionId: 'sess-ok',
      usage: { input_tokens: 30_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 8_000 },
    });
    await p1;
    expect(service.loadCompanionState().context?.percent).toBeCloseTo(0.29, 5);

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-ok'); // 未到线:原会话续跑
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-ok' });
    await p2;
  });

  it('G9-2 绝对闸口:窗口报 1M 时 percent 仅 6.1% 也按 tokensUsed 轮换(60K)', async () => {
    writeConfig({ brain: { contextCompactTokens: 60_000 } });
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    await completeWithUsage(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), {
      sessionId: 'sess-1m',
      usage: { input_tokens: 40_000, output_tokens: 500, cache_read_input_tokens: 15_000, cache_creation_input_tokens: 6_000 },
      modelUsage: { 'claude-haiku-4-5': { contextWindow: 1_000_000 } },
    });
    await p1;
    const st = service.loadCompanionState();
    expect(st.context?.windowTokens).toBe(1_000_000);
    expect(st.context?.tokensUsed).toBe(61_000);
    expect(st.context?.percent).toBeCloseTo(0.061, 5); // 远低于 0.3

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBeNull(); // 绝对闸口兜住了
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-2' });
    await p2;
  });

  it('G9-2b 绝对闸口缺省 0 = 关:同 61K/1M 局面不轮换', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    await completeWithUsage(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), {
      sessionId: 'sess-1m',
      usage: { input_tokens: 40_000, output_tokens: 500, cache_read_input_tokens: 15_000, cache_creation_input_tokens: 6_000 },
      modelUsage: { 'claude-haiku-4-5': { contextWindow: 1_000_000 } },
    });
    await p1;

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-1m'); // 未到线、闸口关:续跑
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-1m' });
    await p2;
  });

  it('G9-3 配置解析:缺省 0.3/0;0.05→0.1、0.99→0.95;闸口 -5→0、2M→1M', () => {
    writeConfig();
    let cfg = service.loadServerConfig();
    expect(cfg.contextCompactPercent).toBe(0.3);
    expect(cfg.contextCompactTokens).toBe(0);

    writeConfig({ brain: { contextCompactPercent: 0.05, contextCompactTokens: 2_000_000 } });
    cfg = service.loadServerConfig();
    expect(cfg.contextCompactPercent).toBe(0.1);
    expect(cfg.contextCompactTokens).toBe(1_000_000);

    writeConfig({ brain: { contextCompactPercent: 0.99, contextCompactTokens: -5 } });
    cfg = service.loadServerConfig();
    expect(cfg.contextCompactPercent).toBe(0.95);
    expect(cfg.contextCompactTokens).toBe(0);
  });
});

// ============================================================================
// G10 交接素材环缓冲(任务39·F2)
// ============================================================================

describe('G10 交接素材环缓冲(任务39·F2)', () => {
  /** 直读状态文件的 recentTurns(共享 StateFile 类型未含该字段,专测直读)。 */
  function readRecentTurns(): Array<{ role: string; text: string; at: number; event?: boolean }> {
    const raw = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as {
      recentTurns?: Array<{ role: string; text: string; at: number; event?: boolean }>;
    };
    return raw.recentTurns ?? [];
  }

  it('G10-1 用户句与助手最终回复入缓冲;开关关(缺省)不入', async () => {
    // beforeEach 已置 TC_VOICE_HANDOFF=0:转一圈不记(全链回退现状)。
    const p0 = startProcess('开关关的一回合');
    const call0 = await waitSpawn(1);
    await completeWith(call0.child, contractText({ action: 'general_response', responseToUser: '收到。' }), { sessionId: 'sess-off' });
    await p0;
    expect(readRecentTurns()).toEqual([]);

    // 打开:user + assistant 各一条,旧→新。
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const p1 = startProcess('帮我看下订单');
    const call1 = await waitSpawn(2);
    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '好嘞,我这就看。' }), { sessionId: 'sess-on' });
    await p1;

    const turns = readRecentTurns();
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0]!.text).toBe('帮我看下订单');
    expect(turns[1]!.text).toBe('好嘞,我这就看。');
    expect(typeof turns[0]!.at).toBe('number');
  });

  it('G10-2 轮换清空缓冲:新会话只带轮换后自己的两条', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const p1 = startProcess('旧会话第一句');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '旧会话回复。' }), { sessionId: 'sess-old' });
    await p1;
    expect(readRecentTurns()).toHaveLength(2);

    // 拨到轮数上限(保留 recentTurns 字段)→ 次回合轮换。
    const patch = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as Record<string, unknown>;
    patch.turns = DEFAULT_TEST_CONFIG.brain.maxTurns;
    fs.writeFileSync(stateFilePath, JSON.stringify(patch));

    const p2 = startProcess('新会话第一句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBeNull(); // 轮换生效
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '新会话回复。' }), { sessionId: 'sess-new' });
    await p2;

    const turns = readRecentTurns();
    expect(turns.map((t) => t.text)).toEqual(['新会话第一句', '新会话回复。']);
  });

  it('G10-3 降级回合只记用户句(降级话术不当材料)', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const p = startProcess('会失败的回合');
    const call = await waitSpawn(1);
    await closeChild(call.child, 1); // 非零退出且无文本 → 降级
    const r = await p;
    expect(r.degraded).toBe(true);
    const turns = readRecentTurns();
    expect(turns.map((t) => t.role)).toEqual(['user']);
    expect(turns[0]!.text).toBe('会失败的回合');
  });
});

// ============================================================================
// G11 交接预生成(任务39·F3;认领/渲染在 G12)
// ============================================================================

describe('G11 交接预生成(任务39·F3)', () => {
  /** 回合1 usage → percent=0.25:跨过预备线 0.2、未到触发线 0.3。 */
  const PREPARE_USAGE = {
    input_tokens: 30_000,
    output_tokens: 500,
    cache_read_input_tokens: 15_000,
    cache_creation_input_tokens: 5_000,
  };
  const NOTE_TEXT = '在聊订单同步\n等 A 方案结果\n老大比较急';

  it('G11-1 跨过预备线 → 后台预生成(spawn+1,材料/提示词正确);返回 → pending 落地', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p1 = startProcess('帮我看下订单');
      const call1 = await waitSpawn(1);
      await completeWithUsage(
        call1.child,
        contractText({ action: 'general_response', responseToUser: '好嘞,我这就看。' }),
        { sessionId: 'sess-prep', usage: PREPARE_USAGE },
      );
      await p1;
      expect(service.loadCompanionState().context?.percent).toBeCloseTo(0.25, 5);

      // 后台预生成启动:spawn #2,一次性、不带 --resume、skipMcp。
      await waitFor(() => spawnCalls.length >= 2, '交接预生成 spawn');
      const pregenCall = spawnCalls[1]!;
      expect(resumeIdOf(pregenCall)).toBeNull();
      expect(fs.readFileSync(promptFileOf(pregenCall), 'utf-8')).toContain('交接便签');
      await waitFor(() => pregenCall.child.stdinWrites.length >= 1, '预生成 stdin 写入');
      expect(stdinUserContent(pregenCall)).toContain('【最近对话（旧→新）】');
      expect(stdinUserContent(pregenCall)).toContain('帮我看下订单');

      // 预生成返回 → pending 落地(内存),in-flight 清空。
      await completeWith(pregenCall.child, NOTE_TEXT);
      await waitFor(() => service.getHandoffRuntime().pending !== null, 'pending 落地');
      expect(service.getHandoffRuntime().pending).toMatchObject({ forSessionId: 'sess-prep', text: NOTE_TEXT });
      expect(service.getHandoffRuntime().inFlight).toBeNull();
      const logs = logSpy.mock.calls.map(([m]) => String(m));
      expect(logs.some((m) => m.includes('交接预生成 触发'))).toBe(true);
      expect(logs.some((m) => m.includes('交接预生成 完成'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('G11-2 竞态:预生成未及返回就轮换 → 完成后丢弃(跳过(已轮换)),pending 保持 null', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p1 = startProcess('第一句');
      const call1 = await waitSpawn(1);
      await completeWithUsage(
        call1.child,
        contractText({ action: 'general_response', responseToUser: '一。' }),
        { sessionId: 'sess-old', usage: PREPARE_USAGE },
      );
      await p1;
      await waitFor(() => spawnCalls.length >= 2, '交接预生成 spawn');
      const pregenCall = spawnCalls[1]!;
      expect(service.getHandoffRuntime().inFlight).toBe('sess-old');

      // 拨过触发线 → 次回合轮换(发生在预生成返回之前;此时 pending 还没生成)。
      const patch = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as { context?: { percent?: number } };
      patch.context = { ...(patch.context ?? {}), percent: 0.31 };
      fs.writeFileSync(stateFilePath, JSON.stringify(patch));

      const p2 = startProcess('第二句');
      const call2 = await waitSpawn(3); // #0=回合1 #1=预生成 #2=回合2(轮换后新会话)
      expect(resumeIdOf(call2)).toBeNull();
      await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-new' });
      await p2;
      expect(service.loadCompanionState().sessionId).toBe('sess-new');

      // 预生成此刻才返回 → 核对会话已变 → 丢弃。
      await completeWith(pregenCall.child, NOTE_TEXT);
      await waitFor(() => service.getHandoffRuntime().inFlight === null, 'in-flight 清空');
      expect(service.getHandoffRuntime().pending).toBeNull();
      const logs = logSpy.mock.calls.map(([m]) => String(m));
      expect(logs.some((m) => m.includes('交接预生成 跳过(已轮换'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('G11-3 降级:预生成失败(非零退出) → pending 保持 null,in-flight 清空,回合链不受影响', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p1 = startProcess('第一句');
      const call1 = await waitSpawn(1);
      await completeWithUsage(
        call1.child,
        contractText({ action: 'general_response', responseToUser: '一。' }),
        { sessionId: 'sess-f', usage: PREPARE_USAGE },
      );
      await p1;
      await waitFor(() => spawnCalls.length >= 2, '交接预生成 spawn');
      const pregenCall = spawnCalls[1]!;
      await closeChild(pregenCall.child, 1); // 非零退出 → callClaudeOnce 抛错
      await waitFor(() => service.getHandoffRuntime().inFlight === null, 'in-flight 清空');
      expect(service.getHandoffRuntime().pending).toBeNull();
      const logs = logSpy.mock.calls.map(([m]) => String(m));
      expect(logs.some((m) => m.includes('交接预生成 失败'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('G11-4 冷却:同会话 2 回合内不再触发(回合2 只有主 spawn,无预生成 spawn)', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    await completeWithUsage(
      call1.child,
      contractText({ action: 'general_response', responseToUser: '一。' }),
      { sessionId: 'sess-c', usage: PREPARE_USAGE },
    );
    await p1;
    await waitFor(() => spawnCalls.length >= 2, '交接预生成 spawn');
    await completeWith(spawnCalls[1]!.child, NOTE_TEXT); // 完成预生成 → lastPregen.turns=1
    await waitFor(() => service.getHandoffRuntime().pending !== null, 'pending 落地');

    // 回合2:同会话再跨线、turns=2(距上次预生成 1 回合 < 2)→ 冷却拦住;只有主 spawn(#2)。
    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(3);
    expect(resumeIdOf(call2)).toBe('sess-c');
    await completeWithUsage(
      call2.child,
      contractText({ action: 'general_response', responseToUser: '二。' }),
      { sessionId: 'sess-c', usage: PREPARE_USAGE },
    );
    await p2;
    // 等待一小段确认没有第三个 spawn(pregen)。
    await drainMicrotasks();
    expect(spawnCalls).toHaveLength(3);
  });
});

// ============================================================================
// G12/G13/G14 交接认领与渲染(任务39·F4)
// ============================================================================

describe('G12/G13/G14 交接认领与渲染(任务39·F4)', () => {
  /** 回合1 usage → percent=0.25:跨过预备线 0.2、未到触发线 0.3(与 G11 同源)。 */
  const PREPARE_USAGE = {
    input_tokens: 30_000,
    output_tokens: 500,
    cache_read_input_tokens: 15_000,
    cache_creation_input_tokens: 5_000,
  };
  const NOTE_TEXT = '在聊订单同步\n等 A 方案结果\n老大比较急';

  it('G12-1 全链认领:预生成 → 跨线轮换 → 便签落盘 + 新会话提示词含【上段会话交接】', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      // 回合1:sessionId=sess-claim,收尾 percent=0.25 → 后台预生成 → pending 落地。
      const p1 = startProcess('帮我看下订单');
      const call1 = await waitSpawn(1);
      await completeWithUsage(
        call1.child,
        contractText({ action: 'general_response', responseToUser: '好嘞,我这就看。' }),
        { sessionId: 'sess-claim', usage: PREPARE_USAGE },
      );
      await p1;
      await waitFor(() => spawnCalls.length >= 2, '交接预生成 spawn');
      await completeWith(spawnCalls[1]!.child, NOTE_TEXT);
      await waitFor(() => service.getHandoffRuntime().pending !== null, 'pending 落地');

      // 拨过触发线 → 回合2 起点轮换,认领便签。
      const patch = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as { context?: { percent?: number } };
      patch.context = { ...(patch.context ?? {}), percent: 0.31 };
      fs.writeFileSync(stateFilePath, JSON.stringify(patch));

      const p2 = startProcess('第二句');
      const call2 = await waitSpawn(3); // #0=回合1 #1=预生成 #2=回合2(轮换后新会话)
      expect(resumeIdOf(call2)).toBeNull(); // 轮换 = 新会话
      // 认领即消费:内存待收清空 + 日志。
      expect(service.getHandoffRuntime().pending).toBeNull();
      const logs = logSpy.mock.calls.map(([m]) => String(m));
      expect(logs.some((m) => m.includes('交接笔记已认领'))).toBe(true);
      // 新会话首回合系统提示词(轮换后 spawn)带上交接段 = 笔记文本。
      const prompt = fs.readFileSync(promptFileOf(call2), 'utf-8');
      expect(prompt).toContain('【上段会话交接】(自动生成,可能不全)');
      expect(prompt).toContain(NOTE_TEXT);

      await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-new' });
      await p2;

      // 落盘:memory.handoff 已持久(forSessionId = 旧会话),loadCompanionState 认它。
      const stored = readStateFile();
      expect(stored.memory.handoff).toMatchObject({ text: NOTE_TEXT, forSessionId: 'sess-claim' });
      expect(service.loadCompanionState().memory.handoff?.text).toBe(NOTE_TEXT);
      // /status 状态口不新增字段(⑨ 兼容)。
      expect('handoff' in service.getCompanionStatus().memory).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('G12-2 未及生成:轮换时无 pending → 降级现状(summary 原样)+ 日志如实', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      writeState({
        sessionId: 'sess-dg', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao',
        memory: { summary: '老板喜欢先看结论', notes: [], updatedAt: 1, droppedCount: 0 },
        context: { tokensUsed: 62_000, windowTokens: 200_000, percent: 0.31, updatedAt: Date.now() },
      });
      const p = startProcess('第二句');
      const call = await waitSpawn(1);
      expect(resumeIdOf(call)).toBeNull(); // 轮换照常
      await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '嗯。' }), { sessionId: 'sess-dg-new' });
      await p;

      const logs = logSpy.mock.calls.map(([m]) => String(m));
      expect(logs.some((m) => m.includes('交接笔记未及生成'))).toBe(true);
      // 降级 = 现状:无便签落盘,长期总结不被覆盖。
      const stored = readStateFile();
      expect(stored.memory.handoff).toBeNull();
      expect(stored.memory.summary).toBe('老板喜欢先看结论');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('G13-1 门控:当前会话不渲染自己的便签(同 sessionId)', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    writeState({
      sessionId: 'sess-own', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao',
      memory: { summary: '', notes: [], updatedAt: 1, droppedCount: 0, handoff: { text: NOTE_TEXT, forSessionId: 'sess-own', at: Date.now() } },
    });
    const p = startProcess('随便聊聊');
    const call = await waitSpawn(1);
    expect(resumeIdOf(call)).toBe('sess-own'); // 未轮换,续跑本会话
    expect(fs.readFileSync(promptFileOf(call), 'utf-8')).not.toContain('上段会话交接');
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '嗯。' }), { sessionId: 'sess-own' });
    await p;
  });

  it('G13-2 时效:73h 前的便签跨会话也不渲染', async () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '1');
    writeState({
      sessionId: 'sess-cur', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao',
      memory: {
        summary: '', notes: [], updatedAt: 1, droppedCount: 0,
        handoff: { text: NOTE_TEXT, forSessionId: 'sess-prev', at: Date.now() - 73 * 3_600_000 },
      },
    });
    const p = startProcess('随便聊聊');
    const call = await waitSpawn(1);
    expect(fs.readFileSync(promptFileOf(call), 'utf-8')).not.toContain('上段会话交接');
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '嗯。' }), { sessionId: 'sess-cur' });
    await p;
  });

  it('G13-3 回退:TC_VOICE_HANDOFF=0 时旧便签不渲染,提示词与无便签状态逐字节一致', async () => {
    // HANDOFF 保持 beforeEach 的 '0'(回退档)。
    const stateBase = {
      sessionId: 'sess-ret', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao',
    } as const;
    writeState({
      ...stateBase,
      memory: { summary: '', notes: [], updatedAt: 1, droppedCount: 0, handoff: { text: NOTE_TEXT, forSessionId: 'sess-prev', at: Date.now() } },
    });
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    const promptWithNote = fs.readFileSync(promptFileOf(call1), 'utf-8');
    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), { sessionId: 'sess-ret' });
    await p1;

    writeState({ ...stateBase, memory: { summary: '', notes: [], updatedAt: 1, droppedCount: 0 } });
    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    const promptWithout = fs.readFileSync(promptFileOf(call2), 'utf-8');
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-ret' });
    await p2;

    expect(promptWithNote).not.toContain('上段会话交接');
    expect(promptWithNote).toBe(promptWithout); // 逐字节一致(留存的旧便签不含在提示词里)
  });

  it('G14 reset 清留语义:keepMemory=true 保留便签、false 清空;预生成内存态必清;状态口不出口', () => {
    writeState({
      sessionId: 'sess-r', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao',
      memory: { summary: '', notes: [], updatedAt: 1, droppedCount: 0, handoff: { text: NOTE_TEXT, forSessionId: 'sess-prev', at: Date.now() } },
    });
    expect(service.loadCompanionState().memory.handoff?.text).toBe(NOTE_TEXT);

    service.resetCompanion({ keepMemory: true });
    expect(readStateFile().memory.handoff?.text).toBe(NOTE_TEXT); // 记忆语义:保留(72h 内继续兜底)
    expect(service.getHandoffRuntime()).toEqual({ pending: null, inFlight: null, lastPregen: null });
    expect('handoff' in service.getCompanionStatus().memory).toBe(false);

    service.resetCompanion({ keepMemory: false });
    expect(readStateFile().memory.handoff ?? null).toBeNull(); // 记忆整体清空 → 便签同去
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
    expect(r.response).toContain('有点问题');
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
// 任务19·A·尾:vcs 会话生命周期埋点(session 类四落点)
// ============================================================================

describe('任务19·A·尾:vcs 会话生命周期埋点', () => {
  it('created:首轮无会话→建立 sessionId 落一条 created;次轮 resume 不重复', async () => {
    writeState({ personaKey: 'doubao' });
    const p1 = startProcess('第一轮');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({ action: 'general_response', responseToUser: '一。' }), { sessionId: 'sess-lc-new' });
    await p1;
    expect(sessionRows().filter((row) => row.sessionId === 'sess-lc-new' && row.phase === 'created')).toHaveLength(1);

    // 次轮 --resume 命中同一会话 → 只在 null→id 记账,不重复 created
    // (次轮必须显式回显同一 sessionId:否则 result.sessionId=null,守卫分支不进,断言空转)
    const p2 = startProcess('第二轮');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-lc-new');
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '二。' }), { sessionId: 'sess-lc-new' });
    await p2;
    expect(sessionRows().filter((row) => row.sessionId === 'sess-lc-new' && row.phase === 'created')).toHaveLength(1);
  });

  it('rotated(max-turns):轮数上限轮换落 rotated/max-turns 且带旧会话 id', async () => {
    writeState({ sessionId: 'sess-lc-turns', sessionStartedAt: Date.now(), turns: 10, personaKey: 'doubao' });
    const p = startProcess('到点了');
    const call = await waitSpawn(1);
    expect(resumeIdOf(call)).toBeNull();
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '轮换。' }), { sessionId: 'sess-lc-t2' });
    await p;

    const rows = sessionRows().filter((row) => row.sessionId === 'sess-lc-turns');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'rotated', reason: 'max-turns' });
  });

  it('expired(max-age):超龄轮换落 expired/max-age 且 ageMs 超阈值', async () => {
    writeState({ sessionId: 'sess-lc-age', sessionStartedAt: Date.now() - 8 * 86_400_000, turns: 2, personaKey: 'doubao' });
    const p = startProcess('好久不见');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '过期。' }), { sessionId: 'sess-lc-t3' });
    await p;

    const rows = sessionRows().filter((row) => row.sessionId === 'sess-lc-age');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'expired', reason: 'max-age' });
    expect(Number(rows[0].ageMs)).toBeGreaterThan(7 * 86_400_000);
  });

  it('rotated(persona):旧状态 personaKey 缺失 → 轮换落 rotated/persona-changed', async () => {
    writeState({ sessionId: 'sess-lc-legacy', sessionStartedAt: Date.now(), turns: 3, personaKey: null });
    const p = startProcess('旧状态');
    const call = await waitSpawn(1);
    expect(resumeIdOf(call)).toBeNull();
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '一。' }), { sessionId: 'sess-lc-legacy2' });
    await p;

    const rows = sessionRows().filter((row) => row.sessionId === 'sess-lc-legacy');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'rotated', reason: 'persona-changed' });
  });

  it('resume-rejected:--resume 被拒落 reject 事件,重试成功的新会话落 created', async () => {
    writeState({ sessionId: 'sess-lc-dead', sessionStartedAt: Date.now(), turns: 5, personaKey: 'doubao' });
    const p = startProcess('还在吗');
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBe('sess-lc-dead');
    emitStderr(call1.child, 'No conversation found with session ID: sess-lc-dead');
    await closeChild(call1.child, 1);

    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBeNull();
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '我在。' }), { sessionId: 'sess-lc-fresh' });
    await p;

    const rejected = sessionRows().filter((row) => row.sessionId === 'sess-lc-dead');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ phase: 'resume-rejected', sessionId: 'sess-lc-dead', reason: 'stale-session-id' });
    // 重试成功 → 新会话 created(重试结果自然观测)
    expect(sessionRows().filter((row) => row.sessionId === 'sess-lc-fresh' && row.phase === 'created')).toHaveLength(1);
  });

  it('cleared:resetCompanion 清会话落 cleared/旧 id;无会话时不发噪音', () => {
    const nullRowsBefore = sessionRows().filter((row) => !row.sessionId).length;
    writeState({ sessionId: 'sess-lc-reset', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    service.resetCompanion({ keepMemory: true });

    const rows = sessionRows().filter((row) => row.sessionId === 'sess-lc-reset');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'cleared', sessionId: 'sess-lc-reset', reason: 'reset-companion' });

    service.resetCompanion({ keepMemory: true }); // 已无会话 → 不重复落、不发 null-session 噪音行
    expect(sessionRows().filter((row) => row.sessionId === 'sess-lc-reset')).toHaveLength(1);
    expect(sessionRows().filter((row) => !row.sessionId).length).toBe(nullRowsBefore);
  });

  it('护栏:无会话时轮换不落噪音行(sessionId 为空的行数不变)', async () => {
    const nullRowsBefore = sessionRows().filter((row) => !row.sessionId).length;
    writeState({ personaKey: null }); // 旧状态:人设缺失+无会话 → 轮换判定进入,但无会话可轮换
    const p = startProcess('无会话旧状态');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '一。' }), { sessionId: 'sess-lc-quiet' });
    await p;

    expect(sessionRows().filter((row) => row.sessionId === 'sess-lc-quiet' && row.phase === 'created')).toHaveLength(1);
    expect(sessionRows().filter((row) => !row.sessionId).length).toBe(nullRowsBefore);
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
    expect(r.response).toContain('有点问题');
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
    expect(r.response).toContain('有点问题');
  });

  it('G5-3 degrades when the process closes cleanly with no text', async () => {
    const p = startProcess('空手而归');
    const call = await waitSpawn(1);
    await closeChild(call.child, 0);
    const r = await p;
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('有点问题');
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
    expect(r.response).toContain('有点问题');
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
  it('G6-1 任务只走 Boss(改①):delegate_to_boss 只有主管收到 sendCommand,消息走 buildBossMessage', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });
    mockAgents.push({ id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'idle' });
    const p = startProcess('让团队做登录页');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'delegate_to_boss',
      targetAgentId: null,
      messageToAgent: '把登录页做出来',
      delivery: 'queue',
      responseToUser: '已交给主管安排。',
    }));

    const r = await p;
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('b1', 'BOSS:把登录页做出来', 'sys:b1'); // 唯一目标是 Boss
    expect(sendCommandMock.mock.calls.some((c) => c[0] === 'a1')).toBe(false); // 普通 agent 一个指令都没收到
    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(r.action).toBe('delegate_to_boss');
    expect(r.response).toBe('已交给主管安排。');
    expect(r.messageSent).toBe('把登录页做出来');
    expect(r.delivery).toBe('queue');
    expect(r.interrupted).toBe(false);
    expect(r.targetAgent).toEqual({ id: 'b1', name: '大当家' });
  });

  it('G6-1b 旧契约 send_to_agent 直派普通 agent → 违规告警(决策观测点①)并改道 Boss,仅 Boss 收到 sendCommand', async () => {
    mockAgents.push({ id: 'v1', name: '小美', class: 'claude', status: 'idle' });
    mockAgents.push({ id: 'vb', name: '大当家', class: 'boss', isBoss: true, status: 'idle' });
    const sentences: string[] = [];
    const p = startProcess('让小美做登录页', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'v1',
      messageToAgent: '做登录页',
      responseToUser: '已让小美去做。', // 模型误话术:不得播出
    }), { via: 'delta' });

    const r = await p;
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('vb', 'BOSS:做登录页', 'sys:vb');
    expect(r.targetAgent).toEqual({ id: 'vb', name: '大当家' });
    expect(r.response).toContain('只能把任务交给主管');
    // 违规改道必须丢弃模型原话术(「已让小美去做」不得播出)——防未来误删 discardHop1 无回归护栏
    expect(sentences.join('')).not.toContain('已让小美去做');

    const rows = querySystemLog({ category: 'delegation', order: 'asc' });
    const blocked = rows.find((row) => logBody(row).phase === 'blocked' && logBody(row).toAgentId === 'v1');
    expect(blocked).toBeDefined();
    expect(blocked?.level).toBe('warn');
    expect(logBody(blocked!)).toMatchObject({
      cat: 'delegation', phase: 'blocked', status: 'direct-dispatch-blocked', routedBy: 'send_to_agent',
    });
    const rerouted = rows.find((row) => logBody(row).phase === 'dispatched' && logBody(row).status === 'rerouted-to-boss');
    expect(rerouted).toBeDefined();
    expect(logBody(rerouted!).routedBy).toBe('send_to_agent-rerouted');
  });

  it('G6-1c delegate_to_boss 但团队没有主管 → 不派发,如实告知', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });
    const sentences: string[] = [];
    const p = startProcess('让团队做登录页', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'delegate_to_boss',
      messageToAgent: '做登录页',
      responseToUser: '已交给主管安排。',
    }), { via: 'delta' });

    const r = await p;
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(sentences).toEqual([]); // 派不出去就不播「已交给主管」
    expect(r.response).toContain('还没有主管');
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
    // 改① 后可打断的目标就是主管(Boss);普通 agent 的「停下 X」由主管去安排。
    mockAgents.push({ id: 'b3', name: '大当家', class: 'boss', isBoss: true, status: 'working' });
    let stoppedAt = 0;
    let sentAt = 0;
    stopAgentMock.mockImplementation(async () => {
      stoppedAt = Date.now();
    });
    sendCommandMock.mockImplementation(async () => {
      sentAt = Date.now();
    });
    const p = startProcess('马上改做别的');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'b3',
      messageToAgent: '改用方案B',
      delivery: 'interrupt',
      responseToUser: '',
    }));
    const r = await p;

    expect(stopAgentMock).toHaveBeenCalledWith('b3');
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('b3', 'BOSS:改用方案B', 'sys:b3');
    expect(stopAgentMock.mock.invocationCallOrder[0]).toBeLessThan(sendCommandMock.mock.invocationCallOrder[0]!);
    // P9:stopAgent 返回即走,不再垫固定 250ms(旧实现这里必然 ≥250)
    expect(sentAt - stoppedAt).toBeLessThan(200);
    expect(r.interrupted).toBe(true);
    expect(r.response).toContain('已打断');
    expect(r.response).toContain('大当家');
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

  it('G6-4b 待岗目标拒派:不吃错误路径,整段确定性话术说明原因与恢复方式', async () => {
    mockAgents.push({ id: 'b9', name: '大当家', class: 'boss', isBoss: true, status: 'idle', standby: true });
    const sentences: string[] = [];
    const p = startProcess('让大当家看日志', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'b9',
      targetAgentName: '大当家',
      messageToAgent: '看日志',
      responseToUser: '已让大当家去看。',
    }), { via: 'delta' });

    const r = await p;
    expect(sendCommandMock).not.toHaveBeenCalled(); // 不投递(底层守卫之外的前置拒绝)
    expect(stopAgentMock).not.toHaveBeenCalled();    // 不打断
    expect(sentences).toEqual([]);                   // 「已让X去做」不可信:流式缓冲丢弃
    expect(r.spoke).toBeUndefined();
    expect(r.response).toContain('大当家');
    expect(r.response).toContain('待岗');
    expect(r.response).toContain('恢复上岗');
  });

  it('G6-5 falls back when messageToAgent is empty', async () => {
    mockAgents.push({ id: 'b4', name: '大当家', class: 'boss', isBoss: true, status: 'idle' });
    const sentences: string[] = [];
    const p = startProcess('让大当家做那个', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'send_to_agent',
      targetAgentId: 'b4',
      messageToAgent: '',
      responseToUser: '',
    }), { via: 'delta' });

    const r = await p;
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(sentences).toEqual([]);
    expect(r.response).toContain('没听清要让它做什么');
  });

  it('G6-6 answers query_agent_output with a second hop(no resume, hop2 prompt, hop1 过渡话术先播)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle', taskLabel: '登录页' });
    mockHistory = [
      { type: 'assistant', content: '完成了登录页' },
      { type: 'assistant', content: '又修了一个 bug' },
      { type: 'user', content: '用户消息应被忽略' },
    ];

    const sentences: string[] = [];
    const metas: (undefined | { pre?: boolean })[] = [];
    const p = startProcess('小美最近干了什么', {
      onSentence: (s, m) => {
        sentences.push(s);
        metas.push(m);
      },
    });
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBe('sess-1');
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'a1',
      query: '最近干了什么',
      responseToUser: '在,我去看一眼。',
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
    // W4:过渡话术照播(带 pre,不参与客户端最终对账),hop2 答案随后跟播(不带 pre)。
    expect(sentences).toEqual(['在,我去看一眼。', '小美刚完成了登录页,还修了一个 bug。']);
    expect(metas).toEqual([{ pre: true }, undefined]);
    expect(r.spoke).toBe(true);
  });

  it('G6-6b query 目标不存在:过渡句不出声也不当答案,确定性兜底(W4)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    const sentences: string[] = [];
    const p = startProcess('幽灵最近干了什么', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'nope',
      targetAgentName: '幽灵',
      query: '最近干了什么',
      responseToUser: '在,我去看一眼。',
    }), { via: 'delta' });

    const r = await p;
    expect(sentences).toEqual([]); // 没查成功:过渡句丢弃(不空应声)
    expect(spawnCalls).toHaveLength(1); // 不跑第二跳
    expect(r.response).toBe('没找到这个 agent(幽灵)。'); // 不拿过渡话术当整段答案
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
    const p = startProcess('⟦系统事件⟧ 一切正常', { isEvent: true, onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'noop', responseToUser: '不该出声。' }), { via: 'delta' });

    const r = await p;
    expect(r.action).toBe('noop');
    expect(r.response).toBe('');
    expect(sentences).toEqual([]);
    const stdin = stdinUserContent(call);
    expect(stdin).toContain('⟦系统事件⟧');
    expect(stdin).not.toContain('【格式】'); // isEvent 且无 resume → 不追加
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

  it('G6-9b 待岗者不计入忙/闲,单独点名报出(「团队谁有空」排除待岗者)', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'working' });
    mockAgents.push({ id: 'a2', name: '阿强', class: 'claude', status: 'idle' });
    mockAgents.push({ id: 'a3', name: '张豪年', class: 'claude', status: 'idle', standby: true });
    const p = startProcess('现在谁有空');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'list_agents', responseToUser: '' }));

    const r = await p;
    expect(r.response).toContain('3 个 agent');
    expect(r.response).toContain('1 个在忙:小美');
    expect(r.response).toContain('其余 1 个空闲'); // 空闲只数在岗者(2 在岗 − 1 忙)
    expect(r.response).toContain('另有 1 个待岗:张豪年,需你恢复');
  });

  it('G6-9c 全员待岗:如实报「全部待岗」,不报空闲', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle', standby: true });
    mockAgents.push({ id: 'a2', name: '阿强', class: 'claude', status: 'idle', standby: true });
    const p = startProcess('现在谁有空');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'list_agents', responseToUser: '' }));

    const r = await p;
    expect(r.response).toContain('全部待岗');
    expect(r.response).not.toContain('空闲');
  });

  it('G6-9d list_agents 话术静默:模型流式文本不出声,由最终回复整段补播(一问两答回归钉)', async () => {
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle' });
    const sentences: string[] = [];
    const p = startProcess('现在谁有空', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'list_agents',
      responseToUser: '闲人一堆,小美现在空着。',
    }), { via: 'delta' });

    const r = await p;
    // 静默门:hop1 话术一字不出(否则它先被播出,回合收尾客户端 final 对账
    // 发现已播≠最终回复,又把兜底名单整段重播 → 一次提问听两遍);
    // spoke 缺省(仅出声才置 true)→ 客户端按 result.response 整段补播一次。
    expect(sentences).toEqual([]);
    expect(r.spoke).toBeUndefined();
    expect(r.response.length).toBeGreaterThan(0);
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

  it('G6-11 gates the delegate_to_boss confirmation until dispatch to the Boss succeeds', async () => {
    mockAgents.push({ id: 'b5', name: '大当家', class: 'boss', isBoss: true, status: 'idle' });
    const order: string[] = [];
    sendCommandMock.mockImplementation(async () => {
      order.push('send');
    });
    const p = startProcess('让团队去做', { onSentence: (s) => order.push(`sentence:${s}`) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'delegate_to_boss',
      targetAgentId: null,
      messageToAgent: '做登录页',
      responseToUser: '已交给主管安排。',
    }), { via: 'delta' });

    const r = await p;
    expect(order).toEqual(['send', 'sentence:已交给主管安排。']); // 派发成功后才出声
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

  it('G6-14 grace-flushes a dangling first sentence after ~180ms of silence (P5)', async () => {
    const sentences: string[] = [];
    const p = startProcess('喘口气', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    // action 与首句同帧到达,句号悬在缓冲末尾:正常切句要等下一个字符
    emitLine(call.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"action":"general_response","responseToUser":"第一句。' } },
    });
    expect(sentences).toEqual([]); // 悬尾按住(宽限期内)
    await new Promise((r) => setTimeout(r, 300)); // > GRACE_FLUSH_MS(180ms)
    expect(sentences).toEqual(['第一句。']); // 宽限 flush 先吐,不再白等
    emitLine(call.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '第二句。","targetAgentId":null}' } },
    });
    expect(sentences).toEqual(['第一句。', '第二句。']); // 后续不重不漏
    await closeChild(call.child, 0);
    const r = await p;
    expect(r.response).toBe('第一句。第二句。');
    expect(r.spoke).toBe(true);
  });

  it('G6-15 falls back to a canned line when general_response carries no text(P9)', async () => {
    const sentences: string[] = [];
    const p = startProcess('在吗', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '' }));

    const r = await p;
    expect(r.action).toBe('general_response');
    expect(r.response).toBe('嗯,我在。');
    expect(sentences).toEqual([]); // 模型没吐过整句
    expect(r.spoke).toBeFalsy(); // 客户端按 spoke=false 整段补播兜底话术
  });
});

// ============================================================================
// W5 慢档续垫 · 双垫加固(真麦教训:垫话与 query 过渡句前后脚播出)
//
// 修复语义:hop1 一动笔(首个 text_delta,整句尚未闭合)即取消在途垫话 ——
// 不能等「整句出闸」才取消:query 过渡句在 SpeechGate 里缓到目标解析后才放行
// (实测 ~9.1s),而垫话吐出底线是 max(armMs+emitMs, 生成就绪≈8.0–8.8s),
// 取消来晚一步就会「垫话 8.8s + 过渡句 9.1s」双出声。
// ============================================================================

describe('W5 慢档续垫:hop1 首字节即取消(双垫加固)', () => {
  it('垫话已生成就绪,hop1 刚出文本(整句未闭合)就一票否决;整句闭合后只播真实回复', async () => {
    // 阈值压到下限(armMs≥500 / emitMs≥1000 为 clamp 下限),让状态机在百 ms 级可观测。
    writeConfig({ brain: { ...DEFAULT_TEST_CONFIG.brain, slowFiller: { enabled: true, armMs: 500, emitMs: 1_000 } } });

    const sentences: Array<{ text: string; pre: boolean }> = [];
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p = startProcess('查一下主管在干什么', {
        onSentence: (s, meta) => sentences.push({ text: s, pre: !!meta?.pre }),
      });

      const hop1 = await waitSpawn(1);
      // armMs=500 后垫话开始预生成(第二个 spawn:一次性调用,不碰常驻)。
      await waitFor(() => spawnCalls.length >= 2, '垫话生成 spawn', 2_000);
      const filler = spawnCalls[1];
      // C13/C19:垫话生成零工具(跳过 MCP + 禁全部内置工具,--tools 为变参须收尾);
      // 主链路走白名单档(5 内置 + 过滤后 MCP),并带中立 cwd(隔断仓库 CLAUDE.md 注入)。
      expect(filler.args).toContain('--strict-mcp-config');
      expect(filler.args[filler.args.length - 2]).toBe('--tools');
      expect(filler.args[filler.args.length - 1]).toBe(process.platform === 'win32' ? '""' : '');
      expect(hop1.args).toContain('--strict-mcp-config');
      expect(hop1.args).toContain('--mcp-config');
      expect(hop1.args[hop1.args.length - 1]).toBe('WebSearch,WebFetch,Read,Glob,Grep');
      expect(hop1.opts.cwd).toBe(path.join(dataHome!, 'tide-commander', 'voice-cwd'));
      // C18:垫话提示词要求「顺着内容接、别答非所问」(多样性改由服务端记忆注入,不再靠提示词给整句示例)。
      expect(fs.readFileSync(promptFileOf(filler), 'utf-8')).toContain('别答非所问');
      emitLine(filler.child, { type: 'result', result: '稍等，我确认一下。' });
      await closeChild(filler.child, 0); // 生成就绪(服务端会打「慢档垫话:…」日志)

      // hop1 开始出文本但整句未闭合 —— 此刻就该取消(而不是等句子出闸)。
      emitLine(hop1.child, {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"action":"general_response","responseToUser":"我看看' } },
      });
      // 睡过吐出底线(armMs+emitMs=1500ms;取消发生在 ~500ms 后不久)。
      await new Promise((r) => setTimeout(r, 1_400));

      expect(sentences.filter((s) => s.pre)).toEqual([]); // 垫话已就绪也一票否决
      // 反蒙混:证明生成确实跑完并打了日志(不是「没就绪所以没吐」碰巧通过)。
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('慢档垫话'))).toBe(true);

      // 正常收尾:整句闭合 → 唯一出声的是真实回复。
      emitLine(hop1.child, {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '，主管在整理日志。","targetAgentId":null}' } },
      });
      await closeChild(hop1.child, 0);

      const r = await p;
      expect(r.response).toBe('我看看，主管在整理日志。');
      expect(sentences).toEqual([{ text: '我看看，主管在整理日志。', pre: false }]);
      expect(spawnCalls).toHaveLength(2); // 只有 hop1 + 垫话生成,无多余进程
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ============================================================================
// 静态垫话(垫话 v2 默认档,2026-10-06)
//
// 动机:动态生成句「假/前言不搭」三根因 —— ①拿半句 partial 生成 ②输入无上下文
// ③提示词逼模型换说法带话题。静态档从场景无关短池选句(voice/filler-phrases.ts),
// 不读 partial、不喂上下文、不让模型造句;池句全过 filler-guard(专测锁定)。
// llm 动态档保留为 TC_VOICE_FILLER_MODE=llm 实验开关(上方 W5/C18/C21 用例即该档)。
// ============================================================================

describe('静态垫话:池内选句、零生成 spawn、连续不重样', () => {
  it('慢回合从池内选句经 pre 通道吐出(无垫话 spawn);下一回合避开上一句', async () => {
    vi.stubEnv('TC_VOICE_FILLER_MODE', 'static');
    writeConfig({ brain: { ...DEFAULT_TEST_CONFIG.brain, slowFiller: { enabled: true, armMs: 500, emitMs: 1_000 } } });

    const sentences: Array<{ text: string; pre: boolean }> = [];
    const first = startProcess('帮我看看今天的安排', {
      onSentence: (s, meta) => sentences.push({ text: s, pre: !!meta?.pre }),
    });
    await waitSpawn(1);
    await waitFor(() => sentences.some((s) => s.pre), '回合1 静态垫话吐出', 3_000);
    const phrase1 = sentences.find((s) => s.pre)?.text ?? '';
    expect(STATIC_FILLER_PHRASES).toContain(phrase1);
    expect(spawnCalls).toHaveLength(1); // 静态档零生成:全程只有 hop1,没有垫话 spawn

    await completeWith(spawnCalls[0]!.child, contractText({ action: 'general_response', responseToUser: '今天三件事。' }));
    const r1 = await first;
    expect(r1.response).toBe('今天三件事。'); // 回合正常收尾(非流式档:客户端按 response 整段补播)

    // 第二回合(同档同样慢):选句须避开最近用过的(环缓冲保留 3 条)。
    sentences.length = 0;
    const second = startProcess('再帮我排一下优先级', {
      onSentence: (s, meta) => sentences.push({ text: s, pre: !!meta?.pre }),
    });
    await waitSpawn(2);
    await waitFor(() => sentences.some((s) => s.pre), '回合2 静态垫话吐出', 3_000);
    const phrase2 = sentences.find((s) => s.pre)?.text ?? '';
    expect(STATIC_FILLER_PHRASES).toContain(phrase2);
    expect(phrase2).not.toBe(phrase1); // 「别连续同款」

    await completeWith(spawnCalls[1]!.child, contractText({ action: 'general_response', responseToUser: '排好了。' }));
    await second;
    expect(spawnCalls).toHaveLength(2); // 两个 hop1,零垫话生成
  });
});

// ============================================================================
// 垫话 v2 反冲(2026-10-07,用户真麦反馈「垫语出现两次」)
//
// 事故:静态档垫话 3.0s 吐出「好嘞」→ hop1 6.1s 解析出 query_agent_output →
// 过渡句「在,我去看一眼」照常放行,一回合两句短垫前后脚(隔 3.1s)。
// W5 的「hop1 首字节即取消」只堵在途垫话;静态档零生成、emitMs 到点即吐,
// 早于 hop1 首字节,取消永远来不及 —— 出口闸落在 releaseHop1 前的反冲抑制窗。
// ============================================================================

describe('垫话 v2 反冲:垫话刚出声 → query 过渡句不再叠加', () => {
  it('垫话 1s 吐出后 hop1 解析 query:过渡句被抑制(唯一 pre 句是垫话),hop2 照常两跳', async () => {
    vi.stubEnv('TC_VOICE_FILLER_MODE', 'static');
    writeConfig({ brain: { ...DEFAULT_TEST_CONFIG.brain, slowFiller: { enabled: true, armMs: 500, emitMs: 1_000 } } });
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push({ id: 'a1', name: '小美', class: 'claude', status: 'idle', taskLabel: '登录页' });
    mockHistory = [{ type: 'assistant', content: '完成了登录页' }];

    const sentences: string[] = [];
    const metas: (undefined | { pre?: boolean })[] = [];
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p = startProcess('小美最近干了什么', {
        onSentence: (s, m) => {
          sentences.push(s);
          metas.push(m);
        },
      });
      const call1 = await waitSpawn(1);
      // 静态垫话 1.0s 吐出(零生成 spawn,池内选句)。
      await waitFor(() => metas.some((m) => m?.pre), '垫话吐出', 3_000);

      // hop1 随即解析为 query —— 垫话刚出声,落在抑制窗内。
      await completeWith(call1.child, contractText({
        action: 'query_agent_output',
        targetAgentId: 'a1',
        query: '最近干了什么',
        responseToUser: '在,我去看一眼。',
      }), { via: 'delta' });

      const call2 = await waitSpawn(2); // hop2 照常(抑制的只是过渡话术)
      await completeWith(call2.child, '{"responseToUser":"小美刚完成了登录页。"}', { via: 'delta' });

      const r = await p;
      expect(r.response).toBe('小美刚完成了登录页。');
      const pre = sentences.filter((_, i) => metas[i]?.pre);
      const normal = sentences.filter((_, i) => !metas[i]?.pre);
      expect(pre).toHaveLength(1); // 唯一 pre = 垫话本身
      expect(STATIC_FILLER_PHRASES).toContain(pre[0]);
      expect(normal).toEqual(['小美刚完成了登录页。']); // 过渡句「在,我去看一眼。」被出口闸挡下
      expect(sentences).not.toContain('在,我去看一眼。');
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('过渡句抑制'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ============================================================================
// C18 垫话提示词 v3:顺着内容接(别答非所问)+ 服务端「最近应过」记忆强制换说法
//
// C17 教训:提示词里给整句示例(「好嘞,我捋捋」)会被模型逐字照抄 —— 示例越通用越像模板。
// 修法:①提示词删整句示例、改按类别示样(照抄类别句式仍贴题);②服务端把实际产出
// 记进环缓冲(保留 3 条),注入下一次生成,跨次不重样。
// ============================================================================

describe('C18 垫话:提示词按内容接 + 跨次换说法(服务端记忆)', () => {
  it('生成成功记入记忆;下一次生成请求带「最近你已经应过」且含上一条', async () => {
    writeConfig({ brain: { ...DEFAULT_TEST_CONFIG.brain, slowFiller: { enabled: true, armMs: 500, emitMs: 1_000 } } });

    // ── 第 1 轮:垫话生成成功「我瞅瞅天气哈」→ 记入服务端记忆 ──
    const p1 = startProcess('看下天气', { onSentence: () => {} });
    const hop1 = await waitSpawn(1);
    await waitFor(() => spawnCalls.length >= 2, '第 1 轮垫话生成 spawn', 2_000);
    const f1 = spawnCalls[1];
    expect(fs.readFileSync(promptFileOf(f1), 'utf-8')).toContain('别答非所问'); // C18 提示词
    emitLine(f1.child, { type: 'result', result: '我瞅瞅天气哈。' });
    await closeChild(f1.child, 0); // 生成就绪 → push 进环缓冲
    emitLine(hop1.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `{"action":"general_response","responseToUser":"今天晴。","targetAgentId":null}` } },
    });
    await closeChild(hop1.child, 0);
    await p1;

    // ── 第 2 轮:新一轮生成请求应带上记忆(含上一条),强制换说法 ──
    const before = spawnCalls.length;
    const p2 = startProcess('今天几号', { onSentence: () => {} });
    const hop2 = await waitSpawn(before + 1);
    const f2 = await waitSpawn(before + 2);
    const user2 = stdinUserContent(f2);
    expect(user2).toContain('老板刚才说:「今天几号」');
    expect(user2).toContain('最近你已经应过');
    expect(user2).toContain('我瞅瞅天气哈'); // 上一条实际产出
    expect(user2).toContain('别重样');

    emitLine(f2.child, { type: 'result', result: '我翻翻日历哈。' });
    await closeChild(f2.child, 0);
    emitLine(hop2.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `{"action":"general_response","responseToUser":"5 号。","targetAgentId":null}` } },
    });
    await closeChild(hop2.child, 0);
    await p2;
  });
});

// ============================================================================
// 任务 03·尾 / 27·尾:接线尾(analyze_logs 自留区入口 + 记忆三挂点)
//
// 这里只验「接线」本身:真 processVoiceInput 编排 + 真契约解析,把两个新依赖模块
// 换成记录型替身 —— 日志分析的报告质量、记忆四层的读写规则已由各自单测/集成覆盖,
// 本组测的是「谁在什么时序调了谁」:
//   - 03:analyze_logs 契约 → runLogAnalysis(时间窗) → renderLogAnalysisReport → hop1 话术丢弃;
//   - 27:挂点1 先写后回应(capture 先于 hop1 spawn)、挂点2 轮换先 summarize+sweep 再清 session、
//        挂点3 memoryOps 双写(旧 CompanionMemory 通道保持生效)。
// ============================================================================

interface MemoryCapture {
  text: string;
  sessionId?: string;
  /** capture 发生时已发生的 spawn 数(0 = 先写后回应:落记忆先于 hop1 子进程) */
  spawnsAtCall: number;
}

const memoryWire: {
  captures: MemoryCapture[];
  bridges: Array<{ ops: ReadonlyArray<Record<string, unknown>>; sessionId?: string }>;
  summaries: Array<{ sessionId: string; summary: string }>;
  sweeps: number;
} = { captures: [], bridges: [], summaries: [], sweeps: 0 };

/** H3b 门控:captureUserTurn 挂起于此 Promise 直到测试显式释放(锁「真 await」而非调用序)。 */
let captureGate: Promise<void> | null = null;

vi.mock('../jarvis-core/memory/index.js', () => ({
  createMemoryStack: () => ({
    store: {},
    observer: {},
    engine: {
      captureUserTurn: async (text: string, opts: { sessionId?: string } = {}) => {
        memoryWire.captures.push({ text, sessionId: opts.sessionId, spawnsAtCall: spawnCalls.length });
        if (captureGate) await captureGate; // H3b:门控挂起(缺省 null 即时返回)
        return { entries: [], hits: [], skipped: 0, errors: [] };
      },
      captureAgentConfirmed: async () => null,
      captureInferred: async () => null,
      summarizeSession: async (input: { sessionId: string; summary: string }) => {
        memoryWire.summaries.push(input);
        return null;
      },
      bridgeVoiceMemoryOps: async (
        ops: ReadonlyArray<Record<string, unknown>>,
        opts: { sessionId?: string } = {},
      ) => {
        memoryWire.bridges.push({ ops, sessionId: opts.sessionId });
        return { entries: [], hits: [], skipped: 0, errors: [] };
      },
      sweep: async () => {
        memoryWire.sweeps += 1;
        return { expired: 0, overflow: 0, droppedCount: 0 };
      },
    },
  }),
}));

const logAnalysisCalls: Array<{ preset?: string }> = [];
const LOG_REPORT_SENTINEL = '【测试用四段日志报告】';

vi.mock('../log-analysis/index.js', () => ({
  runLogAnalysis: async (opts: { preset?: string }) => {
    logAnalysisCalls.push(opts);
    return { __fake: 'report' };
  },
  renderLogAnalysisReport: () => LOG_REPORT_SENTINEL,
}));

describe('任务03·尾:analyze_logs 自留区入口(真实 processVoiceInput 编排)', () => {
  beforeEach(() => {
    logAnalysisCalls.length = 0;
  });

  it('H1 analyze_logs:缺省时间窗=昨天,播报走渲染报告,hop1 话术被闸门丢弃', async () => {
    writeState({ sessionId: 'sess-ana', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao' });
    const sentences: string[] = [];
    const p = startProcess('秘书,查一下昨天的日志', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'analyze_logs',
      query: '昨天的日志',
      responseToUser: '（hop1 话术,不该播报）好的。',
    }), { via: 'delta' });

    const r = await p;
    expect(r.action).toBe('analyze_logs');
    expect(r.response).toBe(LOG_REPORT_SENTINEL); // 报告整段由 renderLogAnalysisReport 产出
    expect(typeof r.secondHopMs).toBe('number');
    expect(logAnalysisCalls).toHaveLength(1);
    expect(logAnalysisCalls[0]?.preset).toBe('yesterday');
    expect(sentences).toEqual([]); // hop1 的「好的。」丢弃,报告不走流式句子
    expect(r.spoke).toBeFalsy(); // 客户端按 spoke=false 整段补播报告
  });

  it('H2 analyze_logs:话里带「今天」→ 时间窗切到 today(query 为空时看原文)', async () => {
    writeState({ sessionId: 'sess-ana', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao' });
    const p = startProcess('看看今天出了哪些错');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'analyze_logs' }), { via: 'delta' });

    await p;
    expect(logAnalysisCalls).toHaveLength(1);
    expect(logAnalysisCalls[0]?.preset).toBe('today');
  });
});

describe('任务27·尾:记忆三挂点(真实 processVoiceInput 编排)', () => {
  beforeEach(() => {
    memoryWire.captures.length = 0;
    memoryWire.bridges.length = 0;
    memoryWire.summaries.length = 0;
    memoryWire.sweeps = 0;
    captureGate = null;
  });

  it('H3 挂点1:非事件输入在 hop1 spawn 之前先落工作记忆(先写后回应);系统事件不算用户陈述', async () => {
    writeState({ sessionId: 'sess-mem', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao' });
    const p = startProcess('以后都用中文回复我');
    const call = await waitSpawn(1);

    // 断言发生在 hop1 已 spawn 之后:spawnsAtCall=0 证明 capture 真的先于子进程。
    expect(memoryWire.captures).toHaveLength(1);
    expect(memoryWire.captures[0]).toMatchObject({
      text: '以后都用中文回复我',
      sessionId: 'sess-mem',
      spawnsAtCall: 0,
    });
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '好的。' }));
    await p;

    memoryWire.captures.length = 0;
    const p2 = startProcess('⟦系统事件⟧ 任务完成', { isEvent: true });
    const call2 = await waitSpawn(2);
    await completeWith(call2.child, contractText({ action: 'noop' }));
    await p2;
    expect(memoryWire.captures).toHaveLength(0); // 系统事件不落用户陈述
  });

  it('H3b 挂点1:capture 未 resolve 前不得 spawn(锁真 await,而非仅调用序)', async () => {
    writeState({ sessionId: 'sess-mem', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao' });
    let release!: () => void;
    captureGate = new Promise<void>((r) => { release = r; });
    const p = startProcess('以后都用中文回复我');

    // 给足宏任务周期:若服务端没 await capture,这段时间里 hop1 早就 spawn 了。
    await drainMicrotasks(50);
    await new Promise((r) => setTimeout(r, 20));
    expect(memoryWire.captures).toHaveLength(1); // capture 已进入(被门控挂起)
    expect(spawnCalls).toHaveLength(0);          // 未释放 → 严禁 spawn(先写后回应)

    captureGate = null;
    release();
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '好的。' }));
    await p;
    expect(memoryWire.captures[0]?.spawnsAtCall).toBe(0);
  });

  it('H4 挂点2:会话轮换先 summarize(旧 session)+ sweep,再清 session;下一跳不带 --resume', async () => {
    writeState({ sessionId: 'sess-old', sessionStartedAt: Date.now(), turns: 10, personaKey: 'doubao' });
    const p = startProcess('你好');
    const call = await waitSpawn(1);

    expect(memoryWire.summaries).toEqual([{ sessionId: 'sess-old', summary: '' }]);
    expect(memoryWire.sweeps).toBe(1);
    expect(memoryWire.captures[0]?.sessionId).toBeUndefined(); // 轮换先于挂点1:新会话从空 session 开始
    expect(resumeIdOf(call)).toBeNull(); // 清 session → 全新会话,不 resume 旧上下文

    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '在的。' }), { sessionId: 'sess-new' });
    const r = await p;
    expect(r.response).toBe('在的。');
  });

  it('H5 挂点3:契约 memoryOps 双写 bridgeVoiceMemoryOps,旧 CompanionMemory 通道保持生效', async () => {
    writeState({ sessionId: 'sess-mem', sessionStartedAt: Date.now(), turns: 1, personaKey: 'doubao' });
    const p = startProcess('以后叫我老板');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'general_response',
      responseToUser: '好的,老板。',
      memoryOps: [{ op: 'add', text: '称呼用户为老板' }],
    }));

    const r = await p;
    expect(r.response).toBe('好的,老板。');
    expect(memoryWire.bridges).toHaveLength(1);
    expect(memoryWire.bridges[0]?.ops).toMatchObject([{ op: 'add', text: '称呼用户为老板' }]);
    // H5 加固:挂点3 必须把当前会话 id 带给 vault(bridge 的 sessionId 透传)
    expect(memoryWire.bridges[0]?.sessionId).toBe('sess-mem');
    // 旧通道(applyMemoryOps)未被替换:vault 双写之外,state.memory 仍落盘
    const st = readStateFile();
    expect(st.memory.notes.some((n) => n.text === '称呼用户为老板')).toBe(true);
  });
});

// ============================================================================
// 任务07·④ 查进度走下属(query 链路修正,Spec §4.4 / 验收 ⑥2)
//
// 场景:老板问「团队那个任务到哪了」,hop1 把 query 目标解析成 Boss。
// 修复前材料来源 = Boss 自己的 excerpt(全是调度文本)→「查一下→没下文」;
// 修复后 = 委派树(最近委派 → 每个下属的 assistant 产出)汇总给 hop2。
// ============================================================================

describe('任务07·④ 查进度走下属(委派树 query)', () => {
  it('G7-1 Boss 目标触发委派树:材料含下属实质进展而非 Boss 调度话术(验收 ⑥2)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push(
      { id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'working', taskLabel: '统筹发布' },
      { id: 'a1', name: '小美', class: 'builder', status: 'idle' },
      { id: 'a2', name: '阿强', class: 'builder', status: 'working' },
    );
    // Boss 自己的历史只有调度文本(旧实现的材料来源)—— 修复后不应进入材料。
    mockHistoryByAgent.set('b1', [{ type: 'assistant', content: '已安排小美去做登录页' }]);
    // 小美:8 条 assistant(护栏只取最近 6 条)+ 1 条 user(必须被排除)。
    mockHistoryByAgent.set('a1', [
      ...Array.from({ length: 8 }, (_, i) => ({ type: 'assistant', content: `产出-${i}` })),
      { type: 'user', content: '用户消息不应出现' },
    ]);
    mockHistoryByAgent.set('a2', []); // working 中无产出
    seedDelegationHistory({
      b1: [
        delegationDecision({
          timestamp: 2_000, selectedAgentId: 'a2', selectedAgentName: '阿强',
          userCommand: '把接口层改一下', taskCard: { objective: '改造接口层' },
        }),
        delegationDecision({
          timestamp: 1_000, selectedAgentId: 'a1', selectedAgentName: '小美',
          userCommand: '把登录页重构成 React 18',
        }),
      ],
    });

    const sentences: string[] = [];
    const metas: (undefined | { pre?: boolean })[] = [];
    const p = startProcess('团队那个任务到哪了', {
      onSentence: (s, m) => {
        sentences.push(s);
        metas.push(m);
      },
    });
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'b1',
      targetAgentName: '大当家',
      query: '团队那个任务到哪了',
      responseToUser: '在,我去看一眼。',
    }), { via: 'delta' });

    const call2 = await waitSpawn(2);
    const hop2User = stdinUserContent(call2);
    expect(hop2User).toContain('产出-7');                          // 小美的实质产出
    expect(hop2User).toContain('产出-2');
    expect(hop2User).not.toContain('产出-1');                      // excerpt 护栏:只取最近 6 条
    expect(hop2User).not.toContain('产出-0');
    expect(hop2User).not.toContain('用户消息不应出现');             // 只取 assistant 消息
    expect(hop2User).toContain('正在做「改造接口层」,暂无实质进展'); // 行为定义 2:working 无产出
    expect(hop2User).not.toContain('已安排小美去做登录页');          // 不再拿 Boss 自己的调度文本
    expect([...historyQueriedIds].sort()).toEqual(['a1', 'a2']);   // 查的是下属,不是 Boss 自己

    await completeWith(call2.child, '{"responseToUser":"小美已经完成登录页重构,阿强还在改接口层。"}', { via: 'delta' });
    const r = await p;
    expect(r.response).toContain('小美');
    expect(r.targetAgent).toEqual({ id: 'b1', name: '大当家' });
    // W4:hop1 过渡话术照播(pre)+ hop2 答案。
    expect(sentences).toEqual(['在,我去看一眼。', '小美已经完成登录页重构,阿强还在改接口层。']);
    expect(metas).toEqual([{ pre: true }, undefined]);

    // 🔴④ 观测点:system_log 可查出 路由判定 / 查了哪些下属 / hop 次数 / 耗时 / 返回摘要
    const rows = queryChainRows();
    expect(rows[0]).toMatchObject({ phase: 'completed', route: 'boss-tree', targetAgentId: 'b1', hops: 2 });
    expect(rows[0]!.subordinateCount).toBe(2);
    expect([...(rows[0]!.subordinateIds as string[])].sort()).toEqual(['a1', 'a2']);
    expect(typeof rows[0]!.durationMs).toBe('number');
    expect(String(rows[0]!.responsePreview)).toContain('小美');
    expect(rows[1]).toMatchObject({ phase: 'request', route: 'boss-tree', targetAgentId: 'b1' });
  });

  it('G7-2 Boss 无委派记录:如实「未找到对应委派」,不跑 hop2(行为定义 3)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push({ id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'idle' });

    const p = startProcess('团队那个任务到哪了');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'b1',
      query: '团队那个任务到哪了',
    }));

    const r = await p;
    expect(r.response).toContain('未找到对应委派');
    expect(r.response).toContain('大当家');
    expect(r.degraded).toBeUndefined();
    expect(spawnCalls).toHaveLength(1); // 确定性话术,不开第二跳

    const rows = queryChainRows();
    expect(rows[0]).toMatchObject({ phase: 'completed', route: 'boss-tree', hops: 1, subordinateCount: 0 });
  });

  it('G7-3 普通 agent 目标行为不变:仍走自身 excerpt(route=single-agent)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push({ id: 'a1', name: '小美', class: 'builder', status: 'idle' });
    mockHistoryByAgent.set('a1', [{ type: 'assistant', content: '完成了登录页' }]);

    const p = startProcess('小美最近干了什么');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'a1',
      query: '最近干了什么',
    }));
    const call2 = await waitSpawn(2);
    const hop2User = stdinUserContent(call2);
    expect(hop2User).toContain('完成了登录页');
    expect(hop2User).not.toContain('以下为主管'); // 不走委派树材料
    expect(historyQueriedIds).toEqual(['a1']);

    await completeWith(call2.child, '{"responseToUser":"小美刚完成了登录页。"}');
    const r = await p;
    expect(r.response).toBe('小美刚完成了登录页。');

    const rows = queryChainRows();
    expect(rows[0]).toMatchObject({ phase: 'completed', route: 'single-agent', hops: 2 });
    expect(rows[0]!.subordinateIds).toBeUndefined();
  });

  it('G7-4 hop2 降级路径也留痕(phase=failed + degraded + error)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push({ id: 'a1', name: '小美', class: 'builder', status: 'idle' });
    mockHistoryByAgent.set('a1', [{ type: 'assistant', content: '完成了登录页' }]);

    const p = startProcess('小美最近干了什么');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'a1',
      query: '最近干了什么',
    }));
    const call2 = await waitSpawn(2);
    await closeChild(call2.child, 1); // 第二跳失败 → 确定性摘要兜底

    const r = await p;
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('「小美」最近的输出:');

    const rows = queryChainRows();
    expect(rows[0]).toMatchObject({ phase: 'failed', route: 'single-agent', hops: 2, degraded: true });
    expect(typeof rows[0]!.error).toBe('string');
    expect(rows[0]!.error).not.toBe('');
  });

  it('G7-5 委派史超限:只取最近 5 条、同下属保留最新(锁 vcs 真调 pickRecentDelegations)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push(
      { id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'working' },
      ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id, i) => ({ id, name: `下属${i + 1}`, class: 'builder', status: 'working' })),
    );
    // 7 条委派:a1 有新旧两条(去重应保留 3000 的新任务),a2(2000)最旧应被 limit=5 挤出。
    seedDelegationHistory({
      b1: [
        delegationDecision({ timestamp: 1_000, selectedAgentId: 'a1', selectedAgentName: '下属1', userCommand: '旧任务甲' }),
        delegationDecision({ timestamp: 2_000, selectedAgentId: 'a2', selectedAgentName: '下属2', userCommand: '被挤出的任务' }),
        delegationDecision({ timestamp: 3_000, selectedAgentId: 'a1', selectedAgentName: '下属1', userCommand: '新任务甲' }),
        delegationDecision({ timestamp: 4_000, selectedAgentId: 'a3', selectedAgentName: '下属3', userCommand: '任务丙' }),
        delegationDecision({ timestamp: 5_000, selectedAgentId: 'a4', selectedAgentName: '下属4', userCommand: '任务丁' }),
        delegationDecision({ timestamp: 6_000, selectedAgentId: 'a5', selectedAgentName: '下属5', userCommand: '任务戊' }),
        delegationDecision({ timestamp: 7_000, selectedAgentId: 'a6', selectedAgentName: '下属6', userCommand: '任务己' }),
      ],
    });

    const p = startProcess('团队那个任务到哪了');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'b1',
      query: '团队那个任务到哪了',
    }));
    const call2 = await waitSpawn(2);
    const hop2User = stdinUserContent(call2);

    expect(hop2User).toContain('共 5 条');          // limit=5 生效(若传全量史则是「共 7 条」)
    expect(hop2User).toContain('任务己');
    expect(hop2User).toContain('新任务甲');          // 同下属去重:保留最近一条
    expect(hop2User).not.toContain('旧任务甲');      // 更早的 a1 委派不得出现
    expect(hop2User).not.toContain('被挤出的任务');  // 最旧的 a2 被 limit 挤出
    expect([...historyQueriedIds].sort()).toEqual(['a1', 'a3', 'a4', 'a5', 'a6']); // 没查被挤出的 a2

    await completeWith(call2.child, '{"responseToUser":"最近的委派都在这儿了。"}');
    const r = await p;
    expect(r.response).toContain('委派');
    const rows = queryChainRows();
    expect(rows[0]).toMatchObject({ phase: 'completed', route: 'boss-tree', hops: 2, subordinateCount: 5 });
  });

  it('G7-6 ⑧ 病历:已完成的委派输出执行者/耗时/产出/评价(任务11 编排层透传链)', async () => {
    writeState({ sessionId: 'sess-1', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    mockAgents.push(
      { id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'working' },
      { id: 'a1', name: '小美', class: 'builder', status: 'idle' },
    );
    // 下属无 excerpt:病历行优先于产出三分支(恰好锁「完成行优先」,不因无产出退化成「正在做」)
    mockHistoryByAgent.set('a1', []);
    seedDelegationHistory({
      b1: [
        delegationDecision({
          timestamp: 1_000, selectedAgentId: 'a1', selectedAgentName: '小美',
          userCommand: '把登录页重构成 React 18',
          completion: {
            completedAt: 751_000,
            durationMs: 750_000,
            result: 'completed',
            summary: '登录页重构完成，测试全绿',
            outputLocation: '/reports/login.md',
            reason: 'report-task',
          },
          userRating: 'satisfied',
        }),
      ],
    });

    const p = startProcess('团队那个任务到哪了');
    const call1 = await waitSpawn(1);
    await completeWith(call1.child, contractText({
      action: 'query_agent_output',
      targetAgentId: 'b1',
      query: '团队那个任务到哪了',
    }));

    const call2 = await waitSpawn(2);
    const hop2User = stdinUserContent(call2);
    // ⑧ 病历行:执行者 + 耗时 + 产出 + 产出位置 + 评价(decision.completion/userRating → entry 透传)
    expect(hop2User).toContain('【小美】任务「把登录页重构成 React 18」已完成（耗时 12.5 分钟）');
    expect(hop2User).toContain('产出: 登录页重构完成，测试全绿');
    expect(hop2User).toContain('产出位置: /reports/login.md');
    expect(hop2User).toContain('评价: 满意');
    expect(hop2User).not.toContain('正在做');

    await completeWith(call2.child, '{"responseToUser":"小美的登录页重构已完成，产出在 reports/login.md。"}');
    const r = await p;
    expect(r.response).toContain('小美');
    expect(r.targetAgent).toEqual({ id: 'b1', name: '大当家' });
  });
});

// ============================================================================
// 任务13·⑩ 秘书 Bolba 桥(业务待办:查/建/完成/重开;两本账不混)
//
// 与 bolba-bridge-service.test.ts(纯函数)互补:这里跑真实 processVoiceInput
// 的契约 → 分派 → finish 全链路,只 mock fetch(Bolba HTTP)与既有系统边界。
// ============================================================================

describe('B 任务13·⑩ Bolba 桥(业务待办)', () => {
  const originalUrl = process.env.BOLBA_TASKS_URL;
  const originalToken = process.env.BOLBA_TASKS_TOKEN;

  /** 本地日历日字符串(与服务端 classifyBolbaDue 同口径)。 */
  function dayStr(offset: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 镜像 bolba-bridge 周口径:「周X」= 含今天在内的下一次(周一为一周之始)。 */
  function upcomingWeekday(target: number): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monday = new Date(today);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const candidate = new Date(monday);
    candidate.setDate(candidate.getDate() + ((target + 6) % 7));
    if (candidate.getTime() < today.getTime()) candidate.setDate(candidate.getDate() + 7);
    return `${candidate.getFullYear()}-${`${candidate.getMonth() + 1}`.padStart(2, '0')}-${`${candidate.getDate()}`.padStart(2, '0')}`;
  }

  function bolbaJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  beforeEach(() => {
    process.env.BOLBA_TASKS_URL = 'http://127.0.0.1:9876';
    process.env.BOLBA_TASKS_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.BOLBA_TASKS_URL;
    else process.env.BOLBA_TASKS_URL = originalUrl;
    if (originalToken === undefined) delete process.env.BOLBA_TASKS_TOKEN;
    else process.env.BOLBA_TASKS_TOKEN = originalToken;
  });

  it('B1 问「我今天有什么要盯的」→ 服务端渲染 due 列表;hop1 话术不流式出声;两本账不混', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => bolbaJson({
      count: 2,
      tasks: [
        { id: 5301, title: '准备 BOL-4472 报价', status: 'open', proj: 'BOL', due: dayStr(0) },
        { id: 5302, title: '付款 ALT', status: 'open', proj: 'MDO', due: dayStr(-1) },
        { id: 5399, title: '已完成的', status: 'done', due: dayStr(0) },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const sentences: string[] = [];

    const p = startProcess('我今天有什么要盯的', { onSentence: (s) => sentences.push(s) });
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'query_bolba_tasks',
      responseToUser: '我先看看(这句不该播出去)。',
      query: '今天有什么要盯的',
    }), { via: 'delta' });

    const r = await p;
    expect(r.action).toBe('query_bolba_tasks');
    expect(r.response).toContain('今天要盯 2 件');
    expect(r.response).toContain('准备 BOL-4472 报价');
    expect(r.response).toContain('已过期 1 天');
    expect(sentences.join('')).not.toContain('不该播'); // hop1 话术被显式 Bolba 门丢弃
    expect(spawnCalls).toHaveLength(1);                 // 服务端确定性产出,不开第二跳
    expect(sendCommandMock).not.toHaveBeenCalled();     // 绝不走 ① 委派通道
    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:9876/tasks');

    // 埋点:dialog out + broadcast 带 action;bolba-sync 读事件落 system_log
    const dialogRows = querySystemLog({ category: 'dialog', source: 'voice-companion', limit: 20 })
      .map((row) => logBody(row)).filter((b) => b.action === 'query_bolba_tasks');
    expect(dialogRows.length).toBeGreaterThan(0);
    const broadcastRows = querySystemLog({ category: 'broadcast', source: 'voice-companion', limit: 20 })
      .map((row) => logBody(row)).filter((b) => b.action === 'query_bolba_tasks');
    expect(broadcastRows.length).toBeGreaterThan(0);
    const syncRows = querySystemLog({ category: 'system', source: 'bolba', limit: 20 }).map((row) => logBody(row));
    expect(syncRows.some((b) => b.cat === 'bolba-sync' && b.op === 'query' && b.ok === true)).toBe(true);
  });

  it('B2 语音创建:「记一下,周五前准备 BOL-4472 报价」→ POST /tasks(title 无时间词 + due 计算值)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return bolbaJson({ id: 5310, task: { id: 5310, title: '准备 BOL-4472 报价' }, warnings: [] }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = startProcess('记一下,周五前准备 BOL-4472 报价');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'create_bolba_task',
      bolbaTask: '准备 BOL-4472 报价',
    }), { via: 'delta' });

    const r = await p;
    expect(r.action).toBe('create_bolba_task');
    expect(r.response).toContain('记下了');
    expect(r.response).toContain('准备 BOL-4472 报价');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:9876/tasks');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      title: '准备 BOL-4472 报价',
      due: upcomingWeekday(5),
    });
    // 两本账负断言:业务待办绝不触碰 ① 委派通道。
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(stopAgentMock).not.toHaveBeenCalled();

    const syncRows = querySystemLog({ category: 'system', source: 'bolba', limit: 20 }).map((row) => logBody(row));
    expect(syncRows.some((b) => b.op === 'create' && b.ok === true)).toBe(true);
  });

  it('B3 「X 做完了」→ 按标题解析编号 → POST /tasks/:id/close {status:done}', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'POST') return bolbaJson({ ok: true });
      return bolbaJson({ tasks: [{ id: 5301, title: '准备 BOL-4472 报价', status: 'open', proj: 'BOL' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = startProcess('准备 BOL-4472 报价做完了');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'complete_bolba_task',
      bolbaTask: '准备 BOL-4472 报价',
    }));

    const r = await p;
    expect(r.response).toContain('标记完成了');
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('http://127.0.0.1:9876/tasks/5301/close');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ status: 'done' });
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(stopAgentMock).not.toHaveBeenCalled();
  });

  it('B4 「重开 5302」→ POST /tasks/:id/reopen(编号直配)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'POST') return bolbaJson({ ok: true });
      return bolbaJson({ tasks: [{ id: 5302, title: '付款 ALT', status: 'open' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = startProcess('重开 5302');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'reopen_bolba_task',
      bolbaTask: '5302',
    }));

    const r = await p;
    expect(r.response).toContain('重开了');
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('http://127.0.0.1:9876/tasks/5302/reopen');
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(stopAgentMock).not.toHaveBeenCalled();
  });

  it('B5 板上没有 → 确定性「没找到」话术,不发任何 POST', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return bolbaJson({ tasks: [{ id: 5301, title: '别的活', status: 'open' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = startProcess('把不存在的活完成掉');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({
      action: 'complete_bolba_task',
      bolbaTask: '不存在的活',
    }));

    const r = await p;
    expect(r.response).toContain('没找到');
    expect(calls.every((c) => c.init?.method !== 'POST')).toBe(true);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(stopAgentMock).not.toHaveBeenCalled();
  });

  it('B6 Bolba 连不上 → degraded 透传(确定性降级话术,不抛)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const p = startProcess('今天有什么要盯的');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'query_bolba_tasks', query: '今天要盯的' }));

    const r = await p;
    expect(r.action).toBe('query_bolba_tasks');
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('连不上');

    const syncRows = querySystemLog({ category: 'system', source: 'bolba', limit: 20 }).map((row) => logBody(row));
    expect(syncRows.some((b) => b.ok === false)).toBe(true);
  });

  it('B7 闭环:完成→重开(done 列表命中被撤销的任务,真实场景走通)', async () => {
    // 有状态的假板:close 置 done、reopen 置 open,验证 reopen 候选含最近完成。
    let store = [{ id: 5301, title: '准备 BOL-4472 报价', status: 'open', proj: 'BOL' }];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (init?.method === 'POST') {
        if (u.includes('/close')) store = store.map((t) => (t.id === 5301 ? { ...t, status: 'done' } : t));
        else if (u.includes('/reopen')) store = store.map((t) => (t.id === 5301 ? { ...t, status: 'open' } : t));
        return bolbaJson({ ok: true });
      }
      if (u.includes('status=done')) return bolbaJson({ tasks: store.filter((t) => t.status === 'done') });
      return bolbaJson({ tasks: store.filter((t) => t.status === 'open') });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 第 1 回合:标记完成(在办列表同步清空)
    const p1 = startProcess('准备 BOL-4472 报价做完了');
    const c1 = await waitSpawn(1);
    await completeWith(c1.child, contractText({
      action: 'complete_bolba_task',
      bolbaTask: '准备 BOL-4472 报价',
    }));
    const r1 = await p1;
    expect(r1.response).toContain('标记完成了');

    // 第 2 回合:重开——在办列表已空,必须从 done 列表命中
    const p2 = startProcess('重开 准备 BOL-4472 报价');
    const c2 = await waitSpawn(2);
    await completeWith(c2.child, contractText({
      action: 'reopen_bolba_task',
      bolbaTask: '准备 BOL-4472 报价',
    }));
    const r2 = await p2;
    expect(r2.response).toContain('重开了');

    const posts = calls.filter((c) => c.init?.method === 'POST').map((c) => c.url);
    expect(posts).toEqual([
      'http://127.0.0.1:9876/tasks/5301/close',
      'http://127.0.0.1:9876/tasks/5301/reopen',
    ]);
    expect(calls.some((c) => c.url.includes('status=done&limit=8'))).toBe(true);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(stopAgentMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 任务36 · G8 故障注入(mock 传输,3 例)
//
// LLM 挂起超时 / 5xx 错误结果 / 畸形输出(全废话非 JSON)——全部在假子进程层注入。
// 统一断言口径:processVoiceInput 永不抛出、有确定性降级话术、落盘状态无半写
// (状态文件可解析、saveCompanionState 的原子 tmp 不残留)、会话不因故障重置。
// ============================================================================

describe('G8 故障注入(任务36)', () => {
  it('G8-1 LLM 挂起超时:降级兜底,SIGTERM 收尾,状态文件完整无半写', async () => {
    writeState({ sessionId: 'sess-hang', sessionStartedAt: Date.now(), turns: 3, personaKey: 'doubao' });
    vi.useFakeTimers();
    const p = startProcess('挂着不动');
    while (spawnCalls.length === 0) await Promise.resolve();
    const call = spawnCalls[0]!;
    const promptPath = promptFileOf(call);
    emitText(call.child, '{"action":"general_resp', 'delta'); // 半个契约到达后彻底挂起,不 close
    await vi.advanceTimersByTimeAsync(5_001); // > hop1TimeoutMs(5000)

    const r = await p; // 永不抛出:超时按降级处理
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('有点问题');
    expect(call.child.kills).toContain('SIGTERM');
    expect(fs.existsSync(promptPath)).toBe(false); // 临时提示词已清理

    const stored = readStateFile(); // 能 JSON.parse = 落盘无半写
    expect(stored.sessionId).toBe('sess-hang'); // 超时不重置会话
    expect(stored.turns).toBe(3); // 失败回合不计轮数
    expect(fs.existsSync(`${stateFilePath}.tmp`)).toBe(false); // 原子写不留 tmp
  });

  it('G8-2 LLM 返回错误结果(5xx 文案):降级兜底,错误原文不进用户回复,状态无半写', async () => {
    writeState({ sessionId: 'sess-5xx', sessionStartedAt: Date.now(), turns: 2, personaKey: 'doubao' });
    const p = startProcess('服务端报错了');
    const call = await waitSpawn(1);
    emitStderr(call.child, 'API Error: 500 Internal Server Error (upstream overloaded)');
    emitLine(call.child, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: 500 Internal Server Error (upstream overloaded)',
    });
    await closeChild(call.child, 1);

    const r = await p; // 永不抛出:错误文案当不可信输出,解析失败走降级
    expect(r.degraded).toBe(true);
    expect(r.response).toContain('有点问题');
    expect(r.response).not.toContain('500');
    expect(r.response).not.toContain('API Error');

    const stored = readStateFile();
    expect(stored.sessionId).toBe('sess-5xx');
    expect(stored.turns).toBe(2);
    expect(fs.existsSync(`${stateFilePath}.tmp`)).toBe(false);
  });

  it('G8-3 畸形输出(全废话非 JSON):降级不泄漏半截话,会话保留,下一轮恢复', async () => {
    writeState({ sessionId: 'sess-garbage', sessionStartedAt: Date.now(), turns: 4, personaKey: 'doubao' });
    const sentences: string[] = [];
    const p1 = startProcess('说点正经的', { onSentence: (s) => sentences.push(s) });
    const call1 = await waitSpawn(1);
    // 硬化(验证意见):必须走流式 delta 通道喂入——默认 assistant 通道不进播报管线,
    // 句子/spoke 断言会退化成构造上恒真的空断言。分两段 delta(先半句、再余下)后 close,
    // 让「非 responseToUser 字段的废话即使经增量到达也一字不得进播报队列」成为真断言。
    emitLine(call1.child, { type: 'system', subtype: 'init', session_id: 'sess-garbage-2' });
    emitText(call1.child, '嗯……让我先缓缓。', 'delta');
    emitText(call1.child, '今天天气不错,我们聊点别的吧,JSON 那些东西我不想碰。', 'delta');
    await closeChild(call1.child, 0);

    const r1 = await p1; // 永不抛出
    expect(r1.degraded).toBe(true);
    expect(r1.response).toContain('有点问题');
    expect(sentences).toEqual([]); // 畸形输出一字不得播(经 delta 通道真实喂入,非恒真空断言)
    expect(r1.spoke).toBeFalsy();

    const st1 = readStateFile(); // 可解析 = 无半写
    expect(st1.sessionId).toBe('sess-garbage-2'); // 解析失败也不重置会话(与 G5-5b 同口径)
    expect(st1.turns).toBe(4); // 轮数不计
    expect(fs.existsSync(`${stateFilePath}.tmp`)).toBe(false);

    // 故障不粘滞:下一轮带 --resume 续上会话,正常契约 → 正常回复
    const p2 = startProcess('现在说正经的');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-garbage-2');
    await completeWith(call2.child, contractText({ action: 'general_response', responseToUser: '好的,我在。' }));
    const r2 = await p2;
    expect(r2.response).toBe('好的,我在。');
    expect(r2.degraded).toBeUndefined();
  });
});

// ============================================================================
// 任务14·⑪ 秘书项目感知与路由(⑥ 验收)
//
// 证据等级如实:本 describe 是 L2(真实 processVoiceInput 编排 + 沙箱工作区/区域/
// 委派史 fixture,假 claude 子进程);L1 纯函数面在 jarvis-core/projects/*.test.ts 与
// voice-companion-service.project-routing.test.ts。L3(真人语音 E2E)未跑,不在本文件冒充。
// 世界:workspaces(项目A=areaA→主管 pbA / 项目B=areaB→主管 pbB)+ 1 普通成员;
// 区域夹具走 mockAreas(data/index loadAreas 替身),工作区/别名表走 XDG 沙箱真实读写。
// ============================================================================

describe('任务14·⑪ 秘书项目感知与路由', () => {
  const PROJ_BOSS_A = { id: 'pbA', name: '大当家A', class: 'boss', isBoss: true, status: 'idle' };
  const PROJ_BOSS_B = { id: 'pbB', name: '二当家B', class: 'boss', isBoss: true, status: 'idle' };
  const PROJ_WORKER = { id: 'pw1', name: '小工', class: 'claude', status: 'idle' };

  function areaDef(id: string, assignedAgentIds: string[], directories: string[]): DrawingArea {
    return {
      id,
      name: id,
      type: 'rectangle',
      center: { x: 0, z: 0 },
      width: 10,
      height: 10,
      color: '#336699',
      zIndex: 0,
      assignedAgentIds,
      directories,
    };
  }

  /** 沙箱内写工作区 fixture(项目A/项目B 各挂一个区域);activeWorkspaceId=null 即 All 状态。 */
  function seedWorkspaces(activeWorkspaceId: string | null): void {
    const now = Date.now();
    const mk = (id: string, name: string, areaIds: string[]): Record<string, unknown> => ({
      id, name, areaIds, createdAt: now - 3_600_000, updatedAt: now - 60_000,
    });
    fs.mkdirSync(path.dirname(workspacesFilePath), { recursive: true });
    fs.writeFileSync(workspacesFilePath, JSON.stringify({
      workspaces: [mk('pwsA', '项目A', ['parA']), mk('pwsB', '项目B', ['parB'])],
      activeWorkspaceId,
    }));
  }

  /** 两项目 + 两主管 + 一普通成员(pbA 是 agent 序首位,即现状兜底 Boss)。 */
  function deployTwoProjects(activeWorkspaceId: string | null = null): void {
    mockAgents.push({ ...PROJ_BOSS_A }, { ...PROJ_BOSS_B }, { ...PROJ_WORKER });
    mockAreas.push(areaDef('parA', ['pbA', 'pw1'], ['E:/proj/a']), areaDef('parB', ['pbB'], ['E:/proj/b']));
    seedWorkspaces(activeWorkspaceId);
  }

  /** ⑪ 观测行(系统日志 source='project-routing',按 body.text 唯一标记过滤;新→旧)。 */
  function projectRows(marker: string): Array<Record<string, unknown>> {
    return querySystemLog({ category: 'system', source: 'project-routing', limit: 50 })
      .map((row) => logBody(row))
      .filter((body) => typeof body.text === 'string' && body.text.includes(marker));
  }

  /** 跑一个完整派发回合(真 hop1 → 契约 → 派发/反问),返回进程结果。 */
  async function runDispatchTurn(text: string, messageToAgent: string): Promise<VoiceProcessResult> {
    const before = spawnCalls.length;
    const p = startProcess(text);
    await waitFor(() => spawnCalls.length >= before + 1, `spawn for ${text}`);
    const call = spawnCalls[before]!;
    await new Promise((r) => setTimeout(r, 0)); // 让 'spawn'(nextTick)写入 stdin
    await completeWith(call.child, contractText({
      action: 'delegate_to_boss',
      messageToAgent,
      delivery: 'queue',
      responseToUser: '已交给主管安排。',
    }));
    return p;
  }

  it('⑥1 快照注入:prompt 含【项目感知】+ 当前项目标记 + 各项目卡摘要(在做/主管)', async () => {
    deployTwoProjects('pwsB');
    seedDelegationHistory({
      pbA: [delegationDecision({
        timestamp: Date.now() - 2 * 3_600_000,
        selectedAgentId: 'pw1',
        selectedAgentName: '小工',
        userCommand: '整理报价单',
        bossId: 'pbA',
        taskCard: { objective: '整理报价单', projectId: 'pwsA' },
      })],
    });

    const p = startProcess('大家忙什么呢');
    const call = await waitSpawn(1);
    const prompt = fs.readFileSync(promptFileOf(call), 'utf-8');

    expect(prompt).toContain('【项目感知】');
    expect(prompt).toContain('- [当前] 项目B');
    expect(prompt).toContain('主管: 二当家B(pbB)');
    expect(prompt).toContain('- 项目A'); // 非当前项目也在卡列表
    expect(prompt).toContain('在做: 整理报价单'); // 卡摘要来自委派史(⑥6 派生链)
    await completeWith(call.child, contractText({ action: 'general_response', responseToUser: '都在忙。' }));
    await p;
  });

  it('⑥2 「让项目B的团队做 X」→ 路由到 Boss-B(别名层显式命中,⑪ route 观测)', async () => {
    deployTwoProjects(null);
    const r = await runDispatchTurn('让项目B的团队做登录页', '把登录页做出来');

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('pbB', 'BOSS:把登录页做出来', 'sys:pbB');
    expect(sendCommandMock.mock.calls.some((c) => c[0] === 'pbA')).toBe(false); // 首位 Boss 没被误派
    expect(r.targetAgent).toEqual({ id: 'pbB', name: '二当家B' });

    const rows = projectRows('让项目B的团队做登录页');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'route', layer: 'explicit', source: 'alias:项目b', projectId: 'pwsB',
      finalBossId: 'pbB', fallbackToFirstBoss: false, needAsk: false,
    });
  });

  it('⑥3 切到项目B 工作区后「让团队做 X」→ 当前项目主管 pbB(激活工作区信号)', async () => {
    deployTwoProjects('pwsB');
    const r = await runDispatchTurn('让团队做对账单', '把对账单做了');

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('pbB', 'BOSS:把对账单做了', 'sys:pbB');
    expect(r.targetAgent).toEqual({ id: 'pbB', name: '二当家B' });

    const rows = projectRows('让团队做对账单');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'route', layer: 'explicit', source: 'active-workspace', projectId: 'pwsB',
      finalBossId: 'pbB', fallbackToFirstBoss: false,
    });
  });

  it('⑥4 「那个报价的事」→ 关键词唯一命中项目A 不反问;委派史落在卡上可再次命中(⑥6)', async () => {
    deployTwoProjects(null);
    // 48h 前的委派(在 24h「最近委派」窗外;projectId 归属项目A)→ 只可能走关键词层
    seedDelegationHistory({
      pbA: [delegationDecision({
        timestamp: Date.now() - 48 * 3_600_000,
        selectedAgentId: 'pw1',
        selectedAgentName: '小工',
        userCommand: '整理报价单',
        bossId: 'pbA',
        taskCard: { objective: '整理报价单', projectId: 'pwsA' },
      })],
    });

    const before = spawnCalls.length;
    const p = startProcess('那个报价的事交给团队办一下');
    await waitFor(() => spawnCalls.length >= before + 1, 'spawn for 报价');
    const call = spawnCalls[before]!;
    await new Promise((r) => setTimeout(r, 0));
    // ⑥6:委派史已派生到项目A 卡「在做」,随快照进 prompt
    expect(fs.readFileSync(promptFileOf(call), 'utf-8')).toContain('在做: 整理报价单');
    await completeWith(call.child, contractText({
      action: 'delegate_to_boss',
      messageToAgent: '把报价的事办了',
      delivery: 'queue',
      responseToUser: '已交给主管安排。',
    }));
    const r = await p;

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('pbA', 'BOSS:把报价的事办了', 'sys:pbA');
    expect(r.targetAgent).toEqual({ id: 'pbA', name: '大当家A' });

    const rows = projectRows('那个报价的事交给团队办一下');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'route', layer: 'keyword', projectId: 'pwsA', finalBossId: 'pbA', needAsk: false });
    expect(String(rows[0].source)).toMatch(/^keyword:/);
  });

  it('⑥5 消不掉 → 反问一次(不派发);回答项目名 → 确定性直派,不再跑 hop1 也不再问', async () => {
    deployTwoProjects(null);

    // 回合1:All + 两主管 + 无别名/上下文/关键词信号 → need_ask,不派发
    const r1 = await runDispatchTurn('把登录页那个活安排一下', '把登录页做出来');
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(r1.action).toBe('delegate_to_boss');
    expect(r1.response).toContain('哪个项目');
    expect(r1.response).toContain('项目A');
    expect(r1.response).toContain('项目B');
    expect(spawnCalls).toHaveLength(1);
    const askRows = projectRows('把登录页那个活安排一下');
    expect(askRows).toHaveLength(1);
    expect(askRows[0]).toMatchObject({ kind: 'need-ask', needAsk: true, askCount: 1 });

    // 回合2:回答项目名(带口语后缀仍按别名子串命中) → 确定性解析直派(零 spawn = 不跑 hop1)
    const p2 = startProcess('项目B，就它了');
    const r2 = await p2;
    expect(spawnCalls).toHaveLength(1); // 没有第二次 claude 调用
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('pbB', 'BOSS:把登录页做出来', 'sys:pbB');
    expect(r2.targetAgent).toEqual({ id: 'pbB', name: '二当家B' });
    expect(r2.messageSent).toBe('把登录页做出来');
    expect(r2.response).toContain('二当家B');
    const resolvedRows = projectRows('就它了');
    expect(resolvedRows).toHaveLength(1);
    expect(resolvedRows[0]).toMatchObject({ kind: 'clarify-resolved', askCount: 1, finalBossId: 'pbB' });
  });

  it('⑥5 反问只一次:回答仍消不掉 → 回落首位 Boss 并登记(warn),绝不二次反问', async () => {
    deployTwoProjects(null);

    const r1 = await runDispatchTurn('把仓库那摊活安排一下', '把仓库整理一遍');
    expect(r1.response).toContain('哪个项目');
    expect(spawnCalls).toHaveLength(1);

    const p2 = startProcess('你看着办吧');
    const r2 = await p2;
    expect(spawnCalls).toHaveLength(1); // 回答不跑 hop1(确定性消费)
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('pbA', 'BOSS:把仓库整理一遍', 'sys:pbA'); // 回落首位 Boss
    expect(r2.targetAgent).toEqual({ id: 'pbA', name: '大当家A' });
    expect(r2.response).toContain('我先交给');

    const askRows = projectRows('把仓库那摊活安排一下');
    expect(askRows).toHaveLength(1); // 只问了这一次
    expect(askRows[0]).toMatchObject({ kind: 'need-ask', askCount: 1 });
    const fallbackRows = projectRows('你看着办吧');
    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0]).toMatchObject({ kind: 'clarify-fallback', fallbackToFirstBoss: true, finalBossId: 'pbA' });
  });

  it('⑥5 回答取消话术 → 丢弃挂起任务(clarify-abandoned),不派发不反问', async () => {
    deployTwoProjects(null);

    const r1 = await runDispatchTurn('把周报整理一下', '整理周报');
    expect(r1.response).toContain('哪个项目');

    const p2 = startProcess('算了，这活先不做了');
    const r2 = await p2;
    expect(spawnCalls).toHaveLength(1);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(r2.response).toBe('好，这活先不派了。');
    const rows = projectRows('算了，这活先不做了');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'clarify-abandoned', askCount: 1 });
  });

  it('开关关(TC_JARVIS_PROJECT_ROUTING=0)= 现状零变化:不注快照、别名不生效、回落首位 Boss、零 ⑪ 观测', async () => {
    process.env.TC_JARVIS_PROJECT_ROUTING = '0';
    try {
      deployTwoProjects(null);
      const before = spawnCalls.length;
      const p = startProcess('让项目B的团队做结算页');
      await waitFor(() => spawnCalls.length >= before + 1, 'spawn for 结算页');
      const call = spawnCalls[before]!;
      await new Promise((r) => setTimeout(r, 0));
      const prompt = fs.readFileSync(promptFileOf(call), 'utf-8');
      expect(prompt).not.toContain('【项目感知】'); // 不注快照块
      expect(prompt).toContain('【agent 列表】'); // 其余提示词原样
      await completeWith(call.child, contractText({
        action: 'delegate_to_boss',
        messageToAgent: '把结算做出来',
        delivery: 'queue',
        responseToUser: '已交给主管安排。',
      }));
      const r = await p;

      expect(sendCommandMock).toHaveBeenCalledTimes(1);
      expect(sendCommandMock).toHaveBeenCalledWith('pbA', 'BOSS:把结算做出来', 'sys:pbA'); // 首个 agent 序 Boss
      expect(r.targetAgent).toEqual({ id: 'pbA', name: '大当家A' });
      expect(projectRows('让项目B的团队做结算页')).toEqual([]); // 零 ⑪ 观测
      expect(fs.existsSync(path.join(jarvisProjectsDir, 'aliases.json'))).toBe(false); // 连别名种子都不写
    } finally {
      delete process.env.TC_JARVIS_PROJECT_ROUTING;
    }
  });
});

// ============================================================================
// C21 垫话承诺护栏:出口硬闸(2026-10-05 23:56 事故)
//
// 事故:垫话吐出「好嘞,两分钟后喊你」,而系统当时并无分钟级提醒机制 —— C18 提示词
// 已写「不承诺时间、不保证结果、不编进展」仍食言,纯提示词方案被证伪。
// 修法:清洗后过 filler-guard 纯函数(四类承诺);违规 → 回灌负例 + 带原因重生成
// 一次(独立 4s 上限),仍违规 → 静默(少句垫话,绝不食言)。
// ============================================================================

describe('C21 垫话承诺护栏', () => {
  it('违规句被拦 → 回灌负例 + 带原因重生成一次;重生成合格才播出', async () => {
    writeConfig({ brain: { ...DEFAULT_TEST_CONFIG.brain, slowFiller: { enabled: true, armMs: 500, emitMs: 1_000 } } });
    const sentences: Array<{ text: string; pre: boolean }> = [];
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p = startProcess('两分钟后叫我一下', {
        onSentence: (s, meta) => sentences.push({ text: s, pre: !!meta?.pre }),
      });
      const hop1 = await waitSpawn(1);
      await waitFor(() => spawnCalls.length >= 2, '垫话首生成 spawn', 2_000);
      const f1 = spawnCalls[1];
      // L1:垫话提示词已收紧为硬规则(违反会被系统拦下重写)。
      expect(fs.readFileSync(promptFileOf(f1), 'utf-8')).toContain('硬规则');

      emitLine(f1.child, { type: 'result', result: '好嘞，两分钟后喊你。' }); // 事故原句
      await closeChild(f1.child, 0);

      // 违规 → 第二次生成(spawn #3):用户内容带违规句 + 类别说明 + 负例回灌。
      const f2 = await waitSpawn(3);
      const user2 = stdinUserContent(f2);
      expect(user2).toContain('刚才你应的是「好嘞，两分钟后喊你。');
      expect(user2).toContain('你承诺了时间');
      expect(user2).toContain('已被系统拦下');
      expect(user2).toContain('严禁使用或变相改写'); // banned ring 回灌
      expect(user2).toContain('两分钟后喊你'); // 负例内容本身

      // 重生成合格:「好嘞」放行、无承诺类表述 → 到点播出。
      emitLine(f2.child, { type: 'result', result: '好嘞，我看看。' });
      await closeChild(f2.child, 0);
      await waitFor(() => sentences.some((s) => s.pre), '垫话吐出', 3_000);
      expect(sentences.filter((s) => s.pre)).toEqual([{ text: '好嘞，我看看。', pre: true }]);

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      expect(logs.some((m) => m.includes('垫话拦截 rule=time-promise') && m.includes('重生成一次'))).toBe(true);
      expect(logs.some((m) => m.includes('慢档垫话:好嘞，我看看。'))).toBe(true); // 重生成走了验收路径

      await completeWith(hop1.child, contractText({ action: 'general_response', responseToUser: '好，这就办。' }));
      const r = await p;
      expect(r.response).toBe('好，这就办。');
      expect(spawnCalls).toHaveLength(3); // hop1 + 首生成 + 一次重生成,无第三次生成
    } finally {
      logSpy.mockRestore();
    }
  });

  it('重生成仍违规 → 放弃(静默):不播出、不再重试、日志留痕', async () => {
    writeConfig({ brain: { ...DEFAULT_TEST_CONFIG.brain, slowFiller: { enabled: true, armMs: 500, emitMs: 1_000 } } });
    const sentences: Array<{ text: string; pre: boolean }> = [];
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p = startProcess('查一下主管在干什么', {
        onSentence: (s, meta) => sentences.push({ text: s, pre: !!meta?.pre }),
      });
      const hop1 = await waitSpawn(1);
      await waitFor(() => spawnCalls.length >= 2, '垫话首生成 spawn', 2_000);
      const f1 = spawnCalls[1];
      emitLine(f1.child, { type: 'result', result: '搞定了，马上回来。' }); // 完成宣告 + 加急回话语义
      await closeChild(f1.child, 0);

      const f2 = await waitSpawn(3);
      emitLine(f2.child, { type: 'result', result: '好，三分钟内搞定。' }); // 重生成仍违规
      await closeChild(f2.child, 0);
      await new Promise((r) => setTimeout(r, 400)); // 睡过吐出口

      expect(sentences.filter((s) => s.pre)).toEqual([]); // 静默,绝不食言
      expect(spawnCalls).toHaveLength(3); // 只有一次重试机会
      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      expect(logs.some((m) => m.includes('垫话拦截') && m.includes('放弃(静默)'))).toBe(true);

      await completeWith(hop1.child, contractText({ action: 'general_response', responseToUser: '主管在整理日志。' }));
      const r = await p;
      expect(r.response).toBe('主管在整理日志。'); // 回合照常,只是少句垫话
    } finally {
      logSpy.mockRestore();
    }
  });

  it('开关 TC_VOICE_FILLER_GUARD=0:违规句直接放行(零重生成)', async () => {
    vi.stubEnv('TC_VOICE_FILLER_GUARD', '0');
    writeConfig({ brain: { ...DEFAULT_TEST_CONFIG.brain, slowFiller: { enabled: true, armMs: 500, emitMs: 1_000 } } });
    const sentences: Array<{ text: string; pre: boolean }> = [];
    const logSpy = vi.spyOn(logger.server, 'log');
    try {
      const p = startProcess('两分钟后叫我一下', {
        onSentence: (s, meta) => sentences.push({ text: s, pre: !!meta?.pre }),
      });
      const hop1 = await waitSpawn(1);
      await waitFor(() => spawnCalls.length >= 2, '垫话生成 spawn', 2_000);
      const f1 = spawnCalls[1];
      emitLine(f1.child, { type: 'result', result: '好嘞，两分钟后喊你。' });
      await closeChild(f1.child, 0);
      await waitFor(() => sentences.some((s) => s.pre), '垫话吐出', 3_000);

      expect(sentences.filter((s) => s.pre)).toEqual([{ text: '好嘞，两分钟后喊你。', pre: true }]);
      expect(spawnCalls).toHaveLength(2); // 无重生成
      expect(logSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('垫话拦截'))).toBe(false);

      await completeWith(hop1.child, contractText({ action: 'general_response', responseToUser: '好。' }));
      await p;
    } finally {
      logSpy.mockRestore();
    }
  });
});
