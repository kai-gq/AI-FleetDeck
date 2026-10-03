import { describe, it, expect } from 'vitest';
import { SpeechGate } from './speech-gate.js';

function collect() {
  const spoken: string[] = [];
  const gate = new SpeechGate((s) => spoken.push(s));
  return { gate, spoken };
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

  it('drops buffered text and stays silent for query_agent_output', () => {
    const { gate, spoken } = collect();
    gate.push('我先看看。');
    gate.setAction('query_agent_output');
    gate.push('还有这句。');
    expect(spoken).toEqual([]);
  });

  it('holds send_to_agent confirmations until dispatch succeeds', () => {
    const { gate, spoken } = collect();
    gate.setAction('send_to_agent');
    gate.push('已让小美去修登录页。');
    expect(spoken).toEqual([]);
    gate.release();
    expect(spoken).toEqual(['已让小美去修登录页。']);
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

  it('ignores empty or whitespace-only sentences and counts only emitted ones', () => {
    const { gate, spoken } = collect();
    gate.setAction('general_response');
    gate.push('   ');
    gate.push('');
    gate.push('在的。');
    expect(spoken).toEqual(['在的。']);
    expect(gate.spokenCount).toBe(1);
  });

  it('lets later pushes through once switched to a speaking action (hop2 usage)', () => {
    const { gate, spoken } = collect();
    gate.setAction('query_agent_output');
    gate.push('丢弃。');
    gate.setAction('general_response');
    gate.push('小美刚把登录页修完了。');
    expect(spoken).toEqual(['小美刚把登录页修完了。']);
  });

  // ---- 阶段一补测:五动作语义边界 ----

  it('list_agents releases immediately once the action is known', () => {
    const { gate, spoken } = collect();
    gate.setAction('list_agents');
    gate.push('小美在改登录页,阿蓝空闲。');
    expect(spoken).toEqual(['小美在改登录页,阿蓝空闲。']); // 不缓冲,直接出声
    expect(gate.spokenCount).toBe(1);
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
