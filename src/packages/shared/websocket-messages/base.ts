/**
 * 协议基座:WebSocket 消息基础接口 WSMessage(type + payload)
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */


// ============================================================================
// WebSocket Base
// ============================================================================

export interface WSMessage {
  type: string;
  payload?: unknown;
}
