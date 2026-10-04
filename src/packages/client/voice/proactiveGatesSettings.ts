/**
 * 播报分级(任务 09·B)客户端设置:focus 时段 / 每日预算 / 口播子配额。
 *
 * 不写进 tools/voice-companion/config.json:该文件服务端大脑与流式通道同读,
 * 而 09·B 约定纯客户端改动(零服务端);分级参数只影响客户端播报出口决策。
 * 沿用客户端 localStorage 偏好模式(参考 utils/buildingViewMode.ts):
 * 读时夹取坏值、localStorage 不可用(隐私模式 / Node 测试)时回默认。
 *
 * 默认值来自 shared/broadcast-gates(06-11 §4 建议值非实测);
 * 判定侧每轮经 toGatesConfig 现读,所以改设置即时生效(无需重启上报器)。
 */

import {
  DAILY_BUDGET_MAX,
  DEFAULT_GATES_CONFIG,
  type GatesConfig,
  type TimeWindow,
} from '../../shared/broadcast-gates';

export interface BroadcastGatesSettings {
  /** focus time 窗口(默认 09:00–11:00):窗口内不主动口播,评分 >90 破例;空数组 = 关闭拦截。 */
  focusWindows: TimeWindow[];
  /** 每日主动播报预算(条,起点 10,可配 0–50;0 = 只上屏不口播)。 */
  baseDailyBudget: number;
  /** 口播子配额(条/天,3–5):只限即时口播(SPEAK),攒批/上屏不占。 */
  speechSubQuota: number;
}

export const BROADCAST_GATES_STORAGE_KEY = 'tide:voice-companion:broadcast-gates';

/** focus 窗口数上限(初始值非实测:正常用户不会配这么多段)。 */
const MAX_FOCUS_WINDOWS = 6;
/** 一天最后一分钟(0–1439)。 */
const MINUTE_MAX = 24 * 60 - 1;

export const DEFAULT_BROADCAST_GATES_SETTINGS: BroadcastGatesSettings = {
  focusWindows: DEFAULT_GATES_CONFIG.focusWindows.map((w) => ({ ...w })),
  baseDailyBudget: DEFAULT_GATES_CONFIG.baseDailyBudget,
  speechSubQuota: DEFAULT_GATES_CONFIG.speechSubQuota,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function sanitizeWindow(raw: unknown): TimeWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const win = raw as Record<string, unknown>;
  const start = Number(win.startMinutes);
  const end = Number(win.endMinutes);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    startMinutes: Math.min(MINUTE_MAX, Math.max(0, Math.round(start))),
    endMinutes: Math.min(MINUTE_MAX, Math.max(0, Math.round(end))),
  };
}

/** 任意来源 → 合法设置(未知字段丢弃,数值夹取,窗口数封顶;坏窗口整条丢弃)。 */
export function sanitizeBroadcastGatesSettings(raw: unknown): BroadcastGatesSettings {
  const fallback = DEFAULT_BROADCAST_GATES_SETTINGS;
  const fallbackWindows = () => fallback.focusWindows.map((w) => ({ ...w }));
  if (!raw || typeof raw !== 'object') {
    return { ...fallback, focusWindows: fallbackWindows() };
  }
  const obj = raw as Record<string, unknown>;
  const windows = Array.isArray(obj.focusWindows)
    ? obj.focusWindows
        .map(sanitizeWindow)
        .filter((w): w is TimeWindow => w !== null)
        .slice(0, MAX_FOCUS_WINDOWS)
    : fallbackWindows();
  return {
    focusWindows: windows,
    baseDailyBudget: clampInt(obj.baseDailyBudget, 0, DAILY_BUDGET_MAX, fallback.baseDailyBudget),
    speechSubQuota: clampInt(obj.speechSubQuota, 3, 5, fallback.speechSubQuota),
  };
}

/** 读取设置;缺失/坏 JSON/不可用 → 默认(focus 09:00–11:00 / 预算 10 / 子配额 5)。 */
export function loadBroadcastGatesSettings(): BroadcastGatesSettings {
  try {
    const raw = localStorage.getItem(BROADCAST_GATES_STORAGE_KEY);
    if (!raw) return sanitizeBroadcastGatesSettings(null);
    return sanitizeBroadcastGatesSettings(JSON.parse(raw));
  } catch {
    // 无 localStorage(隐私模式/Node)或 JSON 损坏:回默认
    return sanitizeBroadcastGatesSettings(null);
  }
}

/** 写入设置(先夹取;写失败静默 = 偏好不落盘,判定侧仍拿默认)。 */
export function saveBroadcastGatesSettings(next: BroadcastGatesSettings): void {
  try {
    localStorage.setItem(BROADCAST_GATES_STORAGE_KEY, JSON.stringify(sanitizeBroadcastGatesSettings(next)));
  } catch {
    /* 隐私模式 / 配额:忽略 */
  }
}

/** 设置 + 默认阈值 → 完整 GatesConfig(四闸门判定入参)。 */
export function toGatesConfig(settings: BroadcastGatesSettings = loadBroadcastGatesSettings()): GatesConfig {
  return {
    ...DEFAULT_GATES_CONFIG,
    focusWindows: settings.focusWindows.map((w) => ({ ...w })),
    baseDailyBudget: settings.baseDailyBudget,
    speechSubQuota: settings.speechSubQuota,
  };
}
