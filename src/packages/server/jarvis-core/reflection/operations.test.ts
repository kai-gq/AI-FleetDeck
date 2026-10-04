/**
 * jarvis-core/reflection · 四操作 + Tier 划分单测（任务 28 ⑤.3/⑤.4/⑥）
 *
 * 覆盖：Tier 规则矩阵（NEW/UPDATE/DELETE/PROMOTE 逐规则 + 边界 30 天 / use_count
 * 10/11）、拒绝路径（不吞不假）、判别器（决定类 / 矛盾启发式 / 高置信）、首次运行
 * 强制 Tier2、opId 确定性、应用执行器（真实 FileMemoryStore 临时目录 + 失败桩）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileMemoryStore, type MemoryStore } from '../memory/index.js';
import {
  applyReflectionOperations,
  countOperationKinds,
  findContradictions,
  isDecisionText,
  isHighConfidenceEntry,
  planReflection,
  type ReflectionIngestBundle,
  type ReflectionPlan,
  type ReflectionPlanOptions,
  type ReflectionProposalBundle,
} from './index.js';
import {
  DAY_MS,
  FIXTURE_NOW,
  fixtureByName,
  ingestOf,
  makeEntry,
  type ReflectionFixture,
} from './__fixtures__/reflection-fixtures.js';
import { stableStringify } from './__fixtures__/golden-utils.js';

// ============================================================================
// 便捷构造
// ============================================================================

function ingestWith(parts: Partial<ReflectionFixture> = {}): ReflectionIngestBundle {
  return ingestOf({ name: 'inline', description: '', sessionCount: 5, sessions: [], proposals: {}, ...parts });
}

function planWith(
  proposals: ReflectionProposalBundle,
  parts: Partial<ReflectionFixture> = {},
  options: Partial<ReflectionPlanOptions> = {},
): ReflectionPlan {
  return planReflection(proposals, ingestWith(parts), { now: FIXTURE_NOW, ...options });
}

const staleEntry = makeEntry({
  id: 'lt-stale',
  text: '旧调研记录：方案 C 待清理',
  updatedAt: FIXTURE_NOW - 31 * DAY_MS,
});

// ============================================================================
// NEW
// ============================================================================

describe('Tier 划分 · NEW', () => {
  it('低置信新增（缺省）→ Tier1 new-low-confidence，载荷落 long-term 并带置信度标签', () => {
    const plan = planWith({ newEntries: [{ text: '用户习惯先跑测试再提交' }] });
    expect(plan.operations).toHaveLength(1);
    const op = plan.operations[0];
    expect(op.tier).toBe(1);
    expect(op.tierReason).toBe('new-low-confidence');
    expect(op.add).toMatchObject({ layer: 'long-term', source: 'agent-confirmed', confidence: 'low' });
    expect(op.add?.tags).toContain('reflection');
    expect(op.add?.tags).toContain('confidence:low');
  });

  it('显式中/高置信新增 → Tier2 new-needs-review（保守起步：未列明的自动应用一律人工）', () => {
    const plan = planWith({
      newEntries: [
        { text: '中等置信的观察', confidence: 'medium' },
        { text: '高置信的结论', confidence: 'high' },
      ],
    });
    expect(plan.operations.map((op) => [op.tier, op.tierReason])).toEqual([
      [2, 'new-needs-review'],
      [2, 'new-needs-review'],
    ]);
    expect(plan.tier2Rate).toBe(1);
  });

  it('决定类新增（正文标记/kind/tags）→ Tier2 decision-class', () => {
    const plan = planWith({
      newEntries: [
        { text: '决定本月先不接生产反思', confidence: 'low' },
        { text: '分支策略观察', confidence: 'low', kind: 'decision' },
        { text: '端口约定', confidence: 'low', tags: ['decision'] },
      ],
    });
    expect(plan.operations.map((op) => op.tierReason)).toEqual(['decision-class', 'decision-class', 'decision-class']);
    expect(plan.tier2Count).toBe(3);
  });

  it('显式 contradicts 命中 → Tier2 contradiction（即使低置信）', () => {
    const plan = planWith(
      { newEntries: [{ text: '构建工具换成 vite', confidence: 'low', contradicts: ['lt-build'] }] },
      { longTermEntries: [makeEntry({ id: 'lt-build', text: '构建工具是 webpack' })] },
    );
    expect(plan.operations[0].tierReason).toBe('contradiction');
    expect(plan.operations[0].tier).toBe(2);
  });

  it('启发式矛盾（否定/覆盖词 + token 重叠）→ Tier2 contradiction', () => {
    const plan = planWith(
      { newEntries: [{ text: '项目主分支改为 local', confidence: 'low' }] },
      { longTermEntries: [makeEntry({ id: 'lt-master', text: '项目主分支是 master' })] },
    );
    expect(plan.operations[0].tierReason).toBe('contradiction');
  });

  it('无否定信号/无重叠 → 不误报矛盾（Tier1）', () => {
    const plan = planWith(
      { newEntries: [{ text: '夜间反思产物写入 reflections 层', confidence: 'low' }] },
      { longTermEntries: [makeEntry({ id: 'lt-master', text: '项目主分支是 master' })] },
    );
    expect(plan.operations[0].tierReason).toBe('new-low-confidence');
  });

  it('与现存长期知识完全同文 → 拒绝 duplicate-existing', () => {
    const plan = planWith(
      { newEntries: [{ text: '用户偏好使用 pnpm 安装依赖', confidence: 'low' }] },
      { longTermEntries: [makeEntry({ id: 'lt-pnpm', source: 'user-stated', text: '用户偏好使用 pnpm 安装依赖' })] },
    );
    expect(plan.operations).toHaveLength(0);
    expect(plan.rejected).toEqual([{ kind: 'NEW', index: 0, reason: 'duplicate-existing', text: '用户偏好使用 pnpm 安装依赖' }]);
  });

  it('空文本 → 拒绝 empty-text', () => {
    const plan = planWith({ newEntries: [{ text: '   ' }] });
    expect(plan.rejected[0]).toMatchObject({ kind: 'NEW', reason: 'empty-text' });
  });

  it('inferred 来源 → 拒绝 inferred-not-allowed-for-long-term（记忆层硬规则）', () => {
    const plan = planWith({ newEntries: [{ text: '推测：用户可能偏好夜间跑任务', source: 'inferred' }] });
    expect(plan.rejected[0]).toMatchObject({ kind: 'NEW', reason: 'inferred-not-allowed-for-long-term' });
    expect(plan.operations).toHaveLength(0);
  });
});

// ============================================================================
// UPDATE
// ============================================================================

describe('Tier 划分 · UPDATE', () => {
  const base = { longTermEntries: [makeEntry({ id: 'lt-note', text: '会议纪要归档在 D 盘', tags: ['archive'] })] };

  it('元数据整理（仅 tags/kind）→ Tier1 metadata-only', () => {
    const plan = planWith({ updates: [{ id: 'lt-note', tags: ['archive', 'd-drive'] }] }, base);
    expect(plan.operations[0]).toMatchObject({ tier: 1, tierReason: 'metadata-only', targetEntryId: 'lt-note' });
    expect(plan.operations[0].patch).toEqual({ tags: ['archive', 'd-drive'] });
  });

  it('正文更新 → Tier2 update-text-needs-review（语义重写保守起步）', () => {
    const plan = planWith({ updates: [{ id: 'lt-note', text: '会议纪要归档在 E 盘' }] }, base);
    expect(plan.operations[0]).toMatchObject({ tier: 2, tierReason: 'update-text-needs-review' });
  });

  it('与现存内容一致 → 拒绝 no-change', () => {
    const plan = planWith({ updates: [{ id: 'lt-note', text: '会议纪要归档在 D 盘' }] }, base);
    expect(plan.rejected[0]).toMatchObject({ kind: 'UPDATE', reason: 'no-change' });
    expect(plan.operations).toHaveLength(0);
  });

  it('空文本 → 拒绝 empty-text', () => {
    const plan = planWith({ updates: [{ id: 'lt-note', text: '  ' }] }, base);
    expect(plan.rejected[0]).toMatchObject({ kind: 'UPDATE', reason: 'empty-text' });
  });

  it('决定类条目被更新 → Tier2 decision-class（即使只是元数据）', () => {
    const plan = planWith(
      { updates: [{ id: 'lt-decision', tags: ['x'] }] },
      { longTermEntries: [makeEntry({ id: 'lt-decision', kind: 'decision', text: '决定用 local 分支' })] },
    );
    expect(plan.operations[0]).toMatchObject({ tier: 2, tierReason: 'decision-class' });
  });

  it('不存在的 id → 拒绝 entry-not-found', () => {
    const plan = planWith({ updates: [{ id: 'ghost', tags: ['x'] }] }, base);
    expect(plan.rejected[0]).toMatchObject({ kind: 'UPDATE', reason: 'entry-not-found', targetEntryId: 'ghost' });
  });

  it('成长日志 append-only → 拒绝 append-only', () => {
    const plan = planWith(
      { updates: [{ id: 'gl-1', tags: ['x'] }] },
      { growthLogEntries: [makeEntry({ id: 'gl-1', layer: 'growth-log', text: '学会先确认再动手' })] },
    );
    expect(plan.rejected[0]).toMatchObject({ kind: 'UPDATE', reason: 'append-only' });
  });
});

// ============================================================================
// DELETE
// ============================================================================

describe('Tier 划分 · DELETE', () => {
  it('31 天 0 使用 → Tier1 delete-unused-30d', () => {
    const plan = planWith({ deletes: [{ id: 'lt-stale' }] }, { longTermEntries: [staleEntry] });
    expect(plan.operations[0]).toMatchObject({ tier: 1, tierReason: 'delete-unused-30d', targetEntryId: 'lt-stale' });
  });

  it('恰好 30 天 → Tier1（阈值含边界）', () => {
    const plan = planWith(
      { deletes: [{ id: 'lt-30d' }] },
      { longTermEntries: [makeEntry({ id: 'lt-30d', text: '满 30 天', updatedAt: FIXTURE_NOW - 30 * DAY_MS })] },
    );
    expect(plan.operations[0].tierReason).toBe('delete-unused-30d');
  });

  it('29 天未满 → Tier2 delete-not-eligible', () => {
    const plan = planWith(
      { deletes: [{ id: 'lt-29d' }] },
      { longTermEntries: [makeEntry({ id: 'lt-29d', text: '未满 30 天', updatedAt: FIXTURE_NOW - 29 * DAY_MS })] },
    );
    expect(plan.operations[0]).toMatchObject({ tier: 2, tierReason: 'delete-not-eligible' });
  });

  it('高置信（user-stated）31 天仍 → Tier2 delete-high-confidence', () => {
    const plan = planWith(
      { deletes: [{ id: 'lt-user' }] },
      { longTermEntries: [makeEntry({ id: 'lt-user', source: 'user-stated', text: '用户明确要求', updatedAt: FIXTURE_NOW - 31 * DAY_MS })] },
    );
    expect(plan.operations[0]).toMatchObject({ tier: 2, tierReason: 'delete-high-confidence' });
  });

  it('use_count>0 → Tier2 delete-not-eligible（被引用过的不自动删）', () => {
    const plan = planWith(
      { deletes: [{ id: 'lt-used' }] },
      { longTermEntries: [makeEntry({ id: 'lt-used', text: '被用过', useCount: 1, updatedAt: FIXTURE_NOW - 60 * DAY_MS })] },
    );
    expect(plan.operations[0]).toMatchObject({ tier: 2, tierReason: 'delete-not-eligible' });
  });

  it('决定类 → Tier2 decision-class（优先于过期判定）', () => {
    const plan = planWith(
      { deletes: [{ id: 'lt-decision' }] },
      {
        longTermEntries: [
          makeEntry({ id: 'lt-decision', kind: 'decision', text: '决定用 local', updatedAt: FIXTURE_NOW - 90 * DAY_MS }),
        ],
      },
    );
    expect(plan.operations[0]).toMatchObject({ tier: 2, tierReason: 'decision-class' });
  });

  it('成长日志 append-only → 拒绝 append-only', () => {
    const plan = planWith(
      { deletes: [{ id: 'gl-1' }] },
      { growthLogEntries: [makeEntry({ id: 'gl-1', layer: 'growth-log', text: '学会先确认再动手' })] },
    );
    expect(plan.rejected[0]).toMatchObject({ kind: 'DELETE', reason: 'append-only' });
  });
});

// ============================================================================
// PROMOTE
// ============================================================================

describe('Tier 划分 · PROMOTE', () => {
  const makeWorking = (useCount: number) => makeEntry({ id: 'wt-1', layer: 'working', text: '高频复用的构建命令', useCount });

  it('use_count 11 > 10 → Tier1 promote-use-count', () => {
    const plan = planWith({ promotes: [{ id: 'wt-1' }] }, { workingEntries: [makeWorking(11)] });
    expect(plan.operations[0]).toMatchObject({ tier: 1, tierReason: 'promote-use-count', promoteTarget: 'long-term' });
  });

  it('use_count 10 → Tier2 promote-below-threshold（严格大于边界）', () => {
    const plan = planWith({ promotes: [{ id: 'wt-1' }] }, { workingEntries: [makeWorking(10)] });
    expect(plan.operations[0]).toMatchObject({ tier: 2, tierReason: 'promote-below-threshold' });
  });

  it('inferred → 拒绝 inferred-not-promotable（记忆层硬规则）', () => {
    const plan = planWith(
      { promotes: [{ id: 'wt-inf' }] },
      { workingEntries: [makeEntry({ id: 'wt-inf', layer: 'working', source: 'inferred', text: '推测', useCount: 99 })] },
    );
    expect(plan.rejected[0]).toMatchObject({ kind: 'PROMOTE', reason: 'inferred-not-promotable' });
  });

  it('成长日志 → 拒绝 append-only', () => {
    const plan = planWith(
      { promotes: [{ id: 'gl-1' }] },
      { growthLogEntries: [makeEntry({ id: 'gl-1', layer: 'growth-log', text: '学会先确认再动手', useCount: 50 })] },
    );
    expect(plan.rejected[0]).toMatchObject({ kind: 'PROMOTE', reason: 'append-only' });
  });

  it('同层 → 拒绝 already-in-target', () => {
    const plan = planWith(
      { promotes: [{ id: 'lt-x' }] },
      { longTermEntries: [makeEntry({ id: 'lt-x', text: '已是长期知识', useCount: 50 })] },
    );
    expect(plan.rejected[0]).toMatchObject({ kind: 'PROMOTE', reason: 'already-in-target' });
  });

  it('target 非 long-term → 拒绝 invalid-target', () => {
    const plan = planWith({ promotes: [{ id: 'wt-1', target: 'working' }] }, { workingEntries: [makeWorking(20)] });
    expect(plan.rejected[0]).toMatchObject({ kind: 'PROMOTE', reason: 'invalid-target' });
  });

  it('不存在的 id → 拒绝 entry-not-found', () => {
    const plan = planWith({ promotes: [{ id: 'ghost' }] });
    expect(plan.rejected[0]).toMatchObject({ kind: 'PROMOTE', reason: 'entry-not-found', targetEntryId: 'ghost' });
  });
});

// ============================================================================
// 首次运行 + 计划结构
// ============================================================================

describe('首次运行强制 Tier2（未审不下发/不应用）', () => {
  it('firstRun=true：四类操作全部 Tier2 + first-run，本可 Tier1 的项也不例外', () => {
    const plan = planWith(
      {
        newEntries: [{ text: '跨会话重复：每周同步上游' }],
        updates: [{ id: 'lt-note', tags: ['x'] }],
        deletes: [{ id: 'lt-stale' }],
        promotes: [{ id: 'wt-11' }],
      },
      {
        workingEntries: [makeEntry({ id: 'wt-11', layer: 'working', text: '高频命令', useCount: 11 })],
        longTermEntries: [staleEntry, makeEntry({ id: 'lt-note', text: '普通条目' })],
      },
      { firstRun: true },
    );
    expect(plan.operations).toHaveLength(4);
    expect(plan.operations.every((op) => op.tier === 2 && op.tierReason === 'first-run')).toBe(true);
    expect(plan.tier1Count).toBe(0);
    expect(plan.tier2Rate).toBe(1);
  });
});

describe('计划结构（黄金对比锚点）', () => {
  it('opId 确定性：按提案序号，跨类固定顺序 NEW→UPDATE→DELETE→PROMOTE', () => {
    const plan = planWith(
      {
        promotes: [{ id: 'lt-x' }],
        newEntries: [{ text: '甲' }],
        deletes: [{ id: 'lt-x' }],
        updates: [{ id: 'lt-x', tags: ['t'] }],
      },
      { longTermEntries: [makeEntry({ id: 'lt-x', text: '条目' })] },
    );
    // promote lt-x 已同层被拒，operations 顺序仍按 NEW→UPDATE→DELETE→PROMOTE 排列
    expect(plan.operations.map((op) => op.opId)).toEqual(['new-0', 'update-0', 'delete-0']);
  });

  it('tier2Rate = 拦截数/操作数；无操作时为 0', () => {
    const plan = planWith({ newEntries: [{ text: '低置信自动项' }, { text: '决定类项：决定采用 A' }] });
    expect(plan.tier2Rate).toBeCloseTo(0.5, 10);
    expect(planWith({}).tier2Rate).toBe(0);
  });

  it('拒绝登记 index = 提案在同类数组中的位置（拒绝不推进序号；opId 允许留空号）', () => {
    const plan = planWith(
      { promotes: [{ id: 'wt-11' }, { id: 'ghost' }, { id: 'wt-10' }] },
      {
        workingEntries: [
          makeEntry({ id: 'wt-11', layer: 'working', text: '高频复用命令', useCount: 11 }),
          makeEntry({ id: 'wt-10', layer: 'working', text: '常用端口约定', useCount: 10 }),
        ],
      },
    );
    expect(plan.rejected).toEqual([
      { kind: 'PROMOTE', index: 1, reason: 'entry-not-found', targetEntryId: 'ghost' },
    ]);
    // opId 取提案位置：promote-0 与 promote-2（中间的 1 被拒绝占用）
    expect(plan.operations.map((op) => op.opId)).toEqual(['promote-0', 'promote-2']);
  });

  it('countOperationKinds 统计四操作数', () => {
    const plan = planWith(
      {
        newEntries: [{ text: '甲' }],
        updates: [{ id: 'lt-x', tags: ['t'] }],
        deletes: [{ id: 'lt-y' }],
        promotes: [{ id: 'wt-1' }],
      },
      {
        workingEntries: [makeEntry({ id: 'wt-1', layer: 'working', text: '高频', useCount: 11 })],
        longTermEntries: [makeEntry({ id: 'lt-x', text: '条目' }), makeEntry({ id: 'lt-y', text: '旧条目', updatedAt: FIXTURE_NOW - 40 * DAY_MS })],
      },
    );
    expect(countOperationKinds(plan.operations)).toEqual({ NEW: 1, UPDATE: 1, DELETE: 1, PROMOTE: 1 });
  });

  it('稳定序列化：同输入两次计划逐字节一致', () => {
    const fixture = fixtureByName('f05-contradiction');
    const make = () => planReflection(fixture.proposals, ingestOf(fixture), { now: FIXTURE_NOW });
    expect(stableStringify(make())).toBe(stableStringify(make()));
  });
});

// ============================================================================
// 判别器
// ============================================================================

describe('判别器（纯函数）', () => {
  it('isDecisionText：kind/tags/正文标记三类命中', () => {
    expect(isDecisionText('随便一句', 'decision')).toBe(true);
    expect(isDecisionText('随便一句', 'note', ['decision'])).toBe(true);
    expect(isDecisionText('决定采用方案 A')).toBe(true);
    expect(isDecisionText('敲定了端口 7492')).toBe(true);
    expect(isDecisionText('这只是普通记录')).toBe(false);
  });

  it('findContradictions：否定词 + token 重叠命中；无否定词不误报；完全同文不算矛盾', () => {
    const entries = [makeEntry({ id: 'lt-master', text: '项目主分支是 master' })];
    expect(findContradictions('项目主分支改为 local', entries)).toEqual(['lt-master']);
    expect(findContradictions('项目主分支文档已补齐', entries)).toEqual([]);
    expect(findContradictions('项目主分支是 master', entries)).toEqual([]);
    expect(findContradictions('完全无关的新事实', entries)).toEqual([]);
  });

  it('isHighConfidenceEntry：仅 user-stated 为高置信', () => {
    expect(isHighConfidenceEntry(makeEntry({ id: 'a', text: 'x', source: 'user-stated' }))).toBe(true);
    expect(isHighConfidenceEntry(makeEntry({ id: 'b', text: 'x', source: 'agent-confirmed' }))).toBe(false);
    expect(isHighConfidenceEntry(makeEntry({ id: 'c', text: 'x', source: 'inferred' }))).toBe(false);
  });
});

// ============================================================================
// 应用执行器（真实 FileMemoryStore 临时目录）
// ============================================================================

describe('applyReflectionOperations（真实存储）', () => {
  let baseDir: string;
  let store: FileMemoryStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-ops-'));
    store = new FileMemoryStore({ baseDir, now: () => FIXTURE_NOW });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('NEW 应用：落 long-term（保守缺省来源 agent-confirmed）', async () => {
    const plan = planWith({ newEntries: [{ text: '用户习惯先跑测试再提交' }] });
    const [result] = await applyReflectionOperations(store, plan.operations);
    expect(result).toMatchObject({ opId: 'new-0', applied: true });
    const entries = await store.query({ layer: 'long-term' });
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('用户习惯先跑测试再提交');
    expect(entries[0].tags).toContain('reflection');
  });

  it('UPDATE 应用：patch 生效且保留 id', async () => {
    const seeded = await store.add({ layer: 'long-term', source: 'agent-confirmed', text: '会议纪要归档在 D 盘' });
    const plan = planReflection(
      { updates: [{ id: seeded.id, tags: ['archive'] }] },
      ingestWith({ longTermEntries: [seeded] }),
      { now: FIXTURE_NOW },
    );
    const [result] = await applyReflectionOperations(store, plan.operations);
    expect(result.applied).toBe(true);
    const [entry] = await store.query({ layer: 'long-term' });
    expect(entry.id).toBe(seeded.id);
    expect(entry.tags).toEqual(['archive']);
  });

  it('DELETE 应用：条目物理移除（31 天 0 使用 → Tier1）', async () => {
    const seeded = await store.add({ layer: 'long-term', source: 'agent-confirmed', text: '待删条目' });
    const stale = { ...seeded, updatedAt: FIXTURE_NOW - 31 * DAY_MS };
    const plan = planReflection({ deletes: [{ id: stale.id }] }, ingestWith({ longTermEntries: [stale] }), {
      now: FIXTURE_NOW,
    });
    expect(plan.operations[0].tier).toBe(1);
    const [result] = await applyReflectionOperations(store, plan.operations);
    expect(result.applied).toBe(true);
    expect(await store.query({ layer: 'long-term' })).toHaveLength(0);
  });

  it('PROMOTE 应用：working → long-term', async () => {
    const seeded = await store.add({ layer: 'working', source: 'agent-confirmed', text: '高频复用的构建命令' });
    const plan = planReflection(
      { promotes: [{ id: seeded.id }] },
      ingestWith({ workingEntries: [{ ...seeded, useCount: 11 }] }),
      { now: FIXTURE_NOW },
    );
    expect(plan.operations[0].tier).toBe(1);
    const [result] = await applyReflectionOperations(store, plan.operations);
    expect(result.applied).toBe(true);
    expect(await store.query({ layer: 'working' })).toHaveLength(0);
    const longTerm = await store.query({ layer: 'long-term' });
    expect(longTerm[0]).toMatchObject({ id: seeded.id, promotedFrom: 'working' });
  });

  it('tiers 选择器：只应用 Tier1，Tier2 不碰存储（未审不应用）', async () => {
    const plan = planWith({
      newEntries: [{ text: '低置信自动项' }, { text: '决定类项：决定采用 A' }],
    });
    expect(plan.operations.map((op) => op.tier)).toEqual([1, 2]);
    const results = await applyReflectionOperations(store, plan.operations, { tiers: [1] });
    expect(results).toHaveLength(1);
    expect(results[0].applied).toBe(true);
    const entries = await store.query({ layer: 'long-term' });
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('低置信自动项');
  });

  it('opIds 选择器：只应用指定操作', async () => {
    const plan = planWith({ newEntries: [{ text: '甲项' }, { text: '乙项' }] });
    expect(plan.operations).toHaveLength(2);
    const results = await applyReflectionOperations(store, plan.operations, { opIds: ['new-1'] });
    expect(results).toHaveLength(1);
    expect(results[0].opId).toBe('new-1');
    const entries = await store.query({ layer: 'long-term' });
    expect(entries.map((e) => e.text)).toEqual(['乙项']);
  });

  it('存储抛错 → applied:false + error，执行器不抛（不吞不假）', async () => {
    const failing = {
      add: async () => {
        throw new Error('disk full');
      },
      update: async () => null,
      delete: async () => false,
      promote: async () => null,
      query: async () => [],
      list: async () => [],
    } satisfies MemoryStore;
    const plan = planWith({ newEntries: [{ text: '会失败的新增' }] });
    const [result] = await applyReflectionOperations(failing, plan.operations);
    expect(result).toMatchObject({ applied: false, reason: 'error', error: 'disk full' });
  });
});
