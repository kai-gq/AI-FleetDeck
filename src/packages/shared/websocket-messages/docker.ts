/**
 * Docker 日志流式消息:分块/流状态/容器列表
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type ExistingDockerContainer, type ExistingComposeProject } from '../building-types.js';

// ============================================================================
// Docker Log Streaming Messages
// ============================================================================

// Start streaming Docker logs (Client -> Server)
export interface DockerLogsStartMessage extends WSMessage {
  type: 'docker_logs_start';
  payload: {
    buildingId: string;
    lines?: number; // Initial lines to fetch (default 100)
    service?: string; // For compose mode: specific service to stream
  };
}

// Stop streaming Docker logs (Client -> Server)
export interface DockerLogsStopMessage extends WSMessage {
  type: 'docker_logs_stop';
  payload: {
    buildingId: string;
  };
}

// Docker log chunk from streaming (Server -> Client)
export interface DockerLogsChunkMessage extends WSMessage {
  type: 'docker_logs_chunk';
  payload: {
    buildingId: string;
    chunk: string;
    timestamp: number;
    isError?: boolean; // stderr vs stdout
    service?: string; // For compose mode: which service this log is from
  };
}

// Docker streaming started confirmation (Server -> Client)
export interface DockerLogsStreamingMessage extends WSMessage {
  type: 'docker_logs_streaming';
  payload: {
    buildingId: string;
    streaming: boolean;
  };
}

// Request list of existing Docker containers (Client -> Server)
export interface DockerListContainersMessage extends WSMessage {
  type: 'docker_list_containers';
  payload: Record<string, never>; // Empty payload
}

// Response with list of existing containers (Server -> Client)
export interface DockerContainersListMessage extends WSMessage {
  type: 'docker_containers_list';
  payload: {
    containers: ExistingDockerContainer[];
    composeProjects: ExistingComposeProject[];
  };
}
