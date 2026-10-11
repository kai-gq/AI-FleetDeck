/**
 * 建筑消息:同步/增删改/日志/容器
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type Building } from '../building-types.js';

// ============================================================================
// Building Messages
// ============================================================================

// Buildings sync message (Server -> Client)
export interface BuildingsUpdateMessage extends WSMessage {
  type: 'buildings_update';
  payload: Building[];
}

// Building created message (Server -> Client)
export interface BuildingCreatedMessage extends WSMessage {
  type: 'building_created';
  payload: Building;
}

// Building updated message (Server -> Client)
export interface BuildingUpdatedMessage extends WSMessage {
  type: 'building_updated';
  payload: Building;
}

// Building deleted message (Server -> Client)
export interface BuildingDeletedMessage extends WSMessage {
  type: 'building_deleted';
  payload: { id: string };
}

// Building logs message (Server -> Client)
export interface BuildingLogsMessage extends WSMessage {
  type: 'building_logs';
  payload: {
    buildingId: string;
    logs: string;
    timestamp: number;
  };
}

// Sync buildings message (Client -> Server)
export interface SyncBuildingsMessage extends WSMessage {
  type: 'sync_buildings';
  payload: Building[];
}

// Building command message (Client -> Server) - start/stop/restart/logs/delete
export interface BuildingCommandMessage extends WSMessage {
  type: 'building_command';
  payload: {
    buildingId: string;
    command: 'start' | 'stop' | 'restart' | 'healthCheck' | 'logs' | 'delete';
  };
}
