/**
 * 任务28·夜间反思 生产接线（02:00 扫描入口，主脑波次屏障落点）
 *
 * 职责：组装任务27 记忆栈（store）+ Tier2 待审队列 + 运行状态 + ⑭ 观测适配，
 * 调用 jarvis-core/reflection 的 runNightlyReflection 跑一次反思；由
 * cron-service.startNightlyReflectionJob() 每日 02:00（本地时区，可配）懒加载调用。
 *
 * LLM 端口刻意留白（真实通道接线延后登记，06-11 §6.3「端口先行」）：
 *   - 当日会话数 <5 → skipped（Dream 硬规则）；
 *   - 会话数 ≥5 → 引擎走到 LLM 后如实记 failed/llm-port-unavailable，
 *     零操作、零写入、零费用；通道接通后只换本文件注入，不动调度层。
 *
 * 边界：写面 = 反思自己的队列/状态 JSON（默认 jarvis-reflection/ 目录）+ Tier1
 * 应用/晨报草稿（经 store 写 reflections 层）；不 import 任何热文件，调度层不反向依赖。
 */

import { logEvent } from '../data/system-log.js';
import { createMemoryStack } from '../jarvis-core/memory/index.js';
import {
  createReflectionLogObserver,
  FileReflectionRunState,
  runNightlyReflection,
  Tier2ReviewQueue,
  type ReflectionRunResult,
} from '../jarvis-core/reflection/index.js';

/** 跑一次夜间反思扫描（引擎契约永不抛；组装级异常由 cron 侧 catch 兜底）。 */
export async function runNightlyReflectionScan(): Promise<ReflectionRunResult> {
  // 记忆栈按调用构造：一夜一次，无跨夜缓存需求；记忆写入日志经 ⑭（channel='reflection'）。
  const { store } = createMemoryStack({ logEvent, channel: 'reflection' });
  return runNightlyReflection({
    store,
    // 队列/状态显式注入默认路径实例（与引擎缺省同值；显式便于接线审计）。
    reviewQueue: new Tier2ReviewQueue(),
    runState: new FileReflectionRunState(),
    observer: createReflectionLogObserver(logEvent),
    // llm 缺省 = 不可用端口（真实通道延后登记）。
  });
}
