/**
 * Agent Overview Panel
 *
 * Displays all agents grouped by area in a collapsible side panel within the Guake Terminal.
 * Shows agent status, last message, recent tool activity, and subagent information.
 * Inspired by the AgentDebugPanel layout.
 * 辅助类型 / 常量 / 助手与卡片、分组区块已拆入 ./agent-overview/(2026-10-11 W2 拆分);
 * 本文件保留主面板组件与对外导出。
 */

// ============================================================================
// 模块拆分(W2,2026-10-11):辅助类型 / 常量 / 助手 / 卡片与分组区块已拆入
// ./agent-overview/;本文件保留主面板组件与对外导出(导出面不变)。
// ============================================================================

import { type AopConfig, type AgentOverviewPanelProps, type SortMode, type FilterMode, type SearchMatchContext, type AreaGroup, type AgentCardSelectionState } from './agent-overview/types';
import { EMPTY_TOOL_EXECS, EMPTY_SUBAGENTS, EMPTY_SUBORDINATES, STATUS_COLORS } from './agent-overview/constants';
import { keepArray, keepMap, keepSet } from './agent-overview/helpers';
import { AgentCardSelectionContext, AgentCard } from './agent-overview/AgentCard';
import { AreaGroupSection } from './agent-overview/AreaGroupSection';
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentsArray, useAgentsWithUnseenOutput, useCustomAgentClassesArray, useToolExecutions, useSubagents, useAreas, useFileChanges, useCompactingAgents, store } from '../../store';
import { STORAGE_KEYS, getStorage, setStorage } from '../../utils/storage';
import { makeAgentOverviewComparator } from './agentOverviewSort';
import { AgentActivityDock } from './AgentActivityDock';
import { useAgentDockPosition } from './agentDockPosition';
import { type Agent, type Subagent, type DrawingArea } from '../../../shared/types';
import { type ToolExecution } from '../../store/types';
import { ContextMenu } from '../ContextMenu';
import { type ContextMenuAction } from '../ContextMenu';
import { buildAgentContextMenuActions } from './agentContextMenuActions';
import { findFreeAreaSpot } from '../../utils/areaPlacement';
import { AREA_COLORS } from '../../utils/colors';
import { WorkspaceSwitcher, useWorkspaceFilter, isAgentVisibleInWorkspace } from '../WorkspaceSwitcher';
import { BulkManageModal } from '../BulkManageModal';
import { Icon } from '../Icon';
import { ConfirmModal } from '../shared/ConfirmModal';
import { SubordinateProgressDots } from '../shared/SubordinateProgressDots';
import { providerAssetUrl, providerLabel } from '../../utils/providerDisplay';

export function AgentOverviewPanel({ activeAgentId, onClose, onSelectAgent, mobileFull = false, onToggleMobileFull, agentListRef: externalAgentListRef, twoFingerState, expandedAreas: externalExpandedAreas, onToggleArea: externalOnToggleArea, onSetExpandedAreas }: AgentOverviewPanelProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const allAgents = useAgentsArray();
  const [activeWorkspace] = useWorkspaceFilter();
  const agents = useMemo(() => {
    if (!activeWorkspace) return allAgents;
    return allAgents.filter(a => {
      const area = store.getAreaForAgent(a.id);
      return isAgentVisibleInWorkspace(area?.id ?? null);
    });
  }, [allAgents, activeWorkspace]);
  const agentsWithUnseenOutput = useAgentsWithUnseenOutput();
  const toolExecutions = useToolExecutions();
  const subagents = useSubagents();
  const areas = useAreas();
  const fileChanges = useFileChanges();
  // These collections are shared by every card. One parent subscription avoids
  // two store listeners per row (a large fan-out during streamed output).
  const customAgentClasses = useCustomAgentClassesArray();
  const compactingAgents = useCompactingAgents();
  const dockPosition = useAgentDockPosition();

  // Resolve subordinate Agent objects per boss for the SubordinateProgressDots indicator.
  const prevSubordinatesByBossRef = useRef<Map<string, Agent[]>>(new Map());
  const subordinatesByBoss = useMemo(() => {
    const byId = new Map(allAgents.map((a) => [a.id, a]));
    const map = new Map<string, Agent[]>();
    const prev = prevSubordinatesByBossRef.current;
    for (const agent of allAgents) {
      if ((agent.isBoss || agent.class === 'boss') && agent.subordinateIds && agent.subordinateIds.length > 0) {
        const subs = agent.subordinateIds
          .map((id) => byId.get(id))
          .filter((a): a is Agent => a !== undefined);
        if (subs.length > 0) {
          // Keep the previous array when the subordinate objects are the same
          // (AgentCard prop → memo stability across unrelated agent updates).
          map.set(agent.id, keepArray(prev.get(agent.id), subs));
        }
      }
    }
    const kept = keepMap(prev, map);
    prevSubordinatesByBossRef.current = kept;
    return kept;
  }, [allAgents]);

  // When the currently selected agent is a boss, highlight its subordinates in the panel
  // so the user can quickly see which agents report to the boss they just clicked.
  const prevSubordinatesOfActiveBossRef = useRef<Set<string> | null>(null);
  const subordinatesOfActiveBoss = useMemo(() => {
    const active = allAgents.find((a) => a.id === activeAgentId);
    let next: Set<string> | null = null;
    if (active) {
      const isBoss = active.isBoss || active.class === 'boss';
      if (isBoss && active.subordinateIds && active.subordinateIds.length > 0) next = new Set(active.subordinateIds);
    }
    const kept = keepSet(prevSubordinatesOfActiveBossRef.current, next);
    prevSubordinatesOfActiveBossRef.current = kept;
    return kept;
  }, [allAgents, activeAgentId]);

  // Load persisted config from localStorage
  const savedConfig = useMemo(() => getStorage<AopConfig>(STORAGE_KEYS.AOP_CONFIG, {
    groupByArea: true,
    sortMode: 'recent',
    filterMode: 'all',
    sameAreaOnly: false,
    visibleAreaIds: null,
    visibleProviders: null,
  }), []);

  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());
  // Areas render collapsed unless present in this set, so every page load
  // starts with all areas collapsed.
  const [internalExpandedAreas, setInternalExpandedAreas] = useState<Set<string>>(new Set());
  const expandedAreas = externalExpandedAreas ?? internalExpandedAreas;
  const [editingPromptAreaId, setEditingPromptAreaId] = useState<string | null>(null);
  const [editingPromptText, setEditingPromptText] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>(savedConfig.sortMode);
  const [filterMode, setFilterMode] = useState<FilterMode>(savedConfig.filterMode);
  const [searchQuery, setSearchQuery] = useState('');
  // Quick "search area" filter — narrows the list to agents whose area name
  // matches. Focused with Ctrl/Cmd+L and cleared automatically once an agent
  // is selected.
  const [areaSearchQuery, setAreaSearchQuery] = useState('');
  const [groupByArea, setGroupByArea] = useState(savedConfig.groupByArea);
  const [sameAreaOnly, setSameAreaOnly] = useState(savedConfig.sameAreaOnly);
  const [visibleAreaIds, setVisibleAreaIds] = useState<Set<string> | null>(
    savedConfig.visibleAreaIds ? new Set(savedConfig.visibleAreaIds) : null
  );
  const [visibleProviders, setVisibleProviders] = useState<Set<string> | null>(
    savedConfig.visibleProviders ? new Set(savedConfig.visibleProviders) : null
  );
  const [areaFilterOpen, setAreaFilterOpen] = useState(false);
  const [areaFilterSearch, setAreaFilterSearch] = useState('');
  const [runtimeFilterOpen, setRuntimeFilterOpen] = useState(false);
  const [bulkManageOpen, setBulkManageOpen] = useState(false);
  const areaFilterRef = useRef<HTMLDivElement>(null);
  const runtimeFilterRef = useRef<HTMLDivElement>(null);
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
  const [mobileFiltersCollapsed, setMobileFiltersCollapsed] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
  const [areaContextMenu, setAreaContextMenu] = useState<{
    areaId: string;
    position: { x: number; y: number };
  } | null>(null);
  const [agentContextMenu, setAgentContextMenu] = useState<{
    agentId: string;
    position: { x: number; y: number };
  } | null>(null);
  // Remove-agent confirmation — replaces native window.confirm() so the dialog
  // matches the rest of the TC modals (dark theme, escape-to-close, focus trap).
  const [removeAgentConfirm, setRemoveAgentConfirm] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  // Standby (待岗) confirmation — reversible deactivation stops the agent
  // immediately, so it gets the same ConfirmModal treatment as removal.
  // Restoring is immediate (no dialog).
  const [standbyConfirm, setStandbyConfirm] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  const [deleteAreaConfirm, setDeleteAreaConfirm] = useState<{
    areaId: string;
    name: string;
    agentIds: string[];
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const areaSearchInputRef = useRef<HTMLInputElement>(null);
  const internalAgentListRef = useRef<HTMLDivElement>(null);
  const agentListRef = externalAgentListRef || internalAgentListRef;
  const hasCenteredActiveRef = useRef(false);
  /** Tracks the last stable sort order (agent IDs) per sort key, to avoid re-sorting on every tick. */
  const prevSortOrderRef = useRef<Map<string, string[]>>(new Map());

  // Two-finger state comes from the parent (detected on terminal, applied here)
  const twoFingerSelector = twoFingerState || { isActive: false, hoveredAgentId: null };

  // Ref-wrap the parent callback so each card receives a stable reference — even
  // if the parent re-creates `onSelectAgent` on every render.
  const onSelectAgentRef = useRef(onSelectAgent);
  useEffect(() => { onSelectAgentRef.current = onSelectAgent; }, [onSelectAgent]);
  const handleCardSelect = useCallback((agentId: string) => {
    // Selecting an agent dismisses the transient "search area" filter.
    setAreaSearchQuery('');
    onSelectAgentRef.current(agentId);
  }, []);
  const handleCardClearContext = useCallback((agentId: string) => {
    store.clearContext(agentId);
  }, []);
  const handleCardContextMenu = useCallback((agentId: string, position: { x: number; y: number }) => {
    setAgentContextMenu({ agentId, position });
  }, []);

  // Track mobile breakpoint to enable compact filter controls by default on phones.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const media = window.matchMedia('(max-width: 768px)');
    const apply = (matches: boolean) => {
      setIsMobileViewport(matches);
      setMobileFiltersCollapsed(matches);
    };

    apply(media.matches);

    const onChange = (event: MediaQueryListEvent) => apply(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Close area filter dropdown on outside click
  useEffect(() => {
    if (!areaFilterOpen) { setAreaFilterSearch(''); return; }
    const handleClick = (e: MouseEvent) => {
      if (areaFilterRef.current && !areaFilterRef.current.contains(e.target as Node)) {
        setAreaFilterOpen(false);
        setAreaFilterSearch('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [areaFilterOpen]);

  // Close runtime filter dropdown on outside click
  useEffect(() => {
    if (!runtimeFilterOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (runtimeFilterRef.current && !runtimeFilterRef.current.contains(e.target as Node)) {
        setRuntimeFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [runtimeFilterOpen]);

  // Focus overview search with Alt+Shift+F, or the "search area" input with
  // Ctrl/Cmd+L, when the panel is open.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isFocusSearchShortcut = event.altKey
        && event.shiftKey
        && !event.ctrlKey
        && !event.metaKey
        && event.code === 'KeyF';

      const isFocusAreaSearchShortcut = (event.ctrlKey || event.metaKey)
        && !event.altKey
        && !event.shiftKey
        && event.code === 'KeyL';

      if (isFocusAreaSearchShortcut) {
        event.preventDefault();
        areaSearchInputRef.current?.focus();
        areaSearchInputRef.current?.select();
        return;
      }

      if (!isFocusSearchShortcut) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // Persist config changes to localStorage
  useEffect(() => {
    setStorage(STORAGE_KEYS.AOP_CONFIG, {
      groupByArea,
      sortMode,
      filterMode,
      sameAreaOnly,
      visibleAreaIds: visibleAreaIds ? Array.from(visibleAreaIds) : null,
      visibleProviders: visibleProviders ? Array.from(visibleProviders) : null,
    } as AopConfig);
  }, [groupByArea, sortMode, filterMode, sameAreaOnly, visibleAreaIds, visibleProviders]);

  // List of non-archived areas for the filter dropdown
  const availableAreas = useMemo(() => {
    const result: { id: string; name: string; color: string }[] = [];
    for (const [, area] of areas) {
      if (!area.archived) result.push({ id: area.id, name: area.name, color: area.color });
    }
    result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return result;
  }, [areas]);

  // Area filter helpers
  const isAllAreasVisible = visibleAreaIds === null;
  const toggleAreaVisibility = useCallback((areaId: string) => {
    setVisibleAreaIds(prev => {
      if (prev === null) {
        // Switch from "all" to "all except this one"
        const ids = new Set(availableAreas.map(a => a.id));
        ids.add('__unassigned__');
        ids.delete(areaId);
        return ids;
      }
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      // If all areas + unassigned are now selected, switch back to null (= "all")
      if (next.size >= availableAreas.length + 1) return null;
      return next;
    });
  }, [availableAreas]);

  const toggleAllAreas = useCallback(() => {
    setVisibleAreaIds(prev => (prev === null ? new Set<string>() : null));
  }, []);

  // Distinct agent runtimes (providers) currently present, in a stable order.
  // Drives the runtime filter dropdown — hidden entirely when only one runtime
  // is in use, since filtering by it would be a no-op.
  const availableProviders = useMemo(() => {
    const present = new Set<string>();
    for (const agent of agents) present.add(agent.provider || 'claude');
    const order = ['claude', 'codex', 'opencode', 'grok', 'pi'];
    const known = order.filter(p => present.has(p));
    const extras = Array.from(present).filter(p => !order.includes(p)).sort();
    return [...known, ...extras];
  }, [agents]);

  // Runtime filter helpers (mirror the area filter: null = show all runtimes)
  const isAllRuntimesVisible = visibleProviders === null;
  const toggleProviderVisibility = useCallback((provider: string) => {
    setVisibleProviders(prev => {
      if (prev === null) {
        // Switch from "all" to "all except this one"
        const next = new Set(availableProviders);
        next.delete(provider);
        return next;
      }
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      // If every available runtime is now selected, collapse back to null (= "all")
      if (next.size >= availableProviders.length) return null;
      return next;
    });
  }, [availableProviders]);

  const toggleAllRuntimes = useCallback(() => {
    setVisibleProviders(prev => (prev === null ? new Set<string>() : null));
  }, []);

  // Map agent -> area info (color + name) for badge display
  // One getAreaForAgent pass per (agents, areas) change feeds three lookups
  // (badge info, search name, area id) — this panel re-renders on every agent
  // update while agents work, and three separate O(agents) area walks per
  // render were the top memo cost in the profiler.
  const prevAgentAreaInfoRef = useRef<Map<string, { color: string; name: string }>>(new Map());
  const prevAgentAreaSearchNameRef = useRef<Map<string, string>>(new Map());
  const prevAgentToAreaIdRef = useRef<Map<string, string>>(new Map());
  const { agentAreaInfo, agentAreaSearchName, agentToAreaId } = useMemo(() => {
    const info = new Map<string, { color: string; name: string }>();
    // Search path includes archived (disabled) areas so the area search
    // matches across ALL areas, regardless of their enabled/disabled state;
    // the badge/grouping maps exclude them.
    const searchName = new Map<string, string>();
    const areaId = new Map<string, string>();
    const prevInfo = prevAgentAreaInfoRef.current;
    for (const agent of agents) {
      const area = store.getAreaForAgent(agent.id);
      if (!area) continue;
      searchName.set(agent.id, area.name);
      if (area.archived) continue;
      // Reuse the previous {color,name} object when unchanged — it is an
      // AgentCard prop, and a fresh object per agent per render made every
      // card re-render on every agent update.
      const before = prevInfo.get(agent.id);
      info.set(agent.id, before && before.color === area.color && before.name === area.name
        ? before
        : { color: area.color, name: area.name });
      areaId.set(agent.id, area.id);
    }
    const keptInfo = keepMap(prevAgentAreaInfoRef.current, info);
    const keptSearchName = keepMap(prevAgentAreaSearchNameRef.current, searchName);
    const keptAreaId = keepMap(prevAgentToAreaIdRef.current, areaId);
    prevAgentAreaInfoRef.current = keptInfo;
    prevAgentAreaSearchNameRef.current = keptSearchName;
    prevAgentToAreaIdRef.current = keptAreaId;
    return { agentAreaInfo: keptInfo, agentAreaSearchName: keptSearchName, agentToAreaId: keptAreaId };
  }, [agents, areas]);

  // Group tool executions by agent. Per-agent arrays keep their identity when
  // that agent's executions did not change: a new array for EVERY agent on
  // each tool start/finish defeated AgentCard's memo across the whole panel
  // (every card re-rendered on every tool event of any agent).
  const prevToolsByAgentRef = useRef<Map<string, ToolExecution[]>>(new Map());
  const toolsByAgent = useMemo(() => {
    const map = new Map<string, ToolExecution[]>();
    for (const exec of toolExecutions) {
      const list = map.get(exec.agentId) || [];
      list.push(exec);
      map.set(exec.agentId, list);
    }
    const prev = prevToolsByAgentRef.current;
    for (const [id, list] of map) map.set(id, keepArray(prev.get(id), list));
    const kept = keepMap(prev, map);
    prevToolsByAgentRef.current = kept;
    return kept;
  }, [toolExecutions]);

  // Group subagents by parent (same identity preservation as toolsByAgent).
  const prevSubagentsByParentRef = useRef<Map<string, Subagent[]>>(new Map());
  const subagentsByParent = useMemo(() => {
    const map = new Map<string, Subagent[]>();
    for (const [, sub] of subagents) {
      const list = map.get(sub.parentAgentId) || [];
      list.push(sub);
      map.set(sub.parentAgentId, list);
    }
    const prev = prevSubagentsByParentRef.current;
    for (const [id, list] of map) map.set(id, keepArray(prev.get(id), list));
    const kept = keepMap(prev, map);
    prevSubagentsByParentRef.current = kept;
    return kept;
  }, [subagents]);

  // Filter agents — deep search through file changes and user tasks
  const prevSearchMatchContextsRef = useRef<Map<string, SearchMatchContext>>(new Map());
  const [filteredAgents, searchMatchContexts] = useMemo(() => {
    const activeAreaId = agentToAreaId.get(activeAgentId) ?? null;
    const contexts = new Map<string, SearchMatchContext>();

    const result = agents.filter(a => {
      if (filterMode === 'working' && a.status !== 'working') return false;
      if (filterMode === 'idle' && a.status !== 'idle') return false;
      if (filterMode === 'error' && a.status !== 'error') return false;
      if (visibleProviders && !visibleProviders.has(a.provider || 'claude')) return false;
      if (sameAreaOnly) {
        const aAreaId = agentToAreaId.get(a.id) ?? null;
        if (aAreaId !== activeAreaId) return false;
      }
      if (areaSearchQuery.trim()) {
        const aq = areaSearchQuery.toLowerCase().trim();
        const areaName = agentAreaSearchName.get(a.id)?.toLowerCase() ?? '';
        if (!areaName.includes(aq)) return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();

        // Basic fields (match is visible directly in the card UI)
        if (
          a.name.toLowerCase().includes(q)
          || a.id.includes(q)
          || (a.class || '').toLowerCase().includes(q)
          || (a.taskLabel || '').toLowerCase().includes(q)
        ) {
          return true;
        }

        // Full user instruction (lastAssignedTask is longer than taskLabel)
        const task = a.lastAssignedTask || '';
        if (task.toLowerCase().includes(q)) {
          contexts.set(a.id, { type: 'task', text: task });
          return true;
        }

        // File changes
        for (const fc of fileChanges) {
          if (fc.agentId === a.id && fc.filePath.toLowerCase().includes(q)) {
            contexts.set(a.id, { type: 'file', text: fc.filePath });
            return true;
          }
        }

        return false;
      }
      return true;
    });

    const keptContexts = keepMap(prevSearchMatchContextsRef.current, contexts, (a, b) => a.type === b.type && a.text === b.text);
    prevSearchMatchContextsRef.current = keptContexts;
    return [result, keptContexts] as const;
  }, [agents, filterMode, searchQuery, areaSearchQuery, agentAreaSearchName, sameAreaOnly, agentToAreaId, activeAgentId, fileChanges, visibleProviders]);

  // Sort agents within groups — uses stable ordering to prevent scroll-jumping.
  // A full re-sort only happens when the agent set changes (add/remove) or when
  // sort-critical properties change (status bucket, boss flag). Within the same
  // bucket, previously-established order is preserved to avoid DOM churn.
  const sortAgents = useCallback((list: Agent[], groupKey: string = '__default__') => {
    const currentIds = new Set(list.map(a => a.id));
    const prevOrder = prevSortOrderRef.current.get(groupKey);

    // Determine if we need a full re-sort: new/removed agents, or first render for this group
    const needsFullSort = !prevOrder
      || prevOrder.length !== list.length
      || prevOrder.some(id => !currentIds.has(id));

    // Build a sort-bucket key for each agent to detect bucket changes
    const getBucketKey = (agent: Agent): string => {
      const isBoss = !!(agent.isBoss || agent.class === 'boss');
      if (sortMode === 'name') return `${isBoss ? '0' : '1'}`;
      if (sortMode === 'status') {
        const statusOrder = ['working', 'waiting_input', 'waiting_permission', 'error', 'idle', 'stopped'];
        const statusIdx = statusOrder.indexOf(agent.status);
        const unread = agentsWithUnseenOutput.has(agent.id) ? '0' : '1';
        return `${isBoss ? '0' : '1'}-${statusIdx}-${unread}`;
      }
      // 'recent' mode
      return `${isBoss ? '0' : '1'}`;
    };

    // Check if any agent changed sort bucket since last order
    let bucketChanged = false;
    if (prevOrder && !needsFullSort) {
      const prevBuckets = prevSortOrderRef.current.get(groupKey + '__buckets');
      if (prevBuckets) {
        for (const agent of list) {
          const idx = prevOrder.indexOf(agent.id);
          if (idx >= 0 && prevBuckets[idx] !== getBucketKey(agent)) {
            bucketChanged = true;
            break;
          }
        }
      } else {
        bucketChanged = true;
      }
    }

    let sorted: Agent[];
    if (needsFullSort || bucketChanged || sortMode === 'recent') {
      // Full sort — shared with the Spotlight "Areas" tab via makeAgentOverviewComparator
      // so both surfaces order agents identically.
      sorted = [...list].sort(makeAgentOverviewComparator({
        sortMode,
        agentsWithUnseenOutput,
        getLatestToolTimestamp: (id) => (toolsByAgent.get(id) || [])[0]?.timestamp,
      }));
    } else {
      // Stable: reuse previous order
      const agentMap = new Map(list.map(a => [a.id, a]));
      sorted = prevOrder!.map(id => agentMap.get(id)!).filter(Boolean);
    }

    // Cache the order and bucket keys for next comparison
    const sortedIds = sorted.map(a => a.id);
    const sortedBuckets = sorted.map(a => getBucketKey(a));
    prevSortOrderRef.current.set(groupKey, sortedIds);
    prevSortOrderRef.current.set(groupKey + '__buckets', sortedBuckets);

    return sorted;
  }, [sortMode, toolsByAgent, agentsWithUnseenOutput]);

  // Build area groups (or flat list), applying the area visibility filter
  const prevAreaGroupsRef = useRef<Map<string, AreaGroup>>(new Map());
  const areaGroups = useMemo(() => {
    if (!groupByArea) {
      // Flat list: single group with no area
      const before = prevAreaGroupsRef.current.get('__flat__');
      const sorted = keepArray(before?.agents, sortAgents(filteredAgents, '__flat__'));
      const group = before && before.agents === sorted ? before : { area: null, agents: sorted };
      prevAreaGroupsRef.current = new Map([['__flat__', group]]);
      return [group] as AreaGroup[];
    }

    const agentsByAreaId = new Map<string, Agent[]>();
    const unassignedAgents: Agent[] = [];
    for (const agent of filteredAgents) {
      // agentToAreaId already excludes archived areas (same rule as before);
      // reusing it avoids a second point-in-area walk over every agent.
      const areaId = agentToAreaId.get(agent.id);
      if (!areaId) {
        unassignedAgents.push(agent);
        continue;
      }
      const list = agentsByAreaId.get(areaId);
      if (list) list.push(agent);
      else agentsByAreaId.set(areaId, [agent]);
    }

    const groups: AreaGroup[] = [];
    // Reuse the previous group object (and its sorted array) when nothing in
    // it changed — the area sections below are memoized on it.
    const prevGroups = prevAreaGroupsRef.current;
    const nextGroups = new Map<string, AreaGroup>();
    const keepGroup = (key: string, area: DrawingArea | null, sorted: Agent[]): AreaGroup => {
      const before = prevGroups.get(key);
      const agentsKept = keepArray(before?.agents, sorted);
      const group = before && before.area === area && before.agents === agentsKept ? before : { area, agents: agentsKept };
      nextGroups.set(key, group);
      return group;
    };

    for (const [areaId, area] of areas) {
      if (area.archived) continue;
      // Apply area visibility filter
      if (visibleAreaIds && !visibleAreaIds.has(areaId)) continue;
      const areaAgents = agentsByAreaId.get(areaId) || [];
      if (areaAgents.length > 0) {
        groups.push(keepGroup(`area_${areaId}`, area, sortAgents(areaAgents, `area_${areaId}`)));
      }
    }

    // Unassigned agents: show when no filter or when filter explicitly allows __unassigned__
    if (unassignedAgents.length > 0 && (!visibleAreaIds || visibleAreaIds.has('__unassigned__'))) {
      groups.push(keepGroup('__unassigned__', null, sortAgents(unassignedAgents, '__unassigned__')));
    }
    prevAreaGroupsRef.current = nextGroups;

    groups.sort((a, b) => {
      // Keep Unassigned after named areas, while ordering named areas A-Z.
      if (!a.area && !b.area) return 0;
      if (!a.area) return 1;
      if (!b.area) return -1;
      return a.area.name.localeCompare(b.area.name, undefined, { sensitivity: 'base' });
    });

    return groups;
  }, [areas, filteredAgents, sortAgents, groupByArea, visibleAreaIds, agentToAreaId]);

  const renderAgentCards = useCallback((groupAgents: Agent[]) => {
    return groupAgents.map((agent) => (
      <React.Fragment key={agent.id}>
        <AgentCard
          agent={agent}
          isExpanded={expandedAgents.has(agent.id)}
          isMobile={isMobileViewport}
          hasPendingRead={agentsWithUnseenOutput.has(agent.id)}
          isTwoFingerHovered={twoFingerSelector.hoveredAgentId === agent.id}
          showAreaChip={!groupByArea}
          toolExecs={toolsByAgent.get(agent.id) || EMPTY_TOOL_EXECS}
          subagents={subagentsByParent.get(agent.id) || EMPTY_SUBAGENTS}
          subordinates={subordinatesByBoss.get(agent.id) || EMPTY_SUBORDINATES}
          areaInfo={agentAreaInfo.get(agent.id)}
          matchContext={searchMatchContexts.get(agent.id)}
          customClasses={customAgentClasses}
          isCompacting={compactingAgents.has(agent.id)}
          onSelect={handleCardSelect}
          onClearContext={handleCardClearContext}
          onContextMenu={handleCardContextMenu}
        />
      </React.Fragment>
    ));
  }, [
    expandedAgents,
    isMobileViewport,
    agentsWithUnseenOutput,
    twoFingerSelector.hoveredAgentId,
    groupByArea,
    toolsByAgent,
    subagentsByParent,
    subordinatesByBoss,
    agentAreaInfo,
    searchMatchContexts,
    customAgentClasses,
    compactingAgents,
    handleCardSelect,
    handleCardClearContext,
    handleCardContextMenu,
  ]);

  // Status summary
  const statusSummary = useMemo(() => {
    const summary = { total: agents.length, working: 0, idle: 0, error: 0 };
    for (const a of agents) {
      if (a.status === 'working') summary.working++;
      else if (a.status === 'error') summary.error++;
      else if (a.status === 'idle') summary.idle++;
    }
    return summary;
  }, [agents]);

  const toggleAgent = (agentId: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const unassignedLabel = t('terminal:overview.unassigned');
  const toggleArea = useCallback((areaKey: string) => {
    const nextKeys = expandedAreas.has(areaKey) ? [] : [areaKey];
    if (onSetExpandedAreas) {
      onSetExpandedAreas(nextKeys);
      return;
    }
    if (externalOnToggleArea) {
      // Compatibility fallback for externally controlled callers that only
      // provide a toggle callback: close the others before opening this one.
      for (const expandedArea of expandedAreas) {
        if (expandedArea !== areaKey) externalOnToggleArea(expandedArea);
      }
      externalOnToggleArea(areaKey);
      return;
    }
    setInternalExpandedAreas(new Set(nextKeys));
  }, [expandedAreas, externalOnToggleArea, onSetExpandedAreas]);

  // When the selected agent changes, make sure its area is expanded so the
  // card is actually visible. Without this, selecting an agent from another
  // surface (TrackingBoard, FlatView chat, 3D scene) would silently highlight
  // a hidden card inside a collapsed area.
  useEffect(() => {
    if (!activeAgentId) return;
    const areaKey = agentToAreaId.get(activeAgentId) ?? '__unassigned__';
    if (expandedAreas.has(areaKey)) return;
    // Expanding a large area can mount dozens of rich AgentCards. It is useful
    // follow-up UI, but not part of the critical click→chat response, so keep
    // it in a transition that React may yield or supersede on rapid switching.
    React.startTransition(() => {
      if (onSetExpandedAreas) {
        onSetExpandedAreas([areaKey]);
      } else if (externalOnToggleArea) {
        for (const expandedArea of expandedAreas) {
          if (expandedArea !== areaKey) externalOnToggleArea(expandedArea);
        }
        externalOnToggleArea(areaKey);
      } else {
        setInternalExpandedAreas(new Set([areaKey]));
      }
    });
    // Depend only on the agent id so a later user-driven collapse of the same
    // area is respected; we re-expand only when the selection itself changes.
  }, [activeAgentId]);

  const requestSpawnForArea = useCallback((area: DrawingArea) => {
    window.dispatchEvent(new CustomEvent('tide:open-spawn-modal', {
      detail: {
        areaId: area.id,
        position: {
          x: area.center.x,
          z: area.center.z,
        },
      },
    }));
  }, []);

  const requestBossSpawnForArea = useCallback((area: DrawingArea) => {
    window.dispatchEvent(new CustomEvent('tide:open-boss-spawn-modal', {
      detail: {
        areaId: area.id,
        position: {
          x: area.center.x,
          z: area.center.z,
        },
      },
    }));
  }, []);

  const createNewAreaNear = useCallback((origin: { x: number; z: number } | null) => {
    const DEFAULT_SIZE = 8;
    const allAreas = Array.from(store.getState().areas.values());
    const spot = findFreeAreaSpot(allAreas, DEFAULT_SIZE, DEFAULT_SIZE, origin ?? { x: 0, z: 0 });
    const visibleCount = allAreas.filter(a => !a.archived).length;
    const randomSuffix = Math.random().toString(36).slice(2, 11);
    const newArea: DrawingArea = {
      id: `area_${Date.now()}_${randomSuffix}`,
      name: `Area ${visibleCount + 1}`,
      type: 'rectangle',
      center: spot,
      width: DEFAULT_SIZE,
      height: DEFAULT_SIZE,
      color: AREA_COLORS[visibleCount % AREA_COLORS.length],
      zIndex: store.getNextZIndex(),
      assignedAgentIds: [],
      directories: [],
    };
    store.addArea(newArea);
  }, []);

  const openAreaContextMenu = useCallback((area: DrawingArea, position: { x: number; y: number }) => {
    setAreaContextMenu({
      areaId: area.id,
      position,
    });
  }, []);

  const areaContextMenuActions = useMemo((): ContextMenuAction[] => {
    if (!areaContextMenu) return [];
    const area = areas.get(areaContextMenu.areaId);
    if (!area) return [];

    return [
      {
        id: 'spawn-agent',
        label: t('common:agentBar.newAgent'),
        icon: '+',
        onClick: () => requestSpawnForArea(area),
      },
      {
        id: 'spawn-boss',
        label: t('terminal:overview.newBoss', { defaultValue: 'New Boss' }),
        icon: <Icon name="crown" size={14} />,
        onClick: () => requestBossSpawnForArea(area),
      },
      {
        id: 'new-area',
        label: t('terminal:overview.newArea', { defaultValue: 'New Area' }),
        icon: <Icon name="target" size={14} />,
        onClick: () => createNewAreaNear(area.center),
      },
      {
        id: 'delete-area',
        label: t('terminal:overview.deleteArea', { defaultValue: 'Delete Area' }),
        icon: <Icon name="trash" size={14} />,
        danger: true,
        onClick: () => setDeleteAreaConfirm({
          areaId: area.id,
          name: area.name,
          // Only agents that still exist: assignedAgentIds can hold stale ids.
          agentIds: area.assignedAgentIds.filter((id) => agents.some((agent) => agent.id === id)),
        }),
      },
    ];
  }, [areaContextMenu, areas, agents, requestSpawnForArea, requestBossSpawnForArea, createNewAreaNear, t]);

  const agentContextMenuActions = useMemo((): ContextMenuAction[] => {
    if (!agentContextMenu) return [];
    const agent = agents.find(a => a.id === agentContextMenu.agentId);
    if (!agent) return [];
    const isExpanded = expandedAgents.has(agent.id);

    return buildAgentContextMenuActions({
      agent,
      t,
      onDelete: () => setRemoveAgentConfirm({ agentId: agent.id, name: agent.name }),
      onToggleStandby: () => {
        if (agent.standby === true) store.setAgentStandby(agent.id, false);
        else setStandbyConfirm({ agentId: agent.id, name: agent.name });
      },
      extraActions: [
        {
          id: 'toggle-expand',
          label: isExpanded ? t('terminal:overview.collapse', { defaultValue: 'Collapse' }) : t('terminal:overview.expand', { defaultValue: 'Expand' }),
          icon: <Icon name={isExpanded ? 'caret-down' : 'caret-right'} size={14} />,
          onClick: () => toggleAgent(agent.id),
        },
      ],
    });
  }, [agentContextMenu, agents, expandedAgents, t]);

  // Keep the active agent card centered in the overview scroll container when the
  // selected agent changes.  We intentionally depend only on activeAgentId (not on
  // areaGroups) so that routine data updates don't hijack the user's scroll position.
  useEffect(() => {
    const container = agentListRef.current;
    if (!container) return;

    // Small delay so React can flush the DOM update before we measure.
    const raf = requestAnimationFrame(() => {
      const activeCard = container.querySelector<HTMLElement>(
        '.aop-agent-card.active, .aop-agent-card:has(.aop-agent-state-marker--active)'
      );
      if (!activeCard) return;

      const containerRect = container.getBoundingClientRect();
      const activeRect = activeCard.getBoundingClientRect();
      const offsetWithinContainer = activeRect.top - containerRect.top;
      const targetTop = container.scrollTop + offsetWithinContainer - ((containerRect.height - activeRect.height) / 2);
      const clampedTargetTop = Math.max(0, targetTop);
      const delta = Math.abs(container.scrollTop - clampedTargetTop);
      if (delta < 2) return;

      container.scrollTo({
        top: clampedTargetTop,
        behavior: hasCenteredActiveRef.current ? 'smooth' : 'auto',
      });
      hasCenteredActiveRef.current = true;
    });

    return () => cancelAnimationFrame(raf);
  }, [activeAgentId]);

  const cardSelectionState = useMemo<AgentCardSelectionState>(() => ({
    activeAgentId,
    subordinateAgentIds: subordinatesOfActiveBoss,
    subordinateLabel: t('terminal:overview.subordinateOfSelectedBoss', { defaultValue: 'Reports to selected boss' }),
  }), [activeAgentId, subordinatesOfActiveBoss, t]);

  return (
    <AgentCardSelectionContext.Provider value={cardSelectionState}>
    <div className={`agent-overview-panel${isMobileViewport && mobileFiltersCollapsed ? ' mobile-filters-collapsed' : ''}${isMobileViewport ? (mobileFull ? ' mobile-full' : ' mobile-compact') : ''}`}>
      {/* Stats + Search + Close — minimal top row */}
      <div className="aop-stats-row">
        <span className="stat">{t('terminal:overview.agents', { count: statusSummary.total })}</span>
        {statusSummary.working > 0 && <span className="stat stat-working"><Icon name="status-working" size={11} color={STATUS_COLORS.working} weight="fill" /> {statusSummary.working}</span>}
        {statusSummary.idle > 0 && <span className="stat stat-idle"><Icon name="status-idle" size={11} color={STATUS_COLORS.idle} weight="fill" /> {statusSummary.idle}</span>}
        {statusSummary.error > 0 && <span className="stat stat-error"><Icon name="status-error" size={11} color={STATUS_COLORS.error} weight="fill" /> {statusSummary.error}</span>}

        <div className="aop-row-controls">
          {onToggleMobileFull && (
            <button
              type="button"
              className="aop-mobile-size-toggle"
              onClick={onToggleMobileFull}
              title={mobileFull ? t('terminal:overview.showCompactPanel', { defaultValue: 'Show compact agents panel' }) : t('terminal:overview.showCompletePanel', { defaultValue: 'Show complete agents panel' })}
              aria-label={mobileFull ? t('terminal:overview.showCompactPanel', { defaultValue: 'Show compact agents panel' }) : t('terminal:overview.showCompletePanel', { defaultValue: 'Show complete agents panel' })}
            >
              {mobileFull ? t('terminal:overview.compact', { defaultValue: 'Compact' }) : t('terminal:overview.full', { defaultValue: 'Full' })}
            </button>
          )}
          <button
            type="button"
            className="aop-search-toggle"
            onClick={() => {
              setMobileFiltersCollapsed(false);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            title={t('terminal:overview.searchAgentsTitle', { defaultValue: 'Search agents' })}
          >
            <Icon name="search" size={14} />
          </button>
          <button
            type="button"
            className={`aop-filters-toggle${mobileFiltersCollapsed ? ' collapsed' : ''}`}
            onClick={() => setMobileFiltersCollapsed(v => !v)}
            title={mobileFiltersCollapsed ? t('terminal:overview.showFilters', { defaultValue: 'Show filters' }) : t('terminal:overview.hideFilters', { defaultValue: 'Hide filters' })}
          >
            {mobileFiltersCollapsed ? t('terminal:overview.filtersLabel', { defaultValue: 'Filters' }) : t('terminal:overview.hideFilters', { defaultValue: 'Hide filters' })}
          </button>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('terminal:overview.searchAgents')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              if (e.nativeEvent.isComposing) return;
              if (searchQuery.trim().length === 0) return;
              if (filteredAgents.length === 0) return;

              e.preventDefault();
              onSelectAgent(filteredAgents[0].id);
              setSearchQuery('');
              setAreaSearchQuery('');
            }}
            className="search-input"
          />
          <input
            ref={areaSearchInputRef}
            type="text"
            placeholder={t('terminal:overview.searchArea')}
            value={areaSearchQuery}
            onChange={e => setAreaSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setAreaSearchQuery('');
                areaSearchInputRef.current?.blur();
                return;
              }
              if (e.key !== 'Enter') return;
              if (e.nativeEvent.isComposing) return;
              if (areaSearchQuery.trim().length === 0) return;
              if (filteredAgents.length === 0) return;

              e.preventDefault();
              onSelectAgent(filteredAgents[0].id);
              setAreaSearchQuery('');
            }}
            className="search-input area-search-input"
          />
          <button className="close-btn" onClick={onClose} title={t('common:buttons.close')}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      {/* Actions — filter, sort, workspace, toggles */}
      <div className="aop-actions">
        <select
          value={filterMode}
          onChange={e => setFilterMode(e.target.value as FilterMode)}
          className="filter-select"
        >
          <option value="all">{t('terminal:overview.allStatus')}</option>
          <option value="working">{t('terminal:overview.statusLabels.working')}</option>
          <option value="idle">{t('terminal:overview.statusLabels.idle')}</option>
          <option value="error">{t('terminal:overview.statusLabels.error')}</option>
        </select>
        <select
          value={sortMode}
          onChange={e => setSortMode(e.target.value as SortMode)}
          className="filter-select"
        >
          <option value="recent">{t('terminal:overview.mostRecent')}</option>
          <option value="status">{t('terminal:overview.byStatus')}</option>
          <option value="name">{t('terminal:overview.byName')}</option>
        </select>
        <WorkspaceSwitcher />
        <button onClick={() => setGroupByArea(v => !v)} className={`action-btn action-btn--toggle${groupByArea ? ' active' : ''}`} title={t('terminal:overview.areas')}>
          {t('terminal:overview.areas')}
        </button>
        {groupByArea && availableAreas.length > 0 && (
          <div className="aop-area-filter" ref={areaFilterRef}>
            <button
              className={`action-btn action-btn--toggle${!isAllAreasVisible ? ' active' : ''}`}
              onClick={() => setAreaFilterOpen(v => !v)}
              title={t('terminal:overview.filterAreas', { defaultValue: 'Filter areas' })}
            >
              {isAllAreasVisible ? t('terminal:overview.allAreas', { defaultValue: 'All areas' }) : t('terminal:overview.areasCount', { defaultValue: '{{n}} areas', n: visibleAreaIds!.size })}
              <span className="aop-area-filter-caret"><Icon name={areaFilterOpen ? 'caret-up' : 'caret-down'} size={10} /></span>
            </button>
            {areaFilterOpen && (
              <div className="aop-area-filter-dropdown">
                {availableAreas.length >= 5 && (
                  <div className="aop-area-filter-search">
                    <input
                      type="text"
                      placeholder={t('terminal:overview.filterAreasPlaceholder', { defaultValue: 'Filter areas...' })}
                      value={areaFilterSearch}
                      onChange={(e) => setAreaFilterSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  </div>
                )}
                {(() => {
                  const search = areaFilterSearch.toLowerCase().trim();
                  const filtered = search
                    ? availableAreas.filter(a => a.name.toLowerCase().includes(search))
                    : availableAreas;
                  const showUnassigned = !search || 'unassigned'.includes(search);
                  return (
                    <>
                      {!search && (
                        <>
                          <label className="aop-area-filter-option" onClick={(e) => { e.preventDefault(); toggleAllAreas(); }}>
                            <input type="checkbox" checked={isAllAreasVisible} readOnly />
                            <span className="aop-area-filter-color" style={{ background: '#6272a4' }} />
                            <span>{t('terminal:overview.all', { defaultValue: 'All' })}</span>
                          </label>
                          <div className="aop-area-filter-divider" />
                        </>
                      )}
                      {filtered.map(area => {
                        const checked = isAllAreasVisible || (visibleAreaIds?.has(area.id) ?? false);
                        return (
                          <label key={area.id} className="aop-area-filter-option" onClick={(e) => { e.preventDefault(); toggleAreaVisibility(area.id); }}>
                            <input type="checkbox" checked={checked} readOnly />
                            <span className="aop-area-filter-color" style={{ background: area.color }} />
                            <span className="aop-area-filter-name">{area.name}</span>
                          </label>
                        );
                      })}
                      {showUnassigned && (
                        <>
                          <div className="aop-area-filter-divider" />
                          <label className="aop-area-filter-option" onClick={(e) => { e.preventDefault(); toggleAreaVisibility('__unassigned__'); }}>
                            <input type="checkbox" checked={isAllAreasVisible || (visibleAreaIds?.has('__unassigned__') ?? false)} readOnly />
                            <span className="aop-area-filter-color" style={{ background: '#6272a4' }} />
                            <span className="aop-area-filter-name">{t('terminal:overview.unassigned')}</span>
                          </label>
                        </>
                      )}
                      {search && filtered.length === 0 && !showUnassigned && (
                        <div className="aop-area-filter-empty">{t('terminal:overview.noMatchingAreas', { defaultValue: 'No matching areas' })}</div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        )}
        {availableProviders.length > 1 && (
          <div className="aop-runtime-filter" ref={runtimeFilterRef}>
            <button
              className={`action-btn action-btn--toggle${!isAllRuntimesVisible ? ' active' : ''}`}
              onClick={() => setRuntimeFilterOpen(v => !v)}
              title={t('terminal:overview.filterRuntimes', { defaultValue: 'Filter runtimes' })}
            >
              {isAllRuntimesVisible ? t('terminal:overview.allRuntimes', { defaultValue: 'All runtimes' }) : t('terminal:overview.runtimesCount', { defaultValue: '{{n}} runtimes', n: visibleProviders!.size })}
              <span className="aop-area-filter-caret"><Icon name={runtimeFilterOpen ? 'caret-up' : 'caret-down'} size={10} /></span>
            </button>
            {runtimeFilterOpen && (
              <div className="aop-area-filter-dropdown">
                <label className="aop-area-filter-option" onClick={(e) => { e.preventDefault(); toggleAllRuntimes(); }}>
                  <input type="checkbox" checked={isAllRuntimesVisible} readOnly />
                  <span className="aop-area-filter-color" style={{ background: '#6272a4' }} />
                  <span>{t('terminal:overview.all', { defaultValue: 'All' })}</span>
                </label>
                <div className="aop-area-filter-divider" />
                {availableProviders.map(provider => {
                  const checked = isAllRuntimesVisible || (visibleProviders?.has(provider) ?? false);
                  return (
                    <label key={provider} className="aop-area-filter-option" onClick={(e) => { e.preventDefault(); toggleProviderVisibility(provider); }}>
                      <input type="checkbox" checked={checked} readOnly />
                      <img src={providerAssetUrl(provider, import.meta.env.BASE_URL)} alt="" className="aop-runtime-filter-icon" />
                      <span className="aop-area-filter-name">{providerLabel(provider)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {groupByArea && onSetExpandedAreas && areaGroups.length > 0 && (
          <button
            type="button"
            onClick={() => onSetExpandedAreas([])}
            className="action-btn"
            title={t('terminal:overview.collapseAllAreasTitle', { defaultValue: 'Collapse all areas' })}
          >
            {t('terminal:overview.collapseAll', { defaultValue: 'Collapse all' })}
          </button>
        )}
        <button onClick={() => setSameAreaOnly(v => !v)} className={`action-btn action-btn--toggle${sameAreaOnly ? ' active' : ''}`} title={t('terminal:overview.sameAreaOnly')}>
          {t('terminal:overview.sameAreaOnly')}
        </button>
        <button onClick={() => setBulkManageOpen(true)} className="action-btn" title={t('terminal:overview.bulkManageTitle', { defaultValue: 'Bulk manage agents' })}>
          {t('terminal:overview.bulkManage', { defaultValue: 'Bulk Manage' })}
        </button>
      </div>

      <div className="aop-agent-list" ref={agentListRef}>
        {areaGroups.length === 0 ? (
          <div className="aop-empty">
            {agents.length === 0 ? t('terminal:overview.noAgentsDeployed') : t('terminal:overview.noAgentsMatch')}
          </div>
        ) : (
          areaGroups.map((group) => {
            const areaKey = group.area?.id || '__unassigned__';
            const isEditingPrompt = editingPromptAreaId === areaKey && !!group.area;
            return (
              <React.Fragment key={areaKey}>
              <AreaGroupSection
                group={group}
                groupByArea={groupByArea}
                isCollapsed={!expandedAreas.has(areaKey)}
                unassignedLabel={unassignedLabel}
                isEditingPrompt={isEditingPrompt}
                editingPromptText={isEditingPrompt ? editingPromptText : ''}
                setEditingPromptText={setEditingPromptText}
                setEditingPromptAreaId={setEditingPromptAreaId}
                toggleArea={toggleArea}
                openAreaContextMenu={openAreaContextMenu}
                toggleAreaVisibility={toggleAreaVisibility}
                renderAgentCards={renderAgentCards}
                t={t}
              />
              </React.Fragment>
            );
          })
        )}
      </div>

      {dockPosition === 'overview' && (
        <AgentActivityDock activeAgentId={activeAgentId} onSelectAgent={onSelectAgent} />
      )}

      <ContextMenu
        isOpen={areaContextMenu !== null}
        position={areaContextMenu?.position ?? { x: 0, y: 0 }}
        worldPosition={{ x: 0, z: 0 }}
        actions={areaContextMenuActions}
        onClose={() => setAreaContextMenu(null)}
      />

      <ContextMenu
        isOpen={agentContextMenu !== null}
        position={agentContextMenu?.position ?? { x: 0, y: 0 }}
        worldPosition={{ x: 0, z: 0 }}
        actions={agentContextMenuActions}
        onClose={() => setAgentContextMenu(null)}
      />

      <BulkManageModal isOpen={bulkManageOpen} onClose={() => setBulkManageOpen(false)} />

      <ConfirmModal
        isOpen={removeAgentConfirm !== null}
        title={t('common:confirm.removeAgentTitle')}
        message={t('common:confirm.removeAgentMessage', { name: removeAgentConfirm?.name ?? '' })}
        confirmLabel={t('common:buttons.remove')}
        cancelLabel={t('common:buttons.cancel')}
        variant="danger"
        onConfirm={() => {
          if (removeAgentConfirm) store.removeAgentFromServer(removeAgentConfirm.agentId);
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
      <ConfirmModal
        isOpen={deleteAreaConfirm !== null}
        title={t('terminal:overview.deleteAreaTitle', { defaultValue: 'Delete area' })}
        message={deleteAreaConfirm && deleteAreaConfirm.agentIds.length > 0
          ? t('terminal:overview.deleteAreaWithAgents', {
            defaultValue: 'Delete the area "{{name}}" and its {{count}} agent(s)? The agents are deleted too. This cannot be undone.',
            name: deleteAreaConfirm.name,
            count: deleteAreaConfirm.agentIds.length,
          })
          : t('terminal:overview.deleteAreaEmpty', {
            defaultValue: 'Delete the area "{{name}}"? It has no agents.',
            name: deleteAreaConfirm?.name ?? '',
          })}
        confirmLabel={t('common:buttons.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common:buttons.cancel')}
        variant="danger"
        onConfirm={() => {
          if (!deleteAreaConfirm) return;
          for (const agentId of deleteAreaConfirm.agentIds) store.removeAgentFromServer(agentId);
          store.deleteArea(deleteAreaConfirm.areaId);
        }}
        onClose={() => setDeleteAreaConfirm(null)}
      />
    </div>
    </AgentCardSelectionContext.Provider>
  );
}

// ============================================================================
// Agent Card sub-component
// ============================================================================
