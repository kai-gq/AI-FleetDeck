/**
 * 富聊天视图(react.memo 组件,自 FlatView 按块迁出)。
 *
 * 自 index.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type ChatViewProps } from './types';
import { TERMINAL_VIEW_MODES, TERMINAL_VIEW_MODE_LABELS, TERMINAL_VIEW_MODE_ICONS, TERMINAL_VIEW_MODE_DESCRIPTIONS, CLEAR_CONFIRM_ID } from './constants';
import { readFlatEmbeddedPanels, writeFlatEmbeddedPanel, formatCwdShort, getAgentModelLabel, flatIsPositionInArea } from './helpers';
import React, { useState, useMemo, useCallback, useRef, useEffect, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgents, useAgent, useAreas, useBuildings, useRunningTestRoots, isTestPathRelated } from '../../../store/selectors';
import { store, useSettings } from '../../../store';
import { outdatedAgentModel } from '../../../../shared/model-freshness';
import { Agent } from '../../../../shared/types';
import { ProviderIcon } from '../../ProviderIcon';
import { AgentIcon } from '../../AgentIcon';
import { Icon, type IconName } from '../../Icon';
import { ActivityGlyph } from '../../shared/ActivityGlyph';
import { ContextMenu, type ContextMenuAction } from '../../ContextMenu';
import { getAgentStatusColor } from '../../../utils/colors';
import { getDisplayContextInfo } from '../../../utils/context';
import { AgentTerminalPane, type AgentTerminalPaneHandle } from '../../ClaudeOutputPanel/AgentTerminalPane';
import { buildImageGallery } from '../../ClaudeOutputPanel/imageGallery';
import { useCtrlCStopAgent } from '../../ClaudeOutputPanel/useCtrlCStopAgent';
import AgentClassicTerminal from '../AgentClassicTerminal';
import { PlanLimitsTooltip, getWeeklyUsageWindow, useProviderUsageSnapshot } from '../PlanLimitsTooltip';
import { getUsedPercentColor } from '../../../utils/claude-usage-format';
import { formatTokenCapacity } from '../../../utils/formatting';
import { AgentDebugPanel } from '../../ClaudeOutputPanel/AgentDebugPanel';
import { AreaBuildingsPanel } from '../../ClaudeOutputPanel/AreaBuildingsPanel';
import { GuakeGitPanel } from '../../ClaudeOutputPanel/GuakeGitPanel';
import { GuakeTaskBanner } from '../../ClaudeOutputPanel/GuakeTaskBanner';
import { ContextConfirmModal } from '../../ClaudeOutputPanel/TerminalModals';
import { useModalStackRegistration } from '../../../hooks/useModalStack';
import { useBottomTerminalResize } from '../../ClaudeOutputPanel/useBottomTerminalResize';
import { useSidePanelResize } from '../../ClaudeOutputPanel/useSidePanelResize';
import { ThemeSelector } from '../../ClaudeOutputPanel/ThemeSelector';
import { useGitBranches } from '../../ClaudeOutputPanel/useGitBranch';
import TerminalEmbed from '../../TerminalEmbed';
import { HttpRequestsBrowser } from '../../HttpRequestsBuildingModal';
import { TestsBrowser } from '../../TestsBuildingModal';
import { BottomPm2LogContent } from '../../ClaudeOutputPanel/BottomPm2LogContent';
import { DatabasePanelInline } from '../../database/DatabasePanelInline';
import { getBuildingViewMode, expandBuilding, type DockPanelType } from '../../../utils/buildingViewMode';
import { areaTerminalId, isAreaTerminalId, areaIdFromTerminalId, startAreaTerminal } from '../../../api/area-terminal';
import { BOTTOM_PM2_LOG_RETENTION_OPTIONS, readBottomPm2LogRetention, writeBottomPm2LogRetention } from '../../../utils/logRetention';
import { CopyAgentIdentityButton } from '../../shared/CopyAgentIdentityButton';
import { useTwoClickConfirm } from '../../../hooks';
import { getStorageBoolean, setStorageBoolean, STORAGE_KEYS } from '../../../utils/storage';

export const ChatView = React.memo(function ChatView({
  agentId,
  terminalViewMode,
  onTerminalViewModeChange,
  inspectorOpen,
  onToggleInspector,
  onShowTaskBoard,
  onImageClick,
  onFileClick,
  onBashClick,
  onViewMarkdown,
  onRequestClearSubordinates,
  keyboard,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
  agentInfoOpen,
  onToggleAgentInfo,
  onHeaderContextMenu,
  onBuildingContextMenu,
}: ChatViewProps) {
  const agent = useAgent(agentId);
  const buildings = useBuildings();
  const settings = useSettings();
  const { t } = useTranslation(['terminal', 'common']);
  const paneRef = useRef<AgentTerminalPaneHandle>(null);
  // The pane owns the conversation data; the modal lives in the parent. Attach
  // the gallery here so the parent's viewer can browse every image.
  const handlePaneImageClick = useCallback((url: string, name: string) => {
    const pane = paneRef.current;
    onImageClick(url, name, buildImageGallery(pane?.getDedupedHistory() ?? [], pane?.getDedupedOutputs() ?? [], url, name, agent?.cwd));
  }, [onImageClick, agent?.cwd]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const provider = agent?.provider ?? 'claude';
  const usageProviderSupported = provider === 'claude'
    || provider === 'codex'
    || provider === 'opencode'
    || provider === 'grok'
    || provider === 'pi';
  // Pi can change its underlying provider/model without changing agent ID.
  // Include that selection in the cache identity to avoid showing stale limits.
  const usageScope = provider === 'pi'
    ? `${provider}:${agent?.piModelProvider ?? ''}:${agent?.piModel ?? ''}`
    : provider === 'opencode'
      ? `${provider}:${agent?.opencodeModel ?? ''}`
      : provider;
  const providerUsage = useProviderUsageSnapshot(
    agentId,
    !!agent && usageProviderSupported,
    60_000,
    usageScope,
  );

  // Ctrl+C stops this chat's agent while its run is in flight.
  useCtrlCStopAgent(true, agentId);

  // Swap the keyed conversation immediately. The former outgoing/incoming
  // opacity crossfade deliberately rendered a blank frame between panes, which
  // read as a flicker and added 30ms to every selection.
  const displayedAgentId = agentId;
  const displayedAgent = agent;

  // "Classic TUI" view: only offered when interactive-TUI mode is enabled and
  // this is a Claude agent that has a session (i.e. a tc-int-<agentId> tmux
  // session exists). Toggles a local, per-agent embedded-terminal view.
  const classicTuiAvailable =
    !!settings.interactiveMode && (agent?.provider ?? 'claude') === 'claude' && !!agent?.sessionId;
  const [classicTuiOpen, setClassicTuiOpen] = useState(false);
  const [showSlashCommandOutputs, setShowSlashCommandOutputs] = useState(() =>
    getStorageBoolean(STORAGE_KEYS.SLASH_COMMAND_OUTPUTS_VISIBLE, true)
  );
  const toggleSlashCommandOutputs = useCallback(() => {
    setShowSlashCommandOutputs((visible) => {
      const next = !visible;
      setStorageBoolean(STORAGE_KEYS.SLASH_COMMAND_OUTPUTS_VISIBLE, next);
      return next;
    });
  }, []);
  // Anchor for the view-mode dropdown (null = closed).
  const [viewModeMenu, setViewModeMenu] = useState<{ x: number; y: number } | null>(null);

  // Every message-view option plus Classic TUI, with the active one ticked in
  // the shortcut slot (ContextMenu has no checked state of its own).
  const viewModeActions = useMemo((): ContextMenuAction[] => {
    const actions: ContextMenuAction[] = TERMINAL_VIEW_MODES.map((mode) => {
      const isActive = !classicTuiOpen && terminalViewMode === mode;
      return {
        id: `view-mode-${mode}`,
        label: t(`flatView.mode.${mode}`, { defaultValue: TERMINAL_VIEW_MODE_LABELS[mode] }),
        icon: <span className="flat-terminal-wrapper__view-mode-icon">{TERMINAL_VIEW_MODE_ICONS[mode]}</span>,
        shortcut: isActive ? '✓' : undefined,
        onClick: () => {
          setClassicTuiOpen(false);
          onTerminalViewModeChange(mode);
          setViewModeMenu(null);
        },
      };
    });

    if (classicTuiAvailable) {
      actions.push({
        id: 'view-mode-classic-tui',
        label: t('flatView.classicTui', { defaultValue: 'Classic TUI' }),
        icon: <Icon name="terminal" size={13} />,
        shortcut: classicTuiOpen ? '✓' : undefined,
        onClick: () => {
          setClassicTuiOpen((open) => !open);
          setViewModeMenu(null);
        },
      });
    }

    return actions;
  }, [classicTuiAvailable, classicTuiOpen, terminalViewMode, onTerminalViewModeChange, t]);
  // Mobile-only bottom sheet that relocates the header action cluster (search /
  // clear / git / buildings / debug / destructive ops) into a thumb-reachable
  // surface. On phones the top-right cluster is hidden (CSS) and a single
  // trigger opens this sheet; desktop keeps the inline cluster. Registered on
  // the modal stack so Escape / Android-back close it.
  const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
  const closeActionsSheet = useCallback(() => setActionsSheetOpen(false), []);
  useModalStackRegistration('flat-chat-actions', actionsSheetOpen, closeActionsSheet);
  // Bridge: the mobile bottom-nav "Actions" button lives in App's
  // MobileBottomMenu (a separate React tree), so it toggles this sheet via a
  // window event rather than a prop.
  useEffect(() => {
    const handler = () => setActionsSheetOpen((o) => !o);
    window.addEventListener('tide:toggle-chat-actions', handler);
    return () => window.removeEventListener('tide:toggle-chat-actions', handler);
  }, []);
  // Reset when switching agents or when it stops being available.
  useEffect(() => {
    setClassicTuiOpen(false);
    setActionsSheetOpen(false);
  }, [agentId]);
  useEffect(() => {
    if (!classicTuiAvailable && classicTuiOpen) setClassicTuiOpen(false);
  }, [classicTuiAvailable, classicTuiOpen]);

  // Mouse back/forward button gestures for agent history navigation — mirrors
  // the 3D ClaudeOutputPanel so the Flat view responds to the same physical
  // mouse side-buttons. Scoped to the flat-terminal-wrapper element.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        onNavigateBack();
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        onNavigateForward();
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    };

    el.addEventListener('mouseup', onMouseUp);
    el.addEventListener('mousedown', onMouseDown);
    return () => {
      el.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('mousedown', onMouseDown);
    };
  }, [onNavigateBack, onNavigateForward]);

  // Mac trackpad two-finger horizontal swipe → prev/next agent. macOS browsers
  // translate the gesture into wheel events with horizontal deltaX; relying on
  // popstate alone is unreliable because Safari/Chrome may not commit a same-
  // URL pushState navigation. We accumulate horizontal delta and fire when
  // dominant horizontal motion crosses a threshold. Skipped when the gesture
  // is consumed by an inner horizontally-scrollable element (e.g. wide code).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    let accumX = 0;
    let lastWheelAt = 0;
    let cooldownUntil = 0;
    const RESET_MS = 250;
    const COOLDOWN_MS = 600;
    const THRESHOLD = 80;
    const DOMINANCE = 1.5;

    const isInHorizontalScroller = (target: EventTarget | null): boolean => {
      let node = target instanceof HTMLElement ? target : null;
      while (node && node !== el) {
        const ox = window.getComputedStyle(node).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (now < cooldownUntil) {
        e.preventDefault();
        return;
      }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * DOMINANCE) {
        accumX = 0;
        return;
      }
      if (isInHorizontalScroller(e.target)) {
        accumX = 0;
        return;
      }
      if (now - lastWheelAt > RESET_MS) accumX = 0;
      lastWheelAt = now;
      accumX += e.deltaX;

      if (accumX <= -THRESHOLD) {
        accumX = 0;
        cooldownUntil = now + COOLDOWN_MS;
        e.preventDefault();
        onNavigateBack();
      } else if (accumX >= THRESHOLD) {
        accumX = 0;
        cooldownUntil = now + COOLDOWN_MS;
        e.preventDefault();
        onNavigateForward();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onNavigateBack, onNavigateForward]);

  // ── Statusbar: area folder lookup (mirrors the Guake statusbar deriv) ────
  const areas = useAreas();
  const agentAreaDirectories = useMemo(() => {
    if (!agent) return null;
    const matchedIds = new Set<string>();
    const matched: { id: string; name: string; directories: string[] }[] = [];
    for (const area of areas.values()) {
      if (area.archived || area.directories.length === 0) continue;
      if (area.assignedAgentIds.includes(agentId)) {
        matchedIds.add(area.id);
        matched.push(area);
      }
    }
    // Fallback: include areas containing the agent's position — keeps the
    // folder badges visible when assignment state is stale.
    for (const area of areas.values()) {
      if (area.archived || area.directories.length === 0 || matchedIds.has(area.id)) continue;
      if (flatIsPositionInArea({ x: agent.position.x, z: agent.position.z }, area)) {
        matchedIds.add(area.id);
        matched.push(area);
      }
    }
    if (matched.length === 0) return null;
    return matched.flatMap((a) =>
      a.directories
        .filter((d) => d && d.trim().length > 0)
        .map((d) => ({ areaId: a.id, areaName: a.name, dir: d }))
    );
  }, [agent, agentId, areas]);
  const { branches: areaBranches, fetchRemote: fetchGitRemote, fetchingDirs: gitFetchingDirs } =
    useGitBranches(agentAreaDirectories);

  // ── Area-scoped buildings for the statusbar (terminal / PM2 / database) ──
  // Mirrors ClaudeOutputPanel so the chat statusbar surfaces the same shortcut
  // buttons for buildings in the agent's working area.
  //
  // Proxy URLs of started zero-config area terminals (areaId → url). Session-
  // local cache; the start endpoint is idempotent so re-opening revalidates.
  const [areaTerminalUrls, setAreaTerminalUrls] = useState<Record<string, string>>({});
  const [areaTerminalError, setAreaTerminalError] = useState<string | null>(null);
  const areaTerminalBuildings = useMemo(() => {
    const area = store.getAreaForAgent(agentId);
    if (!area) return [];
    const result: { id: string; name: string; hasUrl: boolean; isDefault?: boolean }[] = [];
    // Zero-config default terminal — every area gets one (cwd'd to its first
    // assigned folder), no terminal building required.
    const areaDir = area.directories.find((d) => d && d.trim().length > 0)?.trim();
    const dirLabel = areaDir ? (areaDir.split('/').filter(Boolean).pop() || areaDir) : area.name;
    result.push({
      id: areaTerminalId(area.id),
      name: dirLabel,
      hasUrl: !!areaTerminalUrls[area.id],
      isDefault: true,
    });
    for (const building of buildings.values()) {
      if (building.type === 'terminal' && store.isPositionInArea(building.position, area)) {
        result.push({
          id: building.id,
          name: building.name,
          hasUrl: !!building.terminalStatus?.url,
        });
      }
    }
    return result;
  }, [agentId, buildings, areas, areaTerminalUrls]);

  const areaPm2Buildings = useMemo(() => {
    const area = store.getAreaForAgent(agentId);
    if (!area) return [];
    const result: { id: string; name: string }[] = [];
    for (const building of buildings.values()) {
      if (building.type === 'server' && building.pm2?.enabled && store.isPositionInArea(building.position, area)) {
        result.push({ id: building.id, name: building.name });
      }
    }
    return result;
  }, [agentId, buildings]);

  const areaDatabaseBuildings = useMemo(() => {
    const area = store.getAreaForAgent(agentId);
    if (!area) return [];
    const result: { id: string; name: string }[] = [];
    for (const building of buildings.values()) {
      if (building.type === 'database' && building.database && store.isPositionInArea(building.position, area)) {
        result.push({ id: building.id, name: building.name });
      }
    }
    return result;
  }, [agentId, buildings]);

  // Roots with a test run in flight — stable across per-line output updates
  // (only run start/finish changes it), so the statusbar flask can animate
  // while that building's tests execute without re-render storms.
  const runningTestRoots = useRunningTestRoots();
  const areaTestsBuildings = useMemo(() => {
    const area = store.getAreaForAgent(agentId);
    if (!area) return [];
    const result: { id: string; name: string; working: boolean }[] = [];
    for (const building of buildings.values()) {
      if (building.type === 'tests' && store.isPositionInArea(building.position, area)) {
        const working =
          !!building.folderPath &&
          runningTestRoots.some((root) => isTestPathRelated(root, building.folderPath!));
        result.push({ id: building.id, name: building.name, working });
      }
    }
    return result;
  }, [agentId, buildings, runningTestRoots]);

  // HTTP-requests buildings in the agent's area (statusbar shortcut buttons).
  const areaHttpBuildings = useMemo(() => {
    const area = store.getAreaForAgent(agentId);
    if (!area) return [];
    const result: { id: string; name: string }[] = [];
    for (const building of buildings.values()) {
      if (building.type === 'http' && store.isPositionInArea(building.position, area)) {
        result.push({ id: building.id, name: building.name });
      }
    }
    return result;
  }, [agentId, buildings]);

  const areaSlashCommandBuildings = useMemo(() => {
    const area = store.getAreaForAgent(agentId);
    if (!area) return [];
    const result: { id: string; name: string; icon?: string; command: string }[] = [];
    for (const building of buildings.values()) {
      if (
        building.type === 'slash-command'
        && building.slashCommand?.command
        && store.isPositionInArea(building.position, area)
      ) {
        result.push({
          id: building.id,
          name: building.name,
          icon: building.icon,
          command: building.slashCommand.command,
        });
      }
    }
    return result;
  }, [agentId, buildings]);

  // Search-mode mirror: paneRef owns the search state, but header buttons
  // need to re-render to reflect the active style when toggled. A counter
  // forces a re-render after we call toggleSearch().
  const [, bumpTick] = useReducer((x: number) => x + 1, 0);
  const searchMode = paneRef.current?.search.searchMode ?? false;
  const handleSearchToggle = useCallback(() => {
    paneRef.current?.search.toggleSearch();
    bumpTick();
  }, []);

  // Clear-context confirmation (two-click arm/confirm, shared hook so the
  // behavior matches the tracking board and the 3D header).
  const clearConfirm = useTwoClickConfirm();
  const isClearArmed = clearConfirm.isPending(CLEAR_CONFIRM_ID);

  // Embedded bottom panel — one building surface at a time (terminal, PM2
  // logs, database, tests or HTTP requests), rendered under the chat pane like
  // the Guake statusbar's bottom panels. The statusbar buttons toggle it; the
  // maximize button swaps to the building's rich modal.
  const [embeddedPanel, setEmbeddedPanel] = useState<{ type: DockPanelType; buildingId: string } | null>(null);
  const embeddedBuilding = embeddedPanel ? buildings.get(embeddedPanel.buildingId) : null;
  // PM2-panel chrome state (filter is per-open; retention shared with the guake panel).
  const [embeddedPm2Filter, setEmbeddedPm2Filter] = useState('');
  const [embeddedPm2Retention, setEmbeddedPm2Retention] = useState<number | null>(() => readBottomPm2LogRetention());
  const agentAreaId = useMemo(() => store.getAreaForAgent(agentId)?.id ?? null, [agentId, buildings]);
  // Explicit user actions persist the panel per area; the area-switch restore
  // effect below reads it back. Automatic closes (building removed / area
  // switch) must NOT persist — they'd clobber the user's saved choice.
  const toggleEmbeddedPanel = useCallback((type: DockPanelType, buildingId: string) => {
    setEmbeddedPm2Filter('');
    setEmbeddedPanel((prev) => {
      const next = prev?.buildingId === buildingId ? null : { type, buildingId };
      if (agentAreaId) writeFlatEmbeddedPanel(agentAreaId, next);
      return next;
    });
  }, [agentAreaId]);
  const closeEmbeddedPanel = useCallback(() => {
    setEmbeddedPm2Filter('');
    setEmbeddedPanel(null);
    if (agentAreaId) writeFlatEmbeddedPanel(agentAreaId, null);
  }, [agentAreaId]);
  // PM2 log streaming follows the panel lifecycle (same pattern as the guake
  // bottom panels: start on open, stop on close/swap).
  useEffect(() => {
    if (embeddedPanel?.type !== 'pm2-logs') return;
    const id = embeddedPanel.buildingId;
    store.startLogStreaming(id, 200);
    return () => store.stopLogStreaming(id);
  }, [embeddedPanel]);
  // Zero-config area terminal: start (or revalidate — the endpoint is
  // idempotent) whenever the embedded panel targets it. Covers both the
  // statusbar button click and the saved-panel restore on mount/area switch.
  // The ttyd is left running on close so reopening is instant.
  useEffect(() => {
    setAreaTerminalError(null);
    if (embeddedPanel?.type !== 'terminal' || !isAreaTerminalId(embeddedPanel.buildingId)) return;
    const areaId = areaIdFromTerminalId(embeddedPanel.buildingId);
    let cancelled = false;
    startAreaTerminal(areaId)
      .then((res) => {
        if (!cancelled) setAreaTerminalUrls((prev) => (prev[areaId] === res.url ? prev : { ...prev, [areaId]: res.url }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setAreaTerminalError(err instanceof Error ? err.message : t('flatView.failedToStartTerminal', { defaultValue: 'Failed to start terminal' }));
      });
    return () => { cancelled = true; };
  }, [embeddedPanel]);
  // Shared resizer — same hook the Guake bottom panel uses, so the persisted
  // height is kept in sync across both surfaces.
  const { height: embeddedHeight, onResizeStart: handleEmbeddedResizeStart } = useBottomTerminalResize();

  // Side-panel width — same shared hook + persisted width the Guake terminal
  // uses, so the git/buildings panels resize identically across both views.
  const { sidePanelWidth, handleSidePanelResizeStart } = useSidePanelResize();

  // Side panels (git / area buildings) — reuse the Guake components, persist
  // open-state to the same STORAGE_KEYS so the toggle survives a view swap.
  const [gitPanelOpen, setGitPanelOpen] = useState<boolean>(() =>
    getStorageBoolean(STORAGE_KEYS.GIT_PANEL_OPEN, false)
  );
  const [buildingsPanelOpen, setBuildingsPanelOpen] = useState<boolean>(() =>
    getStorageBoolean(STORAGE_KEYS.BUILDINGS_PANEL_OPEN, false)
  );
  // Debug panel parity with the Guake terminal header: same AgentDebugPanel.
  // Opening it does NOT turn message capture on — that is a persisted opt-in
  // switch inside the panel (see agentDebugger). Panel open state itself is
  // session-local, like the Guake version.
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const toggleDebugPanel = useCallback(() => {
    setDebugPanelOpen((prev) => !prev);
  }, []);
  const closeDebugPanel = useCallback(() => setDebugPanelOpen(false), []);
  const toggleGitPanel = useCallback(() => {
    setGitPanelOpen((prev) => {
      const next = !prev;
      setStorageBoolean(STORAGE_KEYS.GIT_PANEL_OPEN, next);
      return next;
    });
  }, []);
  const toggleBuildingsPanel = useCallback(() => {
    setBuildingsPanelOpen((prev) => {
      const next = !prev;
      setStorageBoolean(STORAGE_KEYS.BUILDINGS_PANEL_OPEN, next);
      return next;
    });
  }, []);
  const closeGitPanel = useCallback(() => {
    setGitPanelOpen(false);
    setStorageBoolean(STORAGE_KEYS.GIT_PANEL_OPEN, false);
  }, []);
  const closeBuildingsPanel = useCallback(() => {
    setBuildingsPanelOpen(false);
    setStorageBoolean(STORAGE_KEYS.BUILDINGS_PANEL_OPEN, false);
  }, []);

  // Agents Map needed by GuakeGitPanel's diff viewer lookups.
  const agentsMap = useAgents();

  // Buildings this pane can host, per panel type — drives both the ghost
  // cleanup and the dock-event membership check below.
  const embeddableByType = useMemo<Record<DockPanelType, { id: string }[]>>(() => ({
    terminal: areaTerminalBuildings,
    'pm2-logs': areaPm2Buildings,
    database: areaDatabaseBuildings,
    tests: areaTestsBuildings,
    http: areaHttpBuildings,
  }), [areaTerminalBuildings, areaPm2Buildings, areaDatabaseBuildings, areaTestsBuildings, areaHttpBuildings]);

  // Close the embed automatically if the building leaves the current area or
  // disappears, so the panel doesn't stick around as a stale ghost. Visual
  // close only — no LS write, so the restore effect below can bring the saved
  // panel back when the user returns to its area.
  useEffect(() => {
    if (!embeddedPanel) return;
    const stillInArea = embeddableByType[embeddedPanel.type].some((b) => b.id === embeddedPanel.buildingId);
    if (!stillInArea) {
      setEmbeddedPm2Filter('');
      setEmbeddedPanel(null);
    }
  }, [embeddedPanel, embeddableByType]);

  // Restore the area's saved panel when the pane lands on an agent of a
  // different area (and on mount/reload). Guarded by a ref so it fires once
  // per area change — in-area opens/closes are never overridden.
  const prevEmbedAreaRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevEmbedAreaRef.current === agentAreaId) return;
    prevEmbedAreaRef.current = agentAreaId;
    const saved = agentAreaId ? readFlatEmbeddedPanels()[agentAreaId] : undefined;
    setEmbeddedPm2Filter('');
    if (saved && embeddableByType[saved.type]?.some((b) => b.id === saved.buildingId)) {
      setEmbeddedPanel(saved);
    } else {
      setEmbeddedPanel(null);
    }
  }, [agentAreaId, embeddableByType]);

  // Dock request coming from a modal's minimize button while the flat chat
  // pane is the visible surface. Marking `handled` tells dockBuilding() it
  // doesn't need to fall back to the Guake bottom panel. Buildings outside
  // this pane's area stay unhandled — the still-in-area cleanup above would
  // immediately close them, so the guake dock is the better host.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ buildingId: string; type: DockPanelType; handled?: boolean }>).detail;
      if (!detail?.buildingId || !detail?.type) return;
      if (!embeddableByType[detail.type]?.some((b) => b.id === detail.buildingId)) return;
      detail.handled = true;
      setEmbeddedPm2Filter('');
      const panel = { type: detail.type, buildingId: detail.buildingId };
      setEmbeddedPanel(panel);
      if (agentAreaId) writeFlatEmbeddedPanel(agentAreaId, panel);
    };
    window.addEventListener('tide:dock-building-flat', handler as EventListener);
    return () => window.removeEventListener('tide:dock-building-flat', handler as EventListener);
  }, [embeddableByType, agentAreaId]);

  // More-actions menu (kebab) for collapse/remove/clear-subs
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  if (!agent) {
    return (
      <div className="flat-chat flat-chat--empty">
        <div className="flat-chat__placeholder">
          <span className="flat-chat__placeholder-icon">💬</span>
          <span className="flat-chat__placeholder-text">{t('flatView.selectAgent', { defaultValue: 'Select an agent to start chatting' })}</span>
        </div>
      </div>
    );
  }

  // Context / token usage calculations — shared resolver, same numbers as the
  // 3D overlay footer widget and the agent panels.
  const contextHasData = !!agent.contextStats;
  const {
    totalTokens: contextTotalTokens,
    contextWindow,
    usedPercent: contextUsedPercent,
  } = getDisplayContextInfo(agent);
  const contextUsedPercentDisplay = Math.round(contextUsedPercent * 10) / 10;
  const contextColor =
    contextUsedPercent >= 80
      ? '#ff4a4a'
      : contextUsedPercent >= 60
        ? '#ff9e4a'
        : contextUsedPercent >= 40
          ? '#ffd700'
          : '#4aff9e';
  const contextUsedK = (contextTotalTokens / 1000).toFixed(1);
  const contextLimitK = (contextWindow / 1000).toFixed(1);
  const contextWindowLabel = formatTokenCapacity(contextWindow);
  const weeklyWindow = getWeeklyUsageWindow(providerUsage.snapshot);
  const weeklyUsedPercent = weeklyWindow
    ? Math.max(0, Math.min(100, weeklyWindow.utilization))
    : null;
  const isOpenCodeFree = providerUsage.snapshot?.provider === 'opencode'
    && providerUsage.snapshot.plan === 'free';
  const weeklyColor = isOpenCodeFree
    ? '#4aff9e'
    : weeklyUsedPercent === null
      ? 'var(--text-muted)'
      : getUsedPercentColor(weeklyUsedPercent);
  const weeklyValue = isOpenCodeFree
    ? t('flatView.free', { defaultValue: 'Free' })
    : weeklyUsedPercent === null
      ? (providerUsage.loading ? '…' : '—')
      : `${Math.round(weeklyUsedPercent)}%`;

  const cwd = agent.cwd;
  const cwdShort = cwd ? formatCwdShort(cwd) : null;
  const subordinateCount = agent.subordinateIds?.length || 0;
  const hasSubordinates = subordinateCount > 0;

  return (
    <div
      ref={wrapperRef}
      className={`flat-terminal-wrapper ${gitPanelOpen || buildingsPanelOpen || debugPanelOpen ? 'flat-terminal-wrapper--with-side-panel' : ''}`}
      // Clamp to 70% of the (often narrow) Flat chat column so the side panel
      // can't overflow it and push the resize handle off the left edge. Panel
      // width, chat margin, and handle position all read this one var, so they
      // stay in sync. The Guake terminal is full-width and uses the raw px.
      style={{ '--guake-side-panel-width': `min(${sidePanelWidth}px, 70%)` } as React.CSSProperties}
    >
      <div className="flat-terminal-wrapper__header">
        <div
          className={`flat-terminal-wrapper__header-main ${agentInfoOpen ? 'flat-terminal-wrapper__header-main--active' : ''}`}
          onClick={onToggleAgentInfo}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onHeaderContextMenu({ x: e.clientX, y: e.clientY });
          }}
          title={agentInfoOpen ? t('flatView.hideAgentInfo', { defaultValue: 'Hide agent info' }) : t('flatView.showAgentInfo', { defaultValue: 'Show agent info' })}
        >
          <span className={`flat-terminal-wrapper__header-avatar${agent.status === 'working' ? ' is-working' : ''}`}>
            <AgentIcon agent={agent} size={28} />
            {agent.status === 'working' && (
              <ActivityGlyph animated size={12} className="flat-terminal-wrapper__header-activity" />
            )}
          </span>
          <span className="flat-terminal-wrapper__header-info">
            <span className="flat-terminal-wrapper__header-identity">
              <span className="flat-terminal-wrapper__header-name">{agent.name}</span>
              <CopyAgentIdentityButton name={agent.name} id={agent.id} />
            </span>
            <span
              className="flat-terminal-wrapper__header-status"
              style={{ color: getAgentStatusColor(agent.status) }}
              title={agent.status === 'error' && agent.lastError ? agent.lastError : undefined}
            >
              {agent.status}
            </span>
          </span>
          {agent.taskLabel && (
            <span className="flat-terminal-wrapper__header-task" title={agent.taskLabel}>
              📋 {agent.taskLabel}
            </span>
          )}
          <span className="flat-terminal-wrapper__header-model">
            <ProviderIcon
              agent={agent}
              alt={`${agent.name} provider`}
              className="flat-terminal-wrapper__header-provider-icon"
            />
            {(() => {
              const { model, effort } = getAgentModelLabel(agent);
              // Older generation than what the pickers now offer (e.g. Opus 5 → 5.5).
              const outdated = outdatedAgentModel(agent);
              const baseTitle = effort ? `Model: ${model} · Effort: ${effort}` : `Model: ${model}`;
              return (
                <span
                  className={`flat-terminal-wrapper__header-model-chip${outdated ? ' flat-terminal-wrapper__header-model-chip--outdated' : ''}`}
                  title={outdated ? `${baseTitle}\nA newer model is available: ${outdated.newerLabel}` : baseTitle}
                >
                  {outdated && <Icon name="warn" size={10} />}
                  <span className="flat-terminal-wrapper__header-model-name">{model}</span>
                  {effort && (
                    <>
                      <span className="flat-terminal-wrapper__header-model-sep" aria-hidden="true">·</span>
                      <span className="flat-terminal-wrapper__header-model-effort">{effort}</span>
                    </>
                  )}
                </span>
              );
            })()}
          </span>
        </div>
        <div className="flat-terminal-wrapper__header-meta">
          {/* One button showing the active mode; the rest live in a dropdown.
              The segmented control grew a button per mode and crowded the
              header, while all but one of them were always inactive. */}
          <div className="flat-terminal-wrapper__view-mode">
            <button
              type="button"
              className={`flat-terminal-wrapper__view-mode-btn flat-terminal-wrapper__view-mode-trigger${
                viewModeMenu ? ' flat-terminal-wrapper__view-mode-trigger--open' : ''
              }`}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setViewModeMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
              title={classicTuiOpen
                ? t('flatView.classicTuiTip', { defaultValue: 'Classic TUI — attach to the live interactive claude session in a terminal' })
                : t(`flatView.modeDesc.${terminalViewMode}`, { defaultValue: TERMINAL_VIEW_MODE_DESCRIPTIONS[terminalViewMode] })}
              aria-haspopup="menu"
              aria-expanded={!!viewModeMenu}
              aria-label={t('flatView.viewModeAria', { defaultValue: 'Message view mode' })}
            >
              <span className="flat-terminal-wrapper__view-mode-icon" aria-hidden="true">
                {classicTuiOpen ? <Icon name="terminal" size={13} /> : TERMINAL_VIEW_MODE_ICONS[terminalViewMode]}
              </span>
              <span className="flat-terminal-wrapper__view-mode-label">
                {classicTuiOpen ? t('flatView.classicTui', { defaultValue: 'Classic TUI' }) : t(`flatView.mode.${terminalViewMode}`, { defaultValue: TERMINAL_VIEW_MODE_LABELS[terminalViewMode] })}
              </span>
              <Icon name="caret-down" size={9} />
            </button>
          </div>
          {/* Applicable guake-actions — back/forward, search, clear-context, more-menu */}
          <div className="flat-terminal-wrapper__actions" role="group" aria-label={t('flatView.actionsAria', { defaultValue: 'Terminal actions' })}>
            <button
              type="button"
              className="flat-terminal-wrapper__action-btn"
              onClick={onNavigateBack}
              disabled={!canNavigateBack}
              title={t('flatView.prevAgent', { defaultValue: 'Back to previous agent' })}
              aria-label={t('flatView.prevAgent', { defaultValue: 'Back to previous agent' })}
            >
              <Icon name="arrow-left" size={14} />
            </button>
            <button
              type="button"
              className="flat-terminal-wrapper__action-btn"
              onClick={onNavigateForward}
              disabled={!canNavigateForward}
              title={t('flatView.nextAgent', { defaultValue: 'Forward to next agent' })}
              aria-label={t('flatView.nextAgent', { defaultValue: 'Forward to next agent' })}
            >
              <Icon name="arrow-right" size={14} />
            </button>
            <button
              type="button"
              className={`flat-terminal-wrapper__action-btn ${searchMode ? 'flat-terminal-wrapper__action-btn--active' : ''}`}
              onClick={handleSearchToggle}
              title={searchMode ? t('flatView.closeSearch', { defaultValue: 'Close search' }) : t('flatView.searchMessages', { defaultValue: 'Search messages' })}
              aria-pressed={searchMode}
            >
              <Icon name={searchMode ? 'cross' : 'search'} size={14} />
            </button>
            <button
              type="button"
              className={`flat-terminal-wrapper__action-btn ${showSlashCommandOutputs ? 'flat-terminal-wrapper__action-btn--active' : ''}`}
              onClick={toggleSlashCommandOutputs}
              title={showSlashCommandOutputs ? t('flatView.hideSlashOutput', { defaultValue: 'Hide slash command output' }) : t('flatView.showSlashOutput', { defaultValue: 'Show slash command output' })}
              aria-label={showSlashCommandOutputs ? t('flatView.hideSlashOutput', { defaultValue: 'Hide slash command output' }) : t('flatView.showSlashOutput', { defaultValue: 'Show slash command output' })}
              aria-pressed={showSlashCommandOutputs}
            >
              <Icon name={showSlashCommandOutputs ? 'eye' : 'eye-closed'} size={14} />
            </button>
            <button
              type="button"
              className={`flat-terminal-wrapper__action-btn flat-terminal-wrapper__action-btn--danger ${isClearArmed ? 'flat-terminal-wrapper__action-btn--confirm' : ''}`}
              onClick={() =>
                clearConfirm.handleClick(CLEAR_CONFIRM_ID, () => {
                  store.clearContext(agentId);
                  paneRef.current?.historyLoader.clearHistory();
                })
              }
              title={isClearArmed ? t('flatView.confirmClearTip', { defaultValue: 'Click again to confirm clear context' }) : t('flatView.clearContext', { defaultValue: 'Clear context' })}
            >
              <Icon name={isClearArmed ? 'question' : 'clear'} size={14} />
            </button>
            <button
              type="button"
              className={`flat-terminal-wrapper__action-btn ${gitPanelOpen ? 'flat-terminal-wrapper__action-btn--active' : ''}`}
              onClick={toggleGitPanel}
              title={gitPanelOpen ? t('flatView.hideGitPanel', { defaultValue: 'Hide git panel' }) : t('flatView.showGitChanges', { defaultValue: 'Show git changes' })}
              aria-pressed={gitPanelOpen}
            >
              <Icon name="git-branch" size={14} />
            </button>
            <button
              type="button"
              className={`flat-terminal-wrapper__action-btn ${buildingsPanelOpen ? 'flat-terminal-wrapper__action-btn--active' : ''}`}
              onClick={toggleBuildingsPanel}
              title={buildingsPanelOpen ? t('flatView.hideBuildingsPanel', { defaultValue: 'Hide buildings panel' }) : t('flatView.showAreaBuildings', { defaultValue: 'Show area buildings' })}
              aria-pressed={buildingsPanelOpen}
            >
              <Icon name="buildings" size={14} />
            </button>
            <div className="flat-terminal-wrapper__more" ref={menuRef}>
              <button
                type="button"
                className={`flat-terminal-wrapper__action-btn ${menuOpen ? 'flat-terminal-wrapper__action-btn--active' : ''}`}
                onClick={() => setMenuOpen((o) => !o)}
                title={t('header.moreActions', { defaultValue: 'More actions' })}
                aria-expanded={menuOpen}
              >
                ⋮
              </button>
              {menuOpen && (
                <div className="flat-terminal-wrapper__more-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={`flat-terminal-wrapper__more-item ${debugPanelOpen ? 'flat-terminal-wrapper__more-item--active' : ''}`}
                    onClick={() => {
                      toggleDebugPanel();
                      setMenuOpen(false);
                    }}
                    title={debugPanelOpen ? t('terminal:header.hideDebug') : t('terminal:header.showDebug')}
                  >
                    <Icon name="bug" size={14} />
                    <span>{debugPanelOpen ? t('terminal:header.hideDebug') : t('terminal:header.showDebug')}</span>
                  </button>
                  <div className="flat-terminal-wrapper__more-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="flat-terminal-wrapper__more-item"
                    onClick={() => {
                      store.collapseContext(agentId);
                      setMenuOpen(false);
                    }}
                    disabled={agent.status !== 'idle'}
                    title={agent.status !== 'idle' ? t('flatView.collapseContextIdleTip', { defaultValue: 'Agent must be idle to collapse context' }) : t('flatView.collapseContext', { defaultValue: 'Collapse context' })}
                  >
                    <Icon name="package" size={14} />
                    <span>{t('flatView.collapseContext', { defaultValue: 'Collapse context' })}</span>
                  </button>
                  {hasSubordinates && (
                    <button
                      type="button"
                      role="menuitem"
                      className="flat-terminal-wrapper__more-item flat-terminal-wrapper__more-item--danger"
                      onClick={() => {
                        // Route through the shared ContextConfirmModal so the
                        // destructive action has the same confirm-step UX as
                        // the 3D view (and so users get visible feedback).
                        onRequestClearSubordinates(agentId, subordinateCount);
                        setMenuOpen(false);
                      }}
                    >
                      <Icon name="crown" size={14} />
                      <span>
                        {t('flatView.clearSubordinates', { defaultValue: 'Clear {{count}} subordinate{{plural}}', count: subordinateCount, plural: subordinateCount === 1 ? '' : 's' })}
                      </span>
                    </button>
                  )}
                  <div className="flat-terminal-wrapper__more-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="flat-terminal-wrapper__more-item flat-terminal-wrapper__more-item--danger"
                    onClick={() => {
                      store.killAgent(agentId);
                      setMenuOpen(false);
                    }}
                  >
                    <Icon name="cross" size={14} />
                    <span>{t('flatView.removeAgent', { defaultValue: 'Remove agent' })}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`flat-terminal-wrapper__inspector-toggle ${
              inspectorOpen ? 'flat-terminal-wrapper__inspector-toggle--active' : ''
            }`}
            onClick={onToggleInspector}
            title={inspectorOpen ? t('flatView.hideInspector', { defaultValue: 'Hide inspector panel' }) : t('flatView.showInspector', { defaultValue: 'Show inspector panel' })}
            aria-label={inspectorOpen ? t('flatView.hideInspector', { defaultValue: 'Hide inspector panel' }) : t('flatView.showInspector', { defaultValue: 'Show inspector panel' })}
            aria-pressed={inspectorOpen}
          >
            <span className="flat-terminal-wrapper__inspector-icon" aria-hidden="true">
              {/* Sidebar-right icon */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                <line x1="10" y1="2.5" x2="10" y2="13.5" />
              </svg>
            </span>
            <span className="flat-terminal-wrapper__inspector-label">{t('common:mobileBottomMenu.inspector')}</span>
          </button>
          <button
            type="button"
            className="flat-terminal-wrapper__close"
            onClick={() => store.deselectAll()}
            title={t('flatView.closeChat', { defaultValue: 'Close chat' })}
            aria-label={t('flatView.closeChat', { defaultValue: 'Close chat' })}
          >
            <Icon name="cross" size={14} />
          </button>
        </div>
      </div>

      {/* Mobile-only chat-actions bottom sheet — the header cluster relocated
          into a thumb-reachable surface that slides up above the bottom-nav. */}
      {actionsSheetOpen && (
        <div className="flat-chat-actions-sheet-root" role="presentation">
          <div className="flat-chat-actions-sheet__backdrop" onClick={closeActionsSheet} />
          <div className="flat-chat-actions-sheet" role="menu" aria-label={t('flatView.chatActions', { defaultValue: 'Chat actions' })}>
            <div className="flat-chat-actions-sheet__grabber" aria-hidden="true" />
            <div className="flat-chat-actions-sheet__title-row">
              <span className="flat-chat-actions-sheet__title">{agent.name}</span>
              <button
                type="button"
                className="flat-chat-actions-sheet__done"
                onClick={closeActionsSheet}
              >
                {t('common:buttons.done')}
              </button>
            </div>
            <div className="flat-chat-actions-sheet__grid">
              <button
                type="button"
                role="menuitem"
                className={`flat-chat-actions-sheet__item ${searchMode ? 'is-active' : ''}`}
                onClick={() => { handleSearchToggle(); closeActionsSheet(); }}
              >
                <Icon name={searchMode ? 'cross' : 'search'} size={20} />
                <span>{searchMode ? t('flatView.closeSearch', { defaultValue: 'Close search' }) : t('common:buttons.search')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`flat-chat-actions-sheet__item ${showSlashCommandOutputs ? 'is-active' : ''}`}
                onClick={() => { toggleSlashCommandOutputs(); closeActionsSheet(); }}
              >
                <Icon name={showSlashCommandOutputs ? 'eye' : 'eye-closed'} size={20} />
                <span>{t('flatView.slashOutput', { defaultValue: 'Slash output' })}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`flat-chat-actions-sheet__item ${gitPanelOpen ? 'is-active' : ''}`}
                onClick={() => { toggleGitPanel(); closeActionsSheet(); }}
              >
                <Icon name="git-branch" size={20} />
                <span>{t('flatView.gitChanges', { defaultValue: 'Git changes' })}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`flat-chat-actions-sheet__item ${buildingsPanelOpen ? 'is-active' : ''}`}
                onClick={() => { toggleBuildingsPanel(); closeActionsSheet(); }}
              >
                <Icon name="buildings" size={20} />
                <span>{t('flatView.buildings', { defaultValue: 'Buildings' })}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`flat-chat-actions-sheet__item ${debugPanelOpen ? 'is-active' : ''}`}
                onClick={() => { toggleDebugPanel(); closeActionsSheet(); }}
              >
                <Icon name="bug" size={20} />
                <span>{t('flatView.debug', { defaultValue: 'Debug' })}</span>
              </button>
            </div>
            <div className="flat-chat-actions-sheet__list">
              <button
                type="button"
                role="menuitem"
                className={`flat-chat-actions-sheet__row flat-chat-actions-sheet__row--danger ${isClearArmed ? 'is-armed' : ''}`}
                onClick={() =>
                  clearConfirm.handleClick(CLEAR_CONFIRM_ID, () => {
                    store.clearContext(agentId);
                    paneRef.current?.historyLoader.clearHistory();
                    closeActionsSheet();
                  })
                }
              >
                <Icon name={isClearArmed ? 'question' : 'clear'} size={18} />
                <span>{isClearArmed ? t('flatView.confirmClearTap', { defaultValue: 'Tap again to confirm clear' }) : t('flatView.clearContext', { defaultValue: 'Clear context' })}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="flat-chat-actions-sheet__row"
                disabled={agent.status !== 'idle'}
                onClick={() => { store.collapseContext(agentId); closeActionsSheet(); }}
              >
                <Icon name="package" size={18} />
                <span>{t('flatView.collapseContext', { defaultValue: 'Collapse context' })}</span>
              </button>
              {hasSubordinates && (
                <button
                  type="button"
                  role="menuitem"
                  className="flat-chat-actions-sheet__row flat-chat-actions-sheet__row--danger"
                  onClick={() => { onRequestClearSubordinates(agentId, subordinateCount); closeActionsSheet(); }}
                >
                  <Icon name="crown" size={18} />
                  <span>{t('flatView.clearSubordinates', { defaultValue: 'Clear {{count}} subordinate{{plural}}', count: subordinateCount, plural: subordinateCount === 1 ? '' : 's' })}</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="flat-chat-actions-sheet__row flat-chat-actions-sheet__row--danger"
                onClick={() => { store.killAgent(agentId); closeActionsSheet(); }}
              >
                <Icon name="cross" size={18} />
                <span>{t('flatView.removeAgent', { defaultValue: 'Remove agent' })}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Current-task banner — what this agent is working on right now. */}
      <GuakeTaskBanner agent={agent} onClick={onShowTaskBoard} />

      {classicTuiOpen && classicTuiAvailable ? (
        <AgentClassicTerminal agentId={agentId} />
      ) : displayedAgentId && displayedAgent ? (
        <AgentTerminalPane
          key={displayedAgentId}
          ref={paneRef}
          agentId={displayedAgentId}
          agent={displayedAgent}
          viewMode={terminalViewMode}
          isOpen={true}
          showSlashCommandOutputs={showSlashCommandOutputs}
          onImageClick={handlePaneImageClick}
          onFileClick={onFileClick}
          onBashClick={onBashClick}
          onViewMarkdown={onViewMarkdown}
          keyboard={keyboard}
          hasModalOpen={false}
        />
      ) : null}
      {embeddedPanel && (embeddedBuilding || isAreaTerminalId(embeddedPanel.buildingId)) && (() => {
        const panelType = embeddedPanel.type;
        // The zero-config area default terminal has no backing building —
        // resolve its name from the statusbar entry and its URL from the
        // area-terminal start cache.
        const isAreaDefault = isAreaTerminalId(embeddedPanel.buildingId);
        const panelName = embeddedBuilding?.name
          ?? t('flatView.terminalPanelName', {
            defaultValue: 'Terminal — {{name}}',
            name: areaTerminalBuildings.find((b) => b.id === embeddedPanel.buildingId)?.name
              ?? t('flatView.areaFallback', { defaultValue: 'area' }),
          });
        const terminalUrl = isAreaDefault
          ? areaTerminalUrls[areaIdFromTerminalId(embeddedPanel.buildingId)]
          : embeddedBuilding?.terminalStatus?.url;
        const titleIcon: Record<DockPanelType, IconName> = {
          terminal: 'terminal',
          'pm2-logs': 'scroll',
          database: 'hard-drives',
          tests: 'flask',
          http: 'globe',
        };
        const terminalStarting = panelType === 'terminal' && !terminalUrl;
        // Terminals without a URL can't maximize (the modal needs the URL);
        // the area default terminal has no modal surface at all.
        const canMaximize = !terminalStarting && !isAreaDefault;
        return (
          <>
            <div
              className="guake-bottom-terminal-resize"
              onMouseDown={handleEmbeddedResizeStart}
              role="separator"
              aria-orientation="horizontal"
              aria-label={t('flatView.resizeEmbeddedPanel', { defaultValue: 'Resize embedded panel' })}
            />
            <div
              className="flat-bottom-panel"
              role="region"
              aria-label={t('flatView.panelAriaLabel', { defaultValue: '{{name}} panel', name: panelName })}
              style={{ height: embeddedHeight }}
            >
              <div className="flat-bottom-panel__header">
                <span className="flat-bottom-panel__title">
                  <Icon name={titleIcon[panelType]} size={12} />
                  <span>{panelName}</span>
                  {terminalStarting && <span className="flat-bottom-panel__muted">{t('flatView.startingMuted', { defaultValue: '(starting...)' })}</span>}
                </span>
                <span className="flat-bottom-panel__header-actions">
                  {panelType === 'pm2-logs' && embeddedBuilding && (
                    <>
                      <input
                        type="text"
                        className="guake-bottom-terminal-filter"
                        value={embeddedPm2Filter}
                        onChange={(e) => setEmbeddedPm2Filter(e.target.value)}
                        placeholder={t('flatView.filterLogsPlaceholder', { defaultValue: 'Filter logs' })}
                        aria-label={t('flatView.filterLogsFor', { defaultValue: 'Filter logs for {{name}}', name: embeddedBuilding.name })}
                        spellCheck={false}
                      />
                      <select
                        className="guake-bottom-terminal-retention"
                        value={embeddedPm2Retention === null ? 'unlimited' : String(embeddedPm2Retention)}
                        onChange={(e) => {
                          const nextValue = e.target.value === 'unlimited' ? null : Number(e.target.value);
                          setEmbeddedPm2Retention(nextValue);
                          writeBottomPm2LogRetention(nextValue);
                        }}
                        aria-label={t('flatView.maxLogRetentionFor', { defaultValue: 'Max log retention for {{name}}', name: embeddedBuilding.name })}
                      >
                        {BOTTOM_PM2_LOG_RETENTION_OPTIONS.map((option) => (
                          <option key={option === null ? 'unlimited' : option} value={option === null ? 'unlimited' : String(option)}>
                            {option === null ? t('flatView.unlimited', { defaultValue: 'Unlimited' }) : t('flatView.linesCount', { defaultValue: '{{count}} lines', count: option.toLocaleString() })}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="flat-bottom-panel__close"
                        onClick={() => store.clearStreamingLogs(embeddedPanel.buildingId)}
                        title={t('flatView.clearLogs', { defaultValue: 'Clear logs' })}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                      <button
                        type="button"
                        className="flat-bottom-panel__close"
                        onClick={() => store.sendBuildingCommand(embeddedPanel.buildingId, 'restart')}
                        title={t('terminal:buildingAction.restart')}
                      >
                        <Icon name="restart" size={12} />
                      </button>
                    </>
                  )}
                  {canMaximize && (
                    <button
                      type="button"
                      className="flat-bottom-panel__close"
                      onClick={() => {
                        closeEmbeddedPanel();
                        expandBuilding(embeddedPanel.buildingId);
                      }}
                      title={t('flatView.maximizeTip', { defaultValue: 'Maximize — open as modal' })}
                      aria-label={t('flatView.openAsModal', { defaultValue: 'Open as modal' })}
                    >
                      <Icon name="fullscreen" size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="flat-bottom-panel__close"
                    onClick={closeEmbeddedPanel}
                    title={t('common:rightPanel.closePanel')}
                    aria-label={t('common:rightPanel.closePanel')}
                  >
                    <Icon name="cross" size={12} />
                  </button>
                </span>
              </div>
              <div className="flat-bottom-panel__body">
                {panelType === 'terminal' ? (
                  terminalUrl ? (
                    <TerminalEmbed
                      terminalUrl={terminalUrl}
                      visible={true}
                    />
                  ) : (
                    <div className="flat-bottom-panel__placeholder">{areaTerminalError ?? t('flatView.startingTerminal', { defaultValue: 'Starting terminal...' })}</div>
                  )
                ) : panelType === 'pm2-logs' ? (
                  <BottomPm2LogContent
                    buildingId={embeddedPanel.buildingId}
                    filterText={embeddedPm2Filter}
                    maxRetention={embeddedPm2Retention}
                  />
                ) : !embeddedBuilding ? null : panelType === 'database' ? (
                  <DatabasePanelInline building={embeddedBuilding} />
                ) : panelType === 'tests' ? (
                  <div className="tests-panel-host">
                    <TestsBrowser building={embeddedBuilding} autoFocusSearch={false} />
                  </div>
                ) : (
                  <div className="http-requests-panel-host">
                    <HttpRequestsBrowser building={embeddedBuilding} autoFocusSearch={false} />
                  </div>
                )}
              </div>
            </div>
          </>
        );
      })()}
      <div className="flat-terminal-wrapper__statusbar" role="contentinfo">
        {agent.isDetached && (
          <span
            className="flat-terminal-wrapper__detached"
            title={t('flatView.reattachingTip', { defaultValue: 'Reattaching session...' })}
          >
            <Icon name="refresh" size={12} />
            <span>{t('flatView.reattaching', { defaultValue: 'Reattaching' })}</span>
          </span>
        )}
        {cwd && cwdShort && (
          <span
            className="flat-terminal-wrapper__cwd"
            title={t('flatView.openInExplorerTip', { defaultValue: 'Open in file explorer: {{cwd}}', cwd })}
            aria-label={t('flatView.openInExplorerAria', { defaultValue: 'Open {{cwd}} in file explorer', cwd })}
            role="button"
            tabIndex={0}
            onClick={() => store.openFileExplorer(cwd)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                store.openFileExplorer(cwd);
              }
            }}
          >
            <span className="flat-terminal-wrapper__cwd-icon">
              <Icon name="folder" size={12} />
            </span>
            <span className="flat-terminal-wrapper__cwd-text">{cwdShort}</span>
          </span>
        )}
        {agentAreaDirectories && agentAreaDirectories.map(({ areaId, areaName, dir }) => {
          const branchInfo = areaBranches.get(dir);
          const isFetching = gitFetchingDirs.has(dir);
          const dirLabel = dir.split('/').filter(Boolean).pop() || dir;
          return (
            <span
              key={`${areaId}:${dir}`}
              className="flat-terminal-wrapper__area-dir"
              title={`${areaName}: ${dir}${branchInfo ? ` (${branchInfo.branch}${branchInfo.ahead ? ` ↑${branchInfo.ahead}` : ''}${branchInfo.behind ? ` ↓${branchInfo.behind}` : ''})` : ''}`}
              onClick={() => store.openFileExplorerForAreaFolder(areaId, dir)}
            >
              <Icon name="folder-open" size={12} />
              <span className="flat-terminal-wrapper__area-dir-name">{dirLabel}</span>
              {branchInfo && (
                <>
                  <span className="flat-terminal-wrapper__area-dir-branch">
                    <Icon name="git-branch" size={10} /> {branchInfo.branch}
                  </span>
                  {branchInfo.ahead > 0 && (
                    <span className="flat-terminal-wrapper__branch-ahead" title={t('flatView.branchAhead', { defaultValue: '{{count}} ahead', count: branchInfo.ahead })}>
                      <Icon name="arrow-up" size={9} />{branchInfo.ahead}
                    </span>
                  )}
                  {branchInfo.behind > 0 && (
                    <span className="flat-terminal-wrapper__branch-behind" title={t('flatView.branchBehind', { defaultValue: '{{count}} behind', count: branchInfo.behind })}>
                      <Icon name="arrow-down" size={9} />{branchInfo.behind}
                    </span>
                  )}
                  <span
                    className={`flat-terminal-wrapper__area-fetch ${isFetching ? 'flat-terminal-wrapper__area-fetch--fetching' : ''}`}
                    title={t('terminal:gitPanel.gitFetch', { defaultValue: 'Git fetch' })}
                    onClick={(e) => { e.stopPropagation(); fetchGitRemote(dir); }}
                  >
                    <Icon name={isFetching ? 'hourglass' : 'download'} size={12} />
                  </span>
                </>
              )}
            </span>
          );
        })}
        <PlanLimitsTooltip
          agentId={agentId}
          usageScope={usageScope}
          disabled={!usageProviderSupported}
          contextSummary={
            contextHasData
              ? t('flatView.contextSummary', { defaultValue: 'Context: {{used}}k / {{limit}}k tokens ({{pct}}% used)', used: contextUsedK, limit: contextLimitK, pct: contextUsedPercentDisplay })
              : undefined
          }
        >
          <span
            className="flat-terminal-wrapper__context"
            tabIndex={0}
            role="button"
            onClick={() => store.setContextModalAgentId(agentId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                store.setContextModalAgentId(agentId);
              }
            }}
            // Native title only for harnesses without a quota endpoint.
            title={!usageProviderSupported
              ? (contextHasData
                  ? t('flatView.contextUsageTip', { defaultValue: 'Context usage: {{used}}k / {{limit}}k tokens ({{pct}}% used). Click to view stats.', used: contextUsedK, limit: contextLimitK, pct: contextUsedPercentDisplay })
                  : t('flatView.fetchStatsTip', { defaultValue: 'Click to fetch context stats' }))
              : undefined}
          >
            <span className="flat-terminal-wrapper__usage-bars">
              <span
                className="flat-terminal-wrapper__usage-gauge"
                title={t('flatView.sessionContextTip', { defaultValue: 'Session context: {{used}}k / {{limit}}k tokens ({{pct}}% used)', used: contextUsedK, limit: contextLimitK, pct: contextUsedPercentDisplay })}
              >
                <span className="flat-terminal-wrapper__usage-label">
                  {t('flatView.ctx', { defaultValue: 'Ctx' })} <span className="flat-terminal-wrapper__usage-window">{contextWindowLabel}</span>
                </span>
                <span className="flat-terminal-wrapper__context-bar">
                  <span
                    className="flat-terminal-wrapper__context-bar-fill"
                    style={{ width: `${contextUsedPercent}%`, backgroundColor: contextColor }}
                  />
                </span>
                <span className="flat-terminal-wrapper__usage-value" style={{ color: contextColor }}>
                  {Math.round(contextUsedPercent)}%
                </span>
              </span>
              <span
                className="flat-terminal-wrapper__usage-gauge"
                title={weeklyWindow
                  ? t('flatView.weeklyUsageTip', { defaultValue: 'Weekly usage: {{pct}}% used', pct: Math.round(weeklyUsedPercent!) })
                  : isOpenCodeFree
                    ? t('flatView.opencodeFreeTip', { defaultValue: 'OpenCode free-model capacity is dynamic; no weekly quota is published' })
                    : providerUsage.error || t('flatView.weeklyUnavailableTip', { defaultValue: 'Weekly usage is unavailable for this provider/account' })}
              >
                <span className="flat-terminal-wrapper__usage-label">{t('flatView.week', { defaultValue: 'Week' })}</span>
                <span className="flat-terminal-wrapper__context-bar">
                  <span
                    className="flat-terminal-wrapper__context-bar-fill"
                    style={{ width: `${weeklyUsedPercent ?? 0}%`, backgroundColor: weeklyColor }}
                  />
                </span>
                <span className="flat-terminal-wrapper__usage-value" style={{ color: weeklyColor }}>
                  {weeklyValue}
                </span>
              </span>
            </span>
            {!contextHasData && (
              <span className="flat-terminal-wrapper__context-warning" title={t('flatView.noContextStats', { defaultValue: 'No context stats yet' })}>
                <Icon name="warn" size={12} />
              </span>
            )}
          </span>
        </PlanLimitsTooltip>
        <div className="flat-terminal-wrapper__statusbar-spacer" aria-hidden="true" />
        {/* Area-scoped building shortcuts — mirrors the Guake statusbar so the
            user can jump into a terminal/PM2 logs/database from any view. */}
        {areaTerminalBuildings.length > 0 && (
          <span className="flat-terminal-wrapper__buildings" role="group" aria-label={t('flatView.areaTerminals', { defaultValue: 'Area terminals' })}>
            {areaTerminalBuildings.map((tb) => {
              const isActive = embeddedPanel?.buildingId === tb.id;
              // The area default terminal is zero-config: no building to
              // start/expand — opening the panel is all it takes (the start
              // effect spins up the ttyd on demand).
              if (tb.isDefault) {
                return (
                  <button
                    key={tb.id}
                    type="button"
                    className={`flat-terminal-wrapper__building-btn flat-terminal-wrapper__building-btn--default ${isActive ? 'flat-terminal-wrapper__building-btn--active' : ''}`}
                    title={t('flatView.toggleAreaTerminal', { defaultValue: '{{action}} area terminal: {{name}}', action: t(isActive ? 'flatView.hideAction' : 'flatView.showAction'), name: tb.name })}
                    onClick={() => {
                      if (isActive) closeEmbeddedPanel();
                      else toggleEmbeddedPanel('terminal', tb.id);
                    }}
                  >
                    <Icon name="terminal" size={14} />
                  </button>
                );
              }
              return (
                <button
                  key={tb.id}
                  type="button"
                  className={`flat-terminal-wrapper__building-btn ${isActive ? 'flat-terminal-wrapper__building-btn--active' : ''} ${!tb.hasUrl ? 'flat-terminal-wrapper__building-btn--offline' : ''}`}
                  title={!tb.hasUrl
                    ? t('flatView.toggleTerminalStarting', { defaultValue: '{{action}} terminal: {{name}} (starting...)', action: t(isActive ? 'flatView.hideAction' : 'flatView.showAction'), name: tb.name })
                    : t('flatView.toggleTerminal', { defaultValue: '{{action}} terminal: {{name}}', action: t(isActive ? 'flatView.hideAction' : 'flatView.showAction'), name: tb.name })}
                  onClick={() => {
                    if (isActive) {
                      closeEmbeddedPanel();
                      return;
                    }
                    if (tb.hasUrl && getBuildingViewMode(tb.id) === 'modal') {
                      expandBuilding(tb.id);
                      return;
                    }
                    if (!tb.hasUrl) store.sendBuildingCommand(tb.id, 'start');
                    toggleEmbeddedPanel('terminal', tb.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onBuildingContextMenu(tb.id, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <Icon name="terminal" size={14} />
                </button>
              );
            })}
          </span>
        )}
        {areaPm2Buildings.length > 0 && (
          <span className="flat-terminal-wrapper__buildings" role="group" aria-label={t('flatView.areaPm2Logs', { defaultValue: 'Area PM2 logs' })}>
            {areaPm2Buildings.map((sb) => {
              const isActive = embeddedPanel?.buildingId === sb.id;
              return (
                <button
                  key={sb.id}
                  type="button"
                  className={`flat-terminal-wrapper__building-btn ${isActive ? 'flat-terminal-wrapper__building-btn--active' : ''}`}
                  title={t('flatView.toggleLogs', { defaultValue: '{{action}} logs: {{name}}', action: t(isActive ? 'flatView.hideAction' : 'flatView.showAction'), name: sb.name })}
                  onClick={() => {
                    if (isActive) {
                      closeEmbeddedPanel();
                    } else if (getBuildingViewMode(sb.id) === 'modal') {
                      expandBuilding(sb.id);
                    } else {
                      toggleEmbeddedPanel('pm2-logs', sb.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onBuildingContextMenu(sb.id, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <Icon name="scroll" size={14} />
                </button>
              );
            })}
          </span>
        )}
        {areaDatabaseBuildings.length > 0 && (
          <span className="flat-terminal-wrapper__buildings" role="group" aria-label={t('flatView.areaDatabases', { defaultValue: 'Area databases' })}>
            {areaDatabaseBuildings.map((db) => {
              const isActive = embeddedPanel?.buildingId === db.id;
              return (
                <button
                  key={db.id}
                  type="button"
                  className={`flat-terminal-wrapper__building-btn ${isActive ? 'flat-terminal-wrapper__building-btn--active' : ''}`}
                  title={t('flatView.toggleDatabase', { defaultValue: '{{action}} database: {{name}}', action: t(isActive ? 'flatView.hideAction' : 'flatView.showAction'), name: db.name })}
                  onClick={() => {
                    if (isActive) {
                      closeEmbeddedPanel();
                    } else if (getBuildingViewMode(db.id) === 'modal') {
                      expandBuilding(db.id);
                    } else {
                      toggleEmbeddedPanel('database', db.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onBuildingContextMenu(db.id, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <Icon name="hard-drives" size={14} />
                </button>
              );
            })}
          </span>
        )}
        {areaTestsBuildings.length > 0 && (
          <span className="flat-terminal-wrapper__buildings" role="group" aria-label={t('flatView.areaTests', { defaultValue: 'Area tests' })}>
            {areaTestsBuildings.map((tb) => {
              const isActive = embeddedPanel?.buildingId === tb.id;
              return (
                <button
                  key={tb.id}
                  type="button"
                  className={`flat-terminal-wrapper__building-btn ${isActive ? 'flat-terminal-wrapper__building-btn--active' : ''} ${tb.working ? 'flat-terminal-wrapper__building-btn--tests-working' : ''}`}
                  title={tb.working
                    ? t('flatView.runningTests', { defaultValue: 'Running tests: {{name}}', name: tb.name })
                    : t('flatView.toggleTests', { defaultValue: '{{action}} tests: {{name}}', action: t(isActive ? 'flatView.hideAction' : 'flatView.showAction'), name: tb.name })}
                  onClick={() => {
                    if (isActive) {
                      closeEmbeddedPanel();
                    } else if (getBuildingViewMode(tb.id) === 'modal') {
                      expandBuilding(tb.id);
                    } else {
                      toggleEmbeddedPanel('tests', tb.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onBuildingContextMenu(tb.id, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <Icon name="flask" size={14} />
                </button>
              );
            })}
          </span>
        )}
        {areaSlashCommandBuildings.length > 0 && (
          <span className="flat-terminal-wrapper__buildings" role="group" aria-label={t('flatView.areaSlashCommands', { defaultValue: 'Area slash commands' })}>
            {areaSlashCommandBuildings.map((slashBuilding) => (
              <button
                key={slashBuilding.id}
                type="button"
                className="flat-terminal-wrapper__building-btn flat-terminal-wrapper__building-btn--slash-command"
                title={t('flatView.runSlashCommand', { defaultValue: 'Run {{name}}: {{command}}', name: slashBuilding.name, command: slashBuilding.command })}
                aria-label={t('flatView.runSlashCommandAria', { defaultValue: 'Run {{name}}', name: slashBuilding.name })}
                data-building-id={slashBuilding.id}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('tide:open-slash-command-building', {
                    detail: { buildingId: slashBuilding.id },
                  }));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onBuildingContextMenu(slashBuilding.id, { x: e.clientX, y: e.clientY });
                }}
              >
                {slashBuilding.icon ? (
                  <span className="flat-terminal-wrapper__building-emoji" aria-hidden="true">
                    {slashBuilding.icon}
                  </span>
                ) : (
                  <Icon name="bolt" size={14} />
                )}
              </button>
            ))}
          </span>
        )}
        {areaHttpBuildings.length > 0 && (
          <span className="flat-terminal-wrapper__buildings" role="group" aria-label={t('flatView.areaHttpRequests', { defaultValue: 'Area HTTP requests' })}>
            {areaHttpBuildings.map((hb) => {
              const isActive = embeddedPanel?.buildingId === hb.id;
              return (
                <button
                  key={hb.id}
                  type="button"
                  className={`flat-terminal-wrapper__building-btn ${isActive ? 'flat-terminal-wrapper__building-btn--active' : ''}`}
                  title={t('flatView.toggleHttpRequests', { defaultValue: '{{action}} HTTP requests: {{name}}', action: t(isActive ? 'flatView.hideAction' : 'flatView.showAction'), name: hb.name })}
                  onClick={() => {
                    if (isActive) {
                      closeEmbeddedPanel();
                    } else if (getBuildingViewMode(hb.id) === 'modal') {
                      expandBuilding(hb.id);
                    } else {
                      toggleEmbeddedPanel('http', hb.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onBuildingContextMenu(hb.id, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <Icon name="globe" size={14} />
                </button>
              );
            })}
          </span>
        )}
        <div className="flat-terminal-wrapper__theme">
          <ThemeSelector iconOnly />
        </div>
      </div>
      {/* Side panels — reuse the same GuakeGitPanel / AreaBuildingsPanel the
          3D view uses, so the feature set stays aligned. They position
          absolutely against the .flat-terminal-wrapper (position: relative).
          The git panel renders its own resize handle (glued to its left edge)
          via onResizeStart, so it can't detach from the panel in this layout. */}
      {gitPanelOpen && (
        <GuakeGitPanel
          agentId={agentId}
          agents={agentsMap}
          onClose={closeGitPanel}
          branchInfoMap={areaBranches}
          fetchRemote={fetchGitRemote}
          fetchingDirs={gitFetchingDirs}
          onResizeStart={(e) => handleSidePanelResizeStart(e, 'right')}
        />
      )}
      {buildingsPanelOpen && (
        <AreaBuildingsPanel
          agentId={agentId}
          onClose={closeBuildingsPanel}
        />
      )}
      {debugPanelOpen && (
        <AgentDebugPanel agentId={agentId} onClose={closeDebugPanel} />
      )}

      <ContextMenu
        isOpen={viewModeMenu !== null}
        position={viewModeMenu ?? { x: 0, y: 0 }}
        worldPosition={{ x: 0, z: 0 }}
        actions={viewModeActions}
        onClose={() => setViewModeMenu(null)}
      />
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================
