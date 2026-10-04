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

function reportTask(body: Record<string, unknown> = { summary: '已完成并通过测试', status: 'completed' }) {
  return fetch(`${baseUrl}/api/agents/agent-1/report-task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/agents/:id/report-task — 任务08② 回执通知接线', () => {
  it('有 boss：通知回执（source report-task，带摘要与转发出口）+ completeDelegation(report-task)', async () => {
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
    expect(completeDelegation).toHaveBeenCalledWith('agent-1', { success: true, reason: 'report-task' });
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
