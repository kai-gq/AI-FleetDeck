import React from 'react';
import { AgentIcon } from './AgentIcon';
import { Icon } from './Icon';
import {
  AGENT_BADGE_TONE_VARS,
  agentBadgeTone,
  nameInitial,
} from '../utils/agentBadge';
import './AgentBadge.scss';

/**
 * Minimal agent shape the badge needs. Works with store agents, subagents and
 * delegation-tree nodes alike — deliberately structural, not tied to `Agent`.
 */
export interface AgentBadgeAgent {
  name: string;
  class: string;
  status: string;
  isBoss?: boolean;
}

interface AgentBadgeProps {
  agent: AgentBadgeAgent;
  /** Box size — number (px) or a CSS length (e.g. '100%' to fill the host slot). */
  size?: number | string;
  /** Status ring around the tile (default on). Turn OFF where the host already frames status (e.g. AgentBar item borders). */
  ring?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Optional hover title. Off by default so hosts keep their own tooltips. */
  title?: string;
}

/**
 * Individual agent identity tile (SPEC EPIC-8): class icon (custom image >
 * builtin icon > emoji, all via AgentIcon) + name-initial chip + status ring
 * + boss crown. Ring color comes from the shared tone → CSS variable map.
 */
export const AgentBadge = React.memo(function AgentBadge({
  agent,
  size = 24,
  ring = true,
  className,
  style,
  title,
}: AgentBadgeProps) {
  const tone = agentBadgeTone(agent.status);
  const box = typeof size === 'number' ? `${size}px` : size;
  const iconSize = typeof size === 'number' ? Math.round(size * 0.66) : '66%';

  return (
    <span
      className={
        `agent-badge agent-badge--${tone}` +
        (ring ? ' agent-badge--ring' : '') +
        (agent.isBoss ? ' agent-badge--boss' : '') +
        (className ? ` ${className}` : '')
      }
      style={{
        width: box,
        height: box,
        ...(ring ? ({ '--agent-badge-tone': AGENT_BADGE_TONE_VARS[tone] } as React.CSSProperties) : null),
        ...style,
      }}
      title={title}
    >
      <AgentIcon classId={agent.class} size={iconSize} className="agent-badge__icon" />
      <span className="agent-badge__initial" aria-hidden="true">{nameInitial(agent.name)}</span>
      {/* Corner crown only when the base icon doesn't already show one
          (class 'boss' renders the crown as its class icon). */}
      {agent.isBoss && agent.class !== 'boss' && (
        <span className="agent-badge__crown" aria-hidden="true">
          <Icon name="crown" size="52%" weight="fill" />
        </span>
      )}
    </span>
  );
});

export default AgentBadge;
