/**
 * 任务24 · 委派看板只读 API 测试（验收①③④）：
 *   - 五要素 + 病历关联字段（产出位置/验收/评价/优先级/项目）全量可达；
 *   - 在办追踪合并（in-flight）+ 史外孤儿不丢；
 *   - 分页/过滤/上限；错误降级不 500；
 *   - 只读：仅 GET（写方法一律 404）。
 * mock 面：agentService（不加载真实 agent 表）、boss-service 委派史、在办追踪快照；
 * team-memory-service 用真实装配（本测试同时钉住视图输出的看板口径）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../services/index.js', () => ({
  agentService: {
    getAllAgents: vi.fn(() => []),
    getAgent: vi.fn(() => undefined),
  },
}));

vi.mock('../services/boss-service.js', () => ({
  getDelegationHistory: vi.fn(() => []),
}));

vi.mock('../websocket/handlers/boss-response-handler.js', () => ({
  listActiveDelegations: vi.fn(() => []),
}));

import { agentService } from '../services/index.js';
import * as bossService from '../services/boss-service.js';
import { listActiveDelegations } from '../websocket/handlers/boss-response-handler.js';
import delegationBoardRouter from './delegation-board.js';
import type { DelegationDecision } from '../../shared/types.js';

// ─── fixtures ───

function makeDecision(overrides: Partial<DelegationDecision> = {}): DelegationDecision {
  return {
    id: 'd-1',
    timestamp: 1_000_000,
    bossId: 'boss-1',
    userCommand: '做个登录页',
    selectedAgentId: 'agent-1',
    selectedAgentName: '小刘',
    reasoning: 'builder 空闲且熟悉前端',
    alternativeAgents: [],
    confidence: 'high',
    status: 'completed',
    taskId: 'task-1',
    taskCard: {
      objective: '实现登录页',
      acceptanceCriteria: ['lint:types 通过'],
      dependencies: [],
      priority: 'P1',
      projectId: 'proj-1',
      status: 'done',
    },
    completion: {
      completedAt: 1_038_500,
      durationMs: 38_500,
      result: 'completed',
      summary: '登录页完成并通过验收',
      outputLocation: 'src/pages/login.tsx',
    },
    ...overrides,
  };
}

const bossAgent = { id: 'boss-1', name: '王经理', class: 'boss', isBoss: true };
const subAgent = { id: 'agent-1', name: '小刘', class: 'builder' };

let server: http.Server;
let baseUrl: string;

async function getBoard(query = ''): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/delegations/board${query}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/delegations', delegationBoardRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentService.getAllAgents).mockReturnValue([bossAgent, subAgent] as any);
  vi.mocked(bossService.getDelegationHistory).mockReturnValue([]);
  vi.mocked(listActiveDelegations).mockReturnValue([]);
});

describe('任务24 委派看板只读 API', () => {
  it('五要素 + 病历字段全量返回（产出位置/验收/评价/优先级/项目/taskId/bossName）', async () => {
    vi.mocked(bossService.getDelegationHistory).mockImplementation((bossId) =>
      bossId === 'boss-1'
        ? [makeDecision({ userRating: 'satisfied', ratedAt: 1_040_000 }) as any]
        : []
    );

    const { status, body } = await getBoard();
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(typeof body.generatedAt).toBe('number');

    const entry = body.entries[0];
    expect(entry).toMatchObject({
      decisionId: 'd-1',
      taskId: 'task-1',
      bossId: 'boss-1',
      bossName: '王经理',
      who: { agentId: 'agent-1', agentName: '小刘' },
      when: { delegatedAt: 1_000_000, completedAt: 1_038_500, durationMs: 38_500 },
      what: { objective: '实现登录页', status: 'completed', priority: 'P1', projectId: 'proj-1' },
      why: { userCommand: '做个登录页', reasoning: 'builder 空闲且熟悉前端', confidence: 'high' },
      where: { outputLocation: 'src/pages/login.tsx', summary: '登录页完成并通过验收' },
    });
    expect(entry.outcome.result).toBe('completed');
    expect(entry.outcome.acceptanceCriteria).toEqual(['lint:types 通过']);
    expect(entry.outcome.rating).toBe('satisfied');
    expect(entry.outcome.ratedAt).toBe(1_040_000);
  });

  it('在办追踪合并：无史在办 → in-flight 条目（含 subordinateName）；史内命中 → 状态覆盖为 in-flight', async () => {
    vi.mocked(bossService.getDelegationHistory).mockReturnValue([
      makeDecision({ id: 'd-inflight', status: 'sent', taskCard: undefined, completion: undefined, taskId: 'task-9' }),
    ] as any);
    vi.mocked(listActiveDelegations).mockReturnValue([
      { subordinateId: 'agent-1', bossId: 'boss-1', taskDescription: '做个登录页', decisionId: 'd-inflight', taskId: 'task-9' },
      { subordinateId: 'agent-9', bossId: 'boss-1', taskDescription: '修一下导航' },
    ] as any);

    const { body } = await getBoard();
    expect(body.total).toBe(2);
    const dIn = body.entries.find((e: any) => e.decisionId === 'd-inflight');
    expect(dIn.what.status).toBe('in-flight');
    expect(dIn.taskId).toBe('task-9');
    const liveOnly = body.entries.find((e: any) => e.decisionId === 'live:agent-9');
    expect(liveOnly.who).toEqual({ agentId: 'agent-9', agentName: 'agent-9' }); // 不在 agent 表 → 回退 id
    expect(liveOnly.what.objective).toBe('修一下导航');
  });

  it('Boss 已不在 agent 表的孤儿在办追踪仍呈现（bossName 缺省）', async () => {
    vi.mocked(listActiveDelegations).mockReturnValue([
      { subordinateId: 'agent-9', bossId: 'boss-gone', taskDescription: '遗留任务' },
    ] as any);

    const { body } = await getBoard();
    expect(body.total).toBe(1);
    expect(body.entries[0].bossId).toBe('boss-gone');
    expect(body.entries[0].bossName).toBeUndefined();
    expect(body.entries[0].what.status).toBe('in-flight');
  });

  it('分页与上限：limit=2 截断/offset 生效/total 保持全量；越界限幅 1..200；非法值回落默认', async () => {
    vi.mocked(bossService.getDelegationHistory).mockReturnValue([
      makeDecision({ id: 'd-a', completion: { completedAt: 3_000, durationMs: 1, result: 'completed' } }),
      makeDecision({ id: 'd-b', completion: { completedAt: 2_000, durationMs: 1, result: 'completed' } }),
      makeDecision({ id: 'd-c', completion: { completedAt: 1_000, durationMs: 1, result: 'completed' } }),
    ] as any);

    const page1 = await getBoard('?limit=2');
    expect(page1.body.total).toBe(3);
    expect(page1.body.entries.map((e: any) => e.decisionId)).toEqual(['d-a', 'd-b']);

    const page2 = await getBoard('?limit=2&offset=2');
    expect(page2.body.entries.map((e: any) => e.decisionId)).toEqual(['d-c']);
    expect(page2.body.offset).toBe(2);

    expect((await getBoard('?limit=99999')).body.limit).toBe(200);
    expect((await getBoard('?limit=abc')).body.limit).toBe(50);
    expect((await getBoard('?limit=0')).body.limit).toBe(50);
    expect((await getBoard('?offset=-3')).body.offset).toBe(0);
  });

  it('过滤：bossId / status 精确匹配', async () => {
    vi.mocked(agentService.getAllAgents).mockReturnValue([
      bossAgent,
      subAgent,
      { id: 'boss-2', name: '李总', class: 'boss', isBoss: true },
    ] as any);
    vi.mocked(bossService.getDelegationHistory).mockImplementation((bossId) =>
      bossId === 'boss-1'
        ? [makeDecision({ id: 'd-done' })]
        : [makeDecision({ id: 'd-fail', bossId: 'boss-2', completion: { completedAt: 2_000, durationMs: 1, result: 'failed' } })]
    );

    expect((await getBoard('?bossId=boss-2')).body.entries.map((e: any) => e.decisionId)).toEqual(['d-fail']);
    expect((await getBoard('?status=failed')).body.entries.map((e: any) => e.decisionId)).toEqual(['d-fail']);
    expect((await getBoard('?status=completed')).body.entries.map((e: any) => e.decisionId)).toEqual(['d-done']);
  });

  it('空态与失败降级：无数据 → 200 空列表；读史抛错 → 降级不 500', async () => {
    vi.mocked(agentService.getAllAgents).mockReturnValue([] as any);
    const empty = await getBoard();
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual(expect.objectContaining({ total: 0, entries: [] }));

    vi.mocked(bossService.getDelegationHistory).mockImplementation(() => {
      throw new Error('盘读失败');
    });
    const degraded = await getBoard();
    expect(degraded.status).toBe(200);
    expect(degraded.body.total).toBe(0);
  });

  it('只读：仅注册 GET（POST/PUT/DELETE 一律 404，无写入口）', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}/api/delegations/board`, { method });
      expect(res.status).toBe(404);
    }
  });
});
