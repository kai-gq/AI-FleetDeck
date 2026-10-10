/**
 * 微信 ClawBot 扫码登录。
 *
 * 用法：npx tsx tools/wechat-link/login.ts [--html qr.html] [--base <url>] [--dump]
 * 流程：get_bot_qrcode → 终端 ASCII 二维码 → 2.5s 轮询 get_qrcode_status
 *       → confirmed 后把 bot_token/baseurl 写入 .state.json（token 只脱敏打印）。
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_BASE, getBotQrcode, getQrcodeStatus, maskToken, pickString, sleep } from './ilink';
import { saveState } from './state';
import qrcode from '../../src/packages/client/vendor/qrcode/qrcode';
import { buildQrPath } from '../../src/packages/client/utils/wechatQr'; // 附带 UTF-8 stringToBytes 覆盖

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const baseUrl = flagValue('--base') ?? DEFAULT_BASE;
const htmlPath = flagValue('--html');
const dump = args.includes('--dump');

// 腾讯 status 的真实拼写由 S0 定案；此处集中一处，实测后收紧。
const CONFIRMED = new Set(['confirmed', 'confirm', 'success', 'logged_in', 'bound']);
const DEAD = new Set(['expired', 'expire', 'canceled', 'cancelled', 'invalid', 'timeout']);

function printAscii(content: string): void {
  const qr = qrcode(0, 'M');
  qr.addData(content, 'Byte');
  qr.make();
  console.log(qr.createASCII(2, 3));
}

function writeHtml(content: string, file: string): void {
  const { path: d, size } = buildQrPath(content);
  const html = `<!doctype html>
<meta charset="utf-8">
<title>微信 ClawBot 扫码</title>
<body style="background:#fff;margin:0;display:flex;flex-direction:column;align-items:center;padding:40px;font-family:sans-serif">
<svg width="400" height="400" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="#ffffff"/>
<path d="${d}" fill="#111111" shape-rendering="crispEdges"/>
</svg>
<p style="color:#333">手机微信 → 我 → 设置 → 插件 → ClawBot → 扫这个码</p>
</body>`;
  writeFileSync(file, html);
  console.log(`已写入 ${file}（浏览器打开可扫）`);
}

async function main(): Promise<void> {
  console.log(`请求二维码中…（${baseUrl}）`);
  const qr = await getBotQrcode(baseUrl);
  if (!qr.qrcode || !qr.imgContent) {
    console.error('取码失败，原始响应：');
    console.error(JSON.stringify(qr.raw, null, 2));
    process.exit(1);
  }
  console.log(`qrcode(session): ${qr.qrcode}`);
  console.log(`扫码内容: ${qr.imgContent}`);
  console.log('');
  printAscii(qr.imgContent);
  console.log('手机微信 → 我 → 设置 → 插件 → ClawBot → 扫上面这个码');
  console.log('（终端配色不同二维码可能反色扫不动 —— 扫不动就加 --html qr.html 用浏览器打开再扫）');
  if (htmlPath) writeHtml(qr.imgContent, htmlPath);

  const startedAt = Date.now();
  const deadline = startedAt + 120_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(2500);
    let status;
    try {
      status = await getQrcodeStatus(qr.qrcode, baseUrl);
    } catch (error) {
      console.log(`轮询异常（继续）：${(error as Error).message}`);
      continue;
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (status.status !== lastStatus || dump) {
      console.log(`[${elapsed}s] status=${status.status || '(空)'} ret=${status.ret ?? '-'}`);
      if (!status.status || dump) console.log('  原始响应：', JSON.stringify(status.raw));
      lastStatus = status.status;
    }
    if (CONFIRMED.has(status.status)) {
      if (!status.botToken) {
        console.error('confirmed 但响应无 bot_token，原始响应：');
        console.error(JSON.stringify(status.raw, null, 2));
        process.exit(1);
      }
      const botUserId = status.botUserId ?? pickString(status.raw, ['bot_user_id', 'botUserId']);
      saveState({
        botToken: status.botToken,
        baseUrl: status.baseUrl ?? baseUrl,
        botUserId,
        loginAt: Date.now(),
      });
      console.log('');
      console.log('✅ 登录成功，已写入 .state.json');
      console.log(`bot_token: ${maskToken(status.botToken)}`);
      console.log(`baseurl: ${status.baseUrl ?? `(未返回，继续用 ${baseUrl})`}`);
      console.log(`botUserId: ${botUserId ?? '(响应未带，观察 getupdates 里的消息来确认)'}`);
      console.log('下一步：npx tsx tools/wechat-link/listen.ts --reply');
      return;
    }
    if (DEAD.has(status.status)) {
      console.log('二维码已失效，请重跑本脚本。');
      return;
    }
  }
  console.log('120s 超时未确认，请重跑本脚本。');
}

void main().catch((error) => {
  console.error('登录失败：', error);
  process.exit(1);
});
