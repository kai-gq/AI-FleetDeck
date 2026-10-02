/**
 * BulkManageModal - Modal for bulk agent management operations
 *
 * Provides filtering, multi-select, and bulk actions (delete, stop, clear context, move to area).
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalPortal } from './shared/ModalPortal';
import { SearchableSelect } from './shared/SearchableSelect';
import { Icon } from './Icon';
import { PiModelSelect } from './PiModelSelect';
import { useAgentsArray, useAreas, useSkillsArray } from '../store';
import {
  bulkDeleteAgents,
  bulkStopAgents,
  bulkClearContext,
  bulkMoveToArea,
  bulkChangeModel,
  bulkAddSkills,
  bulkRemoveSkills,
  type BulkActionResult,
  type BulkAddSkillsResult,
  type BulkRemoveSkillsResult,
} from '../api/bulk-agents';
import type { Agent, DrawingArea, Skill, SessionTransferMode } from '../../shared/types';
import { skillAssignmentSource } from '../../shared/skill-assignment';
import { CLAUDE_MODELS, CODEX_MODELS, CLAUDE_EFFORTS, DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_EFFORT, DEFAULT_CODEX_MODEL, isDeprecatedClaudeModel, isDeprecatedCodexModel, supportsSessionImport, type ClaudeModel, type ClaudeEffort, type CodexModel } from '../../shared/agent-types';
import { convertAgentRuntime } from '../api/session-transfer';
import '../styles/components/bulk-manage-modal.scss';

type ModelProvider = 'claude' | 'codex' | 'pi';

/** Convert areas Map to array */
function areasToArray(areas: Map<string, DrawingArea>): DrawingArea[] {
  return Array.from(areas.values());
}

export interface BulkManageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type StatusFilter = 'all' | 'idle' | 'working' | 'error' | 'stopped';
type IdleTimeFilter = 'any' | '>1h' | '>6h' | '>1d' | '>3d' | '>7d' | '>30d';
type ProviderFilter = 'all' | 'claude' | 'codex' | 'opencode' | 'grok' | 'pi';
type ModelFilter = 'all' | 'fable-5-1' | 'fable-5-1m' | 'fable-5' | 'opus' | 'opus-5-5-1m' | 'opus-5-5' | 'opus-5-1m' | 'opus-5' | 'opus-4-7-1m' | 'opus-4-7' | 'opus-4-6' | 'sonnet-5-5' | 'sonnet-5-1m' | 'sonnet-5' | 'sonnet' | 'haiku';

type ConfirmAction = 'delete' | 'clear-context' | 'change-model' | 'add-skill' | 'remove-skill' | null;
type SkillPickerMode = 'add' | 'remove' | null;

const IDLE_TIME_MS: Record<Exclude<IdleTimeFilter, 'any'>, number> = {
  '>1h': 60 * 60 * 1000,
  '>6h': 6 * 60 * 60 * 1000,
  '>1d': 24 * 60 * 60 * 1000,
  '>3d': 3 * 24 * 60 * 60 * 1000,
  '>7d': 7 * 24 * 60 * 60 * 1000,
  '>30d': 30 * 24 * 60 * 60 * 1000,
};

function formatIdleTime(lastActivity: number): string {
  const diff = Date.now() - lastActivity;
  if (diff < 60_000) return '<1m';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

function getAgentArea(agent: Agent, areas: DrawingArea[]): DrawingArea | null {
  for (const area of areas) {
    if (area.assignedAgentIds.includes(agent.id)) return area;
  }
  return null;
}

const NO_AGENTS: Agent[] = [];

export function BulkManageModal({ isOpen, onClose }: BulkManageModalProps) {
  const { t } = useTranslation(['config', 'common']);
  const areaFilterPinned = useMemo(() => [
    { value: 'all', label: t('config:bulkManage.filter.allAreas', { defaultValue: 'All Areas' }) },
    { value: 'unassigned', label: t('config:bulkManage.filter.unassigned', { defaultValue: 'Unassigned' }) },
  ], [t]);
  const moveAreaPinned = useMemo(() => [
    { value: '', label: t('config:bulkManage.moveArea.unassign', { defaultValue: 'Unassign area' }) },
  ], [t]);
  const liveAgents = useAgentsArray();
  // Closed modal: don't feed the (agents × filters) memos below — this
  // component stays mounted inside the overview panel and re-rendered on
  // every agent update while agents work.
  const agents = isOpen ? liveAgents : NO_AGENTS;
  const areasMap = useAreas();
  const areas = useMemo(() => areasToArray(areasMap), [areasMap]);
  // Area dropdowns list areas alphabetically (the store keeps creation order).
  const areaOptions = useMemo(
    () => areas
      .map(area => ({ value: area.id, label: area.name }))
      .sort((x, y) => x.label.localeCompare(y.label, undefined, { sensitivity: 'base', numeric: true })),
    [areas],
  );
  const skills = useSkillsArray();

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [idleTimeFilter, setIdleTimeFilter] = useState<IdleTimeFilter>('any');
  const [areaFilter, setAreaFilter] = useState<string>('all');
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [modelFilter, setModelFilter] = useState<ModelFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Action state
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [moveAreaId, setMoveAreaId] = useState<string>('');
  const [modelProvider, setModelProvider] = useState<ModelProvider>('claude');
  const [newClaudeModel, setNewClaudeModel] = useState<ClaudeModel>(DEFAULT_CLAUDE_MODEL);
  const [newCodexModel, setNewCodexModel] = useState<CodexModel>(DEFAULT_CODEX_MODEL);
  const [newPiModel, setNewPiModel] = useState<string>('');
  const [transferMode, setTransferMode] = useState<SessionTransferMode>('smart');
  const [stopActiveForTransfer, setStopActiveForTransfer] = useState(false);
  // 'default' represents "leave unchanged / use default"; other values are ClaudeEffort levels
  const [newEffort, setNewEffort] = useState<ClaudeEffort | 'default'>(DEFAULT_CLAUDE_EFFORT);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);

  // Skill picker state (multi-select)
  const [skillPickerMode, setSkillPickerMode] = useState<SkillPickerMode>(null);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [pendingSkillIds, setPendingSkillIds] = useState<Set<string>>(new Set());

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedIds(new Set());
      setError(null);
      setSuccess(null);
      setConfirmAction(null);
      setTransferMode('smart');
      setStopActiveForTransfer(false);
      setSkillPickerMode(null);
      setSkillSearchQuery('');
      setPendingSkillIds(new Set());
    }
  }, [isOpen]);

  // Filter agents
  const filteredAgents = useMemo(() => {
    const now = Date.now();
    const query = searchQuery.toLowerCase().trim();

    return agents.filter(agent => {
      // Status filter
      if (statusFilter !== 'all' && agent.status !== statusFilter) return false;

      // Idle time filter
      if (idleTimeFilter !== 'any') {
        const idleMs = now - agent.lastActivity;
        if (idleMs < IDLE_TIME_MS[idleTimeFilter]) return false;
      }

      // Area filter
      if (areaFilter !== 'all') {
        const agentArea = getAgentArea(agent, areas);
        if (areaFilter === 'unassigned') {
          if (agentArea !== null) return false;
        } else {
          if (!agentArea || agentArea.id !== areaFilter) return false;
        }
      }

      // Provider filter
      if (providerFilter !== 'all' && agent.provider !== providerFilter) return false;

      // Model filter
      if (modelFilter !== 'all') {
        const agentModel = agent.model || 'sonnet';
        const matchesFilter =
          modelFilter === 'fable-5-1' ? agentModel === 'claude-fable-5-1' :
          modelFilter === 'fable-5-1m' ? agentModel === 'claude-fable-5[1m]' :
          modelFilter === 'fable-5' ? agentModel === 'claude-fable-5' :
          modelFilter === 'opus-5-5-1m' ? agentModel === 'claude-opus-5-5[1m]' :
          modelFilter === 'opus-5-5' ? agentModel === 'claude-opus-5-5' :
          modelFilter === 'opus-5-1m' ? agentModel === 'claude-opus-5[1m]' :
          modelFilter === 'opus-5' ? agentModel === 'claude-opus-5' :
          modelFilter === 'opus-4-7-1m' ? agentModel === 'opus[1m]' :
          modelFilter === 'opus-4-7' ? agentModel === 'claude-opus-4-7' :
          modelFilter === 'opus-4-6' ? agentModel === 'claude-opus-4-6' :
          modelFilter === 'sonnet-5-5' ? agentModel === 'claude-sonnet-5-5' :
          modelFilter === 'sonnet-5-1m' ? agentModel === 'claude-sonnet-5[1m]' :
          modelFilter === 'sonnet-5' ? agentModel === 'claude-sonnet-5' :
          agentModel === modelFilter;
        if (!matchesFilter) return false;
      }

      // Text search
      if (query) {
        const nameMatch = agent.name.toLowerCase().includes(query);
        const classMatch = agent.class.toLowerCase().includes(query);
        if (!nameMatch && !classMatch) return false;
      }

      return true;
    });
  }, [agents, areas, statusFilter, idleTimeFilter, areaFilter, providerFilter, modelFilter, searchQuery]);

  // Clean up selected IDs when filtered agents change
  useEffect(() => {
    const filteredIds = new Set(filteredAgents.map(a => a.id));
    setSelectedIds(prev => {
      const next = new Set<string>();
      for (const id of prev) {
        if (filteredIds.has(id)) next.add(id);
      }
      return next.size !== prev.size ? next : prev;
    });
  }, [filteredAgents]);

  const toggleSelect = useCallback((agentId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredAgents.map(a => a.id)));
  }, [filteredAgents]);

  const selectNone = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Skills available for the picker, filtered by mode and search query.
  // - 'add': all enabled skills.
  // - 'remove': enabled skills that reach ≥1 selected agent (directly, via class or '*').
  const pickerSkills = useMemo<Skill[]>(() => {
    if (!skillPickerMode) return [];
    const query = skillSearchQuery.toLowerCase().trim();
    let base: Skill[];
    if (skillPickerMode === 'add') {
      base = skills.filter(s => s.enabled);
    } else {
      const selectedAgents = agents.filter(a => selectedIds.has(a.id));
      base = skills.filter(s => s.enabled && selectedAgents.some(a => skillAssignmentSource(s, a) !== null));
    }
    if (!query) return base;
    return base.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.slug.toLowerCase().includes(query)
    );
  }, [skillPickerMode, skillSearchQuery, skills, selectedIds, agents]);

  const pendingSkillsList = useMemo<Skill[]>(
    () => skills.filter(s => pendingSkillIds.has(s.id)),
    [pendingSkillIds, skills]
  );
  const pendingSkillsLabel = useMemo(() => {
    if (pendingSkillsList.length === 0) return '';
    if (pendingSkillsList.length === 1) return `"${pendingSkillsList[0].name}"`;
    if (pendingSkillsList.length <= 3) return pendingSkillsList.map(s => `"${s.name}"`).join(', ');
    return t('config:bulkManage.picker.manySkills', { defaultValue: '{{count}} skills', count: pendingSkillsList.length });
  }, [pendingSkillsList, t]);

  // For 'remove-skill' confirm: how many (agent, skill) pairs would actually be
  // removed, i.e. selected agents the pending skills reach (directly, via class
  // or '*'). Counts each pair, so an agent with 2 pending skills contributes 2.
  const removeSkillAffectedPairs = useMemo(() => {
    if (pendingSkillsList.length === 0) return 0;
    let count = 0;
    for (const agent of agents) {
      if (!selectedIds.has(agent.id)) continue;
      for (const skill of pendingSkillsList) {
        if (skillAssignmentSource(skill, agent)) count++;
      }
    }
    return count;
  }, [pendingSkillsList, selectedIds, agents]);

  // Map of agentId -> sorted list of enabled skill chips that apply to that
  // agent, however they reach it (direct, class, '*'). Bulk Remove handles all
  // three: class/'*' ones are excluded for the selected agents only.
  type AgentSkillChip = { name: string; source: 'direct' | 'class' | 'wildcard' };
  const skillsByAgent = useMemo(() => {
    const map = new Map<string, AgentSkillChip[]>();
    for (const agent of agents) {
      const list: AgentSkillChip[] = [];
      for (const skill of skills) {
        if (!skill.enabled) continue;
        const source = skillAssignmentSource(skill, agent);
        if (source) list.push({ name: skill.name, source });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      map.set(agent.id, list);
    }
    return map;
  }, [agents, skills]);

  const selectedModelAgents = useMemo(() => {
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    return Array.from(selectedIds)
      .map((id) => agentById.get(id))
      .filter((agent): agent is Agent => Boolean(agent));
  }, [agents, selectedIds]);
  const sameProviderAgents = useMemo(
    () => selectedModelAgents.filter((agent) => (agent.provider ?? 'claude') === modelProvider),
    [selectedModelAgents, modelProvider],
  );
  const migratingAgents = useMemo(
    () => selectedModelAgents.filter((agent) => (agent.provider ?? 'claude') !== modelProvider),
    [selectedModelAgents, modelProvider],
  );
  const activeMigratingAgents = useMemo(
    () => migratingAgents.filter((agent) => ['working', 'waiting', 'waiting_permission', 'orphaned'].includes(agent.status)),
    [migratingAgents],
  );
  const migratingAgentsWithoutSession = useMemo(
    () => migratingAgents.filter((agent) => !agent.sessionId),
    [migratingAgents],
  );
  const targetSupportsImport = supportsSessionImport(modelProvider);

  const handleAction = useCallback(async (action: string) => {
    setActionInProgress(true);
    setError(null);
    setSuccess(null);

    try {
      let result: BulkActionResult | undefined;
      let addResult: BulkAddSkillsResult | undefined;
      let removeResult: BulkRemoveSkillsResult | undefined;
      let verb = '';

      if (action === 'change-model') {
        if (selectedModelAgents.length === 0) {
          setActionInProgress(false);
          setConfirmAction(null);
          return;
        }
        const model = modelProvider === 'claude'
          ? newClaudeModel
          : modelProvider === 'codex'
            ? newCodexModel
            : newPiModel;
        const effort = modelProvider === 'claude' || modelProvider === 'pi'
          ? (newEffort === 'default' ? null : newEffort)
          : undefined;
        const succeeded: string[] = [];
        const failed: string[] = [];

        if (sameProviderAgents.length > 0) {
          const changed = await bulkChangeModel(
            sameProviderAgents.map((agent) => agent.id),
            modelProvider,
            model,
            effort,
          );
          succeeded.push(...changed.succeeded);
          failed.push(...changed.failed);
        }

        for (const agent of migratingAgents) {
          try {
            await convertAgentRuntime(agent.id, {
              targetProvider: modelProvider,
              mode: targetSupportsImport && agent.sessionId ? transferMode : 'fresh',
              model,
              effort,
              stopActive: stopActiveForTransfer,
            });
            succeeded.push(agent.id);
          } catch {
            failed.push(agent.id);
          }
        }

        result = { succeeded, failed };
        verb = migratingAgents.length > 0
          ? t('config:bulkManage.verb.changedModelRuntime', { defaultValue: 'Changed model/runtime for' })
          : t('config:bulkManage.verb.changedModel', { defaultValue: 'Changed model for' });
      } else if (action === 'add-skill' || action === 'remove-skill') {
        const ids = Array.from(selectedIds);
        const skillIds = Array.from(pendingSkillIds);
        if (ids.length === 0 || skillIds.length === 0) {
          setActionInProgress(false);
          setConfirmAction(null);
          return;
        }
        if (action === 'add-skill') {
          addResult = await bulkAddSkills(ids, skillIds);
        } else {
          removeResult = await bulkRemoveSkills(ids, skillIds);
        }
      } else {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) {
          setActionInProgress(false);
          setConfirmAction(null);
          return;
        }
        switch (action) {
          case 'delete':
            result = await bulkDeleteAgents(ids);
            verb = t('config:bulkManage.verb.deleted', { defaultValue: 'Deleted' });
            if (result.failed.length === 0) setSelectedIds(new Set());
            break;
          case 'stop':
            result = await bulkStopAgents(ids);
            verb = t('config:bulkManage.verb.stopped', { defaultValue: 'Stopped' });
            break;
          case 'clear-context':
            result = await bulkClearContext(ids);
            verb = t('config:bulkManage.verb.clearedContext', { defaultValue: 'Cleared context for' });
            break;
          case 'move-area':
            result = await bulkMoveToArea(ids, moveAreaId || null);
            verb = t('config:bulkManage.verb.moved', { defaultValue: 'Moved' });
            break;
        }
      }

      if (result) {
        if (result.failed.length > 0) {
          setSuccess(t('config:bulkManage.result.withFailed', {
            defaultValue: '{{verb}} {{count}} agent(s). Failed: {{failed}}',
            verb,
            count: result.succeeded.length,
            failed: result.failed.length,
          }));
        } else {
          setSuccess(t('config:bulkManage.result.ok', {
            defaultValue: '{{verb}} {{count}} agent(s)',
            verb,
            count: result.succeeded.length,
          }));
        }
      } else if (addResult) {
        const skillCount = addResult.results.length;
        const totalAdded = addResult.results.reduce((sum, r) => sum + r.updated.length, 0);
        const totalAlready = addResult.results.reduce((sum, r) => sum + r.alreadyHad.length, 0);
        const totalFailed = addResult.results.reduce((sum, r) => sum + r.failed.length, 0);
        const alreadySuffix = totalAlready > 0
          ? t('config:bulkManage.result.alreadyAssigned', { defaultValue: ' ({{count}} already assigned)', count: totalAlready })
          : '';
        const failSuffix = totalFailed > 0
          ? t('config:bulkManage.result.failSuffix', { defaultValue: ', {{count}} failed', count: totalFailed })
          : '';
        setSuccess(t('config:bulkManage.result.skillsAdded', {
          defaultValue: 'Added {{skills}} skill(s): {{added}} new assignment(s){{already}}{{failed}}',
          skills: skillCount,
          added: totalAdded,
          already: alreadySuffix,
          failed: failSuffix,
        }));
        setPendingSkillIds(new Set());
      } else if (removeResult) {
        const skillCount = removeResult.results.length;
        const totalRemoved = removeResult.results.reduce((sum, r) => sum + r.updated.length, 0);
        const totalMissing = removeResult.results.reduce((sum, r) => sum + r.didNotHave.length, 0);
        const totalFailed = removeResult.results.reduce((sum, r) => sum + r.failed.length, 0);
        const missingSuffix = totalMissing > 0
          ? t('config:bulkManage.result.notAssigned', { defaultValue: " ({{count}} weren't assigned)", count: totalMissing })
          : '';
        const failSuffix = totalFailed > 0
          ? t('config:bulkManage.result.failSuffix', { defaultValue: ', {{count}} failed', count: totalFailed })
          : '';
        setSuccess(t('config:bulkManage.result.skillsRemoved', {
          defaultValue: 'Removed {{skills}} skill(s): {{removed}} assignment(s) removed{{missing}}{{failed}}',
          skills: skillCount,
          removed: totalRemoved,
          missing: missingSuffix,
          failed: failSuffix,
        }));
        setPendingSkillIds(new Set());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:bulkManage.actionFailed', { defaultValue: 'Action failed' }));
    } finally {
      setActionInProgress(false);
      setConfirmAction(null);
    }
  }, [t, selectedIds, moveAreaId, selectedModelAgents, sameProviderAgents, migratingAgents, modelProvider, newClaudeModel, newCodexModel, newPiModel, newEffort, targetSupportsImport, transferMode, stopActiveForTransfer, pendingSkillIds]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (confirmAction) {
        setConfirmAction(null);
      } else if (skillPickerMode) {
        setSkillPickerMode(null);
        setSkillSearchQuery('');
        setPendingSkillIds(new Set());
      } else {
        onClose();
      }
    }
  }, [confirmAction, skillPickerMode, onClose]);

  const openSkillPicker = useCallback((mode: 'add' | 'remove') => {
    setSkillPickerMode(mode);
    setSkillSearchQuery('');
    setPendingSkillIds(new Set());
    setError(null);
    setSuccess(null);
  }, []);

  const closeSkillPicker = useCallback(() => {
    setSkillPickerMode(null);
    setSkillSearchQuery('');
    setPendingSkillIds(new Set());
  }, []);

  const togglePendingSkill = useCallback((skillId: string) => {
    setPendingSkillIds(prev => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }, []);

  const confirmSkillPick = useCallback(() => {
    if (!skillPickerMode || pendingSkillIds.size === 0) return;
    setConfirmAction(skillPickerMode === 'add' ? 'add-skill' : 'remove-skill');
    setSkillPickerMode(null);
    setSkillSearchQuery('');
  }, [skillPickerMode, pendingSkillIds]);

  if (!isOpen) return null;

  return (
    <ModalPortal>
      <div className={`modal-overlay ${isOpen ? 'visible' : ''}`} onClick={onClose}>
        <div className="bulk-manage-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
          {/* Header */}
          <div className="modal-header">
            <h2>{t('config:bulkManage.title', { defaultValue: 'Bulk Agent Management' })}</h2>
            <button className="modal-close" onClick={onClose} aria-label={t('common:buttons.close')}>
              &#x2715;
            </button>
          </div>

          {/* Filters */}
          <div className="bulk-filters">
            <div className="filter-row">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                className="bulk-filter-select"
              >
                <option value="all">{t('config:bulkManage.filter.allStatus', { defaultValue: 'All Status' })}</option>
                <option value="idle">{t('config:bulkManage.status.idle', { defaultValue: 'Idle' })}</option>
                <option value="working">{t('config:bulkManage.status.working', { defaultValue: 'Working' })}</option>
                <option value="error">{t('config:bulkManage.status.error', { defaultValue: 'Error' })}</option>
                <option value="stopped">{t('config:bulkManage.status.stopped', { defaultValue: 'Stopped' })}</option>
              </select>

              <select
                value={idleTimeFilter}
                onChange={e => setIdleTimeFilter(e.target.value as IdleTimeFilter)}
                className="bulk-filter-select"
              >
                <option value="any">{t('config:bulkManage.idleTime.any', { defaultValue: 'Any Idle Time' })}</option>
                <option value=">1h">{t('config:bulkManage.idleTime.1h', { defaultValue: '> 1 hour' })}</option>
                <option value=">6h">{t('config:bulkManage.idleTime.6h', { defaultValue: '> 6 hours' })}</option>
                <option value=">1d">{t('config:bulkManage.idleTime.1d', { defaultValue: '> 1 day' })}</option>
                <option value=">3d">{t('config:bulkManage.idleTime.3d', { defaultValue: '> 3 days' })}</option>
                <option value=">7d">{t('config:bulkManage.idleTime.7d', { defaultValue: '> 7 days' })}</option>
                <option value=">30d">{t('config:bulkManage.idleTime.30d', { defaultValue: '> 30 days' })}</option>
              </select>

              <SearchableSelect
                value={areaFilter}
                onChange={setAreaFilter}
                pinnedOptions={areaFilterPinned}
                options={areaOptions}
                placeholder={t('config:bulkManage.searchAreas', { defaultValue: 'Search areas…' })}
                className="bulk-filter-select"
              />

              <select
                value={providerFilter}
                onChange={e => setProviderFilter(e.target.value as ProviderFilter)}
                className="bulk-filter-select"
              >
                <option value="all">{t('config:bulkManage.filter.allProviders', { defaultValue: 'All Providers' })}</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
                <option value="grok">Grok</option>
                <option value="pi">Pi</option>
              </select>

              <select
                value={modelFilter}
                onChange={e => setModelFilter(e.target.value as ModelFilter)}
                className="bulk-filter-select"
              >
                <option value="all">{t('config:bulkManage.filter.allModels', { defaultValue: 'All Models' })}</option>
                <option value="fable-5-1">Fable 5.1 [1M]</option>
                <option value="fable-5-1m">Fable 5 [1M]</option>
                <option value="fable-5">Fable 5 (200K)</option>
                <option value="opus-5-5-1m">Opus 5.5 [1M]</option>
                <option value="opus-5-5">Opus 5.5 (200K)</option>
                <option value="opus-5-1m">Opus 5 [1M]</option>
                <option value="opus-5">Opus 5 (200K)</option>
                <option value="opus-4-7-1m">Opus 4.7 [1M]</option>
                <option value="opus-4-7">Opus 4.7 (200K)</option>
                <option value="opus-4-6">Opus 4.6</option>
                <option value="opus">{t('config:bulkManage.model.opusLegacy', { defaultValue: 'Opus (legacy)' })}</option>
                <option value="sonnet-5-5">Sonnet 5.5 [1M]</option>
                <option value="sonnet-5-1m">Sonnet 5 [1M]</option>
                <option value="sonnet-5">Sonnet 5 (200K)</option>
                <option value="sonnet">{t('config:bulkManage.model.sonnetLegacy', { defaultValue: 'Sonnet (legacy)' })}</option>
                <option value="haiku">Haiku</option>
              </select>

              <input
                type="text"
                placeholder={t('config:bulkManage.searchNameClass', { defaultValue: 'Search name/class...' })}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="bulk-filter-search"
              />
            </div>
          </div>

          {/* Count + Select controls */}
          <div className="bulk-count-bar">
            <span className="bulk-count">
              {t('config:bulkManage.countBar', {
                defaultValue: '{{matched}} matched, {{selected}} selected',
                matched: filteredAgents.length,
                selected: selectedIds.size,
              })}
            </span>
            <div className="bulk-select-controls">
              <button className="bulk-link-btn" onClick={selectAll}>
                {t('config:bulkManage.selectAll', { defaultValue: 'Select all' })}
              </button>
              <button className="bulk-link-btn" onClick={selectNone}>
                {t('config:bulkManage.selectNone', { defaultValue: 'Select none' })}
              </button>
            </div>
          </div>

          {/* Alerts */}
          {error && (
            <div className="bulk-alert bulk-alert-error">
              <span className="alert-icon">!</span>
              {error}
            </div>
          )}
          {success && (
            <div className="bulk-alert bulk-alert-success">
              <span className="alert-icon">&#x2713;</span>
              {success}
            </div>
          )}

          {/* Agent list */}
          <div className="bulk-agent-list">
            {filteredAgents.length === 0 ? (
              <div className="bulk-empty">
                {t('config:bulkManage.noMatch', { defaultValue: 'No agents match the current filters' })}
              </div>
            ) : (
              <table className="bulk-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <input
                        type="checkbox"
                        checked={selectedIds.size === filteredAgents.length && filteredAgents.length > 0}
                        onChange={() => selectedIds.size === filteredAgents.length ? selectNone() : selectAll()}
                      />
                    </th>
                    <th className="col-name">{t('common:labels.name')}</th>
                    <th className="col-class">{t('common:labels.class')}</th>
                    <th className="col-status">{t('common:labels.status')}</th>
                    <th className="col-idle">{t('config:bulkManage.table.idle', { defaultValue: 'Idle' })}</th>
                    <th className="col-area">{t('config:bulkManage.table.area', { defaultValue: 'Area' })}</th>
                    <th className="col-skills">{t('config:bulkManage.table.skills', { defaultValue: 'Skills' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map(agent => {
                    const agentArea = getAgentArea(agent, areas);
                    const agentSkills = skillsByAgent.get(agent.id) ?? [];
                    return (
                      <tr
                        key={agent.id}
                        className={selectedIds.has(agent.id) ? 'selected' : ''}
                        onClick={() => toggleSelect(agent.id)}
                      >
                        <td className="col-check">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(agent.id)}
                            onChange={() => toggleSelect(agent.id)}
                            onClick={e => e.stopPropagation()}
                          />
                        </td>
                        <td className="col-name">{agent.name}</td>
                        <td className="col-class">{agent.class}</td>
                        <td className="col-status">
                          <span className={`bulk-status bulk-status-${agent.status}`}>
                            {agent.status}
                          </span>
                        </td>
                        <td className="col-idle">{formatIdleTime(agent.lastActivity)}</td>
                        <td className="col-area">
                          {agentArea ? (
                            <span className="bulk-area-badge" style={{ borderColor: agentArea.color }}>
                              {agentArea.name}
                            </span>
                          ) : (
                            <span className="bulk-area-none">--</span>
                          )}
                        </td>
                        <td className="col-skills">
                          {agentSkills.length === 0 ? (
                            <span className="bulk-area-none">--</span>
                          ) : (
                            <div className="bulk-skill-chips">
                              {agentSkills.map(chip => {
                                const readOnly = chip.source !== 'direct';
                                const tooltip =
                                  chip.source === 'wildcard'
                                    ? t('config:bulkManage.skillTooltip.wildcard', {
                                        defaultValue: "{{name}} — applied to all agents ('*' wildcard); not removable per-agent",
                                        name: chip.name,
                                      })
                                    : chip.source === 'class'
                                    ? t('config:bulkManage.skillTooltip.class', {
                                        defaultValue: '{{name}} — applied to all "{{class}}" agents via class default; not removable per-agent',
                                        name: chip.name,
                                        class: agent.class,
                                      })
                                    : chip.name;
                                return (
                                  <span key={chip.name} className="bulk-skill-chip" title={tooltip}>
                                    {chip.name}
                                    {readOnly && (
                                      <span className="bulk-skill-chip-asterisk" aria-hidden="true">
                                        *
                                      </span>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Skill picker overlay */}
          {skillPickerMode && (
            <div className="bulk-confirm-overlay">
              <div className="bulk-confirm-box" style={{ minWidth: 480, maxWidth: 640, textAlign: 'left' }}>
                <p style={{ fontWeight: 600, marginBottom: 8 }}>
                  {skillPickerMode === 'add'
                    ? t('config:bulkManage.picker.addTitle', { defaultValue: 'Add skills to {{count}} selected agent(s)', count: selectedIds.size })
                    : t('config:bulkManage.picker.removeTitle', { defaultValue: 'Remove skills from {{count}} selected agent(s)', count: selectedIds.size })}
                </p>
                <input
                  type="text"
                  className="bulk-filter-search"
                  placeholder={t('config:bulkManage.picker.search', { defaultValue: 'Search skills...' })}
                  value={skillSearchQuery}
                  onChange={e => setSkillSearchQuery(e.target.value)}
                  autoFocus
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <div
                  className="bulk-count-bar"
                  style={{ padding: '4px 0', borderBottom: 'none', marginBottom: 4 }}
                >
                  <span className="bulk-count">
                    {t('config:bulkManage.picker.selectedCount', {
                      defaultValue: '{{selected}} of {{total}} selected',
                      selected: pendingSkillIds.size,
                      total: pickerSkills.length,
                    })}
                  </span>
                  <div className="bulk-select-controls">
                    <button
                      type="button"
                      className="bulk-link-btn"
                      onClick={() => setPendingSkillIds(new Set(pickerSkills.map(s => s.id)))}
                      disabled={pickerSkills.length === 0}
                    >
                      {t('config:bulkManage.selectAll', { defaultValue: 'Select all' })}
                    </button>
                    <button
                      type="button"
                      className="bulk-link-btn"
                      onClick={() => setPendingSkillIds(new Set())}
                      disabled={pendingSkillIds.size === 0}
                    >
                      {t('config:bulkManage.selectNone', { defaultValue: 'Select none' })}
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    maxHeight: 320,
                    overflowY: 'auto',
                    border: '1px solid var(--border-color, #444)',
                    borderRadius: 4,
                    padding: 4,
                    textAlign: 'left',
                  }}
                >
                  {pickerSkills.length === 0 ? (
                    <div className="bulk-empty" style={{ padding: 16 }}>
                      {skillPickerMode === 'remove'
                        ? t('config:bulkManage.picker.emptyRemove', { defaultValue: 'None of the selected agents have a skill matching this filter.' })
                        : t('config:bulkManage.picker.emptySearch', { defaultValue: 'No skills match this search.' })}
                    </div>
                  ) : (
                    pickerSkills.map(skill => {
                      const checked = pendingSkillIds.has(skill.id);
                      return (
                        <label
                          key={skill.id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 8,
                            padding: '6px 8px',
                            cursor: 'pointer',
                            borderRadius: 4,
                            textAlign: 'left',
                            background: checked ? 'var(--accent-soft, #4a9eff20)' : 'transparent',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePendingSkill(skill.id)}
                            style={{ marginTop: 3 }}
                          />
                          <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                            <div style={{ fontWeight: 600 }}>
                              {skill.name}
                              {skill.builtin && (
                                <span style={{ fontSize: 11, color: 'var(--text-muted, #888)', marginLeft: 6 }}>
                                  {t('config:bulkManage.picker.builtIn', { defaultValue: '(built-in)' })}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)' }}>
                              {skill.description}
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
                <div className="bulk-confirm-actions" style={{ marginTop: 12 }}>
                  <button
                    className="btn btn-secondary"
                    onClick={closeSkillPicker}
                    disabled={actionInProgress}
                  >
                    {t('common:buttons.cancel')}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={confirmSkillPick}
                    disabled={pendingSkillIds.size === 0 || actionInProgress}
                  >
                    {t('config:bulkManage.picker.continue', { defaultValue: 'Continue ({{count}})', count: pendingSkillIds.size })}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Confirmation overlay */}
          {confirmAction && (
            <div className="bulk-confirm-overlay">
              <div className={`bulk-confirm-box${confirmAction === 'change-model' ? ' bulk-confirm-box--model' : ''}`}>
                {confirmAction === 'change-model' ? (
                  <>
                    <p>
                      {t('config:bulkManage.confirm.changeModelTo', { defaultValue: 'Change model to ' })}
                      <strong>
                        {modelProvider === 'claude'
                          ? CLAUDE_MODELS[newClaudeModel].label
                          : modelProvider === 'codex'
                            ? CODEX_MODELS[newCodexModel].label
                            : newPiModel}
                      </strong>
                      {(modelProvider === 'claude' || modelProvider === 'pi') && (
                        <>
                          {t('config:bulkManage.confirm.atEffort', { defaultValue: ' at ' })}
                          <strong>
                            {newEffort === 'default'
                              ? t('config:bulkManage.confirm.effortDefault', { defaultValue: 'default effort' })
                              : t('config:bulkManage.confirm.effortLevel', { defaultValue: '{{level}} effort', level: CLAUDE_EFFORTS[newEffort].label })}
                          </strong>
                        </>
                      )}
                      {t('config:bulkManage.confirm.forSelected', { defaultValue: ' for ' })}
                      <strong>{selectedModelAgents.length}</strong>
                      {t('config:bulkManage.confirm.selectedAgentsQ', { defaultValue: ' selected agent(s)?' })}
                    </p>
                    {sameProviderAgents.length > 0 && (
                      <p style={{ color: 'var(--color-success, #4caf7d)', fontWeight: 600 }}>
                        {t('config:bulkManage.confirm.sameProvider', {
                          defaultValue: '{{count}} already use {{provider}}: the model changes in place without restarting or clearing context.',
                          count: sameProviderAgents.length,
                          provider: modelProvider,
                        })}
                      </p>
                    )}
                    {migratingAgents.length > 0 && (
                      <div className="runtime-transfer-panel">
                        <div className="runtime-transfer-panel__title">
                          <Icon name="arrow-right" size={14} />{' '}
                          {t('config:bulkManage.confirm.migrateTitle', {
                            defaultValue: 'Migrate {{count}} agent(s) to {{provider}}',
                            count: migratingAgents.length,
                            provider: modelProvider,
                          })}
                        </div>
                        <div className="spawn-inline-hint">
                          {t('config:bulkManage.confirm.migrateHint', {
                            defaultValue: 'Commander uses the existing per-agent migration flow. Each source session remains archived for rollback.',
                          })}
                        </div>
                        {targetSupportsImport && (
                          <div className="runtime-transfer-mode-grid">
                            {([
                              ['smart', 'Smart Context', 'Useful history and recent turns within the target context budget.'],
                              ['full', 'Visible Transcript', 'Import visible user/assistant turns and safe tool activity.'],
                              ['fresh', 'Fresh Start', 'Archive the source without importing its conversation.'],
                            ] as Array<[SessionTransferMode, string, string]>).map(([mode, label, description]) => (
                              <button
                                type="button"
                                key={mode}
                                className={`runtime-transfer-mode ${transferMode === mode ? 'selected' : ''}`}
                                onClick={() => setTransferMode(mode)}
                              >
                                <strong>{t(`config:bulkManage.transferMode.${mode}.label`, { defaultValue: label })}</strong>
                                <span>{t(`config:bulkManage.transferMode.${mode}.description`, { defaultValue: description })}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {migratingAgentsWithoutSession.length > 0 && transferMode !== 'fresh' && (
                          <div className="model-change-notice warning">
                            {t('config:bulkManage.confirm.noSessionWarning', {
                              defaultValue: '{{count}} agent(s) have no saved session and will start fresh automatically; saved sessions still use the selected migration mode.',
                              count: migratingAgentsWithoutSession.length,
                            })}
                          </div>
                        )}
                        {activeMigratingAgents.length > 0 && (
                          <label className="spawn-checkbox runtime-transfer-stop-confirmation">
                            <input
                              type="checkbox"
                              checked={stopActiveForTransfer}
                              onChange={(event) => setStopActiveForTransfer(event.target.checked)}
                            />
                            <span>
                              {t('config:bulkManage.confirm.stopActive', {
                                defaultValue: 'Stop {{count}} active task(s) before taking their migration snapshots',
                                count: activeMigratingAgents.length,
                              })}
                            </span>
                          </label>
                        )}
                      </div>
                    )}
                  </>
                ) : confirmAction === 'add-skill' ? (
                  <p>
                    {t('config:bulkManage.confirm.add.p1', { defaultValue: 'Add' })}{' '}
                    <strong>{pendingSkillsList.length}</strong>{' '}
                    {t('config:bulkManage.confirm.add.p2', { defaultValue: 'skill{{plural}} (', plural: pendingSkillsList.length === 1 ? '' : 's' })}<strong>{pendingSkillsLabel}</strong>{t('config:bulkManage.confirm.add.p3', { defaultValue: ') to ' })}<strong>{selectedIds.size}</strong>{' '}
                    {t('config:bulkManage.confirm.add.p4', { defaultValue: 'agent(s)?' })}
                    <br />
                    <span style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>
                      {t('config:bulkManage.confirm.addNote', { defaultValue: 'Idempotent — assignments that already exist will be skipped.' })}
                    </span>
                  </p>
                ) : confirmAction === 'remove-skill' ? (
                  <p>
                    {t('config:bulkManage.confirm.remove.p1', { defaultValue: 'Remove' })}{' '}
                    <strong>{pendingSkillsList.length}</strong>{' '}
                    {t('config:bulkManage.confirm.remove.p2', { defaultValue: 'skill{{plural}} (', plural: pendingSkillsList.length === 1 ? '' : 's' })}<strong>{pendingSkillsLabel}</strong>{t('config:bulkManage.confirm.remove.p3', { defaultValue: ') from up to ' })}<strong>{selectedIds.size}</strong>{' '}
                    {t('config:bulkManage.confirm.remove.p4', { defaultValue: 'selected agent(s)?' })}
                    <br />
                    <span style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>
                      {t('config:bulkManage.confirm.removeNote', {
                        defaultValue: "{{count}} assignment(s) will be removed. Skills that come from the agent's class or '*' are removed only for these agents; the class assignment stays for everyone else.",
                        count: removeSkillAffectedPairs,
                      })}
                    </span>
                  </p>
                ) : (
                  <p>
                    {confirmAction === 'delete'
                      ? t('config:bulkManage.confirm.deleteQ', { defaultValue: 'Delete {{count}} agent(s)? This cannot be undone.', count: selectedIds.size })
                      : t('config:bulkManage.confirm.clearQ', { defaultValue: 'Clear context for {{count}} agent(s)? This will restart their sessions.', count: selectedIds.size })}
                  </p>
                )}
                <div className="bulk-confirm-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setConfirmAction(null)}
                    disabled={actionInProgress}
                  >
                    {t('common:buttons.cancel')}
                  </button>
                  <button
                    className={`btn ${confirmAction === 'add-skill' ? 'btn-primary' : 'btn-danger'}`}
                    onClick={() => handleAction(confirmAction)}
                    disabled={
                      actionInProgress ||
                      (confirmAction === 'change-model' && (
                        selectedModelAgents.length === 0
                        || (modelProvider === 'pi' && !newPiModel)
                        || (activeMigratingAgents.length > 0 && !stopActiveForTransfer)
                      )) ||
                      ((confirmAction === 'add-skill' || confirmAction === 'remove-skill') && pendingSkillIds.size === 0)
                    }
                  >
                    {actionInProgress
                      ? t('config:bulkManage.working', { defaultValue: 'Working...' })
                      : t('config:bulkManage.confirmBtn', { defaultValue: 'Confirm' })}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Footer actions */}
          <div className="modal-footer bulk-footer">
            <div className="footer-buttons-left">
              <button
                className="btn btn-danger"
                disabled={selectedIds.size === 0 || actionInProgress}
                onClick={() => setConfirmAction('delete')}
              >
                {t('config:bulkManage.footer.delete', { defaultValue: 'Delete Selected' })}
              </button>
              <button
                className="btn btn-secondary"
                disabled={selectedIds.size === 0 || actionInProgress}
                onClick={() => setConfirmAction('clear-context')}
              >
                {t('config:bulkManage.footer.clearContext', { defaultValue: 'Clear Context' })}
              </button>
              <button
                className="btn btn-primary"
                disabled={selectedIds.size === 0 || actionInProgress}
                onClick={() => openSkillPicker('add')}
              >
                {t('config:bulkManage.footer.addSkill', { defaultValue: 'Add Skill' })}
              </button>
              <button
                className="btn btn-secondary"
                disabled={selectedIds.size === 0 || actionInProgress}
                onClick={() => openSkillPicker('remove')}
              >
                {t('config:bulkManage.footer.removeSkill', { defaultValue: 'Remove Skill' })}
              </button>
            </div>

            <div className="footer-buttons-right">
              <button
                className="btn btn-secondary"
                disabled={selectedIds.size === 0 || actionInProgress}
                onClick={() => handleAction('stop')}
              >
                {t('config:bulkManage.footer.stop', { defaultValue: 'Stop Selected' })}
              </button>

              <SearchableSelect
                value={moveAreaId}
                onChange={setMoveAreaId}
                pinnedOptions={moveAreaPinned}
                options={areaOptions}
                placeholder={t('config:bulkManage.searchAreas', { defaultValue: 'Search areas…' })}
                className="bulk-filter-select"
                disabled={selectedIds.size === 0 || actionInProgress}
              />
              <button
                className="btn btn-primary"
                disabled={selectedIds.size === 0 || actionInProgress}
                onClick={() => handleAction('move-area')}
              >
                {t('config:bulkManage.footer.moveToArea', { defaultValue: 'Move to Area' })}
              </button>
            </div>
          </div>

          {/* Change Model row */}
          <div className="modal-footer bulk-footer bulk-change-model-row">
            <div className="footer-buttons-left">
              <span className="bulk-change-model-label">
                {t('config:bulkManage.changeModel.label', { defaultValue: 'Change Model:' })}
              </span>
              <select
                value={modelProvider}
                onChange={e => setModelProvider(e.target.value as ModelProvider)}
                className="bulk-filter-select"
                disabled={actionInProgress}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="pi">Pi Universal</option>
              </select>

              {modelProvider === 'claude' ? (
                <select
                  value={newClaudeModel}
                  onChange={e => setNewClaudeModel(e.target.value as ClaudeModel)}
                  className="bulk-filter-select"
                  disabled={actionInProgress}
                >
                  {(Object.keys(CLAUDE_MODELS) as ClaudeModel[])
                    .filter(m => !isDeprecatedClaudeModel(m) || newClaudeModel === m)
                    .map(m => (
                      <option key={m} value={m}>
                        {CLAUDE_MODELS[m].icon} {CLAUDE_MODELS[m].label}
                      </option>
                    ))}
                </select>
              ) : modelProvider === 'codex' ? (
                <select
                  value={newCodexModel}
                  onChange={e => setNewCodexModel(e.target.value as CodexModel)}
                  className="bulk-filter-select"
                  disabled={actionInProgress}
                >
                  {(Object.keys(CODEX_MODELS) as CodexModel[])
                    .filter(m => !isDeprecatedCodexModel(m) || newCodexModel === m)
                    .map(m => (
                    <option key={m} value={m}>
                      {CODEX_MODELS[m].icon} {CODEX_MODELS[m].label}
                    </option>
                  ))}
                </select>
              ) : (
                <PiModelSelect
                  value={newPiModel}
                  onChange={setNewPiModel}
                  inputId="bulk-pi-model"
                />
              )}

              {(modelProvider === 'claude' || modelProvider === 'pi') && (
                <select
                  value={newEffort}
                  onChange={e => setNewEffort(e.target.value as ClaudeEffort | 'default')}
                  className="bulk-filter-select"
                  disabled={actionInProgress}
                  title={t('config:bulkManage.changeModel.effortTitle', { defaultValue: 'Reasoning effort level' })}
                >
                  <option value="default">
                    {t('config:bulkManage.changeModel.defaultEffort', { defaultValue: 'Default effort' })}
                  </option>
                  {(Object.keys(CLAUDE_EFFORTS) as ClaudeEffort[]).map(level => (
                    <option key={level} value={level}>
                      {CLAUDE_EFFORTS[level].icon} {CLAUDE_EFFORTS[level].label}
                    </option>
                  ))}
                </select>
              )}

              <span className="bulk-change-model-count">
                {t('config:bulkManage.changeModel.selectedCount', { defaultValue: '{{count}} selected', count: selectedModelAgents.length })}
                {migratingAgents.length > 0
                  ? t('config:bulkManage.changeModel.migrateSuffix', { defaultValue: ' · {{count}} migrate', count: migratingAgents.length })
                  : ''}
              </span>
            </div>
            <div className="footer-buttons-right">
              <button
                className="btn btn-primary"
                disabled={selectedModelAgents.length === 0 || actionInProgress || (modelProvider === 'pi' && !newPiModel)}
                onClick={() => setConfirmAction('change-model')}
              >
                {t('config:bulkManage.changeModel.button', { defaultValue: 'Change Model' })}
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
