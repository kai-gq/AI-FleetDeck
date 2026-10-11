# 手机 HTTPS(局域网)本地工具

**目的**: iPhone/iPad 在局域网上访问 Tide Commander 时,浏览器只在**安全上下文**
(https 或 localhost)里给麦克风。http://<PC-IP>:5173 下 `window.isSecureContext=false`,
语音伙伴与终端语音输入会被客户端直接拦下(`useContinuousListening.ts` /
`useSTT.ts` 内均有「麦克风需要 HTTPS」检查)——这个目录提供本地 CA + 服务器证书,
把后端**额外**开一个 HTTPS 监听(6200 的明文 http 保持原样,PC 和本地工具不受影响)。

服务器双监听由仓库原生支持(`HTTPS_PORT`,README.md §"You can also serve HTTP and
HTTPS from the same process";两个监听共享同一份 agents 与 WebSocket)。

## 一次性的四步

1. **生成证书**(任意 IP 变化后重跑;CA 保持不变,手机无需重装):
   ```bash
   bash tools/lan-https/gen-certs.sh            # 自动探测本机 IPv4
   bash tools/lan-https/gen-certs.sh 192.168.1.21   # 或显式指定
   ```
   产物在 `~/.tide-commander/certs/`(与 `cli.ts --install-local-cert` 的目录约定一致);
   `rootCA.crt` 副本导出到 `tools/lan-https/public/`(gitignored)。

2. **`.env` 加后端 TLS 三行**(项目根,gitignored):
   ```
   HTTPS_PORT=6201
   TLS_KEY_PATH=C:/Users/<你>/.tide-commander/certs/localhost-key.pem
   TLS_CERT_PATH=C:/Users/<你>/.tide-commander/certs/localhost.pem
   ```
   然后**重启服务器窗口**(env 只在启动时读一次;tsx watch 不会因 .env 变化重启)。
   验证:`curl -sk https://127.0.0.1:6201/api/health` → `{"status":"ok"}`。

3. **Windows 信任 CA**(PC 上 Chrome/Edge 走系统证书库,用于本机调试 https):
   ```cmd
   certutil -user -addstore -f ROOT %USERPROFILE%\.tide-commander\certs\rootCA.crt
   ```

4. **手机安装 CA**(iOS 一次性):
   1. 电脑上双击 `serve-ca.cmd`(8090 端口只暴露 public/,无私钥);
   2. 手机 **Safari**(必须 Safari,微信内置浏览器不行)打开
      `http://<PC-IP>:8090/rootCA.crt` → 「此网站正尝试下载一个配置描述文件」→ 允许;
   3. 设置 → 通用 → VPN 与设备管理 → 已下载描述文件 → 安装(输锁屏密码);
   4. 设置 → 通用 → 关于本机 → **证书信任设置** → 打开
      「Tide Commander Local CA」的完全信任;
   5. Safari 打开 `https://<PC-IP>:6201/#app`(不再有红色警告),首次点语音伙伴时允许麦克风。

## 使用与维护

- 手机书签:`https://<PC-IP>:6201/#app`(PC 上继续用 http://127.0.0.1:5173/#app,互不影响)。
- 6201 服务的是**构建产物 dist**——改完客户端代码要在项目根跑一次
  `npm run build` 手机才能看到(手机走的是生产路径,没有 HMR;想要手机热更新
  需另配 `DEV_HTTPS` 的 Vite,见 README §DEV_HTTPS)。
- **DHCP 换 IP**:重跑 `gen-certs.sh <新IP>` → 重启服务器窗口 → 手机改用新 IP
  (CA 不用重装;PC 若用 https 也自动信任,因为证书还是同一 CA 签的)。
- 安全:CA 私钥(`rootCA.key`)只在本机;`serve-ca.cmd` 只暴露公钥证书。
  局域网内拿到 rootCA.crt 的人并不能冒充本机签发新证书(没有 rootCA.key)。
