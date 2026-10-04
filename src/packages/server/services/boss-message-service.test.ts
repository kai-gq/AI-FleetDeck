/**
 * 任务10·⑦ 任务对象化：buildBossMessage 委托消息注入任务卡（向后兼容纯文本）。
 * 验收 ⑥1（回退纯文本兼容）+ 交付物「委托消息注入」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-service.js', () => ({
  getAgent: vi.fn(() => ({ name: 'Boss', customInstructions: undefined })),
}));

vi.mock('./subordinate-context-service.js', () => ({
  buildBossContext: vi.fn(async () => null),
}));

import { BOSS_CONTEXT_START, BOSS_CONTEXT_END, type TaskCard } from '../../shared/types.js';
import { buildBossMessage } from './boss-message-service.js';
import { buildBossContext } from './subordinate-context-service.js';

const card: TaskCard = {
  objective: '实现登录页',
  acceptanceCriteria: ['lint:types 通过', '单测覆盖回退'],
  dependencies: ['设计稿 v2'],
  priority: 'P1',
  projectId: 'proj-login',
  status: 'pending',
};

describe('buildBossMessage — ⑦ 任务卡注入', () => {
  beforeEach(() => {
    vi.mocked(buildBossContext).mockResolvedValue(null);
  });

  it('旧两参调用（无卡）输出与旧版逐字节一致,不出现任务卡块', async () => {
    const { message, systemPrompt } = await buildBossMessage('boss-1', '修登录回退');

    expect(message).toBe(`${BOSS_CONTEXT_START}
# BOSS STATUS

You are "Boss", a Boss Agent in Tide Commander.

**CURRENT TEAM:** No subordinates assigned yet.

To be effective, you need subordinate agents assigned to your team. Ask the user to assign agents to you.
${BOSS_CONTEXT_END}

修登录回退`);
    expect(message).not.toContain('[TASK CARD]');
    expect(systemPrompt).toContain('You are "Boss"');
  });

  it('显式传入任务卡：注入可读卡 + delegation 块字段提示,命令保持在末尾', async () => {
    const { message } = await buildBossMessage('boss-1', '实现登录页', card);

    expect(message).toContain('[TASK CARD]');
    expect(message).toContain('Objective: 实现登录页');
    expect(message).toContain('- 单测覆盖回退');
    expect(message).toContain('"taskCard":');
    expect(message).toContain('"acceptanceCriteria":["lint:types 通过","单测覆盖回退"]');
    expect(message.endsWith('实现登录页')).toBe(true);
  });

  it('命令文本中的 ```task-card 围栏块自动解析注入（vcs/API 旧签名调用方也能吃到）', async () => {
    const command = `按这个卡来做:\n\`\`\`task-card\n{"objective":"修登录回退","acceptanceCriteria":["回归全绿"],"priority":"high"}\n\`\`\``;
    const { message } = await buildBossMessage('boss-1', command);

    expect(message).toContain('[TASK CARD]');
    expect(message).toContain('Objective: 修登录回退');
    expect(message).toContain('Priority: P1');
  });

  it('围栏块非法 → 回退纯文本（不注入卡、不抛）', async () => {
    const command = '任务如下\n```task-card\n{不是 JSON}\n```';
    const { message } = await buildBossMessage('boss-1', command);
    expect(message).not.toContain('[TASK CARD]');
    expect(message.endsWith(command)).toBe(true);
  });

  it('有下属（团队上下文）时卡块仍注入在上下文围栏之后', async () => {
    vi.mocked(buildBossContext).mockResolvedValueOnce('团队上下文');
    const { message } = await buildBossMessage('boss-1', '实现登录页', card);
    expect(message).toContain('团队上下文');
    expect(message.indexOf('[TASK CARD]')).toBeGreaterThan(message.indexOf(BOSS_CONTEXT_END));
  });
});
