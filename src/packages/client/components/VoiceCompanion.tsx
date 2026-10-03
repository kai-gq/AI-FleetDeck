/**
 * 语音伙伴 · 悬浮组件
 *
 * 形态:左侧竖排的一个小圆钮(在全量聆听模式下一句话都不用点)+ 上方气泡。
 *   - 挂载点无条件渲染(FloatingActionButtons / MobileFabMenu),组件内部读
 *     tools/voice-companion/config.json:enabled=false 时返回 null;
 *   - 点击 = 开/关持续聆听;播报中点击 = 打断播报;非 leader 标签页点击 = 抢过聆听权;
 *   - 气泡:实时 partial / 最终转写 / 大脑回复 / 系统提示;空闲 ui.bubbleTimeoutMs 后淡出;
 *   - 多标签页:localStorage 心跳选 leader,只有 leader 自动聆听(避免多个标签页抢麦);
 *   - dev 钩子:window.__voiceCompanionTest(text)/__voiceCompanionState()(E2E 绕开真麦)。
 *
 * 组合关系:聆听管线在 useContinuousListening,大脑在服务端 /api/voice-companion,
 * 组件只做 FSM 编排(off → listening → hearing → transcribing → thinking → speaking)
 * 与气泡呈现。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTTS } from '../hooks/useTTS';
import { useContinuousListening } from '../hooks/useContinuousListening';
import {
  DEFAULT_VOICE_COMPANION_CONFIG,
  loadVoiceCompanionConfig,
  processVoiceCompanionText,
  subscribeVoiceCompanionConfig,
  type VoiceCompanionConfig,
} from '../api/voiceCompanion';
import { createProactiveReporter, type ProactiveReporterHandle } from '../voice/proactiveReporter';
import '../styles/components/voice-companion.scss';

const LEADER_KEY = 'tide:voice-companion:leader';
const LEADER_TTL_MS = 15_000;
const LEADER_TICK_MS = 5_000;

type EntryRole = 'user' | 'assistant' | 'system' | 'error';
interface BubbleEntry {
  id: number;
  role: EntryRole;
  text: string;
  at: number;
}

export function VoiceCompanion({ className }: { className?: string }) {
  const { t } = useTranslation(['terminal']);

  const [config, setConfig] = useState<VoiceCompanionConfig | null>(null);
  const [sessionOn, setSessionOn] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [entries, setEntries] = useState<BubbleEntry[]>([]);
  const [isLeader, setIsLeader] = useState(true);

  const { speak, stop: stopTts, speaking: ttsSpeaking } = useTTS();
  const entryIdRef = useRef(0);
  const speakGenRef = useRef(0);
  const tabIdRef = useRef(`vc-${Math.random().toString(36).slice(2, 10)}`);
  const queueRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const thinkingRef = useRef(false);
  const ttsSpeakingRef = useRef(false);
  const reporterRef = useRef<ProactiveReporterHandle | null>(null);

  // ---- 配置:挂载读一次 + 订阅设置面板保存(即时生效) ----
  useEffect(() => {
    let alive = true;
    void loadVoiceCompanionConfig()
      .then(({ config: loaded }) => {
        if (alive) setConfig(loaded);
      })
      .catch((err) => {
        console.warn('[VoiceCompanion] 配置读取失败(服务端可能未就绪):', err);
      });
    const unsubscribe = subscribeVoiceCompanionConfig((next) => setConfig(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // ---- 多标签页 leader 心跳 ----
  useEffect(() => {
    const id = tabIdRef.current;
    const tick = () => {
      const now = Date.now();
      let leader: { id?: string; at?: number } | null = null;
      try {
        leader = JSON.parse(localStorage.getItem(LEADER_KEY) || 'null') as { id?: string; at?: number } | null;
      } catch {
        leader = null;
      }
      const fresh = !!leader && typeof leader.at === 'number' && now - leader.at < LEADER_TTL_MS;
      if (!fresh || leader?.id === id) {
        try {
          localStorage.setItem(LEADER_KEY, JSON.stringify({ id, at: now }));
        } catch {
          /* 隐私模式等:忽略,默认本页为 leader */
        }
        setIsLeader(true);
      } else {
        setIsLeader(false);
      }
    };
    tick();
    const timer = window.setInterval(tick, LEADER_TICK_MS);
    const onStorage = (e: StorageEvent) => {
      if (e.key === LEADER_KEY) tick();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('storage', onStorage);
      // 让位:本页若是 leader,清掉记录让其它标签页尽快接管
      try {
        const current = JSON.parse(localStorage.getItem(LEADER_KEY) || 'null') as { id?: string } | null;
        if (current?.id === id) localStorage.removeItem(LEADER_KEY);
      } catch {
        /* ignore */
      }
    };
  }, []);

  const claimLeadership = useCallback(() => {
    try {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: tabIdRef.current, at: Date.now() }));
    } catch {
      /* ignore */
    }
    setIsLeader(true);
  }, []);

  // ---- 气泡 ----
  const pushEntry = useCallback((role: EntryRole, text: string) => {
    setEntries((prev) => [...prev.slice(-3), { id: ++entryIdRef.current, role, text, at: Date.now() }]);
  }, []);

  /** 播报(带竞态守卫:等待期间被新的播报/打断取代时,停掉这次迟到的播放)。 */
  const speakSafely = useCallback(
    async (text: string) => {
      const gen = ++speakGenRef.current;
      try {
        await speak(text);
        if (gen !== speakGenRef.current) stopTts();
      } catch (err) {
        console.warn('[VoiceCompanion] 播报失败:', err);
      }
    },
    [speak, stopTts],
  );

  /** 串行处理队列:大脑可能慢(两跳查询),并发提交会让回复错序。 */
  const drainQueue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const text = queueRef.current.shift() as string;
        setThinking(true);
        try {
          const res = await processVoiceCompanionText(text);
          if (res.success && res.response) {
            pushEntry('assistant', res.response);
            void speakSafely(res.response);
          } else {
            pushEntry(
              'error',
              res.error || t('terminal:voiceCompanion.errors.processFailed', { defaultValue: '语音伙伴处理失败' }),
            );
          }
        } catch (err) {
          console.warn('[VoiceCompanion] 处理失败:', err);
          pushEntry(
            'error',
            t('terminal:voiceCompanion.errors.unavailable', { defaultValue: '语音伙伴服务不可用' }),
          );
        } finally {
          setThinking(false);
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, [pushEntry, speakSafely, t]);

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pushEntry('user', trimmed);
      queueRef.current.push(trimmed);
      void drainQueue();
    },
    [pushEntry, drainQueue],
  );

  // ---- 聆听管线 ----
  const cfg = config ?? DEFAULT_VOICE_COMPANION_CONFIG;
  const listeningEnabled = !!config?.enabled && sessionOn && isLeader;

  const listening = useContinuousListening({
    enabled: listeningEnabled,
    mode: cfg.stt.mode,
    config: cfg.listening,
    ttsSpeaking,
    onPartial: (text) => setLiveText(text),
    onFinal: (text, meta) => {
      pushEntry('user', text);
      if (!meta.submit) return; // 仅上屏:等用户点「提交」或说结束词
      queueRef.current.push(text);
      void drainQueue();
    },
    onBargeIn: () => {
      speakGenRef.current++;
      stopTts();
    },
    onError: (message) => {
      setLiveText('');
      pushEntry('error', message);
    },
    onNotice: (message) => pushEntry('system', message),
  });

  // ---- 主动汇报:store 快照 diff → 静默窗口合并 → 大脑(event:true)→ 播报 ----
  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);
  useEffect(() => {
    ttsSpeakingRef.current = ttsSpeaking;
  }, [ttsSpeaking]);

  // 只在「启用 + 主动汇报开 + 本页是 leader」时运行(多标签页避免重复播报)
  const proactiveActive = !!config?.enabled && cfg.proactive.enabled && isLeader;

  useEffect(() => {
    if (!config || !proactiveActive) {
      reporterRef.current?.stop();
      reporterRef.current = null;
      return;
    }
    if (reporterRef.current) return;
    const reporter = createProactiveReporter({
      quietWindowMs: config.proactive.quietWindowMs,
      intervalMs: Math.max(60_000, Math.round(config.proactive.intervalMinutes * 60_000)),
      scope: config.proactive.scope,
      isBusy: () => busyRef.current || thinkingRef.current || ttsSpeakingRef.current,
      onSubmit: (text) => {
        void (async () => {
          try {
            const res = await processVoiceCompanionText(text, { event: true });
            if (res.success && res.response && res.action !== 'noop') {
              pushEntry('assistant', res.response);
              void speakSafely(res.response);
            }
          } catch (err) {
            console.warn('[VoiceCompanion] 主动汇报失败:', err);
          }
        })();
      },
    });
    reporter.start();
    reporterRef.current = reporter;
    return () => {
      reporter.stop();
      reporterRef.current = null;
    };
  }, [config, proactiveActive, pushEntry, speakSafely]);

  const handleButtonClick = useCallback(() => {
    if (!isLeader) {
      claimLeadership();
      return;
    }
    if (!sessionOn) {
      setSessionOn(true);
      return;
    }
    if (ttsSpeaking) {
      speakGenRef.current++;
      stopTts();
      return;
    }
    setSessionOn(false);
    setLiveText('');
    stopTts();
  }, [isLeader, claimLeadership, sessionOn, ttsSpeaking, stopTts]);

  // 气泡自动淡出:空闲(没有实时文本/思考/播报)时才倒计时
  useEffect(() => {
    if (entries.length === 0) return;
    if (thinking || ttsSpeaking || liveText || listening.pendingSubmit) return;
    const timer = window.setTimeout(() => setEntries([]), cfg.ui.bubbleTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [entries, thinking, ttsSpeaking, liveText, listening.pendingSubmit, cfg.ui.bubbleTimeoutMs]);

  // ---- dev 钩子(E2E 绕开真麦) ----
  const displayPhase: 'off' | 'thinking' | 'speaking' | string = !listeningEnabled
    ? 'off'
    : thinking
      ? 'thinking'
      : ttsSpeaking
        ? 'speaking'
        : listening.phase;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__voiceCompanionState = () => ({
      phase: displayPhase,
      listeningPhase: listening.phase,
      activeMode: listening.activeMode,
      vadEngine: listening.vadEngine,
      thinking,
      speaking: ttsSpeaking,
      sessionOn,
      isLeader,
      proactive: proactiveActive,
      pendingSubmit: listening.pendingSubmit,
      entries,
    });
    w.__voiceCompanionTest = (text: string) => {
      setSessionOn(true);
      submitText(String(text ?? ''));
    };
    // 合成音频帧驱动整条音频管线(E2E 无真麦);先开聆听、等 start() 生效再喂
    w.__voiceCompanionFeed = async (rms: number, frames: number, opts?: { bypassModel?: boolean; delayMs?: number }) => {
      setSessionOn(true);
      await new Promise((r) => window.setTimeout(r, opts?.delayMs ?? 400));
      listening.devFeed(Number(rms) || 0, Number(frames) || 0, { bypassModel: opts?.bypassModel });
    };
    w.__voiceCompanionProactive = {
      flushNow: () => reporterRef.current?.flushNow({ force: true }) ?? null,
      pendingCount: () => reporterRef.current?.pendingCount() ?? 0,
    };
    return () => {
      delete w.__voiceCompanionState;
      delete w.__voiceCompanionTest;
      delete w.__voiceCompanionFeed;
      delete w.__voiceCompanionProactive;
    };
  }, [displayPhase, listening.phase, listening.activeMode, listening.vadEngine, listening.devFeed, listening.pendingSubmit, thinking, ttsSpeaking, sessionOn, isLeader, proactiveActive, entries, submitText]);

  if (!config || !config.enabled) return null;

  const phaseLabel = (): string => {
    if (!isLeader) return t('terminal:voiceCompanion.phase.otherTab', { defaultValue: '另一标签页正在聆听,点击接管' });
    switch (displayPhase) {
      case 'starting':
        return t('terminal:voiceCompanion.phase.starting', { defaultValue: '正在启动麦克风…' });
      case 'listening':
        return t('terminal:voiceCompanion.phase.listening', { defaultValue: '持续聆听中(点击关闭)' });
      case 'hearing':
        return t('terminal:voiceCompanion.phase.hearing', { defaultValue: '听到了,请继续说…' });
      case 'transcribing':
        return t('terminal:voiceCompanion.phase.transcribing', { defaultValue: '正在转写…' });
      case 'thinking':
        return t('terminal:voiceCompanion.phase.thinking', { defaultValue: '正在处理…' });
      case 'speaking':
        return t('terminal:voiceCompanion.phase.speaking', { defaultValue: '正在播报(说话或点击可打断)' });
      case 'paused':
        return t('terminal:voiceCompanion.phase.paused', { defaultValue: '页面在后台,已暂停聆听' });
      case 'error':
        return t('terminal:voiceCompanion.phase.error', { defaultValue: '麦克风出错(点击重试)' });
      default:
        return t('terminal:voiceCompanion.phase.off', { defaultValue: '语音伙伴已关闭(点击开启)' });
    }
  };

  const entryTag: Record<EntryRole, string> = {
    user: t('terminal:voiceCompanion.tags.you', { defaultValue: '你' }),
    assistant: t('terminal:voiceCompanion.tags.companion', { defaultValue: '伙伴' }),
    system: t('terminal:voiceCompanion.tags.system', { defaultValue: '系统' }),
    error: t('terminal:voiceCompanion.tags.error', { defaultValue: '错误' }),
  };

  const showBubble = entries.length > 0 || !!liveText || thinking || !!listening.pendingSubmit;
  const buttonClasses = ['voice-companion-btn', `phase-${displayPhase}`];
  if (className) buttonClasses.push(className);
  if (!isLeader) buttonClasses.push('non-leader');

  return (
    <>
      {showBubble && (
        <div className="voice-companion-bubble" role="status" aria-live="polite">
          {liveText && (
            <div className="vc-entry vc-entry--live">
              <span className="vc-entry__tag">{t('terminal:voiceCompanion.tags.live', { defaultValue: '实时' })}</span>
              <span className="vc-entry__text">{liveText}</span>
            </div>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className={`vc-entry vc-entry--${entry.role}`}>
              <span className="vc-entry__tag">{entryTag[entry.role]}</span>
              <span className="vc-entry__text">{entry.text}</span>
            </div>
          ))}
          {thinking && (
            <div className="vc-entry vc-entry--system">
              <span className="vc-entry__tag">…</span>
              <span className="vc-entry__text">{t('terminal:voiceCompanion.thinking', { defaultValue: '正在思考…' })}</span>
            </div>
          )}
          {listening.pendingSubmit && (
            <button type="button" className="vc-commit" onClick={listening.commitPending}>
              {t('terminal:voiceCompanion.commit', { defaultValue: '发送这条(未自动提交)' })}
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        className={buttonClasses.join(' ')}
        onClick={handleButtonClick}
        title={phaseLabel()}
        aria-label={phaseLabel()}
      >
        {displayPhase === 'speaking' ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
        <span className="voice-companion-dot" />
      </button>

      {listeningEnabled && displayPhase !== 'listening' && displayPhase !== 'off' && (
        <span className="voice-companion-pill">{phaseLabel()}</span>
      )}
    </>
  );
}
