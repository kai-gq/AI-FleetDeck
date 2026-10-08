import { describe, expect, it } from 'vitest';
import {
  clickVoiceCompanionButton,
  pickVoiceCompanionButton,
  readVoiceCompanionState,
  type VoiceButtonLike,
} from './useVoiceCompanionPhase';

/** 最小桩：className + classList.contains + title + click 记录（本仓测试无 jsdom，只测纯逻辑）。 */
function stubButton(className: string, title: string | null = null) {
  const clicked: string[] = [];
  const btn: VoiceButtonLike = {
    className,
    classList: { contains: (token: string) => className.split(/\s+/).includes(token) },
    getAttribute: (name: string) => (name === 'title' ? title : null),
    click: () => clicked.push(className),
  };
  return { btn, clicked };
}

function stubRoot(buttons: VoiceButtonLike[]): ParentNode {
  return { querySelectorAll: () => buttons } as unknown as ParentNode;
}

describe('pickVoiceCompanionButton（B-26 双实例择一）', () => {
  it('无按钮 → null', () => {
    expect(pickVoiceCompanionButton(stubRoot([]))).toBeNull();
  });

  it('优先 leader（无 non-leader 类），即使它在 DOM 靠后', () => {
    const { btn: follower } = stubButton('voice-companion-btn phase-off non-leader');
    const { btn: leader } = stubButton('voice-companion-btn phase-listening');
    expect(pickVoiceCompanionButton(stubRoot([follower, leader]))).toBe(leader);
  });

  it('全部 non-leader → 取 DOM 首个', () => {
    const { btn: first } = stubButton('voice-companion-btn phase-off non-leader');
    const { btn: second } = stubButton('voice-companion-btn phase-off non-leader');
    expect(pickVoiceCompanionButton(stubRoot([first, second]))).toBe(first);
  });
});

describe('readVoiceCompanionState（相位镜像）', () => {
  it('无按钮 → present=false + 空闲相位', () => {
    expect(readVoiceCompanionState(stubRoot([]))).toEqual({
      present: false,
      phase: 'off',
      label: null,
      isLeader: false,
    });
  });

  it('提取 phase-* 后缀与 title，自定义类（mobile-voice-companion）不干扰', () => {
    const { btn } = stubButton(
      'voice-companion-btn mobile-voice-companion phase-speaking',
      '正在播报(说话或点击可打断)'
    );
    expect(readVoiceCompanionState(stubRoot([btn]))).toEqual({
      present: true,
      phase: 'speaking',
      label: '正在播报(说话或点击可打断)',
      isLeader: true,
    });
  });

  it('缺 phase- 类 → 回退 off（防御）', () => {
    const { btn } = stubButton('voice-companion-btn');
    expect(readVoiceCompanionState(stubRoot([btn])).phase).toBe('off');
  });

  it('non-leader 实例 isLeader=false', () => {
    const { btn } = stubButton('voice-companion-btn phase-off non-leader');
    expect(readVoiceCompanionState(stubRoot([btn])).isLeader).toBe(false);
  });
});

describe('clickVoiceCompanionButton（DOM 代理点击）', () => {
  it('点到 leader 实例并返回 true', () => {
    const { btn: follower, clicked: c1 } = stubButton('voice-companion-btn phase-off non-leader');
    const { btn: leader, clicked: c2 } = stubButton('voice-companion-btn phase-off');
    expect(clickVoiceCompanionButton(stubRoot([follower, leader]))).toBe(true);
    expect(c1).toEqual([]);
    expect(c2).toEqual(['voice-companion-btn phase-off']);
  });

  it('无按钮 → false（调用方降级）', () => {
    expect(clickVoiceCompanionButton(stubRoot([]))).toBe(false);
  });
});
