/**
 * jarvis-core · 自愈闭环（任务 33 ⑤.4 / 台阶三⑧）· 纯函数检测
 *
 * 检测「问三遍 / 反复误判」两种模式 → 输出**降级道歉建议对象**：
 * - 问三遍（repeated-request）：同一请求在窗口内重复 ≥ N 次（优先按 intentKey
 *   归组；无键时按文本高相似聚类，含错别字/标点的近似重复）；
 * - 反复误判（repeated-misjudge）：同一误判主题在窗口内重复 ≥ M 次
 *   （优先按 topicKey 归组；无键时按文本相似聚类）。
 *
 * 建议对象只承载**事实 + 方向**（谁重复了几次、原始文本、建议档位上限），
 * **不含文案**——文案生成不在本波（W11/后续消费）。
 * 文案原则（写死，防漂移）：**说清哪里错、不狡辩**——先复述用户原始诉求，
 * 再指出这次错在哪一步，最后给纠正动作；不找借口、不堆歉词、不反问用户。
 *
 * 纯函数契约：now 显式注入；不读 I/O、不抛错；输入事件的畸形项（时刻非有限数 /
 * 文本为空 / 类别不符）静默丢弃（本层不做降级记因——采集侧负责）。
 * 开关：`TC_JARVIS_SENTINEL`（或配置 enabled）关 → 恒返回 []（零行为变化）。
 */

import type { SentinelConfig, SentinelInteractionEvent, SentinelSelfHealSuggestion } from './types.js';
import { resolveSentinelConfig } from './types.js';

// ============================================================================
// 文本归一化与相似度（零依赖；中文友好：字符 bigram Dice 系数）
// ============================================================================

/** 归一化：trim + 空白压缩 + 小写（与 reflection/operations.normalizeText 同形）。 */
export function normalizeRequestText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 2 <= text.length; i++) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * 文本相似度（0–1，多重集 Dice 系数）：`2·|A∩B| / (|A|+|B|)`，A/B = 归一化后的
 * 字符 bigram 集合。完全相同 = 1；单字（无法成 bigram）只认完全相同。
 * 初始实现非实测口径（相似阈值 0.7 见 SelfHealTuning），登记待标定。
 */
export function textSimilarity(a: string, b: string): number {
  const x = normalizeRequestText(a);
  const y = normalizeRequestText(b);
  if (x === y) return x === '' ? 0 : 1;
  if (x === '' || y === '') return 0;
  const ax = bigramCounts(x);
  const by = bigramCounts(y);
  let intersection = 0;
  let total = 0;
  for (const [gram, count] of ax) {
    total += count;
    const other = by.get(gram);
    if (other !== undefined) intersection += Math.min(count, other);
  }
  for (const count of by.values()) total += count;
  return total === 0 ? 0 : (2 * intersection) / total;
}

// ============================================================================
// 聚类
// ============================================================================

interface InteractionCluster {
  /** 是否按键归组（intentKey / topicKey）。 */
  keyed: boolean;
  /** 归组键（键归组 = 原键；相似归组 = 代表文本）。 */
  key: string;
  /** 归一化代表文本（簇内首个成员）。 */
  representative: string;
  events: SentinelInteractionEvent[];
  texts: string[];
}

function clusterSimilarity(cluster: InteractionCluster): number | null {
  if (cluster.keyed) return null;
  let min = 1;
  for (const text of cluster.texts) {
    min = Math.min(min, textSimilarity(cluster.representative, text));
  }
  return min;
}

/**
 * 窗口内同类别事件聚类（时间升序）：
 * - 有键事件只在**同键**簇内合并（不同文本、同 intentKey 也视为同一请求）；
 * - 无键事件与相似度 ≥ 阈值的**无键**簇合并（键/无键不混簇——生产接线宜统一供键）。
 */
function collectClusters(
  events: readonly SentinelInteractionEvent[],
  kind: SentinelInteractionEvent['kind'],
  now: number,
  tuning: { windowMs: number; similarityThreshold: number },
): InteractionCluster[] {
  const windowStart = now - tuning.windowMs;
  const relevant = events
    .filter((event) => event && event.kind === kind)
    .filter((event) => Number.isFinite(event.at) && event.at <= now && event.at >= windowStart)
    .filter((event) => typeof event.text === 'string' && normalizeRequestText(event.text) !== '')
    .sort((a, b) => a.at - b.at);

  const clusters: InteractionCluster[] = [];
  for (const event of relevant) {
    const text = normalizeRequestText(event.text);
    const rawKey = kind === 'user-request' ? event.intentKey : event.topicKey;
    const key = typeof rawKey === 'string' && rawKey.trim() !== '' ? rawKey.trim() : null;

    let cluster = clusters.find((candidate) =>
      key !== null
        ? candidate.keyed && candidate.key === key
        : !candidate.keyed && textSimilarity(candidate.representative, text) >= tuning.similarityThreshold,
    );
    if (!cluster) {
      cluster = { keyed: key !== null, key: key ?? text, representative: text, events: [], texts: [] };
      clusters.push(cluster);
    }
    cluster.events.push(event);
    cluster.texts.push(text);
  }
  return clusters;
}

function toSuggestion(
  cluster: InteractionCluster,
  reason: SentinelSelfHealSuggestion['reason'],
  minCount: number,
  now: number,
  tuning: { windowMs: number; maxSamples: number },
): SentinelSelfHealSuggestion | null {
  if (cluster.events.length < minCount) return null;

  const samples: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < cluster.events.length && samples.length < tuning.maxSamples; i++) {
    const normalized = cluster.texts[i];
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    samples.push(cluster.events[i].text);
  }

  return {
    reason,
    action: 'degrade-and-apologize',
    maxTier: 'STORE',
    at: now,
    count: cluster.events.length,
    key: cluster.key,
    samples,
    firstAt: cluster.events[0].at,
    lastAt: cluster.events[cluster.events.length - 1].at,
    similarity: clusterSimilarity(cluster),
    windowMs: tuning.windowMs,
  };
}

// ============================================================================
// 检测入口
// ============================================================================

/** 问三遍检测：窗口内同一请求 ≥ repeatThreshold 次 → 降级道歉建议。 */
export function detectRepeatedRequests(
  events: readonly SentinelInteractionEvent[],
  now: number,
  config: SentinelConfig = {},
): SentinelSelfHealSuggestion[] {
  const resolved = resolveSentinelConfig(config);
  if (!resolved.enabled) return [];
  const tuning = resolved.selfHeal;
  return collectClusters(events, 'user-request', now, tuning)
    .map((cluster) => toSuggestion(cluster, 'repeated-request', tuning.repeatThreshold, now, tuning))
    .filter((suggestion): suggestion is SentinelSelfHealSuggestion => suggestion !== null);
}

/** 反复误判检测：窗口内同一误判 ≥ misjudgeRepeatThreshold 次 → 降级道歉建议。 */
export function detectRepeatedMisjudges(
  events: readonly SentinelInteractionEvent[],
  now: number,
  config: SentinelConfig = {},
): SentinelSelfHealSuggestion[] {
  const resolved = resolveSentinelConfig(config);
  if (!resolved.enabled) return [];
  const tuning = resolved.selfHeal;
  return collectClusters(events, 'misjudge', now, tuning)
    .map((cluster) => toSuggestion(cluster, 'repeated-misjudge', tuning.misjudgeRepeatThreshold, now, tuning))
    .filter((suggestion): suggestion is SentinelSelfHealSuggestion => suggestion !== null);
}

/** 两类模式合并输出（稳定序：lastAt 升序，再按归组键字典序）。 */
export function detectSelfHeal(
  events: readonly SentinelInteractionEvent[],
  now: number,
  config: SentinelConfig = {},
): SentinelSelfHealSuggestion[] {
  const suggestions = [
    ...detectRepeatedRequests(events, now, config),
    ...detectRepeatedMisjudges(events, now, config),
  ];
  return suggestions.sort((a, b) => a.lastAt - b.lastAt || a.key.localeCompare(b.key));
}
