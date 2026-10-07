/**
 * jarvis-core · 感知层六源单测（任务 30 ⑥ 验收；第 6 路 user-behavior 补齐后）
 *
 * 覆盖：各源 mock 注入（正常路径/首次基线/畸形数据/端口抛错/端口未接）、
 * 每源独立开关（配置入参 + TC_JARVIS_SENSE_* 环境变量，关 = 不采集不产出不报错）、
 * 归一化形状断言。证据等级 L1（mock 注入；真链路未跑，见任务报告「未覆盖」）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JarvisLogger } from '../executors.js';
import { createAgentStateSense, type AgentStatePort } from './agent-state.js';
import { createSystemHealthSense, type SystemHealthProbe, type SystemHealthPort } from './system-health.js';
import { createProjectEventsSense, type ProjectEventInput, type ProjectEventsPort } from './project-events.js';
import { createTimeContextSense, periodOfMinutes, readTimeContext, type TimeContextPort } from './time-context.js';
import { createMemorySignalsSense, type MemorySignalInput, type MemorySignalsPort } from './memory-signals.js';
import { createUserBehaviorSense, type UserBehaviorPort } from './user-behavior.js';
import { SENSE_ENV_KEYS, SENSE_NAMES, isSenseEnabled, type Sense } from './types.js';

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/** 本地 2026-01-15（周四）10:00。 */
const THU_10AM = new Date(2026, 0, 15, 10, 0, 0).getTime();
/** 本地 2026-01-17（周六）10:00。 */
const SAT_10AM = new Date(2026, 0, 17, 10, 0, 0).getTime();

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 断言基础信号形状（归一化前后都该满足的字段；ts 在 RawSignal 里可选）。 */
function expectSignalShape(
  signal: { source: string; kind: string; ts?: number; dedupeKey?: string },
  source: string,
  kind: string,
  ts: number,
): void {
  expect(signal.source).toBe(source);
  expect(signal.kind).toBe(kind);
  expect(signal.ts).toBe(ts);
  expect(typeof signal.dedupeKey).toBe('string');
  expect(signal.dedupeKey!.length).toBeGreaterThan(0);
}

// ============================================================================
// 源 0：公共开关
// ============================================================================

describe('感知层公共开关（types）', () => {
  it('六源规范清单；环境变量缺省开、0/off/false 关', () => {
    expect(SENSE_NAMES).toEqual([
      'agent-state',
      'system-health',
      'project-events',
      'time-context',
      'memory-signals',
      'user-behavior',
    ]);
    for (const name of SENSE_NAMES) {
      const key = SENSE_ENV_KEYS[name];
      expect(key.startsWith('TC_JARVIS_SENSE_')).toBe(true);
      expect(isSenseEnabled(name, { [key]: undefined })).toBe(true);
      expect(isSenseEnabled(name, { [key]: '' })).toBe(true);
      expect(isSenseEnabled(name, { [key]: '1' })).toBe(true);
      expect(isSenseEnabled(name, { [key]: '0' })).toBe(false);
      expect(isSenseEnabled(name, { [key]: ' off ' })).toBe(false);
      expect(isSenseEnabled(name, { [key]: 'FALSE' })).toBe(false);
    }
  });
});

// ============================================================================
// 源 1：Agent 状态（快照 diff）
// ============================================================================

describe('信号源 agent-state（快照 diff）', () => {
  function queuedPort(snapshots: unknown[]): { port: AgentStatePort; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      port: {
        snapshot: () => {
          const next = snapshots[Math.min(calls, snapshots.length - 1)];
          calls++;
          return next as never;
        },
      },
    };
  }

  it('首次采集只建基线；working→idle 报完成（形状/评分/键齐备）', async () => {
    const { port, calls } = queuedPort([
      { a1: { name: '小美', status: 'working', taskLabel: '登录页' } },
      { a1: { name: '小美', status: 'idle', taskLabel: '登录页' } },
    ]);
    const sense = createAgentStateSense({ port, logger: silentLogger });
    expect(await sense.collect(THU_10AM)).toEqual({ signals: [] });
    const reading = await sense.collect(THU_10AM + 1_000);
    expect(calls()).toBe(2);
    expect(reading.signals).toHaveLength(1);
    expectSignalShape(reading.signals[0]!, 'agent', 'agent_completed', THU_10AM + 1_000);
    expect(reading.signals[0]!.text).toBe('小美 完成任务:登录页');
    expect(reading.signals[0]!.dedupeKey).toBe(`agent-completed:a1@${THU_10AM + 1_000}`);
    expect(reading.signals[0]!.urgency).toBe(60);
    expect(reading.signals[0]!.relevance).toBe(70);
    expect(reading.signals[0]!.certainty).toBe(95);
    expect(reading.degraded).toBeUndefined();
  });

  it('待岗(standby)停机不算完成：用户主动下线，不报 agent_completed', async () => {
    const { port } = queuedPort([
      { a1: { name: '小美', status: 'working', taskLabel: '登录页' } },
      { a1: { name: '小美', status: 'idle', taskLabel: '登录页', standby: true } },
    ]);
    const sense = createAgentStateSense({ port, logger: silentLogger });
    await sense.collect(THU_10AM);
    const reading = await sense.collect(THU_10AM + 1_000);
    expect(reading.signals).toHaveLength(0);
  });

  it('→error / lastError 更新报错；→waiting_permission 报等待授权且 timeSensitive', async () => {
    const { port } = queuedPort([
      { a1: { name: '阿强', status: 'working' }, a2: { name: '小美', status: 'working' } },
      { a1: { name: '阿强', status: 'error', lastError: '构建失败' }, a2: { name: '小美', status: 'waiting_permission', taskLabel: '部署' } },
    ]);
    const sense = createAgentStateSense({ port, logger: silentLogger });
    await sense.collect(THU_10AM);
    const reading = await sense.collect(THU_10AM + 1);
    const kinds = reading.signals.map((s) => s.kind).sort();
    expect(kinds).toEqual(['agent_failed', 'agent_waiting']);
    const failed = reading.signals.find((s) => s.kind === 'agent_failed')!;
    expect(failed.text).toBe('阿强 出错:构建失败');
    expect(failed.urgency).toBe(90);
    const waiting = reading.signals.find((s) => s.kind === 'agent_waiting')!;
    expect(waiting.text).toBe('小美 等待授权(部署)');
    expect(waiting.timeSensitive).toBe(true);
  });

  it('状态未变但错误串更新也算报错；新出现的 agent 不报', async () => {
    const { port } = queuedPort([
      { a1: { name: '阿强', status: 'idle' } },
      { a1: { name: '阿强', status: 'idle', lastError: '连接超时' }, a9: { name: '新来的', status: 'error' } },
    ]);
    const sense = createAgentStateSense({ port, logger: silentLogger });
    await sense.collect(THU_10AM);
    const reading = await sense.collect(THU_10AM + 2);
    expect(reading.signals).toHaveLength(1);
    expect(reading.signals[0]!.kind).toBe('agent_failed');
    expect(reading.signals[0]!.text).toBe('阿强 出错:连接超时');
  });

  it("scope='all' 才报换任务；默认 important 不报", async () => {
    const snapshots = [
      { a1: { name: '小美', status: 'working', taskLabel: 'A' } },
      { a1: { name: '小美', status: 'working', taskLabel: 'B' } },
    ];
    const all = createAgentStateSense({ port: queuedPort(snapshots).port, scope: 'all', logger: silentLogger });
    await all.collect(THU_10AM);
    const allReading = await all.collect(THU_10AM + 1);
    expect(allReading.signals.map((s) => s.kind)).toEqual(['agent_task-changed']);
    expect(allReading.signals[0]!.text).toBe('小美 换任务:B');

    const important = createAgentStateSense({ port: queuedPort(snapshots).port, logger: silentLogger });
    await important.collect(THU_10AM);
    expect((await important.collect(THU_10AM + 1)).signals).toEqual([]);
  });

  it('单条目畸形安全丢弃 + 该源记因；整体形态非法 → 安全缺省', async () => {
    const { port } = queuedPort([
      { a1: { name: '小美', status: 'working' }, bad: 42, bad2: { name: '缺状态' } },
      { a1: { name: '小美', status: 'idle' } },
    ]);
    const sense = createAgentStateSense({ port, logger: silentLogger });
    const first = await sense.collect(THU_10AM);
    expect(first.signals).toEqual([]);
    expect(first.degraded).toMatchObject({ reason: 'malformed_data' });
    expect(first.degraded!.detail).toContain('2');

    const badSense = createAgentStateSense({ port: { snapshot: () => [] as never }, logger: silentLogger });
    const bad = await badSense.collect(THU_10AM);
    expect(bad.signals).toEqual([]);
    expect(bad.degraded).toMatchObject({ reason: 'malformed_data' });
  });

  it('端口抛错 → port_error；端口未接 → port_not_wired（均不抛出）', async () => {
    const boom = createAgentStateSense({ port: { snapshot: () => Promise.reject(new Error('boom')) }, logger: silentLogger });
    expect(await boom.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_error' } });

    const unwired = createAgentStateSense({ logger: silentLogger });
    expect(await unwired.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_not_wired' } });
  });

  it('独立开关：入参 false / 环境变量 0 → 不采集不产出不报错', async () => {
    const spy = vi.fn(() => ({}) as never);
    const off = createAgentStateSense({ enabled: false, port: { snapshot: spy }, logger: silentLogger });
    expect(off.enabled).toBe(false);
    expect(await off.collect(THU_10AM)).toEqual({ signals: [] });
    expect(spy).not.toHaveBeenCalled();

    vi.stubEnv(SENSE_ENV_KEYS['agent-state'], '0');
    const envOff = createAgentStateSense({ port: { snapshot: spy }, logger: silentLogger });
    expect(envOff.enabled).toBe(false);
    expect(await envOff.collect(THU_10AM)).toEqual({ signals: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 源 2：系统健康
// ============================================================================

describe('信号源 system-health', () => {
  function probePort(probe: SystemHealthProbe | (() => unknown)): SystemHealthPort {
    return { probe: () => (typeof probe === 'function' ? (probe() as SystemHealthProbe) : probe) };
  }

  it('磁盘/服务/日志/后台任务四类命中产出（阈值判定 + 形状）', async () => {
    const sense = createSystemHealthSense({
      port: probePort({
        disks: [{ mount: 'C:', freePercent: 7.5 }, { mount: 'D:', freePercent: 42 }],
        services: [{ name: 'websocket', alive: true }, { name: 'whisper', alive: false }],
        logErrors: { recentCount: 9, keywords: ['ECONNRESET', 'OOM'] },
        backgroundTasks: [
          { id: 'bg-1', name: '备份', state: 'failed', error: '句柄占用' },
          { name: '索引', state: 'running' },
        ],
      }),
      logger: silentLogger,
    });
    const reading = await sense.collect(THU_10AM);
    const kinds = reading.signals.map((s) => s.kind).sort();
    expect(kinds).toEqual(['system_background_task_failed', 'system_disk_low', 'system_log_error_burst', 'system_service_down']);
    const disk = reading.signals.find((s) => s.kind === 'system_disk_low')!;
    expectSignalShape(disk, 'system', 'system_disk_low', THU_10AM);
    expect(disk.text).toBe('磁盘 C: 剩余 7.5%');
    expect(disk.dedupeKey).toContain('system-health:disk_low:C:');
    const bg = reading.signals.find((s) => s.kind === 'system_background_task_failed')!;
    expect(bg.dedupeKey).toBe('system-health:background_task_failed:bg-1');
    expect(reading.degraded).toBeUndefined();
  });

  it('未命中阈值不产信号；freePercent 缺省可由 bytes 推算', async () => {
    const sense = createSystemHealthSense({
      port: probePort({
        disks: [{ mount: 'D:', freeBytes: 5, totalBytes: 100 }],
        services: [{ name: 'websocket', alive: true }],
        logErrors: { recentCount: 1 },
        backgroundTasks: [{ name: '索引', state: 'completed' }],
      }),
      logger: silentLogger,
    });
    const reading = await sense.collect(THU_10AM);
    expect(reading.signals).toHaveLength(1);
    expect(reading.signals[0]!.kind).toBe('system_disk_low');
    expect(reading.signals[0]!.text).toBe('磁盘 D: 剩余 5%');
  });

  it('阈值可覆盖（磁盘 50% / 日志 1 条）', async () => {
    const sense = createSystemHealthSense({
      port: probePort({ disks: [{ mount: 'C:', freePercent: 40 }], logErrors: { recentCount: 1 } }),
      thresholds: { diskLowFreePercent: 50, logErrorBurstCount: 1 },
      logger: silentLogger,
    });
    const reading = await sense.collect(THU_10AM);
    expect(reading.signals.map((s) => s.kind).sort()).toEqual(['system_disk_low', 'system_log_error_burst']);
  });

  it('同桶重复采集 dedupeKey 稳定；跨桶更新', async () => {
    const port = probePort({ disks: [{ mount: 'C:', freePercent: 3 }] });
    const sense = createSystemHealthSense({ port, logger: silentLogger });
    const first = await sense.collect(THU_10AM);
    const second = await sense.collect(THU_10AM + 60_000);
    expect(second.signals[0]!.dedupeKey).toBe(first.signals[0]!.dedupeKey);
    const later = await sense.collect(THU_10AM + 7 * 60 * 60 * 1000);
    expect(later.signals[0]!.dedupeKey).not.toBe(first.signals[0]!.dedupeKey);
  });

  it('畸形条目丢弃 + 记因；整体畸形安全缺省；端口抛错/未接降级', async () => {
    const mixed = createSystemHealthSense({
      port: probePort({ disks: [{ mount: 'C:', freePercent: 1 }, 'oops', null], services: 'nope' } as unknown as SystemHealthProbe),
      logger: silentLogger,
    });
    const reading = await mixed.collect(THU_10AM);
    expect(reading.signals).toHaveLength(1);
    expect(reading.degraded).toMatchObject({ reason: 'malformed_data' });
    expect(reading.degraded!.detail).toContain('3');

    const bad = createSystemHealthSense({ port: probePort(() => 'nope'), logger: silentLogger });
    expect(await bad.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'malformed_data' } });

    const boom = createSystemHealthSense({ port: { probe: () => Promise.reject(new Error('boom')) }, logger: silentLogger });
    expect(await boom.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_error' } });

    const unwired = createSystemHealthSense({ logger: silentLogger });
    expect(await unwired.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_not_wired' } });
  });

  it('独立开关：环境变量关 → 零采集零产出零报错', async () => {
    vi.stubEnv(SENSE_ENV_KEYS['system-health'], 'off');
    const spy = vi.fn(() => ({}) as never);
    const sense = createSystemHealthSense({ port: { probe: spy }, logger: silentLogger });
    expect(sense.enabled).toBe(false);
    expect(await sense.collect(THU_10AM)).toEqual({ signals: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 源 3：项目事件
// ============================================================================

describe('信号源 project-events', () => {
  it('五类事件映射 + 评分 + 透传（默认键用 at，自带键优先）', async () => {
    const port: ProjectEventsPort = {
      poll: () => [
        { kind: 'test_failed', at: THU_10AM - 60_000, projectId: 'p1', text: '任务30 单测失败' },
        { kind: 'git_commit', at: THU_10AM - 120_000, dedupeKey: 'commit:abc123' },
        { kind: 'file_changed', at: THU_10AM - 30_000, payload: { path: 'a.ts' } },
      ],
    };
    const sense = createProjectEventsSense({ port, logger: silentLogger });
    const reading = await sense.collect(THU_10AM);
    expect(reading.signals).toHaveLength(3);
    const test = reading.signals.find((s) => s.kind === 'project_test_failed')!;
    expectSignalShape(test, 'project', 'project_test_failed', THU_10AM);
    expect(test.urgency).toBe(85);
    expect(test.projectId).toBe('p1');
    expect(test.dedupeKey).toBe(`project-test_failed:p1@${THU_10AM - 60_000}`);
    const commit = reading.signals.find((s) => s.kind === 'project_git_commit')!;
    expect(commit.dedupeKey).toBe('commit:abc123');
    expect(commit.urgency).toBe(40);
    const file = reading.signals.find((s) => s.kind === 'project_file_changed')!;
    expect(file.payload).toEqual({ path: 'a.ts' });
    expect(file.relevance).toBe(60);
  });

  it('未知 kind 条目丢弃 + 记因；非数组整体畸形；端口抛错/未接降级', async () => {
    const mixed = createProjectEventsSense({
      port: { poll: () => [{ kind: 'git_commit', at: THU_10AM }, { kind: 'unknown_kind' }, 7] as unknown as ProjectEventInput[] },
      logger: silentLogger,
    });
    const reading = await mixed.collect(THU_10AM);
    expect(reading.signals).toHaveLength(1);
    expect(reading.degraded).toMatchObject({ reason: 'malformed_data' });
    expect(reading.degraded!.detail).toContain('2');

    const bad = createProjectEventsSense({ port: { poll: () => ({}) as never }, logger: silentLogger });
    expect(await bad.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'malformed_data' } });

    const boom = createProjectEventsSense({ port: { poll: () => Promise.reject(new Error('git fail')) }, logger: silentLogger });
    expect(await boom.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_error' } });

    const unwired = createProjectEventsSense({ logger: silentLogger });
    expect(await unwired.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_not_wired' } });
  });

  it('独立开关：入参 false → 不 poll 不产出', async () => {
    const spy = vi.fn(() => [] as never);
    const sense = createProjectEventsSense({ enabled: false, port: { poll: spy }, logger: silentLogger });
    expect(await sense.collect(THU_10AM)).toEqual({ signals: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 源 4：时间上下文
// ============================================================================

describe('信号源 time-context', () => {
  it('纯函数：时段边界 / 周末 / 距上次说话分钟数', () => {
    expect(periodOfMinutes(23 * 60)).toBe('deep-night');
    expect(periodOfMinutes(2 * 60)).toBe('deep-night');
    expect(periodOfMinutes(5 * 60)).toBe('early-morning');
    expect(periodOfMinutes(8 * 60)).toBe('morning');
    expect(periodOfMinutes(12 * 60)).toBe('afternoon');
    expect(periodOfMinutes(18 * 60)).toBe('evening');
    expect(readTimeContext(THU_10AM, null).isWeekend).toBe(false);
    expect(readTimeContext(SAT_10AM, null).isWeekend).toBe(true);
    expect(readTimeContext(THU_10AM, THU_10AM - 90 * 60_000).minutesSinceLastUserSpeech).toBe(90);
    expect(readTimeContext(THU_10AM, THU_10AM + 60_000).minutesSinceLastUserSpeech).toBe(0);
  });

  it('首次基线；时段跨段/周末切换才产信号（按本地日幂等）', async () => {
    const sense = createTimeContextSense({ port: { lastUserSpeechAt: () => null }, logger: silentLogger });
    expect((await sense.collect(THU_10AM)).signals).toEqual([]);
    const afternoon = new Date(2026, 0, 15, 13, 0, 0).getTime();
    const changed = await sense.collect(afternoon);
    expect(changed.signals).toHaveLength(1);
    expect(changed.signals[0]!.kind).toBe('time_period_changed');
    expectSignalShape(changed.signals[0]!, 'time', 'time_period_changed', afternoon);
    expect(changed.signals[0]!.dedupeKey).toBe('time-period:afternoon@2026-1-15');

    const weekend = createTimeContextSense({ port: { lastUserSpeechAt: () => null }, logger: silentLogger });
    await weekend.collect(THU_10AM);
    const weekendReading = await weekend.collect(SAT_10AM);
    expect(weekendReading.signals.map((s) => s.kind)).toEqual(['time_weekend_changed']);
  });

  it('离开很久只报一次（按发言时戳幂等）；回来后报 user_returned', async () => {
    const oldSpeech = THU_10AM - 3 * 60 * 60_000;
    let current = oldSpeech;
    const sense = createTimeContextSense({ port: { lastUserSpeechAt: () => current }, logger: silentLogger });
    const away = await sense.collect(THU_10AM);
    expect(away.signals.map((s) => s.kind)).toEqual(['time_user_away_long']);
    expect(away.signals[0]!.payload).toMatchObject({ minutes: 180 });
    // 同一离开事件不重复产信号
    expect((await sense.collect(THU_10AM + 5 * 60_000)).signals).toEqual([]);
    // 用户回来（新发言时戳）
    current = THU_10AM + 5 * 60_000 + 1000;
    const returned = await sense.collect(THU_10AM + 5 * 60_000 + 60_000);
    expect(returned.signals.map((s) => s.kind)).toEqual(['time_user_returned']);
    expect(returned.signals[0]!.dedupeKey).toBe(`time-return:${current}`);
  });

  it('端口未接：时段能力照常，仅「距上次说话」降级记因', async () => {
    const sense = createTimeContextSense({ logger: silentLogger });
    await sense.collect(THU_10AM);
    const reading = await sense.collect(new Date(2026, 0, 15, 13, 0, 0).getTime());
    expect(reading.signals.map((s) => s.kind)).toEqual(['time_period_changed']);
    expect(reading.degraded).toMatchObject({ reason: 'port_not_wired' });
  });

  it('端口抛错/畸形时戳：时段照常 + port_error / malformed_data', async () => {
    const boom = createTimeContextSense({ port: { lastUserSpeechAt: () => Promise.reject(new Error('boom')) }, logger: silentLogger });
    const boomReading = await boom.collect(THU_10AM);
    expect(boomReading.signals).toEqual([]);
    expect(boomReading.degraded).toMatchObject({ reason: 'port_error' });

    const malformed = createTimeContextSense({ port: { lastUserSpeechAt: () => 'yesterday' as never }, logger: silentLogger });
    expect(await malformed.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'malformed_data' } });
  });

  it('独立开关：环境变量关 → 零采集零产出零报错', async () => {
    vi.stubEnv(SENSE_ENV_KEYS['time-context'], 'false');
    const spy = vi.fn(() => null);
    const sense = createTimeContextSense({ port: { lastUserSpeechAt: spy }, logger: silentLogger });
    expect(sense.enabled).toBe(false);
    expect(await sense.collect(THU_10AM)).toEqual({ signals: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 源 6：记忆信号
// ============================================================================

describe('信号源 memory-signals', () => {
  it('三类映射/评分/默认按日幂等键', async () => {
    const port: MemorySignalsPort = {
      read: () => [
        { kind: 'due', itemId: 't13', text: '任务13 今天到期' },
        { kind: 'promise_unkept', itemId: 'p7', text: '答应整理周报' },
        { kind: 'knowledge_gap', text: '缺少部署清单' },
      ],
    };
    const sense = createMemorySignalsSense({ port, logger: silentLogger });
    const reading = await sense.collect(THU_10AM);
    expect(reading.signals).toHaveLength(3);
    const due = reading.signals.find((s) => s.kind === 'memory_task_due')!;
    expectSignalShape(due, 'memory', 'memory_task_due', THU_10AM);
    expect(due.urgency).toBe(85);
    expect(due.timeSensitive).toBe(true);
    expect(due.dedupeKey).toBe('memory-due:t13@2026-1-15');
    const promise = reading.signals.find((s) => s.kind === 'memory_promise_unkept')!;
    expect(promise.dedupeKey).toBe('memory-promise_unkept:p7@2026-1-15');
    const gap = reading.signals.find((s) => s.kind === 'memory_knowledge_gap')!;
    expect(gap.urgency).toBe(40);
    expect(gap.dedupeKey).toBe('memory-knowledge_gap:all@2026-1-15');
  });

  it('自带 dedupeKey 优先；未知 kind/畸形条目丢弃 + 记因', async () => {
    const sense = createMemorySignalsSense({
      port: { read: () => [{ kind: 'due', dedupeKey: 'bolba-due-scan:2026-1-15' }, { kind: 'nope' }, null] as unknown as MemorySignalInput[] },
      logger: silentLogger,
    });
    const reading = await sense.collect(THU_10AM);
    expect(reading.signals).toHaveLength(1);
    expect(reading.signals[0]!.dedupeKey).toBe('bolba-due-scan:2026-1-15');
    expect(reading.degraded).toMatchObject({ reason: 'malformed_data' });
    expect(reading.degraded!.detail).toContain('2');
  });

  it('非数组整体畸形 / 端口抛错 / 端口未接 → 安全缺省', async () => {
    const bad = createMemorySignalsSense({ port: { read: () => 'nope' as never }, logger: silentLogger });
    expect(await bad.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'malformed_data' } });

    const boom = createMemorySignalsSense({ port: { read: () => Promise.reject(new Error('boom')) }, logger: silentLogger });
    expect(await boom.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_error' } });

    const unwired = createMemorySignalsSense({ logger: silentLogger });
    expect(await unwired.collect(THU_10AM)).toMatchObject({ signals: [], degraded: { reason: 'port_not_wired' } });
  });

  it('独立开关：入参 false → 不 read 不产出', async () => {
    const spy = vi.fn(() => [] as never);
    const sense = createMemorySignalsSense({ enabled: false, port: { read: spy }, logger: silentLogger });
    expect(await sense.collect(THU_10AM)).toEqual({ signals: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 契约：六源 collect 永不抛出（含注入 logger 抛错的病态场景）
// ============================================================================

describe('六源「永不上抛」契约', () => {
  it('端口抛错 + logger 全抛错 → collect 仍返回安全缺省', async () => {
    const hostileLogger: JarvisLogger = {
      log: () => {
        throw new Error('log boom');
      },
      debug: () => {
        throw new Error('debug boom');
      },
      warn: () => {
        throw new Error('warn boom');
      },
      error: () => {
        throw new Error('error boom');
      },
    };
    const senses: Sense[] = [
      createAgentStateSense({ port: { snapshot: () => Promise.reject(new Error('x')) }, logger: hostileLogger }),
      createSystemHealthSense({ port: { probe: () => Promise.reject(new Error('x')) }, logger: hostileLogger }),
      createProjectEventsSense({ port: { poll: () => Promise.reject(new Error('x')) }, logger: hostileLogger }),
      createTimeContextSense({ port: { lastUserSpeechAt: () => Promise.reject(new Error('x')) }, logger: hostileLogger }),
      createMemorySignalsSense({ port: { read: () => Promise.reject(new Error('x')) }, logger: hostileLogger }),
      createUserBehaviorSense({
        read: () => {
          throw new Error('x');
        },
      } satisfies UserBehaviorPort),
    ];
    for (const sense of senses) {
      const reading = await sense.collect(THU_10AM);
      expect(reading.signals).toEqual([]);
      expect(reading.degraded).toMatchObject({ reason: 'port_error' });
    }
  });
});
