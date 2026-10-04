/**
 * system_log 单测（⑭ 日志地基①）：迁移建表、logEvent 自动补字段、traceId 贯穿、
 * 分级采样、脱敏、写失败静默降级、按 taskId 串时间线（验收 1）。
 *
 * 数据目录由 test-setup.ts 重定向到每进程临时目录，不触碰真实 events.db。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeEventDb, initEventDb, queryMany } from './event-db.js';
import {
  INFO_SAMPLE_RATE,
  countSystemLog,
  deleteSystemLog,
  ensureEventDbFilePermissions,
  getLogEventWriteFailureCount,
  logEvent,
  querySystemLog,
  redactSensitive,
  resetSystemLogStateForTests,
} from './system-log.js';
import { ensureTaskId, runWithTrace } from '../utils/trace-context.js';

beforeAll(() => {
  initEventDb();
});

afterAll(() => {
  closeEventDb();
});

describe('迁移与建表', () => {
  it('011 迁移已登记，system_log 全字段与索引就位', () => {
    const migrations = queryMany<{ version: number }>('SELECT version FROM _migrations ORDER BY version');
    expect(migrations.map(m => m.version)).toContain(11);

    const columns = queryMany<{ name: string; notnull: number; pk: number }>('PRAGMA table_info(system_log)');
    expect(columns.map(c => c.name)).toEqual([
      'id', 'ts', 'category', 'source', 'agent_id', 'project_id', 'session_id', 'task_id', 'level', 'body',
    ]);
    expect(columns.find(c => c.name === 'id')?.pk).toBe(1);

    const indexNames = queryMany<{ name: string }>('PRAGMA index_list(system_log)').map(i => i.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_system_log_ts',
      'idx_system_log_category',
      'idx_system_log_level',
      'idx_system_log_session',
      'idx_system_log_task',
    ]));
  });
});

describe('logEvent 写入', () => {
  it('自动补 ts/source/level，body 对象 JSON 化，返回行 id', () => {
    const before = Date.now();
    const id = logEvent('dialog', {
      source: 'unit-basic',
      sessionId: 'sess-basic',
      body: { text: '你好', direction: 'in' },
    });
    expect(typeof id).toBe('number');

    const [row] = querySystemLog({ sessionId: 'sess-basic' });
    expect(row.id).toBe(id);
    expect(row.ts).toBeGreaterThanOrEqual(before);
    expect(row.category).toBe('dialog');
    expect(row.source).toBe('unit-basic');
    expect(row.level).toBe('info');
    expect(JSON.parse(row.body ?? '')).toEqual({ text: '你好', direction: 'in' });
  });

  it('未显式给 source/level 时兜底为 server/info；字符串 body 原样存', () => {
    logEvent('system', { sessionId: 'sess-defaults', body: 'plain text' });
    const [row] = querySystemLog({ sessionId: 'sess-defaults' });
    expect(row.source).toBe('server');
    expect(row.level).toBe('info');
    expect(row.body).toBe('plain text');
  });

  it('warn/error 全量写入', () => {
    logEvent('system', { source: 'unit-warn', level: 'warn', body: 'w1' });
    logEvent('system', { source: 'unit-warn', level: 'error', body: 'e1' });
    expect(countSystemLog({ source: 'unit-warn' })).toBe(2);
  });
});

describe('traceId 贯穿（taskId/sessionId 整链共享）', () => {
  it('链路内 taskId 只生成一次，嵌套环节继承；logEvent 自动带上', () => {
    const chainTaskId = runWithTrace({ sessionId: 'sess-chain', projectId: 'proj-chain' }, () => {
      const taskId = ensureTaskId();
      expect(ensureTaskId()).toBe(taskId); // 同一链路重复取用不新生成（禁止各环节各生成）

      logEvent('dialog', { body: '帮我看下构建' });

      return runWithTrace({ agentId: 'boss-1' }, () => {
        expect(ensureTaskId()).toBe(taskId); // 嵌套子环节继承父链路
        logEvent('delegation', { body: '派给 boss-1' });
        return taskId;
      });
    });

    const rows = querySystemLog({ taskId: chainTaskId, order: 'asc' });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.sessionId === 'sess-chain' && r.projectId === 'proj-chain')).toBe(true);
    expect(rows[0].agentId).toBeUndefined();
    expect(rows[1].agentId).toBe('boss-1');
  });

  it('显式 fields 优先于链路上下文；链路外写入不报错（ID 按空处理）', () => {
    runWithTrace({ sessionId: 'sess-ctx', taskId: 'task-ctx' }, () => {
      logEvent('dialog', { sessionId: 'sess-explicit', taskId: 'task-explicit', body: 'x' });
    });
    const [row] = querySystemLog({ taskId: 'task-explicit' });
    expect(row.sessionId).toBe('sess-explicit');

    logEvent('system', { source: 'unit-nocontext', body: 'no context' });
    const [bare] = querySystemLog({ source: 'unit-nocontext' });
    expect(bare.taskId).toBeUndefined();
    expect(bare.sessionId).toBeUndefined();
  });
});

describe('验收 1：按 taskId SQL 串出完整链路时间线', () => {
  it('一次「对话 + 派活 + 执行 + 回执 + 播报」后 SQL 可查完整时间线', () => {
    const taskId = runWithTrace({ sessionId: 'sess-e2e', projectId: 'proj-e2e' }, () => {
      const id = ensureTaskId();
      logEvent('dialog', { source: 'voice-companion', body: '帮我看看构建为什么挂了' });
      logEvent('delegation', { source: 'secretary', body: '派活 → Boss' });
      logEvent('delegation', { source: 'subordinate-a', body: '执行完成：已修复构建' });
      logEvent('broadcast', { source: 'voice-companion', body: '播报：构建已恢复' });
      return id;
    });

    const rows = queryMany<{ category: string; task_id: string; session_id: string; body: string }>(
      'SELECT category, task_id, session_id, body FROM system_log WHERE task_id = ? ORDER BY ts ASC, id ASC',
      [taskId]
    );
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r.category)).toEqual(['dialog', 'delegation', 'delegation', 'broadcast']);
    expect(rows.every(r => r.task_id === taskId && r.session_id === 'sess-e2e')).toBe(true);
    expect(rows[3].body).toBe('播报：构建已恢复');
  });
});

describe('分级采样（info 高频通道 1:10，warn+ 与业务链路全量）', () => {
  it('采样只作用于高频通道，且 warn/error 永不采样', () => {
    resetSystemLogStateForTests();

    for (let i = 0; i < 20; i++) logEvent('context_stats', { source: 'sample-cat', body: `poll-${i}` });
    expect(countSystemLog({ source: 'sample-cat' })).toBe(20 / INFO_SAMPLE_RATE);

    for (let i = 0; i < 20; i++) logEvent('system', { source: 'sample-flag', sampled: true, body: `http-${i}` });
    expect(countSystemLog({ source: 'sample-flag' })).toBe(20 / INFO_SAMPLE_RATE);

    for (let i = 0; i < 5; i++) logEvent('dialog', { source: 'sample-dialog', body: `msg-${i}` });
    expect(countSystemLog({ source: 'sample-dialog' })).toBe(5);

    for (let i = 0; i < 5; i++) {
      logEvent('context_stats', { source: 'sample-error', level: 'error', body: `err-${i}` });
    }
    expect(countSystemLog({ source: 'sample-error' })).toBe(5);
  });
});

describe('隐私：密钥脱敏', () => {
  it('对象敏感键递归替换为 [REDACTED]，用量类字段不误伤', () => {
    expect(redactSensitive({
      apiKey: 'sk-abcdef123456',
      nested: { password: 'p@ssw0rd', access_token: 'abc123456' },
      tokensUsed: 1234,
      maxTokens: 8192,
      keep: 'ok',
    })).toEqual({
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]', access_token: '[REDACTED]' },
      tokensUsed: 1234,
      maxTokens: 8192,
      keep: 'ok',
    });
  });

  it('字符串正文命中常见密钥形态时脱敏', () => {
    expect(redactSensitive('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactSensitive('api_key=supersecret123')).toBe('api_key=[REDACTED]');
    expect(redactSensitive('"token":"xyz987654"')).not.toContain('xyz987654');
    expect(redactSensitive('sk-abcdefgh12345678')).toBe('[REDACTED]');
  });

  it('logEvent 落盘前脱敏（对象 body 与字符串 body）', () => {
    logEvent('system', {
      source: 'redact-test',
      body: { token: 'tok-abc123456', note: 'Bearer abcdefghijklmnop' },
    });
    logEvent('system', { source: 'redact-test', body: 'client_secret=abcdef123456' });

    const rows = querySystemLog({ source: 'redact-test', order: 'asc' });
    expect(rows).toHaveLength(2);
    expect(rows[0].body).not.toContain('tok-abc123456');
    expect(rows[0].body).toContain('[REDACTED]');
    expect(rows[0].body).not.toContain('abcdefghijklmnop');
    expect(rows[1].body).not.toContain('abcdef123456');
  });
});

describe('写失败静默降级', () => {
  it('EventDB 不可用时 logEvent 不抛异常，只累计内存失败计数', () => {
    resetSystemLogStateForTests();
    closeEventDb();
    try {
      expect(() => logEvent('system', { source: 'fail-test', body: 'x' })).not.toThrow();
      expect(logEvent('system', { source: 'fail-test', body: 'y' })).toBeUndefined();
      expect(getLogEventWriteFailureCount()).toBe(2);
    } finally {
      initEventDb();
    }
    // 恢复后可正常写入
    expect(logEvent('system', { source: 'fail-test', body: 'z' })).toBeTypeOf('number');
  });
});

describe('可查/可删', () => {
  it('deleteSystemLog 需带过滤条件（安全阀），按条件删除', () => {
    logEvent('system', { source: 'del-test', body: 'old', ts: Date.now() - 60_000 });
    expect(countSystemLog({ source: 'del-test' })).toBe(1);

    expect(deleteSystemLog({})).toBe(0); // 空条件不误删
    expect(deleteSystemLog({ before: Date.now() - 30_000, category: 'no-such-category' })).toBe(0);
    expect(deleteSystemLog({ before: Date.now() - 30_000, category: 'system' })).toBeGreaterThanOrEqual(1);
    expect(countSystemLog({ source: 'del-test' })).toBe(0);
  });
});

describe('隐私：events.db 权限收紧', () => {
  it.skipIf(process.platform === 'win32')('POSIX 下收紧为仅当前用户可读写（0600）', () => {
    ensureEventDbFilePermissions();
    const dataDir = path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
      'tide-commander'
    );
    const mode = fs.statSync(path.join(dataDir, 'events.db')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
