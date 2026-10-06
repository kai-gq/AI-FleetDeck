/**
 * 任务16·⑬ 撤回/评价 —— vcs 接线层集成测试（契约 action → 目标解析 → 执行链 → 播报/回写）。
 *
 * 与 voice-companion-service.integration.test.ts 同款边界替身（假 claude 子进程 /
 * agent-service 夹具 / services.index 桩），差异：services/index 桩额外提供可用的
 * agentService + 真实 bossService —— 因为 cancel_delegation 分支会动态 import
 * boss-response-handler，其 cancelDelegation 真实执行（找史、迁卡、通知、审计）。
 *
 * 覆盖（brief 第 5 条）：
 *   - 两动作契约解析/分支：cancel 唯一 live 命中执行、queued 候选从排队撤下、无目标固定话术、
 *     done 拒撤、已撤幂等；rate satisfied 写回、unsatisfied 写回、unknown 追问、无目标固定话术；
 *   - 反问一次性：多候选平票 → 反问挂起；下一回合编号作答不跑 hop1、只撤所选、挂起消费殆尽；
 *   - hop1 话术不出声（SpeechGate 丢弃，onSentence 零回调）；
 *   - 白名单：COMPANION_ACTIONS/parseContractJson 接纳两动作，未知 action 回落。
 *
 * 三保险防误写真实数据（同 integration 范本）：
 *   1) src/test-setup.ts 已把 XDG_DATA_HOME 指向进程级临时沙箱（模块加载前）；
 *   2) beforeAll 先 chdir 到临时工程目录再动态 import 服务；
 *   3) beforeAll 硬断言状态文件落在 XDG 沙箱内，失败立即终止。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VoiceProcessOptions, VoiceProcessResult } from './voice-companion-service.js';
import { closeEventDb, initEventDb } from '../data/event-db.js';
import { querySystemLog } from '../data/system-log.js';
import * as bossService from './boss-service.js';
import type { DelegationDecision, TaskCard } from '../../shared/agent-types.js';
import type { DrawingArea } from '../../shared/common-types.js';
import {
  DELEGATION_QUOTA_BUDGET_ENV,
  DELEGATION_QUOTA_PHASE_CANCELLED,
  getDelegationQuotaSnapshot,
  tryAdmitDelegation,
} from './delegation-quota-gate.js';

// ============================================================================
// 假 claude 子进程（与 integration 范本同款）
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

function fakeSpawn(cmd: string, args: string[], opts: SpawnOpts): FakeChild {
  const child = new FakeChild();
  spawnCalls.push({ cmd, args, opts, child });
  process.nextTick(() => child.emit('spawn'));
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: fakeSpawn };
});

// ============================================================================
// 系统边界替身（agent 世界 / 数据目录 / services 入口 / websocket 配置）
// ============================================================================

interface MockAgent {
  id: string;
  name: string;
  class?: string;
  status: string;
  isBoss?: boolean;
}

const mockAgents: MockAgent[] = [];
/** 项目路由世界（默认空；撤回/评价用例不依赖区域数据，只要读盘不发生）。 */
const mockAreas: DrawingArea[] = [];

vi.mock('./agent-service.js', () => ({
  getAllAgents: () => mockAgents,
  getAgent: (id: string) => mockAgents.find((a) => a.id === id),
  getAgentHistory: async () => ({ messages: [] }),
}));

vi.mock('../data/index.js', async () => {
  const actual = await vi.importActual<typeof import('../data/index.js')>('../data/index.js');
  return { ...actual, loadAreas: () => mockAreas };
});

const stopAgentMock = vi.fn(async (_agentId: string) => {});
const sendCommandMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('./index.js', async () => {
  // 真实 boss-service 单例（撤回迁卡/评价回写走真实落盘链路，沙箱内）
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
    bossMessageService: {
      buildBossMessage: async (id: string, message: string) => ({
        message: `BOSS:${message}`,
        systemPrompt: `sys:${id}`,
      }),
    },
  };
});

vi.mock('../websocket/handlers/command-handler.js', () => ({
  getLastBossCommand: () => undefined,
  buildCustomAgentConfig: (id: string, cls?: string) => ({ __custom: id, cls }),
}));

// ============================================================================
// 沙箱、临时工程目录与状态文件
// ============================================================================

const dataHome = process.env.XDG_DATA_HOME;
if (!dataHome) throw new Error('XDG_DATA_HOME 未设置:test-setup 沙箱失效,拒绝加载本测试文件');

const stateFilePath = path.join(dataHome, 'tide-commander', 'voice-companion.json');
const delegationHistoryPath = path.join(dataHome, 'tide-commander', 'delegation-history.json');

let service: typeof import('./voice-companion-service.js');
let handler: typeof import('../websocket/handlers/boss-response-handler.js');
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

function writeConfig(): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(DEFAULT_TEST_CONFIG));
}

function seedAgents(): void {
  mockAgents.length = 0;
  mockAgents.push(
    { id: 'b1', name: '主管', class: 'boss', isBoss: true, status: 'idle' },
    { id: 'a-mei', name: '小美', class: 'builder', status: 'working' },
    { id: 'a-gang', name: '小刚', class: 'builder', status: 'working' },
  );
}

beforeAll(async () => {
  originalCwd = process.cwd();
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cancel-'));
  fs.mkdirSync(path.join(projectDir, 'tools', 'voice-companion'), { recursive: true });
  process.chdir(projectDir);
  initEventDb(); // 撤回审计落 system_log（XDG 沙箱内真盘可查）

  service = await import('./voice-companion-service.js');
  handler = await import('../websocket/handlers/boss-response-handler.js');

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
  mockAgents.length = 0;
  mockAreas.length = 0;
  seedAgents();
  stopAgentMock.mockReset();
  stopAgentMock.mockImplementation(async () => {});
  sendCommandMock.mockReset();
  sendCommandMock.mockImplementation(async () => {});
  fs.rmSync(stateFilePath, { force: true });
  fs.rmSync(delegationHistoryPath, { force: true });
  // 数据层 safeReadJsonSync 有 .bak 兜底(主文件缺失时从备份恢复并写回主文件)——
  // 沙箱隔离必须连备份一起清,否则上一用例的委派史会在下一用例「起死回生」
  // （B4 窗口测试正是在此翻红:test ① 的 d-fresh 经 .bak 复活成 live 候选）。
  fs.rmSync(`${delegationHistoryPath}.bak`, { force: true });
  fs.rmSync(`${delegationHistoryPath}.tmp`, { force: true });
  service.resetProjectRoutingSession();
  service.resetCancelClarificationSession();
  service.resetLastBossDispatchForTests(); // HC-B4：模块级派发缓存跨用例复位
  handler.resetBossDelegationStateForTests(); // 追踪/回执/配额账本全复位
  bossService.init();
  writeConfig();
  // W3 预热点火:本文件回合均以 close 收尾(常驻进程死亡),预热会在测试间隙
  // 触发额外 spawn 污染计数 —— 统一关掉;预热语义由 resident.test.ts 的 P1-P6 专测。
  vi.stubEnv('TC_VOICE_PREWARM', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ============================================================================
// helpers：驱动假子进程 / 夹具 / 盘面读取
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
  messageToAgent?: string;
}

function contractText(c: TestContract): string {
  return JSON.stringify({
    action: c.action,
    responseToUser: c.responseToUser ?? '',
    targetAgentId: null,
    targetAgentName: null,
    messageToAgent: c.messageToAgent ?? '',
    delivery: 'queue',
    query: '',
    bolbaTask: '',
    memoryOps: [],
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
  opts: { via?: TextChannel; code?: number } = {},
): Promise<void> {
  emitText(child, text, opts.via ?? 'assistant');
  await closeChild(child, opts.code ?? 0);
}

// ── 夹具 ──

function taskCard(over: Partial<TaskCard> = {}): TaskCard {
  return { objective: '登录页改造', acceptanceCriteria: [], dependencies: [], status: 'running', ...over };
}

function decision(over: Partial<DelegationDecision> & { id: string }): DelegationDecision {
  return {
    timestamp: 1_000,
    bossId: 'b1',
    userCommand: over.id,
    selectedAgentId: 'a-mei',
    selectedAgentName: '小美',
    reasoning: 'fixture',
    alternativeAgents: [],
    confidence: 'medium',
    status: 'sent',
    ...over,
  };
}

/** 沙箱内写委派史 fixture 并走 bossService.init() 真实读取链路。 */
function seedHistory(decisions: DelegationDecision[]): void {
  fs.mkdirSync(path.dirname(delegationHistoryPath), { recursive: true });
  fs.writeFileSync(delegationHistoryPath, JSON.stringify({ histories: { b1: decisions }, savedAt: 0, version: '1.0.0' }));
  bossService.init();
}

/** 直接种 handler 的 live 追踪（等价于已派发在跑）。 */
function seedLive(subordinateId: string, opts: { decisionId: string; taskId: string; card: TaskCard; taskDescription?: string }): void {
  handler.activeDelegations.set(subordinateId, {
    bossId: 'b1',
    taskDescription: opts.taskDescription ?? opts.card.objective,
    taskId: opts.taskId,
    decisionId: opts.decisionId,
    taskCard: opts.card,
  });
}

function lastDecisionOnDisk(id: string): DelegationDecision | undefined {
  if (!fs.existsSync(delegationHistoryPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(delegationHistoryPath, 'utf-8')) as {
    histories: Record<string, DelegationDecision[]>;
  };
  return Object.values(raw.histories).flat().find((d) => d.id === id);
}

// ── system_log 查询（delegation 通道） ──

function delegationRows(): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .map((row) => (row.body ? (JSON.parse(row.body) as Record<string, unknown>) : {}));
}

/** ⑬ 撤回审计行（phase='cancelled'，按 toAgentId 过滤）。 */
function cancelAuditRows(toAgentId: string): Array<Record<string, unknown>> {
  return delegationRows().filter((body) => body.phase === 'cancelled' && body.toAgentId === toAgentId);
}

/** 🟡⑫ 配额审计行（按 phase + decisionId 过滤）。 */
function quotaRows(phase: string, decisionId: string): Array<Record<string, unknown>> {
  return delegationRows().filter((body) => body.phase === phase && body.decisionId === decisionId);
}

// ============================================================================
// 白名单：契约模板/解析接纳两个新动作
// ============================================================================

describe('任务16·⑬ 契约白名单', () => {
  it('COMPANION_ACTIONS 含两动作；parseContractJson 接纳且未知 action 回落', () => {
    expect(service.COMPANION_ACTIONS).toContain('cancel_delegation');
    expect(service.COMPANION_ACTIONS).toContain('rate_delegation');
    expect(service.parseContractJson('{"action":"cancel_delegation"}').action).toBe('cancel_delegation');
    expect(service.parseContractJson('{"action":"rate_delegation"}').action).toBe('rate_delegation');
    expect(service.parseContractJson('{"action":"withdraw_everything"}').action).toBe('general_response');
  });
});

// ============================================================================
// cancel_delegation 分支
// ============================================================================

describe('任务16·⑬ cancel_delegation 分支', () => {
  it('唯一 live 命中 → 真实撤回链：确定话术、卡迁移 cancelled、通知带 A3 回执口径、hop1 话术不出声', async () => {
    seedHistory([
      decision({
        id: 'd-mei',
        userCommand: '把登录页那个活做了',
        taskCard: taskCard({ objective: '登录页改造', status: 'running' }),
      }),
    ]);
    seedLive('a-mei', { decisionId: 'd-mei', taskId: 't-mei', card: taskCard({ objective: '登录页改造', status: 'running' }) });

    const spoken: string[] = [];
    const p = startProcess('把小美那个登录页的活撤了', { onSentence: (s) => spoken.push(s) });
    const call = await waitSpawn(1);
    // 走 delta 通道：文本真经过 SpeechGate，仍必须被丢弃（判别性在于一旦丢弃表漏登记就会出声）
    await completeWith(call.child, contractText({ action: 'cancel_delegation', responseToUser: '好的,我这就去撤。' }), { via: 'delta' });
    const r = await p;

    expect(r.action).toBe('cancel_delegation');
    expect(r.response).toBe('好,已撤回「小美」的「登录页改造」。已通知小美停手。');
    expect(r.targetAgent).toEqual({ id: 'a-mei', name: '小美' });
    expect(spoken).toEqual([]); // hop1 话术丢弃：onSentence 零回调
    expect(r.spoke).toBeUndefined();

    // 通知投递：forceInterrupt + 任务17·A3 回执口径（failed 免验收；completed 需 outputLocation+acceptance）
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    const args = sendCommandMock.mock.calls[0] as unknown as [string, string, unknown, unknown, unknown, unknown];
    expect(args[0]).toBe('a-mei');
    expect(args[1]).toContain('[TASK CANCELLED by boss "主管"]');
    // 锚定 A3 回执口径的固定短语（回退整段即变红，不接受零散字段名顶替）
    expect(args[1]).toContain('用 "status":"failed"');
    expect(args[1]).toContain('必须带 outputLocation 与非空 acceptance（逐条 {"item","done"}）');
    expect(args[5]).toEqual({ forceInterrupt: true });

    // 追踪清理 + 卡迁移 + ⑬ 审计
    expect(handler.activeDelegations.has('a-mei')).toBe(false);
    expect(lastDecisionOnDisk('d-mei')?.taskCard?.status).toBe('cancelled');
    const audit = cancelAuditRows('a-mei');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'cancelled-running',
      initiator: 'user',
      toAgentName: '小美',
      notified: true,
      message: '登录页改造',
    });
    expect(typeof audit[0].notifyMs).toBe('number');
  });

  it('多候选平票 → 一次反问挂起；下一回合「第二个」不跑 hop1 直接撤所选，挂起一次性消费', async () => {
    seedHistory([
      decision({ id: 'd-mei', userCommand: '改造登录页', taskCard: taskCard({ objective: '登录页改造', status: 'running' }) }),
      decision({
        id: 'd-gang',
        timestamp: 2_000,
        selectedAgentId: 'a-gang',
        selectedAgentName: '小刚',
        userCommand: '重构登录页',
        taskCard: taskCard({ objective: '登录页重构', status: 'running' }),
      }),
    ]);
    seedLive('a-mei', { decisionId: 'd-mei', taskId: 't-mei', card: taskCard({ objective: '登录页改造', status: 'running' }) });
    seedLive('a-gang', { decisionId: 'd-gang', taskId: 't-gang', card: taskCard({ objective: '登录页重构', status: 'running' }) });

    const p1 = startProcess('取消登录页');
    const c1 = await waitSpawn(1);
    await completeWith(c1.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    const r1 = await p1;
    expect(r1.action).toBe('cancel_delegation');
    expect(r1.response).toContain('要撤回哪一个？');
    expect(r1.response).toContain('1）小美：登录页改造');
    expect(r1.response).toContain('2）小刚：登录页重构');
    expect(r1.response).toContain('回个编号或名字');

    // 第二回合：确定性消费挂起，不再跑 hop1（无新子进程）
    const p2 = startProcess('第二个');
    const r2 = await p2;
    expect(spawnCalls).toHaveLength(1);
    expect(r2.action).toBe('cancel_delegation');
    expect(r2.response).toBe('好,已撤回「小刚」的「登录页重构」。已通知小刚停手。');
    expect(r2.targetAgent).toEqual({ id: 'a-gang', name: '小刚' });
    expect(sendCommandMock.mock.calls.map((c) => c[0])).toEqual(['a-gang']);
    // 只撤所选：被选者清追踪+卡迁移，未被选者原样健在
    expect(handler.activeDelegations.has('a-gang')).toBe(false);
    expect(handler.activeDelegations.has('a-mei')).toBe(true);
    expect(lastDecisionOnDisk('d-gang')?.taskCard?.status).toBe('cancelled');
    expect(lastDecisionOnDisk('d-mei')?.taskCard?.status).toBe('running');

    // 挂起已消费殆尽：下一回合回到 hop1，不再反问
    const p3 = startProcess('谢谢');
    const c3 = await waitSpawn(2);
    await completeWith(c3.child, contractText({ action: 'general_response', responseToUser: '不客气。' }));
    const r3 = await p3;
    expect(r3.response).toBe('不客气。');
  });

  it('无目标 → 固定话术，不通知不写盘', async () => {
    const p = startProcess('把那个任务撤了');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    const r = await p;
    expect(r.action).toBe('cancel_delegation');
    expect(r.response).toBe('现在没有可以撤回的在办任务。');
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(handler.activeDelegations.size).toBe(0);
  });

  it('目标已完成（史源 done 卡）→ 拒撤话术，零副作用', async () => {
    seedHistory([
      decision({
        id: 'd-gang',
        selectedAgentId: 'a-gang',
        selectedAgentName: '小刚',
        userCommand: '修复支付回调',
        status: 'completed',
        completion: { completedAt: 3_000, durationMs: 1_000, result: 'completed' },
        taskCard: taskCard({ objective: '支付回调修复', status: 'done', statusUpdatedAt: 2_900 }),
      }),
    ]);
    const p = startProcess('取消支付回调修复');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    const r = await p;
    expect(r.response).toBe('「支付回调修复」已经完成了,撤不回来。');
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(lastDecisionOnDisk('d-gang')?.taskCard?.status).toBe('done');
  });

  it('目标已撤过（史源 cancelled 卡）→ 幂等话术，不重复通知', async () => {
    seedHistory([
      decision({
        id: 'd-mei',
        userCommand: '改造登录页',
        taskCard: taskCard({ objective: '登录页改造', status: 'cancelled', statusUpdatedAt: 1_500 }),
      }),
    ]);
    const p = startProcess('取消登录页改造');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    const r = await p;
    expect(r.response).toBe('这个任务之前已经撤过了,不用再撤一次。');
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('queued 候选（配额排队）→ 从队列撤下、不通知；快照清空 + quota-cancelled 审计', async () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '0'); // 全部排队
    const admitted = tryAdmitDelegation({
      taskId: 't-q',
      bossId: 'b1',
      decisionId: 'd-q',
      selectedAgentId: 'a-gang',
      selectedAgentName: '小刚',
      taskCommand: '支付回调修复',
      taskCard: taskCard({ objective: '支付回调修复', status: 'queued' }),
    });
    expect(admitted.status).toBe('queued');

    const p = startProcess('把支付回调修复撤了');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    const r = await p;

    expect(r.action).toBe('cancel_delegation');
    expect(r.response).toBe('好,已撤回「小刚」的「支付回调修复」(还没开工,已从排队中撤下)。');
    expect(r.targetAgent).toEqual({ id: 'a-gang', name: '小刚' });
    expect(sendCommandMock).not.toHaveBeenCalled(); // queued 未派发 → 不通知
    const snap = getDelegationQuotaSnapshot();
    expect(snap.queuedIds).toEqual([]);
    expect(snap.queued).toEqual([]);
    expect(quotaRows(DELEGATION_QUOTA_PHASE_CANCELLED, 'd-q')).toHaveLength(1);
    // system_log 跨用例累计（前序用例也撤过 a-gang）→ 按本条撤回结论过滤
    const queuedAudit = cancelAuditRows('a-gang').filter((row) => row.status === 'cancelled-queued');
    expect(queuedAudit).toHaveLength(1);
    expect(queuedAudit[0]).toMatchObject({ message: '支付回调修复', notified: false });
  });
});

// ============================================================================
// rate_delegation 分支
// ============================================================================

describe('任务16·⑬ rate_delegation 分支（承接任务11 评价回写）', () => {
  function completedFixture(id: string, completedAt: number, over: Partial<DelegationDecision> = {}): DelegationDecision {
    return decision({
      id,
      userCommand: '写周报',
      status: 'completed',
      completion: { completedAt, durationMs: 1_000, result: 'completed' },
      taskCard: taskCard({ objective: '写周报', status: 'done', statusUpdatedAt: completedAt }),
      ...over,
    });
  }

  it('满意 → 写回沙箱委派史并确认播报；已评不再入选（覆盖排除）', async () => {
    seedHistory([completedFixture('d-report', 5_000)]);
    const p = startProcess('刚才那个活干得不错');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'rate_delegation', responseToUser: '好。' }));
    const r = await p;

    expect(r.action).toBe('rate_delegation');
    expect(r.response).toBe('已记下：对「小美」的「写周报」评价为满意。');
    expect(r.targetAgent).toEqual({ id: 'a-mei', name: '小美' });
    const onDisk = lastDecisionOnDisk('d-report');
    expect(onDisk?.userRating).toBe('satisfied');
    expect(onDisk?.ratedAt).toBeGreaterThan(0);

    // 覆盖排除：同一目标已评价 → 下一回合明确「没有待评价」，不改写已有评价
    const p2 = startProcess('不错');
    const c2 = await waitSpawn(2);
    await completeWith(c2.child, contractText({ action: 'rate_delegation', responseToUser: '好。' }));
    const r2 = await p2;
    expect(r2.response).toBe('最近没有已完成、还没评价的任务。');
    expect(lastDecisionOnDisk('d-report')?.ratedAt).toBe(onDisk?.ratedAt);
  });

  it('极性不明 → 追问且目标不变；下一回合补评价（同一目标，不满意）', async () => {
    seedHistory([completedFixture('d-draft', 6_000)]);
    const p1 = startProcess('嗯');
    const c1 = await waitSpawn(1);
    await completeWith(c1.child, contractText({ action: 'rate_delegation', responseToUser: '好。' }));
    const r1 = await p1;
    expect(r1.response).toBe('要给「小美」的「写周报」打满意还是不满意？');
    expect(lastDecisionOnDisk('d-draft')?.userRating).toBeUndefined(); // 不猜不写

    const p2 = startProcess('不太满意');
    const c2 = await waitSpawn(2);
    await completeWith(c2.child, contractText({ action: 'rate_delegation', responseToUser: '好。' }));
    const r2 = await p2;
    expect(r2.response).toBe('已记下：对「小美」的「写周报」评价为不满意。');
    expect(lastDecisionOnDisk('d-draft')?.userRating).toBe('unsatisfied');
  });

  it('无待评价目标（失败/已评都不入选）→ 固定话术，不覆盖已有评价', async () => {
    seedHistory([
      completedFixture('d-rated', 4_000, { userRating: 'satisfied', ratedAt: 4_500 }),
      decision({
        id: 'd-failed',
        userCommand: '跑测试',
        status: 'failed',
        completion: { completedAt: 9_000, durationMs: 1_000, result: 'failed' },
        taskCard: taskCard({ objective: '跑测试', status: 'running' }),
      }),
    ]);
    const p = startProcess('评价一下刚才那个活');
    const call = await waitSpawn(1);
    await completeWith(call.child, contractText({ action: 'rate_delegation', responseToUser: '好。' }));
    const r = await p;
    expect(r.response).toBe('最近没有已完成、还没评价的任务。');
    expect(lastDecisionOnDisk('d-rated')?.ratedAt).toBe(4_500); // 未被覆盖
    expect(lastDecisionOnDisk('d-failed')?.userRating).toBeUndefined();
  });
});

// ============================================================================
// HC-B4：撤回窗口等待（「刚交给主管、委派还没落地」的秒级空档）
// ============================================================================

describe('HC-B4：撤回窗口等待（dispatched→delegated 空档）', () => {
  /** 交办回合：delegate_to_boss 派发给主管（记录 lastBossDispatch = B4 窗口识别依据）。 */
  async function delegateRound(n: number, message: string): Promise<void> {
    const p = startProcess(message);
    const call = await waitSpawn(n);
    await completeWith(call.child, contractText({ action: 'delegate_to_boss', responseToUser: '好。', messageToAgent: message }));
    const r = await p;
    expect(r.action).toBe('delegate_to_boss');
    sendCommandMock.mockClear(); // 派发给主管的调用不计入撤回轮断言
  }

  it('窗口内主管拆解落地 → 有界等来新委派并正常撤回（替代「没有在办任务」）', async () => {
    vi.stubEnv('TC_VOICE_CANCEL_WAIT_MS', '5000');
    await delegateRound(1, '让团队把调研竞品做一下');
    expect(service.getLastBossDispatch()).toMatchObject({ bossId: 'b1' });

    const started = Date.now();
    const p2 = startProcess('把调研竞品撤了');
    const c2 = await waitSpawn(2);
    await completeWith(c2.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    // 此刻主管还没拆解完（无候选）→ 300ms 后委派落地（seedHistory+seedLive 同真实「决策产出」形态）
    await new Promise((r) => setTimeout(r, 300));
    seedHistory([decision({ id: 'd-fresh', userCommand: '调研竞品', taskCard: taskCard({ objective: '调研竞品', status: 'running' }) })]);
    seedLive('a-mei', { decisionId: 'd-fresh', taskId: 't-fresh', card: taskCard({ objective: '调研竞品', status: 'running' }) });
    const r2 = await p2;

    expect(r2.action).toBe('cancel_delegation');
    expect(r2.response).toBe('好,已撤回「小美」的「调研竞品」。已通知小美停手。');
    expect(r2.targetAgent).toEqual({ id: 'a-mei', name: '小美' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450); // 判别性：走了有界等待（首次轮询 500ms 起跳）
    expect(sendCommandMock.mock.calls.map((c) => c[0])).toEqual(['a-mei']);
    expect(handler.activeDelegations.has('a-mei')).toBe(false);
    expect(lastDecisionOnDisk('d-fresh')?.taskCard?.status).toBe('cancelled');
    const audit = cancelAuditRows('a-mei').filter((row) => row.message === '调研竞品');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 'cancelled-running', notified: true });
  });

  it('窗口内始终无落地 → 超时如实说「还在安排」+ pending-dispatch 审计，不硬说没有在办', async () => {
    vi.stubEnv('TC_VOICE_CANCEL_WAIT_MS', '600');
    await delegateRound(1, '让团队把周报整理一下');

    const p2 = startProcess('把周报撤了');
    const c2 = await waitSpawn(2);
    await completeWith(c2.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    const r2 = await p2;

    expect(r2.action).toBe('cancel_delegation');
    expect(r2.response).toBe('刚交给主管的那条还在安排,没落到人头上——这会儿撤不着。过几秒再喊一次「撤回」就行。');
    expect(r2.targetAgent).toBeUndefined();
    expect(sendCommandMock).not.toHaveBeenCalled();
    const audit = delegationRows().filter((body) => body.phase === 'cancelled' && body.status === 'pending-dispatch');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ initiator: 'user', reason: '把周报撤了', channel: 'voice-companion' });
  });

  it('等待开关关闭（TC_VOICE_CANCEL_WAIT_MS=0）→ 不等待、立即旧话术，零审计', async () => {
    vi.stubEnv('TC_VOICE_CANCEL_WAIT_MS', '0');
    await delegateRound(1, '让团队把竞品分析做一下');

    const started = Date.now();
    const pendingBefore = delegationRows().filter((body) => body.status === 'pending-dispatch').length;
    const p2 = startProcess('把竞品分析撤了');
    const c2 = await waitSpawn(2);
    await completeWith(c2.child, contractText({ action: 'cancel_delegation', responseToUser: '好。' }));
    const r2 = await p2;

    expect(r2.response).toBe('现在没有可以撤回的在办任务。'); // 0 = 整段回退旧行为
    expect(Date.now() - started).toBeLessThan(450);
    // system_log 跨用例累计（超时用例已留过 pending-dispatch 行）→ 按「无新增」断言
    expect(delegationRows().filter((body) => body.status === 'pending-dispatch')).toHaveLength(pendingBefore);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});
