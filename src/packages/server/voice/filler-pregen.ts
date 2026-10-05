/**
 * W7 垫话预生成:「用户还在说话」时(final 之前)就用流式 partial 触发垫话生成,
 * 把生成(~2.2s)与 TTS 合成(~0.5–0.8s)移出「说完 → 出声」的关键路径。
 *
 * 生命周期(每句一段):
 *   notePartial(首个 ≥6 字规范化的 partial)─→ 一次性生成(注入 generate)
 *   seal()(ASR final)───────────────────→ working 移入 sealedReady(待回合取用)
 *   take(finalText)(回合开始)──────────→ 规范化前缀匹配:命中才消费,返回
 *                                          {ready}(已就绪)| {pending}(在途,交回合等)
 *   未命中/过期/生成失败 → 一律返回 null,调用方回退旧路径(逐字节不变)。
 *
 * 双槽 + 「不命中不消费」是给时序兜底:withMutex 使「POST 到达 ≠ 回合开始」,
 * 连续两句 / 事件回合插队 / 跨连接交接都会让 take 晚于新一句的 partial;此时新句的
 * 密封槽顶替旧槽,take 文本对不上就原样留槽给下一回合 —— 纯降级、零误伤。
 *
 * 纯状态机:不依赖服务层(生成器 / 日志 / 阈值都注入或可配)→ 单测直接驱动。
 */

/** 触发阈值:规范化后至少这么多字符才开始预生成(过短的「嗯」「好」不值得)。 */
const DEFAULT_MIN_CHARS = 6;
/** 文本匹配的最小可比前缀(短于此不认,防「嗯啊」类短串误命中)。 */
const MATCH_MIN_PREFIX = 4;
/** 密封槽存活期(自 seal 起),超时按未命中处理(防陈旧槽跨很久误命中)。 */
const DEFAULT_SEALED_TTL_MS = 30_000;

/** take() 的返回值:已就绪文本或一句在途生成(二选一;失败回退 null)。 */
export interface FillerPregenTake {
  /** 已就绪文本(同步可得)。 */
  ready: string | null;
  /** 在途生成(未就绪时非 null;失败 resolve null)。 */
  pending: Promise<string | null> | null;
}

export interface FillerPregenOptions {
  /** 触发阈值(规范化字符数;缺省 6)。 */
  minChars?: number;
  /** 密封槽存活期 ms(缺省 30s)。 */
  sealedTtlMs?: number;
  /** 观测日志(缺省静默;服务端注入带 [VoiceCompanion] 前缀的 logger)。 */
  log?: (line: string) => void;
}

export interface FillerPregen {
  /** 流式 partial 到达:建/刷工作槽(首个达阈值的 partial 触发一次生成)。 */
  notePartial: (text: string, generate: () => Promise<string | null>, onHint: (text: string) => void) => void;
  /** ASR final:工作槽密封为「待取用」;旧密封槽(如有)被顶替作废。 */
  seal: () => void;
  /** 回合开始:按 final 文本匹配密封槽;命中才消费。 */
  take: (finalText: string) => FillerPregenTake | null;
  /** ASR 会话中止(错误/重连):清工作槽,保留密封槽(上一句的回合可能还没开始)。 */
  dropWorking: () => void;
  /** 连接级清理(close/error):全清。 */
  drop: () => void;
}

/** 归一化 ASR 文本:去空白与全部标点/符号(只留字母/数字/汉字),供前缀匹配。 */
export function normalizeAsrText(text: string): string {
  return text.replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

/** final 与 partial 的匹配:final 以 partial(或 partial 去尾 2 字)为前缀。 */
export function partialMatchesFinal(finalNorm: string, partialNorm: string): boolean {
  // 过短的 partial 不认(触发阈值之外的双保险:ASR 尾部大幅回改后别用一两个字去碰)
  if (!finalNorm || partialNorm.length < MATCH_MIN_PREFIX) return false;
  if (finalNorm.startsWith(partialNorm)) return true;
  // 允许 partial 尾部 1–2 字与 final 有差(ASR 尾部修字/补标点):去掉尾巴再比
  const head = partialNorm.slice(0, -2);
  return head.length >= MATCH_MIN_PREFIX && finalNorm.startsWith(head);
}

interface PregenSlot {
  /** 最近一次 partial 原文(trim;日志/调试)。 */
  lastPartial: string;
  /** 最近一次 partial 的规范化文本(匹配源)。 */
  lastNorm: string;
  generation: Promise<string | null>;
  settled: boolean;
  result: string | null;
  sealedAt: number;
  dropped: boolean;
  superseded: boolean;
}

function truncate(text: string, max = 24): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

export function createFillerPregen(options: FillerPregenOptions = {}): FillerPregen {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const sealedTtlMs = options.sealedTtlMs ?? DEFAULT_SEALED_TTL_MS;
  const log = options.log ?? (() => {});

  let working: PregenSlot | null = null;
  let sealed: PregenSlot | null = null;

  const dropWorking = (): void => {
    if (working) {
      working.dropped = true;
      working = null;
    }
  };

  return {
    notePartial(text, generate, onHint) {
      const raw = text.trim();
      if (!raw) return;
      const norm = normalizeAsrText(raw);
      if (!norm) return;
      if (working && !working.dropped) {
        // 生成期只触发一次;后续 partial 仅刷新匹配源(final 前最完整)
        working.lastPartial = raw;
        working.lastNorm = norm;
        return;
      }
      if (norm.length < minChars) return;

      const slot: PregenSlot = {
        lastPartial: raw,
        lastNorm: norm,
        settled: false,
        result: null,
        sealedAt: 0,
        dropped: false,
        superseded: false,
        generation: Promise.resolve(null),
      };
      working = slot;
      log(`垫话预生成启动(partial ${norm.length} 字)`);
      slot.generation = (async () => {
        let value: string | null = null;
        try {
          value = (await generate())?.trim() || null;
        } catch {
          value = null; // 生成器自会兜底;这里双保险
        }
        slot.settled = true;
        slot.result = value;
        if (value && !slot.dropped && !slot.superseded) {
          log(`垫话预生成就绪「${truncate(value)}」`);
          try {
            onHint(value);
          } catch {
            // 推 hint 失败静默(通道可能已断)
          }
        } else if (!value) {
          log('垫话预生成失败(静默)');
        }
        return value;
      })();
      slot.generation.catch(() => { /* 防未处理拒绝 */ });
    },

    seal() {
      const slot = working;
      if (!slot) return;
      working = null;
      slot.sealedAt = Date.now();
      if (sealed) sealed.superseded = true; // 旧密封槽被新句顶替(在途结果的 hint 作废)
      sealed = slot;
      log(`垫话预生成密封(${slot.lastNorm.length} 字,${slot.settled ? '已就绪' : '生成在途'})`);
    },

    take(finalText) {
      const slot = sealed;
      if (!slot) {
        log('垫话预生成未命中:无密封槽');
        return null;
      }
      if (Date.now() - slot.sealedAt > sealedTtlMs) {
        sealed = null;
        slot.dropped = true;
        log('垫话预生成未命中:过期');
        return null;
      }
      const finalNorm = normalizeAsrText(finalText);
      if (!partialMatchesFinal(finalNorm, slot.lastNorm)) {
        // 不消费:可能是下一句(或更新一句)的槽,留给它的回合
        log(`垫话预生成未命中:文本不符(final「${truncate(finalNorm)}」≠ partial「${truncate(slot.lastNorm)}」)`);
        return null;
      }
      sealed = null;
      if (slot.settled && slot.result) {
        log(`垫话预生成命中(已就绪)「${truncate(slot.result)}」`);
        return { ready: slot.result, pending: null };
      }
      if (!slot.settled) {
        log('垫话预生成命中(生成在途,交回合等待)');
        return { ready: null, pending: slot.generation };
      }
      log('垫话预生成命中但生成失败 → 回退');
      return null;
    },

    dropWorking,

    drop() {
      dropWorking();
      if (sealed) {
        sealed.dropped = true;
        sealed = null;
      }
    },
  };
}
