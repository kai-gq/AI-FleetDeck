import { describe, expect, it } from 'vitest';
import {
  AGENT_BADGE_TONE_VARS,
  AGENT_BADGE_TONES,
  agentBadgeTone,
  nameInitial,
} from './agentBadge';

describe('AgentBadge · 状态分组（EPIC-8）', () => {
  it('七个状态全部映射：active/success/danger/muted', () => {
    expect(agentBadgeTone('working')).toBe('active');
    expect(agentBadgeTone('waiting')).toBe('active');
    expect(agentBadgeTone('waiting_permission')).toBe('active');
    expect(agentBadgeTone('idle')).toBe('success');
    expect(agentBadgeTone('error')).toBe('danger');
    expect(agentBadgeTone('offline')).toBe('muted');
    expect(agentBadgeTone('orphaned')).toBe('muted');
  });

  it('未知/空状态回退 muted，不编造颜色', () => {
    expect(agentBadgeTone('')).toBe('muted');
    expect(agentBadgeTone('nonsense')).toBe('muted');
  });

  it('色值常量唯一来源：四 tone 全走 CSS 变量（与总览状态灯同一变量）', () => {
    expect(Object.keys(AGENT_BADGE_TONE_VARS).sort()).toEqual(['active', 'danger', 'muted', 'success']);
    for (const varRef of Object.values(AGENT_BADGE_TONE_VARS)) {
      expect(varRef).toMatch(/^var\(--[a-z-]+\)$/);
    }
    expect(AGENT_BADGE_TONE_VARS.active).toBe('var(--accent-cyan)');
    expect(AGENT_BADGE_TONE_VARS.success).toBe('var(--accent-green)');
    expect(AGENT_BADGE_TONE_VARS.danger).toBe('var(--accent-red)');
    expect(AGENT_BADGE_TONE_VARS.muted).toBe('var(--text-muted)');
    // 每个状态经 tone 中转后都能落到变量上（无空洞）
    for (const status of Object.keys(AGENT_BADGE_TONES)) {
      expect(AGENT_BADGE_TONE_VARS[agentBadgeTone(status)]).toBeDefined();
    }
  });
});

describe('AgentBadge · 名字首字徽标', () => {
  it('中文取尾字（SPEC 原文例：Builder 甲 → 甲）', () => {
    expect(nameInitial('Builder 甲')).toBe('甲');
    expect(nameInitial('小刘')).toBe('年');
    expect(nameInitial('王强')).toBe('强');
    expect(nameInitial('看板 🚀')).toBe('板'); // 尾部 emoji 跳过，取最后一个汉字
  });

  it('西文取首个字母数字并大写', () => {
    expect(nameInitial('claude-1')).toBe('C');
    expect(nameInitial('  bob ')).toBe('B');
    expect(nameInitial('7号机')).toBe('机'); // 含汉字 → 仍按中文规则取尾字
    expect(nameInitial('agent_42')).toBe('A');
  });

  it('空/纯符号兜底 ?', () => {
    expect(nameInitial('')).toBe('?');
    expect(nameInitial('   ')).toBe('?');
    expect(nameInitial(undefined)).toBe('?');
    expect(nameInitial(null)).toBe('?');
    expect(nameInitial('🚀✨')).toBe('?');
  });

  it('代理对安全：emoji 结尾不把半个字符当首字', () => {
    expect(nameInitial('吴宇航🌊')).toBe('航');
  });
});
