/**
 * 任务23 · 团队记忆服务测试：
 * ① 五要素视图（完成/在办/无卡回退/排序）
 * ② 资产条目映射（确定性 + 只在完成事件写 + 坑收集）
 * ③ 命中摘要（分词/正负例/排序/上限/fail-open/开关）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ASSET_HIT_MAX_ITEMS,
  appendDecisionToAssetLibrary,
  buildAssetHitBlock,
  buildTeamMemoryEntries,
  collectPitfalls,
  decisionToAssetEntry,
  entryFromDecision,
  findAssetHits,
  formatDuration,
  renderAssetHitBlock,
  tokenizeForHits,
} from './team-memory-service.js';
import type { DelegationDecision } from '../../shared/types.js';
import { setTeamAssetStoreForTests, type TeamAssetEntry, type TeamAssetStore, type AssetAppendResult } from './team-asset-store.js';

// ─── fixtures ───

function makeDecision(overrides: Partial<DelegationDecision> = {}): DelegationDecision {
  return {
    id: 'd-1',
    timestamp: 1_000_000,
    bossId: 'boss-1',
    userCommand: '做个登录页',
    selectedAgentId: 'agent-1',
    selectedAgentName: '小刘',
    reasoning: 'builder 空闲且熟悉前端',
    alternativeAgents: [],
    confidence: 'high',
    status: 'completed',
    taskCard: {
      objective: '实现登录页',
      acceptanceCriteria: ['lint:types 通过', '单测覆盖登录回退'],
      dependencies: [],
      status: 'done',
    },
    completion: {
      completedAt: 1_038_500,
      durationMs: 38_500,
      result: 'completed',
      summary: '登录页完成并通过验收',
      outputLocation: 'src/pages/login.tsx',
    },
    ...overrides,
  };
}

/** 内存 fake store（服务层测试用；与 FileTeamAssetStore 同接口）。 */
function fakeStore(initial: TeamAssetEntry[] = []): TeamAssetStore & { entries: TeamAssetEntry[] } {
  const entries = [...initial];
  return {
    entries,
    append(entry: TeamAssetEntry): AssetAppendResult {
      if (entries.some((e) => e.decisionId === entry.decisionId)) return { appended: false, reason: 'duplicate' };
      entries.push(entry);
      return { appended: true };
    },
    list: () => [...entries],
    has: (id: string) => entries.some((e) => e.decisionId === id),
  };
}

const ENV_KEY = 'TC_TEAM_MEMORY';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  setTeamAssetStoreForTests(null);
});

// ─── ① 五要素视图 ───

describe('五要素统一视图', () => {
  it('完成条目:谁/何时/做了什么/为什么/产出在哪 全要素可查（验收①）', () => {
    const entry = entryFromDecision(makeDecision(), { bossId: 'boss-1', bossName: '王经理' });

    expect(entry.who).toEqual({ agentId: 'agent-1', agentName: '小刘' });
    expect(entry.when).toEqual({ delegatedAt: 1_000_000, completedAt: 1_038_500, durationMs: 38_500 });
    expect(entry.what).toEqual({ objective: '实现登录页', status: 'completed' });
    expect(entry.why).toEqual({
      userCommand: '做个登录页',
      reasoning: 'builder 空闲且熟悉前端',
      confidence: 'high',
    });
    expect(entry.where).toEqual({ outputLocation: 'src/pages/login.tsx', summary: '登录页完成并通过验收' });
    expect(entry.outcome.result).toBe('completed');
    expect(entry.outcome.acceptanceCriteria).toEqual(['lint:types 通过', '单测覆盖登录回退']);
    expect(entry.bossName).toBe('王经理');
  });

  it('无卡旧记录:objective 回退用户原话;无 completion 时 where 为空（如实缺省不编造）', () => {
    const entry = entryFromDecision(makeDecision({ taskCard: undefined, completion: undefined, status: 'sent' }));
    expect(entry.what.objective).toBe('做个登录页');
    expect(entry.what.status).toBe('sent');
    expect(entry.where).toEqual({});
    expect(entry.outcome.result).toBeUndefined();
  });

  it('buildTeamMemoryEntries:追踪中标记 in-flight + 补史外活跃条目 + 时间倒序', () => {
    const done = makeDecision({ id: 'd-done', timestamp: 1_000, completion: { completedAt: 2_000, durationMs: 1_000, result: 'completed' } });
    const inflight = makeDecision({ id: 'd-inflight', timestamp: 3_000, completion: undefined, status: 'sent', taskCard: undefined });
    const old = makeDecision({ id: 'd-old', timestamp: 500, completion: { completedAt: 600, durationMs: 100, result: 'failed' } });

    const entries = buildTeamMemoryEntries([
      {
        bossId: 'boss-1',
        bossName: '王经理',
        histories: [done, inflight, old],
        live: [
          { bossId: 'boss-1', subordinateId: 'agent-1', taskDescription: '做个登录页', decisionId: 'd-inflight' },
          { bossId: 'boss-1', subordinateId: 'agent-9', subordinateName: '李四', taskDescription: '修一下导航' },
        ],
      },
    ]);

    // 时间倒序：in-flight(委托时刻 3000) > done(完成 2000) > old(完成 600) > 史外追踪(时刻缺省 0)
    expect(entries.map((e) => e.decisionId)).toEqual(['d-inflight', 'd-done', 'd-old', 'live:agent-9']);
    expect(entries.find((e) => e.decisionId === 'd-inflight')!.what.status).toBe('in-flight');
    expect(entries.find((e) => e.decisionId === 'd-done')!.what.status).toBe('completed');
    expect(entries.find((e) => e.decisionId === 'd-old')!.what.status).toBe('failed');
    const liveOnly = entries.find((e) => e.decisionId === 'live:agent-9')!;
    expect(liveOnly.who.agentName).toBe('李四');
    expect(liveOnly.what.objective).toBe('修一下导航');
  });

  it('collectPitfalls:失败原因 + 未打勾验收项;全绿时缺省', () => {
    const failed = makeDecision({
      completion: {
        completedAt: 2_000,
        durationMs: 1_000,
        result: 'failed',
        reason: 'turn-complete',
        summary: '依赖接口超时',
        acceptance: [
          { item: 'lint:types 通过', done: true },
          { item: '单测覆盖登录回退', done: false },
        ],
      },
    });
    expect(collectPitfalls(failed)).toEqual(['失败(turn-complete)', '依赖接口超时', '未打勾:单测覆盖登录回退']);
    expect(collectPitfalls(makeDecision())).toBeUndefined();
  });
});

// ─── ② 资产条目映射 + 入库钩子 ───

describe('资产条目映射与入库', () => {
  it('只在完成/失败事件写:无 completion → 不产条目（确定性规则）', () => {
    expect(decisionToAssetEntry(makeDecision({ completion: undefined }))).toBeNull();

    const store = fakeStore();
    setTeamAssetStoreForTests(store);
    expect(appendDecisionToAssetLibrary(makeDecision({ completion: undefined }))).toBe(false);
    expect(store.entries).toHaveLength(0);
  });

  it('完成事件 → 条目字段（路径/决策/坑/耗时）+ 入库一次;重复决策幂等拒绝', () => {
    const store = fakeStore();
    setTeamAssetStoreForTests(store);

    expect(appendDecisionToAssetLibrary(makeDecision())).toBe(true);
    expect(store.entries).toHaveLength(1);
    const entry = store.entries[0];
    expect(entry).toMatchObject({
      decisionId: 'd-1',
      bossId: 'boss-1',
      agentName: '小刘',
      objective: '实现登录页',
      userCommand: '做个登录页',
      reasoning: 'builder 空闲且熟悉前端',
      acceptanceCriteria: ['lint:types 通过', '单测覆盖登录回退'],
      outputLocation: 'src/pages/login.tsx',
      outcome: 'completed',
      durationMs: 38_500,
    });

    // 二次到达（幂等重放）→ 静默拒绝,不双写
    expect(appendDecisionToAssetLibrary(makeDecision())).toBe(false);
    expect(store.entries).toHaveLength(1);
  });

  it('超长文本截断（单条资产长度有界）', () => {
    const long = '回'.repeat(500);
    const entry = decisionToAssetEntry(
      makeDecision({ userCommand: long, taskCard: undefined, reasoning: long }),
      { now: 42 }
    )!;
    expect(entry.objective.endsWith('…')).toBe(true);
    expect(entry.objective.length).toBeLessThanOrEqual(201);
    expect(entry.userCommand.length).toBeLessThanOrEqual(201);
    expect(entry.reasoning.length).toBeLessThanOrEqual(201);
    expect(entry.recordedAt).toBe(42);
  });

  it('TC_TEAM_MEMORY=0 → 入库关停（视图纯函数不受影响）', () => {
    process.env[ENV_KEY] = '0';
    const store = fakeStore();
    setTeamAssetStoreForTests(store);
    expect(appendDecisionToAssetLibrary(makeDecision())).toBe(false);
    expect(store.entries).toHaveLength(0);
    expect(entryFromDecision(makeDecision()).who.agentName).toBe('小刘');
  });
});

// ─── ③ 命中摘要 ───

function makeAsset(overrides: Partial<TeamAssetEntry> = {}): TeamAssetEntry {
  return {
    decisionId: 'd-asset-1',
    bossId: 'boss-1',
    agentId: 'agent-1',
    agentName: '小刘',
    objective: '实现登录页',
    userCommand: '做个登录页',
    reasoning: 'builder 空闲',
    acceptanceCriteria: ['lint:types 通过'],
    outputLocation: 'src/pages/login.tsx',
    durationMs: 38_500,
    outcome: 'completed',
    completedAt: Date.UTC(2026, 9, 5),
    recordedAt: Date.UTC(2026, 9, 5),
    ...overrides,
  };
}

describe('资产命中检索', () => {
  it('分词:二字组 + 整串;套话停用词被过滤', () => {
    const tokens = tokenizeForHits('帮我看看登录页');
    expect(tokens).toContain('登录');
    expect(tokens).toContain('登录页');
    expect(tokens).not.toContain('帮我');
    expect(tokens).not.toContain('看看');
  });

  it('命中:相关任务能查回（中文二字组）;无关文本不命中', () => {
    const hits = findAssetHits([makeAsset()], '登录页还有个回退的 bug 要修');
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.decisionId).toBe('d-asset-1');

    expect(findAssetHits([makeAsset()], '帮我订一张去北京的机票')).toEqual([]);
    expect(findAssetHits([makeAsset()], '好的')).toEqual([]);
  });

  it('排序:分数降序 → 完成时间降序;条数上限', () => {
    const low = makeAsset({ decisionId: 'd-low', objective: '登录页样式微调', completedAt: 100 });
    const highOld = makeAsset({ decisionId: 'd-high-old', objective: '实现登录页与回退逻辑', completedAt: 100 });
    const highNew = makeAsset({ decisionId: 'd-high-new', objective: '实现登录页与回退逻辑', completedAt: 200 });

    const hits = findAssetHits([low, highOld, highNew], '登录页回退');
    expect(hits.map((h) => h.entry.decisionId)).toEqual(['d-high-new', 'd-high-old', 'd-low']);

    expect(findAssetHits([low, highOld, highNew], '登录页回退', { maxHits: 1 })).toHaveLength(1);
    expect(ASSET_HIT_MAX_ITEMS).toBe(3);
  });

  it('渲染:无命中 → null;有命中含日期/执行者/产出;行/总长上限生效', () => {
    expect(renderAssetHitBlock([])).toBeNull();

    const block = renderAssetHitBlock(findAssetHits([makeAsset()], '登录页回退'))!;
    expect(block).toContain('【团队资产命中】');
    expect(block).toContain('2026-10-05');
    expect(block).toContain('小刘');
    expect(block).toContain('src/pages/login.tsx');
    expect(block).toContain('完成');

    // 总长上限：小上限时整行丢弃（宁缺毋滥）
    const tiny = renderAssetHitBlock(findAssetHits([makeAsset()], '登录页回退'), { maxChars: 10 });
    expect(tiny).toBeNull();
  });

  it('formatDuration 确定性', () => {
    expect(formatDuration(500)).toBe('不足1秒');
    expect(formatDuration(38_500)).toBe('39秒');
    expect(formatDuration(150_000)).toBe('3分钟');
    expect(formatDuration(7_200_000)).toBe('2.0小时');
  });

  it('buildAssetHitBlock 走单例 store;开关关停返回 null（fail-open 不抛）', () => {
    const store = fakeStore([makeAsset()]);
    setTeamAssetStoreForTests(store);
    expect(buildAssetHitBlock('登录页回退')).toContain('【团队资产命中】');
    expect(buildAssetHitBlock('无关内容')).toBeNull();

    process.env[ENV_KEY] = '0';
    expect(buildAssetHitBlock('登录页回退')).toBeNull();
  });
});
