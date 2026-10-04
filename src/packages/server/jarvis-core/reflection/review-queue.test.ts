/**
 * jarvis-core/reflection · Tier2 人工审查队列单测（任务 28 ⑤.4）
 *
 * 钉死「未审不下发/不应用」的数据级契约：入队持久化（新实例可读回）、
 * approve 不带 store 只迁移状态（不碰存储）、带 store 才真实应用（走 27 API）、
 * reject 不应用、已决幂等、损坏文件容错为空队列不抛。本轮无 UI（client 禁区）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileMemoryStore } from '../memory/index.js';
import type { JarvisLogger } from '../executors.js';
import { Tier2ReviewQueue, type PlannedOperation } from './index.js';

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/** 决定类 NEW（Tier2 decision-class）：审批通过后应落 long-term。 */
const decisionNewOp: PlannedOperation = {
  opId: 'new-0',
  kind: 'NEW',
  tier: 2,
  tierReason: 'decision-class',
  add: {
    layer: 'long-term',
    source: 'agent-confirmed',
    kind: 'decision',
    text: '决定：夜间反思先走数据级队列',
    confidence: 'low',
    tags: ['reflection', 'confidence:low'],
  },
};

/** Tier1 操作（入队应被跳过）。 */
const tier1Op: PlannedOperation = {
  opId: 'new-1',
  kind: 'NEW',
  tier: 1,
  tierReason: 'new-low-confidence',
};

describe('Tier2ReviewQueue', () => {
  let baseDir: string;
  let queueFile: string;
  let storeDir: string;
  let store: FileMemoryStore;
  let queue: Tier2ReviewQueue;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-queue-'));
    queueFile = path.join(baseDir, 'pending-reviews.json');
    storeDir = path.join(baseDir, 'memory');
    store = new FileMemoryStore({ baseDir: storeDir, now: () => 1_000_000 });
    queue = new Tier2ReviewQueue({ filePath: queueFile, now: () => 1_000_000, logger: silentLogger });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('enqueue：仅收 Tier2；返回创建项；重复 runId+opId 跳过', () => {
    const created = queue.enqueue('run-1', [decisionNewOp, tier1Op]);
    expect(created.map((item) => item.id)).toEqual(['run-1:new-0']);
    expect(created[0]).toMatchObject({ status: 'pending', tierReason: 'decision-class', createdAt: 1_000_000 });
    // 重复入队：跳过已存在
    expect(queue.enqueue('run-1', [decisionNewOp])).toEqual([]);
    // 不同 runId 同 opId：另一条记录
    expect(queue.enqueue('run-2', [decisionNewOp]).map((item) => item.id)).toEqual(['run-2:new-0']);
    expect(queue.listReviews()).toHaveLength(2);
  });

  it('持久化：新实例同文件可读回完整条目（操作载荷原样）', () => {
    queue.enqueue('run-1', [decisionNewOp]);
    const reopened = new Tier2ReviewQueue({ filePath: queueFile, logger: silentLogger });
    const pending = reopened.listPendingReviews();
    expect(pending).toHaveLength(1);
    expect(pending[0].operation).toEqual(decisionNewOp);
    expect(fs.existsSync(queueFile)).toBe(true);
  });

  it('未审不应用（钉死）：入队后存储零变动，只有 approve(store) 才落盘', async () => {
    queue.enqueue('run-1', [decisionNewOp]);
    expect(queue.listPendingReviews()).toHaveLength(1);
    expect(await store.query({ layer: 'long-term' })).toHaveLength(0);

    const item = queue.listPendingReviews()[0];
    const approved = await queue.approveReview(item.id, { store });
    expect(approved).toMatchObject({ status: 'approved', applied: true });
    const entries = await store.query({ layer: 'long-term' });
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('决定：夜间反思先走数据级队列');
  });

  it('approve 不带 store：只做数据级状态迁移，不碰存储（主脑后续注入）', async () => {
    const [item] = queue.enqueue('run-1', [decisionNewOp]);
    const approved = await queue.approveReview(item.id);
    expect(approved).toMatchObject({ status: 'approved' });
    expect(approved?.applied).toBeUndefined();
    expect(await store.query({ layer: 'long-term' })).toHaveLength(0);
    // 状态已持久化
    const reopened = new Tier2ReviewQueue({ filePath: queueFile, logger: silentLogger });
    expect(reopened.listPendingReviews()).toHaveLength(0);
    expect(reopened.listReviews('approved')).toHaveLength(1);
  });

  it('approve 带 store 真实应用（PROMOTE 案例）：working → long-term', async () => {
    const seeded = await store.add({ layer: 'working', source: 'agent-confirmed', text: '低频但仍需人工确认的工作记忆' });
    const promoteOp: PlannedOperation = {
      opId: 'promote-0',
      kind: 'PROMOTE',
      tier: 2,
      tierReason: 'promote-below-threshold',
      targetEntryId: seeded.id,
      promoteTarget: 'long-term',
    };
    const [item] = queue.enqueue('run-1', [promoteOp]);
    const approved = await queue.approveReview(item.id, { store });
    expect(approved).toMatchObject({ status: 'approved', applied: true });
    expect(await store.query({ layer: 'working' })).toHaveLength(0);
    const longTerm = await store.query({ layer: 'long-term' });
    expect(longTerm[0]).toMatchObject({ id: seeded.id, promotedFrom: 'working' });
  });

  it('reject：状态迁移且不应用；已决记录再审批幂等（不重复应用）', async () => {
    const [item] = queue.enqueue('run-1', [decisionNewOp]);
    const rejected = await queue.rejectReview(item.id);
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(await store.query({ layer: 'long-term' })).toHaveLength(0);

    // 已决后再 approve：幂等返回原状态，不触发应用
    const reapproved = await queue.approveReview(item.id, { store });
    expect(reapproved).toMatchObject({ status: 'rejected' });
    expect(reapproved?.applied).toBeUndefined();
    expect(await store.query({ layer: 'long-term' })).toHaveLength(0);
  });

  it('approve 应用失败 → applied:false + applyError 如实登记（不吞、不假）', async () => {
    // 目标条目不存在：applyReflectionOperations 返回 not-found
    const promoteOp: PlannedOperation = {
      opId: 'promote-0',
      kind: 'PROMOTE',
      tier: 2,
      tierReason: 'promote-below-threshold',
      targetEntryId: 'ghost-entry',
      promoteTarget: 'long-term',
    };
    const [item] = queue.enqueue('run-1', [promoteOp]);
    const approved = await queue.approveReview(item.id, { store });
    expect(approved).toMatchObject({ status: 'approved', applied: false });
    expect(approved?.applyError).toBeTruthy();
  });

  it('损坏 JSON → warn + 空队列，不抛（容错）', () => {
    fs.writeFileSync(queueFile, '{ 这不是合法 JSON', 'utf-8');
    const warnings: string[] = [];
    const logger: JarvisLogger = { log: () => {}, debug: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    const broken = new Tier2ReviewQueue({ filePath: queueFile, logger });
    expect(broken.listReviews()).toEqual([]);
    expect(broken.getReview('run-1:new-0')).toBeUndefined();
    expect(warnings.some((m) => m.includes('损坏'))).toBe(true);
  });

  it('listPendingReviews 按 createdAt 升序返回副本（外部改动不回写）', () => {
    queue.enqueue('run-1', [decisionNewOp]);
    queue.enqueue('run-2', [decisionNewOp]);
    const ids = queue.listReviews().map((item) => item.id);
    const pending = queue.listPendingReviews().map((item) => item.id);
    // createdAt 同为 1_000_000 → 按 id 升序
    expect(pending).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    const first = queue.listPendingReviews()[0];
    first.status = 'rejected';
    expect(queue.getReview(first.id)?.status).toBe('pending');
  });

  it('approve/reject 未知 id → null（不抛）', async () => {
    expect(await queue.approveReview('ghost')).toBeNull();
    expect(await queue.rejectReview('ghost')).toBeNull();
  });
});
