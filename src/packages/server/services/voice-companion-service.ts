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
 * 实现已全部拆入 ./voice-companion/ 子模块(2026-10-11 拆分 A1–D);本文件只作对外
 * 唯一门面(re-export),历史 import 路径与导出名(含上述纯函数)保持不变。
 */

// ============================================================================
// 模块拆分(A1–D,2026-10-11):实现已按主题全部拆入 voice-companion/ 子模块;
// 本文件只作对外唯一门面(re-export),历史 import 路径与导出名保持不变。
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

export * from './voice-companion/turn.js';
