import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_GATES_CONFIG } from '../../shared/broadcast-gates';
import {
  BROADCAST_GATES_STORAGE_KEY,
  DEFAULT_BROADCAST_GATES_SETTINGS,
  loadBroadcastGatesSettings,
  sanitizeBroadcastGatesSettings,
  saveBroadcastGatesSettings,
  toGatesConfig,
} from './proactiveGatesSettings';

// Node 测试环境没有 localStorage:装一个 Map 桩;卸载后再验证「不可用回默认」
function installLocalStorageStub(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  } as unknown as Storage;
}

describe('proactiveGatesSettings', () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('默认值 = 06-11 §4:focus 09:00–11:00 / 预算 10 / 口播子配额 5', () => {
    const settings = loadBroadcastGatesSettings();
    expect(settings.focusWindows).toEqual([{ startMinutes: 9 * 60, endMinutes: 11 * 60 }]);
    expect(settings.baseDailyBudget).toBe(10);
    expect(settings.speechSubQuota).toBe(5);
    // 与 shared 常量同源(建议值非实测,改一处即两处同步)
    expect(settings.baseDailyBudget).toBe(DEFAULT_GATES_CONFIG.baseDailyBudget);
    expect(settings.speechSubQuota).toBe(DEFAULT_GATES_CONFIG.speechSubQuota);
  });

  it('save → load 往返一致(经夹取)', () => {
    saveBroadcastGatesSettings({
      focusWindows: [{ startMinutes: 13 * 60 + 30, endMinutes: 14 * 60 }],
      baseDailyBudget: 20,
      speechSubQuota: 3,
    });
    expect(loadBroadcastGatesSettings()).toEqual({
      focusWindows: [{ startMinutes: 810, endMinutes: 840 }],
      baseDailyBudget: 20,
      speechSubQuota: 3,
    });
  });

  it('坏值夹取:预算 0–50、子配额 3–5、窗口分钟 0–1439、窗口数封顶', () => {
    const clamped = sanitizeBroadcastGatesSettings({
      focusWindows: [
        { startMinutes: -30, endMinutes: 99999 },
        { startMinutes: 'x', endMinutes: 60 }, // 整条丢弃
        ...Array.from({ length: 8 }, (_, i) => ({ startMinutes: i * 100, endMinutes: i * 100 + 50 })),
      ],
      baseDailyBudget: 999,
      speechSubQuota: 1,
    });
    expect(clamped.baseDailyBudget).toBe(50);
    expect(clamped.speechSubQuota).toBe(3);
    expect(clamped.focusWindows).toHaveLength(6);
    expect(clamped.focusWindows[0]).toEqual({ startMinutes: 0, endMinutes: 1439 });

    const low = sanitizeBroadcastGatesSettings({ baseDailyBudget: -5, speechSubQuota: 9 });
    expect(low.baseDailyBudget).toBe(0);
    expect(low.speechSubQuota).toBe(5);
  });

  it('空 focus 窗口 = 关闭 focus 拦截(显式配置生效)', () => {
    saveBroadcastGatesSettings({ ...DEFAULT_BROADCAST_GATES_SETTINGS, focusWindows: [] });
    expect(loadBroadcastGatesSettings().focusWindows).toEqual([]);
  });

  it('损坏 JSON / 字段缺失回默认,不抛出', () => {
    localStorage.setItem(BROADCAST_GATES_STORAGE_KEY, '{ 不是 JSON');
    expect(loadBroadcastGatesSettings()).toEqual(DEFAULT_BROADCAST_GATES_SETTINGS);

    localStorage.setItem(BROADCAST_GATES_STORAGE_KEY, '{}');
    expect(loadBroadcastGatesSettings()).toEqual(DEFAULT_BROADCAST_GATES_SETTINGS);
  });

  it('localStorage 不可用时回默认且保存不抛出', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadBroadcastGatesSettings()).toEqual(DEFAULT_BROADCAST_GATES_SETTINGS);
    expect(() => saveBroadcastGatesSettings(DEFAULT_BROADCAST_GATES_SETTINGS)).not.toThrow();
  });

  it('toGatesConfig 合并默认阈值,只覆盖三项客户端设置', () => {
    const config = toGatesConfig({
      focusWindows: [{ startMinutes: 600, endMinutes: 660 }],
      baseDailyBudget: 12,
      speechSubQuota: 4,
    });
    expect(config.relevanceThreshold).toBe(DEFAULT_GATES_CONFIG.relevanceThreshold);
    expect(config.disruptionThreshold).toBe(DEFAULT_GATES_CONFIG.disruptionThreshold);
    expect(config.deepNight).toEqual(DEFAULT_GATES_CONFIG.deepNight);
    expect(config.baseDailyBudget).toBe(12);
    expect(config.speechSubQuota).toBe(4);
    expect(config.focusWindows).toEqual([{ startMinutes: 600, endMinutes: 660 }]);
    // 拷贝隔离:改结果不污染常量
    config.focusWindows[0].startMinutes = 1;
    expect(DEFAULT_GATES_CONFIG.focusWindows[0].startMinutes).toBe(9 * 60);
  });
});
