import { describe, expect, it } from 'vitest';
import {
  boardStatusGroup,
  filterBoardEntries,
  formatBoardDuration,
  groupEntriesByBoss,
  parseBoardResponse,
  type BoardEntry,
} from './boardModel';

function makeEntry(overrides: Partial<BoardEntry> = {}): BoardEntry {
  return {
    decisionId: 'd-1',
    bossId: 'boss-1',
    bossName: '王经理',
    who: { agentId: 'agent-1', agentName: '小刘' },
    when: { delegatedAt: 1_000_000, completedAt: 1_038_500, durationMs: 38_500 },
    what: { objective: '实现登录页', status: 'completed' },
    why: { userCommand: '做个登录页', reasoning: 'builder 空闲', confidence: 'high' },
    where: { outputLocation: 'src/pages/login.tsx' },
    outcome: { result: 'completed', rating: 'satisfied' },
    ...overrides,
  };
}

describe('任务24 委派看板数据模型', () => {
  it('parseBoardResponse:宽松校验——非法响应 null,单条非法跳过,缺省字段回落', () => {
    expect(parseBoardResponse(null)).toBeNull();
    expect(parseBoardResponse({ entries: 'nope' })).toBeNull();

    const ok = parseBoardResponse({
      entries: [makeEntry(), { decisionId: 'bad' }, 42],
    });
    expect(ok).not.toBeNull();
    expect(ok!.entries).toHaveLength(1);
    expect(ok!.entries[0].decisionId).toBe('d-1');
    expect(ok!.generatedAt).toBe(0); // 服务端必给;缺省回落 0 而非崩溃
    expect(ok!.total).toBe(3); // total 缺省 → entries 原始长度

    const withMeta = parseBoardResponse({ generatedAt: 9, total: 7, limit: 5, offset: 2, entries: [] });
    expect(withMeta).toMatchObject({ generatedAt: 9, total: 7, limit: 5, offset: 2 });
  });

  it('状态归类:活跃/成功/失败/取消', () => {
    expect(boardStatusGroup('in-flight')).toBe('active');
    expect(boardStatusGroup('sent')).toBe('active');
    expect(boardStatusGroup('running')).toBe('active');
    expect(boardStatusGroup('completed')).toBe('success');
    expect(boardStatusGroup('done')).toBe('success');
    expect(boardStatusGroup('failed')).toBe('danger');
    expect(boardStatusGroup('cancelled')).toBe('muted');
  });

  it('过滤:all 全量;具体状态精确匹配;不改输入', () => {
    const entries = [
      makeEntry({ decisionId: 'a', what: { objective: 'A', status: 'in-flight' } }),
      makeEntry({ decisionId: 'b', what: { objective: 'B', status: 'completed' } }),
    ];
    expect(filterBoardEntries(entries, 'all').map((e) => e.decisionId)).toEqual(['a', 'b']);
    expect(filterBoardEntries(entries, 'in-flight').map((e) => e.decisionId)).toEqual(['a']);
    expect(filterBoardEntries(entries, 'failed')).toEqual([]);
    expect(entries).toHaveLength(2);
  });

  it('按 Boss 分组:保持时间倒序;bossName 缺省回退 bossId', () => {
    const entries = [
      makeEntry({ decisionId: 'a', bossId: 'boss-1' }),
      makeEntry({ decisionId: 'b', bossId: 'boss-2', bossName: undefined }),
      makeEntry({ decisionId: 'c', bossId: 'boss-1' }),
    ];
    const groups = groupEntriesByBoss(entries);
    expect(groups.map((g) => g.bossId)).toEqual(['boss-1', 'boss-2']);
    expect(groups[0].entries.map((e) => e.decisionId)).toEqual(['a', 'c']);
    expect(groups[0].bossName).toBe('王经理');
    expect(groups[1].bossName).toBe('boss-2');
  });

  it('耗时紧凑格式:38.5s → 39s / 3m / 2.1h;异常值空串', () => {
    expect(formatBoardDuration(500)).toBe('0.5s');
    expect(formatBoardDuration(38_500)).toBe('39s');
    expect(formatBoardDuration(150_000)).toBe('3m');
    expect(formatBoardDuration(7_200_000)).toBe('2.0h');
    expect(formatBoardDuration(Number.NaN)).toBe('');
    expect(formatBoardDuration(-5)).toBe('');
  });
});
