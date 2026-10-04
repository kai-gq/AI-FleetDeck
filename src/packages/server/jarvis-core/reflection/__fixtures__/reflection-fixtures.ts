/**
 * jarvis-core/reflection · 黄金回归固定样本（任务 28 ②/⑥，06-11 §13.3）
 *
 * 10 组历史会话摘要 fixtures（测试资产）+ 每组配套的确定性 LLM 提案
 * （createStaticReflectionLlm 原样返回，替代真实通道）。边界款覆盖：
 *   空会话（f02）/ 超短摘要（f03）/ 决定类（f04）/ 矛盾知识（f05）/
 *   超 30 天未用知识（f06）/ 高置信删除（f07）/ PROMOTE 阈值边界（f08）/
 *   元数据 vs 正文更新（f09）/ 首次运行强制 Tier2（f10）。
 * 另含 f01 安全基准（零 Tier2 拦截）。
 *
 * 时间全部相对固定 FIXTURE_NOW（不依赖运行时钟）→ 黄金文件逐字节可比。
 */

import type { MemoryEntry, MemoryLayer, MemorySource } from '../../memory/types.js';
import type {
  IngestedSessionSummary,
  ReflectionIngestBundle,
  ReflectionProposalBundle,
} from '../types.js';

/** 固定基准时刻：2026-10-04 02:00:00 UTC（夜间反思触发时点）。 */
export const FIXTURE_NOW = Date.UTC(2026, 9, 4, 2, 0, 0);

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 固定窗口起点（fixture 内自洽即可；引擎侧口径见 gate.startOfLocalDay）。 */
export const FIXTURE_SINCE = FIXTURE_NOW - 8 * 60 * 60 * 1000;

export interface MakeEntryInput extends Partial<Omit<MemoryEntry, 'id' | 'text'>> {
  id: string;
  text: string;
}

/** 构造一条完整记忆条目（缺省值固定，保证 fixture 可复现）。 */
export function makeEntry(input: MakeEntryInput): MemoryEntry {
  return {
    id: input.id,
    layer: input.layer ?? ('long-term' as MemoryLayer),
    source: input.source ?? ('agent-confirmed' as MemorySource),
    kind: input.kind ?? 'note',
    text: input.text,
    createdAt: input.createdAt ?? FIXTURE_NOW - 3 * DAY_MS,
    updatedAt: input.updatedAt ?? input.createdAt ?? FIXTURE_NOW - 3 * DAY_MS,
    useCount: input.useCount ?? 0,
    status: input.status ?? 'active',
    sessionId: input.sessionId,
    tags: input.tags,
    promotedFrom: input.promotedFrom,
    markedAt: input.markedAt,
    markReason: input.markReason,
  };
}

function session(sessionId: string, summary: string, agoMs: number): IngestedSessionSummary {
  return { sessionId, summary, at: FIXTURE_NOW - agoMs };
}

export interface ReflectionFixture {
  name: string;
  description: string;
  /** 首次运行（强制 Tier2）。 */
  firstRun?: boolean;
  /** 门槛校验口径的会话数（通常 = sessions.length）。 */
  sessionCount: number;
  sessions: IngestedSessionSummary[];
  workingEntries?: MemoryEntry[];
  markedEntries?: MemoryEntry[];
  growthLogEntries?: MemoryEntry[];
  longTermEntries?: MemoryEntry[];
  proposals: ReflectionProposalBundle;
}

export function ingestOf(fixture: ReflectionFixture): ReflectionIngestBundle {
  return {
    now: FIXTURE_NOW,
    since: FIXTURE_SINCE,
    sessions: fixture.sessions,
    workingEntries: fixture.workingEntries ?? [],
    markedEntries: fixture.markedEntries ?? [],
    growthLogEntries: fixture.growthLogEntries ?? [],
    longTermEntries: fixture.longTermEntries ?? [],
    errors: [],
  };
}

// ============================================================================
// 10 组固定样本
// ============================================================================

const fiveShortSessions = [
  session('s31', '确认了测试范围', 6 * 60 * 60 * 1000),
  session('s32', '跑了回归', 5 * 60 * 60 * 1000),
  session('s33', '看了日志', 4 * 60 * 60 * 1000),
  session('s34', '整理了待办', 3 * 60 * 60 * 1000),
  session('s35', '提前收工', 2 * 60 * 60 * 1000),
];

export const REFLECTION_FIXTURES: readonly ReflectionFixture[] = [
  // f01 安全基准：低置信新知识 + 高使用 PROMOTE → 全 Tier1，零拦截
  {
    name: 'f01-multi-session-pattern',
    description: '跨会话重复模式 → 低置信 NEW(Tier1) + use_count 12 → PROMOTE(Tier1)，零 Tier2',
    sessionCount: 6,
    sessions: [
      session('s1', '先跑测试再提交，避免回滚', 10 * 60 * 60 * 1000),
      session('s2', '讨论了构建脚本', 9 * 60 * 60 * 1000),
      session('s3', '又是先跑测试再提交', 8 * 60 * 60 * 1000),
      session('s4', '排查了一个环境问题', 7 * 60 * 60 * 1000),
      session('s5', '提交前先跑测试成了习惯', 6 * 60 * 60 * 1000),
      session('s6', '闲聊', 5 * 60 * 60 * 1000),
    ],
    workingEntries: [
      makeEntry({
        id: 'wt-pnpm',
        layer: 'working',
        text: '项目用 pnpm workspace 管理多包',
        useCount: 12,
        updatedAt: FIXTURE_NOW - 60 * 60 * 1000,
      }),
    ],
    longTermEntries: [
      makeEntry({
        id: 'lt-pnpm',
        source: 'user-stated',
        kind: 'preference',
        text: '用户偏好使用 pnpm 安装依赖',
        tags: ['preference'],
        useCount: 3,
        updatedAt: FIXTURE_NOW - 2 * DAY_MS,
      }),
    ],
    proposals: {
      newEntries: [
        {
          text: '用户习惯先跑测试再提交',
          confidence: 'low',
          kind: 'reflection-pattern',
          evidenceSessionIds: ['s1', 's3', 's5'],
        },
      ],
      promotes: [{ id: 'wt-pnpm', target: 'long-term' }],
      morningDraft: '昨天主要推进测试流程；今天建议先跑一遍全量回归。',
    },
  },

  // f02 空会话：5 条空摘要 + 空提案 → 计划为空（不硬造操作）
  {
    name: 'f02-empty-sessions',
    description: '空会话摘要 + 空提案 → operations/rejected 全空，tier2Rate=0',
    sessionCount: 5,
    sessions: [
      session('s10', '', 5 * 60 * 60 * 1000),
      session('s11', '', 4 * 60 * 60 * 1000),
      session('s12', '', 3 * 60 * 60 * 1000),
      session('s13', '', 2 * 60 * 60 * 1000),
      session('s14', '', 1 * 60 * 60 * 1000),
    ],
    proposals: {},
  },

  // f03 超短摘要 + 坏引用：空文本/不存在 id → 全部如实拒绝，不产生操作
  {
    name: 'f03-short-summaries',
    description: '超短摘要 + 空文本 NEW + 不存在的 id → 全部拒绝登记（不假）',
    sessionCount: 5,
    sessions: [
      session('s21', 'ok', 5 * 60 * 60 * 1000),
      session('s22', '好', 4 * 60 * 60 * 1000),
      session('s23', '嗯', 3 * 60 * 60 * 1000),
      session('s24', '继续', 2 * 60 * 60 * 1000),
      session('s25', '收到', 1 * 60 * 60 * 1000),
    ],
    proposals: {
      newEntries: [{ text: '   ', confidence: 'low' }],
      updates: [{ id: 'missing-entry', tags: ['x'] }],
      deletes: [{ id: 'missing-entry' }],
      promotes: [{ id: 'missing-entry' }],
    },
  },

  // f04 决定类：NEW/UPDATE/DELETE 触及决定 → 全 Tier2（decision-class）
  {
    name: 'f04-decision-class',
    description: '决定类 NEW + 覆盖决定条目的 UPDATE/DELETE → Tier2（decision-class）',
    sessionCount: 5,
    sessions: fiveShortSessions,
    longTermEntries: [
      makeEntry({
        id: 'lt-branch-decision',
        kind: 'decision',
        tags: ['decision'],
        text: '决定项目主分支用 local（master 冻结为旧快照）',
        useCount: 4,
        updatedAt: FIXTURE_NOW - 10 * DAY_MS,
      }),
    ],
    proposals: {
      newEntries: [
        {
          text: '决定夜间反思只在本地跑，暂不接生产',
          confidence: 'low',
          evidenceSessionIds: ['s31'],
        },
      ],
      updates: [
        {
          id: 'lt-branch-decision',
          text: '决定项目主分支用 local 并冻结 master 快照',
          kind: 'decision',
        },
      ],
      deletes: [{ id: 'lt-branch-decision' }],
    },
  },

  // f05 矛盾知识：显式 contradicts + 启发式（改为/换成）→ Tier2；无冲突低置信 → Tier1
  {
    name: 'f05-contradiction',
    description: '显式 contradicts + 启发式矛盾 → Tier2；无关低置信 NEW → Tier1',
    sessionCount: 5,
    sessions: fiveShortSessions,
    longTermEntries: [
      makeEntry({
        id: 'lt-master',
        text: '项目主分支是 master',
        useCount: 2,
        updatedAt: FIXTURE_NOW - 6 * DAY_MS,
      }),
    ],
    proposals: {
      newEntries: [
        { text: '项目主分支改为 local', confidence: 'low', contradicts: ['lt-master'], evidenceSessionIds: ['s32'] },
        { text: '夜间反思产物写入 reflections 层', confidence: 'low', evidenceSessionIds: ['s33'] },
        { text: '项目主分支换成 trunk', confidence: 'low', evidenceSessionIds: ['s35'] },
      ],
    },
  },

  // f06 过期删除：31 天 0 使用 → Tier1；29 天未满 → Tier2（边界）
  {
    name: 'f06-stale-knowledge',
    description: '31 天 0 使用 DELETE → Tier1；29 天 → Tier2（阈值边界）',
    sessionCount: 5,
    sessions: fiveShortSessions,
    longTermEntries: [
      makeEntry({
        id: 'lt-old',
        text: '临时调研结论：候选方案 A 待验证',
        updatedAt: FIXTURE_NOW - 31 * DAY_MS,
      }),
      makeEntry({
        id: 'lt-recent',
        text: '候选方案 B 的细节记录',
        updatedAt: FIXTURE_NOW - 29 * DAY_MS,
      }),
    ],
    proposals: {
      deletes: [{ id: 'lt-old', note: '30 天未引用' }, { id: 'lt-recent' }],
    },
  },

  // f07 删除高置信：user-stated 40 天未用仍 Tier2；有使用记录的工作记忆 → Tier2
  {
    name: 'f07-high-confidence-delete',
    description: '删除 user-stated（高置信）条目 → Tier2；use_count>0 删除 → Tier2',
    sessionCount: 5,
    sessions: fiveShortSessions,
    workingEntries: [
      makeEntry({
        id: 'wt-used',
        layer: 'working',
        text: '被引用过的工作记忆',
        useCount: 5,
        updatedAt: FIXTURE_NOW - 60 * DAY_MS,
      }),
    ],
    longTermEntries: [
      makeEntry({
        id: 'lt-user',
        source: 'user-stated',
        text: '用户明确要求：提交说明一律用中文',
        updatedAt: FIXTURE_NOW - 40 * DAY_MS,
      }),
    ],
    proposals: {
      deletes: [{ id: 'lt-user' }, { id: 'wt-used' }],
    },
  },

  // f08 PROMOTE 边界：use_count 11 >10 → Tier1；10 → Tier2；inferred/growth-log/同层 → 拒绝
  {
    name: 'f08-promote-boundary',
    description: 'PROMOTE use_count 11 → Tier1；10 → Tier2；inferred/growth-log/同层 → 拒绝',
    sessionCount: 5,
    sessions: fiveShortSessions,
    workingEntries: [
      makeEntry({ id: 'wt-11', layer: 'working', text: '高频复用的构建命令', useCount: 11 }),
      makeEntry({ id: 'wt-10', layer: 'working', text: '常用端口约定', useCount: 10 }),
      makeEntry({
        id: 'wt-inf',
        layer: 'working',
        source: 'inferred',
        text: '推测：用户可能偏好夜里跑重任务',
        useCount: 99,
      }),
    ],
    growthLogEntries: [
      makeEntry({ id: 'gl-1', layer: 'growth-log', text: '学会先确认再动手', useCount: 3 }),
    ],
    longTermEntries: [
      makeEntry({ id: 'lt-already', text: '已经在长期知识里的条目' }),
    ],
    proposals: {
      promotes: [
        { id: 'wt-11' },
        { id: 'wt-10' },
        { id: 'wt-inf' },
        { id: 'gl-1' },
        { id: 'lt-already' },
      ],
    },
  },

  // f09 更新模式：元数据整理 → Tier1；正文更新 → Tier2；无改动/空文本 → 拒绝
  {
    name: 'f09-update-modes',
    description: '元数据整理 → Tier1；正文更新 → Tier2；no-change/空文本 → 拒绝',
    sessionCount: 5,
    sessions: fiveShortSessions,
    longTermEntries: [
      makeEntry({ id: 'lt-note', text: '会议纪要归档在 D 盘', tags: ['archive'] }),
      makeEntry({ id: 'lt-note2', text: '服务端口 7492' }),
    ],
    proposals: {
      updates: [
        { id: 'lt-note', tags: ['archive', 'd-drive'] },
        { id: 'lt-note2', text: '服务端口 7500' },
        { id: 'lt-note', text: '会议纪要归档在 D 盘' },
        { id: 'lt-note2', tags: ['port'] },
        { id: 'lt-note', text: '   ' },
      ],
    },
  },

  // f10 首次运行：全部操作强制 Tier2（未审不下发/不应用）
  {
    name: 'f10-first-run',
    description: 'firstRun=true → 四操作全部 Tier2（first-run 覆盖 Tier1 判定）',
    firstRun: true,
    sessionCount: 5,
    sessions: fiveShortSessions,
    workingEntries: [
      makeEntry({ id: 'wt-12', layer: 'working', text: '每周同步一次上游的高频操作', useCount: 12 }),
    ],
    longTermEntries: [
      makeEntry({
        id: 'lt-master',
        text: '项目主分支是 master',
        updatedAt: FIXTURE_NOW - 6 * DAY_MS,
      }),
      makeEntry({
        id: 'lt-stale',
        text: '旧调研记录：方案 C 待清理',
        updatedAt: FIXTURE_NOW - 40 * DAY_MS,
      }),
    ],
    proposals: {
      newEntries: [
        {
          text: '跨会话重复：每周同步一次上游',
          confidence: 'low',
          evidenceSessionIds: ['s31', 's34'],
        },
      ],
      updates: [{ id: 'lt-master', tags: ['branch'] }],
      deletes: [{ id: 'lt-stale' }],
      promotes: [{ id: 'wt-12' }],
      morningDraft: '首次反思：全部提案先过人工审查。',
    },
  },
];

/** 按名取样本（测试便捷）。 */
export function fixtureByName(name: string): ReflectionFixture {
  const found = REFLECTION_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`未知 fixture: ${name}`);
  return found;
}
