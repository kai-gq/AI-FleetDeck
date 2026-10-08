import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import {
  parseVoiceEntries,
  pickVoiceBubble,
  toVoiceEntryRow,
  type VoiceStreamEntry,
} from './voiceStreamModel';
import { useVoiceCompanionPhase } from './useVoiceCompanionPhase';
import { VoiceSessionControl } from './VoiceSessionControl';
import { voiceStateKey } from './DeckStatusBar';

interface VoiceSessionStreamProps {
  /** 语音未开启时引导卡的「去设置」回调（App 注入工具箱打开）。 */
  onOpenVoiceSettings?: () => void;
}

/** 相位 → 舞台副行（B-29，原型 .voice-state 副行口径；比短标签多一档细分）。 */
function voiceStageSubKey(phase: string): { key: string; fallback: string } {
  switch (phase) {
    case 'off':
      return { key: 'stage.off', fallback: '点击开启后随说随现' };
    case 'starting':
      return { key: 'stage.starting', fallback: '正在启动麦克风…' };
    case 'listening':
      return { key: 'stage.listening', fallback: '持续聆听 · 你说就行' };
    case 'hearing':
      return { key: 'stage.hearing', fallback: '听到了，请继续说…' };
    case 'transcribing':
      return { key: 'stage.transcribing', fallback: '正在转写…' };
    case 'thinking':
      return { key: 'stage.thinking', fallback: '正在整理方案' };
    case 'speaking':
      return { key: 'stage.speaking', fallback: '正在向你汇报结果' };
    case 'paused':
      return { key: 'stage.paused', fallback: '页面在后台，已暂停聆听' };
    case 'error':
      return { key: 'stage.error', fallback: '麦克风出错，点击重试' };
    default:
      return { key: 'stage.active', fallback: '语音伙伴进行中' };
  }
}

/**
 * 总览右栏 · 语音会话流（只读 DOM 镜像，见 voiceStreamModel.ts 的约束说明）。
 * MutationObserver 盯 document.body（气泡无统一根类，且双实例挂载）；
 * 在场/相位走 useVoiceCompanionPhase（B-26）——未开启（VoiceCompanion 返回 null）→
 * 引导卡，不整栏消失；启停控件走 DOM 代理（VoiceSessionControl）。
 * B-29 对齐原型：舞台条（38px 语音球 + 涟漪 + 状态两行 + 控件右槽）、气泡去标签、
 * 流式半句=虚线气泡 + 尾部闪烁光标；原型「办结回执」卡无诚实数据源 → 不做（台账）。
 */
export function VoiceSessionStream({ onOpenVoiceSettings }: VoiceSessionStreamProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const voice = useVoiceCompanionPhase();
  const [entries, setEntries] = useState<VoiceStreamEntry[]>([]);
  const lastSerializedRef = useRef('');
  const listRef = useRef<HTMLDivElement | null>(null);
  // 语音球：仅「在场且相位非 off」点亮（B-26 起相位真实；此前只看在场）
  const voiceOn = voice.present === true && voice.phase !== 'off';

  useEffect(() => {
    const scan = () => {
      const candidates = Array.from(document.querySelectorAll('.voice-companion-bubble')).map((bubble) => ({
        inFabRail: bubble.closest('.fab-rail') !== null,
        rows: Array.from(bubble.querySelectorAll('.vc-entry')).map(toVoiceEntryRow),
      }));
      const chosen = pickVoiceBubble(candidates);
      const next = chosen ? parseVoiceEntries(chosen.rows) : [];
      const serialized = JSON.stringify(next);
      if (serialized !== lastSerializedRef.current) {
        lastSerializedRef.current = serialized;
        setEntries(next);
      }
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  // 流式自动滚底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // 舞台文字：短标签复用状态栏映射（单一来源）；非 leader 实例 =「另一处正在聆听」（点击控件可接管）
  const statusKey = voiceStateKey(voice.phase);
  const stageSub = voiceStageSubKey(voice.phase);
  const stageLabel = !voice.isLeader
    ? t('terminal:fleetHome.voice.stage.otherTab', { defaultValue: '另一标签页聆听中' })
    : t(`terminal:fleetHome.statusBar.${statusKey.key}`, { defaultValue: statusKey.fallback });
  const stageSubText = !voice.isLeader
    ? t('terminal:fleetHome.voice.stage.otherTabSub', { defaultValue: '点击接管' })
    : t(`terminal:fleetHome.voice.${stageSub.key}`, { defaultValue: stageSub.fallback });

  return (
    <aside className="fleetdeck-col fleetdeck-col--voice">
      <header className="fleetdeck-col__head">
        <h2>
          <Icon name="microphone" size={14} />
          {t('terminal:fleetHome.voice.title', { defaultValue: '语音会话流' })}
        </h2>
        <span className="fleetdeck-col__count">
          {t('terminal:fleetHome.voice.streaming', { defaultValue: '流式' })}
        </span>
      </header>

      {voice.present === true && (
        <div className="voice-stream__stage">
          <span className={`voice-stream__orb${voiceOn ? '' : ' is-off'}`} aria-hidden="true" />
          <div className="voice-stream__state">
            <b>{stageLabel}</b>
            <span>{stageSubText}</span>
          </div>
          {/* 启停控件（B-26 起；B-29 移入舞台右槽对齐原型 .voice-demo 位）：DOM 代理点击 */}
          <VoiceSessionControl state={voice} />
        </div>
      )}

      {voice.present === false ? (
        <div className="voice-stream__guide">
          <Icon name="microphone" size={22} />
          <strong>{t('terminal:fleetHome.voice.offTitle', { defaultValue: '语音未开启' })}</strong>
          <p>
            {t('terminal:fleetHome.voice.offBody', {
              defaultValue: '开启语音伙伴后，这里的对话会随说随现。',
            })}
          </p>
          {onOpenVoiceSettings && (
            <button type="button" onClick={onOpenVoiceSettings}>
              {t('terminal:fleetHome.voice.openSettings', { defaultValue: '去开启' })}
            </button>
          )}
        </div>
      ) : (
        <div className="fleetdeck-col__body voice-stream" ref={listRef}>
          {entries.map((entry) => (
            <div key={entry.id} className={`voice-stream__entry voice-stream__entry--${entry.role}`}>
              <span className="voice-stream__text">
                {entry.text}
                {entry.role === 'live' && <span className="voice-stream__caret" aria-hidden="true" />}
              </span>
            </div>
          ))}
          {voice.present === true && entries.length === 0 && (
            <div className="fleetdeck-col__empty">
              {t('terminal:fleetHome.voice.empty', { defaultValue: '等待对话…' })}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export default VoiceSessionStream;
