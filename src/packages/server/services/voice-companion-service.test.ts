import { describe, it, expect } from 'vitest';
import {
  stripCodeFences,
  parseContractJson,
  applyMemoryOps,
  buildAgentSnapshotLines,
  buildCompanionSystemPrompt,
  shouldRotateSession,
  shouldRotateForPersona,
  DEFAULT_SERVER_CONFIG,
  type CompanionMemory,
  type VoiceCompanionState,
} from './voice-companion-service.js';
import { VOICE_PERSONAS } from '../../shared/voice-personas.js';

function emptyMemory(): CompanionMemory {
  return { summary: '', notes: [], updatedAt: 0, droppedCount: 0 };
}

function emptyState(): VoiceCompanionState {
  return { sessionId: null, sessionStartedAt: null, turns: 0, lastUsedAt: null, personaKey: null, memory: emptyMemory() };
}

describe('stripCodeFences', () => {
  it('removes ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('removes bare fences', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe('parseContractJson', () => {
  it('parses a clean contract', () => {
    const c = parseContractJson(JSON.stringify({
      action: 'send_to_agent',
      targetAgentId: 'a1',
      targetAgentName: '小美',
      messageToAgent: '修登录页',
      delivery: 'queue',
      responseToUser: '好的',
      memoryOps: [{ op: 'add', text: '叫我老板' }],
    }));
    expect(c.action).toBe('send_to_agent');
    expect(c.targetAgentId).toBe('a1');
    expect(c.messageToAgent).toBe('修登录页');
    expect(c.delivery).toBe('queue');
    expect(c.memoryOps).toEqual([{ op: 'add', text: '叫我老板' }]);
  });

  it('tolerates prose around the JSON and code fences', () => {
    const c = parseContractJson('好的,这是结果:\n```json\n{"action":"noop","responseToUser":""}\n```\n谢谢');
    expect(c.action).toBe('noop');
    expect(c.responseToUser).toBe('');
  });

  it('falls back to general_response for unknown actions and invalid delivery', () => {
    const c = parseContractJson('{"action":"destroy","delivery":"now"}');
    expect(c.action).toBe('general_response');
    expect(c.delivery).toBe('queue');
    expect(c.targetAgentId).toBeNull();
    expect(c.memoryOps).toEqual([]);
  });

  it('drops malformed memoryOps entries', () => {
    const c = parseContractJson('{"memoryOps":[{"op":"add"},{"op":"remove"},{"op":"add","text":"ok"},{"op":"remove","id":"x"}]}');
    expect(c.memoryOps).toEqual([
      { op: 'add', text: 'ok' },
      { op: 'remove', id: 'x' },
    ]);
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseContractJson('抱歉,我听不懂')).toThrow();
  });
});

describe('applyMemoryOps', () => {
  it('adds a note and dedupes identical text', () => {
    const { memory, applied } = applyMemoryOps(emptyMemory(), [
      { op: 'add', text: '叫我老板' },
      { op: 'add', text: '叫我老板' },
    ], 40, 1000);
    expect(applied).toBe(1);
    expect(memory.notes).toHaveLength(1);
    expect(memory.notes[0].source).toBe('user');
    expect(memory.notes[0].id).toMatch(/^m/);
  });

  it('ignores too-short notes', () => {
    const { applied } = applyMemoryOps(emptyMemory(), [{ op: 'add', text: ' ' }, { op: 'add', text: 'x' }], 40);
    expect(applied).toBe(0);
  });

  it('removes by id', () => {
    const first = applyMemoryOps(emptyMemory(), [{ op: 'add', text: '喜好A' }], 40, 1000).memory;
    const { memory, applied } = applyMemoryOps(first, [{ op: 'remove', id: first.notes[0].id }], 40, 2000);
    expect(applied).toBe(1);
    expect(memory.notes).toHaveLength(0);
  });

  it('caps notes at maxNotes, dropping the oldest auto entry first', () => {
    let memory = emptyMemory();
    memory.notes.push({ id: 'auto-old', text: '自动旧条', createdAt: 1, source: 'auto' });
    for (let i = 0; i < 4; i++) {
      memory = applyMemoryOps(memory, [{ op: 'add', text: `笔记${i}` }], 5, 100 + i).memory;
    }
    // 现在 5 条(容量),再加一条应挤掉 auto-old
    const { memory: capped } = applyMemoryOps(memory, [{ op: 'add', text: '新笔记' }], 5, 999);
    expect(capped.notes).toHaveLength(5);
    expect(capped.notes.some((n) => n.id === 'auto-old')).toBe(false);
    expect(capped.droppedCount).toBe(1);
  });

  it('sets summary', () => {
    const { memory, applied } = applyMemoryOps(emptyMemory(), [{ op: 'setSummary', summary: '  老板喜欢简洁汇报  ' }], 40);
    expect(applied).toBe(1);
    expect(memory.summary).toBe('老板喜欢简洁汇报');
  });

  it('returns the same object when nothing applied', () => {
    const memory = emptyMemory();
    const { memory: out, applied } = applyMemoryOps(memory, [{ op: 'remove', id: 'nope' }], 40);
    expect(applied).toBe(0);
    expect(out).toBe(memory);
  });
});

describe('shouldRotateSession', () => {
  it('never rotates without a session', () => {
    expect(shouldRotateSession(emptyState(), DEFAULT_SERVER_CONFIG, 10_000_000)).toBe(false);
  });
  it('rotates on turn cap', () => {
    const state = { ...emptyState(), sessionId: 's1', turns: DEFAULT_SERVER_CONFIG.maxTurns };
    expect(shouldRotateSession(state, DEFAULT_SERVER_CONFIG)).toBe(true);
  });
  it('rotates on age cap', () => {
    const state = { ...emptyState(), sessionId: 's1', sessionStartedAt: 0 };
    const now = DEFAULT_SERVER_CONFIG.sessionMaxAgeDays * 86_400_000 + 1;
    expect(shouldRotateSession(state, DEFAULT_SERVER_CONFIG, now)).toBe(true);
  });
  it('keeps a young session', () => {
    const state = { ...emptyState(), sessionId: 's1', turns: 5, sessionStartedAt: 1000 };
    expect(shouldRotateSession(state, DEFAULT_SERVER_CONFIG, 2000)).toBe(false);
  });
});

describe('shouldRotateForPersona', () => {
  it('rotates once for legacy state (personaKey missing)', () => {
    expect(shouldRotateForPersona({ ...emptyState(), sessionId: 's1' }, 'doubao')).toBe(true);
  });
  it('keeps the session while the persona is unchanged', () => {
    const state = { ...emptyState(), sessionId: 's1', personaKey: 'butler' };
    expect(shouldRotateForPersona(state, 'butler')).toBe(false);
  });
  it('rotates when the persona changed', () => {
    const state = { ...emptyState(), sessionId: 's1', personaKey: 'butler' };
    expect(shouldRotateForPersona(state, 'sharp')).toBe(true);
  });
});

describe('buildAgentSnapshotLines', () => {
  it('renders id/status/task and areas, sorted by recent activity', () => {
    const agents = [
      { id: 'a1', name: '小美', class: 'builder', status: 'working', taskLabel: '修登录页', lastWorkedAt: 100 },
      { id: 'a2', name: '老王', class: 'boss', status: 'idle', isBoss: true, lastWorkedAt: 200 },
    ];
    const areas = [
      { id: 'ar1', name: '前端区', archived: false, assignedAgentIds: ['a1'] },
    ] as never;
    const { lines, total, truncated } = buildAgentSnapshotLines(agents, areas);
    expect(total).toBe(2);
    expect(truncated).toBe(false);
    expect(lines[0]).toContain('老王');
    expect(lines[0]).toContain('[BOSS]');
    expect(lines[1]).toContain('小美');
    expect(lines[1]).toContain('id: a1');
    expect(lines[1]).toContain('任务: 修登录页');
    expect(lines[1]).toContain('区域: 前端区');
  });

  it('truncates long task/error text and caps at 60 agents', () => {
    const agents = Array.from({ length: 70 }, (_, i) => ({
      id: `a${i}`, name: `agent${i}`, status: 'idle', lastWorkedAt: i,
      taskLabel: 'x'.repeat(200), lastError: 'e'.repeat(200),
    }));
    const { lines, truncated } = buildAgentSnapshotLines(agents, []);
    expect(lines).toHaveLength(60);
    expect(truncated).toBe(true);
    // 最热(lastWorkedAt 最大)的排最前
    expect(lines[0]).toContain('agent69');
    expect(lines[0]).toContain('…');
  });
});

describe('buildCompanionSystemPrompt — persona & 自适应长度', () => {
  const base = () => ({
    agentLines: ['- 小美 (id: a1, idle)'],
    totalAgents: 1,
    truncated: false,
    memory: emptyMemory(),
    nowText: '2026-10-03 12:00',
  });

  it('injects the default persona (豆包风) and dropped the 60-char caps', () => {
    const prompt = buildCompanionSystemPrompt(base());
    const doubao = VOICE_PERSONAS.find((p) => p.id === 'doubao')!;
    expect(prompt).toContain(doubao.stylePrompt);
    expect(prompt).not.toContain('不超过 60 字');
  });

  it('honors a preset id and a custom persona', () => {
    const butler = VOICE_PERSONAS.find((p) => p.id === 'butler')!;
    expect(buildCompanionSystemPrompt({ ...base(), persona: { preset: 'butler', custom: '' } }))
      .toContain(butler.stylePrompt);
    expect(buildCompanionSystemPrompt({ ...base(), persona: { preset: 'custom', custom: '你是个海盗船长。' } }))
      .toContain('你是个海盗船长。');
  });
});
