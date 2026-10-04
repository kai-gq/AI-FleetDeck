/**
 * jarvis-core/reflection · INGEST 收集器单测（任务 28 ⑤.2）
 *
 * 真实 FileMemoryStore（临时目录、只读导入任务 27 模块）验证：
 *   · 会话计数口径（去重 / 匿名摘要 / 窗口过滤）——防幻觉门槛输入；
 *   · 四路收集（工作记忆 / 会话摘要 / 成长日志新增 / 长期知识）与排序；
 *   · 数据源失败降级「不吞、不假」：失败源如实登记 errors、数据保持缺失。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileMemoryStore, type MemoryEntry, type MemoryQuery } from '../memory/index.js';
import type { JarvisLogger } from '../executors.js';
import {
  countSessionsFromEntries,
  createMemoryReflectionDataSource,
  createStaticReflectionDataSource,
  startOfLocalDay,
} from './index.js';
import { FIXTURE_NOW, makeEntry } from './__fixtures__/reflection-fixtures.js';

/** 静音日志（失败用例走降级路径时避免测试输出噪音）。 */
const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

const HOUR_MS = 60 * 60 * 1000;

// ============================================================================
// 会话计数（纯函数）
// ============================================================================

describe('countSessionsFromEntries（门槛口径）', () => {
  it('同日摘要按 sessionId 去重 + 匿名摘要逐条计 + 非摘要带 sessionId 并入 + 窗口外剔除', () => {
    const since = FIXTURE_NOW - 8 * HOUR_MS;
    const entries: MemoryEntry[] = [
      makeEntry({ id: 'a', layer: 'working', kind: 'session-summary', text: '摘要一', sessionId: 's1', createdAt: FIXTURE_NOW - 1 * HOUR_MS, updatedAt: FIXTURE_NOW - 1 * HOUR_MS }),
      makeEntry({ id: 'b', layer: 'working', kind: 'session-summary', text: '同会话再摘要', sessionId: 's1', createdAt: FIXTURE_NOW - 2 * HOUR_MS, updatedAt: FIXTURE_NOW - 2 * HOUR_MS }),
      makeEntry({ id: 'c', layer: 'working', kind: 'session-summary', text: '匿名摘要', createdAt: FIXTURE_NOW - 3 * HOUR_MS, updatedAt: FIXTURE_NOW - 3 * HOUR_MS }),
      makeEntry({ id: 'd', layer: 'working', kind: 'agent-note', text: '非摘要但带会话', sessionId: 's2', createdAt: FIXTURE_NOW - 4 * HOUR_MS, updatedAt: FIXTURE_NOW - 4 * HOUR_MS }),
      makeEntry({ id: 'e', layer: 'working', kind: 'agent-note', text: '无会话无摘要', createdAt: FIXTURE_NOW - 5 * HOUR_MS, updatedAt: FIXTURE_NOW - 5 * HOUR_MS }),
      makeEntry({ id: 'f', layer: 'working', kind: 'session-summary', text: '昨日摘要', sessionId: 's9', createdAt: FIXTURE_NOW - 30 * HOUR_MS, updatedAt: FIXTURE_NOW - 30 * HOUR_MS }),
    ];
    // s1(去重) + s2 + 匿名 = 3；e 不计；f 在窗口外
    expect(countSessionsFromEntries(entries, since)).toBe(3);
    expect(countSessionsFromEntries([], since)).toBe(0);
  });
});

// ============================================================================
// 静态数据源（fixture 注入）
// ============================================================================

describe('createStaticReflectionDataSource', () => {
  it('原样返回给定数据（不加工、不伪造）', async () => {
    const entry = makeEntry({ id: 'x', text: '固定条目' });
    const source = createStaticReflectionDataSource(7, {
      now: FIXTURE_NOW,
      since: FIXTURE_NOW - HOUR_MS,
      longTermEntries: [entry],
    });
    expect(await source.countSessionsToday(FIXTURE_NOW)).toBe(7);
    const bundle = await source.ingest({ now: FIXTURE_NOW, since: FIXTURE_NOW - HOUR_MS });
    expect(bundle.longTermEntries).toEqual([entry]);
    expect(bundle.workingEntries).toEqual([]);
    expect(bundle.errors).toEqual([]);
  });
});

// ============================================================================
// 真实存储数据源
// ============================================================================

describe('createMemoryReflectionDataSource（真实 FileMemoryStore）', () => {
  let baseDir: string;
  let store: FileMemoryStore;
  let since: number;
  let todayAt: number;
  let oldAt: number;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-ingest-'));
    store = new FileMemoryStore({ baseDir, now: () => FIXTURE_NOW });
    since = startOfLocalDay(FIXTURE_NOW);
    todayAt = since + 60_000; // 当天 00:01（本地）
    oldAt = since - 60_000; // 前一天 23:59（本地）
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('countSessionsToday：当天摘要去重 + 匿名计一 + 昨日剔除', async () => {
    await store.add({ layer: 'working', source: 'agent-confirmed', kind: 'session-summary', text: '会话一摘要', sessionId: 's1', at: todayAt });
    await store.add({ layer: 'working', source: 'agent-confirmed', kind: 'session-summary', text: '会话一续', sessionId: 's1', at: todayAt + 1000 });
    await store.add({ layer: 'working', source: 'agent-confirmed', kind: 'session-summary', text: '匿名摘要', at: todayAt + 2000 });
    await store.add({ layer: 'working', source: 'agent-confirmed', kind: 'session-summary', text: '昨日摘要', sessionId: 's0', at: oldAt });

    const source = createMemoryReflectionDataSource(store, { logger: silentLogger });
    expect(await source.countSessionsToday(FIXTURE_NOW)).toBe(2);
  });

  it('countSessionsToday 读取失败 → 直接抛（引擎按 skipped 处理，宁可跳过不冒险）', async () => {
    class BrokenCountStore extends FileMemoryStore {
      override async query(q?: MemoryQuery): Promise<MemoryEntry[]> {
        if (q?.layer === 'working') throw new Error('工作记忆读取失败');
        return super.query(q);
      }
    }
    const broken = new BrokenCountStore({ baseDir, now: () => FIXTURE_NOW });
    const source = createMemoryReflectionDataSource(broken, { logger: silentLogger });
    await expect(source.countSessionsToday(FIXTURE_NOW)).rejects.toThrow('工作记忆读取失败');
  });

  it('ingest：四路收集 + 窗口过滤 + 确定性排序', async () => {
    // 工作记忆：当天 active / 昨日 active / 待反思（不限日期）
    const todayWorking = await store.add({ layer: 'working', source: 'agent-confirmed', text: '今天的工作记忆', at: todayAt + 3000 });
    const oldWorking = await store.add({ layer: 'working', source: 'agent-confirmed', text: '昨天的工作记忆', at: oldAt });
    const marked = await store.add({ layer: 'working', source: 'agent-confirmed', text: '待反思的工作条目', at: todayAt + 4000 });
    await store.update(marked.id, { status: 'pending-reflection' });
    // 会话摘要：当天 / 昨日
    await store.add({ layer: 'working', source: 'agent-confirmed', kind: 'session-summary', text: '会话摘要 A', sessionId: 's1', at: todayAt + 1000 });
    await store.add({ layer: 'working', source: 'agent-confirmed', kind: 'session-summary', text: '昨日摘要', sessionId: 's0', at: oldAt });
    // 成长日志：当天新增 / 往日
    const glToday = await store.add({ layer: 'growth-log', source: 'agent-confirmed', text: '今日成长：先确认再动手', at: todayAt + 5000 });
    const glOld = await store.add({ layer: 'growth-log', source: 'agent-confirmed', text: '往日成长', at: oldAt });
    // 长期知识：active / 已标记（标记条目不应出现在长期知识路）
    const ltActive = await store.add({ layer: 'long-term', source: 'user-stated', text: '用户长期偏好', at: todayAt + 6000 });
    const ltMarked = await store.add({ layer: 'long-term', source: 'agent-confirmed', text: '长期待反思条目', at: todayAt + 7000 });
    await store.update(ltMarked.id, { status: 'pending-reflection' });

    const source = createMemoryReflectionDataSource(store, { logger: silentLogger });
    const bundle = await source.ingest({ now: FIXTURE_NOW, since });

    // 会话摘要：仅当天、按 at 升序
    expect(bundle.sessions).toEqual([{ sessionId: 's1', summary: '会话摘要 A', at: todayAt + 1000 }]);
    // 工作记忆：当天 active + 全部标记条目；昨日 active 不在
    const workingIds = bundle.workingEntries.map((e) => e.id);
    expect(workingIds).toContain(todayWorking.id);
    expect(workingIds).toContain(marked.id);
    expect(workingIds).not.toContain(oldWorking.id);
    // updatedAt 降序（确定性排序）
    const times = bundle.workingEntries.map((e) => e.updatedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // 标记条目：两条都在
    const markedIds = bundle.markedEntries.map((e) => e.id);
    expect(markedIds).toContain(marked.id);
    expect(markedIds).toContain(ltMarked.id);
    // 成长日志：当天新增在、往日不在、createdAt 升序
    expect(bundle.growthLogEntries.map((e) => e.id)).toEqual([glToday.id]);
    expect(bundle.growthLogEntries.map((e) => e.id)).not.toContain(glOld.id);
    // 长期知识：active 在、pending-reflection 剔除
    const longTermIds = bundle.longTermEntries.map((e) => e.id);
    expect(longTermIds).toContain(ltActive.id);
    expect(longTermIds).not.toContain(ltMarked.id);
    // 全绿无降级
    expect(bundle.errors).toEqual([]);
    expect(bundle.now).toBe(FIXTURE_NOW);
    expect(bundle.since).toBe(since);
  });

  it('ingest：单源失败 → errors 如实登记、该源数据缺失（不吞、不假）', async () => {
    const lt = await store.add({ layer: 'long-term', source: 'user-stated', text: '长期知识仍在', at: todayAt + 1000 });
    await store.add({ layer: 'growth-log', source: 'agent-confirmed', text: '今日成长', at: todayAt + 2000 });

    class FlakyGrowthStore extends FileMemoryStore {
      override async query(q?: MemoryQuery): Promise<MemoryEntry[]> {
        if (q?.layer === 'growth-log') throw new Error('growth-log 读取失败');
        return super.query(q);
      }
    }
    const flaky = new FlakyGrowthStore({ baseDir, now: () => FIXTURE_NOW });
    const source = createMemoryReflectionDataSource(flaky, { logger: silentLogger });
    const bundle = await source.ingest({ now: FIXTURE_NOW, since });

    // 失败源：如实登记 + 数据保持缺失（不是空数组伪装成功——它有 errors 在案）
    expect(bundle.errors).toEqual([{ source: 'growth-log', message: 'growth-log 读取失败' }]);
    expect(bundle.growthLogEntries).toEqual([]);
    // 其他源正常收集，不受连累
    expect(bundle.longTermEntries.map((e) => e.id)).toEqual([lt.id]);
  });
});
