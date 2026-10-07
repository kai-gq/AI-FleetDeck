/**
 * Boss Service
 * Manages boss agents, subordinate relationships, and task delegation logic
 * Boss agents can route user commands to the most appropriate subordinate agent
 */

import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as agentService from './agent-service.js';
import type {
  Agent,
  DelegationDecision,
  DelegationUserRating,
  Skill,
  SubordinateContext,
  TaskCard,
  TaskCardStatus,
} from '../../shared/types.js';
import { ClaudeBackend } from '../claude/index.js';
import {
  loadDelegationHistory,
  saveDelegationHistory,
  addDelegationDecision,
  getDelegationHistory as getHistoryFromStorage,
  deleteDelegationHistory,
} from '../data/index.js';
import { logEvent } from '../data/system-log.js';
import { logger, sanitizeUnicode, generateId, truncateOrEmpty } from '../utils/index.js';
import { canTransitionTaskCard } from './task-card-service.js';
import { logTaskCardStatus } from './activity-log.js';
import { buildAgentProfileCard } from './agent-profile-service.js';
import { computeAgentLedger, buildRosterNote } from './agent-ledger-service.js';
import * as skillService from './skill-service.js';

const log = logger.boss || console;

// Delegation history storage (persisted to disk)
let delegationHistories: Map<string, DelegationDecision[]> = new Map();

// Claude backend for delegation analysis
const claudeBackend = new ClaudeBackend();

// Event listeners
type BossListener = (event: string, data: unknown) => void;
const listeners = new Set<BossListener>();

// ============================================================================
// Initialization
// ============================================================================

export function init(): void {
  delegationHistories = loadDelegationHistory();
  log.log?.(' Initialized boss service');
  log.log?.(` Loaded delegation history for ${delegationHistories.size} bosses`);
}

export function shutdown(): void {
  // Save any pending history
  saveDelegationHistory(delegationHistories);
}

// ============================================================================
// Event System
// ============================================================================

export function subscribe(listener: BossListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: string, data: unknown): void {
  listeners.forEach((listener) => listener(event, data));
}

// ============================================================================
// Boss Validation
// ============================================================================

/**
 * Check if an agent is a boss
 * Checks both isBoss property and class === 'boss' for backward compatibility
 */
export function isBossAgent(agentId: string): boolean {
  const agent = agentService.getAgent(agentId);
  return agent?.isBoss === true || agent?.class === 'boss';
}

/**
 * Get a boss agent by ID (returns null if not a boss)
 * Checks both isBoss property and class === 'boss' for backward compatibility
 */
export function getBossAgent(agentId: string): Agent | null {
  const agent = agentService.getAgent(agentId);
  if (!agent?.isBoss && agent?.class !== 'boss') return null;
  return agent;
}

// ============================================================================
// Subordinate Management
// ============================================================================

/**
 * Assign subordinates to a boss
 * Replaces any existing subordinate assignments
 */
export function assignSubordinates(bossId: string, subordinateIds: string[]): void {
  const boss = getBossAgent(bossId);
  if (!boss) {
    throw new Error(`Agent ${bossId} is not a boss`);
  }

  // Validate subordinates
  const validSubordinates: string[] = [];
  for (const subId of subordinateIds) {
    const sub = agentService.getAgent(subId);
    if (!sub) {
      log.log?.(`  Skipping invalid subordinate ID: ${subId}`);
      continue;
    }
    if (sub.isBoss || sub.class === 'boss') {
      log.log?.(`  Skipping boss agent as subordinate: ${sub.name}`);
      continue;
    }
    if (sub.bossId && sub.bossId !== bossId) {
      log.log?.(`  Agent ${sub.name} already has a boss, reassigning`);
      // Remove from previous boss
      const prevBoss = agentService.getAgent(sub.bossId);
      if (prevBoss && prevBoss.subordinateIds) {
        agentService.updateAgent(sub.bossId, {
          subordinateIds: prevBoss.subordinateIds.filter(id => id !== subId)
        });
      }
    }
    validSubordinates.push(subId);
  }

  // Update boss with new subordinates
  agentService.updateAgent(bossId, { subordinateIds: validSubordinates });

  // Update each subordinate with their boss reference
  for (const subId of validSubordinates) {
    agentService.updateAgent(subId, { bossId });
  }

  // Remove bossId from agents no longer subordinate
  const previousSubs = boss.subordinateIds || [];
  for (const prevSubId of previousSubs) {
    if (!validSubordinates.includes(prevSubId)) {
      agentService.updateAgent(prevSubId, { bossId: undefined });
    }
  }

  log.log?.(` Assigned ${validSubordinates.length} subordinates to boss ${boss.name}`);
  emit('subordinates_updated', { bossId, subordinateIds: validSubordinates });
}

/**
 * Remove a subordinate from a boss
 */
export function removeSubordinate(bossId: string, subordinateId: string): void {
  const boss = getBossAgent(bossId);
  if (!boss) {
    throw new Error(`Agent ${bossId} is not a boss`);
  }

  const currentSubs = boss.subordinateIds || [];
  if (!currentSubs.includes(subordinateId)) {
    return; // Already not a subordinate
  }

  // Update boss
  agentService.updateAgent(bossId, {
    subordinateIds: currentSubs.filter(id => id !== subordinateId)
  });

  // Update subordinate
  agentService.updateAgent(subordinateId, { bossId: undefined });

  log.log?.(` Removed subordinate ${subordinateId} from boss ${boss.name}`);
  emit('subordinates_updated', { bossId, subordinateIds: currentSubs.filter(id => id !== subordinateId) });
}

/**
 * Get all subordinates for a boss
 */
export function getSubordinates(bossId: string): Agent[] {
  const boss = getBossAgent(bossId);
  if (!boss) return [];

  const subordinateIds = boss.subordinateIds || [];
  return subordinateIds
    .map(id => agentService.getAgent(id))
    .filter((agent): agent is Agent => agent !== null);
}

/**
 * Get the boss for an agent (if any)
 */
export function getBossForAgent(agentId: string): Agent | null {
  const agent = agentService.getAgent(agentId);
  if (!agent?.bossId) return null;
  return agentService.getAgent(agent.bossId) || null;
}

// ============================================================================
// Context Gathering
// ============================================================================

/**
 * Gather context for all subordinates of a boss
 * Used for LLM delegation decision
 *
 * B1（任务18）扩展：每名下属附带一张人事档案卡（技能摘要 + 历史表现），
 * 由 subordinate-context-service.buildBossContext 渲染进 Boss 快照 TEAM 段。
 * 纯聚合在 agent-profile-service（显式 now 注入）；这里只做数据接线与失败降级。
 *
 * 任务22 扩展：同一份合并委派史 + 花名册压成编制台账，非「保留」的建议以行尾
 * 注记进档案卡（如「观察中：连续失败 3 次」）。只标注、不自动执行任何动作。
 */
export async function gatherSubordinateContext(bossId: string): Promise<SubordinateContext[]> {
  const subordinates = getSubordinates(bossId);
  const now = Date.now();

  // 历史表现取全部 Boss 的委派史合并（与 vcs.collectDelegationHistory 同口径：
  // 同一个 agent 换过团队，之前的战绩仍是它的战绩）。只在内存 map 里读，零磁盘 IO；
  // 读取异常按空史降级——档案卡退化为「有技能、无样本」，快照照常注入。
  let allDecisions: DelegationDecision[] = [];
  try {
    allDecisions = Array.from(delegationHistories.values()).flat();
  } catch (err) {
    log.warn?.(' Failed to collect delegation history for agent profiles, degrading to empty:', err);
  }

  // 任务22 编制注记：agentId → 短句（仅非 keep 档有）；台账异常 → 无注记降级，快照照常。
  const rosterNotes = new Map<string, string>();
  try {
    const roster = agentService
      .getAllAgents()
      .filter((agent) => !agent.isBoss)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        ...(typeof agent.lastAssignedTaskTime === 'number'
          ? { lastAssignedTaskTime: agent.lastAssignedTaskTime }
          : {}),
      }));
    for (const entry of computeAgentLedger(allDecisions, roster, now)) {
      const note = buildRosterNote(entry);
      if (note) rosterNotes.set(entry.agentId, note);
    }
  } catch (err) {
    log.warn?.(' Roster ledger failed, snapshot runs without roster notes:', err);
  }

  return Promise.all(subordinates.map(async (sub) => {
    // Mirror the guake-agent-context component in
    // src/packages/client/components/ClaudeOutputPanel/index.tsx:1705-1710
    // byte-for-byte so every TEAM CONTEXT line matches the subordinate's UI bar.
    const stats = sub.contextStats;
    const totalTokens = stats ? stats.totalTokens : (sub.contextUsed || 0);
    const contextWindow = stats ? stats.contextWindow : (sub.contextLimit || 200000);
    const rawUsedPercent = stats ? stats.usedPercent : Math.round((totalTokens / contextWindow) * 100);
    const usedPercent = Math.max(0, Math.min(100, rawUsedPercent));
    const contextPercent = Math.round(usedPercent);
    const tokensUsed = totalTokens;

    // B1 人事档案卡：技能库不可读/抛错 → 空技能表降级，绝不打断 Boss 快照
    // （验收「失败降级：技能库不可读时不炸快照」）。整卡组装的意外异常同样兜底跳过卡片。
    let profile: SubordinateContext['profile'];
    try {
      let skills: Skill[] = [];
      try {
        skills = skillService.getSkillsForAgent(sub.id, sub.class, sub.isBoss);
      } catch (err) {
        log.warn?.(` Skill lookup failed for ${sub.name}; profile degrades to no skills:`, err);
      }
      profile = buildAgentProfileCard({
        agentId: sub.id,
        agentName: sub.name,
        skills,
        decisions: allDecisions,
        now,
        rosterNote: rosterNotes.get(sub.id) ?? null,
      });
    } catch (err) {
      log.warn?.(` Failed to build profile card for ${sub.name}, omitting it:`, err);
    }

    return {
      id: sub.id,
      name: sub.name,
      class: sub.class,
      status: sub.status,
      currentTask: sub.currentTask,
      lastAssignedTask: sub.lastAssignedTask,
      contextPercent,
      tokensUsed,
      ...(profile ? { profile } : {}),
    };
  }));
}

// ============================================================================
// Delegation Logic
// ============================================================================

/**
 * Delegate a command to the most appropriate subordinate
 * Uses LLM to analyze subordinate context and select the best agent
 */
export async function delegateCommand(
  bossId: string,
  command: string
): Promise<DelegationDecision> {
  const boss = getBossAgent(bossId);
  if (!boss) {
    throw new Error(`Agent ${bossId} is not a boss`);
  }

  const subordinates = getSubordinates(bossId);
  if (subordinates.length === 0) {
    throw new Error(`Boss ${boss.name} has no subordinates to delegate to`);
  }

  log.log?.(` Boss ${boss.name} delegating: "${truncateOrEmpty(command, 50)}"`);

  // Gather subordinate context
  const contexts = await gatherSubordinateContext(bossId);

  // Create pending decision
  const decisionId = generateId();
  const pendingDecision: DelegationDecision = {
    id: decisionId,
    timestamp: Date.now(),
    bossId,
    userCommand: command,
    selectedAgentId: '',
    selectedAgentName: '',
    reasoning: 'Analyzing...',
    alternativeAgents: [],
    confidence: 'medium',
    status: 'pending',
  };

  emit('delegation_decision', pendingDecision);

  try {
    // Call LLM for delegation decision
    const prompt = buildDelegationPrompt(command, contexts);
    const response = await callClaudeForDelegation(prompt);
    const parsed = parseDelegationResponse(response, contexts);

    // Build final decision
    const decision: DelegationDecision = {
      id: decisionId,
      timestamp: Date.now(),
      bossId,
      userCommand: command,
      selectedAgentId: parsed.selectedAgentId,
      selectedAgentName: parsed.selectedAgentName,
      reasoning: parsed.reasoning,
      alternativeAgents: parsed.alternativeAgents,
      confidence: parsed.confidence,
      status: 'sent',
    };

    // Store decision in history
    addDelegationDecision(delegationHistories, bossId, decision);
    saveDelegationHistory(delegationHistories);

    // Emit the decision
    emit('delegation_decision', decision);

    log.log?.(` Delegated to ${decision.selectedAgentName}: ${decision.reasoning}`);

    return decision;
  } catch (err) {
    log.error?.(' Delegation LLM failed, using fallback:', err);

    // Fallback: ALWAYS prioritize idle agents over busy ones
    const idleAgent = subordinates.find(s => s.status === 'idle') || subordinates[0];

    const fallbackDecision: DelegationDecision = {
      id: decisionId,
      timestamp: Date.now(),
      bossId,
      userCommand: command,
      selectedAgentId: idleAgent.id,
      selectedAgentName: idleAgent.name,
      reasoning: idleAgent.status === 'idle'
        ? 'Fallback selection: chose idle agent to balance workload'
        : 'Fallback selection: no idle agents available, chose first agent',
      alternativeAgents: subordinates.filter(s => s.id !== idleAgent.id).map(s => s.name),
      confidence: 'low',
      status: 'sent',
    };

    addDelegationDecision(delegationHistories, bossId, fallbackDecision);
    saveDelegationHistory(delegationHistories);
    emit('delegation_decision', fallbackDecision);

    return fallbackDecision;
  }
}

// ============================================================================
// LLM Integration
// ============================================================================

const DELEGATION_PROMPT = `You are a task router. Your ONLY job is to select which agent should handle the user's request.

IMPORTANT: You MUST respond with ONLY a JSON object. No explanations, no markdown, no other text.

## Available Agents
{{SUBORDINATES_DATA}}

## User Request
"{{USER_COMMAND}}"

## Selection Rules
1. **Strongly prefer idle agents** - If a capable idle agent exists, choose them. Do not select a working agent merely because they touched nearby code or have somewhat related context
2. Match agent class to task type (scout=explore, builder=code, debugger=fix, architect=plan, warrior=refactor, support=docs/tests)
3. **Do not over-prefer ultra-low context usage** - Treat agents under roughly 20% contextPercent as unusually cold for normal assignment and avoid choosing them unless there is a stronger reason such as a uniquely good class match, a very small task, or no better option. Treat roughly 20-60% as the healthy low-context range. An agent at 25% is not "really low" and should not be preferred on that basis alone. Avoid agents with >80% context usage entirely
4. Consider recent work context only as a secondary tiebreaker, mainly among idle capable agents
5. For general questions or status queries, pick any idle agent
6. Assume the delegating boss can include enough repo paths, summaries, constraints, and handoff notes for another capable idle agent to pick up the task quickly
7. Choose a working agent over an idle capable agent only when continuity is clearly critical and the interruption cost is justified

## Required Output Format (JSON only, no other text):
{"selectedAgentId":"<agent id>","selectedAgentName":"<agent name>","reasoning":"<why this agent>","alternativeAgents":[],"confidence":"medium"}`;

function buildDelegationPrompt(command: string, contexts: SubordinateContext[]): string {
  // Sanitize all string fields to prevent invalid Unicode surrogates
  const subordinatesData = contexts.map(ctx => ({
    id: ctx.id,
    name: sanitizeUnicode(ctx.name),
    class: ctx.class,
    status: ctx.status,
    currentTask: sanitizeUnicode(ctx.currentTask || 'None'),
    lastAssignedTask: ctx.lastAssignedTask ? sanitizeUnicode(truncateOrEmpty(ctx.lastAssignedTask, 200)) : 'None',
    contextPercent: ctx.contextPercent,
    tokensUsed: ctx.tokensUsed,
  }));

  return DELEGATION_PROMPT
    .replace('{{SUBORDINATES_DATA}}', JSON.stringify(subordinatesData, null, 2))
    .replace('{{USER_COMMAND}}', sanitizeUnicode(command));
}

async function callClaudeForDelegation(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    log.log?.(' Spawning Claude Code for delegation analysis...');

    const executable = claudeBackend.getExecutablePath();
    // Use --print mode with stream-json output - --verbose is required when using stream-json with --print
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];

    log.log?.(' Command:', executable, args.join(' '));

    const childProcess = spawn(executable, args, {
      env: {
        ...process.env,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      shell: true,
    });

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let textOutput = '';

    childProcess.stdout?.on('data', (data: Buffer) => {
      buffer += decoder.write(data);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        log.log?.(' [delegation stdout line]:', line.substring(0, 200));
        try {
          const event = JSON.parse(line);
          // Handle assistant event with full message content
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                log.log?.(' [delegation] Got assistant text:', block.text.substring(0, 100));
                textOutput += block.text;
              }
            }
          }
          // Handle streaming text delta events
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
            if (event.event.delta?.type === 'text_delta' && event.event.delta.text) {
              textOutput += event.event.delta.text;
            }
          }
          // Also capture result text as fallback
          if (event.type === 'result' && event.result && typeof event.result === 'string') {
            log.log?.(' [delegation] Got result with text:', event.result.substring(0, 100));
            // Only use result if we didn't get text from assistant event
            if (!textOutput) {
              textOutput = event.result;
            }
          }
        } catch {
          // Not JSON - could be raw text output
          log.log?.(' [delegation] Non-JSON line:', line.substring(0, 100));
        }
      }
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      const text = decoder.write(data);
      log.log?.(' [delegation stderr]:', text.substring(0, 200));
    });

    childProcess.on('close', (code) => {
      log.log?.(' [delegation] Process closed with code:', code);
      log.log?.(' [delegation] textOutput so far:', textOutput.substring(0, 200));

      const remaining = buffer + decoder.end();
      if (remaining.trim()) {
        log.log?.(' [delegation] Processing remaining buffer:', remaining.substring(0, 200));
        try {
          const event = JSON.parse(remaining);
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                textOutput += block.text;
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      log.log?.(' [delegation] Final textOutput length:', textOutput.length);

      if (code !== 0 && textOutput.length === 0) {
        reject(new Error(`Claude Code exited with code ${code}`));
      } else if (!textOutput) {
        reject(new Error('No response from Claude Code'));
      } else {
        resolve(textOutput);
      }
    });

    childProcess.on('error', (err) => {
      log.error?.(' [delegation] Process error:', err);
      reject(err);
    });

    childProcess.on('spawn', () => {
      log.log?.(' [delegation] Process spawned, sending prompt...');
      // Sanitize prompt to remove invalid Unicode surrogates that break JSON
      const sanitizedPrompt = sanitizeUnicode(prompt);
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: sanitizedPrompt,
        },
      });
      log.log?.(' [delegation] stdin message:', stdinMessage.substring(0, 200));
      childProcess.stdin?.write(stdinMessage + '\n');
      childProcess.stdin?.end();
      log.log?.(' [delegation] stdin closed');
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (!childProcess.killed) {
        log.log?.(' [delegation] Timeout - killing process');
        childProcess.kill('SIGTERM');
        reject(new Error('Claude Code timed out'));
      }
    }, 60000);
  });
}

interface ParsedDelegation {
  selectedAgentId: string;
  selectedAgentName: string;
  reasoning: string;
  alternativeAgents: string[];
  confidence: 'high' | 'medium' | 'low';
}

function parseDelegationResponse(
  response: string,
  contexts: SubordinateContext[]
): ParsedDelegation {
  try {
    let jsonStr = response.trim();

    // Remove markdown fences if present
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    // Try to extract JSON object from response if it contains extra text
    const jsonMatch = jsonStr.match(/\{[\s\S]*"selectedAgentId"[\s\S]*"selectedAgentName"[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    log.log?.(' [delegation] Attempting to parse JSON:', jsonStr.substring(0, 200));

    const parsed = JSON.parse(jsonStr);

    // Validate the selected agent exists
    const selectedAgent = contexts.find(
      ctx => ctx.id === parsed.selectedAgentId || ctx.name === parsed.selectedAgentName
    );

    if (!selectedAgent) {
      throw new Error('Selected agent not found in subordinates');
    }

    return {
      selectedAgentId: selectedAgent.id,
      selectedAgentName: selectedAgent.name,
      reasoning: parsed.reasoning || 'No reasoning provided',
      alternativeAgents: parsed.alternativeAgents || [],
      confidence: parsed.confidence || 'medium',
    };
  } catch (err) {
    log.error?.(' Failed to parse delegation response:', err);
    throw err;
  }
}

// ============================================================================
// History Management
// ============================================================================

/**
 * Get delegation history for a boss
 */
export function getDelegationHistory(bossId: string): DelegationDecision[] {
  return getHistoryFromStorage(delegationHistories, bossId);
}

/**
 * Delete delegation history for a boss (when boss is deleted)
 */
export function deleteBossHistory(bossId: string): void {
  deleteDelegationHistory(delegationHistories, bossId);
  saveDelegationHistory(delegationHistories);
  log.log?.(` Deleted delegation history for boss ${bossId}`);
}

/**
 * Add a delegation decision to history (used when boss includes delegation in response)
 */
export function addDelegationToHistory(bossId: string, decision: DelegationDecision): void {
  addDelegationDecision(delegationHistories, bossId, decision);
  saveDelegationHistory(delegationHistories);
  log.log?.(` Added delegation decision for boss ${bossId}: ${decision.selectedAgentName}`);
}

// ─── ⑦ 任务卡状态机（改造点⑦，Spec §4.7） ───

export interface TaskCardStatusUpdateOptions {
  /** 迁移时刻（缺省 Date.now；回填/测试可显式传） */
  at?: number;
  /** 终态结果（完成入口写入），供 ⑧ 病历区分 */
  result?: 'completed' | 'failed';
  /** 触发原因：delegated / dispatched / turn-complete / report-task 等 */
  reason?: string;
  subordinateId?: string;
  /** 显式 taskId（跨进程/跨模块处由调用方透传，缺省不落） */
  taskId?: string;
}

/**
 * ⑦ 任务卡状态机迁移：按 decisionId 定位委派史记录，迁移 taskCard.status → 落盘 + 🔴⑦ 埋点。
 * - 无卡（旧记录/纯文本委派）返回 undefined：不写盘、不埋点，保持旧行为；
 * - 非法迁移（含同态重复）告警并跳过，守卫乱序回执（如 done 后又来 running）；
 * - taskId 仅在服务端进程内可达（任务 02 登记限制），跨进程事件不携带。
 */
export function updateDelegationTaskCardStatus(
  bossId: string,
  decisionId: string,
  status: TaskCardStatus,
  opts: TaskCardStatusUpdateOptions = {}
): TaskCard | undefined {
  const decision = delegationHistories.get(bossId)?.find((d) => d.id === decisionId);
  const card = decision?.taskCard;
  if (!decision || !card) return undefined;

  const from = card.status;
  if (!canTransitionTaskCard(from, status)) {
    log.warn?.(` Ignored task card transition ${from} -> ${status} for decision ${decisionId}`);
    return undefined;
  }

  const at = opts.at ?? Date.now();
  card.status = status;
  card.statusUpdatedAt = at;
  saveDelegationHistory(delegationHistories);

  // 🔴 决策观测点⑦：状态机迁移 + 时间（Spec §4.14 决策观测点）
  logTaskCardStatus({
    decisionId,
    from,
    to: status,
    at,
    bossId,
    subordinateId: opts.subordinateId,
    projectId: card.projectId,
    sourceProject: card.sourceProject,
    result: opts.result,
    reason: opts.reason,
    taskId: opts.taskId,
  });

  return card;
}

// ─── ⑧ 病历：完成事件 + 用户评价（改造点⑧，Spec §4.8，任务11） ───

/**
 * 🟡 决策观测点⑧ 病历追加（Spec §4.14 P2 项；任务11 预留通道，随 ⑭P2 启用）：
 * 与 🔴⑦ logTaskCardStatus 同形态 —— delegation 通道 + 独立 phase + taskId 列。
 * helper 落点在本模块（本地小函数直调 logEvent，纯加法）：activity-log.ts 不在
 * 任务11 允许触碰清单内，避免越界；事件字段与此前埋点风格保持一致。
 */
function logDelegationRecord(
  phase: 'completion-recorded' | 'rating-recorded',
  refs: { decisionId: string; bossId: string; subordinateId?: string; taskId?: string },
  body: Record<string, unknown>
): void {
  logEvent('delegation', {
    source: 'boss',
    taskId: refs.taskId,
    agentId: refs.subordinateId ?? refs.bossId,
    body: {
      cat: 'delegation',
      phase,
      decisionId: refs.decisionId,
      bossId: refs.bossId,
      subordinateId: refs.subordinateId,
      ...body,
    },
  });
}

export interface DelegationCompletionUpdateOptions {
  /** 完成时刻（缺省 Date.now；回填/测试可显式传） */
  at?: number;
  /** 终态结果（缺省 completed） */
  result?: 'completed' | 'failed';
  /** 产出摘要（report-task 入口的 req.body.summary；空白按「未提供」处理） */
  summary?: string;
  /** 产出位置（report-task 入口回传；任务17·A3 接通） */
  outputLocation?: string;
  /** 验收打勾（report-task 入口回传；任务17·A3 接通；空数组按「未提供」处理） */
  acceptance?: Array<{ item: string; done: boolean }>;
  /** 触发原因：report-task / turn-complete 等 */
  reason?: string;
  subordinateId?: string;
  /** 显式 taskId（跨进程/跨模块处由调用方透传，缺省不落） */
  taskId?: string;
}

/** 非空白字符串才视为已提供（空白摘要/位置按「未提供」落缺省）。 */
function nonBlank(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * ⑧ 病历写回：按 decisionId 定位委派史记录，固化 completion（完成时刻/耗时/结果/摘要/位置/原因）
 * + status 迁移（'sent'/'pending' → 'completed'/'failed'）→ 落盘 + 🟡⑧ 埋点。
 * - 幂等（主脑口径）：已有 completion 的记录不双写不覆盖，直接返回（第二次到达/重复入口稳定 no-op）；
 * - 无此记录（未知 decisionId / 已被 MAX_DELEGATION_HISTORY_PER_BOSS 裁剪）→ 返回 undefined，不写盘；
 * - 耗时 = at − decision.timestamp（时钟回拨的负值钳为 0）。
 */
export function recordDelegationCompletion(
  bossId: string,
  decisionId: string,
  opts: DelegationCompletionUpdateOptions = {}
): DelegationDecision | undefined {
  const decision = delegationHistories.get(bossId)?.find((d) => d.id === decisionId);
  if (!decision) {
    log.warn?.(` Ignored completion record for unknown decision ${decisionId}`);
    return undefined;
  }
  if (decision.completion) return decision;

  const at = opts.at ?? Date.now();
  const result = opts.result ?? 'completed';
  const summary = nonBlank(opts.summary);
  const outputLocation = nonBlank(opts.outputLocation);
  const acceptance =
    Array.isArray(opts.acceptance) && opts.acceptance.length > 0 ? opts.acceptance : undefined;

  decision.completion = {
    completedAt: at,
    durationMs: Math.max(0, at - decision.timestamp),
    result,
    ...(summary ? { summary } : {}),
    ...(outputLocation ? { outputLocation } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
  // ⑧ 状态迁移：现状永远停在 'sent'（本任务补齐）；重复入口在上方幂等分支已挡住
  decision.status = result;
  saveDelegationHistory(delegationHistories);

  logDelegationRecord('completion-recorded', {
    decisionId,
    bossId,
    subordinateId: opts.subordinateId,
    taskId: opts.taskId,
  }, {
    at,
    durationMs: decision.completion.durationMs,
    result,
    reason: opts.reason,
    hasSummary: summary !== undefined,
    hasOutputLocation: outputLocation !== undefined,
  });

  return decision;
}

export interface DelegationRatingUpdateOptions {
  /** 评价时刻（缺省 Date.now；回填/测试可显式传） */
  at?: number;
  subordinateId?: string;
  taskId?: string;
}

/**
 * ⑧ 病历评价回写 API：满意/不满意 → 按 decisionId 写回 userRating/ratedAt → 落盘 + 🟡⑧ 埋点。
 * - 自然语言入口延后（主脑裁决：需动契约表，与任务16 同批）；
 * - 重复评价允许覆盖（用户改主意以最后一次为准，语义与完成事件的「不覆盖」幂等不同）；
 * - 未知 decisionId → 返回 undefined，不写盘。
 */
export function rateDelegationCompletion(
  bossId: string,
  decisionId: string,
  rating: DelegationUserRating,
  opts: DelegationRatingUpdateOptions = {}
): DelegationDecision | undefined {
  const decision = delegationHistories.get(bossId)?.find((d) => d.id === decisionId);
  if (!decision) {
    log.warn?.(` Ignored rating for unknown decision ${decisionId}`);
    return undefined;
  }

  const at = opts.at ?? Date.now();
  decision.userRating = rating;
  decision.ratedAt = at;
  saveDelegationHistory(delegationHistories);

  logDelegationRecord('rating-recorded', {
    decisionId,
    bossId,
    subordinateId: opts.subordinateId ?? decision.selectedAgentId,
    taskId: opts.taskId,
  }, { at, rating });

  return decision;
}

// ============================================================================
// Utilities
// ============================================================================
