/**
 * WS 语义封装 —— env-prep 与探针需要的 5 条客户端指令（handler.ts:257-343）
 *
 * 消息表（本轮取证）：
 *   sync_areas          payload=整表 DrawingArea[]（sync-handler.ts:29-82，只广播给他人，无自回执）
 *   spawn_boss_agent    payload={name,class?,cwd,position?,subordinateIds?}（boss-handler.ts:18-108）
 *                       回执=agent_created 广播（payload 形状未冻结 → 用名字递归匹配）
 *   assign_subordinates payload={bossId,subordinateIds} → boss_subordinates_updated 广播
 *   stop_agent          payload={agentId}（agent-handler.ts:425-450，无成功回执 → REST 复核）
 *   send_command        payload={agentId,command}
 */

import type { WsMsg, WsObserverLike } from './types.js';
import { WsObserver, toMainWsUrl } from './ws-observer.js';

export async function connectMainWs(baseUrl: string, token: string | undefined, timeoutMs: number): Promise<WsObserver> {
  return WsObserver.connect(toMainWsUrl(baseUrl), token, timeoutMs);
}

/** 在任意 JSON 结构里递归找第一个满足谓词的对象（spawn 回执形状未冻结的防御式解析） */
export function findJsonObject(root: unknown, pred: (obj: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (pred(obj)) return obj;
    for (const v of Object.values(obj)) stack.push(v);
  }
  return undefined;
}

/** 从 agent_created 广播里提取 name 匹配的 agent id（payload.agent / payload 本身皆可） */
export function extractAgentId(msg: WsMsg, name: string): string | undefined {
  const hit = findJsonObject(msg.payload, (o) => o.name === name && typeof o.id === 'string');
  return hit ? String(hit.id) : undefined;
}

export function syncAreas(ws: WsObserverLike, areas: unknown[]): void {
  ws.send('sync_areas', areas);
}

export function assignSubordinates(ws: WsObserverLike, bossId: string, subordinateIds: string[]): void {
  ws.send('assign_subordinates', { bossId, subordinateIds });
}

export function sendCommand(ws: WsObserverLike, agentId: string, command: string): void {
  ws.send('send_command', { agentId, command });
}

export async function stopAgent(ws: WsObserverLike, agentId: string): Promise<{ ok: boolean; error?: string }> {
  ws.send('stop_agent', { agentId });
  // 该指令无成功回执（agent-handler.ts:425-450 只做 stop + idle 广播）→ 调用方用 REST 复核
  return { ok: true };
}

export interface SpawnBossResult { ok: boolean; agentId?: string; error?: string }

/** 经 WS 建 Boss（唯一路径）：等 agent_created 广播按名字匹配取 id */
export async function spawnBossAgent(
  ws: WsObserverLike,
  payload: { name: string; class?: string; cwd: string; subordinateIds?: string[] },
  timeoutMs = 15_000,
): Promise<SpawnBossResult> {
  const sinceTs = Date.now();
  ws.send('spawn_boss_agent', { class: 'boss', ...payload });
  const msg = await ws.waitFor(
    (m) => m.type === 'agent_created' && extractAgentId(m, payload.name) !== undefined,
    { timeoutMs, sinceTs },
  );
  if (!msg) {
    const raw = ws.receivedSince(sinceTs).map((m) => m.type).join(',');
    return { ok: false, error: `等待 agent_created（name=${payload.name}）超时；窗口内广播：${raw || '（无）'}` };
  }
  return { ok: true, agentId: extractAgentId(msg, payload.name) };
}
