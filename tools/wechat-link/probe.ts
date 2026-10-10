/**
 * iLink 语义探测矩阵 —— 把"文档推测"变成"实测结论"，结果进 probe-log.jsonl。
 *
 * 用法：
 *   npx tsx tools/wechat-link/probe.ts p1 [--to <userId>]     无 context_token 主动发送？(看手机)
 *   npx tsx tools/wechat-link/probe.ts p2                     伪造 context_token 的错误码
 *   npx tsx tools/wechat-link/probe.ts p3                     同一 context_token 连用两次
 *   npx tsx tools/wechat-link/probe.ts p4                     固定 X-WECHAT-UIN 发一条
 *   npx tsx tools/wechat-link/probe.ts p5 --yes               连发 10 条（会真发 10 条到手机号！）
 *   npx tsx tools/wechat-link/probe.ts p7                     语音转写字段（被动观测说明）
 *   npx tsx tools/wechat-link/probe.ts --long-run             24h 观测（轮询 + 30min 心跳，Ctrl+C 停）
 *
 * p1/p2/p3/p4 的目标默认取 .state.json 的 lastInbound（先跑 listen.ts 收一条消息）；
 * 也可 --to/--context 显式指定。
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUpdates, parseMessage, sendText, sleep } from './ilink';
import { loadState, requireLogin, saveState } from './state';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE_LOG = path.join(DIR, 'probe-log.jsonl');

function log(probe: string, verdict: string, detail?: unknown): void {
  const entry = { ts: new Date().toISOString(), probe, verdict, detail };
  appendFileSync(PROBE_LOG, `${JSON.stringify(entry)}\n`);
  console.log(`[${verdict}] ${probe}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}

function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const state = requireLogin();
const target = flagValue('--to') ?? state.lastInbound?.userId;
const contextToken = flagValue('--context') ?? state.lastInbound?.contextToken;

async function main(): Promise<void> {
  const probe = args[0];

  if (probe === '--long-run') {
    await longRun();
    return;
  }

  if (probe === 'p1') {
    if (!target) return needTarget();
    console.log('p1：不带 context_token 主动发送，注意看手机是否收到（以及延迟多久）。');
    const res = await sendText({
      baseUrl: state.baseUrl,
      botToken: state.botToken,
      toUserId: target,
      text: `[probe-p1] 主动消息 ${stamp()}`,
    });
    log('p1 主动发送(无ctx)', res.ret === 0 ? `ret=0 → 待手机确认是否真收到` : `FAIL ret=${res.ret} ${res.errmsg ?? ''}`, res.raw);
    return;
  }

  if (probe === 'p2') {
    if (!target) return needTarget();
    console.log('p2：用伪造的 context_token 发送，记录错误码。');
    const res = await sendText({
      baseUrl: state.baseUrl,
      botToken: state.botToken,
      toUserId: target,
      text: `[probe-p2] 伪造 ctx ${stamp()}`,
      contextToken: 'invalid-context-token-probe',
    });
    log('p2 伪造ctx', `ret=${res.ret} ${res.errmsg ?? ''}`, res.raw);
    return;
  }

  if (probe === 'p3') {
    if (!target) return needTarget();
    if (!contextToken) return needContext();
    console.log('p3：同一 context_token 连用两次（间隔 1.2s）。');
    const first = await sendText({
      baseUrl: state.baseUrl,
      botToken: state.botToken,
      toUserId: target,
      text: `[probe-p3] 复用 1/2 ${stamp()}`,
      contextToken,
    });
    await sleep(1200);
    const second = await sendText({
      baseUrl: state.baseUrl,
      botToken: state.botToken,
      toUserId: target,
      text: `[probe-p3] 复用 2/2 ${stamp()}`,
      contextToken,
    });
    log('p3 ctx复用', `first=${first.ret} second=${second.ret}`, { first: first.raw, second: second.raw });
    return;
  }

  if (probe === 'p4') {
    if (!target) return needTarget();
    console.log('p4：固定 X-WECHAT-UIN 发送一条（默认每次随机；服务端是否因此拒绝）。');
    const fixedUin = Buffer.from('12345', 'utf8').toString('base64');
    const res = await sendText({
      baseUrl: state.baseUrl,
      botToken: state.botToken,
      toUserId: target,
      text: `[probe-p4] 固定 UIN ${stamp()}`,
      contextToken,
      uin: fixedUin,
    });
    log('p4 固定UIN', `ret=${res.ret} ${res.errmsg ?? ''}`, res.raw);
    return;
  }

  if (probe === 'p5') {
    if (!target) return needTarget();
    if (!args.includes('--yes')) {
      console.log('p5 会连续发送 10 条消息到该会话（手机上可见）。确认请加 --yes 重跑。');
      return;
    }
    console.log('p5：连发 10 条（间隔 200ms），记录每条 ret —— 观察限流表现。');
    const results: Array<{ n: number; ret: number; errmsg?: string }> = [];
    for (let n = 1; n <= 10; n += 1) {
      const res = await sendText({
        baseUrl: state.baseUrl,
        botToken: state.botToken,
        toUserId: target,
        text: `[probe-p5] ${n}/10 ${stamp()}`,
        contextToken,
      });
      results.push({ n, ret: res.ret, errmsg: res.errmsg });
      console.log(`   ${n}/10 ret=${res.ret} ${res.errmsg ?? ''}`);
      await sleep(200);
    }
    log('p5 连发10条', `rets=${results.map((r) => r.ret).join(',')}`, results);
    return;
  }

  if (probe === 'p7') {
    console.log('p7 语音转写字段：被动观测项。');
    console.log('  手机给 bot 发一条语音 → 跑 listen.ts 看打印的原始 JSON →');
    console.log('  把 voice_item 里转写文本的真实字段名回填 README 结论表。');
    return;
  }

  usage();
}

function needTarget(): void {
  console.log('缺少目标 userId：先跑 listen.ts 收到一条消息（会记入 .state.json），或加 --to <userId>。');
}

function needContext(): void {
  console.log('缺少 context_token：先跑 listen.ts 收到一条消息，或加 --context <token>。');
}

function usage(): void {
  console.log('用法：npx tsx tools/wechat-link/probe.ts p1|p2|p3|p4|p5 --yes|p7|--long-run');
}

// ---------------------------------------------------------------------------
// p6：长跑观测（24h）——持续轮询记录 ret 变化 + 每 30 分钟心跳发送
// ---------------------------------------------------------------------------

async function longRun(): Promise<void> {
  let cursor = loadState().cursor ?? '';
  let lastHeartbeat = 0;
  console.log('p6 长跑观测启动：持续轮询（每轮记 probe-log.jsonl）+ 每 30 分钟心跳发送。');
  console.log('   建议挂满 24h 以上，观察：getupdates 何时开始报错、心跳何时开始失败（重认证触发条件）。');
  for (;;) {
    try {
      const round = await getUpdates({ baseUrl: state.baseUrl, botToken: state.botToken, cursor, timeoutMs: 45_000 });
      log('p6-poll', `ret=${round.ret} msgs=${round.msgs.length}`, round.ret !== 0 ? round.raw : undefined);
      if (round.ret === 0 && round.cursor) {
        cursor = round.cursor;
        saveState({ cursor });
      }
      for (const msg of round.msgs) {
        const parsed = parseMessage(msg);
        if (parsed.fromUserId && !parsed.fromUserId.endsWith('@im.bot') && parsed.messageType !== 2) {
          saveState({
            lastInbound: {
              userId: parsed.fromUserId,
              contextToken: parsed.contextToken,
              text: parsed.text || parsed.voiceText,
              at: Date.now(),
            },
          });
        }
      }
    } catch (error) {
      log('p6-poll', `EXC ${(error as Error).message}`);
      await sleep(15_000);
    }
    if (Date.now() - lastHeartbeat > 30 * 60_000) {
      lastHeartbeat = Date.now();
      const lastInbound = loadState().lastInbound;
      if (lastInbound?.userId) {
        const res = await sendText({
          baseUrl: state.baseUrl,
          botToken: state.botToken,
          toUserId: lastInbound.userId,
          text: `[probe-p6] 心跳 ${stamp()}`,
          contextToken: lastInbound.contextToken,
        });
        log('p6-heartbeat', `ret=${res.ret} ${res.errmsg ?? ''}`, res.raw);
      } else {
        log('p6-heartbeat', 'SKIP（还没有 lastInbound，先让手机发一条）');
      }
    }
  }
}

void main().catch((error) => {
  console.error('探测失败：', error);
  process.exit(1);
});
