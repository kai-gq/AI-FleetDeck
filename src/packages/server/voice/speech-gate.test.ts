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
});
