import React, { Suspense, Profiler } from 'react';
import { useTranslation } from 'react-i18next';
import { store, useAgents, useBuildings, useSelectedAgentIds, useSelectedBuildingIds } from '../store';
import { useExplorerAreaId } from '../store/selectors';
import { type SceneConfig } from './toolbox';
import { ContextMenu, type ContextMenuAction } from './ContextMenu';
import { GlobalTestRunnerModal } from './GlobalTestRunnerModal';
import { GlobalTestsBuildingModal } from './TestsBuildingModal';
import { GlobalHttpRequestsBuildingModal } from './HttpRequestsBuildingModal';
import { SlashCommandBuildingModalHost } from './SlashCommandBuildingModal';
import { profileRender } from '../utils/profiling';
import type { UseModalState, UseModalStateWithId, UseContextMenu } from '../hooks';
import type { SessionFinderOpenData } from './SessionSearchModal';
import type { SpawnModalInitialSession } from './SpawnModal';

// Lazy-load heavy modal components (only loaded when first opened)
const SpawnModal = React.lazy(() => import('./SpawnModal').then(m => ({ default: m.SpawnModal })));
const BossSpawnModal = React.lazy(() => import('./BossSpawnModal').then(m => ({ default: m.BossSpawnModal })));
const SubordinateAssignmentModal = React.lazy(() => import('./SubordinateAssignmentModal').then(m => ({ default: m.SubordinateAssignmentModal })));
const Toolbox = React.lazy(() => import('./toolbox').then(m => ({ default: m.Toolbox })));
const VoiceSettingsModal = React.lazy(() => import('./VoiceSettingsModal').then(m => ({ default: m.VoiceSettingsModal })));
const BuildingConfigModal = React.lazy(() => import('./BuildingConfigModal').then(m => ({ default: m.BuildingConfigModal })));
const CommanderView = React.lazy(() => import('./CommanderView').then(m => ({ default: m.CommanderView })));
const FileExplorerPanel = React.lazy(() => import('./FileExplorerPanel').then(m => ({ default: m.FileExplorerPanel })));
const Spotlight = React.lazy(() => import('./Spotlight').then(m => ({ default: m.Spotlight })));
const SessionSearchModal = React.lazy(() => import('./SessionSearchModal').then(m => ({ default: m.SessionSearchModal })));
const ControlsModal = React.lazy(() => import('./ControlsModal').then(m => ({ default: m.ControlsModal })));
const SkillsPanel = React.lazy(() => import('./SkillsPanel').then(m => ({ default: m.SkillsPanel })));
const PluginsPanel = React.lazy(() => import('./PluginsPanel').then(m => ({ default: m.PluginsPanel })));
const AgentEditModal = React.lazy(() => import('./AgentEditModal').then(m => ({ default: m.AgentEditModal })));
const RestoreArchivedAreaModal = React.lazy(() => import('./RestoreArchivedAreaModal').then(m => ({ default: m.RestoreArchivedAreaModal })));
const IntegrationsPanel = React.lazy(() => import('./IntegrationsPanel').then(m => ({ default: m.IntegrationsPanel })));
const MonitoringModal = React.lazy(() => import('./MonitoringModal').then(m => ({ default: m.MonitoringModal })));
const StatisticsModal = React.lazy(() => import('./StatisticsModal').then(m => ({ default: m.StatisticsModal })));
const WorkflowEditorPanel = React.lazy(() => import('./WorkflowEditorPanel').then(m => ({ default: m.WorkflowEditorPanel })));
const TriggerManagerPanel = React.lazy(() => import('./TriggerManagerPanel').then(m => ({ default: m.TriggerManagerPanel })));

interface AppModalsProps {
  // Modal states
  spawnModal: UseModalState<SpawnModalInitialSession>;
  bossSpawnModal: UseModalState;
  subordinateModal: UseModalState<string>;
  toolboxModal: UseModalState;
  voiceSettingsModal: UseModalState;
  commanderModal: UseModalState;
  deleteConfirmModal: UseModalState;
  spotlightModal: UseModalState;
  sessionFinderModal: UseModalState<SessionFinderOpenData>;
  controlsModal: UseModalState;
  skillsModal: UseModalState;
  pluginsModal: UseModalState;
  integrationsModal: UseModalState<string | undefined>;
  monitoringModal: UseModalState;
  statisticsModal: UseModalState;
  workflowEditorModal: UseModalState;
  triggerManagerModal: UseModalState;
  buildingModal: UseModalState<string | null>;
  agentEditModal: UseModalState<string>;
  restoreArchivedModal: UseModalState<{ x: number; z: number } | null>;
  explorerModal: UseModalStateWithId;
  contextMenu: UseContextMenu;

  // Modal data
  spawnPosition: { x: number; z: number } | null;
  spawnAreaId: string | null;
  explorerFolderPath: string | null;
  contextMenuActions: ContextMenuAction[];
  buildingInitialPosition: { x: number; z: number } | null;

  // Config
  sceneConfig: SceneConfig;

  // Callbacks
  onConfigChange: (config: SceneConfig) => void;
  onToolChange: (tool: 'rectangle' | 'circle' | 'select' | null) => void;
  onOpenAreaExplorer: (areaId: string) => void;
  onDeleteSelectedAgents: () => void;

  // Building delete confirmation
  pendingBuildingDelete: string | 'selected' | null;
  onCancelBuildingDelete: () => void;
  onConfirmBuildingDelete: () => void;

  // Navigation modal
  showBackNavModal: boolean;
  onCloseBackNavModal: () => void;
  onLeave: () => void;

  // Building logs modals (for Spotlight)
  onOpenPM2LogsModal: (buildingId: string) => void;
  onOpenBossLogsModal: (buildingId: string) => void;
  onOpenDatabasePanel: (buildingId: string) => void;

  // Scene sync callback for restore
  onSyncScene?: () => void;
}

export function AppModals({
  spawnModal,
  bossSpawnModal,
  subordinateModal,
  toolboxModal,
  voiceSettingsModal,
  commanderModal,
  deleteConfirmModal,
  spotlightModal,
  sessionFinderModal,
  controlsModal,
  skillsModal,
  pluginsModal,
  integrationsModal,
  monitoringModal,
  statisticsModal,
  workflowEditorModal,
  triggerManagerModal,
  buildingModal,
  agentEditModal,
  restoreArchivedModal,
  explorerModal,
  contextMenu,
  spawnPosition,
  spawnAreaId,
  explorerFolderPath,
  contextMenuActions,
  buildingInitialPosition,
  sceneConfig,
  onConfigChange,
  onToolChange,
  onOpenAreaExplorer,
  onDeleteSelectedAgents,
  pendingBuildingDelete,
  onCancelBuildingDelete,
  onConfirmBuildingDelete,
  showBackNavModal,
  onCloseBackNavModal,
  onLeave,
  onOpenPM2LogsModal,
  onOpenBossLogsModal,
  onOpenDatabasePanel,
  onSyncScene,
}: AppModalsProps) {
  const { t } = useTranslation(['common']);
  const agents = useAgents();
  const buildings = useBuildings();
  const [toolboxSearchQuery, setToolboxSearchQuery] = React.useState<string>();

  // A Spotlight Settings result supplies a one-shot panel query. Clear it after
  // any close path so opening Settings normally never restores a stale filter.
  React.useEffect(() => {
    if (!toolboxModal.isOpen) setToolboxSearchQuery(undefined);
  }, [toolboxModal.isOpen]);

  // Clear the Session Finder prefill whenever it closes — by ANY path
  // (Escape, hotkey toggle, backdrop) — so a plain Ctrl+Shift+F reopen
  // doesn't resurrect a stale Spotlight hit.
  const sessionFinderOpen = sessionFinderModal.isOpen;
  const setSessionFinderData = sessionFinderModal.setData;
  React.useEffect(() => {
    if (!sessionFinderOpen) setSessionFinderData(undefined);
  }, [sessionFinderOpen, setSessionFinderData]);
  const selectedAgentIds = useSelectedAgentIds();
  const selectedBuildingIds = useSelectedBuildingIds();
  const explorerAreaId = useExplorerAreaId();

  const isSelectedBuildingsDelete = pendingBuildingDelete === 'selected';
  const pendingBuilding = pendingBuildingDelete && pendingBuildingDelete !== 'selected'
    ? buildings.get(pendingBuildingDelete)
    : null;
  const selectedBuildingCount = selectedBuildingIds.size;

  return (
    <Suspense fallback={null}>
      <SlashCommandBuildingModalHost />

      {/* Toolbox sidebar overlay */}
      <Toolbox
        config={sceneConfig}
        onConfigChange={onConfigChange}
        onToolChange={onToolChange}
        isOpen={toolboxModal.isOpen}
        onClose={toolboxModal.close}
        initialSearchQuery={toolboxSearchQuery}
        onOpenBuildingModal={(buildingId) => buildingModal.open(buildingId || null)}
        onOpenAreaExplorer={onOpenAreaExplorer}
        onOpenIntegrationsModal={(id) => integrationsModal.open(id)}
        onOpenPluginsModal={() => pluginsModal.open()}
        onOpenMonitoringModal={() => monitoringModal.open()}
        onOpenStatisticsModal={() => statisticsModal.open()}
        onOpenWorkflowEditor={() => workflowEditorModal.open()}
        onOpenTriggerManager={() => triggerManagerModal.open()}
      />

      {/* Voice Settings Modal (顶栏话筒 / FAB / 设置面板「已迁出」入口) */}
      <VoiceSettingsModal isOpen={voiceSettingsModal.isOpen} onClose={voiceSettingsModal.close} />

      {/* Building Config Modal */}
      <BuildingConfigModal
        isOpen={buildingModal.isOpen}
        onClose={buildingModal.close}
        buildingId={buildingModal.data}
        initialPosition={buildingInitialPosition || undefined}
      />

      <SpawnModal
        isOpen={spawnModal.isOpen}
        onClose={spawnModal.close}
        onSpawnStart={() => {}}
        onSpawnEnd={() => {}}
        spawnPosition={spawnPosition}
        spawnAreaId={spawnAreaId}
        initialSession={spawnModal.data}
      />

      <BossSpawnModal
        isOpen={bossSpawnModal.isOpen}
        onClose={bossSpawnModal.close}
        onSpawnStart={() => {}}
        onSpawnEnd={() => {}}
        spawnPosition={spawnPosition}
        spawnAreaId={spawnAreaId}
      />

      <SubordinateAssignmentModal
        isOpen={subordinateModal.isOpen}
        bossId={subordinateModal.data || ''}
        onClose={subordinateModal.close}
      />

      {/* Agent Edit Modal */}
      {agentEditModal.isOpen && agentEditModal.data && (() => {
        const agent = agents.get(agentEditModal.data);
        if (!agent) return null;
        return (
          <AgentEditModal
            agent={agent}
            isOpen={agentEditModal.isOpen}
            onClose={agentEditModal.close}
          />
        );
      })()}

      {/* Delete Agent Confirmation Modal */}
      {deleteConfirmModal.isOpen && (
        <div
          className="modal-overlay visible"
          onClick={deleteConfirmModal.close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') deleteConfirmModal.close();
            if (e.key === 'Enter') onDeleteSelectedAgents();
          }}
        >
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">{t('common:appModals.removeAgentsTitle', { defaultValue: 'Remove Agents' })}</div>
            <div className="modal-body confirm-modal-body">
              <p>{selectedAgentIds.size > 1
                ? t('common:appModals.removeAgentsMany', { defaultValue: 'Remove {{n}} selected agents from the battlefield?', n: selectedAgentIds.size })
                : t('common:appModals.removeAgentsOne', { defaultValue: 'Remove {{n}} selected agent from the battlefield?', n: selectedAgentIds.size })}</p>
              <p className="confirm-modal-note">{t('common:appModals.sessionsContinueNote', { defaultValue: 'Claude Code sessions will continue running in the background.' })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={deleteConfirmModal.close}>
                {t('common:buttons.cancel')}
              </button>
              <button className="btn btn-danger" onClick={onDeleteSelectedAgents} autoFocus>
                {t('common:buttons.remove')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Building Confirmation Modal */}
      {(pendingBuilding || isSelectedBuildingsDelete) && (
        <div
          className="modal-overlay visible"
          onClick={onCancelBuildingDelete}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancelBuildingDelete();
            if (e.key === 'Enter') onConfirmBuildingDelete();
          }}
        >
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">{isSelectedBuildingsDelete && selectedBuildingCount > 1
              ? t('common:appModals.deleteBuildingsTitle', { defaultValue: 'Delete Buildings' })
              : t('common:appModals.deleteBuildingTitle', { defaultValue: 'Delete Building' })}</div>
            <div className="modal-body confirm-modal-body">
              {isSelectedBuildingsDelete ? (
                <p>{selectedBuildingCount > 1
                  ? t('common:appModals.deleteBuildingsQ', { defaultValue: 'Delete {{n}} selected buildings?', n: selectedBuildingCount })
                  : t('common:appModals.deleteBuildingQ', { defaultValue: 'Delete {{n}} selected building?', n: selectedBuildingCount })}</p>
              ) : (
                <p>{t('common:appModals.deleteNamedQ1', { defaultValue: 'Delete ' })}<strong>{pendingBuilding?.name}</strong>{t('common:appModals.deleteNamedQ2', { defaultValue: '?' })}</p>
              )}
              <p className="confirm-modal-note">{isSelectedBuildingsDelete && selectedBuildingCount > 1
                ? t('common:appModals.deleteBuildingNoteMany', { defaultValue: 'This will permanently remove the buildings and their configuration.' })
                : t('common:appModals.deleteBuildingNoteOne', { defaultValue: 'This will permanently remove the building and its configuration.' })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={onCancelBuildingDelete}>
                {t('common:buttons.cancel')}
              </button>
              <button className="btn btn-danger" onClick={onConfirmBuildingDelete} autoFocus>
                {t('common:buttons.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Back Navigation Confirmation Modal - highest z-index */}
      {showBackNavModal && (
        <div
          className="modal-overlay navigation-confirm-overlay visible"
          onClick={onCloseBackNavModal}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCloseBackNavModal();
          }}
        >
          <div className="modal confirm-modal navigation-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">{t('common:appModals.leaveTitle', { defaultValue: 'Leave Tide Commander?' })}</div>
            <div className="modal-body confirm-modal-body">
              <p>{t('common:appModals.leaveConfirm', { defaultValue: 'Are you sure you want to leave this page?' })}</p>
              <p className="confirm-modal-note">{t('common:appModals.leaveNote', { defaultValue: 'Active Claude Code sessions will continue running in the background.' })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={onCloseBackNavModal} autoFocus>
                {t('common:appModals.stay', { defaultValue: 'Stay' })}
              </button>
              <button className="btn btn-danger" onClick={onLeave}>
                {t('common:appModals.leave', { defaultValue: 'Leave' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mounted only while open: CommanderView pays its full agents/tabs/
          filter selector pipeline before its own isOpen early-return, and it
          already resets its internal state on close, so unmounting is safe. */}
      {commanderModal.isOpen && (
        <Profiler id="CommanderView" onRender={profileRender}>
          <CommanderView
            isOpen={commanderModal.isOpen}
            onClose={commanderModal.close}
          />
        </Profiler>
      )}

      {/* File Explorer Panel (right side) */}
      <FileExplorerPanel
        isOpen={explorerModal.isOpen || explorerFolderPath !== null || explorerAreaId !== null}
        areaId={explorerModal.id || explorerAreaId || null}
        folderPath={explorerFolderPath}
        onChangeArea={(newAreaId) => {
          // Clear any direct-folder path (opened via the terminal cwd or spotlight)
          // so the freshly picked folder isn't overridden when we leave direct-folder
          // mode — otherwise the lingering cwd path re-seeds the selection.
          store.setExplorerFolderPath(null);
          explorerModal.open(newAreaId);
        }}
        onClose={() => {
          explorerModal.close();
          store.closeFileExplorer();
        }}
      />

      {/* Test results — global mount so Ctrl+T / the explorer button can open it anywhere */}
      <GlobalTestRunnerModal />

      {/* Tests building browser — global mount, driven by store.testsBuildingId */}
      <GlobalTestsBuildingModal />

      {/* HTTP-requests building browser — global mount, driven by store.httpBuildingId */}
      <GlobalHttpRequestsBuildingModal />

      {/* Spotlight / Global Search */}
      <Spotlight
        isOpen={spotlightModal.isOpen}
        onClose={spotlightModal.close}
        onOpenSpawnModal={() => spawnModal.open()}
        onOpenCommanderView={() => commanderModal.open()}
        onOpenToolbox={(searchQuery) => {
          setToolboxSearchQuery(searchQuery);
          toolboxModal.open();
        }}
        onOpenFileExplorer={(areaId) => explorerModal.open(areaId)}
        onOpenPM2LogsModal={onOpenPM2LogsModal}
        onOpenBossLogsModal={onOpenBossLogsModal}
        onOpenDatabasePanel={onOpenDatabasePanel}
        onOpenMonitoringModal={() => monitoringModal.open()}
        onOpenSessionFinder={(data) => sessionFinderModal.open(data)}
      />

      {/* Session Finder (Ctrl+Shift+F, or a Spotlight session hit to restore) */}
      {sessionFinderModal.isOpen && (
        <SessionSearchModal
          isOpen={sessionFinderModal.isOpen}
          initialQuery={sessionFinderModal.data?.initialQuery}
          initialSessionKey={sessionFinderModal.data?.initialSessionKey}
          onClose={sessionFinderModal.close}
        />
      )}

      {/* Controls Modal (Keyboard & Mouse) */}
      <ControlsModal
        isOpen={controlsModal.isOpen}
        onClose={controlsModal.close}
      />

      {/* Skills Panel */}
      <SkillsPanel
        isOpen={skillsModal.isOpen}
        onClose={skillsModal.close}
      />

      {/* Trusted local Plugins */}
      <PluginsPanel
        isOpen={pluginsModal.isOpen}
        onClose={pluginsModal.close}
      />

      {/* Integrations Modal */}
      <IntegrationsPanel
        isOpen={integrationsModal.isOpen}
        onClose={integrationsModal.close}
        initialTab={integrationsModal.data}
      />

      {/* Monitoring Modal */}
      <MonitoringModal
        isOpen={monitoringModal.isOpen}
        onClose={monitoringModal.close}
      />

      {/* Statistics Modal */}
      <StatisticsModal
        isOpen={statisticsModal.isOpen}
        onClose={statisticsModal.close}
      />

      {/* Workflow Editor */}
      <WorkflowEditorPanel
        isOpen={workflowEditorModal.isOpen}
        onClose={workflowEditorModal.close}
      />

      {/* Trigger Manager Panel */}
      <TriggerManagerPanel
        isOpen={triggerManagerModal.isOpen}
        onClose={triggerManagerModal.close}
      />

      {/* Restore Archived Area Modal */}
      <RestoreArchivedAreaModal
        isOpen={restoreArchivedModal.isOpen}
        restorePosition={restoreArchivedModal.data ?? null}
        onClose={restoreArchivedModal.close}
        onRestored={onSyncScene}
      />

      {/* Right-click Context Menu */}
      <ContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.screenPosition}
        worldPosition={contextMenu.worldPosition}
        actions={contextMenuActions}
        onClose={contextMenu.close}
      />
    </Suspense>
  );
}
