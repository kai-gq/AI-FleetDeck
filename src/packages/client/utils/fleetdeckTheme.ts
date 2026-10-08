/**
 * FleetDeck 双皮肤（B-24）
 *
 * 深色 fleetdeck（新默认）+ 亮色 fleetdeck-light 两个主题对象，以及顶栏开关三件套：
 *   - migrateThemeOnce()：一次性把老用户的 'classic' 存档迁到 'fleetdeck'。
 *     背景：applyTheme 会无条件写 localStorage['tide-theme']，只改 DEFAULT_THEME
 *     对已有存档不生效；用独立标记防重复（用户之后手选回 classic 不再被迁）。
 *   - toggleTheme()：按当前主题 tone 切到另一皮；记忆各自 tone 最近用过的主题
 *     （tide-theme-last-dark / tide-theme-last-light），默认对 fleetdeck ↔ fleetdeck-light。
 *   - getActiveThemeId()：dataset.tideTheme（applyTheme 实时写入）优先，存档兜底。
 *
 * 色板直取原型 token（FleetDeck-指挥台总览-原型.html）：
 *   暗：bg #0A0F1E / panel #0E1628 / panel2 #0B1222 / line #1C2A45 /
 *       text #E6EDF7 / muted #8CA3C3 / faint #5A6C8C / accent #22D3EE + #4F8CFF
 *   亮：bg #F4F7FB / panel #FFFFFF / panel2 #EEF2F8 / line #DDE5F0 /
 *       text #0F172A / muted #5B6B82 / faint #93A3B8 / accent #2563EB + #0EA5E9
 * 原型三档文字对应 textPrimary / textSecondary / textMuted；消息、工具、状态色
 * 按各皮 accent 合成（不引用的扩展字段走 applyTheme 内建 fallback）。
 *
 * 与 themes.ts 的关系：本文件提供数据与逻辑，themes.ts 只做加性接线
 *（ThemeId 联合 / Theme.tone / themes 数组 / DEFAULT_THEME / xterm 亮色分支 + 回填 bindThemeRuntime）。
 * 注意「方向」：themes.ts 求值时需要本文件的主题数据（进 themes 数组），因此本文件
 * 反向不能在求值期依赖 themes.ts——applyTheme/getTheme 走 bindThemeRuntime 回填
 *（themes.ts 自身求值结束前必已执行，两模块任意加载顺序都成立；避免循环依赖
 * 把 themes 数组读成 undefined 的求值时序雷）。
 * 存储键不经过 utils/storage.ts（冻结文件），裸 localStorage + try/catch。
 */

import type { Theme, ThemeId } from './themes';

const SAVED_KEY = 'tide-theme';
const MIGRATED_KEY = 'tide-theme-fleetdeck-migrated';
const LAST_DARK_KEY = 'tide-theme-last-dark';
const LAST_LIGHT_KEY = 'tide-theme-last-light';

// ── themes.ts 运行时回填（见文件头「方向」说明）──
let applyThemeRuntime: ((theme: Theme) => void) | null = null;
let getThemeRuntime: ((id: ThemeId) => Theme) | null = null;

/** 由 themes.ts 在自己求值结束时调用（函数声明会被提升，任意加载顺序下都先于其调用就绪） */
export function bindThemeRuntime(
  apply: (theme: Theme) => void,
  lookup: (id: ThemeId) => Theme
): void {
  applyThemeRuntime = apply;
  getThemeRuntime = lookup;
}

/** 深色皮：深空全息（FleetDeck 新默认） */
export const fleetdeckDarkTheme: Theme = {
  id: 'fleetdeck',
  name: 'FleetDeck',
  description: 'Deep-space deck with cyan holo accents',
  tone: 'dark',
  colors: {
    bgPrimary: '#0A0F1E',
    bgSecondary: '#0E1628',
    bgTertiary: '#0B1222',
    borderColor: '#1C2A45',
    textPrimary: '#E6EDF7',
    textSecondary: '#8CA3C3',
    textMuted: '#5A6C8C',
    accentBlue: '#4F8CFF',
    accentGreen: '#34D399',
    accentOrange: '#FBBF24',
    accentRed: '#F87171',
    accentPurple: '#A78BFA',
    accentCyan: '#22D3EE',
    accentClaude: '#E2B16A',
    accentClaudeLight: '#F0C68C',
    accentPink: '#F472B6',
    accentYellow: '#FBBF24',
    // 消息：用户=蓝（次强调）/ 助理=青（主强调），半透明合成色
    msgUserBg: 'rgba(79, 140, 255, 0.14)',
    msgUserHighlightBg: 'rgba(79, 140, 255, 0.10)',
    msgUserBorder: 'rgba(79, 140, 255, 0.35)',
    msgUserText: '#9DC0FF',
    msgAssistantBg: 'rgba(34, 211, 238, 0.10)',
    msgAssistantBorder: 'rgba(34, 211, 238, 0.30)',
    msgAssistantText: '#7FE7F5',
    // 工具：比面板略深一阶的底 + 珊瑚/冰蓝描边
    toolUseBg: '#0D1526',
    toolUseBorder: '#1F3355',
    toolUseText: '#8CA3C3',
    toolUseName: '#FBBF24',
    toolResultBg: '#0B1322',
    toolResultBorder: '#1A2A45',
    toolResultText: '#8CA3C3',
    outputLineBg: '#0A0F1E',
    contextBarBg: 'rgba(90, 108, 140, 0.25)',
    contextBarFill: '#4F8CFF',
    taskLabelColor: '#22D3EE',
  },
};

/** 亮色皮：明亮 SaaS（同布局同语义；accent 对调为蓝主 / 天蓝次，见 fleetdeck-light-overrides.scss） */
export const fleetdeckLightTheme: Theme = {
  id: 'fleetdeck-light',
  name: 'FleetDeck Light',
  description: 'Bright SaaS light skin',
  tone: 'light',
  colors: {
    bgPrimary: '#F4F7FB',
    bgSecondary: '#FFFFFF',
    bgTertiary: '#EEF2F8',
    borderColor: '#DDE5F0',
    textPrimary: '#0F172A',
    textSecondary: '#5B6B82',
    textMuted: '#93A3B8',
    accentBlue: '#2563EB',
    accentGreen: '#059669',
    accentOrange: '#D97706',
    accentRed: '#DC2626',
    accentPurple: '#7C3AED',
    accentCyan: '#0EA5E9',
    accentClaude: '#B45309',
    accentClaudeLight: '#D97706',
    accentPink: '#DB2777',
    accentYellow: '#CA8A04',
    msgUserBg: 'rgba(37, 99, 235, 0.08)',
    msgUserBorder: 'rgba(37, 99, 235, 0.25)',
    msgUserText: '#1D4ED8',
    msgAssistantBg: 'rgba(14, 165, 233, 0.08)',
    msgAssistantBorder: 'rgba(14, 165, 233, 0.28)',
    msgAssistantText: '#0369A1',
    toolUseBg: '#F6F9FE',
    toolUseBorder: '#DDE5F0',
    toolUseText: '#5B6B82',
    toolUseName: '#B45309',
    toolResultBg: '#F2F6FC',
    toolResultBorder: '#DDE5F0',
    toolResultText: '#5B6B82',
    outputLineBg: '#F4F7FB',
    contextBarBg: 'rgba(147, 163, 184, 0.30)',
    contextBarFill: '#2563EB',
    taskLabelColor: '#2563EB',
  },
};

/** 主题语气：未标注 tone 的历史暗色主题一律视为 dark */
export function themeToneOf(theme: Theme): 'dark' | 'light' {
  return theme.tone === 'light' ? 'light' : 'dark';
}

/** 当前生效主题 id：dataset.tideTheme（applyTheme 实时写入）优先，存档兜底，最后兜默认皮 */
export function getActiveThemeId(): ThemeId {
  if (typeof document !== 'undefined') {
    const live = document.documentElement.dataset.tideTheme;
    if (live) return live as ThemeId;
  }
  try {
    const saved = localStorage.getItem(SAVED_KEY);
    if (saved) return saved as ThemeId;
  } catch {
    // localStorage 不可用
  }
  return 'fleetdeck';
}

/**
 * 一键切皮：从当前主题切到另一语气。
 * 记忆机制：离开某皮时把它的 id 记进对应 tone 的 last 键；切去另一语气时优先
 * 回到「该语气最近用过的主题」（如从 nightshade 切走再切回仍是 nightshade），
 * 无记忆或记忆不合法时落到默认对 fleetdeck ↔ fleetdeck-light。
 * 返回落地主题 id（便于调用方/测试断言）。
 */
export function toggleTheme(): ThemeId {
  const lookup = getThemeRuntime;
  const apply = applyThemeRuntime;
  const currentId = getActiveThemeId();
  // 运行时未接线（理论不可达：themes.ts 与主包同载）：不动皮肤，原样返回
  if (!lookup || !apply) return currentId;
  const current = lookup(currentId);
  const currentTone = themeToneOf(current);
  const nextTone: 'dark' | 'light' = currentTone === 'dark' ? 'light' : 'dark';
  let target: ThemeId = nextTone === 'light' ? 'fleetdeck-light' : 'fleetdeck';
  try {
    localStorage.setItem(currentTone === 'light' ? LAST_LIGHT_KEY : LAST_DARK_KEY, current.id);
    const remembered = localStorage.getItem(nextTone === 'light' ? LAST_LIGHT_KEY : LAST_DARK_KEY);
    if (remembered && remembered !== current.id) {
      const candidate = lookup(remembered as ThemeId);
      // getTheme 对未知 id 回退 classic ——用 id 回读校验，避免把回退值当记忆命中
      if (candidate.id === remembered && themeToneOf(candidate) === nextTone) {
        target = remembered as ThemeId;
      }
    }
  } catch {
    // localStorage 不可用：直接走默认对
  }
  apply(lookup(target));
  return target;
}

/**
 * 一次性迁移：存档 === 'classic' 且无迁移标记 → 改写为 'fleetdeck'。
 * 无论是否改写都落标记：用户之后手选回 classic 的偏好不再被覆盖。
 * 必须在 themes.ts 的 initializeTheme()（main.tsx）之前调用——先改档、后应用，零闪烁。
 */
export function migrateThemeOnce(): void {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    if (localStorage.getItem(SAVED_KEY) === 'classic') {
      localStorage.setItem(SAVED_KEY, 'fleetdeck');
    }
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    // localStorage 不可用：不迁移，DEFAULT_THEME 兜底
  }
}
