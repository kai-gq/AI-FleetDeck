/**
 * jarvis-core/projects · 三层消歧与三态路由（任务 14·⑪ ⑤.2/⑤.3，验收 ⑥2-⑥5）
 *
 * 钉死：① 别名/显式 bossId/激活工作区/确认 → ② 最近提及/最近委派 → ③ 关键词唯一命中；
 * 单 Boss 退化直派不反问；All + 多 Boss + 消不掉 → needAsk（只给「问一次」的输入）；
 * 已切工作区/无主管/无卡 → 不反问、回落由接线层兜底。
 */

import { describe, expect, it } from 'vitest';

import { isAffirmativeText, isCancelText, planClarificationAnswer, resolveProjectTarget } from './resolve.js';
import type {
  ProjectAliasEntry,
  ProjectBossRef,
  ProjectCard,
  ProjectResolveInput,
} from './types.js';

const NOW = 1_800_000_000_000;
const BOSSES: ProjectBossRef[] = [
  { id: 'bossA', name: '大当家A' },
  { id: 'bossB', name: '二当家B' },
];

function card(partial: Partial<ProjectCard> & { id: string; name: string }): ProjectCard {
  return {
    aliases: [partial.name],
    areaIds: [],
    inProgress: [],
    keywords: [],
    lastActiveAt: NOW - 60_000,
    status: 'active',
    ...partial,
  };
}

const CARD_A = card({ id: 'wsA', name: '项目A', bossId: 'bossA', bossName: '大当家A' });
const CARD_B = card({ id: 'wsB', name: '项目B', bossId: 'bossB', bossName: '二当家B' });

const ALIASES: ProjectAliasEntry[] = [
  { alias: '项目a', projectId: 'wsA', createdAt: NOW, source: 'seed' },
  { alias: '项目b', projectId: 'wsB', createdAt: NOW, source: 'seed' },
];

function input(partial: Partial<ProjectResolveInput> & { text: string }): ProjectResolveInput {
  return {
    cards: [CARD_A, CARD_B],
    aliases: ALIASES,
    bosses: BOSSES,
    activeWorkspaceId: null,
    ...partial,
  };
}

describe('resolveProjectTarget — ① 显式信号', () => {
  it('口称别名唯一命中 → 该项目主管（⑥2「让项目B 的团队做 X」）', () => {
    const r = resolveProjectTarget(input({ text: '让项目B的团队做登录页' }));
    expect(r.projectId).toBe('wsB');
    expect(r.projectName).toBe('项目B');
    expect(r.bossId).toBe('bossB');
    expect(r.layer).toBe('explicit');
    expect(r.source).toBe('alias:项目b');
    expect(r.needAsk).toBe(false);
    expect(r.candidates.some((c) => c.projectId === 'wsB' && c.hit)).toBe(true);
  });

  it('模型显式 bossId → 该主管对应项目（显式信号优先于反问）', () => {
    const r = resolveProjectTarget(input({ text: '让团队做登录页', modelBossId: 'bossB' }));
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsB', bossId: 'bossB', layer: 'explicit', source: 'boss-id', needAsk: false }));
  });

  it('激活工作区命中 → 当前项目（⑥3 切了工作区「让团队做 X」）', () => {
    const r = resolveProjectTarget(input({ text: '让团队做登录页', activeWorkspaceId: 'wsB' }));
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsB', bossId: 'bossB', layer: 'explicit', source: 'active-workspace', needAsk: false }));
  });

  it('激活工作区存在但该卡无主管/无此卡 → 不反问（回落交给接线层）', () => {
    const noBoss = card({ id: 'wsC', name: '项目C' });
    const r = resolveProjectTarget(input({ text: '让团队做登录页', cards: [CARD_A, CARD_B, noBoss], activeWorkspaceId: 'wsC' }));
    expect(r.bossId).toBeUndefined();
    expect(r.needAsk).toBe(false);
    const r2 = resolveProjectTarget(input({ text: '让团队做登录页', activeWorkspaceId: 'wsMissing' }));
    expect(r2.bossId).toBeUndefined();
    expect(r2.needAsk).toBe(false);
  });

  it('上一问建议 + 纯确认「是」→ 确认该项目（clarify-confirm）', () => {
    const r = resolveProjectTarget(input({ text: '是', clarifySuggestion: 'wsB' }));
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsB', bossId: 'bossB', source: 'clarify-confirm', needAsk: false }));
  });

  it('口称两个项目（歧义）→ 两个都提名、不算命中；All 状态 → needAsk', () => {
    const r = resolveProjectTarget(input({ text: '把项目A和项目B的活都推进一下' }));
    expect(r.bossId).toBeUndefined();
    expect(r.needAsk).toBe(true);
    expect(r.candidates.filter((c) => c.layer === 'explicit').map((c) => c.projectId).sort()).toEqual(['wsA', 'wsB']);
    expect(r.candidates.every((c) => !c.hit)).toBe(true);
    expect(r.askQuestion).toContain('项目A');
    expect(r.askQuestion).toContain('项目B');
  });
});

describe('resolveProjectTarget — ② 对话上下文', () => {
  it('会话最近提及（lastProjectId）优先于关键词', () => {
    const r = resolveProjectTarget(input({
      text: '那个报价的事推进一下',
      cards: [CARD_A, card({ id: 'wsB', name: '项目B', bossId: 'bossB', inProgress: ['整理报价单'] })],
      lastProjectId: 'wsA',
    }));
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsA', layer: 'context', source: 'last-project' }));
  });

  it('最近委派史（recentProjectIds，新→旧）命中', () => {
    const r = resolveProjectTarget(input({ text: '接着干', recentProjectIds: ['wsA', 'wsB'] }));
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsA', bossId: 'bossA', layer: 'context', source: 'recent-delegation' }));
  });
});

describe('resolveProjectTarget — ③ 关键词（⑥4「那个报价的事」）', () => {
  const cards = [CARD_A, card({ id: 'wsB', name: '项目B', bossId: 'bossB', inProgress: ['整理报价单'] })];
  // 注意：报价单属于 B —— 文本唯一命中 B
  it('唯一最高分 → 命中该项目，不问', () => {
    const r = resolveProjectTarget(input({ text: '那个报价的事交给团队办一下', cards }));
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsB', bossId: 'bossB', layer: 'keyword', needAsk: false }));
    expect(r.source?.startsWith('keyword:')).toBe(true);
  });

  it('平票 → 双方提名 keyword 层、不算命中；All → needAsk', () => {
    const tieCards = [
      card({ id: 'wsA', name: '项目A', bossId: 'bossA', inProgress: ['整理报价单'] }),
      card({ id: 'wsB', name: '项目B', bossId: 'bossB', inProgress: ['报价单归档'] }),
    ];
    const r = resolveProjectTarget(input({ text: '报价单', cards: tieCards }));
    expect(r.bossId).toBeUndefined();
    expect(r.needAsk).toBe(true);
    expect(r.candidates.filter((c) => c.layer === 'keyword').map((c) => c.projectId).sort()).toEqual(['wsA', 'wsB']);
  });

  it('已切工作区仍消不掉 → 不反问（回落现状默认）', () => {
    const r = resolveProjectTarget(input({ text: '随便弄弄', activeWorkspaceId: null }));
    expect(r.needAsk).toBe(true); // All，且有两张可派卡
    const r2 = resolveProjectTarget(input({ text: '随便弄弄', activeWorkspaceId: 'wsMissing' }));
    expect(r2.needAsk).toBe(false);
    expect(r2.bossId).toBeUndefined();
  });

  it('否定片段剔除（「不是项目B，是项目A」→ 只命中 A）', () => {
    const r = resolveProjectTarget(input({ text: '不是项目B，是项目A那边的事' }));
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsA', bossId: 'bossA', layer: 'explicit' }));
  });
});

describe('resolveProjectTarget — 三态边界（单 Boss 退化 / 无主管 / 反问上限）', () => {
  it('全仓仅 1 个 boss-like → 直派不反问（现状零回归）', () => {
    const single = card({ id: 'wsA', name: '项目A', bossId: 'bossA' });
    const r = resolveProjectTarget(input({
      text: '让项目B的团队做登录页', // 即便口称了别的项目
      cards: [single],
      bosses: [{ id: 'bossA', name: '大当家A' }],
    }));
    expect(r).toEqual(expect.objectContaining({ bossId: 'bossA', projectId: 'wsA', degenerate: true, source: 'single-boss', needAsk: false }));
  });

  it('团队没有主管 → 不路由也不反问（no_boss 由现状路由处理）', () => {
    const r = resolveProjectTarget(input({ text: '让团队做登录页', bosses: [] }));
    expect(r.bossId).toBeUndefined();
    expect(r.needAsk).toBe(false);
    expect(r.degenerate).toBeUndefined();
  });

  it('反问候选：只有 1 张可派卡时给 suggestedProjectId（回答「是」可直接确认）', () => {
    const r = resolveProjectTarget(input({
      text: '让团队做登录页',
      cards: [CARD_A, card({ id: 'wsC', name: '项目C' })], // 只有 A 有主管
    }));
    expect(r.needAsk).toBe(true);
    expect(r.suggestedProjectId).toBe('wsA');
    expect(r.askQuestion).toContain('项目A');
  });
});

describe('取消 / 确认话术与一次性反问消费（planClarificationAnswer）', () => {
  it('isCancelText / isAffirmativeText', () => {
    expect(isCancelText('算了，先不做了')).toBe(true);
    expect(isCancelText('项目B，马上办')).toBe(false);
    expect(isAffirmativeText('是')).toBe(true);
    expect(isAffirmativeText('对的！')).toBe(true);
    expect(isAffirmativeText('嗯嗯')).toBe(true);
    expect(isAffirmativeText('是项目B')).toBe(false); // 交给别名层
  });

  it('回答取消话术 → abandon（丢弃挂起任务）', () => {
    expect(planClarificationAnswer(input({ text: '算了，这活不做了' })).kind).toBe('abandon');
  });

  it('回答项目名 → resolve（确定性直接派发）', () => {
    const plan = planClarificationAnswer(input({ text: '项目B' }));
    expect(plan).toMatchObject({ kind: 'resolve', bossId: 'bossB', projectId: 'wsB', projectName: '项目B' });
  });

  it('回答「是」+ 建议 → resolve 到建议项目', () => {
    const plan = planClarificationAnswer(input({ text: '是', clarifySuggestion: 'wsA' }));
    expect(plan).toMatchObject({ kind: 'resolve', bossId: 'bossA', projectId: 'wsA' });
  });

  it('回答仍消不掉 → fallback（回落首位 Boss，只问一次不再问）', () => {
    const plan = planClarificationAnswer(input({ text: '你看着办吧' }));
    expect(plan.kind).toBe('fallback');
    if (plan.kind !== 'fallback') throw new Error('unreachable');
    expect(plan.decision.bossId).toBeUndefined();
  });

  it('回答消不掉但已切工作区 → 也 fallback，不再反问', () => {
    const plan = planClarificationAnswer(input({ text: '你看着办吧', activeWorkspaceId: 'wsMissing' }));
    expect(plan.kind).toBe('fallback');
  });
});
