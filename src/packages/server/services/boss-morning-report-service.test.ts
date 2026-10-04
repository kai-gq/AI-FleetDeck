/**
 * 任务12·⑨ boss-morning-report-service 单测
 *
 * 覆盖：信号构造（昨窗边界/多项目分段/failed 口径/产出从句/dedupeKey/评分时效）、
 * 跨日重置纯函数、扫描主流程四档（SPEAK / 深夜 PREPARE / STORE 预算用尽 / SILENT
 * 重复）与跨日预算回滚、speak 降级 notice、关闭开关、读盘与投递异常降级、
 * cron 注册点幂等与可停。
 *
 * 依赖 mock：voice-companion-service（logProactiveBroadcast 探针）、
 * data/system-log（logEvent 探针，断言 boss-morning-report 行）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalQueue } from '../jarvis-core/index.js';
import {
  buildMorningReportSignal,
  createMorningReportPorts,
  isMorningReportEnabled,
  resetBossMorningReportStateForTests,
  rolloverGatesStateForNewDay,
  runBossMorningReportScan,
} from './boss-morning-report-service.js';
import type { DelegationDecision } from '../../shared/types.js';
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
/** 本地日历日边界。 */
const YDAY0 = new Date(2026, 9, 4).getTime();
const TODAY0 = new Date(2026, 9, 5).getTime();

interface RecordOpts {
  at: number;
  id?: string;
  result?: 'completed' | 'failed';
  agent?: string;
  /** 纯文本委托（无任务卡）时的原始指令。 */
  command?: string;
  /** 任务卡目标（给则落卡）。 */
  objective?: string;
  projectId?: string;
  outputLocation?: string;
  summary?: string;
  /** 任务17·A2：任务卡截止日（date-only 'YYYY-MM-DD'；给则落卡）。 */
  due?: string;
  /** 任务17·A2：任务卡状态（缺省 done——旧记录形态，天然不进「今日待办」）。 */
  cardStatus?: 'pending' | 'queued' | 'running' | 'done';
  /** 任务17·A2：在办卡无 completion（真实在办形态；决策 status 随之落 'sent'）。 */
  noCompletion?: boolean;
}

function record(opts: RecordOpts): DelegationDecision {
  const { at, ...rest } = opts;
  return {
    id: rest.id ?? `d-${at}`,
    timestamp: at - 60_000,
    bossId: 'boss-1',
    userCommand: rest.command ?? '一句话委托',
    selectedAgentId: 'agent-1',
    selectedAgentName: rest.agent ?? '甲',
    reasoning: 'test',
    alternativeAgents: [],
    confidence: 'high',
    status: rest.noCompletion ? 'sent' : rest.result === 'failed' ? 'failed' : 'completed',
    ...(rest.objective || rest.projectId || rest.due
      ? {
          taskCard: {
            objective: rest.objective ?? '',
            acceptanceCriteria: [],
            dependencies: [],
            status: rest.cardStatus ?? ('done' as const),
            ...(rest.projectId ? { projectId: rest.projectId } : {}),
            ...(rest.due ? { due: rest.due } : {}),
          },
        }
      : {}),
    ...(rest.noCompletion
      ? {}
      : {
          completion: {
            completedAt: at,
            durationMs: 60_000,
            result: rest.result ?? 'completed',
            ...(rest.summary ? { summary: rest.summary } : {}),
            ...(rest.outputLocation ? { outputLocation: rest.outputLocation } : {}),
          },
        }),
  };
}

/** 取出 boss-morning-report 埋点行（body 形态）。 */
function reportLogs(): Record<string, unknown>[] {
  return logEventMock.mock.calls
    .map((call) => call[1] as { body?: Record<string, unknown> } | undefined)
    .map((fields) => fields?.body)
    .filter((body): body is Record<string, unknown> => !!body && body.cat === 'boss-morning-report');
}

function history(...records: DelegationDecision[]): Map<string, DelegationDecision[]> {
  return new Map([['boss-1', records]]);
}

function seededQueue(now: Date, spokenToday: number): SignalQueue {
  const queue = new SignalQueue({ now: now.getTime() });
  queue.restoreState({ ...queue.snapshotState(), spokenToday });
  return queue;
}

beforeEach(() => {
  broadcastMock.mockClear();
  logEventMock.mockClear();
  resetBossMorningReportStateForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cronService.stopBossMorningReportJob();
});

// ============================================================================
// 信号构造
// ============================================================================

describe('buildMorningReportSignal', () => {
  it('昨日无可报项 → null（不空发信号）', () => {
    expect(buildMorningReportSignal([], NOW8)).toBeNull();
    // 前天 23:59:59.999：早于昨窗
    expect(buildMorningReportSignal([record({ at: new Date(2026, 9, 3, 23, 59, 59, 999).getTime() })], NOW8)).toBeNull();
    // 无 completion 的旧记录（任务11 前历史）按「无完成事件」处理
    const legacy = { ...record({ at: YDAY0 }), completion: undefined };
    expect(buildMorningReportSignal([legacy], NOW8)).toBeNull();
  });

  it('昨窗边界：昨 00:00 含、昨 23:59:59.999 含、前天 23:59:59.999 不含、今 00:00 不含、今天 08:00 不含', () => {
    const yday = buildMorningReportSignal(
      [
        record({ id: 'a', at: YDAY0 }),
        record({ id: 'b', at: YDAY0 + 86_400_000 - 1 }),
        record({ id: 'c', at: YDAY0 - 1 }),
        record({ id: 'd', at: TODAY0 }),
        record({ id: 'e', at: NOW8.getTime() }),
      ],
      NOW8,
    );
    expect((yday?.payload as { count: number }).count).toBe(2);
    expect(yday?.dedupeKey).toBe('morning-report:2026-10-05');
  });

  it('多项目分段 + 形态：项目A/项目B/未归项目、执行者/目标/产出在/摘要', () => {
    const signal = buildMorningReportSignal(
      [
        record({ at: new Date(2026, 9, 4, 12, 0).getTime(), agent: '丁', objective: '巡检', id: 'd4' }),
        record({ at: new Date(2026, 9, 4, 9, 0).getTime(), agent: '甲', objective: 'Y', projectId: 'A', outputLocation: 'src/auth', id: 'd1' }),
        record({ at: new Date(2026, 9, 4, 11, 0).getTime(), agent: '丙', objective: '报价单', projectId: 'B', summary: '已发出', id: 'd3' }),
        record({ at: new Date(2026, 9, 4, 10, 0).getTime(), agent: '乙', command: '写周报', projectId: 'A', id: 'd2' }),
      ],
      NOW8,
    );

    expect(signal).toMatchObject({
      source: 'memory',
      kind: 'boss_morning_report',
      ts: NOW8.getTime(),
      dedupeKey: 'morning-report:2026-10-05',
      urgency: 65,
      relevance: 85,
      certainty: 95,
      timeSensitive: true,
    });
    expect(signal?.text).toBe(
      '昨日要点：项目A：甲 完成「Y」（产出在 src/auth），乙 完成「写周报」；项目B：丙 完成「报价单」（已发出）；未归项目：丁 完成「巡检」。',
    );
    expect(signal?.payload).toMatchObject({ count: 4, segments: 3, completed: 4, failed: 0, projects: ['A', 'B', null] });
  });

  it('failed 如实说「未完成」；无产出位置且无摘要 → 省去产出从句（不硬造）', () => {
    const signal = buildMorningReportSignal(
      [
        record({ at: YDAY0 + 1000, agent: '甲', objective: 'X', id: 'f1', result: 'failed' }),
        record({ at: YDAY0 + 2000, agent: '乙', objective: 'W', id: 'f2' }),
      ],
      NOW8,
    );
    expect(signal?.text).toContain('甲 未完成「X」');
    expect(signal?.text).toContain('乙 完成「W」');
    expect(signal?.text).not.toContain('产出在');
    expect(signal?.payload).toMatchObject({ completed: 1, failed: 1 });
  });

  it('objective 缺省回退 userCommand；再缺省才用「未记录内容」占位', () => {
    const signal = buildMorningReportSignal(
      [
        record({ at: YDAY0 + 1000, agent: '甲', command: '修复登录', id: 'c1' }),
        record({ at: YDAY0 + 2000, agent: '乙', command: '', id: 'c2' }),
      ],
      NOW8,
    );
    expect(signal?.text).toContain('甲 完成「修复登录」');
    expect(signal?.text).toContain('乙 完成「未记录内容」');
  });

  it('dedupeKey 按扫描日日戳（跨日切换）', () => {
    const day1 = buildMorningReportSignal([record({ at: YDAY0 })], NOW8);
    const day2 = buildMorningReportSignal([record({ at: new Date(2026, 9, 5, 12, 0).getTime() })], NEXT_DAY8);
    expect(day1?.dedupeKey).toBe('morning-report:2026-10-05');
    expect(day2?.dedupeKey).toBe('morning-report:2026-10-06');
  });
});

// ============================================================================
// 跨日重置
// ============================================================================

describe('rolloverGatesStateForNewDay', () => {
  it('同一天：原样返回（同一引用）', () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const state = queue.snapshotState();
    expect(rolloverGatesStateForNewDay(state, NOW8)).toBe(state);
  });

  it('跨日：预算计数与统计归零，seenKeys/env/config 保留', () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    queue.restoreState({
      ...queue.snapshotState(),
      spokenToday: 3,
      instantSpeakToday: 2,
      seenKeys: ['morning-report:2026-10-05'],
      stats: { broadcasts: 4, ignored: 1, adopted: 2 },
    });
    const rolled = rolloverGatesStateForNewDay(queue.snapshotState(), NEXT_DAY8);
    expect(rolled.spokenToday).toBe(0);
    expect(rolled.instantSpeakToday).toBe(0);
    expect(rolled.stats).toEqual({ broadcasts: 0, ignored: 0, adopted: 0 });
    expect(rolled.seenKeys).toEqual(['morning-report:2026-10-05']);
    expect(rolled.config).toEqual(queue.snapshotState().config);
    expect(rolled.now).toBe(NEXT_DAY8.getTime());
  });
});

// ============================================================================
// 扫描主流程（四档 / 开关 / 兜底）
// ============================================================================

describe('runBossMorningReportScan — 闸门四档与投递', () => {
  it('08:00 昨日有产出 → SPEAK/time_sensitive：走 vcs 主动播报出口 + 生成/投递埋点', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(
        record({ at: new Date(2026, 9, 4, 9, 0).getTime(), agent: '甲', objective: 'Y', projectId: 'A', outputLocation: 'src/auth', id: 'd1' }),
        record({ at: new Date(2026, 9, 4, 10, 0).getTime(), agent: '乙', objective: 'W', projectId: 'B', id: 'd2' }),
      ),
      now: () => NOW8,
      queue,
    });

    expect(r).toMatchObject({ bosses: 1, scanned: 2, yesterday: 2, segments: 2, degraded: false });
    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'time_sensitive' }]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'boss_morning_report',
      text: expect.stringContaining('昨日要点：项目A：甲 完成「Y」（产出在 src/auth）'),
    }));

    const rows = reportLogs();
    expect(rows.some((row) => row.op === 'scan' && row.ok === true && row.count === 2)).toBe(true);
    expect(rows.some((row) => row.op === 'generate' && row.ok === true && row.yesterday === 2 && row.segments === 2 && row.dedupeKey === 'morning-report:2026-10-05')).toBe(true);
    expect(rows.some((row) => row.op === 'deliver' && row.tier === 'SPEAK' && row.reason === 'time_sensitive' && row.ok === true)).toBe(true);
    expect(logEventMock.mock.calls.every((call) => call[0] === 'system')).toBe(true);
  });

  it('同日二次扫描 → SILENT duplicate（幂等不重播）', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const deps = {
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
    };
    const first = await runBossMorningReportScan(deps);
    const second = await runBossMorningReportScan(deps);

    expect(first.decisions).toEqual([{ tier: 'SPEAK', reason: 'time_sensitive' }]);
    expect(second.decisions).toEqual([{ tier: 'SILENT', reason: 'duplicate' }]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('03:00 深夜 → PREPARE deep_night：不播、留攒批缓冲（timeSensitive 不豁免②③）', async () => {
    const queue = new SignalQueue({ now: NOW3.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW3,
      queue,
    });

    expect(r.decisions).toEqual([{ tier: 'PREPARE', reason: 'deep_night' }]);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(queue.preparedCount).toBe(1);
    expect(reportLogs().some((row) => row.op === 'deliver' && row.tier === 'PREPARE')).toBe(true);
  });

  it('预算用尽同一天 → STORE：只登记 system_log，不写 broadcast 假装上屏', async () => {
    const queue = seededQueue(NOW8, 10);
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
    });

    expect(r.decisions).toEqual([{ tier: 'STORE', reason: 'budget_exhausted' }]);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(reportLogs().some((row) => row.op === 'deliver' && row.tier === 'STORE')).toBe(true);
  });

  it('跨日扫描 → 预算计数回滚后照常 SPEAK（接线层 rollover 生效）', async () => {
    const queue = seededQueue(NOW8, 10); // 昨日预算用尽
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: new Date(2026, 9, 5, 12, 0).getTime(), agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NEXT_DAY8,
      queue,
    });

    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'time_sensitive' }]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('speak 出口抛错 → 降级 notice 同通道 + degraded 标记', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
      ports: {
        ...createMorningReportPorts(),
        speak: () => { throw new Error('voice channel down'); },
      },
    });

    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'time_sensitive' }]);
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({ degraded: true, action: 'boss_morning_report' }));
    expect(reportLogs().some((row) => row.op === 'deliver' && row.ok === false && String(row.error).startsWith('degraded:'))).toBe(true);
  });

  it('投递注入：deliver 收到可观察的 ConsumedSignal（tier/预算预扣）', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const deliver = vi.fn();
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
      deliver,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({
      decision: { tier: 'SPEAK', reason: 'time_sensitive' },
      budgetCharged: true,
    });
    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'time_sensitive' }]);
  });
});

describe('runBossMorningReportScan — 开关、空板与兜底', () => {
  it('关闭开关 TC_JARVIS_MORNING_REPORT=0 → 不读盘不投递、disabled=true、scan 记 disabled', async () => {
    vi.stubEnv('TC_JARVIS_MORNING_REPORT', '0');
    const loadHistory = vi.fn(() => history(record({ at: YDAY0 + 1000 })));
    const r = await runBossMorningReportScan({ loadHistory, now: () => NOW8 });

    expect(r).toMatchObject({ decisions: [], degraded: false, disabled: true });
    expect(loadHistory).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(reportLogs().some((row) => row.op === 'scan' && row.reason === 'disabled')).toBe(true);
  });

  it('开关解析：缺省开；0/off/false（含大小写空白）关', () => {
    expect(isMorningReportEnabled({})).toBe(true);
    expect(isMorningReportEnabled({ TC_JARVIS_MORNING_REPORT: undefined })).toBe(true);
    expect(isMorningReportEnabled({ TC_JARVIS_MORNING_REPORT: '' })).toBe(true);
    expect(isMorningReportEnabled({ TC_JARVIS_MORNING_REPORT: '1' })).toBe(true);
    expect(isMorningReportEnabled({ TC_JARVIS_MORNING_REPORT: '0' })).toBe(false);
    expect(isMorningReportEnabled({ TC_JARVIS_MORNING_REPORT: ' off ' })).toBe(false);
    expect(isMorningReportEnabled({ TC_JARVIS_MORNING_REPORT: 'FALSE' })).toBe(false);
  });

  it('没有昨日产出 → 不发信号、不播报，scan 记 no-yesterday', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: TODAY0 })),
      now: () => NOW8,
      queue,
    });

    expect(r).toMatchObject({ bosses: 1, scanned: 1, yesterday: 0, decisions: [], degraded: false });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(reportLogs().some((row) => row.op === 'scan' && row.reason === 'no-yesterday')).toBe(true);
  });

  it('读盘抛错 → 不抛、degraded=true、scan warn 落盘', async () => {
    const r = await runBossMorningReportScan({
      loadHistory: () => { throw new Error('EACCES'); },
      now: () => NOW8,
    });

    expect(r).toMatchObject({ scanned: 0, yesterday: 0, decisions: [], degraded: true });
    expect(broadcastMock).not.toHaveBeenCalled();
    const row = reportLogs().find((r2) => r2.op === 'scan');
    expect(row).toMatchObject({ ok: false, error: 'EACCES' });
  });

  it('投递段抛错 → 不抛、degraded=true、已完成的决策如实带回', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const deliver = vi.fn(() => { throw new Error('deliver down'); });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
      deliver,
    });

    expect(r).toMatchObject({ scanned: 1, yesterday: 1, degraded: true, decisions: [] });
    expect(reportLogs().some((row) => row.op === 'deliver' && row.ok === false && row.error === 'deliver down')).toBe(true);
  });
});

// ============================================================================
// cron 注册点
// ============================================================================

describe('startBossMorningReportJob', () => {
  it('模块加载自启；重复调用幂等（同一句柄）；表达式/时区/interval 就位', () => {
    const first = cronService.startBossMorningReportJob();
    const second = cronService.startBossMorningReportJob();
    expect(first).toBe(second);
    expect(first.expression).toBe(cronService.BOSS_MORNING_REPORT_CRON);
    expect(first.expression).toBe('0 8 * * *');
    expect(first.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(first.timer).not.toBeNull();
  });

  it('stopBossMorningReportJob 可停且清空注册点，再次启动拿到新句柄', () => {
    const first = cronService.startBossMorningReportJob();
    cronService.stopBossMorningReportJob();
    expect(first.timer).toBeNull();
    const second = cronService.startBossMorningReportJob();
    expect(second).not.toBe(first);
    expect(second.timer).not.toBeNull();
  });

  it('注册点与真实扫描模块可拼接（callback 存在且为函数）；13 的到期提醒注册点不受影响', () => {
    const job = cronService.startBossMorningReportJob();
    expect(typeof job.callback).toBe('function');
    expect(cronService.BOLBA_DUE_SCAN_CRON).toBe('0 8 * * *');
  });
});

// ============================================================================
// 任务19·A·⑮ P2：日报进晨报聚合（只读数据源）
// ============================================================================

const DIGEST = {
  file: '/data/reports/daily/daily-log-report-2026-10-04.json',
  dateLabel: '2026-10-04',
  generatedAt: YDAY0 + 7 * 3600_000,
  summary: '昨日日志 120 条（error 3 / warn 9）；异常 2 项，瓶颈 1 项，建议 3 项',
};

describe('buildMorningReportSignal — 日报聚合从句（任务19·A）', () => {
  it('有日报：昨日要点后追加「日志分析」从句 + payload.dailyReport 元数据；无日报时文本逐字不变', () => {
    const base = record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' });
    const withDigest = buildMorningReportSignal([base], NOW8, DIGEST);
    expect(withDigest?.text).toBe(
      `昨日要点：未归项目：甲 完成「Y」。日志分析：${DIGEST.summary}。`,
    );
    expect(withDigest?.payload).toMatchObject({
      count: 1,
      dailyReport: { file: DIGEST.file, dateLabel: '2026-10-04', generatedAt: DIGEST.generatedAt },
    });

    const withoutDigest = buildMorningReportSignal([base], NOW8);
    expect(withoutDigest?.text).toBe('昨日要点：未归项目：甲 完成「Y」。');
    expect((withoutDigest?.payload as { dailyReport?: unknown }).dailyReport).toBeUndefined();
  });

  it('昨日无产出但日报在 → 仍成信号（日报即当日要点）；摘要为空视同无日报 → null', () => {
    const only = buildMorningReportSignal([], NOW8, DIGEST);
    expect(only).not.toBeNull();
    expect(only?.text).toBe(`日志分析：${DIGEST.summary}。`);
    expect(only?.payload).toMatchObject({ count: 0, segments: 0 });

    expect(buildMorningReportSignal([], NOW8, { ...DIGEST, summary: '   ' })).toBeNull();
    expect(buildMorningReportSignal([], NOW8, null)).toBeNull();
  });
});

describe('runBossMorningReportScan — 日报只读聚合（任务19·A）', () => {
  it('日报进信号：text 含从句、generate 埋点带 dailyReport=true、结果旗标回传', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
      readDailyReport: () => DIGEST,
    });

    expect(r).toMatchObject({ degraded: false, dailyReportIncluded: true });
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('日志分析：昨日日志 120 条'),
    }));
    expect(reportLogs().some((row) => row.op === 'generate' && row.dailyReport === true)).toBe(true);
  });

  it('日报缺失（缺省读取；沙箱无 reports 目录）→ 静默跳过、dailyReportIncluded=false、晨报照常', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
    });

    expect(r).toMatchObject({ degraded: false, dailyReportIncluded: false });
    expect(reportLogs().some((row) => row.op === 'generate' && row.dailyReport === false)).toBe(true);
  });

  it('日报读取抛错 → 静默跳过（不打断晨报、不降级），正常投递', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'd1' })),
      now: () => NOW8,
      queue,
      readDailyReport: () => { throw new Error('EACCES'); },
    });

    expect(r).toMatchObject({ degraded: false, dailyReportIncluded: false });
    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'time_sensitive' }]);
  });

  it('昨日无产出但日报在 → 不发空信号，聚合日报播报', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(),
      now: () => NOW8,
      queue,
      readDailyReport: () => DIGEST,
    });

    expect(r).toMatchObject({ yesterday: 0, dailyReportIncluded: true, degraded: false });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('日志分析：') }));
  });
});

// ============================================================================
// 任务17·A2：任务卡 due → 晨报「今日待办」句
// ============================================================================

describe('buildMorningReportSignal — 今日待办（任务17·A2）', () => {
  it('无 due 卡 → 不输出「今日待办」句；payload dueCount=0（负断言）', () => {
    const signal = buildMorningReportSignal(
      [
        record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'n1', cardStatus: 'running', noCompletion: true }),
        record({ at: YDAY0 + 2000, agent: '乙', objective: 'Z', id: 'n2' }), // done 卡（历史完成）
      ],
      NOW8,
    );
    expect(signal?.text).not.toContain('今日待办');
    expect(signal?.payload).toMatchObject({ dueCount: 0, dueProjects: [] });
  });

  it('在办 + due ≤ 今日 → 按 projectId 分段成句（逾期/今日到期如实标注，按 due 升序）；done/明日/无 due/非法形状排除', () => {
    const signal = buildMorningReportSignal(
      [
        // 同日不同 due：10-01（逾期）应排在 10-05（今日）前
        record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', projectId: 'A', due: '2026-10-05', cardStatus: 'running', noCompletion: true, id: 'u1' }),
        record({ at: YDAY0 + 2000, agent: '乙', objective: 'Z', projectId: 'A', due: '2026-10-01', cardStatus: 'queued', noCompletion: true, id: 'u2' }),
        record({ at: YDAY0 + 3000, agent: '丙', objective: 'W', due: '2026-10-04', cardStatus: 'pending', noCompletion: true, id: 'u3' }),
        record({ at: YDAY0 + 4000, agent: '丁', objective: '已完成卡', due: '2026-10-05', cardStatus: 'done', noCompletion: true, id: 'u4' }),
        record({ at: YDAY0 + 5000, agent: '戊', objective: '明日卡', due: '2026-10-06', cardStatus: 'running', noCompletion: true, id: 'u5' }),
        record({ at: YDAY0 + 6000, agent: '己', objective: '无due卡', projectId: 'B', cardStatus: 'running', noCompletion: true, id: 'u6' }),
        record({ at: YDAY0 + 7000, agent: '庚', objective: '坏形状due', due: '2026-10-5', cardStatus: 'running', noCompletion: true, id: 'u7' }),
      ],
      NOW8,
    );

    // 无昨日产出/日报，仅到期卡也成信号
    expect(signal).not.toBeNull();
    expect(signal?.text).toBe(
      '今日待办：项目A：乙 在办「Z」（已逾期 2026-10-01），甲 在办「Y」（今日到期）；未归项目：丙 在办「W」（已逾期 2026-10-04）。',
    );
    expect(signal?.payload).toMatchObject({ count: 0, dueCount: 3, dueProjects: ['A', null] });
    // 被排除者一律不出现在文本里（负断言）
    expect(signal?.text).not.toContain('已完成卡');
    expect(signal?.text).not.toContain('明日卡');
    expect(signal?.text).not.toContain('无due卡');
    expect(signal?.text).not.toContain('坏形状due');
  });

  it('跨日边界：due=今日含、due=明日不含；跨到次日 → 今日到期变已逾期、明日卡转在办', () => {
    const todayDue = record({ at: YDAY0 + 1000, agent: '甲', objective: '今日卡', due: '2026-10-05', cardStatus: 'running', noCompletion: true, id: 'b1' });
    const tomorrowDue = record({ at: YDAY0 + 2000, agent: '乙', objective: '明日卡', due: '2026-10-06', cardStatus: 'running', noCompletion: true, id: 'b2' });

    const day1 = buildMorningReportSignal([todayDue, tomorrowDue], NOW8);
    expect(day1?.text).toContain('甲 在办「今日卡」（今日到期）');
    expect(day1?.text).not.toContain('明日卡');
    expect(day1?.payload).toMatchObject({ dueCount: 1 });

    const day2 = buildMorningReportSignal([todayDue, tomorrowDue], NEXT_DAY8);
    expect(day2?.text).toContain('甲 在办「今日卡」（已逾期 2026-10-05）');
    expect(day2?.text).toContain('乙 在办「明日卡」（今日到期）');
    expect(day2?.payload).toMatchObject({ dueCount: 2 });
  });

  it('cancelled 卡排除（状态白名单口径，而非黑名单）', () => {
    const cancelled = record({ at: YDAY0 + 1000, agent: '甲', objective: '已取消卡', due: '2026-10-05', cardStatus: 'running', noCompletion: true, id: 'c1' });
    // 运行期改写为 cancelled（TaskCardStatus 的 cancelled 协同由任务16 扩展；白名单口径天然排除）
    (cancelled.taskCard as { status: string }).status = 'cancelled';
    const alive = record({ at: YDAY0 + 2000, agent: '乙', objective: '在办卡', due: '2026-10-05', cardStatus: 'running', noCompletion: true, id: 'c2' });

    const signal = buildMorningReportSignal([cancelled, alive], NOW8);
    expect(signal?.text).toContain('乙 在办「在办卡」（今日到期）');
    expect(signal?.text).not.toContain('已取消卡');
    expect(signal?.payload).toMatchObject({ dueCount: 1 });
  });

  it('due 从句与昨日要点/日报并列：顺序为 昨日要点 → 今日待办 → 日志分析', () => {
    const signal = buildMorningReportSignal(
      [
        record({ at: YDAY0 + 1000, agent: '甲', objective: 'Y', id: 'p1' }),
        record({ at: YDAY0 + 2000, agent: '乙', objective: 'Z', due: '2026-10-05', cardStatus: 'running', noCompletion: true, id: 'p2' }),
      ],
      NOW8,
      DIGEST,
    );
    expect(signal?.text).toBe(
      `昨日要点：未归项目：甲 完成「Y」。今日待办：未归项目：乙 在办「Z」（今日到期）。日志分析：${DIGEST.summary}。`,
    );
  });

  it('due-only 信号可投递：扫描 → SPEAK，播报文本含「今日待办」', async () => {
    const queue = new SignalQueue({ now: NOW8.getTime() });
    const r = await runBossMorningReportScan({
      loadHistory: () => history(
        record({ at: YDAY0 + 1000, agent: '甲', objective: '到期任务', due: '2026-10-05', cardStatus: 'running', noCompletion: true, id: 'd1' }),
      ),
      now: () => NOW8,
      queue,
    });

    expect(r).toMatchObject({ yesterday: 0, degraded: false });
    expect(r.decisions).toEqual([{ tier: 'SPEAK', reason: 'time_sensitive' }]);
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'boss_morning_report',
      text: '今日待办：未归项目：甲 在办「到期任务」（今日到期）。',
    }));
  });
});
