import { beforeEach, describe, expect, it, vi } from 'vitest';

// trigger-service has heavy data/runtime deps; stub them so we can exercise the
// cron re-arm + same-minute guard wiring in isolation. sendCommand and
// handleTrigger are pulled in via dynamic import() inside fireTrigger — vi.mock
// intercepts those too.
vi.mock('../data/trigger-store.js', () => ({
  loadTriggers: () => [],
  saveTriggers: vi.fn(),
  saveTriggersSync: vi.fn(),
  saveTriggersAsync: vi.fn().mockResolvedValue(undefined),
}));

let nextEventId = 1;
vi.mock('../data/event-db.js', () => ({
  insertOne: vi.fn(() => nextEventId++),
  queryMany: vi.fn(() => []),
  execute: vi.fn(),
}));

vi.mock('./llm-matcher-service.js', () => ({
  llmMatch: vi.fn(),
  llmExtractVariables: vi.fn(),
}));

vi.mock('./cron-service.js', () => ({
  schedule: vi.fn(),
  scheduleOnce: vi.fn(),
  stop: vi.fn(),
  validate: vi.fn(),
  getNextFireTimes: vi.fn(),
}));

vi.mock('./runtime-service.js', () => ({
  sendCommand: vi.fn().mockResolvedValue(undefined),
}));

const mockGetAgent = vi.hoisted(() => vi.fn());
vi.mock('./agent-service.js', () => ({
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
}));

vi.mock('./workflow-executor.js', () => ({
  handleTrigger: vi.fn().mockResolvedValue(undefined),
}));

import * as triggerService from './trigger-service.js';
import * as cronService from './cron-service.js';
import * as runtimeService from './runtime-service.js';
import { insertOne } from '../data/event-db.js';

const cronSchedule = vi.mocked(cronService.schedule);
const sendCommand = vi.mocked(runtimeService.sendCommand);

beforeEach(() => {
  cronSchedule.mockClear();
  sendCommand.mockClear();
});

describe('cron trigger re-arm seeds the same-minute guard (no double-fire)', () => {
  function makeCronTrigger(): string {
    // The cron-service mock is a no-op; this spec only cares about HOW
    // startCronJob invokes schedule(). Expression / timezone values are
    // arbitrary because nothing in the mocked path parses them.
    const created = triggerService.createTrigger({
      name: 'cron-rearm-test',
      type: 'cron',
      agentId: 'A',
      promptTemplate: 'tick',
      enabled: true,
      status: 'enabled',
      matchMode: 'structural',
      rateLimitPerMinute: 0,
      config: { expression: '* * * * *', timezone: 'UTC' },
    } as Parameters<typeof triggerService.createTrigger>[0]);
    return created.id;
  }

  it('createTrigger schedules with initialLastFired: null (no prior fire yet)', () => {
    makeCronTrigger();
    expect(cronSchedule).toHaveBeenCalledTimes(1);
    const opts = cronSchedule.mock.calls[0][3];
    expect(opts).toEqual({ initialLastFired: null });
  });

  it('after fireTrigger the re-armed schedule receives initialLastFired = lastFiredAt', async () => {
    const id = makeCronTrigger();
    expect(cronSchedule).toHaveBeenCalledTimes(1);

    // Pin time so we can assert the exact seed value passed on re-arm.
    const fireMoment = 1_700_000_001_234;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fireMoment));

    await triggerService.fireTrigger(id, {});

    // fireTrigger -> updateTrigger({lastFiredAt: fireMoment}) -> re-arm via schedule.
    // Total calls so far: 1 (initial) + 1 (re-arm) = 2.
    expect(cronSchedule).toHaveBeenCalledTimes(2);
    const rearmOpts = cronSchedule.mock.calls[1][3];
    expect(rearmOpts).toEqual({ initialLastFired: fireMoment });

    vi.useRealTimers();
  });
});

describe('fireTrigger — standby (待岗) skip', () => {
  function makeCronTrigger(): string {
    const created = triggerService.createTrigger({
      name: 'standby-skip-test',
      type: 'cron',
      agentId: 'A',
      promptTemplate: 'tick',
      enabled: true,
      status: 'enabled',
      matchMode: 'structural',
      rateLimitPerMinute: 0,
      config: { expression: '* * * * *', timezone: 'UTC' },
    } as Parameters<typeof triggerService.createTrigger>[0]);
    return created.id;
  }

  it('待岗 agent:不投递、不落 trigger_events、不翻 trigger 状态', async () => {
    const id = makeCronTrigger();
    vi.mocked(insertOne).mockClear();
    mockGetAgent.mockReturnValue({ id: 'A', name: 'Worker A', standby: true });

    await triggerService.fireTrigger(id, {});

    expect(sendCommand).not.toHaveBeenCalled();
    // 跳过发生在 SQLite 落库之前——待岗期间事件流不留失败噪音
    expect(vi.mocked(insertOne)).not.toHaveBeenCalled();
    const trigger = triggerService.getTrigger(id);
    expect(trigger?.fireCount).toBe(0);
    expect(trigger?.lastFiredAt).toBeUndefined();
    expect(trigger?.status).toBe('enabled');
  });
});
