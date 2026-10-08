/**
 * 声纹注册录音 Hook(工具箱 → 语音伙伴 → 声纹门禁)
 *
 * 采集装配与 useContinuousListening 一致(16k AudioWorklet 'pcm-capture'、30ms 帧、
 * 同样的麦克风约束)——注册音与日后验证音声学特征同源,匹配率才有保证。
 * 不做 ScriptProcessor 回退:注册是一次性动作,静默降级录出的音会污染声纹,
 * 无 audioWorklet 直接报错。
 *
 * start(seconds) 返回 Promise:录满/提前结束 → { wavBase64, seconds };
 * 太短/取消/出错 → null(error 状态里有原因)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import workletUrl from '../voice/pcm-worklet.js?url';
import { pcm16FramesToWav } from '../voice/wav';
import { bytesToBase64, wavDurationSeconds } from '../voice/voiceprintWav';

const TARGET_RATE = 16_000;
const FRAME_MS = 30;
/** 与服务端 MIN_AUDIO_SECONDS(voiceprint-enroll-service)同门槛。 */
export const VOICEPRINT_MIN_SECONDS = 4.5;
export const VOICEPRINT_RECORD_SECONDS = 20;

export interface VoiceprintRecording {
  wavBase64: string;
  seconds: number;
}

interface RunningSession {
  ctx: AudioContext;
  mic: MediaStream;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  sink: GainNode;
  frames: ArrayBuffer[];
  timer: number;
  resolve: (r: VoiceprintRecording | null) => void;
  finished: boolean;
}

function micErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') return '麦克风权限被拒绝';
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') return '未找到麦克风设备';
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') return '麦克风被其他程序占用(先关掉语音聆听再录)';
    if (err.name === 'OverconstrainedError') return '麦克风不支持所需参数';
    return `麦克风错误:${err.message}`;
  }
  return '无法访问麦克风';
}

/** 释放一条录制会话(不碰 React 状态;卸载路径直接用)。 */
function teardownSession(s: RunningSession): void {
  window.clearInterval(s.timer);
  try {
    s.node.port.onmessage = null;
  } catch {
    /* ignore */
  }
  try {
    s.source.disconnect();
    s.node.disconnect();
    s.sink.disconnect();
  } catch {
    /* ignore */
  }
  s.mic.getTracks().forEach((track) => track.stop());
  void s.ctx.close().catch(() => {
    /* ignore */
  });
}

export function useVoiceprintRecorder() {
  const [recording, setRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<RunningSession | null>(null);
  const lastLevelAtRef = useRef(0);

  const clearSession = useCallback((s: RunningSession) => {
    sessionRef.current = null;
    teardownSession(s);
    setRecording(false);
    setLevel(0);
  }, []);

  /** 收尾:出 WAV;太短 → error + null。 */
  const finish = useCallback(
    (s: RunningSession) => {
      if (s.finished) return;
      s.finished = true;
      const frames = s.frames;
      clearSession(s);
      const wav = pcm16FramesToWav(frames, TARGET_RATE);
      const seconds = wavDurationSeconds(wav);
      if (seconds < VOICEPRINT_MIN_SECONDS) {
        setError(`录音太短(${seconds.toFixed(1)} 秒):至少要说满 ${VOICEPRINT_MIN_SECONDS} 秒`);
        s.resolve(null);
        return;
      }
      setError(null);
      s.resolve({ wavBase64: bytesToBase64(wav), seconds });
    },
    [clearSession],
  );

  /** 取消:不出结果、不报错(卸载/放弃用)。 */
  const cancel = useCallback(
    (s: RunningSession) => {
      if (s.finished) return;
      s.finished = true;
      clearSession(s);
      s.resolve(null);
    },
    [clearSession],
  );

  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (s) finish(s); // 提前结束 = 提前收尾(太短会给 error,不静默)
  }, [finish]);

  const start = useCallback(
    (seconds: number = VOICEPRINT_RECORD_SECONDS): Promise<VoiceprintRecording | null> => {
      if (sessionRef.current) return Promise.resolve(null);
      setError(null);

      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setError('麦克风需要 HTTPS(或 localhost)环境');
        return Promise.resolve(null);
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前浏览器不支持麦克风采集');
        return Promise.resolve(null);
      }

      return (async (): Promise<VoiceprintRecording | null> => {
        let mic: MediaStream;
        try {
          // 约束与聆听链路一致(useContinuousListening):注册音/验证音必须同处理
          mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: TARGET_RATE },
          });
        } catch (err) {
          setError(micErrorMessage(err));
          return null;
        }

        let ctx: AudioContext | null = null;
        try {
          const Ctor =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          ctx = new Ctor({ sampleRate: TARGET_RATE });
          if (ctx.state === 'suspended') await ctx.resume();
          if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            throw new Error('AudioWorklet unavailable');
          }
          await ctx.audioWorklet.addModule(workletUrl);
        } catch {
          mic.getTracks().forEach((track) => track.stop());
          if (ctx) {
            void ctx.close().catch(() => {
              /* ignore */
            });
          }
          setError('当前浏览器不支持音频采集(AudioWorklet),请换新版 Chrome/Edge');
          return null;
        }

        const source = ctx.createMediaStreamSource(mic);
        const sink = ctx.createGain();
        sink.gain.value = 0; // 静音:保持图连接让 worklet 持续被 pull
        sink.connect(ctx.destination);
        const node = new AudioWorkletNode(ctx, 'pcm-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { targetRate: TARGET_RATE, frameMs: FRAME_MS },
        });

        return new Promise<VoiceprintRecording | null>((resolve) => {
          const session: RunningSession = { ctx, mic, node, source, sink, frames: [], timer: 0, resolve, finished: false };
          sessionRef.current = session;
          const startedAt = Date.now();
          setRecording(true);
          setSecondsLeft(Math.ceil(seconds));

          node.port.onmessage = (ev: MessageEvent) => {
            const d = ev.data as { rms?: number; pcm16?: ArrayBuffer } | null;
            if (!d || typeof d.rms !== 'number' || !d.pcm16) return;
            session.frames.push(d.pcm16);
            const now = Date.now();
            if (now - lastLevelAtRef.current >= 100) {
              lastLevelAtRef.current = now; // 电平 ~10Hz,不驱动高频渲染
              setLevel(d.rms);
            }
          };
          source.connect(node);
          node.connect(sink);

          session.timer = window.setInterval(() => {
            const remaining = seconds - (Date.now() - startedAt) / 1000;
            if (remaining <= 0) {
              finish(session);
              return;
            }
            setSecondsLeft(Math.ceil(remaining));
          }, 200);
        });
      })();
    },
    [finish],
  );

  // 卸载:释放麦克风与 AudioContext(不 setState)
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      if (!s) return;
      sessionRef.current = null;
      teardownSession(s);
      s.finished = true;
      s.resolve(null);
    };
  }, []);

  return { recording, secondsLeft, level, error, start, stop, cancel };
}
