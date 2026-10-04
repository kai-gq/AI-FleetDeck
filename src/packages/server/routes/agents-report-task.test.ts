/**
 * 任务10 未覆盖项①（入口 A）+ 任务08② 接线回归：
 * POST /api/agents/:id/report-task → completeDelegation(reason 'report-task')
 *   + 回执订阅播报统一入口 notifyTaskCompletion（source 'report-task'）；
 * 无 boss 早退路径也须通知（无 boss 回执同样过判断层留证）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Mock every module that agents.ts imports (与 agents-file-mention.test.ts 同装置)
// ---------------------------------------------------------------------------

vi.mock('../services/index.js', () => ({
  agentService: {
    getAgent: vi.fn(),
    archiveCurrentSession: vi.fn(),
    updateAgent: vi.fn(),
    sanitizeModelForProvider: vi.fn(),
    sanitizeCodexModel: vi.fn(),
    sanitizeGrokModel: vi.fn(),
    sanitizeOpencodeModel: vi.fn(),
    sanitizePiModel: vi.fn(),
  },
  runtimeService: {
    sendCommand: vi.fn(async () => true),
    stopAgent: vi.fn(),
    collapseAgentContext: vi.fn(),
    isAgentRunning: vi.fn(() => false),
    switchAgentModel: vi.fn(async () => true),
  },
  bossMessageService: { buildBossMessage: vi.fn(async () => ({ message: 'msg', systemPrompt: 'sp' })) },
  skillService: { buildSkillPromptContent: vi.fn(), hasPendingSkillUpdates: vi.fn(() => false), getSkillUpdateData: vi.fn(), clearPendingSkillUpdates: vi.fn() },
}));

vi.mock('../data/index.js', () => ({
  getClaudeProjectDir: vi.fn(() => '/tmp'),
  loadAreas: vi.fn(() => []),
  saveAreas: vi.fn(),
  loadBuildings: vi.fn(() => []),
}));

vi.mock('../claude/session-loader.js', () => ({
  loadSession: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  searchSession: vi.fn(async () => ({ results: [] })),
  detectSessionProvider: vi.fn(() => null),
}));

vi.mock('../services/custom-class-service.js', () => ({
  getAllCustomClasses: vi.fn(() => []),
  getCustomClass: vi.fn(),
  getClassInstructions: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));

vi.mock('../utils/log-context.js', () => ({
  withAgentContext: vi.fn((_id: string, fn: () => unknown) => fn()),
}));

vi.mock('../utils/string.js', () => ({
  truncateOrEmpty: vi.fn((s: string) => s ?? ''),
}));

vi.mock('../websocket/handlers/command-handler.js', () => ({
  buildCustomAgentConfig: vi.fn(),
  expandFileMentions: vi.fn(async (cmd: string) => cmd),
}));

vi.mock('../websocket/handlers/boss-response-handler.js', () => ({
  completeDelegation: vi.fn(),
  getBossForSubordinate: vi.fn(),
}));

vi.mock('../websocket/handlers/task-receipt-notifier.js', () => ({
  notifyTaskCompletion: vi.fn(() => ({
    matched: false,
    duplicate: false,
    tier: 'SILENT',
    reason: 'low_relevance',
    score: 0,
    forwarded: false,
  })),
}));

vi.mock('../services/activity-log.js', () => ({
  logDelegation: vi.fn(),
}));

vi.mock('../opencode/backend.js', () => ({
  OpencodeBackend: class { listSessions = vi.fn(async () => []); },
}));

vi.mock('../services/system-prompt-service.js', () => ({
  getSystemPrompt: vi.fn(() => null),
  setSystemPrompt: vi.fn(),
  clearSystemPrompt: vi.fn(),
  isEchoPromptEnabled: vi.fn(() => false),
  setEchoPromptEnabled: vi.fn(),
  getCodexBinaryPath: vi.fn(() => null),
  setCodexBinaryPath: vi.fn(),
  isTmuxModeEnabled: vi.fn(() => false),
  setTmuxModeEnabled: vi.fn(),
  isInteractiveModeEnabled: vi.fn(() => false),
  setInteractiveModeEnabled: vi.fn(),
}));

vi.mock('../services/agent-terminal-service.js', () => ({
  startAgentTerminal: vi.fn(),
  stopAgentTerminal: vi.fn(),
}));

vi.mock('../services/claude-usage-service.js', () => ({
  buildClaudeUsageByAgentSummary: vi.fn(() => []),
  buildClaudeUsageByDaySummary: vi.fn(() => []),
  buildClaudeUsageSnapshot: vi.fn(() => ({})),
}));

vi.mock('../services/grok-usage-service.js', () => ({
  buildGrokUsageSnapshot: vi.fn(() => ({})),
}));

vi.mock('../services/backup-service.js', () => ({
  getBackupStatus: vi.fn(() => ({ enabled: false })),
  setBackupEnabled: vi.fn(),
}));

import { agentService, runtimeService } from '../services/index.js';
import { completeDelegation, getBossForSubordinate } from '../websocket/handlers/boss-response-handler.js';
import { notifyTaskCompletion } from '../websocket/handlers/task-receipt-notifier.js';
import { reportTaskToBoss } from '../data/builtin-skills/report-task-to-boss.js';
import agentsRouter, { setBroadcast } from './agents.js';

let server: http.Server;
let baseUrl: string;
const broadcast = vi.fn();

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/agents', agentsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runtimeService.sendCommand).mockResolvedValue(true as any);
  setBroadcast(broadcast);
});

/** 任务17·A3：completed 合法载荷（验收打勾 + 产出位置齐备）。 */
const COMPLETED_BODY = {
  summary: '已完成并通过测试',
  status: 'completed',
  outputLocation: 'src/auth/login.tsx',
  acceptance: [{ item: '登录可用', done: true }],
};

function reportTask(body: Record<string, unknown> = COMPLETED_BODY) {
  return fetch(`${baseUrl}/api/agents/agent-1/report-task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/agents/:id/report-task — 任务08② 回执通知接线', () => {
  it('有 boss：通知回执（source report-task，带摘要与转发出口）+ completeDelegation(report-task, A3 字段透传)', async () => {
    const subordinate = { id: 'agent-1', name: 'Builder One', class: 'builder', bossId: 'boss-1' };
    const boss = { id: 'boss-1', name: 'Boss' };
    vi.mocked(agentService.getAgent).mockImplementation((id: string) =>
      (id === 'agent-1' ? subordinate : id === 'boss-1' ? boss : undefined) as any,
    );
    vi.mocked(getBossForSubordinate).mockReturnValue({
      bossId: 'boss-1',
      taskDescription: '实现登录页',
      taskId: 't-1',
    } as any);

    const res = await reportTask();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ forwarded: true, bossId: 'boss-1', taskStatus: 'completed' });
    expect(notifyTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        subordinateId: 'agent-1',
        agentName: 'Builder One',
        success: true,
        summary: '已完成并通过测试',
        source: 'report-task',
        broadcast,
      }),
    );
    // ⑧ 病历（任务11）+ 任务17·A3：summary/outputLocation/acceptance 随完成入口透传落库
    expect(completeDelegation).toHaveBeenCalledWith('agent-1', {
      success: true,
      reason: 'report-task',
      summary: '已完成并通过测试',
      outputLocation: 'src/auth/login.tsx',
      acceptance: [{ item: '登录可用', done: true }],
    });
  });

  it('无 boss 早退：通知回执仍触发（不静默），completeDelegation 不被调用', async () => {
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', name: 'Builder One', class: 'builder' } as any);
    vi.mocked(getBossForSubordinate).mockReturnValue(undefined as any);

    const res = await reportTask({ summary: '独自完成', status: 'failed' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ forwarded: false, bossId: null });
    expect(notifyTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        subordinateId: 'agent-1',
        agentName: 'Builder One',
        success: false,
        source: 'report-task',
      }),
    );
    expect(completeDelegation).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 任务17·A3：completed 验收自检必填（400 + 重发指引）、failed 不拦、透传落库
// ============================================================================

describe('POST /api/agents/:id/report-task — A3 验收自检必填', () => {
  function bootBossedAgent() {
    const subordinate = { id: 'agent-1', name: 'Builder One', class: 'builder', bossId: 'boss-1' };
    const boss = { id: 'boss-1', name: 'Boss' };
    vi.mocked(agentService.getAgent).mockImplementation((id: string) =>
      (id === 'agent-1' ? subordinate : id === 'boss-1' ? boss : undefined) as any,
    );
    vi.mocked(getBossForSubordinate).mockReturnValue({
      bossId: 'boss-1',
      taskDescription: '实现登录页',
      taskId: 't-1',
    } as any);
  }

  it('completed 缺 acceptance → 400（missing=[acceptance]）+ 期望字段示例 + 重发指引；无任何副作用', async () => {
    bootBossedAgent();
    const res = await reportTask({ summary: '完成了', status: 'completed', outputLocation: 'src/auth' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, missing: ['acceptance'] });
    expect(body.error).toContain('acceptance');
    expect(body.expected).toEqual({
      summary: 'what was done and the result',
      status: 'completed',
      outputLocation: 'path or link to the deliverable',
      acceptance: [{ item: 'acceptance criterion verified', done: true }],
    });
    expect(body.hint).toContain('POST /api/agents/agent-1/report-task');
    // 拒收 = 零副作用：不通知回执、不写病历、不播报
    expect(notifyTaskCompletion).not.toHaveBeenCalled();
    expect(completeDelegation).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('completed 缺 outputLocation（含空白串）→ 400（missing=[outputLocation]）', async () => {
    bootBossedAgent();
    const res = await reportTask({ summary: '完成了', status: 'completed', acceptance: [{ item: 'x', done: true }] });
    expect(res.status).toBe(400);
    expect((await res.json()).missing).toEqual(['outputLocation']);

    const blank = await reportTask({
      summary: '完成了',
      status: 'completed',
      outputLocation: '   ',
      acceptance: [{ item: 'x', done: true }],
    });
    expect(blank.status).toBe(400);
    expect((await blank.json()).missing).toEqual(['outputLocation']);
  });

  it('两个都缺 → 400 missing 两项；空数组/坏条目形状（item 空串、done 非布尔、非对象）同样 400', async () => {
    bootBossedAgent();
    const both = await reportTask({ summary: '完成了', status: 'completed' });
    expect(both.status).toBe(400);
    expect((await both.json()).missing).toEqual(['acceptance', 'outputLocation']);

    for (const bad of [
      [],
      [{ item: '  ', done: true }],
      [{ item: 'x', done: 'yes' }],
      ['not-an-object'],
      [{ item: 'x' }],
    ]) {
      const res = await reportTask({ summary: '完成了', status: 'completed', outputLocation: 'src/auth', acceptance: bad });
      expect(res.status, `acceptance=${JSON.stringify(bad)} 应被拒`).toBe(400);
      expect((await res.json()).missing).toEqual(['acceptance']);
    }
    expect(completeDelegation).not.toHaveBeenCalled();
  });

  it('completed 齐备 → 200 且 acceptance/outputLocation 逐字段透传落库（含多条打勾）', async () => {
    bootBossedAgent();
    const res = await reportTask({
      summary: '完成',
      status: 'completed',
      outputLocation: ' reports/weekly/w.md ',
      acceptance: [
        { item: '单测通过', done: true },
        { item: '文档更新', done: false },
      ],
    });

    expect(res.status).toBe(200);
    expect(completeDelegation).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      success: true,
      reason: 'report-task',
      outputLocation: ' reports/weekly/w.md ',
      acceptance: [
        { item: '单测通过', done: true },
        { item: '文档更新', done: false },
      ],
    }));
  });

  it('failed 不强制：缺字段照常 200；夹带的坏形状字段被剥离（不落库）', async () => {
    bootBossedAgent();
    const bare = await reportTask({ summary: '没做成', status: 'failed' });
    expect(bare.status).toBe(200);
    expect(completeDelegation).toHaveBeenCalledWith('agent-1', {
      success: false,
      reason: 'report-task',
      summary: '没做成',
    });

    const dirty = await reportTask({
      summary: '没做成',
      status: 'failed',
      outputLocation: '   ',
      acceptance: [{ item: '', done: true }],
    });
    expect(dirty.status).toBe(200);
    const lastCall = vi.mocked(completeDelegation).mock.calls.at(-1);
    expect(lastCall?.[1]).not.toHaveProperty('acceptance');
    expect(lastCall?.[1]).not.toHaveProperty('outputLocation');
  });

  it('status 缺省按 completed 处理 → 同样触发必填校验（400）', async () => {
    bootBossedAgent();
    const res = await reportTask({ summary: '没写状态' });
    expect(res.status).toBe(400);
    expect((await res.json()).missing).toEqual(['acceptance', 'outputLocation']);
  });
});

describe('report-task-to-boss 技能文本 — A3 回执契约同步', () => {
  it('含 JSON 示例（outputLocation + acceptance）与 400 拒收说明；保留 API 端点字面量', () => {
    const content = reportTaskToBoss.content;
    expect(content).toContain('POST /api/agents/YOUR_AGENT_ID/report-task');
    expect(content).toContain('"outputLocation"');
    expect(content).toContain('"acceptance"');
    expect(content).toContain('{"item":"acceptance criterion verified","done":true}');
    expect(content).toContain('rejected with HTTP 400');
    expect(content).toContain('reports do not require them');
  });
});
