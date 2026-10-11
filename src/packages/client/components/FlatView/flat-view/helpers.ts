/**
 * FlatView 的纯助手(嵌入面板读写 / cwd 短格式 / 模型标签 / 落点判定)。
 *
 * 自 index.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { FLAT_EMBED_LS_KEY } from './constants';
import { CLAUDE_MODELS, CLAUDE_EFFORTS, CODEX_MODELS, DEFAULT_CODEX_MODEL, DEFAULT_GROK_MODEL } from '../../../../shared/types';
import { Agent } from '../../../../shared/types';
import { type DockPanelType } from '../../../utils/buildingViewMode';

export function readFlatEmbeddedPanels(): Record<string, { type: DockPanelType; buildingId: string }> {
  try {
    const raw = localStorage.getItem(FLAT_EMBED_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeFlatEmbeddedPanel(areaId: string, panel: { type: DockPanelType; buildingId: string } | null): void {
  try {
    const map = readFlatEmbeddedPanels();
    if (panel) map[areaId] = panel;
    else delete map[areaId];
    localStorage.setItem(FLAT_EMBED_LS_KEY, JSON.stringify(map));
  } catch {
    /* quota/private mode — open state just won't stick */
  }
}

export function formatCwdShort(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length === 0) return cwd;
  return parts.slice(-2).join('/');
}

// Resolve a compact "Model · Effort" label for the header chip. Claude agents
// have both a model and a reasoning effort; Codex/OpenCode only carry a model.
export function getAgentModelLabel(agent: Agent): { model: string; effort?: string } {
  if (agent.provider === 'codex') {
    const id = agent.codexModel || DEFAULT_CODEX_MODEL;
    const meta = (CODEX_MODELS as Record<string, { label: string }>)[id];
    return { model: meta?.label || id };
  }
  if (agent.provider === 'opencode') {
    return { model: (agent as unknown as { opencodeModel?: string }).opencodeModel || 'opencode' };
  }
  if (agent.provider === 'grok') {
    const id = (agent as unknown as { grokModel?: string }).grokModel || DEFAULT_GROK_MODEL;
    const effortId = agent.effort;
    const effortMeta = effortId
      ? (CLAUDE_EFFORTS as Record<string, { label: string }>)[effortId]
      : undefined;
    return { model: id, effort: effortMeta?.label };
  }
  if (agent.provider === 'pi') {
    const id = (agent as unknown as { piModel?: string }).piModel || 'pi default';
    const effortId = agent.effort;
    const effortMeta = effortId
      ? (CLAUDE_EFFORTS as Record<string, { label: string }>)[effortId]
      : undefined;
    return { model: id, effort: effortMeta?.label };
  }
  const id = agent.model || agent.detectedModel || 'default';
  const meta = (CLAUDE_MODELS as Record<string, { label: string }>)[id];
  const effortId = agent.effort;
  const effortMeta = effortId
    ? (CLAUDE_EFFORTS as Record<string, { label: string }>)[effortId]
    : undefined;
  return { model: meta?.label || id, effort: effortMeta?.label };
}

// Geometry helper — mirrors ClaudeOutputPanel/index.tsx so the area-dir chips
// (and the agent→area resolution) behave identically to the Guake statusbar.
export function flatIsPositionInArea(
  pos: { x: number; z: number },
  area: { type: string; center: { x: number; z: number }; width?: number; height?: number; radius?: number }
): boolean {
  if (area.type === 'rectangle' && area.width && area.height) {
    const halfW = area.width / 2;
    const halfH = area.height / 2;
    return (
      pos.x >= area.center.x - halfW &&
      pos.x <= area.center.x + halfW &&
      pos.z >= area.center.z - halfH &&
      pos.z <= area.center.z + halfH
    );
  }
  if (area.type === 'circle' && area.radius) {
    const dx = pos.x - area.center.x;
    const dz = pos.z - area.center.z;
    return dx * dx + dz * dz <= area.radius * area.radius;
  }
  return false;
}
