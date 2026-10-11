/**
 * PM2 日志流式消息:分块/流状态/启停
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';

// ============================================================================
// PM2 Log Streaming Messages
// ============================================================================

// Start streaming logs (Client -> Server)
export interface PM2LogsStartMessage extends WSMessage {
  type: 'pm2_logs_start';
  payload: {
    buildingId: string;
    lines?: number; // Initial lines to fetch (default 100)
  };
}

// Stop streaming logs (Client -> Server)
export interface PM2LogsStopMessage extends WSMessage {
  type: 'pm2_logs_stop';
  payload: {
    buildingId: string;
  };
}

// Log chunk from streaming (Server -> Client)
export interface PM2LogsChunkMessage extends WSMessage {
  type: 'pm2_logs_chunk';
  payload: {
    buildingId: string;
    chunk: string;
    timestamp: number;
    isError?: boolean; // stderr vs stdout
  };
}

// Streaming started confirmation (Server -> Client)
export interface PM2LogsStreamingMessage extends WSMessage {
  type: 'pm2_logs_streaming';
  payload: {
    buildingId: string;
    streaming: boolean;
  };
}
