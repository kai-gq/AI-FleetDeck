/**
 * AgentOverviewPanel 的类型定义(props / 排序筛选 / 卡片与分组 / 选择态)。
 *
 * 自 AgentOverviewPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import React from 'react';
import { store } from '../../../store';
import { type Agent, type Subagent, type DrawingArea, type CustomAgentClass } from '../../../../shared/types';
import { type ToolExecution, type ClaudeOutput } from '../../../store/types';
import { type TwoFingerSelectorState } from '../../../hooks/useTwoFingerSelector';

/** Persisted config shape for the overview panel */
export interface AopConfig {
  groupByArea: boolean;
  sortMode: SortMode;
  filterMode: FilterMode;
  sameAreaOnly: boolean; // only show agents in the same area as the active agent
  visibleAreaIds: string[] | null; // null = all areas visible; string[] = only these area IDs
  visibleProviders: string[] | null; // null = all runtimes visible; string[] = only these providers
}

export interface AgentOverviewPanelProps {
  activeAgentId: string;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  /** Mobile-only compact tray ↔ complete panel state. */
  mobileFull?: boolean;
  onToggleMobileFull?: () => void;
  /** External ref for the agent card list (used by the two-finger selector hook). */
  agentListRef?: React.RefObject<HTMLDivElement | null>;
  /** Two-finger selector state driven from the parent (GuakeOutputPanel). */
  twoFingerState?: TwoFingerSelectorState;
  /** Optional external control of which areas are expanded (all others render collapsed). */
  expandedAreas?: Set<string>;
  /** Optional external handler for area toggle. */
  onToggleArea?: (areaKey: string) => void;
  /** Optional bulk replace of the expanded set ([] collapses everything), exposed by surfaces that own expanded state. */
  onSetExpandedAreas?: (areaKeys: string[]) => void;
}

export type SortMode = 'name' | 'status' | 'recent';

export type FilterMode = 'all' | 'working' | 'idle' | 'error';

/** Cached card summary for an immutable per-agent output array. */
export interface AgentMessageSummary {
  lastMessage: ClaudeOutput | null;
  messageCount: number;
}

/** Context about why an agent matched a search query (for non-obvious matches) */
export interface SearchMatchContext {
  type: 'task' | 'file';
  text: string;
}

export interface AreaGroup {
  area: DrawingArea | null;
  agents: Agent[];
}

// ── Area group section ──
// One `.aop-area-group` (header + optional prompt editor + cards). Memoized so
// that, on an agent update, only the section whose `group` object changed
// rebuilds its element tree — element creation for every group on every
// update was ~80% of the panel's render time.
export interface AreaGroupSectionProps {
  group: AreaGroup;
  groupByArea: boolean;
  isCollapsed: boolean;
  unassignedLabel: string;
  isEditingPrompt: boolean;
  /** '' unless this section is the one being edited (keeps the prop stable). */
  editingPromptText: string;
  setEditingPromptText: (text: string) => void;
  setEditingPromptAreaId: (areaId: string | null) => void;
  toggleArea: (areaKey: string) => void;
  openAreaContextMenu: (area: DrawingArea, position: { x: number; y: number }) => void;
  toggleAreaVisibility: (areaId: string) => void;
  renderAgentCards: (groupAgents: Agent[]) => React.ReactNode;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface AgentCardSelectionState {
  activeAgentId: string;
  subordinateAgentIds: Set<string> | null;
  subordinateLabel: string;
}

export interface AgentCardProps {
  agent: Agent;
  isExpanded: boolean;
  isMobile: boolean;
  hasPendingRead: boolean;
  isTwoFingerHovered: boolean;
  showAreaChip: boolean;
  toolExecs: ToolExecution[];
  subagents: Subagent[];
  subordinates: Agent[];
  areaInfo?: { color: string; name: string };
  matchContext?: SearchMatchContext;
  customClasses: CustomAgentClass[];
  isCompacting: boolean;
  onSelect: (agentId: string) => void;
  onClearContext: (agentId: string) => void;
  onContextMenu: (agentId: string, position: { x: number; y: number }) => void;
}

/** Unified subagent entry combining live store data and tool execution history */
export interface SubagentEntry {
  id: string;
  name: string;
  type: string;
  description?: string;
  status: 'working' | 'spawning' | 'completed' | 'failed' | 'unknown';
  timestamp: number;
}
