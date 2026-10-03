"""piper.exe 兼容垫片:把 piper CLI 调用转发给 edge-tts 常驻服务。

调用约定(tts.ts 同款):
  piper.exe --model <voices_dir>/<voice>.onnx --output_file <out.wav>
  文本从 stdin 读入;成功时 <out.wav> 为 16-bit PCM WAV。

链路:shim → HTTP 127.0.0.1:17129/synth(常驻服务,不在则自动拉起)。
任何失败(服务起不来、断网、接口失效)→ 回退同目录 piper_real.exe(原版 piper),
最坏 = 原来的机器音,绝不更差。日志:tools/edge-tts/shim.log
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent            # tools/edge-tts/shim
TOOL_DIR = HERE.parent                            # tools/edge-tts
SERVER_PY = TOOL_DIR / "server.py"
PORT = int(os.environ.get("EDGE_TTS_PORT", "17129"))
BASE_URL = os.environ.get("EDGE_TTS_URL", "http://127.0.0.1:" + str(PORT))
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"


def log(msg):
    try:
        with open(TOOL_DIR / "shim.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


def parse_args(argv):
    """只关心 --model 与 --output_file,其余参数透传给回退路径。"""
    model = out = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--model", "-m") and i + 1 < len(argv):
            model = argv[i + 1]
            i += 2
            continue
        if a in ("--output_file", "-f") and i + 1 < len(argv):
            out = argv[i + 1]
            i += 2
            continue
        i += 1
    return model, out


def pick_voice(model):
    """由模型文件名(如 zh_CN-huayan-medium.onnx)的语言前缀查 voices.json。"""
    try:
        cfg = json.loads((TOOL_DIR / "voices.json").read_text(encoding="utf-8"))
    except Exception:
        cfg = {}
    lang = "zh"
    if model:
        stem = Path(model).name
        if "_" in stem:
            lang = stem.split("_", 1)[0].lower()
    return cfg.get(lang) or cfg.get("zh") or DEFAULT_VOICE


def health(timeout=0.5):
    """本机对未监听端口的连接是超时(非秒拒),超时必须压小,否则拖慢回退。"""
    try:
        with urllib.request.urlopen(BASE_URL + "/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def start_service():
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [sys.executable, str(SERVER_PY)],
        cwd=str(TOOL_DIR),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
        close_fds=True,
    )


def ensure_service():
    if health():
        return True
    start_service()
    for _ in range(8):
        time.sleep(0.4)
        if health():
            return True
    return False


def synth(text, voice):
    body = json.dumps({"text": text, "voice": voice}).encode("utf-8")
    req = urllib.request.Request(
        BASE_URL + "/synth", data=body,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def fallback(argv, text):
    real = Path(sys.argv[0]).resolve().parent / "piper_real.exe"
    if not real.exists():
        log("fallback: piper_real.exe 不存在,放弃")
        return 127
    log("fallback -> " + str(real))
    try:
        p = subprocess.run([str(real)] + argv, input=text.encode("utf-8"))
        return p.returncode
    except Exception as e:
        log("fallback 执行失败:" + repr(e))
        return 126


def main():
    argv = sys.argv[1:]
    model, out = parse_args(argv)
    text = sys.stdin.buffer.read().decode("utf-8", "replace").strip()
    if not out or not text:
        log("参数不足: model=%s out=%s text_len=%d" % (model, out, len(text)))
        return fallback(argv, text) if text else 1
    try:
        if not ensure_service():
            raise RuntimeError("service 无法启动")
        voice = pick_voice(model)
        wav = synth(text, voice)
        if len(wav) < 100:
            raise RuntimeError("返回音频异常(%d 字节)" % len(wav))
        Path(out).write_bytes(wav)
        log("ok %dB voice=%s text=%r" % (len(wav), voice, text[:30]))
        return 0
    except Exception as e:
        log("synth 失败(%s: %s),回退 piper" % (e.__class__.__name__, e))
        return fallback(argv, text)


if __name__ == "__main__":
    sys.exit(main())
