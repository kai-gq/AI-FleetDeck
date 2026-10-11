/**
 * 热词管家(hotword curator)
 *
 * 「智能更新热词」按钮的服务端核心:一次点击 = 一次增量批处理。
 *   1. 增量读对话:voice-cwd 的大脑会话 JSONL(claude projects 目录),
 *      只取 lastAnalyzedAt 之后的消息;文件 mtime 早于节点 → 整个文件跳过;
 *   2. 只看对话正文:user 取转写原文(剥【…】注入模板),assistant 取协议
 *      JSON 的 responseToUser;thinking / 工具 / 系统帧全部跳过;
 *   3. 提示词筛选 → 代码硬校验(词必须真在对话里出现;count 由代码统计,
 *      不信模型自报)→ 合并入池(asr-hotwords)。
 *
 * 首次(无节点)默认看最近 7 天;超量截断采样(保最新);少于 3 条回合不调模型。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectDir } from '../claude/session-loader.js';
import { resolveVoiceCwd } from './companion-cli-profile.js';
import {
  buildEffectiveWords,
  clampWeight,
  countOccurrences,
  evictToCap,
  mergeCandidates,
  readHotwordsFile,
  stripLockedDuplicates,
  touchSeenWords,
  writeHotwordsFile,
  type HotwordCandidate,
} from './asr-hotwords.js';

/** 首次分析的回看窗口(无节点时)。 */
export const HOTWORDS_FIRST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** 单次喂给模型的最大字符数(超出取最新,标 sampled)。 */
export const HOTWORD_REFRESH_MAX_CHARS = 15_000;
/** 少于这个回合数不值得调模型。 */
export const HOTWORD_MIN_TURNS = 3;

/**
 * 管家的专用中立 cwd(与大脑的 voice-cwd 同级、隔离):
 * 管家会话(含「【待筛选对话】」提示词全文)绝不能落进 voice-cwd ——
 * 那会污染大脑对话历史与下次扫描。返回 null = 回退档案默认。
 */
export function resolveCuratorCwd(env: NodeJS.ProcessEnv = process.env): string | null {
  const voiceCwd = resolveVoiceCwd(env);
  if (!voiceCwd) return null;
  const dir = path.join(path.dirname(voiceCwd), 'voice-hotwords-cwd');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

export interface DialogueTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ms;0 = 该行无 timestamp。 */
  ts: number;
}

// ============================================================================
// 「只看对话」提取
// ============================================================================

/**
 * 剥用户侧注入模板(按实测形态,2026-10-07):
 *   a. 「看看主管在干嘛？\n\n【当前时间】…\n\n【格式】…」→ 第一个「【」起截掉;
 *   b. 「老板刚才说:「X」 (最近你已经应过:「…」「…」——这次换个说法,别重样。)」
 *      → 「(最近你已经应过」起截掉(该尾巴会复制往期大脑回复,污染计数);
 *   c. 「老板的问题:X agent「主管」当前状态:idle,任务:… 最近输出记录: …」
 *      → 「agent「」起截掉(状态注入块)。
 * ASR 转写不会产出这些标记,不会误伤;纯模板(空)返回 ''。
 */
export function stripUserTemplate(text: string): string {
  let head = text;
  const swapHint = head.indexOf('(最近你已经应过');
  if (swapHint >= 0) head = head.slice(0, swapHint);
  const agentState = head.indexOf('agent「');
  if (agentState >= 0) head = head.slice(0, agentState);
  const idx = head.indexOf('【');
  if (idx >= 0) head = head.slice(0, idx);
  return head.replace(/\s+/g, ' ').trim();
}

/**
 * 取 assistant 的「话」:content 数组里 type=text 的块,若是协议 JSON
 * ({"action":…,"responseToUser":"…"})则只取 responseToUser;协议壳无话
 * 可说 → '';非 JSON 文本原样。thinking/工具块天然被跳过。
 */
export function extractAssistantSay(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  const joined = texts.join('\n').trim();
  if (!joined) return '';
  const start = joined.indexOf('{');
  const end = joined.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(joined.slice(start, end + 1)) as { responseToUser?: unknown };
      if (typeof obj.responseToUser === 'string' && obj.responseToUser.trim()) {
        return obj.responseToUser.replace(/\s+/g, ' ').trim();
      }
      // 协议 JSON 但没有说出口的话(如 noop)→ 不喂协议原文。
      return '';
    } catch {
      /* 不是 JSON,按纯文本处理 */
    }
  }
  return joined.replace(/\s+/g, ' ').trim();
}

/**
 * 逐行解析一个会话 JSONL;只留 sinceMs 之后的对话回合(0 = 不过滤)。
 * 跳过:queue-operation / system / isSidechain(user 侧数组 content 即 tool_result)。
 * maxTs 取**所有**合法行的最大 timestamp(含被过滤项之外的类型),供节点推进。
 */
export function parseSessionLines(
  lines: Iterable<string>,
  sinceMs: number,
): { turns: DialogueTurn[]; maxTs: number } {
  const turns: DialogueTurn[] = [];
  let maxTs = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const tsMs = Number.isFinite(ts) ? ts : 0;
    // 节点推进取「所有合法行」的时间(含侧链/工具行):下次不再重扫这些行。
    if (tsMs > maxTs) maxTs = tsMs;
    if (obj.isSidechain === true) continue;

    if (obj.type === 'user') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (typeof content !== 'string') continue; // 数组 = tool_result 等,跳过
      if (sinceMs > 0 && tsMs > 0 && tsMs <= sinceMs) continue;
      const text = stripUserTemplate(content);
      if (!text) continue;
      turns.push({ role: 'user', text, ts: tsMs });
    } else if (obj.type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      if (sinceMs > 0 && tsMs > 0 && tsMs <= sinceMs) continue;
      const say = extractAssistantSay(message?.content);
      if (!say) continue;
      turns.push({ role: 'assistant', text: say, ts: tsMs });
    }
  }
  return { turns, maxTs };
}

export interface IncrementalDialogue {
  /** 「[用户] …」/「[大脑] …」行(截断后)。 */
  lines: string[];
  /** lines.join('\n'),供校验与提及计数。 */
  text: string;
  turnCount: number;
  fileCount: number;
  maxTimestamp: number;
  sampled: boolean;
}

/**
 * 增量收集:projectDir 下所有 *.jsonl —— mtime 早于节点的文件整体跳过;
 * 消息按 timestamp 过滤;跨文件合并后按时间正序,超量从旧端截断(保最新)。
 */
export function collectIncrementalDialogue(opts: {
  projectDir: string;
  sinceMs: number;
  maxChars?: number;
}): IncrementalDialogue {
  const maxChars = opts.maxChars ?? HOTWORD_REFRESH_MAX_CHARS;
  const empty: IncrementalDialogue = {
    lines: [],
    text: '',
    turnCount: 0,
    fileCount: 0,
    maxTimestamp: 0,
    sampled: false,
  };
  let names: string[];
  try {
    names = fs.readdirSync(opts.projectDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return empty;
  }

  const allTurns: DialogueTurn[] = [];
  let maxTimestamp = 0;
  let fileCount = 0;
  for (const name of names) {
    const filePath = path.join(opts.projectDir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    // 「过期的不读」:文件最后写入都早于节点 → 整个文件不可能有新消息。
    if (opts.sinceMs > 0 && mtimeMs > 0 && mtimeMs <= opts.sinceMs) continue;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const { turns, maxTs } = parseSessionLines(content.split(/\r?\n/), opts.sinceMs);
    if (maxTs > maxTimestamp) maxTimestamp = maxTs;
    if (turns.length === 0) continue;
    fileCount += 1;
    allTurns.push(...turns);
  }

  // 时间正序;无时间戳的排最后(保最新截断时不优先丢)。
  allTurns.sort((a, b) => (a.ts || Number.MAX_SAFE_INTEGER) - (b.ts || Number.MAX_SAFE_INTEGER));

  const kept: string[] = [];
  let used = 0;
  let sampled = false;
  for (let i = allTurns.length - 1; i >= 0; i -= 1) {
    const t = allTurns[i];
    const line = `[${t.role === 'user' ? '用户' : '大脑'}] ${t.text}`;
    if (kept.length > 0 && used + line.length + 1 > maxChars) {
      sampled = true;
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  kept.reverse();

  return {
    lines: kept,
    text: kept.join('\n'),
    turnCount: allTurns.length,
    fileCount,
    maxTimestamp,
    sampled,
  };
}

// ============================================================================
// 提示词与输出校验
// ============================================================================

export const CURATOR_SYSTEM_PROMPT = [
  '你是 Tide Commander 语音系统的「ASR 热词筛选员」。',
  '',
  '背景:火山引擎流式语音识别对专有名词、中英混排词、专业术语经常听错(同音替代、拆词、音译)。你的任务:从给定的对话记录里挑出应当加入 ASR 热词表的词,提升后续识别准确率。',
  '',
  '收录标准(按优先级):',
  '1. 用户转写中疑似被听错、而大脑回复里出现过正确拼写的词(最高优先);',
  '2. 项目/产品/工具/技术名称(如 tide-commander、bolba、zustand、ClickHouse、tRPC);',
  '3. 人名、团队内部称呼、领域术语、中英混排词。',
  '',
  '排除标准:',
  '- 通用高频词(今天、任务、系统、终端、命令、语音 等);',
  '- 单个字、纯数字、普通动词/形容词/口语词;',
  '- 「已有热词」列表里的词(无需重复列出)。',
  '',
  '格式要求:',
  '- 每个词以 2~12 个字符为宜;词内数字/符号改写为汉字(如 A4L → A四L);',
  '- weight 取 1~10 的整数,越重要越高;',
  '- 宁缺毋滥:只在「ASR 确实容易错、收录有实际帮助」时收录;没有把握就不收。',
  '',
  '输出:严格只输出一个 JSON 对象,不要解释、不要 markdown 围栏:',
  '{"hotwords":[{"word":"词","weight":6,"evidence":"该词在对话里出现的原句片段"}]}',
].join('\n');

export function buildCuratorPrompt(
  dialogueText: string,
  existingWords: readonly string[],
): { system: string; user: string } {
  const existing = existingWords.length > 0 ? existingWords.join('、') : '(无)';
  const user = [
    '【已有热词】',
    existing,
    '',
    '【待筛选对话】(时间正序;[用户]=用户语音转写(可能有识别错误),[大脑]=语音伙伴回复(文本干净,可用于校对拼写))',
    dialogueText,
  ].join('\n');
  return { system: CURATOR_SYSTEM_PROMPT, user };
}

export interface RawCandidate {
  word: string;
  weight?: unknown;
  evidence?: unknown;
}

/** 提取模型回复里的 JSON(容忍围栏与前后杂文本)。 */
export function parseCuratorReply(reply: string): RawCandidate[] {
  const text = reply.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { hotwords?: unknown };
    if (!Array.isArray(obj.hotwords)) return [];
    return obj.hotwords.filter(
      (c): c is RawCandidate =>
        !!c && typeof c === 'object' && typeof (c as RawCandidate).word === 'string',
    );
  } catch {
    return [];
  }
}

export interface ValidatedCandidate extends HotwordCandidate {
  evidence: string;
}

/**
 * 硬校验(防幻觉):词必须真在对话文本里出现过;count 由代码统计,不信模型自报。
 * 非法形态(空/超长/含空白/纯数字/重复)→ 丢弃。
 */
export function validateCandidates(
  raws: readonly RawCandidate[],
  dialogueText: string,
): { accepted: ValidatedCandidate[]; rejected: string[] } {
  const haystack = dialogueText.toLowerCase();
  const accepted: ValidatedCandidate[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const word = raw.word.trim();
    const key = word.toLowerCase();
    const len = Array.from(word).length;
    if (!word || len < 2 || len > 20 || /\s|【|】/.test(word) || /^\d+$/.test(word) || seen.has(key)) {
      rejected.push(word);
      continue;
    }
    const count = countOccurrences(haystack, key);
    if (count === 0) {
      rejected.push(word); // 对话里找不到 → 编造/过期
      continue;
    }
    seen.add(key);
    accepted.push({
      word,
      weight: clampWeight(raw.weight),
      count,
      evidence: typeof raw.evidence === 'string' ? raw.evidence.slice(0, 200) : '',
    });
  }
  return { accepted, rejected };
}

// ============================================================================
// 全流程
// ============================================================================

export interface HotwordRefreshResult {
  ok: boolean;
  message: string;
  added: number;
  updated: number;
  touched: number;
  evicted: number;
  skippedBlocked: number;
  rejected: number;
  /** 池内与锁定层(agent 名)重复的存量条目清理数。 */
  strippedDuplicates: number;
  turnCount: number;
  fileCount: number;
  sampled: boolean;
  analyzedFrom: string | null;
  analyzedTo: string | null;
  totalWords: number;
  elapsedMs: number;
}

export async function refreshHotwords(opts: {
  callModel: (system: string, user: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** 分析起点覆写(ms;面板「上次分析时间」可改选)。缺省 = 节点,无节点回看 7 天。 */
  sinceMs?: number;
  /** 测试沙箱可覆盖;缺省 = voice-cwd 对应的 claude projects 目录。 */
  projectDir?: string;
  log?: (msg: string) => void;
}): Promise<HotwordRefreshResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const startedAt = Date.now();
  const log = opts.log ?? (() => {});

  const { file } = readHotwordsFile(env);
  // 锁定层(agent 名)占有效词表;池内重复条目清走(不拉黑)
  const strippedDuplicates = stripLockedDuplicates(file);
  const nodeMs = file.lastAnalyzedAt
    ? Date.parse(file.lastAnalyzedAt)
    : now - HOTWORDS_FIRST_LOOKBACK_MS;
  const override = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const sinceMs = override ?? nodeMs;
  const projectDir = opts.projectDir ?? getProjectDir(resolveVoiceCwd(env) ?? process.cwd());

  const dialogue = collectIncrementalDialogue({ projectDir, sinceMs });
  log(
    `项目目录 ${projectDir};起点 ${new Date(sinceMs).toISOString()}` +
      `${override !== null ? '(面板选定)' : file.lastAnalyzedAt ? '(节点)' : '(首次,回看 7 天)'} → ` +
      `读到 ${dialogue.turnCount} 回合 / ${dialogue.fileCount} 个会话文件${dialogue.sampled ? '(已采样)' : ''}`,
  );

  const base = {
    added: 0,
    updated: 0,
    touched: 0,
    evicted: 0,
    skippedBlocked: 0,
    rejected: 0,
    turnCount: dialogue.turnCount,
    fileCount: dialogue.fileCount,
    sampled: dialogue.sampled,
    analyzedFrom: new Date(sinceMs).toISOString(),
  };

  if (dialogue.turnCount < HOTWORD_MIN_TURNS || !dialogue.text.trim()) {
    if (strippedDuplicates > 0) writeHotwordsFile(file, env); // 清理不因「对话不够」而丢
    return {
      ok: true,
      message: `最近没有足够的新对话(${dialogue.turnCount} 条,至少 ${HOTWORD_MIN_TURNS} 条才分析),未调用模型`,
      analyzedTo: file.lastAnalyzedAt,
      totalWords: file.words.length,
      elapsedMs: Date.now() - startedAt,
      strippedDuplicates,
      ...base,
    };
  }

  // 「已有热词」= 有效词表全层(agent 名 + 池)—— 锁定层也列上,防模型重复提案
  const effective = buildEffectiveWords(file);
  const lockedKeys = new Set(
    effective
      .filter((w) => w.source === 'agent-name')
      .map((w) => w.word.toLowerCase()),
  );
  const { system, user } = buildCuratorPrompt(dialogue.text, effective.map((w) => w.word));
  const reply = await opts.callModel(system, user);
  const raws = parseCuratorReply(reply);
  const { accepted: rawAccepted, rejected } = validateCandidates(raws, dialogue.text);
  // 兜底:模型仍提案锁定层词(提示词失效/幻觉)→ 不收录(锁定层本就注入,池内重复无意义)
  const accepted = rawAccepted.filter((c) => !lockedKeys.has(c.word.toLowerCase()));
  const lockedSkipped = rawAccepted.length - accepted.length;

  // 提及刷新先行(existing only),再合并候选(新词 count = 本批出现数;
  // 已有词 count 已在 touch 里算过,merge 不再重复累加)。
  const nowIso = new Date(now).toISOString();
  const touched = touchSeenWords(file, dialogue.text, nowIso);
  const stats = mergeCandidates(file, accepted, nowIso);
  stats.skippedBlocked += lockedSkipped;
  const evicted = evictToCap(file);

  const analyzedTo = dialogue.maxTimestamp > 0 ? new Date(dialogue.maxTimestamp).toISOString() : nowIso;
  file.lastAnalyzedAt = analyzedTo;
  writeHotwordsFile(file, env);

  const parts = [`新增 ${stats.added}`, `更新 ${stats.updated}`, `提及刷新 ${touched}`];
  if (rejected.length > 0) parts.push(`丢弃 ${rejected.length}(无证据/格式非法)`);
  if (stats.skippedBlocked > 0) parts.push(`屏蔽/锁定跳过 ${stats.skippedBlocked}`);
  if (strippedDuplicates > 0) parts.push(`清理重复 ${strippedDuplicates}`);
  if (evicted > 0) parts.push(`淘汰 ${evicted}`);

  return {
    ok: true,
    message: parts.join('、'),
    added: stats.added,
    updated: stats.updated,
    touched,
    evicted,
    skippedBlocked: stats.skippedBlocked,
    rejected: rejected.length,
    strippedDuplicates,
    analyzedTo,
    totalWords: file.words.length,
    elapsedMs: Date.now() - startedAt,
    turnCount: dialogue.turnCount,
    fileCount: dialogue.fileCount,
    sampled: dialogue.sampled,
    analyzedFrom: base.analyzedFrom,
  };
}
