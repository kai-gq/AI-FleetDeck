/**
 * 任务 32 · 会话计数单测（验收①：前 20 次会话零变更的计数器断言）
 *
 * 覆盖：计数与记录期判定、同 id 幂等去重、空 id 不计、持久化跨实例、
 * 文件缺失/损坏容错、写失败降级不阻断。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileSessionCounter } from './session-counter.js';
import { RECORD_PHASE_SESSIONS } from './governance.js';

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-counter-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function counter(file = path.join(tmpDir, 'session-count.json')): FileSessionCounter {
  return new FileSessionCounter({ filePath: file });
}

describe('FileSessionCounter', () => {
  it('初始 0 次、记录期；第 20 次后离开记录期', () => {
    const c = counter();
    expect(c.count).toBe(0);
    expect(c.isRecordPhase()).toBe(true);

    for (let i = 1; i <= RECORD_PHASE_SESSIONS; i++) {
      const r = c.recordSession(`sess-${i}`, 1_000 + i);
      expect(r.counted).toBe(true);
      expect(r.sessionCount).toBe(i);
    }
    expect(c.count).toBe(RECORD_PHASE_SESSIONS);
    expect(c.isRecordPhase()).toBe(false);
  });

  it('第 19 次仍记录期（边界）', () => {
    const c = counter();
    for (let i = 1; i < RECORD_PHASE_SESSIONS; i++) c.recordSession(`sess-${i}`);
    expect(c.count).toBe(RECORD_PHASE_SESSIONS - 1);
    expect(c.isRecordPhase()).toBe(true);
  });

  it('同 id 重复记录幂等（counted=false 且不落盘）；空 id 不计', () => {
    const c = counter();
    expect(c.recordSession('sess-a')).toEqual({ sessionCount: 1, counted: true });
    expect(c.recordSession('sess-a')).toEqual({ sessionCount: 1, counted: false });
    expect(c.recordSession('')).toEqual({ sessionCount: 1, counted: false });
    expect(c.count).toBe(1);
  });

  it('持久化：新实例读同一文件继承计数（含 lastSessionId 去重仍生效）', () => {
    const file = path.join(tmpDir, 'session-count.json');
    counter(file).recordSession('sess-a', 111);
    const c2 = counter(file);
    expect(c2.count).toBe(1);
    expect(c2.recordSession('sess-a')).toEqual({ sessionCount: 1, counted: false });
    expect(c2.recordSession('sess-b')).toEqual({ sessionCount: 2, counted: true });

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw).toMatchObject({ version: 1, sessionCount: 2, lastSessionId: 'sess-b', lastRecordedAt: expect.any(Number) });
  });

  it('文件缺失 / 损坏 → 初始态，不抛', () => {
    expect(counter(path.join(tmpDir, 'nope.json')).count).toBe(0);
    const bad = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(bad, '{broken json');
    expect(counter(bad).count).toBe(0);
  });

  it('写失败降级：仍返回计数（仅存内存），不抛', () => {
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'file, not dir');
    const c = counter(path.join(blocker, 'session-count.json'));
    expect(c.recordSession('sess-a')).toEqual({ sessionCount: 1, counted: true });
    expect(c.recordSession('sess-b')).toEqual({ sessionCount: 2, counted: true }); // 内存缓存继续工作
    expect(counter(path.join(blocker, 'session-count.json')).count).toBe(0); // 磁盘上没有 → 新实例回落
  });
});
