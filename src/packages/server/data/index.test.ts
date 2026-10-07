/**
 * agents.json 持久化白名单测试 —— 重点是「待岗」标志（standby）必须穿过
 * toStoredAgents 白名单落盘、再被 loadAgents 原样读回。
 *
 * fs 用内存桩：saveAgents 走原子写（tmp → rename），loadAgents 走
 * safeReadJsonSync，这条链路要在不碰真实数据目录的前提下完整跑通。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memfs = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs', () => {
  const read = (p: unknown): string => {
    const key = String(p);
    const value = memfs.files.get(key);
    if (value === undefined) throw new Error(`ENOENT: ${key}`);
    return value;
  };
  const move = (from: unknown, to: unknown): void => {
    const value = read(from);
    memfs.files.set(String(to), value);
    memfs.files.delete(String(from));
  };
  return {
    existsSync: (p: unknown) => memfs.files.has(String(p)),
    readFileSync: read,
    writeFileSync: (p: unknown, data: unknown) => {
      memfs.files.set(String(p), String(data));
    },
    copyFileSync: (from: unknown, to: unknown) => {
      memfs.files.set(String(to), read(from));
    },
    renameSync: move,
    mkdirSync: () => {},
    readdirSync: () => [],
    promises: {
      writeFile: async (p: unknown, data: unknown) => {
        memfs.files.set(String(p), String(data));
      },
      access: async (p: unknown) => {
        read(p);
      },
      copyFile: async (from: unknown, to: unknown) => {
        memfs.files.set(String(to), read(from));
      },
      rename: async (from: unknown, to: unknown) => move(from, to),
    },
  };
});

import type { Agent } from '../../shared/types.js';

const makeAgent = (overrides: Record<string, unknown>): Agent => ({
  id: 'a1',
  name: 'A1',
  class: 'default',
  status: 'idle',
  provider: 'claude',
  position: { x: 0, y: 0, z: 0 },
  cwd: '/tmp/project',
  permissionMode: 'bypass',
  tokensUsed: 0,
  contextUsed: 0,
  contextLimit: 200000,
  taskCount: 0,
  createdAt: 1,
  lastActivity: 1,
  ...overrides,
}) as unknown as Agent;

describe('agents.json standby persistence', () => {
  beforeEach(() => {
    memfs.files.clear();
    vi.resetModules();
  });

  it('round-trips standby:true through saveAgents → loadAgents', async () => {
    const { saveAgents, loadAgents } = await import('./index.js');
    saveAgents([
      makeAgent({ id: 'sb', standby: true }),
      makeAgent({ id: 'normal' }),
    ]);

    const stored = loadAgents();
    expect(stored).toHaveLength(2);
    expect(stored[0].standby).toBe(true);
    // 未待岗者不落 standby 键（只存 true 或省略，避免 agents.json 抖动）
    expect('standby' in stored[1]).toBe(false);
  });

  it('round-trips standby:true through the async hot-path save too', async () => {
    const { saveAgentsAsync, loadAgents } = await import('./index.js');
    await saveAgentsAsync([makeAgent({ id: 'sb', standby: true })]);

    expect(loadAgents()[0].standby).toBe(true);
  });
});
