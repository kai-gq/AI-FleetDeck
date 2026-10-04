/**
 * jarvis-core/sentinel · 公共类型 / 阈值 / 开关（任务 33 W10 纯模块）
 *
 * 钉死：开关形态与 jarvis-core 先例同口径（缺省开，'0'/'off'/'false' 关，
 * 入参优先）；阈值缺省 = 06-11 §13.4 初值；非法阈值回落缺省（不抛）；
 * 09 四档 clamp 边界。
 */

import { describe, expect, it } from 'vitest';

import {
  BROADCAST_TIER_RANK,
  DEFAULT_SELF_HEAL_TUNING,
  DEFAULT_SENTINEL_THRESHOLDS,
  SENTINEL_ENV_KEY,
  SENTINEL_PHASES,
  clampBroadcastTier,
  isSentinelEnabled,
  isSentinelPhase,
  resolveSelfHealTuning,
  resolveSentinelConfig,
  resolveSentinelEnabled,
  resolveSentinelThresholds,
} from './index.js';

describe('开关 TC_JARVIS_SENTINEL', () => {
  it('缺省 / 空白 / 1 → 开；0 / off / false（忽略大小写空白）→ 关', () => {
    expect(SENTINEL_ENV_KEY).toBe('TC_JARVIS_SENTINEL');
    expect(isSentinelEnabled({})).toBe(true);
    expect(isSentinelEnabled({ TC_JARVIS_SENTINEL: undefined })).toBe(true);
    expect(isSentinelEnabled({ TC_JARVIS_SENTINEL: '' })).toBe(true);
    expect(isSentinelEnabled({ TC_JARVIS_SENTINEL: '1' })).toBe(true);
    expect(isSentinelEnabled({ TC_JARVIS_SENTINEL: '0' })).toBe(false);
    expect(isSentinelEnabled({ TC_JARVIS_SENTINEL: ' off ' })).toBe(false);
    expect(isSentinelEnabled({ TC_JARVIS_SENTINEL: 'FALSE' })).toBe(false);
  });

  it('配置入参优先于环境变量', () => {
    expect(resolveSentinelEnabled(true, { TC_JARVIS_SENTINEL: '0' })).toBe(true);
    expect(resolveSentinelEnabled(false, {})).toBe(false);
    expect(resolveSentinelEnabled(undefined, { TC_JARVIS_SENTINEL: '0' })).toBe(false);
  });
});

describe('相位表与守卫', () => {
  it('四相位规范顺序；isSentinelPhase 只认字面量', () => {
    expect(SENTINEL_PHASES).toEqual(['normal', 'warning', 'degraded', 'recovering']);
    expect(isSentinelPhase('degraded')).toBe(true);
    expect(isSentinelPhase('NORMAL')).toBe(false);
    expect(isSentinelPhase(null)).toBe(false);
    expect(isSentinelPhase(1)).toBe(false);
  });
});

describe('阈值缺省与合并', () => {
  it('缺省 = 06-11 §13.4 初值（非实测）＋ 保守恢复/驻留', () => {
    expect(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateDegrade).toBe(0.4);
    expect(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateWarning).toBe(0.3);
    expect(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateRecover).toBe(0.3);
    expect(DEFAULT_SENTINEL_THRESHOLDS.adoptRateHealthy).toBe(0.3);
    expect(DEFAULT_SENTINEL_THRESHOLDS.complaintsAllowed).toBe(0);
    expect(DEFAULT_SENTINEL_THRESHOLDS.recoverHealthyDays).toBe(3);
    expect(DEFAULT_SENTINEL_THRESHOLDS.minPhaseDwellDays).toBe(2);
    // 滞回带合法：恢复线不高于警告线，警告线不高于降级线
    expect(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateRecover).toBeLessThanOrEqual(
      DEFAULT_SENTINEL_THRESHOLDS.ignoreRateWarning,
    );
    expect(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateWarning).toBeLessThan(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateDegrade);
  });

  it('覆盖项生效；非法值回落缺省（NaN / Infinity / 负数 / 非数）', () => {
    const merged = resolveSentinelThresholds({
      ignoreRateDegrade: 0.2,
      recoverHealthyDays: 2,
      minPhaseDwellDays: 0,
      speechFactorWhenWarning: 0.25,
    });
    expect(merged.ignoreRateDegrade).toBe(0.2);
    expect(merged.recoverHealthyDays).toBe(2);
    expect(merged.minPhaseDwellDays).toBe(0);

    const bad = resolveSentinelThresholds({
      ignoreRateDegrade: Number.NaN,
      ignoreRateWarning: Number.POSITIVE_INFINITY,
      complaintsAllowed: -1,
      recoverHealthyDays: 0,
      minPhaseDwellDays: -3,
      speechFactorWhenRecovering: 'x' as unknown as number,
    });
    expect(bad.ignoreRateDegrade).toBe(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateDegrade);
    expect(bad.ignoreRateWarning).toBe(DEFAULT_SENTINEL_THRESHOLDS.ignoreRateWarning);
    expect(bad.complaintsAllowed).toBe(DEFAULT_SENTINEL_THRESHOLDS.complaintsAllowed);
    expect(bad.recoverHealthyDays).toBe(1); // 天数下限 1（0 非法）
    expect(bad.minPhaseDwellDays).toBe(DEFAULT_SENTINEL_THRESHOLDS.minPhaseDwellDays);
    expect(bad.speechFactorWhenRecovering).toBe(DEFAULT_SENTINEL_THRESHOLDS.speechFactorWhenRecovering);
  });

  it('自愈调参缺省：问三遍 N=3 / 反复误判 M=2 / 相似 0.7 / 窗口 30min / 样本 3', () => {
    expect(DEFAULT_SELF_HEAL_TUNING.repeatThreshold).toBe(3);
    expect(DEFAULT_SELF_HEAL_TUNING.misjudgeRepeatThreshold).toBe(2);
    expect(DEFAULT_SELF_HEAL_TUNING.similarityThreshold).toBe(0.7);
    expect(DEFAULT_SELF_HEAL_TUNING.windowMs).toBe(30 * 60 * 1000);
    expect(DEFAULT_SELF_HEAL_TUNING.maxSamples).toBe(3);

    const clamped = resolveSelfHealTuning({ similarityThreshold: 2, repeatThreshold: 1, maxSamples: 0 });
    expect(clamped.similarityThreshold).toBe(1);
    expect(clamped.repeatThreshold).toBe(2);
    expect(clamped.maxSamples).toBe(1);
  });

  it('resolveSentinelConfig：开关 ∞ 环境 + 两类阈值合并', () => {
    const cfg = resolveSentinelConfig({
      env: { TC_JARVIS_SENTINEL: '0' },
      thresholds: { ignoreRateDegrade: 0.5 },
      selfHeal: { windowMs: 1000 },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.thresholds.ignoreRateDegrade).toBe(0.5);
    expect(cfg.thresholds.recoverHealthyDays).toBe(DEFAULT_SENTINEL_THRESHOLDS.recoverHealthyDays);
    expect(cfg.selfHeal.windowMs).toBe(1000);
    expect(resolveSentinelConfig().enabled).toBe(true);
  });
});

describe('09 四档 clamp（不自造新档）', () => {
  it('排序 SPEAK < PREPARE < STORE < SILENT；clamp 取更保守者', () => {
    expect(BROADCAST_TIER_RANK).toEqual({ SPEAK: 0, PREPARE: 1, STORE: 2, SILENT: 3 });
    expect(clampBroadcastTier('SPEAK', 'STORE')).toBe('STORE');
    expect(clampBroadcastTier('PREPARE', 'STORE')).toBe('STORE');
    expect(clampBroadcastTier('STORE', 'STORE')).toBe('STORE');
    expect(clampBroadcastTier('SILENT', 'STORE')).toBe('SILENT');
    expect(clampBroadcastTier('STORE', 'SPEAK')).toBe('STORE');
    expect(clampBroadcastTier('PREPARE', 'SPEAK')).toBe('PREPARE');
  });
});
