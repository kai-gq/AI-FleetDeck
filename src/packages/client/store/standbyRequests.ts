/**
 * 待岗(standby)手势登记 — 本标签页刚发起的「设为待岗」请求,短时效。
 *
 * 为什么需要它:服务端把「停止」与「打标」做成一次 updateAgent(先停进程,
 * 同一次广播里带上 standby),所以 working→idle 那条广播**本身**已经带标记。
 * 但停止过程中 runtimeService.stopAgent 内部还会先广播一次 idle(此刻标记
 * 尚未落地),两个广播相隔毫秒级。凡是把 working→idle 读作「任务完成」的
 * 消费方(完成提示音、语音伙伴主动汇报)都可能被第一条骗到,播报一个**用户
 * 自己造成**的「完成任务」。
 *
 * 因此消费方多问一句:这个 agent 是不是本标签页刚点了待岗?是 → 那是停止,
 * 不是完成。纯客户端、内存态、TTL 兜底,不落盘;服务端的 standby 标记仍是
 * UI(灰显/徽章/菜单)的唯一事实源,本模块不改任何 UI 状态。
 *
 * 多端局限:从手机端发起待岗时,桌面标签页没有这条手势记录,可能仍响一声
 * 完成音(与既有「手动停止也会响」的行为一致,非本机制引入)。
 */

/** 手势有效期:足够覆盖停止进程 + 两次广播的间隔,又短到不会误伤后续真实完成。 */
const TTL_MS = 15_000;

const pending = new Map<string, number>();

/** 登记一次「设为待岗」手势(恢复不需要:恢复后本来就有新任务才会完成)。 */
export function markStandbyRequest(agentId: string, now = Date.now()): void {
  // 顺带清理过期项,免长会话里只增不减
  for (const [id, at] of pending) {
    if (now - at > TTL_MS) pending.delete(id);
  }
  pending.set(agentId, now);
}

/** 该 agent 是否刚被本标签页设为待岗(未过期)。 */
export function wasStandbyJustRequested(agentId: string, now = Date.now()): boolean {
  const at = pending.get(agentId);
  if (at === undefined) return false;
  if (now - at > TTL_MS) {
    pending.delete(agentId);
    return false;
  }
  return true;
}

/** 测试用:清空登记。 */
export function clearStandbyRequests(): void {
  pending.clear();
}
