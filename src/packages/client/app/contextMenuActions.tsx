

import React from 'react';
import { store } from '../store';
import type { SceneManager } from '../scene/SceneManager';
import type { ContextMenuAction } from '../components/ContextMenu';
import type { ToastType } from '../components/Toast';
import { Icon } from '../components/Icon';
import type { Agent, DrawingArea as Area, Building } from '../../shared/types';
import { organizeArea } from '../api/area-layout';
import type { OrganizeResult } from '../api/area-layout';
import { getI18nInstance } from '../utils/formatting';

// Loose signature so the bound i18n.t fits without pulling i18next types in.
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Translate a key outside React: the English `defaultValue` keeps en output
 * byte-identical, zh values live in public/locales/zh-CN (locale-only keys).
 * Before i18n init (unit tests) the default is returned with its `{{vars}}`
 * interpolated so callers never see raw placeholders.
 */
function tr(key: string, options: { defaultValue: string } & Record<string, unknown>): string {
  const i18n = getI18nInstance();
  const t = i18n?.t?.bind(i18n) as Translate | undefined;
  if (t) return t(key, options);
  const { defaultValue, ...vars } = options;
  return defaultValue.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

export interface ContextMenuTarget {
  type: 'ground' | 'agent' | 'area' | 'building';
  id?: string;
}

export interface ContextMenuCallbacks {
  showToast: (type: ToastType, title: string, message: string) => void;
  openSpawnModal: () => void;
  openBossSpawnModal: () => void;
  openToolboxModal: () => void;
  openCommanderModal: () => void;
  openExplorerModal: (areaId: string) => void;
  openBuildingModal: (buildingId: string | null) => void;
  openAgentEditModal: (agentId: string) => void;
  requestBuildingDelete: (buildingId: string) => void;
  setSpawnPosition: (pos: { x: number; z: number }) => void;
  openRestoreArchivedModal: (worldPos: { x: number; z: number }) => void;
  sceneRef: React.RefObject<SceneManager | null>;
}

/**
 * Apply organize results: update agent positions in the store so the scene animates them.
 */
export function applyOrganizeResult(
  result: OrganizeResult,
  sceneRef: React.RefObject<SceneManager | null>
): void {
  const state = store.getState();
  for (const entry of result.organized) {
    const agent = state.agents.get(entry.agentId);
    if (agent) {
      const updated = { ...agent, position: entry.position };
      store.updateAgent(updated);
      // Trigger animated movement in the 3D/2D scene
      sceneRef.current?.updateAgent(updated, true);
    }
  }

  for (const entry of result.buildings) {
    const building = state.buildings.get(entry.buildingId);
    if (!building) continue;

    store.updateBuilding(entry.buildingId, { position: entry.position });
    sceneRef.current?.updateBuilding({ ...building, position: entry.position });
  }
}

/**
 * Build context menu actions based on what was clicked
 */
export function buildContextMenuActions(
  worldPos: { x: number; z: number },
  target: ContextMenuTarget,
  agents: Map<string, Agent>,
  areas: Map<string, Area>,
  buildings: Map<string, Building>,
  callbacks: ContextMenuCallbacks
): ContextMenuAction[] {
  const actions: ContextMenuAction[] = [];

  // Agent-specific actions
  if (target.type === 'agent' && target.id) {
    const agent = agents.get(target.id);
    if (agent) {
      actions.push({
        id: 'select-agent',
        label: tr('terminal:sceneMenu.selectAgent', { defaultValue: 'Select {{name}}', name: agent.name }),
        icon: <Icon name="hand-point" size={14} />,
        onClick: () => {
          store.selectAgent(target.id!);
          callbacks.sceneRef.current?.refreshSelectionVisuals();
        },
      });
      actions.push({
        id: 'focus-agent',
        label: tr('terminal:sceneMenu.focusCamera', { defaultValue: 'Focus Camera' }),
        icon: <Icon name="target" size={14} />,
        onClick: () => {
          callbacks.sceneRef.current?.focusAgent(target.id!);
        },
      });
      actions.push({
        id: 'open-terminal',
        label: tr('terminal:controls.shortcuts.open-terminal.name', { defaultValue: 'Open Terminal' }),
        icon: <Icon name="chat" size={14} />,
        onClick: () => {
          store.selectAgent(target.id!);
          store.setTerminalOpen(true);
        },
      });
      actions.push({
        id: 'edit-agent',
        label: tr('terminal:overview.editAgent', { defaultValue: 'Edit Agent' }),
        icon: <Icon name="edit" size={14} />,
        onClick: () => {
          callbacks.openAgentEditModal(target.id!);
        },
      });
      actions.push({
        id: 'clone-agent',
        label: tr('terminal:overview.cloneAgent', { defaultValue: 'Clone Agent' }),
        icon: <Icon name="clipboard" size={14} />,
        onClick: () => {
          store.cloneAgent(target.id!);
          callbacks.showToast(
            'success',
            tr('terminal:sceneMenu.agentCloned', { defaultValue: 'Agent Cloned' }),
            tr('terminal:sceneMenu.agentClonedMsg', { defaultValue: 'Created a copy of {{name}}', name: agent.name })
          );
        },
      });
      actions.push({
        id: 'fork-agent',
        label: tr('terminal:overview.forkAgent', { defaultValue: 'Fork Agent (with history)' }),
        icon: <Icon name="git-branch" size={14} />,
        onClick: () => {
          store.forkAgent(target.id!);
          callbacks.showToast(
            'success',
            tr('terminal:sceneMenu.agentForked', { defaultValue: 'Agent Forked' }),
            tr('terminal:sceneMenu.agentForkedMsg', { defaultValue: 'Forked {{name}} — continues its conversation', name: agent.name })
          );
        },
      });
      actions.push({ id: 'divider-agent', label: '', divider: true, onClick: () => {} });
      actions.push({
        id: 'delete-agent',
        label: tr('terminal:sceneMenu.removeAgent', { defaultValue: 'Remove {{name}}', name: agent.name }),
        icon: <Icon name="failure" size={14} />,
        danger: true,
        onClick: () => {
          store.removeAgentFromServer(target.id!);
          callbacks.sceneRef.current?.removeAgent(target.id!);
          callbacks.showToast(
            'info',
            tr('terminal:sceneMenu.agentRemoved', { defaultValue: 'Agent Removed' }),
            tr('notifications:agent.removed', { defaultValue: '{{name}} removed from view', name: agent.name })
          );
        },
      });
      return actions;
    }
  }

  // Area-specific actions
  if (target.type === 'area' && target.id) {
    const area = areas.get(target.id);
    if (area) {
      actions.push({
        id: 'select-area',
        label: tr('terminal:sceneMenu.selectArea', { defaultValue: 'Select "{{name}}"', name: area.name }),
        icon: <Icon name="class-architect" size={14} />,
        onClick: () => {
          store.selectArea(target.id!);
          callbacks.openToolboxModal();
        },
      });
      if (area.directories && area.directories.length > 0) {
        actions.push({
          id: 'open-explorer',
          label: tr('terminal:sceneMenu.openFileExplorer', { defaultValue: 'Open File Explorer' }),
          icon: <Icon name="folder" size={14} />,
          onClick: () => {
            callbacks.openExplorerModal(target.id!);
          },
        });
      }
      actions.push({
        id: 'spawn-in-area',
        label: tr('terminal:spawn.spawnAgent', { defaultValue: 'Spawn Agent' }),
        icon: <Icon name="robot" size={14} />,
        onClick: () => {
          window.dispatchEvent(
            new CustomEvent('tide:open-spawn-modal', {
              detail: { areaId: target.id, position: { x: area.center.x, z: area.center.z } },
            })
          );
        },
      });
      actions.push({
        id: 'spawn-boss-in-area',
        label: tr('terminal:sceneMenu.spawnBoss', { defaultValue: 'Spawn Boss' }),
        icon: <Icon name="crown" size={14} />,
        onClick: () => {
          window.dispatchEvent(
            new CustomEvent('tide:open-boss-spawn-modal', {
              detail: { areaId: target.id, position: { x: area.center.x, z: area.center.z } },
            })
          );
        },
      });
      actions.push({
        id: 'new-building-in-area',
        label: tr('terminal:sceneMenu.placeBuilding', { defaultValue: 'Place Building' }),
        icon: <Icon name="buildings" size={14} />,
        onClick: () => {
          window.dispatchEvent(
            new CustomEvent('tide:building-create', {
              detail: { position: { x: area.center.x, z: area.center.z } },
            })
          );
        },
      });
      actions.push({ id: 'divider-area-layer', label: '', divider: true, onClick: () => {} });
      actions.push({
        id: 'bring-to-front',
        label: tr('terminal:sceneMenu.bringToFront', { defaultValue: 'Bring to Front' }),
        icon: <Icon name="arrow-up" size={14} />,
        onClick: () => {
          store.bringAreaToFront(target.id!);
          callbacks.sceneRef.current?.syncAreas();
        },
      });
      actions.push({
        id: 'send-to-back',
        label: tr('terminal:sceneMenu.sendToBack', { defaultValue: 'Send to Back' }),
        icon: <Icon name="arrow-down" size={14} />,
        onClick: () => {
          store.sendAreaToBack(target.id!);
          callbacks.sceneRef.current?.syncAreas();
        },
      });
      // Auto-organize agents within this area
      if (area.assignedAgentIds.length > 0) {
        actions.push({
          id: 'organize-area',
          label: tr('terminal:sceneMenu.organizeArea', { defaultValue: 'Organize Area' }),
          icon: <Icon name="sparkle" size={14} />,
          onClick: () => {
            organizeArea(target.id!)
              .then((result) => {
                applyOrganizeResult(result, callbacks.sceneRef);
                const organizedCount = result.organized.length;
                const organizedMsg =
                  organizedCount === 1
                    ? tr('terminal:sceneMenu.areaOrganizedMsgOne', {
                        defaultValue: 'Arranged {{n}} agent in "{{name}}"',
                        n: organizedCount,
                        name: area.name,
                      })
                    : tr('terminal:sceneMenu.areaOrganizedMsgMany', {
                        defaultValue: 'Arranged {{n}} agents in "{{name}}"',
                        n: organizedCount,
                        name: area.name,
                      });
                callbacks.showToast(
                  'success',
                  tr('terminal:sceneMenu.areaOrganized', { defaultValue: 'Area Organized' }),
                  organizedMsg
                );
              })
              .catch((err) => {
                console.error('organize area error:', err);
                callbacks.showToast(
                  'error',
                  tr('terminal:sceneMenu.organizeFailed', { defaultValue: 'Organize Failed' }),
                  err.message || tr('terminal:sceneMenu.organizeFailedMsg', { defaultValue: 'Failed to organize area' })
                );
              });
          },
        });
      }
      actions.push({ id: 'divider-area', label: '', divider: true, onClick: () => {} });
      actions.push({
        id: 'archive-area',
        label: tr('terminal:sceneMenu.archiveArea', { defaultValue: 'Archive "{{name}}"', name: area.name }),
        icon: <Icon name="package" size={14} />,
        onClick: () => {
          const agentCount = area.assignedAgentIds.length;
          // Use stopAgent instead of killAgent so agents are preserved for restore
          store.archiveArea(target.id!, (agentId) => store.stopAgent(agentId));
          callbacks.sceneRef.current?.syncAreas();
          callbacks.sceneRef.current?.syncAgents(Array.from(store.getState().agents.values()));
          let archivedMsg = tr('terminal:sceneMenu.zoneArchivedMsg', {
            defaultValue: '"{{name}}" has been archived',
            name: area.name,
          });
          if (agentCount === 1) {
            archivedMsg = tr('terminal:sceneMenu.zoneArchivedMsgOneStopped', {
              defaultValue: '"{{name}}" has been archived ({{n}} agent stopped)',
              name: area.name,
              n: agentCount,
            });
          } else if (agentCount > 1) {
            archivedMsg = tr('terminal:sceneMenu.zoneArchivedMsgManyStopped', {
              defaultValue: '"{{name}}" has been archived ({{n}} agents stopped)',
              name: area.name,
              n: agentCount,
            });
          }
          callbacks.showToast(
            'info',
            tr('terminal:sceneMenu.zoneArchived', { defaultValue: 'Zone Archived' }),
            archivedMsg
          );
        },
      });
      actions.push({
        id: 'delete-area',
        label: tr('terminal:sceneMenu.deleteArea', { defaultValue: 'Delete "{{name}}"', name: area.name }),
        icon: <Icon name="trash" size={14} />,
        danger: true,
        onClick: () => {
          store.deleteArea(target.id!);
          callbacks.sceneRef.current?.syncAreas();
          callbacks.showToast(
            'info',
            tr('terminal:sceneMenu.areaDeleted', { defaultValue: 'Area Deleted' }),
            tr('terminal:sceneMenu.areaDeletedMsg', { defaultValue: '"{{name}}" has been deleted', name: area.name })
          );
        },
      });
      return actions;
    }
  }

  // Building-specific actions
  if (target.type === 'building' && target.id) {
    const building = buildings.get(target.id);
    if (building) {
      actions.push({
        id: 'select-building',
        label: tr('terminal:sceneMenu.selectBuilding', { defaultValue: 'Select "{{name}}"', name: building.name }),
        icon: <Icon name="buildings" size={14} />,
        onClick: () => {
          store.selectBuilding(target.id!);
          callbacks.openToolboxModal();
        },
      });
      actions.push({
        id: 'edit-building',
        label: tr('terminal:sceneMenu.editBuilding', { defaultValue: 'Edit Building' }),
        icon: <Icon name="edit" size={14} />,
        onClick: () => {
          callbacks.openBuildingModal(target.id!);
        },
      });
      actions.push({
        id: 'clone-building',
        label: tr('terminal:sceneMenu.cloneBuilding', { defaultValue: 'Clone Building' }),
        icon: <Icon name="clipboard" size={14} />,
        onClick: () => {
          // Clone the building with offset position
          const cloneData = {
            name: `${building.name} (Copy)`,
            type: building.type,
            style: building.style,
            color: building.color,
            scale: building.scale,
            icon: building.icon,
            slashCommand: building.slashCommand,
            position: {
              x: building.position.x + 2,
              z: building.position.z + 2,
            },
            cwd: building.cwd,
            folderPath: building.folderPath,
            commands: building.commands,
            pm2: building.pm2,
            docker: building.docker,
            database: building.database,
            urls: building.urls,
            subordinateBuildingIds: building.subordinateBuildingIds,
          };
          store.createBuilding(cloneData);
          callbacks.showToast(
            'success',
            tr('terminal:sceneMenu.buildingCloned', { defaultValue: 'Building Cloned' }),
            tr('terminal:sceneMenu.buildingClonedMsg', { defaultValue: 'Created "{{name}}"', name: cloneData.name })
          );
        },
      });
      if (building.type === 'slash-command') {
        actions.push({
          id: 'run-slash-command',
          label: tr('terminal:sceneMenu.runSlashCommand', { defaultValue: 'Run Slash Command' }),
          icon: <Icon name="bolt" size={14} />,
          onClick: () => {
            window.dispatchEvent(new CustomEvent('tide:open-slash-command-building', {
              detail: { buildingId: building.id },
            }));
          },
        });
      }
      if (building.type === 'folder' && building.folderPath) {
        actions.push({
          id: 'open-folder',
          label: tr('terminal:sceneMenu.openFolder', { defaultValue: 'Open Folder' }),
          icon: <Icon name="folder" size={14} />,
          onClick: () => {
            store.openFileExplorer(building.folderPath!);
          },
        });
      }
      if (building.type === 'tests' && building.folderPath) {
        actions.push({
          id: 'open-tests',
          label: tr('terminal:sceneMenu.openTests', { defaultValue: 'Open Tests' }),
          icon: <Icon name="flask" size={14} />,
          onClick: () => {
            store.openTestsBuilding(building.id);
          },
        });
      }
      if (building.type === 'http' && building.folderPath) {
        actions.push({
          id: 'open-http-requests',
          label: tr('terminal:sceneMenu.openRequests', { defaultValue: 'Open Requests' }),
          icon: <Icon name="globe" size={14} />,
          onClick: () => {
            store.openHttpBuilding(building.id);
          },
        });
      }
      actions.push({ id: 'divider-building', label: '', divider: true, onClick: () => {} });
      actions.push({
        id: 'delete-building',
        label: tr('terminal:sceneMenu.deleteBuilding', { defaultValue: 'Delete "{{name}}"', name: building.name }),
        icon: <Icon name="trash" size={14} />,
        danger: true,
        onClick: () => {
          callbacks.requestBuildingDelete(target.id!);
        },
      });
      return actions;
    }
  }

  // Ground actions (default) - spawn, draw, etc.
  actions.push({
    id: 'spawn-agent',
    label: tr('terminal:sceneMenu.spawnAgentHere', { defaultValue: 'Spawn Agent Here' }),
    icon: <Icon name="robot" size={14} />,
    shortcut: 'N',
    onClick: () => {
      callbacks.setSpawnPosition(worldPos);
      callbacks.openSpawnModal();
    },
  });
  actions.push({
    id: 'spawn-boss',
    label: tr('terminal:sceneMenu.spawnBossHere', { defaultValue: 'Spawn Boss Here' }),
    icon: <Icon name="crown" size={14} />,
    onClick: () => {
      callbacks.setSpawnPosition(worldPos);
      callbacks.openBossSpawnModal();
    },
  });
  actions.push({ id: 'divider-1', label: '', divider: true, onClick: () => {} });
  actions.push({
    id: 'draw-area',
    label: tr('terminal:sceneMenu.drawArea', { defaultValue: 'Draw Area' }),
    icon: <Icon name="class-architect" size={14} />,
    onClick: () => {
      callbacks.sceneRef.current?.setDrawingTool('rectangle');
      if (typeof window !== 'undefined' && (window as any).__tideScene2D_setDrawingTool) {
        (window as any).__tideScene2D_setDrawingTool('rectangle');
      }
      callbacks.showToast(
        'info',
        tr('notifications:drawing.rectangleTool', { defaultValue: 'Rectangle Tool' }),
        tr('notifications:drawing.clickAndDrag', { defaultValue: 'Click and drag on the battlefield to draw an area' })
      );
    },
  });
  actions.push({
    id: 'new-building',
    label: tr('terminal:sceneMenu.placeBuilding', { defaultValue: 'Place Building' }),
    icon: <Icon name="buildings" size={14} />,
    onClick: () => {
      callbacks.openBuildingModal(null);
    },
  });
  // Show "Restore Archived Zone" if there are any archived areas
  const archivedCount = Array.from(areas.values()).filter((a) => a.archived).length;
  if (archivedCount > 0) {
    actions.push({
      id: 'restore-archived',
      label: tr('terminal:sceneMenu.restoreArchived', { defaultValue: 'Restore Archived Zone ({{n}})', n: archivedCount }),
      icon: <Icon name="package" size={14} />,
      onClick: () => {
        callbacks.openRestoreArchivedModal(worldPos);
      },
    });
  }
  actions.push({ id: 'divider-2', label: '', divider: true, onClick: () => {} });
  actions.push({
    id: 'open-settings',
    label: tr('common:buttons.settings', { defaultValue: 'Settings' }),
    icon: <Icon name="gear" size={14} />,
    onClick: () => {
      callbacks.openToolboxModal();
    },
  });
  actions.push({
    id: 'open-commander',
    label: tr('common:floatingButtons.commanderView', { defaultValue: 'Commander View' }),
    icon: <Icon name="dashboard" size={14} />,
    shortcut: 'Tab',
    onClick: () => {
      callbacks.openCommanderModal();
    },
  });

  return actions;
}
