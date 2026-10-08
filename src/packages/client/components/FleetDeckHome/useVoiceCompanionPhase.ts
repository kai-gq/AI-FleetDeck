import { useEffect, useState } from 'react';

/**
 * 语音伙伴相位镜像 + DOM 代理启停（B-26）
 *
 * VoiceCompanion 是冻结组件（不改），但它的状态全写在 DOM 上：
 * `.voice-companion-btn` 的 `phase-*` 类与 `title`（本地化相位标签）。
 * 本模块让指挥台启停控件 / 顶栏秘书 pill / 状态栏（B-27）共用同一份真实状态：
 * - `useVoiceCompanionPhase()`：MutationObserver 盯 document.body 读相位；
 * - `clickVoiceCompanionButton()`：合成点击（对 display:none 元素照常派发），
 *   语义复用 VoiceCompanion.handleButtonClick（开启 / 关闭 / 播报中打断）。
 *
 * 双实例（桌面 rail + MobileFabMenu 各挂一份）：优先取 leader 实例（无 `non-leader` 类）——
 * 非 leader 那份的语义是「另一处正在聆听，点击接管」。
 * 纯逻辑（pick/read/click）只依赖结构最小化类型，便于 node 环境单测（本仓无 jsdom）。
 */

export interface VoiceCompanionState {
  /** 任一实例的按钮是否存在（config.enabled=false 时组件返回 null）；null=首帧未扫描 */
  present: boolean | null;
  /** 相位（phase-* 类后缀，如 off/listening/hearing/speaking）；无按钮时 'off' */
  phase: string;
  /** 按钮 title（VoiceCompanion 自带本地化相位标签）；无按钮时 null */
  label: string | null;
  /** 选中实例是否 leader */
  isLeader: boolean;
}

/** 结构最小化按钮（HTMLButtonElement 天然满足；单测用同名桩） */
export interface VoiceButtonLike {
  className: string;
  classList: { contains(token: string): boolean };
  getAttribute(name: string): string | null;
  click(): void;
}

const IDLE = { phase: 'off', label: null, isLeader: false } as const;

function phaseOf(btn: VoiceButtonLike): string {
  const cls = btn.className.split(/\s+/).find((c) => c.startsWith('phase-'));
  return cls ? cls.slice('phase-'.length) : 'off';
}

/** 双实例择一：优先 leader（无 non-leader 类），否则 DOM 首个 */
export function pickVoiceCompanionButton(root: ParentNode = document): VoiceButtonLike | null {
  const buttons = Array.from(root.querySelectorAll<HTMLElement>('.voice-companion-btn'));
  if (buttons.length === 0) return null;
  return buttons.find((btn) => !btn.classList.contains('non-leader')) ?? buttons[0];
}

export function readVoiceCompanionState(root: ParentNode = document): VoiceCompanionState {
  const btn = pickVoiceCompanionButton(root);
  if (!btn) return { present: false, ...IDLE };
  return {
    present: true,
    phase: phaseOf(btn),
    label: btn.getAttribute('title'),
    isLeader: !btn.classList.contains('non-leader'),
  };
}

/** 合成点击：display:none 元素照常派发事件；按钮不存在返回 false（调用方自行降级） */
export function clickVoiceCompanionButton(root: ParentNode = document): boolean {
  const btn = pickVoiceCompanionButton(root);
  if (!btn) return false;
  btn.click();
  return true;
}

/**
 * 扫描签名去重：按钮类/标题没变就不 setState（TTS 流式期间 body 变异频繁）。
 * 监听 class 与 title 属性 + 子树增删（组件挂载/卸载、气泡出现）。
 */
export function useVoiceCompanionPhase(): VoiceCompanionState {
  const [state, setState] = useState<VoiceCompanionState>({ present: null, ...IDLE });

  useEffect(() => {
    let last = '';
    const scan = () => {
      const next = readVoiceCompanionState();
      const sig = `${next.present ? '1' : '0'}|${next.phase}|${next.isLeader ? '1' : '0'}|${next.label ?? ''}`;
      if (sig === last) return;
      last = sig;
      setState(next);
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'title'],
    });
    return () => observer.disconnect();
  }, []);

  return state;
}
