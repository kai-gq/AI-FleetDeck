#!/usr/bin/env node
// 把 bin/ 里的文件同步到目标目录(默认本机 PATH 中的 E:\nodejs)
// 处理“目标正被运行中进程占用”的情况:先改名让位(NTFS 允许),再写入
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, 'bin');
const target = process.argv[2] || 'E:\\nodejs';

if (!fs.existsSync(bin)) {
  console.error('bin/ 不存在 —— 先跑 build.mjs,并放入 ttyd.exe / tmux_real.exe / which.cmd');
  process.exit(1);
}
const files = fs.readdirSync(bin).filter((f) => !f.includes('.old-'));
if (!files.length) {
  console.error('bin/ 为空 —— 先跑 build.mjs(并放入 ttyd.exe / tmux_real.exe / which.cmd)');
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
let copied = 0;
for (const f of files) {
  const s = path.join(bin, f);
  const d = path.join(target, f);
  try {
    if (fs.existsSync(d) && fs.realpathSync(s) === fs.realpathSync(d)) {
      console.log('= ' + f + '  (与目标同一文件,跳过)');
      continue;
    }
  } catch { /* ignore */ }
  if (fs.existsSync(d)) {
    try {
      fs.renameSync(d, d + '.old-' + Date.now());
    } catch (e) {
      console.warn('! 无法移开旧文件 ' + f + ': ' + e.message);
    }
  }
  fs.copyFileSync(s, d);
  console.log('-> ' + f + '  =>  ' + target);
  copied++;
}

for (const f of fs.readdirSync(target)) {
  if (!f.includes('.old-')) continue;
  try {
    fs.unlinkSync(path.join(target, f));
    console.log('   清理 ' + f);
  } catch {
    console.warn('! 旧文件 ' + f + ' 仍被占用,重启相关进程后可手动删除');
  }
}
console.log('完成:' + copied + ' 个文件 → ' + target);
