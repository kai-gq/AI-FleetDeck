/**
 * WeChat ⇄ 秘书大脑（语音伙伴）直连桥
 *
 * 用户拍板（2026-10-11）：微信私聊消息交给「大脑秘书」——即语音伙伴
 * （voice-companion）的持久会话（claude --resume + 记忆），而不是团队 agent。
 * 本桥订阅 wechat-trigger-handler.ts 的模块级总线（与触发器共用同一条消息流，
 * 连接层零改动），把入站消息按对话注入大脑，再把 response 正文原样回发微信
 * （context_token 取自当前入站消息）。
 *
 * 与 triggers 的关系：两条消费者互相独立。若同一消息既命中触发器又开本桥，
 * 会双回复——配置上应二选一（companionBridge=true 时建议触发器留空）。
 *
 * 工程约束：
 * - 串行链：秘书是单会话（服务内 withMutex），这里再串一道队列，多条微信
 *   按序进大脑、按序回发；单轮 120s 上限，超时放弃本轮不阻塞后续。
 * - 不传 onSentence —— 走整段返回路径，不触发 TTS 播报（微信回合对房间保持安静）。
 * - 失败只记日志（含原因），绝不改动 lastError 等连接诊断字段——秘书桥哑火
 *   不应把整个集成状态染红。
 */

import { createLogger } from '../../utils/logger.js';
import {
  subscribeWeChatMessages,
  humanizeWeChatId,
  type NormalizedWeChatMessage,
} from './wechat-trigger-handler.js';
import { getWeChatConnection } from './wechat-connection.js';
import { loadConfig } from './wechat-config.js';

const log = createLogger('WeChatCompanion');

/** 单轮上限：超时中止本轮 claude 调用（垫话/长尾已知可达 ~40s，120s 已是宽限）。 */
const COMPANION_TURN_TIMEOUT_MS = 120_000;

let unsubscribe: (() => void) | null = null;
/** 串行队列尾指针——保证“按序进大脑、按序回发”。 */
let chain: Promise<void> = Promise.resolve();

/**
 * 组装注入大脑的对话文本。要点：说清来源（微信）、给出来者与正文，
 * 并明确「答复会原样发回微信」——大脑的 response 即微信回复正文。
 */
export function composeCompanionTurn(msg: NormalizedWeChatMessage): string {
  const name = msg.fromName || humanizeWeChatId(msg.fromUserId);
  const kind = msg.voiceTranscription ? '（语音留言，附转写）' : '';
  return (
    `【微信消息】「${name}」在微信上对你说${kind}：\n\n` +
    `${msg.body}\n\n` +
    `（这是微信对话：请直接给出要回复到微信的正文，我会原样发过去。）`
  );
}

async function runCompanionTurn(msg: NormalizedWeChatMessage): Promise<void> {
  const started = Date.now();
  const senderTag = humanizeWeChatId(msg.fromUserId);
  try {
    // 动态 import：避免插件初始化期与 voice-companion-service 的模块环。
    const { processVoiceInput } = await import('../../services/voice-companion-service.js');
    const result = await processVoiceInput(composeCompanionTurn(msg), {
      signal: AbortSignal.timeout(COMPANION_TURN_TIMEOUT_MS),
    });
    const reply = (result?.response ?? '').trim();
    if (!reply) {
      log.debug(`wechat.companion 空回复（action=${result?.action ?? 'n/a'}）from=${senderTag}`);
      return;
    }
    const conn = getWeChatConnection();
    if (!conn) {
      log.warn(`wechat.companion 连接已停用，放弃回发 from=${senderTag}`);
      return;
    }
    await conn.sendMessage({
      toUserId: msg.fromUserId,
      text: reply,
      contextToken: msg.contextToken,
    });
    // 只记长度与耗时，不落回复正文（内容进微信即可，日志不复制一份）。
    log.log(
      `wechat.companion 已回发 from=${senderTag} action=${result.action} len=${reply.length} ${Date.now() - started}ms`,
    );
  } catch (err) {
    log.warn(
      `wechat.companion 回合失败 from=${senderTag}：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 订阅总线（插件 init 时调用；重复调用幂等）。 */
export function startWeChatCompanionBridge(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeWeChatMessages((msg) => {
    if (!loadConfig().companionBridge) return;
    if (!msg.contextToken) {
      // 没有回复凭证的消息（异常形态）进大脑也没法回发——跳过。
      log.debug(`wechat.companion 跳过无 contextToken 消息 from=${humanizeWeChatId(msg.fromUserId)}`);
      return;
    }
    chain = chain.then(() => runCompanionTurn(msg)).catch(() => { /* runCompanionTurn 自吞异常；此处兜底保证链不中断 */ });
  });
  log.debug('wechat.companion 桥已挂上总线');
}

/** 退订（插件 shutdown 时调用；在飞回合不等待——shutdown 有 4500ms 强杀约束）。 */
export function stopWeChatCompanionBridge(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
