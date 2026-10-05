/**
 * 探针注册表 + 完整性自检
 *
 * 自检项（run.ts --self-test 离线执行）：
 *   - HC-01..HC-43 无缺号、无重号（planned 43 = 5 波探针目录逐条对应）；
 *   - 每探针 wave 与目录波一致、title/dim/steps/assertionDocs 非空、run 可调用；
 *   - prereqIds 全部命中 runner.PREREQS 注册表（防 id 拼写漂移静默放过）；
 *   - 同波 id 连续。
 */

import type { ProbeDef, WaveId } from '../types.js';
import { PREREQS } from '../runner.js';
import { W1_PROBES } from './w1-dialog.js';
import { W2_PROBES } from './w2-delegation.js';
import { W3_PROBES } from './w3-multiproject.js';
import { W4_PROBES } from './w4-machine.js';
import { W5_PROBES } from './w5-voice.js';

export const WAVES: ReadonlyArray<{ wave: WaveId; probes: ProbeDef[] }> = [
  { wave: 1, probes: W1_PROBES },
  { wave: 2, probes: W2_PROBES },
  { wave: 3, probes: W3_PROBES },
  { wave: 4, probes: W4_PROBES },
  { wave: 5, probes: W5_PROBES },
];

export const PLANNED_TOTAL = 43;

/** 同波执行序：order ?? 100 升序，再按 id（HC-28=order 1 先行） */
export function probesForWave(wave: WaveId): ProbeDef[] {
  const entry = WAVES.find((w) => w.wave === wave);
  if (!entry) return [];
  return [...entry.probes].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

export function allProbes(): ProbeDef[] {
  return WAVES.flatMap((w) => probesForWave(w.wave));
}

export function findProbe(idOrPrefix: string): ProbeDef[] {
  const key = idOrPrefix.trim().toUpperCase();
  return allProbes().filter((p) => p.id.toUpperCase() === key || p.id.toUpperCase().startsWith(key) || p.id === idOrPrefix);
}

export interface RegistryIssue { level: 'error' | 'warn'; probeId?: string; msg: string }

export function checkRegistry(): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const seen = new Map<string, ProbeDef>();
  for (const { wave, probes } of WAVES) {
    const ids = [...probes].map((p) => p.id).sort();
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i]!;
      if (seen.has(p.id)) issues.push({ level: 'error', probeId: p.id, msg: `重号（${seen.get(p.id)!.wave} 波已注册）` });
      seen.set(p.id, p);
      if (p.wave !== wave) issues.push({ level: 'error', probeId: p.id, msg: `wave 字段=${p.wave} 与目录波=${wave} 不一致` });
      if (!p.title?.trim()) issues.push({ level: 'error', probeId: p.id, msg: 'title 空' });
      if (!p.dim?.trim()) issues.push({ level: 'error', probeId: p.id, msg: 'dim 空' });
      if (!p.steps?.length) issues.push({ level: 'error', probeId: p.id, msg: 'steps 空' });
      if (!p.assertionDocs?.length) issues.push({ level: 'error', probeId: p.id, msg: 'assertionDocs 空' });
      if (typeof p.run !== 'function') issues.push({ level: 'error', probeId: p.id, msg: 'run 不是函数' });
      for (const req of p.prereqIds) {
        if (!PREREQS.has(req)) issues.push({ level: 'error', probeId: p.id, msg: `未知前置 id=${req}（PREREQS 未注册）` });
      }
      if (p.manualOnly && p.effect !== 'manual') issues.push({ level: 'warn', probeId: p.id, msg: 'manualOnly 但 effect≠manual' });
    }
    // 同波序号连续
    const nums = ids.map((id) => Number(id.replace(/^HC-/, ''))).filter((n) => Number.isFinite(n));
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] !== nums[i - 1] + 1) issues.push({ level: 'error', msg: `${wave} 波 id 不连续：${ids[i - 1]} → ${ids[i]}` });
    }
  }
  // 全表连续性 + 总数
  const all = [...seen.keys()].map((id) => Number(id.replace(/^HC-/, ''))).sort((a, b) => a - b);
  for (let i = 0; i < all.length; i++) {
    if (all[i] !== i + 1) { issues.push({ level: 'error', msg: `全表缺号：期望 HC-${String(i + 1).padStart(2, '0')}，实际 HC-${String(all[i]).padStart(2, '0')}` }); break; }
  }
  if (seen.size !== PLANNED_TOTAL) issues.push({ level: 'error', msg: `探针总数=${seen.size}，计划=${PLANNED_TOTAL}` });
  return issues;
}
