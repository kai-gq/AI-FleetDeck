/**
 * 待岗（standby）HTTP 封堵回归：
 *  - PATCH /api/agents/:id 带 standby → 400（否则任何 agent 含 Boss 用 curl
 *    都能 {"standby":false} 自我恢复——这是用户专属开关，仅面板 WS 可切）；
 *  - POST /api/agents/:id/message 目标待岗 → 409（带可见拒绝文案）；
 *  - GET /api/agents/status 暴露只读 standby 字段（外部可观测）；
 *  - 对照：非 standby 的正常 PATCH / message 不受影响（防过度封堵）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Mock every module that agents.ts imports（沿用 agents-report-task.test.ts 装置）
// ---------------------------------------------------------------------------

vi.mock('../services/index.js', () => ({
  agentService: {
    getAgent: vi.fn(),
    getAllAgents: vi.fn(() => []),
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
    syncAllAgentStatus: vi.fn(async () => {}),
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
  notifyTaskCompletion: vi.fn(),
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
  setBroadcast(broadcast);
  vi.mocked(runtimeService.sendCommand).mockResolvedValue(true as any);
});

const STANDBY_AGENT = {
  id: 'sb-1', name: 'Standby One', class: 'default', status: 'idle',
  cwd: '/tmp/project', provider: 'claude', standby: true,
};

describe('PATCH /api/agents/:id — standby 封堵', () => {
  it('{"standby":false} → 400 且不落库（防 agent/Boss 自恢复）', async () => {
    vi.mocked(agentService.getAgent).mockReturnValue(STANDBY_AGENT as any);

    const res = await fetch(`${baseUrl}/api/agents/sb-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ standby: false }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('standby-user-only');
    expect(agentService.updateAgent).not.toHaveBeenCalled();
  });

  it('混入 standby 的其他更新同样整体拒绝', async () => {
    vi.mocked(agentService.getAgent).mockReturnValue(STANDBY_AGENT as any);

    const res = await fetch(`${baseUrl}/api/agents/sb-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskLabel: 'x', standby: true }),
    });

    expect(res.status).toBe(400);
    expect(agentService.updateAgent).not.toHaveBeenCalled();
  });

  it('对照：不带 standby 的普通 PATCH 正常放行', async () => {
    vi.mocked(agentService.getAgent).mockReturnValue(STANDBY_AGENT as any);
    vi.mocked(agentService.updateAgent).mockReturnValue({
      id: 'sb-1', name: 'Standby One', status: 'idle', ok: true,
    } as any);

    const res = await fetch(`${baseUrl}/api/agents/sb-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskLabel: 'x' }),
    });

    expect(res.status).toBe(200);
    expect(agentService.updateAgent).toHaveBeenCalledWith('sb-1', { taskLabel: 'x' });
  });
});

describe('POST /api/agents/:id/message — 待岗目标 409', () => {
  it('待岗 agent → 409 + 拒绝文案，且不投递', async () => {
    vi.mocked(agentService.getAgent).mockReturnValue(STANDBY_AGENT as any);

    const res = await fetch(`${baseUrl}/api/agents/sb-1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'do the thing' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('standby');
    expect(runtimeService.sendCommand).not.toHaveBeenCalled();
  });

  it('对照：非待岗 agent 正常投递', async () => {
    vi.mocked(agentService.getAgent).mockReturnValue({
      ...STANDBY_AGENT, standby: undefined,
    } as any);

    const res = await fetch(`${baseUrl}/api/agents/sb-1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'do the thing' }),
    });

    expect(res.status).toBe(200);
    expect(runtimeService.sendCommand).toHaveBeenCalled();
  });
});

describe('GET /api/agents/status — 只读 standby 字段', () => {
  it('暴露 standby 布尔（未待岗=false，脏值也归 false）', async () => {
    vi.mocked(agentService.getAllAgents).mockReturnValue([
      STANDBY_AGENT,
      { ...STANDBY_AGENT, id: 'a2', name: 'Active', standby: undefined },
      { ...STANDBY_AGENT, id: 'a3', name: 'Dirty', standby: 'yes' },
    ] as any);

    const res = await fetch(`${baseUrl}/api/agents/status`);
    const body = await res.json() as Array<{ id: string; standby: boolean }>;

    expect(res.status).toBe(200);
    expect(body.find((a) => a.id === 'sb-1')?.standby).toBe(true);
    expect(body.find((a) => a.id === 'a2')?.standby).toBe(false);
    expect(body.find((a) => a.id === 'a3')?.standby).toBe(false);
  });
});
