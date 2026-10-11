# tools/ttyd-tmux — FleetDeck 的 Windows 终端工具集

让 FleetDeck 的**建筑终端 / 区域终端 / agent(Classic TUI)终端**在 Windows 上跑起来:
ttyd 把终端暴露成网页,tmux(arndawg 移植版)负责会话持久化。
本目录把用到的二进制、包装器源码和配套脚本收拢到一处,方便重建与排障。

> 本机现状(2026-10):`E:\nodejs` 在用户 PATH 中,`bin/` 里的工具同步到那里;
> ttyd 1.7.7 与 winget 包 `tsl0922.ttyd` 的 exe 逐字节一致(md5 `416d1df2…`),
> tmux 与 winget 包 `arndawg.tmux-windows` 的 tmux.exe 逐字节一致(md5 `609eabe7…`)。

## 目录结构

```
tools/ttyd-tmux/
  bin/                # 二进制(gitignored,不入库)
    ttyd.exe          # ttyd 1.7.7(与 winget tsl0922.ttyd 相同)
    tmux_real.exe     # arndawg tmux-windows 3.6a-win32.7 原生 tmux(与 winget 包相同)
    tmux.exe          # ⚠ 不是 tmux!是本目录包装器,由 build.mjs 编译生成
    which.cmd         # 给 TC 的 `which <cmd>` 探测用的 shim
  tmux-wrapper.cs     # 包装器源码(C# 5,零依赖)
  build.mjs           # 用系统 csc.exe 编译 → bin/tmux.exe
  install.mjs         # 把 bin/ 里的文件同步到 PATH 目录(默认 E:\nodejs)
  smoke.mjs           # 冒烟测试:验证三大修复 + claude 解析
```

## 为什么需要 tmux.exe 包装器

arndawg 的 Windows 移植版有三个实机验证过的硬伤,直接导致 TC 终端不可用:

1. `new-session -c <绝对路径>` 一律 "create window failed: spawn failed"(只有 `/`、`.`、`""` 可用)。
   包装器改写:`-c .` + 追加命令 `cmd /k cd /d <目标>`(实测 pane 工作目录正确)。
2. 裸 `sh`/`bash` 在 tmux server 环境里解析不到(spawn failed);`-e` 无法影响程序查找(用的是 server 自身 PATH)。
   包装器改写:把 `-- sh|bash` 解析为 Git 的 sh.exe 全路径。
3. `--` 之后的 argv 会被用裸空格拼成一条命令行再解析:含空格的长命令(`sh -c '<整条命令>'`)被拆散、pane 秒退。
   包装器改写:多参数先折叠成单个"预引号字符串",让裸拼接还原正确边界。

附加能力:

- 把发给真 tmux 的**进程环境里的 `SHELL` 固定为 `cmd.exe`**(该移植版用它决定 default-shell):
  server 若从 bash 环境启动(bash 导出 `SHELL`),default-shell 就变成 bash,于是 `-- 命令` 的
  引号/反斜杠语义整体翻转 —— 实测所有折叠参数一律 126/file-not-found 秒退,`-c` 重写的
  `cmd /k cd /d` 也失效;固定后无论 server 从 cmd 还是 bash 环境启动,行为都一致(2026-10-03 排查所得);
- 给 `new-session` 注入 `-e PATH=<合并PATH>`(`.local\bin` / bin 自身 / `E:\nodejs` / Git / winget 目录…),
  让 pane 里的 `sh -c` 等能解析到 Unix 工具;
- 把 `-- claude ...` 的首个 token 解析为绝对路径(优先 `%USERPROFILE%\.local\bin\claude.exe`),
  不依赖 tmux server(可能是旧环境)的 PATH —— agent Classic TUI 起不来的根因之一;
- 寻找真 tmux 的顺序:同目录 `tmux_real.exe` → winget 包目录 → `E:\nodejs\tmux_real.exe` → PATH 扫描(排除自身)。

## 构建 / 安装 / 验证

```bash
node tools/ttyd-tmux/build.mjs     # 编译包装器 → bin/tmux.exe(需要 .NET Framework 4.x 的 csc.exe)
node tools/ttyd-tmux/install.mjs   # 同步 bin/ → E:\nodejs(已在用户 PATH;可传目标目录覆盖)
node tools/ttyd-tmux/smoke.mjs     # 冒烟测试(需要 bin/ 或系统里能找到真 tmux)
```

## 运行前提(重要)

- `E:\nodejs`(或 `bin/`)必须在 PATH 里,TC 进程与 tmux server 才能解析到 `ttyd` / `tmux` / `which`;
- `%USERPROFILE%\.local\bin` 需在 PATH 里,`claude`(原生 exe)才可被解析
  —— TC 里 voice assistant 等直接 `spawn('claude')` 的路径靠它;
- TC 的 `commandExists()` 实际执行 Unix 风格的 `which <cmd>`:Windows 没有 which,由 `which.cmd` 顶上,
  所以 which.cmd 必须能被解析到(PATH=E:\nodejs,或 cwd=仓库根)。

## 从零重建(换机/重装系统)

1. `winget install tsl0922.ttyd arndawg.tmux-windows`;
2. 把 winget 包目录里的 `ttyd.exe` 复制进 `bin/`;把 `tmux.exe` 复制进 `bin/` 并改名 `tmux_real.exe`;
3. 写一个 `which.cmd`(内容:`where %1 >nul 2>&1` 形态的探测 shim,exit 0/1);
4. `node build.mjs && node install.mjs && node smoke.mjs`。

## 备注

- 二进制不入库(gitignore `bin/`);`tmux.exe` 是包装器源码的产物,不要把它当 tmux 备份。
- tmux 移植版升级后请重跑 `smoke.mjs`:三个坑可能被上游修掉,也可能变样,包装器要跟着调。
