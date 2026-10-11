import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBossDelegation, parseBossSpawn, resetBossDelegationStateForTests } from './boss-response-handler.js';

vi.mock('../../services/index.js', () => ({
  agentService: {
    getAgent: vi.fn(),
    createAgent: vi.fn(),
  },
  runtimeService: {
    sendCommand: vi.fn(() => Promise.resolve()),
  },
  bossService: {
    addDelegationToHistory: vi.fn(),
    updateDelegationTaskCardStatus: vi.fn(),
    getSubordinates: vi.fn(() => []),
    assignSubordinates: vi.fn(),
  },
  workPlanService: {
    parseWorkPlanBlock: vi.fn(),
    createWorkPlan: vi.fn(),
    parseAnalysisRequestBlock: vi.fn(() => []),
    createAnalysisRequest: vi.fn(),
    startAnalysisRequest: vi.fn(),
  },
  skillService: {
    assignSkillToAgent: vi.fn(),
    resolveInitialSkillIdsForCreate: vi.fn(),
  },
}));

// 任务15·B：handler 静态 import 播报出口（voice-companion-service）后，模块图会带上
// utils 的真实消费者（createLogger/generateId 等）——partial mock 保真，仅静音 ws 通道。
vi.mock('../../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/index.js')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      ws: {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    },
    getCommanderBaseUrl: vi.fn(() => 'http://localhost:6200'),
  };
});

vi.mock('./command-handler.js', () => ({
  getLastBossCommand: vi.fn(),
  buildCustomAgentConfig: vi.fn(() => undefined),
}));

vi.mock('../../services/custom-class-service.js', () => ({
  getAllCustomClasses: vi.fn(() => []),
  getClassDefaultSkillIds: vi.fn(() => []),
}));

import { agentService, runtimeService, bossService, skillService } from '../../services/index.js';
import { getLastBossCommand } from './command-handler.js';
import { bossInstructions } from '../../data/builtin-skills/boss-instructions.js';

describe('boss-response-handler parseBossDelegation', () => {
  const broadcast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetBossDelegationStateForTests();
    // 派发守卫（待岗/不存在）会解析目标 agent：默认给良性桩，单测按需覆盖。
    vi.mocked(agentService.getAgent).mockImplementation(((id: string) => ({
      id, name: id, class: 'builder',
    })) as any);
    vi.mocked(getLastBossCommand).mockReturnValue('fallback delegated task');
  });

  it('parses multiple delegation blocks with mixed prose and dispatches all valid items', async () => {
    const resultText = `I will delegate this in parts.

\`\`\`delegation
I picked this owner:
[{"selectedAgentId":"agent-1","selectedAgentName":"Scout One","taskCommand":"Investigate token race around \\\"refresh\\\" flow","reasoning":"context owner","confidence":"high"}]
extra prose that should be ignored
\`\`\`

More notes between blocks.

\`\`\`delegation
[
  {"selectedAgentId":"agent-2","selectedAgentName":"Builder Two","taskCommand":"Implement fix in websocket handler","reasoning":"builder","confidence":"medium"},
  {"selectedAgentId":"agent-3","selectedAgentName":"Support Three","taskCommand":"Add tests for malformed delegation payloads","reasoning":"testing","confidence":"low"}
]
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(runtimeService.sendCommand).toHaveBeenCalledTimes(3);
    expect(runtimeService.sendCommand).toHaveBeenNthCalledWith(1, 'agent-1', expect.stringContaining('Investigate token race around "refresh" flow'), undefined, undefined, undefined);
    expect(runtimeService.sendCommand).toHaveBeenNthCalledWith(2, 'agent-2', expect.stringContaining('Implement fix in websocket handler'), undefined, undefined, undefined);
    expect(runtimeService.sendCommand).toHaveBeenNthCalledWith(3, 'agent-3', expect.stringContaining('Add tests for malformed delegation payloads'), undefined, undefined, undefined);
    expect(bossService.addDelegationToHistory).toHaveBeenCalledTimes(3);
  });

  it('parses single-object delegation payload and wraps it as one item', async () => {
    const resultText = `\`\`\`delegation
{"selectedAgentId":"agent-1","selectedAgentName":"Scout One","reasoning":"single payload","confidence":"high"}
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(runtimeService.sendCommand).toHaveBeenCalledTimes(1);
    expect(runtimeService.sendCommand).toHaveBeenCalledWith('agent-1', expect.stringContaining('fallback delegated task'), undefined, undefined, undefined);
  });

  it('skips invalid delegation items and emits clear error output', async () => {
    const resultText = `\`\`\`delegation
[
  {"selectedAgentId":"agent-1","selectedAgentName":"Scout One","taskCommand":"valid","confidence":"high"},
  {"selectedAgentId":"agent-2","selectedAgentName":"Scout Two","taskCommand":"invalid confidence","confidence":"certain"},
  {"selectedAgentName":"Scout Three","taskCommand":"missing id","confidence":"low"}
]
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(runtimeService.sendCommand).toHaveBeenCalledTimes(1);
    expect(runtimeService.sendCommand).toHaveBeenCalledWith('agent-1', expect.stringContaining('valid'), undefined, undefined, undefined);

    const errorOutputs = broadcast.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg?.type === 'output' && typeof msg?.payload?.text === 'string' && msg.payload.text.includes('Delegation parse error'));
    expect(errorOutputs.length).toBe(2);
  });

  it('standby 守卫：目标待岗 → refusal 输出 + 零派发/零落史/零去重登记', async () => {
    vi.mocked(agentService.getAgent).mockImplementation(((id: string) => (
      id === 'sb-1'
        ? { id, name: 'Standby One', class: 'builder', standby: true }
        : { id, name: id, class: 'builder' }
    )) as any);
    const resultText = `\`\`\`delegation
[{"selectedAgentId":"sb-1","selectedAgentName":"Standby One","taskCommand":"do it","reasoning":"x","confidence":"high"}]
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(runtimeService.sendCommand).not.toHaveBeenCalled();
    expect(bossService.addDelegationToHistory).not.toHaveBeenCalled();

    const refusalsOf = () => broadcast.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg?.type === 'output' && typeof msg?.payload?.text === 'string' && msg.payload.text.includes('Delegation refused'));
    expect(refusalsOf().length).toBe(1);
    expect(refusalsOf()[0].payload.text).toContain('standby');
    // 不复用 parse error 前缀：Boss 不会被误导去改 JSON
    expect(refusalsOf()[0].payload.text).not.toContain('parse error');

    // 重发同一块：仍被拒（证明拒绝路径没进去重表——否则第二次会被静默 skip）
    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();
    expect(refusalsOf().length).toBe(2);
  });

  it('standby 守卫：不存在的 agent id 显式拒绝（不再沉进 sendCommand 异常）', async () => {
    vi.mocked(agentService.getAgent).mockImplementation(((id: string) => (
      id === 'agent-ghost' ? undefined : { id, name: id, class: 'builder' }
    )) as any);
    const resultText = `\`\`\`delegation
[{"selectedAgentId":"agent-ghost","selectedAgentName":"Ghost","taskCommand":"nobody home","reasoning":"x","confidence":"high"}]
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(runtimeService.sendCommand).not.toHaveBeenCalled();
    expect(bossService.addDelegationToHistory).not.toHaveBeenCalled();
    const refusals = broadcast.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg?.type === 'output' && typeof msg?.payload?.text === 'string' && msg.payload.text.includes('Delegation refused'));
    expect(refusals.length).toBe(1);
    expect(refusals[0].payload.text).toContain('does not exist');
  });

  it('任务卡(⑦):delegation 块携带 taskCard 时落 pending 卡 + 委托消息注入验收标准', async () => {
    const resultText = `\`\`\`delegation
[{"selectedAgentId":"agent-1","selectedAgentName":"Builder One","taskCommand":"实现登录页","reasoning":"builder","confidence":"high","taskCard":{"objective":"实现登录页","acceptanceCriteria":["lint:types 通过","单测覆盖回退"],"dependencies":["设计稿 v2"],"priority":"P1","projectId":"proj-login","sourceProject":"proj-web"}}]
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(bossService.addDelegationToHistory).toHaveBeenCalledTimes(1);
    const decision = vi.mocked(bossService.addDelegationToHistory).mock.calls[0][1];
    expect(decision.taskCard).toMatchObject({
      objective: '实现登录页',
      acceptanceCriteria: ['lint:types 通过', '单测覆盖回退'],
      dependencies: ['设计稿 v2'],
      priority: 'P1',
      projectId: 'proj-login',
      sourceProject: 'proj-web',
      status: 'pending',
    });
    expect(typeof decision.taskCard?.statusUpdatedAt).toBe('number');

    // 委托消息（发给下属）带可读任务卡
    const sentMessage = vi.mocked(runtimeService.sendCommand).mock.calls[0][1] as string;
    expect(sentMessage).toContain('[TASK CARD]');
    expect(sentMessage).toContain('单测覆盖回退');

    // 交付成功 → 🔴⑦ pending → running 迁移（异步 then 链）
    expect(bossService.updateDelegationTaskCardStatus).toHaveBeenCalledWith('boss-1', decision.id, 'running', expect.objectContaining({ subordinateId: 'agent-1' }));
  });

  it('内置技能规格守卫（待岗）：AGENT SELECTION 含 standby 规则；status API 描述含 standby 只读字段', () => {
    const content = bossInstructions.content;
    expect(content).toContain('NEVER pick an agent marked "Standby (待岗)"');
    expect(content).toContain('auto-refused');
    expect(content).toContain('restore someone from the agent panel');
    expect(content).toContain('isProcessRunning, standby');
  });

  it('本地规范规格守卫:三段本地团队规范已并入内置技能(所有 boss 出生自带)', () => {
    const content = bossInstructions.content;
    expect(content).toContain('LOCAL TEAM PROTOCOL');
    expect(content).toContain('【派活前 · 先扫团队笔记】');
    expect(content).toContain('【委派格式 · 收尾固定要求】');
    expect(content).toContain('【建队纪律 · 编制清单制】');
    expect(content).toContain('.team-notes');
    // 默认禁令仍在,例外指针指向同文件(自洽,不再靠跨文件「以本条为准」)
    expect(content).toContain('NEVER spawn automatically');
    expect(content).toContain('唯一例外(EXCEPTION)');
    expect(content).not.toContain('本条与内置技能冲突时');
  });

  it('任务卡(⑦):格式错误只降级无卡,派活与委派史仍按纯文本完成(向后兼容)', async () => {
    const resultText = `\`\`\`delegation
[{"selectedAgentId":"agent-1","selectedAgentName":"Builder One","taskCommand":"纯文本任务","confidence":"high","taskCard":{"acceptanceCriteria":["缺少 objective"]}}]
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(runtimeService.sendCommand).toHaveBeenCalledTimes(1);
    expect(bossService.addDelegationToHistory).toHaveBeenCalledTimes(1);
    const decision = vi.mocked(bossService.addDelegationToHistory).mock.calls[0][1];
    expect(decision.taskCard).toBeUndefined();
    expect(bossService.updateDelegationTaskCardStatus).not.toHaveBeenCalled();

    const sentMessage = vi.mocked(runtimeService.sendCommand).mock.calls[0][1] as string;
    expect(sentMessage).not.toContain('[TASK CARD]');
  });

  it('emits parse error and dispatches nothing when no JSON can be recovered', async () => {
    const resultText = `\`\`\`delegation
This is not JSON and has no parseable payload.
\`\`\``;

    parseBossDelegation('boss-1', 'Boss', resultText, broadcast);
    await Promise.resolve();

    expect(runtimeService.sendCommand).not.toHaveBeenCalled();
    const errorOutputs = broadcast.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg?.type === 'output' && typeof msg?.payload?.text === 'string' && msg.payload.text.includes('Delegation parse error'));
    expect(errorOutputs.length).toBeGreaterThan(0);
  });
});

describe('boss-response-handler parseBossSpawn initial skills', () => {
  const broadcast = vi.fn();
  const sendActivity = vi.fn();

  const spawnText = (entry: Record<string, unknown>) =>
    `Spawning a specialist.\n\n\`\`\`spawn\n${JSON.stringify([entry])}\n\`\`\``;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentService.getAgent).mockImplementation(((id: string) => ({
      id, name: id, class: 'boss', cwd: '/repo',
    })) as any);
    vi.mocked(agentService.createAgent).mockResolvedValue({
      id: 'new-1', name: 'Nova', class: 'builder',
    } as any);
    // Mirrors the real resolver: explicit list wins verbatim; a missing list
    // yields the installation defaults (here two builtin slugs).
    vi.mocked(skillService.resolveInitialSkillIdsForCreate).mockImplementation(
      (requested?: string[]) => requested ?? ['builtin-agent-memory', 'builtin-streaming-exec'],
    );
  });

  it('fills in the installation defaults when the spawn block omits initialSkillIds', async () => {
    await parseBossSpawn(
      'boss-1', 'Boss',
      spawnText({ name: 'Nova', class: 'builder' }),
      broadcast, sendActivity,
    );

    expect(skillService.resolveInitialSkillIdsForCreate).toHaveBeenCalledWith(undefined);
    expect(skillService.assignSkillToAgent).toHaveBeenCalledWith('builtin-agent-memory', 'new-1');
    expect(skillService.assignSkillToAgent).toHaveBeenCalledWith('builtin-streaming-exec', 'new-1');
  });

  it('respects an explicit empty list — no default fill-in', async () => {
    await parseBossSpawn(
      'boss-1', 'Boss',
      spawnText({ name: 'Nova', class: 'builder', initialSkillIds: [] }),
      broadcast, sendActivity,
    );

    expect(skillService.resolveInitialSkillIdsForCreate).toHaveBeenCalledWith([]);
    expect(skillService.assignSkillToAgent).not.toHaveBeenCalled();
  });
});
