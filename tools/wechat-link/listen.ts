/**
 * 微信 ClawBot 长轮询收信 + 回显。
 *
 * 用法：npx tsx tools/wechat-link/listen.ts [--reply] [--timeout 45000]
 *   --reply  每条入站消息用其 context_token 原路回 "echo: <文本>"
 * 每条消息打印完整原始 JSON（S0 的核心产出），并存 msgs.jsonl（gitignored）。
 * 游标先落盘再处理消息 —— 中途崩溃不重放。
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUpdates, parseMessage, sendText, sleep } from './ilink';
import { requireLogin, saveState } from './state';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MSGS_PATH = path.join(DIR, 'msgs.jsonl');

const args = process.argv.slice(2);
const replyMode = args.includes('--reply');
const timeoutIndex = args.indexOf('--timeout');
const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 45_000;

const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];

const state = requireLogin();
let cursor = state.cursor ?? '';
let consecutiveErrors = 0;
let stopping = false;

process.on('SIGINT', () => {
  stopping = true;
  console.log('\n已停止（Ctrl+C）。游标已保存在 .state.json，重跑不丢消息。');
  process.exit(0);
});

console.log(`长轮询：${state.baseUrl}（${replyMode ? '回显模式' : '只读模式'}，Ctrl+C 停止）`);

async function main(): Promise<void> {
  while (!stopping) {
    try {
      const round = await getUpdates({
        baseUrl: state.baseUrl,
        botToken: state.botToken,
        cursor,
        timeoutMs,
      });
      console.log(
        `-- ${round.elapsedMs}ms ret=${round.ret} msgs=${round.msgs.length} ` +
          `cursor=${round.cursor ? `${round.cursor.slice(0, 12)}…` : '(无)'}`,
      );
      if (round.ret !== 0) {
        consecutiveErrors += 1;
        console.log(`   errmsg=${round.errmsg ?? '(空)'} 原始=${JSON.stringify(round.raw).slice(0, 400)}`);
        await sleep(BACKOFF_MS[Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1)]);
        continue;
      }
      consecutiveErrors = 0;
      if (round.cursor) {
        cursor = round.cursor;
        saveState({ cursor }); // 先落盘游标，再处理消息
      }
      for (const msg of round.msgs) {
        appendFileSync(MSGS_PATH, `${JSON.stringify(msg)}\n`);
        const parsed = parseMessage(msg);
        console.log('──── 原始消息 ────');
        console.log(JSON.stringify(msg, null, 2));
        console.log(
          `>> from=${parsed.fromUserId ?? '?'} type=${parsed.messageType ?? '?'} ` +
            `items=[${parsed.itemTypes.join(',')}] ctx=${parsed.contextToken ? '有' : '无'} ` +
            `text=${JSON.stringify(parsed.text || parsed.voiceText)}`,
        );
        const isInboundUser =
          !!parsed.fromUserId && !parsed.fromUserId.endsWith('@im.bot') && parsed.messageType !== 2;
        if (isInboundUser) {
          saveState({
            lastInbound: {
              userId: parsed.fromUserId as string,
              contextToken: parsed.contextToken,
              text: parsed.text || parsed.voiceText,
              at: Date.now(),
            },
          });
          const body = parsed.text || parsed.voiceText;
          if (replyMode && body) {
            const res = await sendText({
              baseUrl: state.baseUrl,
              botToken: state.botToken,
              toUserId: parsed.fromUserId as string,
              text: `echo: ${body}`,
              contextToken: parsed.contextToken,
            });
            console.log(`<< 回显 ret=${res.ret} ${res.errmsg ?? ''} raw=${JSON.stringify(res.raw).slice(0, 300)}`);
          }
        }
      }
    } catch (error) {
      if (stopping) break;
      consecutiveErrors += 1;
      console.log(`轮询异常：${(error as Error).message}`);
      await sleep(BACKOFF_MS[Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1)]);
    }
  }
}

void main().catch((error) => {
  console.error('收信失败：', error);
  process.exit(1);
});
