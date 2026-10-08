/**
 * 声纹链路探针 —— 用本地 wav 走真实 SAUC 链路,实锤「声纹判定」的真实响应形态。
 *
 * 用法(仓库根目录):
 *   npx tsx tools/voiceprint/probe.ts --file tools/voiceprint/samples/x.wav
 *
 * 行为:读 tools/voice-companion/config.json 凭据(绝不打屏)+ voiceprint.local.json
 * (TC_VOICE_VOICEPRINT_SOURCE 可覆盖)→ 16k 单声道 wav 以 10 倍速灌入真实端点 →
 * 打印全部 onLog(含「声纹判定 … speaker_id=[…]」观测行)与终稿 meta。
 *
 * 用途:注册完声纹先跑一遍 —— 确认 1) 请求字段被服务端接受(不报参数错);
 * 2) speaker_id 是否附加、匹配成功时长什么样。不依赖人对着麦克风说话。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VolcengineAsrSession } from '../../src/packages/server/voice/volcengine-asr-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_FILE = path.join(ROOT, 'tools', 'voice-companion', 'config.json');

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { file: string } {
  let file = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') {
      file = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法:npx tsx tools/voiceprint/probe.ts --file <16k 单声道 wav>');
      process.exit(0);
    }
  }
  if (!file) fail('缺 --file;用法:npx tsx tools/voiceprint/probe.ts --file <wav>');
  return { file: path.resolve(file) };
}

interface WavPcm {
  pcm: Buffer;
  seconds: number;
}

/** 解析 16k/单声道/16bit wav 的 PCM 数据(其余规格直接拒绝并提示先转码)。 */
function readWav16k(wavPath: string): WavPcm {
  const buf = fs.readFileSync(wavPath);
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') fail(`${wavPath} 不是 WAV 文件`);
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    off += 8 + size + (size % 2);
  }
  if (!data) fail('WAV 里没有 data 块');
  if (sampleRate !== 16000 || channels !== 1 || bits !== 16) {
    fail(`规格不符(rate=${sampleRate} ch=${channels} bits=${bits});先用 enroll.mjs --file 转成 16k 单声道再探`);
  }
  return { pcm: data, seconds: data.length / 32000 };
}

async function main(): Promise<void> {
  const { file } = parseArgs(process.argv.slice(2));
  const { pcm, seconds } = readWav16k(file);

  let cfg: { stt?: { volcengine?: Record<string, unknown> } } = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    fail(`读取 config.json 失败:${(err as Error).message}`);
  }
  const volc = cfg.stt?.volcengine ?? {};
  const credentials = {
    apiKey: String(volc.apiKey ?? ''),
    appId: String(volc.appId ?? ''),
    accessToken: String(volc.accessToken ?? ''),
    resourceId: String(volc.resourceId ?? 'volc.bigasr.sauc.duration'),
    endpoint: (volc.endpoint ?? 'bigmodel_async') as 'bigmodel_async' | 'bigmodel' | 'bigmodel_nostream',
  };
  if (!credentials.apiKey) fail('config.json 的 stt.volcengine.apiKey 为空');

  // 探针不注入热词(隔离变量);外部显式覆盖则尊重
  if (!process.env.TC_VOICE_HOTWORDS_SOURCE) {
    process.env.TC_VOICE_HOTWORDS_SOURCE = path.join(ROOT, 'tools', 'voiceprint', 'no-hotwords.json');
  }

  console.log(`● 探针:${path.relative(ROOT, file)}(${seconds.toFixed(1)}s)→ ${credentials.endpoint}`);
  console.log(`  端点资源:${credentials.resourceId}`);

  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const session = new VolcengineAsrSession({
      credentials,
      uid: 'voiceprint-probe',
      onLog: (line) => console.log(`  [asr] ${line}`),
      onPartial: () => {},
      onFinal: (text, meta) => {
        console.log(`  [asr] 终稿(${((Date.now() - started) / 1000).toFixed(1)}s):「${text}」`);
        console.log(`  [asr] meta:${meta ? JSON.stringify(meta) : '(无 —— 门禁未启用/端点不支持/判定 unknown)'}`);
        resolve();
      },
      onError: (err) => reject(err),
    });

    // 10 倍速灌入(100ms 音频 / 10ms 实时),末包收尾
    const CHUNK = 3200;
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= pcm.length) {
        clearInterval(timer);
        session.finish();
        return;
      }
      session.sendAudio(pcm.subarray(offset, Math.min(offset + CHUNK, pcm.length)));
      offset += CHUNK;
    }, 10);
  });
  console.log('✓ 探针完成');
}

main().catch((err) => fail((err as Error)?.stack || String(err)));
