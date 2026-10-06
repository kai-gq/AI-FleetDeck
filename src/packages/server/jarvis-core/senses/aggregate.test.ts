/**
 * jarvis-core · 感知层聚合与故障隔离单测（任务 30 ⑥ 验收；第 6 路补齐后）
 *
 * 覆盖：六源齐采的归一化形状（09·A Signal）、单源 throws / 超时 / 畸形读数 /
 * 单条畸形信号 → 只该源降级、其余源正常；关闭源零采集；注入钩子/日志抛错也不破坏
 * 「聚合永不抛出」；聚合结果可直接入 SignalQueue 判定链路；默认装配（第 6 路
 * user-behavior 传端口才追加，向后兼容）。
 * 证据等级 L1（mock 注入；真链路未跑）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Signal } from '../../../shared/broadcast-gates.js';
import { SignalQueue, type RawSignal } from '../signal-queue.js';
import type { JarvisLogger } from '../executors.js';
import {
  collectSensesSafely,
  createDefaultSenses,
  DEFAULT_SENSE_NAMES,
} from './aggregate.js';
import { createAgentStateSense } from './agent-state.js';
import { createSystemHealthSense } from './system-health.js';
import { createProjectEventsSense } from './project-events.js';
import { createTimeContextSense } from './time-context.js';
import { createMemorySignalsSense } from './memory-signals.js';
import { createUserBehaviorSense } from './user-behavior.js';
import {
  SENSE_NAMES,
  SENSE_SIGNAL_SOURCES,
  SENSE_TRIGGERS,
  type Sense,
  type SenseName,
  type SenseReading,
} from './types.js';

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/** 本地 2026-01-15（周四）13:00。 */
const THU_1PM = new Date(2026, 0, 15, 13, 0, 0).getTime();
const THU_10AM = new Date(2026, 0, 15, 10, 0, 0).getTime();

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 手搓假源（故障注入用：不受各源内部 catch 保护，直达聚合层隔离逻辑）。 */
function fakeSense(
  name: SenseName,
  collect: (now: number) => SenseReading | Promise<SenseReading>,
  enabled = true,
): Sense {
  return {
    name,
    source: SENSE_SIGNAL_SOURCES[name],
    trigger: SENSE_TRIGGERS[name],
    enabled,
    collect: async (now) => collect(now),
  };
}

/** 六源齐采的默认 mock 组合（各产 1 条合法信号）。 */
function sixHealthySenses(): { senses: Sense[]; setUserActivityAt: (at: number | null) => void } {
  // user-behavior：基线前已离开 2h（基线记「离开」，正式采集前把活动拨到「刚回来」）。
  // 回来是输入类活动（没说话）——语音回来的 ≥2h 长离开按分工归 time-context，本源不产。
  let userActivityAt: number | null = THU_10AM - 2 * 60 * 60_000;
  const userSpeechAt: number | null = null;
  const agent = createAgentStateSense({
    logger: silentLogger,
    port: {
      snapshot: (() => {
        let n = 0;
        return () => {
          n++;
          return n === 1
            ? { a1: { name: '小美', status: 'working', taskLabel: '登录页' } }
            : { a1: { name: '小美', status: 'idle', taskLabel: '登录页' } };
        };
      })(),
    },
  });
  const system = createSystemHealthSense({
    logger: silentLogger,
    port: { probe: () => ({ disks: [{ mount: 'C:', freePercent: 3 }] }) },
  });
  const project = createProjectEventsSense({
    logger: silentLogger,
    port: { poll: () => [{ kind: 'test_failed', at: THU_1PM - 60_000, text: '单测失败' }] },
  });
  const time = createTimeContextSense({ logger: silentLogger, port: { lastUserSpeechAt: () => null } });
  const memory = createMemorySignalsSense({
    logger: silentLogger,
    port: { read: () => [{ kind: 'due', itemId: 't13' }] },
  });
  const user = createUserBehaviorSense({
    read: () => ({ lastActivityAt: userActivityAt, lastSpeechAt: userSpeechAt }),
  });
  return {
    senses: [agent, system, project, time, memory, user],
    setUserActivityAt: (at) => {
      userActivityAt = at;
    },
  };
}

describe('聚合：六源齐采与归一化形状', () => {
  it('六源各产 1 条 → 归一化为 09·A Signal（source/ts/dedupeKey/顺序齐备）', async () => {
    const { senses, setUserActivityAt } = sixHealthySenses();
    // 预跑基线（agent/time/user 首次只建基线；正式采集前先喂一轮）
    await senses[0]!.collect(THU_10AM);
    await senses[3]!.collect(THU_10AM);
    await senses[5]!.collect(THU_10AM);
    setUserActivityAt(THU_1PM - 30_000); // 用户 30 秒前刚有活动 → 正式采集报「回来」
    const result = await collectSensesSafely(senses, { now: THU_1PM, logger: silentLogger });

    expect(result.failures).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.signals).toHaveLength(6);
    expect(result.signals.map((s) => s.source)).toEqual(['agent', 'system', 'project', 'time', 'memory', 'user']);
    for (const signal of result.signals) {
      expect(typeof signal.kind).toBe('string');
      expect(signal.ts).toBe(THU_1PM);
      expect(typeof signal.dedupeKey).toBe('string');
      expect(signal.dedupeKey.length).toBeGreaterThan(0);
    }
    expect(result.readings.map((r) => r.name)).toEqual([...SENSE_NAMES]);
    for (const reading of result.readings) {
      expect(reading.enabled).toBe(true);
      expect(reading.collected).toBe(true);
      expect(reading.signalCount).toBe(1);
      expect(reading.malformedCount).toBe(0);
      expect(reading.degraded).toBe(false);
      expect(reading.degradeReason).toBeUndefined();
    }
    expect(result.signals.map((s) => s.kind)).toEqual([
      'agent_completed',
      'system_disk_low',
      'project_test_failed',
      'time_period_changed',
      'memory_task_due',
      'user_returned',
    ]);
  });

  it('聚合结果可直接进 SignalQueue 判定链路（归一化形状可被消费）', async () => {
    const { senses, setUserActivityAt } = sixHealthySenses();
    await senses[0]!.collect(THU_10AM);
    await senses[3]!.collect(THU_10AM);
    await senses[5]!.collect(THU_10AM);
    setUserActivityAt(THU_1PM - 30_000);
    const result = await collectSensesSafely(senses, { now: THU_1PM, logger: silentLogger });

    const queue = new SignalQueue({ now: THU_1PM, logger: silentLogger });
    for (const signal of result.signals) queue.enqueue(signal);
    const consumed = queue.consumeAll();
    expect(consumed).toHaveLength(6);
    for (const item of consumed) {
      expect(['SPEAK', 'PREPARE', 'STORE', 'SILENT']).toContain(item.decision.tier);
      expect(item.signal.ts).toBe(THU_1PM);
    }
  });
});

describe('聚合：故障隔离（一源失败不影响其他源）', () => {
  it('某源 throw → 该源 port_error 降级，其余源照常出信号', async () => {
    const echo = fakeSense('system-health', () => ({
      signals: [{ source: 'system', kind: 'system_disk_low', ts: THU_1PM, dedupeKey: 'k-sys' }],
    }));
    const boom = fakeSense('agent-state', () => {
      throw new Error('snapshot exploded');
    });
    const result = await collectSensesSafely([boom, echo], { now: THU_1PM, logger: silentLogger });

    expect(result.signals.map((s) => s.kind)).toEqual(['system_disk_low']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.source).toBe('agent-state');
    const agentSummary = result.readings.find((r) => r.name === 'agent-state')!;
    expect(agentSummary.degraded).toBe(true);
    expect(agentSummary.degradeReason).toBe('port_error');
    expect(agentSummary.signalCount).toBe(0);
    const systemSummary = result.readings.find((r) => r.name === 'system-health')!;
    expect(systemSummary.degraded).toBe(false);
    expect(systemSummary.signalCount).toBe(1);
  });

  it('某源 reject 非 Error（字符串）也不上抛、照记 port_error', async () => {
    const boom = fakeSense('project-events', () => Promise.reject('plain-string'));
    const echo = fakeSense('memory-signals', () => ({
      signals: [{ source: 'memory', kind: 'memory_task_due', ts: THU_1PM, dedupeKey: 'k-mem' }],
    }));
    const result = await collectSensesSafely([boom, echo], { now: THU_1PM, logger: silentLogger });
    expect(result.signals).toHaveLength(1);
    expect(result.readings[0]!.degradeReason).toBe('port_error');
  });

  it('某源超时 → 该源 timeout 降级，其余源照常（不吞循环）', async () => {
    const hang = fakeSense('agent-state', () => new Promise<SenseReading>(() => {}));
    const echo = fakeSense('time-context', () => ({
      signals: [{ source: 'time', kind: 'time_period_changed', ts: THU_1PM, dedupeKey: 'k-time' }],
    }));
    const result = await collectSensesSafely([hang, echo], { now: THU_1PM, timeoutMs: 20, logger: silentLogger });

    expect(result.signals.map((s) => s.kind)).toEqual(['time_period_changed']);
    const hangSummary = result.readings.find((r) => r.name === 'agent-state')!;
    expect(hangSummary.degraded).toBe(true);
    expect(hangSummary.degradeReason).toBe('timeout');
    expect(result.failures[0]!.source).toBe('agent-state');
    expect(result.readings.find((r) => r.name === 'time-context')!.degraded).toBe(false);
  });

  it('某源读数畸形（无 signals 数组）→ 该源 malformed_data，其余源照常', async () => {
    const malformed = fakeSense('system-health', () => ({ signals: 'oops' }) as unknown as SenseReading);
    const echo = fakeSense('memory-signals', () => ({
      signals: [{ source: 'memory', kind: 'memory_task_due', ts: THU_1PM, dedupeKey: 'k-mem' }],
    }));
    const result = await collectSensesSafely([malformed, echo], { now: THU_1PM, logger: silentLogger });
    expect(result.signals.map((s) => s.kind)).toEqual(['memory_task_due']);
    const badSummary = result.readings.find((r) => r.name === 'system-health')!;
    expect(badSummary.degraded).toBe(true);
    expect(badSummary.degradeReason).toBe('malformed_data');
    expect(badSummary.collected).toBe(false);
  });

  it('单条畸形信号安全丢弃：合法条目保留 + 该源记因', async () => {
    const mixed = fakeSense('project-events', () => ({
      signals: [
        { source: 'project', kind: 'project_test_failed', ts: THU_1PM, dedupeKey: 'ok' },
        { source: 'not-a-source', kind: 'x', ts: THU_1PM, dedupeKey: 'bad-source' },
        null,
      ] as unknown as RawSignal[],
    }));
    const echo = fakeSense('memory-signals', () => ({
      signals: [{ source: 'memory', kind: 'memory_task_due', ts: THU_1PM, dedupeKey: 'k-mem' }],
    }));
    const result = await collectSensesSafely([mixed, echo], { now: THU_1PM, logger: silentLogger });
    expect(result.signals.map((s) => s.dedupeKey)).toEqual(['ok', 'k-mem']);
    const mixedSummary = result.readings.find((r) => r.name === 'project-events')!;
    expect(mixedSummary.signalCount).toBe(1);
    expect(mixedSummary.malformedCount).toBe(2);
    expect(mixedSummary.degradeReason).toBe('malformed_data');
    expect(result.readings.find((r) => r.name === 'memory-signals')!.degraded).toBe(false);
  });

  it('聚合函数本身永不抛出：注入钩子/日志全抛错 + 某源 throw → 仍返回且其余源信号完好', async () => {
    const hostileLogger: JarvisLogger = {
      log: () => {
        throw new Error('boom');
      },
      debug: () => {
        throw new Error('boom');
      },
      warn: () => {
        throw new Error('boom');
      },
      error: () => {
        throw new Error('boom');
      },
    };
    const boom = fakeSense('agent-state', () => {
      throw new Error('x');
    });
    const echo = fakeSense('system-health', () => ({
      signals: [{ source: 'system', kind: 'system_service_down', ts: THU_1PM, dedupeKey: 'k-sys' }],
    }));
    const result = await collectSensesSafely([boom, echo], {
      now: THU_1PM,
      logger: hostileLogger,
      onSourceError: () => {
        throw new Error('hook boom');
      },
    });
    expect(result.signals.map((s) => s.kind)).toEqual(['system_service_down']);
    expect(result.readings.find((r) => r.name === 'agent-state')!.degraded).toBe(true);
    expect(result.readings.find((r) => r.name === 'system-health')!.degraded).toBe(false);
  });

  it('空源列表：零信号零失败零降级', async () => {
    const result = await collectSensesSafely([], { now: THU_1PM, logger: silentLogger });
    expect(result).toEqual({ signals: [], readings: [], failures: [], degraded: false });
  });
});

describe('聚合：独立开关（关闭 = 零采集零产出零报错）', () => {
  it('关闭源不调用端口，摘要 enabled=false/collected=false，且不产生失败', async () => {
    const spy = vi.fn(() => ({ signals: [] }) as SenseReading);
    const off = fakeSense('agent-state', spy, false);
    const on = fakeSense('system-health', () => ({
      signals: [{ source: 'system', kind: 'system_disk_low', ts: THU_1PM, dedupeKey: 'k-sys' }],
    }));
    const result = await collectSensesSafely([off, on], { now: THU_1PM, logger: silentLogger });

    expect(spy).not.toHaveBeenCalled();
    const offSummary = result.readings.find((r) => r.name === 'agent-state')!;
    expect(offSummary.enabled).toBe(false);
    expect(offSummary.collected).toBe(false);
    expect(offSummary.degraded).toBe(false);
    expect(offSummary.signalCount).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.signals.map((s) => s.kind)).toEqual(['system_disk_low']);
  });

  it('环境变量关某源：createDefaultSenses 产出该源 enabled=false 且零采集', async () => {
    vi.stubEnv('TC_JARVIS_SENSE_PROJECT_EVENTS', '0');
    const senses = createDefaultSenses({ logger: silentLogger });
    const project = senses.find((s) => s.name === 'project-events')!;
    expect(project.enabled).toBe(false);
    const result = await collectSensesSafely(senses, { now: THU_1PM, logger: silentLogger });
    const summary = result.readings.find((r) => r.name === 'project-events')!;
    expect(summary.enabled).toBe(false);
    expect(summary.collected).toBe(false);
    expect(summary.degraded).toBe(false);
  });

  it('默认装配（不传 userBehaviorPort）：五源向后兼容，未接端口 → 逐源 port_not_wired', async () => {
    const senses = createDefaultSenses({ logger: silentLogger });
    expect(senses.map((s) => s.name)).toEqual([...SENSE_NAMES].filter((name) => name !== 'user-behavior'));
    expect(senses).toHaveLength(5);
    expect(senses.every((s) => s.enabled)).toBe(true);

    const result = await collectSensesSafely(senses, { now: THU_1PM, logger: silentLogger });
    expect(result.signals).toEqual([]);
    expect(result.failures).toEqual([]); // 未接线是计划内降级，不是读取失败
    expect(result.readings.every((r) => r.degraded && r.degradeReason === 'port_not_wired')).toBe(true);
    expect(result.degraded).toBe(true);
    // 信号源类别严格对应 09·A 六类之五（第 6 路未接线不装配）
    expect(result.readings.map((r) => r.source)).toEqual(['agent', 'system', 'project', 'time', 'memory']);
  });

  it('传入 userBehaviorPort → 追加第 6 路（顺序 = DEFAULT_SENSE_NAMES），独立采集不降级', async () => {
    const senses = createDefaultSenses({
      logger: silentLogger,
      userBehaviorPort: { read: () => ({ lastActivityAt: THU_1PM, lastSpeechAt: THU_1PM }) },
    });
    expect(senses.map((s) => s.name)).toEqual([...DEFAULT_SENSE_NAMES]);
    expect(senses).toHaveLength(6);
    const user = senses[5]!;
    expect(user.name).toBe('user-behavior');
    expect(user.source).toBe('user');
    expect(user.trigger).toBe('heartbeat');
    expect(user.enabled).toBe(true);

    // 首次采集只建基线（在场 → 不产信号），且不降级
    const result = await collectSensesSafely([user], { now: THU_1PM, logger: silentLogger });
    expect(result.failures).toEqual([]);
    expect(result.signals).toEqual([]);
    expect(result.readings[0]).toMatchObject({
      name: 'user-behavior',
      collected: true,
      degraded: false,
      signalCount: 0,
    });
  });
});

describe('聚合：时序与稳定性', () => {
  it('同一批输入两次聚合结果稳定（无隐藏状态）', async () => {
    const make = (): Sense[] => [
      fakeSense('system-health', () => ({ signals: [{ source: 'system', kind: 'system_disk_low', ts: THU_1PM, dedupeKey: 'k' }] })),
      fakeSense('memory-signals', () => ({ signals: [{ source: 'memory', kind: 'memory_task_due', ts: THU_1PM, dedupeKey: 'm' }] })),
    ];
    const first = await collectSensesSafely(make(), { now: THU_1PM, logger: silentLogger });
    const second = await collectSensesSafely(make(), { now: THU_1PM, logger: silentLogger });
    expect(second.signals).toEqual(first.signals as Signal[]);
    expect(second.readings).toEqual(first.readings);
  });
});
