/**
 * Voice Companion Service
 *
 * 「语音伙伴」的服务端大脑:持续聆听模式下,客户端把每一段最终转写文本
 * (或合并后的 agent 事件)发到这里,由本服务完成:
 *
 *   1. 调用 claude(headless,haiku/sonnet,--resume 持久会话)理解意图;
 *   2. 模型按要求只输出一份 JSON 契约(action / targetAgentId / delivery /
 *      responseToUser / memoryOps …);
 *   3. 按契约执行:任务一律 delegate_to_boss 交团队主管(改①;委托消息复用
 *      buildBossMessage 注入团队上下文,默认排队、急迫语义才打断)、查询 agent
 *      最近输出(第二跳 claude 总结)、列 agent、纯聊天;
 *   4. 维护跨会话的持久记忆(notes + summary),每轮注入系统提示词;
 *   5. 团队认知(改③):只读注入委派史摘要(Boss→下属→任务→状态),agent 快照的
 *      Boss 行展开下属结构/忙闲/最近委派(delegation-history 永不写)。
 *
 * 设计要点:
 * - 会话状态与记忆落盘 ~/.local/share/tide-commander/voice-companion.json(tmp+rename);
 * - 超时**不**重置会话(新会话由轮数/天数轮换;旧 voice-assistant 路由已移除);
 * - --resume 被拒(session 文件丢失)→ 清会话重试一次;
 * - 打断走 runtimeService.stopAgent + sendCommand(Claude 无 interruptTurn,
 *   forceInterrupt 对其无效);
 * - 单一互斥队列:主动汇报与用户语音不会并发两次 claude 调用。
 *
 * 纯函数(parseContractJson / applyMemoryOps / buildAgentSnapshotLines /
 * buildDelegationSummaryLines / shouldRotateSession)导出以便单测;IO 部分保持薄。
 */

import { spawn } from 'child_process';
import * as agentService from './agent-service.js';
import * as bossService from './boss-service.js';
import { logger } from '../utils/index.js';
import { createSlowFiller } from '../voice/slow-filler.js';
// C21 垫话承诺护栏:出口硬闸(事故「好嘞,两分钟后喊你」;纯提示词已证伪)。
// W7 垫话预生成:说话期间的流式 partial 即触发垫话生成,密封后回合零等待取用。
// 垫话 v2 静态池:默认档垫话改为池内选句(不读半句 partial、不让模型造句);
// 动态生成降级为 TC_VOICE_FILLER_MODE=llm 实验档。
// 任务39·F2/F3/F4:最近轮次环缓冲(交接材料源)+ 交接便签预生成/认领渲染(纯函数)。
import {
  appendRecentTurn,
  isHandoffEnabled,
  handoffObservation,
} from '../voice/handoff.js';
// 任务19:工具白名单/中立 cwd/effort —— spawn 档案唯一解析点(与常驻通道共用)。
// 任务18·秘书常驻化:轻量常驻通道(进程跨回合存活 + stdin 复用;回退开关在模块内)。
// 每回合 args 与既有 callClaudeOnce 逐字同构,权限姿态不变;hop2 保持一次性。
import {
  stopCompanionProcess,
  hasLiveCompanionProcess,
} from '../voice/companion-runner.js';
import { personaKeyOf } from '../../shared/voice-personas.js';
import {
  logDialogMessage,
  logBroadcast,
  logDelegation,
  logMemoryOps,
  logSession,
} from './activity-log.js';
// 待岗(standby)守卫:单一事实源(派发/主管/HTTP 通路共用同一判定,勿另写)。
import { AGENT_ON_STANDBY, isOnStandby } from './agent-standby.js';
import { ensureTaskId, runWithTrace, updateTraceContext } from '../utils/trace-context.js';
// 任务32 人格层：核心身份（固定）常驻 + 关系模型（可演化）——纯逻辑全在 jarvis-core/persona/**（本文件只做接线）
import { runLogAnalysis, renderLogAnalysisReport } from '../log-analysis/index.js';
import { logEvent } from '../data/system-log.js';
// 任务14·⑪ 项目感知与路由：纯逻辑全在 jarvis-core/projects/**（本文件只做接线）。
import { isProjectRoutingEnabled } from '../jarvis-core/projects/types.js';
import type { ProjectResolveResult } from '../jarvis-core/projects/types.js';
// 任务13·⑩ 秘书 Bolba 桥：业务待办（报价/付款/会议…）的只读查询与创建/完成/重开。
// 两本账边界：本文件里这四动作只碰 Bolba 账本，绝不进 ① 委派通道。
import {
  BOLBA_CONTRACT_ACTIONS,
  handleBolbaContractAction,
  type BolbaContractAction,
} from './bolba-bridge-service.js';
// 任务07·④ 查进度走下属:query 目标为 Boss 时的委派树解析/材料拼接/观测点④字段(纯逻辑在 voice/ 下)
import {
  buildDelegationQueryMaterial,
  buildNoDelegationResponse,
  buildSingleAgentQueryMaterial,
  pickRecentAgentDelegations,
  pickRecentDelegations,
  planQueryRoute,
  // 任务16·⑬ 撤回/评价纯逻辑(目标解析/反问消费/评价极性/话术)
  buildCancelClarifyQuestion,
  buildCancelNoneResponse,
  buildCancelPendingDispatchResponse,
  buildNoRatingTargetResponse,
  buildRatingConfirmResponse,
  buildRatingTargetQuestion,
  isActionableCancelState,
  planCancelAction,
  parseRatingPolarity,
  pickLatestUnratedCompletion,
} from '../voice/delegation-query.js';
// 任务40 办结主动汇报：派活成功时登记「最近一次秘书→主管派活」（上行回执链登记簿）
import { isBossUplinkReceiptEnabled, registerBossUplinkReceipt } from '../websocket/handlers/boss-uplink-receipt-registry.js';

// ---- 模块拆分(A1,2026-10-11):类型/常量/谓词/配置 IO/状态 IO 移入 voice-companion/ 子目录 ----
// 对外导出继续经本文件 re-export(见文件末尾),外部 import 路径与名字不变。
import {
  VoiceCompanionAbortedError,
  type CompanionDelivery,
  type VoiceProcessOptions,
  type VoiceProcessResult,
} from './voice-companion/types.js';
import {
  DEGRADED_RESPONSE,
  QUERY_LOG_PREVIEW_CHARS,
} from './voice-companion/constants.js';
import { isBossLikeAgent } from './voice-companion/agents.js';
import { loadServerConfig } from './voice-companion/config.js';
import { loadCompanionState, saveCompanionState } from './voice-companion/state.js';
// ---- 模块拆分(A2,2026-10-11):纯函数族(契约/会话/快照/派发路由)移入 voice-companion/ 子目录 ----
import { applyMemoryOps, truncate, warnUnappliedMemoryRemoves } from './voice-companion/contract.js';
import { computeContextState, isContextCompactionDue, shouldRotateForPersona, shouldRotateSession } from './voice-companion/session.js';
import { collectDelegationHistory } from './voice-companion/snapshot.js';
import { resolveDispatchRoute } from './voice-companion/dispatch-route.js';
// ---- 模块拆分(B,2026-10-11):接线层(撤回/评价、派发执行、项目路由)移入 voice-companion/ 子目录 ----
import {
  cancelWaitBudgetMs,
  collectCancelCandidates,
  consumeCancelClarification,
  executeCancel,
  getLastBossDispatch,
  getPendingCancelClarification,
  recordLastBossDispatch,
  resetCancelClarificationSession,
  setPendingCancelClarification,
  waitFreshDispatchCandidate,
} from './voice-companion/cancel.js';
import { deliverToAgent } from './voice-companion/deliver.js';
import {
  buildProjectRoutingWorld,
  consumeProjectClarification,
  logProjectRouting,
  projectRoutingRuntime,
  resetProjectRoutingSession,
  resolveProjectRoutingForTurn,
} from './voice-companion/project-routing.js';

// ---- 模块拆分(C,2026-10-11):提示词/调用层/回合/垫话/查询材料/播报/互斥/回合辅助/状态 移入 voice-companion/ ----
import { type Hop1Outcome, prewarmCompanion, runHop1, runHop2 } from './voice-companion/hop.js';
import { generateSlowFillerPhrase, resolvePregenFiller, takeFillerPregen } from './voice-companion/filler.js';
import {
  buildAgentListFallback,
  buildSubordinateQueryEntry,
  fetchAgentOutputExcerpt,
  logQueryChain,
  readBossDelegationHistory,
} from './voice-companion/query.js';
import { withMutex } from './voice-companion/mutex.js';
import { PRE_ACK_SUPPRESS_AFTER_FILLER_MS, createSpeechPipeline } from './voice-companion/speech.js';
import { getJarvisMemory, handoffRuntime, maybePregenHandoff, pickLogWindowPreset } from './voice-companion/turn-helpers.js';

const log = logger.server;

// ============================================================================
// Main entry
// ============================================================================

/**
 * 处理一段最终文本(用户语音转写或 ⟦系统事件⟧)。返回给客户端用于播报的
 * response;模型超时/解析失败时降级为兜底话术(degraded=true),只有
 * spawn 失败(ENOENT 等)才抛出。
 */
export async function processVoiceInput(text: string, opts: VoiceProcessOptions = {}): Promise<VoiceProcessResult> {
  // 任务 02：语音回合是链路起点，runWithTrace 让本回合所有埋点共享 taskId/sessionId。
  return withMutex(async () => runWithTrace({ source: 'voice-companion' }, async () => {
    const started = Date.now();
    const cfg = loadServerConfig();

    // W5 慢档续垫:与主链路解耦 —— 生成走一次性调用(resumeId:null,不碰常驻),
    // 吐出走 pre 通道(照播但不参与客户端最终对账)。任何真实句(含 query 过渡句)
    // 一出即取消;事件回合不武装(noop 场景不出声)。
    const rawOnSentence = opts.onSentence;
    // W7 垫话预生成:命中则改用零等待档 —— armMs=0 立即取用、emitMs=pregenEmitMs
    // (缺省 3000,与兜底档吐出底线一致:预生成只保证「到点即出、音频已备」,不提前触发线);
    // 未命中/失败/禁用全链回退兜底档(500/2500),逐字节等同旧行为。
    // 注:极少数「澄清早退回合」会白耗一个已消费的预生成(消歧回复通常很短、本就到不了触发阈值),可忽略。
    const pregen = !opts.isEvent && cfg.slowFiller.enabled && rawOnSentence
      ? takeFillerPregen(text)
      : null;
    /** 本回合垫话真正吐出时刻(0=没吐过);供 query 过渡句反冲抑制判定(见 releaseHop1 处)。 */
    let fillerEmittedAt = 0;
    const slowFiller = createSlowFiller({
      enabled: cfg.slowFiller.enabled && !!rawOnSentence,
      armMs: pregen ? 0 : cfg.slowFiller.armMs,
      emitMs: pregen ? cfg.slowFiller.pregenEmitMs : cfg.slowFiller.emitMs,
      generate: pregen
        ? () => resolvePregenFiller(pregen, text, cfg.model, opts.signal)
        : () => generateSlowFillerPhrase(text, cfg.model, opts.signal),
      emit: (sentence) => {
        // 与「慢档垫话:…」(生成完成,可能随后被取消)区分:这一行才是真正推给客户端播出的垫话。
        log.log(`[VoiceCompanion] 垫话吐出:${sentence}`);
        fillerEmittedAt = Date.now();
        rawOnSentence?.(sentence, { pre: true });
      },
    });
    const speech = createSpeechPipeline(
      rawOnSentence
        ? (sentence, meta) => {
            slowFiller.cancel(); // 有真实句出声,垫话已无必要
            rawOnSentence(sentence, meta);
          }
        : undefined,
      // W2 阶段2:首句机械上限(0=关,默认;见 loadServerConfig 登记)。
      { firstMaxChars: cfg.firstSentenceMaxChars },
    );
    const state = loadCompanionState();
    const personaKey = personaKeyOf(cfg.persona.preset, cfg.persona.custom);

    /**
     * W3 预热点火:回合收尾时若常驻进程已不在(超时/中止/崩溃被杀),静默补建 ——
     * 下一回合直接复用,不再吃冷启动。事件回合不预热;活进程在场时零动作。
     * 异步(setTimeout 0)不占回合响应路径;与下一回合 spawn 的竞态由单线程时序 +
     * 幂等守卫兜底(进程已在/回合中则跳过)。
     */
    const schedulePrewarm = (): void => {
      if (opts.isEvent || hasLiveCompanionProcess()) return;
      setTimeout(() => { prewarmCompanion(); }, 0);
    };

    /** 回合收尾(正常 finish / 中止重抛)统一出口:停宽限计时器 + 停垫话 + 补建预热。 */
    const disposeTurn = () => {
      slowFiller.cancel();
      speech.dispose();
      schedulePrewarm();
    };

    if (shouldRotateSession(state, cfg) || shouldRotateForPersona(state, personaKey) || isContextCompactionDue(state, cfg)) {
      // W3 预热点火:是否需要停常驻进程,取决于「确有待失效对象」——
      // ① 有会话:旧 --resume/旧提示词必须废,停;
      // ② 人设从有记录的旧值变化:常驻进程里的提示词过期,停;
      // ③ 首次开局(状态无人设记录、无会话):轮换只是把当前人设写进状态,预热点火
      //    建好的进程拿的本就是当前人设 → 不停,否则预热会在首个回合被白杀掉
      //    (首个回合恰恰是最值得藏冷启动的一次)。
      const hadSession = !!state.sessionId;
      const personaChangedFromRecorded = state.personaKey != null && state.personaKey !== personaKey;
      // 任务 27·尾 挂点2(会话结束):旧会话摘要先落工作记忆 + 生命周期裁剪,再清 session。
      // 任务18:上下文到阈值同样走此路径 = 压缩 v1「摘要续跑」。
      // 任务39·F4:轮换前先认领交接便签——只认「本会话」的待收笔记(开关关则不认领);
      // 认领文本即 summarizeSession 的摘要素材(新会话的工作记忆起点);未命中 → 降级
      // 现状(summary 原样,旧笔记保留继续兜底)。
      if (state.sessionId) {
        const claim = isHandoffEnabled() && handoffRuntime.pending?.forSessionId === state.sessionId
          ? handoffRuntime.pending
          : null;
        if (claim) {
          state.memory.handoff = { text: claim.text, forSessionId: claim.forSessionId, at: claim.at };
          handoffRuntime.pending = null;
          log.log(`[VoiceCompanion] 交接笔记已认领(${Date.now() - claim.at}ms 前生成, ${claim.text.length} 字)`);
        } else if (isHandoffEnabled()) {
          log.log('[VoiceCompanion] 交接笔记未及生成(降级现状)');
        }
        await getJarvisMemory().engine.summarizeSession({
          sessionId: state.sessionId,
          summary: claim?.text ?? state.memory.summary,
        });
      }
      await getJarvisMemory().engine.sweep();
      resetProjectRoutingSession(); // 任务14·⑪：项目路由内存态（最近提及/挂起反问）与 session 同生命周期
      resetCancelClarificationSession(); // 任务16·⑬：撤回反问挂起随会话轮换一并清空
      log.log(`[VoiceCompanion] 会话轮换(turns=${state.turns}),保留记忆`);
      // 系统活动 5：会话轮换留痕（超龄 → expired；轮数上限/人设切换/上下文压缩 → rotated）。
      if (state.sessionId) {
        const sessionAgeMs = state.sessionStartedAt != null ? Date.now() - state.sessionStartedAt : undefined;
        const ageExpired = sessionAgeMs != null && sessionAgeMs > cfg.sessionMaxAgeDays * 86_400_000;
        const rotateByTurns = state.turns >= cfg.maxTurns;
        const rotateByPersona = shouldRotateForPersona(state, personaKey);
        logSession({
          phase: ageExpired ? 'expired' : 'rotated',
          sessionId: state.sessionId,
          reason: ageExpired ? 'max-age'
            : rotateByTurns ? 'max-turns'
              : rotateByPersona ? 'persona-changed'
                : 'context-compact', // 任务18:压缩 v1 触发(percent 或绝对 token 闸口,见 isContextCompactionDue)
          ageMs: sessionAgeMs,
        });
      }
      state.sessionId = null;
      state.sessionStartedAt = null;
      state.turns = 0;
      state.context = null; // 任务18:占用快照随会话一并清零
      state.recentTurns = []; // 任务39·F2:环缓冲随轮换清空(新会话从零攒;F4 认领素材来自内存预生成,与此无关)
      // 任务18:轮换后旧常驻进程(带旧 --resume/旧系统提示词)必须停掉,下一回合重新 spawn。
      if (hadSession || personaChangedFromRecorded) stopCompanionProcess('session-rotation');
    }
    state.personaKey = personaKey;

    // 任务 27·尾 挂点1(先写后回应):用户陈述命中触发词先落工作记忆再进 hop1;系统事件不算用户陈述。
    if (!opts.isEvent) {
      await getJarvisMemory().engine.captureUserTurn(text, { sessionId: state.sessionId ?? undefined });
    }
    // 任务39·F2:用户句入环缓冲(事件回合也记,event:true 是语境);本回合收尾的
    // saveCompanionState 落盘(轮换清空在前,此处记的是新会话的第一句)。
    if (isHandoffEnabled()) {
      state.recentTurns = appendRecentTurn(state.recentTurns, {
        role: 'user',
        text,
        at: Date.now(),
        ...(opts.isEvent ? { event: true as const } : {}),
      });
    }

    // 任务 02 埋点：本回合 taskId 在此生成一次（对话 in/out、播报、委派共用同一时间线）。
    // 「任务类」与否由 hop1 判定，taskId 仅作关联 ID，纯聊天回合多一个 ID 无副作用。
    const taskId = ensureTaskId();
    logDialogMessage({
      direction: 'in',
      text,
      sessionId: state.sessionId ?? undefined,
      taskId,
      isEvent: !!opts.isEvent,
    });

    // 任务39·F2:finish 每回合只调一次;幂等旗标防未来多路径重用(重复记素材)。
    let handoffClosed = false;
    const finish = (r: VoiceProcessResult): VoiceProcessResult => {
      disposeTurn(); // 取消悬尾宽限计时器(正常收尾时未被触发的那次)+ 停垫话计时
      if (speech.spoke) r.spoke = true;
      // 任务39·F2:最终回复入环缓冲(不取中间过渡句;降级话术不算材料,异常路径不走 finish)。
      // 此处统一补一次落盘(早前各 return 点保存的快照不含本回合助手侧)。
      if (isHandoffEnabled() && !handoffClosed) {
        handoffClosed = true;
        if (typeof r.response === 'string' && r.response.trim().length > 0 && !r.degraded) {
          state.recentTurns = appendRecentTurn(state.recentTurns, { role: 'assistant', text: r.response, at: Date.now() });
          saveCompanionState(state);
        }
      }
      // 任务 02 埋点：回合最终回应 = 对话(out) + 播报(phase=server-sent，实际播放链路在客户端)
      if (r.response) {
        logDialogMessage({
          direction: 'out',
          text: r.response,
          sessionId: state.sessionId ?? undefined,
          taskId,
          action: r.action,
          degraded: r.degraded,
          targetAgentId: r.targetAgent?.id,
        });
        logBroadcast({
          text: r.response,
          phase: 'server-sent',
          action: r.action,
          degraded: r.degraded,
          sessionId: state.sessionId ?? undefined,
          taskId,
        });
      }
      return r;
    };

    // 任务14·⑪ 一次性消歧：上一回合挂了反问 → 本回合先按「回答」消费一次
    // （确定性解析，不跑 hop1、不反问第二次；取消/命中/回落三分支见 consumeProjectClarification）。
    if (!opts.isEvent && isProjectRoutingEnabled() && projectRoutingRuntime.pending) {
      const clarified = await consumeProjectClarification(text, state, taskId, started);
      if (clarified) {
        state.turns += 1;
        state.lastUsedAt = Date.now();
        saveCompanionState(state);
        return finish(clarified);
      }
    }

    // 任务16·⑬ 撤回一次性反问：上一回合挂了撤回反问 → 本回合先按「回答」消费一次
    // （确定性解析，不跑 hop1；编号/名字命中 → 直接撤回，放弃话术 → 不撤，其余丢弃挂起按普通回合继续）。
    if (!opts.isEvent && getPendingCancelClarification()) {
      const cancelled = await consumeCancelClarification(text, taskId, started);
      if (cancelled) {
        state.turns += 1;
        state.lastUsedAt = Date.now();
        saveCompanionState(state);
        return finish(cancelled);
      }
    }

    // W5:用户回合才武装垫话(事件回合可能 noop,不浪费一次生成)。
    if (!opts.isEvent) slowFiller.arm();

    let outcome: Hop1Outcome;
    try {
      outcome = await runHop1(text, state, cfg, !!opts.isEvent, {
        // W5 加固(真麦双垫教训):hop1 一动笔(思考结束、开始出文本),首句/过渡句
        // 就在 1 秒内 —— 此刻垫话已无必要,立即作废在途垫话。这比「整句出闸才取消」
        // 更早:query 过渡句在 SpeechGate 里缓到目标解析后才放行(实测 ~9.1s),只靠
        // 句子取消时垫话可能已吐出(实测 8.79s) → 「垫话+过渡句」双出声。
        // 思考过程不在 text_delta 里(callClaudeOnce 只转发 text_delta),长思考的
        // 静默依然由垫话兜底。
        onTextDelta: (fullText: string) => {
          slowFiller.cancel();
          speech.onHop1Delta(fullText);
        },
        signal: opts.signal,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { name?: string };
      if (e.code === 'ENOENT') {
        disposeTurn();
        throw err; // 服务器没装 claude —— 配置问题,交给路由 500
      }
      if (e.name === 'VoiceCompanionAborted') {
        disposeTurn();
        throw err; // 客户端已断开:交给路由静默收尾
      }
      const shouldDegrade = e.name === 'VoiceCompanionTimeout'
        || e.name === 'VoiceCompanionParse'
        || /exited with code|No response from Claude/.test(e.message ?? '');
      if (!shouldDegrade) throw err;
      log.error(`[VoiceCompanion] hop1 降级: ${e.message}`);
      // 注意:超时/失败**不**重置会话。
      state.lastUsedAt = Date.now();
      saveCompanionState(state);
      return finish({ action: 'general_response', response: DEGRADED_RESPONSE, degraded: true, elapsedMs: Date.now() - started });
    }

    state.turns += 1;
    state.lastUsedAt = Date.now();
    // 任务 02：hop1 成功后 sessionId 才就绪（含 resume），回填链路上下文供后续埋点复用。
    updateTraceContext({ sessionId: state.sessionId ?? undefined });

    // 任务18:usage 采集落状态 + 观测(⑭ 系统活动 4 context_stats 采样通道;不新增 logSession 埋点)。
    if (outcome.context) {
      const ctx = computeContextState(outcome.context, cfg);
      if (ctx) {
        state.context = ctx;
        logEvent('context_stats', {
          source: 'voice-companion',
          sessionId: state.sessionId ?? undefined,
          body: {
            tokensUsed: ctx.tokensUsed,
            windowTokens: ctx.windowTokens,
            percent: Math.round(ctx.percent * 1000) / 10,
            compactPercent: Math.round(cfg.contextCompactPercent * 100),
            // 任务39:绝对 token 闸口(0 = 关);列进采样便于 ⑭ 观测阈值命中分布。
            compactTokens: cfg.contextCompactTokens || undefined,
            // 任务39·F4:本回合交接状态(none/pending/attached/stale;开关关不给字段,
            // 回退档采样与接入前逐字一致)——供 ⑮ 标定认领率与 72h 时效命中。
            handoff: isHandoffEnabled()
              ? handoffObservation(state.memory.handoff ?? null, handoffRuntime.pending, state.sessionId, Date.now())
              : undefined,
          },
        });
        // 任务39·F3:跨过预备线(触发线−0.1)即后台预生成交接便签——
        // fire-and-forget 不进关键路径;轮换在下一回合起点,此处是最后的提前量。
        maybePregenHandoff(state, cfg);
      }
    }
    // W6 感知提速观测:每回合 usage/缓存命中/常驻复用(hop1 耗时已有独立行;首句 tMs 打点在路由)。
    {
      const u = outcome.context;
      log.log(
        `[VoiceCompanion] usage in=${u?.inputTokens ?? '-'} out=${u?.outputTokens ?? '-'} cacheRead=${u?.cacheReadInputTokens ?? '-'} cacheWrite=${u?.cacheCreationInputTokens ?? '-'} window=${u?.contextWindow ?? '-'} | resident=${outcome.reused ? 'reuse' : 'spawn'} | action=${outcome.contract.action}`,
      );
    }

    const { contract } = outcome;
    // 任务 27·尾 挂点3(模型确认):契约 memoryOps 双写进 vault;下方 applyMemoryOps 块保持原样(旧 CompanionMemory 独立运转)。
    if (contract.memoryOps.length > 0) {
      await getJarvisMemory().engine.bridgeVoiceMemoryOps(contract.memoryOps, { sessionId: state.sessionId ?? undefined });
    }
    // 流式期间若 action 尚未解析出来,这里兜底补上(缓冲的句子按语义放行/丢弃)。
    speech.setHop1Action(contract.action);
    let memoryOpsApplied = 0;
    if (contract.memoryOps.length > 0) {
      const { memory, applied, details } = applyMemoryOps(state.memory, contract.memoryOps, cfg.maxNotes);
      if (applied > 0) {
        state.memory = memory;
        memoryOpsApplied = applied;
        log.log(`[VoiceCompanion] 记忆更新 ${applied} 条(共 ${memory.notes.length} 条)`);
      }
      // 任务 02 埋点：系统活动 2 —— 每个 op 的生效明细与裁剪 droppedCount 全量落盘
      logMemoryOps({
        applied,
        details,
        notesTotal: state.memory.notes.length,
        droppedTotal: state.memory.droppedCount,
        sessionId: state.sessionId ?? undefined,
        channel: 'voice',
      });
      // A13/H6-1:删除未命中(含文本兜底失败)必须可见,不能只有 details.applied=false。
      warnUnappliedMemoryRemoves(details, 'voice');
    }
    saveCompanionState(state);

    const result: VoiceProcessResult = {
      action: contract.action,
      response: contract.responseToUser,
      memoryOpsApplied,
      elapsedMs: Date.now() - started,
    };

    if (contract.action === 'delegate_to_boss'
      || (contract.action === 'send_to_agent' && contract.targetAgentId)) {
      // 改① 任务只走 Boss:delegate_to_boss 目标固定为主管;send_to_agent 仅主管可达,
      // 模型若仍指向普通 agent(旧会话/回归)→ 违规告警(决策观测点①)+ 改道主管,
      // 保住「全走 Boss」不变式,而不是静默直派或丢任务。
      const agents = agentService.getAllAgents();
      // 任务14·⑪：派活前做一次三层消歧（仅 delegate_to_boss；纯逻辑在 projects 模块，
      // 这里只拼输入）。开关关 / 事件回合 = undefined，route 行为与旧版逐字一致。
      let projectDecision: ProjectResolveResult | undefined;
      if (!opts.isEvent && contract.action === 'delegate_to_boss' && isProjectRoutingEnabled()) {
        try {
          const world = buildProjectRoutingWorld({ getAllAgents: () => agents });
          projectDecision = resolveProjectRoutingForTurn({
            text,
            targetAgentId: contract.targetAgentId,
            agents,
            world,
            lastProjectId: projectRoutingRuntime.lastProjectId,
          });
        } catch (err) {
          log.warn(`[VoiceCompanion] 项目路由解析失败(按现状默认处理): ${(err as Error).message}`);
        }
      }
      const route = resolveDispatchRoute(contract.action, contract.targetAgentId, agents, projectDecision);

      if (route.route === 'missing') {
        // 没派出去就不能播「已让 X 去做」——丢弃缓冲,整段走 result.response 兜底。
        speech.discardHop1();
        result.response = contract.responseToUser || `没找到这个 agent(${contract.targetAgentName || contract.targetAgentId})。`;
        return finish(result);
      }

      if (route.violation) {
        // 🔴 决策观测点①:违规直派告警(warn 全量落盘,供 ⑮ 分析不变式是否被破)
        logDelegation({
          phase: 'blocked',
          level: 'warn',
          channel: 'voice-companion',
          toAgentId: route.violation.requestedAgentId,
          toAgentName: route.violation.requestedAgentName ?? undefined,
          message: contract.messageToAgent,
          delivery: contract.delivery,
          status: 'direct-dispatch-blocked',
          error: `violation: ${contract.action} 请求直派普通 agent(${route.violation.requestedAgentId}),已改道主管`,
          routedBy: contract.action,
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
      }

      if (!contract.messageToAgent) {
        speech.discardHop1();
        result.response = contract.responseToUser || '我没听清要让它做什么,请再说一遍。';
        return finish(result);
      }
      if (route.route === 'need_ask') {
        // 任务14·⑪ 三态路由之歧义：All + 多主管 + 三层消不掉 → 不派发，只反问一次；
        // 挂起原任务指令，等下一回合回答后确定性派发（不再跑 hop1，也不二次反问）。
        speech.discardHop1();
        const question = route.decision.askQuestion ?? '这活要交给哪个项目？回一句项目名就行。';
        projectRoutingRuntime.askCount += 1;
        projectRoutingRuntime.pending = {
          question,
          ...(route.decision.suggestedProjectId ? { suggestionProjectId: route.decision.suggestedProjectId } : {}),
          message: contract.messageToAgent,
          delivery: contract.delivery,
          askedAt: Date.now(),
          taskId,
          originalText: truncate(text, 120),
        };
        result.response = question;
        logProjectRouting({
          kind: 'need-ask',
          at: Date.now(),
          sessionId: state.sessionId ?? undefined,
          taskId,
          text: truncate(text, 80),
          decision: route.decision,
          question,
          askCount: projectRoutingRuntime.askCount,
        });
        logDelegation({
          phase: 'failed',
          channel: 'voice-companion',
          message: contract.messageToAgent,
          status: 'project-need-ask',
          error: 'project-ambiguous',
          routedBy: 'project-clarify',
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
        return finish(result);
      }
      if (route.route === 'no_boss') {
        // 任务语义但没有可转交的主管:如实告知,不派给任何普通 agent。
        speech.discardHop1();
        result.response = '团队里还没有主管(Boss),这事我暂时派不出去。先在团队里设一个主管,再让我派活吧。';
        logDelegation({
          phase: 'failed',
          channel: 'voice-companion',
          message: contract.messageToAgent,
          status: 'no-boss',
          error: 'no-boss-agent',
          routedBy: contract.action,
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
        return finish(result);
      }

      const target = route.agent;
      // 违规改道不携带打断语义:打断决定是针对被请求的普通 agent 做的,转到主管一律 queue。
      const delivery: CompanionDelivery = route.violation ? 'queue' : contract.delivery;
      // 待岗(用户手动停用)拒派:底层 sendCommand 守卫同样会拦(AGENT_ON_STANDBY),
      // 但那是抛错(500);这里与其他路由失败分支(no_boss 等)同型 —— 提前用整段
      // 确定性话术说清「为什么没派出去、怎么恢复」,不投递、不打断、不登记回执。
      if (isOnStandby(target)) {
        speech.discardHop1();
        result.response = `「${target.name}」正在待岗(已被用户停用),派不了活——需要你先在智能体面板把它恢复上岗,我才能安排。`;
        logDelegation({
          phase: 'failed',
          channel: 'voice-companion',
          toAgentId: target.id,
          toAgentName: target.name,
          message: contract.messageToAgent,
          status: 'agent-on-standby',
          error: AGENT_ON_STANDBY,
          routedBy: contract.action,
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
        return finish(result);
      }
      let interrupted: boolean;
      try {
        interrupted = await deliverToAgent(target, contract.messageToAgent, delivery);
      } catch (err) {
        // 任务 02 埋点：基础四类 ③ —— 派活失败行（channel 与成功行一致，原错误继续上抛）
        logDelegation({
          phase: 'failed',
          channel: 'voice-companion',
          toAgentId: target.id,
          toAgentName: target.name,
          message: contract.messageToAgent,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          routedBy: contract.action,
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
        throw err;
      }
      result.targetAgent = { id: target.id, name: target.name };
      result.messageSent = contract.messageToAgent;
      result.delivery = delivery;
      result.interrupted = interrupted;
      // 任务 02 埋点：基础四类 ③ —— 派活出站（voice-companion 渠道）;
      // routedBy 记录路由判定(决策观测点①:请求 → 目标 Boss)。
      logDelegation({
        phase: 'dispatched',
        channel: 'voice-companion',
        toAgentId: target.id,
        toAgentName: target.name,
        message: contract.messageToAgent,
        delivery,
        interrupted,
        status: route.violation ? 'rerouted-to-boss' : undefined,
        routedBy: route.violation ? `${contract.action}-rerouted` : contract.action,
        taskId,
        sessionId: state.sessionId ?? undefined,
      });
      // HC-B4/B5：记最近一次「交给主管」的派活（TTL 120s）——B4 撤回窗口等待 +
      // B5 委派决策 taskCard.projectId 回填共用；只在目标确实是主管时记（普通 agent 不会产出委派决策）。
      if (isBossLikeAgent(target)) {
        recordLastBossDispatch({
          bossId: target.id,
          at: Date.now(),
          ...(route.projectRouting?.projectId ? { projectId: route.projectRouting.projectId } : {}),
          taskId,
        });
        // 任务40：登记「最近一次秘书→主管派活」快照 —— 主管链路收口时交付上行回执
        //（「已回复」/「已办结」，复用 08 task_receipt 通道 + 09 闸门播报）；开关关闭零记账。
        // 派发失败（上方 await deliverToAgent 抛出）自然走不到这里；纯内存登记不打断主链路。
        if (isBossUplinkReceiptEnabled()) {
          registerBossUplinkReceipt({
            bossId: target.id,
            taskSummary: text,
            ...(route.projectRouting?.projectId ? { projectId: route.projectRouting.projectId } : {}),
            taskId,
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          });
        }
      }
      // 任务14·⑪ ⑪ 观测（仅 delegate_to_boss）：登记三层结果/最终 Boss/是否回落首选；
      // 命中携带 projectId → 记会话最近提及（消歧② 输入）。
      if (contract.action === 'delegate_to_boss' && isProjectRoutingEnabled()) {
        const pr = route.projectRouting;
        const explicitRequested = contract.targetAgentId ? agents.find((a) => a.id === contract.targetAgentId) : undefined;
        const explicitBoss = !!explicitRequested && isBossLikeAgent(explicitRequested);
        logProjectRouting({
          kind: 'route',
          at: Date.now(),
          sessionId: state.sessionId ?? undefined,
          taskId,
          text: truncate(text, 80),
          ...(pr ? { decision: pr } : {}),
          finalBossId: target.id,
          fallbackToFirstBoss: !explicitBoss && !pr?.bossId,
        });
        if (pr?.projectId) projectRoutingRuntime.lastProjectId = pr.projectId;
      }
      if (route.violation) {
        // 模型话术多半指名了被拒的普通 agent,不可信 → 丢弃缓冲,用确定性话术整段兜底。
        speech.discardHop1();
        result.response = `我只能把任务交给主管「${target.name}」安排,已经转过去了。`;
      } else if (!result.response) {
        result.response = interrupted
          ? `已打断 ${target.name},改用新任务。`
          : contract.action === 'delegate_to_boss'
            ? `已交给主管「${target.name}」安排。`
            : `已让 ${target.name} 去做。`;
      }
      // 派发成功,放行缓冲的确认话术(「已让 X …」/「已交给主管…」)。
      speech.releaseHop1();
      log.log(`[VoiceCompanion] → ${target.name}(${delivery}${interrupted ? ',已打断' : ''}${route.violation ? ',违规改道' : ''}): ${contract.messageToAgent}`);
      return finish(result);
    }

    if (contract.action === 'query_agent_output' && contract.targetAgentId) {
      const queryStartedAt = Date.now();
      const question = contract.query || text;
      const requestPreview = truncate(question, QUERY_LOG_PREVIEW_CHARS);
      const logCtx = { sessionId: state.sessionId ?? undefined, taskId };
      const target = agentService.getAgent(contract.targetAgentId);
      const route = planQueryRoute(target);

      // 🔴 决策观测点④:请求入口 + 路由判定先落一条 —— hop 卡住/中止时仍有「查过谁」的证据。
      logQueryChain({
        phase: 'request',
        request: requestPreview,
        route,
        targetAgentId: target?.id ?? contract.targetAgentId,
        targetName: target?.name ?? contract.targetAgentName ?? undefined,
      }, logCtx);

      if (!target) {
        // W4:responseToUser 现在是过渡话术(≤12 字先应声),不能当整段答案重播 —— 一律确定性兜底。
        speech.discardHop1();
        result.response = `没找到这个 agent(${contract.targetAgentName || contract.targetAgentId})。`;
        logQueryChain({
          phase: 'completed',
          request: requestPreview,
          route: 'no-target',
          targetAgentId: contract.targetAgentId,
          targetName: contract.targetAgentName ?? undefined,
          hops: 1,
          durationMs: Date.now() - queryStartedAt,
          responsePreview: truncate(result.response, QUERY_LOG_PREVIEW_CHARS),
        }, logCtx);
        return finish(result);
      }

      // 任务07·④:目标是 Boss 时不再只取它自己的 excerpt(旧的 Boss 历史只有调度文本),
      // 改为解析委派树 —— 最近委派 → 每个下属的 assistant 产出 → 汇总材料(边界:只查最近委派)。
      let material: string | null = null;
      let subordinateIds: string[] | undefined;
      if (route === 'boss-tree') {
        const recent = pickRecentDelegations(readBossDelegationHistory(target.id));
        if (recent.length === 0) {
          // 行为定义 3:无委派记录 → 如实告知,不跑 hop2(确定性话术,防模型编造)。
          speech.discardHop1();
          result.response = buildNoDelegationResponse(target.name);
          result.targetAgent = { id: target.id, name: target.name };
          logQueryChain({
            phase: 'completed',
            request: requestPreview,
            route,
            targetAgentId: target.id,
            targetName: target.name,
            subordinateIds: [],
            hops: 1,
            durationMs: Date.now() - queryStartedAt,
            responsePreview: truncate(result.response, QUERY_LOG_PREVIEW_CHARS),
          }, logCtx);
          return finish(result);
        }
        const entries = await Promise.all(recent.map((d) => buildSubordinateQueryEntry(d)));
        material = buildDelegationQueryMaterial({ bossName: target.name, entries });
        subordinateIds = entries.map((e) => e.agentId);
      } else {
        // B(2026-10-07):单 agent 查询也带病历段 —— 从委派史取该 agent 最近任务,与
        // boss-tree 同款条目化(完成看病历、在办看进度),不再只给一段原始会话输出;
        // 产出一次性读取,仅最新一条携带(见 buildSubordinateQueryEntry 的 override 注释);
        // 无委派记录 → material 保持 null,走原有 excerpt 兜底(行为不变)。
        const records = pickRecentAgentDelegations(collectDelegationHistory(agentService.getAllAgents()), target.id);
        if (records.length > 0) {
          let agentExcerpt = '';
          try {
            agentExcerpt = await fetchAgentOutputExcerpt(target.id);
          } catch (err) {
            log.warn(`[VoiceCompanion] 读取产出失败(${target.id}),按无产出处理: ${(err as Error).message}`);
          }
          const entries = await Promise.all(
            records.map((d, i) => buildSubordinateQueryEntry(d, i === 0 ? agentExcerpt : '')),
          );
          material = buildSingleAgentQueryMaterial({ agentName: target.name, entries });
        }
      }

      // W4 感知提速:至此已确定要走第二跳(目标有效、Boss 树有委派)—— 放行缓冲的
      // 过渡话术(「在,我去看一眼」)即刻出声,等待不再静默;带 pre 标记,不参与客户端
      // 最终对账(否则 hop2 答案到达时会因不等而整段重播)。
      // 垫话反冲(2026-10-07):慢档垫话刚出过声时不再叠加过渡句(上闸见常量注释);
      // 丢弃的只是过渡话术,hop2 答案不受影响。
      if (fillerEmittedAt > 0 && Date.now() - fillerEmittedAt < PRE_ACK_SUPPRESS_AFTER_FILLER_MS) {
        speech.discardHop1();
        log.log(`[VoiceCompanion] 过渡句抑制(垫话 ${Date.now() - fillerEmittedAt}ms 前刚出声,双垫防线)`);
      } else {
        speech.releaseHop1({ pre: true });
      }

      const excerpt = material ?? await fetchAgentOutputExcerpt(target.id);
      const hop2Started = Date.now();
      try {
        const answer = await runHop2(
          question,
          target.name,
          target.status,
          target.taskLabel || target.lastAssignedTask,
          target.lastError,
          excerpt,
          cfg,
          { onTextDelta: speech.onHop2Delta, signal: opts.signal },
        );
        result.response = answer;
        logQueryChain({
          phase: 'completed',
          request: requestPreview,
          route,
          targetAgentId: target.id,
          targetName: target.name,
          subordinateIds,
          hops: 2,
          durationMs: Date.now() - queryStartedAt,
          responsePreview: truncate(answer, QUERY_LOG_PREVIEW_CHARS),
        }, logCtx);
      } catch (err) {
        if (err instanceof VoiceCompanionAbortedError) {
          disposeTurn();
          throw err;
        }
        log.warn(`[VoiceCompanion] hop2 失败,用确定性摘要: ${(err as Error).message}`);
        result.response = `「${target.name}」最近的输出:${excerpt.slice(0, 160)}${excerpt.length > 160 ? '…' : ''}`;
        result.degraded = true;
        // 🔴④ 降级路径也要留痕(否则「查一下→没下文」无从复现)。
        logQueryChain({
          phase: 'failed',
          request: requestPreview,
          route,
          targetAgentId: target.id,
          targetName: target.name,
          subordinateIds,
          hops: 2,
          durationMs: Date.now() - queryStartedAt,
          responsePreview: truncate(result.response, QUERY_LOG_PREVIEW_CHARS),
          degraded: true,
          error: (err as Error).message,
        }, logCtx);
      }
      result.secondHopMs = Date.now() - hop2Started;
      result.targetAgent = { id: target.id, name: target.name };
      return finish(result);
    }

    if (contract.action === 'cancel_delegation') {
      // 任务16·⑬ 撤回(独立于派活通道):目标由服务端解析(activeDelegations+配额排队+委派史),
      // hop1 话术丢弃,结果由服务端确定性播报;多候选/平票 → 一次性反问(挂起 10 分钟)。
      const cancelStarted = Date.now();
      speech.discardHop1();
      const { live, history } = await collectCancelCandidates();
      let plan = planCancelAction({ text, live, history });
      // HC-B4：撤回落在「已交给主管、主管回合还没拆解完」的窗口(dispatched→delegated ~秒级)时
      // 此刻没有任何候选——有界等待主管的委派落地再撤；超时不再说「没有在办任务」(与事实不符)。
      // C2 修正(2026-10-07 实况):plan='none' 有两种语义 —— ① 真没有候选(B4 等待窗口);
      // ② 有在办候选但原话没对上号(例:「不用查了」与任务词面仅单字重合,阈值 2 不命中)。
      // 旧代码把 ② 当 ① → 任务明明在办,却等 10s 后播「刚交给主管的那条还在安排…」——
      // 误导话术(当晚实况:任务 5 秒后正常完成)。② 改为复用既有一遍反问,把在办候选摊开。
      let waitedOnDispatch = false;
      if (plan.kind === 'none') {
        const seen = new Set<string>();
        const unmatchedActionable = [...live, ...history].filter((c) => {
          if (!isActionableCancelState(c.state)) return false;
          const key = c.decisionId ?? c.taskId ?? `${c.subordinateId}:${c.label}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (unmatchedActionable.length > 0) {
          plan = {
            kind: 'ask',
            question: buildCancelClarifyQuestion(unmatchedActionable),
            candidates: unmatchedActionable,
          };
        } else {
          const dispatch = getLastBossDispatch();
          // env 关闭(0)时整段回退旧行为:不等待、仍播旧话术（0 = B4 功能关）。
          if (dispatch && cancelWaitBudgetMs() > 0) {
            waitedOnDispatch = true;
            const fresh = await waitFreshDispatchCandidate(text, live, history, dispatch, opts.signal);
            if (fresh) plan = fresh;
          }
        }
      }
      if (plan.kind === 'ask') {
        setPendingCancelClarification({
          question: plan.question,
          candidates: plan.candidates,
          askedAt: Date.now(),
          taskId,
        });
        result.response = plan.question;
        logDelegation({
          phase: 'cancelled',
          channel: 'voice-companion',
          status: 'clarify-ask',
          initiator: 'user',
          reason: truncate(text, 80),
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
        result.secondHopMs = Date.now() - cancelStarted;
        return finish(result);
      }
      if (plan.kind === 'none') {
        result.response = waitedOnDispatch ? buildCancelPendingDispatchResponse() : buildCancelNoneResponse();
        if (waitedOnDispatch) {
          logDelegation({
            phase: 'cancelled',
            channel: 'voice-companion',
            status: 'pending-dispatch',
            initiator: 'user',
            reason: truncate(text, 80),
            taskId,
            sessionId: state.sessionId ?? undefined,
          });
        }
        result.secondHopMs = Date.now() - cancelStarted;
        return finish(result);
      }
      // match / rejected-done / already-cancelled：统一交执行面复核（卡状态权威）+ 落审计
      const exec = await executeCancel(plan.candidate, {
        initiator: 'user',
        reason: truncate(text, 80),
        taskId,
      });
      result.response = exec.response;
      result.targetAgent = {
        id: plan.candidate.subordinateId,
        name: plan.candidate.subordinateName ?? plan.candidate.subordinateId,
      };
      result.secondHopMs = Date.now() - cancelStarted;
      return finish(result);
    }

    if (contract.action === 'rate_delegation') {
      // 任务16·⑬ 评价回写(承接任务11 API):取最近完成且未评价 → 极性解析 → bossService 写回。
      // 极性不明 → 追问一句,不猜;下一回合目标不变(「最近完成且未评价」选取确定性)。
      const rateStarted = Date.now();
      speech.discardHop1();
      const agents = agentService.getAllAgents();
      const ratingTarget = pickLatestUnratedCompletion(collectDelegationHistory(agents));
      if (!ratingTarget) {
        result.response = buildNoRatingTargetResponse();
        result.secondHopMs = Date.now() - rateStarted;
        return finish(result);
      }
      const polarity = parseRatingPolarity(text);
      if (polarity === 'unknown') {
        result.response = buildRatingTargetQuestion(ratingTarget);
        result.secondHopMs = Date.now() - rateStarted;
        return finish(result);
      }
      const updated = bossService.rateDelegationCompletion(ratingTarget.bossId, ratingTarget.id, polarity, {
        subordinateId: ratingTarget.selectedAgentId,
      });
      result.response = updated ? buildRatingConfirmResponse(updated) : buildNoRatingTargetResponse();
      if (updated) result.targetAgent = { id: updated.selectedAgentId, name: updated.selectedAgentName };
      result.secondHopMs = Date.now() - rateStarted;
      return finish(result);
    }

    if (contract.action === 'analyze_logs') {
      // 任务 03·尾:⑮ P1 手动日志分析(秘书自留区只读查询;不走 ① 委派通道、不计 ⑫ 配额)。
      const analysisStarted = Date.now();
      try {
        const report = await runLogAnalysis({
          preset: pickLogWindowPreset(`${contract.query ?? ''} ${text}`),
          signal: opts.signal,
        });
        result.response = renderLogAnalysisReport(report);
      } catch (err) {
        if (err instanceof VoiceCompanionAbortedError) {
          disposeTurn();
          throw err;
        }
        log.warn(`[VoiceCompanion] 日志分析失败: ${(err as Error).message}`);
        result.response = '日志分析没能完成,过会儿再喊我查一次。';
        result.degraded = true;
      }
      result.secondHopMs = Date.now() - analysisStarted;
      return finish(result);
    }

    if (BOLBA_CONTRACT_ACTIONS.has(contract.action)) {
      // 任务13·⑩ 秘书 Bolba 桥:业务待办的查/建/完成/重开。
      // 两本账边界:这里只碰 Bolba 账本,绝不走 ① 委派通道。
      // hop1 话术由 SpeechGate 的显式 Bolba 门丢弃;结果由服务端确定性产出
      // (handleBolbaContractAction 内部兜底,永不抛),degraded 如实透传。
      const bolbaStartedAt = Date.now();
      speech.discardHop1();
      const outcome = await handleBolbaContractAction({
        action: contract.action as BolbaContractAction,
        userText: text,
        contract: { bolbaTask: contract.bolbaTask, query: contract.query },
        now: new Date(),
      });
      result.response = outcome.response;
      result.degraded = outcome.degraded;
      result.secondHopMs = Date.now() - bolbaStartedAt;
      return finish(result);
    }

    if (contract.action === 'noop') {
      result.response = '';
      return finish(result);
    }

    // list_agents / general_response:直接播报 responseToUser;
    // 模型偶尔会照抄模板留空 —— 用确定性摘要兜底,保证有话说。
    // (send/query 缺 targetAgentId 的畸形契约也会落到这里:缓冲丢弃,
    //  由 spoke=false 让客户端按 result.response 整段补播。)
    speech.discardHop1();
    if (contract.action === 'query_agent_output') {
      // W4:query 的 responseToUser 现在是过渡话术(≤12 字),缺目标时不能当答案播。
      result.response = '没听清要查谁,说个名字我再去看。';
    } else if (!result.response) {
      if (contract.action === 'list_agents') {
        result.response = buildAgentListFallback();
      } else {
        result.response = '嗯,我在。';
      }
    }
    return finish(result);
  }));
}

/**
 * 任务13·⑩:非用户回合的主动播报出口(供 Bolba 到期提醒复用)。
 *
 * 复用回合出口 finish() 的同两条通道(dialog out + broadcast/server-sent),
 * 不新建队列、不碰客户端;action 字段供 ⑭ system_log 观测筛选。
 * 注意:服务端目前没有真正的「推送到客户端语音」通道,这里落的是与普通回合
 * 同形态的登记(客户端若接推送可从此通道消费)。
 */
export function logProactiveBroadcast(input: {
  text: string;
  action: string;
  degraded?: boolean;
  sessionId?: string;
  taskId?: string;
}): void {
  logDialogMessage({
    direction: 'out',
    text: input.text,
    sessionId: input.sessionId,
    taskId: input.taskId,
    action: input.action,
    degraded: input.degraded,
  });
  logBroadcast({
    text: input.text,
    phase: 'server-sent',
    action: input.action,
    degraded: input.degraded,
    sessionId: input.sessionId,
    taskId: input.taskId,
  });
}

// ============================================================================
// 模块拆分(A1):re-export 保持本文件为对外唯一门面(历史 import 路径与名字不变)
// ============================================================================
export * from './voice-companion/types.js';
export * from './voice-companion/constants.js';
export * from './voice-companion/agents.js';
export * from './voice-companion/config.js';
export * from './voice-companion/state.js';
export * from './voice-companion/contract.js';
export * from './voice-companion/session.js';
export * from './voice-companion/snapshot.js';
export * from './voice-companion/dispatch-route.js';
export * from './voice-companion/cancel.js';
export * from './voice-companion/deliver.js';
export * from './voice-companion/project-routing.js';

export * from './voice-companion/prompt.js';
export * from './voice-companion/claude-call.js';
export * from './voice-companion/hop.js';
export * from './voice-companion/filler.js';
export * from './voice-companion/query.js';
export * from './voice-companion/mutex.js';
export * from './voice-companion/speech.js';
export * from './voice-companion/turn-helpers.js';
export * from './voice-companion/status.js';
