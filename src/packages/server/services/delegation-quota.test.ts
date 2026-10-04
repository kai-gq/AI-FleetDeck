import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONCURRENCY_BUDGET,
  applyQuotaEvent,
  computeDispatchBudget,
  countsAgainstQuota,
  createQuotaState,
  remainingBudget,
  type QuotaState,
} from './delegation-quota.js';

const N = DEFAULT_CONCURRENCY_BUDGET;

function req(taskId: string, state: QuotaState, budget: number = N) {
  return applyQuotaEvent(state, { kind: 'request', taskId }, budget);
}

function done(taskId: string, state: QuotaState, budget: number = N) {
  return applyQuotaEvent(state, { kind: 'complete', taskId }, budget);
}

/** 依次请求若干 id,返回末态(默认 N=3)。 */
function requestAll(ids: readonly string[], budget: number = N): QuotaState {
  let state = createQuotaState();
  for (const id of ids) state = req(id, state, budget).state;
  return state;
}

/** 确定性伪随机(LCG),保证不变式回放可复现。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('delegation-quota · 起步预算与自留区边界(Spec §4.12 / §8.2)', () => {
  it('起步预算 N=3(保守初始值,非最优,无实测)', () => {
    expect(DEFAULT_CONCURRENCY_BUDGET).toBe(3);
  });

  it('配额只约束委派链路:自留区(聊天/查询/只读)不计配额', () => {
    expect(countsAgainstQuota('delegation')).toBe(true);
    expect(countsAgainstQuota('secretary')).toBe(false);
  });
});

describe('delegation-quota · 准入与 N=3 边界', () => {
  it('未满放行:活跃 < N → admitted,占用预算', () => {
    const s1 = req('t1', createQuotaState());
    expect(s1.decision.action).toBe('admitted');
    expect(s1.decision.reason).toBe('budget_available');
    expect(s1.state.activeIds).toEqual(['t1']);

    const s2 = req('t2', s1.state);
    expect(s2.decision.action).toBe('admitted');
    expect(s2.state.activeIds).toEqual(['t1', 't2']);
  });

  it('N=3 边界:3 个占满 → 第 4 个 queued(严格小于,不超发)', () => {
    const full = requestAll(['a', 'b', 'c']); // 默认预算 3,连开 3 个
    expect(full.activeIds).toEqual(['a', 'b', 'c']);
    expect(full.queuedIds).toEqual([]);

    const fourth = req('d', full); // 不传 budget,走默认 N=3
    expect(fourth.decision.action).toBe('queued');
    expect(fourth.decision.reason).toBe('budget_exhausted');
    expect(fourth.state.activeIds).toEqual(['a', 'b', 'c']); // 活跃不动
    expect(fourth.state.queuedIds).toEqual(['d']); // 不丢:进队尾
    expect(fourth.decision.activeCount).toBe(3);
    expect(fourth.decision.queuedCount).toBe(1);
  });

  it('budget ≤ 0:一律排队(保守降级,不静默放行也不丢任务)', () => {
    const s = req('t1', createQuotaState(), 0);
    expect(s.decision.action).toBe('queued');
    expect(s.state.activeIds).toEqual([]);
    expect(s.state.queuedIds).toEqual(['t1']);
  });

  it('重复请求(同 id):noop/duplicate,状态不变(不重复占位)', () => {
    let state = requestAll(['a']);
    state = req('b', state).state; // active [a,b]
    const dupActive = req('a', state);
    expect(dupActive.decision.action).toBe('noop');
    expect(dupActive.decision.reason).toBe('duplicate');
    expect(dupActive.state).toEqual(state);

    const queuedState = requestAll(['a', 'b', 'c', 'q']); // q 排队
    const dupQueued = req('q', queuedState);
    expect(dupQueued.decision.action).toBe('noop');
    expect(dupQueued.decision.reason).toBe('duplicate');
    expect(dupQueued.state).toEqual(queuedState);
  });

  it('全局共池:多个项目任务共享同一预算(N=2 时第 3 个排队)', () => {
    const s = requestAll(['p1-a', 'p2-b', 'p3-c'], 2);
    expect(s.activeIds).toEqual(['p1-a', 'p2-b']);
    expect(s.queuedIds).toEqual(['p3-c']);
  });
});

describe('delegation-quota · 完成与 FIFO 自动出队', () => {
  it('空队完成:completed/released,活跃减 1,无出队', () => {
    const state = requestAll(['a', 'b']);
    const r = done('a', state);
    expect(r.decision.action).toBe('completed');
    expect(r.decision.reason).toBe('released');
    expect(r.decision.dequeuedId).toBeNull();
    expect(r.state.activeIds).toEqual(['b']);
    expect(r.state.queuedIds).toEqual([]);
  });

  it('完成 1 个(队非空)→ 自动出队队首 1 个,FIFO 序', () => {
    // active [a,b,c],排队 [d,e]
    let state = requestAll(['a', 'b', 'c', 'd', 'e']);
    expect(state.activeIds).toEqual(['a', 'b', 'c']);
    expect(state.queuedIds).toEqual(['d', 'e']);

    const first = done('b', state); // 完成中间一个,队首 d 出队
    expect(first.decision.action).toBe('dequeued');
    expect(first.decision.reason).toBe('auto_dequeue');
    expect(first.decision.dequeuedId).toBe('d'); // 先到先得
    expect(first.state.activeIds).toEqual(['a', 'c', 'd']);
    expect(first.state.queuedIds).toEqual(['e']);

    const second = done('a', first.state);
    expect(second.decision.dequeuedId).toBe('e'); // d 在前,e 在后(顺序反转必红)
    expect(second.state.activeIds).toEqual(['c', 'd', 'e']);
    expect(second.state.queuedIds).toEqual([]);

    const third = done('c', second.state); // 队列已空,只释放
    expect(third.decision.action).toBe('completed');
    expect(third.decision.dequeuedId).toBeNull();
    expect(third.state.activeIds).toEqual(['d', 'e']);
  });

  it('完成 1 出队 1:队列非空期间净活跃恒为 N', () => {
    const state = requestAll(['a', 'b', 'c', 'd', 'e', 'f']);
    let cur = state;
    for (const id of ['a', 'b', 'c']) {
      const r = done(id, cur);
      expect(r.decision.action).toBe('dequeued');
      expect(r.decision.activeCount).toBe(N); // 出一个、进一个
      cur = r.state;
    }
    expect(cur.activeIds).toEqual(['d', 'e', 'f']);
    expect(cur.queuedIds).toEqual([]);
  });

  it('出队后再请求:新任务进队尾(不插队)', () => {
    let state = requestAll(['a', 'b', 'c', 'd', 'e']);
    state = done('a', state).state; // active [b,c,d], queue [e]
    const r = req('f', state); // 满员 → 排队
    expect(r.decision.action).toBe('queued');
    expect(r.state.queuedIds).toEqual(['e', 'f']); // 队尾,不插队
    expect(done('b', r.state).decision.dequeuedId).toBe('e');
  });
});

describe('delegation-quota · 确定性降级(不丢任务)', () => {
  it('未知 id 释放(空队):noop/unknown_task,状态不变', () => {
    const state = requestAll(['a']);
    const r = done('ghost', state);
    expect(r.decision.action).toBe('noop');
    expect(r.decision.reason).toBe('unknown_task');
    expect(r.state).toEqual(state);
  });

  it('重复释放同一 id:首次 completed,二次 noop,状态不再变', () => {
    const state = requestAll(['a', 'b']);
    const first = done('a', state);
    expect(first.decision.action).toBe('completed');
    const second = done('a', first.state);
    expect(second.decision.action).toBe('noop');
    expect(second.decision.reason).toBe('unknown_task');
    expect(second.state).toEqual(first.state);
  });

  it('释放仍在排队的 id:noop,排队保持(FIFO 不动、任务不丢)', () => {
    const state = requestAll(['a', 'b', 'c', 'q']);
    const r = done('q', state); // q 还没开始跑,误报完成
    expect(r.decision.action).toBe('noop');
    expect(r.decision.reason).toBe('unknown_task');
    expect(r.state.activeIds).toEqual(['a', 'b', 'c']);
    expect(r.state.queuedIds).toEqual(['q']); // 取消是 ⑬ 的独立通路,不在配额闸门处理
  });
});

describe('delegation-quota · Boss 拆解可并行数 = min(团队空闲, 剩余预算)', () => {
  it('剩余预算:max(0, N − 活跃);配置缩水时钳到 0', () => {
    expect(remainingBudget(requestAll(['a']), N)).toBe(2);
    expect(remainingBudget(requestAll(['a', 'b', 'c']), N)).toBe(0);
    expect(remainingBudget(requestAll(['a', 'b', 'c', 'd', 'e']), N)).toBe(0); // 活跃 > N(配置缩水)
  });

  it('组合:预算绑定(空闲 5 / 剩余 1 → 1)', () => {
    const state = requestAll(['a', 'b']); // 剩余 1
    expect(computeDispatchBudget(state, 5, N)).toBe(1);
  });

  it('组合:空闲绑定(空闲 2 / 剩余 3 → 2)', () => {
    const state = createQuotaState(); // 剩余 3
    expect(computeDispatchBudget(state, 2, N)).toBe(2);
  });

  it('组合:剩余 0(满员)→ 0;空闲 0 → 0', () => {
    const full = requestAll(['a', 'b', 'c']);
    expect(computeDispatchBudget(full, 5, N)).toBe(0);
    expect(computeDispatchBudget(createQuotaState(), 0, N)).toBe(0);
  });

  it('确定性降级:空闲数传负 → 0(不放大也不放行);默认预算参数生效', () => {
    expect(computeDispatchBudget(createQuotaState(), -3)).toBe(0);
    expect(computeDispatchBudget(createQuotaState(), 5)).toBe(3); // 默认 N=3
  });
});

describe('delegation-quota · 纯函数与不丢任务不变式', () => {
  it('纯函数:输入状态不被修改;变更时数组为新引用', () => {
    const state = requestAll(['a', 'b', 'c']);
    const snapshot = JSON.parse(JSON.stringify(state));

    const r = req('d', state);
    done('a', state);
    done('ghost', state);
    expect(state).toEqual(snapshot); // 输入原样

    expect(r.state.activeIds).toBe(state.activeIds); // 排队不改活跃 → 按引用复用
    expect(r.state.queuedIds).not.toBe(state.queuedIds); // 排队追加 → 新数组
  });

  it('Spec §4.12 验收片段:并发 5 个请求 → 活跃 ≤ N,其余 queued;完成 1 → 出队 1', () => {
    const state = requestAll(['t1', 't2', 't3', 't4', 't5']);
    expect(state.activeIds.length).toBe(N);
    expect(state.queuedIds).toEqual(['t4', 't5']);

    const r = done('t1', state); // 完成一个 → 自动出队一个
    expect(r.state.activeIds).toEqual(['t2', 't3', 't4']);
    expect(r.state.queuedIds).toEqual(['t5']);
  });

  it('不丢任务不变式:300 步确定性随机序列,账目守恒、id 不重不漏、不超预算', () => {
    const rand = lcg(20261004);
    let state = createQuotaState();
    const outstanding = new Set<string>(); // 已准入且未完成(活跃 ∪ 排队)
    const queuedMirror: string[] = []; // 按决策记账的 FIFO 镜像

    for (let step = 0; step < 300; step++) {
      if (rand() < 0.55 || outstanding.size === 0) {
        const id = `t${Math.floor(rand() * 40)}`; // id 空间小于步数 → 必然出现重复请求
        const { state: next, decision } = req(id, state);
        if (decision.action === 'admitted') {
          expect(decision.reason).toBe('budget_available');
          expect(outstanding.has(id)).toBe(false);
          outstanding.add(id);
        } else if (decision.action === 'queued') {
          expect(decision.reason).toBe('budget_exhausted');
          expect(outstanding.has(id)).toBe(false);
          outstanding.add(id);
          queuedMirror.push(id);
        } else {
          expect(decision.action).toBe('noop');
          expect(decision.reason).toBe('duplicate'); // 重复请求不重复占位
        }
        state = next;
      } else {
        const unknown = rand() < 0.4; // 4 成概率释放未知 id(确定性 noop)
        const pool = [...outstanding];
        const id = unknown ? `ghost-${step}` : pool[Math.floor(rand() * pool.length)];
        const { state: next, decision } = done(id, state);
        if (decision.action === 'completed' || decision.action === 'dequeued') {
          expect(outstanding.has(id)).toBe(true); // 只有活跃任务可完成
          outstanding.delete(id);
          if (decision.action === 'dequeued') {
            expect(decision.dequeuedId).not.toBeNull();
            expect(decision.dequeuedId).toBe(queuedMirror.shift()); // FIFO 记账一致
            expect(outstanding.has(decision.dequeuedId as string)).toBe(true);
          }
        } else {
          expect(decision.action).toBe('noop');
          expect(decision.reason).toBe('unknown_task'); // 未知/重复/仍排队 → 确定降级
        }
        state = next;
      }

      // 不变式:账目守恒(总数 = 活跃 + 排队)、id 不重不漏、活跃永不超预算。
      expect(state.activeIds.length + state.queuedIds.length).toBe(outstanding.size);
      expect(new Set([...state.activeIds, ...state.queuedIds]).size).toBe(outstanding.size);
      expect(state.activeIds.length).toBeLessThanOrEqual(N);
      expect(state.queuedIds).toEqual(queuedMirror);
    }
    // 300 步内确有请求/排队/出队/降级各态发生,序列不退化
    expect(outstanding.size).toBeGreaterThan(0);
  });
});
