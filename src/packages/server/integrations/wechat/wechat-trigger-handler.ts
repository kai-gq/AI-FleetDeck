/**
 * WeChat ClawBot In-Process Trigger Bridge
 *
 * Mirror of the WhatsApp three-part pattern: the connection loop (see
 * wechat-connection.ts) normalizes inbound iLink messages and rebroadcasts
 * them through a module-level subscriber bus; the trigger-service-facing
 * `wechatTriggerHandler` below subscribes on startListening and stays
 * attached across connection restarts.
 *
 * Unlike WhatsApp there is no upstream websocket — the connection loop IS the
 * bridge (in-process iLink long-poll).
 */

import type {
  TriggerHandler,
  TriggerDefinition,
  ExternalEvent,
} from '../../../shared/integration-types.js';
import type { WeChatTrigger } from '../../../shared/trigger-types.js';
import { loadConfig } from './wechat-config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('WeChatTrigger');

export interface NormalizedWeChatMessage {
  /** Sender id, e.g. xxx@im.wechat */
  fromUserId: string;
  /** Display name when one can be resolved (protocol field or alias table). */
  fromName?: string;
  /** Message body — typed text, or the cloud transcription for voice notes. */
  body: string;
  /** Set (and equal to body) when the message arrived as a voice note. */
  voiceTranscription?: string;
  /** Reply token from the inbound message — REQUIRED to answer this message. */
  contextToken?: string;
  messageId?: string;
  timestamp: number;
  /** item.type values (1 text / 2 image / 3 voice / 4 file / 5 video). */
  itemTypes: number[];
  direction: 'inbound';
  raw: Record<string, unknown>;
}

// Module-level subscriber set fed by the connection loop on every normalized
// message. The trigger-service-facing handler registers its callback here so
// subscribers stay attached even when the connection restarts.
const triggerSubscribers = new Set<(msg: NormalizedWeChatMessage) => void>();

export function notifyWeChatSubscribers(payload: NormalizedWeChatMessage): void {
  for (const cb of triggerSubscribers) {
    try {
      cb(payload);
    } catch (err) {
      // Subscriber errors must not break the loop — log and swallow.
      log.warn(`wechat.trigger subscriber error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── Display-name resolution (three-layer fallback) ───

/**
 * Last-resort display for a WeChat id: never show the raw openid — mask the
 * middle. `a1b2c3d4e5f6g7h8@im.wechat` → `a1b2c3…g7h8`.
 */
export function humanizeWeChatId(id: string): string {
  const local = (id || '').split('@')[0] || id || '';
  if (local.length <= 10) return local;
  return `${local.slice(0, 6)}…${local.slice(-4)}`;
}

/** Protocol-field candidates for a sender nickname (spellings pending S0). */
function pickNameFromRaw(raw: Record<string, unknown>): string | undefined {
  for (const key of ['from_name', 'fromName', 'sender_name', 'nickname', 'nick_name', 'name', 'remark']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Layer 1: protocol field → Layer 2: config aliases → undefined (caller falls back to humanize). */
export function resolveWeChatDisplayName(msg: NormalizedWeChatMessage): string | undefined {
  const fromRaw = msg.fromName?.trim() || pickNameFromRaw(msg.raw);
  if (fromRaw && fromRaw !== msg.fromUserId) return fromRaw;
  const alias = loadConfig().aliases?.[msg.fromUserId];
  if (alias?.trim()) return alias.trim();
  return undefined;
}

/** True only when every item is media-less and the body is blank. */
export function isEmptyWeChatContent(msg: NormalizedWeChatMessage): boolean {
  const bodyEmpty = !msg.body || msg.body.trim().length === 0;
  const noMedia = !msg.itemTypes.some((t) => t !== 1);
  return bodyEmpty && noMedia;
}

function isWeChatGroupMessage(msg: NormalizedWeChatMessage): boolean {
  // ClawBot is DM-only today; group markers are unconfirmed protocol fields.
  // TODO(S0): confirm group spellings; default false keeps dmOnly a no-op.
  const raw = msg.raw;
  for (const key of ['is_group', 'isGroup']) {
    if (raw[key] === true) return true;
  }
  const chatId = raw['chat_id'] ?? raw['chatId'];
  return typeof chatId === 'string' && (chatId.includes('@group') || chatId.includes('@chatroom'));
}

// ─── TriggerHandler ───

const MEDIA_LABELS: Record<number, string> = {
  2: 'image',
  3: 'voice',
  4: 'file',
  5: 'video',
};

let triggerUnsubscribe: (() => void) | null = null;

export const wechatTriggerHandler: TriggerHandler = {
  triggerType: 'wechat',

  async startListening(onEvent) {
    const cb = (msg: NormalizedWeChatMessage) => {
      onEvent({
        source: 'wechat',
        type: 'message',
        data: msg,
        timestamp: msg.timestamp,
      });
    };
    triggerSubscribers.add(cb);
    triggerUnsubscribe = () => triggerSubscribers.delete(cb);
  },

  async stopListening() {
    if (triggerUnsubscribe) {
      triggerUnsubscribe();
      triggerUnsubscribe = null;
    }
  },

  structuralMatch(trigger: TriggerDefinition, event: ExternalEvent): boolean {
    const msg = event.data as NormalizedWeChatMessage;
    const cfg = trigger.config as WeChatTrigger['config'];

    if (isEmptyWeChatContent(msg)) {
      log.debug(`wechat.trigger.skipped reason=empty_content from=${msg.fromUserId}`);
      return false;
    }

    const fromLower = (msg.fromUserId || '').toLowerCase();
    // excludeFrom wins over fromFilter (evaluated first).
    if (cfg.excludeFrom?.length) {
      if (cfg.excludeFrom.some((f) => fromLower.includes(f.toLowerCase()))) return false;
    }
    if (cfg.fromFilter?.length) {
      if (!cfg.fromFilter.some((f) => fromLower.includes(f.toLowerCase()))) return false;
    }
    if (cfg.dmOnly && isWeChatGroupMessage(msg)) return false;
    if (cfg.onlyWithContextToken && !msg.contextToken) return false;
    if (cfg.bodyPattern) {
      try {
        if (!new RegExp(cfg.bodyPattern, 'i').test(msg.body)) return false;
      } catch {
        return false;
      }
    }

    return true;
  },

  extractVariables(trigger: TriggerDefinition, event: ExternalEvent): Record<string, string> {
    const msg = event.data as NormalizedWeChatMessage;
    void trigger;
    const fromName = resolveWeChatDisplayName(msg) ?? humanizeWeChatId(msg.fromUserId);

    const mediaBlock = msg.itemTypes
      .filter((t) => t !== 1)
      .map((t) => `[wechat attachment: ${MEDIA_LABELS[t] ?? `type-${t}`}]`)
      .join('\n');

    return {
      'wechat.from': msg.fromUserId,
      'wechat.fromName': fromName,
      'wechat.body': msg.body,
      'wechat.contextToken': msg.contextToken ?? '',
      'wechat.hasContextToken': String(!!msg.contextToken),
      'wechat.messageId': msg.messageId ?? '',
      'wechat.toUserId': String(msg.raw['to_user_id'] ?? msg.raw['toUserId'] ?? ''),
      'wechat.itemTypes': msg.itemTypes.join(','),
      'wechat.voiceTranscription': msg.voiceTranscription ?? '',
      'wechat.mediaBlock': mediaBlock,
      'wechat.timestamp': new Date(msg.timestamp).toISOString(),
    };
  },

  formatEventForLLM(event: ExternalEvent): string {
    const msg = event.data as NormalizedWeChatMessage;
    const name = resolveWeChatDisplayName(msg) ?? humanizeWeChatId(msg.fromUserId);
    const lines = [
      'WeChat DM received',
      `From: ${name} (${msg.fromUserId})`,
      `Time: ${new Date(msg.timestamp).toISOString()}`,
      `Reply token: ${msg.contextToken ? 'present ({{wechat.contextToken}})' : 'MISSING — cannot reply to this message'}`,
    ];
    let suffix = '';
    if (msg.voiceTranscription) {
      suffix += `\n[voice transcription: ${msg.voiceTranscription}]`;
    }
    const media = msg.itemTypes.filter((t) => t !== 1);
    if (media.length) {
      suffix += `\n[attachments: ${media.map((t) => MEDIA_LABELS[t] ?? `type-${t}`).join(', ')}]`;
    }
    return `${lines.join('\n')}\n\n${msg.body}${suffix}`;
  },
};
