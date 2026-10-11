@echo off
rem ============================================================
rem  Tide Commander 启动 / 编译(仓库根目录快捷脚本,本地新增文件)
rem  双击 = 打开菜单;命令行可直达:
rem     启动编译.bat start   -> 启动开发模式
rem     启动编译.bat build   -> 编译生产包
rem  说明:聚合命令 npm run dev 内部调 bun(本机无 bun),故此处直接
rem       用本地 node_modules 的 vite + node 脚本拼起两个半边。
rem ============================================================
rem  文件编码:GBK(中文 Windows 控制台原生码页,勿转 UTF-8——cmd 解析会丢字节)
chcp 936 >nul 2>nul
title Tide Commander - 启动 / 编译
cd /d "%~dp0"

if /i "%~1"=="start" goto :start
if /i "%~1"=="build" goto :build

:menu
cls
echo ============================================================
echo   Tide Commander 启动 / 编译
echo   目录: %CD%
echo ============================================================
echo.
echo   [1] 启动开发模式    vite(5173) + 服务端(6200/6201),单窗口
echo   [2] 编译生产包      tsc 类型检查 + vite build + 服务端编译
echo   [3] 先编译再启动    编译成功后才启动
echo   [0] 退出
echo.
set "choice="
set /p choice=请输入编号并回车:
if "%choice%"=="1" goto :start
if "%choice%"=="2" goto :build
if "%choice%"=="3" goto :buildstart
if "%choice%"=="0" exit /b 0
goto :menu

:check_env
where node >nul 2>nul || (
  echo [错误] 未找到 node,请先安装 Node.js 并确认在 PATH 中。
  pause
  exit /b 1
)
if not exist "node_modules\.bin\vite.cmd" (
  echo [错误] 未找到 node_modules,请先安装依赖（bun install 或 npm install）。
  pause
  exit /b 1
)
exit /b 0

:port_hint
netstat -ano 2>nul | findstr /c:":6200 " | findstr /i "LISTENING" >nul 2>nul && (
  echo [提示] 端口 6200 已有进程在监听 —— 可能已有一个实例在运行,
  echo        继续启动可能端口冲突,建议先关掉旧实例。
  echo.
)
exit /b 0

:start
call :check_env || exit /b 1
call :port_hint
echo.
echo [启动] 开发模式 —— Ctrl+C 结束
echo        vite: http://localhost:5173   服务端: http://localhost:6200
echo        手机/局域网: .env 已设 LISTEN_ALL_INTERFACES,访问 https://本机IP:6201
echo.
call "node_modules\.bin\concurrently.cmd" --raw -k -n client,server "npm:dev:client" "npm:dev:server"
set "rc=%errorlevel%"
echo.
echo [退出] 开发模式已结束(concurrently 返回码 %rc%)。
pause
if /i "%~1"=="start" exit /b %rc%
goto :menu

:build
call :check_env || exit /b 1
echo.
echo [编译] npm run build —— 类型检查 + vite build + 服务端 tsc(约 1~3 分钟)
echo.
call npm run build
if errorlevel 1 (
  echo.
  echo [失败] 编译未通过,请查看上方日志。
  pause
  if /i "%~1"=="build" exit /b 1
  goto :menu
)
echo.
echo [完成] 编译成功 —— dist/ 已更新(桌面/手机页刷新即生效)。
pause
if /i "%~1"=="build" exit /b 0
goto :menu

:buildstart
call :check_env || exit /b 1
call :port_hint
echo.
echo [编译] 先编译生产包...
call npm run build
if errorlevel 1 (
  echo [失败] 编译未通过,不启动。
  pause
  goto :menu
)
echo [完成] 编译成功,继续启动...
echo.
call "node_modules\.bin\concurrently.cmd" --raw -k -n client,server "npm:dev:client" "npm:dev:server"
echo.
echo [退出] 开发模式已结束。
pause
goto :menu
