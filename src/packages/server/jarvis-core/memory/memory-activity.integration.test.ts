/**
 * jarvis-core/memory · ⑭ 观测通道集成（任务 27 ⑦ / ⑥.5）
 *
 * 用**真实 logEvent + EventDB**（src/test-setup.ts 已把 XDG_DATA_HOME 指向
 * 进程级临时沙箱）验证注入式回调通道可用：
 *   createSystemLogObserver(logEvent) → FileMemoryStore / MemoryWriteEngine
 *   → logEvent('system', { source:'memory', body:{cat:'memory',…} })
 *   → querySystemLog({ source:'memory' }) 读回。
 * 与 services/activity-log.test.ts 同款沙箱模式；断言写失败降级按 warn 落盘。
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeEventDb, initEventDb } from '../../data/event-db.js';
import { logEvent, querySystemLog } from '../../data/system-log.js';
import { createMemoryStack, createSystemLogObserver, MemoryWriteEngine, type MemoryLifecycleStore } from './index.js';

const dataHome = process.env.XDG_DATA_HOME;
if (!dataHome) throw new Error('XDG_DATA_HOME 未设置：test-setup 沙箱失效，拒绝加载本测试文件');

let baseDir = '';

beforeAll(() => {
  initEventDb();
});

afterAll(() => {
  closeEventDb();
});

afterEach(() => {
  if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
});

function bodyOf(row: { body?: string }): Record<string, unknown> {
  return JSON.parse(row.body ?? '{}');
}

const DAY = 24 * 60 * 60 * 1000;

describe('记忆操作 → ⑭ system/memory 通道（真实 EventDB 沙箱）', () => {
  it('add/capture/sweep 落盘，可按 source=memory 查询，droppedCount 可见', async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-int-'));
    let clock = 1_700_000_000_000;
    const stack = createMemoryStack({ baseDir, logEvent, channel: 'memory-int', now: () => clock });
    const sessionId = `sess-mem-int-${process.pid}-${Date.now()}`;

    const captured = await stack.engine.captureUserTurn('不是这样的，我是说用 pnpm', { sessionId });
    expect(captured.entries).toHaveLength(1);

    // 触发一次裁剪：容量 0 → 该条被标记（droppedCount=1）
    clock += 1;
    const swept = await stack.store.sweep({ workingCapacity: 0, workingTtlMs: 365 * DAY });
    expect(swept.droppedCount).toBe(1);

    const allRows = querySystemLog({ source: 'memory', order: 'asc' });
    const rows = allRows.filter((r) => r.sessionId === sessionId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.category === 'system')).toBe(true);

    const bodies = rows.map(bodyOf);
    expect(bodies.some((b) => b.op === 'capture' && b.applied === true && b.layer === 'working')).toBe(true);
    expect(bodies.some((b) => b.op === 'add' && b.applied === true && b.source === 'user-stated')).toBe(true);

    // sweep 不携带会话（无会话上下文的裁剪），按 op 在全局行中找
    const sweepRow = allRows.find((r) => bodyOf(r).op === 'sweep');
    expect(sweepRow).toBeDefined();
    expect(bodyOf(sweepRow!)).toMatchObject({
      cat: 'memory', channel: 'memory-int', op: 'sweep', applied: true,
      layer: 'working', droppedCount: 1, markedTotal: 1,
    });
    expect(sweepRow!.level).toBe('info');
  });

  it('写失败降级事件按 warn 全量落盘（reason=error）', async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-int-'));
    const sessionId = `sess-mem-fail-${process.pid}-${Date.now()}`;
    const failingStore = {
      add: async () => {
        throw new Error('disk full');
      },
      update: async () => null,
      delete: async () => false,
      promote: async () => null,
      query: async () => [],
      list: async () => [],
      touch: async () => null,
      sweep: async () => ({
        markedExpired: 0, markedOverflow: 0, droppedCount: 0, markedIds: [],
        totals: { active: 0, marked: 0, byLayer: { working: 0, 'long-term': 0, 'growth-log': 0, reflections: 0 } },
      }),
      listMarkedForReflection: async () => [],
      stats: async () => ({ active: 0, marked: 0, byLayer: { working: 0, 'long-term': 0, 'growth-log': 0, reflections: 0 } }),
    } satisfies MemoryLifecycleStore;
    const observer = createSystemLogObserver(logEvent, { channel: 'memory-int-warn' });
    const engine = new MemoryWriteEngine({ store: failingStore, observer, now: () => 1_700_000_000_000 });

    const result = await engine.captureUserTurn('记住我喜欢 pnpm', { sessionId });
    expect(result.errors).toEqual(['disk full']);

    const rows = querySystemLog({ source: 'memory', sessionId });
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('warn');
    expect(bodyOf(rows[0])).toMatchObject({
      cat: 'memory', channel: 'memory-int-warn', op: 'capture', applied: false, reason: 'error',
      detail: { error: 'disk full' },
    });
  });
});
