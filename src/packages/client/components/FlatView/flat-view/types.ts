/**
 * FlatView / ChatView 的类型定义(props)。
 *
 * 自 index.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { AgentTerminalPane } from '../../ClaudeOutputPanel/AgentTerminalPane';
import { type ImageGalleryPick } from '../../ClaudeOutputPanel/imageGallery';
import { useKeyboardHeight } from '../../ClaudeOutputPanel/useKeyboardHeight';
import { ViewMode as TerminalViewMode } from '../../ClaudeOutputPanel/types';

export interface FlatViewProps {
  onAgentClick: (agentId: string) => void;
  onAgentDoubleClick?: (agentId: string) => void;
  onBuildingClick: (buildingId: string) => void;
  onBuildingDoubleClick?: (buildingId: string) => void;
  /** Open the floating BuildingActionPopup (boss/database/server etc.) anchored at the click. */
  onBuildingPopup?: (buildingId: string, screenPos: { x: number; y: number }) => void;
  onAreaClick?: (areaId: string) => void;
  /** Open the global area context menu — mirrors the right-click area menu used by 2D/3D scenes. */
  onAreaContextMenu?: (areaId: string, screenPos: { x: number; y: number }) => void;
  // Creation modal callbacks
  onOpenSpawnModal?: () => void;
  onOpenBossSpawnModal?: () => void;
  onOpenBuildingModal?: () => void;
  onOpenAreaModal?: () => void;
}

// ============================================================================
// Rich Chat View — reuses AgentTerminalPane from 3D view
// ============================================================================

export interface ChatViewProps {
  agentId: string;
  terminalViewMode: TerminalViewMode;
  onTerminalViewModeChange: (mode: TerminalViewMode) => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  /** Open the inspector on its Tracking tab (current-task banner click-through). */
  onShowTaskBoard: () => void;
  /** `gallery`: the conversation's images, so the viewer can browse prev/next. */
  onImageClick: (url: string, name: string, gallery?: ImageGalleryPick) => void;
  onFileClick: (path: string, editData?: any) => void;
  onBashClick: (command: string, output: string) => void;
  onViewMarkdown: (content: string) => void;
  onRequestClearSubordinates: (agentId: string, count: number) => void;
  keyboard: ReturnType<typeof useKeyboardHeight>;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  agentInfoOpen: boolean;
  onToggleAgentInfo: () => void;
  onHeaderContextMenu: (position: { x: number; y: number }) => void;
  /** Open the building context menu for an area-shortcut button — mirrors the
   * right-click menu on the empty-state map's building chips. */
  onBuildingContextMenu: (buildingId: string, position: { x: number; y: number }) => void;
}
