/**
 * 任务10·⑦ 任务卡集成链路（验收 ⑥2 代理）：给 Boss 一张带验收标准的任务卡 →
 * 委派历史可见验收字段；并验证状态机 pending → running → done 的真实写盘 + 🔴⑦ 迁移埋点。
 *
 * 覆盖方式（真 LLM E2E 由金丝雀 full 承接，此处为进程内真实函数链路）：
 * - 真实：parseBossDelegation（Boss 围栏块解析）→ bossService.addDelegationToHistory
 *   → delegation-history.json（XDG 沙箱）→ bossService.updateDelegationTaskCardStatus
 *   → completeDelegation（routes/agents.ts 与 runtime-listeners 使用的同一完成入口）；
 * - 仅 mock：agentService/runtimeService（不真跑下属进程），command-handler 的取命令上下文。
 *
 * 任务 02 登记限制：taskId 仅服务端进程内可达，本链路不跨下属进程。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const h = vi.hoisted(() => {
  let resolveSend: (() => void) | null = null;
  return {
    sendCommand: vi.fn((_agentId: string, _message: string) => new Promise<void>((resolve) => { resolveSend = resolve; })),
    resolveSend: () => resolveSend?.(),
  };
});

vi.mock('../../services/index.js', async () => {
  const realBoss = await vi.importActual<typeof import('../../services/boss-service.js')>('../../services/boss-service.js');
  return {
    agentService: { getAgent: vi.fn(() => undefined) },
    runtimeService: { sendCommand: h.sendCommand },
    bossService: realBoss,
    workPlanService: {},
    skillService: {},
  };
});

vi.mock('./command-handler.js', () => ({
  getLastBossCommand: vi.fn(() => ''),
  buildCustomAgentConfig: vi.fn(() => undefined),
}));

import { completeDelegation, getBossForSubordinate, parseBossDelegation, resetBossDelegationStateForTests } from './boss-response-handler.js';
import * as bossService from '../../services/boss-service.js';
import { closeEventDb, initEventDb } from '../../data/event-db.js';
import { querySystemLog, type SystemLogEntry } from '../../data/system-log.js';
import type { DelegationDecision } from '../../../shared/types.js';

const dataDir = path.join(process.env.XDG_DATA_HOME!, 'tide-commander');
const historyFile = path.join(dataDir, 'delegation-history.json');

/** 读回沙箱委派史里指定 taskCommand 的记录（真实落盘，非内存 mock）。 */
function readDecision(taskCommand: string): DelegationDecision {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as { histories: Record<string, DelegationDecision[]> };
  const found = Object.values(raw.histories).flat().find((d) => d.userCommand === taskCommand);
  if (!found) throw new Error(`decision not found in delegation-history.json: ${taskCommand}`);
  return found;
}

function taskCardStatusRows(): Array<{ body: Record<string, unknown>; row: SystemLogEntry }> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .map((row) => ({ row, body: row.body ? (JSON.parse(row.body) as Record<string, unknown>) : {} }))
    .filter(({ body }) => body.phase === 'task-card-status');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('任务卡集成链路：带验收标准的卡 → 委派历史 + 状态机 + 🔴⑦ 埋点', () => {
  beforeAll(() => {
    fs.rmSync(historyFile, { force: true });
    fs.rmSync(`${historyFile}.bak`, { force: true });
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetBossDelegationStateForTests();
  });

  it('⑥2 代理：delegation 块带验收标准 → 委派历史可见验收字段；pending→running→done 全链路真实写盘', async () => {
    bossService.init();

    const resultText = `我来拆解这个任务。

\`\`\`delegation
[{"selectedAgentId":"agent-1","selectedAgentName":"Builder One","taskCommand":"实现登录页","reasoning":"builder 空闲","confidence":"high","taskCard":{"objective":"实现登录页","acceptanceCriteria":["npm run lint:types 通过","单测覆盖登录回退"],"dependencies":["设计稿 v2"],"priority":"P1","projectId":"proj-login","sourceProject":"proj-web"}}]
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, vi.fn());

    // 委托消息注入：下属收到可读任务卡（验收标准可见）
    expect(h.sendCommand).toHaveBeenCalledTimes(1);
    const sentMessage = h.sendCommand.mock.calls[0][1] as string;
    expect(sentMessage).toContain('[TASK CARD]');
    expect(sentMessage).toContain('单测覆盖登录回退');

    // 落卡持久化：验收字段真实写入 delegation-history.json
    const pending = readDecision('实现登录页');
    expect(pending.taskCard).toMatchObject({
      objective: '实现登录页',
      acceptanceCriteria: ['npm run lint:types 通过', '单测覆盖登录回退'],
      dependencies: ['设计稿 v2'],
      priority: 'P1',
      projectId: 'proj-login',
      sourceProject: 'proj-web',
      status: 'pending',
    });
    expect(typeof pending.taskCard?.statusUpdatedAt).toBe('number');
    expect(getBossForSubordinate('agent-1')?.decisionId).toBe(pending.id);

    // 交付成功（sendCommand resolve）→ pending → running
    h.resolveSend();
    await tick();
    const running = readDecision('实现登录页');
    expect(running.taskCard?.status).toBe('running');
    expect(running.taskCard!.statusUpdatedAt!).toBeGreaterThanOrEqual(pending.taskCard!.statusUpdatedAt!);

    // 完成入口（report-task / turn-complete 共用函数）→ running → done，追踪清理
    completeDelegation('agent-1', { success: true, reason: 'report-task' });
    const done = readDecision('实现登录页');
    expect(done.taskCard?.status).toBe('done');
    expect(done.taskCard!.statusUpdatedAt!).toBeGreaterThanOrEqual(running.taskCard!.statusUpdatedAt!);
    expect(getBossForSubordinate('agent-1')).toBeUndefined();

    // 🔴 决策观测点⑦：迁移 + 时间进 system_log（delegation 通道 task-card-status）
    const transitions = taskCardStatusRows().filter(({ body }) => body.decisionId === pending.id);
    expect(transitions.map(({ body }) => `${body.from}->${body.to}`)).toEqual(['none->pending', 'pending->running', 'running->done']);
    expect(transitions.map(({ body }) => body.at)).toEqual([
      pending.taskCard!.statusUpdatedAt,
      running.taskCard!.statusUpdatedAt,
      done.taskCard!.statusUpdatedAt,
    ]);
    expect(transitions[2].body.result).toBe('completed');
    expect(transitions[0].body.projectId).toBe('proj-login');
    // taskId 服务端进程内可达（任务 02 登记限制），落埋点列供时间线关联
    expect(pending.id).toBeTruthy();
    expect(transitions[0].row.taskId).toBeTruthy();
  });

  it('向后兼容：旧纯文本委派（无卡）不产生 taskCard/迁移埋点，完成入口退化为原 clearDelegation', async () => {
    bossService.init();
    const rowsBefore = taskCardStatusRows().length;

    parseBossDelegation('boss-1', 'Boss', `\`\`\`delegation
[{"selectedAgentId":"agent-2","selectedAgentName":"Builder Two","taskCommand":"纯文本旧任务","confidence":"medium"}]
\`\`\``, vi.fn());

    const decision = readDecision('纯文本旧任务');
    expect(decision.taskCard).toBeUndefined();
    expect(decision.status).toBe('sent'); // 旧字段语义不变

    h.resolveSend();
    await tick();
    completeDelegation('agent-2', { success: true, reason: 'turn-complete' });

    expect(readDecision('纯文本旧任务').taskCard).toBeUndefined();
    expect(getBossForSubordinate('agent-2')).toBeUndefined();
    expect(taskCardStatusRows().length).toBe(rowsBefore); // 零任务卡迁移埋点
  });
});
