/**
 * 通知消息:代理通知 + WhatsApp 收信 + 聚焦代理 + 发送通知(技能)
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type AgentNotification } from '../common-types.js';

// ============================================================================
// Agent Notification Messages
// ============================================================================

// Agent notification message (Server -> Client)
export interface AgentNotificationMessage extends WSMessage {
  type: 'agent_notification';
  payload: AgentNotification;
}

// ============================================================================
// WhatsApp Message Received (Server -> Client)
// ============================================================================
// Pushed by the WhatsApp integration's upstream WS bridge whenever the
// whatsapp-api server delivers a 'message' or 'message_create' event.
// `direction` is 'outbound' when the message originated from the connected
// WhatsApp account (Baileys key.fromMe === true), 'inbound' otherwise.
export interface WhatsAppMessageReceivedMessage extends WSMessage {
  type: 'whatsapp_message';
  payload: {
    sessionId: string;
    from: string;
    fromName?: string;
    body: string;
    timestamp: number;
    isGroup: boolean;
    groupName?: string;
    mediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    mediaUrl?: string;
    direction: 'inbound' | 'outbound';
  };
}

// Focus agent request pushed by REST endpoint (Server -> Client)
export interface FocusAgentMessage extends WSMessage {
  type: 'focus_agent';
  payload: {
    agentId: string;
    openTerminal: boolean;
  };
}

// Send notification request (Client -> Server, from agent via skill)
export interface SendNotificationMessage extends WSMessage {
  type: 'send_notification';
  payload: {
    agentId: string;
    title: string;
    message: string;
    iconUrl?: string;
    imageUrl?: string;
  };
}
