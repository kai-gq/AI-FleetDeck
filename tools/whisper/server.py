#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
whisper 常驻转写服务 —— 应用内语音转文字(STT)的加速后端。

为什么存在:
  应用服务端每次语音输入都会 spawn('whisper', ...) 一个全新进程,每次都要
  重新导入 torch、把模型加载进显存(冷启动 ≈ 30 秒,而转写本身只要 ~0.5 秒)。
  本服务把模型常驻内存/显存,由 shim/(安装后覆盖 venv/Scripts/whisper.exe)
  把 CLI 调用转发到这里:首次调用拉起服务(≈10~20 秒),之后每次 ≈1 秒。

接口(仅监听 127.0.0.1,不对外):
  GET  /health
       -> {"ok": true, "pid": …, "model": …, "loaded": …, "idle_sec": …}
  POST /transcribe?language=Chinese&model=turbo&ext=webm
       body = 原始音频字节(webm/wav/opus/…),-> {"text": "…"}
       language 省略 = 自动检测;model 省略 = turbo。

退出:空闲 --idle-timeout 秒(默认 900,即 15 分钟)后自动退出,释放显存。
日志:标准输出(由拉起方追加写入 tools/whisper/server.log)。
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

_HERE = os.path.dirname(os.path.abspath(__file__))  # …/tools/whisper
DEFAULT_PORT = 17128
DEFAULT_MODEL = "turbo"
DEFAULT_IDLE_TIMEOUT = 15 * 60.0


def _prepend_path(d: str) -> None:
    """把本栈自带目录加进 PATH(不依赖启动者环境,保证 ffmpeg 一定找得到)。"""
    if os.path.isdir(d):
        path = os.environ.get("PATH", "")
        existing = [p.lower() for p in path.split(os.pathsep) if p]
        if d.lower() not in existing:
            os.environ["PATH"] = d + os.pathsep + path


_prepend_path(os.path.join(_HERE, "ffmpeg", "bin"))
_prepend_path(os.path.join(_HERE, "venv", "Scripts"))

_lock = threading.Lock()  # 模型不是线程安全的:转写串行化
_state = {
    "model": None,
    "model_name": None,
    "device": None,
    "last_active": time.time(),
    "busy": False,
}


def _log(msg: str) -> None:
    print(f"[whisper-server] {msg}", flush=True)


def load_model(model_name: str):
    import torch
    import whisper

    device = "cuda" if torch.cuda.is_available() else "cpu"
    t0 = time.time()
    model = whisper.load_model(model_name, device=device)
    _log(f"模型 {model_name} 加载完成 {time.time() - t0:.1f}s (device={device})")
    return model, device


def warmup(model, device: str, language: str | None) -> None:
    """用 1 秒静音预热首次推理(cuBLAS/cuDNN 首次调用要初始化,约 5~10 秒)。"""
    try:
        import numpy as np

        t0 = time.time()
        audio = np.zeros(16000, dtype=np.float32)
        kwargs = {"verbose": False, "fp16": device == "cuda"}
        if language:
            kwargs["language"] = language
        captured = io.StringIO()
        try:
            with contextlib.redirect_stderr(captured):
                model.transcribe(audio, **kwargs)
        except Exception:
            noise = captured.getvalue().strip()
            if noise:
                print(noise[-2000:], flush=True)
            raise
        _log(f"预热完成 {time.time() - t0:.1f}s")
    except Exception:
        _log("预热失败(不影响功能):")
        traceback.print_exc()


def get_model(model_name: str):
    if _state["model"] is None or _state["model_name"] != model_name:
        _state["model"], _state["device"] = load_model(model_name)
        _state["model_name"] = model_name
    return _state["model"], _state["device"]


def do_transcribe(data: bytes, ext: str, language: str, model_name: str) -> str:
    suffix = ext if ext.startswith(".") else "." + ext
    fd, tmp = tempfile.mkstemp(prefix="whisper-srv-", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        with _lock:
            model, device = get_model(model_name)
            kwargs = {"verbose": False, "fp16": device == "cuda"}
            if language:
                kwargs["language"] = language
            t0 = time.time()
            captured = io.StringIO()
            try:
                with contextlib.redirect_stderr(captured):  # 吞掉 tqdm 进度条噪音
                    result = model.transcribe(tmp, **kwargs)
            except Exception:
                noise = captured.getvalue().strip()
                if noise:
                    _log(f"whisper 输出(出错时,末尾 2000 字符):\n{noise[-2000:]}")
                raise
            text = (result.get("text") or "").strip()
            _log(
                f"转写完成 {time.time() - t0:.2f}s / {len(text)} 字 "
                f"(model={model_name}, lang={language or 'auto'}, {len(data)} bytes)"
            )
            return text
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "whisper-server/1.0"

    def log_message(self, fmt, *args):  # 禁用默认逐请求日志(自己记的更有用)
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._json(200, {
                "ok": True,
                "pid": os.getpid(),
                "model": _state["model_name"],
                "loaded": _state["model"] is not None,
                "busy": _state["busy"],
                "idle_sec": round(time.time() - _state["last_active"], 1),
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        qs = parse_qs(u.query)
        language = (qs.get("language", [""])[0] or "").strip()
        model_name = (qs.get("model", [DEFAULT_MODEL])[0] or DEFAULT_MODEL).strip()
        ext = (qs.get("ext", ["webm"])[0] or "webm").strip()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._json(400, {"error": "empty body"})
            return
        data = self.rfile.read(length)
        _state["busy"] = True
        try:
            text = do_transcribe(data, ext, language, model_name)
            _state["last_active"] = time.time()
            self._json(200, {
                "text": text,
                "model": model_name,
                "language": language or "auto",
            })
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
        finally:
            _state["busy"] = False


class Server(ThreadingHTTPServer):
    # Windows 下避免两个实例同时绑定同一端口(SO_REUSEADDR 在 Windows 语义不同)
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address):
        etype = sys.exc_info()[0]
        if etype in (ConnectionAbortedError, ConnectionResetError,
                     BrokenPipeError, TimeoutError):
            return  # 客户端提前断开(健康检查超时等):静默,不当错误
        super().handle_error(request, client_address)


def idle_watchdog(timeout: float) -> None:
    while True:
        time.sleep(5)
        if _state["busy"]:
            continue
        idle = time.time() - _state["last_active"]
        if idle > timeout:
            _log(f"空闲 {idle:.0f}s 超过上限 {timeout:.0f}s,退出释放显存")
            os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser(description="whisper 常驻转写服务")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--language",
        default="Chinese",
        help="预热用的语言(不影响请求中传入的 language)",
    )
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=DEFAULT_IDLE_TIMEOUT,
        help="空闲多少秒后退出(0=永不退出),默认 900",
    )
    parser.add_argument("--no-warmup", action="store_true")
    args = parser.parse_args()

    _log(
        f"启动 pid={os.getpid()} port={args.port} model={args.model} "
        f"idle_timeout={args.idle_timeout:.0f}s"
    )

    # 先占端口:已有实例在跑就直接退出(不重复加载模型)
    try:
        httpd = Server(("127.0.0.1", args.port), Handler)
    except OSError as e:
        _log(f"端口 {args.port} 不可用(可能已有实例在跑):{e}")
        sys.exit(0)
    httpd.daemon_threads = True

    with _lock:
        _state["model"], _state["device"] = load_model(args.model)
        _state["model_name"] = args.model
    if not args.no_warmup:
        warmup(_state["model"], _state["device"], args.language)

    _state["last_active"] = time.time()
    if args.idle_timeout > 0:
        threading.Thread(
            target=idle_watchdog, args=(args.idle_timeout,), daemon=True
        ).start()

    _log(f"就绪 http://127.0.0.1:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("收到 Ctrl+C,退出")


if __name__ == "__main__":
    main()
