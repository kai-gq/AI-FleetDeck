/**
 * jarvis-production 单测（W13 生产接线）
 *
 * 覆盖：agent 快照映射；system-health 体检（假 statfs/计数注入，单段失败隔离）；
 * git 项目事件适配器（首采只建基线 / 新增提交 / 分支切换 / 失败上抛给 sense 降级）；
 * 记忆条目 → 信号映射（tag 白名单 / 非活跃跳过）；init/shutdown 全链（真服务未初始化
 * 也不炸，六源齐采一轮建基线，三方 flush 注册与注销）。
 * 证据等级 L1（mock 注入为主；init 冒烟为 L2 本地真实服务未初始化环境）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryEntry } from '../jarvis-core/memory/index.js';
import { listPreparedQueues, resetPreparedFlushForTests } from '../jarvis-core/prepare-flush.js';
import {
  buildAgentSnapshot,
  createGitProjectEventsPort,
  createSystemHealthPort,
  initJarvisCoreProduction,
  isJarvisCoreEnabled,
  mapMemoryEntriesToSignals,
  parseGitLog,
  resetJarvisCoreProductionForTests,
  shutdownJarvisCoreProduction,
  JARVIS_CORE_ENV_KEY,
} from './jarvis-production.js';
import { resetUserActivityForTests } from './user-activity-service.js';
import type { Agent } from '../../shared/agent-types.js';

// ============================================================================
// agent-state
// ============================================================================

describe('实端口：agent-state（getAllAgents 快照映射）', () => {
  it('status 直用，currentTask→taskLabel、lastError 透传；缺省字段不带键', () => {
    const agents = [
      { id: 'a1', name: '小美', status: 'working', currentTask: '登录页' },
      { id: 'a2', name: '大军', status: 'error', lastError: '拉取失败' },
      { id: 'a3', name: '阿蓝', status: 'idle' },
    ] as unknown as Agent[];

    const snapshot = buildAgentSnapshot(agents);
    expect([...snapshot.keys()]).toEqual(['a1', 'a2', 'a3']);
    expect(snapshot.get('a1')).toEqual({ name: '小美', status: 'working', taskLabel: '登录页' });
    expect(snapshot.get('a2')).toEqual({ name: '大军', status: 'error', lastError: '拉取失败' });
    expect(snapshot.get('a3')).toEqual({ name: '阿蓝', status: 'idle' });
  });
});

// ============================================================================
// system-health
// ============================================================================

describe('实端口：system-health（statfs + 日志错误计数）', () => {
  it('磁盘换算 freePercent；计数 >0 才带 logErrors；单盘/计数失败逐段跳过', async () => {
    const ok = createSystemHealthPort({
      roots: ['E:\\', 'C:\\'],
      statfs: async (target) => {
        if (target === 'C:\\') throw new Error('no C');
        return { blocks: 100, bsize: 10, bavail: 25 };
      },
      countErrors: () => 7,
      now: () => 5_000_000,
    });
    await expect(ok.probe()).resolves.toEqual({
      disks: [{ mount: 'E:\\', freePercent: 25, freeBytes: 250, totalBytes: 1_000 }],
      logErrors: { recentCount: 7 },
    });

    // 日志计数抛错 → 跳过该段（不误报）；0 条 → 不带 logErrors 键
    const broken = createSystemHealthPort({
      roots: ['E:\\'],
      statfs: async () => ({ blocks: 100, bsize: 10, bavail: 50 }),
      countErrors: () => {
        throw new Error('db down');
      },
    });
    await expect(broken.probe()).resolves.toEqual({
      disks: [{ mount: 'E:\\', freePercent: 50, freeBytes: 500, totalBytes: 1_000 }],
    });

    const quiet = createSystemHealthPort({
      roots: ['E:\\'],
      statfs: async () => ({ blocks: 100, bsize: 10, bavail: 50 }),
      countErrors: () => 0,
    });
    const probe = await quiet.probe();
    expect(probe.logErrors).toBeUndefined();
  });
});

// ============================================================================
// project-events（git）
// ============================================================================

const H = (prefix: string): string => `${prefix}${'0'.repeat(40 - prefix.length)}`;
const line = (hash: string, ct: number, subject: string): string => `${hash}\u0001${ct}\u0001${subject}`;

/** 可变 git 假执行器（log/rev-parse 两问）。 */
function gitFake(state: { log: string; branch: string; fail?: boolean }) {
  return async (args: readonly string[]): Promise<string> => {
    if (state.fail) throw new Error('git boom');
    if (args[0] === 'log') return state.log;
    if (args[0] === 'rev-parse') return `${state.branch}\n`;
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

describe('实端口：project-events（git poll 适配器）', () => {
  it('parseGitLog：解析 hash/秒戳/主题；畸形行丢弃', () => {
    const stdout = [line('aaa', 100, '第一次'), '', 'broken', line('bbb', 200, '第二次')].join('\n');
    expect(parseGitLog(stdout)).toEqual([
      { hash: 'aaa', at: 100_000, subject: '第一次' },
      { hash: 'bbb', at: 200_000, subject: '第二次' },
    ]);
  });

  it('首次 poll 只建基线；此后新增提交按时间正序产出（dedupeKey=commit hash）', async () => {
    const c1 = H('c1');
    const c2 = H('c2');
    const c3 = H('c3');
    const state = { log: [line(c2, 200, '第二次'), line(c1, 100, '第一次')].join('\n'), branch: 'local' };
    let nowMs = 1_000;
    const port = createGitProjectEventsPort({ execGit: gitFake(state), now: () => nowMs, projectId: 'tc' });

    expect(await port.poll()).toEqual([]); // 基线：历史提交不当新事件

    // 两次提交后一次 poll：仍按旧→新产出
    state.log = [line(c3, 300, '第三次'), line(c2, 200, '第二次'), line(c1, 100, '第一次')].join('\n');
    expect(await port.poll()).toEqual([
      {
        kind: 'git_commit',
        at: 300_000,
        projectId: 'tc',
        text: `新提交 ${c3.slice(0, 7)}: 第三次`,
        payload: { hash: c3 },
        dedupeKey: `git-commit:${c3}`,
      },
    ]);

    // 无新提交 → 空（seen 去重）
    expect(await port.poll()).toEqual([]);
  });

  it('分支切换产出 branch_changed（带原分支）；同分支重复 poll 不产', async () => {
    const c1 = H('d1');
    const state = { log: line(c1, 100, '初始'), branch: 'local' };
    let nowMs = 1_000;
    const port = createGitProjectEventsPort({ execGit: gitFake(state), now: () => nowMs });
    await port.poll(); // 基线

    state.branch = 'main';
    nowMs = 2_000;
    expect(await port.poll()).toEqual([
      {
        kind: 'branch_changed',
        at: 2_000,
        text: '分支切换到 main（原 local）',
        payload: { branch: 'main', previous: 'local' },
        dedupeKey: 'git-branch:main@2000',
      },
    ]);
    expect(await port.poll()).toEqual([]); // 分支稳定后不重复
  });

  it('git 执行失败 → poll 上抛（由 sense 记为 port_error 降级）', async () => {
    const state = { log: '', branch: 'local', fail: true };
    const port = createGitProjectEventsPort({ execGit: gitFake(state) });
    await expect(port.poll()).rejects.toThrow('git boom');
  });
});

// ============================================================================
// memory-signals
// ============================================================================

describe('实端口：memory-signals（working 条目 → 信号映射）', () => {
  const entry = (over: Partial<MemoryEntry>): MemoryEntry => ({
    id: 'm1',
    layer: 'working',
    source: 'user-stated',
    kind: 'correction',
    text: '答应过周五交',
    createdAt: 1,
    updatedAt: 2,
    useCount: 0,
    status: 'active',
    ...over,
  });

  it('tag 白名单映射；非活跃/未命中 tag 跳过；字段齐备', () => {
    const inputs = mapMemoryEntriesToSignals([
      entry({ tags: ['promise'] }),
      entry({ id: 'm2', tags: ['knowledge-gap'], text: '不知道下次评审时间' }),
      entry({ id: 'm3', tags: ['other'] }),
      entry({ id: 'm4', tags: ['promise'], status: 'pending-reflection' }),
      entry({ id: 'm5' }), // 无 tags
    ]);
    expect(inputs).toEqual([
      { kind: 'promise_unkept', itemId: 'm1', text: '答应过周五交', at: 2, payload: { tags: ['promise'] } },
      { kind: 'knowledge_gap', itemId: 'm2', text: '不知道下次评审时间', at: 2, payload: { tags: ['knowledge-gap'] } },
    ]);
  });
});

// ============================================================================
// init / shutdown 冒烟
// ============================================================================

describe('init / shutdown（开关 + 生命周期）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'jarvis-prod-'));
    vi.stubEnv('XDG_DATA_HOME', tmp); // 活动账/记忆库重定向到临时目录，不碰真实数据
    resetUserActivityForTests();
  });

  afterEach(async () => {
    await shutdownJarvisCoreProduction();
    resetJarvisCoreProductionForTests();
    resetPreparedFlushForTests();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('TC_JARVIS_CORE=0 → init 返回 null（一键关闭）', () => {
    vi.stubEnv(JARVIS_CORE_ENV_KEY, '0');
    expect(isJarvisCoreEnabled()).toBe(false);
    expect(initJarvisCoreProduction()).toBeNull();
  });

  it('缺省开：init 幂等 → 启动轮建基线 → 三方 flush 注册 → shutdown 清空', async () => {
    expect(isJarvisCoreEnabled()).toBe(true);
    const handle = initJarvisCoreProduction();
    expect(handle).not.toBeNull();
    expect(initJarvisCoreProduction()).toBe(handle); // 幂等：不重复启动

    await handle!.heartbeat.whenIdle(); // 等启动轮（wakeNow）收尾：真服务未初始化也不炸
    expect(handle!.heartbeat.stats.cycles).toBeGreaterThanOrEqual(1);
    expect(listPreparedQueues()).toEqual(expect.arrayContaining(['jarvis-core', 'bolba-due', 'boss-morning']));

    await shutdownJarvisCoreProduction();
    expect(listPreparedQueues()).toEqual([]);
  });
});
