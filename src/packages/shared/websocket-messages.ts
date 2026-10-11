// ============================================================================
// 模块拆分(W4 特例,2026-10-11):消息接口按主题拆入 ./websocket-messages/,
// 此处保留 ServerMessage / ClientMessage 协议联合与全量再导出;导出面不变。
// ============================================================================

import { type AgentsUpdateMessage, type AgentCreatedMessage, type AgentUpdatedMessage, type AgentDeletedMessage, type EventMessage, type ActivityMessage, type ServerTimeMessage, type PingMessage, type PongMessage, type SpawnAgentMessage, type CloneAgentMessage, type ForkAgentMessage, type SendCommandMessage, type ReattachAgentMessage, type MoveAgentMessage, type KillAgentMessage, type StopAgentMessage, type SetAgentStandbyMessage, type ClearContextMessage, type BrowserRegisterMessage, type BrowserResultMessage, type BrowserCommandMessage, type RestoreSessionMessage, type RestoreSessionNewAgentMessage, type RequestSessionHistoryMessage, type SessionHistoryMessage, type CollapseContextMessage, type RequestContextStatsMessage, type CreateDirectoryMessage, type RemoveAgentMessage, type RenameAgentMessage, type UpdateAgentPropertiesMessage } from './websocket-messages/agents.js';
import { type GitWatchMessage, type GitRefreshMessage, type GitStatusUpdateMessage, type OutputMessage, type PluginOutputMessage, type PluginOutputPatchMessage, type ContextStatsMessage, type ContextUpdateMessage, type CompactingStatusMessage, type ErrorMessage, type CommandStartedMessage, type SessionUpdatedMessage, type DirectoryNotFoundMessage } from './websocket-messages/git-watch.js';
import { type SubagentStartedMessage, type SubagentOutputMessage, type SubagentCompletedMessage, type SubagentStreamMessage, type BackgroundTasksUpdateMessage } from './websocket-messages/subagents.js';
import { type AreasUpdateMessage, type SyncAreasMessage } from './websocket-messages/areas.js';
import { type BuildingsUpdateMessage, type BuildingCreatedMessage, type BuildingUpdatedMessage, type BuildingDeletedMessage, type BuildingLogsMessage, type SyncBuildingsMessage, type BuildingCommandMessage } from './websocket-messages/buildings.js';
import { type PM2LogsStartMessage, type PM2LogsStopMessage, type PM2LogsChunkMessage, type PM2LogsStreamingMessage } from './websocket-messages/pm2.js';
import { type DockerLogsStartMessage, type DockerLogsStopMessage, type DockerLogsChunkMessage, type DockerLogsStreamingMessage, type DockerListContainersMessage, type DockerContainersListMessage } from './websocket-messages/docker.js';
import { type BossBuildingCommandMessage, type AssignBuildingsMessage, type BossBuildingLogsStartMessage, type BossBuildingLogsStopMessage, type BossBuildingLogsChunkMessage, type BossBuildingSubordinatesUpdatedMessage } from './websocket-messages/boss-buildings.js';
import { type PermissionRequestMessage, type PermissionResolvedMessage, type PermissionResponseMessage, type AgentPromptRequestMessage, type AgentPromptResolvedMessage } from './websocket-messages/permissions.js';
import { type AgentNotificationMessage, type WhatsAppMessageReceivedMessage, type FocusAgentMessage, type SendNotificationMessage } from './websocket-messages/notifications.js';
import { type SpawnBossAgentMessage, type AssignSubordinatesMessage, type RemoveSubordinateMessage, type SendBossCommandMessage, type RequestDelegationHistoryMessage, type DelegationDecisionMessage, type BossSubordinatesUpdatedMessage, type DelegationHistoryMessage, type BossSpawnedAgentMessage, type AgentTaskStartedMessage, type AgentTaskOutputMessage, type AgentTaskCompletedMessage, type TaskReceiptMessage } from './websocket-messages/boss.js';
import { type WorkPlanCreatedMessage, type WorkPlanUpdatedMessage, type WorkPlanDeletedMessage, type WorkPlansUpdateMessage, type AnalysisRequestCreatedMessage, type AnalysisRequestCompletedMessage, type ApproveWorkPlanMessage, type ExecuteWorkPlanMessage, type PauseWorkPlanMessage, type CancelWorkPlanMessage, type RequestWorkPlansMessage } from './websocket-messages/work-plans.js';
import { type SkillsUpdateMessage, type SkillCreatedMessage, type SkillUpdatedMessage, type SkillDeletedMessage, type CreateSkillMessage, type UpdateSkillMessage, type DeleteSkillMessage, type AssignSkillMessage, type UnassignSkillMessage, type RequestAgentSkillsMessage, type AgentSkillsMessage } from './websocket-messages/skills.js';
import { type CustomAgentClassesUpdateMessage, type CustomAgentClassCreatedMessage, type CustomAgentClassUpdatedMessage, type CustomAgentClassDeletedMessage, type CreateCustomAgentClassMessage, type UpdateCustomAgentClassMessage, type DeleteCustomAgentClassMessage } from './websocket-messages/custom-agent-classes.js';
import { type ExecTaskStartedMessage, type ExecTasksSnapshotMessage, type ExecTaskOutputMessage, type ExecTaskCompletedMessage } from './websocket-messages/exec-tasks.js';
import { type TestRunStartedMessage, type TestRunOutputMessage, type TestRunProgressMessage, type TestRunCompletedMessage, type HttpRunStartedMessage, type HttpRunCompletedMessage } from './websocket-messages/test-runs.js';
import { type SecretsUpdateMessage, type SecretCreatedMessage, type SecretUpdatedMessage, type SecretDeletedMessage, type CreateSecretMessage, type UpdateSecretMessage, type DeleteSecretMessage } from './websocket-messages/secrets.js';
import { type TestDatabaseConnectionMessage, type TestDatabaseConnectionTransientMessage, type DatabaseConnectionResultMessage, type ListDatabasesMessage, type DatabasesListMessage, type ExecuteQueryMessage, type QueryResultMessage, type SilentQueryResultMessage, type QueryHistoryUpdateMessage, type RequestQueryHistoryMessage, type ToggleQueryFavoriteMessage, type DeleteQueryHistoryMessage, type ClearQueryHistoryMessage, type GetTableSchemaMessage, type TableSchemaMessage, type ListTablesMessage, type TablesListMessage } from './websocket-messages/database.js';
import { type TriggersUpdateMessage, type TriggerCreatedMessage, type TriggerUpdatedMessage, type TriggerDeletedMessage, type TriggerFiredMessage, type TriggerErrorMessage, type CreateTriggerMessage, type UpdateTriggerMessage, type DeleteTriggerMessage, type FireTriggerMessage } from './websocket-messages/triggers.js';
import { type WorkflowDefinitionsUpdateMessage, type WorkflowDefinitionCreatedMessage, type WorkflowDefinitionUpdatedMessage, type WorkflowDefinitionDeletedMessage, type WorkflowInstanceCreatedMessage, type WorkflowInstanceUpdatedMessage, type WorkflowStateChangedMessage, type WorkflowStepUpdateMessage, type WorkflowVariableChangedMessage, type WorkflowCompletedMessage, type WorkflowErrorMessage, type CreateWorkflowDefMessage, type UpdateWorkflowDefMessage, type DeleteWorkflowDefMessage, type StartWorkflowMessage, type PauseWorkflowMessage, type ResumeWorkflowMessage, type CancelWorkflowMessage, type ManualTransitionMessage } from './websocket-messages/workflow.js';

export type { WSMessage } from './websocket-messages/base.js';
export type { AgentsUpdateMessage, AgentCreatedMessage, AgentUpdatedMessage, AgentDeletedMessage, EventMessage, ActivityMessage, ServerTimeMessage, PingMessage, PongMessage, SpawnAgentMessage, CloneAgentMessage, ForkAgentMessage, SendCommandMessage, ReattachAgentMessage, MoveAgentMessage, KillAgentMessage, StopAgentMessage, SetAgentStandbyMessage, ClearContextMessage, BrowserRegisterMessage, BrowserResultMessage, BrowserCommandMessage, RestoreSessionMessage, RestoreSessionNewAgentMessage, RequestSessionHistoryMessage, SessionHistoryMessage, CollapseContextMessage, RequestContextStatsMessage, CreateDirectoryMessage, RemoveAgentMessage, RenameAgentMessage, UpdateAgentPropertiesMessage } from './websocket-messages/agents.js';
export type { GitWatchedFile, GitWatchedDirStatus, GitWatchMessage, GitRefreshMessage, GitStatusUpdateMessage, OutputMessage, PluginOutputMessage, PluginOutputPatchMessage, ContextStatsMessage, ContextUpdateMessage, CompactingStatusMessage, ErrorMessage, CommandStartedMessage, SessionUpdatedMessage, DirectoryNotFoundMessage } from './websocket-messages/git-watch.js';
export type { SubagentStartedMessage, SubagentOutputMessage, SubagentCompletedMessage, SubagentStreamMessage, BackgroundTasksUpdateMessage } from './websocket-messages/subagents.js';
export type { AreasUpdateMessage, SyncAreasMessage } from './websocket-messages/areas.js';
export type { BuildingsUpdateMessage, BuildingCreatedMessage, BuildingUpdatedMessage, BuildingDeletedMessage, BuildingLogsMessage, SyncBuildingsMessage, BuildingCommandMessage } from './websocket-messages/buildings.js';
export type { PM2LogsStartMessage, PM2LogsStopMessage, PM2LogsChunkMessage, PM2LogsStreamingMessage } from './websocket-messages/pm2.js';
export type { DockerLogsStartMessage, DockerLogsStopMessage, DockerLogsChunkMessage, DockerLogsStreamingMessage, DockerListContainersMessage, DockerContainersListMessage } from './websocket-messages/docker.js';
export type { BossBuildingCommandMessage, AssignBuildingsMessage, BossBuildingLogsStartMessage, BossBuildingLogsStopMessage, BossBuildingLogsChunkMessage, BossBuildingSubordinatesUpdatedMessage } from './websocket-messages/boss-buildings.js';
export type { PermissionRequestMessage, PermissionResolvedMessage, PermissionResponseMessage, AgentPromptRequestMessage, AgentPromptResolvedMessage } from './websocket-messages/permissions.js';
export type { AgentNotificationMessage, WhatsAppMessageReceivedMessage, FocusAgentMessage, SendNotificationMessage } from './websocket-messages/notifications.js';
export type { SpawnBossAgentMessage, AssignSubordinatesMessage, RemoveSubordinateMessage, SendBossCommandMessage, RequestDelegationHistoryMessage, DelegationDecisionMessage, BossSubordinatesUpdatedMessage, DelegationHistoryMessage, BossSpawnedAgentMessage, AgentTaskStartedMessage, AgentTaskOutputMessage, AgentTaskCompletedMessage, TaskReceiptMessage } from './websocket-messages/boss.js';
export type { WorkPlanCreatedMessage, WorkPlanUpdatedMessage, WorkPlanDeletedMessage, WorkPlansUpdateMessage, AnalysisRequestCreatedMessage, AnalysisRequestCompletedMessage, ApproveWorkPlanMessage, ExecuteWorkPlanMessage, PauseWorkPlanMessage, CancelWorkPlanMessage, RequestWorkPlansMessage } from './websocket-messages/work-plans.js';
export type { SkillsUpdateMessage, SkillCreatedMessage, SkillUpdatedMessage, SkillDeletedMessage, CreateSkillMessage, UpdateSkillMessage, DeleteSkillMessage, AssignSkillMessage, UnassignSkillMessage, RequestAgentSkillsMessage, AgentSkillsMessage } from './websocket-messages/skills.js';
export type { CustomAgentClassesUpdateMessage, CustomAgentClassCreatedMessage, CustomAgentClassUpdatedMessage, CustomAgentClassDeletedMessage, CreateCustomAgentClassMessage, UpdateCustomAgentClassMessage, DeleteCustomAgentClassMessage } from './websocket-messages/custom-agent-classes.js';
export type { ExecTaskStartedMessage, ExecTasksSnapshotMessage, ExecTaskOutputMessage, ExecTaskCompletedMessage } from './websocket-messages/exec-tasks.js';
export type { TestRunStartedMessage, TestRunOutputMessage, TestRunProgressMessage, TestRunCompletedMessage, HttpRunStartedMessage, HttpRunCompletedMessage } from './websocket-messages/test-runs.js';
export type { SecretsUpdateMessage, SecretCreatedMessage, SecretUpdatedMessage, SecretDeletedMessage, CreateSecretMessage, UpdateSecretMessage, DeleteSecretMessage } from './websocket-messages/secrets.js';
export type { TestDatabaseConnectionMessage, TestDatabaseConnectionTransientMessage, DatabaseConnectionResultMessage, ListDatabasesMessage, DatabasesListMessage, ExecuteQueryMessage, QueryResultMessage, SilentQueryResultMessage, QueryHistoryUpdateMessage, RequestQueryHistoryMessage, ToggleQueryFavoriteMessage, DeleteQueryHistoryMessage, ClearQueryHistoryMessage, GetTableSchemaMessage, TableSchemaMessage, ListTablesMessage, TablesListMessage } from './websocket-messages/database.js';
export type { TriggersUpdateMessage, TriggerCreatedMessage, TriggerUpdatedMessage, TriggerDeletedMessage, TriggerFiredMessage, TriggerErrorMessage, CreateTriggerMessage, UpdateTriggerMessage, DeleteTriggerMessage, FireTriggerMessage } from './websocket-messages/triggers.js';
export type { WorkflowDefinitionsUpdateMessage, WorkflowDefinitionCreatedMessage, WorkflowDefinitionUpdatedMessage, WorkflowDefinitionDeletedMessage, WorkflowInstanceCreatedMessage, WorkflowInstanceUpdatedMessage, WorkflowStateChangedMessage, WorkflowStepUpdateMessage, WorkflowVariableChangedMessage, WorkflowCompletedMessage, WorkflowErrorMessage, CreateWorkflowDefMessage, UpdateWorkflowDefMessage, DeleteWorkflowDefMessage, StartWorkflowMessage, PauseWorkflowMessage, ResumeWorkflowMessage, CancelWorkflowMessage, ManualTransitionMessage } from './websocket-messages/workflow.js';

// ============================================================================
// Message Union Types
// ============================================================================

export type ServerMessage =
  | AgentsUpdateMessage
  | AgentCreatedMessage
  | AgentUpdatedMessage
  | AgentDeletedMessage
  | EventMessage
  | ActivityMessage
  | ServerTimeMessage
  | PongMessage
  | GitStatusUpdateMessage
  | OutputMessage
  | PluginOutputMessage
  | PluginOutputPatchMessage
  | ErrorMessage
  | DirectoryNotFoundMessage
  | CommandStartedMessage
  | SessionUpdatedMessage
  | AreasUpdateMessage
  | BuildingsUpdateMessage
  | BuildingCreatedMessage
  | BuildingUpdatedMessage
  | BuildingDeletedMessage
  | BuildingLogsMessage
  | PermissionRequestMessage
  | PermissionResolvedMessage
  | AgentPromptRequestMessage
  | AgentPromptResolvedMessage
  | DelegationDecisionMessage
  | BossSubordinatesUpdatedMessage
  | DelegationHistoryMessage
  | BossSpawnedAgentMessage
  | AgentTaskStartedMessage
  | AgentTaskOutputMessage
  | AgentTaskCompletedMessage
  | TaskReceiptMessage
  | SkillsUpdateMessage
  | SkillCreatedMessage
  | SkillUpdatedMessage
  | SkillDeletedMessage
  | AgentSkillsMessage
  | CustomAgentClassesUpdateMessage
  | CustomAgentClassCreatedMessage
  | CustomAgentClassUpdatedMessage
  | CustomAgentClassDeletedMessage
  | ContextStatsMessage
  | ContextUpdateMessage
  | WorkPlanCreatedMessage
  | WorkPlanUpdatedMessage
  | WorkPlanDeletedMessage
  | WorkPlansUpdateMessage
  | AnalysisRequestCreatedMessage
  | AnalysisRequestCompletedMessage
  | AgentNotificationMessage
  | WhatsAppMessageReceivedMessage
  | FocusAgentMessage
  | ExecTaskStartedMessage
  | ExecTasksSnapshotMessage
  | ExecTaskOutputMessage
  | ExecTaskCompletedMessage
  | TestRunStartedMessage
  | TestRunOutputMessage
  | TestRunProgressMessage
  | TestRunCompletedMessage
  | HttpRunStartedMessage
  | HttpRunCompletedMessage
  | SecretsUpdateMessage
  | SecretCreatedMessage
  | SecretUpdatedMessage
  | SecretDeletedMessage
  | PM2LogsChunkMessage
  | PM2LogsStreamingMessage
  | DockerLogsChunkMessage
  | DockerLogsStreamingMessage
  | DockerContainersListMessage
  | BossBuildingLogsChunkMessage
  | BossBuildingSubordinatesUpdatedMessage
  | DatabaseConnectionResultMessage
  | DatabasesListMessage
  | QueryResultMessage
  | SilentQueryResultMessage
  | QueryHistoryUpdateMessage
  | TableSchemaMessage
  | TablesListMessage
  | SubagentStartedMessage
  | SubagentOutputMessage
  | SubagentCompletedMessage
  | SubagentStreamMessage
  | BackgroundTasksUpdateMessage
  | TriggersUpdateMessage
  | TriggerCreatedMessage
  | TriggerUpdatedMessage
  | TriggerDeletedMessage
  | TriggerFiredMessage
  | TriggerErrorMessage
  | WorkflowDefinitionsUpdateMessage
  | WorkflowDefinitionCreatedMessage
  | WorkflowDefinitionUpdatedMessage
  | WorkflowDefinitionDeletedMessage
  | WorkflowInstanceCreatedMessage
  | WorkflowInstanceUpdatedMessage
  | WorkflowStateChangedMessage
  | WorkflowStepUpdateMessage
  | WorkflowVariableChangedMessage
  | WorkflowCompletedMessage
  | WorkflowErrorMessage
  | CompactingStatusMessage
  | SessionHistoryMessage
  | BrowserCommandMessage;

export type ClientMessage =
  | SpawnAgentMessage
  | CloneAgentMessage
  | ForkAgentMessage
  | RestoreSessionNewAgentMessage
  | SendCommandMessage
  | ReattachAgentMessage
  | MoveAgentMessage
  | KillAgentMessage
  | StopAgentMessage
  | SetAgentStandbyMessage
  | ClearContextMessage
  | BrowserRegisterMessage
  | BrowserResultMessage
  | RestoreSessionMessage
  | RequestSessionHistoryMessage
  | CollapseContextMessage
  | CreateDirectoryMessage
  | RemoveAgentMessage
  | RenameAgentMessage
  | UpdateAgentPropertiesMessage
  | SyncAreasMessage
  | SyncBuildingsMessage
  | BuildingCommandMessage
  | PM2LogsStartMessage
  | PM2LogsStopMessage
  | GitWatchMessage
  | GitRefreshMessage
  | DockerLogsStartMessage
  | DockerLogsStopMessage
  | DockerListContainersMessage
  | PermissionResponseMessage
  | SpawnBossAgentMessage
  | AssignSubordinatesMessage
  | RemoveSubordinateMessage
  | SendBossCommandMessage
  | RequestDelegationHistoryMessage
  | CreateSkillMessage
  | UpdateSkillMessage
  | DeleteSkillMessage
  | AssignSkillMessage
  | UnassignSkillMessage
  | RequestAgentSkillsMessage
  | CreateCustomAgentClassMessage
  | UpdateCustomAgentClassMessage
  | DeleteCustomAgentClassMessage
  | RequestContextStatsMessage
  | ApproveWorkPlanMessage
  | ExecuteWorkPlanMessage
  | PauseWorkPlanMessage
  | CancelWorkPlanMessage
  | RequestWorkPlansMessage
  | SendNotificationMessage
  | CreateSecretMessage
  | UpdateSecretMessage
  | DeleteSecretMessage
  | BossBuildingCommandMessage
  | AssignBuildingsMessage
  | BossBuildingLogsStartMessage
  | BossBuildingLogsStopMessage
  | TestDatabaseConnectionMessage
  | TestDatabaseConnectionTransientMessage
  | ListDatabasesMessage
  | ExecuteQueryMessage
  | RequestQueryHistoryMessage
  | ToggleQueryFavoriteMessage
  | DeleteQueryHistoryMessage
  | ClearQueryHistoryMessage
  | GetTableSchemaMessage
  | ListTablesMessage
  | CreateTriggerMessage
  | UpdateTriggerMessage
  | DeleteTriggerMessage
  | FireTriggerMessage
  | CreateWorkflowDefMessage
  | UpdateWorkflowDefMessage
  | DeleteWorkflowDefMessage
  | StartWorkflowMessage
  | PauseWorkflowMessage
  | ResumeWorkflowMessage
  | CancelWorkflowMessage
  | ManualTransitionMessage
  | PingMessage;
