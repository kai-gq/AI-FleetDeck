/**
 * Voice Assistant Route
 * Processes voice commands using Claude Code (haiku) with persistent session
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { agentService } from '../services/index.js';
import { loadAreas } from '../data/index.js';
import { ClaudeBackend } from '../claude/index.js';
import { logger, sanitizeUnicode } from '../utils/index.js';
import { personaKeyOf, resolvePersonaStyle, VOICE_LENGTH_RULES } from '../../shared/voice-personas.js';

const router = Router();
const claudeBackend = new ClaudeBackend();

// Voice assistant state file
const VOICE_STATE_FILE = path.join(os.homedir(), '.local/share/tide-commander/voice-assistant.json');

// Persistent session ID for voice assistant
let voiceSessionId: string | null = null;
// 上次使用的人设键(personaKeyOf);变化 → 轮换会话,否则 --resume 的历史会盖过新提示词
let voiceSessionPersonaKey: string | null = null;

/**
 * Load voice assistant state from disk
 */
function loadVoiceState(): void {
  try {
    if (fs.existsSync(VOICE_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(VOICE_STATE_FILE, 'utf-8'));
      voiceSessionId = data.sessionId || null;
      voiceSessionPersonaKey = typeof data.personaKey === 'string' ? data.personaKey : null;
      logger.server.log(`[VoiceAssistant] Loaded session: ${voiceSessionId}`);
    }
  } catch (err) {
    logger.server.error(`[VoiceAssistant] Failed to load state:`, err);
  }
}

/**
 * Save voice assistant state to disk
 */
function saveVoiceState(): void {
  try {
    const dir = path.dirname(VOICE_STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(VOICE_STATE_FILE, JSON.stringify({
      sessionId: voiceSessionId,
      personaKey: voiceSessionPersonaKey,
      updatedAt: Date.now(),
    }, null, 2));
  } catch (err) {
    logger.server.error(`[VoiceAssistant] Failed to save state:`, err);
  }
}

// Load state on module init
loadVoiceState();

/**
 * Build the system prompt with current agent list and their areas.
 * persona: 客户端 settings 里的 { preset, custom }(见 shared/voice-personas),缺省用默认人设。
 */
function buildSystemPrompt(persona?: { preset?: unknown; custom?: unknown }): string {
  const agents = agentService.getAllAgents();
  const areas = loadAreas();

  // Build agent list with their assigned areas and boss status
  const agentList = agents.map(a => {
    const agentAreas = areas.filter(area => area.assignedAgentIds.includes(a.id));
    const areaNames = agentAreas.map(area => area.name).join(', ');
    const parts = [`${a.name} (id: ${a.id}, ${a.status})`];
    if (a.isBoss) parts.push('[BOSS]');
    if (areaNames) parts.push(`[areas: ${areaNames}]`);
    return `- ${parts.join(' ')}`;
  }).join('\n');

  const personaStyle = resolvePersonaStyle(persona?.preset, persona?.custom);

  return `你是 Tide Commander(多 AI agent 指挥台)的语音助手。老板通过语音和你说话:你负责把任务派给合适的 agent、汇报 agent 情况,也可以正常聊天、回答问题、给建议——你是个有自己判断的真人助手。

【人设】${personaStyle}

【输出格式】只输出一个 JSON 对象,不要 markdown、不要解释、不要代码块(输出不是合法 JSON 会导致整轮失败):
{"targetAgentId":"id|null","targetAgentName":"name|null","messageToAgent":"要转发给 agent 的完整指令","responseToUser":"给老板播报的话","action":"send_to_agent|list_agents|general_response"}

【action 说明】
- send_to_agent: 老板要求某个 agent 做事。targetAgentId 填下方列表里的 id;messageToAgent 写成给该 agent 的完整指令(写清要做什么)。
- list_agents: 老板想了解有哪些 agent、谁在忙。必须用 responseToUser 口头汇报概况(数量、谁在忙、谁空闲)。
- general_response: 一切无需派活/查询的对话——寒暄、问你自己、闲聊、咨询建议、讨论方案。对老板的决定有不同看法就直接说出来,该质疑质疑。必须给出 responseToUser。

【说话风格】responseToUser 用与老板相同的语言;${VOICE_LENGTH_RULES}派活确认时简短些即可。这是语音播报,写出来就要能直接念。

【agent 列表】(共 ${agents.length} 个)
${agentList}`;
}

/**
 * Call Claude Code with haiku model, maintaining session
 */
async function callClaudeHaiku(
  userMessage: string,
  isFirstMessage: boolean,
  persona?: { preset?: unknown; custom?: unknown },
): Promise<{ text: string; sessionId: string | null }> {
  return new Promise((resolve, reject) => {
    const executable = claudeBackend.getExecutablePath();
    const args = [
      '--print',
      '--verbose',
      '--model', 'haiku',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
    ];

    // Always write system prompt to temp file - Claude Code needs it on every call
    const systemPromptFile = path.join(os.tmpdir(), `voice-assistant-prompt-${Date.now()}.txt`);
    fs.writeFileSync(systemPromptFile, buildSystemPrompt(persona));
    args.push('--system-prompt-file', systemPromptFile);

    // Resume existing session if available
    if (voiceSessionId && !isFirstMessage) {
      args.push('--resume', voiceSessionId);
    }

    const childProcess = spawn(executable, args, {
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      shell: false, // Don't use shell to avoid escaping issues
    });

    // Clean up temp file when done
    const cleanup = () => {
      if (fs.existsSync(systemPromptFile)) {
        try { fs.unlinkSync(systemPromptFile); } catch { /* ignore */ }
      }
    };

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let textOutput = '';
    let newSessionId: string | null = null;

    childProcess.stdout?.on('data', (data: Buffer) => {
      buffer += decoder.write(data);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Capture session ID from init event
          if (event.type === 'system' && event.session_id) {
            newSessionId = event.session_id;
          }

          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) textOutput += block.text;
            }
          }
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
            if (event.event.delta?.type === 'text_delta' && event.event.delta.text) {
              textOutput += event.event.delta.text;
            }
          }
        } catch { /* ignore non-JSON */ }
      }
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      const msg = decoder.write(data);
      // Only log actual errors, not verbose output
      if (msg.includes('Error') || msg.includes('error')) {
        logger.server.error(`[VoiceAssistant] Claude stderr: ${msg}`);
      }
    });

    childProcess.on('close', (code) => {
      cleanup();
      const remaining = buffer + decoder.end();
      if (remaining.trim()) {
        try {
          const event = JSON.parse(remaining);
          if (event.type === 'system' && event.session_id) {
            newSessionId = event.session_id;
          }
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) textOutput += block.text;
            }
          }
        } catch { /* ignore */ }
      }

      if (code !== 0 && !textOutput) reject(new Error(`Claude exited with code ${code}`));
      else if (!textOutput) reject(new Error('No response from Claude'));
      else resolve({ text: textOutput, sessionId: newSessionId });
    });

    childProcess.on('error', (err) => {
      cleanup();
      reject(err);
    });

    childProcess.on('spawn', () => {
      // Include routing instruction with every message to ensure compliance
      const routingInstruction = isFirstMessage ? '' : '\n\n[REMINDER: Output ONLY JSON. No explanations.]';
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: sanitizeUnicode(userMessage) + routingInstruction },
      });
      childProcess.stdin?.write(stdinMessage + '\n');
      childProcess.stdin?.end();
    });

    setTimeout(() => {
      if (!childProcess.killed) {
        childProcess.kill('SIGTERM');
        cleanup();
        reject(new Error('Claude timed out'));
      }
    }, 30000);
  });
}

function stripCodeFences(s: string): string {
  s = s.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}

interface ProcessedCommand {
  targetAgentId: string | null;
  targetAgentName: string | null;
  messageToAgent: string;
  responseToUser: string;
  action: 'send_to_agent' | 'list_agents' | 'general_response';
}

/**
 * POST /api/voice-assistant/process
 */
router.post('/process', async (req: Request, res: Response) => {
  const { text, persona } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text is required' });
  }

  logger.server.log(`[VoiceAssistant] Processing: "${text}" (session: ${voiceSessionId || 'new'})`);

  try {
    // 人设变化 → 轮换会话:--resume 的对话历史会盖过新系统提示词,不轮换新老船长会一直"在场"。
    // personaKey 缺失(旧状态/首次)也算变化 → 一次性轮换到当前人设并落盘。
    const personaKey = personaKeyOf(persona?.preset, persona?.custom);
    if (voiceSessionPersonaKey !== personaKey) {
      if (voiceSessionId) logger.server.log('[VoiceAssistant] Persona changed — starting a new session');
      voiceSessionId = null;
      voiceSessionPersonaKey = personaKey;
      saveVoiceState();
    }

    const isFirstMessage = !voiceSessionId;
    const { text: response, sessionId } = await callClaudeHaiku(text, isFirstMessage, persona);

    // Save session ID for future messages
    if (sessionId && sessionId !== voiceSessionId) {
      voiceSessionId = sessionId;
      saveVoiceState();
      logger.server.log(`[VoiceAssistant] Session saved: ${voiceSessionId}`);
    }

    const jsonStr = stripCodeFences(response);

    let parsed: ProcessedCommand;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      logger.server.error(`[VoiceAssistant] Failed to parse: ${jsonStr}`);
      throw new Error('Failed to parse response');
    }

    logger.server.log(`[VoiceAssistant] Parsed:`, parsed);

    if (parsed.action === 'send_to_agent' && parsed.targetAgentId) {
      const targetAgent = agentService.getAgent(parsed.targetAgentId);
      if (!targetAgent) {
        return res.json({
          success: true,
          response: `No encuentro al agente ${parsed.targetAgentName}`,
        });
      }

      const { runtimeService, bossMessageService } = await import('../services/index.js');
      const { buildCustomAgentConfig } = await import('../websocket/handlers/command-handler.js');

      if (targetAgent.isBoss || targetAgent.class === 'boss') {
        const { message: bossMessage, systemPrompt } = await bossMessageService.buildBossMessage(
          parsed.targetAgentId,
          parsed.messageToAgent
        );
        await runtimeService.sendCommand(parsed.targetAgentId, bossMessage, systemPrompt);
      } else {
        const customAgentConfig = buildCustomAgentConfig(parsed.targetAgentId, targetAgent.class);
        await runtimeService.sendCommand(parsed.targetAgentId, parsed.messageToAgent, undefined, undefined, customAgentConfig);
      }

      logger.server.log(`[VoiceAssistant] Sent to ${targetAgent.name}: "${parsed.messageToAgent}"`);

      return res.json({
        success: true,
        response: parsed.responseToUser,
        targetAgent: { id: targetAgent.id, name: targetAgent.name },
        messageSent: parsed.messageToAgent,
      });
    }

    return res.json({
      success: true,
      response: parsed.responseToUser,
    });
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    logger.server.error(`[VoiceAssistant] Error: ${msg}`);

    // Reset session on error so next message starts fresh
    if (msg.includes('exited with code') || msg.includes('timed out')) {
      voiceSessionId = null;
    }

    return res.status(500).json({ error: 'Failed to process', details: msg });
  }
});

/**
 * POST /api/voice-assistant/reset
 * Reset the voice assistant session
 */
router.post('/reset', (_req: Request, res: Response) => {
  voiceSessionId = null;
  saveVoiceState();
  logger.server.log('[VoiceAssistant] Session reset');
  res.json({ success: true, message: 'Session reset' });
});

router.get('/status', (_req: Request, res: Response) => {
  res.json({
    available: true,
    hasSession: !!voiceSessionId,
    sessionId: voiceSessionId,
    agentCount: agentService.getAllAgents().length,
  });
});

export default router;
