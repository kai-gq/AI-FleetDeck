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

interface VoiceSessionStreamProps {
  /** 语音未开启时引导卡的「去设置」回调（App 注入工具箱打开）。 */
  onOpenVoiceSettings?: () => void;
}

/**
 * 总览右栏 · 语音会话流（只读 DOM 镜像，见 voiceStreamModel.ts 的约束说明）。
 * MutationObserver 盯 document.body（气泡无统一根类，且双实例挂载）；
 * 在场/相位走 useVoiceCompanionPhase（B-26）——未开启（VoiceCompanion 返回 null）→
 * 引导卡，不整栏消失；列头启停控件走 DOM 代理（VoiceSessionControl）。
 */
export function VoiceSessionStream({ onOpenVoiceSettings }: VoiceSessionStreamProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const voice = useVoiceCompanionPhase();
  const [entries, setEntries] = useState<VoiceStreamEntry[]>([]);
  const lastSerializedRef = useRef('');
  const listRef = useRef<HTMLDivElement | null>(null);
  // 语音球：仅「在场且相位非 off」呼吸（B-26 起相位真实；此前只看在场）
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

  return (
    <aside className="fleetdeck-col fleetdeck-col--voice">
      <header className="fleetdeck-col__head">
        {/* 语音球（B-25；B-26 起相位真实）：呼吸=语音开启中；未开启落 is-off 静态灰 */}
        <span className={`voice-stream__orb${voiceOn ? '' : ' is-off'}`} aria-hidden="true" />
        <h2>
          <Icon name="microphone" size={14} />
          {t('terminal:fleetHome.voice.title', { defaultValue: '语音会话流' })}
        </h2>
        <span className="fleetdeck-col__count">
          {t('terminal:fleetHome.voice.streaming', { defaultValue: '流式' })}
        </span>
        {/* 启停控件（B-26）：DOM 代理点击，未配置时「未启用」占位 */}
        <VoiceSessionControl state={voice} />
      </header>

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
              {entry.tag && <span className="voice-stream__tag">{entry.tag}</span>}
              <span className="voice-stream__text">{entry.text}</span>
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
