/**
 * 任务06·③ 委派史注入秘书(团队认知)——Boss 快照升级 + 委派史注入单测。
 *
 * 背景:真实数据目录的 delegation-history.json 不存在(从未有委派写盘),因此:
 * - 纯函数测试用内存 fixture(Boss→下属→任务→状态);
 * - 服务级测试把 fixture 写进 test-setup 的 XDG 临时沙箱,再走 bossService.init()
 *   真实读取链路读回 —— 不碰真实数据目录、不跑真委派(真链路由金丝雀工具承接)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildAgentSnapshotLines,
  buildCompanionSystemPrompt,
  buildDelegationSummaryLines,
  collectDelegationHistory,
  type CompanionMemory,
  type SnapshotAgent,
} from './voice-companion-service.js';
import * as bossService from './boss-service.js';
import type { DelegationDecision } from '../../shared/agent-types.js';
import type { DrawingArea } from '../../shared/common-types.js';

let decisionSeq = 0;

function decision(overrides: {
  bossId: string;
  selectedAgentName: string;
  userCommand: string;
  timestamp: number;
}): DelegationDecision {
  decisionSeq += 1;
  return {
    id: `del-fixture-${decisionSeq}`,
    timestamp: overrides.timestamp,
    bossId: overrides.bossId,
    userCommand: overrides.userCommand,
    selectedAgentId: `agent-${overrides.selectedAgentName}`,
    selectedAgentName: overrides.selectedAgentName,
    reasoning: 'fixture',
    alternativeAgents: [],
    confidence: 'medium',
    status: 'sent',
  };
}

function emptyMemory(): CompanionMemory {
  return { summary: '', notes: [], updatedAt: 0, droppedCount: 0 };
}

function area(id: string, name: string, assignedAgentIds: string[]): DrawingArea {
  return {
    id,
    name,
    type: 'rectangle',
    center: { x: 0, z: 0 },
    color: '#888888',
    zIndex: 0,
    assignedAgentIds,
    directories: [],
  };
}

/** 两个 Boss + 三个下属的固定世界(带区域与忙闲)。 */
const world: SnapshotAgent[] = [
  { id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'working', lastWorkedAt: 400, subordinateIds: ['a1', 'a2'] },
  { id: 'b2', name: '二当家', class: 'boss', isBoss: true, status: 'idle', lastWorkedAt: 300, subordinateIds: ['a3'] },
  { id: 'a1', name: '小美', class: 'builder', status: 'working', bossId: 'b1', lastWorkedAt: 200 },
  { id: 'a2', name: '老王', class: 'builder', status: 'idle', bossId: 'b1', lastWorkedAt: 100 },
  { id: 'a3', name: '阿强', class: 'builder', status: 'waiting', bossId: 'b2', lastWorkedAt: 50 },
];

const worldAreas: DrawingArea[] = [
  area('ar1', '前端区', ['a1']),
  area('ar2', '指挥区', ['b1']),
];

/** hop1 prompt 最小输入;委派史相关字段由调用方按需附加。 */
function buildPrompt(opts: {
  delegationHistory?: readonly DelegationDecision[];
  bossNames?: ReadonlyMap<string, string>;
} = {}): string {
  return buildCompanionSystemPrompt({
    agentLines: ['- 大当家 | id: b1 | boss | working [BOSS] | 下属(2): 1忙/1闲 — 小美(working·前端区)、老王(idle)'],
    totalAgents: 5,
    truncated: false,
    memory: emptyMemory(),
    ...opts,
  });
}

// ============================================================================
// 快照升级:从「只标 [BOSS]」到「Boss 卡片含下属结构/忙闲/最近委派」(验收 ⑥2)
// ============================================================================

describe('buildAgentSnapshotLines — Boss 卡片下属结构(任务06·③)', () => {
  it('Boss 行含下属结构/忙闲/区域叠加;普通 agent 行不受影响', () => {
    const { lines, total, truncated } = buildAgentSnapshotLines(world, worldAreas);
    expect(total).toBe(5);
    expect(truncated).toBe(false);

    const boss1 = lines.find((l) => l.includes('大当家'))!;
    expect(boss1).toContain('[BOSS]');
    expect(boss1).toContain('下属(2): 1忙/1闲');
    expect(boss1).toContain('小美(working·前端区)');
    expect(boss1).toContain('老王(idle)');
    expect(boss1).toContain('[区域: 指挥区]');

    // 不再是「只有 [BOSS]」;普通 agent 行无下属结构
    const subLine = lines.find((l) => l.includes('id: a1'))!;
    expect(subLine).not.toContain('下属(');
    expect(subLine).not.toContain('[BOSS]');
  });

  it('无委派史(缺省参数)时结构照常且不出现「最近委派」,不抛', () => {
    const omitted = buildAgentSnapshotLines(world, worldAreas);
    const explicit = buildAgentSnapshotLines(world, worldAreas, []);
    for (const { lines } of [omitted, explicit]) {
      expect(lines.find((l) => l.includes('大当家'))!).toContain('下属(2): 1忙/1闲');
      expect(lines.join('\n')).not.toContain('最近委派');
    }
  });

  it('多 Boss:各自只列自己的下属,最近委派按 bossId 过滤取最新一条', () => {
    const history = [
      decision({ bossId: 'b1', selectedAgentName: '小美', userCommand: '旧任务:修登录页', timestamp: 1_000 }),
      decision({ bossId: 'b2', selectedAgentName: '阿强', userCommand: '二当家的活', timestamp: 2_000 }),
      decision({ bossId: 'b1', selectedAgentName: '老王', userCommand: '新任务:改接口', timestamp: 3_000 }),
    ];
    const { lines } = buildAgentSnapshotLines(world, worldAreas, history);
    const boss1 = lines.find((l) => l.includes('大当家'))!;
    const boss2 = lines.find((l) => l.includes('二当家'))!;

    expect(boss1).toContain('最近委派: "新任务:改接口" → 老王 (sent)');
    expect(boss1).not.toContain('旧任务'); // 同一 Boss 只展示最近一条
    expect(boss1).not.toContain('阿强');   // 不串别家下属/委派

    expect(boss2).toContain('下属(1): 1忙/0闲');
    expect(boss2).toContain('阿强(waiting)');
    expect(boss2).toContain('最近委派: "二当家的活" → 阿强 (sent)');
    expect(boss2).not.toContain('小美');
  });

  it('下属超出上限只展开 8 个,其余报「…另N人」(防单行膨胀)', () => {
    const subs: SnapshotAgent[] = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`, name: `下属${i}`, class: 'builder', status: 'idle', bossId: 'big', lastWorkedAt: 10 + i,
    }));
    const boss: SnapshotAgent = {
      id: 'big', name: '大总管', class: 'boss', isBoss: true, status: 'idle',
      lastWorkedAt: 9_999, subordinateIds: subs.map((s) => s.id),
    };
    const { lines } = buildAgentSnapshotLines([boss, ...subs], []);
    const line = lines.find((l) => l.includes('大总管'))!;
    expect(line).toContain('下属(30):');
    expect(line).toContain('…另22人'); // 30 − 8(MAX_SNAPSHOT_SUBORDINATES)
    expect(line.length).toBeLessThan(400);
  });

  it('数据膨胀(70 agent、多 Boss 各带 12 下属)仍封顶 60 行(§8.1 常量)', () => {
    const expanded: SnapshotAgent[] = [];
    for (let i = 0; i < 70; i++) {
      const isBoss = i % 7 === 0;
      expanded.push({
        id: `x${i}`, name: `agent${i}`, class: isBoss ? 'boss' : 'builder', isBoss,
        status: 'idle', lastWorkedAt: i,
        subordinateIds: isBoss ? Array.from({ length: 12 }, (_, j) => `x${(i + j + 1) % 70}`) : undefined,
      });
    }
    const { lines, truncated } = buildAgentSnapshotLines(expanded, []);
    expect(lines).toHaveLength(60);
    expect(truncated).toBe(true);
    expect(lines.find((l) => l.includes('[BOSS]'))!).toContain('…另4人'); // 12 − 8
  });
});

// ============================================================================
// 待岗(standby)标注:语音侧不计入忙/闲,快照行/下属摘要点名;非待岗输出不变
// ============================================================================

describe('buildAgentSnapshotLines — 待岗(standby)标注', () => {
  /** 与 world 同构,但 a3 待岗(状态仍是 idle —— 待岗 = 停用标志,不是新状态值)。 */
  const standbyWorld: SnapshotAgent[] = [
    { id: 'b1', name: '大当家', class: 'boss', isBoss: true, status: 'working', lastWorkedAt: 400, subordinateIds: ['a1', 'a2', 'a3'] },
    { id: 'a1', name: '小美', class: 'builder', status: 'working', bossId: 'b1', lastWorkedAt: 200 },
    { id: 'a2', name: '老王', class: 'builder', status: 'idle', bossId: 'b1', lastWorkedAt: 100 },
    { id: 'a3', name: '阿强', class: 'builder', status: 'idle', bossId: 'b1', lastWorkedAt: 50, standby: true },
  ];

  it('待岗下属不算「忙/闲」:单独计数,条目名后标「·待岗」', () => {
    const { lines } = buildAgentSnapshotLines(standbyWorld, []);
    const boss = lines.find((l) => l.includes('大当家'))!;
    expect(boss).toContain('下属(3): 1忙/1闲/1待岗');
    expect(boss).toContain('阿强(idle·待岗)');
    expect(boss).toContain('小美(working)');
  });

  it('待岗 agent 快照行带方括号标记;非待岗行零变化(防 prompt 抖动)', () => {
    const { lines } = buildAgentSnapshotLines(standbyWorld, []);
    const standbyLine = lines.find((l) => l.includes('id: a3'))!;
    expect(standbyLine).toContain('[待岗:用户已停用,勿派活,需用户恢复]');
    expect(standbyLine).not.toContain('[BOSS]');
    expect(lines.find((l) => l.includes('id: a1'))!).not.toContain('待岗');
    // Boss 本人在岗:自身无方括号标记(行内的「…/1待岗」来自下属摘要,是应有内容)
    expect(lines.find((l) => l.includes('id: b1'))!).not.toContain('[待岗:用户已停用');
  });

  it('全员在岗(既有 world):忙/闲与条目格式逐字节同旧版', () => {
    const { lines } = buildAgentSnapshotLines(world, worldAreas);
    const boss1 = lines.find((l) => l.includes('大当家'))!;
    expect(boss1).toContain('下属(2): 1忙/1闲');
    expect(lines.join('\n')).not.toContain('待岗');
  });
});

// ============================================================================
// 委派史注入:镜像 subordinate-context-service:135 的 slice(0,5) 摘要
// ============================================================================

describe('buildDelegationSummaryLines / buildCompanionSystemPrompt — 委派史注入(任务06·③)', () => {
  const bossNames = new Map<string, string>([['b1', '大当家'], ['b2', '二当家']]);
  const seven = [
    decision({ bossId: 'b1', selectedAgentName: '小美', userCommand: '任务1', timestamp: 1_000 }),
    decision({ bossId: 'b2', selectedAgentName: '阿强', userCommand: '任务2', timestamp: 2_000 }),
    decision({ bossId: 'b1', selectedAgentName: '小美', userCommand: '任务3', timestamp: 3_000 }),
    decision({ bossId: 'b2', selectedAgentName: '阿强', userCommand: '任务4', timestamp: 4_000 }),
    decision({ bossId: 'b1', selectedAgentName: '老王', userCommand: '任务5', timestamp: 5_000 }),
    decision({ bossId: 'b2', selectedAgentName: '阿强', userCommand: '任务6', timestamp: 6_000 }),
    decision({ bossId: 'b1', selectedAgentName: '小美', userCommand: '任务7', timestamp: 7_000 }),
  ];

  it('摘要按时间倒序只取最近 5 条(slice(0,5) 截断生效),格式含 Boss→下属→任务→状态', () => {
    const lines = buildDelegationSummaryLines(seven, bossNames);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('大当家 → 小美');
    expect(lines[0]).toContain('任务7');
    expect(lines[0]).toContain('[状态: sent]');
    const joined = lines.join('\n');
    expect(joined).toContain('二当家 → 阿强');
    expect(joined).not.toContain('任务2'); // 第 6 新
    expect(joined).not.toContain('任务1'); // 第 7 新
  });

  it('prompt 注入【最近委派】段落,含摘要与团队问答指引', () => {
    const prompt = buildPrompt({ delegationHistory: seven, bossNames });
    expect(prompt).toContain('【最近委派】');
    expect(prompt).toContain('大当家 → 小美');
    expect(prompt).toContain('任务7');
    expect(prompt).not.toContain('任务2');
    expect(prompt).toContain('status: sent 只表示已派出');
    expect(prompt).toContain('谁在给谁干活');
  });

  it('空/缺省委派史:输出「(暂无委派记录)」,prompt 不炸', () => {
    expect(buildPrompt()).toContain('(暂无委派记录)');
    expect(buildPrompt({ delegationHistory: [] })).toContain('(暂无委派记录)');
  });

  it('bossNames 缺省时回退显示 bossId(不抛)', () => {
    const lines = buildDelegationSummaryLines([decision({ bossId: 'b9', selectedAgentName: '小美', userCommand: '任务X', timestamp: 1_000 })]);
    expect(lines[0]).toContain('b9 → 小美');
  });
});

// ============================================================================
// 服务级只读链路:XDG 沙箱 fixture(文件缺失/损坏均优雅降级)
// ============================================================================

describe('collectDelegationHistory — 沙箱 fixture 只读链路(任务06·③)', () => {
  const dataDir = path.join(process.env.XDG_DATA_HOME!, 'tide-commander');
  const historyFile = path.join(dataDir, 'delegation-history.json');
  const agents: SnapshotAgent[] = world;

  it('delegation-history.json 缺失:collect 返回空、不抛,prompt 优雅降级', () => {
    fs.rmSync(historyFile, { force: true });
    fs.rmSync(`${historyFile}.bak`, { force: true });
    bossService.init(); // 与 server/index.ts 相同的真实读取路径,缺文件 → 空 Map
    const history = collectDelegationHistory(agents);
    expect(history).toEqual([]);
    expect(buildPrompt({ delegationHistory: history })).toContain('(暂无委派记录)');
  });

  it('沙箱 fixture 读回:跨 Boss 合并、最近在前,快照与 prompt 都吃到', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(historyFile, JSON.stringify({
      histories: {
        b1: [
          decision({ bossId: 'b1', selectedAgentName: '老王', userCommand: '任务A-新', timestamp: 3_000 }),
          decision({ bossId: 'b1', selectedAgentName: '小美', userCommand: '任务A-旧', timestamp: 1_000 }),
        ],
        b2: [decision({ bossId: 'b2', selectedAgentName: '阿强', userCommand: '任务B', timestamp: 2_000 })],
      },
      savedAt: 0,
      version: '1.0.0',
    }));
    bossService.init();

    const merged = collectDelegationHistory(agents);
    expect(merged.map((d) => d.userCommand)).toEqual(['任务A-新', '任务B', '任务A-旧']);

    const { lines } = buildAgentSnapshotLines(agents, [], merged);
    expect(lines.find((l) => l.includes('大当家'))!).toContain('最近委派: "任务A-新" → 老王 (sent)');
    const prompt = buildPrompt({
      delegationHistory: merged,
      bossNames: new Map([['b1', '大当家'], ['b2', '二当家']]),
    });
    expect(prompt).toContain('任务A-新');
    expect(prompt).toContain('任务B');
  });

  it('文件损坏:init 不炸、collect 空(降级,不打断 hop1)', () => {
    fs.mkdirSync(dataDir, { recursive: true }); // 单跑本用例时目录尚未建（此前依赖前序用例副作用）
    fs.writeFileSync(historyFile, '{ not valid json');
    bossService.init();
    expect(collectDelegationHistory(agents)).toEqual([]);
  });
});
