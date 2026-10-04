/**
 * jarvis-core/memory · 写入引擎单测（任务 27 ⑤.3/⑤.5、⑥.2/⑥.3/⑥.4）
 *
 * 覆盖：触发词扫描矩阵（命中 / 不误报）、来源分层、先写后回应时序
 * （gated store：store.add 未完成前 capture 不 resolve）、写失败降级、
 * 会话摘要、vcs memoryOps 桥接、裁剪委托。基目录一律临时目录。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FileMemoryStore,
  MemoryWriteEngine,
  scanTriggers,
  triggerKinds,
  type MemoryAddInput,
  type MemoryEntry,
  type MemoryLifecycleStore,
  type MemoryOpEvent,
  type MemoryTotals,
  type SweepResult,
  type TriggerHit,
} from './index.js';

// ============================================================================
// 触发词扫描矩阵
// ============================================================================

function kindsOf(text: string): string[] {
  return triggerKinds(scanTriggers(text));
}

describe('触发词扫描矩阵：命中', () => {
  it.each([
    ['不是这样的，我是说用 pnpm', 'correction'],
    ['不对，重新来', 'correction'],
    ['你记错了，我说的是周三', 'correction'],
    ['我喜欢用 pnpm', 'preference'],
    ['以后都用中文回答我', 'preference'],
    ['记住我周三下午有例会', 'preference'],
    ['行，就这么定了', 'decision'],
    ['最终用 Mem0 方案', 'decision'],
    ['决定走 sonnet', 'decision'],
    ['工作记忆 7 天过期', 'numeric'],
    ['阈值是 60', 'numeric'],
    ['80% 就行', 'numeric'],
    ['最多 3 个 agent', 'numeric'],
    ['项目叫 tide-commander', 'proper-noun'],
    ['把「潮汐指挥官」记下来', 'proper-noun'],
    ['Claude 的配置在哪', 'proper-noun'],
  ] as const)('「%s」命中 %s', (text, kind) => {
    expect(kindsOf(text)).toContain(kind);
  });

  it('命中带位置与命中文本（供观测/调试）', () => {
    const hits: TriggerHit[] = scanTriggers('工作记忆 7 天过期');
    expect(hits).toEqual([{ kind: 'numeric', text: '7 天', index: 5 }]);
  });

  it('规则顺序 = 优先级：多信号时主 kind 取纠正', () => {
    const hits = scanTriggers('不对，阈值是 60');
    expect(hits[0].kind).toBe('correction');
    expect(triggerKinds(hits)).toEqual(['correction', 'numeric']);
  });
});

describe('触发词扫描矩阵：不误报', () => {
  it.each([
    '好的，我知道了',
    '帮我看看构建为什么挂了',
    '这个功能什么时候能做完？',
    '这个方案是不是更好？',
    '这个方案对不对？',
    '这叫什么？',
    '他不在办公室',
    '先这样吧',
    '我还没决定',
    '这个数字是 42',
    '把文件放到 D 盘',
    '今天几号？',
  ])('普通话语「%s」不命中任何规则', (text) => {
    expect(scanTriggers(text)).toEqual([]);
  });

  it('空文本/空白不命中', () => {
    expect(scanTriggers('')).toEqual([]);
    expect(scanTriggers('   ')).toEqual([]);
  });

  it('命中数量受 maxHits 截断', () => {
    const hits = scanTriggers('记住：阈值是 60，最多 3 个，超时 30 秒，80% 就行', { maxHits: 2 });
    expect(hits).toHaveLength(2);
  });
});

// ============================================================================
// 夹具：可控 gate store（证明「先写后回应」的等待语义）
// ============================================================================

function totals0(): MemoryTotals {
  return { active: 0, marked: 0, byLayer: { working: 0, 'long-term': 0, 'growth-log': 0, reflections: 0 } };
}

class GatedStore implements MemoryLifecycleStore {
  readonly addCalls: MemoryAddInput[] = [];
  private releaseGate: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate();
  }

  async add(input: MemoryAddInput): Promise<MemoryEntry> {
    this.addCalls.push(input);
    await this.gate;
    const at = input.at ?? 0;
    return {
      id: 'gated-1', layer: input.layer, source: input.source, kind: input.kind ?? 'note', text: input.text,
      createdAt: at, updatedAt: at, useCount: 0, status: 'active', tags: input.tags, sessionId: input.sessionId,
    };
  }

  async update(): Promise<MemoryEntry | null> { return null; }
  async delete(): Promise<boolean> { return false; }
  async promote(): Promise<MemoryEntry | null> { return null; }
  async query(): Promise<MemoryEntry[]> { return []; }
  async list(): Promise<MemoryEntry[]> { return []; }
  async touch(): Promise<MemoryEntry | null> { return null; }
  async sweep(): Promise<SweepResult> {
    return { markedExpired: 0, markedOverflow: 0, droppedCount: 0, markedIds: [], totals: totals0() };
  }
  async listMarkedForReflection(): Promise<MemoryEntry[]> { return []; }
  async stats(): Promise<MemoryTotals> { return totals0(); }
}

class FailingStore extends GatedStore {
  constructor(private readonly message: string) {
    super();
  }

  override async add(input: MemoryAddInput): Promise<MemoryEntry> {
    this.addCalls.push(input);
    throw new Error(this.message);
  }
}

// ============================================================================
// 引擎行为
// ============================================================================

let baseDir = '';
let clock = 1_700_000_000_000;
const events: MemoryOpEvent[] = [];

function makeEngine(store: MemoryLifecycleStore): MemoryWriteEngine {
  return new MemoryWriteEngine({ store, now: () => clock, observer: (ev) => events.push(ev) });
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-engine-'));
  clock = 1_700_000_000_000;
  events.length = 0;
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('先写后回应时序', () => {
  it('store.add 未完成前 capture 不 resolve（调用方 await 后才可回应）', async () => {
    const store = new GatedStore();
    const engine = makeEngine(store);
    let replied = false;
    const pending = engine.captureUserTurn('不是这样的，我是说用 pnpm', { sessionId: 's1' }).then((result) => {
      replied = true;
      return result;
    });

    await Promise.resolve(); // 让引擎推进到 await store.add
    expect(store.addCalls).toHaveLength(1);
    expect(store.addCalls[0]).toMatchObject({ layer: 'working', source: 'user-stated', kind: 'correction', sessionId: 's1' });
    expect(replied).toBe(false); // 写未完成 → 不能继续回应

    store.release();
    const result = await pending;
    expect(replied).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('文件实现：await capture 后条目已落盘（先写后回应可验证）', async () => {
    const store = new FileMemoryStore({ baseDir, now: () => clock });
    const engine = makeEngine(store);
    const result = await engine.captureUserTurn('记住：以后都用中文回答我', { sessionId: 's2' });
    expect(result.hits.map((h) => h.kind)).toContain('preference');
    const [entry] = result.entries;
    expect(entry).toMatchObject({ layer: 'working', source: 'user-stated', kind: 'preference', sessionId: 's2' });
    expect(fs.existsSync(path.join(baseDir, 'working', `${entry.id}.md`))).toBe(true);

    // 重复陈述去重，不产生第二条
    const again = await engine.captureUserTurn('记住：以后都用中文回答我', { sessionId: 's2' });
    expect(again.entries[0].id).toBe(entry.id);
    expect(await store.list('working')).toHaveLength(1);
  });

  it('无触发词不落盘、不产生 capture 事件', async () => {
    const store = new FileMemoryStore({ baseDir, now: () => clock });
    const engine = makeEngine(store);
    const result = await engine.captureUserTurn('帮我看看构建日志', { sessionId: 's3' });
    expect(result).toEqual({ entries: [], hits: [], skipped: 0, errors: [] });
    expect(await store.list('working')).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('来源分层', () => {
  it('captureInferred 只写工作记忆 inferred 候选，标注 candidate', async () => {
    const store = new FileMemoryStore({ baseDir, now: () => clock });
    const engine = makeEngine(store);
    const entry = await engine.captureInferred('推测：用户可能想先看晨报', { sessionId: 's4' });
    expect(entry).toMatchObject({ layer: 'working', source: 'inferred', kind: 'inferred', tags: ['candidate'] });
    expect(await store.list('long-term')).toEqual([]);
  });

  it('captureAgentConfirmed 写 agent-confirmed；推断候选不可 promote 到长期知识', async () => {
    const store = new FileMemoryStore({ baseDir, now: () => clock });
    const engine = makeEngine(store);
    const confirmed = await engine.captureAgentConfirmed('用户确认超时改 30 秒', { sessionId: 's5' });
    expect(confirmed.entries[0]).toMatchObject({ source: 'agent-confirmed', kind: 'numeric' });
    await expect(store.promote(confirmed.entries[0].id)).resolves.toMatchObject({ layer: 'long-term' });

    const inferred = await engine.captureInferred('推测候选', {});
    await expect(store.promote(inferred!.id)).rejects.toThrow('inferred');
  });
});

describe('降级：写失败不阻断回应', () => {
  it('store.add 抛错时 capture 正常 resolve，错误进 errors 且观测 reason=error', async () => {
    const engine = makeEngine(new FailingStore('disk full'));
    const result = await engine.captureUserTurn('记住我喜欢 pnpm', { sessionId: 's6' });
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual(['disk full']);
    expect(events.some((e) => e.op === 'capture' && e.applied === false && e.reason === 'error')).toBe(true);
  });
});

describe('会话摘要与 vcs memoryOps 桥接', () => {
  it('summarizeSession 写 agent-confirmed 工作记忆；空摘要不写', async () => {
    const store = new FileMemoryStore({ baseDir, now: () => clock });
    const engine = makeEngine(store);
    const entry = await engine.summarizeSession({ sessionId: 's7', summary: '本会话敲定了记忆层四层方案' });
    expect(entry).toMatchObject({ layer: 'working', source: 'agent-confirmed', kind: 'session-summary' });
    expect(await engine.summarizeSession({ sessionId: 's7', summary: '   ' })).toBeNull();
  });

  it('bridgeVoiceMemoryOps：add → agent-note；setSummary → 摘要；remove 跳过（id 空间不同）', async () => {
    const store = new FileMemoryStore({ baseDir, now: () => clock });
    const engine = makeEngine(store);
    const result = await engine.bridgeVoiceMemoryOps(
      [
        { op: 'add', text: '用户希望播报简短' },
        { op: 'setSummary', summary: '在聊记忆层接线' },
        { op: 'remove', id: 'vc-note-1' },
        { op: 'add', text: '' },
      ],
      { sessionId: 's8' },
    );
    expect(result.entries.map((e) => e.kind)).toEqual(['agent-note', 'session-summary']);
    expect(result.skipped).toBe(2);
    expect(result.errors).toEqual([]);
    expect((await store.list('working')).map((e) => e.source)).toEqual(['agent-confirmed', 'agent-confirmed']);
  });

  it('sweep 委托 store 并透传 droppedCount', async () => {
    const store = new FileMemoryStore({ baseDir, now: () => clock });
    const engine = makeEngine(store);
    await store.add({ layer: 'working', source: 'user-stated', text: '第一条' });
    clock += 8 * 24 * 60 * 60 * 1000;
    await store.add({ layer: 'working', source: 'user-stated', text: '第二条' });
    const result = await engine.sweep();
    expect(result).toMatchObject({ markedExpired: 1, droppedCount: 1 });
  });
});
