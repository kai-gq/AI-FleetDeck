/**
 * 语音伙伴 · 流式转写通道(服务端 WS 代理)
 *
 * 路径:/ws/voice-companion(与主 /ws、终端代理并存,按路径前缀分发)
 * 鉴权:复用 auth/index 的 validateWebSocketAuth(?token= 或 auth-<token> 子协议)。
 *
 * 协议(与客户端 useContinuousListening 约定):
 *   客户端 → 服务端:
 *     - 二进制帧:PCM s16le / 16kHz / 单声道(仅语音段,客户端已在 VAD 处裁剪;
 *       服务端按 100ms/包转发给火山,超出自动拆分);
 *     - 文本 JSON:{"type":"finish"} 客户端 VAD 判停,要求末包结果;
 *                 {"type":"close"}  断开整条通道;
 *                 {"type":"ping"}   保活探测。
 *   服务端 → 客户端:
 *     - {"type":"ready", endpoint}          凭据就绪,流式可用
 *     - {"type":"partial", text}            实时部分结果(整句增量,客户端替换显示)
 *     - {"type":"final", text}              一句的最终结果
 *     - {"type":"error", code, message}     凭据缺失/识别出错(客户端据此回退批量通道)
 *     - {"type":"pong"}
 *
 * 凭据来自 tools/voice-companion/config.json 的 stt.volcengine(见
 * voice-companion-service.loadVolcengineSttConfig);缺失时立即回 error,
 * 客户端自动走既有的 /api/stt/transcribe 分段回退,功能不残。
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { validateWebSocketAuth } from '../auth/index.js';
import { loadVolcengineSttConfig, prewarmCompanion, type VolcengineSttConfig } from '../services/voice-companion-service.js';
import { VolcengineAsrSession, type VolcengineAsrError } from './volcengine-asr-client.js';
import { logVoiceAsr } from '../services/activity-log.js';
import { logger } from '../utils/index.js';
// 任务18·秘书常驻化:进程卫生(启动清扫残留 + 退出钩子)——挂在这个唯一的服务启动钩子上。
import { initCompanionProcessHygiene } from './companion-runner.js';

const log = logger.server;

export const VOICE_COMPANION_WS_PATH = '/ws/voice-companion';

/** 单帧上限(客户端正常发 ~3.2KB/100ms,512KB 足够防御异常客户端)。 */
const MAX_FRAME_BYTES = 512 * 1024;
/** 单会话音频上限:60s(超长会话强制判停,防跑飞)。 */
const MAX_SESSION_AUDIO_BYTES = 60 * 32_000;

export function hasVolcengineCredentials(cfg: VolcengineSttConfig): boolean {
  return !!cfg.apiKey || (!!cfg.appId && !!cfg.accessToken);
}

/**
 * 挂载流式通道。在 server/index.ts 的 websocket.init 之后调用(每个 listener 一次),
 * 与 terminal-proxy 的 upgrade 监听器按路径前缀互不干扰。
 */
export function attachVoiceCompanionStream(server: HttpServer | import('node:https').Server): void {
  // 任务18·秘书常驻化:启动时清扫上一代 server 留下的常驻 claude 进程 + 装退出钩子(幂等)。
  initCompanionProcessHygiene();

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '', 'http://localhost').pathname;
    } catch {
      return;
    }
    if (pathname !== VOICE_COMPANION_WS_PATH) return;

    if (!validateWebSocketAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => handleConnection(ws));
  log.log(`[VoiceCompanion] 流式转写通道已挂载:${VOICE_COMPANION_WS_PATH}`);
}

/** 可见性:生产由 attach 内部调用;导出以便单测驱动连接协议(首个音频帧→预热等)。 */
export function handleConnection(ws: WebSocket): void {
  const cfg = loadVolcengineSttConfig();

  const send = (obj: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  if (!hasVolcengineCredentials(cfg)) {
    send({
      type: 'error',
      code: 'no_credentials',
      message: '未配置火山引擎流式识别凭据(工具箱 → 语音伙伴),请在客户端回退批量转写',
    });
    ws.close();
    return;
  }

  send({ type: 'ready', endpoint: cfg.endpoint });
  log.log(`[VoiceCompanion] 流式通道连接建立(endpoint=${cfg.endpoint})`);

  let session: VolcengineAsrSession | null = null;
  let sessionAudioBytes = 0;
  // 任务 02 语音链路埋点：记录一段流式会话的起点，onFinal/onError 落 ASR 文本与耗时。
  let sessionStartedAt: number | null = null;
  let closed = false;
  // W3 预热点火:每连接一次 —— 用户开口的首帧音频即后台补建常驻 claude 进程,
  // 把冷启动(spawn + CLI 引导)藏进说话时间;回合真正到来时直接复用。
  let speechPrewarmed = false;

  const dropSession = (): void => {
    session = null;
    sessionAudioBytes = 0;
    sessionStartedAt = null;
  };

  const ensureSession = (): VolcengineAsrSession => {
    if (session) return session;
    sessionAudioBytes = 0;
    sessionStartedAt = Date.now();
    const s = new VolcengineAsrSession({
      credentials: cfg,
      onPartial: (text) => send({ type: 'partial', text }),
      onFinal: (text) => {
        logVoiceAsr({
          channel: 'volcengine-stream',
          text,
          durationMs: sessionStartedAt !== null ? Date.now() - sessionStartedAt : 0,
          ok: true,
        });
        send({ type: 'final', text });
        dropSession();
      },
      onError: (err: VolcengineAsrError) => {
        log.warn(`[VoiceCompanion] 流式识别错误:${err.message}`);
        logVoiceAsr({
          channel: 'volcengine-stream',
          text: '',
          ok: false,
          error: err.message,
          durationMs: sessionStartedAt !== null ? Date.now() - sessionStartedAt : 0,
        });
        send({ type: 'error', code: err.code ?? 'asr_error', message: err.message });
        dropSession();
      },
      onLog: (line) => log.log(`[VoiceCompanion/stream] ${line}`),
    });
    session = s;
    return s;
  };

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (closed) return;

    if (isBinary) {
      const chunk = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (chunk.length === 0 || chunk.length > MAX_FRAME_BYTES) return;
      if (!speechPrewarmed) {
        speechPrewarmed = true;
        // 异步不占帧转发路径;失败静默(预热只是加成)。
        setTimeout(() => { prewarmCompanion(); }, 0);
      }
      sessionAudioBytes += chunk.length;
      if (sessionAudioBytes > MAX_SESSION_AUDIO_BYTES) {
        // 防御:单段超 60s,强制判停(客户端也会按 maxSegmentMs 自行切)
        session?.finish();
        return;
      }
      ensureSession().sendAudio(chunk);
      return;
    }

    let msg: { type?: string } | null = null;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg?.type === 'finish') {
      if (session) {
        session.finish();
      } else {
        // 还没发过音频(客户端空段):直接回空终稿,不必连线火山
        send({ type: 'final', text: '' });
      }
      return;
    }
    if (msg?.type === 'close') {
      closed = true;
      session?.close();
      dropSession();
      ws.close();
      return;
    }
    if (msg?.type === 'ping') {
      send({ type: 'pong' });
    }
  });

  ws.on('close', () => {
    closed = true;
    session?.close();
    dropSession();
  });
  ws.on('error', () => {
    closed = true;
    session?.close();
    dropSession();
  });
}
