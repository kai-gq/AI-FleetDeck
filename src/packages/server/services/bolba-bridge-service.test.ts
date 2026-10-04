/**
 * 任务13·⑩ bolba-bridge-service 单测
 *
 * 覆盖：日期解析/分桶边界（今天/明天/过期/周口径）、选单/分组/渲染、引用匹配、
 * 只读视图、写路径（create/complete/reopen，mock fetch 不起真服务）、409 防重与强制、
 * 🟡⑩ bolba-sync 埋点（logEvent mock 断言）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOLBA_CONTRACT_ACTIONS,
  BOLBA_DEGRADED_REPLY,
  classifyBolbaDue,
  completeBolbaTaskFromVoice,
  createBolbaTaskFromVoice,
  dueLabel,
  fetchPendingBolbaTasks,
  groupTasksByProject,
  handleBolbaContractAction,
  matchBolbaTaskReference,
  parseSpokenDue,
  pickBolbaQueryMode,
  queryBolbaTasksView,
  reopenBolbaTaskFromVoice,
  renderDueReport,
  renderProjectReport,
  selectDueSoonTasks,
  speakableDue,
  stripDuePhrases,
  type BolbaApiTask,
} from './bolba-bridge-service.js';

vi.mock('../data/system-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/system-log.js')>();
  return { ...actual, logEvent: vi.fn() };
});

import { logEvent } from '../data/system-log.js';

const logEventMock = vi.mocked(logEvent);

/** 2026-10-05 = 周一（本地时区），周口径断言锚点。 */
const NOW = new Date(2026, 9, 5);

const originalUrl = process.env.BOLBA_TASKS_URL;
const originalToken = process.env.BOLBA_TASKS_TOKEN;

beforeEach(() => {
  process.env.BOLBA_TASKS_URL = 'http://127.0.0.1:9876';
  process.env.BOLBA_TASKS_TOKEN = 'test-token';
  logEventMock.mockClear();
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.BOLBA_TASKS_URL;
  else process.env.BOLBA_TASKS_URL = originalUrl;
  if (originalToken === undefined) delete process.env.BOLBA_TASKS_TOKEN;
  else process.env.BOLBA_TASKS_TOKEN = originalToken;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function task(over: Partial<BolbaApiTask> & { id: number | string; title: string }): BolbaApiTask {
  return { status: 'open', ...over };
}

// ============================================================================
// 日期解析 / 分桶
// ============================================================================

describe('parseSpokenDue', () => {
  it('解析相对日（今天/明天/后天/大后天）', () => {
    expect(parseSpokenDue('今天要盯的', NOW)).toBe('2026-10-05');
    expect(parseSpokenDue('明天提醒我', NOW)).toBe('2026-10-06');
    expect(parseSpokenDue('后天', NOW)).toBe('2026-10-07');
    expect(parseSpokenDue('大后天', NOW)).toBe('2026-10-08');
  });

  it('解析周口径：无前缀=含今天的下一次，本/这=本周（已过顺延），下=下一周', () => {
    expect(parseSpokenDue('周五前准备报价', NOW)).toBe('2026-10-09');
    expect(parseSpokenDue('本周三交', NOW)).toBe('2026-10-07');
    expect(parseSpokenDue('下周三交', NOW)).toBe('2026-10-14');
    // 当天即周五 → 就是今天
    expect(parseSpokenDue('周五前给我', new Date(2026, 9, 9))).toBe('2026-10-09');
    // 说「本周三」时已是周四 → 本周的那天已过，保守顺延一周
    expect(parseSpokenDue('本周三交', new Date(2026, 9, 8))).toBe('2026-10-14');
    // 无前缀且已过（周四说周三）→ 下一次（下周三）
    expect(parseSpokenDue('周三交', new Date(2026, 9, 8))).toBe('2026-10-14');
  });

  it('解析绝对日期（年月日 / 月日，月日取未来最近一次）', () => {
    expect(parseSpokenDue('2026-10-10 之前', NOW)).toBe('2026-10-10');
    expect(parseSpokenDue('10月10日前', NOW)).toBe('2026-10-10');
    expect(parseSpokenDue('10月1号之前', NOW)).toBe('2027-10-01'); // 今年已过 → 明年
  });

  it('解析不到返回 null', () => {
    expect(parseSpokenDue('准备 BOL-4472 报价', NOW)).toBeNull();
    expect(parseSpokenDue('', NOW)).toBeNull();
  });
});

describe('stripDuePhrases', () => {
  it('剥离日期词与截止修饰词（含指令口头语）', () => {
    expect(stripDuePhrases('周五前准备 BOL-4472 报价')).toBe('准备 BOL-4472 报价');
    expect(stripDuePhrases('记一下，周五前准备报价')).toBe('准备报价');
    expect(stripDuePhrases('下周三之前 付款 ALT')).toBe('付款 ALT');
    expect(stripDuePhrases('准备 BOL-4472 报价')).toBe('准备 BOL-4472 报价');
  });
});

describe('classifyBolbaDue / dueLabel 边界', () => {
  it('昨天/今天/明天/更远/无值 分桶', () => {
    expect(classifyBolbaDue('2026-10-04', NOW)).toEqual({ bucket: 'overdue', days: -1 });
    expect(classifyBolbaDue('2026-10-05', NOW)).toEqual({ bucket: 'today', days: 0 });
    expect(classifyBolbaDue('2026-10-06', NOW)).toEqual({ bucket: 'tomorrow', days: 1 });
    expect(classifyBolbaDue('2026-10-09', NOW)).toEqual({ bucket: 'later', days: 4 });
    expect(classifyBolbaDue(null, NOW)).toEqual({ bucket: 'none', days: null });
    expect(classifyBolbaDue('not-a-date', NOW)).toEqual({ bucket: 'none', days: null });
  });

  it('口播标签', () => {
    expect(dueLabel('2026-10-03', NOW)).toBe('已过期 2 天');
    expect(dueLabel('2026-10-05', NOW)).toBe('今天到期');
    expect(dueLabel('2026-10-06', NOW)).toBe('明天到期');
    expect(dueLabel('2026-10-09', NOW)).toBe('4 天后到期');
    expect(dueLabel(undefined, NOW)).toBe('未标截止');
    expect(speakableDue('2026-10-05', NOW)).toBe('今天');
    expect(speakableDue('2026-10-06', NOW)).toBe('明天');
    expect(speakableDue('2026-10-09', NOW)).toBe('10月9日');
  });
});

// ============================================================================
// 选单 / 分组 / 渲染 / 匹配
// ============================================================================

describe('selectDueSoonTasks / renderDueReport', () => {
  const tasks: BolbaApiTask[] = [
    task({ id: 1, title: 'A 过期两天', due: '2026-10-03' }),
    task({ id: 2, title: 'B 今天', due: '2026-10-05' }),
    task({ id: 3, title: 'C 明天', due: '2026-10-06', proj: 'BOL' }),
    task({ id: 4, title: 'D 四天后', due: '2026-10-09' }),
    task({ id: 5, title: 'E 无截止' }),
    task({ id: 6, title: 'F 今天但已完成', due: '2026-10-05', status: 'done' }),
  ];

  it('只取 overdue/today/tomorrow（horizon=1），过期最久在前，非 pending/无 due 排除', () => {
    expect(selectDueSoonTasks(tasks, NOW).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('渲染为口播列表；空板与无到期有话说', () => {
    const text = renderDueReport(tasks, NOW);
    expect(text).toContain('今天要盯 3 件');
    expect(text).toContain('已过期 2 天');
    expect(text).toContain('今天到期');
    expect(text).toContain('明天到期');
    expect(text).toContain('（BOL）');
    expect(renderDueReport([], NOW)).toBe('板上没有在办的活。');
    const laterOnly = renderDueReport([task({ id: 9, title: '下周的活', due: '2026-10-20' })], NOW);
    expect(laterOnly).toContain('这两天没有到期的');
  });

  it('超过 cap 提示还有多少件', () => {
    const many = Array.from({ length: 8 }, (_, i) => task({ id: i + 1, title: `T${i + 1}`, due: '2026-10-05' }));
    expect(renderDueReport(many, NOW, 6)).toContain('还有 2 件');
  });
});

describe('groupTasksByProject / renderProjectReport / pickBolbaQueryMode', () => {
  const tasks: BolbaApiTask[] = [
    task({ id: 1, title: 'BOL 急', due: '2026-10-05', proj: 'BOL' }),
    task({ id: 2, title: 'BOL 缓', due: '2026-10-20', proj: 'BOL' }),
    task({ id: 3, title: 'ALT 活', due: '2026-10-06', proj: 'ALT' }),
    task({ id: 4, title: '散活' }),
  ];

  it('分组按最早 due 排序，组内同样排序', () => {
    const groups = groupTasksByProject(tasks, NOW);
    expect(groups.map((g) => g.project)).toEqual(['BOL', 'ALT', '未分项目']);
    expect(groups[0].tasks.map((t) => t.id)).toEqual([1, 2]);
  });

  it('渲染按项目视图', () => {
    const text = renderProjectReport(tasks, NOW);
    expect(text).toContain('按项目：');
    expect(text).toContain('BOL 2 件在办');
    expect(text).toContain('最急：『BOL 急』今天到期');
    expect(renderProjectReport([], NOW)).toBe('板上没有在办的活。');
  });

  it('视图选择：项目名/按项目/默认按截止', () => {
    expect(pickBolbaQueryMode('BOL 项目有什么', ['BOL', 'ALT'])).toEqual({ mode: 'project', project: 'BOL' });
    expect(pickBolbaQueryMode('按项目看看', ['BOL'])).toEqual({ mode: 'projects' });
    expect(pickBolbaQueryMode('今天有什么要盯的', ['BOL'])).toEqual({ mode: 'due' });
  });
});

describe('matchBolbaTaskReference', () => {
  const tasks = [
    task({ id: 5301, title: '准备 BOL-4472 报价' }),
    task({ id: 5302, title: '付款 ALT' }),
    task({ id: 5303, title: '付款 BOL' }),
  ];

  it('纯数字/#数字 → id 精确', () => {
    expect(matchBolbaTaskReference('5301', tasks)).toMatchObject({ kind: 'found', task: { id: 5301 } });
    expect(matchBolbaTaskReference('#5302', tasks)).toMatchObject({ kind: 'found', task: { id: 5302 } });
  });

  it('标题精确/包含 → found', () => {
    expect(matchBolbaTaskReference('准备 BOL-4472 报价', tasks)).toMatchObject({ kind: 'found', task: { id: 5301 } });
    expect(matchBolbaTaskReference('BOL-4472', tasks)).toMatchObject({ kind: 'found', task: { id: 5301 } });
  });

  it('多命中 → ambiguous（候选≤3）；无命中/空 → none', () => {
    const m = matchBolbaTaskReference('付款', tasks);
    expect(m.kind).toBe('ambiguous');
    expect(m.candidates?.map((t) => t.id)).toEqual([5302, 5303]);
    expect(matchBolbaTaskReference('不存在的事', tasks).kind).toBe('none');
    expect(matchBolbaTaskReference('', tasks).kind).toBe('none');
    expect(matchBolbaTaskReference('9999', tasks).kind).toBe('none');
  });
});

// ============================================================================
// IO：只读视图（mock fetch）
// ============================================================================

describe('queryBolbaTasksView（mock fetch）', () => {
  it('按截止视图：拉取 + 过滤 + 渲染 + 埋点', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse({
      count: 2,
      tasks: [
        { id: 5301, title: '报价', status: 'open', proj: 'BOL', due: '2026-10-06' },
        { id: 5302, title: '已完成的', status: 'done', due: '2026-10-05' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await queryBolbaTasksView({ userText: '我今天有什么要盯的', now: NOW });
    expect(r.degraded).toBe(false);
    expect(r.response).toContain('今天要盯 1 件');
    expect(r.response).toContain('『报价』明天到期');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:9876/tasks');
    expect(logEventMock).toHaveBeenCalledWith('system', expect.objectContaining({
      source: 'bolba',
      body: expect.objectContaining({ cat: 'bolba-sync', op: 'query', ok: true, mode: 'due' }),
    }));
  });

  it('项目视图：命中项目名过滤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      count: 2,
      tasks: [
        { id: 1, title: 'BOL 活', status: 'open', proj: 'BOL', due: '2026-10-05' },
        { id: 2, title: 'ALT 活', status: 'open', proj: 'ALT', due: '2026-10-05' },
      ],
    })));
    const r = await queryBolbaTasksView({ userText: 'BOL 项目上有什么', now: NOW });
    expect(r.mode).toBe('project');
    expect(r.response).toContain('BOL 1 件在办');
    expect(r.response).not.toContain('ALT 活');
  });

  it('网络失败 → 确定性降级 + warn 埋点', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    const r = await queryBolbaTasksView({ userText: '今天有什么要盯的', now: NOW });
    expect(r.response).toBe(BOLBA_DEGRADED_REPLY);
    expect(r.degraded).toBe(true);
    expect(logEventMock).toHaveBeenCalledWith('system', expect.objectContaining({
      source: 'bolba',
      level: 'warn',
      body: expect.objectContaining({ cat: 'bolba-sync', op: 'query', ok: false }),
    }));
  });

  it('fetchPendingBolbaTasks 过滤非在办、保留 Bolba 字段原名', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      tasks: [
        { id: 1, title: 'A', status: 'waiting', proj: 'BOL', due: '2026-10-06', reg: '2026-10-01', from_person: '老板' },
        { id: 2, title: 'B', status: 'discarded' },
      ],
    })));
    const tasks = await fetchPendingBolbaTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 1, status: 'waiting', proj: 'BOL', due: '2026-10-06', reg: '2026-10-01', from_person: '老板' });
  });
});

// ============================================================================
// IO：写路径（mock fetch，不起真服务）
// ============================================================================

describe('createBolbaTaskFromVoice', () => {
  it('正常创建：POST /tasks，标题去时间词、due 从原话解析', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse({ id: 5310, task: { id: 5310, title: '准备 BOL-4472 报价' }, warnings: [] }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const r = await createBolbaTaskFromVoice({
      userText: '记一下，周五前准备 BOL-4472 报价',
      contract: { bolbaTask: '准备 BOL-4472 报价' },
      now: NOW,
    });
    expect(r.degraded).toBe(false);
    expect(r.response).toContain('记下了');
    expect(r.response).toContain('10月9日');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:9876/tasks');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ title: '准备 BOL-4472 报价', due: '2026-10-09' });
    expect(logEventMock).toHaveBeenCalledWith('system', expect.objectContaining({
      body: expect.objectContaining({ cat: 'bolba-sync', op: 'create', ok: true }),
    }));
  });

  it('契约没给 bolbaTask 时用原话兜底并剥离指令词', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse({ id: 5311, task: { id: 5311, title: '准备报价' } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await createBolbaTaskFromVoice({ userText: '记一下，周五前准备报价', now: NOW });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ title: '准备报价', due: '2026-10-09' });
  });

  it('409 防重：不强建，列出相似候选并要求确认', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ error: 'posible duplicado; revisa y reintenta con force=true o usa PATCH', candidates: [] }, 409);
      }
      return jsonResponse({ tasks: [{ id: 5301, status: 'open', proj: 'BOL', title: '准备 BOL-4472 报价' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await createBolbaTaskFromVoice({
      userText: '记一下，周五前准备 BOL-4472 报价',
      contract: { bolbaTask: '准备 BOL-4472 报价' },
      now: NOW,
    });
    expect(r.degraded).toBe(false);
    expect(r.response).toContain('板上已有很像的：『准备 BOL-4472 报价』');
    expect(r.response).toContain('强制记一条');
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
    expect(logEventMock).toHaveBeenCalledWith('system', expect.objectContaining({
      body: expect.objectContaining({ op: 'create', ok: false, error: '409 duplicate' }),
    }));
  });

  it('用户说「强制记一条」→ ?force=true 重试', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse({ id: 5312, task: { id: 5312, title: '准备报价' } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const r = await createBolbaTaskFromVoice({
      userText: '强制记一条：准备报价',
      contract: { bolbaTask: '准备报价' },
      now: NOW,
    });
    expect(r.degraded).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:9876/tasks?force=true');
  });

  it('网络失败 → 降级话术', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const r = await createBolbaTaskFromVoice({ userText: '记一下 准备报价', now: NOW });
    expect(r.response).toBe(BOLBA_DEGRADED_REPLY);
    expect(r.degraded).toBe(true);
  });
});

describe('complete/reopenBolbaTaskFromVoice', () => {
  it('完成后：按标题解析 id → POST /tasks/:id/close {status:done}', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true });
      return jsonResponse({ tasks: [{ id: 5301, status: 'open', title: '准备报价' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await completeBolbaTaskFromVoice({ reference: '准备报价', now: NOW });
    expect(r.response).toContain('标记完成了');
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(String(post?.[0])).toBe('http://127.0.0.1:9876/tasks/5301/close');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ status: 'done' });
    expect(logEventMock).toHaveBeenCalledWith('system', expect.objectContaining({
      body: expect.objectContaining({ op: 'complete', ok: true, taskId: 5301 }),
    }));
  });

  it('重开：POST /tasks/:id/reopen', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true });
      return jsonResponse({ tasks: [{ id: 5302, status: 'open', title: '付款 ALT' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await reopenBolbaTaskFromVoice({ reference: '5302', now: NOW });
    expect(r.response).toContain('重开了');
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(String(post?.[0])).toBe('http://127.0.0.1:9876/tasks/5302/reopen');
  });

  it('找不到 → 确定性话术，不发 POST', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse({ tasks: [{ id: 1, status: 'open', title: '别的活' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await completeBolbaTaskFromVoice({ reference: '不存在', now: NOW });
    expect(r.response).toContain('没找到');
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true);
  });

  it('歧义 → 列候选求澄清', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      tasks: [
        { id: 1, status: 'open', title: '付款 ALT' },
        { id: 2, status: 'open', title: '付款 BOL' },
      ],
    })));
    const r = await completeBolbaTaskFromVoice({ reference: '付款', now: NOW });
    expect(r.response).toContain('对应好几条');
    expect(r.response).toContain('『付款 ALT』');
  });

  // ---- 验证条件关闭:reopen 主场景(撤销误完成)→ 候选源补最近完成列表 ----

  it('reopen:在办列表已空时仍能从最近完成列表命中并写回(完成→重开闭环)', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true });
      if (String(url).includes('status=done')) {
        return jsonResponse({ tasks: [{ id: 5301, status: 'done', proj: 'BOL', title: '准备报价' }] });
      }
      return jsonResponse({ tasks: [] }); // 任务已完成:在办列表为空
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await reopenBolbaTaskFromVoice({ reference: '准备报价', now: NOW });
    expect(r.degraded).toBe(false);
    expect(r.response).toContain('重开了');
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(String(post?.[0])).toBe('http://127.0.0.1:9876/tasks/5301/reopen');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=done&limit=8'))).toBe(true);
  });

  it('reopen:在办与已完成候选同现 → 歧义守卫(列双方候选,不发写请求)', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true });
      if (String(url).includes('status=done')) {
        return jsonResponse({ tasks: [{ id: 2, status: 'done', title: '付款 BOL' }] });
      }
      return jsonResponse({ tasks: [{ id: 1, status: 'open', title: '付款 ALT' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await reopenBolbaTaskFromVoice({ reference: '付款', now: NOW });
    expect(r.response).toContain('对应好几条');
    expect(r.response).toContain('『付款 ALT』');
    expect(r.response).toContain('『付款 BOL』');
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true);
  });

  it('complete:不把已完成列表当候选(不请求 done 端点,防误改已完成条目)', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true });
      if (String(url).includes('status=done')) {
        return jsonResponse({ tasks: [{ id: 2, status: 'done', title: '准备报价' }] });
      }
      return jsonResponse({ tasks: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await completeBolbaTaskFromVoice({ reference: '准备报价', now: NOW });
    expect(r.response).toContain('没找到');
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=done'))).toBe(false);
  });
});

// ============================================================================
// 契约入口 / 动作集 / 埋点兜底
// ============================================================================

describe('handleBolbaContractAction', () => {
  it('四动作都在 BOLBA_CONTRACT_ACTIONS 且可路由（query 注入板数据）', async () => {
    expect([...BOLBA_CONTRACT_ACTIONS].sort()).toEqual([
      'complete_bolba_task', 'create_bolba_task', 'query_bolba_tasks', 'reopen_bolba_task',
    ]);
    const r = await handleBolbaContractAction({
      action: 'query_bolba_tasks',
      userText: '我今天有什么要盯的',
      contract: { query: '今天要盯的' },
      now: NOW,
    });
    // 未 mock fetch（真实板不可达）→ 兜底降级，但绝不抛
    expect(typeof r.response).toBe('string');
    expect(r.response.length).toBeGreaterThan(0);
  });

  it('完成动作：契约 bolbaTask 指代优先', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true });
      return jsonResponse({ tasks: [{ id: 7, status: 'open', title: '报价' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await handleBolbaContractAction({
      action: 'complete_bolba_task',
      userText: '把报价标记完成',
      contract: { bolbaTask: '报价' },
      now: NOW,
    });
    expect(r.response).toContain('标记完成了');
  });
});
