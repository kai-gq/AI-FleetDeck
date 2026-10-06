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
import { useSpeechQueue } from '../hooks/useSpeechQueue';
import { useContinuousListening } from '../hooks/useContinuousListening';
import {
  DEFAULT_VOICE_COMPANION_CONFIG,
  loadVoiceCompanionConfig,
  processVoiceCompanionTextStream,
  subscribeVoiceCompanionConfig,
  fetchVoiceReminderDue,
  ackVoiceReminder,
  type VoiceCompanionConfig,
  type VoiceProcessStreamFinal,
} from '../api/voiceCompanion';
import { createProactiveReporter, type ProactiveReporterHandle } from '../voice/proactiveReporter';
import { createReminderWatcher, type ReminderWatcherHandle } from '../voice/reminderWatcher';
import { createUserActivityReporter, type UserActivityReporterHandle } from '../voice/userActivityReporter';
import { preloadTtsAudio } from '../voice/ttsPreload';
import { loadBroadcastGatesSettings, toGatesConfig } from '../voice/proactiveGatesSettings';
import { subscribeTaskReceipt } from '../voice/taskReceiptBus';
import { store } from '../store';
import { executeOpenCommand, matchOpenCommand } from '../voice/openCommand';
import '../styles/components/voice-companion.scss';

const LEADER_KEY = 'tide:voice-companion:leader';
const LEADER_TTL_MS = 15_000;
const LEADER_TICK_MS = 5_000;
/** 打断播报后的连击保护窗:窗口内再点只当打断,不关麦(P3)。 */
const BARGE_IN_CLICK_GUARD_MS = 500;

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

/** 按用户话语判定播报语种:中文句子用 zh 音色(避免短句被自动检测误判)。 */
function speechLangFor(text: string): string {
  return /[一-鿿]/.test(text) ? 'zh' : 'en';
}

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

  const { enqueue: enqueueSpeech, stop: stopSpeech, drain: drainSpeech, speaking: ttsSpeaking } = useSpeechQueue();
  const entryIdRef = useRef(0);
  const speakGenRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const lastBargeInAtRef = useRef(0);
  const sentencesRef = useRef<string[]>([]); // 本轮已播句子(dev 钩子 E2E 断言用)
  const tabIdRef = useRef(`vc-${Math.random().toString(36).slice(2, 10)}`);
  const queueRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const thinkingRef = useRef(false);
  const ttsSpeakingRef = useRef(false);
  const isLeaderRef = useRef(true);
  const listeningPhaseRef = useRef<string>('off');
  const reporterRef = useRef<ProactiveReporterHandle | null>(null);
  const reminderWatcherRef = useRef<ReminderWatcherHandle | null>(null);
  const userActivityReporterRef = useRef<UserActivityReporterHandle | null>(null);

  // 卸载:中止在途流;播报队列由 useSpeechQueue 自行停止
  useEffect(() => () => {
    speakGenRef.current++;
    streamAbortRef.current?.abort();
  }, []);

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

  /**
   * 流式播报一轮大脑请求(代际守卫 + 可 abort):
   * - 模型边生成边按句下推,首句一到就入播报队列(合成+播放接续进行);
   * - pre 句(过渡/垫话,meta.pre)照播但不进对账集——final 的 response
   *   不含它们,若计入比较必然不等,真实回复会被整段重播念两遍;
   * - final 的 response 与已播明显不一致、或服务端整轮没出过声(spoke=false)
   *   → 整段补播,避免系统兜底话术被吞;
   * - 返回 final 结果;null = 期间被新的播报/打断取代(调用方不再上屏)。
   */
  const runStreamSafely = useCallback(
    async (text: string, event: boolean, lang: string): Promise<VoiceProcessStreamFinal | null> => {
      const gen = ++speakGenRef.current;
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      sentencesRef.current = [];
      const spoken: string[] = [];

      try {
        let final: VoiceProcessStreamFinal | null = null;
        await processVoiceCompanionTextStream(
          text,
          { event, signal: controller.signal },
          {
            onSentence: (sentence, meta) => {
              if (gen !== speakGenRef.current) return;
              if (!meta?.pre) spoken.push(sentence); // pre 句照播但不参与最终对账
              sentencesRef.current.push(sentence);
              // pre 垫话不清「正在思考」:真答案还没出,清了会让 turnInFlight 提前解除、
              // 用户中途插话不再触发 barge-in(不 abort 在途回合,下一句得等它跑完)。
              if (!meta?.pre) setThinking(false);
              enqueueSpeech(sentence, lang);
            },
            onFinal: (result) => {
              final = result;
            },
          },
        );
        if (gen !== speakGenRef.current) return null;

        const result = final as VoiceProcessStreamFinal | null;
        if (result && result.success !== false && result.response) {
          const playedSomething = spoken.length > 0 || result.spoke === true;
          const spokenNorm = spoken.join('').replace(/\s+/g, '');
          const finalNorm = result.response.replace(/\s+/g, '');
          if (!playedSomething || spokenNorm !== finalNorm) {
            // 整段兜底(noop 之外没出过声)/ 纠正(系统兜底覆盖了模型话术)
            enqueueSpeech(result.response, lang);
          }
        }
        return result;
      } finally {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
      }
    },
    [enqueueSpeech],
  );

  /** 服务端稳定错误码 → 中文文案(P8);未知码/旧服务端回退到 error 原文。 */
  const errorTextFor = useCallback(
    (res: { code?: string; error?: string }): string => {
      switch (res.code) {
        case 'CLAUDE_NOT_FOUND':
          return t('terminal:voiceCompanion.errors.claudeNotFound', { defaultValue: '未找到 Claude CLI,请检查安装与 PATH' });
        case 'TEXT_REQUIRED':
          return t('terminal:voiceCompanion.errors.textRequired', { defaultValue: '没有听到内容' });
        case 'TEXT_TOO_LONG':
          return t('terminal:voiceCompanion.errors.textTooLong', { defaultValue: '内容太长,请分两句说' });
        case 'PROCESS_FAILED':
        case 'INTERNAL':
          return t('terminal:voiceCompanion.errors.processFailed', { defaultValue: '语音伙伴处理失败' });
        default:
          return res.error || t('terminal:voiceCompanion.errors.processFailed', { defaultValue: '语音伙伴处理失败' });
      }
    },
    [t],
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
          const res = await runStreamSafely(text, false, speechLangFor(text));
          if (res === null) continue; // 被新的播报/打断取代
          if (res.success && res.response) {
            pushEntry('assistant', res.response);
          } else if (!res.success) {
            pushEntry('error', errorTextFor(res));
          }
          // success 且无 response:noop,不出声也不上屏
        } catch (err) {
          if (isAbortError(err)) continue;
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
  }, [pushEntry, runStreamSafely, errorTextFor]);

  /**
   * 「打开X」本地直达(voice/openCommand):语音终稿在进大脑之前先过固定触发。
   * 命中 → 直接打开面板 + 出声确认,不进 queueRef(不送大脑);未命中 → false,原链路。
   */
  const tryOpenCommand = useCallback(
    (text: string): boolean => {
      const cmd = matchOpenCommand(text, store.getState().agents.values());
      if (!cmd) return false;
      const ack = executeOpenCommand(cmd);
      pushEntry('assistant', ack);
      enqueueSpeech(ack, speechLangFor(ack));
      return true;
    },
    [pushEntry, enqueueSpeech],
  );

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pushEntry('user', trimmed);
      if (tryOpenCommand(trimmed)) return; // 「打开X」本地直达:不进大脑
      queueRef.current.push(trimmed);
      void drainQueue();
    },
    [pushEntry, tryOpenCommand, drainQueue],
  );

  // ---- 聆听管线 ----
  const cfg = config ?? DEFAULT_VOICE_COMPANION_CONFIG;
  const listeningEnabled = !!config?.enabled && sessionOn && isLeader;

  const listening = useContinuousListening({
    enabled: listeningEnabled,
    mode: cfg.stt.mode,
    config: cfg.listening,
    ttsSpeaking,
    turnInFlight: thinking,
    onPartial: (text) => setLiveText(text),
    onFillerHint: (text) => preloadTtsAudio(text, speechLangFor(text)),
    onFinal: (text, meta) => {
      // 手动提交回放的同一文本已上屏过,不再重复 push(P11)
      if (!meta.fromPending) pushEntry('user', text);
      if (!meta.submit) return; // 仅上屏:等用户点「提交」或说结束词
      if (tryOpenCommand(text)) return; // 「打开X」本地直达:不进大脑
      queueRef.current.push(text);
      void drainQueue();
    },
    onBargeIn: () => {
      lastBargeInAtRef.current = Date.now();
      speakGenRef.current++;
      streamAbortRef.current?.abort();
      stopSpeech();
      // latest-wins(HC-B8):排队中未处理的旧终稿一并作废,只答最后一句
      queueRef.current.length = 0;
      // 打断是"无声"的:给一条可见提示,避免用户以为播报丢了(P7);
      // 思考中被打断时没有可听的「播报」,换一条更准确的提示(HC-B8)
      pushEntry(
        'system',
        ttsSpeaking
          ? t('terminal:voiceCompanion.notices.bargeIn', { defaultValue: '已打断播报,继续聆听…' })
          : t('terminal:voiceCompanion.notices.turnCancelled', { defaultValue: '已取消上一回合,按新的一句来…' }),
      );
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
  useEffect(() => {
    isLeaderRef.current = isLeader;
  }, [isLeader]);
  useEffect(() => {
    listeningPhaseRef.current = listening.phase;
  }, [listening.phase]);

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
      // 09·B 播报分级:STORE 档走上屏通道(不口播);分级参数现读 localStorage,改设置即时生效
      onStore: (text) => pushEntry('system', text),
      gatesConfig: () => toGatesConfig(loadBroadcastGatesSettings()),
      gatesEnv: () => ({ speaking: ttsSpeakingRef.current }),
      onSubmit: (text) => {
        void (async () => {
          try {
            const res = await runStreamSafely(text, true, speechLangFor(text));
            if (res && res.success && res.response && res.action !== 'noop') {
              pushEntry('assistant', res.response);
            }
          } catch (err) {
            if (isAbortError(err)) return;
            console.warn('[VoiceCompanion] 主动汇报失败:', err);
          }
        })();
      },
    });
    reporter.start();
    reporterRef.current = reporter;
    // 任务08②:派活闭环回执(task_receipt)→ 同一队列/同一闸门(权威判定),
    // 并与 store 快照 diff 做同目标覆盖抑制——同一次完成不双播
    const unsubscribeReceipt = subscribeTaskReceipt((receipt) => {
      reporterRef.current?.ingestReceipt(receipt);
    });
    return () => {
      unsubscribeReceipt();
      reporter.stop();
      reporterRef.current = null;
    };
  }, [config, proactiveActive, pushEntry, runStreamSafely]);

  // ---- 分钟级提醒取件:到点(WS 主通道 + 5s 轮询兜底)→ 播报 → 回执(仅 leader) ----
  // 链路与边界见 voice/reminderWatcher;闹钟语义,不搭车 hop1(事故教训:36s 级延迟不可接受)。
  useEffect(() => {
    if (!config?.enabled || !isLeader) {
      reminderWatcherRef.current?.stop();
      reminderWatcherRef.current = null;
      return;
    }
    const watcher = createReminderWatcher({
      isLeader: () => isLeaderRef.current,
      // 不插话:用户正在说话(听写/转写)、大脑处理中、播报中一律挂起,下一 tick 重试
      isBusy: () =>
        busyRef.current ||
        thinkingRef.current ||
        ttsSpeakingRef.current ||
        listeningPhaseRef.current === 'hearing' ||
        listeningPhaseRef.current === 'transcribing',
      speak: (text) => {
        enqueueSpeech(text, speechLangFor(text));
        return drainSpeech(); // 播完(或被打断)才 resolve → 之后才回执
      },
      ack: ackVoiceReminder,
      fetchDue: fetchVoiceReminderDue,
    });
    watcher.start();
    reminderWatcherRef.current = watcher;
    return () => {
      watcher.stop();
      reminderWatcherRef.current = null;
    };
  }, [config?.enabled, isLeader, enqueueSpeech, drainSpeech]);

  // ---- 用户活跃上报:输入节奏/焦点变化(不含内容)节流上报,服务端据此判断「用户在场」 ----
  // 模块与边界见 voice/userActivityReporter;只记「发生过输入」,绝不读 key/坐标。
  useEffect(() => {
    if (!config?.enabled) {
      userActivityReporterRef.current?.stop();
      userActivityReporterRef.current = null;
      return;
    }
    const reporter = createUserActivityReporter();
    reporter.start();
    userActivityReporterRef.current = reporter;
    return () => {
      reporter.stop();
      userActivityReporterRef.current = null;
    };
  }, [config?.enabled]);

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
      // 播报中点击 = 打断(不关麦);记时间戳供连击保护
      lastBargeInAtRef.current = Date.now();
      speakGenRef.current++;
      streamAbortRef.current?.abort();
      stopSpeech();
      return;
    }
    if (Date.now() - lastBargeInAtRef.current < BARGE_IN_CLICK_GUARD_MS) {
      return; // 双击的第二下:打断已结束,但用户意图仍是打断,不当关麦(P3)
    }
    setSessionOn(false);
    setLiveText('');
    stopSpeech();
  }, [isLeader, claimLeadership, sessionOn, ttsSpeaking, stopSpeech]);

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
      sentences: sentencesRef.current,
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
      // ⑭ 观测点⑥:本地决策统计(各闸门打分→档位→理由;内存快照)
      stats: () => reporterRef.current?.gatesStats() ?? null,
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
