/**
 * 语音伙伴服务 — 互斥队列(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 用户语音与主动汇报的 claude 回合串行化(FIFO 单尾链,失败不断链)。
 */

let tail: Promise<unknown> = Promise.resolve();

export function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn, fn);
  tail = result.catch(() => undefined);
  return result;
}
