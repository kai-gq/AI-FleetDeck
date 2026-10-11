/**
 * FlatView - Flat UI layout with 3-column design
 *
 * Layout:
 * - Left sidebar: Navigation menu (settings, commander, etc.)
 * - Middle column: Agents, buildings, and areas
 * - Right column: Selected agent's chat view
 * 类型 / 常量 / 助手与 ChatView 已拆入 ./flat-view/(2026-10-11 W2 拆分);
 * 本文件保留 FlatView 主组件与对外导出。
 */

// ============================================================================
// 模块拆分(W2,2026-10-11):类型 / 常量 / 助手与 ChatView 已拆入 ./flat-view/;
// 本文件保留 FlatView 主组件(及空分组常量),导出面不变。
// ============================================================================

import { type FlatViewProps } from './flat-view/types';
import { FLAT_SPLITTER_WIDTH, FLAT_AGENTS_MIN_WIDTH, FLAT_RIGHT_MIN_WIDTH, FLAT_INSPECTOR_MIN_WIDTH, FLAT_LEFT_GUTTER } from './flat-view/constants';
import { ChatView } from './flat-view/chat-view';
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentsArrayWhen, useAgentIds, useSelectedAgentIds, useAgent, useAreas, useBuildings } from '../../store/selectors';
import { store } from '../../store';
import { ConfirmModal } from '../shared/ConfirmModal';
import { Agent, DrawingArea } from '../../../shared/types';
import { ProviderIcon } from '../ProviderIcon';
import { Building } from '../../../shared/building-types';
import { BUILDING_TYPES } from '../../../shared/building-types';
import { AgentIcon } from '../AgentIcon';
import { Icon } from '../Icon';
import { getBuildingTypeIcon } from '../DashboardView/utils';
import { getAreaLogoUrl } from '../../api/area-logos';
import { TaskProgressDots } from '../shared/TaskProgressDots';
import { SubordinateProgressDots } from '../shared/SubordinateProgressDots';
import { AgentHoverTooltip } from '../shared/AgentHoverTooltip';
import { ActivityGlyph } from '../shared/ActivityGlyph';
import { ContextMenu, type ContextMenuAction } from '../ContextMenu';
import { getAgentStatusColor, getBuildingStatusColor } from '../../utils/colors';
import { getDisplayContextInfo } from '../../utils/context';
import { AgentOverviewPanel } from '../ClaudeOutputPanel/AgentOverviewPanel';
import { useImageGalleryModal } from '../ClaudeOutputPanel/imageGallery';
import { AreaBuildingsPanel } from '../ClaudeOutputPanel/AreaBuildingsPanel';
import { ContextConfirmModal, ImageModal, BashModal, AgentInfoModal, AgentResponseModalWrapper, type BashModalState } from '../ClaudeOutputPanel/TerminalModals';
import { useModalStackRegistration } from '../../hooks/useModalStack';
import { useKeyboardHeight } from '../ClaudeOutputPanel/useKeyboardHeight';
import { SingleAgentPanel } from '../UnitPanel/SingleAgentPanel';
import { TrackingBoard } from '../ClaudeOutputPanel/TrackingBoard';
import { useWorkspaceFilter, isAgentVisibleInWorkspace, isAreaVisibleInWorkspace } from '../WorkspaceSwitcher';
import { ViewMode as TerminalViewMode } from '../ClaudeOutputPanel/types';
import { ViewModeToggle } from '../ViewModeToggle/ViewModeToggle';
import { useAndroidBackButton } from '../../hooks';
import { getStorageBoolean, setStorageBoolean, getStorageString, setStorageString, getStorageNumber, setStorageNumber, STORAGE_KEYS } from '../../utils/storage';
import './FlatView.scss';

// Stable empty result for the emptyChatGroups memo while a chat is open — the
// empty-state map isn't rendered then, so the grouping work can be skipped.
const EMPTY_FLAT_MAP_GROUPS: {
  groups: { area: DrawingArea; agents: Agent[]; buildings: Building[] }[];
  gridCols: number;
  gridRows: number;
  positions: Map<string, { row: number; col: number }>;
} = { groups: [], gridCols: 1, gridRows: 1, positions: new Map() };

export function FlatView({
  onAgentClick,
  onBuildingClick,
  onBuildingDoubleClick,
  onBuildingPopup,
  onAreaContextMenu,
  onOpenSpawnModal,
  onOpenBossSpawnModal,
  onOpenAreaModal,
}: FlatViewProps) {
  const { t } = useTranslation(['common']);
  const selectedAgentIds = useSelectedAgentIds();
  const selectedAgentId = useMemo(() => {
    return selectedAgentIds.size > 0 ? selectedAgentIds.values().next().value ?? null : null;
  }, [selectedAgentIds]);
  // The all-agent map is only rendered by the empty-chat map. While a chat is
  // open, subscribing to every agent object made unrelated status/context
  // updates rebuild this entire 3,400-line component.
  const agents = useAgentsArrayWhen(selectedAgentId === null);
  const agentIds = useAgentIds();

  // Modal state for terminal integration (owned by parent, shown over everything)
  const { imageModal, openImage, navigateImage, closeImage } = useImageGalleryModal();
  const [bashModal, setBashModal] = useState<BashModalState | null>(null);
  const [responseModalContent, setResponseModalContent] = useState<string | null>(null);

  // Register the image modal on the shared modal stack so ESC (handled globally
  // in useKeyboardShortcuts → closeTopModal) closes it, matching AgentPanel.
  useModalStackRegistration('flatview-image-modal', imageModal !== null, closeImage);
  // Clear-subordinates confirmation modal — reuses the same modal component
  // the 3D overlay uses, so the two views share one source of truth for the
  // destructive action's UX.
  const [clearSubsModal, setClearSubsModal] = useState<{ agentId: string; count: number } | null>(null);
  // Right-click menu on agent chips in the empty-state overview (no selected agent).
  const [emptyAgentContextMenu, setEmptyAgentContextMenu] = useState<{
    agentId: string;
    position: { x: number; y: number };
  } | null>(null);
  // Right-click menu on building chips in the empty-state overview. Mirrors the
  // AreaBuildingsPanel actions (open / start-stop / edit / clone / delete).
  const [buildingContextMenu, setBuildingContextMenu] = useState<{
    buildingId: string;
    position: { x: number; y: number };
  } | null>(null);
  // Remove-agent confirmation modal — replaces the native window.confirm() the
  // delete action used to trigger so the dialog matches the rest of the app.
  const [removeAgentConfirm, setRemoveAgentConfirm] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  // Standby (待岗) confirmation — reversible deactivation; restoring is immediate.
  const [standbyConfirm, setStandbyConfirm] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  // Agent info modal — opened by clicking the agent avatar/name in the chat
  // header, mirroring the Guake terminal's guake-title-btn behavior.
  const [agentInfoOpen, setAgentInfoOpen] = useState(false);
  const handleToggleAgentInfo = useCallback(() => {
    setAgentInfoOpen((prev) => !prev);
  }, []);
  const handleCloseAgentInfo = useCallback(() => {
    setAgentInfoOpen(false);
  }, []);

  // Terminal view-mode (simple/chat/advanced). Shared with the 3D overlay via
  // STORAGE_KEYS.VIEW_MODE so users don't have to re-configure their preference.
  const [terminalViewMode, setTerminalViewModeState] = useState<TerminalViewMode>(() => {
    const saved = getStorageString(STORAGE_KEYS.VIEW_MODE);
    if (saved === 'simple' || saved === 'chat' || saved === 'advanced') {
      return saved;
    }
    return 'simple';
  });

  // Persist changes and keep in sync if another surface (3D overlay) updates it.
  const handleTerminalViewModeChange = useCallback((mode: TerminalViewMode) => {
    setTerminalViewModeState(mode);
    setStorageString(STORAGE_KEYS.VIEW_MODE, mode);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.VIEW_MODE) return;
      const value = event.newValue;
      if (value === 'simple' || value === 'chat' || value === 'advanced') {
        setTerminalViewModeState(value);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Inspector side-panel state (pushes the chat column rather than overlaying)
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() =>
    getStorageBoolean(STORAGE_KEYS.FLAT_INSPECTOR_OPEN, false)
  );

  // Mobile-only: agents column renders as a slide-in drawer. The toggle
  // button is only visible below the CSS mobile breakpoint, but the state
  // lives here so the drawer can be closed programmatically (e.g. after an
  // agent is tapped from inside it).
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileSidebarFull, setMobileSidebarFull] = useState(() =>
    getStorageBoolean(STORAGE_KEYS.FLAT_MOBILE_SIDEBAR_FULL, false)
  );
  const toggleMobileSidebar = useCallback(() => setMobileSidebarOpen((prev) => !prev), []);
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);
  const toggleMobileSidebarFull = useCallback(() => {
    setMobileSidebarFull((full) => {
      const next = !full;
      setStorageBoolean(STORAGE_KEYS.FLAT_MOBILE_SIDEBAR_FULL, next);
      return next;
    });
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tide-flat-agents-drawer-state', { detail: { open: mobileSidebarOpen } }));
  }, [mobileSidebarOpen]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tide-flat-inspector-state', { detail: { open: inspectorOpen } }));
  }, [inspectorOpen]);

  useEffect(() => {
    const onToggleAgents = () => setMobileSidebarOpen((prev) => !prev);
    const onToggleInspectorEvt = () => {
      setInspectorOpen((prev) => {
        const next = !prev;
        setStorageBoolean(STORAGE_KEYS.FLAT_INSPECTOR_OPEN, next);
        return next;
      });
    };
    const onCloseSideViews = () => {
      setMobileSidebarOpen(false);
      setInspectorOpen(false);
      setStorageBoolean(STORAGE_KEYS.FLAT_INSPECTOR_OPEN, false);
    };
    const onCloseAgentsDrawerOnly = () => setMobileSidebarOpen(false);
    const onCloseInspectorOnly = () => {
      setInspectorOpen(false);
      setStorageBoolean(STORAGE_KEYS.FLAT_INSPECTOR_OPEN, false);
    };
    window.addEventListener('tide-toggle-flat-agents-drawer', onToggleAgents);
    window.addEventListener('tide-toggle-flat-inspector', onToggleInspectorEvt);
    window.addEventListener('tide-close-flat-side-views', onCloseSideViews);
    window.addEventListener('tide-close-flat-agents-drawer-only', onCloseAgentsDrawerOnly);
    window.addEventListener('tide-close-flat-inspector-only', onCloseInspectorOnly);
    return () => {
      window.removeEventListener('tide-toggle-flat-agents-drawer', onToggleAgents);
      window.removeEventListener('tide-toggle-flat-inspector', onToggleInspectorEvt);
      window.removeEventListener('tide-close-flat-side-views', onCloseSideViews);
      window.removeEventListener('tide-close-flat-agents-drawer-only', onCloseAgentsDrawerOnly);
      window.removeEventListener('tide-close-flat-inspector-only', onCloseInspectorOnly);
    };
  }, []);

  // Desktop/tablet: user-resizable widths for the .flat-middle (agents) and
  // .flat-inspector (right-side details) columns. `null` = use the responsive
  // CSS default; a number is a pixel override applied via a CSS custom
  // property inline on .flat-view so media queries for mobile still win.
  const flatViewRef = useRef<HTMLDivElement>(null);
  const splitterDragRef = useRef<{
    kind: 'middle' | 'inspector';
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);
  const [middleWidth, setMiddleWidth] = useState<number | null>(() => {
    const saved = getStorageNumber(STORAGE_KEYS.FLAT_MIDDLE_WIDTH, 0);
    return saved >= FLAT_AGENTS_MIN_WIDTH ? saved : null;
  });
  const [inspectorWidth, setInspectorWidth] = useState<number | null>(() => {
    const saved = getStorageNumber(STORAGE_KEYS.FLAT_INSPECTOR_WIDTH, 0);
    return saved >= FLAT_INSPECTOR_MIN_WIDTH ? saved : null;
  });

  // Clamp helpers — the max for each column depends on the other columns'
  // current widths so neither can push the chat column below its min.
  const clampMiddleWidth = useCallback((w: number): number => {
    if (typeof window === 'undefined') return w;
    const inspectorCost =
      inspectorWidth !== null ? FLAT_SPLITTER_WIDTH + inspectorWidth : 0;
    const maxWidth =
      window.innerWidth - FLAT_LEFT_GUTTER - FLAT_SPLITTER_WIDTH - FLAT_RIGHT_MIN_WIDTH - inspectorCost;
    return Math.max(FLAT_AGENTS_MIN_WIDTH, Math.min(Math.max(maxWidth, FLAT_AGENTS_MIN_WIDTH), w));
  }, [inspectorWidth]);

  const clampInspectorWidth = useCallback((w: number): number => {
    if (typeof window === 'undefined') return w;
    const middle = flatViewRef.current?.querySelector<HTMLElement>('.flat-middle');
    const middleActual = middle?.getBoundingClientRect().width ?? FLAT_AGENTS_MIN_WIDTH;
    const maxWidth =
      window.innerWidth - FLAT_LEFT_GUTTER - middleActual - FLAT_SPLITTER_WIDTH - FLAT_RIGHT_MIN_WIDTH - FLAT_SPLITTER_WIDTH;
    return Math.max(FLAT_INSPECTOR_MIN_WIDTH, Math.min(Math.max(maxWidth, FLAT_INSPECTOR_MIN_WIDTH), w));
  }, []);

  // Re-clamp persisted widths if the viewport gets smaller (e.g. window
  // resize). Without this, stored values that no longer fit could hide the
  // chat column entirely.
  useEffect(() => {
    if (middleWidth === null && inspectorWidth === null) return;
    const onResize = () => {
      setMiddleWidth(prev => {
        if (prev === null) return prev;
        const clamped = clampMiddleWidth(prev);
        return clamped === prev ? prev : clamped;
      });
      setInspectorWidth(prev => {
        if (prev === null) return prev;
        const clamped = clampInspectorWidth(prev);
        return clamped === prev ? prev : clamped;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [middleWidth, inspectorWidth, clampMiddleWidth, clampInspectorWidth]);

  const handleMiddleSplitterPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const middle = flatViewRef.current?.querySelector<HTMLElement>('.flat-middle');
    if (!middle) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    splitterDragRef.current = {
      kind: 'middle',
      startX: e.clientX,
      startWidth: middle.getBoundingClientRect().width,
      pointerId: e.pointerId,
    };
    document.body.classList.add('flat-splitter-dragging');
  }, []);

  const handleInspectorSplitterPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const inspector = flatViewRef.current?.querySelector<HTMLElement>('.flat-inspector');
    if (!inspector) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    splitterDragRef.current = {
      kind: 'inspector',
      startX: e.clientX,
      startWidth: inspector.getBoundingClientRect().width,
      pointerId: e.pointerId,
    };
    document.body.classList.add('flat-splitter-dragging');
  }, []);

  const handleSplitterPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = splitterDragRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    const deltaX = e.clientX - state.startX;
    if (state.kind === 'middle') {
      setMiddleWidth(clampMiddleWidth(state.startWidth + deltaX));
    } else {
      // Inspector sits at the right edge — dragging its handle LEFT (negative
      // deltaX) widens it, dragging RIGHT narrows it.
      setInspectorWidth(clampInspectorWidth(state.startWidth - deltaX));
    }
  }, [clampMiddleWidth, clampInspectorWidth]);

  const handleSplitterPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = splitterDragRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    splitterDragRef.current = null;
    document.body.classList.remove('flat-splitter-dragging');
    // Skip persistence for a pure click with no drag — the user is probably
    // double-clicking to reset, and a stray persist-on-pointerup would
    // overwrite the reset's "0" between the 2nd click and the dblclick event.
    const moved = Math.abs(e.clientX - state.startX) > 2;
    if (!moved) return;
    // Compute the final width from the same delta math as pointermove so we
    // can write storage directly (no setState updater side effect).
    const deltaX = e.clientX - state.startX;
    if (state.kind === 'middle') {
      const final = clampMiddleWidth(state.startWidth + deltaX);
      setMiddleWidth(final);
      setStorageNumber(STORAGE_KEYS.FLAT_MIDDLE_WIDTH, final);
    } else {
      const final = clampInspectorWidth(state.startWidth - deltaX);
      setInspectorWidth(final);
      setStorageNumber(STORAGE_KEYS.FLAT_INSPECTOR_WIDTH, final);
    }
  }, [clampMiddleWidth, clampInspectorWidth]);

  const handleMiddleSplitterDoubleClick = useCallback(() => {
    setMiddleWidth(null);
    setStorageNumber(STORAGE_KEYS.FLAT_MIDDLE_WIDTH, 0);
  }, []);

  const handleInspectorSplitterDoubleClick = useCallback(() => {
    setInspectorWidth(null);
    setStorageNumber(STORAGE_KEYS.FLAT_INSPECTOR_WIDTH, 0);
  }, []);

  // Inspector tab — matches the traditional sidebar's Agents/Tracking toggle.
  const [inspectorView, setInspectorViewState] = useState<'agent' | 'tracking'>(() => {
    const saved = getStorageString(STORAGE_KEYS.FLAT_INSPECTOR_VIEW);
    return saved === 'tracking' ? 'tracking' : 'agent';
  });

  const setInspectorView = useCallback((view: 'agent' | 'tracking') => {
    setInspectorViewState(view);
    setStorageString(STORAGE_KEYS.FLAT_INSPECTOR_VIEW, view);
  }, []);

  const handleToggleInspector = useCallback(() => {
    setInspectorOpen((prev) => {
      const next = !prev;
      setStorageBoolean(STORAGE_KEYS.FLAT_INSPECTOR_OPEN, next);
      return next;
    });
  }, []);

  const handleCloseInspector = useCallback(() => {
    setInspectorOpen(false);
    setStorageBoolean(STORAGE_KEYS.FLAT_INSPECTOR_OPEN, false);
  }, []);

  // Current-task banner click-through: open the inspector on its Tracking tab
  // (the Flat view's equivalent of the guake terminal's TrackingBoard toggle).
  const handleShowTaskBoard = useCallback(() => {
    setInspectorView('tracking');
    setInspectorOpen(true);
    setStorageBoolean(STORAGE_KEYS.FLAT_INSPECTOR_OPEN, true);
  }, [setInspectorView]);

  // Shared keyboard-height hook for mobile (must be stable across rerenders)
  const keyboard = useKeyboardHeight();

  // Modal callbacks for the terminal pane
  const handleImageClick = openImage;

  const handleBashClick = useCallback((command: string, output: string) => {
    setBashModal({ command, output, isLive: false });
  }, []);

  const handleFileClick = useCallback((path: string, editData?: any) => {
    // Reuse the global file-viewer flow from the store. Resolve relative paths
    // against the CWD of the agent whose chat is open (ChatView is scoped to the
    // selected agent) so a path like `tide-api/src/api-core.js` anchors at that
    // agent's repo — NOT the commander's process.cwd(), which is the wrong base
    // and produced the "Tried N candidate locations" miss.
    const ownerId = selectedAgentIds.size > 0 ? Array.from(selectedAgentIds)[0] : null;
    const cwd = ownerId ? store.getState().agents.get(ownerId)?.cwd : undefined;
    store.setFileViewerPath(path, editData, cwd);
  }, [selectedAgentIds]);

  const handleViewMarkdown = useCallback((content: string) => {
    setResponseModalContent(content);
  }, []);

  const handleRequestClearSubordinates = useCallback((agentId: string, count: number) => {
    setClearSubsModal({ agentId, count });
  }, []);

  const handleOpenBuilding = useCallback((buildingId: string) => {
    // Delegate to the app-level double-click handler so the appropriate modal
    // (PM2 logs, database panel, file explorer, etc.) opens based on the
    // building's type — identical to what happens when the user double-clicks
    // a building in the 3D scene.
    if (onBuildingDoubleClick) {
      onBuildingDoubleClick(buildingId);
    } else {
      onBuildingClick(buildingId);
    }
  }, [onBuildingClick, onBuildingDoubleClick]);

  // Stable context-menu handlers for ChatView — inline lambdas here would be
  // the only unstable props and would defeat its React.memo on every render.
  const handleHeaderContextMenu = useCallback((position: { x: number; y: number }) => {
    if (!selectedAgentId) return;
    setEmptyAgentContextMenu({ agentId: selectedAgentId, position });
  }, [selectedAgentId]);

  const handleBuildingContextMenuOpen = useCallback((buildingId: string, position: { x: number; y: number }) => {
    setBuildingContextMenu({ buildingId, position });
  }, []);

  // Close the agent-info modal whenever the selected agent changes so it
  // doesn't linger on top of a different agent's chat.
  useEffect(() => {
    setAgentInfoOpen(false);
  }, [selectedAgentId]);

  // Agent history navigation — mirrors GuakeOutputPanel agent history so Flat
  // view users get the same browser-style back/forward through selected agents.
  const agentNavigationHistoryRef = useRef<string[]>([]);
  const agentNavigationIndexRef = useRef(-1);
  const isHistoryNavigationRef = useRef(false);
  // Tracks the most recently opened agent independently of navigation history
  // so Space/Backspace (and the mobile bottom-nav button) can reopen it even
  // after history is cleared. Seeded from storage so it survives a reload.
  const lastOpenedAgentIdRef = useRef<string | null>(
    getStorageString(STORAGE_KEYS.LAST_OPENED_AGENT, '') || null
  );
  const [canNavigateBack, setCanNavigateBack] = useState(false);
  const [canNavigateForward, setCanNavigateForward] = useState(false);

  // Browser history integration so Alt+Left/Right (and trackpad swipe → popstate
  // and any other browser-driven back/forward) cycles selected agents the same
  // way the prev/next buttons do. Mirrors ClaudeOutputPanel's __guakeAgentNav
  // pattern; uses a distinct __flatAgentNav marker so the two coexist.
  const browserHistoryInitializedRef = useRef(false);
  const lastBrowserHistoryAgentIdRef = useRef<string | null>(null);
  const isBrowserPopNavigationRef = useRef(false);

  const agentIdSet = useMemo(() => new Set(agentIds), [agentIds]);

  // Resolve subordinate Agent objects per boss for the SubordinateProgressDots indicator on the FlatView map.
  const subordinatesByBoss = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const map = new Map<string, Agent[]>();
    for (const agent of agents) {
      if ((agent.isBoss || agent.class === 'boss') && agent.subordinateIds && agent.subordinateIds.length > 0) {
        const subs = agent.subordinateIds
          .map((id) => byId.get(id))
          .filter((a): a is Agent => a !== undefined);
        if (subs.length > 0) map.set(agent.id, subs);
      }
    }
    return map;
  }, [agents]);

  const updateAgentNavigationAvailability = useCallback(() => {
    const history = agentNavigationHistoryRef.current;
    const index = agentNavigationIndexRef.current;
    setCanNavigateBack(index > 0);
    setCanNavigateForward(index >= 0 && index < history.length - 1);
  }, []);

  const navigateAgentHistory = useCallback(
    (direction: -1 | 1) => {
      const history = agentNavigationHistoryRef.current;
      if (history.length === 0) return;

      let nextIndex = agentNavigationIndexRef.current + direction;
      while (nextIndex >= 0 && nextIndex < history.length) {
        const targetAgentId = history[nextIndex];
        if (agentIdSet.has(targetAgentId)) {
          isHistoryNavigationRef.current = true;
          agentNavigationIndexRef.current = nextIndex;
          updateAgentNavigationAvailability();
          store.selectAgent(targetAgentId);
          return;
        }
        nextIndex += direction;
      }
    },
    [agentIdSet, updateAgentNavigationAvailability]
  );

  const handleNavigateBack = useCallback(() => navigateAgentHistory(-1), [navigateAgentHistory]);
  const handleNavigateForward = useCallback(() => navigateAgentHistory(1), [navigateAgentHistory]);

  // Android system back gesture (Capacitor APK) routes through the same
  // prev-agent stack the FlatView toolbar's Back button uses. When there's
  // no previous agent in the stack, fall back to App.exitApp() so the OS
  // closes the app like users expect. No-op on web. Forward gestures aren't
  // exposed by Android, so only back is wired.
  useAndroidBackButton(useCallback(() => {
    const history = agentNavigationHistoryRef.current;
    const index = agentNavigationIndexRef.current;
    if (history.length > 0 && index > 0) {
      navigateAgentHistory(-1);
      return 'handled';
    }
    return 'exit';
  }, [navigateAgentHistory]));

  const setFlatBrowserHistoryState = useCallback((agentId: string, mode: 'push' | 'replace') => {
    if (typeof window === 'undefined') return;
    const currentState = window.history.state;
    const baseState = typeof currentState === 'object' && currentState !== null ? currentState : {};
    const nextState = {
      ...baseState,
      __flatAgentNav: { agentId },
    };
    if (mode === 'replace') {
      window.history.replaceState(nextState, '', window.location.href);
    } else {
      window.history.pushState(nextState, '', window.location.href);
    }
  }, []);

  // Push (or replace on first init) a browser-history entry every time the
  // selected agent changes — except when the change itself was triggered by
  // a browser pop, in which case the entry already exists.
  useEffect(() => {
    if (!selectedAgentId) {
      browserHistoryInitializedRef.current = false;
      lastBrowserHistoryAgentIdRef.current = null;
      return;
    }

    if (!browserHistoryInitializedRef.current) {
      setFlatBrowserHistoryState(selectedAgentId, 'replace');
      browserHistoryInitializedRef.current = true;
      lastBrowserHistoryAgentIdRef.current = selectedAgentId;
      return;
    }

    if (isBrowserPopNavigationRef.current) {
      isBrowserPopNavigationRef.current = false;
      lastBrowserHistoryAgentIdRef.current = selectedAgentId;
      return;
    }

    if (lastBrowserHistoryAgentIdRef.current === selectedAgentId) return;

    setFlatBrowserHistoryState(selectedAgentId, 'push');
    lastBrowserHistoryAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId, setFlatBrowserHistoryState]);

  // Browser back/forward (Alt+Left/Right, trackpad swipe, mouse side buttons
  // routed through the browser) — listener is installed on FlatView mount and
  // torn down on unmount so it can't leak into other views.
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const targetAgentId = event.state?.__flatAgentNav?.agentId;
      if (!targetAgentId || typeof targetAgentId !== 'string') return;
      if (!agentIdSet.has(targetAgentId)) return;
      if (targetAgentId === selectedAgentId) return;

      isBrowserPopNavigationRef.current = true;
      isHistoryNavigationRef.current = true;

      const history = agentNavigationHistoryRef.current;
      const foundIndex = history.lastIndexOf(targetAgentId);
      if (foundIndex >= 0) {
        agentNavigationIndexRef.current = foundIndex;
      } else {
        history.push(targetAgentId);
        agentNavigationIndexRef.current = history.length - 1;
      }
      updateAgentNavigationAvailability();
      store.selectAgent(targetAgentId);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [agentIdSet, selectedAgentId, updateAgentNavigationAvailability]);

  useEffect(() => {
    if (!selectedAgentId) {
      agentNavigationHistoryRef.current = [];
      agentNavigationIndexRef.current = -1;
      updateAgentNavigationAvailability();
      return;
    }

    // Remember this agent as the last explicitly opened one so Space/Backspace
    // (and the mobile bottom-nav "Last agent" button) can reopen it later when
    // no agent is selected. Persisted so it also survives an app reload.
    lastOpenedAgentIdRef.current = selectedAgentId;
    setStorageString(STORAGE_KEYS.LAST_OPENED_AGENT, selectedAgentId);

    if (isHistoryNavigationRef.current) {
      isHistoryNavigationRef.current = false;
      updateAgentNavigationAvailability();
      return;
    }

    const history = agentNavigationHistoryRef.current;
    const currentIndex = agentNavigationIndexRef.current;
    if (currentIndex >= 0 && history[currentIndex] === selectedAgentId) {
      updateAgentNavigationAvailability();
      return;
    }

    const trimmedHistory =
      currentIndex < history.length - 1
        ? history.slice(0, currentIndex + 1)
        : history.slice();

    trimmedHistory.push(selectedAgentId);
    const MAX_AGENT_HISTORY = 100;
    if (trimmedHistory.length > MAX_AGENT_HISTORY) {
      trimmedHistory.shift();
    }

    agentNavigationHistoryRef.current = trimmedHistory;
    agentNavigationIndexRef.current = trimmedHistory.length - 1;
    updateAgentNavigationAvailability();
  }, [selectedAgentId, updateAgentNavigationAvailability]);

  const handleAgentClick = useCallback(
    (agentId: string) => {
      onAgentClick(agentId);
      // Full mode is a browse/manage screen, so selecting lands in chat. The
      // compact rail is intentionally persistent: it stays open beside chat
      // for rapid switching while the user continues working in Guake.
      if (mobileSidebarFull) setMobileSidebarOpen(false);
    },
    [onAgentClick, mobileSidebarFull]
  );

  // Empty-string sentinel keeps the Guake AgentOverviewPanel happy when nothing
  // is selected — it just means no card is highlighted.
  const overviewActiveAgentId = selectedAgentId ?? '';
  const noopOverviewClose = useCallback(() => {
    // The overview panel IS the middle column in the Flat UI; the panel can't
    // be dismissed from inside (no in-view nav), so the close hook is a no-op.
  }, []);
  const handleOverviewSelectAgent = useCallback(
    (agentId: string) => {
      handleAgentClick(agentId);
    },
    [handleAgentClick]
  );

  const showInspector = inspectorOpen;

  const [inspectorMounted, setInspectorMounted] = useState(showInspector);
  const [inspectorAnimateOpen, setInspectorAnimateOpen] = useState(showInspector);
  // ChatView already subscribes to the active agent. The large FlatView parent
  // only needs the object while one of its own detail/modal surfaces displays
  // it; otherwise context/status ticks stay local to ChatView.
  const selectedAgent = useAgent(
    agentInfoOpen || responseModalContent !== null || (inspectorMounted && inspectorView === 'agent')
      ? selectedAgentId
      : null
  );

  useEffect(() => {
    if (showInspector) {
      setInspectorMounted(true);
      return;
    }
    setInspectorAnimateOpen(false);
    const timer = setTimeout(() => setInspectorMounted(false), 240);
    return () => clearTimeout(timer);
  }, [showInspector]);

  useEffect(() => {
    if (!inspectorMounted || !showInspector) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setInspectorAnimateOpen(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [inspectorMounted, showInspector]);

  // ── Ref for scrolling the left-panel AgentOverviewPanel ──
  const agentListRef = useRef<HTMLDivElement>(null);

  // ── Space / Backspace reopen last agent when empty-chat view is showing ──
  useEffect(() => {
    if (selectedAgentId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ' ' && event.key !== 'Backspace') return;
      // Ignore when typing in inputs, textareas, or contenteditable elements
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }
      const lastId = lastOpenedAgentIdRef.current;
      if (!lastId || !agentIdSet.has(lastId)) return;
      event.preventDefault();
      store.selectAgent(lastId);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedAgentId, agentIdSet]);

  // ── Expanded areas state (lifted so empty-chat overview can expand them) ──
  // Only areas in this set render expanded, so every page load starts with
  // all areas collapsed.
  const [expandedAreas, setExpandedAreas] = useState<Set<string>>(new Set());
  const handleToggleArea = useCallback((areaKey: string) => {
    setExpandedAreas(prev => {
      const next = new Set(prev);
      if (next.has(areaKey)) next.delete(areaKey);
      else next.add(areaKey);
      return next;
    });
  }, []);
  const handleSetExpandedAreas = useCallback((areaKeys: string[]) => {
    setExpandedAreas(new Set(areaKeys));
  }, []);

  // ── Mobile flat-map: areas collapse to readable two-column browse cards;
  // tapping a header expands that area to full width to reveal its contents.
  // Single-selection — only one area is expanded at a time, so tapping a
  // different area collapses the previous one. `null` means everything is
  // collapsed. Desktop continues to use the exact spatial map positions.
  const [isFlatMobile, setIsFlatMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => setIsFlatMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const [mobileExpandedAreaId, setMobileExpandedAreaId] = useState<string | null>(null);
  const handleMobileToggleArea = useCallback((areaKey: string) => {
    setMobileExpandedAreaId(prev => prev === areaKey ? null : areaKey);
  }, []);

  // ── Compact area/agent data for the empty-chat state ──
  const areas = useAreas();
  const buildingsMap = useBuildings();
  const [activeWorkspace] = useWorkspaceFilter();
  const emptyChatGroups = useMemo(() => {
    // Only consumed by the empty-chat map (and handleFocusArea, which is only
    // reachable from it) — skip the O(agents×areas + buildings×areas) work
    // while a chat is open.
    if (selectedAgentId) return EMPTY_FLAT_MAP_GROUPS;

    const agentsByAreaId = new Map<string, typeof agents>();
    const unassigned: typeof agents = [];
    for (const agent of agents) {
      const area = store.getAreaForAgent(agent.id);
      // Workspace filter: hide agents whose area isn't part of the active
      // workspace (and unassigned agents while a workspace is active).
      if (!isAgentVisibleInWorkspace(area?.id ?? null)) continue;
      if (!area || area.archived) {
        unassigned.push(agent);
        continue;
      }
      const list = agentsByAreaId.get(area.id);
      if (list) list.push(agent);
      else agentsByAreaId.set(area.id, [agent]);
    }

    // Bucket buildings by area using the same point-in-area test the 3D scene
    // uses, so a building shows up in the area card whose footprint contains
    // its world position.
    const buildingsByAreaId = new Map<string, Building[]>();
    const unassignedBuildings: Building[] = [];
    for (const building of buildingsMap.values()) {
      let matched = false;
      for (const area of areas.values()) {
        if (area.archived) continue;
        if (!isAreaVisibleInWorkspace(area.id)) continue;
        if (store.isPositionInArea(building.position, area)) {
          const list = buildingsByAreaId.get(area.id);
          if (list) list.push(building);
          else buildingsByAreaId.set(area.id, [building]);
          matched = true;
          break;
        }
      }
      if (!matched && isAgentVisibleInWorkspace(null)) {
        unassignedBuildings.push(building);
      }
    }

    const groups: { area: typeof areas extends Map<string, infer V> ? V : never; agents: typeof agents; buildings: Building[] }[] = [];
    for (const [, area] of areas) {
      if (area.archived) continue;
      // Workspace filter: skip areas that aren't part of the active workspace.
      if (!isAreaVisibleInWorkspace(area.id)) continue;
      const list = agentsByAreaId.get(area.id);
      const bList = buildingsByAreaId.get(area.id) ?? [];
      if ((list && list.length > 0) || bList.length > 0) {
        groups.push({ area, agents: list ?? [], buildings: bList });
      }
    }
    if (unassigned.length > 0 || unassignedBuildings.length > 0) {
      groups.push({
        area: { id: '__unassigned__', name: 'Unassigned', color: '#6272a4', center: { x: 0, z: 0 }, type: 'circle', radius: 0, directories: [], archived: false, assignedAgentIds: [], zIndex: 0 } as any,
        agents: unassigned,
        buildings: unassignedBuildings,
      });
    }

    const assignedGroups = groups.filter(g => g.area.id !== '__unassigned__');
    const unassignedGroups = groups.filter(g => g.area.id === '__unassigned__');

    // ── Compute a 2D grid that mirrors the actual scene layout ──
    let gridCols = 1;
    let gridRows = 1;
    const positions = new Map<string, { row: number; col: number }>();

    if (assignedGroups.length > 1) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const g of assignedGroups) {
        minX = Math.min(minX, g.area.center.x);
        maxX = Math.max(maxX, g.area.center.x);
        minZ = Math.min(minZ, g.area.center.z);
        maxZ = Math.max(maxZ, g.area.center.z);
      }
      const spanX = maxX - minX || 1;
      const spanZ = maxZ - minZ || 1;

      // For small numbers of areas, lay them out left-to-right in a single row
      // so the flat view column count matches the 2D scene more directly.
      if (assignedGroups.length <= 4) {
        gridCols = assignedGroups.length;
        gridRows = 1;
        const xSorted = [...assignedGroups].sort((a, b) => a.area.center.x - b.area.center.x);
        for (let i = 0; i < xSorted.length; i++) {
          positions.set(xSorted[i].area.id, { row: 1, col: i + 1 });
        }
      } else {
        // Detect natural columns from x-coordinate gaps
        const xSorted = [...assignedGroups].sort((a, b) => a.area.center.x - b.area.center.x);
        const xGaps: number[] = [];
        for (let i = 1; i < xSorted.length; i++) {
          xGaps.push(xSorted[i].area.center.x - xSorted[i - 1].area.center.x);
        }
        const meanXGap = xGaps.reduce((a, b) => a + b, 0) / xGaps.length || 1;
        let detectedCols = 1;
        for (const gap of xGaps) {
          if (gap > meanXGap * 1.3) detectedCols++;
        }
        gridCols = Math.max(2, Math.min(detectedCols, assignedGroups.length));

        // Detect natural rows from z-coordinate gaps
        const zSorted = [...assignedGroups].sort((a, b) => a.area.center.z - b.area.center.z);
        const zGaps: number[] = [];
        for (let i = 1; i < zSorted.length; i++) {
          zGaps.push(zSorted[i].area.center.z - zSorted[i - 1].area.center.z);
        }
        const meanZGap = zGaps.reduce((a, b) => a + b, 0) / zGaps.length || 1;
        let detectedRows = 1;
        for (const gap of zGaps) {
          if (gap > meanZGap * 1.3) detectedRows++;
        }
        gridRows = Math.max(2, Math.min(detectedRows, assignedGroups.length));

        // Make sure the grid is large enough to hold every area
        gridCols = Math.max(gridCols, Math.ceil(assignedGroups.length / gridRows));
        gridRows = Math.max(gridRows, Math.ceil(assignedGroups.length / gridCols));

        // Snap each area to its nearest grid cell
        const colWidth = spanX / gridCols;
        const rowHeight = spanZ / gridRows;
        const usedCells = new Set<string>();

        for (const g of assignedGroups) {
          let col = Math.min(gridCols - 1, Math.max(0, Math.floor((g.area.center.x - minX) / colWidth)));
          let row = Math.min(gridRows - 1, Math.max(0, Math.floor((g.area.center.z - minZ) / rowHeight)));
          // Resolve collisions: scan forward in reading order (right, then
          // wrap to the next row) until a free cell is found. The previous
          // implementation only shifted right within the same row, so when
          // the preferred column was already the last column, two areas
          // would silently land on the same {row,col} — and CSS grid would
          // stack the second card directly on top of the first, making the
          // agent chips inside the lower card appear to overlap with the
          // one on top.
          let cellKey = `${row},${col}`;
          let scanned = 0;
          const maxCells = gridRows * gridCols;
          while (usedCells.has(cellKey) && scanned < maxCells) {
            col++;
            if (col >= gridCols) {
              col = 0;
              row = (row + 1) % gridRows;
            }
            cellKey = `${row},${col}`;
            scanned++;
          }
          if (usedCells.has(cellKey)) {
            // Every existing cell is taken — append a new row so the card
            // still gets a unique slot instead of stacking on an occupied cell.
            row = gridRows;
            col = 0;
            cellKey = `${row},${col}`;
            gridRows++;
          }
          usedCells.add(cellKey);
          positions.set(g.area.id, { row: row + 1, col: col + 1 }); // CSS grid is 1-based
        }
      }
    }

    // Sort agents inside each group by their scene position (z then x)
    const sortAgents = (list: typeof agents) => {
      list.sort((a, b) => {
        const zDiff = (a.position?.z ?? 0) - (b.position?.z ?? 0);
        if (zDiff !== 0) return zDiff;
        return (a.position?.x ?? 0) - (b.position?.x ?? 0);
      });
    };
    for (const g of assignedGroups) sortAgents(g.agents);
    for (const g of unassignedGroups) sortAgents(g.agents);

    // The flat map is a browse surface rather than a spatial projection of the
    // battlefield. Keep its reading order stable and predictable regardless of
    // where an area happens to be positioned in the 2D/3D scene.
    const alphabetizedGroups = [...assignedGroups, ...unassignedGroups].sort((a, b) =>
      a.area.name.localeCompare(b.area.name, undefined, { sensitivity: 'base', numeric: true })
        || a.area.id.localeCompare(b.area.id)
    );
    positions.clear();
    alphabetizedGroups.forEach((group, index) => {
      positions.set(group.area.id, {
        row: Math.floor(index / gridCols) + 1,
        col: (index % gridCols) + 1,
      });
    });
    gridRows = Math.max(1, Math.ceil(alphabetizedGroups.length / gridCols));

    return { groups: alphabetizedGroups, gridCols, gridRows, positions };
  }, [agents, areas, buildingsMap, activeWorkspace, selectedAgentId]);

  const emptyChatStats = useMemo(() => {
    let agentCount = 0;
    let workingCount = 0;
    for (const group of emptyChatGroups.groups) {
      agentCount += group.agents.length;
      workingCount += group.agents.filter(agent => agent.status === 'working').length;
    }
    return {
      areaCount: emptyChatGroups.groups.length,
      agentCount,
      workingCount,
    };
  }, [emptyChatGroups]);

  // Right-click menu actions for agent chips in the empty-state overview.
  // Mirrors the Edit Agent / Delete Agent actions wired in AgentOverviewPanel so
  // both surfaces share one UX for per-agent mutations.
  const emptyAgentContextMenuActions = useMemo((): ContextMenuAction[] => {
    if (!emptyAgentContextMenu) return [];
    const agent = store.getState().agents.get(emptyAgentContextMenu.agentId);
    if (!agent) return [];
    return [
      {
        id: 'edit-agent',
        label: t('terminal:overview.editAgent', { defaultValue: 'Edit Agent' }),
        icon: <Icon name="edit" size={14} />,
        onClick: () => {
          window.dispatchEvent(new CustomEvent('tide:open-agent-edit', { detail: { agentId: agent.id } }));
        },
      },
      {
        id: 'open-chat',
        label: t('terminal:flatView.openChat', { defaultValue: 'Open Chat' }),
        icon: <Icon name="chat" size={14} />,
        onClick: () => onAgentClick(agent.id),
      },
      {
        id: 'toggle-standby',
        label: agent.standby === true
          ? t('terminal:overview.restoreAction', { defaultValue: 'Restore agent' })
          : t('terminal:overview.standbyAction', { defaultValue: 'Set on standby' }),
        icon: <Icon name={agent.standby === true ? 'play' : 'pause'} size={14} />,
        onClick: () => {
          if (agent.standby === true) store.setAgentStandby(agent.id, false);
          else setStandbyConfirm({ agentId: agent.id, name: agent.name });
        },
      },
      {
        id: 'clone-agent',
        label: t('terminal:overview.cloneAgent', { defaultValue: 'Clone Agent' }),
        icon: <Icon name="clipboard" size={14} />,
        onClick: () => store.cloneAgent(agent.id),
      },
      {
        id: 'fork-agent',
        label: t('terminal:overview.forkAgent', { defaultValue: 'Fork Agent (with history)' }),
        icon: <Icon name="git-branch" size={14} />,
        onClick: () => store.forkAgent(agent.id),
      },
      {
        id: 'delete-agent',
        label: t('terminal:overview.deleteAgent', { defaultValue: 'Delete Agent' }),
        icon: <Icon name="trash" size={14} />,
        danger: true,
        onClick: () => {
          setRemoveAgentConfirm({ agentId: agent.id, name: agent.name });
        },
      },
    ];
  }, [emptyAgentContextMenu, onAgentClick, t]);

  // Right-click menu actions for building chips on the empty-state map. Mirrors
  // AreaBuildingsPanel so the two surfaces share one UX for per-building
  // mutations (start/stop/restart, edit, clone, delete, open URLs, etc).
  const buildingContextMenuActions = useMemo((): ContextMenuAction[] => {
    if (!buildingContextMenu) return [];
    const building = buildingsMap.get(buildingContextMenu.buildingId);
    if (!building) return [];

    const actions: ContextMenuAction[] = [];
    const isRunnable = building.type === 'server' || building.type === 'docker' || building.type === 'terminal';
    const isRunning = building.status === 'running';
    const isBoss = building.type === 'boss';

    actions.push({
      id: 'open',
      label: building.type === 'database' ? t('terminal:flatView.openDatabase', { defaultValue: 'Open Database' }) :
             building.type === 'folder' ? t('terminal:flatView.openFolder', { defaultValue: 'Open Folder' }) :
             building.type === 'tests' ? t('terminal:flatView.openTests', { defaultValue: 'Open Tests' }) :
             building.type === 'http' ? t('terminal:flatView.openRequests', { defaultValue: 'Open Requests' }) :
             building.type === 'slash-command' ? t('terminal:flatView.runCommand', { defaultValue: 'Run Command' }) :
             building.type === 'boss' ? t('terminal:flatView.viewBossLogs', { defaultValue: 'View Boss Logs' }) :
             building.type === 'terminal' ? t('terminal:flatView.openTerminal', { defaultValue: 'Open Terminal' }) :
             (building.type === 'server' && building.pm2?.enabled) ? t('terminal:flatView.viewPm2Logs', { defaultValue: 'View PM2 Logs' }) :
             t('terminal:flatView.open', { defaultValue: 'Open' }),
      icon: <Icon name={building.type === 'database' ? 'database' :
            building.type === 'folder' ? 'folder' :
            building.type === 'tests' ? 'flask' :
            building.type === 'http' ? 'globe' :
            building.type === 'slash-command' ? 'envelope' :
            building.type === 'terminal' ? 'terminal' :
            'eye'} size={14} />,
      onClick: () => handleOpenBuilding(building.id),
    });

    if (isRunnable) {
      if (!isRunning) {
        actions.push({
          id: 'start',
          label: t('terminal:buildingAction.start'),
          icon: <Icon name="play" size={14} />,
          onClick: () => store.sendBuildingCommand(building.id, 'start'),
        });
      }
      if (isRunning) {
        actions.push({
          id: 'restart',
          label: t('terminal:buildingAction.restart'),
          icon: <Icon name="refresh" size={14} />,
          onClick: () => store.sendBuildingCommand(building.id, 'restart'),
        });
        actions.push({
          id: 'stop',
          label: t('terminal:buildingAction.stop'),
          icon: <Icon name="stop" size={14} />,
          onClick: () => store.sendBuildingCommand(building.id, 'stop'),
        });
      }
    }

    if (isBoss && building.subordinateBuildingIds && building.subordinateBuildingIds.length > 0) {
      actions.push({
        id: 'start-all',
        label: t('terminal:flatView.startAllSubordinates', { defaultValue: 'Start All Subordinates' }),
        icon: <Icon name="launch" size={14} />,
        onClick: () => {
          for (const subId of building.subordinateBuildingIds!) {
            store.sendBuildingCommand(subId, 'start');
          }
        },
      });
      actions.push({
        id: 'stop-all',
        label: t('terminal:flatView.stopAllSubordinates', { defaultValue: 'Stop All Subordinates' }),
        icon: <Icon name="pause" size={14} />,
        onClick: () => {
          for (const subId of building.subordinateBuildingIds!) {
            store.sendBuildingCommand(subId, 'stop');
          }
        },
      });
      actions.push({
        id: 'restart-all',
        label: t('terminal:flatView.restartAllSubordinates', { defaultValue: 'Restart All Subordinates' }),
        icon: <Icon name="restart" size={14} />,
        onClick: () => {
          for (const subId of building.subordinateBuildingIds!) {
            store.sendBuildingCommand(subId, 'restart');
          }
        },
      });
    }

    if (isRunnable) {
      actions.push({
        id: 'health-check',
        label: t('terminal:buildingAction.healthCheck'),
        icon: <Icon name="health" size={14} />,
        onClick: () => store.sendBuildingCommand(building.id, 'healthCheck'),
      });
    }

    actions.push({
      id: 'divider-edit',
      label: '',
      divider: true,
      onClick: () => {},
    });

    actions.push({
      id: 'edit',
      label: t('terminal:flatView.editBuilding', { defaultValue: 'Edit Building' }),
      icon: <Icon name="edit" size={14} />,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('tide:building-edit', { detail: { buildingId: building.id } }));
      },
    });

    actions.push({
      id: 'clone',
      label: t('terminal:flatView.cloneBuilding', { defaultValue: 'Clone Building' }),
      icon: <Icon name="copy" size={14} />,
      onClick: () => {
        // Drop the clone next to the original so it stays in the same area.
        store.createBuilding({
          name: `${building.name}${t('terminal:flatView.copySuffix', { defaultValue: ' (Copy)' })}`,
          type: building.type,
          style: building.style,
          color: building.color,
          scale: building.scale,
          icon: building.icon,
          slashCommand: building.slashCommand,
          position: { x: building.position.x + 2, z: building.position.z + 2 },
          cwd: building.cwd,
          folderPath: building.folderPath,
          commands: building.commands,
          pm2: building.pm2,
          docker: building.docker,
          database: building.database,
          terminal: building.terminal,
          urls: building.urls,
          subordinateBuildingIds: building.subordinateBuildingIds,
        });
      },
    });

    if (building.urls && building.urls.length > 0) {
      for (const link of building.urls) {
        actions.push({
          id: `url-${link.label}`,
          label: link.label,
          icon: <Icon name="link" size={14} />,
          onClick: () => window.open(link.url, '_blank', 'noopener,noreferrer'),
        });
      }
    }

    actions.push({
      id: 'divider-danger',
      label: '',
      divider: true,
      onClick: () => {},
    });

    actions.push({
      id: 'delete',
      label: t('terminal:flatView.deleteBuilding', { defaultValue: 'Delete Building' }),
      icon: <Icon name="trash" size={14} />,
      danger: true,
      onClick: () => store.deleteBuilding(building.id),
    });

    return actions;
  }, [buildingContextMenu, buildingsMap, handleOpenBuilding, t]);

  // ── Focus an area in the left-panel AgentOverviewPanel ──
  const handleFocusArea = useCallback((areaKey: string) => {
    // 1. Expand only the clicked area (everything else collapses)
    setExpandedAreas(new Set([areaKey]));
    // 2. After React flushes, scroll the area header into view
    requestAnimationFrame(() => {
      const container = agentListRef.current;
      if (!container) return;
      const header = container.querySelector<HTMLElement>(`[data-area-id="${areaKey}"]`);
      if (!header) return;
      const containerRect = container.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const offset = headerRect.top - containerRect.top + container.scrollTop - 8;
      container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    });
  }, []);

  return (
    <div
      ref={flatViewRef}
      className={`flat-view ${showInspector ? 'flat-view--with-inspector' : ''} ${selectedAgentId ? 'flat-view--has-chat' : ''} ${mobileSidebarOpen ? 'flat-view--mobile-sidebar-open' : ''} ${mobileSidebarFull ? 'flat-view--mobile-sidebar-full' : 'flat-view--mobile-sidebar-compact'}`}
      style={(() => {
        if (middleWidth === null && inspectorWidth === null) return undefined;
        // Typed as a record so the custom CSS properties pass through the
        // React `style` narrowing.
        const s: Record<string, string> = {};
        if (middleWidth !== null) s['--flat-middle-width'] = `${middleWidth}px`;
        if (inspectorWidth !== null) s['--flat-inspector-width'] = `${inspectorWidth}px`;
        return s as React.CSSProperties;
      })()}
    >
      {/* Backdrop that captures taps outside the drawer to close it. Only
          rendered when the drawer is open. Hidden on desktop via CSS. */}
      {mobileSidebarOpen && mobileSidebarFull && (
        <div
          className="flat-mobile-sidebar-backdrop"
          onClick={closeMobileSidebar}
          aria-hidden="true"
        />
      )}
      {/* Middle Column - Agents overview. The former in-view SidebarMenu was
          removed because the floating left-side FAB menu (settings/spotlight/
          spawn buttons) already covers navigation. */}
      <div className="flat-middle">
        <div className="flat-middle__header">
          <div className="flat-middle__actions">
            <button
              className="flat-cta-btn flat-cta-btn--agent"
              onClick={onOpenSpawnModal}
              title={t('terminal:flatView.createAgentTitle', { defaultValue: 'Create new agent' })}
            >
              {t('terminal:flatView.addAgent', { defaultValue: '+ Agent' })}
            </button>
            <button
              className="flat-cta-btn flat-cta-btn--boss"
              onClick={onOpenBossSpawnModal}
              title={t('terminal:flatView.createBossTitle', { defaultValue: 'Create new boss agent' })}
            >
              {t('terminal:flatView.addBoss', { defaultValue: '+ Boss' })}
            </button>
            <button
              className="flat-cta-btn flat-cta-btn--area"
              onClick={onOpenAreaModal}
              title={t('terminal:flatView.createAreaTitle', { defaultValue: 'Create new area' })}
            >
              {t('terminal:flatView.addArea', { defaultValue: '+ Area' })}
            </button>
            <button
              type="button"
              className="flat-mobile-sidebar-size-toggle"
              onClick={(event) => {
                event.stopPropagation();
                toggleMobileSidebarFull();
              }}
              aria-pressed={mobileSidebarFull}
              title={mobileSidebarFull ? t('terminal:flatView.showCompactSidebar', { defaultValue: 'Show compact agents panel' }) : t('terminal:flatView.showCompleteSidebar', { defaultValue: 'Show complete agents panel' })}
              aria-label={mobileSidebarFull ? t('terminal:flatView.showCompactSidebar', { defaultValue: 'Show compact agents panel' }) : t('terminal:flatView.showCompleteSidebar', { defaultValue: 'Show complete agents panel' })}
            >
              {mobileSidebarFull ? t('terminal:flatView.compact', { defaultValue: 'Compact' }) : t('terminal:flatView.full', { defaultValue: 'Full' })}
            </button>
          </div>
        </div>
        <div className="flat-middle__content">
          <AgentOverviewPanel
            activeAgentId={overviewActiveAgentId}
            onClose={noopOverviewClose}
            onSelectAgent={handleOverviewSelectAgent}
            expandedAreas={expandedAreas}
            onToggleArea={handleToggleArea}
            onSetExpandedAreas={handleSetExpandedAreas}
            agentListRef={agentListRef}
          />
        </div>
      </div>

      {/* Draggable splitter between .flat-middle and .flat-right. Hidden on
          mobile by the `@media (max-width: 1024px)` block in FlatView.scss.
          Double-click to reset to the CSS default. */}
      <div
        className="flat-splitter flat-splitter--middle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('terminal:flatView.resizeAgentsPanel', { defaultValue: 'Resize agents panel' })}
        title={t('terminal:flatView.dragToResizeReset', { defaultValue: 'Drag to resize · Double-click to reset' })}
        onPointerDown={handleMiddleSplitterPointerDown}
        onPointerMove={handleSplitterPointerMove}
        onPointerUp={handleSplitterPointerUp}
        onPointerCancel={handleSplitterPointerUp}
        onDoubleClick={handleMiddleSplitterDoubleClick}
      />

      {/* Right Column - Chat/Details */}
      <div className="flat-right">
        {/* Mobile-only: toggle button for the agents drawer. Rendered as the
            first child of flat-right so it docks above whatever content the
            right column shows (chat header, or flat-map empty state). Hidden
            on desktop via CSS. */}
        <button
          type="button"
          className="flat-mobile-sidebar-toggle"
          aria-label={mobileSidebarOpen ? t('terminal:flatView.closeAgentsSidebar', { defaultValue: 'Close agents sidebar' }) : t('terminal:flatView.openAgentsSidebar', { defaultValue: 'Open agents sidebar' })}
          aria-expanded={mobileSidebarOpen}
          onClick={toggleMobileSidebar}
        >
          <Icon name="list" size={18} />
          <span className="flat-mobile-sidebar-toggle__label">{t('common:labels.agents')}</span>
        </button>
        {selectedAgentId ? (
          <ChatView
            agentId={selectedAgentId}
            terminalViewMode={terminalViewMode}
            onTerminalViewModeChange={handleTerminalViewModeChange}
            inspectorOpen={inspectorOpen}
            onToggleInspector={handleToggleInspector}
            onShowTaskBoard={handleShowTaskBoard}
            onImageClick={handleImageClick}
            onFileClick={handleFileClick}
            onBashClick={handleBashClick}
            onViewMarkdown={handleViewMarkdown}
            onRequestClearSubordinates={handleRequestClearSubordinates}
            keyboard={keyboard}
            canNavigateBack={canNavigateBack}
            canNavigateForward={canNavigateForward}
            onNavigateBack={handleNavigateBack}
            onNavigateForward={handleNavigateForward}
            agentInfoOpen={agentInfoOpen}
            onToggleAgentInfo={handleToggleAgentInfo}
            onHeaderContextMenu={handleHeaderContextMenu}
            onBuildingContextMenu={handleBuildingContextMenuOpen}
          />
        ) : (
          <div className="flat-chat flat-chat--empty">
            <div className="flat-map">
              <div className="flat-map__header">
                <span className="flat-map__title">{t('terminal:flatView.mapAreas', { defaultValue: '🗺️ Areas' })}</span>
                <span className="flat-map__hint">{t('terminal:flatView.mapHint', { defaultValue: 'Click an area to focus it, or an agent to chat' })}</span>
                <span className="flat-map__stats">
                  <span>{t('terminal:flatView.areaCount', { defaultValue: '{{count}} areas', count: emptyChatStats.areaCount })}</span>
                  <span>{t('terminal:flatView.agentCount', { defaultValue: '{{count}} agent{{plural}}', count: emptyChatStats.agentCount, plural: emptyChatStats.agentCount === 1 ? '' : 's' })}</span>
                  {emptyChatStats.workingCount > 0 && (
                    <span className="flat-map__stats-working">
                      <span className="flat-map__stats-dot" aria-hidden="true" />
                      {t('terminal:flatView.workingCount', { defaultValue: '{{count}} working', count: emptyChatStats.workingCount })}
                    </span>
                  )}
                </span>
                <ViewModeToggle className="flat-map__view-mode" />
              </div>
              <div
                className="flat-map__grid"
                style={{
                  gridTemplateColumns: isFlatMobile
                    ? 'repeat(2, minmax(0, 1fr))'
                    : `repeat(${emptyChatGroups.gridCols}, 1fr)`,
                }}
              >
                {emptyChatGroups.groups.length === 0 ? (
                  <div className="flat-map__empty">
                    <span>{t('terminal:flatView.noAreasOrAgents', { defaultValue: 'No areas or agents yet' })}</span>
                  </div>
                ) : (
                  (() => {
                    // Mobile keeps the map's broad spatial reading order, but
                    // removes empty scene cells so every card has enough room
                    // for its name and status. Desktop keeps exact positions.
                    const visibleGroups = isFlatMobile
                      ? [...emptyChatGroups.groups].sort((a, b) => {
                          const aPos = emptyChatGroups.positions.get(a.area.id);
                          const bPos = emptyChatGroups.positions.get(b.area.id);
                          if (!aPos && !bPos) return 0;
                          if (!aPos) return 1;
                          if (!bPos) return -1;
                          return aPos.row - bPos.row || aPos.col - bPos.col;
                        })
                      : emptyChatGroups.groups;
                    return visibleGroups.map(group => {
                    const areaKey = group.area.id;
                    const pos = emptyChatGroups.positions.get(areaKey);
                    const workingAgentCount = group.agents.filter(agent => agent.status === 'working').length;
                    const hasWorkingAgents = workingAgentCount > 0;
                    const isMobileCollapsed = isFlatMobile && mobileExpandedAreaId !== areaKey;
                    const isMobileExpanded = isFlatMobile && !isMobileCollapsed;
                    return (
                      <div
                        key={areaKey}
                        className={`flat-map-area-card${hasWorkingAgents ? ' flat-map-area-card--working' : ''}${isMobileCollapsed ? ' flat-map-area-card--collapsed' : ''}${isMobileExpanded ? ' flat-map-area-card--expanded' : ''}`}
                        style={{
                          '--area-color': group.area.color,
                          gridRow: isFlatMobile ? undefined : pos?.row,
                          gridColumn: isFlatMobile ? undefined : pos?.col,
                        } as React.CSSProperties}
                        onContextMenu={(e) => {
                          if (!onAreaContextMenu) return;
                          e.preventDefault();
                          e.stopPropagation();
                          onAreaContextMenu(areaKey, { x: e.clientX, y: e.clientY });
                        }}
                      >
                        <button
                          type="button"
                          className="flat-map-area-card__header"
                          onClick={() => isFlatMobile ? handleMobileToggleArea(areaKey) : handleFocusArea(areaKey)}
                          title={isFlatMobile
                            ? (isMobileCollapsed
                                ? t('terminal:flatView.expandArea', { defaultValue: 'Expand {{name}}', name: group.area.name })
                                : t('terminal:flatView.collapseArea', { defaultValue: 'Collapse {{name}}', name: group.area.name }))
                            : t('terminal:flatView.focusArea', { defaultValue: 'Focus {{name}} in left panel', name: group.area.name })}
                          aria-expanded={isFlatMobile ? !isMobileCollapsed : undefined}
                        >
                          <span
                            className="flat-map-area-card__color"
                            style={{ background: group.area.color }}
                          />
                          {group.area.logo?.filename && (
                            <img
                              className="flat-map-area-card__logo"
                              src={getAreaLogoUrl(group.area.logo.filename)}
                              alt=""
                              aria-hidden="true"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          )}
                          <span className="flat-map-area-card__name">{group.area.name}</span>
                          <span
                            className="flat-map-area-card__count"
                            title={t('terminal:flatView.agentCount', { defaultValue: '{{count}} agent{{plural}}', count: group.agents.length, plural: group.agents.length === 1 ? '' : 's' })}
                            aria-label={t('terminal:flatView.agentCount', { defaultValue: '{{count}} agent{{plural}}', count: group.agents.length, plural: group.agents.length === 1 ? '' : 's' })}
                          >
                            <Icon name="users" size={10} />
                            {group.agents.length}
                          </span>
                          {hasWorkingAgents && (
                            <span
                              className="flat-map-area-card__working"
                              title={t('terminal:flatView.workingAgents', { defaultValue: '{{count}} working agent{{plural}}', count: workingAgentCount, plural: workingAgentCount === 1 ? '' : 's' })}
                              aria-label={t('terminal:flatView.workingAgents', { defaultValue: '{{count}} working agent{{plural}}', count: workingAgentCount, plural: workingAgentCount === 1 ? '' : 's' })}
                            >
                              <ActivityGlyph animated size={12} className="flat-map-area-card__working-glyph" />
                              <span className="flat-map-area-card__working-count">{workingAgentCount}</span>
                            </span>
                          )}
                          {isFlatMobile && (
                            <Icon
                              name={isMobileCollapsed ? 'caret-down' : 'caret-up'}
                              size={11}
                              className="flat-map-area-card__caret"
                            />
                          )}
                        </button>
                        <div className="flat-map-area-card__agents">
                          {group.agents.map(agent => {
                            const isBoss = agent.isBoss || agent.class === 'boss';
                            const subs = isBoss ? subordinatesByBoss.get(agent.id) : undefined;
                            const ctx = getDisplayContextInfo(agent);
                            const ctxColor =
                              ctx.usedPercent >= 80 ? '#ff4a4a'
                                : ctx.usedPercent >= 60 ? '#ff9e4a'
                                  : ctx.usedPercent >= 40 ? '#ffd700'
                                    : '#4aff9e';
                            const ctxTitle = t('terminal:flatView.agentContextTip', { defaultValue: 'Context: {{used}}k / {{window}}k ({{pct}}% used, {{free}}% free)', used: (ctx.totalTokens / 1000).toFixed(1), window: (ctx.contextWindow / 1000).toFixed(1), pct: ctx.usedPercent, free: ctx.freePercent });
                            const hasHoverContent = (agent.latestTodos && agent.latestTodos.length > 0) || (subs && subs.length > 0);
                            return (
                              <AgentHoverTooltip
                                key={agent.id}
                                todos={agent.latestTodos}
                                subordinates={subs}
                                position="top"
                              >
                              <button
                                type="button"
                                className={`flat-map-agent-chip ${agent.status}`}
                                onClick={() => onAgentClick(agent.id)}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setEmptyAgentContextMenu({
                                    agentId: agent.id,
                                    position: { x: e.clientX, y: e.clientY },
                                  });
                                }}
                                title={hasHoverContent ? undefined : `${isBoss ? t('terminal:flatView.bossPrefix', { defaultValue: 'Boss · ' }) : ''}${t('terminal:flatView.openChatWithAgent', { defaultValue: 'Open chat with {{name}}\n{{ctx}}', name: agent.name, ctx: ctxTitle })}`}
                              >
                                <AgentIcon agent={agent} size={16} />
                                {isBoss && (
                                  <span className="flat-map-agent-chip__crown" aria-hidden="true">
                                    <Icon name="crown" size={11} color="#ffd700" weight="fill" />
                                  </span>
                                )}
                                <span className="flat-map-agent-chip__name">{agent.name}</span>
                                <ProviderIcon
                                  agent={agent}
                                  alt={t('terminal:flatView.agentProviderAlt', { defaultValue: '{{name}} provider', name: agent.name })}
                                  className="flat-map-agent-chip__provider-icon"
                                />
                                {agent.status === 'working' ? (
                                  <ActivityGlyph animated size={11} className="flat-map-agent-chip__activity" />
                                ) : (
                                  <span
                                    className="flat-map-agent-chip__dot"
                                    style={{ backgroundColor: getAgentStatusColor(agent.status) }}
                                  />
                                )}
                                {agent.latestTodos && agent.latestTodos.length > 0 && (
                                  <TaskProgressDots todos={agent.latestTodos} maxDots={6} />
                                )}
                                {isBoss && subs && subs.length > 0 && (
                                  <SubordinateProgressDots subordinates={subs} maxDots={6} />
                                )}
                                <span
                                  className="flat-map-agent-chip__context-bar"
                                  aria-hidden="true"
                                >
                                  <span
                                    className="flat-map-agent-chip__context-bar-fill"
                                    style={{ width: `${ctx.usedPercent}%`, backgroundColor: ctxColor }}
                                  />
                                </span>
                              </button>
                              </AgentHoverTooltip>
                            );
                          })}
                        </div>
                        {group.area.directories.length > 0 && (
                          <div className="flat-map-area-card__folders" role="group" aria-label={t('terminal:flatView.areaFoldersAria', { defaultValue: '{{name}} folders', name: group.area.name })}>
                            {group.area.directories.map(dir => {
                              const dirLabel = dir.split('/').filter(Boolean).pop() || dir;
                              return (
                                <button
                                  key={dir}
                                  type="button"
                                  className="flat-map-folder-chip"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    store.openFileExplorerForAreaFolder(areaKey, dir);
                                  }}
                                  title={t('terminal:flatView.openInExplorerTip', { defaultValue: 'Open in file explorer: {{cwd}}', cwd: dir })}
                                >
                                  <Icon name="folder-open" size={12} />
                                  <span className="flat-map-folder-chip__name">{dirLabel}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {group.buildings.length > 0 && (
                          <div className="flat-map-area-card__buildings">
                            {group.buildings.map(building => {
                              const typeColor = BUILDING_TYPES[building.type]?.color;
                              return (
                              <button
                                key={building.id}
                                type="button"
                                className={`flat-map-building-chip flat-map-building-chip--${building.status}`}
                                style={typeColor ? ({ '--building-type-color': typeColor } as React.CSSProperties) : undefined}
                                onClick={(e) => {
                                  if (building.type === 'slash-command') {
                                    handleOpenBuilding(building.id);
                                  } else if (onBuildingPopup) {
                                    // Anchor the popup at the chip's right edge so it
                                    // visually points at what was clicked rather than at
                                    // the cursor's exact pixel.
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    onBuildingPopup(building.id, {
                                      x: rect.right,
                                      y: rect.top + rect.height / 2,
                                    });
                                  } else {
                                    handleOpenBuilding(building.id);
                                  }
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setBuildingContextMenu({
                                    buildingId: building.id,
                                    position: { x: e.clientX, y: e.clientY },
                                  });
                                }}
                                title={`${building.name} · ${building.type} · ${building.status}`}
                              >
                                <Icon
                                  name={getBuildingTypeIcon(building.type)}
                                  size={12}
                                  color={typeColor}
                                />
                                <span className="flat-map-building-chip__name">{building.name}</span>
                                <span
                                  className="flat-map-building-chip__dot"
                                  style={{ backgroundColor: getBuildingStatusColor(building.status) }}
                                />
                              </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  });
                  })()
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Draggable splitter between .flat-right and .flat-inspector. Only
          rendered while the inspector is open. Hidden on mobile via the
          `@media (max-width: 1024px)` block in FlatView.scss. */}
      {showInspector && (
        <div
          className="flat-splitter flat-splitter--inspector"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('terminal:flatView.resizeInspectorPanel', { defaultValue: 'Resize inspector panel' })}
          title={t('terminal:flatView.dragToResizeReset', { defaultValue: 'Drag to resize · Double-click to reset' })}
          onPointerDown={handleInspectorSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={handleSplitterPointerUp}
          onPointerCancel={handleSplitterPointerUp}
          onDoubleClick={handleInspectorSplitterDoubleClick}
        />
      )}

      {/* Inspector Column - Pushes chat column rather than overlaying.
          Independent of chat/selection state: stays visible even when no
          agent is selected so the tracking board remains available. The
          Agent tab shows an empty-state when there's no selection. */}
      {inspectorMounted && (
        <aside className={`flat-inspector ${inspectorAnimateOpen ? 'flat-inspector--open' : 'flat-inspector--closing'}`} aria-label={t('terminal:flatView.inspectorPanel', { defaultValue: 'Inspector panel' })}>
          <div className="flat-inspector__header">
            <div className="flat-inspector__tabs" role="tablist" aria-label={t('terminal:flatView.inspectorView', { defaultValue: 'Inspector view' })}>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorView === 'agent'}
                className={`flat-inspector__tab ${inspectorView === 'agent' ? 'flat-inspector__tab--active' : ''}`}
                onClick={() => setInspectorView('agent')}
              >
                {t('common:labels.agent')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorView === 'tracking'}
                className={`flat-inspector__tab ${inspectorView === 'tracking' ? 'flat-inspector__tab--active' : ''}`}
                onClick={() => setInspectorView('tracking')}
              >
                {t('common:mobileBottomMenu.tracking')}
              </button>
            </div>
            <button
              type="button"
              className="flat-inspector__close"
              onClick={handleCloseInspector}
              title={t('terminal:flatView.closeInspector', { defaultValue: 'Close inspector' })}
              aria-label={t('terminal:flatView.closeInspector', { defaultValue: 'Close inspector' })}
            >
              ✕
            </button>
          </div>
          <div className="flat-inspector__body">
            {inspectorView === 'tracking' ? (
              <TrackingBoard
                activeAgentId={selectedAgentId ?? ''}
                onSelectAgent={(agentId) => {
                  onAgentClick(agentId);
                  if (window.innerWidth <= 768) {
                    handleCloseInspector();
                  }
                }}
              />
            ) : (() => {
              if (!selectedAgentId) {
                return (
                  <div className="flat-inspector__empty">
                    <span>{t('terminal:flatView.selectAgentToInspect', { defaultValue: 'Select an agent to inspect' })}</span>
                  </div>
                );
              }
              if (!selectedAgent) {
                return (
                  <div className="flat-inspector__empty">
                    <span>{t('terminal:flatView.agentNotFound', { defaultValue: 'Agent not found' })}</span>
                  </div>
                );
              }
              return (
                <SingleAgentPanel
                  agent={selectedAgent}
                  onFocusAgent={(agentId) => {
                    onAgentClick(agentId);
                    if (window.innerWidth <= 768) {
                      handleCloseInspector();
                    }
                  }}
                  onKillAgent={(agentId) => store.killAgent(agentId)}
                />
              );
            })()}
          </div>
        </aside>
      )}

      {/* Terminal modals — portal-based, so position here is fine */}
      {imageModal && (
        <ImageModal
          url={imageModal.url}
          name={imageModal.name}
          onClose={closeImage}
          gallery={{ items: imageModal.items, index: imageModal.index, onNavigate: navigateImage }}
        />
      )}
      {bashModal && (
        <BashModal
          state={bashModal}
          onClose={() => setBashModal(null)}
        />
      )}
      <AgentResponseModalWrapper
        agent={selectedAgent ?? null}
        content={responseModalContent}
        onClose={() => setResponseModalContent(null)}
      />
      {clearSubsModal && (
        <ContextConfirmModal
          action="clear-subordinates"
          selectedAgentId={clearSubsModal.agentId}
          subordinateCount={clearSubsModal.count}
          onClose={() => setClearSubsModal(null)}
          onClearHistory={() => {
            // No local history is loaded for subordinates in this view — the
            // store action invalidates their cached outputs and clears them
            // server-side, so there is nothing extra to reset here.
          }}
        />
      )}
      <AgentInfoModal
        agent={selectedAgent ?? null}
        isOpen={agentInfoOpen && !!selectedAgentId}
        onClose={handleCloseAgentInfo}
      />

      <ContextMenu
        isOpen={emptyAgentContextMenu !== null}
        position={emptyAgentContextMenu?.position ?? { x: 0, y: 0 }}
        worldPosition={{ x: 0, z: 0 }}
        actions={emptyAgentContextMenuActions}
        onClose={() => setEmptyAgentContextMenu(null)}
      />

      <ContextMenu
        isOpen={buildingContextMenu !== null}
        position={buildingContextMenu?.position ?? { x: 0, y: 0 }}
        worldPosition={{ x: 0, z: 0 }}
        actions={buildingContextMenuActions}
        onClose={() => setBuildingContextMenu(null)}
      />

      <ConfirmModal
        isOpen={removeAgentConfirm !== null}
        title={t('common:confirm.removeAgentTitle')}
        message={t('common:confirm.removeAgentMessage', { name: removeAgentConfirm?.name ?? '' })}
        confirmLabel={t('common:buttons.remove')}
        cancelLabel={t('common:buttons.cancel')}
        variant="danger"
        onConfirm={() => {
          if (removeAgentConfirm) {
            store.removeAgentFromServer(removeAgentConfirm.agentId);
          }
        }}
        onClose={() => setRemoveAgentConfirm(null)}
      />
      <ConfirmModal
        isOpen={standbyConfirm !== null}
        title={t('terminal:overview.standbyConfirmTitle', { defaultValue: 'Set agent on standby?' })}
        message={t('terminal:overview.standbyConfirmMessage', {
          defaultValue: '{{name}} stops immediately and will not receive any delegations until you restore it manually from this panel.',
          name: standbyConfirm?.name ?? '',
        })}
        confirmLabel={t('terminal:overview.standbyAction', { defaultValue: 'Set on standby' })}
        cancelLabel={t('common:buttons.cancel')}
        variant="primary"
        onConfirm={() => {
          if (standbyConfirm) store.setAgentStandby(standbyConfirm.agentId, true);
        }}
        onClose={() => setStandbyConfirm(null)}
      />
    </div>
  );
}
