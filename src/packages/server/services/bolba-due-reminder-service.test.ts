/**
 * 任务13·⑩ bolba-due-reminder-service 单测
 *
 * 覆盖：信号构造（含 dedupeKey/评分/时效）、跨日重置纯函数、扫描主流程四档
 * （SPEAK / PREPARE 深夜与攒批 / STORE 预算用尽 / SILENT 重复）、跨日预算回滚、
 * speak 降级 notice、fetch 失败兜底、cron 注册点幂等与可停。
 *
 * 依赖 mock：voice-companion-service（logProactiveBroadcast 探针，不加载真实重模块）、
 * data/system-log（logEvent 探针，断言 bolba-sync 行）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalQueue } from '../jarvis-core/index.js';
import {
  buildDueReminderSignal,
  createBolbaReminderPorts,
  resetBolbaDueReminderStateForTests,
  rolloverGatesStateForNewDay,
  runBolbaDueReminderScan,
} from './bolba-due-reminder-service.js';
import type { BolbaApiTask } from './bolba-bridge-service.js';
import * as cronService from './cron-service.js';

vi.mock('./voice-companion-service.js', () => ({ logProactiveBroadcast: vi.fn() }));

vi.mock('../data/system-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/system-log.js')>();
  return { ...actual, logEvent: vi.fn() };
});

import { logProactiveBroadcast } from './voice-companion-service.js';
import { logEvent } from '../data/system-log.js';

const broadcastMock = vi.mocked(logProactiveBroadcast);
const logEventMock = vi.mocked(logEvent);

/** 2026-10-05 周一 08:00（本地时区）——非深夜、非 focus 窗口。 */
const NOW8 = new Date(2026, 9, 5, 8, 0, 0);
const NOW3 = new Date(2026, 9, 5, 3, 0, 0);
const NEXT_DAY8 = new Date(2026, 9, 6, 8, 0, 0);

function task(over: Partial<BolbaApiTask> & { id: number; title: string }): BolbaApiTask {
  return { status: 'open', ...over };
}

const DUE_TASKS: BolbaApiTask[] = [
  task({ id: 1, title: 'A 过期两天', due: '2026-10-03' }),
  task({ id: 2, title: 'B 今天', due: '2026-10-05' }),
  task({ id: 3, title: 'C 明天', due: '2026-10-06', proj: 'BOL' }),
  task({ id: 4, title: 'D 两周后', due: '2026-10-20' }),
  task({ id: 5, title: 'E 已完成', due: '2026-10-05', status: 'done' }),
];

/** 取出 bolba-sync 埋点行（body 形态）。 */
function syncLogs(): Record<string, unknown>[] {
  return logEventMock.mock.calls
    .map((call) => call[1] as { body?: Record<string, unknown> } | undefined)
    .map((fields) => fields?.body)
    .filter((body): body is Record<string, unknown> => !!body && body.cat === 'bolba-sync');
}

function seededQueue(now: Date, spokenToday: number): SignalQueue {
  const queue = new SignalQueue({ now: now.getTime() });
  queue.restoreState({ ...queue.snapshotState(), spokenToday });
  return queue;
}

beforeEach(() => {
  broadcastMock.mockClear();
  logEventMock.mockClear();
  resetBolbaDueReminderStateForTests();
});

afterEach(() => {
  cronService.stopBolbaDueReminderJob();
});

// ============================================================================
// 信号构造
// ============================================================================

describe('buildDueReminderSignal', () => {
  it('无近期待办 → null（不空发信号）', () => {
    expect(buildDueReminderSignal([task({ id: 4, title: 'D', due: '2026-10-20' })], NOW8)).toBeNull();
    expect(buildDueReminderSignal([task({ id: 5, title: 'E', status: 'done', due: '2026-10-05' })], NOW8)).toBeNull();
  });

  it('overdue+today+tomorrow → 一条聚合信号：memory/bolba_task_due/按日 dedupeKey/强时效', () => {
    const signal = buildDueReminderSignal(DUE_TASKS, NOW8);
    expect(signal).toMatchObject({
      source: 'memory',
      kind: 'bolba_task_due',
      ts: NOW8.getTime(),
      dedupeKey: 'bolba-due-scan:2026-10-05',
      urgency: 85,
      relevance: 80,
      certainty: 95,
      timeSensitive: true,
    });
    expect(signal?.text).toContain('今天要盯 3 件');
    expect(signal?.payload).toMatchObject({ count: 3, taskIds: [1, 2, 3] });
  });

  it('仅明天到期 → 不加 timeSensitive、urgency 70（落 PREPARE 攒批）', () => {
    const signal = buildDueReminderSignal([task({ id: 3, title: 'C 明天', due: '2026-10-06' })], NOW8);
    expect(signal).toMatchObject({ urgency: 70 });
    expect(signal?.timeSensitive).toBeUndefined();
  });

  it('horizon 只看今天/明天：后天及更远不发', () => {
    expect(buildDueReminderSignal([task({ id: 6, title: 'F', due: '2026-10-07' })], NOW8)).toBeNull();
  });
});

// ============================================================================
// 跨日重置
// ============================================================================

describe('rolloverGatesStateForNewDay', () => {
  it('同一天：原样返回（同一引用）', () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    queue.restoreState({ ...queue.snapshotState(), spokenToday: 3, instantSpeakToday: 2 });
    const state = queue.snapshotState();
    expect(rolloverGatesStateForNewDay(state, NOW8)).toBe(state);
  });

  it('跨日：预算计数与统计归零，seenKeys/env/config 保留', () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    queue.restoreState({
      ...queue.snapshotState(),
      spokenToday: 3,
      instantSpeakToday: 2,
      seenKeys: ['bolba-due-scan:2026-10-05'],
      stats: { broadcasts: 4, ignored: 1, adopted: 2 },
    });
    const rolled = rolloverGatesStateForNewDay(queue.snapshotState(), NEXT_DAY8);
    expect(rolled.spokenToday).toBe(0);
    expect(rolled.instantSpeakToday).toBe(0);
    expect(rolled.stats).toEqual({ broadcasts: 0, ignored: 0, adopted: 0 });
    expect(rolled.seenKeys).toEqual(['bolba-due-scan:2026-10-05']);
    expect(rolled.config).toEqual(queue.snapshotState().config);
    expect(rolled.now).toBe(NEXT_DAY8.getTime());
  });
});

// ============================================================================
// 扫描主流程（四档）
// ============================================================================

describe('runBolbaDueReminderScan — 闸门四档与投递', () => {
  it('08:00 overdue/today → SPEAK：走 vcs 主动播报出口 + due-reminder 埋点', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBolbaDueReminderScan({
      fetchTasks: async () => DUE_TASKS,
      now: () => NOW8,
      queue,
    });

    expect(r).toMatchObject({ scanned: 5, due: 3, degraded: false });
    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'urgent' }]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bolba_due_reminder',
      text: expect.stringContaining('今天要盯 3 件'),
    }));
    const rows = syncLogs();
    expect(rows.some((r2) => r2.op === 'scan' && r2.ok === true && r2.count === 5)).toBe(true);
    expect(rows.some((r2) => r2.op === 'due-reminder' && r2.tier === 'SPEAK' && r2.ok === true)).toBe(true);
  });

  it('同日二次扫描 → SILENT duplicate（幂等不重播）', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const first = await runBolbaDueReminderScan({ fetchTasks: async () => DUE_TASKS, now: () => NOW8, queue });
    const second = await runBolbaDueReminderScan({ fetchTasks: async () => DUE_TASKS, now: () => NOW8, queue });

    expect(first.decisions).toEqual([{ tier: 'SPEAK', reason: 'urgent' }]);
    expect(second.decisions).toEqual([{ tier: 'SILENT', reason: 'duplicate' }]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('03:00 深夜 → PREPARE deep_night：不播、留攒批缓冲', async () => {
    const queue = new SignalQueue({ now: NOW3.getTime() });
    const r = await runBolbaDueReminderScan({ fetchTasks: async () => DUE_TASKS, now: () => NOW3, queue });

    expect(r.decisions).toEqual([{ tier: 'PREPARE', reason: 'deep_night' }]);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(queue.preparedCount).toBe(1);
    expect(syncLogs().some((row) => row.op === 'due-reminder' && row.tier === 'PREPARE')).toBe(true);
  });

  it('仅明天 → PREPARE batched（不打扰）', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBolbaDueReminderScan({
      fetchTasks: async () => [task({ id: 3, title: 'C 明天', due: '2026-10-06' })],
      now: () => NOW8,
      queue,
    });
    expect(r.decisions).toEqual([{ tier: 'PREPARE', reason: 'batched' }]);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('预算用尽同一天 → STORE：只登记 system_log，不写 broadcast 假装上屏', async () => {
    const queue = seededQueue(NOW8, 10);
    const r = await runBolbaDueReminderScan({ fetchTasks: async () => DUE_TASKS, now: () => NOW8, queue });

    expect(r.decisions).toEqual([{ tier: 'STORE', reason: 'budget_exhausted' }]);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(syncLogs().some((row) => row.op === 'due-reminder' && row.tier === 'STORE')).toBe(true);
  });

  it('跨日扫描 → 预算计数回滚后照常 SPEAK（接线层 rollover 生效）', async () => {
    const queue = seededQueue(NOW8, 10); // 昨日预算用尽
    const r = await runBolbaDueReminderScan({ fetchTasks: async () => DUE_TASKS, now: () => NEXT_DAY8, queue });

    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'urgent' }]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('speak 出口抛错 → 降级 notice 同通道 + degraded 标记', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBolbaDueReminderScan({
      fetchTasks: async () => DUE_TASKS,
      now: () => NOW8,
      queue,
      ports: {
        ...createBolbaReminderPorts(),
        speak: () => { throw new Error('voice channel down'); },
      },
    });

    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'urgent' }]);
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({ degraded: true, action: 'bolba_due_reminder' }));
    expect(syncLogs().some((row) => row.op === 'due-reminder' && row.ok === false && String(row.error).startsWith('degraded:'))).toBe(true);
  });

  it('投递注入：deliver 收到可观察的 ConsumedSignal（tier/预算预扣）', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const deliver = vi.fn();
    const r = await runBolbaDueReminderScan({ fetchTasks: async () => DUE_TASKS, now: () => NOW8, queue, deliver });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({
      decision: { tier: 'SPEAK' },
      budgetCharged: true,
    });
    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'urgent' }]);
  });
});

describe('runBolbaDueReminderScan — 兜底与空板', () => {
  it('fetch 抛错 → 不抛、degraded=true、scan warn 落盘', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBolbaDueReminderScan({
      fetchTasks: async () => { throw new Error('ECONNREFUSED'); },
      now: () => NOW8,
      queue,
    });

    expect(r).toMatchObject({ scanned: 0, due: 0, degraded: true });
    expect(broadcastMock).not.toHaveBeenCalled();
    const row = syncLogs().find((r2) => r2.op === 'scan');
    expect(row).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });

  it('没有到期的 → 不发信号、不播报，scan 记 no-due', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBolbaDueReminderScan({
      fetchTasks: async () => [task({ id: 4, title: 'D', due: '2026-10-20' })],
      now: () => NOW8,
      queue,
    });

    expect(r).toMatchObject({ scanned: 1, due: 0, decisions: [], degraded: false });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(syncLogs().some((row) => row.op === 'scan' && row.reason === 'no-due')).toBe(true);
  });
});

// ============================================================================
// cron 注册点
// ============================================================================

describe('startBolbaDueReminderJob', () => {
  it('模块加载自启；重复调用幂等（同一句柄）；表达式/时区/interval 就位', () => {
    const first = cronService.startBolbaDueReminderJob();
    const second = cronService.startBolbaDueReminderJob();
    expect(first).toBe(second);
    expect(first.expression).toBe(cronService.BOLBA_DUE_SCAN_CRON);
    expect(first.expression).toBe('0 8 * * *');
    expect(first.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(first.timer).not.toBeNull();
  });

  it('stopBolbaDueReminderJob 可停且清空注册点，再次启动拿到新句柄', () => {
    const first = cronService.startBolbaDueReminderJob();
    cronService.stopBolbaDueReminderJob();
    expect(first.timer).toBeNull();
    const second = cronService.startBolbaDueReminderJob();
    expect(second).not.toBe(first);
    expect(second.timer).not.toBeNull();
  });

  it('注册点与真实扫描模块可拼接（callback 存在且为函数）', () => {
    const job = cronService.startBolbaDueReminderJob();
    expect(typeof job.callback).toBe('function');
  });
});
