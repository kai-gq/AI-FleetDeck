/**
 * 分钟级提醒服务 —— 单测(存储/调度/回执/取消/上限/rearm/容错)。
 *
 * 全测试显式注入临时文件与可控时钟;setTimeout 用 vi.useFakeTimers 推进。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  REMINDER_MAX_PENDING,
  VoiceReminderService,
  buildReminderCapSay,
  buildReminderListSay,
  formatReminderDelayText,
  isVoiceReminderEnabled,
  toDuePayload,
  type DueReminderPayload,
} from './voice-reminder-service.js';
import { matchReminderCommand, type ReminderCreateCommand } from '../voice/reminder-parse.js';

const T0 = 1_700_000_000_000;

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-')), 'reminders.json');
}

function createCmd(text: string, at: number): ReminderCreateCommand {
  const cmd = matchReminderCommand(text, at);
  if (!cmd || cmd.op !== 'create') throw new Error(`fixture 解析失败: ${text}`);
  return cmd;
}

function makeService(filePath = tempFile()) {
  const pushed: DueReminderPayload[] = [];
  let fakeNow = T0;
  const service = new VoiceReminderService({
    filePath,
    now: () => fakeNow,
    push: (payload) => pushed.push(payload),
  });
  return {
    service,
    pushed,
    filePath,
    setNow: (t: number) => {
      fakeNow = t;
    },
    /** 时钟与定时器同步推进。 */
    advance: (ms: number) => {
      fakeNow += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

function readFile(filePath: string): { reminders: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { reminders: Array<Record<string, unknown>> };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// 注册 / 到点 / 回执
// ============================================================================

describe('注册 → 到点 → 回执 全链路', () => {
  it('注册落盘(pending)+ 定时器到点转 due + 推送话术 + 回执 done 幂等', () => {
    const { service, pushed, filePath, advance } = makeService();
    const cmd = createCmd('两分钟后提醒我喝水', T0);
    const res = service.register(cmd, '两分钟后提醒我喝水');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const saved = readFile(filePath);
    expect(saved.reminders).toHaveLength(1);
    expect(saved.reminders[0]).toMatchObject({
      id: res.reminder.id,
      status: 'pending',
      itemText: '喝水',
      fireAt: T0 + 120_000,
    });
    expect(pushed).toHaveLength(0);

    advance(120_000);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toEqual({ id: res.reminder.id, itemText: '喝水', fireAt: T0 + 120_000, say: '老大,到点了:喝水。' });
    expect(readFile(filePath).reminders[0].status).toBe('due');

    expect(service.ack(res.reminder.id)).toBe(true);
    expect(service.ack(res.reminder.id)).toBe(true); // 幂等
    const done = readFile(filePath).reminders[0];
    expect(done.status).toBe('done');
    expect(done.deliveredAt).toBe(T0 + 120_000);
  });

  it('ack 语义:pending 不能 ack,未知 id false', () => {
    const { service } = makeService();
    const res = service.register(createCmd('三分钟后叫我', T0), '三分钟后叫我');
    if (!res.ok) throw new Error('unreachable');
    expect(service.ack(res.reminder.id)).toBe(false);
    expect(service.ack('vr-nope')).toBe(false);
  });

  it('无事项提醒到点话术只报「到点了」', () => {
    const { service, pushed, advance } = makeService();
    service.register(createCmd('两分钟后叫我一下', T0), '两分钟后叫我一下');
    advance(120_000);
    expect(pushed[0].say).toBe('老大,到点了。');
  });
});

// ============================================================================
// 取消 / 列表 / 上限
// ============================================================================

describe('取消 / 列表 / 上限', () => {
  it('取消全部在挂(pending),定时器不再触发', () => {
    const { service, pushed, advance } = makeService();
    service.register(createCmd('两分钟后叫我', T0), '两分钟后叫我');
    service.register(createCmd('三分钟后叫我', T0), '三分钟后叫我');
    expect(service.cancelActive()).toBe(2);
    expect(service.listActive()).toHaveLength(0);
    advance(10 * 60_000);
    expect(pushed).toHaveLength(0);
    expect(service.cancelActive()).toBe(0);
  });

  it('列表:在挂按到点升序;due 未回执也算在挂', () => {
    const { service, advance } = makeService();
    service.register(createCmd('三分钟后叫我', T0), '三分钟后叫我');
    service.register(createCmd('两分钟后叫我', T0), '两分钟后叫我');
    const active = service.listActive();
    expect(active.map((r) => r.itemText)).toEqual(['', '']);
    expect(active[0].fireAt).toBe(T0 + 120_000);
    advance(120_000); // 第二条到点 → due
    expect(service.listActive()).toHaveLength(2);
    expect(service.listDue()).toHaveLength(1);
    expect(service.listDue()[0].fireAt).toBe(T0 + 120_000);
  });

  it('待播逾期 >1h 未取件:下次 listDue 自动取消(与 rearm 同口径,防陈年补播)', () => {
    const { service, pushed, advance } = makeService();
    const res = service.register(createCmd('两分钟后提醒我喝水', T0), '两分钟后提醒我喝水');
    if (!res.ok) throw new Error('unreachable');
    advance(120_000); // 到点 → due(推送过,但页面不在线)
    expect(pushed).toHaveLength(1);

    advance(30 * 60_000); // 晚 30 分钟取件:仍在窗口内
    expect(service.listDue()).toHaveLength(1);

    advance(31 * 60_000); // 累计晚 61 分钟 > 1h → 逾期
    expect(service.listDue()).toHaveLength(0);
    expect(service.ack(res.reminder.id)).toBe(false); // 已 cancelled,回执拒绝
  });

  it(`pending 上限 ${REMINDER_MAX_PENDING} 条,第 11 条拒绝(cap)`, () => {
    const { service } = makeService();
    for (let i = 0; i < REMINDER_MAX_PENDING; i++) {
      expect(service.register(createCmd('两分钟后叫我', T0), '两分钟后叫我').ok).toBe(true);
    }
    const overflow = service.register(createCmd('两分钟后叫我', T0), '两分钟后叫我');
    expect(overflow).toEqual({ ok: false, reason: 'cap' });
  });
});

// ============================================================================
// rearm(重启恢复)
// ============================================================================

describe('rearm —— 重启后的三种情形', () => {
  it('未到点:重设定时,到点照常触发', () => {
    const filePath = tempFile();
    const a = makeService(filePath);
    a.service.register(createCmd('两分钟后提醒我喝水', T0), '两分钟后提醒我喝水');
    a.service.dispose(); // 模拟进程结束(定时器丢失)

    const b = makeService(filePath);
    b.setNow(T0 + 30_000); // 30s 后重启
    b.service.rearm();
    b.advance(90_000); // T0+120000 到点
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0].say).toBe('老大,到点了:喝水。');
  });

  it('已过期 ≤1h:立即转 due 补发(页面在则播出)', () => {
    const filePath = tempFile();
    const a = makeService(filePath);
    a.service.register(createCmd('两分钟后提醒我喝水', T0), '两分钟后提醒我喝水');
    a.service.dispose();

    const b = makeService(filePath);
    b.setNow(T0 + 120_000 + 30 * 60_000); // 到点 30 分钟后重启
    b.service.rearm();
    expect(b.pushed).toHaveLength(1);
    expect(b.service.listDue()).toHaveLength(1);
    expect(readFile(filePath).reminders[0].status).toBe('due');
  });

  it('已过期 >1h:取消,不补发不打扰', () => {
    const filePath = tempFile();
    const a = makeService(filePath);
    a.service.register(createCmd('两分钟后提醒我喝水', T0), '两分钟后提醒我喝水');
    a.service.dispose();

    const b = makeService(filePath);
    b.setNow(T0 + 120_000 + 2 * 3_600_000); // 到点 2 小时后重启
    b.service.rearm();
    expect(b.pushed).toHaveLength(0);
    expect(b.service.listDue()).toHaveLength(0);
    expect(readFile(filePath).reminders[0].status).toBe('cancelled');
  });

  it('rearm 幂等(重复调用不重复调度/不重复补发)', () => {
    const filePath = tempFile();
    const { service, pushed } = makeService(filePath);
    service.register(createCmd('两分钟后叫我', T0), '两分钟后叫我');
    service.rearm();
    service.rearm();
    vi.advanceTimersByTime(120_000);
    expect(pushed).toHaveLength(1);
  });
});

// ============================================================================
// 容错 / 话术 / 开关
// ============================================================================

describe('存储容错与话术', () => {
  it('损坏文件按空处理,注册照常(并覆盖为合法 JSON)', () => {
    const filePath = tempFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not-json{{{', 'utf-8');
    const { service } = makeService(filePath);
    const res = service.register(createCmd('两分钟后叫我', T0), '两分钟后叫我');
    expect(res.ok).toBe(true);
    expect(readFile(filePath).reminders).toHaveLength(1);
  });

  it('字段不正的记录被丢弃(不让服务带病运行)', () => {
    const filePath = tempFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        reminders: [
          { id: 'ok', itemText: 'x', sourceText: 's', createdAt: 1, fireAt: 2, status: 'pending' },
          { id: 42, status: 'weird' },
          null,
        ],
      }),
      'utf-8',
    );
    const { service } = makeService(filePath);
    expect(service.listActive()).toHaveLength(1);
  });

  it('formatReminderDelayText:秒/分钟/小时/已到点', () => {
    expect(formatReminderDelayText(30_000)).toBe('30 秒');
    expect(formatReminderDelayText(5 * 60_000)).toBe('5 分钟');
    expect(formatReminderDelayText(2 * 3_600_000)).toBe('2 小时');
    expect(formatReminderDelayText(90 * 60_000)).toBe('1.5 小时');
    expect(formatReminderDelayText(-1)).toBe('已到点');
  });

  it('buildReminderListSay:空/多条的编号与时长口径', () => {
    expect(buildReminderListSay([], T0)).toBe('现在没有挂着的提醒。');
    const rows = [
      { id: 'a', itemText: '喝水', sourceText: '', createdAt: T0, fireAt: T0 + 5 * 60_000, status: 'pending' as const },
      { id: 'b', itemText: '', sourceText: '', createdAt: T0, fireAt: T0 - 1, status: 'due' as const },
    ];
    expect(buildReminderListSay(rows, T0)).toBe('有 2 条:1)5 分钟后提醒你喝水;2)已到点。');
  });

  it('toDuePayload / buildReminderCapSay', () => {
    const payload = toDuePayload({
      id: 'r1',
      itemText: '',
      sourceText: '',
      createdAt: 0,
      fireAt: 10,
      status: 'due',
    });
    expect(payload).toEqual({ id: 'r1', itemText: '', fireAt: 10, say: '老大,到点了。' });
    expect(buildReminderCapSay()).toContain(String(REMINDER_MAX_PENDING));
  });

  it('开关:TC_VOICE_REMINDER=0 关,其余开着', () => {
    const original = process.env.TC_VOICE_REMINDER;
    try {
      process.env.TC_VOICE_REMINDER = '0';
      expect(isVoiceReminderEnabled()).toBe(false);
      delete process.env.TC_VOICE_REMINDER;
      expect(isVoiceReminderEnabled()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TC_VOICE_REMINDER;
      else process.env.TC_VOICE_REMINDER = original;
    }
  });
});
