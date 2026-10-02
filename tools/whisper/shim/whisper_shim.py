#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
whisper CLI 转发 shim(本地 STT 加速用)

安装(见 tools/whisper/README.md):
    venv\\Scripts\\python.exe -m pip install -e tools/whisper/shim --no-deps

安装后本包提供的 console_script 会覆盖 venv/Scripts/whisper.exe。之后:

  应用 spawn `whisper <file> --model … --language … --output_format txt --output_dir …`
    → shim 把音频 POST 给常驻服务(server.py,模型常驻显存)
    → 服务返回文本 → shim 按 CLI 约定写出 <base>.txt → 退出码 0

原则:绝不比原版差 —— 参数形状不认识、服务拉不起来、任何一步出错,都在
同一进程内回退到真正的 whisper CLI(行为与原来完全逐字一致)。

自检:`whisper --shim-version` 打印 shim 版本(原版 CLI 不认识这个参数)。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from urllib.parse import quote

# 输出统一 UTF-8(被应用 spawn 时 Python 默认走系统 ANSI 代码页,中文会乱码)
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

SHIM_VERSION = "0.1.0"
PORT = 17128
BASE_URL = f"http://127.0.0.1:{PORT}"

_HERE = os.path.dirname(os.path.abspath(__file__))  # …/tools/whisper/shim
_STACK = os.path.dirname(_HERE)  # …/tools/whisper
SERVER_PY = os.path.join(_STACK, "server.py")
SERVER_LOG = os.path.join(_STACK, "server.log")

START_TIMEOUT = 180.0  # 冷启动等待上限:torch 导入 + 模型加载 + 预热
TRANS_TIMEOUT = 900.0  # 单次转写上限(秒)

# 认识的带值选项(快路径会用到 / 需跳过其值)
_FLAG_TO_OPT = {
    "--model": "model", "-m": "model",
    "--language": "language", "-l": "language",
    "--output_format": "output_format", "-f": "output_format",
    "--output_dir": "output_dir", "-o": "output_dir",
    "--task": "task", "-t": "task",
}
# 认识但快路径用不到的带值选项(跳过 flag + 值;值可能是布尔词)
_FLAG_SKIP = {
    "--verbose", "--fp16", "--device", "--threads", "--temperature",
    "--beam_size", "--best_of", "--patience", "--length_penalty",
    "--suppress_tokens", "--initial_prompt", "--condition_on_previous_text",
    "--compression_ratio_threshold", "--logprob_threshold",
    "--no_speech_threshold", "--word_timestamps",
}


def _err(msg: str) -> None:
    print(f"[whisper-shim] {msg}", file=sys.stderr, flush=True)


def parse_fast_path(argv):
    """只认形如 `<file> [--model x] [--language x] --output_format txt --output_dir d`
    的单文件转写;其余一律返回 None(交给原版 CLI,保证行为一致)。"""
    opts = {
        "model": None,
        "language": None,
        "output_format": "txt",
        "output_dir": ".",
        "task": None,
        "files": [],
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            return None
        if a in _FLAG_TO_OPT:
            if i + 1 >= len(argv):
                return None
            opts[_FLAG_TO_OPT[a]] = argv[i + 1]
            i += 2
            continue
        if a.startswith("--") and "=" in a:
            k, v = a.split("=", 1)
            if k in _FLAG_TO_OPT:
                opts[_FLAG_TO_OPT[k]] = v
                i += 1
                continue
            return None
        if a in _FLAG_SKIP:
            nxt = argv[i + 1] if i + 1 < len(argv) else None
            # 下一个 token 不以 '-' 开头就当它的值跳过(argparse 语义);
            # 跳错也只会让本形状不满足快路径条件 → 安全回退原版 CLI
            if nxt is not None and not nxt.startswith("-"):
                i += 2
            else:
                i += 1
            continue
        if a.startswith("-"):
            return None  # 不认识的选项:回退
        opts["files"].append(a)
        i += 1
    return opts


def health():
    try:
        with urllib.request.urlopen(BASE_URL + "/health", timeout=1.5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def start_server() -> None:
    log = open(SERVER_LOG, "ab")
    creationflags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"  # server.log 用 UTF-8,方便查看
    subprocess.Popen(
        [sys.executable, SERVER_PY],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        cwd=_STACK,
        creationflags=creationflags,
        close_fds=True,
        env=env,
    )


def ensure_server() -> bool:
    if health():
        return True
    _err("常驻服务未运行,正在拉起(首次需加载模型,约 10~20 秒)…")
    try:
        start_server()
    except Exception as e:
        _err(f"拉起失败:{e}")
        return False
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        h = health()
        if h:
            _err(f"服务就绪:{h}")
            return True
        time.sleep(0.5)
    _err(f"等待服务就绪超时({START_TIMEOUT:.0f}s)")
    return False


def transcribe(path: str, model: str, language: str) -> str:
    ext = os.path.splitext(path)[1].lstrip(".") or "webm"
    q = f"?ext={quote(ext)}&model={quote(model)}"
    if language:
        q += f"&language={quote(language)}"
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(
        BASE_URL + "/transcribe" + q,
        data=data,
        method="POST",
        headers={"Content-Type": "application/octet-stream"},
    )
    with urllib.request.urlopen(req, timeout=TRANS_TIMEOUT) as r:
        obj = json.loads(r.read().decode("utf-8"))
    return obj.get("text", "")


def write_txt(audio_path: str, output_dir: str, text: str) -> str:
    output_dir = output_dir or "."
    os.makedirs(output_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(audio_path))[0]
    out = os.path.join(output_dir, base + ".txt")
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    return out


def run_real_cli(argv) -> None:
    """原地跑真正的 whisper CLI(与 openai-whisper 原版 console_script 相同)。"""
    sys.argv = ["whisper"] + list(argv)
    from whisper.transcribe import cli

    cli()


def main() -> None:
    argv = sys.argv[1:]

    # 自检标记(原版 CLI 不认识;用来确认 whisper.exe 是不是 shim)
    if "--shim-version" in argv:
        print(f"whisper-shim {SHIM_VERSION} ({_HERE})")
        return

    try:
        opts = parse_fast_path(argv)
    except Exception:
        opts = None

    if (
        opts
        and len(opts["files"]) == 1
        and opts["task"] in (None, "transcribe")
        and opts["output_format"] in (None, "txt")
        and os.path.isfile(opts["files"][0])
    ):
        path = os.path.abspath(opts["files"][0])
        try:
            if ensure_server():
                t0 = time.time()
                text = transcribe(path, opts["model"] or "turbo", opts["language"] or "")
                out = write_txt(path, opts["output_dir"], text)
                _err(f"服务转写完成 {time.time() - t0:.2f}s -> {out}")
                return
        except Exception as e:
            _err(f"服务路径失败({type(e).__name__}: {e}),回退原版 CLI(会慢,但行为一致)")

    run_real_cli(argv)


if __name__ == "__main__":
    main()
