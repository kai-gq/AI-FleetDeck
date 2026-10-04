/**
 * jarvis-core/reflection · 黄金回归工具（测试资产，任务 28 ⑥/§13.3）
 *
 * stableStringify：递归排序对象键 + 2 空格缩进 → 逐字节稳定（与对象构造顺序无关）；
 * planSnapshot：只取计划的对外语义字段（操作序列 + 拒绝登记 + Tier 计数/拦截率），
 * 作为黄金文件的对比单元。
 */

import type { ReflectionPlan } from '../types.js';

/** 确定性 JSON 序列化（对象键递归排序；undefined 属性剔除）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) out[key] = sortValue(item);
    }
    return out;
  }
  return value;
}

export interface PlanSnapshot {
  operations: ReflectionPlan['operations'];
  rejected: ReflectionPlan['rejected'];
  tier1Count: number;
  tier2Count: number;
  tier2Rate: number;
}

export function planSnapshot(plan: ReflectionPlan): PlanSnapshot {
  return {
    operations: plan.operations,
    rejected: plan.rejected,
    tier1Count: plan.tier1Count,
    tier2Count: plan.tier2Count,
    tier2Rate: plan.tier2Rate,
  };
}
