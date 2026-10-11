/**
 * 按区域分组的折叠区块(自 AgentOverviewPanel 迁出)。
 *
 * 自 AgentOverviewPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type AreaGroupSectionProps } from './types';
import React from 'react';
import { store } from '../../../store';
import { Icon } from '../../Icon';
import { ActivityGlyph } from '../../shared/ActivityGlyph';

export const AreaGroupSection = React.memo(function AreaGroupSection({
  group,
  groupByArea,
  isCollapsed,
  unassignedLabel,
  isEditingPrompt,
  editingPromptText,
  setEditingPromptText,
  setEditingPromptAreaId,
  toggleArea,
  openAreaContextMenu,
  toggleAreaVisibility,
  renderAgentCards,
  t,
}: AreaGroupSectionProps) {
  const areaKey = group.area?.id || '__unassigned__';
  const areaName = group.area?.name || (groupByArea ? unassignedLabel : '');
  const areaColor = group.area?.color || '#6272a4';
  const workingAgentCount = group.agents.filter(agent => agent.status === 'working').length;
  return (
    <div className="aop-area-group">
      {/* Only show area header when grouping is on */}
      {groupByArea && (
        <div
          className={`aop-area-header${workingAgentCount > 0 ? ' aop-area-header--working' : ''}`}
          data-area-id={areaKey}
          onClick={() => toggleArea(areaKey)}
          onContextMenu={(event) => {
            if (!group.area) return;
            event.preventDefault();
            event.stopPropagation();
            openAreaContextMenu(group.area, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
          style={{
            borderLeftColor: areaColor,
            '--aop-area-color': areaColor,
          } as React.CSSProperties}
        >
          <span className="aop-area-expand"><Icon name={isCollapsed ? 'caret-right' : 'caret-down'} size={10} /></span>
          <span className="aop-area-color" style={{ background: areaColor }} />
          <span
            className="aop-area-name"
            onContextMenu={(event) => {
              if (!group.area) return;
              event.preventDefault();
              event.stopPropagation();
              openAreaContextMenu(group.area, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            {areaName}
          </span>
          <button
            type="button"
            className="aop-area-eye-btn"
            title={t('terminal:overview.hideArea', { defaultValue: 'Hide area' })}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleAreaVisibility(areaKey);
            }}
          >
            <Icon name="target" size={14} />
          </button>
          {group.area && (
            <button
              type="button"
              className="aop-area-eye-btn"
              title={t('terminal:overview.editAreaPrompt', { defaultValue: 'Edit area prompt' })}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const area = group.area!;
                if (isEditingPrompt) {
                  setEditingPromptAreaId(null);
                } else {
                  setEditingPromptText(area.prompt || '');
                  setEditingPromptAreaId(area.id);
                }
              }}
            >
              <Icon name="edit" size={12} />
            </button>
          )}
          {group.area && (() => {
            const area = group.area;
            return (
            <button
              type="button"
              className="aop-area-add-btn"
              title={t('common:agentBar.newAgent')}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openAreaContextMenu(area, {
                  x: rect.left,
                  y: rect.bottom + 6,
                });
              }}
            >
              +
            </button>
            );
          })()}
          {workingAgentCount > 0 && (
            <span
              className="aop-area-working"
              title={workingAgentCount === 1 ? t('terminal:overview.workingAgentsOne', { defaultValue: '{{n}} working agent', n: workingAgentCount }) : t('terminal:overview.workingAgentsMany', { defaultValue: '{{n}} working agents', n: workingAgentCount })}
              aria-label={workingAgentCount === 1 ? t('terminal:overview.workingAgentsOne', { defaultValue: '{{n}} working agent', n: workingAgentCount }) : t('terminal:overview.workingAgentsMany', { defaultValue: '{{n}} working agents', n: workingAgentCount })}
            >
              <ActivityGlyph animated size={12} className="aop-area-working-glyph" />
              <span>{workingAgentCount}</span>
            </span>
          )}
          <span className="aop-area-count">{group.agents.length}</span>
        </div>
      )}
      {isEditingPrompt && group.area && (
        <div className="aop-area-prompt-editor" onClick={(e) => e.stopPropagation()}>
          <textarea
            className="aop-area-prompt-textarea"
            value={editingPromptText}
            onChange={(e) => setEditingPromptText(e.target.value)}
            placeholder={t('terminal:overview.areaPromptPlaceholder', { defaultValue: 'System prompt for agents in this area...' })}
            rows={3}
            autoFocus
          />
          <div className="aop-area-prompt-actions">
            <button
              className="aop-area-prompt-save"
              onClick={() => {
                store.updateArea(group.area!.id, { prompt: editingPromptText });
                setEditingPromptAreaId(null);
              }}
            >
              {t('common:buttons.save')}
            </button>
            <button
              className="aop-area-prompt-cancel"
              onClick={() => setEditingPromptAreaId(null)}
            >
              {t('common:buttons.cancel')}
            </button>
          </div>
        </div>
      )}
      {(!groupByArea || !isCollapsed) && (
        <div className={groupByArea ? 'aop-area-content' : undefined}>
          {renderAgentCards(group.agents)}
        </div>
      )}
    </div>
  );
});
