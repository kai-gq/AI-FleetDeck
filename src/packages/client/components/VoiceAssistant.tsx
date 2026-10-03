/**
 * VoiceAssistant - Global voice interface component
 *
 * Provides a mic button that records user speech, sends it to the server
 * which transcribes, analyzes intent with Claude, forwards to appropriate agent,
 * and responds with TTS.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSTT } from '../hooks/useSTT';
import { useSpeechQueue } from '../hooks/useSpeechQueue';
import { processVoiceAssistantTextStream, type VoiceAssistantStreamFinal } from '../api/voiceAssistant';
import { useSettings } from '../store';

interface VoiceAssistantProps {
  className?: string;
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

/** 按用户话语判定播报语种(避免短句被自动检测误判)。 */
function speechLangFor(text: string): string {
  return /[一-鿿]/.test(text) ? 'zh' : 'en';
}

export function VoiceAssistant({ className }: VoiceAssistantProps) {
  const { t } = useTranslation(['terminal']);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = useSettings();

  // 分句流式播报(模型边生成边合成播放),替换原先「整段等完再播」
  const { enqueue: enqueueSpeech, stop: stopSpeech, speaking: ttsSpeaking } = useSpeechQueue();
  const speakGenRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const personaPreset = settings.voiceAssistantPersonaPreset;
  const personaCustom = settings.voiceAssistantPersonaCustom;

  // 卸载:中止在途流(播报队列由 useSpeechQueue 自行停止)
  useEffect(() => () => {
    speakGenRef.current++;
    streamAbortRef.current?.abort();
  }, []);

  const handleTranscription = useCallback(async (text: string) => {
    if (!text.trim()) return;

    console.log('[VoiceAssistant] Transcribed:', text);
    setProcessing(true);
    setError(null);

    // 代际守卫:新一轮请求/打断会让旧流的结果作废
    const gen = ++speakGenRef.current;
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const spoken: string[] = [];
    const lang = speechLangFor(text);

    try {
      let final: VoiceAssistantStreamFinal | null = null;
      await processVoiceAssistantTextStream(
        text,
        { persona: { preset: personaPreset, custom: personaCustom }, signal: controller.signal },
        {
          onSentence: (sentence) => {
            if (gen !== speakGenRef.current) return;
            spoken.push(sentence);
            enqueueSpeech(sentence, lang);
          },
          onFinal: (result) => { final = result; },
        },
      );
      if (gen !== speakGenRef.current) return;

      const result = final as VoiceAssistantStreamFinal | null;
      if (result && result.success !== false) {
        if (result.response) {
          console.log('[VoiceAssistant] Response:', result.response);
          const playedSomething = spoken.length > 0 || result.spoke === true;
          const spokenNorm = spoken.join('').replace(/\s+/g, '');
          const finalNorm = result.response.replace(/\s+/g, '');
          if (!playedSomething || spokenNorm !== finalNorm) {
            // 服务端没下推过句子(旧服务端/兜底覆盖)→ 整段补播
            enqueueSpeech(result.response, lang);
          }
        }
      } else {
        const errorMsg = result?.error || t('terminal:voiceAssistant.failedToProcess');
        console.error('[VoiceAssistant] Error:', errorMsg);
        setError(errorMsg);
        enqueueSpeech(errorMsg, lang);
      }
    } catch (err) {
      if (isAbortError(err)) return;
      console.error('[VoiceAssistant] Request failed:', err);
      const errorMsg = t('terminal:voiceAssistant.unavailable');
      setError(errorMsg);
      enqueueSpeech(errorMsg, lang);
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
      if (gen === speakGenRef.current) setProcessing(false);
    }
  }, [enqueueSpeech, personaPreset, personaCustom, t]);

  const stt = useSTT({
    language: 'Chinese',
    model: 'turbo',
    onTranscription: handleTranscription,
  });

  const isActive = stt.recording || stt.transcribing || processing || ttsSpeaking;

  const getButtonTitle = () => {
    if (stt.error) return `${t('terminal:voiceAssistant.error')}: ${stt.error}`;
    if (error) return `${t('terminal:voiceAssistant.error')}: ${error}`;
    if (stt.recording) return t('terminal:voiceAssistant.recording');
    if (stt.transcribing) return t('terminal:voiceAssistant.transcribing');
    if (processing) return t('terminal:voiceAssistant.processing');
    if (ttsSpeaking) return t('terminal:voiceAssistant.speaking');
    return t('terminal:voiceAssistant.title');
  };

  const getButtonClass = () => {
    const classes = ['voice-assistant-btn', className].filter(Boolean);
    if (stt.recording) classes.push('recording');
    if (stt.transcribing || processing) classes.push('processing');
    if (ttsSpeaking) classes.push('speaking');
    if (error || stt.error) classes.push('error');
    return classes.join(' ');
  };

  const handleClick = () => {
    // Clear any previous error on new attempt
    setError(null);

    if (ttsSpeaking) {
      // barge-in:打断播报并中止在途请求(代际守卫让旧流的结果作废)
      speakGenRef.current++;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      stopSpeech();
      setProcessing(false);
      return;
    }

    if (stt.transcribing || processing) {
      return; // Don't interrupt processing
    }

    stt.toggleRecording();
  };

  return (
    <button
      className={getButtonClass()}
      onClick={handleClick}
      title={!stt.supported ? t('terminal:voiceAssistant.notSupported') : getButtonTitle()}
      disabled={!stt.supported || stt.transcribing || (processing && !ttsSpeaking)}
    >
      {stt.recording ? (
        // Recording animation - pulsing mic
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
          <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
        </svg>
      ) : ttsSpeaking ? (
        // Speaking animation - sound waves
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      ) : (
        // Default mic icon
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
      {isActive && <span className="voice-assistant-indicator" />}
    </button>
  );
}
