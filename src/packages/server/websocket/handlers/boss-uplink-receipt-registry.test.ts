/**
 * 任务40 ⑥1/⑥4/⑥5 单测：上行登记簿（登记/消费/过期/上限/单槽/截断）
 * + 就绪判定真值表（canFireBossUplink）+ 开关单一真源。
 * 仅 mock boss-response-handler.listActiveDelegations（避免真实委派史 IO）；
 * pending-receipt-registry 用真模块（unmatched 计数来源）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./boss-response-handler.js', () => ({
  listActiveDelegations: vi.fn(() => []),
}));

import {
  canFireBossUplink,
  collectBossUplinkState,
  createBossUplinkRegistry,
  isBossUplinkReceiptEnabled,
  peekBossUplinkReceipt,
  registerBossUplinkReceipt,
  resetBossUplinksForTests,
  DEFAULT_BOSS_UPLINK_TTL_MS,
} from './boss-uplink-receipt-registry.js';
import {
  DEFAULT_RECEIPT_TTL_MS,
  matchPendingReceipt,
  registerPendingReceipt,
  resetPendingReceiptsForTests,
} from './pending-receipt-registry.js';
import { listActiveDelegations } from './boss-response-handler.js';

type EntryInput = Parameters<typeof registerBossUplinkReceipt>[0];

function makeEntry(overrides: Partial<EntryInput> = {}): EntryInput {
  return { bossId: 'boss-1', taskSummary: '实现登录页', taskId: 't-1', ...overrides };
}

describe('createBossUplinkRegistry', () => {
  it('TTL 常量与 08 同口径（防止未来漂移）', () => {
    expect(DEFAULT_BOSS_UPLINK_TTL_MS).toBe(DEFAULT_RECEIPT_TTL_MS);
  });

  it('登记后 peek/has 命中；consume 消费即删（二次消费 undefined）', () => {
    const registry = createBossUplinkRegistry();
    registry.register(makeEntry({ registeredAt: 1000 }));
    expect(registry.has('boss-1', 1500)).toBe(true);
    expect(registry.peek('boss-1', 1500)?.taskId).toBe('t-1');

    const consumed = registry.consume('boss-1', 2000);
    expect(consumed?.taskSummary).toBe('实现登录页');
    expect(registry.has('boss-1', 2000)).toBe(false);
    expect(registry.consume('boss-1', 2000)).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it('同 boss 重复登记覆盖（单槽——最近一次派活为准），registeredAt 更新', () => {
    const registry = createBossUplinkRegistry();
    registry.register(makeEntry({ registeredAt: 1000 }));
    registry.register(makeEntry({ taskId: 't-2', taskSummary: '修复构建失败', registeredAt: 3000 }));
    expect(registry.size()).toBe(1);
    expect(registry.peek('boss-1', 3500)).toMatchObject({
      taskId: 't-2',
      taskSummary: '修复构建失败',
      registeredAt: 3000,
    });
  });

  it('过期条目：peek/consume 惰性清扫返回 undefined', () => {
    const registry = createBossUplinkRegistry({ ttlMs: 1000 });
    registry.register(makeEntry({ registeredAt: 1000 }));
    expect(registry.peek('boss-1', 2500)).toBeUndefined();
    expect(registry.size()).toBe(0);
    expect(registry.consume('boss-1', 2500)).toBeUndefined();
  });

  it('register 时同样惰性清扫（无定时器、内存有界）', () => {
    const registry = createBossUplinkRegistry({ ttlMs: 1000 });
    registry.register(makeEntry({ registeredAt: 1000 }));
    registry.register(makeEntry({ bossId: 'boss-2', registeredAt: 3000 }));
    expect(registry.size()).toBe(1); // boss-1 已过期被清
    expect(registry.has('boss-2', 3100)).toBe(true);
  });

  it('上限驱逐最旧（显式找最旧，不受覆盖登记打乱迭代序影响）', () => {
    const registry = createBossUplinkRegistry({ maxEntries: 2 });
    registry.register(makeEntry({ bossId: 'boss-a', registeredAt: 1000 }));
    registry.register(makeEntry({ bossId: 'boss-b', registeredAt: 2000 }));
    registry.register(makeEntry({ bossId: 'boss-c', registeredAt: 3000 }));
    expect(registry.size()).toBe(2);
    expect(registry.has('boss-a', 3000)).toBe(false); // 最旧被驱逐
    expect(registry.has('boss-b', 3000)).toBe(true);
    expect(registry.has('boss-c', 3000)).toBe(true);
  });

  it('摘要截断：空白压缩 + 80 截断 + …（与 08 同规则同常量）', () => {
    const registry = createBossUplinkRegistry();
    registry.register(makeEntry({ taskSummary: '  多行\n文本   带空白  ' }));
    expect(registry.peek('boss-1')?.taskSummary).toBe('多行 文本 带空白');

    registry.register(makeEntry({ bossId: 'boss-2', taskSummary: '任'.repeat(120) }));
    const truncated = registry.peek('boss-2')?.taskSummary ?? '';
    expect(truncated.length).toBe(81); // 80 字 + …
    expect(truncated.endsWith('…')).toBe(true);
  });

  it('remove 命中/未命中（撤回清理钩子备用，v1 不接线）', () => {
    const registry = createBossUplinkRegistry();
    registry.register(makeEntry({ registeredAt: 1000 }));
    expect(registry.remove('boss-1')).toBe(true);
    expect(registry.remove('boss-1')).toBe(false);
  });

  it('list 返回拷贝快照（外部修改不影响账本）', () => {
    const registry = createBossUplinkRegistry();
    registry.register(makeEntry({ registeredAt: 1000 }));
    const snapshot = registry.list(1500);
    expect(snapshot).toHaveLength(1);
    snapshot[0].taskSummary = '被外部改写';
    expect(registry.peek('boss-1', 1500)?.taskSummary).toBe('实现登录页');
  });

  it('可选字段缺省不落键（projectId/taskId/sessionId）', () => {
    const registry = createBossUplinkRegistry();
    registry.register({ bossId: 'boss-1', taskSummary: '无卡派活', registeredAt: 1000 });
    const entry = registry.peek('boss-1', 1000)!;
    expect('projectId' in entry).toBe(false);
    expect('taskId' in entry).toBe(false);
    expect('sessionId' in entry).toBe(false);
  });
});

describe('canFireBossUplink 真值表（纯函数）', () => {
  it.each([
    ['无在飞无未匹配 → 可交付', { inFlight: 0, unmatched: 0 }, true],
    ['有在飞委派 → 不可交付', { inFlight: 1, unmatched: 0 }, false],
    ['有未匹配下属回执 → 不可交付', { inFlight: 0, unmatched: 1 }, false],
    ['在飞与未匹配并存 → 不可交付', { inFlight: 2, unmatched: 3 }, false],
  ])('%s', (_label, state, expected) => {
    expect(canFireBossUplink(state)).toBe(expected);
  });
});

describe('collectBossUplinkState（真实单例组合：在飞 + 未匹配）', () => {
  beforeEach(() => {
    resetBossUplinksForTests();
    resetPendingReceiptsForTests();
    vi.mocked(listActiveDelegations).mockReturnValue([]);
  });

  it('无在飞无未匹配 → canFire true（链路真收口）', () => {
    expect(collectBossUplinkState('boss-1')).toEqual({ inFlight: 0, unmatched: 0 });
    expect(canFireBossUplink(collectBossUplinkState('boss-1'))).toBe(true);
  });

  it('模块级单例：登记后 peek 可见、reset 清空（测试隔离入口）', () => {
    registerBossUplinkReceipt(makeEntry({ registeredAt: 1000 }));
    expect(peekBossUplinkReceipt('boss-1', 1000)?.taskId).toBe('t-1');
    resetBossUplinksForTests();
    expect(peekBossUplinkReceipt('boss-1', 1000)).toBeUndefined();
  });

  it('按 bossId 过滤在飞委派（他 boss 的不计入）', () => {
    vi.mocked(listActiveDelegations).mockReturnValue([
      { subordinateId: 'agent-1', bossId: 'boss-1', taskDescription: 'a' },
      { subordinateId: 'agent-2', bossId: 'boss-1', taskDescription: 'b' },
      { subordinateId: 'agent-3', bossId: 'boss-2', taskDescription: 'c' },
    ] as any);
    expect(collectBossUplinkState('boss-1').inFlight).toBe(2);
    expect(collectBossUplinkState('boss-2').inFlight).toBe(1);
  });

  it('未匹配下属回执计入；已匹配（matchedAt 置位）不计', () => {
    registerPendingReceipt({ targetAgentId: 'agent-1', bossId: 'boss-1', taskSummary: '未回' });
    registerPendingReceipt({ targetAgentId: 'agent-2', bossId: 'boss-1', taskSummary: '已回' });
    matchPendingReceipt('agent-2', 500); // 完成事件已匹配（条目保留供第二入口，但不计未匹配）

    const state = collectBossUplinkState('boss-1');
    expect(state).toEqual({ inFlight: 0, unmatched: 1 });
    expect(canFireBossUplink(state)).toBe(false);
  });
});

describe('isBossUplinkReceiptEnabled（单一真源，登记与触发共用）', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('缺省/非 0 → 开；=0 → 关（全链逐字回退开关）', () => {
    const saved = process.env.TC_VOICE_BOSS_RECEIPT;
    delete process.env.TC_VOICE_BOSS_RECEIPT;
    expect(isBossUplinkReceiptEnabled()).toBe(true); // 未设 = 缺省开
    process.env.TC_VOICE_BOSS_RECEIPT = '1';
    expect(isBossUplinkReceiptEnabled()).toBe(true);
    process.env.TC_VOICE_BOSS_RECEIPT = '0';
    expect(isBossUplinkReceiptEnabled()).toBe(false);
    if (saved === undefined) delete process.env.TC_VOICE_BOSS_RECEIPT;
    else process.env.TC_VOICE_BOSS_RECEIPT = saved;
  });
});
