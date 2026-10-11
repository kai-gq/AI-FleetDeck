/**
 * 智能体卡片与选择态上下文(自 AgentOverviewPanel 迁出)。
 *
 * 自 AgentOverviewPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type AgentCardSelectionState, type AgentCardProps, type SubagentEntry } from './types';
import { STATUS_ICONS, STATUS_LABEL_KEYS } from './constants';
import { getMessageSummary, truncate } from './helpers';
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { store } from '../../../store';
import { getToolIconName, formatTimestamp } from '../../../utils/outputRendering';
import { getClassConfig } from '../../../utils/classConfig';
import { prefetchAgentHistory } from '../useHistoryLoader';
import { type Agent } from '../../../../shared/types';
import { AgentIcon } from '../../AgentIcon';
import { Icon } from '../../Icon';
import { useHasDraft } from '../../../utils/agentDrafts';
import { TaskProgressDots } from '../../shared/TaskProgressDots';
import { SubordinateProgressDots } from '../../shared/SubordinateProgressDots';
import { AgentHoverTooltip } from '../../shared/AgentHoverTooltip';
import { ActivityGlyph } from '../../shared/ActivityGlyph';
import { ProviderIcon } from '../../ProviderIcon';
import { CopyAgentIdentityButton } from '../../shared/CopyAgentIdentityButton';

export const AgentCardSelectionContext = React.createContext<AgentCardSelectionState>({
  activeAgentId: '',
  subordinateAgentIds: null,
  subordinateLabel: 'Reports to selected boss',
});

/**
 * Selection-only state lives in a tiny context consumer inside each card.
 * Selecting a boss can change the subordinate marker on dozens of rows; keeping
 * that bit out of AgentCard's props prevents every card from rescanning history
 * and rebuilding its full content just to toggle one class/badge.
 */
const AgentCardSelectionMarker = React.memo(function AgentCardSelectionMarker({ agentId }: { agentId: string }) {
  const selection = React.useContext(AgentCardSelectionContext);
  const isActive = selection.activeAgentId === agentId;
  const isSubordinate = selection.subordinateAgentIds?.has(agentId) ?? false;
  if (!isActive && !isSubordinate) return null;

  return (
    <>
      {isActive && <span className="aop-agent-state-marker--active" aria-hidden="true" />}
      {isSubordinate && (
        <span
          className="aop-subordinate-badge"
          title={selection.subordinateLabel}
          aria-label={selection.subordinateLabel}
        >
          <Icon name="link" size={10} color="#ffd700" weight="bold" />
        </span>
      )}
    </>
  );
});

/** Tiny SVG activity cue; rotating its 13px texture avoids card-sized paints. */
const AgentCardWorkingIndicator = React.memo(function AgentCardWorkingIndicator({
  label,
}: {
  label: string;
}) {
  return (
    <span className="aop-agent-working-glyph" title={label} aria-label={label}>
      <ActivityGlyph animated size={13} />
    </span>
  );
});

export const AgentCard = React.memo(function AgentCard({
  agent,
  isExpanded,
  isMobile,
  hasPendingRead,
  isTwoFingerHovered,
  showAreaChip,
  toolExecs,
  subagents,
  subordinates,
  areaInfo,
  matchContext,
  customClasses,
  isCompacting,
  onSelect,
  onClearContext,
  onContextMenu,
}: AgentCardProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const classConfig = getClassConfig(agent.class, customClasses);
  const isBossAgent = agent.isBoss || agent.class === 'boss';
  const hasDraft = useHasDraft(agent.id);
  const _statusIcon = STATUS_ICONS[agent.status] || '❓';
  const _statusLabel = STATUS_LABEL_KEYS[agent.status] ? t(`terminal:${STATUS_LABEL_KEYS[agent.status]}`) : agent.status;
  const recentTools = toolExecs.slice(0, isMobile ? 4 : 8);
  const { lastMessage: lastMsg, messageCount: msgCount } = getMessageSummary(agent.id);
  const trunc = isMobile ? 40 : 80;

  // Build unified subagent list: live subagents + Task tool execs not in live store
  const allSubagentEntries = useMemo((): SubagentEntry[] => {
    const entries: SubagentEntry[] = [];
    const seenNames = new Set<string>();

    // First: live subagents from the store (most accurate status)
    for (const sub of subagents) {
      entries.push({
        id: sub.id,
        name: sub.name,
        type: sub.subagentType,
        description: sub.description,
        status: sub.status,
        timestamp: sub.startedAt,
      });
      seenNames.add(sub.name);
    }

    // Second: Task tool executions that don't have a matching live subagent
    for (const exec of toolExecs) {
      if (exec.toolName !== 'Task' && exec.toolName !== 'Agent') continue;
      const desc = (exec.toolInput?.description as string) || (exec.toolInput?.name as string) || '';
      const name = desc || (exec.toolInput?.prompt as string)?.slice(0, 40) || 'Task';
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      entries.push({
        id: `task-${exec.timestamp}`,
        name,
        type: (exec.toolInput?.subagent_type as string) || 'unknown',
        description: (exec.toolInput?.prompt as string)?.slice(0, 100),
        status: 'completed',
        timestamp: exec.timestamp,
      });
    }

    // Sort by timestamp descending (newest first)
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  }, [subagents, toolExecs]);

  const activeSubagents = allSubagentEntries.filter(s => s.status === 'working' || s.status === 'spawning');
  const hasVisibleSubagents = allSubagentEntries.length > 0;
  const hasVisibleRecentActivity = recentTools.length > 0;
  const hasAnyVisibleSection = hasVisibleSubagents || hasVisibleRecentActivity;
  const contextUsageRatio = agent.contextLimit > 0 ? agent.contextUsed / agent.contextLimit : 0;
  const contextUsagePercent = Math.min(100, contextUsageRatio * 100);
  const clampedContextRatio = Math.min(1, Math.max(0, contextUsageRatio));
  const contextHue = Math.round((1 - clampedContextRatio) * 120); // 120=green, 0=red
  const contextFillColor = `hsl(${contextHue} 80% 45% / 0.55)`;
  const swipeRevealWidth = 112;
  const swipeRevealThreshold = 56;
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipeRevealed, setSwipeRevealed] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchStartXRef = useRef(0);
  const touchStartYRef = useRef(0);
  const touchStartOffsetRef = useRef(0);
  const hasDirectionRef = useRef(false);
  const isHorizontalSwipeRef = useRef(false);
  const suppressNextClickRef = useRef(false);

  useEffect(() => {
    if (isMobile) return;
    setSwipeOffset(0);
    setSwipeRevealed(false);
    setIsSwiping(false);
  }, [isMobile]);

  const handleSelect = useCallback(() => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    if (swipeRevealed) {
      setSwipeOffset(0);
      setSwipeRevealed(false);
      suppressNextClickRef.current = true;
      return;
    }

    onSelect(agent.id);
  }, [onSelect, agent.id, swipeRevealed]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobile || event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchStartXRef.current = touch.clientX;
    touchStartYRef.current = touch.clientY;
    touchStartOffsetRef.current = swipeRevealed ? swipeRevealWidth : 0;
    hasDirectionRef.current = false;
    isHorizontalSwipeRef.current = false;
    setIsSwiping(true);
  }, [isMobile, swipeRevealed]);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobile || !isSwiping || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const deltaX = touch.clientX - touchStartXRef.current;
    const deltaY = touch.clientY - touchStartYRef.current;

    if (!hasDirectionRef.current) {
      if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
      hasDirectionRef.current = true;
      isHorizontalSwipeRef.current = Math.abs(deltaX) > Math.abs(deltaY);
    }

    if (!isHorizontalSwipeRef.current) return;

    event.preventDefault();
    const nextOffset = Math.max(0, Math.min(swipeRevealWidth, touchStartOffsetRef.current - deltaX));
    setSwipeOffset(nextOffset);
  }, [isMobile, isSwiping]);

  const finishSwipe = useCallback(() => {
    if (!isMobile || !isSwiping) return;
    setIsSwiping(false);

    if (!isHorizontalSwipeRef.current) {
      if (!swipeRevealed) setSwipeOffset(0);
      return;
    }

    const reveal = swipeOffset >= swipeRevealThreshold;
    const changed = reveal !== swipeRevealed || swipeOffset !== (reveal ? swipeRevealWidth : 0);
    setSwipeRevealed(reveal);
    setSwipeOffset(reveal ? swipeRevealWidth : 0);
    if (changed) suppressNextClickRef.current = true;
  }, [isMobile, isSwiping, swipeOffset, swipeRevealed]);

  const handleClearContext = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClearContext(agent.id);
    setSwipeRevealed(false);
    setSwipeOffset(0);
    suppressNextClickRef.current = true;
  }, [onClearContext, agent.id]);

  return (
    <div className={`aop-agent-swipe${isMobile ? ' swipe-enabled' : ''}${swipeRevealed ? ' revealed' : ''}`}>
      {isMobile && (
        <button
          type="button"
          className="aop-swipe-clear-action"
          onClick={handleClearContext}
          title={t('terminal:overview.clearContext', { defaultValue: 'Clear context' })}
        >
          <Icon name="clear" size={14} /> {t('common:buttons.clear')}
        </button>
      )}
      <div
        className={`aop-agent-card ${isBossAgent ? 'boss' : ''} ${agent.status}${agent.standby === true ? ' standby' : ''} ${hasPendingRead ? 'unread' : ''}${isTwoFingerHovered ? ' two-finger-hover' : ''}${isCompacting ? ' compacting' : ''}`}
        data-agent-id={agent.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-agent-id', agent.id);
          e.dataTransfer.effectAllowed = 'copy';
          (e.currentTarget as HTMLElement).style.opacity = '0.5';
        }}
        onDragEnd={(e) => {
          (e.currentTarget as HTMLElement).style.opacity = '';
        }}
        onClick={handleSelect}
        // Warm the history cache during hover (same as the pinned bar) so a
        // click switches to an already-cached conversation.
        onMouseEnter={() => prefetchAgentHistory(agent.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(agent.id, { x: e.clientX, y: e.clientY });
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={finishSwipe}
        onTouchCancel={finishSwipe}
        style={isMobile ? {
          transform: `translateX(-${swipeOffset}px)`,
          transition: isSwiping ? 'none' : 'transform 0.18s ease',
        } : undefined}
      >
        {/* Left avatar — PNG icon or emoji, with provider badge */}
        <div
          className={`aop-card-avatar${classConfig.iconPath ? '' : ' emoji'}`}
          style={!classConfig.iconPath ? { background: `${classConfig.color}25` } : undefined}
        >
          <AgentIcon agent={agent} size="100%" customClasses={customClasses} />
          <ProviderIcon
            agent={agent}
            alt={t('terminal:header.providerAlt', { defaultValue: '{{name}} provider', name: agent.name })}
            className="aop-provider-icon"
          />
        </div>
        <div className="aop-card-content">
        {/* Card Header - always visible */}
        <AgentHoverTooltip todos={agent.latestTodos} subordinates={isBossAgent ? subordinates : undefined} position="bottom">
        <div className="aop-agent-header">
        <span
          className="aop-agent-name"
          title={t('terminal:overview.clickToSwitch')}
        >
          {isBossAgent && <span className="aop-boss-crown" aria-hidden="true"><Icon name="crown" size={12} color="#ffd700" weight="fill" /></span>}
          <AgentCardSelectionMarker agentId={agent.id} />
          {agent.name}
        </span>
        {agent.standby === true && (
          <span
            className="aop-standby-badge"
            title={t('terminal:overview.standbyBadgeTooltip', { defaultValue: 'Deactivated by the user — this agent receives no delegations until you restore it (right-click → Restore).' })}
            aria-label={t('terminal:overview.standbyBadge', { defaultValue: 'Standby' })}
          >
            <Icon name="pause" size={10} weight="fill" />
            <span>{t('terminal:overview.standbyBadge', { defaultValue: 'Standby' })}</span>
          </span>
        )}
        <CopyAgentIdentityButton name={agent.name} id={agent.id} />
        {(agent.status === 'working' || isCompacting) && (
          <AgentCardWorkingIndicator
            label={isCompacting ? t('terminal:overview.compactingContext', { defaultValue: 'Compacting context' }) : t('terminal:overview.statusLabels.working')}
          />
        )}
        {hasPendingRead && (
          <span className="aop-pending-read-indicator" title={t('terminal:overview.pendingRead', { defaultValue: 'Pending read' })}>!</span>
        )}
        {hasDraft && (
          <span
            className="aop-draft-indicator"
            title={t('terminal:overview.hasDraft', { defaultValue: 'Has unsent draft' })}
            aria-label={t('terminal:overview.hasDraft', { defaultValue: 'Has unsent draft' })}
          >
            <Icon name="edit" size={10} />
          </span>
        )}
        {msgCount > 0 && (
          <span className="aop-msg-count" title={t('terminal:overview.messages', { count: msgCount })}>
            {msgCount}
          </span>
        )}
        {activeSubagents.length > 0 && (
          <span className="aop-subagent-count" title={activeSubagents.map(s => `${s.name}: ${s.description || s.type}`).join('\n')}>
            ⑂{activeSubagents.length}
          </span>
        )}
        {allSubagentEntries.length > 0 && activeSubagents.length === 0 && (
          <span className="aop-subagent-count" title={t('terminal:overview.subagentsCompleted', { count: allSubagentEntries.length })} style={{ opacity: 0.5 }}>
            ⑂{allSubagentEntries.length}
          </span>
        )}
        {showAreaChip && areaInfo && (
          <span
            className="aop-area-chip"
            style={{ background: `${areaInfo.color}10`, borderColor: `${areaInfo.color}25`, color: `color-mix(in srgb, ${areaInfo.color} 65%, var(--text-muted))` }}
          >
            {areaInfo.name}
          </span>
        )}
        {agent.latestTodos && agent.latestTodos.length > 0 && (
          <TaskProgressDots todos={agent.latestTodos} />
        )}
        {isBossAgent && subordinates.length > 0 && (
          <SubordinateProgressDots subordinates={subordinates} />
        )}
        </div>
        </AgentHoverTooltip>

        {/* Task label preview - always visible when available */}
        {agent.taskLabel && (
          <div className="aop-task-label" title={agent.taskLabel}>
            <span className="task-prefix"><Icon name="task" size={12} /></span>
            <span className="task-text">{truncate(agent.taskLabel, trunc)}</span>
          </div>
        )}

        {/* Last message preview - hide assistant messages when collapsed */}
        {lastMsg && (isExpanded || lastMsg.isUserPrompt) && (
          <div
            className={`aop-last-message ${lastMsg.isUserPrompt ? 'user' : 'assistant'}`}
            title={lastMsg.text.split('\n')[0]}
          >
            <span className="lm-prefix"><Icon name={lastMsg.isUserPrompt ? 'caret-right' : 'caret-left'} size={10} /></span>
            <span className="lm-text">{truncate(lastMsg.text, trunc)}</span>
            <span className="lm-time">{formatTimestamp(lastMsg.timestamp)}</span>
          </div>
        )}

        {/* Search match context — shows why agent matched a deep search */}
        {matchContext && (
          <div className={`aop-match-context aop-match-context--${matchContext.type}`} title={matchContext.text}>
            <span className="match-icon">
              <Icon name={matchContext.type === 'file' ? 'file-text' : 'chat'} size={12} />
            </span>
            <span className="match-label">
              {matchContext.type === 'file' ? t('terminal:overview.fileLabel', { defaultValue: 'file' }) : t('terminal:overview.taskLabel', { defaultValue: 'task' })}
            </span>
            <span className="match-text">{truncate(matchContext.text, trunc)}</span>
          </div>
        )}

        {/* Expanded Content */}
        {isExpanded && (
          <div className="aop-agent-body">
            {/* Subagents (live + historical from tool execs) */}
            {hasVisibleSubagents && (
              <div className="aop-subagents">
                <div className="aop-section-label">{t('terminal:overview.subagents', { count: allSubagentEntries.length })}</div>
                {allSubagentEntries.map(sub => (
                  <div key={sub.id} className={`aop-subagent-item ${sub.status}`}>
                    <span className="sub-icon">
                      {sub.status === 'completed' ? <Icon name="success" size={12} color="#4ade80" weight="fill" /> : sub.status === 'failed' ? <Icon name="failure" size={12} color="#ef4444" weight="fill" /> : sub.status === 'unknown' ? <Icon name="status-pending" size={12} /> : <Icon name="subitem" size={12} />}
                    </span>
                    <span className="sub-name">{sub.name}</span>
                    <span className="sub-type">{sub.type}</span>
                    {sub.description && (
                      <span className="sub-desc" title={sub.description}>{truncate(sub.description, isMobile ? 30 : 50)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Recent tool activity timeline */}
            {hasVisibleRecentActivity && (
              <div className="aop-tool-timeline">
                <div className="aop-section-label">{t('terminal:overview.recentActivity')}</div>
                {recentTools.map((exec, i) => {
                  const param = exec.toolInput
                    ? (exec.toolInput.file_path as string)
                      || (exec.toolInput.command as string)?.slice(0, 40)
                      || (exec.toolInput.pattern as string)
                      || (exec.toolInput.description as string)
                      || (exec.toolInput.prompt as string)?.slice(0, 50)
                      || ''
                    : '';
                  return (
                    <div key={`${exec.timestamp}-${i}`} className="aop-timeline-entry">
                      <span className="tl-time">{formatTimestamp(exec.timestamp)}</span>
                      <span className="tl-icon"><Icon name={getToolIconName(exec.toolName)} size={14} /></span>
                      <span className="tl-tool">{exec.toolName}</span>
                      {param && <span className="tl-param">{param}</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {!hasAnyVisibleSection && (
              <div className="aop-no-activity">{t('terminal:overview.noToolActivity')}</div>
            )}
          </div>
        )}

        </div>{/* end aop-card-content */}

        {/* Context usage bar - spans full card width at bottom */}
        {agent.contextLimit > 0 && (
          <div
            className="aop-context-bar"
            title={t('terminal:overview.contextUsed', { defaultValue: '{{pct}}% context used ({{used}}k / {{limit}}k)', pct: Math.round(contextUsageRatio * 100), used: Math.round(agent.contextUsed / 1000), limit: Math.round(agent.contextLimit / 1000) })}
          >
            <div
              className="aop-context-fill"
              style={{ width: `${contextUsagePercent}%`, backgroundColor: contextFillColor }}
            />
          </div>
        )}
      </div>
    </div>
  );
});
