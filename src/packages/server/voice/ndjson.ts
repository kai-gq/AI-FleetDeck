/**
 * NDJSON 流式响应小工具(语音分句流水线专用)。
 *
 * 为什么不是 SSE:负载是「一行一个 JSON」的短消息,没有重连/事件名语义,
 * NDJSON 客户端解析更简单(逐行 JSON.parse)。
 *
 * 防缓冲:
 * - `Cache-Control: no-cache, no-transform` 让 app.ts 的 compression 中间件
 *   跳过本响应(该中间件按 no-transform 让路,自更新 SSE 是同样先例),
 *   否则首句这种小 chunk 会被 threshold:1024 憋住,流水线全白搭;
 * - `X-Accel-Buffering: no` 关闭反代缓冲;
 * - flushHeaders 立刻把响应头发出去,setNoDelay 关掉 Nagle。
 */

import type { Response } from 'express';

type FlushableResponse = Response & { flush?: () => void };

export function initNdjson(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.socket?.setNoDelay?.(true);
}

/** 写一行 JSON。连接已断 → false(调用方可提前收摊,但写失败本身不抛)。 */
export function writeNdjsonLine(res: Response, payload: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    (res as FlushableResponse).flush?.();
    res.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 正常收尾(幂等:已结束/已断开的响应不再 end)。 */
export function endNdjson(res: Response): void {
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.end();
    } catch {
      // socket already gone
    }
  }
}
