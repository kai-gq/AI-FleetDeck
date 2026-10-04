/**
 * jarvis-core/memory · FileMemoryStore 单测（任务 27 ⑥.1/⑥.4/⑥.5）
 *
 * 覆盖：四层 CRUD / 打开重扫持久化 / 来源分层硬闸门（inferred 拒收）/
 * 成长日志 append-only / 过期与容量裁剪（droppedCount）/ 去重 / 边界容错
 * （空库、损坏文件）/ use_count。基目录一律临时目录，绝不触碰真实数据。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AppendOnlyViolationError,
  DEFAULT_WORKING_CAPACITY,
  FileMemoryStore,
  InferredMemoryRejectedError,
  type MemoryOpEvent,
  type MemorySource,
} from './index.js';

// ============================================================================
// 夹具
// ============================================================================

let baseDir = '';
let clock = 1_700_000_000_000;
const events: MemoryOpEvent[] = [];

function makeStore(overrides: { maxTextLength?: number } = {}): FileMemoryStore {
  return new FileMemoryStore({
    baseDir,
    now: () => clock,
    maxTextLength: overrides.maxTextLength,
    observer: (ev) => events.push(ev),
  });
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-'));
  clock = 1_700_000_000_000;
  events.length = 0;
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

// ============================================================================
// 四层 CRUD
// ============================================================================

describe('四层结构增删改查', () => {
  it('add 落到对应层，query/list 可检索，元数据齐全（层/来源/时间戳/use_count）', async () => {
    const store = makeStore();
    const w = await store.add({ layer: 'working', source: 'user-stated', text: '当前焦点：接线记忆层', kind: 'focus' });
    const l = await store.add({ layer: 'long-term', source: 'agent-confirmed', text: '用户偏好中文', kind: 'preference' });
    const g = await store.add({ layer: 'growth-log', source: 'user-stated', text: '学会了先写后回应', kind: 'lesson' });
    const r = await store.add({ layer: 'reflections', source: 'agent-confirmed', text: '今晚反思草稿', kind: 'snapshot' });

    expect(w).toMatchObject({
      layer: 'working', source: 'user-stated', kind: 'focus', text: '当前焦点：接线记忆层',
      createdAt: clock, updatedAt: clock, useCount: 0, status: 'active',
    });
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await store.list('long-term')).map((e) => e.id)).toEqual([l.id]);
    expect((await store.query({ layer: ['working', 'reflections'] })).map((e) => e.id).sort()).toEqual([w.id, r.id].sort());
    expect((await store.query()).length).toBe(4);
    expect((await store.query({ layer: 'growth-log' }))[0].id).toBe(g.id);
    expect((await store.query({ text: '反思' }))[0].id).toBe(r.id);
    expect(await store.stats()).toEqual({
      active: 4, marked: 0, byLayer: { working: 1, 'long-term': 1, 'growth-log': 1, reflections: 1 },
    });
  });

  it('落盘为 Markdown（frontmatter + 正文），重开 store 可恢复', async () => {
    const store = makeStore();
    const entry = await store.add({ layer: 'working', source: 'user-stated', text: '工作记忆 7 天过期', kind: 'numeric', tags: ['numeric'], sessionId: 's1' });
    const file = path.join(baseDir, 'working', `${entry.id}.md`);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content.startsWith('---')).toBe(true);
    expect(content).toContain(`id: ${entry.id}`);
    expect(content).toContain('layer: working');
    expect(content).toContain('source: user-stated');
    expect(content).toContain('工作记忆 7 天过期');

    const reopened = makeStore();
    const [loaded] = await reopened.list('working');
    expect(loaded).toMatchObject({
      id: entry.id, layer: 'working', source: 'user-stated', kind: 'numeric',
      text: '工作记忆 7 天过期', sessionId: 's1', tags: ['numeric'], useCount: 0,
    });
  });

  it('update 改文本/来源/标签；未找到返回 null；delete 未找到返回 false', async () => {
    const store = makeStore();
    const entry = await store.add({ layer: 'working', source: 'user-stated', text: '旧文本' });
    clock += 1000;
    const updated = await store.update(entry.id, { text: '新文本', tags: ['focus'] });
    expect(updated).toMatchObject({ text: '新文本', tags: ['focus'], updatedAt: clock, createdAt: entry.createdAt });

    expect(await store.update('missing-id', { text: 'x' })).toBeNull();
    expect(await store.delete('missing-id')).toBe(false);

    expect(await store.delete(entry.id)).toBe(true);
    expect(await store.query()).toEqual([]);
    expect(fs.existsSync(path.join(baseDir, 'working', `${entry.id}.md`))).toBe(false);
  });

  it('同层同文本去重（返回既有条目、刷新 updatedAt）；异层各自保留', async () => {
    const store = makeStore();
    const first = await store.add({ layer: 'working', source: 'user-stated', text: '我喜欢用 pnpm' });
    clock += 1000;
    const second = await store.add({ layer: 'working', source: 'user-stated', text: ' 我喜欢用   pnpm '.replace(/\s+/g, ' ') });
    const other = await store.add({ layer: 'long-term', source: 'user-stated', text: '我喜欢用 pnpm' });

    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBe(clock);
    expect((await store.query()).length).toBe(2);
    expect(other.id).not.toBe(first.id);
    expect(events.some((e) => e.op === 'add' && e.applied === false && e.reason === 'duplicate')).toBe(true);
  });

  it('超长正文按 maxTextLength 截断', async () => {
    const store = makeStore({ maxTextLength: 10 });
    const entry = await store.add({ layer: 'working', source: 'user-stated', text: 'x'.repeat(50) });
    expect(entry.text).toHaveLength(10);
  });

  it('空文本抛 TypeError（编程错误尽早暴露）', async () => {
    const store = makeStore();
    await expect(store.add({ layer: 'working', source: 'user-stated', text: '   ' })).rejects.toThrow(TypeError);
  });
});

// ============================================================================
// 来源分层（§11.3 / ⑥.4）
// ============================================================================

describe('来源分层：inferred 只允许工作记忆', () => {
  it('inferred 写入 working 允许；写入 long-term / growth-log / reflections 一律拒收', async () => {
    const store = makeStore();
    const ok = await store.add({ layer: 'working', source: 'inferred', text: '推测：用户可能想先看日志' });
    expect(ok.source).toBe('inferred');

    for (const layer of ['long-term', 'growth-log', 'reflections'] as const) {
      await expect(
        store.add({ layer, source: 'inferred', text: '推断内容' }),
      ).rejects.toThrow(InferredMemoryRejectedError);
    }
    expect((await store.query()).length).toBe(1); // 失败写入未落盘
  });

  it('promote 到长期知识拒收 inferred（代码层强制）', async () => {
    const store = makeStore();
    const inferred = await store.add({ layer: 'working', source: 'inferred', text: '推测候选' });
    await expect(store.promote(inferred.id)).rejects.toThrow(InferredMemoryRejectedError);
    expect((await store.query({ layer: 'working' }))[0]).toMatchObject({ layer: 'working', status: 'active' });
  });

  it('promote 合法来源成功迁移并记录 promotedFrom；同层 promote 不改动', async () => {
    const store = makeStore();
    const entry = await store.add({ layer: 'working', source: 'user-stated', text: '用户偏好中文' });
    clock += 500;
    const promoted = await store.promote(entry.id);
    expect(promoted).toMatchObject({ layer: 'long-term', promotedFrom: 'working', updatedAt: clock });
    expect(fs.existsSync(path.join(baseDir, 'working', `${entry.id}.md`))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'long-term', `${entry.id}.md`))).toBe(true);
    expect(await store.list('working')).toEqual([]);
    expect((await store.list('long-term')).map((e) => e.id)).toEqual([entry.id]);

    const again = await store.promote(entry.id);
    expect(again).toMatchObject({ layer: 'long-term' });
    expect(events.some((e) => e.op === 'promote' && e.applied === false && e.reason === 'already-in-target')).toBe(true);
  });

  it('promote 未找到返回 null', async () => {
    const store = makeStore();
    expect(await store.promote('missing-id')).toBeNull();
  });
});

// ============================================================================
// 成长日志 append-only
// ============================================================================

describe('成长日志 append-only', () => {
  it('update/delete 默认拒绝；force=true 仅供隐私清除', async () => {
    const store = makeStore();
    const entry = await store.add({ layer: 'growth-log', source: 'user-stated', text: '你纠正过我：不是 pnpm 而是 bun' });
    await expect(store.update(entry.id, { text: '篡改' })).rejects.toThrow(AppendOnlyViolationError);
    await expect(store.delete(entry.id)).rejects.toThrow(AppendOnlyViolationError);
    expect((await store.list('growth-log')).length).toBe(1);

    const forced = await store.update(entry.id, { tags: ['privacy'] }, { force: true });
    expect(forced?.tags).toEqual(['privacy']);
    expect(await store.delete(entry.id, { force: true })).toBe(true);
    expect(await store.list('growth-log')).toEqual([]);
  });

  it('promote 同样拒绝（证据不被搬走；反思应新建派生条目）', async () => {
    const store = makeStore();
    const entry = await store.add({ layer: 'growth-log', source: 'user-stated', text: '教训：先写后回应' });
    await expect(store.promote(entry.id)).rejects.toThrow(AppendOnlyViolationError);
    expect((await store.list('growth-log')).length).toBe(1);
  });
});

// ============================================================================
// 生命周期（过期 / 容量 / use_count）
// ============================================================================

describe('生命周期：过期与容量裁剪', () => {
  it('过期工作记忆标记 pending-reflection，droppedCount 正确，默认查询不可见', async () => {
    const store = makeStore();
    const old = await store.add({ layer: 'working', source: 'user-stated', text: '七天前的焦点' });
    clock += 8 * DAY;
    const fresh = await store.add({ layer: 'working', source: 'user-stated', text: '今天的焦点' });

    const result = await store.sweep();
    expect(result).toMatchObject({ markedExpired: 1, markedOverflow: 0, droppedCount: 1 });
    expect(result.markedIds).toEqual([old.id]);

    const active = await store.query({ layer: 'working' });
    expect(active.map((e) => e.id)).toEqual([fresh.id]);
    const marked = await store.listMarkedForReflection();
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ id: old.id, status: 'pending-reflection', markReason: 'expired', markedAt: clock });
    expect((await store.stats()).marked).toBe(1);

    // 裁剪事件含 droppedCount（⑭ 通道）
    const sweepEvent = events.find((e) => e.op === 'sweep' && e.droppedCount === 1);
    expect(sweepEvent?.detail).toMatchObject({ markedExpired: 1, markedOverflow: 0 });
  });

  it('超容量时裁掉最旧、保留最新 capacity 条，原因记 capacity', async () => {
    const store = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      clock += 1000;
      ids.push((await store.add({ layer: 'working', source: 'user-stated', text: `条目 ${i}` })).id);
    }
    const result = await store.sweep({ workingCapacity: 2, workingTtlMs: 365 * DAY });
    expect(result).toMatchObject({ markedExpired: 0, markedOverflow: 2, droppedCount: 2 });
    expect(result.markedIds).toEqual([ids[0], ids[1]]);

    const active = await store.query({ layer: 'working' });
    expect(active.map((e) => e.id).sort()).toEqual([ids[2], ids[3]].sort());
    const marked = await store.listMarkedForReflection();
    expect(marked.map((e) => e.markReason)).toEqual(['capacity', 'capacity']);
  });

  it('未过期且未超容量时 droppedCount=0，事件 applied=false', async () => {
    const store = makeStore();
    await store.add({ layer: 'working', source: 'user-stated', text: '唯一焦点' });
    const result = await store.sweep({ workingCapacity: DEFAULT_WORKING_CAPACITY });
    expect(result.droppedCount).toBe(0);
    expect(events.some((e) => e.op === 'sweep' && e.applied === false)).toBe(true);
  });

  it('仅作用于工作记忆：长期知识过期也不裁剪', async () => {
    const store = makeStore();
    const l = await store.add({ layer: 'long-term', source: 'user-stated', text: '长期偏好' });
    clock += 30 * DAY;
    const result = await store.sweep();
    expect(result.droppedCount).toBe(0);
    expect((await store.list('long-term')).map((e) => e.id)).toEqual([l.id]);
  });

  it('touch 累加 use_count；query touchResults 批量记引用', async () => {
    const store = makeStore();
    const entry = await store.add({ layer: 'working', source: 'user-stated', text: '被引用条目' });
    clock += 100;
    await store.touch(entry.id);
    const [recalled] = await store.query({ text: '引用', touchResults: true });
    expect(recalled.useCount).toBe(2);
    expect(recalled.updatedAt).toBe(clock);
    expect(await store.touch('missing-id')).toBeNull();
  });
});

// ============================================================================
// 边界：空库 / 损坏文件
// ============================================================================

describe('边界容错', () => {
  it('基目录不存在 = 空库，不抛错；add 自动建目录', async () => {
    baseDir = path.join(baseDir, 'not-created-yet');
    const store = makeStore();
    expect(await store.query()).toEqual([]);
    expect(store.getLoadErrors()).toEqual([]);
    const entry = await store.add({ layer: 'working', source: 'user-stated', text: '首条' });
    expect(fs.existsSync(path.join(baseDir, 'working', `${entry.id}.md`))).toBe(true);
  });

  it('损坏文件跳过并登记 loadErrors，其余条目照常装载', async () => {
    const workingDir = path.join(baseDir, 'working');
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'garbage.md'), '这不是 frontmatter');
    fs.writeFileSync(path.join(workingDir, 'no-id.md'), '---\nlayer: working\n---\n\n有正文但缺 id');
    fs.writeFileSync(path.join(workingDir, 'empty.md'), '---\nid: x-1\nlayer: working\n---\n\n');

    const seeded = makeStore();
    const valid = await seeded.add({ layer: 'working', source: 'user-stated', text: '有效条目' });

    const reopened = makeStore();
    const list = await reopened.query();
    expect(list.map((e) => e.id)).toEqual([valid.id]);
    const errors = reopened.getLoadErrors();
    expect(errors.length).toBe(3);
    expect(errors.every((e) => e.file.endsWith('.md') && e.reason.length > 0)).toBe(true);
  });

  it('缺 source 按 inferred 保守装载并登记（不静默提升可信度）', async () => {
    const workingDir = path.join(baseDir, 'working');
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(
      path.join(workingDir, 'legacy.md'),
      '---\nid: legacy-1\nlayer: working\nkind: note\ncreatedAt: 1700000000000\n---\n\n手写旧条目',
    );
    const store = makeStore();
    const [entry] = await store.query();
    expect(entry).toMatchObject({ id: 'legacy-1', source: 'inferred' as MemorySource, useCount: 0, status: 'active' });
    expect(store.getLoadErrors().some((e) => e.reason.includes('source'))).toBe(true);
  });
});
