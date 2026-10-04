/**
 * 任务10·⑦ 任务对象化（任务卡）单测：解析 / 归一化 / 回退纯文本 / 状态机守卫 / 渲染。
 * 验收 ⑥1：任务卡解析 + 回退纯文本兼容。
 */
import { describe, expect, it } from 'vitest';
import {
  canTransitionTaskCard,
  formatTaskCard,
  formatTaskCardForBoss,
  isTaskCardStatus,
  normalizeTaskCard,
  parseTaskCardFromText,
} from './task-card-service.js';

describe('normalizeTaskCard — 任务卡解析/归一化', () => {
  it('完整字段卡：归一化并去空白，status 一律 pending', () => {
    const { card, errors } = normalizeTaskCard({
      objective: '  实现登录页  ',
      acceptanceCriteria: ['types 通过', ' 单测覆盖回退 '],
      dependencies: ['设计稿 v2'],
      priority: 'p1',
      projectId: 'proj-login',
      sourceProject: 'proj-web',
    });
    expect(errors).toEqual([]);
    expect(card).toMatchObject({
      objective: '实现登录页',
      acceptanceCriteria: ['types 通过', '单测覆盖回退'],
      dependencies: ['设计稿 v2'],
      priority: 'P1',
      projectId: 'proj-login',
      sourceProject: 'proj-web',
      status: 'pending',
    });
  });

  it('acceptanceCriteria 允许单个字符串（Boss 省事写法），空串剔除、重复去重', () => {
    const { card } = normalizeTaskCard({ objective: 'x', acceptanceCriteria: '  冒烟通过  ' });
    expect(card?.acceptanceCriteria).toEqual(['冒烟通过']);

    const { card: deduped } = normalizeTaskCard({ objective: 'x', acceptanceCriteria: ['a', ' a ', '', 'b'] });
    expect(deduped?.acceptanceCriteria).toEqual(['a', 'b']);
  });

  it('priority 接受 high/medium/low 别名并归一化为 P1/P2/P3', () => {
    expect(normalizeTaskCard({ objective: 'x', priority: 'high' }).card?.priority).toBe('P1');
    expect(normalizeTaskCard({ objective: 'x', priority: 'MEDIUM' }).card?.priority).toBe('P2');
    expect(normalizeTaskCard({ objective: 'x', priority: 'low' }).card?.priority).toBe('P3');
    expect(normalizeTaskCard({ objective: 'x', priority: 'P0' }).card?.priority).toBe('P0');
  });

  it('非法输入返回 errors：非对象 / 缺 objective / 非法 priority / 非法数组元素', () => {
    expect(normalizeTaskCard(null).card).toBeUndefined();
    expect(normalizeTaskCard([1]).errors).toContain('taskCard must be an object');
    expect(normalizeTaskCard({}).errors).toContain('taskCard.objective is required');
    expect(normalizeTaskCard({ objective: 'x', priority: 'urgent' }).errors.join()).toContain('priority');
    expect(normalizeTaskCard({ objective: 'x', acceptanceCriteria: [42] }).errors.join()).toContain('acceptanceCriteria');
  });

  it('外部传入 status 被忽略（状态由服务端状态机维护，落卡一律 pending）', () => {
    const { card } = normalizeTaskCard({ objective: 'x', status: 'done' });
    expect(card?.status).toBe('pending');
  });
});

describe('parseTaskCardFromText — ```task-card 围栏块解析 + 回退纯文本', () => {
  it('从散文中抽取围栏块 JSON', () => {
    const text = `请做这个任务:
\`\`\`task-card
{"objective":"修复登录回退","acceptanceCriteria":["回归用例全绿"],"priority":"P1"}
\`\`\`
谢谢`;
    expect(parseTaskCardFromText(text)).toMatchObject({
      objective: '修复登录回退',
      acceptanceCriteria: ['回归用例全绿'],
      priority: 'P1',
      status: 'pending',
    });
  });

  it('无围栏块 → undefined（旧纯文本消息按纯文本处理）', () => {
    expect(parseTaskCardFromText('帮我看下登录 bug')).toBeUndefined();
  });

  it('围栏内容非法 JSON / 校验失败 → undefined,不抛异常', () => {
    expect(parseTaskCardFromText('```task-card\n{not json}\n```')).toBeUndefined();
    expect(parseTaskCardFromText('```task-card\n{"acceptanceCriteria":[]}\n```')).toBeUndefined();
  });
});

describe('状态机守卫 canTransitionTaskCard（pending → queued/running → done）', () => {
  it('合法迁移', () => {
    expect(canTransitionTaskCard('pending', 'running')).toBe(true);
    expect(canTransitionTaskCard('pending', 'done')).toBe(true);   // 乱序回执：运行标记未及落盘
    expect(canTransitionTaskCard('running', 'done')).toBe(true);
    // 任务15·B 并发配额：pending → queued（超预算入队）、queued → running（出队派发）
    expect(canTransitionTaskCard('pending', 'queued')).toBe(true);
    expect(canTransitionTaskCard('queued', 'running')).toBe(true);
  });

  it('非法迁移（终态出边为空 / 同态重复 / queued 只接 running）', () => {
    expect(canTransitionTaskCard('done', 'running')).toBe(false);
    expect(canTransitionTaskCard('done', 'pending')).toBe(false);
    expect(canTransitionTaskCard('pending', 'pending')).toBe(false);
    expect(canTransitionTaskCard('running', 'running')).toBe(false);
    expect(canTransitionTaskCard('queued', 'queued')).toBe(false);
    expect(canTransitionTaskCard('queued', 'pending')).toBe(false);
    expect(canTransitionTaskCard('queued', 'done')).toBe(false); // 排队不得直接完成
    expect(canTransitionTaskCard('running', 'queued')).toBe(false);
    expect(canTransitionTaskCard('done', 'queued')).toBe(false);
  });

  it('isTaskCardStatus 认四态（queued 已落地；cancelled 仍留任务 16）', () => {
    expect(isTaskCardStatus('pending')).toBe(true);
    expect(isTaskCardStatus('running')).toBe(true);
    expect(isTaskCardStatus('done')).toBe(true);
    expect(isTaskCardStatus('queued')).toBe(true);
    expect(isTaskCardStatus('cancelled')).toBe(false);
  });
});

describe('渲染 formatTaskCard / formatTaskCardForBoss', () => {
  const card = normalizeTaskCard({
    objective: '实现登录页',
    acceptanceCriteria: ['types 通过', '单测覆盖回退'],
    dependencies: ['设计稿 v2'],
    priority: 'P1',
    projectId: 'proj-login',
    sourceProject: 'proj-web',
  }).card!;

  it('可读块含目标/验收/依赖/优先级/项目', () => {
    const text = formatTaskCard(card);
    expect(text).toContain('[TASK CARD]');
    expect(text).toContain('Objective: 实现登录页');
    expect(text).toContain('- types 通过');
    expect(text).toContain('Dependencies:');
    expect(text).toContain('Priority: P1');
    expect(text).toContain('Project: proj-login (source: proj-web)');
    expect(text).toContain('[/TASK CARD]');
  });

  it('空验收标准/依赖显示 (none …) 占位,不出现空列表', () => {
    const bare = normalizeTaskCard({ objective: '光杆任务' }).card!;
    const text = formatTaskCard(bare);
    expect(text).toContain('- (none provided)');
    expect(text).toContain('- (none)');
    expect(text).not.toContain('Priority:');
  });

  it('Boss 注入版附 delegation 块 taskCard JSON 提示（携带验收标准）', () => {
    const text = formatTaskCardForBoss(card);
    expect(text).toContain('"taskCard":');
    expect(text).toContain('"acceptanceCriteria":["types 通过","单测覆盖回退"]');
  });
});
