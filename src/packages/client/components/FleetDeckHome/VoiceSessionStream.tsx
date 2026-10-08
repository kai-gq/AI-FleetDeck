import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import {
  parseVoiceEntries,
  pickVoiceBubble,
  toVoiceEntryRow,
  type VoiceStreamEntry,
} from './voiceStreamModel';

interface VoiceSessionStreamProps {
  /** 语音未开启时引导卡的「去设置」回调（App 注入工具箱打开）。 */
  onOpenVoiceSettings?: () => void;
}

/**
 * 总览右栏 · 语音会话流（只读 DOM 镜像，见 voiceStreamModel.ts 的约束说明）。
 * MutationObserver 盯 document.body（气泡无统一根类，且双实例挂载）；
 * 语音未开启（VoiceCompanion 返回 null）→ 引导卡，不整栏消失。
 */
export function VoiceSessionStream({ onOpenVoiceSettings }: VoiceSessionStreamProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const [voicePresent, setVoicePresent] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<VoiceStreamEntry[]>([]);
  const lastSerializedRef = useRef('');
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scan = () => {
      setVoicePresent(document.querySelector('.voice-companion-btn') !== null);
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
        {/* 语音球（B-25）：呼吸=语音开启中；未开启落 is-off 静态灰（引导卡同时在场） */}
        <span className={`voice-stream__orb${voicePresent === false ? ' is-off' : ''}`} aria-hidden="true" />
        <h2>
          <Icon name="microphone" size={14} />
          {t('terminal:fleetHome.voice.title', { defaultValue: '语音会话流' })}
        </h2>
        <span className="fleetdeck-col__count">
          {t('terminal:fleetHome.voice.streaming', { defaultValue: '流式' })}
        </span>
      </header>

      {voicePresent === false ? (
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
          {voicePresent && entries.length === 0 && (
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
