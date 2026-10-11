#!/usr/bin/env bash
# 生成本机局域网 HTTPS 证书(openssl),供手机在安全上下文里访问 Tide Commander。
#
# 为什么需要: iOS/Safari 只有在安全上下文(https 或 localhost)才允许麦克风,
# 手机以 http://<PC-IP>:… 打开时 window.isSecureContext=false,语音伙伴/语音输入
# 的麦克风采集会被浏览器拒绝(客户端代码会直接报「麦克风需要 HTTPS(或 localhost)环境」)。
#
# 产物(默认写到 ~/.tide-commander/certs/,与 cli.ts 的 TLS_DIR 一致):
#   rootCA.key / rootCA.crt               本机自签 CA(rootCA.key 私钥永不外发)
#   localhost-key.pem / localhost.pem     服务器证书(SAN: localhost/127.0.0.1 + 指定 IP)
# 并把 rootCA.crt 复制到 tools/lan-https/public/,供手机下载安装(serve-ca.cmd)。
#
# 用法:
#   bash tools/lan-https/gen-certs.sh                 # 自动探测本机 IPv4
#   bash tools/lan-https/gen-certs.sh 192.168.1.21    # 显式指定(可多个: IP 或主机名)
#
# 换 IP 后: 重跑本脚本(CA 不重新生成,手机无需重装 CA)——然后重启服务器窗口。
set -euo pipefail

# 文件路径统一用 C:/ 风格(cygpath -m): 关掉 MSYS 参数转换后,mingw 版 openssl 不认 /c/... 路径
CERT_DIR="$(cygpath -m "$HOME")/.tide-commander/certs"
HERE="$(cygpath -m "$(cd "$(dirname "$0")" && pwd)")"
PUBLIC_DIR="$HERE/public"

command -v openssl >/dev/null || { echo "缺少 openssl(Git for Windows 自带)"; exit 1; }
mkdir -p "$CERT_DIR" "$PUBLIC_DIR"

# Git-Bash(MSYS)会把 -subj "/CN=..." 当路径转成 D:/Git/CN=...,必须关掉参数转换
# (关掉后 openssl 的文件路径参数不再被自动换算,见上方 CERT_DIR 的 C:/ 风格)
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

HOSTS=("$@")
if [ ${#HOSTS[@]} -eq 0 ]; then
  ip="$(ipconfig | iconv -f GBK -t UTF-8 2>/dev/null | grep -i 'IPv4' | head -1 | sed 's/.*: *//' | tr -d ' \r')"
  [ -n "$ip" ] && HOSTS=("$ip")
fi

SAN="DNS:localhost,IP:127.0.0.1"
for h in "${HOSTS[@]}"; do
  case "$h" in
    *[!0-9.]*) SAN="$SAN,DNS:$h" ;;   # 含非数字/点 → 按主机名
    *)         SAN="$SAN,IP:$h" ;;    # 纯数字与点 → 按 IP
  esac
done

# CA 只在缺失时生成: 换 IP 重签叶证书时保持不变,手机上的信任无需重做
if [ ! -f "$CERT_DIR/rootCA.crt" ] || [ ! -f "$CERT_DIR/rootCA.key" ]; then
  echo "[gen] 生成 CA(10 年)..."
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$CERT_DIR/rootCA.key" -out "$CERT_DIR/rootCA.crt" \
    -subj "/CN=Tide Commander Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
else
  echo "[gen] 复用已有 CA: $CERT_DIR/rootCA.crt"
fi

echo "[gen] 生成服务器证书 SAN: $SAN"
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$CERT_DIR/localhost-key.pem" -out "$CERT_DIR/localhost.csr" \
  -subj "/CN=tide-commander-local"
cat > "$CERT_DIR/leaf.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EOF
# 397 天: 低于 iOS 对服务器证书的 398 天上限
openssl x509 -req -in "$CERT_DIR/localhost.csr" \
  -CA "$CERT_DIR/rootCA.crt" -CAkey "$CERT_DIR/rootCA.key" -CAcreateserial \
  -out "$CERT_DIR/localhost.pem" -days 397 -sha256 -extfile "$CERT_DIR/leaf.ext"
rm -f "$CERT_DIR/localhost.csr" "$CERT_DIR/leaf.ext"

cp -f "$CERT_DIR/rootCA.crt" "$PUBLIC_DIR/rootCA.crt"

echo
echo "完成。服务器证书: $CERT_DIR/localhost.pem"
echo "手机用 CA(仅公钥): tools/lan-https/public/rootCA.crt  → 用 serve-ca.cmd 起下载页"
