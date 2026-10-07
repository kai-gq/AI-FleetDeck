/**
 * Shared right-click menu for a single agent (Edit / Standby / Clear context /
 * Clone / Fork / Delete). Built once here so every spot that offers the agent
 * menu — the overview panel's cards and the guake header's title area — shows
 * the exact same actions instead of each keeping its own copy.
 */

import React from 'react';
import { store } from '../../store';
import { Icon } from '../Icon';
import type { ContextMenuAction } from '../ContextMenu';
import type { Agent } from '../../../shared/types';

// Loose signature so the `t` of any useTranslation() call fits without
// binding this module to a namespace generic.
type Translate = (key: string, options?: { defaultValue?: string }) => string;

export function buildAgentContextMenuActions(opts: {
  agent: Agent;
  t: Translate;
  /** Delete confirmation is caller-owned — each host renders its own ConfirmModal. */
  onDelete: () => void;
  /**
   * Standby (待岗) toggle. The host owns the confirmation dialog: this fires on
   * click with the intent already resolved (restore is immediate; setting
   * standby opens the host's ConfirmModal). Omit to hide the item.
   */
  onToggleStandby?: () => void;
  /** Host-specific actions inserted after "Edit Agent" (e.g. the overview card's Expand/Collapse). */
  extraActions?: ContextMenuAction[];
}): ContextMenuAction[] {
  const { agent, t, onDelete, onToggleStandby, extraActions = [] } = opts;
  const isStandby = agent.standby === true;
  return [
    {
      id: 'edit-agent',
      label: t('terminal:overview.editAgent', { defaultValue: 'Edit Agent' }),
      icon: <Icon name="edit" size={14} />,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('tide:open-agent-edit', { detail: { agentId: agent.id } }));
      },
    },
    ...extraActions,
    ...(onToggleStandby ? [{
      id: 'toggle-standby',
      label: isStandby
        ? t('terminal:overview.restoreAction', { defaultValue: 'Restore agent' })
        : t('terminal:overview.standbyAction', { defaultValue: 'Set on standby' }),
      icon: <Icon name={isStandby ? 'play' : 'pause'} size={14} />,
      onClick: onToggleStandby,
    }] : []),
    {
      id: 'clear-context',
      label: t('terminal:overview.clearContext', { defaultValue: 'Clear context' }),
      icon: <Icon name="clear" size={14} />,
      // Disabled while on standby: clearing would wipe the very session that
      // restoring the agent is meant to resume.
      disabled: isStandby,
      onClick: () => store.clearContext(agent.id),
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
      onClick: onDelete,
    },
  ];
}
