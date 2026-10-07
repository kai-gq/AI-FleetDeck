/**
 * 任务 32 · 人格层治理单测
 *
 * 钉住验收：④ 核心身份不可变（冻结常量 + 改名/改基调/改红线提案一律拒收）、
 * ① 记录期前 20 次会话零变更（record-only）、③ 重叠 <50% 大改标记不应用（flagged）。
 * 另覆盖：无证据拒收、白名单外字段拒收、重叠率算法、观测事件。
 */

import { describe, expect, it } from 'vitest';

import {
  BIG_CHANGE_OVERLAP_THRESHOLD,
  RECORD_PHASE_SESSIONS,
  computeTextOverlap,
  computeValueOverlap,
  evaluateProposal,
  evaluateProposalObserved,
} from './governance.js';
import { CORE_IDENTITY, CORE_IDENTITY_RED_LINES, buildCoreIdentityBlock, isCoreIdentityField } from './core-identity.js';
import type { RelationshipEvolutionProposal, RelationshipModel } from './types.js';

function proposal(overrides: Partial<RelationshipEvolutionProposal> = {}): RelationshipEvolutionProposal {
  return {
    id: 'p1',
    proposedAt: 1_759_000_000_000,
    evidence: ['glog-1'],
    changes: [{ field: 'bossProfile', from: undefined, to: '独立开发者，喜欢直接给结论' }],
    ...overrides,
  };
}

const AFTER_RECORD_PHASE = { sessionCount: RECORD_PHASE_SESSIONS };
const IN_RECORD_PHASE = { sessionCount: RECORD_PHASE_SESSIONS - 1 };

// ============================================================================
// 重叠率
// ============================================================================

describe('computeTextOverlap（字符 bigram Jaccard）', () => {
  it('相同文本 → 1；完全不同 → 0；部分重叠 → (0,1)', () => {
    expect(computeTextOverlap('喜欢先说结论', '喜欢先说结论')).toBe(1);
    expect(computeTextOverlap('abcdef', 'xyzuvw')).toBe(0);
    const partial = computeTextOverlap('abcdef', 'abcxyz'); // ab,bc 命中 / union 8
    expect(partial).toBeCloseTo(0.25, 5);
  });

  it('两串都空 → 1；仅一边空 → 0', () => {
    expect(computeTextOverlap('  ', '')).toBe(1);
    expect(computeTextOverlap('abc', '')).toBe(0);
  });
});

describe('computeValueOverlap', () => {
  it('from 未建立（undefined/空串）→ null（首次建立不算大改）', () => {
    expect(computeValueOverlap(undefined, 'x')).toBeNull();
    expect(computeValueOverlap('', 'x')).toBeNull();
  });

  it('数值 → 1-|a-b|（clamp）；非有限数 → 0', () => {
    expect(computeValueOverlap(0.6, 0.8)).toBeCloseTo(0.8, 5);
    expect(computeValueOverlap(0.6, 0)).toBeCloseTo(0.4, 5);
    expect(computeValueOverlap(0, 2)).toBe(0);
    expect(computeValueOverlap(Number.NaN, 0.5)).toBe(0);
  });

  it('类型改变（字符串↔数值）→ 0（视作完全重写）', () => {
    expect(computeValueOverlap('经常聊', 0.5)).toBe(0);
  });
});

// ============================================================================
// 拒收（硬边界）
// ============================================================================

describe('evaluateProposal · 拒收', () => {
  it('空变更 / 无证据 → reject', () => {
    expect(evaluateProposal(proposal({ changes: [] }), {}, AFTER_RECORD_PHASE).verdict).toBe('reject');
    const noEvidence = evaluateProposal(proposal({ evidence: [] }), {}, AFTER_RECORD_PHASE);
    expect(noEvidence.verdict).toBe('reject');
    expect(noEvidence.reasons[0]).toContain('证据');
  });

  it('核心身份字段（含中英同义别名）→ reject，且混合提案整单拒收（无部分应用）', () => {
    for (const field of ['name', 'tone', 'redLines', 'redlines', '基调', '红线', '名字', '人设']) {
      const d = evaluateProposal(proposal({ changes: [{ field, from: 'x', to: 'y' }] }), {}, AFTER_RECORD_PHASE);
      expect(d.verdict, `字段 ${field} 应拒收`).toBe('reject');
      expect(d.reasons[0]).toContain('核心身份');
    }
    const mixed = evaluateProposal(
      proposal({
        changes: [
          { field: 'bossProfile', from: undefined, to: '新画像' },
          { field: 'name', from: '秘书', to: '管家' },
        ],
      }),
      {},
      AFTER_RECORD_PHASE,
    );
    expect(mixed.verdict).toBe('reject');
  });

  it('白名单外（非核心）字段 → reject', () => {
    const d = evaluateProposal(proposal({ changes: [{ field: 'favoriteColor', from: undefined, to: '蓝色' }] }), {}, AFTER_RECORD_PHASE);
    expect(d.verdict).toBe('reject');
    expect(d.reasons[0]).toContain('白名单');
  });

  it('isCoreIdentityField 大小写/空白归一', () => {
    expect(isCoreIdentityField(' name ')).toBe(true);
    expect(isCoreIdentityField('redLines')).toBe(true);
    expect(isCoreIdentityField('bossProfile')).toBe(false);
  });
});

// ============================================================================
// 记录期（验收①）
// ============================================================================

describe('evaluateProposal · 记录期（前 20 次会话零变更）', () => {
  it('sessionCount 0 / 19 → record-only，reason 带 N/20', () => {
    const d0 = evaluateProposal(proposal(), {}, { sessionCount: 0 });
    expect(d0.verdict).toBe('record-only');
    expect(d0.reasons[0]).toContain(`0/${RECORD_PHASE_SESSIONS}`);
    expect(evaluateProposal(proposal(), {}, IN_RECORD_PHASE).verdict).toBe('record-only');
  });

  it('sessionCount 达到阈值 → 不再 record-only（首次建立走 review）', () => {
    expect(evaluateProposal(proposal(), {}, AFTER_RECORD_PHASE).verdict).toBe('review');
  });
});

// ============================================================================
// 大改标记（验收③）
// ============================================================================

describe('evaluateProposal · 大改标记（重叠 <50%）', () => {
  const current: RelationshipModel = { communicationPrefs: '喜欢简短直接的回复，先说结论' };

  it('改动很小 → review', () => {
    const d = evaluateProposal(
      proposal({ changes: [{ field: 'communicationPrefs', from: current.communicationPrefs, to: '喜欢简短直接的回复，先说结论和行动项' }] }),
      current,
      AFTER_RECORD_PHASE,
    );
    expect(d.verdict).toBe('review');
  });

  it('近乎重写 → flagged，flagged 列表带字段与重叠率', () => {
    const d = evaluateProposal(
      proposal({ changes: [{ field: 'communicationPrefs', from: current.communicationPrefs, to: '我希望你把所有事情都详细展开讲清楚' }] }),
      current,
      AFTER_RECORD_PHASE,
    );
    expect(d.verdict).toBe('flagged');
    expect(d.flagged?.[0]?.field).toBe('communicationPrefs');
    expect(d.flagged?.[0]?.overlap).toBeLessThan(BIG_CHANGE_OVERLAP_THRESHOLD);
  });

  it('全新字段（from 未建立）不算大改 → review', () => {
    expect(evaluateProposal(proposal(), {}, AFTER_RECORD_PHASE).verdict).toBe('review');
  });

  it('current 为权威基准：提案 from 留空也按当前模型算重叠', () => {
    const d = evaluateProposal(
      proposal({ changes: [{ field: 'communicationPrefs', from: undefined, to: '我希望你把所有事情都详细展开讲清楚' }] }),
      current,
      AFTER_RECORD_PHASE,
    );
    expect(d.verdict).toBe('flagged');
  });

  it('数值变幅 >0.5 → flagged（信任度 0.6 → 0）', () => {
    const d = evaluateProposal(
      proposal({ changes: [{ field: 'trustLevel', from: 0.6, to: 0 }] }),
      { trustLevel: 0.6 },
      AFTER_RECORD_PHASE,
    );
    expect(d.verdict).toBe('flagged');
  });
});

// ============================================================================
// 核心身份不变式（验收④）
// ============================================================================

describe('核心身份不变式（冻结 + 注入块）', () => {
  it('CORE_IDENTITY 及其红线数组 Object.freeze', () => {
    expect(Object.isFrozen(CORE_IDENTITY)).toBe(true);
    expect(Object.isFrozen(CORE_IDENTITY_RED_LINES)).toBe(true);
    expect(CORE_IDENTITY.name).toBe('秘书');
  });

  it('注入块含名字 / 基调 / 「不替你做主」红线', () => {
    const block = buildCoreIdentityBlock();
    expect(block).toContain('秘书');
    expect(block).toContain('不替你做主');
    expect(block).toContain('固定不可改');
  });
});

// ============================================================================
// 观测
// ============================================================================

describe('evaluateProposalObserved', () => {
  it('发出 governance 事件（verdict / proposalId / applied=false）', () => {
    const events: unknown[] = [];
    const d = evaluateProposalObserved(proposal(), {}, {
      ...AFTER_RECORD_PHASE,
      at: 123,
      observer: (e) => events.push(e),
    });
    expect(d.verdict).toBe('review');
    expect(events).toEqual([
      expect.objectContaining({ op: 'governance', at: 123, proposalId: 'p1', verdict: 'review', applied: false }),
    ]);
  });

  it('观测回调抛错不影响裁决', () => {
    const d = evaluateProposalObserved(proposal(), {}, {
      ...AFTER_RECORD_PHASE,
      observer: () => { throw new Error('observer down'); },
    });
    expect(d.verdict).toBe('review');
  });
});
