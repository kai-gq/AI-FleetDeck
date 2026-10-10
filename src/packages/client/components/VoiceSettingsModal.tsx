/**
 * 语音设置弹窗(2026-10-10):顶栏话筒按钮入口,从工具箱「设置」面板整体迁出。
 *
 * 三个标签:
 *   语音转文字  识别引擎三档(自动/仅本地/仅云端,services/stt-volcengine.ts)+ 火山凭据状态
 *   文字转语音  edge-tts 音色 / 试听 / 语速 / 音量(voices.local.json)
 *   语音伙伴    完整设置面板(常开聆听/热词/大脑)+ 声纹门禁
 * 原设置面板的「去语音伙伴/转写设置/音色设置」关系条互跳改为切标签。
 *
 * 外壳复刻 AsrHotwordsModal(shortcuts-modal + 标签条)。入口:顶栏话筒按钮 /
 * 移动端 FAB 菜单 / 设置面板「已迁出」跳转条(window 事件见 utils/voiceSettingsEvents)。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModalClose } from '../hooks';
import { Icon } from './Icon';
import { ModalPortal } from './shared/ModalPortal';
import { ConfigRelationNote } from './toolbox/ConfigRelationNote';
import { VoiceCompanionSection } from './toolbox/VoiceCompanionSection';
import { VoiceprintSettings } from './toolbox/VoiceprintSettings';
import { loadWhisperCloudConfig, saveWhisperCloudConfig, loadVolcengineCredStatus, DEFAULT_WHISPER_CLOUD_CONFIG } from '../api/whisperCloud';
import type { WhisperCloudConfig, SttEngineMode } from '../api/whisperCloud';
import { loadTtsVoices, saveTtsVoices, sanitizeTuning, DEFAULT_TTS_VOICES, TTS_VOICE_OPTIONS, TTS_AUDITION_SAMPLES, TTS_LANG_LABELS } from '../api/ttsVoice';
import type { TtsVoiceConfig, TtsLang } from '../api/ttsVoice';
import { apiUrl, authFetch } from '../utils/storage';

type VoiceTab = 'stt' | 'tts' | 'companion';

interface VoiceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function VoiceSettingsModal({ isOpen, onClose }: VoiceSettingsModalProps) {
  const { t } = useTranslation(['config', 'common']);

  const [tab, setTab] = useState<VoiceTab>('stt');

  // ---- 语音转文字(原 ConfigSection「语音」合并块上半) ----
  const [sttConfig, setSttConfig] = useState<WhisperCloudConfig>(DEFAULT_WHISPER_CLOUD_CONFIG);
  const [sttDirty, setSttDirty] = useState(false);
  const [sttLoaded, setSttLoaded] = useState(false);
  const [sttSaving, setSttSaving] = useState(false);
  const [sttSaved, setSttSaved] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  // 火山凭据状态(跟随「语音伙伴」config.json):null=检测中
  const [volcCreds, setVolcCreds] = useState<boolean | null>(null);

  // ---- 文字转语音 ----
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceConfig>(DEFAULT_TTS_VOICES);
  const [ttsVoicesExist, setTtsVoicesExist] = useState(false);
  const [ttsDirty, setTtsDirty] = useState(false);
  // 语速/音量输入框的原始文本(允许编辑中的 "-"/"+" 等中间态,保存时归一化)
  const [ttsRateInput, setTtsRateInput] = useState('0');
  const [ttsVolumeInput, setTtsVolumeInput] = useState('0');
  const [ttsLoaded, setTtsLoaded] = useState(false);
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsSaved, setTtsSaved] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsAuditioning, setTtsAuditioning] = useState<TtsLang | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  const { handleMouseDown: handleBackdropMouseDown, handleClick: handleBackdropClick } = useModalClose(onClose);

  // Escape 关闭(捕获阶段,与 AsrHotwordsModal/ControlsModal 同款)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  // 打开时读取云通道配置 + 火山凭据状态(凭据在「语音伙伴」里配置,这里只显示有无)
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setSttError(null);
    loadWhisperCloudConfig()
      .then(({ config }) => {
        if (!alive) return;
        setSttConfig(config);
        setSttDirty(false);
      })
      .catch((err) => {
        if (alive) setSttError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setSttLoaded(true);
      });
    loadVolcengineCredStatus()
      .then((v) => {
        if (alive) setVolcCreds(v);
      })
      .catch(() => {
        if (alive) setVolcCreds(false);
      });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  // 打开时读取播报音色(voices.local.json 用户覆盖优先)
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setTtsError(null);
    loadTtsVoices()
      .then(({ config, exists }) => {
        if (!alive) return;
        setTtsVoices(config);
        setTtsRateInput(String(config.rate));
        setTtsVolumeInput(String(config.volume));
        setTtsVoicesExist(exists);
        setTtsDirty(false);
      })
      .catch((err) => {
        if (alive) setTtsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setTtsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  // 关闭即停掉试听(设置面板生命周期内不存在这条路径,弹窗需要)
  useEffect(() => {
    if (isOpen) return;
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    setTtsAuditioning(null);
  }, [isOpen]);

  const handleSttModeChange = (mode: SttEngineMode) => {
    setSttConfig((c) => ({ ...c, mode }));
    setSttDirty(true);
    setSttError(null);
  };

  const handleSttSave = () => {
    setSttSaving(true);
    setSttError(null);
    saveWhisperCloudConfig(sttConfig)
      .then(() => {
        setSttDirty(false);
        setSttSaved(true);
        window.setTimeout(() => setSttSaved(false), 3000);
      })
      .catch((err) => setSttError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSttSaving(false));
  };

  const handleTtsVoiceChange = (lang: TtsLang, value: string) => {
    setTtsVoices((c) => ({ ...c, [lang]: value }));
    setTtsDirty(true);
    setTtsError(null);
  };

  // 语速/音量(-100..100 百分数,0 = 默认):与音色同一份配置一起保存/试听。
  // 输入框保留原始文本(便于输入负号),配置里存解析后的数值(非法/空 → 0)。
  const handleTtsTuningChange = (field: 'rate' | 'volume', raw: string) => {
    if (field === 'rate') setTtsRateInput(raw); else setTtsVolumeInput(raw);
    setTtsVoices((c) => ({ ...c, [field]: sanitizeTuning(raw, 0) }));
    setTtsDirty(true);
    setTtsError(null);
  };

  // 返回是否保存成功(试听前先保存,失败则中止)
  const handleTtsSave = async (): Promise<boolean> => {
    setTtsSaving(true);
    setTtsError(null);
    try {
      await saveTtsVoices(ttsVoices);
      // 保存后把输入框归一化为实际落盘值(非法中间态如 "-" 会显示为 0)
      setTtsRateInput(String(ttsVoices.rate));
      setTtsVolumeInput(String(ttsVoices.volume));
      setTtsDirty(false);
      setTtsVoicesExist(true);
      setTtsSaved(true);
      window.setTimeout(() => setTtsSaved(false), 3000);
      return true;
    } catch (err) {
      setTtsError(`${t('config:tts.saveFailed', { defaultValue: '保存失败' })}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      setTtsSaving(false);
    }
  };

  const handleTtsAudition = async (lang: TtsLang) => {
    if (ttsDirty && !(await handleTtsSave())) return;
    // 停掉上一段试听
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    setTtsAuditioning(lang);
    setTtsError(null);
    try {
      const res = await authFetch(apiUrl('/api/tts/speak'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: TTS_AUDITION_SAMPLES[lang], lang, rate: ttsVoices.rate, volume: ttsVoices.volume }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      const finish = () => {
        if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
        URL.revokeObjectURL(url);
        setTtsAuditioning((cur) => (cur === lang ? null : cur));
      };
      audio.onended = finish;
      audio.onerror = finish;
      await audio.play();
    } catch (err) {
      ttsAudioRef.current = null;
      setTtsAuditioning(null);
      setTtsError(`${t('config:tts.auditionFailed', { defaultValue: '试听失败' })}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const selectTab = useCallback((next: VoiceTab) => {
    setTab(next);
    // 切回识别标签时刷新凭据状态(可能刚在「语音伙伴」里填过)
    if (next === 'stt') {
      loadVolcengineCredStatus()
        .then(setVolcCreds)
        .catch(() => setVolcCreds(false));
    }
  }, []);

  if (!isOpen) return null;

  return (
    <ModalPortal>
    <div className="shortcuts-modal-overlay" onMouseDown={handleBackdropMouseDown} onClick={handleBackdropClick}>
      <div className="shortcuts-modal controls-modal voice-settings-modal">
        {/* Header */}
        <div className="shortcuts-modal-header">
          <div className="shortcuts-modal-title">
            <Icon name="microphone" size={20} />
            <span>{t('config:voiceSettings.title', { defaultValue: '语音设置' })}</span>
          </div>
          <button className="shortcuts-modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Tabs:语音转文字(默认)/ 文字转语音 / 语音伙伴 */}
        <div className="voice-settings-tabs">
          <button
            type="button"
            className={`voice-settings-tab${tab === 'stt' ? ' is-active' : ''}`}
            onClick={() => selectTab('stt')}
          >
            {t('config:general.stt', { defaultValue: '语音转文字' })}
          </button>
          <button
            type="button"
            className={`voice-settings-tab${tab === 'tts' ? ' is-active' : ''}`}
            onClick={() => selectTab('tts')}
          >
            {t('config:general.tts', { defaultValue: '文字转语音' })}
          </button>
          <button
            type="button"
            className={`voice-settings-tab${tab === 'companion' ? ' is-active' : ''}`}
            onClick={() => selectTab('companion')}
          >
            {t('config:voiceCompanion.sectionTitle', { defaultValue: '语音伙伴' })}
          </button>
        </div>

        <div className="shortcuts-modal-content">
          {tab === 'stt' && (
            <>
              <ConfigRelationNote
                items={[{
                  text: t('config:voiceRelations.stt', { defaultValue: '本页引擎设置同时被:终端语音输入、语音伙伴(批量回退)、WhatsApp 转写 使用;云端凭据在「语音伙伴」里配置。' }),
                  links: [{ label: t('config:voiceRelations.goCompanion', { defaultValue: '去语音伙伴' }), target: 'companion' }],
                }]}
                onJump={(target) => selectTab(target as VoiceTab)}
              />
              <div className="config-row">
                <span className="config-label">{t('config:stt.engineMode', { defaultValue: '引擎模式' })}</span>
                <select className="config-select" value={sttConfig.mode} onChange={(e) => handleSttModeChange(e.target.value as SttEngineMode)}>
                  <option value="auto">{t('config:stt.modeAuto', { defaultValue: '自动(云优先,失败回退本地)' })}</option>
                  <option value="local">{t('config:stt.modeLocal', { defaultValue: '仅本地(离线)' })}</option>
                  <option value="cloud">{t('config:stt.modeCloud', { defaultValue: '仅云端(失败不回退)' })}</option>
                </select>
              </div>
              <div className="config-row config-row-stacked">
                <span className="config-hint">{t('config:stt.cloudHint', { defaultValue: '云端识别 = 火山引擎(字节);凭据复用「语音伙伴」的火山配置,云端模式会把语音上传服务商。' })}</span>
                {sttLoaded && volcCreds !== null && (
                  <span className="config-hint">{volcCreds ? t('config:stt.statusVolcConfigured', { defaultValue: '火山凭据已配置' }) : sttConfig.mode === 'cloud' ? t('config:stt.cloudNeedsCred', { defaultValue: '⚠ 仅云端模式未配置火山凭据,语音识别将不可用(去「语音伙伴」填)' }) : t('config:stt.statusNoCred', { defaultValue: '未配置火山凭据(「自动」= 纯本地识别)' })}</span>
                )}
                {sttError && (
                  <span className="config-hint">{t('config:stt.saveFailed', { defaultValue: '保存失败' })}: {sttError}</span>
                )}
                {(sttDirty || sttSaved) && (
                  <button className="config-btn config-btn-sm" onClick={handleSttSave} disabled={sttSaving}>{sttSaved ? t('config:stt.saved', { defaultValue: '已保存' }) : t('common:buttons.apply')}</button>
                )}
              </div>
            </>
          )}

          {tab === 'tts' && (
            <>
              <ConfigRelationNote
                items={[{
                  text: t('config:voiceRelations.tts', { defaultValue: '本页音色同时被:语音伙伴播报、终端逐行朗读 使用。' }),
                  links: [{ label: t('config:voiceRelations.goCompanion', { defaultValue: '去语音伙伴' }), target: 'companion' }],
                }]}
                onJump={(target) => selectTab(target as VoiceTab)}
              />
              {(['zh', 'en', 'es'] as const).map((lang) => (
                <div className="config-row" key={lang}>
                  <span className="config-label">{TTS_LANG_LABELS[lang]}</span>
                  <select className="config-select" value={ttsVoices[lang]} onChange={(e) => handleTtsVoiceChange(lang, e.target.value)}>
                    {TTS_VOICE_OPTIONS[lang].map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <button className="config-btn config-btn-sm" onClick={() => handleTtsAudition(lang)} disabled={ttsAuditioning !== null || ttsSaving}>
                    {ttsAuditioning === lang ? t('config:tts.auditioning', { defaultValue: '播放中…' }) : t('config:tts.audition', { defaultValue: '试听' })}
                  </button>
                </div>
              ))}
              <div className="config-row">
                <span className="config-label">{t('config:tts.rate', { defaultValue: '语速(%)' })}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="config-input config-input-sm"
                  value={ttsRateInput}
                  placeholder="0"
                  onChange={(e) => handleTtsTuningChange('rate', e.target.value)}
                />
                <span className="config-hint">{t('config:tts.rateHint', { defaultValue: '负值更慢,正值更快;0 = 原速' })}</span>
              </div>
              <div className="config-row">
                <span className="config-label">{t('config:tts.volume', { defaultValue: '音量(%)' })}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="config-input config-input-sm"
                  value={ttsVolumeInput}
                  placeholder="0"
                  onChange={(e) => handleTtsTuningChange('volume', e.target.value)}
                />
                <span className="config-hint">{t('config:tts.volumeHint', { defaultValue: '负值更轻,正值更响;0 = 原音量' })}</span>
              </div>
              <div className="config-row config-row-stacked">
                <span className="config-hint">{t('config:tts.hint', { defaultValue: '音色由微软在线语音合成(免费);语速/音量取值 -100..100(百分数);试听会先保存再播放,保存后下一句播报立即生效。' })}</span>
                {ttsLoaded && (
                  <span className="config-hint">{ttsVoicesExist ? t('config:tts.statusCustom', { defaultValue: '已自定义音色' }) : t('config:tts.statusDefault', { defaultValue: '当前为默认音色(尚未自定义)' })}</span>
                )}
                {ttsError && (
                  <span className="config-hint">{ttsError}</span>
                )}
                {(ttsDirty || ttsSaved) && (
                  <button className="config-btn config-btn-sm" onClick={handleTtsSave} disabled={ttsSaving}>{ttsSaved ? t('config:tts.saved', { defaultValue: '已保存' }) : t('common:buttons.apply')}</button>
                )}
              </div>
            </>
          )}

          {tab === 'companion' && (
            <>
              <ConfigRelationNote
                items={[{
                  text: t('config:voiceRelations.companion', { defaultValue: '实时转写=本页火山配置;批量回退→语音转文字;播报音色→文字转语音。' }),
                  links: [
                    { label: t('config:voiceRelations.goStt', { defaultValue: '转写设置' }), target: 'stt' },
                    { label: t('config:voiceRelations.goTts', { defaultValue: '音色设置' }), target: 'tts' },
                  ],
                }]}
                onJump={(target) => selectTab(target as VoiceTab)}
              />
              <VoiceCompanionSection />
              <VoiceprintSettings />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shortcuts-modal-footer">
          <span className="shortcuts-modal-hint">
            {tab === 'stt' && t('config:voiceSettings.footStt', { defaultValue: '「自动」= 云端优先,失败回退本地识别;「仅本地」= 完全离线。' })}
            {tab === 'tts' && t('config:voiceSettings.footTts', { defaultValue: '试听会先保存再播放;保存后下一句播报立即生效。' })}
            {tab === 'companion' && t('config:voiceSettings.footCompanion', { defaultValue: '实时转写、常开聆听、热词、声纹门禁等完整配置都在这里。' })}
          </span>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

export default VoiceSettingsModal;
