/**
 * 任务08② 回执订阅总线（轻量,无 React 依赖）
 *
 * 服务端 'task_receipt' 消息(websocket/handlers.ts 分发)→ emitTaskReceipt
 * → VoiceCompanion 订阅 → proactiveReporter.ingestReceipt(权威判定 + 同目标覆盖抑制)。
 * 独立成模块的原因:客户端 WS 分发在模块顶层(无组件上下文),组件侧用订阅对接,两端不直接引用;
 * 回执链路 best-effort——单订阅者抛错不影响其它订阅者,更不影响 WS 主消息循环。
 */
import type { TaskReceiptMessage } from '../../shared/types';

export type TaskReceiptPayload = TaskReceiptMessage['payload'];

type TaskReceiptListener = (payload: TaskReceiptPayload) => void;

const listeners = new Set<TaskReceiptListener>();

/** 订阅回执(返回退订函数);VoiceCompanion 在 proactive 激活期间订阅。 */
export function subscribeTaskReceipt(listener: TaskReceiptListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播回执给全部订阅者(快照迭代:订阅者在回调里退订也安全)。 */
export function emitTaskReceipt(payload: TaskReceiptPayload): void {
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch {
      // 回执播报 best-effort:订阅者异常不打断其它订阅者与主消息循环
    }
  }
}

/** 测试专用:清空订阅(避免用例间串扰)。 */
export function resetTaskReceiptBusForTests(): void {
  listeners.clear();
}
