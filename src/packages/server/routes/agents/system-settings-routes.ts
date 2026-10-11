/**
 * 系统设置路由:系统提示词、echo、codex 路径、各运行时模式开关、备份调度与默认技能。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './helpers.js';
import { Request, Response } from 'express';
import * as path from 'path';
import { agentService } from '../../services/index.js';
import { logConfig } from '../../services/activity-log.js';
import { getDefaultAgentSkillSlugs, setDefaultAgentSkillSlugs, resetDefaultAgentSkillSlugs, getFactoryDefaultAgentSkillSlugs, isDefaultAgentSkillsConfigured } from '../../services/default-agent-skills-service.js';
import { getSystemPrompt, setSystemPrompt, clearSystemPrompt, isEchoPromptEnabled, setEchoPromptEnabled, getCodexBinaryPath, setCodexBinaryPath, isTmuxModeEnabled, setTmuxModeEnabled, isInteractiveModeEnabled, setInteractiveModeEnabled, isCodexAppServerModeEnabled, setCodexAppServerModeEnabled, isOpencodeServerModeEnabled, setOpencodeServerModeEnabled, isPiRpcModeEnabled, setPiRpcModeEnabled } from '../../services/system-prompt-service.js';
import { markInstructionsDirtyForAll } from '../../services/instruction-refresh.js';
import { getBackupStatus, setBackupEnabled } from '../../services/backup-service.js';

// ============================================================================
// System Settings Routes
// ============================================================================

// GET /api/system-settings/prompt - Get the current system prompt
export const handleGetSystemSettingsPrompt = (_req: Request, res: Response) => {
  try {
    const prompt = getSystemPrompt();
    res.json({ prompt });
  } catch (err: any) {
    log.error(' Failed to get system prompt:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/prompt - Update the system prompt
export const handlePostSystemSettingsPrompt = (req: Request, res: Response) => {
  try {
    const { prompt } = req.body;

    if (typeof prompt !== 'string') {
      res.status(400).json({ error: 'Prompt must be a string' });
      return;
    }

    setSystemPrompt(prompt);
    // 任务19·A（⑭ P2·系统活动7）：配置变更埋点（prompt 不落全文，只记长度）
    logConfig({ key: 'system-prompt', action: 'set', valueLength: prompt.length });

    // The global system prompt is part of the injected instruction block. Claude
    // re-applies it on every resume, but the stdin backends (OpenCode/Codex) skip
    // that block on resume — flag every agent so the change reaches live sessions.
    markInstructionsDirtyForAll(agentService.getAllAgents().map(a => a.id));

    log.log(` System prompt updated (${prompt.length} chars)`);

    res.json({
      success: true,
      message: 'System prompt updated successfully',
      length: prompt.length
    });
  } catch (err: any) {
    log.error(' Failed to set system prompt:', err);
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/system-settings/prompt - Clear the system prompt
export const handleDeleteSystemSettingsPrompt = (_req: Request, res: Response) => {
  try {
    clearSystemPrompt();
    // 任务19·A（⑭ P2·系统活动7）：配置变更埋点
    logConfig({ key: 'system-prompt', action: 'clear' });

    // Same as the update path: flag every agent so the stdin backends drop the
    // now-removed system prompt from their next resumed turn.
    markInstructionsDirtyForAll(agentService.getAllAgents().map(a => a.id));

    log.log(` System prompt cleared`);

    res.json({
      success: true,
      message: 'System prompt cleared successfully'
    });
  } catch (err: any) {
    log.error(' Failed to clear system prompt:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/echo-prompt - Get echo prompt setting
export const handleGetSystemSettingsEchoPrompt = (_req: Request, res: Response) => {
  try {
    const enabled = isEchoPromptEnabled();
    res.json({ enabled });
  } catch (err: any) {
    log.error(' Failed to get echo prompt setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/echo-prompt - Update echo prompt setting
export const handlePostSystemSettingsEchoPrompt = (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setEchoPromptEnabled(enabled);
    log.log(` Echo prompt setting updated: enabled=${enabled}`);
    res.json({ success: true, enabled });
  } catch (err: any) {
    log.error(' Failed to set echo prompt setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/codex-binary - Get the codex binary path
export const handleGetSystemSettingsCodexBinary = (_req: Request, res: Response) => {
  try {
    const binaryPath = getCodexBinaryPath();
    res.json({ path: binaryPath });
  } catch (err: any) {
    log.error(' Failed to get codex binary path:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/codex-binary - Set the codex binary path
export const handlePostSystemSettingsCodexBinary = (req: Request, res: Response) => {
  try {
    const { path: binaryPath } = req.body;
    if (typeof binaryPath !== 'string') {
      res.status(400).json({ error: 'path must be a string' });
      return;
    }
    setCodexBinaryPath(binaryPath);
    log.log(` Codex binary path updated: ${binaryPath || '(cleared)'}`);
    res.json({ success: true, path: binaryPath });
  } catch (err: any) {
    log.error(' Failed to set codex binary path:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/tmux-mode - Get tmux mode setting
export const handleGetSystemSettingsTmuxMode = (_req: Request, res: Response) => {
  try {
    const enabled = isTmuxModeEnabled();
    res.json({ enabled });
  } catch (err: any) {
    log.error(' Failed to get tmux mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/tmux-mode - Update tmux mode setting
export const handlePostSystemSettingsTmuxMode = (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setTmuxModeEnabled(enabled);
    // 任务19·A（⑭ P2·系统活动7）：配置变更埋点（tmux 开关，配合 ⑪ 回滚开关）
    logConfig({ key: 'tmux-mode', action: 'set', value: enabled });
    log.log(` Tmux mode setting updated: enabled=${enabled}`);
    res.json({ success: true, enabled });
  } catch (err: any) {
    log.error(' Failed to set tmux mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/interactive-mode - Get experimental interactive-TUI mode setting
export const handleGetSystemSettingsInteractiveMode = (_req: Request, res: Response) => {
  try {
    const enabled = isInteractiveModeEnabled();
    res.json({ enabled });
  } catch (err: any) {
    log.error(' Failed to get interactive mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/interactive-mode - Update experimental interactive-TUI mode setting
export const handlePostSystemSettingsInteractiveMode = (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setInteractiveModeEnabled(enabled);
    log.log(` Interactive mode setting updated: enabled=${enabled}`);
    res.json({ success: true, enabled });
  } catch (err: any) {
    log.error(' Failed to set interactive mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/codex-app-server-mode - Get experimental Codex app-server (streaming) mode setting
export const handleGetSystemSettingsCodexAppServerMode = (_req: Request, res: Response) => {
  try {
    const enabled = isCodexAppServerModeEnabled();
    res.json({ enabled });
  } catch (err: any) {
    log.error(' Failed to get codex app-server mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/codex-app-server-mode - Update experimental Codex app-server (streaming) mode setting
export const handlePostSystemSettingsCodexAppServerMode = (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setCodexAppServerModeEnabled(enabled);
    log.log(` Codex app-server mode setting updated: enabled=${enabled}`);
    res.json({ success: true, enabled });
  } catch (err: any) {
    log.error(' Failed to set codex app-server mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/opencode-server-mode - Get experimental OpenCode server (streaming) mode setting
export const handleGetSystemSettingsOpencodeServerMode = (_req: Request, res: Response) => {
  try {
    const enabled = isOpencodeServerModeEnabled();
    res.json({ enabled });
  } catch (err: any) {
    log.error(' Failed to get opencode server mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/opencode-server-mode - Update experimental OpenCode server (streaming) mode setting
export const handlePostSystemSettingsOpencodeServerMode = (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setOpencodeServerModeEnabled(enabled);
    log.log(` OpenCode server mode setting updated: enabled=${enabled}`);
    res.json({ success: true, enabled });
  } catch (err: any) {
    log.error(' Failed to set opencode server mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/pi-rpc-mode - Get Pi RPC (mid-turn steering) mode setting
export const handleGetSystemSettingsPiRpcMode = (_req: Request, res: Response) => {
  try {
    const enabled = isPiRpcModeEnabled();
    res.json({ enabled });
  } catch (err: any) {
    log.error(' Failed to get pi RPC mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/pi-rpc-mode - Update Pi RPC (mid-turn steering) mode setting
export const handlePostSystemSettingsPiRpcMode = (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setPiRpcModeEnabled(enabled);
    // 任务19·A（⑭ P2·系统活动7）：配置变更埋点（pi-rpc 开关，配合 ⑪ 回滚开关）
    logConfig({ key: 'pi-rpc-mode', action: 'set', value: enabled });
    log.log(` Pi RPC mode setting updated: enabled=${enabled}`);
    res.json({ success: true, enabled });
  } catch (err: any) {
    log.error(' Failed to set pi RPC mode setting:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/system-settings/backup - Get hourly backup scheduler status
export const handleGetSystemSettingsBackup = (_req: Request, res: Response) => {
  try {
    res.json(getBackupStatus());
  } catch (err: any) {
    log.error(' Failed to get backup status:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/system-settings/backup - Enable or disable the hourly backup scheduler
export const handlePostSystemSettingsBackup = (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const status = setBackupEnabled(enabled);
    res.json({ success: true, ...status });
  } catch (err: any) {
    log.error(' Failed to set backup enabled:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// Default Agent Skills (skills pre-selected in the spawn modal)
// ============================================================================

/** Shape shared by every response below so the client always gets the full picture. */
function defaultAgentSkillsPayload() {
  return {
    slugs: getDefaultAgentSkillSlugs(),
    factoryDefault: getFactoryDefaultAgentSkillSlugs(),
    configured: isDefaultAgentSkillsConfigured(),
  };
}

// GET /api/agents/system-settings/default-agent-skills - Skills pre-selected for new agents
export const handleGetSystemSettingsDefaultAgentSkills = (_req: Request, res: Response) => {
  try {
    res.json(defaultAgentSkillsPayload());
  } catch (err: any) {
    log.error(' Failed to get default agent skills:', err);
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/agents/system-settings/default-agent-skills - Replace the pre-selected list
export const handlePutSystemSettingsDefaultAgentSkills = (req: Request, res: Response) => {
  try {
    const { slugs } = req.body ?? {};
    // An empty array is valid and means "pre-select nothing".
    if (!Array.isArray(slugs) || slugs.some((slug: unknown) => typeof slug !== 'string')) {
      res.status(400).json({ error: 'slugs must be an array of strings' });
      return;
    }
    setDefaultAgentSkillSlugs(slugs);
    res.json({ success: true, ...defaultAgentSkillsPayload() });
  } catch (err: any) {
    log.error(' Failed to set default agent skills:', err);
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/agents/system-settings/default-agent-skills - Back to the factory list
export const handleDeleteSystemSettingsDefaultAgentSkills = (_req: Request, res: Response) => {
  try {
    resetDefaultAgentSkillSlugs();
    res.json({ success: true, ...defaultAgentSkillsPayload() });
  } catch (err: any) {
    log.error(' Failed to reset default agent skills:', err);
    res.status(500).json({ error: err.message });
  }
};
