/**
 * activity-log 埋点门面单测（⑭ 日志地基②，任务 02）
 *
 * 覆盖：基础四类（dialog/broadcast/delegation）字段形态与 taskId 贯穿、
 * 系统活动 1-4（voice/memory/security/resource）落盘字段、采样默认值、
 * 费用估算价格表。数据目录由 test-setup.ts 重定向到临时目录，不触碰真实 events.db。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeEventDb, initEventDb } from '../data/event-db.js';
import { countSystemLog, querySystemLog, resetSystemLogStateForTests } from '../data/system-log.js';
import { ensureTaskId, runWithTrace } from '../utils/trace-context.js';
import {
  ACTIVITY_SOURCE,
  ESTIMATED_PRICE_PER_MTOKENS,
  estimateCostUsd,
  logBroadcast,
  logDelegation,
  logDialogMessage,
  logMemoryOps,
  logResourceUsage,
  logSecurity,
  logVoiceAsr,
  logVoiceTts,
  previewToolInput,
} from './activity-log.js';

beforeAll(() => {
  initEventDb();
});

afterAll(() => {
  closeEventDb();
});

function bodyOf(row: { body?: string }): Record<string, unknown> {
  return JSON.parse(row.body ?? '{}');
}

describe('基础四类：dialog / broadcast / delegation', () => {
  it('一次语音回合的四类行共享 taskId，可按 taskId 串时间线', () => {
    const taskId = runWithTrace({ sessionId: 'sess-al-chain' }, () => {
      const tid = ensureTaskId();
      logDialogMessage({ direction: 'in', text: '帮我看下构建为什么挂了', taskId: tid });
      logDialogMessage({ direction: 'out', text: '好的，我让 a1 去看看。', action: 'send_to_agent', targetAgentId: 'a1' });
      logDelegation({
        phase: 'dispatched', channel: 'voice-companion', toAgentId: 'a1', toAgentName: '小美',
        message: '查构建失败原因', delivery: 'queue', taskId: tid,
      });
      logBroadcast({ text: '好的，我让 a1 去看看。', phase: 'server-sent', action: 'send_to_agent', taskId: tid });
      return tid;
    });

    const rows = querySystemLog({ taskId, order: 'asc' });
    expect(rows.map(r => r.category)).toEqual(['dialog', 'dialog', 'delegation', 'broadcast']);
    // in/out 与 delegation/broadcast 均继承链路 sessionId
    expect(rows.every(r => r.sessionId === 'sess-al-chain')).toBe(true);
    expect(rows[0].source).toBe(ACTIVITY_SOURCE.dialog);
    expect(rows[2].source).toBe('voice-companion');
    expect(rows[3].source).toBe(ACTIVITY_SOURCE.broadcast);
  });

  it('dialog in 标记 isEvent（主动汇报），out 带 action/degraded/targetAgentId', () => {
    logDialogMessage({
      direction: 'in', text: '[系统事件] a1 任务完成', isEvent: true, sessionId: 'sess-al-dlg',
    });
    logDialogMessage({
      direction: 'out', text: '兜底话术', action: 'general_response', degraded: true, sessionId: 'sess-al-dlg',
    });

    const rows = querySystemLog({ sessionId: 'sess-al-dlg', order: 'asc' });
    expect(rows).toHaveLength(2);
    expect(bodyOf(rows[0])).toMatchObject({
      cat: 'dialog', direction: 'in', text: '[系统事件] a1 任务完成', isEvent: true, channel: 'voice-companion',
    });
    expect(rows[1].level).toBe('warn'); // degraded 回合按 warn 全量落盘
    expect(bodyOf(rows[1])).toMatchObject({
      direction: 'out', action: 'general_response', degraded: true,
    });
  });

  it('delegation 失败行：channel 与成功行一致，含 status/error', () => {
    logDelegation({
      phase: 'failed', channel: 'api', toAgentId: 'a9', toAgentName: '老王',
      message: '部署生产', status: 'failed', error: 'sendCommand timeout', taskId: 'task-al-fail',
    });
    const [row] = querySystemLog({ taskId: 'task-al-fail' });
    expect(row.category).toBe('delegation');
    expect(row.source).toBe('api');
    expect(bodyOf(row)).toMatchObject({
      cat: 'delegation', phase: 'failed', channel: 'api', toAgentId: 'a9',
      toAgentName: '老王', status: 'failed', error: 'sendCommand timeout',
    });
  });

  it('delegation 显式 taskId 跨进程可用；source 承载渠道', () => {
    logDelegation({
      phase: 'reported', channel: 'subordinate', taskId: 'task-al-explicit',
      fromAgentId: 'sub-1', fromName: '小美', toAgentId: 'boss-1', toAgentName: 'Boss',
      message: '已修复构建', status: 'completed', forwarded: true,
    });
    const [row] = querySystemLog({ taskId: 'task-al-explicit' });
    expect(row.category).toBe('delegation');
    expect(row.source).toBe('subordinate');
    expect(bodyOf(row)).toMatchObject({
      cat: 'delegation', phase: 'reported', channel: 'subordinate',
      fromAgentId: 'sub-1', toAgentId: 'boss-1', status: 'completed', forwarded: true,
    });
  });
});

describe('系统活动 1：语音（ASR / TTS）', () => {
  it('logVoiceAsr 成功 info 全量、失败 warn，落文本与耗时', () => {
    resetSystemLogStateForTests();
    logVoiceAsr({
      channel: 'whisper', text: '你好呀', durationMs: 123, cached: false,
      audioFile: 'a.webm', model: 'turbo', sessionId: 'sess-al-asr',
    });
    logVoiceAsr({
      channel: 'volcengine-stream', text: '', ok: false, error: 'asr_error',
      durationMs: 5, sessionId: 'sess-al-asr',
    });

    const rows = querySystemLog({ sessionId: 'sess-al-asr', order: 'asc' });
    expect(rows).toHaveLength(2);
    expect(rows[0].category).toBe('system');
    expect(rows[0].source).toBe(ACTIVITY_SOURCE.voice);
    expect(rows[0].level).toBe('info');
    expect(bodyOf(rows[0])).toMatchObject({
      cat: 'voice', sub: 'asr', channel: 'whisper', text: '你好呀', durationMs: 123, ok: true, audioFile: 'a.webm',
    });
    expect(rows[1].level).toBe('warn');
    expect(bodyOf(rows[1])).toMatchObject({ sub: 'asr', channel: 'volcengine-stream', ok: false, error: 'asr_error' });
  });

  it('logVoiceTts 落文本长度/合成耗时/音频字节', () => {
    logVoiceTts({ voice: 'zh_CN-huayan-medium', textChars: 42, durationMs: 800, audioBytes: 2048, sessionId: 'sess-al-tts' });
    const [row] = querySystemLog({ sessionId: 'sess-al-tts' });
    expect(row.source).toBe(ACTIVITY_SOURCE.voice);
    expect(bodyOf(row)).toMatchObject({
      cat: 'voice', sub: 'tts', voice: 'zh_CN-huayan-medium', textChars: 42, durationMs: 800, audioBytes: 2048, ok: true,
    });
  });
});

describe('系统活动 2：记忆操作', () => {
  it('logMemoryOps 落 applied/ops 明细/裁剪 droppedTotal', () => {
    logMemoryOps({
      applied: 1,
      details: [
        { op: 'add', applied: true, droppedCount: 2 },
        { op: 'remove', applied: false },
      ],
      notesTotal: 40,
      droppedTotal: 5,
      channel: 'voice',
      sessionId: 'sess-al-mem',
    });
    const [row] = querySystemLog({ sessionId: 'sess-al-mem' });
    expect(row.source).toBe(ACTIVITY_SOURCE.memory);
    expect(bodyOf(row)).toMatchObject({
      cat: 'memory', channel: 'voice', applied: 1, notesTotal: 40, droppedTotal: 5,
      ops: [
        { op: 'add', applied: true, droppedCount: 2 },
        { op: 'remove', applied: false },
      ],
    });
  });
});

describe('系统活动 3：权限与安全', () => {
  it('request/approved info，timeout 默认 warn', () => {
    resetSystemLogStateForTests();
    logSecurity({
      phase: 'request', agentId: 'ag-sec', requestId: 'r1', tool: 'Bash',
      toolInputPreview: previewToolInput({ command: 'rm -rf build' }), sessionId: 'sess-al-sec',
    });
    logSecurity({ phase: 'approved', agentId: 'ag-sec', requestId: 'r1', tool: 'Bash', remember: true, sessionId: 'sess-al-sec' });
    logSecurity({ phase: 'timeout', agentId: 'ag-sec', requestId: 'r2', tool: 'Write', sessionId: 'sess-al-sec' });

    const rows = querySystemLog({ sessionId: 'sess-al-sec', order: 'asc' });
    expect(rows.map(r => r.level)).toEqual(['info', 'info', 'warn']);
    expect(rows[0].source).toBe(ACTIVITY_SOURCE.security);
    expect(bodyOf(rows[0])).toMatchObject({ cat: 'security', phase: 'request', tool: 'Bash' });
    expect(bodyOf(rows[1])).toMatchObject({ phase: 'approved', remember: true });
    expect(bodyOf(rows[2])).toMatchObject({ phase: 'timeout' });
  });

  it('bypass 工具调用为采样通道（1:10）', () => {
    resetSystemLogStateForTests();
    for (let i = 0; i < 10; i++) {
      logSecurity({ phase: 'bypass-tool-call', agentId: 'ag-sec', tool: 'Read', sampled: true, sessionId: 'sess-al-sec-bypass' });
    }
    expect(countSystemLog({ sessionId: 'sess-al-sec-bypass' })).toBe(1);
  });
});

describe('系统活动 4：资源与费用', () => {
  it('真实 cost 优先；缺失按价格表估算；无 tokens 标 unavailable', () => {
    resetSystemLogStateForTests();
    logResourceUsage({
      agentId: 'ag-res', provider: 'claude', model: 'claude-opus-5-5',
      tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
      costUsd: 0.042, durationMs: 900, contextPercent: 12.5, sessionId: 'sess-al-res',
    });
    logResourceUsage({
      agentId: 'ag-res', model: 'claude-sonnet-4',
      tokens: { input: 1_000_000, output: 0 }, sessionId: 'sess-al-res', sampled: false,
    });
    logResourceUsage({ agentId: 'ag-res', model: 'mystery-model', sessionId: 'sess-al-res', sampled: false });

    const rows = querySystemLog({ sessionId: 'sess-al-res', order: 'asc' });
    expect(rows).toHaveLength(3);
    expect(rows[0].source).toBe(ACTIVITY_SOURCE.resource);
    const b0 = bodyOf(rows[0]);
    expect(b0).toMatchObject({ cat: 'resource', sub: 'turn', costSource: 'provider', tokensTotal: 1500, durationMs: 900 });
    expect(b0.costUsd).toBeCloseTo(0.042);

    const b1 = bodyOf(rows[1]);
    expect(b1).toMatchObject({ costSource: 'estimated' });
    expect(b1.costUsd).toBeCloseTo(3); // sonnet 输入 3 USD/1M

    const b2 = bodyOf(rows[2]);
    expect(b2).toMatchObject({ costSource: 'unavailable' });
    expect(b2.costUsd).toBeUndefined();
  });

  it('context 子类默认采样（未显式 sampled 时）', () => {
    resetSystemLogStateForTests();
    for (let i = 0; i < 10; i++) {
      logResourceUsage({ agentId: 'ag-ctx', sub: 'context', contextPercent: 1, sessionId: 'sess-al-ctx' });
    }
    expect(countSystemLog({ sessionId: 'sess-al-ctx' })).toBe(1);
  });
});

describe('estimateCostUsd 价格表', () => {
  it('按模型族命中，未知模型回退 default；无 tokens 返回 undefined', () => {
    expect(estimateCostUsd('claude-opus-5-5', { input: 1e6, output: 0 })).toBeCloseTo(15);
    expect(estimateCostUsd('claude-haiku-4-5', { input: 0, output: 1e6 })).toBeCloseTo(4);
    expect(estimateCostUsd('mystery-model', { input: 1e6, output: 0 })).toBeCloseTo(ESTIMATED_PRICE_PER_MTOKENS.default.input);
    expect(estimateCostUsd('claude-sonnet-4', undefined)).toBeUndefined();
  });

  it('缓存读/写分别计价', () => {
    const cost = estimateCostUsd('sonnet', { input: 0, output: 0, cacheRead: 1e6, cacheCreation: 1e6 });
    expect(cost).toBeCloseTo(0.3 + 3.75);
  });
});

describe('previewToolInput', () => {
  it('超长截断 300 字符；不可序列化返回 undefined', () => {
    expect(previewToolInput({ a: 'x'.repeat(500) })).toHaveLength(300);
    expect(previewToolInput(undefined)).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(previewToolInput(circular)).toBeUndefined();
  });
});
