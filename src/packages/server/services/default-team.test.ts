/**
 * 出厂默认团队（默认数据）测试：
 * 构造形状（6 人/待岗/站位/职级面）、种子门（全新才种、有数据一律不动、开关、
 * 异常吞掉）、真实数据层回环（沙盒 XDG：种一次 → 读回 6 人 → 再种 0）。
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDefaultTeamAgents, DEFAULT_TEAM_SEED, seedDefaultTeamIfEmpty } from './default-team.js';
import { hasPersistedAgents, loadAgents, saveAgents } from '../data/index.js';

function makeUid(): () => string {
  let n = 0;
  return () => `uid-${++n}`;
}

describe('出厂默认团队 · 构造', () => {
  it('构造 6 名成员，名字/职级与名册逐项一致且职级互不相同', () => {
    const team = buildDefaultTeamAgents({ uid: makeUid(), now: () => 1234, homedir: () => '/tmp/demo-home' });

    expect(team).toHaveLength(6);
    expect(team.map((a) => a.name)).toEqual(DEFAULT_TEAM_SEED.map((m) => m.name));
    expect(team.map((a) => a.class)).toEqual(DEFAULT_TEAM_SEED.map((m) => m.class));
    expect(new Set(team.map((a) => a.class)).size).toBe(6);
    expect(team.some((a) => a.class === 'boss')).toBe(false);
  });

  it('全员待岗、idle、cwd 取注入的家目录、时间戳取自注入时钟', () => {
    const team = buildDefaultTeamAgents({ uid: makeUid(), now: () => 1234, homedir: () => '/tmp/demo-home' });

    for (const agent of team) {
      expect(agent.standby).toBe(true);
      expect(agent.status).toBe('idle');
      expect(agent.cwd).toBe('/tmp/demo-home');
      expect(agent.provider).toBe('claude');
      expect(agent.tokensUsed).toBe(0);
      expect(agent.contextUsed).toBe(0);
      expect(agent.createdAt).toBe(1234);
    }
    expect(new Set(team.map((a) => a.id)).size).toBe(6);
  });

  it('站位为操场中线一排：y=0、z 相同、x 关于 0 对称且互不重叠', () => {
    const team = buildDefaultTeamAgents({ uid: makeUid() });
    const xs = team.map((a) => a.position.x);

    expect(team.every((a) => a.position.y === 0)).toBe(true);
    expect(new Set(team.map((a) => a.position.z)).size).toBe(1);
    expect(new Set(xs).size).toBe(6);
    expect(xs.reduce((s, x) => s + x, 0)).toBeCloseTo(0, 10);
  });
});

describe('出厂默认团队 · 种子门', () => {
  it('全新数据目录：种下 6 人并落盘一次', () => {
    const save = vi.fn();
    const count = seedDefaultTeamIfEmpty({
      hasPersistedAgents: () => false,
      loadAgents: () => [],
      saveAgents: save,
      buildAgents: () => buildDefaultTeamAgents({ uid: makeUid() }),
    });

    expect(count).toBe(6);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toHaveLength(6);
  });

  it('agents.json 已存在（哪怕是空列表＝用户删光）：一律不种', () => {
    const save = vi.fn();
    const count = seedDefaultTeamIfEmpty({
      hasPersistedAgents: () => true,
      loadAgents: () => [],
      saveAgents: save,
    });

    expect(count).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('已有成员：不种', () => {
    const save = vi.fn();
    const count = seedDefaultTeamIfEmpty({
      hasPersistedAgents: () => false,
      loadAgents: () => [{ id: 'x' }],
      saveAgents: save,
    });

    expect(count).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('开关关闭：不种', () => {
    const save = vi.fn();
    const count = seedDefaultTeamIfEmpty({
      enabled: false,
      hasPersistedAgents: () => false,
      loadAgents: () => [],
      saveAgents: save,
    });

    expect(count).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('落盘抛错：吞掉并返回 0，不阻塞启动', () => {
    const count = seedDefaultTeamIfEmpty({
      hasPersistedAgents: () => false,
      loadAgents: () => [],
      saveAgents: () => {
        throw new Error('disk full');
      },
    });

    expect(count).toBe(0);
  });
});

describe('出厂默认团队 · 真实数据层回环（沙盒 XDG）', () => {
  it('全新沙盒：种一次 → 读回 6 名待岗成员 → 再种为 0', () => {
    // 测试沙盒（src/test-setup.ts）每文件一个空 XDG，agents.json 必然不存在。
    expect(hasPersistedAgents()).toBe(false);

    const first = seedDefaultTeamIfEmpty({ hasPersistedAgents, loadAgents, saveAgents });
    expect(first).toBe(6);

    const stored = loadAgents();
    expect(stored).toHaveLength(6);
    expect(stored.map((a) => a.name)).toEqual(DEFAULT_TEAM_SEED.map((m) => m.name));
    expect(stored.every((a) => a.standby === true)).toBe(true);

    // 文件已落盘 → 第二次启动不再种（含用户删光场景）。
    expect(seedDefaultTeamIfEmpty({ hasPersistedAgents, loadAgents, saveAgents })).toBe(0);
  });
});
