/**
 * 语音「打开X」本地直达 —— 单测(严格档)。
 *
 * vitest 全局 node 环境:store 用 vi.mock 截断(真实 store 链会拉进
 * websocket/state.ts 的 window 初始化);commander 执行器用 stubGlobal
 * 注入 window。E2E 另走浏览器 dev 钩子 __voiceCompanionTest。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store', () => ({
  store: {
    selectAgent: vi.fn(),
    requestTerminalExpand: vi.fn(),
    getState: vi.fn(() => ({ viewMode: '3d' })),
  },
}));

import { executeOpenCommand, matchOpenCommand } from './openCommand';
import { store } from '../store';

const AGENTS = [
  { id: 'a-boss', name: '主管' },
  { id: 'a-xiaochen', name: '小陈' },
  { id: 'a-xiaomei', name: '小美' },
  { id: 'a-alice', name: 'Alice' },
];

const setViewMode = (viewMode: string) =>
  vi.mocked(store.getState).mockReturnValue({ viewMode } as unknown as ReturnType<typeof store.getState>);

describe('matchOpenCommand — 正例(命中)', () => {
  it('「打开主管」命中对应 agent(用户数据实有 boss「主管」)', () => {
    expect(matchOpenCommand('打开主管', AGENTS)).toEqual({
      kind: 'agent',
      agentId: 'a-boss',
      name: '主管',
    });
  });

  it('「打开小陈」命中对应 agent', () => {
    expect(matchOpenCommand('打开小陈', AGENTS)).toEqual({
      kind: 'agent',
      agentId: 'a-xiaochen',
      name: '小陈',
    });
  });

  it('容忍句尾标点:打开小陈。/ 打开小陈! / 打开小陈~ / 打开小陈…', () => {
    for (const t of ['打开小陈。', '打开小陈!', '打开小陈!', '打开小陈~', '打开小陈…']) {
      expect(matchOpenCommand(t, AGENTS)?.kind, t).toBe('agent');
    }
  });

  it('容忍句尾语气词:打开小陈吧 / 打开小美呀 / 打开小陈啊', () => {
    expect(matchOpenCommand('打开小陈吧', AGENTS)?.kind).toBe('agent');
    expect(matchOpenCommand('打开小美呀', AGENTS)?.kind).toBe('agent');
    expect(matchOpenCommand('打开小陈啊', AGENTS)?.kind).toBe('agent');
  });

  it('容忍 ASR 空格:「打开 小陈」「打开 小美。」', () => {
    expect(matchOpenCommand('打开 小陈', AGENTS)).toEqual({
      kind: 'agent',
      agentId: 'a-xiaochen',
      name: '小陈',
    });
    expect(matchOpenCommand('打开 小美。', AGENTS)?.kind).toBe('agent');
  });

  it('英文名精确匹配(同大小写):打开Alice', () => {
    expect(matchOpenCommand('打开Alice', AGENTS)).toEqual({
      kind: 'agent',
      agentId: 'a-alice',
      name: 'Alice',
    });
  });

  it('指挥官固定别名:打开指挥官 / 打开指挥官。 / 打开指挥官视图', () => {
    expect(matchOpenCommand('打开指挥官', AGENTS)).toEqual({ kind: 'commander' });
    expect(matchOpenCommand('打开指挥官。', AGENTS)).toEqual({ kind: 'commander' });
    expect(matchOpenCommand('打开指挥官视图', AGENTS)).toEqual({ kind: 'commander' });
  });

  it('指挥官别名优先于同名 agent(视图语义固定)', () => {
    const withClash = [...AGENTS, { id: 'a-cmd', name: '指挥官' }];
    expect(matchOpenCommand('打开指挥官', withClash)).toEqual({ kind: 'commander' });
  });

  it('名字本身以语气词结尾时保守串兜底命中', () => {
    const odd = [{ id: 'a-ya', name: '阿呀' }];
    expect(matchOpenCommand('打开阿呀', odd)).toEqual({ kind: 'agent', agentId: 'a-ya', name: '阿呀' });
  });
});

describe('matchOpenCommand — 反例(不命中,原样进大脑)', () => {
  it('未知名单:打开文件 / 打开小陈涛', () => {
    expect(matchOpenCommand('打开文件', AGENTS)).toBeNull();
    expect(matchOpenCommand('打开小陈涛', AGENTS)).toBeNull();
  });

  it('带后续内容/查询类一律不命中:打开小陈的日志 / 打开主管的待办', () => {
    expect(matchOpenCommand('打开小陈的日志', AGENTS)).toBeNull();
    expect(matchOpenCommand('打开主管的待办', AGENTS)).toBeNull();
  });

  it('非「打开」开头:帮我打开小陈 / 今天打开主管了吗 / 关闭小陈', () => {
    expect(matchOpenCommand('帮我打开小陈', AGENTS)).toBeNull();
    expect(matchOpenCommand('今天打开主管了吗', AGENTS)).toBeNull();
    expect(matchOpenCommand('关闭小陈', AGENTS)).toBeNull();
  });

  it('严格档不认变体:打开一下小陈 / 打开小陈的聊天框', () => {
    expect(matchOpenCommand('打开一下小陈', AGENTS)).toBeNull();
    expect(matchOpenCommand('打开小陈的聊天框', AGENTS)).toBeNull();
  });

  it('空目标:空串 / 空白 / 打开 / 打开。 / 打开吧', () => {
    expect(matchOpenCommand('', AGENTS)).toBeNull();
    expect(matchOpenCommand('   ', AGENTS)).toBeNull();
    expect(matchOpenCommand('打开', AGENTS)).toBeNull();
    expect(matchOpenCommand('打开。', AGENTS)).toBeNull();
    expect(matchOpenCommand('打开吧', AGENTS)).toBeNull();
  });

  it('agent 名为空/缺失时不误命中', () => {
    const broken = [{ id: 'x', name: '' }, { id: 'y', name: '   ' }];
    expect(matchOpenCommand('打开 ', broken)).toBeNull();
  });
});

describe('executeOpenCommand — 动作与确认语', () => {
  beforeEach(() => {
    vi.mocked(store.selectAgent).mockClear();
    vi.mocked(store.requestTerminalExpand).mockClear();
    setViewMode('3d');
  });

  it('agent:选中 + 非 flat 视图请求展开终端,确认语「已打开」', () => {
    const ack = executeOpenCommand({ kind: 'agent', agentId: 'a-xiaochen', name: '小陈' });
    expect(store.selectAgent).toHaveBeenCalledWith('a-xiaochen');
    expect(store.requestTerminalExpand).toHaveBeenCalledTimes(1);
    expect(ack).toBe('已打开');
  });

  it('agent:flat 视图不请求展开(与 Spotlight 同款)', () => {
    setViewMode('flat');
    executeOpenCommand({ kind: 'agent', agentId: 'a-xiaomei', name: '小美' });
    expect(store.selectAgent).toHaveBeenCalledWith('a-xiaomei');
    expect(store.requestTerminalExpand).not.toHaveBeenCalled();
  });

  it('commander:派发 tide:open-commander 事件,确认语「已打开」', () => {
    const dispatch = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: dispatch });
    try {
      const ack = executeOpenCommand({ kind: 'commander' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      const evt = dispatch.mock.calls[0][0] as CustomEvent;
      expect(evt.type).toBe('tide:open-commander');
      expect(ack).toBe('已打开');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
