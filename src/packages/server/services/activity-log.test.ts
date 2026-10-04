/**
 * activity-log 埋点门面单测（⑭ 日志地基②，任务 02）
 *
 * 覆盖：基础四类（dialog/broadcast/delegation）字段形态与 taskId 贯穿、
 * 系统活动 1-4（voice/memory/security/resource）落盘字段、采样默认值、
 * 费用估算价格表。数据目录由 test-setup.ts 重定向到临时目录，不触碰真实 events.db。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 探针包装真实 logEvent（默认委托真实实现，既有用例零影响）：
// 任务19·A 用它注入一次性抛错，验证四个新 helper 的失败隔离。
vi.mock('../data/system-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/system-log.js')>();
  return { ...actual, logEvent: vi.fn(actual.logEvent) };
});

import { closeEventDb, initEventDb } from '../data/event-db.js';
import { countSystemLog, logEvent, querySystemLog, resetSystemLogStateForTests } from '../data/system-log.js';
import { ensureTaskId, runWithTrace } from '../utils/trace-context.js';
import {
  ACTIVITY_SOURCE,
  ESTIMATED_PRICE_PER_MTOKENS,
  estimateCostUsd,
  logBroadcast,
  logConfig,
  logDelegation,
  logDialogMessage,
  logMemoryOps,
  logProcess,
  logResourceUsage,
  logSecurity,
  logSession,
  logSkill,
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

// ════════════════════════════════════════════════════════════════════════════
// 任务19·A（⑭ P2）：系统活动 5-8（session / process / config / skill）
// ════════════════════════════════════════════════════════════════════════════

describe('系统活动 5：会话生命周期（任务19·A）', () => {
  it('created/rotated/resume-rejected/cleared 落 source=session；拒绝/清除默认 warn', () => {
    resetSystemLogStateForTests();
    logSession({ phase: 'created', agentId: 'ag-sess-log', sessionId: 's-sess-1' });
    logSession({
      phase: 'rotated', agentId: 'ag-sess-log', sessionId: 's-sess-2',
      previousSessionId: 's-sess-1', reason: 'session-max-age',
    });
    logSession({
      phase: 'resume-rejected', agentId: 'ag-sess-log', sessionId: 's-sess-2', error: 'resume_failed',
    });
    logSession({
      phase: 'cleared', agentId: 'ag-sess-log', sessionId: 's-sess-2',
      reason: 'unresumable-after-restarts', retry: 'failed',
    });

    const rows = querySystemLog({ agentId: 'ag-sess-log', order: 'asc' });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.category === 'system' && r.source === ACTIVITY_SOURCE.session)).toBe(true);
    expect(rows.map((r) => r.level)).toEqual(['info', 'info', 'warn', 'warn']);
    expect(bodyOf(rows[0])).toMatchObject({ cat: 'session', phase: 'created' });
    expect(bodyOf(rows[1])).toMatchObject({ phase: 'rotated', previousSessionId: 's-sess-1', reason: 'session-max-age' });
    expect(bodyOf(rows[2])).toMatchObject({ phase: 'resume-rejected', error: 'resume_failed' });
    expect(bodyOf(rows[3])).toMatchObject({ phase: 'cleared', reason: 'unresumable-after-restarts', retry: 'failed' });
  });
});

describe('系统活动 6：进程健康（任务19·A）', () => {
  it('spawn-error/restart-failed/restart-exhausted 默认 warn；watchdog/exited/orphan 落详情', () => {
    resetSystemLogStateForTests();
    logProcess({ phase: 'spawn-error', agentId: 'ag-proc-log', error: 'ENOENT' });
    logProcess({
      phase: 'watchdog-missing', agentId: 'ag-proc-log', sessionId: 's-p1',
      turnState: 'processing', queuedCount: 2, tmuxSession: 'tc-ag-proc-log', action: 'respawn',
    });
    logProcess({ phase: 'restart', agentId: 'ag-proc-log', attempt: 1, maxAttempts: 3 });
    logProcess({ phase: 'restart-ok', agentId: 'ag-proc-log', attempt: 1, maxAttempts: 3 });
    logProcess({ phase: 'restart-failed', agentId: 'ag-proc-log', attempt: 1, error: 'spawn fail' });
    logProcess({
      phase: 'restart-exhausted', agentId: 'ag-proc-log',
      attempt: 3, maxAttempts: 3, producedOutput: false, action: 'give-up',
    });
    logProcess({
      phase: 'exited', agentId: 'ag-proc-log', pid: 4321, exitCode: 1,
      signal: null, runtimeMs: 800, wasTracked: true, level: 'warn',
    });
    logProcess({
      phase: 'orphan-killed', agentId: 'ag-proc-log',
      tmuxSession: 'tc-ag-proc-log', reason: 'agent-no-longer-exists',
    });

    const rows = querySystemLog({ agentId: 'ag-proc-log', order: 'asc' });
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.category === 'system' && r.source === ACTIVITY_SOURCE.process)).toBe(true);
    expect(rows.map((r) => r.level)).toEqual(['warn', 'info', 'info', 'info', 'warn', 'warn', 'warn', 'info']);
    expect(bodyOf(rows[0])).toMatchObject({ cat: 'process', phase: 'spawn-error', error: 'ENOENT' });
    expect(bodyOf(rows[1])).toMatchObject({
      phase: 'watchdog-missing', turnState: 'processing', queuedCount: 2, action: 'respawn', tmuxSession: 'tc-ag-proc-log',
    });
    expect(bodyOf(rows[6])).toMatchObject({ phase: 'exited', pid: 4321, exitCode: 1, runtimeMs: 800, wasTracked: true });
    expect(bodyOf(rows[7])).toMatchObject({ phase: 'orphan-killed', reason: 'agent-no-longer-exists' });
  });
});

describe('系统活动 7：配置变更（任务19·A）', () => {
  it('set/clear/switch 落 key/action/value/valueLength；prompt 只记长度不落全文', () => {
    resetSystemLogStateForTests();
    logConfig({ key: 'system-prompt', action: 'set', valueLength: 4200, agentId: 'ag-cfg-log' });
    logConfig({ key: 'system-prompt', action: 'clear', agentId: 'ag-cfg-log' });
    logConfig({ key: 'tmux-mode', action: 'set', value: true, agentId: 'ag-cfg-log' });
    logConfig({ key: 'pi-rpc-mode', action: 'set', value: false, agentId: 'ag-cfg-log' });
    logConfig({ key: 'workspace', action: 'switch', value: null, agentId: 'ag-cfg-log' });

    const rows = querySystemLog({ agentId: 'ag-cfg-log', order: 'asc' });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.category === 'system' && r.source === ACTIVITY_SOURCE.config)).toBe(true);
    expect(bodyOf(rows[0])).toMatchObject({ cat: 'config', key: 'system-prompt', action: 'set', valueLength: 4200 });
    expect(bodyOf(rows[0]).value).toBeUndefined(); // prompt 全文不落
    expect(bodyOf(rows[1])).toMatchObject({ key: 'system-prompt', action: 'clear' });
    expect(bodyOf(rows[2])).toMatchObject({ key: 'tmux-mode', action: 'set', value: true });
    expect(bodyOf(rows[3])).toMatchObject({ key: 'pi-rpc-mode', action: 'set', value: false });
    expect(bodyOf(rows[4])).toMatchObject({ key: 'workspace', action: 'switch', value: null });
  });
});

describe('系统活动 8：技能调用（任务19·A）', () => {
  it('invoked/completed 默认 info；failed（或 ok=false）默认 warn', () => {
    resetSystemLogStateForTests();
    logSkill({ phase: 'invoked', skill: 'video-extract', agentId: 'ag-skill-log', argsPreview: '{"url":"x"}' });
    logSkill({ phase: 'completed', skill: 'video-extract', agentId: 'ag-skill-log', ok: true });
    logSkill({ phase: 'failed', skill: 'video-extract', agentId: 'ag-skill-log', ok: false, error: 'timeout' });

    const rows = querySystemLog({ agentId: 'ag-skill-log', order: 'asc' });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.category === 'system' && r.source === ACTIVITY_SOURCE.skill)).toBe(true);
    expect(rows.map((r) => r.level)).toEqual(['info', 'info', 'warn']);
    expect(bodyOf(rows[0])).toMatchObject({ cat: 'skill', phase: 'invoked', skill: 'video-extract', argsPreview: '{"url":"x"}' });
    expect(bodyOf(rows[1])).toMatchObject({ phase: 'completed', ok: true });
    expect(bodyOf(rows[2])).toMatchObject({ phase: 'failed', ok: false, error: 'timeout' });
  });
});

describe('失败隔离（任务19·A 铁律：埋点绝不倒灌主流程）', () => {
  it('logEvent 抛错时，logSession/logProcess/logConfig/logSkill 均不上抛且返回 undefined', () => {
    const mocked = vi.mocked(logEvent);
    mocked.mockClear();
    const calls: Array<() => unknown> = [
      () => logSession({ phase: 'created', agentId: 'ag-iso', sessionId: 's-iso' }),
      () => logProcess({ phase: 'exited', agentId: 'ag-iso', exitCode: 0 }),
      () => logConfig({ key: 'workspace', action: 'switch', value: 'w-1' }),
      () => logSkill({ phase: 'invoked', skill: 'x', agentId: 'ag-iso' }),
    ];
    for (const call of calls) {
      let result: unknown;
      mocked.mockImplementationOnce(() => { throw new Error('sink down'); });
      expect(() => { result = call(); }).not.toThrow();
      expect(result).toBeUndefined();
    }
    expect(mocked).toHaveBeenCalledTimes(4);
  });
});
