import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { clickVoiceCompanionButton, type VoiceCompanionState } from './useVoiceCompanionPhase';

/**
 * 语音栏列头 · 启停控件（B-26）。
 * 不改冻结的 VoiceCompanion：合成点击 .voice-companion-btn（DOM 代理，见 useVoiceCompanionPhase.ts），
 * 语义复用其 handleButtonClick（开启 / 关闭 / 播报中点击=打断）。
 * 语音未配置（按钮不存在）→「未启用」静态占位；B-29 起舞台条仅在 present===true 挂载，
 * 该分支退为防御性兜底（未开启场景由引导卡接管）。
 */
export function VoiceSessionControl({ state }: { state: VoiceCompanionState }) {
  const { t } = useTranslation(['terminal', 'common']);

  if (state.present === null) return null; // 首帧未扫描

  if (!state.present) {
    return (
      <span className="voice-stream__control is-disabled">
        {t('terminal:fleetHome.voice.disabled', { defaultValue: '未启用' })}
      </span>
    );
  }

  const active = state.phase !== 'off';
  const icon = state.phase === 'speaking' ? 'pause' : active ? 'stop' : 'play';
  const label =
    state.label ?? t('terminal:fleetHome.voice.title', { defaultValue: '语音会话流' });

  return (
    <button
      type="button"
      className={`voice-stream__control${active ? ' is-active' : ''}`}
      onClick={() => clickVoiceCompanionButton()}
      title={label}
      aria-label={label}
    >
      <Icon name={icon} size={11} />
    </button>
  );
}

export default VoiceSessionControl;
