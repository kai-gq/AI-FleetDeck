import { describe, it, expect } from 'vitest';
import {
  VOICE_PERSONAS,
  PERSONA_CUSTOM_ID,
  PERSONA_CUSTOM_MAX,
  DEFAULT_PERSONA_ID,
  sanitizePersonaId,
  sanitizePersonaCustom,
  resolvePersonaStyle,
  personaKeyOf,
} from './voice-personas.js';

describe('voice-personas', () => {
  it('ships a default persona and unique ids', () => {
    const ids = VOICE_PERSONAS.map((p) => p.id);
    expect(ids).toContain(DEFAULT_PERSONA_ID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of VOICE_PERSONAS) {
      expect(p.stylePrompt.length).toBeGreaterThan(0);
    }
  });

  it('sanitizePersonaId: keeps known ids and custom, falls back to default', () => {
    expect(sanitizePersonaId('butler')).toBe('butler');
    expect(sanitizePersonaId(PERSONA_CUSTOM_ID)).toBe(PERSONA_CUSTOM_ID);
    expect(sanitizePersonaId('  sharp ')).toBe('sharp');
    expect(sanitizePersonaId('nope')).toBe(DEFAULT_PERSONA_ID);
    expect(sanitizePersonaId(undefined)).toBe(DEFAULT_PERSONA_ID);
    expect(sanitizePersonaId(42)).toBe(DEFAULT_PERSONA_ID);
  });

  it('sanitizePersonaCustom: trims, strips control chars but keeps newlines, caps length', () => {
    expect(sanitizePersonaCustom('  你好\u0000\u0007 世界  ')).toBe('你好 世界');
    expect(sanitizePersonaCustom('第一行\n第二行')).toBe('第一行\n第二行');
    expect(sanitizePersonaCustom('x'.repeat(PERSONA_CUSTOM_MAX + 50))).toHaveLength(PERSONA_CUSTOM_MAX);
    expect(sanitizePersonaCustom(null)).toBe('');
    expect(sanitizePersonaCustom(123)).toBe('');
  });

  it('resolvePersonaStyle: preset id → its stylePrompt', () => {
    const doubao = VOICE_PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID)!;
    expect(resolvePersonaStyle(DEFAULT_PERSONA_ID)).toBe(doubao.stylePrompt);
    expect(resolvePersonaStyle('pro')).toBe(VOICE_PERSONAS.find((p) => p.id === 'pro')!.stylePrompt);
  });

  it('resolvePersonaStyle: custom with text → custom text wins', () => {
    expect(resolvePersonaStyle(PERSONA_CUSTOM_ID, '  你是个海盗船长。 ')).toBe('你是个海盗船长。');
  });

  it('resolvePersonaStyle: custom empty or unknown → default preset (never empty)', () => {
    const doubao = VOICE_PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID)!;
    expect(resolvePersonaStyle(PERSONA_CUSTOM_ID, '   ')).toBe(doubao.stylePrompt);
    expect(resolvePersonaStyle('bogus', 'ignored')).toBe(doubao.stylePrompt);
    expect(resolvePersonaStyle(undefined, undefined)).toBe(doubao.stylePrompt);
  });

  it('personaKeyOf: stable for the effective persona, differs across personas', () => {
    // 预设:键 = id,与 custom 里残留的文本无关
    expect(personaKeyOf('sharp', 'leftover')).toBe('sharp');
    // 自定义:键含文本;空白自定义与默认预设同键(避免无谓的会话轮换)
    expect(personaKeyOf(PERSONA_CUSTOM_ID, '海盗船长')).not.toBe(personaKeyOf(PERSONA_CUSTOM_ID, '严谨秘书'));
    expect(personaKeyOf(PERSONA_CUSTOM_ID, '  ')).toBe(DEFAULT_PERSONA_ID);
    expect(personaKeyOf('bogus')).toBe(DEFAULT_PERSONA_ID);
    // 同一输入 → 同一键
    expect(personaKeyOf('butler')).toBe(personaKeyOf('butler', ''));
  });
});
