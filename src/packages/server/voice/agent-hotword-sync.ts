/**
 * Agent 名 ↔ ASR 热词同步
 *
 * 「任何通道」的新增/改名/删除 agent 都会经过 agent-service 的 CRUD
 * (createAgent / updateAgent / deleteAgent;改名含 PATCH /api/agents/:id 与
 * rename-agent 插件)—— 订阅其事件即可全覆盖,零改动 agent-service。
 *
 * 设计:
 *   - agent 名**不落** hotwords.local.json:以 provider 形式实时提供
 *     (getAllAgents → 名字列表),新增/改名立即生效(每次建会话现读),重启自愈;
 *   - 事件只负责「退役」:改名 → 旧名移出动态池 + 拉黑;删除 → 同上。
 *     拉黑 = 管家今后不再从旧对话里把退役名字收回来;
 *   - 启动自愈:清走文件池里与锁定层(agent 名)重复的存量条目。
 *
 * 独立性:本模块只依赖 asr-hotwords(文件读写)+ 注入的 agent 源函数,
 * 不 import agent-service —— 生产装配在 routes/voice-companion.ts,测试可注入假源。
 */

import {
  blockWord,
  readHotwordsFile,
  removeWord,
  setAgentNamesProvider,
  stripLockedDuplicates,
  writeHotwordsFile,
} from './asr-hotwords.js';

export interface AgentHotwordSyncAgent {
  id: string;
  name: string;
}

export interface AgentHotwordSyncDeps {
  /** 当前全部 agent(生产 = agent-service.getAllAgents 的投影)。 */
  getAll: () => ReadonlyArray<AgentHotwordSyncAgent>;
  /** 订阅 agent 变更(生产 = agent-service.subscribe);事件名 created/updated/deleted。 */
  subscribe: (listener: (event: string, data: unknown) => void) => () => void;
  /** 热词文件沙箱(测试用);缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export interface AgentHotwordSync {
  /** 幂等:注册 provider + 订阅事件 + 启动清理。 */
  init(): void;
  /** 当前 agent 名(provider 本体;空名过滤、trim)。 */
  currentNames(): string[];
}

export function createAgentHotwordSync(deps: AgentHotwordSyncDeps): AgentHotwordSync {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  /** id → name(改名时要能拿到旧名;事件删掉后无从查询)。 */
  const names = new Map<string, string>();
  let inited = false;
  let startupCleaned = false;

  /** 启动自愈:池内与锁定层(agent 名)重复的存量条目清走(不拉黑)。
   *  空名单 = agent 数据未就绪 → 不置位、留待补跑;有效执行只一次。 */
  const runStartupCleanup = (currentNamesList: readonly string[]): void => {
    if (startupCleaned || currentNamesList.length === 0) return;
    startupCleaned = true;
    try {
      const { file, existed } = readHotwordsFile(env);
      if (existed) {
        const stripped = stripLockedDuplicates(file, { agentNames: currentNamesList });
        if (stripped > 0) {
          writeHotwordsFile(file, env);
          log(`清理池内与锁定层重复的词 ${stripped} 个`);
        }
      }
    } catch (err) {
      log(`启动清理失败(忽略):${(err as Error)?.message}`);
    }
  };

  const currentNames = (): string[] => {
    const list = deps
      .getAll()
      .map((a) => (typeof a?.name === 'string' ? a.name.trim() : ''))
      .filter(Boolean);
    // 懒启动清理:本模块在路由模块级装配(ESM import 提升),早于 main() 里的
    // initAgents() —— init 时名单为空会空转,且 initAgents 不发事件无从补跑;
    // 改为首次拿到非空名单时补跑一次(实测 2026-10-07:线上池内残留 agent 名未清)。
    runStartupCleanup(list);
    return list;
  };

  /** 退役:移出动态池 + 拉黑(改名旧名 / 删除的名字,管家不再收录)。 */
  const retire = (name: string): void => {
    const { file } = readHotwordsFile(env);
    const removed = removeWord(file, name); // 命中时 removeWord 已拉黑
    const blocked = blockWord(file, name); // 不在池内也要拉黑
    if (removed || blocked) {
      writeHotwordsFile(file, env);
      log(`agent 名退役「${name}」:${removed ? '已移出动态池、' : ''}已拉黑(管家不再收录)`);
    }
  };

  /** 动态池不收录 agent 名(现役):新增/改名后即时把池内同名清走(不拉黑)。 */
  const prunePoolNames = (): void => {
    try {
      const { file, existed } = readHotwordsFile(env);
      if (!existed) return;
      const stripped = stripLockedDuplicates(file, { agentNames: currentNames() });
      if (stripped > 0) {
        writeHotwordsFile(file, env);
        log(`池内 agent 名移除 ${stripped} 个(动态池不收录 agent 名)`);
      }
    } catch (err) {
      log(`池内清理失败(忽略):${(err as Error)?.message}`);
    }
  };

  const onEvent = (event: string, data: unknown): void => {
    try {
      if (event === 'deleted') {
        if (typeof data !== 'string') return;
        const prev = names.get(data);
        names.delete(data);
        if (prev) retire(prev);
        return;
      }
      if ((event === 'created' || event === 'updated') && data && typeof data === 'object') {
        const a = data as { id?: unknown; name?: unknown };
        if (typeof a.id !== 'string' || typeof a.name !== 'string') return;
        const next = a.name.trim();
        const prev = names.get(a.id);
        names.set(a.id, next);
        if (prev === next) return; // 非名称变化(status/currentTool 等高频 quiet 事件)→ 零动作
        // 新增:provider 实时读 getAll,下一次建会话自动带上新名字;
        // 改名:旧名退役(拉黑),新名不得留在动态池。
        if (event === 'updated' && prev) retire(prev);
        prunePoolNames();
      }
    } catch (err) {
      // 同步失败绝不上抛(不能拖垮 agent CRUD 本身)
      log(`事件处理失败(忽略):${(err as Error)?.message}`);
    }
  };

  return {
    currentNames,
    init(): void {
      if (inited) return;
      inited = true;
      for (const a of deps.getAll()) {
        if (typeof a?.id === 'string' && typeof a?.name === 'string') names.set(a.id, a.name);
      }
      setAgentNamesProvider(currentNames);
      deps.subscribe(onEvent);
      // 启动自愈:池内与锁定层(agent 名)重复的存量条目清走(不拉黑);
      // 此刻名单若为空(agent 数据未加载)则挂起,首次非空时由 currentNames 补跑。
      runStartupCleanup(currentNames());
    },
  };
}
