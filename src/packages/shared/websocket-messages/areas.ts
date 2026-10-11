/**
 * 区域消息:同步与更新
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type DrawingArea } from '../common-types.js';

// ============================================================================
// Areas Messages
// ============================================================================

// Areas sync message (Server -> Client) - sent on connect and when areas change
export interface AreasUpdateMessage extends WSMessage {
  type: 'areas_update';
  payload: DrawingArea[];
}

// Sync areas message (Client -> Server) - sent when client modifies areas
export interface SyncAreasMessage extends WSMessage {
  type: 'sync_areas';
  payload: DrawingArea[];
}
