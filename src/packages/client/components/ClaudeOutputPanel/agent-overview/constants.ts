/**
 * AgentOverviewPanel 的常量(空数组占位 / 状态图标与颜色 / 状态文案 key)。
 *
 * 自 AgentOverviewPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type AgentMessageSummary } from './types';
import { type Agent, type Subagent } from '../../../../shared/types';
import { type ToolExecution } from '../../../store/types';
import { type IconName } from '../../Icon';

export const EMPTY_TOOL_EXECS: ToolExecution[] = [];

export const EMPTY_SUBAGENTS: Subagent[] = [];

export const EMPTY_SUBORDINATES: Agent[] = [];

export const STATUS_ICONS: Record<string, IconName> = {
  working: 'status-working',
  idle: 'status-idle',
  waiting_input: 'status-waiting-input',
  waiting_permission: 'status-waiting-permission',
  error: 'status-error',
  stopped: 'status-stopped',
};

export const STATUS_COLORS: Record<string, string> = {
  working: '#4ade80',
  idle: '#a78bfa',
  waiting_input: '#fbbf24',
  waiting_permission: '#fb923c',
  error: '#ef4444',
  stopped: '#9ca3af',
};

export const STATUS_LABEL_KEYS: Record<string, string> = {
  working: 'overview.statusLabels.working',
  idle: 'overview.statusLabels.idle',
  waiting_input: 'overview.statusLabels.waitingInput',
  waiting_permission: 'overview.statusLabels.waitingPermission',
  error: 'overview.statusLabels.error',
  stopped: 'overview.statusLabels.stopped',
};

export const EMPTY_MESSAGE_SUMMARY: AgentMessageSummary = { lastMessage: null, messageCount: 0 };
