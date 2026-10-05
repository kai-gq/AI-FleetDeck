/**
 * 任务19·A·5.2 🟡 决策观测点验收（③⑧⑨⑩）——真实 EventDB 集成
 *
 * 口径（任务19·A 开工登记）：
 *   - ③ 委派史变更：**不新增史表裸写事件**——现有流（delegated/dispatched/
 *     reported/closed + task-card-status + completion-recorded/rating-recorded）
 *     已覆盖语义，本测试以 querySystemLog 读回声明覆盖；不改 boss-service.ts。
 *   - ⑧⑨⑩ 已实写（任务11/12/13）→ 本文件只做验收测试（随落地已接）。
 *
 * 与任务28 同款沙箱：src/test-setup.ts 已把 XDG_DATA_HOME 指向进程级临时目录；
 * 本文件 initEventDb() 后用真实 logEvent 写入、querySystemLog 读回。
 * 行标签全部带 process.pid 后缀，避免与同进程其他用例串扰。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./voice-companion-service.js', () => ({ logProactiveBroadcast: vi.fn() }));

import { closeEventDb, initEventDb } from '../data/event-db.js';
import { querySystemLog } from '../data/system-log.js';
import { SignalQueue } from '../jarvis-core/index.js';
import type { DelegationDecision } from '../../shared/types.js';
import { logDelegation } from './activity-log.js';
import * as bossService from './boss-service.js';
import { logProactiveBroadcast } from './voice-companion-service.js';
import {
  BOSS_MORNING_REPORT_ACTION,
  MORNING_REPORT_LOG_SOURCE,
  runBossMorningReportScan,
} from './boss-morning-report-service.js';
import { BOLBA_SYNC_SOURCE, logBolbaSync } from './bolba-bridge-service.js';

const PID = process.pid;
const TASK_ID = `task-19a-acc-${PID}`;
const BOSS_ID = `boss-19a-acc-${PID}`;
const DECISION_ID = `dec-19a-acc-${PID}`;

function bodyOf(row: { body?: string }): Record<string, unknown> {
  return JSON.parse(row.body ?? '{}');
}

/** 本文件专用委派记录（含任务卡；纯验收夹具，不模拟真实派发）。 */
function decisionFixture(at: number): DelegationDecision {
  return {
    id: DECISION_ID,
    timestamp: at - 60_000,
    bossId: BOSS_ID,
    userCommand: '验收：走一遍委派史链路',
    selectedAgentId: `sub-19a-acc-${PID}`,
    selectedAgentName: '小美',
    reasoning: 'acceptance',
    alternativeAgents: [],
    confidence: 'high',
    status: 'pending',
    taskCard: {
      objective: '验收委派史变更观测',
      acceptanceCriteria: [],
      dependencies: [],
      status: 'pending',
      projectId: 'ACC',
    },
  };
}

beforeAll(() => {
  initEventDb();
  bossService.init();
  bossService.addDelegationToHistory(BOSS_ID, decisionFixture(Date.now()));
});

afterAll(() => {
  closeEventDb();
});

describe('🟡③ 委派史变更验收（现有事件流覆盖声明；零新增史表裸写）', () => {
  it('delegated→dispatched→reported→closed + task-card-status 全程可按 taskId 读回', () => {
    // 既有流四段（与任务06/07 接线同款 helper 落盘形态；本用例只读验收）
    logDelegation({
      phase: 'delegated', channel: 'boss', taskId: TASK_ID,
      toAgentId: `sub-19a-acc-${PID}`, toAgentName: '小美', message: '拆解写入委派史',
    });
    logDelegation({
      phase: 'dispatched', channel: 'boss', taskId: TASK_ID,
      toAgentId: `sub-19a-acc-${PID}`, delivery: 'queue',
    });
    logDelegation({
      phase: 'reported', channel: 'subordinate', taskId: TASK_ID,
      fromAgentId: `sub-19a-acc-${PID}`, status: 'completed', summary: '已交付',
    });
    logDelegation({ phase: 'closed', channel: 'boss', taskId: TASK_ID, status: 'closed' });

    // 任务卡状态机迁移（真实 boss-service 公共入口 → 🔴⑦ logTaskCardStatus）
    // 注意：返回的是同一可变卡对象（原地迁移），断言须在每次迁移后立即取值。
    const at = Date.now();
    const running = bossService.updateDelegationTaskCardStatus(BOSS_ID, DECISION_ID, 'running', {
      at, taskId: TASK_ID, subordinateId: `sub-19a-acc-${PID}`, reason: 'dispatched',
    });
    expect(running?.status).toBe('running');
    const done = bossService.updateDelegationTaskCardStatus(BOSS_ID, DECISION_ID, 'done', {
      at: at + 1000, taskId: TASK_ID, subordinateId: `sub-19a-acc-${PID}`,
      result: 'completed', reason: 'report-task',
    });
    expect(done?.status).toBe('done');

    const rows = querySystemLog({ taskId: TASK_ID, order: 'asc' });
    expect(rows.map((r) => r.category)).toEqual(Array(6).fill('delegation'));
    expect(rows.map((r) => bodyOf(r).phase)).toEqual([
      'delegated', 'dispatched', 'reported', 'closed', 'task-card-status', 'task-card-status',
    ]);
    // 覆盖声明：委派四段 + 任务卡迁移均已可查 —— 无需向后补写史表裸事件。
    expect(bodyOf(rows[2])).toMatchObject({ phase: 'reported', status: 'completed', summary: '已交付' });
    expect(bodyOf(rows[4])).toMatchObject({ phase: 'task-card-status', from: 'pending', to: 'running', at });
    expect(bodyOf(rows[5])).toMatchObject({ phase: 'task-card-status', from: 'running', to: 'done', result: 'completed' });
  });
});

describe('🟡⑧ 病历追加验收（完成事件 + 用户评价）', () => {
  it('recordDelegationCompletion / rateDelegationCompletion 经真实 boss-service 落盘可查', () => {
    const at = Date.now();
    const recorded = bossService.recordDelegationCompletion(BOSS_ID, DECISION_ID, {
      at, result: 'completed', summary: '产出摘要', taskId: TASK_ID, subordinateId: `sub-19a-acc-${PID}`,
    });
    expect(recorded?.completion).toMatchObject({ result: 'completed', summary: '产出摘要' });

    const rated = bossService.rateDelegationCompletion(BOSS_ID, DECISION_ID, 'satisfied', {
      taskId: TASK_ID,
    });
    expect(rated?.userRating).toBe('satisfied');

    const rows = querySystemLog({ taskId: TASK_ID, order: 'asc' });
    const completion = rows.find((r) => bodyOf(r).phase === 'completion-recorded');
    expect(completion?.category).toBe('delegation');
    expect(completion?.source).toBe('boss');
    expect(bodyOf(completion!)).toMatchObject({
      phase: 'completion-recorded',
      decisionId: DECISION_ID,
      bossId: BOSS_ID,
      result: 'completed',
      hasSummary: true,
      hasOutputLocation: false,
    });

    const rating = rows.find((r) => bodyOf(r).phase === 'rating-recorded');
    expect(rating?.source).toBe('boss');
    expect(bodyOf(rating!)).toMatchObject({ phase: 'rating-recorded', decisionId: DECISION_ID, rating: 'satisfied' });
  });
});

describe('🟡⑨ 晨会生成与投递验收（真实 logEvent → querySystemLog 读回）', () => {
  it('scan/generate/deliver 三段事件可按 source=boss-morning-report 读回，投递走 vcs 通道', async () => {
    const broadcastMock = vi.mocked(logProactiveBroadcast);
    const now = new Date(2026, 9, 5, 8, 0, 0); // 08:00 非深夜
    const yAt = new Date(2026, 9, 4, 9, 0, 0).getTime();
    const record: DelegationDecision = {
      ...decisionFixture(Date.now()),
      id: `dec-19a-mr-${PID}`,
      completion: { completedAt: yAt, durationMs: 600_000, result: 'completed', outputLocation: 'src/x' },
    };

    const result = await runBossMorningReportScan({
      loadHistory: () => new Map([[BOSS_ID, [record]]]),
      now: () => now,
      queue: new SignalQueue({ now: now.getTime() }),
      readDailyReport: () => null, // 验收 ⑨ 本体；⑮ 聚合口径在 boss 服务测试面另验
      fetchBolbaTasks: async () => [], // 任务29：本用例验 ⑨ 本体，不拉 Bolba（也不写真实覆盖账）
    });
    expect(result).toMatchObject({ degraded: false, yesterday: 1, dailyReportIncluded: false });

    const rows = querySystemLog({ source: MORNING_REPORT_LOG_SOURCE, order: 'asc' });
    const bodies = rows.map(bodyOf);
    expect(bodies.some((b) => b.op === 'scan' && b.ok === true && b.count === 1)).toBe(true);
    expect(bodies.some((b) => b.op === 'generate' && b.yesterday === 1 && b.dedupeKey === 'morning-report:2026-10-05')).toBe(true);
    expect(bodies.some((b) => b.op === 'deliver' && b.tier === 'SPEAK' && b.ok === true)).toBe(true);
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({ action: BOSS_MORNING_REPORT_ACTION }));
  });
});

describe('🟡⑩ Bolba 同步验收（6 类 op 成功/失败可查）', () => {
  it('query/create/complete/reopen/scan/due-reminder 全量落 source=bolba + cat=bolba-sync', () => {
    const ops = ['query', 'create', 'complete', 'reopen', 'scan', 'due-reminder'] as const;
    ops.forEach((op, i) => {
      logBolbaSync({ op, ok: i % 2 === 0, mode: 'bolba-tasks', count: i, reason: `acc-${PID}` });
    });

    const rows = querySystemLog({ source: BOLBA_SYNC_SOURCE, order: 'asc' })
      .filter((r) => bodyOf(r).cat === 'bolba-sync' && bodyOf(r).reason === `acc-${PID}`);
    expect(rows.map((r) => bodyOf(r).op)).toEqual([...ops]);
    expect(rows.map((r) => r.level)).toEqual(['info', 'warn', 'info', 'warn', 'info', 'warn']);
    expect(bodyOf(rows[3])).toMatchObject({ op: 'reopen', ok: false, mode: 'bolba-tasks' });
  });
});
