/**
 * jarvis-core/reflection · 黄金回归测试（任务 28 ⑥、06-11 §13.3）
 *
 * 10 组固定历史会话样本（__fixtures__/reflection-fixtures.ts）+ 确定性
 * planReflection（纯函数）→ planSnapshot → stableStringify 与黄金文件
 * __fixtures__/reflection-golden.json **逐字节对比**。全程无时钟/随机/网络
 * 依赖（FIXTURE_NOW 固定、无 LLM 调用——对比的是「计划」而非提案生成）。
 *
 * 黄金文件首次生成：REFLECTION_GOLDEN_UPDATE=1 npx vitest run <本文件>
 * （生成后必须人工复核 Tier 归属是否符合设计，模板见各 fixture 注释）。
 *
 * 稳定性与拦截断言：
 *   · 同输入重复计划 10 次 → 快照逐字节一致（Tier2 拦截集合恒等）；
 *   · 安全样本 f01/f02/f03 零 Tier2（无误伤）；f10 首次运行拦截率 = 1；
 *   · 混合样本 0 < tier2Rate < 1（拦截率作为运行结果字段输出，供 ⑮）。
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planReflection, type ReflectionPlan } from './index.js';
import { FIXTURE_NOW, REFLECTION_FIXTURES, fixtureByName, ingestOf } from './__fixtures__/reflection-fixtures.js';
import { stableStringify, planSnapshot, type PlanSnapshot } from './__fixtures__/golden-utils.js';

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'reflection-golden.json');

/** 单组样本 → 计划（fixture 自带 firstRun 透传；时刻固定）。 */
function planFixture(name: string): ReflectionPlan {
  const fixture = fixtureByName(name);
  return planReflection(fixture.proposals, ingestOf(fixture), {
    now: FIXTURE_NOW,
    firstRun: fixture.firstRun === true,
  });
}

/** 全样本快照表（黄金对比单元）。 */
function snapshotMap(): Record<string, PlanSnapshot> {
  const out: Record<string, PlanSnapshot> = {};
  for (const fixture of REFLECTION_FIXTURES) {
    out[fixture.name] = planSnapshot(planFixture(fixture.name));
  }
  return out;
}

describe('黄金回归（10 组固定样本）', () => {
  it('黄金对比：10 组样本计划快照逐字节一致', () => {
    const current = stableStringify(snapshotMap());
    if (process.env.REFLECTION_GOLDEN_UPDATE === '1') {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, `${current}\n`, 'utf-8');
    }
    expect(fs.existsSync(GOLDEN_PATH)).toBe(true);
    const golden = fs.readFileSync(GOLDEN_PATH, 'utf-8');
    expect(current).toBe(golden.endsWith('\n') ? golden.slice(0, -1) : golden);
  });

  it('确定性：同输入重复计划 10 次 → 快照逐字节一致、Tier2 集合恒等', () => {
    const baseline = stableStringify(snapshotMap());
    const tier2Baseline = Object.entries(snapshotMap())
      .map(([name, snap]) => [name, snap.operations.filter((op) => op.tier === 2).map((op) => op.opId).join(',')])
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 0; i < 10; i += 1) {
      const snapshot = snapshotMap();
      expect(stableStringify(snapshot)).toBe(baseline);
      const tier2 = Object.entries(snapshot)
        .map(([name, snap]) => [name, snap.operations.filter((op) => op.tier === 2).map((op) => op.opId).join(',')])
        .sort((a, b) => a[0].localeCompare(b[0]));
      expect(tier2).toEqual(tier2Baseline);
    }
  });

  it('安全样本零 Tier2 误伤（f01/f02/f03 连续 10 次运行拦截恒为 0）', () => {
    const safe = ['f01-multi-session-pattern', 'f02-empty-sessions', 'f03-short-summaries'];
    for (let i = 0; i < 10; i += 1) {
      for (const name of safe) {
        const plan = planFixture(name);
        expect(plan.tier2Count).toBe(0);
        expect(plan.operations.filter((op) => op.tier === 2)).toEqual([]);
      }
    }
    // f01 确实产出了 Tier1 操作（不是「空转即安全」）
    expect(planFixture('f01-multi-session-pattern').tier1Count).toBe(2);
  });

  it('Tier2 拦截率：f10 首次运行 = 1；f05 混合样本 0 < rate < 1；f02 空样本 = 0', () => {
    expect(planFixture('f10-first-run').tier2Rate).toBe(1);
    expect(planFixture('f10-first-run').tier2Count).toBe(4);
    const mixed = planFixture('f05-contradiction');
    expect(mixed.tier2Rate).toBeGreaterThan(0);
    expect(mixed.tier2Rate).toBeLessThan(1);
    expect(planFixture('f02-empty-sessions').tier2Rate).toBe(0);
  });

  it('边界模板：f06 30 天边界（Tier1 过期删）/ f08 PROMOTE 11 vs 10 / f09 元数据 vs 正文', () => {
    const f06 = planFixture('f06-stale-knowledge');
    expect(f06.operations.map((op) => op.tierReason)).toEqual(['delete-unused-30d', 'delete-not-eligible']);
    const f08 = planFixture('f08-promote-boundary');
    expect(f08.operations.map((op) => op.tierReason)).toEqual(['promote-use-count', 'promote-below-threshold']);
    expect(f08.rejected.map((r) => r.reason)).toEqual(['inferred-not-promotable', 'append-only', 'already-in-target']);
    const f09 = planFixture('f09-update-modes');
    expect(f09.operations.map((op) => op.tierReason)).toEqual(['metadata-only', 'update-text-needs-review', 'metadata-only']);
    expect(f09.rejected.map((r) => r.reason)).toEqual(['no-change', 'empty-text']);
  });

  it('黄金文件覆盖全部 10 组样本（防漏更）', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Record<string, PlanSnapshot>;
    expect(Object.keys(golden).sort()).toEqual(REFLECTION_FIXTURES.map((f) => f.name).sort());
  });
});
