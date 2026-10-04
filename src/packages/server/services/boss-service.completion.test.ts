/**
 * 任务11·⑧ 病历（进度病历）服务级测试：recordDelegationCompletion / rateDelegationCompletion。
 *
 * 真实：bossService + XDG 沙箱真盘（delegation-history.json）+ EventDB（🟡⑧ 病历追加埋点）。
 * 覆盖：完成写回字段（completedAt/durationMs/result/summary/outputLocation/reason）+ status 迁移
 *   + 幂等口径（已有 completion 不双写不覆盖）+ 未知 decisionId 不写盘 + 耗时时钟回拨钳 0
 *   + 空白摘要按未提供 + 评价回写/重复评价最后有效 + 事件落盘形态。
 *
 * （完成入口 completeDelegation 的快照时序/双入口幂等由 task-card-integration.test.ts 覆盖。）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as bossService from './boss-service.js';
import { closeEventDb, initEventDb } from '../data/event-db.js';
import { querySystemLog } from '../data/system-log.js';
import type { DelegationDecision } from '../../shared/types.js';

const dataDir = path.join(process.env.XDG_DATA_HOME!, 'tide-commander');
const historyFile = path.join(dataDir, 'delegation-history.json');

function makeDecision(id: string): DelegationDecision {
  return {
    id,
    timestamp: 10_000,
    bossId: 'boss-1',
    userCommand: '实现登录页',
    selectedAgentId: 'agent-1',
    selectedAgentName: 'Builder One',
    reasoning: '病历服务级测试',
    alternativeAgents: [],
    confidence: 'high',
    status: 'sent',
  };
}

/** 读回真盘 delegation-history.json 里指定 decision。 */
function readDiskDecision(decisionId: string): DelegationDecision {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as {
    histories: Record<string, DelegationDecision[]>;
  };
  const found = raw.histories['boss-1']?.find((d) => d.id === decisionId);
  if (!found) throw new Error(`decision not found on disk: ${decisionId}`);
  return found;
}

/** 🟡⑧ 病历追加埋点行（delegation 通道 completion-recorded / rating-recorded）。 */
function recordRows(decisionId: string): Array<{ entry: { taskId?: string; source?: string }; body: Record<string, unknown> }> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .map((entry) => ({ entry, body: entry.body ? (JSON.parse(entry.body) as Record<string, unknown>) : {} }))
    .filter(({ body }) =>
      (body.phase === 'completion-recorded' || body.phase === 'rating-recorded') && body.decisionId === decisionId,
    );
}

describe('⑧ 病历服务级：完成写回 + 评价回写（真盘 + 🟡⑧ 埋点）', () => {
  beforeAll(() => {
    fs.rmSync(historyFile, { force: true });
    fs.rmSync(`${historyFile}.bak`, { force: true });
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
  });

  it('完成写回：completion 字段 + status 迁移 completed + 🟡⑧ completion-recorded 事件（真盘）', () => {
    bossService.init();
    bossService.addDelegationToHistory('boss-1', makeDecision('d-done'));

    const decision = bossService.recordDelegationCompletion('boss-1', 'd-done', {
      at: 70_000,
      result: 'completed',
      summary: '登录页完成，测试通过',
      outputLocation: 'reports/login.md',
      reason: 'report-task',
      subordinateId: 'agent-1',
      taskId: 't-1',
    });

    // 内存 + 真盘：completion 全字段 + status 迁移（现状曾永远停在 'sent'）
    expect(decision?.status).toBe('completed');
    expect(decision?.completion).toEqual({
      completedAt: 70_000,
      durationMs: 60_000, // 70_000 − decision.timestamp(10_000)
      result: 'completed',
      summary: '登录页完成，测试通过',
      outputLocation: 'reports/login.md',
      reason: 'report-task',
    });
    const disk = readDiskDecision('d-done');
    expect(disk.status).toBe('completed');
    expect(disk.completion).toEqual(decision?.completion);

    // 🟡⑧ 埋点：delegation 通道 + 独立 phase + taskId 列
    const rows = recordRows('d-done');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatchObject({
      cat: 'delegation',
      phase: 'completion-recorded',
      decisionId: 'd-done',
      bossId: 'boss-1',
      subordinateId: 'agent-1',
      at: 70_000,
      durationMs: 60_000,
      result: 'completed',
      reason: 'report-task',
      hasSummary: true,
      hasOutputLocation: true,
    });
    expect(rows[0]!.entry.taskId).toBe('t-1');
    expect(rows[0]!.entry.source).toBe('boss');
  });

  it('失败结果 + 时钟回拨：result failed、耗时钳 0、空白摘要按未提供', () => {
    bossService.init();
    bossService.addDelegationToHistory('boss-1', makeDecision('d-failed'));

    const decision = bossService.recordDelegationCompletion('boss-1', 'd-failed', {
      at: 5_000, // 早于 decision.timestamp(10_000) → 耗时不为负
      result: 'failed',
      summary: '   ', // 空白 = 未提供，不硬造
      reason: 'turn-complete',
    });

    expect(decision?.status).toBe('failed');
    expect(decision?.completion).toMatchObject({ completedAt: 5_000, durationMs: 0, result: 'failed' });
    expect(decision?.completion).not.toHaveProperty('summary');
    expect(decision?.completion).not.toHaveProperty('outputLocation');
    expect(readDiskDecision('d-failed').completion?.durationMs).toBe(0);

    const rows = recordRows('d-failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatchObject({ result: 'failed', hasSummary: false, hasOutputLocation: false });
  });

  it('幂等口径（主脑）：已有 completion 不双写不覆盖——真盘逐字节不变 + 无第二条事件', () => {
    bossService.init();
    bossService.addDelegationToHistory('boss-1', makeDecision('d-idem'));

    bossService.recordDelegationCompletion('boss-1', 'd-idem', { at: 20_000, reason: 'turn-complete' });
    const bytesAfterFirst = fs.readFileSync(historyFile, 'utf8');

    // 第二次到达（如 runtime 先写、report-task 后到）：summary 不补写、时间不覆盖
    const again = bossService.recordDelegationCompletion('boss-1', 'd-idem', {
      at: 30_000,
      result: 'completed',
      summary: '迟到的摘要',
      reason: 'report-task',
    });

    expect(again?.completion?.completedAt).toBe(20_000);
    expect(again?.completion?.summary).toBeUndefined();
    expect(again?.status).toBe('completed');
    expect(fs.readFileSync(historyFile, 'utf8')).toBe(bytesAfterFirst);
    expect(recordRows('d-idem')).toHaveLength(1);
  });

  it('未知 decisionId：返回 undefined、不写盘、不落事件', () => {
    bossService.init();
    const bytesBefore = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8') : '';

    expect(bossService.recordDelegationCompletion('boss-1', 'd-missing', { at: 1 })).toBeUndefined();

    if (bytesBefore) expect(fs.readFileSync(historyFile, 'utf8')).toBe(bytesBefore);
    expect(recordRows('d-missing')).toHaveLength(0);
  });

  it('评价回写：userRating/ratedAt 落盘 + 🟡⑧ rating-recorded 事件；重复评价以最后一次为准', () => {
    bossService.init();
    bossService.addDelegationToHistory('boss-1', makeDecision('d-rate'));

    const rated = bossService.rateDelegationCompletion('boss-1', 'd-rate', 'satisfied', {
      at: 88_000,
      taskId: 't-rate',
    });
    expect(rated?.userRating).toBe('satisfied');
    expect(rated?.ratedAt).toBe(88_000);
    expect(readDiskDecision('d-rate').userRating).toBe('satisfied');
    expect(readDiskDecision('d-rate').ratedAt).toBe(88_000);

    const rows = recordRows('d-rate');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatchObject({ phase: 'rating-recorded', rating: 'satisfied', at: 88_000 });
    expect(rows[0]!.entry.taskId).toBe('t-rate');

    // 重复评价允许覆盖（用户改主意以最后一次为准——与完成事件的「不覆盖」语义不同）
    bossService.rateDelegationCompletion('boss-1', 'd-rate', 'unsatisfied', { at: 99_000 });
    expect(readDiskDecision('d-rate').userRating).toBe('unsatisfied');
    expect(readDiskDecision('d-rate').ratedAt).toBe(99_000);
    expect(recordRows('d-rate')).toHaveLength(2);
  });
});
