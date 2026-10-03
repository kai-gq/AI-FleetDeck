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

云通道(可选,见 tools/whisper/README.md):tools/whisper/cloud.json 存在且
配了 API key 时,auto 模式先试硅基流动 SenseVoice(云端识别,中文更准),
任何失败自动回落本地服务;mode=local 完全离线;mode=cloud 只走云、失败即
报错不回退。云路径会先用本地 ffmpeg 把音频转成 16kHz 单声道 wav(云 API
不收 webm);此时 CLI 的 --language/--model 被忽略(模型以 cloud.json 为准)。

自检:`whisper --shim-version` 打印 shim 版本(原版 CLI 不认识这个参数)。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import quote

# 输出统一 UTF-8(被应用 spawn 时 Python 默认走系统 ANSI 代码页,中文会乱码)
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

SHIM_VERSION = "0.2.0"
PORT = 17128
BASE_URL = f"http://127.0.0.1:{PORT}"

_HERE = os.path.dirname(os.path.abspath(__file__))  # …/tools/whisper/shim
_STACK = os.path.dirname(_HERE)  # …/tools/whisper
SERVER_PY = os.path.join(_STACK, "server.py")
SERVER_LOG = os.path.join(_STACK, "server.log")

START_TIMEOUT = 180.0  # 冷启动等待上限:torch 导入 + 模型加载 + 预热
TRANS_TIMEOUT = 900.0  # 单次转写上限(秒)

# ---- 云通道(硅基流动 SenseVoice)----
CLOUD_CONFIG = os.path.join(_STACK, "cloud.json")
SILICONFLOW_URL = "https://api.siliconflow.cn/v1/audio/transcriptions"
CLOUD_MODEL_DEFAULT = "FunAudioLLM/SenseVoiceSmall"
CLOUD_TIMEOUT = 10.0  # 单次云请求上限;失败回落本地的等待上限就是它
FFMPEG_TIMEOUT = 120.0  # 本地 ffmpeg 转码上限

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


# ---------------------------------------------------------------------------
# 云通道:硅基流动 SenseVoice(中文更准、免模型加载;配置见 tools/whisper/cloud.json)
# ---------------------------------------------------------------------------

def load_cloud_config() -> dict:
    """读 cloud.json;缺失 / 坏 JSON / 字段非法一律回默认(mode=auto),绝不因此报错。"""
    cfg = {"mode": "auto", "provider": "siliconflow", "apiKey": "", "model": CLOUD_MODEL_DEFAULT}
    try:
        with open(CLOUD_CONFIG, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return cfg
    if not isinstance(raw, dict):
        return cfg
    if raw.get("mode") in ("auto", "local", "cloud"):
        cfg["mode"] = raw["mode"]
    for k in ("provider", "apiKey", "model"):
        v = raw.get(k)
        if isinstance(v, str) and v.strip():
            cfg[k] = v.strip()
    return cfg


def _ffmpeg_path() -> str:
    local = os.path.join(_STACK, "ffmpeg", "bin", "ffmpeg.exe")
    if os.path.isfile(local):
        return local
    return shutil.which("ffmpeg") or shutil.which("ffmpeg.exe") or "ffmpeg"


def transcode_wav16k(src: str) -> str:
    """任意音频 → 16kHz 单声道 wav(云 API 的格式列表不含 webm)。
    返回临时文件路径,调用方负责删除。"""
    fd, dst = tempfile.mkstemp(prefix="whisper-shim-", suffix=".wav")
    os.close(fd)  # Windows:必须先关句柄,ffmpeg 才能写这个文件
    try:
        p = subprocess.run(
            [_ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", dst],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, timeout=FFMPEG_TIMEOUT)
        if p.returncode != 0:
            raise RuntimeError("ffmpeg: " + p.stderr.decode("utf-8", "replace")[:300])
        if os.path.getsize(dst) <= 44:  # 只有 wav 头 = 空音频
            raise RuntimeError("转码输出为空")
        return dst
    except Exception:
        try:
            os.unlink(dst)
        except OSError:
            pass
        raise


def _multipart(fields: dict, audio: bytes) -> tuple:
    """手搓 multipart/form-data(标准库没有现成帮手);返回 (boundary, body)。
    上传文件名固定,不泄露临时文件名。"""
    boundary = "----whisper-shim-" + uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f"--{boundary}\r\n".encode("utf-8")
        out += f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode("utf-8")
        out += str(v).encode("utf-8") + b"\r\n"
    out += f"--{boundary}\r\n".encode("utf-8")
    out += b'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
    out += b"Content-Type: audio/wav\r\n\r\n"
    out += audio + b"\r\n"
    out += f"--{boundary}--\r\n".encode("utf-8")
    return boundary, bytes(out)


def cloud_transcribe(wav_path: str, cfg: dict) -> str:
    """把 16k wav 传到硅基流动转写,返回文本。绝不把 key 打进日志/异常。"""
    with open(wav_path, "rb") as f:
        audio = f.read()
    boundary, body = _multipart({"model": cfg["model"]}, audio)
    req = urllib.request.Request(
        SILICONFLOW_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + cfg["apiKey"],
            "Content-Type": "multipart/form-data; boundary=" + boundary,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=CLOUD_TIMEOUT) as r:
            obj = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"HTTP {e.code} {detail}")
    if not isinstance(obj, dict) or not isinstance(obj.get("text"), str):
        raise RuntimeError("响应缺少 text 字段")
    return obj["text"]


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

        # 云通道:auto=云优先(失败回落本地),cloud=只走云(失败不回退),local=跳过
        cfg = load_cloud_config()
        if cfg["mode"] == "cloud":
            if cfg["provider"] != "siliconflow":
                _err(f"cloud 模式:不支持的 provider {cfg['provider']!r},不回退本地")
                sys.exit(1)
            if not cfg["apiKey"]:
                _err("cloud 模式未配置 API Key(工具箱 → 语音转文字),不回退本地")
                sys.exit(1)
        use_cloud = (
            cfg["mode"] in ("auto", "cloud")
            and cfg["provider"] == "siliconflow"
            and bool(cfg["apiKey"])
        )
        if use_cloud:
            wav = None
            try:
                wav = transcode_wav16k(path)
                t0 = time.time()
                text = cloud_transcribe(wav, cfg)
                out = write_txt(path, opts["output_dir"], text)
                _err(f"云端转写完成 {time.time() - t0:.2f}s ({cfg['model']}) -> {out}")
                return
            except Exception as e:
                _err(f"云端转写失败({type(e).__name__}: {e})")
                if cfg["mode"] == "cloud":
                    _err("cloud 模式:不回退本地")
                    sys.exit(1)
                _err("auto 模式:回退本地服务")
            finally:
                if wav:
                    try:
                        os.unlink(wav)
                    except OSError:
                        pass

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
