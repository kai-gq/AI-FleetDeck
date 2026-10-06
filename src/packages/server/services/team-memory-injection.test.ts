/**
 * 任务23 · 端到端（进程内真实链路）：验收① 完成一次任务后五要素可查 + 验收② Boss 派活注入命中摘要。
 *
 * 链路（真函数,不 mock 核心）：
 *   parseBossDelegation（真实围栏解析）→ delegation-history.json（XDG 沙箱真实落盘）
 *   → completeDelegation（完成单一漏斗）→ 资产库 append（显式注入的临时文件,与 XDG 隔离）
 *   → buildBossMessage（派活消息构造,唯一注入点）→ 命中摘要入消息。
 * 仅 mock：agentService/runtimeService（不真跑下属进程）、团队上下文（固定返回 null 走无下属分支）。
 *
 * 任务23 验收③：委派史（delegation-history.json）与资产库（team-memory/assets.json）
 * 物理分离、各自结构不变——三状态文件零迁移。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => {
  let resolveSend: (() => void) | null = null;
  return {
    sendCommand: vi.fn((_agentId: string, _message: string) => new Promise<void>((resolve) => { resolveSend = resolve; })),
    resolveSend: () => resolveSend?.(),
  };
});

vi.mock('./index.js', async () => {
  const realBoss = await vi.importActual<typeof import('./boss-service.js')>('./boss-service.js');
  return {
    agentService: { getAgent: vi.fn(() => undefined) },
    runtimeService: { sendCommand: h.sendCommand },
    bossService: realBoss,
    workPlanService: {},
    skillService: {},
  };
});

vi.mock('./agent-service.js', () => ({
  getAgent: vi.fn(() => ({ name: 'Boss', customInstructions: undefined })),
}));

vi.mock('./subordinate-context-service.js', () => ({
  buildBossContext: vi.fn(async () => null),
}));

vi.mock('../websocket/handlers/command-handler.js', () => ({
  getLastBossCommand: vi.fn(() => ''),
  buildCustomAgentConfig: vi.fn(() => undefined),
}));

import { completeDelegation, parseBossDelegation, resetBossDelegationStateForTests } from '../websocket/handlers/boss-response-handler.js';
import * as bossService from './boss-service.js';
import { buildBossMessage } from './boss-message-service.js';
import { buildTeamMemoryEntries } from './team-memory-service.js';
import { FileTeamAssetStore, setTeamAssetStoreForTests, resetTeamAssetStoreForTests, type TeamAssetEntry } from './team-asset-store.js';
import { resetLastBossDispatchForTests } from './voice-companion-service.js';
import { closeEventDb, initEventDb } from '../data/event-db.js';
import { BOSS_CONTEXT_END, type DelegationDecision } from '../../shared/types.js';

const dataDir = path.join(process.env.XDG_DATA_HOME!, 'tide-commander');
const historyFile = path.join(dataDir, 'delegation-history.json');

let storeDir: string;
let assetsFile: string;

function readDecision(taskCommand: string): DelegationDecision {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as { histories: Record<string, DelegationDecision[]> };
  const found = Object.values(raw.histories).flat().find((d) => d.userCommand === taskCommand);
  if (!found) throw new Error(`decision not found: ${taskCommand}`);
  return found;
}

function readAssets(): TeamAssetEntry[] {
  return (JSON.parse(fs.readFileSync(assetsFile, 'utf8')) as { entries: TeamAssetEntry[] }).entries;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('任务23 端到端：完成漏斗 → 资产库 → 派活注入', () => {
  beforeAll(() => {
    fs.rmSync(historyFile, { force: true });
    fs.rmSync(`${historyFile}.bak`, { force: true });
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-team-memory-e2e-'));
    assetsFile = path.join(storeDir, 'assets.json');
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetBossDelegationStateForTests();
    resetLastBossDispatchForTests();
    resetTeamAssetStoreForTests();
    fs.rmSync(assetsFile, { force: true });
    // 显式临时文件 store（与 XDG 沙箱隔离,杜绝跨测试文件的盘上污染）
    setTeamAssetStoreForTests(new FileTeamAssetStore({ filePath: assetsFile }));
  });

  it('验收①②:完成任务 → 五要素可查 + 资产落盘 + 新派活消息含命中摘要', async () => {
    bossService.init();

    const resultText = `我来拆解这个任务。

\`\`\`delegation
[{"selectedAgentId":"agent-1","selectedAgentName":"小刘","taskCommand":"实现登录页","reasoning":"builder 空闲且熟悉前端","confidence":"high","taskCard":{"objective":"实现登录页","acceptanceCriteria":["lint:types 通过","单测覆盖登录回退"],"dependencies":[],"priority":"P1"}}]
\`\`\``;
    parseBossDelegation('boss-1', 'Boss', resultText, vi.fn());
    h.resolveSend();
    await tick();

    completeDelegation('agent-1', {
      success: true,
      reason: 'report-task',
      summary: '登录页完成并通过验收',
      outputLocation: 'src/pages/login.tsx',
    });

    // ① 资产库真实落盘（append-only 第二文件）
    const decision = readDecision('实现登录页');
    const assets = readAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      decisionId: decision.id,
      bossId: 'boss-1',
      agentName: '小刘',
      objective: '实现登录页',
      outcome: 'completed',
      outputLocation: 'src/pages/login.tsx',
      summary: '登录页完成并通过验收',
      acceptanceCriteria: ['lint:types 通过', '单测覆盖登录回退'],
    });

    // ① 五要素视图（谁/何时/什么/为什么/产出在哪）同源可查
    const view = buildTeamMemoryEntries([{ bossId: 'boss-1', bossName: '王经理', histories: [decision] }]);
    expect(view).toHaveLength(1);
    expect(view[0].who.agentName).toBe('小刘');
    expect(view[0].when.completedAt).toBe(decision.completion!.completedAt);
    expect(view[0].what.objective).toBe('实现登录页');
    expect(view[0].why.userCommand).toBe('实现登录页');
    expect(view[0].where.outputLocation).toBe('src/pages/login.tsx');

    // ② Boss 派活先查：新任务命中摘要注入（在快照围栏内、命令保持在末尾）
    const { message } = await buildBossMessage('boss-1', '登录页还要加个回退按钮');
    expect(message).toContain('【团队资产命中】');
    expect(message).toContain('实现登录页');
    expect(message).toContain('小刘');
    expect(message).toContain('src/pages/login.tsx');
    expect(message.indexOf('【团队资产命中】')).toBeLessThan(message.indexOf(BOSS_CONTEXT_END));
    expect(message.endsWith('登录页还要加个回退按钮')).toBe(true);

    // ③ 三状态文件物理结构不变：委派史原结构 + 资产在独立文件
    const rawHistory = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as Record<string, unknown>;
    expect(rawHistory).toHaveProperty('histories');
    expect(fs.existsSync(assetsFile)).toBe(true);
  });

  it('失败任务同为资产(坑入账);无关新任务零注入(与旧版输出一致)', async () => {
    bossService.init();

    const resultText = `\`\`\`delegation
[{"selectedAgentId":"agent-2","selectedAgentName":"李四","taskCommand":"重构支付模块","reasoning":"后端专长","confidence":"medium","taskCard":{"objective":"重构支付模块","acceptanceCriteria":["回归全绿"],"dependencies":[]}}]
\`\`\``;
    parseBossDelegation('boss-1', 'Boss', resultText, vi.fn());
    h.resolveSend();
    await tick();

    completeDelegation('agent-2', { success: false, reason: 'turn-complete' });

    const assets = readAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0].outcome).toBe('failed');
    expect(assets[0].pitfalls).toContain('失败(turn-complete)');

    // 无关任务：无命中 → 不注入（消息体保持旧形态）
    const { message } = await buildBossMessage('boss-1', '给项目补一个 README');
    expect(message).not.toContain('团队资产命中');

    // 相关任务：失败资产也能命中（含"未成"标识）
    const { message: hitMessage } = await buildBossMessage('boss-1', '支付模块的回归还是有问题');
    expect(hitMessage).toContain('【团队资产命中】');
    expect(hitMessage).toContain('未成');
  });
});
