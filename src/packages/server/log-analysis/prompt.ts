/**
 * 只读日志分析 agent 定义（⑮ P1，Spec §4.15 行为定义 1）
 *
 * 边界红线（写死在提示词里，并由调用侧结构保证）：
 *   - 只读 EventDB（system_log / audit_log）+ server.log；不执行、不改配置；
 *   - 属秘书自留区（只读查询类，类似 list_agents/query）：不走 ① 委派通道、不计 ⑫ 配额；
 *   - 只依据注入的数据作答，禁止编造 log 行号 —— 编造会在代码层被证据规则丢弃；
 *   - 只建议不自动改：任何配置变更仍需老板拍板。
 *
 * 输出契约与四段报告一致：anomalies / bottlenecks / resources / recommendations，
 * 建议逐条携带 evidence:[{logId}]（Spec §4.15 硬规则）。
 */

import type { AuditLogEntry } from '../../shared/event-types.js';
import type { SystemLogEntry } from '../data/system-log.js';
import type { LogStats, LogWindow } from './types.js';
import type { ServerLogLine } from './collect.js';

/** 自留区 agent 标识（后续接线尾在自留区查询入口登记用）。 */
export const LOG_ANALYSIS_AGENT_ID = 'log-analyst';
export const LOG_ANALYSIS_AGENT_NAME = '日志分析智能体';

export const LOG_ANALYSIS_SYSTEM_PROMPT = `你是 Tide Commander 的「只读日志分析智能体」（改造点⑮，P1 手动查日志）。

## 身份与边界（红线，不可越过）
- 你只读 system_log / audit_log 与 server.log 三类日志；数据由调用方注入，你没有也不需要工具。
- 不执行任何命令、不修改任何配置与文件、不发起委派、不占用并发配额；你只输出分析报告。
- 只依据注入的数据作答：不得编造事件、时间戳、行号或数字。引用不存在的日志行 id 会被代码层直接丢弃。
- 报告语言与老板一致（默认中文）；只建议不自动改，任何调整都必须由老板拍板。

## 输出契约（只输出一个 JSON 对象，不要 markdown、不要解释文字）
{
  "anomalies":     [ {"title": "...", "detail": "...", "severity": "high|medium|low", "evidence": [{"logId": 123, "field": "body.error"}]} ],
  "bottlenecks":   [ {"title": "...", "detail": "...", "severity": "high|medium|low", "evidence": [{"logId": 123}]} ],
  "resources":     [ {"title": "...", "detail": "...", "severity": "low", "evidence": [{"logId": 123}]} ],
  "recommendations":[ {"title": "...", "action": "可拍板动作", "target": "§8.2 参数名(当前值)", "priority": "high|medium|low", "expectedEffect": "...", "evidence": [{"logId": 123, "field": "body.decision.score"}]} ]
}

## 四段定义
1. anomalies 异常：失败模式、error/crash、degraded 降级、撤回/回执未确认（delegation phase=failed/blocked、dialog degraded=true）。
2. bottlenecks 瓶颈：播报拒绝/降级偏多是否阈值过严、消歧反问多、查询链路 hop 长/耗时高（以 body.durationMs 统计为准）。
3. resources 资源：token 用量、费用、上下文占用、排队/并发（以统计摘要为准，不臆造）。
4. recommendations 优化建议：逐条可拍板；target 尽量对齐 Spec §8.2 标定参数名（相关性阈值 60 / 打扰度阈值 70 / 深夜破例阈值 90 / 日志采样率 1:10 / 并发配额 N / 上下文压缩阈值 80% / 记忆卡衰减 30 天 / 重试退避），并写明当前值。

## 证据硬规则（代码强制执行，不是口头要求）
- recommendations 的每一条必须带 evidence，且每个 logId 必须来自下面注入的 system_log 行（#id 即 logId）。
- 无 evidence、或所有 logId 都不存在的建议，会被代码层整条丢弃并在报告中记录丢弃原因。
- anomalies / bottlenecks / resources 也尽量带 evidence，便于老板核对；无证据的条目可保留，但不要编造 id。
- 每条建议只引用能直接支撑它的记录（通常 1-3 条），不要堆砌无关 id。`;

// ─── 注入内容构建 ───

export interface PromptInputBudget {
  maxSystemRows?: number;
  maxAuditRows?: number;
  maxSystemChars?: number;
  maxAuditChars?: number;
  maxServerLogChars?: number;
  bodyChars?: number;
}

const DEFAULTS: Required<PromptInputBudget> = {
  maxSystemRows: 400,
  maxAuditRows: 120,
  maxSystemChars: 60_000,
  maxAuditChars: 20_000,
  maxServerLogChars: 30_000,
  bodyChars: 400,
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * 选取注入 prompt 的 system_log 行：warn/error 优先，其余按新近补齐，最后按原时间顺序排列。
 * 总量受行数与字符双重约束（先到先限）。
 */
export function selectPromptSystemRows(rows: SystemLogEntry[], budget: PromptInputBudget = {}): SystemLogEntry[] {
  const { maxSystemRows, maxSystemChars } = { ...DEFAULTS, ...budget };
  const severe = rows.filter(r => r.level === 'warn' || r.level === 'error');
  const rest = rows.filter(r => r.level !== 'warn' && r.level !== 'error');
  const ordered: SystemLogEntry[] = [...severe];
  for (let i = rest.length - 1; i >= 0 && ordered.length < maxSystemRows; i -= 1) ordered.push(rest[i]);
  const selected = ordered.slice(0, maxSystemRows).sort((a, b) => (a.ts - b.ts) || ((a.id ?? 0) - (b.id ?? 0)));

  const out: SystemLogEntry[] = [];
  let chars = 0;
  for (const row of selected) {
    chars += (row.body?.length ?? 0) + 80;
    if (chars > maxSystemChars && out.length > 0) break;
    out.push(row);
  }
  return out;
}

function formatSystemRow(row: SystemLogEntry, bodyChars: number): string {
  const ctx: string[] = [];
  if (row.agentId) ctx.push(`agent=${row.agentId}`);
  if (row.projectId) ctx.push(`project=${row.projectId}`);
  if (row.sessionId) ctx.push(`session=${row.sessionId}`);
  if (row.taskId) ctx.push(`task=${row.taskId}`);
  return `#${row.id} ts=${iso(row.ts)} cat=${row.category} lvl=${row.level} src=${row.source ?? '-'}${ctx.length ? ` ${ctx.join(' ')}` : ''} body=${truncate(row.body ?? '', bodyChars)}`;
}

function formatAuditRow(entry: AuditLogEntry, bodyChars: number): string {
  let details = '';
  if (entry.details !== undefined) {
    try {
      details = truncate(JSON.stringify(entry.details), bodyChars);
    } catch {
      details = '[unserializable]';
    }
  }
  return `#${entry.id} ts=${iso(entry.createdAt)} cat=${entry.category} action=${entry.action} lvl=${entry.level}${entry.agentId ? ` agent=${entry.agentId}` : ''} details=${details}`;
}

export interface BuildUserContentInput {
  window: LogWindow;
  systemLog: SystemLogEntry[];
  auditLog: AuditLogEntry[];
  serverLogLines: ServerLogLine[];
  stats: LogStats;
  budget?: PromptInputBudget;
  /** 数据源降级说明，一并注入让模型知晓数据边界 */
  warnings?: string[];
}

/** 构建注入给只读 agent 的 user 内容（统计摘要 + 三源样本 + 输出提醒）。 */
export function buildLogAnalysisUserContent(input: BuildUserContentInput): string {
  const budget = { ...DEFAULTS, ...input.budget };
  const parts: string[] = [];

  parts.push(`【分析时间窗】${input.window.label ?? ''}（epoch ms: ${input.window.from} ~ ${input.window.to}）`);
  if (input.warnings && input.warnings.length > 0) {
    parts.push(`【数据源降级说明】\n${input.warnings.map(w => `- ${w}`).join('\n')}`);
  }

  parts.push(
    `【统计摘要（代码生成，可信）】\n` +
      `system_log 行数=${input.stats.total}；error=${input.stats.errorRows} warn=${input.stats.warnRows}；` +
      `按 category=${JSON.stringify(input.stats.byCategory)}；按 level=${JSON.stringify(input.stats.byLevel)}\n` +
      `资源：回合=${input.stats.resource.turns} tokens(in/out/total)=${input.stats.resource.tokensInput}/${input.stats.resource.tokensOutput}/${input.stats.resource.tokensTotal} costUsd=${input.stats.resource.costUsd} models=${JSON.stringify(input.stats.resource.models)}\n` +
      `耗时分布=${input.stats.durationMs ? JSON.stringify(input.stats.durationMs) : '无样本'}；` +
      `server.log ERROR=${input.stats.serverLogErrors} WARN=${input.stats.serverLogWarns}`
  );

  const sysRows = selectPromptSystemRows(input.systemLog, budget);
  parts.push(
    `【system_log 记录（#id 可作为 evidence.logId；共 ${input.systemLog.length} 行，注入 ${sysRows.length} 行）】\n` +
      (sysRows.length > 0 ? sysRows.map(r => formatSystemRow(r, budget.bodyChars)).join('\n') : '(空)')
  );

  const auditRows = input.auditLog.slice(0, budget.maxAuditRows);
  parts.push(
    `【audit_log 记录（共 ${input.auditLog.length} 行，注入 ${auditRows.length} 行）】\n` +
      (auditRows.length > 0 ? auditRows.map(e => formatAuditRow(e, budget.bodyChars)).join('\n') : '(空)')
  );

  let serverChunk = input.serverLogLines.map(l => `L${l.line} ${l.level.toUpperCase()} ${truncate(l.text, budget.bodyChars)}`).join('\n');
  serverChunk = truncate(serverChunk, budget.maxServerLogChars);
  parts.push(
    `【server.log 摘录（共 ${input.serverLogLines.length} 行）】\n` + (serverChunk || '(空)')
  );

  parts.push('请按输出契约仅输出一个 JSON 对象：anomalies / bottlenecks / resources / recommendations，建议逐条带 evidence:[{logId}]。');
  return parts.join('\n\n');
}
