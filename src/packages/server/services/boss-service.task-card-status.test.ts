/**
 * 任务10·⑦ 未覆盖项②（任务08 落地补网）：服务级非法迁移「跳过写盘 + 不落埋点」。
 *
 * 既有覆盖只到守卫函数级（task-card-service.test.ts 的 canTransitionTaskCard 矩阵），
 * 本测试在服务级验证 updateDelegationTaskCardStatus 的真实行为：
 *   - 非法迁移（running→pending）与同态重复（running→running）→ 返回 undefined、
 *     delegation-history.json 逐字节不变、system_log 无该 decisionId 的迁移行；
 *   - 合法迁移（running→done）对照组 → 真写盘 + 真埋点（证明测试装置有效）。
 *
 * 真实：bossService + XDG 沙箱真盘 + EventDB（与 task-card-integration.test.ts 同装置）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as bossService from './boss-service.js';
import { closeEventDb, initEventDb } from '../data/event-db.js';
import { querySystemLog } from '../data/system-log.js';
import type { DelegationDecision, TaskCardStatus } from '../../shared/types.js';

const dataDir = path.join(process.env.XDG_DATA_HOME!, 'tide-commander');
const historyFile = path.join(dataDir, 'delegation-history.json');

function makeDecision(id: string, cardStatus: TaskCardStatus): DelegationDecision {
  return {
    id,
    timestamp: 1000,
    bossId: 'boss-1',
    userCommand: '实现登录页',
    selectedAgentId: 'agent-1',
    selectedAgentName: 'Builder One',
    reasoning: '服务级非法迁移测试',
    alternativeAgents: [],
    confidence: 'high',
    status: 'sent',
    taskCard: {
      objective: '实现登录页',
      acceptanceCriteria: ['lint:types 通过'],
      dependencies: [],
      priority: 'P1',
      status: cardStatus,
      statusUpdatedAt: 2000,
    },
  };
}

/** 该 decisionId 的 🔴⑦ 迁移埋点行（system_log delegation / task-card-status）。 */
function cardStatusRows(decisionId: string): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .map((row) => (row.body ? (JSON.parse(row.body) as Record<string, unknown>) : {}))
    .filter((body) => body.phase === 'task-card-status' && body.decisionId === decisionId);
}

function readDiskCard(decisionId: string) {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as {
    histories: Record<string, DelegationDecision[]>;
  };
  const found = raw.histories['boss-1']?.find((d) => d.id === decisionId);
  if (!found) throw new Error(`decision not found on disk: ${decisionId}`);
  return found;
}

describe('bossService 服务级任务卡迁移守卫（跳过写盘 + 不落埋点）', () => {
  beforeAll(() => {
    fs.rmSync(historyFile, { force: true });
    fs.rmSync(`${historyFile}.bak`, { force: true });
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
  });

  it('非法迁移与同态重复：返回 undefined、真盘逐字节不变、system_log 无迁移行', () => {
    bossService.init();
    bossService.addDelegationToHistory('boss-1', makeDecision('d-illegal', 'running'));
    const bytesBefore = fs.readFileSync(historyFile, 'utf8');
    const rowsBefore = cardStatusRows('d-illegal').length; // 落卡本身不产生迁移行
    expect(rowsBefore).toBe(0);

    // running→pending 非法；running→running 同态重复
    expect(bossService.updateDelegationTaskCardStatus('boss-1', 'd-illegal', 'pending')).toBeUndefined();
    expect(bossService.updateDelegationTaskCardStatus('boss-1', 'd-illegal', 'running')).toBeUndefined();

    // 不写盘：逐字节相等
    expect(fs.readFileSync(historyFile, 'utf8')).toBe(bytesBefore);
    // 不落埋点
    expect(cardStatusRows('d-illegal')).toHaveLength(0);
    // 内存卡状态未被动过
    const card = bossService.getDelegationHistory('boss-1').find((d) => d.id === 'd-illegal')?.taskCard;
    expect(card?.status).toBe('running');
    expect(card?.statusUpdatedAt).toBe(2000);
  });

  it('合法迁移对照：running→done 真写盘 + 真落迁移埋点（装置有效性）', () => {
    bossService.init();
    bossService.addDelegationToHistory('boss-1', makeDecision('d-legal', 'running'));

    const card = bossService.updateDelegationTaskCardStatus('boss-1', 'd-legal', 'done', {
      at: 3000,
      result: 'completed',
      reason: 'report-task',
      subordinateId: 'agent-1',
    });

    expect(card?.status).toBe('done');
    expect(card?.statusUpdatedAt).toBe(3000);
    // 真盘：状态已更新
    expect(readDiskCard('d-legal').taskCard?.status).toBe('done');
    // 埋点：唯一一行 running->done
    const rows = cardStatusRows('d-legal');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: 'running', to: 'done', at: 3000, result: 'completed', reason: 'report-task' });
  });
});
