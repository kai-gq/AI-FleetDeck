/**
 * 热词管家(hotword-curator)单测:「只看对话」提取 / 增量节点 / 硬校验 / 全流程。
 * 全部走沙箱目录(projectDir 覆盖 + TC_VOICE_HOTWORDS_SOURCE),不碰真实 ~/.claude 与仓库文件。
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOTWORDS_SOURCE_ENV, readHotwordsFile, setAgentNamesProvider } from './asr-hotwords.js';
import { VOICE_CWD_ENV, resolveVoiceCwd } from './companion-cli-profile.js';
import {
  buildCuratorPrompt,
  collectIncrementalDialogue,
  extractAssistantSay,
  parseCuratorReply,
  parseSessionLines,
  refreshHotwords,
  resolveCuratorCwd,
  stripUserTemplate,
  validateCandidates,
} from './hotword-curator.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-curator-'));
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

// ---- 真实形态的 JSONL 行工厂(照 2026-10-07 实测样例) ----

function userLine(content: string, tsIso: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    timestamp: tsIso,
  });
}

function userToolResultLine(tsIso: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] },
    timestamp: tsIso,
  });
}

function assistantLine(say: string, tsIso: string, thinking = 'INTERNAL-THINKING-TEXT'): string {
  return JSON.stringify({
    parentUuid: 'u1',
    isSidechain: false,
    type: 'assistant',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text: JSON.stringify({ action: 'general_response', responseToUser: say }) },
      ],
    },
    timestamp: tsIso,
  });
}

function queueOpLine(content: string, tsIso: string): string {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: tsIso, sessionId: 's1', content });
}

function writeSession(dir: string, name: string, lines: string[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

describe('stripUserTemplate', () => {
  it('剥【…】注入模板(实测形态);无模板原样;纯模板 → 空', () => {
    expect(
      stripUserTemplate('看看主管在干嘛？\n\n【当前时间】2026/10/6 23:55:52\n\n【格式】只回那个 JSON 对象,不要任何解释。'),
    ).toBe('看看主管在干嘛？');
    expect(stripUserTemplate('打开 bolba 看板')).toBe('打开 bolba 看板');
    expect(stripUserTemplate('【事件】定时汇报')).toBe('');
  });

  it('剥「换说法」尾巴(它复制往期大脑回复,会污染计数)与 agent 状态注入块', () => {
    expect(
      stripUserTemplate(
        '老板刚才说:「团队一现在什么情况？」 (最近你已经应过:「这就去摸摸a的底」「嗯，这个我得琢磨琢磨」——这次换个说法,别重样。)',
      ),
    ).toBe('老板刚才说:「团队一现在什么情况？」');
    expect(
      stripUserTemplate(
        '老板的问题:主管手上的活怎么样了？ agent「主管」当前状态:idle,任务:推荐先试零成本档:晓伊音色+降速 最近输出记录: 以下为主管名下最近产出…',
      ),
    ).toBe('老板的问题:主管手上的活怎么样了？');
  });
});

describe('resolveCuratorCwd', () => {
  it('与 voice-cwd 同级、独立目录并已 mkdir;inherit → null(回退档案默认)', () => {
    const env = { [VOICE_CWD_ENV]: path.join(sandbox, 'v-cwd') };
    const voiceCwd = resolveVoiceCwd(env);
    expect(voiceCwd).not.toBeNull();
    const dir = resolveCuratorCwd(env);
    expect(dir).toBe(path.join(path.dirname(voiceCwd!), 'voice-hotwords-cwd'));
    expect(fs.existsSync(dir!)).toBe(true);

    expect(resolveCuratorCwd({ [VOICE_CWD_ENV]: 'inherit' })).toBeNull();
  });
});

describe('extractAssistantSay', () => {
  it('跳过 thinking,只取协议 JSON 的 responseToUser', () => {
    const content = [
      { type: 'thinking', thinking: 'about tide-commander rules' },
      { type: 'text', text: '{"action":"general_response","responseToUser":"好的,我去看看。"}' },
    ];
    expect(extractAssistantSay(content)).toBe('好的,我去看看。');
  });

  it('非 JSON 文本原样;协议壳无 responseToUser → 空;无 text 块 → 空', () => {
    expect(extractAssistantSay([{ type: 'text', text: '就是一句大白话' }])).toBe('就是一句大白话');
    expect(extractAssistantSay([{ type: 'text', text: '{"action":"noop","responseToUser":""}' }])).toBe('');
    expect(extractAssistantSay([{ type: 'thinking', thinking: 'x' }])).toBe('');
    expect(extractAssistantSay('not-array')).toBe('');
  });
});

describe('parseSessionLines / collectIncrementalDialogue', () => {
  it('只留对话:queue-operation/tool_result/isSidechain 跳过;since 过滤;maxTs 跟进全部合法行', () => {
    const lines = [
      queueOpLine('看看主管在干嘛？', iso(NOW - 500_000)),
      userLine('看看主管在干嘛？\n\n【当前时间】x', iso(NOW - 490_000)),
      userToolResultLine(iso(NOW - 480_000)),
      assistantLine('在,我去看一眼。', iso(NOW - 470_000)),
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: '侧链内容' }, timestamp: iso(NOW - 460_000) }),
      userLine('旧消息(节点前)', iso(NOW - 600_000)),
    ];
    const { turns, maxTs } = parseSessionLines(lines, NOW - 500_000);
    expect(turns.map((t) => t.text)).toEqual(['看看主管在干嘛？', '在,我去看一眼。']);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(maxTs).toBe(NOW - 460_000); // 侧链行时间也参与节点推进(时间戳与内容过滤分开)
  });

  it('mtime 早于节点的文件整体跳过(不做逐行扫描)', () => {
    const dir = path.join(sandbox, 'proj-mtime');
    fs.mkdirSync(dir, { recursive: true });
    const f = writeSession(dir, 'old.jsonl', [userLine('窗口内但文件已过期', iso(NOW - 50_000))]);
    fs.utimesSync(f, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const d = collectIncrementalDialogue({ projectDir: dir, sinceMs: NOW - 100_000 });
    expect(d.turnCount).toBe(0);
    expect(d.fileCount).toBe(0);
  });

  it('跨文件按时间合并;超量截断保最新并标 sampled;thinking 不进正文', () => {
    const dir = path.join(sandbox, 'proj-merge');
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 'a.jsonl', [
      userLine('甲说 bolba', iso(NOW - 300_000)),
      assistantLine('收到甲', iso(NOW - 299_000)),
    ]);
    writeSession(dir, 'b.jsonl', [
      userLine('乙说 beta-marker', iso(NOW - 200_000)),
      assistantLine('收到乙', iso(NOW - 199_000)),
    ]);
    const full = collectIncrementalDialogue({ projectDir: dir, sinceMs: 0 });
    expect(full.turnCount).toBe(4);
    expect(full.fileCount).toBe(2);
    expect(full.lines[0]).toContain('甲说 bolba');
    expect(full.lines[3]).toContain('收到乙');
    expect(full.maxTimestamp).toBe(NOW - 199_000);
    expect(full.text).not.toContain('INTERNAL-THINKING-TEXT');

    // 只够装最新两行 → 旧两行被截,标 sampled
    const cut = collectIncrementalDialogue({
      projectDir: dir,
      sinceMs: 0,
      maxChars: full.lines[2].length + full.lines[3].length + 3,
    });
    expect(cut.sampled).toBe(true);
    expect(cut.text).toContain('乙说 beta-marker');
    expect(cut.text).toContain('收到乙');
    expect(cut.text).not.toContain('甲说 bolba');
  });
});

describe('parseCuratorReply / validateCandidates', () => {
  it('解析:围栏/杂文本容忍;非 JSON → 空', () => {
    expect(parseCuratorReply('```json\n{"hotwords":[{"word":"bolba"}]}\n```')).toEqual([{ word: 'bolba' }]);
    expect(parseCuratorReply('好的:{"hotwords":[]}完毕')).toEqual([]);
    expect(parseCuratorReply('没有 JSON')).toEqual([]);
  });

  it('硬校验:词必须真在对话里出现;count 由代码统计;非法形态丢进 rejected', () => {
    const dialogue = '[用户] 打开 bolba 看板用 tRPC\n[大脑] bolba 已经打开了。';
    const { accepted, rejected } = validateCandidates(
      [
        { word: 'bolba', weight: 8 },
        { word: '编造词', weight: 9 }, // 对话里没有 → 拒
        { word: 'tRPC', weight: 100 }, // 权重 clamp 到 10
        { word: '打开', weight: 3 }, // 在对话里,但形态合法 → 收(排除靠提示词)
        { word: '上', weight: 3 }, // 单字 → 拒
        { word: '123', weight: 3 }, // 纯数字 → 拒
        { word: 'bolba', weight: 5 }, // 重复 → 拒
      ],
      dialogue,
    );
    expect(accepted.map((c) => c.word)).toEqual(['bolba', 'tRPC', '打开']);
    expect(accepted[0]).toMatchObject({ count: 2, weight: 8 });
    expect(accepted[1].weight).toBe(10);
    expect(rejected).toEqual(['编造词', '上', '123', 'bolba']);
  });
});

describe('refreshHotwords 全流程(沙箱)', () => {
  it('首跑:模型筛选 → 硬校验 → 合并写盘;节点推进到最大消息时间', async () => {
    const dir = path.join(sandbox, 'flow');
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 's1.jsonl', [
      queueOpLine('打开 bolba 看板\n\n【当前时间】x', iso(NOW - 300_500)),
      userLine('打开 bolba 看板\n\n【当前时间】x\n\n【格式】y', iso(NOW - 300_000)),
      assistantLine('bolba 看板已经打开了。', iso(NOW - 299_000)),
      userLine('alpha-marker 再聊聊别的', iso(NOW - 298_000)),
    ]);
    const hotwordsPath = path.join(sandbox, 'flow-hotwords.json');
    const env = { [HOTWORDS_SOURCE_ENV]: hotwordsPath };
    const userContents: string[] = [];
    const callModel = async (_system: string, user: string): Promise<string> => {
      userContents.push(user);
      return '{"hotwords":[{"word":"bolba","weight":8,"evidence":"打开 bolba 看板"},{"word":"编造词","weight":5}]}';
    };

    const result = await refreshHotwords({ callModel, env, projectDir: dir, now: NOW });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ added: 1, rejected: 1, turnCount: 3, skippedBlocked: 0 });
    expect(result.analyzedTo).toBe(iso(NOW - 298_000));
    expect(userContents).toHaveLength(1);
    expect(userContents[0]).toContain('打开 bolba 看板');

    const { file } = readHotwordsFile(env);
    expect(file.lastAnalyzedAt).toBe(iso(NOW - 298_000));
    expect(file.words).toHaveLength(1);
    expect(file.words[0]).toMatchObject({ word: 'bolba', weight: 8, count: 2, source: 'agent' });
  });

  it('二跑增量:只喂新消息;已有词被提及 → touch 刷新 count', async () => {
    const dir = path.join(sandbox, 'flow-inc');
    fs.mkdirSync(dir, { recursive: true });
    // 上一批(节点之前)的会话文件:内容不应再被喂给模型
    writeSession(dir, 's1.jsonl', [
      userLine('打开 bolba 看板 alpha-marker', iso(NOW - 300_000)),
      assistantLine('bolba 看板已经打开了。', iso(NOW - 299_000)),
      userLine('好的', iso(NOW - 298_000)),
    ]);
    writeSession(dir, 's2.jsonl', [
      userLine('再看看 bolba 的进度 beta-marker', iso(NOW - 20_000)),
      assistantLine('bolba 进度正常。', iso(NOW - 19_000)),
      userLine('好的', iso(NOW - 18_000)),
    ]);
    const hotwordsPath = path.join(sandbox, 'inc-hotwords.json');
    const env = { [HOTWORDS_SOURCE_ENV]: hotwordsPath };
    fs.writeFileSync(hotwordsPath, JSON.stringify({
      lastAnalyzedAt: iso(NOW - 100_000),
      words: [{ word: 'bolba', weight: 8, count: 2, source: 'agent', addedAt: iso(NOW - 300_000), lastSeenAt: iso(NOW - 300_000) }],
    }));
    const userContents: string[] = [];
    const callModel = async (_system: string, user: string): Promise<string> => {
      userContents.push(user);
      return '{"hotwords":[]}';
    };

    const result = await refreshHotwords({ callModel, env, projectDir: dir, now: NOW });
    expect(result.turnCount).toBe(3);
    expect(result.fileCount).toBe(1); // 旧文件不再贡献回合
    expect(userContents[0]).toContain('beta-marker');
    expect(userContents[0]).not.toContain('alpha-marker');

    const { file } = readHotwordsFile(env);
    expect(result.touched).toBe(1);
    expect(file.words[0].count).toBe(4); // 2 + 本批出现 2(bolba 在用户与大脑两侧各一次)
    expect(file.words[0].weight).toBe(8);
    expect(file.lastAnalyzedAt).toBe(iso(NOW - 18_000));
    expect(result.analyzedFrom).toBe(iso(NOW - 100_000)); // 缺省起点 = 节点
  });

  it('sinceMs 覆写分析起点:节点之前的旧对话也重扫(「上次分析时间可选」)', async () => {
    const dir = path.join(sandbox, 'flow-since');
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 's1.jsonl', [
      userLine('旧的 alpha-marker', iso(NOW - 300_000)),
      assistantLine('好的', iso(NOW - 299_000)),
      userLine('新的 beta-marker', iso(NOW - 20_000)),
      assistantLine('收到', iso(NOW - 19_000)),
      userLine('好的继续', iso(NOW - 18_000)),
    ]);
    const hotwordsPath = path.join(sandbox, 'since-hotwords.json');
    const env = { [HOTWORDS_SOURCE_ENV]: hotwordsPath };
    fs.writeFileSync(hotwordsPath, JSON.stringify({ lastAnalyzedAt: iso(NOW - 100_000), words: [] }));
    const userContents: string[] = [];
    const callModel = async (_system: string, user: string): Promise<string> => {
      userContents.push(user);
      return '{"hotwords":[]}';
    };

    const result = await refreshHotwords({
      callModel,
      env,
      projectDir: dir,
      now: NOW,
      sinceMs: NOW - 500_000, // 覆写:回到节点之前
    });
    expect(result.analyzedFrom).toBe(iso(NOW - 500_000)); // 起点 = 覆写值
    expect(result.turnCount).toBe(5); // 旧 2 回合 + 新 3 回合全进
    expect(userContents).toHaveLength(1);
    expect(userContents[0]).toContain('alpha-marker'); // 节点之前的旧对话重扫进
    expect(userContents[0]).toContain('beta-marker');
    expect(readHotwordsFile(env).file.lastAnalyzedAt).toBe(iso(NOW - 18_000)); // 节点仍推进到最新
  });

  it('新对话不足 3 条 → 不调模型、不写盘', async () => {
    const dir = path.join(sandbox, 'flow-thin');
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 's1.jsonl', [userLine('就一句话', iso(NOW - 5_000))]);
    const hotwordsPath = path.join(sandbox, 'thin-hotwords.json');
    const env = { [HOTWORDS_SOURCE_ENV]: hotwordsPath };
    const callModel = vi.fn(async () => '{"hotwords":[]}');

    const result = await refreshHotwords({ callModel, env, projectDir: dir, now: NOW });
    expect(result.message).toContain('没有足够的新对话');
    expect(callModel).not.toHaveBeenCalled();
    expect(fs.existsSync(hotwordsPath)).toBe(false);
  });

  it('blocked 词被模型再次提出 → 丢弃并计数', async () => {
    const dir = path.join(sandbox, 'flow-blocked');
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 's1.jsonl', [
      userLine('bolba bolba', iso(NOW - 30_000)),
      assistantLine('好的', iso(NOW - 29_000)),
      userLine('继续', iso(NOW - 28_000)),
    ]);
    const hotwordsPath = path.join(sandbox, 'blocked-hotwords.json');
    const env = { [HOTWORDS_SOURCE_ENV]: hotwordsPath };
    fs.writeFileSync(hotwordsPath, JSON.stringify({ blocked: ['bolba'], words: [] }));
    const callModel = async (): Promise<string> => '{"hotwords":[{"word":"bolba","weight":8}]}';

    const result = await refreshHotwords({ callModel, env, projectDir: dir, now: NOW });
    expect(result).toMatchObject({ added: 0, skippedBlocked: 1 });
    expect(readHotwordsFile(env).file.words).toHaveLength(0);
  });
});

describe('refreshHotwords 与锁定层(agent 名)交互', () => {
  afterEach(() => {
    setAgentNamesProvider(null);
  });

  it('池内与 agent 名重复的存量条目被清走(不拉黑);对话不足也照写盘', async () => {
    setAgentNamesProvider(() => ['主管']);
    const dir = path.join(sandbox, 'flow-strip');
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 's1.jsonl', [userLine('就一句话', iso(NOW - 5_000))]);
    const hotwordsPath = path.join(sandbox, 'strip-hotwords.json');
    const env = { [HOTWORDS_SOURCE_ENV]: hotwordsPath };
    fs.writeFileSync(hotwordsPath, JSON.stringify({
      words: [
        { word: '主管', weight: 3, count: 0, source: 'agent', addedAt: iso(NOW), lastSeenAt: iso(NOW) },
        { word: 'bolba', weight: 6, count: 1, source: 'agent', addedAt: iso(NOW), lastSeenAt: iso(NOW) },
      ],
    }));
    const callModel = vi.fn(async () => '{"hotwords":[]}');

    const result = await refreshHotwords({ callModel, env, projectDir: dir, now: NOW });
    expect(result.strippedDuplicates).toBe(1);
    expect(result.message).toContain('没有足够的新对话');
    expect(callModel).not.toHaveBeenCalled();
    const { file } = readHotwordsFile(env);
    expect(file.words.map((w) => w.word)).toEqual(['bolba']);
    expect(file.blocked).toEqual([]); // 清理 ≠ 拉黑
  });

  it('模型提议锁定词(agent 名)→ 不落池,计入 skippedBlocked', async () => {
    setAgentNamesProvider(() => ['主管']);
    const dir = path.join(sandbox, 'flow-locked');
    fs.mkdirSync(dir, { recursive: true });
    writeSession(dir, 's1.jsonl', [
      userLine('主管 帮我看下 bolba', iso(NOW - 30_000)),
      assistantLine('好的', iso(NOW - 29_000)),
      userLine('继续', iso(NOW - 28_000)),
    ]);
    const hotwordsPath = path.join(sandbox, 'locked-hotwords.json');
    const env = { [HOTWORDS_SOURCE_ENV]: hotwordsPath };
    const callModel = async (): Promise<string> =>
      '{"hotwords":[{"word":"主管","weight":9},{"word":"bolba","weight":7}]}';

    const result = await refreshHotwords({ callModel, env, projectDir: dir, now: NOW });
    expect(result).toMatchObject({ added: 1, skippedBlocked: 1 });
    const { file } = readHotwordsFile(env);
    expect(file.words.map((w) => w.word)).toEqual(['bolba']);
  });
});

describe('buildCuratorPrompt', () => {
  it('带已有热词与对话正文', () => {
    const { system, user } = buildCuratorPrompt('[用户] 打开 bolba', ['tRPC']);
    expect(system).toContain('ASR 热词筛选员');
    expect(user).toContain('【已有热词】');
    expect(user).toContain('tRPC');
    expect(user).toContain('[用户] 打开 bolba');
  });
});
