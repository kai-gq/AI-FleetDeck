/**
 * 语音伙伴服务 — 垫话(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * W5 慢档续垫(静态池为默认档,llm 实验档见 SLOW_FILLER_SYSTEM_PROMPT)+ W7 partial 预生成接线;
 * 出口复检/负例回灌/预生成取用宽限原样保留(说明见 obsidian-docs 06-10 §1e)。
 */
import { logger } from '../../utils/index.js';
import { FILLER_RULE_GUIDANCE, checkFillerSafety, isFillerGuardEnabled } from '../../voice/filler-guard.js';
import { createFillerPregen, type FillerPregenTake } from '../../voice/filler-pregen.js';
import { isStaticFillerMode, pickStaticFiller } from '../../voice/filler-phrases.js';
import { loadServerConfig } from './config.js';
import { truncate } from './contract.js';
import { callClaudeOnce } from './claude-call.js';

const log = logger.server;

/** 垫话系统提示词(C18;**仅 llm 实验档使用**,默认静态档不进模型)。
 *  顺着老板这句话的内容接(别答非所问)、像熟人随口应声、每次换说法。
 *  只给按类别的示样句式,**不给整句通用示例** —— 模型会逐字照抄示例(C17 教训:「好嘞,我捋捋」
 *  被原样搬出,听着又假又雷同);去掉可抄的整句后,多样性由服务端 recentFillerPhrases 记忆注入(见下)。与主提示词隔离。 */
const SLOW_FILLER_SYSTEM_PROMPT = [
  '你是语音伙伴的「垫话」模块。老板说完一句,主流程还在处理,你先像真人秘书那样随口接一声,一句就够。',
  '要点:',
  '- 顺着老板这句话的内容接,别答非所问:他让看什么/查什么,就应「看看」一类(如「我瞅瞅团队一」「我看看天气」);他让你办事,就应事情本身(如「行,这就叫」「好嘞,马上办」);他让你回忆/问事,才应「想想」一类;',
  '- 像熟人随口说话:不超过 12 个字,口语化,别客套、别用敬语;',
  '- 别把老板的话原样念回去(「团队一啊」这种只丢语气词的应声很敷衍);话题可以自然带进句子里,但要连着你要做的事一起说;',
  '- 硬规则(违反会被系统拦下重写):只说「收到 + 你马上要做的过程动作」(如「我看看」「这就叫」「我去查」);严禁①承诺时间(几分钟后/几点/马上好/稍后叫你)②宣告完成(已经/好了/搞定了/查到了)③编造结果(数量/产出)④保证类措辞(一定/保证/肯定/绝对);',
  '- 拿不准或可能要反问澄清的,更应轻一点:宁可只说「嗯,我看看」;',
  '- 每次换一种说法,开口、动词、句式都别重样;',
  '- 不要 emoji、引号、解释;直接输出这一句话本身,不要任何多余内容。',
].join('\n');

/** C18:最近实际产出的垫话(环缓冲,保留 3 条,进程级)。
 *  双用途:静态档 = 选句排除集(「别连续同款」);llm 档 = 注入下一次生成,强制换说法。
 *  为什么放服务端:提示词给整句示例会被照抄(C17),不给又容易句式雷同;
 *  把「刚应过什么」当事实喂回去,比任何措辞约束都直接。 */
const recentFillerPhrases: string[] = [];
/** 保留条数:覆盖「连着几轮都要垫话」的常见场景,又不把提示撑长。 */
const RECENT_FILLER_KEEP = 3;

/** 生成超时(垫话是可选加成,慢过阈值就放弃,绝不拖回合)。 */
const SLOW_FILLER_TIMEOUT_MS = 8_000;
/** C21:违规重生成上限(仅违规时触发;超时即静默——少句垫话,绝不食言)。 */
const SLOW_FILLER_REGEN_TIMEOUT_MS = 4_000;
/** 内容护栏:远超 10 字上限(模型跑偏)宁可静默也不念长句。 */
const SLOW_FILLER_MAX_CHARS = 16;

/** C21:被护栏拦下的句子(环缓冲,保留 2 条)—— 回灌为负例,防同款重犯。 */
const recentBannedFillers: string[] = [];
const RECENT_BANNED_KEEP = 2;

/** C21:护栏违规句回灌(同句去重;只留最近 2 条,防提示词撑长)。 */
function noteBannedFiller(text: string): void {
  if (recentBannedFillers.includes(text)) return;
  recentBannedFillers.push(text);
  if (recentBannedFillers.length > RECENT_BANNED_KEEP) recentBannedFillers.shift();
}

/** C21:验收合格句入环缓冲(防重样)+ 日志;返回原句。 */
function acceptFiller(cleaned: string): string {
  recentFillerPhrases.push(cleaned);
  if (recentFillerPhrases.length > RECENT_FILLER_KEEP) recentFillerPhrases.shift();
  log.log(`[VoiceCompanion] 慢档垫话:${cleaned}`);
  return cleaned;
}

/** C21 出口复检(防线二):生成路径(防线一)已过闸;这里兜住预生成直返等旁路,
 *  违规 → 静默并回灌负例(重生成只发生在防线一,避免双份延迟)。 */
function finalFillerGate(text: string | null): string | null {
  if (!text || !isFillerGuardEnabled()) return text;
  const violation = checkFillerSafety(text);
  if (!violation) return text;
  noteBannedFiller(text);
  log.warn(
    `[VoiceCompanion] 垫话拦截(出口) rule=${violation.rule} mean=${violation.matched} 句=「${text}」→ 静默`,
  );
  return null;
}

/** 取一句垫话。默认静态档:池内选句(排除最近 3 句)——零生成、零延迟,且天然绕开
 *  「半句 partial 输入 / 无上下文 / 模型造句」三条「假」的根因;就绪提前到 partial 时刻,
 *  预合成受益更早(不变式:池句全过 filler-guard,见 filler-phrases.test.ts)。
 *
 *  llm 实验档(TC_VOICE_FILLER_MODE=llm):旧「一次性生成」——任何失败(超时/中止/跑偏/空)
 *  一律 null(调用方静默);C21:清洗后过 `checkFillerSafety`(承诺类硬闸);违规回灌负例 +
 *  注入原因重生成一次(独立 4s 上限),仍违规 → null(静默:少句垫话,绝不食言)。 */
export async function generateSlowFillerPhrase(userText: string, model: string, signal?: AbortSignal): Promise<string | null> {
  if (isStaticFillerMode()) {
    return acceptFiller(pickStaticFiller({ exclude: recentFillerPhrases }));
  }

  const recentHint = recentFillerPhrases.length
    ? `\n(最近你已经应过:${recentFillerPhrases.map((p) => `「${p}」`).join('')}——这次换个说法,别重样。)`
    : '';

  /** 调一次 + 清洗 + 长度闸;空/超限 → null。bannedHint 每次现取:重试时刚拦下的句子已入负例环。 */
  const once = async (extra: string, timeoutMs: number): Promise<string | null> => {
    const bannedHint = recentBannedFillers.length
      ? `\n(以下说法已被系统拦下,严禁使用或变相改写:${recentBannedFillers.map((p) => `「${p}」`).join('')}。)`
      : '';
    const result = await callClaudeOnce(SLOW_FILLER_SYSTEM_PROMPT, `老板刚才说:「${truncate(userText, 80)}」${recentHint}${bannedHint}${extra}`, {
      model,
      resumeId: null,
      timeoutMs,
      signal,
      // 垫话不需要任何工具/项目上下文 → 跳过 MCP/设置加载,冷启动省 ~2.6s。
      skipMcp: true,
    });
    const line = result.text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    const cleaned = line.replace(/^["「『']+|["」』']+$/g, '').trim();
    if (!cleaned || Array.from(cleaned).length > SLOW_FILLER_MAX_CHARS) return null;
    return cleaned;
  };

  try {
    const first = await once('', SLOW_FILLER_TIMEOUT_MS);
    if (!first) return null;
    const violation = isFillerGuardEnabled() ? checkFillerSafety(first) : null;
    if (!violation) return acceptFiller(first);

    // 违规:回灌负例,带上原因重生成一次(只有这一次重试机会)。
    noteBannedFiller(first);
    log.log(
      `[VoiceCompanion] 垫话拦截 rule=${violation.rule} mean=${violation.matched} 句=「${first}」→ 重生成一次`,
    );
    const feedback = `\n(注意:刚才你应的是「${first}」——${FILLER_RULE_GUIDANCE[violation.rule]},已被系统拦下。重新只应一句「收到 + 马上要做的过程动作」,不含任何时间、完成、结果、保证字样。)`;
    const retry = await once(feedback, SLOW_FILLER_REGEN_TIMEOUT_MS);
    if (!retry) return null;
    const again = isFillerGuardEnabled() ? checkFillerSafety(retry) : null;
    if (again) {
      noteBannedFiller(retry);
      log.log(
        `[VoiceCompanion] 垫话拦截 rule=${again.rule} mean=${again.matched} 句=「${retry}」→ 放弃(静默)`,
      );
      return null;
    }
    return acceptFiller(retry);
  } catch (err) {
    log.warn(`[VoiceCompanion] 慢档垫话生成失败(静默): ${(err as Error).message}`);
    return null;
  }
}

// ----------------------------------------------------------------------------
// W7 垫话预生成接线(说话期间的 partial 触发;状态机见 voice/filler-pregen.ts)
// ----------------------------------------------------------------------------

/** 进程级单例:多连接/leader 交接靠「文本匹配 + 不命中不消费」兜底(最坏退化为常规垫话)。 */
const fillerPregen = createFillerPregen({
  log: (line) => log.log(`[VoiceCompanion] ${line}`),
});

/** 流式 partial 到达(WS 通道调用):达阈值触发一次性预生成;就绪即经 onHint 推给客户端预合成。
 *  静态档选句为同步完成 → hint 在首个达阈值 partial 后即刻推出(比 llm 档早 ~2s,预合成窗口更宽)。 */
export function noteFillerPartialForPregen(partial: string, onHint: (text: string) => void): void {
  // 每次 partial 同步读一次配置:文件很小、partial 频率低(每秒几条),换来开关即时生效。
  const cfg = loadServerConfig();
  if (!cfg.slowFiller.enabled) return;
  // 生成不带 signal:此刻还没有回合可中止;超时/失败由 generateSlowFillerPhrase 内部兜底。
  fillerPregen.notePartial(partial, () => generateSlowFillerPhrase(partial, cfg.model), onHint);
}

/** ASR final:密封当前工作槽(供即将到来的回合 take)。 */
export function sealFillerPartial(): void {
  fillerPregen.seal();
}

/** ASR 会话中止(错误/重连):清未密封的工作槽;密封槽留给上一句可能仍在途的回合。 */
export function dropFillerPregenWorking(): void {
  fillerPregen.dropWorking();
}

/** 连接级清理(close/error/close 指令):全清。 */
export function dropFillerPregen(): void {
  fillerPregen.drop();
}

/** 回合开始:按 final 文本匹配密封槽,命中才消费;未命中返回 null → 回退常规垫话。 */
export function takeFillerPregen(finalText: string): FillerPregenTake | null {
  return fillerPregen.take(finalText);
}

/** W7:取用宽限(ms)——预生成还在途时最多等这么久;超时改为并行常规生成,先到先用。
 *  C17:1.5s→2.8s —— 命中档垫话 3.0s 才吐,等到 2.8s 不增加用户可感延迟,
 *  却能避开「预生成即将就绪(实测落地 ≈2s)却已触发并行兜底」的常见浪费
 *  (真麦日志:每轮命中档都多烧一次小生成,随后被丢弃/打断取消)。 */
const PREGEN_TAKE_GRACE_MS = 2_800;

/** 取用预生成结果:ready 直返;在途限时等待;失败/超时回退常规生成(绝不比旧路径更慢)。 */
export async function resolvePregenFiller(
  pregen: FillerPregenTake,
  userText: string,
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (pregen.ready) return finalFillerGate(pregen.ready);
  const fresh = () => generateSlowFillerPhrase(userText, model, signal);
  if (!pregen.pending) return finalFillerGate(await fresh());

  const pending = pregen.pending;
  // 宽限内等到非空结果 → 直接用;明确失败 → 立即回退;超时 → 并行回退,先到先用。
  const early = await new Promise<string | null | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), PREGEN_TAKE_GRACE_MS);
    timer.unref?.();
    void pending.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  if (early !== 'timeout') return finalFillerGate(early ?? (await fresh()));

  const freshPromise = fresh();
  return new Promise<string | null>((resolve) => {
    let done = false;
    let pendingDone = false;
    let freshDone = false;
    let pendingValue: string | null = null;
    let freshValue: string | null = null;
    const maybe = (): void => {
      if (done) return;
      const value = finalFillerGate(pendingValue ?? freshValue);
      if (value) {
        done = true;
        resolve(value);
        return;
      }
      if (pendingDone && freshDone) {
        done = true;
        resolve(null);
      }
    };
    void pending.then((value) => { pendingDone = true; pendingValue = value; maybe(); });
    void freshPromise.then((value) => { freshDone = true; freshValue = value; maybe(); });
  });
}
