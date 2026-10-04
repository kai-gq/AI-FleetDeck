/**
 * 任务17·A2 receipt-timeout-service 单测（L2 桩测）
 *
 * 覆盖：开关解析（缺省开/关）、阈值解析（缺省 30 / 非法兜底 + 警告）、
 * 超时判定边界（恰好 30 分钟不提醒、+1ms 提醒）、matchedAt 排除、
 * 幂等单次提醒（同回执第二次扫描 duplicates）、失败隔离（播报抛错不阻断其余、
 * 失败不记账下轮重试、枚举抛错 degraded 不上抛）、结构化日志、
 * 账本裁剪、与真实登记表单例的接线（registerPendingReceipt → listPendingReceipts）。
 *
 * 依赖 mock：voice-companion-service（logProactiveBroadcast 探针）、
 * data/system-log（logEvent 探针）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECEIPT_TIMEOUT_MIN,
  RECEIPT_TIMEOUT_ACTION,
  RECEIPT_TIMEOUT_LOG_SOURCE,
  isReceiptTimeoutEnabled,
  resetReceiptTimeoutStateForTests,
  resolveReceiptTimeoutMs,
  runReceiptTimeoutScan,
} from './receipt-timeout-service.js';
import {
  registerPendingReceipt,
  resetPendingReceiptsForTests,
  type PendingReceipt,
} from '../websocket/handlers/pending-receipt-registry.js';
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

/** 2026-10-05 08:00 本地。 */
const NOW = new Date(2026, 9, 5, 8, 0, 0).getTime();
const MIN = 60_000;

function receipt(overrides: Partial<PendingReceipt> = {}): PendingReceipt {
  return {
    targetAgentId: 'agent-1',
    bossId: 'boss-1',
    taskSummary: '实现登录页',
    registeredAt: NOW - 31 * MIN,
    ...overrides,
  };
}

/** 本来源的事件行（body 形态）。 */
function scanLogs(): Record<string, unknown>[] {
  return logEventMock.mock.calls
    .map((call) => call[1] as { source?: string; body?: Record<string, unknown> } | undefined)
    .filter((fields): fields is { source?: string; body: Record<string, unknown> } =>
      !!fields && (fields.body as Record<string, unknown>)?.cat === 'receipt-timeout')
    .map((fields) => fields.body);
}

beforeEach(() => {
  broadcastMock.mockClear();
  logEventMock.mockClear();
  resetReceiptTimeoutStateForTests();
  resetPendingReceiptsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetPendingReceiptsForTests();
  cronService.stopReceiptTimeoutJob();
});

// ============================================================================
// 开关与阈值
// ============================================================================

describe('开关 TC_JARVIS_RECEIPT_TIMEOUT', () => {
  it('缺省开；0/off/false（含大小写空白）关', () => {
    expect(isReceiptTimeoutEnabled({})).toBe(true);
    expect(isReceiptTimeoutEnabled({ TC_JARVIS_RECEIPT_TIMEOUT: undefined })).toBe(true);
    expect(isReceiptTimeoutEnabled({ TC_JARVIS_RECEIPT_TIMEOUT: '' })).toBe(true);
    expect(isReceiptTimeoutEnabled({ TC_JARVIS_RECEIPT_TIMEOUT: '1' })).toBe(true);
    expect(isReceiptTimeoutEnabled({ TC_JARVIS_RECEIPT_TIMEOUT: '0' })).toBe(false);
    expect(isReceiptTimeoutEnabled({ TC_JARVIS_RECEIPT_TIMEOUT: ' off ' })).toBe(false);
    expect(isReceiptTimeoutEnabled({ TC_JARVIS_RECEIPT_TIMEOUT: 'FALSE' })).toBe(false);
  });

  it('关闭 → 零扫描零调用（不枚举登记表、不播报），disabled=true 且登记 disabled', async () => {
    vi.stubEnv('TC_JARVIS_RECEIPT_TIMEOUT', '0');
    const listReceipts = vi.fn(() => [receipt()]);
    const r = await runReceiptTimeoutScan({ listReceipts, now: () => new Date(NOW) });

    expect(r).toMatchObject({ disabled: true, scanned: 0, timedOut: 0, reminded: 0, degraded: false });
    expect(listReceipts).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(scanLogs().some((row) => row.op === 'scan' && row.reason === 'disabled')).toBe(true);
  });
});

describe('阈值 TC_JARVIS_RECEIPT_TIMEOUT_MIN', () => {
  it('缺省 30 分钟；显式数值按分钟生效', () => {
    expect(resolveReceiptTimeoutMs({})).toMatchObject({ ms: DEFAULT_RECEIPT_TIMEOUT_MIN * MIN, fallback: false });
    expect(resolveReceiptTimeoutMs({ TC_JARVIS_RECEIPT_TIMEOUT_MIN: '5' })).toMatchObject({ ms: 5 * MIN, fallback: false });
    expect(resolveReceiptTimeoutMs({ TC_JARVIS_RECEIPT_TIMEOUT_MIN: ' 0 ' })).toMatchObject({ ms: 0, fallback: false });
  });

  it('负数 / NaN / Infinity / 非数值串 → 兜底 30 + fallback 标记（并记警告）', async () => {
    for (const bad of ['-1', 'NaN', 'Infinity', 'abc']) {
      expect(resolveReceiptTimeoutMs({ TC_JARVIS_RECEIPT_TIMEOUT_MIN: bad })).toMatchObject({
        ms: DEFAULT_RECEIPT_TIMEOUT_MIN * MIN,
        fallback: true,
        raw: bad,
      });
    }

    // 扫描路径：非法值兜底后按 30 分钟判定（31 分钟前登记 → 仍提醒）
    vi.stubEnv('TC_JARVIS_RECEIPT_TIMEOUT_MIN', 'Infinity');
    const r = await runReceiptTimeoutScan({
      listReceipts: () => [receipt()],
      now: () => new Date(NOW),
      broadcast: broadcastMock,
    });
    expect(r.timeoutMs).toBe(30 * MIN);
    expect(r.reminded).toBe(1);
  });
});

// ============================================================================
// 扫描判定与幂等
// ============================================================================

describe('runReceiptTimeoutScan — 判定 / 幂等 / 隔离', () => {
  it('超过阈值未匹配 → 提醒一次（⑩ 通道 + action + 中文文本含分钟数）；恰好阈值不提醒', async () => {
    const r = await runReceiptTimeoutScan({
      listReceipts: () => [
        receipt({ targetAgentId: 'agent-over', registeredAt: NOW - 31 * MIN }),
        receipt({ targetAgentId: 'agent-edge', registeredAt: NOW - 30 * MIN }),
      ],
      now: () => new Date(NOW),
      broadcast: broadcastMock,
    });

    expect(r).toMatchObject({ scanned: 2, unmatched: 2, timedOut: 1, reminded: 1, duplicates: 0, degraded: false });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith({
      text: '委派提醒：agent-over 的任务「实现登录页」已 31 分钟未见回执，请跟进。',
      action: RECEIPT_TIMEOUT_ACTION,
    });
    expect(scanLogs().some((row) =>
      row.op === 'remind' && row.ok === true && row.agentId === 'agent-over' && row.ageMs === 31 * MIN,
    )).toBe(true);
    expect(scanLogs().some((row) =>
      row.op === 'scan' && row.ok === true && row.scanned === 2 && row.unmatched === 2 && row.timedOut === 1 && row.reminded === 1,
    )).toBe(true);
    expect(logEventMock.mock.calls.every((call) => call[0] === 'system')).toBe(true);
  });

  it('matchedAt 已匹配 → 不计入未匹配、不提醒', async () => {
    const r = await runReceiptTimeoutScan({
      listReceipts: () => [receipt({ matchedAt: NOW - 5 * MIN })],
      now: () => new Date(NOW),
      broadcast: broadcastMock,
    });

    expect(r).toMatchObject({ scanned: 1, unmatched: 0, timedOut: 0, reminded: 0 });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('同一回执幂等：第二次扫描 → duplicates=1、不重播；新登记（新 registeredAt）→ 可再次提醒', async () => {
    const listReceipts = () => [receipt({ registeredAt: NOW - 31 * MIN })];
    const deps = { listReceipts, now: () => new Date(NOW), broadcast: broadcastMock };

    const first = await runReceiptTimeoutScan(deps);
    const second = await runReceiptTimeoutScan(deps);
    expect(first.reminded).toBe(1);
    expect(second).toMatchObject({ timedOut: 1, reminded: 0, duplicates: 1 });
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    // 同一 agent 新任务重新登记（registeredAt 变化）→ 新键，可再次提醒
    const third = await runReceiptTimeoutScan({
      ...deps,
      listReceipts: () => [receipt({ registeredAt: NOW - 10 * MIN })],
    });
    expect(third).toMatchObject({ timedOut: 0, reminded: 0 }); // 未超阈值
    const fourth = await runReceiptTimeoutScan({
      ...deps,
      listReceipts: () => [receipt({ registeredAt: NOW - 45 * MIN })],
    });
    expect(fourth.reminded).toBe(1);
    expect(broadcastMock).toHaveBeenCalledTimes(2);
  });

  it('失败隔离：单条播报抛错不阻断其余条目，失败不记账（下轮重试），本体不上抛', async () => {
    const flaky = vi.fn(({ text }: { text: string }) => {
      if (text.includes('agent-bad')) throw new Error('voice down');
    });
    const listReceipts = () => [
      receipt({ targetAgentId: 'agent-bad', registeredAt: NOW - 40 * MIN }),
      receipt({ targetAgentId: 'agent-good', registeredAt: NOW - 35 * MIN }),
    ];

    const first = await runReceiptTimeoutScan({ listReceipts, now: () => new Date(NOW), broadcast: flaky });
    expect(first).toMatchObject({ timedOut: 2, reminded: 1, degraded: false });
    expect(flaky).toHaveBeenCalledTimes(2); // 异常被吃掉，第二条照常
    expect(scanLogs().some((row) =>
      row.op === 'remind' && row.ok === false && row.agentId === 'agent-bad' && row.error === 'voice down',
    )).toBe(true);

    // 失败者未记账 → 下轮重试成功（agent-bad 补提醒 1 次）；上轮成功者仍幂等跳过
    const second = await runReceiptTimeoutScan({ listReceipts, now: () => new Date(NOW), broadcast: broadcastMock });
    expect(second).toMatchObject({ timedOut: 2, reminded: 1, duplicates: 1 });
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('agent-bad') }));
    const third = await runReceiptTimeoutScan({ listReceipts, now: () => new Date(NOW), broadcast: broadcastMock });
    expect(third).toMatchObject({ reminded: 0, duplicates: 2 });
  });

  it('枚举抛错 → degraded=true、不上抛、不播报；now 注入抛错 → 同样降级兜底', async () => {
    const r = await runReceiptTimeoutScan({
      listReceipts: () => { throw new Error('EACCES'); },
      now: () => new Date(NOW),
      broadcast: broadcastMock,
    });
    expect(r).toMatchObject({ degraded: true, scanned: 0, reminded: 0 });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(scanLogs().some((row) => row.op === 'scan' && row.ok === false && row.error === 'EACCES')).toBe(true);

    const r2 = await runReceiptTimeoutScan({
      now: () => { throw new Error('clock broken'); },
      listReceipts: () => [receipt()],
      broadcast: broadcastMock,
    });
    expect(r2.degraded).toBe(true);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('账本裁剪：登记表已不见的回执键被清掉（有界），不误伤仍在册者', async () => {
    const reminded = new Set(['ghost:1', 'agent-1:100']);
    await runReceiptTimeoutScan({
      listReceipts: () => [receipt({ registeredAt: 100 })],
      now: () => new Date(NOW),
      broadcast: broadcastMock,
      reminded,
    });
    expect(reminded.has('ghost:1')).toBe(false);
    expect(reminded.has('agent-1:100')).toBe(true);
  });

  it('与真实登记表单例接线：registerPendingReceipt → listPendingReceipts 超时被提醒（超时分钟数与登记一致）', async () => {
    registerPendingReceipt({
      targetAgentId: 'agent-real',
      bossId: 'boss-1',
      taskSummary: '接线验证任务',
      registeredAt: NOW - 33 * MIN,
    });
    registerPendingReceipt({
      targetAgentId: 'agent-fresh',
      bossId: 'boss-1',
      taskSummary: '刚派出的任务',
      registeredAt: NOW - 2 * MIN,
    });

    const r = await runReceiptTimeoutScan({ now: () => new Date(NOW), broadcast: broadcastMock });

    expect(r).toMatchObject({ scanned: 2, unmatched: 2, timedOut: 1, reminded: 1 });
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('agent-real'),
    }));
    expect(broadcastMock).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('agent-fresh'),
    }));
  });

  it('结构化日志 source 为 receipt-timeout（观测可筛）', async () => {
    await runReceiptTimeoutScan({
      listReceipts: () => [receipt()],
      now: () => new Date(NOW),
      broadcast: broadcastMock,
    });
    const sources = logEventMock.mock.calls.map((call) => (call[1] as { source?: string } | undefined)?.source);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source === RECEIPT_TIMEOUT_LOG_SOURCE)).toBe(true);
  });
});

// ============================================================================
// cron 注册点
// ============================================================================

describe('startReceiptTimeoutJob', () => {
  it('模块加载自启；重复调用幂等（同一句柄）；表达式 */5 就位且解析合法', () => {
    const first = cronService.startReceiptTimeoutJob();
    const second = cronService.startReceiptTimeoutJob();
    expect(first).toBe(second);
    expect(first.expression).toBe(cronService.RECEIPT_TIMEOUT_CRON);
    expect(first.expression).toBe('*/5 * * * *');
    expect(first.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(first.timer).not.toBeNull();

    const next = cronService.getNextFireTimes(first.expression, first.timezone, 3);
    expect(next.length).toBe(3);
    expect(next.every((d) => d.getMinutes() % 5 === 0)).toBe(true);
  });

  it('stopReceiptTimeoutJob 可停且清空注册点，再次启动拿到新句柄', () => {
    const first = cronService.startReceiptTimeoutJob();
    cronService.stopReceiptTimeoutJob();
    expect(first.timer).toBeNull();
    const second = cronService.startReceiptTimeoutJob();
    expect(second).not.toBe(first);
    expect(second.timer).not.toBeNull();
  });

  it('既有 4 个 job 常量零改动（回归）', () => {
    expect(cronService.BOLBA_DUE_SCAN_CRON).toBe('0 8 * * *');
    expect(cronService.BOSS_MORNING_REPORT_CRON).toBe('0 8 * * *');
    expect(cronService.NIGHTLY_REFLECTION_CRON).toBe('0 2 * * *');
    expect(cronService.DAILY_LOG_REPORT_CRON).toBe('0 7 * * *');
  });
});
