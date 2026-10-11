/**
 * Agent Routes
 * REST API endpoints for agent management
 * 端点处理器按主题拆入 ./agents/(2026-10-11 W3 拆分);本文件保留 Router 实例、
 * :id 参数注入与按原顺序的路由注册表。
 */

// ============================================================================
// 模块拆分(W3,2026-10-11):端点处理器按主题拆入 ./agents/,此处只保留 Router
// 实例、:id 参数注入与路由注册表(注册顺序与拆分前一致);导出面不变。
// ============================================================================

import { handleGetOpencodeModels, handleGetPiModels } from './agents/model-catalog-routes.js';
import { handleGetClaudeSessions, handleGetToolHistory, handleGetStatus, handleGetRoot, handleGetSimple, handlePostRoot, handleGetTrackingStatuses } from './agents/list-routes.js';
import { handleGetUsageByAgent, handleGetUsageByDay, handleGetIdUsage } from './agents/usage-routes.js';
import { handleGetIdProcessOutput, handleGetIdBackgroundTasks, handleGetIdBackgroundTasksKeyOutput } from './agents/process-routes.js';
import { handlePostBulkDelete, handlePostBulkStop, handlePostBulkClearContext, handlePostBulkChangeModel, handlePostBulkMoveArea, handlePostBulkSkillsAdd, handlePostBulkSkillsRemove, handleGetBulkFilters } from './agents/bulk-routes.js';
import { handlePostIdConvertRuntime, handlePostIdConvertToPi } from './agents/convert-routes.js';
import { handleGetId, handlePatchId, handleGetIdMemory, handlePatchIdMemory, handleDeleteIdMemory, handleGetIdQueue, handleDeleteIdQueueIndex, handlePostIdTerminal, handleDeleteIdTerminal, handleDeleteId } from './agents/crud-routes.js';
import { handleGetIdSessions, handleGetIdHistory, handleGetIdInjectedPrompt, handleGetIdSessionHistory, handleGetIdSessionPreviewSessionId, handleGetIdSearch, handleGetIdFiles } from './agents/history-routes.js';
import { handlePostIdMessage, handlePostIdCollapseContext, handlePostIdSimulateModelFallback, handlePostIdReportTask } from './agents/message-routes.js';
import { handleGetSystemSettingsPrompt, handlePostSystemSettingsPrompt, handleDeleteSystemSettingsPrompt, handleGetSystemSettingsEchoPrompt, handlePostSystemSettingsEchoPrompt, handleGetSystemSettingsCodexBinary, handlePostSystemSettingsCodexBinary, handleGetSystemSettingsTmuxMode, handlePostSystemSettingsTmuxMode, handleGetSystemSettingsInteractiveMode, handlePostSystemSettingsInteractiveMode, handleGetSystemSettingsCodexAppServerMode, handlePostSystemSettingsCodexAppServerMode, handleGetSystemSettingsOpencodeServerMode, handlePostSystemSettingsOpencodeServerMode, handleGetSystemSettingsPiRpcMode, handlePostSystemSettingsPiRpcMode, handleGetSystemSettingsBackup, handlePostSystemSettingsBackup, handleGetSystemSettingsDefaultAgentSkills, handlePutSystemSettingsDefaultAgentSkills, handleDeleteSystemSettingsDefaultAgentSkills } from './agents/system-settings-routes.js';
import { Router } from 'express';
import { withAgentContext } from '../utils/log-context.js';

export { setBroadcast } from './agents/helpers.js';

const router = Router();

router.param('id', (req, _res, next, id) => {
  withAgentContext(typeof id === 'string' ? id : undefined, () => next());
});

// ---------------------------------------------------------------------------
// 路由注册表(处理器见 ./agents/;顺序与拆分前一致)
// ---------------------------------------------------------------------------
router.get('/opencode/models', handleGetOpencodeModels);
router.get('/pi/models', handleGetPiModels);
router.get('/claude-sessions', handleGetClaudeSessions);
router.get('/tool-history', handleGetToolHistory);
router.get('/status', handleGetStatus);
router.get('/usage-by-agent', handleGetUsageByAgent);
router.get('/usage-by-day', handleGetUsageByDay);
router.get('/:id/process-output', handleGetIdProcessOutput);
router.get('/:id/background-tasks', handleGetIdBackgroundTasks);
router.get('/:id/background-tasks/:key/output', handleGetIdBackgroundTasksKeyOutput);
router.get('/', handleGetRoot);
router.get('/simple', handleGetSimple);
router.post('/bulk/delete', handlePostBulkDelete);
router.post('/bulk/stop', handlePostBulkStop);
router.post('/bulk/clear-context', handlePostBulkClearContext);
router.post('/bulk/change-model', handlePostBulkChangeModel);
router.post('/bulk/move-area', handlePostBulkMoveArea);
router.post('/bulk/skills/add', handlePostBulkSkillsAdd);
router.post('/bulk/skills/remove', handlePostBulkSkillsRemove);
router.get('/bulk/filters', handleGetBulkFilters);
router.post('/', handlePostRoot);
router.get('/tracking-statuses', handleGetTrackingStatuses);
router.post('/:id/convert-runtime', handlePostIdConvertRuntime);
router.post('/:id/convert-to-pi', handlePostIdConvertToPi);
router.get('/:id', handleGetId);
router.patch('/:id', handlePatchId);
router.get('/:id/memory', handleGetIdMemory);
router.patch('/:id/memory', handlePatchIdMemory);
router.delete('/:id/memory', handleDeleteIdMemory);
router.get('/:id/queue', handleGetIdQueue);
router.delete('/:id/queue/:index', handleDeleteIdQueueIndex);
router.post('/:id/terminal', handlePostIdTerminal);
router.delete('/:id/terminal', handleDeleteIdTerminal);
router.delete('/:id', handleDeleteId);
router.get('/:id/usage', handleGetIdUsage);
router.get('/:id/sessions', handleGetIdSessions);
router.get('/:id/history', handleGetIdHistory);
router.get('/:id/injected-prompt', handleGetIdInjectedPrompt);
router.get('/:id/session-history', handleGetIdSessionHistory);
router.get('/:id/session-preview/:sessionId', handleGetIdSessionPreviewSessionId);
router.get('/:id/search', handleGetIdSearch);
router.get('/:id/files', handleGetIdFiles);
router.post('/:id/message', handlePostIdMessage);
router.post('/:id/collapse-context', handlePostIdCollapseContext);
router.post('/:id/simulate-model-fallback', handlePostIdSimulateModelFallback);
router.post('/:id/report-task', handlePostIdReportTask);
router.get('/system-settings/prompt', handleGetSystemSettingsPrompt);
router.post('/system-settings/prompt', handlePostSystemSettingsPrompt);
router.delete('/system-settings/prompt', handleDeleteSystemSettingsPrompt);
router.get('/system-settings/echo-prompt', handleGetSystemSettingsEchoPrompt);
router.post('/system-settings/echo-prompt', handlePostSystemSettingsEchoPrompt);
router.get('/system-settings/codex-binary', handleGetSystemSettingsCodexBinary);
router.post('/system-settings/codex-binary', handlePostSystemSettingsCodexBinary);
router.get('/system-settings/tmux-mode', handleGetSystemSettingsTmuxMode);
router.post('/system-settings/tmux-mode', handlePostSystemSettingsTmuxMode);
router.get('/system-settings/interactive-mode', handleGetSystemSettingsInteractiveMode);
router.post('/system-settings/interactive-mode', handlePostSystemSettingsInteractiveMode);
router.get('/system-settings/codex-app-server-mode', handleGetSystemSettingsCodexAppServerMode);
router.post('/system-settings/codex-app-server-mode', handlePostSystemSettingsCodexAppServerMode);
router.get('/system-settings/opencode-server-mode', handleGetSystemSettingsOpencodeServerMode);
router.post('/system-settings/opencode-server-mode', handlePostSystemSettingsOpencodeServerMode);
router.get('/system-settings/pi-rpc-mode', handleGetSystemSettingsPiRpcMode);
router.post('/system-settings/pi-rpc-mode', handlePostSystemSettingsPiRpcMode);
router.get('/system-settings/backup', handleGetSystemSettingsBackup);
router.post('/system-settings/backup', handlePostSystemSettingsBackup);
router.get('/system-settings/default-agent-skills', handleGetSystemSettingsDefaultAgentSkills);
router.put('/system-settings/default-agent-skills', handlePutSystemSettingsDefaultAgentSkills);
router.delete('/system-settings/default-agent-skills', handleDeleteSystemSettingsDefaultAgentSkills);

export default router;
