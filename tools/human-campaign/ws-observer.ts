/**
 * 主 WS 观测器 —— 常连 /ws，收集全部服务端广播（含 14·B 回执 `task_receipt`）
 *
 * 为什么需要它：回执播报的中文前缀（【项目别名】…）**只出现在 WS 广播文本里**，
 * system_log 的 receipt 行不含该前缀（任务14·B 取证结论）——HC-23 的唯一证据面。
 * 同时 env-prep 的 spawn_boss_agent / sync_areas / stop_agent 都必须走 WS
 * （handler.ts:257-343，HTTP 无对应端点）。
 *
 * 认证：AUTH_TOKEN 未设置免认证；设置后需子协议 `auth-<token>`（与 canary
 * client.ts:85 的手势一致）。日志落盘为 JSONL（appendFileSync，逐帧小写入）。
 */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { WsMsg } from './types.js';

export class WsObserver {
  private ws: WebSocket;
  private logFd: number | null = null;
  private closed = false;
  readonly messages: WsMsg[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /** 连接并等待 open（超时抛错）。已连上后立刻开始收集消息。 */
  static connect(url: string, token: string | undefined, timeoutMs: number): Promise<WsObserver> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, token ? [`auth-${token}`] : [], { handshakeTimeout: timeoutMs });
      const observer = new WsObserver(ws);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch { /* 忽略 */ }
        reject(new Error(`WS 连接超时（${timeoutMs}ms）：${url}`));
      }, timeoutMs);

      ws.on('message', (data) => observer.ingest(data.toString()));
      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(observer);
      });
      ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on('close', () => { observer.closed = true; });
    });
  }

  private ingest(raw: string): void {
    let type = 'unparsed';
    let payload: unknown;
    try {
      const parsed = JSON.parse(raw) as { type?: unknown };
      if (parsed && typeof parsed === 'object') {
        payload = parsed;
        type = typeof parsed.type === 'string' ? parsed.type : 'unparsed';
      }
    } catch { /* 保留 unparsed */ }
    const msg: WsMsg = { ts: Date.now(), type, payload, raw };
    this.messages.push(msg);
    if (this.logFd !== null) {
      try { fs.writeSync(this.logFd, `${JSON.stringify(msg)}\n`); } catch { /* 观测不影响主链路 */ }
    }
  }

  /** 逐帧落盘到 JSONL（reports/ws-<ISO>.jsonl）；重复调用先关旧 fd。 */
  logTo(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (this.logFd !== null) { try { fs.closeSync(this.logFd); } catch { /* 忽略 */ } }
    this.logFd = fs.openSync(filePath, 'a');
  }

  send(type: string, payload: unknown): void {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  receivedSince(ts: number, type?: string): WsMsg[] {
    return this.messages.filter((m) => m.ts >= ts && (type === undefined || m.type === type));
  }

  async waitFor(
    pred: (m: WsMsg) => boolean,
    opts: { timeoutMs: number; pollMs?: number; sinceTs?: number },
  ): Promise<WsMsg | undefined> {
    const pollMs = Math.max(10, opts.pollMs ?? 250);
    const deadline = Date.now() + Math.max(0, opts.timeoutMs);
    for (;;) {
      const hit = this.messages.find((m) => (opts.sinceTs === undefined || m.ts >= opts.sinceTs) && pred(m));
      if (hit) return hit;
      if (Date.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
  }

  waitForType(type: string, opts: { timeoutMs: number; pollMs?: number; sinceTs?: number }): Promise<WsMsg | undefined> {
    return this.waitFor((m) => m.type === type, opts);
  }

  close(): void {
    if (this.logFd !== null) { try { fs.closeSync(this.logFd); } catch { /* 忽略 */ } this.logFd = null; }
    try { this.ws.close(); } catch { /* 忽略 */ }
    try { this.ws.terminate(); } catch { /* 忽略 */ }
  }

  get isClosed(): boolean { return this.closed; }
}

export function toMainWsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base.replace(/^http/i, 'ws')}/ws`;
}
