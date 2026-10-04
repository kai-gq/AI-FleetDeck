/**
 * jarvis-core/reflection · ⑭ 观测通道集成（任务 28 ⑦）
 *
 * 用**真实 logEvent + EventDB**（src/test-setup.ts 已把 XDG_DATA_HOME 指向
 * 进程级临时沙箱）验证注入式通道可用：
 *   createReflectionLogObserver(logEvent) → runNightlyReflection
 *   → logEvent('system', { source:'reflection', body:{cat:'reflection',…} })
 *   → querySystemLog({ source:'reflection' }) 读回。
 * 覆盖 completed（含四操作计数/Tier2 拦截率与拦截数）、skipped（门槛原因）、
 * failed（通道未接线，level=warn）三种终态事件。与 memory-activity 集成同款沙箱。
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeEventDb, initEventDb } from '../../data/event-db.js';
import { logEvent, querySystemLog } from '../../data/system-log.js';
import { FileMemoryStore } from '../memory/index.js';
import type { JarvisLogger } from '../executors.js';
import {
  FileReflectionRunState,
  Tier2ReviewQueue,
  createReflectionLogObserver,
  createStaticReflectionDataSource,
  createStaticReflectionLlm,
  runNightlyReflection,
  startOfLocalDay,
  type IngestedSessionSummary,
} from './index.js';
import { FIXTURE_NOW } from './__fixtures__/reflection-fixtures.js';

const dataHome = process.env.XDG_DATA_HOME;
if (!dataHome) throw new Error('XDG_DATA_HOME 未设置：test-setup 沙箱失效，拒绝加载本测试文件');

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/** 本文件独占渠道标签，避免与其他用例的 reflection 行串扰。 */
const CHANNEL = `reflection-int-${process.pid}`;

function sessions(count: number): IngestedSessionSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `s${i + 1}`,
    summary: `会话 ${i + 1} 摘要`,
    at: FIXTURE_NOW - (count - i) * 60 * 60 * 1000,
  }));
}

function bodyOf(row: { body?: string }): Record<string, unknown> {
  return JSON.parse(row.body ?? '{}');
}

/** 本渠道的 reflection 事件行（升序）。 */
function channelRows(): Array<{ body?: string; level: string; category: string }> {
  return querySystemLog({ source: 'reflection', order: 'asc' })
    .map((row) => ({ body: row.body, level: row.level, category: row.category }))
    .filter((row) => bodyOf(row).channel === CHANNEL);
}

let baseDir = '';
let store: FileMemoryStore;

beforeAll(() => {
  initEventDb();
});

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-int-'));
  store = new FileMemoryStore({ baseDir: path.join(baseDir, 'memory'), now: () => FIXTURE_NOW });
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

afterAll(() => {
  closeEventDb();
});

describe('反思运行 → ⑭ system/reflection 通道（真实 EventDB 沙箱）', () => {
  it('completed：四操作计数 / tier1Applied / tier2Intercepted / tier2Rate 可按 source=reflection 读回', async () => {
    const before = channelRows().length;
    const source = createStaticReflectionDataSource(5, {
      now: FIXTURE_NOW,
      since: startOfLocalDay(FIXTURE_NOW),
      sessions: sessions(5),
    });
    const llm = createStaticReflectionLlm({
      newEntries: [{ text: '低置信自动项' }, { text: '决定类项：决定采用 A' }],
    });
    const result = await runNightlyReflection({
      store,
      dataSource: source,
      llm,
      firstRun: false,
      reviewQueue: new Tier2ReviewQueue({ filePath: path.join(baseDir, 'reviews.json'), now: () => FIXTURE_NOW, logger: silentLogger }),
      runState: new FileReflectionRunState({ filePath: path.join(baseDir, 'run-state.json'), logger: silentLogger }),
      observer: createReflectionLogObserver(logEvent, { channel: CHANNEL }),
      logger: silentLogger,
      now: () => FIXTURE_NOW,
    });
    expect(result.status).toBe('completed');

    const rows = channelRows();
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    expect(row.category).toBe('system');
    expect(row.level).toBe('info');
    expect(bodyOf(row)).toMatchObject({
      cat: 'reflection',
      channel: CHANNEL,
      kind: 'reflection.run.completed',
      runId: result.runId,
      at: FIXTURE_NOW,
      sessionCount: 5,
      firstRun: false,
      ingest: { sessions: 5, sourceErrors: 0 },
      operationCounts: { NEW: 2, UPDATE: 0, DELETE: 0, PROMOTE: 0 },
      rejectedCount: 0,
      tier1Applied: 1,
      tier2Intercepted: 1,
      tier2Rate: 0.5,
      morningDraftWritten: false,
    });
  });

  it('skipped：门槛不足原因落 body.skippedReason（level=info，安静跳过）', async () => {
    const source = createStaticReflectionDataSource(4, {
      now: FIXTURE_NOW,
      since: startOfLocalDay(FIXTURE_NOW),
      sessions: sessions(4),
    });
    const result = await runNightlyReflection({
      store,
      dataSource: source,
      firstRun: false,
      reviewQueue: new Tier2ReviewQueue({ filePath: path.join(baseDir, 'reviews.json'), now: () => FIXTURE_NOW, logger: silentLogger }),
      runState: new FileReflectionRunState({ filePath: path.join(baseDir, 'run-state.json'), logger: silentLogger }),
      observer: createReflectionLogObserver(logEvent, { channel: CHANNEL }),
      logger: silentLogger,
      now: () => FIXTURE_NOW,
    });
    expect(result.status).toBe('skipped');

    const rows = channelRows();
    const row = rows[rows.length - 1];
    expect(row.level).toBe('info');
    expect(bodyOf(row)).toMatchObject({
      cat: 'reflection',
      channel: CHANNEL,
      kind: 'reflection.run.skipped',
      runId: result.runId,
      sessionCount: 4,
      skippedReason: 'insufficient-sessions',
      tier1Applied: 0,
      tier2Intercepted: 0,
      tier2Rate: 0,
    });
  });

  it('failed：真实通道未接线 → level=warn + failReason + errors 明细（不静默）', async () => {
    const source = createStaticReflectionDataSource(5, {
      now: FIXTURE_NOW,
      since: startOfLocalDay(FIXTURE_NOW),
      sessions: sessions(5),
    });
    // 不传 llm：走缺省不可用端口
    const result = await runNightlyReflection({
      store,
      dataSource: source,
      firstRun: false,
      reviewQueue: new Tier2ReviewQueue({ filePath: path.join(baseDir, 'reviews.json'), now: () => FIXTURE_NOW, logger: silentLogger }),
      runState: new FileReflectionRunState({ filePath: path.join(baseDir, 'run-state.json'), logger: silentLogger }),
      observer: createReflectionLogObserver(logEvent, { channel: CHANNEL }),
      logger: silentLogger,
      now: () => FIXTURE_NOW,
    });
    expect(result.status).toBe('failed');

    const rows = channelRows();
    const row = rows[rows.length - 1];
    expect(row.level).toBe('warn');
    const body = bodyOf(row);
    expect(body).toMatchObject({
      cat: 'reflection',
      channel: CHANNEL,
      kind: 'reflection.run.failed',
      failReason: 'llm-port-unavailable',
      tier1Applied: 0,
      tier2Intercepted: 0,
    });
    expect(Array.isArray(body.errors)).toBe(true);
    expect((body.errors as string[])[0]).toContain('llm-port-unavailable');
  });
});
