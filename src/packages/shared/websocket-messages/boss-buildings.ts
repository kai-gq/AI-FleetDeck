/**
 * 主管-建筑关联消息:日志分块/下属更新/建筑指派
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';

// ============================================================================
// Boss Building Messages
// ============================================================================

// Boss building bulk command message (Client -> Server) - start all/stop all/restart all
export interface BossBuildingCommandMessage extends WSMessage {
  type: 'boss_building_command';
  payload: {
    buildingId: string;  // The boss building ID
    command: 'start_all' | 'stop_all' | 'restart_all';
  };
}

// Assign buildings to boss (Client -> Server)
export interface AssignBuildingsMessage extends WSMessage {
  type: 'assign_buildings';
  payload: {
    bossBuildingId: string;
    subordinateBuildingIds: string[];
  };
}

// Request unified logs from boss building (Client -> Server)
export interface BossBuildingLogsStartMessage extends WSMessage {
  type: 'boss_building_logs_start';
  payload: {
    buildingId: string;  // The boss building ID
    lines?: number;      // Initial lines to fetch per subordinate (default 50)
  };
}

// Stop streaming unified logs (Client -> Server)
export interface BossBuildingLogsStopMessage extends WSMessage {
  type: 'boss_building_logs_stop';
  payload: {
    buildingId: string;
  };
}

// Unified log chunk from boss building (Server -> Client)
export interface BossBuildingLogsChunkMessage extends WSMessage {
  type: 'boss_building_logs_chunk';
  payload: {
    bossBuildingId: string;
    subordinateBuildingId: string;
    subordinateBuildingName: string;
    chunk: string;
    timestamp: number;
    isError?: boolean;
  };
}

// Boss building subordinates updated (Server -> Client)
export interface BossBuildingSubordinatesUpdatedMessage extends WSMessage {
  type: 'boss_building_subordinates_updated';
  payload: {
    bossBuildingId: string;
    subordinateBuildingIds: string[];
  };
}
