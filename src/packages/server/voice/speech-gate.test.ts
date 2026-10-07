import { describe, it, expect } from 'vitest';
import { SpeechGate } from './speech-gate.js';
import type { SentenceMeta } from './speech-gate.js';

function collect() {
  const spoken: string[] = [];
  const metas: (SentenceMeta | undefined)[] = [];
  const gate = new SpeechGate((s, m) => {
    spoken.push(s);
    metas.push(m);
  });
  return { gate, spoken, metas };
}

describe('SpeechGate', () => {
  it('buffers sentences until the action is known, then releases for general_response', () => {
    const { gate, spoken } = collect();
    gate.push('第一句。');
    gate.push('第二句。');
    expect(spoken).toEqual([]);
    gate.setAction('general_response');
    expect(spoken).toEqual(['第一句。', '第二句。']);
    gate.push('第三句。');
    expect(spoken).toEqual(['第一句。', '第二句。', '第三句。']);
  });

  it('stays silent for noop, including later pushes', () => {
    const { gate, spoken } = collect();
    gate.setAction('noop');
    gate.push('不该出声。');
    gate.push('也不该。');
    expect(spoken).toEqual([]);
    expect(gate.spoke).toBe(false);
  });

  it('buffers query_agent_output until released, then plays as pre(W4 过渡话术照播,不进对账集)', () => {
    const { gate, spoken, metas } = collect();
    gate.push('在,我去看一眼。');
    gate.setAction('query_agent_output');
    gate.push('还有这句等 release。');
    expect(spoken).toEqual([]); // 未确定要跑 hop2 前保持静默
    gate.release({ pre: true });
    expect(spoken).toEqual(['在,我去看一眼。', '还有这句等 release。']);
    expect(metas).toEqual([{ pre: true }, { pre: true }]);
    expect(gate.spoke).toBe(true);
  });

  it('query_agent_output 目标无效时 discard 保持静默(失败路径不出声)', () => {
    const { gate, spoken } = collect();
    gate.setAction('query_agent_output');
    gate.push('在,我去看一眼。');
    gate.discard();
    gate.push('后面的也不播。');
    expect(spoken).toEqual([]);
    expect(gate.spokenCount).toBe(0);
  });

  it('drops buffered text and stays silent for analyze_logs(报告由分析产出,hop1 话术不出声)', () => {
    const { gate, spoken } = collect();
    gate.push('我先查查日志。');
    gate.setAction('analyze_logs');
    gate.push('这句也不该出声。');
    expect(spoken).toEqual([]);
    expect(gate.spokenCount).toBe(0);
  });

  it('drops buffered text and stays silent for Bolba 四动作(任务13·⑩:结果由服务端确定性产出)', () => {
    for (const action of ['query_bolba_tasks', 'create_bolba_task', 'complete_bolba_task', 'reopen_bolba_task'] as const) {
      const { gate, spoken } = collect();
      gate.push('这句不能出声。');
      gate.setAction(action);
      gate.push('这也别出声。');
      expect(spoken).toEqual([]);
      expect(gate.spoke).toBe(false);
    }
  });

  it('holds send_to_agent confirmations until dispatch succeeds', () => {
    const { gate, spoken, metas } = collect();
    gate.setAction('send_to_agent');
    gate.push('已让小美去修登录页。');
    expect(spoken).toEqual([]);
    gate.release();
    expect(spoken).toEqual(['已让小美去修登录页。']);
    expect(metas).toEqual([undefined]); // 派发确认句不带 pre 标记(照常参与对账)
    expect(gate.spoke).toBe(true);
  });

  it('discards send_to_agent confirmations when dispatch fails', () => {
    const { gate, spoken } = collect();
    gate.setAction('send_to_agent');
    gate.push('已让小美去修登录页。');
    gate.discard();
    gate.push('后面的也不播。');
    expect(spoken).toEqual([]);
    expect(gate.spokenCount).toBe(0);
  });

  // ---- 改①:delegate_to_boss 与 send_to_agent 同为「派发类」语义 ----

  it('holds delegate_to_boss confirmations until dispatch succeeds', () => {
    const { gate, spoken } = collect();
    gate.setAction('delegate_to_boss');
    gate.push('已交给主管安排。');
    expect(spoken).toEqual([]); // 派发结果未定,不出声
    gate.release();
    expect(spoken).toEqual(['已交给主管安排。']);
    expect(gate.spoke).toBe(true);
  });

  it('discards delegate_to_boss confirmations when dispatch fails', () => {
    const { gate, spoken } = collect();
    gate.setAction('delegate_to_boss');
    gate.push('已交给主管安排。');
    gate.discard();
    gate.push('后面的也不播。');
    expect(spoken).toEqual([]);
    expect(gate.spokenCount).toBe(0);
  });

  it('ignores empty or whitespace-only sentences and counts only emitted ones', () => {
    const { gate, spoken } = collect();
    gate.setAction('general_response');
    gate.push('   ');
    gate.push('');
    gate.push('在的。');
    expect(spoken).toEqual(['在的。']);
    expect(gate.spokenCount).toBe(1);
  });

  it('reclassification query_agent_output → speaking action flushes the buffer without pre meta', () => {
    const { gate, spoken, metas } = collect();
    gate.setAction('query_agent_output');
    gate.push('缓冲句。');
    gate.setAction('general_response'); // 重分类:改按说话动作放行
    gate.push('小美刚把登录页修完了。');
    expect(spoken).toEqual(['缓冲句。', '小美刚把登录页修完了。']);
    expect(metas).toEqual([undefined, undefined]);
  });

  // ---- 阶段一补测:五动作语义边界 ----

  it('list_agents 静默丢弃:名单由服务端实时兜底整段播报,hop1 话术不出声(2026-10-07 修「一问两答」)', () => {
    const { gate, spoken } = collect();
    gate.push('action 落定前先入缓冲的这句。');
    gate.setAction('list_agents');
    gate.push('小美在改登录页,阿蓝空闲。');
    expect(spoken).toEqual([]); // 缓冲清空、后续也不出声
    expect(gate.spokenCount).toBe(0); // spoke=false → 客户端按 result.response 整段补播一次
    expect(gate.spoke).toBe(false);
  });

  it('send_to_agent: release emits buffered sentences in order, including pushes made before the action was known', () => {
    const { gate, spoken } = collect();
    gate.push('第一句。'); // action 未定 → 缓冲
    gate.push('第二句。');
    gate.setAction('send_to_agent'); // 仍缓冲,等派发结果
    gate.push('第三句。');
    expect(spoken).toEqual([]);
    gate.release();
    expect(spoken).toEqual(['第一句。', '第二句。', '第三句。']);
  });

  it('reclassifying send_to_agent → noop drops the pending confirmation', () => {
    const { gate, spoken } = collect();
    gate.setAction('send_to_agent');
    gate.push('已让小美去修登录页。');
    gate.setAction('noop'); // 派发未发生就已判定无事发生
    gate.push('这句也不该出声。');
    expect(spoken).toEqual([]);
    expect(gate.spokenCount).toBe(0);
  });

  it('repeated setAction/release are idempotent (no duplicate emissions)', () => {
    const { gate, spoken } = collect();
    gate.setAction('general_response');
    gate.push('在的。');
    gate.setAction('general_response'); // 重复设置:缓冲已空,无副作用
    gate.release();
    gate.release();
    expect(spoken).toEqual(['在的。']);
    expect(gate.spokenCount).toBe(1);
  });

  it('release/discard on an empty buffer are safe no-ops', () => {
    const { gate, spoken } = collect();
    gate.release();
    gate.discard();
    gate.setAction('send_to_agent');
    gate.release();
    gate.discard();
    expect(spoken).toEqual([]);
  });

  it('send_to_agent: discard drops only what was buffered; later pushes buffer again and release emits them', () => {
    const { gate, spoken } = collect();
    gate.setAction('send_to_agent');
    gate.push('已让小美去修。');
    gate.discard(); // 派发失败:静默丢弃
    gate.push('这句等 release。');
    expect(spoken).toEqual([]);
    gate.release();
    expect(spoken).toEqual(['这句等 release。']);
  });
});
