/**
 * 任务 32 · 关系模型存储单测
 *
 * 钉住验收：② 每次演化留 diff 可回滚（版本递增 + 反向 diff 记录 + 快照重建）、
 * ① 记录期记录不生效（record-only 拒绝应用，即使带人工批准）、
 * ③ 大改标记不应用（flagged 拒绝应用，即使带人工批准）。
 * 另覆盖：缺批准拒绝、历史/快照审计、持久化、损坏容错、观测事件。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileRelationshipStore } from './relationship-store.js';
import { evaluateProposal } from './governance.js';
import type { PersonaOpEvent, RelationshipEvolutionProposal } from './types.js';

let tmpDir = '';
let file = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-rel-'));
  file = path.join(tmpDir, 'relationship.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(observer?: (e: PersonaOpEvent) => void): FileRelationshipStore {
  return new FileRelationshipStore({ filePath: file, observer });
}

function proposal(overrides: Partial<RelationshipEvolutionProposal> = {}): RelationshipEvolutionProposal {
  return {
    id: 'p-boss-profile',
    proposedAt: 1_759_000_000_000,
    evidence: ['glog-1'],
    changes: [{ field: 'bossProfile', from: undefined, to: '独立开发者，喜欢直接给结论' }],
    ...overrides,
  };
}

/** 以存储当前模型为基准跑一次治理（sessionCount 缺省已出记录期）。 */
function decide(store: FileRelationshipStore, p: RelationshipEvolutionProposal, sessionCount = 20) {
  return evaluateProposal(p, store.getModel().model, { sessionCount });
}

describe('FileRelationshipStore · 初始态与持久化', () => {
  it('无文件 → version 0 / 空模型 / 空历史', () => {
    const store = makeStore();
    expect(store.getModel()).toEqual({ modelVersion: 0, model: {} });
    expect(store.getHistory()).toEqual([]);
  });

  it('应用后落盘；新实例继承模型与历史', () => {
    const store = makeStore();
    const p = proposal();
    const r = store.applyEvolution(p, decide(store, p), { approval: 'tier2-approved', at: 111 });
    expect(r.applied).toBe(true);
    expect(r.version).toBe(1);

    const store2 = makeStore();
    expect(store2.getModel()).toEqual({ modelVersion: 1, model: { bossProfile: '独立开发者，喜欢直接给结论' } });
    expect(store2.getHistory()).toHaveLength(1);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw).toMatchObject({ version: 1, modelVersion: 1 });
  });

  it('文件损坏 → 初始态，不抛', () => {
    fs.writeFileSync(file, '{broken json');
    const store = makeStore();
    expect(store.getModel()).toEqual({ modelVersion: 0, model: {} });
  });
});

describe('FileRelationshipStore · 应用门控（类型即纪律）', () => {
  it('review 提案：缺 approval 拒绝；带 approval 通过', () => {
    const store = makeStore();
    const p = proposal();
    const decision = decide(store, p);

    const noApproval = store.applyEvolution(p, decision);
    expect(noApproval.applied).toBe(false);
    expect(noApproval.reason).toContain('批准');
    expect(store.getModel().modelVersion).toBe(0);

    const ok = store.applyEvolution(p, decision, { approval: 'tier2-approved' });
    expect(ok.applied).toBe(true);
  });

  it('reject / record-only / flagged：即使带人工批准也拒绝（验收①②③）', () => {
    const store = makeStore();

    // record-only：记录期（第 3/20 次会话）
    const inPhase = proposal();
    const recordOnly = decide(store, inPhase, 3);
    expect(recordOnly.verdict).toBe('record-only');
    const denied1 = store.applyEvolution(inPhase, recordOnly, { approval: 'tier2-approved' });
    expect(denied1.applied).toBe(false);
    expect(denied1.reason).toContain('记录期');

    // reject：无证据
    const noEvidence = proposal({ id: 'p-no-evidence', evidence: [] });
    const rejected = decide(store, noEvidence);
    expect(store.applyEvolution(noEvidence, rejected, { approval: 'tier2-approved' }).applied).toBe(false);

    // flagged：先建立 communicationPrefs，再提「近乎重写」——大改标记不应用
    const first = proposal({ id: 'p-prefs-1', changes: [{ field: 'communicationPrefs', from: undefined, to: '喜欢简短直接的回复，先说结论' }] });
    store.applyEvolution(first, decide(store, first), { approval: 'tier2-approved' });
    const rewrite = proposal({ id: 'p-prefs-2', changes: [{ field: 'communicationPrefs', from: '喜欢简短直接的回复，先说结论', to: '我希望你把所有事情都详细展开讲清楚' }] });
    const flagged = decide(store, rewrite);
    expect(flagged.verdict).toBe('flagged');
    const denied2 = store.applyEvolution(rewrite, flagged, { approval: 'tier2-approved' });
    expect(denied2.applied).toBe(false);
    expect(denied2.reason).toContain('大改');
    expect(store.getModel().model.communicationPrefs).toBe('喜欢简短直接的回复，先说结论'); // 原值未动

    expect(store.getModel().modelVersion).toBe(1); // 全程只有 first 生效
  });
});

describe('FileRelationshipStore · diff 与回滚（验收②）', () => {
  it('每次应用留逐字段 diff；回滚产生新版本 + 反向 diff（历史不重写）', () => {
    const store = makeStore();
    const p1 = proposal();
    const r1 = store.applyEvolution(p1, decide(store, p1), { approval: 'tier2-approved', at: 100 });
    const p2 = proposal({ id: 'p-prefs', changes: [{ field: 'communicationPrefs', from: undefined, to: '喜欢先说结论' }] });
    const r2 = store.applyEvolution(p2, decide(store, p2), { approval: 'tier2-approved', at: 200 });

    expect(r1.diff).toEqual([{ field: 'bossProfile', from: undefined, to: '独立开发者，喜欢直接给结论' }]);
    expect(r2.version).toBe(2);
    const history = store.getHistory();
    expect(history).toHaveLength(2);
    // 注:历史经 JSON 落盘往返,from: undefined 的键会被剥掉(未建立 = 缺键)
    expect(history[1]).toMatchObject({
      version: 2,
      proposalId: 'p-prefs',
      appliedBy: 'tier2-approved',
      evidence: ['glog-1'],
      diff: [{ field: 'communicationPrefs', to: '喜欢先说结论' }],
    });
    expect(history[1].diff[0].from).toBeUndefined();

    // 回滚到 v1：只剩 bossProfile
    const rollback = store.rollbackTo(1, { at: 300, reason: '用户纠正：之前的偏好记录有误' });
    expect(rollback.applied).toBe(true);
    expect(rollback.version).toBe(3);
    expect(store.getModel()).toEqual({ modelVersion: 3, model: { bossProfile: '独立开发者，喜欢直接给结论' } });
    expect(rollback.diff).toEqual([{ field: 'communicationPrefs', from: '喜欢先说结论', to: undefined }]);

    const last = store.getHistory().at(-1);
    expect(last).toMatchObject({ version: 3, appliedBy: 'rollback', rollbackTo: 1, evidence: ['用户纠正：之前的偏好记录有误'] });

    // 回滚到 0：回到空模型；历史仍完整（4? 3 条记录，不回写）
    const toZero = store.rollbackTo(0, { at: 400 });
    expect(toZero.applied).toBe(true);
    expect(store.getModel()).toEqual({ modelVersion: 4, model: {} });
    expect(store.getHistory()).toHaveLength(4);
  });

  it('非法回滚目标（未来版本 / 负数）→ 拒绝，模型不动', () => {
    const store = makeStore();
    const p = proposal();
    store.applyEvolution(p, decide(store, p), { approval: 'tier2-approved' });

    expect(store.rollbackTo(1).applied).toBe(false); // 当前 modelVersion=1，未产生
    expect(store.rollbackTo(-1).applied).toBe(false);
    expect(store.rollbackTo(1.5).applied).toBe(false);
    expect(store.getModel().modelVersion).toBe(1);
  });
});

describe('FileRelationshipStore · 观测（⑦）', () => {
  it('应用/回滚/拒绝都发事件（含版本与 diffChars）', () => {
    const events: PersonaOpEvent[] = [];
    const store = makeStore((e) => events.push(e));
    const p = proposal();
    const decision = decide(store, p);

    store.applyEvolution(p, decision); // 缺批准 → refused
    expect(events.at(-1)).toMatchObject({ op: 'evolution-applied', applied: false, proposalId: p.id });

    const ok = store.applyEvolution(p, decision, { approval: 'tier2-approved', at: 123 });
    expect(events.at(-1)).toMatchObject({ op: 'evolution-applied', applied: true, version: ok.version, verdict: 'review' });
    expect(events.at(-1)?.diffChars).toBeGreaterThan(0);

    store.rollbackTo(0, { at: 456 });
    expect(events.at(-1)).toMatchObject({ op: 'rollback', applied: true, rollbackTo: 0, version: 2 });
  });

  it('观测回调抛错不影响存储', () => {
    const store = makeStore(() => { throw new Error('observer down'); });
    const p = proposal();
    expect(store.applyEvolution(p, decide(store, p), { approval: 'tier2-approved' }).applied).toBe(true);
  });
});
