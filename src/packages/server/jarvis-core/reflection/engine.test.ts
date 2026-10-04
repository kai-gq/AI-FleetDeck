/**
 * jarvis-core/reflection · 夜间反思引擎端到端单测（任务 28 ⑤.6/⑥）
 *
 * 覆盖：门槛跳过（<5 不跑、LLM 零调用）/ 门槛读不到 → skipped /
 * INGEST 失败与单源降级 / 缺省 LLM 端口未接线 → failed 零操作 /
 * 坏 JSON → failed 零操作 / Tier1 自动应用 + Tier2 只入队（未审不应用）/
 * 首次运行强制 Tier2 → 审批 → 二次运行恢复自动 / 晨报草稿落 reflections 层 /
 * 观测事件计数与拦截率。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileMemoryStore } from '../memory/index.js';
import type { JarvisLogger } from '../executors.js';
import {
  FileReflectionRunState,
  Tier2ReviewQueue,
  createStaticReflectionDataSource,
  createStaticReflectionLlm,
  runNightlyReflection,
  startOfLocalDay,
  type IngestedSessionSummary,
  type ReflectionDataSource,
  type ReflectionLlmPort,
  type ReflectionRunEvent,
} from './index.js';
import { FIXTURE_NOW } from './__fixtures__/reflection-fixtures.js';

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

function sessions(count: number): IngestedSessionSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `s${i + 1}`,
    summary: `会话 ${i + 1} 摘要`,
    at: FIXTURE_NOW - (count - i) * 60 * 60 * 1000,
  }));
}

describe('runNightlyReflection（引擎端到端）', () => {
  let baseDir: string;
  let store: FileMemoryStore;
  let queue: Tier2ReviewQueue;
  let runState: FileReflectionRunState;
  let events: ReflectionRunEvent[];

  const observer = (event: ReflectionRunEvent): void => {
    events.push(event);
  };

  function baseDeps() {
    return {
      store,
      reviewQueue: queue,
      runState,
      observer,
      logger: silentLogger,
      now: () => FIXTURE_NOW,
      firstRun: false as boolean | undefined,
    };
  }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-engine-'));
    store = new FileMemoryStore({ baseDir: path.join(baseDir, 'memory'), now: () => FIXTURE_NOW });
    queue = new Tier2ReviewQueue({ filePath: path.join(baseDir, 'reviews.json'), now: () => FIXTURE_NOW, logger: silentLogger });
    runState = new FileReflectionRunState({ filePath: path.join(baseDir, 'run-state.json'), logger: silentLogger });
    events = [];
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('门槛 4 < 5 → skipped/insufficient-sessions；LLM 零调用、存储零变动、不消耗首次运行', async () => {
    let llmCalls = 0;
    const llm: ReflectionLlmPort = async () => {
      llmCalls += 1;
      return '{}';
    };
    const source = createStaticReflectionDataSource(4, { now: FIXTURE_NOW, since: startOfLocalDay(FIXTURE_NOW), sessions: sessions(4) });
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: undefined, dataSource: source, llm });

    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toBe('insufficient-sessions');
    expect(result.sessionCount).toBe(4);
    expect(llmCalls).toBe(0);
    expect(await store.stats()).toMatchObject({ active: 0, marked: 0 });
    expect(runState.load()).toMatchObject({ runCount: 0, lastStatus: 'skipped' });
    expect(events).toEqual([
      expect.objectContaining({ kind: 'reflection.run.skipped', level: 'info', skippedReason: 'insufficient-sessions', tier2Rate: 0 }),
    ]);
  });

  it('门槛读不到会话数 → skipped/session-count-unavailable（宁可跳过不冒险，level=warn）', async () => {
    const source: ReflectionDataSource = {
      countSessionsToday: async () => {
        throw new Error('查询超时');
      },
      ingest: async () => {
        throw new Error('不应到达 INGEST');
      },
    };
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: undefined, dataSource: source });

    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toBe('session-count-unavailable');
    expect(result.errors[0]).toContain('session-count 读取失败');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'reflection.run.skipped', level: 'warn', skippedReason: 'session-count-unavailable' });
    expect(runState.load().runCount).toBe(0);
  });

  it('INGEST 抛错 → failed/ingest-failed，零操作零应用', async () => {
    const source: ReflectionDataSource = {
      countSessionsToday: async () => 5,
      ingest: async () => {
        throw new Error('磁盘故障');
      },
    };
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: undefined, dataSource: source });

    expect(result.status).toBe('failed');
    expect(result.failReason).toBe('ingest-failed');
    expect(result.operations).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toContain('磁盘故障');
    expect(events[0]).toMatchObject({ kind: 'reflection.run.failed', level: 'warn', failReason: 'ingest-failed' });
    expect(runState.load().runCount).toBe(0);
  });

  it('缺省 LLM 端口（真实通道未接线）→ failed/llm-port-unavailable，零操作零应用', async () => {
    const source = createStaticReflectionDataSource(5, { now: FIXTURE_NOW, since: startOfLocalDay(FIXTURE_NOW), sessions: sessions(5) });
    // 不传 llm：走缺省 createUnavailableReflectionLlm()
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: undefined, dataSource: source });

    expect(result.status).toBe('failed');
    expect(result.failReason).toBe('llm-port-unavailable');
    expect(result.operations).toEqual([]);
    expect(result.pendingReviewIds).toEqual([]);
    expect(await store.stats()).toMatchObject({ active: 0 });
    expect(runState.load()).toMatchObject({ runCount: 0, lastStatus: 'failed' });
    expect(events[0]).toMatchObject({ kind: 'reflection.run.failed', failReason: 'llm-port-unavailable' });
  });

  it('LLM 返回坏 JSON → failed/proposal-parse-failed，零操作零应用（不做半截应用）', async () => {
    const source = createStaticReflectionDataSource(5, { now: FIXTURE_NOW, since: startOfLocalDay(FIXTURE_NOW), sessions: sessions(5) });
    const llm = createStaticReflectionLlm('这不是 JSON');
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: undefined, dataSource: source, llm });

    expect(result.status).toBe('failed');
    expect(result.failReason).toBe('proposal-parse-failed');
    expect(result.operations).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(await store.stats()).toMatchObject({ active: 0 });
  });

  it('INGEST 单源失败 → completed + errors 如实登记 + 事件 level=warn（不吞、不假）', async () => {
    const source = createStaticReflectionDataSource(5, {
      now: FIXTURE_NOW,
      since: startOfLocalDay(FIXTURE_NOW),
      sessions: sessions(5),
      errors: [{ source: 'growth-log', message: '读取失败' }],
    });
    const llm = createStaticReflectionLlm({});
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: undefined, dataSource: source, llm });

    expect(result.status).toBe('completed');
    expect(result.errors).toContain('growth-log: 读取失败');
    expect(result.ingest).toMatchObject({ sourceErrors: 1 });
    expect(events[0]).toMatchObject({ kind: 'reflection.run.completed', level: 'warn' });
    expect(events[0].errors).toContain('growth-log: 读取失败');
  });

  it('Tier1 自动应用 + Tier2 只入队 + 晨报草稿 + 事件计数（零 Tier2 误伤样本）', async () => {
    const seeded = await store.add({ layer: 'working', source: 'agent-confirmed', text: '高频复用的构建命令', at: FIXTURE_NOW });
    const source = createStaticReflectionDataSource(6, {
      now: FIXTURE_NOW,
      since: startOfLocalDay(FIXTURE_NOW),
      sessions: sessions(6),
      workingEntries: [{ ...seeded, useCount: 11 }],
    });
    const llm = createStaticReflectionLlm({
      newEntries: [{ text: '用户习惯先跑测试再提交', confidence: 'low' }],
      promotes: [{ id: seeded.id }],
      morningDraft: '昨天主要推进测试流程；今天建议先跑一遍全量回归。',
    });
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: false, dataSource: source, llm });

    expect(result.status).toBe('completed');
    expect(result.firstRun).toBe(false);
    expect(result.tier2Intercepted).toBe(0);
    expect(result.tier2Rate).toBe(0);
    expect(result.pendingReviewIds).toEqual([]);
    expect(result.applied.filter((r) => r.applied)).toHaveLength(2);
    // Tier1 NEW 落长期知识；Tier1 PROMOTE 迁层（long-term 共 2 条：新增 + 迁入）
    const longTerm = await store.query({ layer: 'long-term' });
    expect(longTerm).toHaveLength(2);
    expect(longTerm.map((e) => e.text)).toContain('用户习惯先跑测试再提交');
    expect(longTerm.map((e) => e.text)).toContain('高频复用的构建命令');
    expect(await store.query({ layer: 'working' })).toHaveLength(0);
    // 晨报草稿落 reflections 层
    const drafts = await store.query({ layer: 'reflections' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'morning-report-draft' });
    expect(result.morningDraftEntryId).toBe(drafts[0].id);
    // 事件：四操作计数 + 应用数 + 拦截率 + 草稿标志
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'reflection.run.completed',
      level: 'info',
      sessionCount: 6,
      firstRun: false,
      operationCounts: { NEW: 1, UPDATE: 0, DELETE: 0, PROMOTE: 1 },
      rejectedCount: 0,
      tier1Applied: 2,
      tier2Intercepted: 0,
      tier2Rate: 0,
      morningDraftWritten: true,
    });
  });

  it('混合样本：低置信自动 + 决定类拦截 → tier2Rate=0.5，队列恰一条（未审不应用）', async () => {
    const source = createStaticReflectionDataSource(5, { now: FIXTURE_NOW, since: startOfLocalDay(FIXTURE_NOW), sessions: sessions(5) });
    const llm = createStaticReflectionLlm({
      newEntries: [{ text: '低置信自动项' }, { text: '决定类项：决定采用 A' }],
    });
    const result = await runNightlyReflection({ ...baseDeps(), firstRun: false, dataSource: source, llm });

    expect(result.status).toBe('completed');
    expect(result.tier2Intercepted).toBe(1);
    expect(result.tier2Rate).toBe(0.5);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ opId: 'new-0', applied: true });
    // 仅 Tier1 落盘；Tier2 在队列（存储里没有）
    const entries = await store.query({ layer: 'long-term' });
    expect(entries.map((e) => e.text)).toEqual(['低置信自动项']);
    const pending = queue.listPendingReviews();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(result.pendingReviewIds[0]);
    expect(pending[0]).toMatchObject({ tierReason: 'decision-class', status: 'pending' });
    expect(events[0]).toMatchObject({ tier2Intercepted: 1, tier2Rate: 0.5, tier1Applied: 1 });
  });

  it('首次运行强制 Tier2：零自动应用 → 审批后落盘 → 二次运行恢复 Tier1 自动应用', async () => {
    const source = createStaticReflectionDataSource(5, { now: FIXTURE_NOW, since: startOfLocalDay(FIXTURE_NOW), sessions: sessions(5) });
    const llmRun1 = createStaticReflectionLlm({ newEntries: [{ text: '跨会话重复：每周同步上游', confidence: 'low' }], morningDraft: '首次反思草稿' });
    const result1 = await runNightlyReflection({ ...baseDepsWithoutFirstRun(), dataSource: source, llm: llmRun1 });

    // 首次运行：全部 Tier2，零应用、零落盘（未审不应用）
    expect(result1.status).toBe('completed');
    expect(result1.firstRun).toBe(true);
    expect(result1.operations[0]).toMatchObject({ tier: 2, tierReason: 'first-run' });
    expect(result1.applied).toEqual([]);
    expect(result1.pendingReviewIds).toHaveLength(1);
    expect(await store.query({ layer: 'long-term' })).toHaveLength(0);
    // 晨报草稿不受 Tier 门限制（它是反思产物，不是知识操作）
    expect(result1.morningDraftEntryId).toBeTruthy();
    expect(runState.load()).toMatchObject({ runCount: 1, lastStatus: 'completed' });

    // 审批通过 → 唯一落盘路径生效
    const approved = await queue.approveReview(result1.pendingReviewIds[0], { store });
    expect(approved).toMatchObject({ status: 'approved', applied: true });
    expect(await store.query({ layer: 'long-term' })).toHaveLength(1);
    expect(queue.listPendingReviews()).toHaveLength(0);

    // 二次运行：不再是首次 → 低置信新增 Tier1 自动应用
    const llmRun2 = createStaticReflectionLlm({ newEntries: [{ text: '第二轮：反思产物写入 reflections 层', confidence: 'low' }] });
    const result2 = await runNightlyReflection({ ...baseDepsWithoutFirstRun(), dataSource: source, llm: llmRun2 });

    expect(result2.status).toBe('completed');
    expect(result2.firstRun).toBe(false);
    expect(result2.operations[0]).toMatchObject({ tier: 1, tierReason: 'new-low-confidence' });
    expect(result2.applied[0]).toMatchObject({ applied: true });
    expect((await store.query({ layer: 'long-term' })).map((e) => e.text).sort()).toEqual([
      '第二轮：反思产物写入 reflections 层',
      '跨会话重复：每周同步上游',
    ]);
    expect(runState.load().runCount).toBe(2);
  });

  // baseDeps 去掉 firstRun 覆盖（走 runState 自动判定）
  function baseDepsWithoutFirstRun() {
    return {
      store,
      reviewQueue: queue,
      runState,
      observer,
      logger: silentLogger,
      now: () => FIXTURE_NOW,
      dataSource: undefined,
      llm: undefined,
    };
  }
});
