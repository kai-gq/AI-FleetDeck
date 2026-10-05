/**
 * 任务29 · 晨报 × 13 双服务「同刻」防双播集成测试（覆盖账真实文件链路）
 *
 * 场景（两服务每日 08:00 各自 cron，触发顺序不可假定）：
 *   ① 晨报先跑：并入 Bolba 到期并播出 → 写覆盖账 → 13 读账跳过独播（零重复）；
 *   ② 13 先跑：独播 bolba_due_reminder → 晨报查当日 broadcast 日志命中 → 不并入（零重复）；
 *   ③ 晨报没真的播出（STORE/预算用尽）→ 不写账 → 13 照常独播（不静默丢话）。
 *
 * mock：voice-companion-service（logProactiveBroadcast 探针）、data/system-log
 * （logEvent 探针 + querySystemLog 可编排——模拟 13 已落库的播报行）。
 * 覆盖账一律注入临时文件，绝不碰真实 XDG 路径。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalQueue } from '../jarvis-core/index.js';

vi.mock('./voice-companion-service.js', () => ({ logProactiveBroadcast: vi.fn() }));

vi.mock('../data/system-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/system-log.js')>();
  return { ...actual, logEvent: vi.fn(), querySystemLog: vi.fn(() => []) };
});

import { logProactiveBroadcast } from './voice-companion-service.js';
import { querySystemLog, type SystemLogEntry } from '../data/system-log.js';
import {
  BOLBA_DUE_REMINDER_ACTION,
  resetBolbaDueReminderStateForTests,
  runBolbaDueReminderScan,
  type BolbaDueScanDeps,
} from './bolba-due-reminder-service.js';
import {
  BOSS_MORNING_REPORT_ACTION,
  resetBossMorningReportStateForTests,
  runBossMorningReportScan,
  type BossMorningReportScanDeps,
} from './boss-morning-report-service.js';
import { FileMorningCoverageStore } from './morning-coverage-store.js';
import type { BolbaApiTask } from './bolba-bridge-service.js';
import type { DelegationDecision } from '../../shared/types.js';

const broadcastMock = vi.mocked(logProactiveBroadcast);
const querySystemLogMock = vi.mocked(querySystemLog);

/** 2026-10-05 周一 08:00（本地时区）——两服务同刻。 */
const NOW8 = new Date(2026, 9, 5, 8, 0, 0);
const DAY_KEY = '2026-10-05';
const YDAY0 = new Date(2026, 9, 4).getTime();

/** 13 视角的到期任务（1 逾期、2 今天、3 明天；4 远期不进视野）。 */
const DUE_TASKS: BolbaApiTask[] = [
  { id: 1, title: '报价单', status: 'open', due: '2026-10-05', proj: 'BOL' },
  { id: 2, title: '证书续期', status: 'open', due: '2026-10-04' },
  { id: 3, title: '客户回访', status: 'open', due: '2026-10-06' },
  { id: 4, title: '远期安排', status: 'open', due: '2026-10-20' },
];

const YESTERDAY_RECORD: DelegationDecision = {
  id: 'dec-int-1',
  timestamp: YDAY0 + 3_600_000,
  bossId: 'boss-1',
  userCommand: '一句话委托',
  selectedAgentId: 'agent-1',
  selectedAgentName: '甲',
  reasoning: 'test',
  alternativeAgents: [],
  confidence: 'high',
  status: 'completed',
  completion: { completedAt: YDAY0 + 7_200_000, durationMs: 60_000, result: 'completed' },
};

let dir: string;
let coverageStore: FileMorningCoverageStore;
let coverageFile: string;

function morningDeps(over: Partial<BossMorningReportScanDeps> = {}): BossMorningReportScanDeps {
  return {
    loadHistory: () => new Map([['boss-1', [YESTERDAY_RECORD]]]),
    now: () => NOW8,
    queue: new SignalQueue({ now: NOW8.getTime() }),
    fetchBolbaTasks: async () => DUE_TASKS,
    coverageStore,
    ...over,
  };
}

function reminderDeps(): BolbaDueScanDeps {
  return {
    fetchTasks: async () => DUE_TASKS,
    now: () => NOW8,
    queue: new SignalQueue({ now: NOW8.getTime() }),
    coverageStore,
  };
}

function broadcastEntry(ts: number, action: string): SystemLogEntry {
  return {
    ts,
    category: 'broadcast',
    level: 'info',
    body: JSON.stringify({ cat: 'broadcast', phase: 'server-sent', action, text: `${action} 播报原文` }),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-coverage-int-'));
  coverageFile = path.join(dir, 'coverage.json');
  coverageStore = new FileMorningCoverageStore({ filePath: coverageFile });
  broadcastMock.mockClear();
  querySystemLogMock.mockClear();
  querySystemLogMock.mockReturnValue([]);
  resetBossMorningReportStateForTests();
  resetBolbaDueReminderStateForTests();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('任务29：晨报 × 13 同刻防双播（覆盖账文件链路）', () => {
  it('① 晨报先跑：并入并播出 → 写账 → 13 读账跳过（全程只播一次，Bolba 不重复）', async () => {
    // 晨报：Bolba 到期并入，08:00 SPEAK 播出
    const morning = await runBossMorningReportScan(morningDeps({ hasBolbaBroadcastToday: () => false }));
    expect(morning).toMatchObject({ decisions: [{ tier: 'SPEAK', reason: 'time_sensitive' }], bolbaDue: 3, coverageRecorded: true });
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({
      action: BOSS_MORNING_REPORT_ACTION,
      text: expect.stringContaining('板上待办：今天要盯 3 件'),
    }));

    // 覆盖账已原子落盘（13 与晨报共用同一日键）
    expect(JSON.parse(fs.readFileSync(coverageFile, 'utf-8'))).toEqual({ day: DAY_KEY, bolbaTaskIds: ['2', '1', '3'] });

    // 13：全部到期任务已覆盖 → 跳过独播
    const reminder = await runBolbaDueReminderScan(reminderDeps());
    expect(reminder).toMatchObject({ due: 3, decisions: [], coveredByMorningReport: true, degraded: false });
    expect(broadcastMock).toHaveBeenCalledTimes(1); // 只有晨报那一次
    expect(broadcastMock.mock.calls.some((call) => call[0].action === BOLBA_DUE_REMINDER_ACTION)).toBe(false);
  });

  it('② 13 先跑：独播落库 → 晨报读当日 broadcast 日志命中 → 不并入（只播一次）', async () => {
    // 13 先独自播报（logProactiveBroadcast 是探针，不真落库——用 mock 日志模拟其 broadcast 行）
    const reminder = await runBolbaDueReminderScan(reminderDeps());
    expect(reminder.decisions).toEqual([{ tier: 'SPEAK', reason: 'urgent' }]);
    querySystemLogMock.mockReturnValue([broadcastEntry(NOW8.getTime(), BOLBA_DUE_REMINDER_ACTION)]);

    // 晨报走缺省判据（hasBolbaDueBroadcastToday → querySystemLog）
    const morning = await runBossMorningReportScan(morningDeps());
    expect(morning).toMatchObject({ yesterday: 1, bolbaDue: 0, coverageRecorded: false });
    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(broadcastMock.mock.calls.map((call) => call[0].action))
      .toEqual([BOLBA_DUE_REMINDER_ACTION, BOSS_MORNING_REPORT_ACTION]);
    const morningText = broadcastMock.mock.calls[1][0].text as string;
    expect(morningText).not.toContain('板上待办');
    expect(morningText).toContain('昨日要点'); // 晨报自己的内容照常播
    expect(coverageStore.coveredIds(DAY_KEY).size).toBe(0); // 没并入就不写账
  });

  it('③ 晨报没真的播出（STORE 预算用尽）→ 不写账 → 13 照常独播（不静默丢话）', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    queue.restoreState({ ...queue.snapshotState(), spokenToday: 10 });
    const morning = await runBossMorningReportScan(morningDeps({
      queue,
      hasBolbaBroadcastToday: () => false,
    }));

    expect(morning).toMatchObject({ decisions: [{ tier: 'STORE', reason: 'budget_exhausted' }], coverageRecorded: false });
    expect(coverageStore.coveredIds(DAY_KEY).size).toBe(0);

    const reminder = await runBolbaDueReminderScan(reminderDeps());
    expect(reminder.decisions).toEqual([{ tier: 'SPEAK', reason: 'urgent' }]);
    expect(broadcastMock.mock.calls.some((call) => call[0].action === BOLBA_DUE_REMINDER_ACTION)).toBe(true);
  });
});
