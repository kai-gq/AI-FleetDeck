/**
 * 任务 32 · 人格层注入接线单测（vcs 侧）
 *
 * 只测接线：buildCompanionSystemPrompt 段拼装（含空段逐字兼容）+ buildSystemPromptFromWorld
 * 的门控/会话计数/降级。人格层本体逻辑在 jarvis-core/persona/*.test.ts。
 * persona 门面以 vi.mock 桩住（只按调用观察接线），不打真实文件。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PERSONA_ID } from '../../shared/voice-personas.js';

const personaMock = vi.hoisted(() => ({
  enabled: true,
  throwOnBuild: false,
  injection: { coreBlock: '- 名字：秘书(测试)', relationshipBlock: '- 老板画像：测试老板' } as {
    coreBlock: string;
    relationshipBlock?: string;
  },
  recordCalls: [] as (string | null)[],
}));

vi.mock('../jarvis-core/persona/index.js', () => ({
  isPersonaEnabled: () => personaMock.enabled,
  buildPersonaInjection: () => {
    if (personaMock.throwOnBuild) throw new Error('persona down');
    return personaMock.injection;
  },
  recordPersonaSession: (sessionId: string | null) => {
    personaMock.recordCalls.push(sessionId);
    return sessionId ? { sessionCount: 1, counted: true } : null;
  },
}));

import {
  buildCompanionSystemPrompt,
  buildSystemPromptFromWorld,
  type CompanionMemory,
  type VoicePersonaConfig,
} from './voice-companion-service.js';

const PERSONA: VoicePersonaConfig = { preset: DEFAULT_PERSONA_ID, custom: '' };

beforeEach(() => {
  personaMock.enabled = true;
  personaMock.throwOnBuild = false;
  personaMock.injection = { coreBlock: '- 名字：秘书(测试)', relationshipBlock: '- 老板画像：测试老板' };
  personaMock.recordCalls.length = 0;
});

function emptyMemory(): CompanionMemory {
  return { summary: '', notes: [], updatedAt: 0, droppedCount: 0 };
}

function promptWith(overrides: { personaCoreBlock?: string; relationshipBlock?: string } = {}): string {
  return buildCompanionSystemPrompt({
    agentLines: ['a1 | 小美 | 空闲'],
    totalAgents: 1,
    truncated: false,
    memory: emptyMemory(),
    currentSessionId: null,
    ...overrides,
  });
}

describe('buildCompanionSystemPrompt · 人格段拼装', () => {
  it('有块 → 【身份(固定)】/【关系模型】插在【人设】与【输出格式】之间', () => {
    const prompt = promptWith({ personaCoreBlock: 'CORE-X', relationshipBlock: 'REL-A' });
    expect(prompt).toContain('【身份(固定)】\nCORE-X');
    expect(prompt).toContain('【关系模型】\nREL-A');
    expect(prompt).toContain('CORE-X\n\n【关系模型】'); // 段间单空行
    expect(prompt).toContain('REL-A\n\n【输出格式】'); // 段尾单空行

    const iPersona = prompt.indexOf('【人设】');
    const iIdentity = prompt.indexOf('【身份(固定)】');
    const iRelation = prompt.indexOf('【关系模型】');
    const iFormat = prompt.indexOf('【输出格式】');
    expect(iPersona).toBeGreaterThanOrEqual(0);
    expect(iIdentity).toBeGreaterThan(iPersona);
    expect(iRelation).toBeGreaterThan(iIdentity);
    expect(iFormat).toBeGreaterThan(iRelation);
  });

  it('只有核心身份 → 不注【关系模型】', () => {
    const prompt = promptWith({ personaCoreBlock: 'CORE-X' });
    expect(prompt).toContain('【身份(固定)】\nCORE-X');
    expect(prompt).not.toContain('【关系模型】');
  });

  it('缺省/空 → 不注任何人格段，【人设】与【输出格式】间保持原空行（逐字兼容）', () => {
    for (const prompt of [promptWith(), promptWith({ personaCoreBlock: '' })]) {
      expect(prompt).not.toContain('【身份(固定)】');
      expect(prompt).not.toContain('【关系模型】');
      expect(prompt).toContain('\n\n【输出格式】');
      expect(prompt).not.toContain('\n\n\n【输出格式】');
    }
  });
});

describe('buildSystemPromptFromWorld · 接线门控', () => {
  it('开关开 → 注入两段 + 会话计数带上 sessionId', () => {
    const prompt = buildSystemPromptFromWorld(emptyMemory(), PERSONA, 'sess-1');
    expect(prompt).toContain('- 名字：秘书(测试)');
    expect(prompt).toContain('- 老板画像：测试老板');
    expect(personaMock.recordCalls).toEqual(['sess-1']);
  });

  it('sessionId null → 仍注入；计数调用收到 null（门面不计数）', () => {
    const prompt = buildSystemPromptFromWorld(emptyMemory(), PERSONA, null);
    expect(prompt).toContain('【身份(固定)】');
    expect(personaMock.recordCalls).toEqual([null]);
  });

  it('开关关 → 不注入、不计数', () => {
    personaMock.enabled = false;
    const prompt = buildSystemPromptFromWorld(emptyMemory(), PERSONA, 'sess-1');
    expect(prompt).not.toContain('【身份(固定)】');
    expect(prompt).not.toContain('【关系模型】');
    expect(personaMock.recordCalls).toEqual([]);
  });

  it('构建抛错 → 降级不注段（也不计数），提示词照常返回', () => {
    personaMock.throwOnBuild = true;
    const prompt = buildSystemPromptFromWorld(emptyMemory(), PERSONA, 'sess-1');
    expect(prompt).not.toContain('【身份(固定)】');
    expect(prompt).toContain('【输出格式】');
    expect(personaMock.recordCalls).toEqual([]);
  });
});
