/**
 * 真链路客户端：HTTP（fetch）+ WebSocket（ws 包）探测与消息发送
 *
 * 探索结论（写入报告）：
 *   - 用户消息入口不是 WS，而是 HTTP：POST /api/voice-companion/process { text, event?, stream? }
 *     （src/packages/server/routes/voice-companion.ts:95，挂载于 routes/index.ts:65）。
 *     WS（/ws）只承载客户端指令（send_command / spawn_agent / …，handler.ts:257-343）与
 *     服务端广播；金丝雀统一走 HTTP，避免在 WS 上拼装复杂指令。
 *   - WS 握手：连 ws://host:6200/ws；服务端连接后立刻下发 server_time/agents_update
 *     （handler.ts:455-486）。认证：AUTH_TOKEN 未设置时免认证；设置后需 query `?token=`
 *     或子协议 `auth-<token>`（auth/index.ts:79-99；客户端用法见 client/websocket/connection.ts:530）。
 *   - 非 ASCII 的坑只影响 curl -d（Git Bash 转码）；本工具用 fetch + JSON.stringify，
 *     天然 UTF-8，不受该坑影响（README 记录该坑供手工验证时参考）。
 */

import WebSocket from 'ws';
import type { AgentInfo, CanaryTransport, HttpResult, WsProbeResult } from './types.js';

// ─── URL 工具 ───

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed || 'http://127.0.0.1:6200';
}

export function toWsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const wsBase = base.replace(/^http/i, 'ws');
  return `${wsBase}/ws`;
}

// ─── HTTP/WS 传输实现 ───

export interface TransportOptions {
  token?: string;
  httpTimeoutMs: number;
  wsTimeoutMs: number;
  verbose?: boolean;
}

export function createTransport(baseUrl: string, opts: TransportOptions): CanaryTransport {
  const base = normalizeBaseUrl(baseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['X-Auth-Token'] = opts.token;

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.httpTimeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: Record<string, unknown> | undefined;
      try {
        const parsed = text ? JSON.parse(text) : undefined;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        } else if (parsed !== undefined) {
          json = { value: parsed };
        }
      } catch {
        // 非 JSON 响应（如 HTML 错误页）——保留状态码即可
      }
      return { ok: res.ok, status: res.status, json, elapsedMs: Date.now() - started };
    } catch (err) {
      const msg = err instanceof Error
        ? (err.name === 'AbortError' ? `请求超时（${opts.httpTimeoutMs}ms）` : err.message)
        : String(err);
      return { ok: false, status: 0, error: msg, elapsedMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  async function wsHandshake(): Promise<WsProbeResult> {
    const started = Date.now();
    const url = toWsUrl(base);
    return new Promise<WsProbeResult>((resolve) => {
      let settled = false;
      const ws = new WebSocket(url, opts.token ? [`auth-${opts.token}`] : [], {
        handshakeTimeout: opts.wsTimeoutMs,
      });
      const timer = setTimeout(() => {
        finish({ ok: false, error: `等待 ${opts.wsTimeoutMs}ms 未收到任何服务端消息`, elapsedMs: Date.now() - started });
      }, opts.wsTimeoutMs);

      const finish = (r: WsProbeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.terminate(); } catch { /* 忽略 */ }
        resolve(r);
      };

      ws.on('message', (data) => {
        let type = 'unparsed';
        try {
          const parsed = JSON.parse(data.toString()) as { type?: string };
          type = parsed?.type ?? 'unparsed';
        } catch { /* 保留 unparsed */ }
        finish({ ok: true, firstMessageType: type, elapsedMs: Date.now() - started });
      });
      ws.on('error', (err) => {
        finish({ ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - started });
      });
      ws.on('close', (code) => {
        finish({ ok: false, error: `连接被关闭（code=${code}）`, elapsedMs: Date.now() - started });
      });
    });
  }

  return {
    baseUrl: base,
    httpGet: (path) => request('GET', path),
    httpPost: (path, body) => request('POST', path, body),
    wsHandshake,
    close: () => { /* fetch/ws 无需显式释放 */ },
  };
}

// ─── 语义化接口封装（场景与 selftest 共用） ───

export async function probeHealth(t: CanaryTransport): Promise<HttpResult> {
  return t.httpGet('/api/health');
}

export async function probeCompanionStatus(t: CanaryTransport): Promise<HttpResult> {
  return t.httpGet('/api/voice-companion/status');
}

/** 发送一条用户消息（真链路：秘书 hop1，会产生真实 LLM 消耗） */
export async function sendCompanionMessage(t: CanaryTransport, text: string, opts?: { stream?: boolean; event?: boolean }): Promise<HttpResult> {
  return t.httpPost('/api/voice-companion/process', {
    text,
    stream: opts?.stream ?? false,
    event: opts?.event ?? false,
  });
}

/** 读取 agent 列表（GET /api/agents 返回数组；transport 会把顶层数组包成 {value:[...]}） */
export async function fetchAgents(t: CanaryTransport): Promise<{ ok: boolean; agents: AgentInfo[]; error?: string }> {
  const res = await t.httpGet('/api/agents');
  if (!res.ok || !res.json) {
    return { ok: false, agents: [], error: res.error ?? `HTTP ${res.status}` };
  }
  const raw = res.json as unknown;
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { value?: unknown }).value)
      ? (raw as { value: unknown[] }).value
      : Array.isArray((raw as { agents?: unknown }).agents)
        ? (raw as { agents: unknown[] }).agents
        : [];
  const agents = (arr as Array<Record<string, unknown>>).map((a) => ({
    id: String(a.id ?? ''),
    name: String(a.name ?? ''),
    isBoss: a.isBoss === true,
    class: typeof a.class === 'string' ? a.class : undefined,
    bossId: typeof a.bossId === 'string' ? a.bossId : undefined,
    status: typeof a.status === 'string' ? a.status : undefined,
  }));
  return { ok: true, agents };
}

/** 找出主管（isBoss 或 class==='boss'，与后端归一化口径一致） */
export function findBoss(agents: AgentInfo[]): AgentInfo | undefined {
  return agents.find((a) => a.isBoss === true || a.class === 'boss');
}

/** 下属回执（真链路：POST /api/agents/:id/report-task，routes/agents.ts:1950） */
export async function reportTask(
  t: CanaryTransport,
  agentId: string,
  summary: string,
  status: 'completed' | 'failed' = 'completed',
): Promise<HttpResult> {
  return t.httpPost(`/api/agents/${encodeURIComponent(agentId)}/report-task`, { summary, status });
}
