/**
 * jarvis-core · executors 单测（任务 26 ⑥）
 *
 * 覆盖：幂等去重（同 dedupeKey 只执行一次/在途/熔断）/ 失败指数退避 /
 * 动作串行（不并发 claude 调用）/ 降级三路径（信号源失败隔离、通道不可用
 * 降级上屏、配置错误保守回退）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GATES_CONFIG,
  createGatesState,
  type BroadcastDecision,
  type BroadcastTier,
  type EnvironmentContext,
  type GatesState,
  type Signal,
} from '../../shared/broadcast-gates.js';
import {
  DEFAULT_RETRY_POLICY,
  IdempotentExecutor,
  backoffDelayMs,
  collectSignalsSafely,
  decideSafely,
  deliverDecision,
  retryWithBackoff,
  validateGatesConfig,
  type IdempotentExecutorOptions,
  type JarvisLogger,
  type ObserveFailure,
} from './executors.js';

const silentLogger: JarvisLogger = {
  log: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

const DAY = new Date(2026, 0, 15, 14, 0, 0).getTime();

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeSignal(score: number, dedupeKey = `k-${score}`): Signal {
  return { source: 'agent', kind: 'agent_completed', ts: DAY, dedupeKey, score, text: 'x' };
}

function makeDecision(tier: BroadcastTier): BroadcastDecision {
  return {
    tier,
    reason: 'batched',
    score: 70,
    disruption: 20,
    budget: 10,
    duplicate: false,
    delta: { seenKeysToAdd: [], dailySpokenDelta: 0, instantSpeechDelta: 0 },
  };
}

function makeExecutor(overrides: Partial<IdempotentExecutorOptions> = {}): IdempotentExecutor {
  return new IdempotentExecutor({ logger: silentLogger, sleep: async () => {}, ...overrides });
}

describe('retryWithBackoff（§11.1 / §8.2 AWS 标准模式）', () => {
  it('失败两次后成功：attempts=3，退避 500/1000ms', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const value = await retryWithBackoff(
      async (attempt) => {
        calls++;
        if (attempt < 3) throw new Error(`fail-${attempt}`);
        return 'ok';
      },
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });

  it('退避封顶 maxDelayMs；重试耗尽抛最后一次异常', async () => {
    const sleeps: number[] = [];
    await expect(
      retryWithBackoff(
        async () => {
          throw new Error('always');
        },
        {
          policy: { maxAttempts: 4, baseDelayMs: 1000, factor: 10, maxDelayMs: 5000 },
          sleep: async (ms) => { sleeps.push(ms); },
        },
      ),
    ).rejects.toThrow('always');
    expect(sleeps).toEqual([1000, 5000, 5000]);
  });

  it('backoffDelayMs 按指数增长并封顶', () => {
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(3)).toBe(2000);
    expect(backoffDelayMs(10, { baseDelayMs: 1000, factor: 10, maxDelayMs: 3000 })).toBe(3000);
  });
});

describe('IdempotentExecutor：幂等去重（同 dedupeKey 只执行一次）', () => {
  it('成功执行一次后同键返回 duplicate，动作不再跑', async () => {
    const executor = makeExecutor();
    let calls = 0;
    const action = async () => {
      calls++;
    };
    const first = await executor.submit({ dedupeKey: 'k1', kind: 'test' }, action);
    expect(first.status).toBe('executed');
    expect(first.attempts).toBe(1);
    expect(executor.hasCompleted('k1')).toBe(true);

    const second = await executor.submit({ dedupeKey: 'k1', kind: 'test' }, action);
    expect(second.status).toBe('duplicate');
    expect(second.attempts).toBe(0);
    expect(calls).toBe(1);
  });

  it('在途去重：动作未结束时同键 submit 返回 in_flight', async () => {
    const executor = makeExecutor();
    const gate = deferred();
    let calls = 0;
    const first = executor.submit({ dedupeKey: 'k2' }, async () => {
      calls++;
      await gate.promise;
    });
    await flushMicrotasks();
    const second = await executor.submit({ dedupeKey: 'k2' }, async () => {
      calls++;
    });
    expect(second.status).toBe('in_flight');
    gate.resolve();
    expect((await first).status).toBe('executed');
    expect(calls).toBe(1);
  });

  it('动作串行（默认）：不并发执行两个动作', async () => {
    const executor = makeExecutor();
    let concurrent = 0;
    let maxConcurrent = 0;
    const action = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent--;
    };
    await Promise.all([
      executor.submit({ dedupeKey: 'a' }, action),
      executor.submit({ dedupeKey: 'b' }, action),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it('已完成键超上限丢最旧（防无界；取舍与 seenKeys 同源）', async () => {
    const executor = makeExecutor({ maxRememberedKeys: 2 });
    await executor.submit({ dedupeKey: 'k1' }, () => {});
    await executor.submit({ dedupeKey: 'k2' }, () => {});
    await executor.submit({ dedupeKey: 'k3' }, () => {});
    expect(executor.hasCompleted('k1')).toBe(false);
    const again = await executor.submit({ dedupeKey: 'k1' }, () => {});
    expect(again.status).toBe('executed');
  });
});

describe('IdempotentExecutor：失败退避与熔断', () => {
  it('失败两次后成功：attempts=3，退避 500/1000ms', async () => {
    const sleeps: number[] = [];
    const executor = makeExecutor({ sleep: async (ms) => { sleeps.push(ms); } });
    let calls = 0;
    const result = await executor.submit({ dedupeKey: 'k3' }, async () => {
      calls++;
      if (calls < 3) throw new Error('boom');
    });
    expect(result.status).toBe('executed');
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('重试耗尽 → failed 熔断（不自动重试）；clearFailure 后可再执行', async () => {
    const sleeps: number[] = [];
    const executor = makeExecutor({ sleep: async (ms) => { sleeps.push(ms); } });
    let calls = 0;
    const first = await executor.submit({ dedupeKey: 'k4' }, async () => {
      calls++;
      throw new Error('always');
    });
    expect(first.status).toBe('failed');
    expect(first.attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(executor.hasFailed('k4')).toBe(true);

    const second = await executor.submit({ dedupeKey: 'k4' }, async () => {
      calls++;
    });
    expect(second.status).toBe('failed'); // 熔断：不自动重试
    expect(calls).toBe(3);

    expect(executor.clearFailure('k4')).toBe(true);
    const third = await executor.submit({ dedupeKey: 'k4' }, async () => {
      calls++;
    });
    expect(third.status).toBe('executed');
    expect(calls).toBe(4);
  });
});

describe('降级路径 1：信号源失败只记日志不吞循环', () => {
  it('坏源隔离，好源照常返回，整体不抛出', async () => {
    const failures: ObserveFailure[] = [];
    const result = await collectSignalsSafely<{ id: string }>(
      [
        { name: 'good-1', read: () => [{ id: 'a' }, { id: 'b' }] },
        {
          name: 'bad',
          read: () => {
            throw new Error('信号源挂了');
          },
        },
        { name: 'good-2', read: async () => ({ id: 'c' }) },
        { name: 'bad-2', read: async () => Promise.reject(new Error('异步挂')) },
      ],
      { logger: silentLogger, onSourceError: (failure) => failures.push(failure) },
    );
    expect(result.signals.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(result.failures.map((f) => f.source)).toEqual(['bad', 'bad-2']);
    expect(failures).toHaveLength(2);
  });

  it('onSourceError 钩子抛错也被隔离，函数仍满足「永不抛出」契约', async () => {
    const result = await collectSignalsSafely<{ id: string }>(
      [
        {
          name: 'bad',
          read: () => {
            throw new Error('信号源挂了');
          },
        },
        { name: 'good', read: () => [{ id: 'ok' }] },
      ],
      {
        logger: silentLogger,
        onSourceError: () => {
          throw new Error('钩子自身抛错');
        },
      },
    );
    // 源错误被记录、好源照常返回、钩子异常不破坏整体不抛出的契约
    expect(result.signals.map((s) => s.id)).toEqual(['ok']);
    expect(result.failures.map((f) => f.source)).toEqual(['bad']);
  });
});

describe('降级路径 2：claude/语音通道不可用 → 降级上屏通知', () => {
  const signal = makeSignal(95, 'k-deliver');

  it('SPEAK 通道正常 → voice', async () => {
    const calls: string[] = [];
    const result = await deliverDecision(
      signal,
      makeDecision('SPEAK'),
      {
        speak: () => {
          calls.push('speak');
        },
        notice: () => {
          calls.push('notice');
        },
      },
      { logger: silentLogger },
    );
    expect(result).toEqual({ channel: 'voice', degraded: false });
    expect(calls).toEqual(['speak']);
  });

  it('SPEAK 通道缺失 → 上屏通知（channel_unavailable）', async () => {
    const notices: string[] = [];
    const result = await deliverDecision(
      signal,
      makeDecision('SPEAK'),
      {
        notice: (_s, _d, reason) => {
          notices.push(reason);
        },
      },
      { logger: silentLogger },
    );
    expect(result.channel).toBe('notice');
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('channel_unavailable');
    expect(notices).toEqual(['channel_unavailable']);
  });

  it('口播抛错 → 降级上屏；上屏也失败/未接 → 仅记日志不抛出', async () => {
    const degraded = await deliverDecision(
      signal,
      makeDecision('SPEAK'),
      {
        speak: () => {
          throw new Error('claude 不可用');
        },
        notice: () => {},
      },
      { logger: silentLogger },
    );
    expect(degraded.channel).toBe('notice');
    expect(degraded.degraded).toBe(true);

    const bothFailed = await deliverDecision(
      signal,
      makeDecision('SPEAK'),
      {
        speak: () => {
          throw new Error('claude 不可用');
        },
        notice: () => {
          throw new Error('上屏也挂');
        },
      },
      { logger: silentLogger },
    );
    expect(bothFailed.channel).toBe('none');
    expect(bothFailed.degraded).toBe(true);
    expect(bothFailed.error).toBeInstanceOf(Error);

    const noPorts = await deliverDecision(signal, makeDecision('SPEAK'), {}, { logger: silentLogger });
    expect(noPorts.channel).toBe('none');
    expect(noPorts.degraded).toBe(true);
  });

  it('PREPARE / STORE / SILENT 路由；出口未接只记日志', async () => {
    const prepare = await deliverDecision(signal, makeDecision('PREPARE'), { prepare: () => {} }, { logger: silentLogger });
    expect(prepare).toEqual({ channel: 'prepare', degraded: false });

    const store = await deliverDecision(signal, makeDecision('STORE'), { store: () => {} }, { logger: silentLogger });
    expect(store).toEqual({ channel: 'store', degraded: false });

    const silent = await deliverDecision(signal, makeDecision('SILENT'), {}, { logger: silentLogger });
    expect(silent).toEqual({ channel: 'none', degraded: false });

    const placeholder = await deliverDecision(signal, makeDecision('PREPARE'), {}, { logger: silentLogger });
    expect(placeholder.channel).toBe('none');
    expect(placeholder.degraded).toBe(false);
  });
});

describe('降级路径 3：判断层配置错误 → 回退「仅播报评分 >85」', () => {
  it('配置体检：合法通过；非法字段列入描述', () => {
    expect(validateGatesConfig(DEFAULT_GATES_CONFIG)).toBeNull();
    expect(validateGatesConfig(undefined)).toContain('config 缺失');
    expect(validateGatesConfig({ ...DEFAULT_GATES_CONFIG, baseDailyBudget: 999 })).toContain('baseDailyBudget');
    const brokenFocus = {
      ...DEFAULT_GATES_CONFIG,
      focusWindows: undefined as unknown as typeof DEFAULT_GATES_CONFIG.focusWindows,
    };
    expect(validateGatesConfig(brokenFocus)).toContain('focusWindows');
  });

  it('配置非法：非紧急落 STORE，>85 仍可 SPEAK（带 degraded 标记）', () => {
    const state = createGatesState({ now: DAY, config: { disruptionThreshold: Number.NaN } });
    const normal = decideSafely(makeSignal(70, 'k-norm'), state, silentLogger);
    expect(normal.degraded).toBe(true);
    expect(normal.configError).toContain('disruptionThreshold');
    expect(normal.decision.tier).toBe('STORE');
    expect(normal.decision.reason).toBe('budget_exhausted');

    const urgent = decideSafely(makeSignal(96, 'k-urgent'), state, silentLogger);
    expect(urgent.degraded).toBe(true);
    expect(urgent.decision.tier).toBe('SPEAK');
    expect(urgent.decision.reason).toBe('urgent');
    expect(urgent.decision.delta.dailySpokenDelta).toBe(1);
  });

  it('判定抛错（病态环境快照）→ 保守回退而非外抛', () => {
    const env = Object.defineProperty({}, 'speaking', {
      get() {
        throw new Error('env爆炸');
      },
    }) as EnvironmentContext;
    const state: GatesState = { ...createGatesState({ now: DAY }), env };
    const guarded = decideSafely(makeSignal(70, 'k-throw'), state, silentLogger);
    expect(guarded.degraded).toBe(true);
    expect(guarded.configError).toBe('env爆炸');
    expect(guarded.decision.tier).toBe('STORE');
    expect(guarded.decision.disruption).toBe(100);
  });
});
