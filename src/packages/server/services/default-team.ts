/**
 * 出厂默认团队（默认数据）
 *
 * 全新数据目录（从未落盘过 agents.json）首启时种下一支 6 人待岗团队：
 * 新装用户/演示环境开箱就有一支可展示、可随时恢复的中文假名编队，而不是
 * 空白战场。发布物只含这份通用假名数据，不含任何真实用户的代理/会话数据。
 *
 * 口径：
 * - 只认「agents.json 从未存在」＝全新数据目录 → 种一次；文件存在（含空列表，
 *   即用户主动删光）→ 一律不动，绝不覆盖/复活。
 * - 6 名成员统一 standby:true：无进程、拒接派活、档案保留、可右键恢复；
 *   互不隶属（无 boss 关系），职级取 6 个内置非 Boss 职级（3 男 3 女模型齐）。
 * - cwd 取 os.homedir()：本机运行时计算，不落任何固定路径；恢复时能直接起进程。
 * - 名字为通用中文假名（07-07 演示数据口径），与任何真实团队无关。
 * - 开关：TC_DEFAULT_TEAM=0 关闭（种子逻辑只挂在 server/index.ts 启动段，
 *   不进 initAgents——测试沙盒 XDG 恒为空，挂在 initAgents 会污染既有用例）。
 */

import * as os from 'os';

import type { Agent } from '../../shared/types.js';
import { generateId } from '../utils/index.js';
import { hasPersistedAgents, loadAgents, saveAgents } from '../data/index.js';
import { logger } from '../utils/index.js';

const log = logger.server;

/** 默认 contextLimit：与 agent-service 同值（claude 启动后由 initAgents 重算，此处仅满足类型）。 */
const DEFAULT_CLAUDE_CONTEXT_LIMIT = 200000;

/** 默认团队名册（顺序即站位顺序：从西到东一排，居中）。 */
export const DEFAULT_TEAM_SEED: ReadonlyArray<{ name: string; class: Agent['class'] }> = [
  { name: '小刘', class: 'scout' },
  { name: '小陈', class: 'builder' },
  { name: '小杨', class: 'architect' },
  { name: '小林', class: 'debugger' },
  { name: '小周', class: 'warrior' },
  { name: '小唐', class: 'support' },
];

/** 每名成员的站位于操场中线一排：x 从 -5 到 +5（步长 2），z=2。 */
const FORMATION_Z = 2;
const FORMATION_SPACING = 2;

export interface DefaultTeamBuildDeps {
  now?: () => number;
  uid?: () => string;
  homedir?: () => string;
}

/** 构造默认团队的运行时 Agent 对象（纯函数；不落盘、不广播）。 */
export function buildDefaultTeamAgents(deps: DefaultTeamBuildDeps = {}): Agent[] {
  const now = deps.now?.() ?? Date.now();
  const uid = deps.uid ?? generateId;
  const cwd = (deps.homedir ?? os.homedir)();
  const startX = -((DEFAULT_TEAM_SEED.length - 1) * FORMATION_SPACING) / 2;

  return DEFAULT_TEAM_SEED.map((member, index) => ({
    id: uid(),
    name: member.name,
    class: member.class,
    status: 'idle',
    provider: 'claude',
    position: { x: startX + index * FORMATION_SPACING, y: 0, z: FORMATION_Z },
    cwd,
    permissionMode: 'bypass',
    tokensUsed: 0,
    contextUsed: 0,
    contextLimit: DEFAULT_CLAUDE_CONTEXT_LIMIT,
    taskCount: 0,
    createdAt: now,
    lastActivity: now,
    standby: true,
  }));
}

export interface DefaultTeamSeedDeps {
  /** 是否启用（默认读 TC_DEFAULT_TEAM !== '0'）。 */
  enabled?: boolean;
  hasPersistedAgents?: () => boolean;
  loadAgents?: () => ReadonlyArray<unknown>;
  saveAgents?: (agents: Agent[]) => void;
  buildAgents?: () => Agent[];
}

/**
 * 全新数据目录时种下默认团队；返回种下的成员数（0＝未种）。
 * 任何异常都吞掉——首启种子绝不阻塞服务启动。
 */
export function seedDefaultTeamIfEmpty(deps: DefaultTeamSeedDeps = {}): number {
  try {
    const enabled = deps.enabled ?? process.env.TC_DEFAULT_TEAM !== '0';
    if (!enabled) return 0;

    const hasPersisted = deps.hasPersistedAgents ?? hasPersistedAgents;
    if (hasPersisted()) return 0;

    const load = deps.loadAgents ?? loadAgents;
    if (load().length > 0) return 0;

    const team = (deps.buildAgents ?? buildDefaultTeamAgents)();
    if (team.length === 0) return 0;

    const save = deps.saveAgents ?? saveAgents;
    save(team);
    log.log(` Seeded default team (${team.length} standby agents) — fresh data dir`);
    return team.length;
  } catch (err) {
    log.warn(` Default team seed skipped: ${String(err)}`);
    return 0;
  }
}
