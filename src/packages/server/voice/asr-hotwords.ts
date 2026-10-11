/**
 * ASR 热词库(hotwords.local.json)
 *
 * 语音伙伴「热词」的本地存储 + 火山流式 ASR 的注入源:
 *   - 存储:<cwd>/tools/voice-companion/hotwords.local.json(gitignored;
 *     TC_VOICE_HOTWORDS_SOURCE 可覆盖,测试沙箱用);
 *   - 注入:VolcengineAsrSession 建会话时取「有效词表」的注入窗口
 *     (默认 50,见 INJECT_TOP_N)→ request.corpus.context;
 *   - 有效词表(唯一口径,见 buildEffectiveWords)= agent 名(实时来自
 *     agent-service,锁定、必进注入窗口)+ 文件池(manual/agent);
 *     同名以 agent 名层为准,池内重复条目不参与注入;
 *   - 合并:增量合并 —— 手动词 weight 永不被 AI 覆盖;blocked 词永不回归;
 *     池上限 200,溢出先挤 agent 侧弱词(lastSeenAt 最老、weight 最低)。
 *
 * 文件缺失/损坏一律按空表处理(热词是加成,永不阻断识别链路)。
 */

import fs from 'node:fs';
import path from 'node:path';

export const HOTWORDS_SOURCE_ENV = 'TC_VOICE_HOTWORDS_SOURCE';
/** 注入窗口覆写(校准/排障用;缺省 = INJECT_TOP_N,硬锁上限 60)。 */
export const HOTWORDS_TOPN_ENV = 'TC_VOICE_HOTWORDS_TOPN';
const HOTWORDS_REL_PATH = path.join('tools', 'voice-companion', 'hotwords.local.json');

/**
 * 注入窗口(硬锁在 40~60,2026-10-07 定):
 * 双向流式内联热词上文 Doc 上限 100 tokens;超过后靠后的词直接失效、
 * 还会污染基础识别 —— 40~60 条是可用的安全区,取 50 为默认。
 * 池内词多于窗口时按注入优先级取前 N(见 pickInjectionWords)。
 */
export const INJECT_TOP_N = 50;
const INJECT_TOP_N_MAX = 60;

/** 注入窗口:环境覆写优先(数值夹取 1..60,硬锁);非法值回默认。 */
export function resolveInjectTopN(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env[HOTWORDS_TOPN_ENV] ?? '').trim());
  if (!Number.isFinite(n) || n < 1) return INJECT_TOP_N;
  return Math.min(INJECT_TOP_N_MAX, Math.floor(n));
}
/** 蓄水池上限:满了挤弱(先 agent 后 manual)。 */
export const POOL_CAP = 200;
/** 屏蔽名单上限。 */
export const BLOCKED_CAP = 200;
/** 默认权重(手动词 / 模型未给时)。 */
export const DEFAULT_WEIGHT = 6;

export interface HotwordEntry {
  word: string;
  /** 1..10;排序权重(手动词不被 AI 覆盖)。 */
  weight: number;
  /** 累计出现次数(代码统计,不信模型自报)。 */
  count: number;
  source: 'agent' | 'manual';
  addedAt: string;
  lastSeenAt: string;
}

export interface HotwordsFile {
  /** 上次分析读到的最大消息时间(ISO);null = 尚未分析过。 */
  lastAnalyzedAt: string | null;
  /** 面板删除 = 拉黑,管家未来输出命中即丢弃。 */
  blocked: string[];
  words: HotwordEntry[];
}

export interface HotwordCandidate {
  word: string;
  weight: number;
  count: number;
}

/** 词来源:文件池(manual/agent)+ 锁定层(agent-name,不落文件)。 */
export type WordSource = 'agent' | 'manual' | 'agent-name';

/** 参与注入排序的词(有效词表元素)。 */
export interface InjectionWord {
  word: string;
  weight: number;
  count: number;
  source: WordSource;
  /** 动态词才有;锁定层为 ''。 */
  lastSeenAt: string;
}

/** agent 名注入层权重(仅参与排序;agent 名不落文件)。 */
export const AGENT_NAME_WEIGHT = 10;

// ---------------------------------------------------------------------------
// agent 名提供者(agent-hotword-sync 注册;asr-hotwords 不依赖 agent-service,
// 避免循环依赖;provider 缺失/抛错一律回空表 —— 热词永不阻断识别链路)
// ---------------------------------------------------------------------------

let agentNamesProvider: (() => readonly string[]) | null = null;

export function setAgentNamesProvider(fn: (() => readonly string[]) | null): void {
  agentNamesProvider = fn;
}

/** 当前 agent 名(实时快照,零缓存;provider 异常 → 空)。 */
export function getAgentNames(): string[] {
  try {
    const names = agentNamesProvider?.() ?? [];
    return names.map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
  } catch {
    return [];
  }
}

export interface EffectiveWordsOptions {
  /** 测试注入用;缺省 = 实时 agent 名(getAgentNames)。 */
  agentNames?: readonly string[];
}

/**
 * 有效词表(注入与面板展示的唯一口径),按层合并、忽略大小写去重:
 *   agent 名(锁定,权重 10,必进注入窗口)→ 文件池(manual/agent)。
 * 同词只保留优先级最高的一层;池内重复条目在去重时被丢弃(不参与注入),
 * 由 stripLockedDuplicates 负责从文件池清走。
 */
export function buildEffectiveWords(
  file: HotwordsFile,
  opts: EffectiveWordsOptions = {},
): InjectionWord[] {
  const agentNames = opts.agentNames ?? getAgentNames();
  const out: InjectionWord[] = [];
  const seen = new Set<string>();
  const push = (word: string, weight: number, source: WordSource, count = 0, lastSeenAt = ''): void => {
    const w = word.trim();
    const key = w.toLowerCase();
    if (!w || seen.has(key)) return;
    seen.add(key);
    out.push({ word: w, weight, count, source, lastSeenAt });
  };
  for (const name of agentNames) push(name, AGENT_NAME_WEIGHT, 'agent-name');
  for (const e of file.words) push(e.word, e.weight, e.source, e.count, e.lastSeenAt);
  return out;
}

/**
 * 清池:移除文件池里与锁定层(agent 名)重复的条目 —— 有效词表去重时
 * agent 名赢,留着只占池位并让面板重复。不拉黑(agent 名仍在注入)。
 * 原地修改;返回移除条数。
 */
export function stripLockedDuplicates(file: HotwordsFile, opts: EffectiveWordsOptions = {}): number {
  const agentNames = opts.agentNames ?? getAgentNames();
  const locked = new Set<string>();
  for (const n of agentNames) locked.add(n.trim().toLowerCase());
  const before = file.words.length;
  file.words = file.words.filter((e) => !locked.has(e.word.trim().toLowerCase()));
  return before - file.words.length;
}

export function emptyHotwordsFile(): HotwordsFile {
  return { lastAnalyzedAt: null, blocked: [], words: [] };
}

export function resolveHotwordsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[HOTWORDS_SOURCE_ENV] ?? '').trim();
  return override || path.join(process.cwd(), HOTWORDS_REL_PATH);
}

export function clampWeight(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_WEIGHT;
  return Math.min(10, Math.max(1, n));
}

function clampCount(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.min(1_000_000, Math.max(0, n));
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** 宽松清洗:垃圾字段忽略,永不抛(读取与测试共用)。 */
export function sanitizeHotwordsFile(raw: unknown): HotwordsFile {
  const out = emptyHotwordsFile();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  out.lastAnalyzedAt = isoOrNull(obj.lastAnalyzedAt);

  if (Array.isArray(obj.blocked)) {
    const seen = new Set<string>();
    for (const b of obj.blocked) {
      if (typeof b !== 'string') continue;
      const w = b.trim();
      const key = w.toLowerCase();
      if (!w || seen.has(key)) continue;
      seen.add(key);
      out.blocked.push(w);
      if (out.blocked.length >= BLOCKED_CAP) break;
    }
  }

  if (Array.isArray(obj.words)) {
    const seen = new Set<string>();
    for (const w of obj.words) {
      if (!w || typeof w !== 'object') continue;
      const e = w as Record<string, unknown>;
      const word = typeof e.word === 'string' ? e.word.trim() : '';
      if (!word || word.length > 40) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const addedAt = isoOrNull(e.addedAt) ?? new Date(0).toISOString();
      out.words.push({
        word,
        weight: clampWeight(e.weight),
        count: clampCount(e.count),
        source: e.source === 'manual' ? 'manual' : 'agent',
        addedAt,
        lastSeenAt: isoOrNull(e.lastSeenAt) ?? addedAt,
      });
    }
  }
  return out;
}

export interface HotwordsReadResult {
  file: HotwordsFile;
  path: string;
  existed: boolean;
}

/** 读取(缺失/损坏 → 空表);existed 供面板区分「没有文件」与「空文件」。 */
export function readHotwordsFile(env: NodeJS.ProcessEnv = process.env): HotwordsReadResult {
  const filePath = resolveHotwordsPath(env);
  let raw: unknown = null;
  let existed = false;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    existed = true;
  } catch {
    existed = fs.existsSync(filePath);
  }
  return { file: sanitizeHotwordsFile(raw), path: filePath, existed };
}

/** 原子写(tmp+rename,与 voice-companion state 同惯例)。 */
export function writeHotwordsFile(file: HotwordsFile, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = resolveHotwordsPath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** 忽略大小写的子串出现计数(非重叠)。 */
export function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystackLower.indexOf(needleLower, i)) !== -1) {
    count += 1;
    i += needleLower.length;
  }
  return count;
}

export interface MergeStats {
  added: number;
  updated: number;
  skippedBlocked: number;
}

/**
 * 增量合并(原地修改 file,返回统计):
 *   - blocked 命中 → 直接丢弃;
 *   - 已有词:lastSeenAt 刷新;agent 词 weight 取最新,manual 词 weight 不动
 *     (count 由 touchSeenWords 统一统计,此处不重复累加);
 *   - 新词按 agent 入库,count = 本批出现数。
 */
export function mergeCandidates(
  file: HotwordsFile,
  candidates: readonly HotwordCandidate[],
  nowIso: string,
): MergeStats {
  const stats: MergeStats = { added: 0, updated: 0, skippedBlocked: 0 };
  const blocked = new Set(file.blocked.map((w) => w.toLowerCase()));
  const byKey = new Map(file.words.map((e) => [e.word.toLowerCase(), e] as const));

  for (const c of candidates) {
    const word = (c.word ?? '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (blocked.has(key)) {
      stats.skippedBlocked += 1;
      continue;
    }
    const count = Math.max(1, clampCount(c.count));
    const weight = clampWeight(c.weight);
    const existing = byKey.get(key);
    if (existing) {
      // count 由 touchSeenWords 统一统计(本批提及只算一次),此处不重复累加。
      existing.lastSeenAt = nowIso;
      if (existing.source === 'agent') existing.weight = weight;
      stats.updated += 1;
    } else {
      const entry: HotwordEntry = {
        word,
        weight,
        count,
        source: 'agent',
        addedAt: nowIso,
        lastSeenAt: nowIso,
      };
      file.words.push(entry);
      byKey.set(key, entry);
      stats.added += 1;
    }
  }
  return stats;
}

/** 提及刷新:已有词在本批对话里出现 → count 累加、lastSeenAt 刷新(weight 不动)。原地修改,返回被刷新词数。 */
export function touchSeenWords(file: HotwordsFile, dialogueText: string, nowIso: string): number {
  const hay = dialogueText.toLowerCase();
  let touched = 0;
  for (const e of file.words) {
    const n = countOccurrences(hay, e.word.toLowerCase());
    if (n > 0) {
      e.count += n;
      e.lastSeenAt = nowIso;
      touched += 1;
    }
  }
  return touched;
}

/** 池超限:从弱到强挤(manual 最后;组内 weight 低 → lastSeenAt 老)。原地修改,返回淘汰数。 */
export function evictToCap(file: HotwordsFile, cap: number = POOL_CAP): number {
  if (file.words.length <= cap) return 0;
  const rank = (e: HotwordEntry): [number, number, number] => [
    e.source === 'manual' ? 1 : 0,
    e.weight,
    Date.parse(e.lastSeenAt) || 0,
  ];
  const sorted = [...file.words].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    return ra[2] - rb[2];
  });
  const dropSet = new Set(sorted.slice(0, file.words.length - cap));
  file.words = file.words.filter((e) => !dropSet.has(e));
  return dropSet.size;
}

/**
 * 注入优先级层次(窗口有上限,层次决定谁进):
 *   0 agent 名(语音指挥要喊名字,必进)
 *   1 手动(面板显式添加 = 用户意图,必进)
 *   2 动态池(按权重排,再按提及次数/新鲜度)
 * 层内:权重降序 → 提及次数降序 → lastSeenAt 新者优先 → 词序。
 */
const SOURCE_TIER: Record<WordSource, number> = {
  'agent-name': 0,
  manual: 1,
  agent: 2,
};

/** 注入窗口:按层次+权重的优先级排序,取前 n(默认 INJECT_TOP_N)。 */
export function pickInjectionWords(
  words: readonly InjectionWord[],
  n: number = INJECT_TOP_N,
): string[] {
  return [...words]
    .sort((a, b) => {
      const ta = SOURCE_TIER[a.source] ?? 2;
      const tb = SOURCE_TIER[b.source] ?? 2;
      if (ta !== tb) return ta - tb;
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (b.count !== a.count) return b.count - a.count;
      const da = Date.parse(a.lastSeenAt) || 0;
      const db = Date.parse(b.lastSeenAt) || 0;
      if (db !== da) return db - da;
      return a.word.localeCompare(b.word);
    })
    .slice(0, Math.max(0, n))
    .map((e) => e.word);
}

/**
 * 火山全量请求的 request.corpus(内联热词,优先于控制台词表)。无词 → null。
 * 格式为真机实测(2026-10-07,bigmodel_async):`{"hotwords":[{"word":"…"},…]}` ——
 * 元素是 LMHotWord 对象而非字符串;裸数组 → CorpusContext 类型不匹配,字符串 → LMHotWord 不匹配。
 */
export function buildCorpusContext(words: readonly string[]): { context: string } | null {
  if (words.length === 0) return null;
  return { context: JSON.stringify({ hotwords: words.map((w) => ({ word: w })) }) };
}

/** 生产入口(VolcengineAsrSession 建会话时调用):任何异常 → null,热词永不阻断识别。 */
export function pickAsrCorpus(
  env: NodeJS.ProcessEnv = process.env,
): { context: string; count: number } | null {
  try {
    const { file } = readHotwordsFile(env);
    const effective = buildEffectiveWords(file);
    const words = pickInjectionWords(effective, resolveInjectTopN(env));
    const corpus = buildCorpusContext(words);
    return corpus ? { context: corpus.context, count: words.length } : null;
  } catch {
    return null;
  }
}

/** 拉黑(不要求词在池内;agent 改名/删除时防管家再收录)。原地修改;返回是否新增。 */
export function blockWord(file: HotwordsFile, word: string): boolean {
  const w = word.trim();
  const key = w.toLowerCase();
  if (!key) return false;
  if (file.blocked.some((b) => b.toLowerCase() === key) || file.blocked.length >= BLOCKED_CAP) {
    return false;
  }
  file.blocked.push(w);
  return true;
}

/** 面板删除 = 移出词表 + 移入屏蔽名单(管家未来输出命中即丢弃)。原地修改;返回是否命中。 */
export function removeWord(file: HotwordsFile, word: string): boolean {
  const key = word.trim().toLowerCase();
  if (!key) return false;
  const before = file.words.length;
  file.words = file.words.filter((e) => e.word.toLowerCase() !== key);
  if (file.words.length === before) return false;
  blockWord(file, word);
  return true;
}

/**
 * 面板手动添加:已存在 → false(已在 blocked 中的会解除屏蔽并升级为 manual)。
 * 手动词权重 DEFAULT_WEIGHT,后续 AI 只能累计 count、不能改 weight。
 */
export function addManualWord(file: HotwordsFile, word: string, nowIso: string): boolean {
  const w = word.trim();
  const key = w.toLowerCase();
  if (!w || w.length > 40 || /\s/.test(w)) return false;
  const existing = file.words.find((e) => e.word.toLowerCase() === key);
  if (existing) {
    if (existing.source === 'manual') return false;
    existing.source = 'manual';
    existing.lastSeenAt = nowIso;
    return true;
  }
  file.blocked = file.blocked.filter((b) => b.toLowerCase() !== key);
  file.words.push({
    word: w,
    weight: DEFAULT_WEIGHT,
    count: 0,
    source: 'manual',
    addedAt: nowIso,
    lastSeenAt: nowIso,
  });
  return true;
}
