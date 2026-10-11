@echo off
rem 仅供手机安装 CA 时使用: 8090 端口只暴露 tools\lan-https\public\(里面只有
rem rootCA.crt,不含任何私钥)。手机 Safari 打开 http://<PC-IP>:8090/rootCA.crt
rem 下载描述文件,安装并开启「完全信任」后即可访问 https://<PC-IP>:6201/#app
title TC 证书下载(:8090)
cd /d "%~dp0"
python -m http.server 8090 --directory public
pause
