/**
 * trace-context 单测（⑭ 日志地基①）：taskId 生成与整链贯穿、上下文继承/合并/恢复。
 */

import { describe, expect, it } from 'vitest';

import {
  ensureTaskId,
  getTaskId,
  getTraceContext,
  newTaskId,
  newTraceId,
  runWithTrace,
  updateTraceContext,
} from './trace-context.js';

describe('ID 生成', () => {
  it('newTaskId/newTraceId 带前缀且唯一', () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(a).toMatch(/^task-/);
    expect(a).not.toBe(b);
    expect(newTraceId()).toMatch(/^trace-/);
  });
});

describe('runWithTrace 上下文传播', () => {
  it('嵌套继承父字段，子上下文覆盖同名，结束后恢复', () => {
    expect(getTraceContext()).toBeUndefined();

    runWithTrace({ sessionId: 's1', projectId: 'p1' }, () => {
      expect(getTraceContext()).toMatchObject({ sessionId: 's1', projectId: 'p1' });

      runWithTrace({ projectId: 'p2', agentId: 'a1' }, () => {
        expect(getTraceContext()).toMatchObject({ sessionId: 's1', projectId: 'p2', agentId: 'a1' });
      });

      // 子上下文退出后不影响父上下文
      expect(getTraceContext()).toMatchObject({ sessionId: 's1', projectId: 'p1' });
    });

    expect(getTraceContext()).toBeUndefined();
  });

  it('undefined 字段不覆盖父上下文已有值', () => {
    runWithTrace({ agentId: 'a0' }, () => {
      runWithTrace({ agentId: undefined }, () => {
        expect(getTraceContext()?.agentId).toBe('a0');
      });
    });
  });

  it('updateTraceContext 可合并链路中途拿到的字段', () => {
    runWithTrace({ sessionId: 's3' }, () => {
      updateTraceContext({ taskId: 'task-manual', projectId: 'p9' });
      expect(getTraceContext()).toMatchObject({ sessionId: 's3', taskId: 'task-manual', projectId: 'p9' });
    });
  });
});

describe('ensureTaskId 整链只生成一次', () => {
  it('链路内首次调用生成，后续环节（含嵌套）复用同一个', () => {
    const outerTaskId = runWithTrace({ sessionId: 's2' }, () => {
      const first = ensureTaskId();
      expect(getTaskId()).toBe(first);
      expect(ensureTaskId()).toBe(first);

      return runWithTrace({ agentId: 'worker' }, () => {
        expect(ensureTaskId()).toBe(first);
        return first;
      });
    });

    expect(outerTaskId).toMatch(/^task-/);

    // 新链路重新生成（不同链路不共享）
    const anotherTaskId = runWithTrace({ sessionId: 's2' }, () => ensureTaskId());
    expect(anotherTaskId).not.toBe(outerTaskId);
  });

  it('链路外调用退化为返回新 ID（无上下文可贯穿）', () => {
    expect(getTaskId()).toBeUndefined();
    expect(ensureTaskId()).toMatch(/^task-/);
    expect(getTaskId()).toBeUndefined();
  });
});
