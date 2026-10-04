/**
 * jarvis-core · 记忆栈组装（任务 27 接线尾便利工厂）
 *
 * 给热文件接线尾一个「一行构造」入口：FileMemoryStore + MemoryWriteEngine +
 * ⑭ 观测适配一起装好，避免在 voice-companion-service.ts 里展开接线细节
 * （保持热文件改动最小；真正的调用挂点仍在 vcs，见任务 27 REPORT 的接线指引）。
 *
 * 不产生模块级单例/副作用：接线尾自己持有 lazy 单例（仓库约定：新模块不
 * 改任何既有 index/barrel，server/index.ts 启动接线由主脑统一处理）。
 */

import type { JarvisLogger } from '../executors.js';
import { FileMemoryStore, defaultMemoryBaseDir } from './file-store.js';
import { createSystemLogObserver, type SystemLogEventFn } from './observability.js';
import type { MemoryObserver } from './types.js';
import { MemoryWriteEngine } from './write-engine.js';

export interface MemoryStackOptions {
  /** 四层根目录；缺省 defaultMemoryBaseDir()（XDG 数据目录，测试须显式注入临时目录）。 */
  baseDir?: string;
  /** 显式观测出口（与 logEvent 二选一；同时传时以 observer 为准）。 */
  observer?: MemoryObserver;
  /** 真实 logEvent（接线尾传 system-log.logEvent；测试传同款进沙箱 EventDB）。 */
  logEvent?: SystemLogEventFn;
  /** 观测渠道标签（body.channel）；缺省 'memory'。 */
  channel?: string;
  now?: () => number;
  logger?: JarvisLogger;
}

export interface MemoryStack {
  store: FileMemoryStore;
  engine: MemoryWriteEngine;
  observer?: MemoryObserver;
}

export function createMemoryStack(options: MemoryStackOptions = {}): MemoryStack {
  const observer =
    options.observer ??
    (options.logEvent ? createSystemLogObserver(options.logEvent, { channel: options.channel }) : undefined);
  const store = new FileMemoryStore({
    baseDir: options.baseDir ?? defaultMemoryBaseDir(),
    now: options.now,
    observer,
    logger: options.logger,
  });
  const engine = new MemoryWriteEngine({
    store,
    observer,
    now: options.now,
    logger: options.logger,
  });
  return { store, engine, observer };
}
