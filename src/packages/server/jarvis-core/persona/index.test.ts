/**
 * 任务 32 · 人格层门面单测
 *
 * 覆盖：开关形态、关系模型注入块渲染、buildPersonaInjection 降级、
 * recordPersonaSession 幂等/降级、recordProposalEvidence 成长日志留痕（含真
 * FileMemoryStore 集成一次）、坏存储降级不抛。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildPersonaInjection,
  isPersonaEnabled,
  recordPersonaSession,
  recordProposalEvidence,
  renderRelationshipBlock,
} from './index.js';
import { FileRelationshipStore } from './relationship-store.js';
import { FileSessionCounter } from './session-counter.js';
import { evaluateProposal } from './governance.js';
import { FileMemoryStore } from '../memory/index.js';
import type { GovernanceDecision, RelationshipEvolutionProposal } from './types.js';

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-facade-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function proposal(overrides: Partial<RelationshipEvolutionProposal> = {}): RelationshipEvolutionProposal {
  return {
    id: 'p1',
    proposedAt: 1_759_000_000_000,
    evidence: ['glog-1'],
    changes: [{ field: 'bossProfile', from: undefined, to: '独立开发者，喜欢直接给结论' }],
    ...overrides,
  };
}

// ============================================================================

describe('isPersonaEnabled（TC_JARVIS_PERSONA，缺省开）', () => {
  it('缺省/空/1 → 开；0/off/false（大小写空白）→ 关', () => {
    expect(isPersonaEnabled({})).toBe(true);
    expect(isPersonaEnabled({ TC_JARVIS_PERSONA: '' })).toBe(true);
    expect(isPersonaEnabled({ TC_JARVIS_PERSONA: '1' })).toBe(true);
    expect(isPersonaEnabled({ TC_JARVIS_PERSONA: '0' })).toBe(false);
    expect(isPersonaEnabled({ TC_JARVIS_PERSONA: ' off ' })).toBe(false);
    expect(isPersonaEnabled({ TC_JARVIS_PERSONA: 'FALSE' })).toBe(false);
  });
});

describe('renderRelationshipBlock', () => {
  it('空模型 → undefined；有值 → 带中文标签逐行', () => {
    expect(renderRelationshipBlock({})).toBeUndefined();
    expect(renderRelationshipBlock({ bossProfile: '独立开发者' })).toBe('- 老板画像：独立开发者');
    expect(
      renderRelationshipBlock({
        bossProfile: '独立开发者',
        communicationPrefs: '先说结论',
        trustLevel: 0.6,
        collaborationRhythm: '高频快节奏',
      }),
    ).toBe(['- 老板画像：独立开发者', '- 沟通偏好：先说结论', '- 信任度：0.6', '- 协作节奏：高频快节奏'].join('\n'));
  });

  it('空串字段视同未建立', () => {
    expect(renderRelationshipBlock({ bossProfile: '' })).toBeUndefined();
  });
});

describe('buildPersonaInjection', () => {
  it('核心身份 always-on；空模型不注关系块', () => {
    const store = new FileRelationshipStore({ filePath: path.join(tmpDir, 'relationship.json') });
    const injection = buildPersonaInjection({ store });
    expect(injection.coreBlock).toContain('秘书');
    expect(injection.coreBlock).toContain('不替你做主');
    expect(injection.relationshipBlock).toBeUndefined();
  });

  it('已演化的关系模型 → 注入块含字段与内容', () => {
    const store = new FileRelationshipStore({ filePath: path.join(tmpDir, 'relationship.json') });
    const p = proposal();
    store.applyEvolution(p, evaluateProposal(p, store.getModel().model, { sessionCount: 20 }), {
      approval: 'tier2-approved',
    });
    const injection = buildPersonaInjection({ store });
    expect(injection.relationshipBlock).toBe('- 老板画像：独立开发者，喜欢直接给结论');
  });

  it('存储读取抛错 → 降级只注核心身份，不抛', () => {
    const broken = { getModel: () => { throw new Error('store down'); } } as unknown as FileRelationshipStore;
    const injection = buildPersonaInjection({ store: broken });
    expect(injection.coreBlock).toContain('秘书');
    expect(injection.relationshipBlock).toBeUndefined();
  });
});

describe('recordPersonaSession', () => {
  it('sessionId null → 不计数返回 null；有 id → 计数且幂等', () => {
    const counter = new FileSessionCounter({ filePath: path.join(tmpDir, 'session-count.json') });
    expect(recordPersonaSession(null, { counter })).toBeNull();
    expect(recordPersonaSession('sess-a', { counter, at: 111 })).toEqual({ sessionCount: 1, counted: true });
    expect(recordPersonaSession('sess-a', { counter })).toEqual({ sessionCount: 1, counted: false });
  });

  it('计数器抛错 → 降级返回 null，不抛', () => {
    const broken = { recordSession: () => { throw new Error('counter down'); } } as unknown as FileSessionCounter;
    expect(recordPersonaSession('sess-a', { counter: broken })).toBeNull();
  });
});

describe('recordProposalEvidence（成长日志留痕）', () => {
  const decision: GovernanceDecision = { verdict: 'review', reasons: ['通过治理初筛，走 Tier2 人工审查'] };

  it('写入 growth-log：来源/kind/tags/正文摘要齐备', async () => {
    const add = vi.fn(async (input) => ({ id: 'e1', ...input }));
    const entry = await recordProposalEvidence({ add } as never, proposal(), decision, { at: 222, sessionId: 'sess-a' });

    expect(entry).not.toBeNull();
    expect(add).toHaveBeenCalledOnce();
    const input = add.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({ layer: 'growth-log', source: 'agent-confirmed', kind: 'persona-evolution', at: 222, sessionId: 'sess-a' });
    expect(input.tags).toEqual(['persona-evolution', 'review']);
    expect(String(input.text)).toContain('[人格演化·review]');
    expect(String(input.text)).toContain('p1');
    expect(String(input.text)).toContain('bossProfile: （未建立） → 独立开发者，喜欢直接给结论');
  });

  it('记忆层缺省/写失败 → null，不抛', async () => {
    expect(await recordProposalEvidence(null, proposal(), decision)).toBeNull();
    expect(await recordProposalEvidence(undefined, proposal(), decision)).toBeNull();
    const failing = { add: async () => { throw new Error('memory down'); } };
    expect(await recordProposalEvidence(failing as never, proposal(), decision)).toBeNull();
  });

  it('真 FileMemoryStore 集成：growth-log append-only 落地可查', async () => {
    const memory = new FileMemoryStore({ baseDir: path.join(tmpDir, 'vault') });
    const entry = await recordProposalEvidence(memory, proposal(), decision, { at: 333 });
    expect(entry).toMatchObject({ layer: 'growth-log', source: 'agent-confirmed' });

    const listed = await memory.list('growth-log');
    expect(listed).toHaveLength(1);
    expect(listed[0].text).toContain('[人格演化·review]');
  });
});
