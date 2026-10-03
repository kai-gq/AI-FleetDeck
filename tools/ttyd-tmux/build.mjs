#!/usr/bin/env node
// 编译 tmux-wrapper.cs → bin/tmux.exe(系统 .NET Framework 的 csc.exe,不需要 SDK)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const cscCandidates = [
  'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
];
const csc = cscCandidates.find((p) => fs.existsSync(p));
if (!csc) {
  console.error('找不到 csc.exe(需要 .NET Framework 4.x,Windows 一般自带)');
  process.exit(1);
}

fs.mkdirSync(path.join(here, 'bin'), { recursive: true });
console.log('csc  = ' + csc);

// 注意:cwd = 本目录 + 相对文件名。直接把绝对路径交给 csc 时,MSYS/盘符会引发解析怪癖。
execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/out:bin/tmux.exe', 'tmux-wrapper.cs'], {
  cwd: here,
  stdio: 'inherit',
});

const outFile = path.join(here, 'bin', 'tmux.exe');
const st = fs.statSync(outFile);
console.log('OK   -> bin/tmux.exe  (' + st.size + ' bytes)');
