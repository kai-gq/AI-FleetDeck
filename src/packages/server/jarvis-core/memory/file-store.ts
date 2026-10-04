/**
 * jarvis-core · 记忆层文件实现（任务 27，06-11 §6.1 / §6.2）
 *
 * JARVIS vault 式（任务 20 决策 #5）：一条记忆 = 一个 Markdown 文件
 * （frontmatter 元数据 + 正文），四个子目录对应四层；索引不落盘——打开时
 * 扫描目录构建内存索引，损坏文件跳过并记录（loadErrors），零依赖、不引向量库。
 *
 * 生命周期（⑤.4）：工作记忆过期（默认 7 天）或超容量（默认 40）→ 标记
 * pending-reflection 留给夜间反思（任务 28），**不物理删除**；裁剪返回 droppedCount。
 * 成长日志 append-only（update/delete 默认拒绝，force 仅供用户隐私清除）。
 *
 * 边界：只管秘书个人四层；基目录可注入（测试用临时目录），绝不写死真实路径。
 * 生产基目录由接线尾经 defaultMemoryBaseDir() 或显式参数注入（XDG 数据目录）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import {
  AppendOnlyViolationError,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_WORKING_CAPACITY,
  DEFAULT_WORKING_TTL_MS,
  InferredMemoryRejectedError,
  LAYER_DIRS,
  LONG_TERM_ALLOWED_SOURCES,
  MEMORY_LAYERS,
  assertSourceAllowedForLayer,
  type MemoryAddInput,
  type MemoryEntry,
  type MemoryLayer,
  type MemoryLifecycleStore,
  type MemoryObserver,
  type MemoryQuery,
  type MemorySource,
  type MemoryStatus,
  type MemoryTotals,
  type MemoryUpdatePatch,
  type MarkReason,
  type SweepOptions,
  type SweepResult,
} from './types.js';

// ============================================================================
// 路径与默认值
// ============================================================================

/**
 * 生产基目录（供接线尾使用；不写死，可被显式 baseDir 覆盖）：
 * XDG_DATA_HOME（测试沙箱重定向）优先，否则 ~/.local/share，与 events.db 同规。
 */
export function defaultMemoryBaseDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-memory');
}

export interface FileMemoryStoreOptions {
  /** 四层根目录（注入式；测试传临时目录）。 */
  baseDir: string;
  /** 时钟（epoch ms）；缺省 Date.now（测试显式注入）。 */
  now?: () => number;
  observer?: MemoryObserver;
  logger?: JarvisLogger;
  /** 单条正文上限；缺省 DEFAULT_MAX_TEXT_LENGTH。 */
  maxTextLength?: number;
}

/** 损坏文件登记（打开时跳过，不阻断其余条目）。 */
export interface MemoryLoadError {
  file: string;
  reason: string;
}

interface IndexedEntry {
  entry: MemoryEntry;
  /** 实际文件路径（层目录与 entry.layer 不一致时用于归一化重写）。 */
  file: string;
}

// ============================================================================
// 序列化（零依赖 frontmatter）
// ============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function serializeValue(value: string | number): string {
  // frontmatter 值单行化，避免解析歧义（正文在分隔线之后，不受影响）
  return String(value).replace(/\r?\n/g, ' ');
}

/** 条目 → Markdown 文本（frontmatter + 空行 + 正文）。 */
export function serializeMemoryEntry(entry: MemoryEntry): string {
  const lines: string[] = [
    '---',
    `id: ${serializeValue(entry.id)}`,
    `layer: ${entry.layer}`,
    `source: ${entry.source}`,
    `kind: ${serializeValue(entry.kind)}`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    `useCount: ${entry.useCount}`,
    `status: ${entry.status}`,
  ];
  if (entry.sessionId) lines.push(`sessionId: ${serializeValue(entry.sessionId)}`);
  if (entry.tags && entry.tags.length > 0) lines.push(`tags: ${entry.tags.map((t) => serializeValue(t)).join(', ')}`);
  if (entry.promotedFrom) lines.push(`promotedFrom: ${entry.promotedFrom}`);
  if (entry.markedAt !== undefined) lines.push(`markedAt: ${entry.markedAt}`);
  if (entry.markReason) lines.push(`markReason: ${entry.markReason}`);
  lines.push('---', '', entry.text, '');
  return lines.join('\n');
}

interface ParsedFile {
  meta: Map<string, string>;
  body: string;
}

export function parseMemoryFile(content: string): ParsedFile | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  const meta = new Map<string, string>();
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    meta.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  return { meta, body: m[2].trim() };
}

function isMemoryLayer(value: string | undefined): value is MemoryLayer {
  return value !== undefined && (MEMORY_LAYERS as readonly string[]).includes(value);
}

function isMemorySource(value: string | undefined): value is MemorySource {
  return value === 'user-stated' || value === 'agent-confirmed' || value === 'inferred';
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// ============================================================================
// FileMemoryStore
// ============================================================================

export class FileMemoryStore implements MemoryLifecycleStore {
  readonly baseDir: string;
  private readonly now: () => number;
  private readonly observer: MemoryObserver | undefined;
  private readonly logger: JarvisLogger;
  private readonly maxTextLength: number;
  private readonly index = new Map<string, IndexedEntry>();
  private readonly loadErrors: MemoryLoadError[] = [];
  private loaded = false;

  constructor(options: FileMemoryStoreOptions) {
    if (!options.baseDir || typeof options.baseDir !== 'string') {
      throw new TypeError('FileMemoryStore 必须显式注入 baseDir（禁止写死真实路径）');
    }
    this.baseDir = options.baseDir;
    this.now = options.now ?? Date.now;
    this.observer = options.observer;
    this.logger = options.logger ?? jarvisLogger;
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  }

  // --------------------------------------------------------------------------
  // 装载 / 索引
  // --------------------------------------------------------------------------

  /** 打开时扫描目录；损坏文件跳过并登记，不抛错（⑥ 边界：损坏文件容错）。 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const layer of MEMORY_LAYERS) {
      const dir = this.layerDir(layer);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue; // 目录不存在/不可读 = 空库，正常
      }
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const file = path.join(dir, name);
        this.loadFile(file, layer);
      }
    }
  }

  private loadFile(file: string, dirLayer: MemoryLayer): void {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      this.loadErrors.push({ file, reason: `读取失败: ${String(error)}` });
      return;
    }
    const parsed = parseMemoryFile(content);
    if (!parsed) {
      this.loadErrors.push({ file, reason: '缺少 frontmatter（损坏文件，已跳过）' });
      return;
    }
    if (!parsed.body) {
      this.loadErrors.push({ file, reason: '正文为空（损坏文件，已跳过）' });
      return;
    }
    const id = parsed.meta.get('id');
    if (!id) {
      this.loadErrors.push({ file, reason: '缺少 id（损坏文件，已跳过）' });
      return;
    }
    if (this.index.has(id)) {
      this.loadErrors.push({ file, reason: `id 重复: ${id}（已跳过）` });
      return;
    }
    const rawLayer = parsed.meta.get('layer');
    let layer: MemoryLayer = dirLayer;
    if (isMemoryLayer(rawLayer)) {
      layer = rawLayer;
      if (rawLayer !== dirLayer) {
        this.loadErrors.push({ file, reason: `layer(${rawLayer}) 与目录(${dirLayer}) 不一致，按字段层装载` });
      }
    }
    const rawSource = parsed.meta.get('source');
    const source: MemorySource = isMemorySource(rawSource) ? rawSource : 'inferred';
    if (!isMemorySource(rawSource)) {
      // 保守缺省 inferred（最不可信来源），避免手滑文件被当作事实 promote
      this.loadErrors.push({ file, reason: '缺少/非法 source，按 inferred 装载（保守缺省）' });
    }
    const createdAt = toInt(parsed.meta.get('createdAt')) ?? this.fileMtime(file);
    const updatedAt = toInt(parsed.meta.get('updatedAt')) ?? createdAt;
    const status: MemoryStatus = parsed.meta.get('status') === 'pending-reflection' ? 'pending-reflection' : 'active';
    const tagsRaw = parsed.meta.get('tags');
    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const entry: MemoryEntry = {
      id,
      layer,
      source,
      kind: parsed.meta.get('kind') || 'note',
      text: parsed.body.slice(0, this.maxTextLength),
      createdAt,
      updatedAt,
      useCount: Math.max(0, toInt(parsed.meta.get('useCount')) ?? 0),
      status,
      sessionId: parsed.meta.get('sessionId') || undefined,
      tags,
      promotedFrom: isMemoryLayer(parsed.meta.get('promotedFrom')) ? (parsed.meta.get('promotedFrom') as MemoryLayer) : undefined,
      markedAt: toInt(parsed.meta.get('markedAt')),
      markReason: parsed.meta.get('markReason') === 'expired' || parsed.meta.get('markReason') === 'capacity'
        ? (parsed.meta.get('markReason') as MarkReason)
        : undefined,
    };
    this.index.set(id, { entry, file });
  }

  private fileMtime(file: string): number {
    try {
      return Math.trunc(fs.statSync(file).mtimeMs);
    } catch {
      return this.now();
    }
  }

  /** 重新扫描（外部手改 vault 文件后调用；清空内存索引重装）。 */
  rebuildIndex(): void {
    this.index.clear();
    this.loadErrors.length = 0;
    this.loaded = false;
    this.ensureLoaded();
  }

  /** 打开时的损坏文件登记（诊断用；为空 = 全绿）。 */
  getLoadErrors(): readonly MemoryLoadError[] {
    this.ensureLoaded();
    return [...this.loadErrors];
  }

  private layerDir(layer: MemoryLayer): string {
    return path.join(this.baseDir, LAYER_DIRS[layer]);
  }

  private filePathFor(entry: MemoryEntry): string {
    return path.join(this.layerDir(entry.layer), `${entry.id}.md`);
  }

  /** 原子落盘（tmp + rename），与 voice-companion-service 的写状态同型。 */
  private persist(entry: MemoryEntry, previousFile?: string): void {
    const file = this.filePathFor(entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serializeMemoryEntry(entry), 'utf-8');
    fs.renameSync(tmp, file);
    if (previousFile && path.resolve(previousFile) !== path.resolve(file)) {
      try {
        fs.rmSync(previousFile, { force: true });
      } catch (error) {
        this.logger.warn(`[MemoryStore] 旧文件清理失败（已忽略）: ${previousFile}`, error);
      }
    }
    this.index.set(entry.id, { entry, file });
  }

  private totals(): MemoryTotals {
    const byLayer: Record<MemoryLayer, number> = { working: 0, 'long-term': 0, 'growth-log': 0, reflections: 0 };
    let active = 0;
    let marked = 0;
    for (const { entry } of this.index.values()) {
      if (entry.status === 'active') {
        active += 1;
        byLayer[entry.layer] += 1;
      } else {
        marked += 1;
      }
    }
    return { active, marked, byLayer };
  }

  /** 观测出口自身异常不影响主链路（对齐 executors.emit）。 */
  private emit(event: Parameters<MemoryObserver>[0]): void {
    if (!this.observer) return;
    try {
      this.observer(event);
    } catch (error) {
      this.logger.warn(`[MemoryStore] 观测出口 ${event.op} 抛错（已忽略）`, error);
    }
  }

  private normalizeText(text: string): string {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  private requireEntry(id: string): IndexedEntry | undefined {
    this.ensureLoaded();
    return this.index.get(id);
  }

  // --------------------------------------------------------------------------
  // 核心六方法
  // --------------------------------------------------------------------------

  async add(input: MemoryAddInput): Promise<MemoryEntry> {
    this.ensureLoaded();
    assertSourceAllowedForLayer(input.layer, input.source);
    const text = (input.text ?? '').trim();
    if (!text) throw new TypeError('记忆文本不能为空');
    const at = input.at ?? this.now();
    const clipped = text.slice(0, this.maxTextLength);

    if (input.dedupe !== false) {
      const normalized = this.normalizeText(clipped);
      for (const { entry, file } of this.index.values()) {
        if (entry.layer !== input.layer || entry.status !== 'active') continue;
        if (this.normalizeText(entry.text) !== normalized) continue;
        // 重复陈述 = 当前焦点的再确认：刷新 updatedAt（不增 useCount），返回既有条目
        const touched = { ...entry, updatedAt: at };
        this.persist(touched, file);
        this.emit({
          op: 'add',
          applied: false,
          reason: 'duplicate',
          at,
          layer: input.layer,
          source: entry.source,
          entryId: entry.id,
          sessionId: input.sessionId,
          totals: this.totals(),
        });
        return { ...touched };
      }
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      layer: input.layer,
      source: input.source,
      kind: input.kind ?? 'note',
      text: clipped,
      createdAt: at,
      updatedAt: at,
      useCount: 0,
      status: 'active',
      sessionId: input.sessionId,
      tags: input.tags && input.tags.length > 0 ? [...input.tags] : undefined,
    };
    this.persist(entry);
    this.emit({
      op: 'add',
      applied: true,
      at,
      layer: entry.layer,
      source: entry.source,
      entryId: entry.id,
      sessionId: entry.sessionId,
      totals: this.totals(),
    });
    return { ...entry };
  }

  async update(id: string, patch: MemoryUpdatePatch, opts: { force?: boolean } = {}): Promise<MemoryEntry | null> {
    const found = this.requireEntry(id);
    if (!found) return null;
    if (found.entry.layer === 'growth-log' && !opts.force) {
      throw new AppendOnlyViolationError('update', id);
    }
    const next: MemoryEntry = { ...found.entry };
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      if (!text) throw new TypeError('记忆文本不能为空');
      next.text = text.slice(0, this.maxTextLength);
    }
    if (patch.source !== undefined) {
      assertSourceAllowedForLayer(next.layer, patch.source);
      next.source = patch.source;
    }
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.tags !== undefined) next.tags = patch.tags.length > 0 ? [...patch.tags] : undefined;
    if (patch.status !== undefined) next.status = patch.status;
    next.updatedAt = this.now();
    this.persist(next, found.file);
    this.emit({
      op: 'update',
      applied: true,
      at: next.updatedAt,
      layer: next.layer,
      source: next.source,
      entryId: id,
      sessionId: next.sessionId,
      totals: this.totals(),
    });
    return { ...next };
  }

  async delete(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const found = this.requireEntry(id);
    if (!found) return false;
    if (found.entry.layer === 'growth-log' && !opts.force) {
      throw new AppendOnlyViolationError('delete', id);
    }
    try {
      fs.rmSync(found.file, { force: true });
    } catch (error) {
      this.logger.warn(`[MemoryStore] 删除文件失败: ${found.file}`, error);
      throw error;
    }
    this.index.delete(id);
    this.emit({
      op: 'delete',
      applied: true,
      at: this.now(),
      layer: found.entry.layer,
      source: found.entry.source,
      entryId: id,
      sessionId: found.entry.sessionId,
      totals: this.totals(),
    });
    return true;
  }

  /**
   * 提升到 target（默认长期知识）。两道硬闸门：
   * 1. 成长日志 append-only——promote 会移动文件（等于从日志移除），拒绝；
   *    夜间反思应新建派生条目（add）而不是搬走证据。
   * 2. 来源分层（§11.3 / ⑥.4）：inferred 一律拒收（InferredMemoryRejectedError）。
   */
  async promote(id: string, target: MemoryLayer = 'long-term'): Promise<MemoryEntry | null> {
    const found = this.requireEntry(id);
    if (!found) return null;
    if (found.entry.layer === 'growth-log') {
      throw new AppendOnlyViolationError('promote', id);
    }
    if (found.entry.source === 'inferred') {
      throw new InferredMemoryRejectedError('promote', target, found.entry.source);
    }
    if (target === 'long-term' && !LONG_TERM_ALLOWED_SOURCES.includes(found.entry.source)) {
      throw new InferredMemoryRejectedError('promote', target, found.entry.source);
    }
    if (found.entry.layer === target) {
      this.emit({
        op: 'promote',
        applied: false,
        reason: 'already-in-target',
        at: this.now(),
        layer: target,
        source: found.entry.source,
        entryId: id,
        sessionId: found.entry.sessionId,
        totals: this.totals(),
      });
      return { ...found.entry };
    }
    const next: MemoryEntry = {
      ...found.entry,
      layer: target,
      promotedFrom: found.entry.layer,
      updatedAt: this.now(),
    };
    this.persist(next, found.file);
    this.emit({
      op: 'promote',
      applied: true,
      at: next.updatedAt,
      layer: target,
      source: next.source,
      entryId: id,
      sessionId: next.sessionId,
      totals: this.totals(),
    });
    return { ...next };
  }

  async query(q: MemoryQuery = {}): Promise<MemoryEntry[]> {
    this.ensureLoaded();
    const layers = q.layer === undefined ? undefined : Array.isArray(q.layer) ? q.layer : [q.layer as MemoryLayer];
    const status = q.status ?? 'active';
    const needle = q.text ? q.text.trim().toLowerCase() : undefined;
    const out: MemoryEntry[] = [];
    for (const { entry } of this.index.values()) {
      if (layers && !layers.includes(entry.layer)) continue;
      if (status !== 'any' && entry.status !== status) continue;
      if (q.source !== undefined && entry.source !== q.source) continue;
      if (q.kind !== undefined && entry.kind !== q.kind) continue;
      if (q.sessionId !== undefined && entry.sessionId !== q.sessionId) continue;
      if (needle && !entry.text.toLowerCase().includes(needle)) continue;
      out.push(entry);
    }
    out.sort((a, b) => (q.order === 'asc' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
    const limited = q.limit !== undefined ? out.slice(0, Math.max(0, q.limit)) : out;
    if (q.touchResults) {
      for (const entry of limited) await this.touch(entry.id);
    }
    // touch 会替换索引对象：返回时从索引取最新态，避免 useCount 陈旧
    return limited.map((e) => ({ ...(this.index.get(e.id)?.entry ?? e) }));
  }

  async list(layer?: MemoryLayer): Promise<MemoryEntry[]> {
    return this.query(layer ? { layer } : {});
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  async touch(id: string): Promise<MemoryEntry | null> {
    const found = this.requireEntry(id);
    if (!found) return null;
    const at = this.now();
    const next: MemoryEntry = { ...found.entry, useCount: found.entry.useCount + 1, updatedAt: at };
    this.persist(next, found.file);
    this.emit({
      op: 'touch',
      applied: true,
      at,
      layer: next.layer,
      source: next.source,
      entryId: id,
      sessionId: next.sessionId,
      totals: this.totals(),
    });
    return { ...next };
  }

  /**
   * 工作记忆裁剪（⑤.4）：过期（updatedAt 早于 ttl）或超出容量（保留最新 capacity 条）
   * → 标记 pending-reflection（不物理删除，任务 28 提炼），返回 droppedCount。
   */
  async sweep(opts: SweepOptions = {}): Promise<SweepResult> {
    this.ensureLoaded();
    const now = opts.now ?? this.now();
    const ttl = opts.workingTtlMs ?? DEFAULT_WORKING_TTL_MS;
    const capacity = Math.max(0, opts.workingCapacity ?? DEFAULT_WORKING_CAPACITY);
    const active = [...this.index.values()]
      .map((v) => v.entry)
      .filter((e) => e.layer === 'working' && e.status === 'active');

    const expired = active.filter((e) => now - e.updatedAt >= ttl);
    const expiredIds = new Set(expired.map((e) => e.id));
    const candidates = active.filter((e) => !expiredIds.has(e.id)).sort((a, b) => a.updatedAt - b.updatedAt);
    const overflow = candidates.slice(0, Math.max(0, candidates.length - capacity));

    const marked: Array<{ entry: MemoryEntry; reason: MarkReason }> = [
      ...expired.map((entry) => ({ entry, reason: 'expired' as const })),
      ...overflow.map((entry) => ({ entry, reason: 'capacity' as const })),
    ];
    for (const { entry, reason } of marked) {
      const found = this.index.get(entry.id);
      if (!found) continue;
      const next: MemoryEntry = {
        ...entry,
        status: 'pending-reflection',
        markedAt: now,
        markReason: reason,
      };
      this.persist(next, found.file);
    }
    const result: SweepResult = {
      markedExpired: expired.length,
      markedOverflow: overflow.length,
      droppedCount: marked.length,
      markedIds: marked.map((m) => m.entry.id),
      totals: this.totals(),
    };
    this.emit({
      op: 'sweep',
      applied: marked.length > 0,
      at: now,
      layer: 'working',
      droppedCount: result.droppedCount,
      detail: { markedExpired: result.markedExpired, markedOverflow: result.markedOverflow },
      totals: result.totals,
    });
    return result;
  }

  async listMarkedForReflection(): Promise<MemoryEntry[]> {
    this.ensureLoaded();
    return [...this.index.values()]
      .map((v) => v.entry)
      .filter((e) => e.status === 'pending-reflection')
      .sort((a, b) => (a.markedAt ?? a.updatedAt) - (b.markedAt ?? b.updatedAt))
      .map((e) => ({ ...e }));
  }

  async stats(): Promise<MemoryTotals> {
    this.ensureLoaded();
    return this.totals();
  }
}
