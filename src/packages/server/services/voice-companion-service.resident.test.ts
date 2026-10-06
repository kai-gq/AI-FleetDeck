/**
 * 任务18·秘书常驻化 —— 常驻通道集成测试(假 claude 子进程 harness,同 16·⑬ 范本)。
 *
 * 覆盖(brief L2 ①-⑤ + 补充):
 *   ① 首轮 spawn → 二轮不 spawn 且经 stdin 复用(进程计数 + `process reused: pid=` 埋点 + 统计);
 *   ② 回合协议同构:args 逐字同款、--system-prompt-file 回合内存在/结算即删、
 *      stdin 消息体同款、PID 台账落盘;
 *   ③ 崩溃(假进程意外 close)→ 下轮 respawn + --resume 续会话;
 *   ④ 回退开关 TC_JARVIS_COMPANION_RESIDENT=0 → 逐字回退一次性 spawn(2 次 spawn、
 *      每次 stdin.end、第二跳带 --resume、常驻通道零接触);
 *   ⑤ usage 采集 → ≥阈值(任务39 缺省 30%)触发压缩轮换(摘要续跑,reason='context-compact',新进程不带 --resume);
 *   ⑥ 进程卫生:stop → SIGTERM + taskkill /T /F 树杀 + 台账清除;启动清扫(仅 owner 已死才杀);
 *   ⑦ 流式保留:stream_event text_delta → onTextDelta 累计回调;中止 → VoiceCompanionAborted。
 *
 * 三保险防误写真实数据(同 cancellation 范本):
 *   1) src/test-setup.ts 已把 XDG_DATA_HOME 指向进程级临时沙箱(模块加载前);
 *   2) beforeAll 先 chdir 到临时工程目录再动态 import 服务;
 *   3) beforeAll 硬断言状态文件落在 XDG 沙箱内,失败立即终止。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VoiceProcessOptions, VoiceProcessResult } from './voice-companion-service.js';
import { closeEventDb, initEventDb } from '../data/event-db.js';
import * as systemLogModule from '../data/system-log.js';
import { querySystemLog } from '../data/system-log.js';
import { logger } from '../utils/index.js';
import type { DrawingArea } from '../../shared/common-types.js';
import {
  getCompanionPidFilePath,
  getCompanionProcessInfo,
  getCompanionRunnerStats,
  initCompanionProcessHygiene,
  resetCompanionRunnerForTests,
  stopCompanionProcess,
  sweepStaleCompanionProcess,
} from '../voice/companion-runner.js';
import { ALLOWLIST_MCP_FILENAME, VOICE_CWD_DIRNAME } from '../voice/companion-cli-profile.js';

// ============================================================================
// 假 claude 子进程(常驻化关键差异:进程跨回合存活,harness 保留 child 不 close)
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
  readonly pid: number;
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.stdinWrites.push(chunk);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

const spawnCalls: SpawnCall[] = [];
const execFileCalls: Array<{ file: string; args: string[] }> = [];

function fakeSpawn(cmd: string, args: string[], opts: SpawnOpts): FakeChild {
  const child = new FakeChild(4000 + spawnCalls.length + 1); // PID 台账断言用:4001/4002/…
  spawnCalls.push({ cmd, args, opts, child });
  process.nextTick(() => child.emit('spawn'));
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: fakeSpawn,
    // 树杀(windows taskkill)只记录不执行——绝不能真杀测试机进程。
    execFile: (file: string, args: string[], _opts: unknown, cb?: (...a: unknown[]) => void) => {
      execFileCalls.push({ file, args });
      cb?.(null, '', '');
      return {} as never;
    },
    spawnSync: () => ({ status: 0 }),
  };
});

// ============================================================================
// 系统边界替身(agent 世界 / 数据目录 / services 入口 / 记忆引擎)
// ============================================================================

interface MockAgent {
  id: string;
  name: string;
  class?: string;
  status: string;
  isBoss?: boolean;
}

const mockAgents: MockAgent[] = [];
const mockAreas: DrawingArea[] = [];

vi.mock('./agent-service.js', () => ({
  getAllAgents: () => mockAgents,
  getAgent: (id: string) => mockAgents.find((a) => a.id === id),
  // F5 补钉:单 agent 查询的 hop2 材料来源(fetchAgentOutputExcerpt 读它);
  // 此前缺此 mock → 查询链路会 TypeError,hop2 无法在 harness 里跑起来。
  getAgentHistory: async (_id: string) => ({
    messages: [{ type: 'assistant', content: '小美刚完成构建任务,正在等待下一单。' }],
  }),
}));

vi.mock('../data/index.js', async () => {
  const actual = await vi.importActual<typeof import('../data/index.js')>('../data/index.js');
  return { ...actual, loadAreas: () => mockAreas };
});

const stopAgentMock = vi.fn(async (_agentId: string) => {});
const sendCommandMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('./index.js', async () => {
  const realBoss = await vi.importActual<typeof import('./boss-service.js')>('./boss-service.js');
  return {
    agentService: {
      getAllAgents: () => mockAgents,
      getAgent: (id: string) => mockAgents.find((a) => a.id === id),
    },
    runtimeService: {
      stopAgent: (...args: [string]) => stopAgentMock(...args),
      sendCommand: (...args: unknown[]) => sendCommandMock(...args),
    },
    bossService: realBoss,
    workPlanService: {},
    skillService: {},
  };
});

vi.mock('../websocket/handlers/command-handler.js', () => ({
  getLastBossCommand: () => undefined,
  buildCustomAgentConfig: (id: string, cls?: string) => ({ __custom: id, cls }),
}));

// 记忆引擎:rotation 摘要/裁剪不碰真实 vault(断言 summarizeSession 调用)。
const { memoryEngine } = vi.hoisted(() => ({
  memoryEngine: {
    captureUserTurn: vi.fn(async () => ({})),
    summarizeSession: vi.fn(async () => ({})),
    sweep: vi.fn(async () => ({})),
    bridgeVoiceMemoryOps: vi.fn(async () => ({})),
  },
}));

vi.mock('../jarvis-core/memory/index.js', () => ({
  createMemoryStack: () => ({ engine: memoryEngine }),
}));

// ============================================================================
// 沙箱、临时工程目录与状态文件
// ============================================================================

const dataHome = process.env.XDG_DATA_HOME;
if (!dataHome) throw new Error('XDG_DATA_HOME 未设置:test-setup 沙箱失效,拒绝加载本测试文件');

const stateFilePath = path.join(dataHome, 'tide-commander', 'voice-companion.json');

let service: typeof import('./voice-companion-service.js');
let projectDir = '';
let originalCwd = '';
/** 任务19:档案模块的 MCP 源配置夹具路径(不读真实 ~/.claude.json,断言可确定)。 */
let mcpFixturePath = '';
let logSpy: ReturnType<typeof vi.spyOn>;

function configPath(): string {
  return path.join(projectDir, 'tools', 'voice-companion', 'config.json');
}

const DEFAULT_TEST_CONFIG = {
  model: 'haiku',
  persona: { preset: 'doubao', custom: '' },
  brain: { hop1TimeoutMs: 5_000, hop2TimeoutMs: 5_000, maxTurns: 120, sessionMaxAgeDays: 7, maxNotes: 5 },
};

function writeConfig(overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...DEFAULT_TEST_CONFIG, ...overrides }));
}

function seedAgents(): void {
  mockAgents.length = 0;
  mockAgents.push(
    { id: 'b1', name: '主管', class: 'boss', isBoss: true, status: 'idle' },
    { id: 'a-mei', name: '小美', class: 'builder', status: 'working' },
  );
}

beforeAll(async () => {
  originalCwd = process.cwd();
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-resident-'));
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
  initEventDb();

  service = await import('./voice-companion-service.js');

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
  vi.unstubAllEnvs();
  spawnCalls.length = 0;
  execFileCalls.length = 0;
  mockAgents.length = 0;
  mockAreas.length = 0;
  seedAgents();
  memoryEngine.captureUserTurn.mockClear();
  memoryEngine.summarizeSession.mockClear();
  memoryEngine.sweep.mockClear();
  resetCompanionRunnerForTests();
  fs.rmSync(stateFilePath, { force: true });
  service.resetProjectRoutingSession();
  service.resetCancelClarificationSession();
  writeConfig();
  logSpy = vi.spyOn(logger.server, 'log').mockImplementation(() => {});
  // W3 预热点火:默认关掉(与集成/取消两文件同口径)——否则「回合以 close 收尾」
  // 的用例会在测试间隙被异步预热补建,污染 spawn 计数;预热语义由本文件 W3 节专测
  // (专测内自行 stubEnv 打开)。
  vi.stubEnv('TC_VOICE_PREWARM', '0');
  // 任务19:档案模块的 MCP 源固定到夹具(缺省档 allowlist;断言不依赖真实用户配置)。
  vi.stubEnv('TC_VOICE_MCP_SOURCE', mcpFixturePath);
  // 任务39:交接链路默认关(与集成文件同口径)——R5 等用例的状态文件/spawn 计数逐字不变。
  vi.stubEnv('TC_VOICE_HANDOFF', '0');
});

afterEach(() => {
  stopCompanionProcess('test-teardown');
  resetCompanionRunnerForTests();
  logSpy.mockRestore();
  vi.unstubAllEnvs();
});

// ============================================================================
// helpers
// ============================================================================

function emitLine(child: FakeChild, obj: unknown): void {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
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
  await new Promise((r) => setTimeout(r, 0));
  return call;
}

function startProcess(text: string, opts: VoiceProcessOptions = {}): Promise<VoiceProcessResult> {
  return service.processVoiceInput(text, opts);
}

function contractText(
  action = 'general_response',
  responseToUser = '好的',
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    action,
    responseToUser,
    targetAgentId: null,
    targetAgentName: null,
    messageToAgent: '',
    delivery: 'queue',
    query: '',
    bolbaTask: '',
    memoryOps: [],
    ...extra,
  });
}

/** 一个回合的完整 stdout 序列:system(带 session)→ assistant → result。 */
function completeTurn(
  child: FakeChild,
  sessionId: string,
  text = contractText(),
  resultExtra: Record<string, unknown> = {},
): void {
  emitLine(child, { type: 'system', subtype: 'init', session_id: sessionId });
  emitLine(child, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  emitLine(child, { type: 'result', subtype: 'success', result: text, ...resultExtra });
}

function argsOf(call: SpawnCall): string[] {
  return call.args;
}

function resumeIdOf(call: SpawnCall): string | null {
  const idx = call.args.indexOf('--resume');
  return idx >= 0 ? call.args[idx + 1] ?? null : null;
}

function readPidRecord(): Record<string, unknown> | null {
  const file = getCompanionPidFilePath();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function sessionLogBodies(): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'system' })
    .map((e) => {
      try { return JSON.parse(e.body ?? '{}') as Record<string, unknown>; } catch { return {}; }
    })
    .filter((b) => b.cat === 'session');
}

/**
 * 常驻树杀断言:Windows 有 pid 时只走 taskkill /T /F(shell:true 下先 SIGTERM 会
 * 杀 cmd 让孙子进程成孤儿);POSIX 先 SIGTERM。
 */
function expectResidentTreeKill(child: FakeChild, pid: number): void {
  if (process.platform === 'win32') {
    expect(execFileCalls.some((c) => c.file === 'taskkill' && c.args.join(' ') === `/pid ${pid} /T /F`)).toBe(true);
  } else {
    expect(child.kills).toContain('SIGTERM');
  }
}

/** F2 补钉:直接种状态文件,构造「轮换多条件同真」的前置态(经真实 loadCompanionState 读取)。 */
function seedCompanionState(overrides: Record<string, unknown> = {}): void {
  const base = {
    sessionId: 'sess-old',
    sessionStartedAt: Date.now(),
    turns: 0,
    lastUsedAt: Date.now(),
    // 与当前配置（preset=doubao）必不相同的旧人设键 → 人设判定必真。
    personaKey: 'persona-old',
    memory: { summary: '', notes: [], updatedAt: 0, droppedCount: 0 },
    context: null,
  };
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify({ ...base, ...overrides }));
}

/** 200K 窗口下的上下文快照(percent 即 tokensUsed/200000)。 */
function contextSnapshot(percent: number): Record<string, unknown> {
  return { tokensUsed: Math.round(percent * 200_000), windowTokens: 200_000, percent, updatedAt: Date.now() };
}

/**
 * 会话轮换留痕(rotated/expired)。event db 跨用例累积且 sessionId 是 log 条目字段
 * (不在 body 里),故按 sessionId 列直接过滤。
 */
function rotationBodies(sessionId: string): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'system', sessionId })
    .map((e) => {
      try { return JSON.parse(e.body ?? '{}') as Record<string, unknown>; } catch { return {}; }
    })
    .filter((b) => b.phase === 'rotated' || b.phase === 'expired');
}

// ============================================================================
// 补钉 F4(M14):initCompanionProcessHygiene 幂等
// (新加入的用例通常声明在最前,hygieneDone 尚未被任何回合置位 → 覆盖「首次」;
// 即便乱序先有回合初始化过,下面的「两信号一致性 + 二次不动作」仍然成立。)
// ============================================================================

describe('任务18 补钉 F4:进程卫生初始化幂等', () => {
  it('F4 initCompanionProcessHygiene 连调两次:装钩子/清扫各恰好一次', () => {
    const pidFile = getCompanionPidFilePath();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const stale = { serverPid: 999999, childPid: null, startedAt: 1, heartbeatAt: 2, model: 'haiku' };
    fs.writeFileSync(pidFile, JSON.stringify(stale));

    const listenersBefore = process.listenerCount('exit');
    initCompanionProcessHygiene();
    // 首次(尚未初始化时):装退出钩子恰好一个 + 清扫残留
    // (owner 999999 已死;childPid=null → 只删台账,不杀任何进程)。
    // 两信号必须同源一致:要么都发生(首次),要么都没发生(此前已初始化)。
    const sweptOnce = !fs.existsSync(pidFile);
    expect(sweptOnce).toBe(process.listenerCount('exit') === listenersBefore + 1);

    // 第二次:幂等早退 —— 不新增钩子,也不再清扫(重建的残留台账原样保留)。
    fs.writeFileSync(pidFile, JSON.stringify(stale));
    initCompanionProcessHygiene();
    expect(process.listenerCount('exit')).toBe(listenersBefore + (sweptOnce ? 1 : 0));
    expect(fs.existsSync(pidFile)).toBe(true);

    fs.rmSync(pidFile, { force: true });
  });
});

// ============================================================================
// ① 常驻复用 / ② 协议同构
// ============================================================================

describe('任务18 常驻通道:复用与协议同构', () => {
  it('R1 首轮 spawn;二轮不 spawn 且经 stdin 复用(进程计数 + 埋点 + 统计)', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1');
    await p1;
    expect(spawnCalls).toHaveLength(1);

    const p2 = startProcess('第二句');
    // 复用:没有第二次 spawn,写入同一个 stdin。
    await waitFor(() => call1.child.stdinWrites.length >= 2, '第二轮 stdin 写入');
    expect(spawnCalls).toHaveLength(1);
    expect(call1.child.stdinEnded).toBe(false);
    expect(call1.child.stdinWrites).toHaveLength(2);
    expect(call1.child.stdinWrites[1]).toContain('第二句');

    completeTurn(call1.child, 'sess-1');
    await p2;

    const stats = getCompanionRunnerStats();
    expect(stats.spawns).toBe(1);
    expect(stats.reuses).toBe(1);
    expect(stats.lastReusePid).toBe(4001);

    const reuseLines = logSpy.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .filter((line: string) => line.includes('process reused: pid='));
    expect(reuseLines).toHaveLength(1);
    expect(reuseLines[0]).toContain('pid=4001');

    const startLines = logSpy.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .filter((line: string) => line.includes('常驻进程启动: pid='));
    expect(startLines).toHaveLength(1);
  });

  it('R2 回合协议同构:args 逐字同款、提示词文件回合内存在/结算即删、PID 台账落盘', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);

    // args 与 callClaudeOnce 今日逐字同构(仅进程生命周期变化)。
    expect(argsOf(call1).slice(0, 9)).toEqual([
      '--print', '--verbose', '--model', 'haiku',
      '--output-format', 'stream-json', '--include-partial-messages', '--input-format', 'stream-json',
    ]);
    expect(argsOf(call1)[9]).toBe('--system-prompt-file');
    expect(call1.opts.shell).toBe(process.platform === 'win32');
    expect(call1.opts.env?.LANG).toBe('en_US.UTF-8');

    // 提示词文件:回合内存在(CLI 已读),回合结算即删(与一次性路径同口径)。
    const promptFile = argsOf(call1)[10];
    expect(fs.existsSync(promptFile)).toBe(true);

    // stdin 消息体:同款 stream-json user 行(含格式提醒)。
    const stdinMsg = JSON.parse(call1.child.stdinWrites[0]!) as { type: string; message: { role: string; content: string } };
    expect(stdinMsg.type).toBe('user');
    expect(stdinMsg.message.role).toBe('user');
    expect(stdinMsg.message.content).toContain('第一句');
    // 时间随回合注入用户消息(修复:resume 提示词冻结导致「现在几点」答的是建会话时刻)
    expect(stdinMsg.message.content).toContain('【当前时间】');
    expect(stdinMsg.message.content).toContain('【格式】只回那个 JSON 对象,不要任何解释。');

    // PID 台账:serverPid=本进程,childPid=子进程。
    const record = readPidRecord();
    expect(record).toMatchObject({ serverPid: process.pid, childPid: 4001, model: 'haiku' });
    expect(getCompanionProcessInfo()?.pid).toBe(4001);

    completeTurn(call1.child, 'sess-1');
    await p1;
    expect(fs.existsSync(promptFile)).toBe(false);
  });

  it('R7 流式保留:text_delta → onTextDelta 累计回调;中止 → VoiceCompanionAborted', async () => {
    const sentences: string[] = [];
    const controller = new AbortController();
    const p1 = startProcess('第一句', { onSentence: (s) => sentences.push(s), signal: controller.signal });
    const call1 = await waitSpawn(1);

    emitLine(call1.child, { type: 'system', subtype: 'init', session_id: 'sess-1' });
    emitLine(call1.child, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"action":"gene' } } });
    emitLine(call1.child, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ral_response","responseToUser":"收到"}' } } });
    // 流式增量已进 SpeechGate(句未完整时可能 0 条,完整句应放行片段)→ 至少不发散;随后中止。
    controller.abort();
    let caught: unknown;
    try {
      await p1;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(service.VoiceCompanionAbortedError);
    expect((caught as Error).name).toBe('VoiceCompanionAborted');
    // 中止 → 树杀(Windows:taskkill /T /F;POSIX:SIGTERM)。
    expectResidentTreeKill(call1.child, 4001);
    void sentences; // 流式回调接口接线可用(句级放行由既有 integration G6-14 覆盖)

    // 中止后进程已作废:下一回合重新 spawn(新进程)。
    const p2 = startProcess('再说一句', { onSentence: () => {} });
    const call2 = await waitSpawn(2);
    completeTurn(call2.child, 'sess-new');
    await p2;
    expect(spawnCalls).toHaveLength(2);
  });

  it('R3 崩溃(意外 close)→ 下轮 respawn + --resume 续会话', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1');
    await p1;
    expect(getCompanionProcessInfo()?.pid).toBe(4001);

    // 进程意外退出(回合外 close,无活动回合)。
    call1.child.emit('close', 1);
    await drainMicrotasks();
    expect(getCompanionProcessInfo()).toBeNull();
    expect(readPidRecord()).toBeNull();

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-1'); // 会话续跑
    completeTurn(call2.child, 'sess-1');
    await p2;
    expect(spawnCalls).toHaveLength(2);
  });
});

// ============================================================================
// ④ 回退开关等价
// ============================================================================

describe('任务18 回退开关(=0 逐字回退一次性 spawn)', () => {
  it('R4 =0 时每回合独立 spawn + stdin.end + resume 续会话,常驻通道零接触', async () => {
    vi.stubEnv('TC_JARVIS_COMPANION_RESIDENT', '0');

    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    await drainMicrotasks();
    expect(call1.child.stdinEnded).toBe(true); // 旧行为:写后立刻 end
    expect(resumeIdOf(call1)).toBeNull();
    completeTurn(call1.child, 'sess-1');
    call1.child.emit('close', 0);
    await p1;

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBe('sess-1');
    completeTurn(call2.child, 'sess-2');
    call2.child.emit('close', 0);
    await p2;

    expect(spawnCalls).toHaveLength(2);
    // 常驻通道完全未被触碰:零统计、无 PID 台账、无树杀。
    const stats = getCompanionRunnerStats();
    expect(stats.spawns).toBe(0);
    expect(stats.reuses).toBe(0);
    expect(readPidRecord()).toBeNull();
    expect(execFileCalls).toHaveLength(0);
  });
});

// ============================================================================
// ⑤ usage 采集 → 阈值压缩轮换(任务39 缺省 30%)
// ============================================================================

describe('任务18/39 上下文压缩(阈值摘要续跑)', () => {
  it('R5 usage 落状态 + context_stats 观测;超阈值次回合以 context-compact 轮换', async () => {
    const usage = {
      input_tokens: 20_000,
      output_tokens: 500,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 40_000, // 合计 160000 / 200000 = 80%(远超任务39 缺省 30% 阈值)
    };
    const modelUsage = { 'claude-haiku-4-5': { contextWindow: 200_000 } };

    // 观测断言用:转发真实实现(采样通道照常落库),同时记录本次调用。
    const realLogEvent = systemLogModule.logEvent;
    const logEventSpy = vi
      .spyOn(systemLogModule, 'logEvent')
      .mockImplementation(((cat: string, fields: unknown) => (realLogEvent as (c: string, f: unknown) => unknown)(cat, fields)) as typeof systemLogModule.logEvent);

    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1', contractText(), { usage, modelUsage });
    await p1;

    // 状态落盘:percent = 0.8。
    const stateAfter1 = service.loadCompanionState();
    expect(stateAfter1.sessionId).toBe('sess-1');
    expect(stateAfter1.context?.tokensUsed).toBe(160_000);
    expect(stateAfter1.context?.windowTokens).toBe(200_000);
    expect(stateAfter1.context?.percent).toBeCloseTo(0.8, 5);

    // 观测:context_stats 发出(body 含 tokensUsed/percent)。
    const ctxCalls = logEventSpy.mock.calls.filter(([cat]) => cat === 'context_stats');
    expect(ctxCalls).toHaveLength(1);
    const ctxBody = (ctxCalls[0]![1] as { body?: { tokensUsed?: number; percent?: number } }).body;
    expect(ctxBody?.tokensUsed).toBe(160_000);
    expect(ctxBody?.percent).toBe(80); // 0-100 标度(80%)
    logEventSpy.mockRestore();

    // 第二回合:到阈值 → 摘要续跑(轮换路径,reason='context-compact')。
    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    await waitFor(() => memoryEngine.summarizeSession.mock.calls.length > 0, 'summarizeSession 调用');
    expect(memoryEngine.summarizeSession).toHaveBeenCalledWith({ sessionId: 'sess-1', summary: '' });
    expect(memoryEngine.sweep).toHaveBeenCalled();
    // 旧常驻进程被停掉(轮换),新进程不带 --resume = 新会话。
    expectResidentTreeKill(call1.child, 4001);
    expect(resumeIdOf(call2)).toBeNull();
    completeTurn(call2.child, 'sess-2');
    await p2;

    // 轮换留痕:phase=rotated,reason=context-compact(既有第 3 条 logSession 埋点内)。
    const bodies = sessionLogBodies();
    const compact = bodies.find((b) => b.reason === 'context-compact');
    expect(compact).toBeTruthy();
    expect(compact?.phase).toBe('rotated');
    // 会话清空、上下文快照清零。
    const stateAfter2 = service.loadCompanionState();
    expect(stateAfter2.sessionId).toBe('sess-2'); // turn2 新建会话
    expect(stateAfter2.turns).toBe(1);
  });

  it('R5b 未达阈值不轮换(第二回合仍复用进程、session 续跑)', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1', contractText(), {
      usage: { input_tokens: 3_000, output_tokens: 100, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 } },
    });
    await p1;
    expect(service.loadCompanionState().context?.percent).toBeCloseTo(0.02, 5);

    const p2 = startProcess('第二句');
    await waitFor(() => call1.child.stdinWrites.length >= 2, '未达阈值应复用(第二次 stdin 写入)');
    expect(spawnCalls).toHaveLength(1); // 复用,不 respawn
    expect(memoryEngine.summarizeSession).not.toHaveBeenCalled();
    completeTurn(call1.child, 'sess-1');
    await p2;
  });
});

// ============================================================================
// ⑥ 进程卫生(台账 / 关停树杀 / 启动清扫)
// ============================================================================

describe('任务18 进程卫生(Windows)', () => {
  it('R6a 关停:stopCompanionProcess → SIGTERM + taskkill /T /F + 台账清除', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    expect(readPidRecord()).toMatchObject({ childPid: 4001 });

    stopCompanionProcess('unit-test');
    expectResidentTreeKill(call1.child, 4001);
    expect(readPidRecord()).toBeNull();
    expect(getCompanionProcessInfo()).toBeNull();

    completeTurn(call1.child, 'sess-1');
    call1.child.emit('close', 0); // 树杀后进程 close;在途回合按一次性口径结算
    await p1;
  });

  it('R6b 启动清扫:owner 已死才树杀残留;owner 存活不动(双实例安全)', () => {
    const pidFile = getCompanionPidFilePath();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });

    // 残留:serverPid(999999)已死、child 存活 → 树杀 + 台账清除。
    fs.writeFileSync(pidFile, JSON.stringify({ serverPid: 999999, childPid: 7777, startedAt: 1, heartbeatAt: 2, model: 'haiku' }));
    const killTree = vi.fn();
    const res1 = sweepStaleCompanionProcess({
      isAlive: (pid) => pid === 7777,
      killTree,
    });
    expect(res1).toMatchObject({ swept: true, reason: 'killed', childPid: 7777 });
    expect(killTree).toHaveBeenCalledWith(7777);
    expect(fs.existsSync(pidFile)).toBe(false);

    // owner 存活:跳过(交给该实例自己的退出钩子)。
    fs.writeFileSync(pidFile, JSON.stringify({ serverPid: 888888, childPid: 7777, startedAt: 1, heartbeatAt: 2, model: 'haiku' }));
    const killTree2 = vi.fn();
    const res2 = sweepStaleCompanionProcess({ isAlive: () => true, killTree: killTree2 });
    expect(res2).toMatchObject({ swept: false, reason: 'owner-alive' });
    expect(killTree2).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(true);
    fs.rmSync(pidFile, { force: true });
  });

  it('R6c 崩溃恢复后 PID 台账翻新(childPid 指向新进程)', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1');
    await p1;
    call1.child.emit('close', 0);
    await drainMicrotasks();

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(readPidRecord()).toMatchObject({ serverPid: process.pid, childPid: 4002 });
    completeTurn(call2.child, 'sess-1');
    await p2;
  });
});

// ============================================================================
// 补钉(F1/F2/F3/F5/F6/F7)—— 独立只读验证 10 处存活变异的测试缺口
// (F4 因需本文件首个 it 的时序前提,单列在本文件靠前处)
// ============================================================================

describe('任务18 补钉 F1:contextWindow 取值优先级', () => {
  it('F1a result 只带 usage(无 modelUsage)→ 窗口用配置缺省 200_000', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1', contractText(), {
      usage: { input_tokens: 10_000, output_tokens: 120, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 },
    });
    await p1;

    const ctx = service.loadCompanionState().context;
    expect(ctx?.tokensUsed).toBe(15_000);
    expect(ctx?.windowTokens).toBe(200_000); // modelUsage 缺失 → cfg.contextWindowTokens 缺省
    expect(ctx?.percent).toBeCloseTo(0.075, 6);
  });

  it('F1b result 带 modelUsage.contextWindow=100_000 → 优先于配置缺省;且取请求模型匹配键', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1', contractText(), {
      usage: { input_tokens: 50_000, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
      // 干扰项在 keys[0](500K):只有「按请求 model=haiku 匹配键」才取到 100K。
      modelUsage: {
        'claude-opus-4-1': { contextWindow: 500_000 },
        'claude-haiku-4-5': { contextWindow: 100_000 },
      },
    });
    await p1;

    const ctx = service.loadCompanionState().context;
    expect(ctx?.tokensUsed).toBe(90_000);
    expect(ctx?.windowTokens).toBe(100_000); // 优先级:请求模型匹配键 > keys[0] > 配置缺省
    expect(ctx?.percent).toBeCloseTo(0.9, 6); // 若错用 200K 兜底会在 0.45;若取 keys[0] 会在 0.18
  });
});

describe('任务18 补钉 F2:轮换 reason 级联(多条件同真取优先级)', () => {
  it('F2a turns≥maxTurns + 旧 persona + context 超阈 → max-turns', async () => {
    seedCompanionState({ sessionId: 'sess-f2a', turns: 120, context: contextSnapshot(0.8) });

    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-a');
    await p1;

    const rotations = rotationBodies('sess-f2a');
    expect(rotations).toHaveLength(1);
    expect(rotations[0]).toMatchObject({ phase: 'rotated', reason: 'max-turns' });
    expect(resumeIdOf(call1)).toBeNull(); // 轮换后是新会话,不带 --resume
  });

  it('F2b persona 变更 + context 超阈(轮数/年龄未到)→ persona-changed', async () => {
    seedCompanionState({ sessionId: 'sess-f2b', turns: 5, context: contextSnapshot(0.85) });

    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-b');
    await p1;

    const rotations = rotationBodies('sess-f2b');
    expect(rotations).toHaveLength(1);
    expect(rotations[0]).toMatchObject({ phase: 'rotated', reason: 'persona-changed' });
  });

  it('F2c 超龄 + 超轮 + 超阈 + 旧 persona → max-age 优先(phase=expired)', async () => {
    seedCompanionState({
      sessionId: 'sess-f2c',
      turns: 500,
      sessionStartedAt: Date.now() - 8 * 86_400_000, // 8 天 > sessionMaxAgeDays 7
      context: contextSnapshot(0.9),
    });

    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-c');
    await p1;

    const rotations = rotationBodies('sess-f2c');
    expect(rotations).toHaveLength(1);
    expect(rotations[0]).toMatchObject({ phase: 'expired', reason: 'max-age' });
  });
});

describe('任务18 补钉 F3:PID 台账路径沙箱', () => {
  it('F3 getCompanionPidFilePath 在 XDG 沙箱内(与状态文件同目录),不在 repo/cwd', () => {
    const pidFile = path.resolve(getCompanionPidFilePath());
    const sandbox = path.resolve(dataHome);
    expect(pidFile.startsWith(sandbox + path.sep)).toBe(true);
    // 与 voice-companion.json 同目录(同为 XDG 沙箱的 tide-commander/),但不是同一文件。
    expect(path.dirname(pidFile)).toBe(path.dirname(path.resolve(stateFilePath)));
    expect(pidFile).not.toBe(path.resolve(stateFilePath));
    // 不在仓库(originalCwd)也不在测试 cwd(临时工程目录)。
    expect(pidFile.startsWith(path.resolve(originalCwd) + path.sep)).toBe(false);
    expect(pidFile.startsWith(path.resolve(process.cwd()) + path.sep)).toBe(false);
  });
});

describe('任务18 补钉 F5:hop2 一次性(不驻留)', () => {
  it('F5 hop2 用完即闭(stdin.end)、不写 PID 台账、stats.spawns 不增、常驻进程不受扰', async () => {
    const p = startProcess('小美在忙什么');
    const hop1 = await waitSpawn(1);

    // hop1 契约:查询动作 → 服务端拉材料后跑 hop2(一次性 callClaudeOnce,不走常驻通道)。
    completeTurn(hop1.child, 'sess-1', contractText('query_agent_output', '', {
      targetAgentId: 'a-mei',
      targetAgentName: '小美',
      query: '小美在忙什么',
    }));
    const hop2 = await waitSpawn(2);
    expect(hop2.child).not.toBe(hop1.child);

    // ① 一次性:写完 stdin 立刻 end;常驻 hop1 进程 stdin 保持可写。
    await waitFor(() => hop2.child.stdinEnded, 'hop2 stdin.end');
    expect(hop2.child.stdinEnded).toBe(true);
    expect(hop2.child.stdinWrites).toHaveLength(1);
    expect(hop1.child.stdinEnded).toBe(false);

    // ② 台账仍指向 hop1 常驻进程:hop2 不落 PID 台账、不动常驻单例。
    expect(getCompanionProcessInfo()?.pid).toBe(4001);
    expect(readPidRecord()).toMatchObject({ serverPid: process.pid, childPid: 4001 });

    // ③ 统计:spawns 只计常驻进程,hop2 的 spawn 不增加。
    expect(getCompanionRunnerStats()).toMatchObject({ spawns: 1, reuses: 0 });

    // hop2 收尾(一次性路径 close 才结算)。
    emitLine(hop2.child, { type: 'system', subtype: 'init', session_id: 'sess-hop2' });
    emitLine(hop2.child, { type: 'assistant', message: { content: [{ type: 'text', text: '{"responseToUser":"小美刚完成构建"}' }] } });
    emitLine(hop2.child, { type: 'result', subtype: 'success', result: '{"responseToUser":"小美刚完成构建"}' });
    hop2.child.emit('close', 0);
    const result = await p;

    expect(result.action).toBe('query_agent_output');
    expect(result.response).toBe('小美刚完成构建');
    // hop2 结束后:常驻统计未计 hop2、常驻进程原样存活、台账未被 hop2 触碰。
    expect(getCompanionRunnerStats().spawns).toBe(1);
    expect(getCompanionProcessInfo()?.pid).toBe(4001);
    expect(readPidRecord()).toMatchObject({ childPid: 4001 });
    expect(spawnCalls).toHaveLength(2);
  });
});

describe('任务18 补钉 F6:常驻 args 全量断言', () => {
  it('F6 args 逐字 toEqual(含长度;任何追加参数——含 bypass 类——都会红)', async () => {
    const baseArgs = [
      '--print', '--verbose', '--model', 'haiku',
      '--output-format', 'stream-json', '--include-partial-messages', '--input-format', 'stream-json',
      '--system-prompt-file',
    ];
    // 提示词快照关(2026-10-06):resume 不再沿用会话首请求「录死」的提示词。
    const snapshotArgs = ['--system-prompt-snapshot', 'off'];
    // 任务19:档案尾部逐字钉住(白名单 5 内置 + 过滤后 MCP 文件;--tools 变参收尾)。
    const profileTail = [
      '--strict-mcp-config',
      '--mcp-config', path.join(dataHome, 'tide-commander', ALLOWLIST_MCP_FILENAME),
      '--tools', 'WebSearch,WebFetch,Read,Glob,Grep',
    ];

    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    expect(argsOf(call1)).toEqual([...baseArgs, expect.stringContaining('voice-companion-prompt-'), ...snapshotArgs, ...profileTail]);
    expect(argsOf(call1)).toHaveLength(baseArgs.length + 1 + snapshotArgs.length + profileTail.length); // 无多余参数
    expect(call1.opts.cwd).toBe(path.join(dataHome, 'tide-commander', VOICE_CWD_DIRNAME));
    expect(argsOf(call1)).not.toContain('--resume');
    for (const arg of argsOf(call1)) {
      expect(arg).not.toMatch(/dangerously|bypass|permission/i); // 权限姿态冻结:显式反断言
    }
    completeTurn(call1.child, 'sess-1');
    await p1;

    // 崩溃后带 --resume 重生的 args 同样全量逐字钉住(--resume 在档案尾之前)。
    call1.child.emit('close', 1);
    await drainMicrotasks();
    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(argsOf(call2)).toEqual([...baseArgs, expect.stringContaining('voice-companion-prompt-'), ...snapshotArgs, '--resume', 'sess-1', ...profileTail]);
    expect(argsOf(call2)).toHaveLength(baseArgs.length + 3 + snapshotArgs.length + profileTail.length);
    completeTurn(call2.child, 'sess-1');
    await p2;
  });
});

describe('任务18 补钉 F7:resetCompanion 停进程清会话', () => {
  it('F7 reset:树杀 + getCompanionProcessInfo()=null + 台账清除 + 下一轮不带 --resume', async () => {
    const p1 = startProcess('第一句');
    const call1 = await waitSpawn(1);
    completeTurn(call1.child, 'sess-1');
    await p1;
    expect(service.loadCompanionState().sessionId).toBe('sess-1');
    expect(getCompanionProcessInfo()?.pid).toBe(4001);
    expect(readPidRecord()).toMatchObject({ childPid: 4001 });

    service.resetCompanion();

    expectResidentTreeKill(call1.child, 4001);
    expect(getCompanionProcessInfo()).toBeNull();
    expect(readPidRecord()).toBeNull();
    expect(service.loadCompanionState().sessionId).toBeNull();

    const p2 = startProcess('第二句');
    const call2 = await waitSpawn(2);
    expect(resumeIdOf(call2)).toBeNull(); // 会话已清:新进程不带 --resume
    completeTurn(call2.child, 'sess-2');
    await p2;
    expect(service.loadCompanionState().sessionId).toBe('sess-2');
  });
});

// ============================================================================
// W3·C8 预热点火(本文件默认 TC_VOICE_PREWARM=0;专测内自行打开)
// ============================================================================

describe('W3-C8 预热点火', () => {
  it('P1 无进程时预热 spawn(无回合不写 stdin、台账落盘);真实回合直接复用', async () => {
    vi.stubEnv('TC_VOICE_PREWARM', '1');

    expect(service.prewarmCompanion()).toBe(true);
    const call1 = await waitSpawn(1);
    expect(call1.child.stdinWrites).toHaveLength(0); // 预热进程没有回合:不写 stdin
    expect(resumeIdOf(call1)).toBeNull(); // 状态无会话 → 与常规首轮同款
    expect(getCompanionProcessInfo()?.pid).toBe(4001);
    expect(getCompanionRunnerStats().spawns).toBe(1);
    expect(readPidRecord()).toMatchObject({ serverPid: process.pid, childPid: 4001, model: 'haiku' });

    const p = startProcess('第一句');
    await waitFor(() => call1.child.stdinWrites.length >= 1, '复用预热进程写 stdin');
    expect(spawnCalls).toHaveLength(1); // 不再冷启动
    completeTurn(call1.child, 'sess-1');
    await p;
    expect(getCompanionRunnerStats()).toMatchObject({ spawns: 1, reuses: 1 });
  });

  it('P2 幂等:同模型活进程在场,二次预热零新增(不打扰)', async () => {
    vi.stubEnv('TC_VOICE_PREWARM', '1');
    expect(service.prewarmCompanion()).toBe(true);
    await waitSpawn(1);

    expect(service.prewarmCompanion()).toBe(false);
    expect(spawnCalls).toHaveLength(1);
    expect(getCompanionProcessInfo()?.pid).toBe(4001);
  });

  it('P3 模型变更:停旧建新,resumeId 继承(下一回合 args 即刻生效)', async () => {
    vi.stubEnv('TC_VOICE_PREWARM', '1');
    seedCompanionState({ sessionId: 'sess-x' });

    expect(service.prewarmCompanion()).toBe(true);
    const call1 = await waitSpawn(1);
    expect(resumeIdOf(call1)).toBe('sess-x');

    writeConfig({ model: 'sonnet' }); // 配置口径只认 sonnet/haiku(loadServerConfig 规整)
    expect(service.prewarmCompanion()).toBe(true);
    const call2 = await waitSpawn(2);
    expectResidentTreeKill(call1.child, 4001); // 旧进程树杀
    expect(resumeIdOf(call2)).toBe('sess-x');
    expect(argsOf(call2)).toContain('sonnet');
    expect(getCompanionProcessInfo()?.pid).toBe(4002);
  });

  it('P4 开关:TC_VOICE_PREWARM=0 或常驻通道关 → 一律静默不 spawn', async () => {
    // ① 本文件 beforeEach 默认已置 TC_VOICE_PREWARM=0。
    expect(service.prewarmCompanion()).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCalls).toHaveLength(0);

    // ② 预热开但常驻通道关:同样不 spawn(两者叠加判定在 runner 内)。
    vi.stubEnv('TC_VOICE_PREWARM', '1');
    vi.stubEnv('TC_JARVIS_COMPANION_RESIDENT', '0');
    expect(service.prewarmCompanion()).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it('P5 崩溃降级回合:finish 尾自动补建,下一回合复用(不再吃冷启动)', async () => {
    vi.stubEnv('TC_VOICE_PREWARM', '1');

    const p1 = startProcess('崩一下');
    const call1 = await waitSpawn(1);
    call1.child.emit('close', 1); // 无文本退出 → 降级;常驻进程已死
    const r1 = await p1;
    expect(r1.degraded).toBe(true);

    await waitFor(() => spawnCalls.length >= 2, '降级后预热补建');
    const call2 = spawnCalls[1]!;
    expect(getCompanionProcessInfo()?.pid).toBe(4002);

    const p2 = startProcess('再试一句');
    await waitFor(() => call2.child.stdinWrites.length >= 1, '复用预热进程');
    expect(spawnCalls).toHaveLength(2);
    completeTurn(call2.child, 'sess-p');
    await p2;
    expect(getCompanionRunnerStats()).toMatchObject({ spawns: 2, reuses: 1 });
  });

  it('P6 中止回合:disposeTurn 统一出口补建(与 finish 同款)', async () => {
    vi.stubEnv('TC_VOICE_PREWARM', '1');

    const controller = new AbortController();
    const p1 = startProcess('中止一下', { signal: controller.signal });
    const call1 = await waitSpawn(1);
    controller.abort();
    await expect(p1).rejects.toMatchObject({ name: 'VoiceCompanionAborted' });
    expectResidentTreeKill(call1.child, 4001);

    await waitFor(() => spawnCalls.length >= 2, '中止后预热补建');
    expect(getCompanionProcessInfo()?.pid).toBe(4002);
  });
});
