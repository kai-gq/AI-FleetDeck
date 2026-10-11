/**
 * agent 名 ↔ 热词同步(agent-hotword-sync)单测:provider 注册(新增/改名即时
 * 生效)/ 启动清理池内重复 / 删除与改名退役(移出池 + 拉黑)/ 异常吞掉不上抛。
 * 全部沙箱(TC_VOICE_HOTWORDS_SOURCE)+ 假 agent 源,不碰 agent-service 真身。
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOTWORDS_SOURCE_ENV,
  emptyHotwordsFile,
  getAgentNames,
  readHotwordsFile,
  setAgentNamesProvider,
  writeHotwordsFile,
  type HotwordEntry,
} from './asr-hotwords.js';
import { createAgentHotwordSync } from './agent-hotword-sync.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-agent-sync-'));
afterAll(() => {
  setAgentNamesProvider(null); // 全局 provider 复位(防泄漏到其它测试文件)
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const T = '2026-10-07T02:00:00.000Z';

function entry(over: Partial<HotwordEntry>): HotwordEntry {
  return {
    word: 'x',
    weight: 6,
    count: 1,
    source: 'agent',
    addedAt: T,
    lastSeenAt: T,
    ...over,
  };
}

/** 假装配:内存 agent 列表 + 事件监听集合 + 沙箱热词文件。 */
function makeHarness(fileName: string, agents: Array<{ id: string; name: string }>) {
  const env = { [HOTWORDS_SOURCE_ENV]: path.join(sandbox, fileName) };
  const state = { agents: [...agents] };
  const listeners = new Set<(event: string, data: unknown) => void>();
  const logs: string[] = [];
  const sync = createAgentHotwordSync({
    getAll: () => state.agents,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    env,
    log: (msg) => logs.push(msg),
  });
  const emit = (event: string, data: unknown): void => {
    for (const l of [...listeners]) l(event, data);
  };
  return { env, state, sync, emit, listeners, logs };
}

describe('createAgentHotwordSync', () => {
  it('init:注册 provider(实时读源)+ 订阅事件 + 幂等', () => {
    const h = makeHarness('init.json', [{ id: 'a1', name: ' 主管 ' }]);
    expect(getAgentNames()).toEqual([]); // 未 init 前无 provider

    h.sync.init();
    expect(getAgentNames()).toEqual(['主管']); // trim
    expect(h.listeners.size).toBe(1);
    h.sync.init(); // 幂等:不重复订阅
    expect(h.listeners.size).toBe(1);

    // 实时:源变化无需事件,provider 现读
    h.state.agents = [{ id: 'a1', name: '主管' }, { id: 'a2', name: '小刘' }];
    expect(getAgentNames()).toEqual(['主管', '小刘']);
  });

  it('启动清理:池内与锁定层(agent 名)重复的存量条目清走(不拉黑)', () => {
    const h = makeHarness('startup.json', [{ id: 'a1', name: '主管' }]);
    const file = emptyHotwordsFile();
    file.words = [entry({ word: '主管' }), entry({ word: 'bolba' })];
    writeHotwordsFile(file, h.env);

    h.sync.init();
    const after = readHotwordsFile(h.env).file;
    expect(after.words.map((e) => e.word)).toEqual(['bolba']);
    expect(after.blocked).toEqual([]); // 不拉黑
  });

  it('懒启动清理:init 时 agent 数据未就绪(空名单)→ 首次非空时补跑一次,且只一次', () => {
    // 复刻线上时序:路由模块级 init() 早于 main() 的 initAgents()(getAll 为空),
    // 之后数据就位但不发事件 —— 启动清理必须靠 currentNames 补跑。
    const h = makeHarness('lazy.json', []);
    const file = emptyHotwordsFile();
    file.words = [entry({ word: '主管' }), entry({ word: 'bolba' })];
    writeHotwordsFile(file, h.env);

    h.sync.init(); // 空名单:不清理、挂起
    expect(readHotwordsFile(h.env).file.words).toHaveLength(2);

    h.state.agents = [{ id: 'a1', name: '主管' }]; // 数据就位(无任何事件)
    expect(h.sync.currentNames()).toEqual(['主管']); // 首次非空 → 补跑清理
    expect(readHotwordsFile(h.env).file.words.map((e) => e.word)).toEqual(['bolba']);

    // 只跑一次:人为塞回重复条目,再次调用不再清(不覆盖后续手工状态)
    const f2 = readHotwordsFile(h.env).file;
    f2.words.push(entry({ word: '主管' }));
    writeHotwordsFile(f2, h.env);
    expect(h.sync.currentNames()).toEqual(['主管']);
    expect(readHotwordsFile(h.env).file.words.map((e) => e.word)).toEqual(['bolba', '主管']);
  });

  it('删除 agent:同名残留移出池 + 拉黑(管家不再收录)', () => {
    const h = makeHarness('deleted.json', [{ id: 'a1', name: '主管' }]);
    h.sync.init();

    // init 后残留在池里的名字(模拟历史收录)→ 删除事件应清走并拉黑
    const file = emptyHotwordsFile();
    file.words = [entry({ word: '主管' }), entry({ word: 'bolba' })];
    writeHotwordsFile(file, h.env);

    h.state.agents = [];
    h.emit('deleted', 'a1');
    const after = readHotwordsFile(h.env).file;
    expect(after.words.map((e) => e.word)).toEqual(['bolba']);
    expect(after.blocked).toEqual(['主管']);
    expect(getAgentNames()).toEqual([]);
    expect(h.logs.some((m) => m.includes('主管'))).toBe(true);
  });

  it('改名:旧名退役(不移入池也拉黑),新名实时生效;同名更新不重复拉黑', () => {
    const h = makeHarness('renamed.json', [{ id: 'a1', name: '主管' }]);
    h.sync.init();

    h.state.agents = [{ id: 'a1', name: '主管2' }];
    h.emit('updated', { id: 'a1', name: '主管2' });
    let after = readHotwordsFile(h.env).file;
    expect(after.words).toHaveLength(0);
    expect(after.blocked).toEqual(['主管']);
    expect(getAgentNames()).toEqual(['主管2']); // provider 实时

    h.emit('updated', { id: 'a1', name: '主管2' }); // 同名重复事件
    after = readHotwordsFile(h.env).file;
    expect(after.blocked).toEqual(['主管']);
  });

  it('动态池不收录 agent 名:新增/改名后池内同名即时清走(不拉黑)', () => {
    const h = makeHarness('prune.json', []);
    // 池里预先有「小陈」(历史收录的普通词)
    const file = emptyHotwordsFile();
    file.words = [entry({ word: '小陈' }), entry({ word: 'bolba' })];
    writeHotwordsFile(file, h.env);
    h.sync.init();

    // 新增名为「小陈」的 agent → 池内同名清走
    h.state.agents = [{ id: 'a1', name: '小陈' }];
    h.emit('created', { id: 'a1', name: '小陈' });
    let after = readHotwordsFile(h.env).file;
    expect(after.words.map((e) => e.word)).toEqual(['bolba']);
    expect(after.blocked).toEqual([]); // 不拉黑(现役 agent 名不是屏蔽)

    // 改名撞上池内已有词(「晓伊」)→ 新名同样清走;旧名退役拉黑
    const f2 = readHotwordsFile(h.env).file;
    f2.words.push(entry({ word: '晓伊' }));
    writeHotwordsFile(f2, h.env);
    h.state.agents = [{ id: 'a1', name: '晓伊' }];
    h.emit('updated', { id: 'a1', name: '晓伊' });
    after = readHotwordsFile(h.env).file;
    expect(after.words.map((e) => e.word)).toEqual(['bolba']);
    expect(after.blocked).toEqual(['小陈']);
  });

  it('created:只更新名单(provider 现读),不写盘;垃圾事件忽略', () => {
    const h = makeHarness('created.json', []);
    h.sync.init();

    h.state.agents = [{ id: 'a1', name: '小陈' }];
    h.emit('created', { id: 'a1', name: '小陈' });
    expect(getAgentNames()).toEqual(['小陈']);
    expect(fs.existsSync(path.join(sandbox, 'created.json'))).toBe(false); // 无写盘

    h.emit('deleted', 42); // 非法载荷
    h.emit('updated', { id: 'x' }); // 缺 name
    expect(getAgentNames()).toEqual(['小陈']);
  });

  it('同步写盘失败(路径不可写)→ 吞掉异常,事件不上抛', () => {
    // 把热词路径指到一个「父路径是文件」的位置:mkdirSync 必抛
    const blocker = path.join(sandbox, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const logs: string[] = [];
    const listeners = new Set<(event: string, data: unknown) => void>();
    const sync = createAgentHotwordSync({
      getAll: () => [{ id: 'a1', name: '主管' }],
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      env: { [HOTWORDS_SOURCE_ENV]: path.join(blocker, 'hotwords.json') },
      log: (msg) => logs.push(msg),
    });
    sync.init();

    expect(() => {
      for (const l of [...listeners]) l('deleted', 'a1');
    }).not.toThrow();
    expect(logs.some((m) => m.includes('失败'))).toBe(true);
  });
});
