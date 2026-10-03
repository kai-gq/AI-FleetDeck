/**
 * 语音契约(模型 JSON 输出)的增量抽取与分句 —— 纯函数,零 IO,单测锁死。
 *
 * 背景:「语音伙伴 / 语音助手」的模型回复是一份 JSON 契约,真正要播报的是其中
 * 的 responseToUser 字段。分句流水线需要在 JSON 还在流式输出时就抽到该字段的
 * 当前值,并按标点切成整句,让客户端边生成边合成播放。
 *
 * 三级能力:
 *   findStringField(raw, key)     顶层字符串字段的当前值(带 complete 标志)
 *   SentenceChunker               游标式切句(推增量、吐新句、flush 余量)
 *   createJsonStringStream(key)   组合:喂「累计原文」,吐新完成的句子
 *
 * 为什么是字符级扫描而不是 indexOf/正则:字段名可能出现在别的字符串值里
 * (例如 messageToAgent 里正好提到 responseToUser),值里可能有转义、{ }、
 * 冒号;只有真正解析字符串 token 才不会误命中、不会把半截转义吐出去。
 */

export interface FieldHit {
  /** 已解出的字段值(未闭合时是"到目前为止"的部分)。 */
  value: string;
  /** 值的结束引号是否已出现。 */
  complete: boolean;
}

const STRING_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** 从 raw[start](必须是开头引号)读一个 JSON 字符串 token。 */
function scanString(raw: string, start: number): { value: string; next: number; closed: boolean } {
  let value = '';
  let i = start + 1;
  const len = raw.length;
  while (i < len) {
    const ch = raw.charAt(i);
    if (ch === '\\') {
      if (i + 1 >= len) return { value, next: len, closed: false }; // 半截转义:挂起
      const esc = raw.charAt(i + 1);
      if (esc === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) return { value, next: len, closed: false };
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // 非法 \u 转义:原样保留 'u',继续(不抛错)
          value += 'u';
          i += 2;
          continue;
        }
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      value += STRING_ESCAPES[esc] ?? esc;
      i += 2;
      continue;
    }
    if (ch === '"') return { value, next: i + 1, closed: true };
    value += ch;
    i++;
  }
  return { value, next: len, closed: false };
}

function skipWhitespace(raw: string, from: number): number {
  let i = from;
  while (i < raw.length && /\s/.test(raw.charAt(i))) i++;
  return i;
}

/**
 * 在增量 JSON 原文里找顶层(depth===1)字符串字段 key 的当前值。
 * 未出现 → null;出现但值未写完 → complete:false;写完 → complete:true。
 */
export function findStringField(raw: string, key: string): FieldHit | null {
  let depth = 0;
  let i = 0;
  const len = raw.length;
  while (i < len) {
    const ch = raw.charAt(i);
    if (ch === '{' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      i++;
      continue;
    }
    if (ch !== '"') {
      i++;
      continue;
    }

    const token = scanString(raw, i);
    if (!token.closed) {
      // 原文在字符串中途截断:只有当它就是目标 key 时才有意义(值未开始)
      if (depth === 1 && token.value === key) return { value: '', complete: false };
      return null;
    }

    const after = skipWhitespace(raw, token.next);
    const isKey = after < len && raw.charAt(after) === ':';
    if (!isKey) {
      // 普通字符串值 / 数组元素:跳过
      i = token.next;
      continue;
    }

    if (depth === 1 && token.value === key) {
      const valueStart = skipWhitespace(raw, after + 1);
      if (valueStart >= len) return { value: '', complete: false }; // 冒号后还没写
      if (raw.charAt(valueStart) !== '"') return null; // 非字符串值(契约中不会出现)
      const value = scanString(raw, valueStart);
      return { value: value.value, complete: value.closed };
    }

    i = after + 1; // 跳过冒号;它的值会在后续轮次作为普通 token 跳过
  }
  return null;
}

// ----------------------------------------------------------------------------
// 切句
// ----------------------------------------------------------------------------

export interface SentenceChunkerOptions {
  /** 句终结符(默认中文标点为主)。ASCII '.' 刻意不算,避免切开 1.2 / index.ts。 */
  terminators?: string;
  /** 无标点长句的软切点(优先在这些位置断开)。 */
  softCuts?: string;
  /** 过短的「句子」(如「嗯。」)与下一句合并;默认 2。 */
  minChars?: number;
  /** 单句硬上限(超出先在软切点、再在硬位置断开);默认 80。 */
  maxChars?: number;
}

const DEFAULT_TERMINATORS = '。！？!?…\n；';
const DEFAULT_SOFT_CUTS = '，,、；; ';
/** 终结符后紧跟的收尾符:并入本句(如 他说：“好的。”)。 */
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', ']', '】', '》', '〉', '"', "'"]);

/**
 * 游标式切句器:push 增量返回「新完成」的句子;绝不会重发已吐出的内容。
 * 终结符若悬在整个缓冲末尾,会等下一个字符再判(避免把 "…" 从 "……" 拆开)。
 */
export class SentenceChunker {
  private readonly terminators: string;
  private readonly softCuts: string;
  private readonly minChars: number;
  private readonly maxChars: number;
  private pending = '';

  constructor(opts: SentenceChunkerOptions = {}) {
    this.terminators = opts.terminators ?? DEFAULT_TERMINATORS;
    this.softCuts = opts.softCuts ?? DEFAULT_SOFT_CUTS;
    this.minChars = Math.max(1, opts.minChars ?? 2);
    this.maxChars = Math.max(this.minChars + 2, opts.maxChars ?? 80);
  }

  /** atEnd = 输入不会再增长了(字段闭合/流结束),尾部残留也可作为整句吐出。 */
  push(delta: string, atEnd = false): string[] {
    this.pending += delta;
    return this.drain(atEnd);
  }

  /** 输入结束:吐出全部残留。 */
  flush(): string[] {
    return this.drain(true);
  }

  /**
   * 宽限 flush(P5):只吐出「已带终结符、但悬在缓冲末尾」的整句。
   * 模型在句号后暂停(还在写别的字段)时,由调用方在静默 ~180ms 后触发,
   * 避免第一句白等;未终结的余量仍挂起,不改变正常切句语义。
   */
  flushTerminated(): string[] {
    return this.drain(false, true);
  }

  /** 防御:字段值回退(异常输入)时清空游标。 */
  reset(): void {
    this.pending = '';
  }

  private drain(atEnd: boolean, forceTerminatedTail = false): string[] {
    const out: string[] = [];
    let searchFrom = 0;
    for (;;) {
      // 超长且迟迟没有终结符:先在软切点断开(整段翻倍仍无软切点则硬断)
      if (this.pending.length > this.maxChars) {
        const soft = this.softCutIndex();
        const cutAt = soft > 0 ? soft : (this.pending.length >= this.maxChars * 2 ? this.maxChars : -1);
        if (cutAt > 0) {
          const sentence = this.pending.slice(0, cutAt).trim();
          if (sentence) out.push(sentence);
          this.pending = this.pending.slice(cutAt);
          searchFrom = 0;
          continue;
        }
      }

      const cut = this.findCut(searchFrom, atEnd || forceTerminatedTail);
      if (cut === -1) break;

      // 正文长度不含尾部的终结符与收尾符:「嗯。」算 1 个字,与下一句合并
      const candidate = this.pending.slice(0, cut);
      let coreEnd = candidate.length;
      while (coreEnd > 0) {
        const last = candidate.charAt(coreEnd - 1);
        if (!this.terminators.includes(last) && !CLOSERS.has(last)) break;
        coreEnd--;
      }
      const core = candidate.slice(0, coreEnd).replace(/\s+/g, '');
      if (core.length >= this.minChars) {
        const sentence = this.pending.slice(0, cut).trim();
        if (sentence) out.push(sentence);
        this.pending = this.pending.slice(cut);
        searchFrom = 0;
      } else {
        // 太短(如「嗯。」):吞并到下一句,不在此处切
        searchFrom = cut;
      }
    }

    if (atEnd) {
      const rest = this.pending.trim();
      this.pending = '';
      if (rest) out.push(rest);
    }
    return out;
  }

  /** 找第一个可切的边界(终结符组 + 收尾符的终点);悬尾且未结束 → -1。 */
  private findCut(from: number, atEnd: boolean): number {
    const len = this.pending.length;
    for (let i = from; i < len; i++) {
      if (!this.terminators.includes(this.pending.charAt(i))) continue;
      let j = i + 1;
      while (j < len) {
        const next = this.pending.charAt(j);
        if (this.terminators.includes(next) || CLOSERS.has(next)) j++;
        else break;
      }
      if (j < len || atEnd) return j;
      return -1; // 终结符组悬在缓冲末尾:等更多输入
    }
    return -1;
  }

  /** 在 maxChars 窗口内倒着找最后一个软切点;找到返回切点后一位,否则 -1。 */
  private softCutIndex(): number {
    for (let i = Math.min(this.pending.length - 1, this.maxChars); i >= this.minChars; i--) {
      if (this.softCuts.includes(this.pending.charAt(i))) return i + 1;
    }
    return -1;
  }
}

// ----------------------------------------------------------------------------
// JSON 字符串字段流
// ----------------------------------------------------------------------------

export interface JsonStringStream {
  /** 喂入「到目前为止的累计原文」(模型输出全文),返回新完成的句子。 */
  pushRaw(rawFull: string): string[];
  /** 宽限 flush:吐出「终结符悬尾」的整句(见 SentenceChunker.flushTerminated)。 */
  flushTerminated(): string[];
  /** 当前已解出的字段值。 */
  readonly value: string;
}

/** 组合 findStringField + SentenceChunker:从累计 JSON 原文里流式吐出字段整句。 */
export function createJsonStringStream(key: string, opts: SentenceChunkerOptions = {}): JsonStringStream {
  const chunker = new SentenceChunker(opts);
  let lastValue = '';
  let done = false;

  return {
    pushRaw(rawFull: string): string[] {
      if (done) return [];
      const hit = findStringField(rawFull, key);
      const value = hit?.value ?? '';
      if (!value.startsWith(lastValue)) {
        // 防御:值出现回退(理论上不会发生)→ 重置游标,重新累计
        lastValue = '';
        chunker.reset();
      }
      const delta = value.slice(lastValue.length);
      lastValue = value;
      const complete = hit?.complete === true;
      if (complete) done = true;
      if (!delta && !complete) return [];
      return chunker.push(delta, complete);
    },
    flushTerminated(): string[] {
      if (done) return [];
      return chunker.flushTerminated();
    },
    get value() {
      return lastValue;
    },
  };
}
