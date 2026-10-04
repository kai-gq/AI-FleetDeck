/**
 * 任务16·⑬ 撤回/评价 —— 纯逻辑单测（§voice/delegation-query.ts 任务16 段）。
 *
 * 覆盖：
 *   - 撤回对象抽取/裸撤回判定（动词剥离 + 指代剥离 + 泛词兜底）；
 *   - LCS 匹配评分（名字/项目/任务文本，阈值 2 的负控）；
 *   - 三态决策 planCancelAction（live 唯一/多候选平票 → 反问、live 无 → 史源
 *     done 拒撤 / cancelled 已撤 / 重启残留 match、全无 → none）；
 *   - 一次性反问消费 consumeCancelClarifyAnswer（编号/名字/放弃/指代不明）；
 *   - 评价极性解析（「不满意」含「满意」的顺序边界）与「最近完成未评价」选取（含覆盖后换一条）；
 *   - SpeechGate 对 cancel_delegation / rate_delegation 的丢弃语义（与 general_response 放行对照）。
 *
 * 断言口径：负断言与边界必须可判别 —— 每个「不命中」都有正控对照，
 * 话术断言含被指代对象；防止空转断言（W8 教训）。
 */
import { describe, expect, it } from 'vitest';
import {
  CANCEL_ASK_MAX_CANDIDATES,
  buildCancelClarifyQuestion,
  buildCancelNoneResponse,
  buildNoRatingTargetResponse,
  buildRatingConfirmResponse,
  buildRatingTargetQuestion,
  consumeCancelClarifyAnswer,
  extractCancelSubject,
  isBareCancelSubject,
  isActionableCancelState,
  longestCommonSubstringLength,
  normalizeCancelMatchText,
  parseCancelOrdinalIndex,
  parseRatingPolarity,
  pickLatestUnratedCompletion,
  planCancelAction,
  rankCancelCandidates,
  type CancelCandidate,
} from './delegation-query.js';
import { SpeechGate } from './speech-gate.js';
import type { DelegationCompletion, DelegationDecision } from '../../shared/agent-types.js';

// ============================================================================
// fixtures
// ============================================================================

function candidate(over: Partial<CancelCandidate> & { subordinateId: string }): CancelCandidate {
  return {
    bossId: 'b1',
    label: '未记录任务',
    state: 'running',
    source: 'active',
    ...over,
  };
}

const mei = (over: Partial<CancelCandidate> = {}): CancelCandidate =>
  candidate({ subordinateId: 'a-mei', subordinateName: '小美', label: '登录页改造', taskId: 't-mei', decisionId: 'd-mei', ...over });
const gang = (over: Partial<CancelCandidate> = {}): CancelCandidate =>
  candidate({ subordinateId: 'a-gang', subordinateName: '小刚', label: '支付回调修复', taskId: 't-gang', decisionId: 'd-gang', ...over });

function decision(over: Partial<DelegationDecision> & { id: string }): DelegationDecision {
  return {
    timestamp: 1_000,
    bossId: 'b1',
    userCommand: '把登录页重构成 React 18',
    selectedAgentId: 'a-mei',
    selectedAgentName: '小美',
    reasoning: 'fixture',
    alternativeAgents: [],
    confidence: 'high',
    status: 'sent',
    ...over,
  };
}

function completion(over: Partial<DelegationCompletion> = {}): DelegationCompletion {
  return { completedAt: 2_000, durationMs: 1_000, result: 'completed', ...over };
}

// ============================================================================
// 撤回对象抽取
// ============================================================================

describe('撤回对象抽取（动词/填充词剥离 + 裸撤回判定）', () => {
  it('剥离撤回动词与指代填充词，保留对象线索（归一化去标点空白小写）', () => {
    expect(extractCancelSubject('登录页那个任务别做了')).toBe('登录页任务');
    expect(extractCancelSubject('请 帮我 取消 Proj-Login 的活')).toBe('projlogin');
    expect(extractCancelSubject('支付回调 停掉')).toBe('支付回调');
  });

  it('裸撤回：只有动词/泛词/语气词（或空）→ true；带对象 → false', () => {
    expect(extractCancelSubject('算了')).toBe('');
    expect(isBareCancelSubject(extractCancelSubject('算了'))).toBe(true);
    expect(isBareCancelSubject(extractCancelSubject('停掉那个任务'))).toBe(true);
    expect(isBareCancelSubject(extractCancelSubject('取消'))).toBe(true);
    expect(isBareCancelSubject(extractCancelSubject('登录页那个任务别做了'))).toBe(false);
  });

  it('normalizeCancelMatchText：去标点空白 + 小写（LCS 用）', () => {
    expect(normalizeCancelMatchText(' Proj-Login、页面 ')).toBe('projlogin页面');
  });

  it('longestCommonSubstringLength：公共子串/零公共/空串边界', () => {
    expect(longestCommonSubstringLength('把登录页任务', '登录页重构')).toBe(3);
    expect(longestCommonSubstringLength('支付回调', '登录页重构')).toBe(0);
    expect(longestCommonSubstringLength('', '登录页')).toBe(0);
    expect(longestCommonSubstringLength('登录页', '')).toBe(0);
  });
});

// ============================================================================
// 候选排序
// ============================================================================

describe('rankCancelCandidates —— 三字段 LCS 评分 + 阈值 2 + 裸撤回全在办', () => {
  const c1 = mei();
  const c2 = gang();
  const finished = candidate({ subordinateId: 'a-old', subordinateName: '老白', label: '旧活', state: 'done', source: 'history' });

  it('按名字/项目/任务文本三字段最大 LCS 命中，得分 <2 不冒认', () => {
    expect(rankCancelCandidates('把登录页那个活撤了', [c1, c2])).toEqual([c1]);
    expect(rankCancelCandidates('取消 proj-login', [candidate({ subordinateId: 'a-p', projectId: 'proj-login' }), c2])[0].subordinateId).toBe('a-p');
    expect(rankCancelCandidates('撤小刚', [c1, c2])).toEqual([c2]);
    // 单字关键词 <2 → 无命中（阈值负控）
    expect(rankCancelCandidates('取消它', [c1, c2])).toEqual([]);
  });

  it('多候选按得分降序（高分在前，与输入序无关）；平票保持稳定序', () => {
    const strong = candidate({ subordinateId: 'a-strong', subordinateName: '小刚', label: '登录页重构' }); // LCS 3
    const weak = candidate({ subordinateId: 'a-weak', subordinateName: '登录', label: '别的活' }); // LCS 2（名字）
    const ranked = rankCancelCandidates('取消登录页', [weak, strong]);
    expect(ranked.map((c) => c.subordinateId)).toEqual(['a-strong', 'a-weak']);
    const tied = rankCancelCandidates('登录页', [
      mei({ label: '登录页改造' }),
      candidate({ subordinateId: 'a-b', subordinateName: '小刚', label: '登录页重构' }),
    ]);
    expect(tied.map((c) => c.subordinateId)).toEqual(['a-mei', 'a-b']);
  });

  it('裸撤回 → 全部「仍可撤回」候选（done/cancelled 终态被滤）', () => {
    expect(rankCancelCandidates('算了', [c1, finished])).toEqual([c1]);
    expect(isActionableCancelState('pending')).toBe(true);
    expect(isActionableCancelState('queued')).toBe(true);
    expect(isActionableCancelState('running')).toBe(true);
    expect(isActionableCancelState('done')).toBe(false);
    expect(isActionableCancelState('cancelled')).toBe(false);
  });
});

// ============================================================================
// 三态决策
// ============================================================================

describe('planCancelAction —— live 优先 / 史源兜底 / 明确 none', () => {
  it('live 唯一命中 → match（带全字段）', () => {
    const plan = planCancelAction({ text: '把登录页那个活撤了', live: [mei(), gang()], history: [] });
    expect(plan.kind).toBe('match');
    if (plan.kind === 'match') expect(plan.candidate.subordinateId).toBe('a-mei');
  });

  it('live 多候选/平票 → 一次反问（问题含编号与两个对象）', () => {
    const plan = planCancelAction({ text: '取消登录页', live: [mei(), mei({ subordinateId: 'a-b', subordinateName: '小刚', label: '登录页重构' })], history: [] });
    expect(plan.kind).toBe('ask');
    if (plan.kind === 'ask') {
      expect(plan.candidates).toHaveLength(2);
      expect(plan.question).toContain('1）小美：登录页改造');
      expect(plan.question).toContain('2）小刚：登录页重构');
      expect(plan.question).toContain('回个编号或名字');
    }
    // 裸撤回多候选同样反问
    const bare = planCancelAction({ text: '算了', live: [mei(), gang()], history: [] });
    expect(bare.kind).toBe('ask');
    // 裸撤回唯一 → 直接 match
    const single = planCancelAction({ text: '算了', live: [mei()], history: [] });
    expect(single.kind).toBe('match');
  });

  it('live 无命中、仅史源单条 → done 拒撤 / cancelled 已撤 / 重启残留 running 可 match', () => {
    const donePlan = planCancelAction({ text: '取消支付回调修复', live: [], history: [gang({ state: 'done', source: 'history' })] });
    expect(donePlan.kind).toBe('rejected-done');
    const cancelledPlan = planCancelAction({ text: '取消支付回调修复', live: [], history: [gang({ state: 'cancelled', source: 'history' })] });
    expect(cancelledPlan.kind).toBe('already-cancelled');
    const residuePlan = planCancelAction({ text: '取消支付回调修复', live: [], history: [gang({ state: 'running', source: 'history' })] });
    expect(residuePlan.kind).toBe('match');
  });

  it('live 优先于史源：live 命中时不因史源多候选而反问', () => {
    const plan = planCancelAction({
      text: '取消登录页',
      live: [mei()],
      history: [mei({ state: 'done', source: 'history' }), gang({ state: 'done', source: 'history' })],
    });
    expect(plan.kind).toBe('match');
    if (plan.kind === 'match') expect(plan.candidate.source).toBe('active');
  });

  it('史源多可撤候选 → 反问；关键词指向多个已结束 → none（不猜）', () => {
    const askPlan = planCancelAction({
      text: '取消支付回调',
      live: [],
      history: [
        gang({ state: 'running', source: 'history' }),
        gang({ subordinateId: 'a-gang2', decisionId: 'd-gang2', state: 'queued', source: 'history' }),
      ],
    });
    expect(askPlan.kind).toBe('ask');
    const finishedOnly = planCancelAction({
      text: '取消支付回调',
      live: [],
      history: [gang({ state: 'done', source: 'history' }), gang({ subordinateId: 'a-g2', decisionId: 'd-g2', state: 'cancelled', source: 'history' })],
    });
    expect(finishedOnly.kind).toBe('none');
  });

  it('全无候选 / 裸撤回且无在办 → none（明确话术由调用方给）', () => {
    expect(planCancelAction({ text: '取消登录页', live: [], history: [] }).kind).toBe('none');
    expect(planCancelAction({ text: '算了', live: [], history: [mei({ state: 'done', source: 'history' })] }).kind).toBe('none');
  });

  it('反问话术超上限给「报名字」提示；未超不加', () => {
    const many = Array.from({ length: CANCEL_ASK_MAX_CANDIDATES + 2 }, (_, i) =>
      candidate({ subordinateId: `a-${i}`, subordinateName: `下属${i}`, label: `任务${i}` }));
    const q = buildCancelClarifyQuestion(many);
    expect(q).toContain('1）下属0：任务0');
    expect(q).toContain(`（还有 2 个未列出，可报名字）`);
    const small = buildCancelClarifyQuestion([mei()]);
    expect(small).not.toContain('未列出');
  });
});

// ============================================================================
// 一次性反问消费
// ============================================================================

describe('consumeCancelClarifyAnswer —— 一次性消费（编号/名字/放弃/其余丢弃）', () => {
  const pool = [mei(), gang()];

  it('编号（阿拉伯/中文/带第…个）→ pick 对应候选', () => {
    expect(consumeCancelClarifyAnswer('第2个', pool)).toEqual({ kind: 'pick', candidate: gang() });
    expect(consumeCancelClarifyAnswer('2', pool)).toEqual({ kind: 'pick', candidate: gang() });
    expect(consumeCancelClarifyAnswer('第二个吧', pool)).toEqual({ kind: 'pick', candidate: gang() });
    expect(consumeCancelClarifyAnswer('就第1个', pool)).toEqual({ kind: 'pick', candidate: mei() });
  });

  it('名字/关键词唯一命中 → pick（不要求说动词）', () => {
    expect(consumeCancelClarifyAnswer('小美', pool)).toEqual({ kind: 'pick', candidate: mei() });
    expect(consumeCancelClarifyAnswer('撤小刚那个', pool)).toEqual({ kind: 'pick', candidate: gang() });
  });

  it('放弃话术 → abort（不撤/算了/不用了/先别…）', () => {
    expect(consumeCancelClarifyAnswer('算了', pool)).toEqual({ kind: 'abort' });
    expect(consumeCancelClarifyAnswer('不撤了', pool)).toEqual({ kind: 'abort' });
    expect(consumeCancelClarifyAnswer('先别', pool)).toEqual({ kind: 'abort' });
  });

  it('指代不明（同时命中多候选/无效编号/无关话）→ unmatched', () => {
    expect(consumeCancelClarifyAnswer('撤小美和支付回调修复', pool)).toEqual({ kind: 'unmatched' });
    expect(consumeCancelClarifyAnswer('第三个', pool)).toEqual({ kind: 'unmatched' });
    expect(consumeCancelClarifyAnswer('今天天气不错', pool)).toEqual({ kind: 'unmatched' });
  });

  it('parseCancelOrdinalIndex 越界/无编号 → undefined', () => {
    expect(parseCancelOrdinalIndex('第2个', 2)).toBe(2);
    expect(parseCancelOrdinalIndex('三个', 2)).toBeUndefined();
    expect(parseCancelOrdinalIndex('好的', 2)).toBeUndefined();
  });
});

// ============================================================================
// 评价（极性 + 选取 + 话术）
// ============================================================================

describe('parseRatingPolarity —— 不满意优先（含「满意」子串顺序边界）', () => {
  it('负面词先判：「不满意」不得落 satisfied', () => {
    expect(parseRatingPolarity('不满意')).toBe('unsatisfied');
    expect(parseRatingPolarity('对那个结果不满意')).toBe('unsatisfied');
    expect(parseRatingPolarity('不太满意')).toBe('unsatisfied'); // 「不满」字面变体，含「满意」子串
    expect(parseRatingPolarity('不太行')).toBe('unsatisfied');
    expect(parseRatingPolarity('干得一般')).toBe('unsatisfied');
  });

  it('正面词 → satisfied；两不沾 → unknown（不猜）', () => {
    expect(parseRatingPolarity('很满意')).toBe('satisfied');
    expect(parseRatingPolarity('刚才那个活干得不错')).toBe('satisfied');
    expect(parseRatingPolarity('辛苦了')).toBe('satisfied');
    expect(parseRatingPolarity('嗯')).toBe('unknown');
    expect(parseRatingPolarity('评价一下')).toBe('unknown');
  });
});

describe('pickLatestUnratedCompletion —— 最近完成且未评价', () => {
  it('取 completedAt 最新且无 userRating 的完成记录；失败/已评/无完成不入选', () => {
    const older = decision({ id: 'd-old', completion: completion({ completedAt: 2_000 }) });
    const rated = decision({ id: 'd-rated', completion: completion({ completedAt: 3_000 }), userRating: 'satisfied', ratedAt: 4_000 });
    const failed = decision({ id: 'd-failed', completion: completion({ completedAt: 9_000, result: 'failed' }) });
    const newest = decision({ id: 'd-newest', completion: completion({ completedAt: 5_000 }) });
    expect(pickLatestUnratedCompletion([older, rated, failed, newest])?.id).toBe('d-newest');
    expect(pickLatestUnratedCompletion([older, rated, failed])?.id).toBe('d-old');
    expect(pickLatestUnratedCompletion([rated, failed, decision({ id: 'd-plain' })])).toBeUndefined();
    expect(pickLatestUnratedCompletion([])).toBeUndefined();
  });

  it('确认/追问话术含对象与任务文本；极性由 decision.userRating 决定（覆盖语义）', () => {
    const satisfied = decision({ id: 'd-1', userCommand: '把登录页重构成 React 18', completion: completion(), userRating: 'satisfied', ratedAt: 9 });
    const text = buildRatingConfirmResponse(satisfied);
    expect(text).toContain('小美');
    expect(text).toContain('登录页重构');
    expect(text).toContain('满意');
    expect(text).not.toContain('不满意'); // 负控：正面评价不得播成负面
    const unsatisfied = decision({ id: 'd-2', completion: completion(), userRating: 'unsatisfied', ratedAt: 9 });
    expect(buildRatingConfirmResponse(unsatisfied)).toContain('不满意');
    expect(buildRatingTargetQuestion(satisfied)).toContain('满意还是不满意？');
    expect(buildRatingTargetQuestion(satisfied)).toContain('小美');
  });

  it('两则固定话术（无目标/无待评价）', () => {
    expect(buildCancelNoneResponse()).toBe('现在没有可以撤回的在办任务。');
    expect(buildNoRatingTargetResponse()).toBe('最近没有已完成、还没评价的任务。');
  });
});

// ============================================================================
// SpeechGate：两个新动作 = 丢弃 hop1 话术（对照 general_response 放行）
// ============================================================================

describe('SpeechGate —— cancel/rate 显式门（hop1 话术一律不出声）', () => {
  for (const action of ['cancel_delegation', 'rate_delegation'] as const) {
    it(`setAction('${action}') 丢弃已缓冲与后续句子；general_response 放行对照`, () => {
      const spoken: string[] = [];
      const gate = new SpeechGate((s) => spoken.push(s));
      gate.push('我这就去撤。'); // 缓冲（action 未定）
      gate.setAction(action);
      gate.push('马上就好。'); // action 已定，仍丢弃
      expect(spoken).toEqual([]);
      expect(gate.spokenCount).toBe(0);
      expect(gate.spoke).toBe(false);

      const control = new SpeechGate((s) => spoken.push(s));
      control.push('大家都好。');
      control.setAction('general_response');
      expect(control.spokenCount).toBe(1);
      expect(spoken).toEqual(['大家都好。']);
    });
  }

  it('cancel/rate 不是派发类门：release() 也不会把丢弃的缓冲放出来', () => {
    const spoken: string[] = [];
    const gate = new SpeechGate((s) => spoken.push(s));
    gate.push('先缓冲一句。');
    gate.setAction('cancel_delegation');
    gate.release();
    expect(spoken).toEqual([]);
  });
});
