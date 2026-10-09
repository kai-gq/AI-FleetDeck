import { describe, expect, it } from 'vitest';
import {
  aggregateStatusGroup,
  boardStatusGroup,
  buildDelegationTree,
  classifyOutputPath,
  extractOutputPath,
  filterBoardEntries,
  formatBoardDuration,
  liveElapsedMs,
  parseBoardResponse,
  taskGroupKey,
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

  it('过滤:all 全量;段位按状态组(进行中=active 全组、已完成含 done、失败=danger);未知 id 精确匹配;不改输入', () => {
    const entries = [
      makeEntry({ decisionId: 'a', what: { objective: 'A', status: 'in-flight' } }),
      makeEntry({ decisionId: 'b', what: { objective: 'B', status: 'sent' } }),
      makeEntry({ decisionId: 'c', what: { objective: 'C', status: 'running' } }),
      makeEntry({ decisionId: 'd', what: { objective: 'D', status: 'completed' } }),
      makeEntry({ decisionId: 'e', what: { objective: 'E', status: 'done' } }),
      makeEntry({ decisionId: 'f', what: { objective: 'F', status: 'failed' } }),
      makeEntry({ decisionId: 'g', what: { objective: 'G', status: 'cancelled' } }),
    ];
    expect(filterBoardEntries(entries, 'all').map((e) => e.decisionId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(filterBoardEntries(entries, 'in-flight').map((e) => e.decisionId)).toEqual(['a', 'b', 'c']);
    expect(filterBoardEntries(entries, 'completed').map((e) => e.decisionId)).toEqual(['d', 'e']);
    expect(filterBoardEntries(entries, 'failed').map((e) => e.decisionId)).toEqual(['f']);
    expect(filterBoardEntries(entries, 'cancelled').map((e) => e.decisionId)).toEqual(['g']);
    expect(entries).toHaveLength(7);
  });

  it('耗时紧凑格式:38.5s → 39s / 3m / 2.1h / 2.0d;异常值空串', () => {
    expect(formatBoardDuration(500)).toBe('0.5s');
    expect(formatBoardDuration(38_500)).toBe('39s');
    expect(formatBoardDuration(150_000)).toBe('3m');
    expect(formatBoardDuration(7_200_000)).toBe('2.0h');
    expect(formatBoardDuration(172_800_000)).toBe('2.0d'); // 陈年 sent 条目
    expect(formatBoardDuration(Number.NaN)).toBe('');
    expect(formatBoardDuration(-5)).toBe('');
  });
});

describe('任务24 委派树 · 归组与构建', () => {
  it('taskGroupKey:taskId 优先;无 taskId 回退 objective;再退 decisionId', () => {
    expect(taskGroupKey(makeEntry({ taskId: 'task-1' }))).toBe('task:task-1');
    expect(taskGroupKey(makeEntry({ what: { objective: 'P', status: 'completed' } }))).toBe('obj:P');
    expect(
      taskGroupKey(makeEntry({ decisionId: 'd-9', what: { objective: '  ', status: 'completed' } }))
    ).toBe('del:d-9');
  });

  it('聚合态:有活跃 → active;否则有失败 → danger;全取消 → muted;其余 success', () => {
    expect(aggregateStatusGroup(['completed', 'in-flight'])).toBe('active');
    expect(aggregateStatusGroup(['completed', 'failed'])).toBe('danger');
    expect(aggregateStatusGroup(['cancelled', 'cancelled'])).toBe('muted');
    expect(aggregateStatusGroup(['completed', 'done'])).toBe('success');
  });

  it('liveElapsedMs:仅活跃态计时;startedAt 优先;回退 delegAt;无起点 null', () => {
    expect(liveElapsedMs('in-flight', 1000, 5000, 9000)).toBe(4000); // startedAt 优先
    expect(liveElapsedMs('sent', 1000, undefined, 9000)).toBe(8000); // 回退委派时刻
    expect(liveElapsedMs('sent', 0, undefined, 9000)).toBeNull(); // 合成条目无起点
    expect(liveElapsedMs('completed', 1000, 5000, 9000)).toBeNull(); // 非活跃不计时
    expect(liveElapsedMs('running', 0, 3000, 2000)).toBe(0); // now 早于起点 → 夹 0
  });

  it('建树:taskId 跨下属聚合;label 取最新条;Boss 归组;任务按 latestAt 倒序', () => {
    const entries = [
      makeEntry({
        decisionId: 'd-3', taskId: 'task-x',
        who: { agentId: 'agent-2', agentName: '王强' },
        when: { delegatedAt: 3000, completedAt: 5000, durationMs: 2000 },
        what: { objective: '登录二期', status: 'completed' },
      }),
      makeEntry({
        decisionId: 'd-2', taskId: 'task-x',
        who: { agentId: 'agent-1', agentName: '小刘' },
        when: { delegatedAt: 1000, completedAt: 2000, durationMs: 1000 },
        what: { objective: '登录一期', status: 'failed' },
      }),
      makeEntry({
        decisionId: 'd-1',
        what: { objective: '独立任务', status: 'completed' },
        when: { delegatedAt: 500, completedAt: 900, durationMs: 400 },
      }),
    ];

    const tasks = buildDelegationTree(entries, { now: 10_000 });
    expect(tasks.map((task) => task.key)).toEqual(['task:task-x', 'obj:独立任务']); // 5000 > 900
    const first = tasks[0];
    expect(first.label).toBe('登录二期'); // 输入序首条即最新
    expect(first.delegationCount).toBe(2); // 跨下属聚合
    expect(first.taskId).toBe('task-x');
    expect(first.statusGroup).toBe('danger'); // 无活跃 + 有失败
    expect(first.bosses).toHaveLength(1);
    expect(first.bosses[0].key).toBe('task:task-x#boss-1');
    expect(first.bosses[0].delegations.map((node) => node.key)).toEqual(['d-3', 'd-2']);
    expect(first.bosses[0].statusGroup).toBe('danger');
  });

  it('建树:任务纯按最新活动倒序(B-34 用户口径;在办不再置顶)', () => {
    const entries = [
      makeEntry({
        decisionId: 'd-done',
        what: { objective: '旧任务', status: 'completed' },
        when: { delegatedAt: 5000, completedAt: 9000, durationMs: 4000 },
      }),
      makeEntry({
        decisionId: 'd-run',
        what: { objective: '在办任务', status: 'running' },
        when: { delegatedAt: 1000 },
      }),
    ];

    const tasks = buildDelegationTree(entries, { now: 10_000 });
    // 最新的委派排最上面:旧任务(9000) 在 在办任务(1000) 之上,不再按状态抬在办
    expect(tasks.map((task) => task.label)).toEqual(['旧任务', '在办任务']);
    expect(tasks[0]?.statusGroup).toBe('success');
    expect(tasks[1]?.statusGroup).toBe('active');
  });

  it('建树:多 Boss 分叉;bossName 缺省回退 bossId;在办条目实时耗时接线', () => {
    const entries = [
      makeEntry({
        decisionId: 'd-2', taskId: 'task-y', bossId: 'boss-2', bossName: undefined,
        what: { objective: 'T', status: 'sent' },
        when: { delegatedAt: 0 }, // 服务端合成在办条目:无起点
      }),
      makeEntry({
        decisionId: 'd-1', taskId: 'task-y', bossId: 'boss-1',
        what: { objective: 'T', status: 'running' },
        when: { delegatedAt: 4000 },
      }),
    ];
    const tasks = buildDelegationTree(entries, {
      now: 10_000,
      startedAtOf: (entry) => (entry.decisionId === 'd-1' ? 6000 : undefined),
    });
    const [task] = tasks;
    expect(task.bosses.map((boss) => boss.bossId)).toEqual(['boss-2', 'boss-1']); // 首见序
    expect(task.bosses[0].bossName).toBe('boss-2'); // 缺省回退
    expect(task.bosses[0].delegations[0].liveElapsedMs).toBeNull(); // 无起点不编造
    expect(task.bosses[1].delegations[0].liveElapsedMs).toBe(4000); // startedAt 6000 → now 10000
    expect(task.statusGroup).toBe('active'); // 有在办
  });
});

describe('任务24 委派树 · 产出路径', () => {
  it('extractOutputPath:首个空白片段路径优先;自然语言描述 → null', () => {
    expect(extractOutputPath('src/pages/login.tsx')).toBe('src/pages/login.tsx');
    expect(extractOutputPath('E:/repo/.team-notes/坑/git-add-A.md')).toBe('E:/repo/.team-notes/坑/git-add-A.md');
    // 真实数据:路径 + 注解的复合串 → 取首个片段
    expect(extractOutputPath('/e/tmp/report.json (JSON报告) + /e/tmp/log.txt (失败清单)')).toBe('/e/tmp/report.json');
    // 真实数据:人话产出 → null(只当文本展示,不猜路径)
    expect(extractOutputPath('无文件交付(只读任务);读取结果见本 summary')).toBeNull();
    expect(extractOutputPath('无(纯调研任务,结论见回执summary)')).toBeNull();
    // 真实数据:路径与括号注解紧贴(无空格) → 剥注解取路径
    expect(extractOutputPath('E:/tmp/uia-out.txt(UIA 完整控件文本) + E:/tmp/phonelink-screen2.png(窗口截图)')).toBe('E:/tmp/uia-out.txt');
    expect(extractOutputPath('E:/tmp/out（最终版）')).toBe('E:/tmp/out');
    // 括号属文件名本体(注解尾段仍带扩展名) → 保留整段
    expect(extractOutputPath('src/foo(1).json')).toBe('src/foo(1).json');
    expect(extractOutputPath(undefined)).toBeNull();
    expect(extractOutputPath('  ')).toBeNull();
  });

  it('classifyOutputPath:文件/目录/不可判定三态', () => {
    expect(classifyOutputPath('src/pages/login.tsx')).toBe('file');
    expect(classifyOutputPath('E:\\repo\\src\\main.ts')).toBe('file');
    expect(classifyOutputPath('tools/repo-inspector/package.json')).toBe('file');
    expect(classifyOutputPath('E:/tide-commander/tide-commander/.team-notes/坑/x.md')).toBe('file');
    expect(classifyOutputPath('E:/repo/dist')).toBe('dir');
    expect(classifyOutputPath('E:/')).toBe('dir'); // 盘根
    expect(classifyOutputPath('无文件交付(只读任务);读取结果见本 summary')).toBe('unknown');
    expect(classifyOutputPath(undefined)).toBe('unknown');
  });
});
