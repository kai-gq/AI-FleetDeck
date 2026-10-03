"""edge-tts 常驻合成服务(微软在线神经语音)。

POST /synth  {"text": "...", "voice": "zh-CN-XiaoxiaoNeural"}  -> audio/wav
GET  /health -> {"ok": true, "pid": ..., "idle_sec": ...}

- mp3 → wav 用 tools/whisper/ffmpeg/bin/ffmpeg.exe(缺失时找 PATH 的 ffmpeg);
- 空闲 30 分钟自动退出(shim 下次播报自动拉起);
- 日志:tools/edge-tts/server.log
"""

import asyncio
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path

import edge_tts
from aiohttp import web

TOOL_DIR = Path(__file__).resolve().parent          # tools/edge-tts
REPO_ROOT = TOOL_DIR.parents[1]                     # tools/edge-tts -> tools -> repo
PORT = int(os.environ.get("EDGE_TTS_PORT", "17129"))
IDLE_EXIT_SEC = 30 * 60

logging.basicConfig(
    filename=str(TOOL_DIR / "server.log"),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("edge-tts-server")

last_activity = time.time()


def find_ffmpeg():
    cand = REPO_ROOT / "tools" / "whisper" / "ffmpeg" / "bin" / "ffmpeg.exe"
    if cand.exists():
        return str(cand)
    return shutil.which("ffmpeg") or "ffmpeg"


FFMPEG = find_ffmpeg()


def mp3_to_wav(mp3: bytes) -> bytes:
    p = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-ar", "24000", "-ac", "1", "-f", "wav", "pipe:1"],
        input=mp3, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg: " + p.stderr.decode("utf-8", "replace")[:300])
    return p.stdout


async def handle_health(request):
    return web.json_response({
        "ok": True,
        "pid": os.getpid(),
        "idle_sec": round(time.time() - last_activity, 1),
    })


async def handle_synth(request):
    global last_activity
    last_activity = time.time()
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    text = (data.get("text") or "").strip()
    voice = data.get("voice") or "zh-CN-XiaoxiaoNeural"
    if not text:
        return web.json_response({"error": "empty text"}, status=400)

    started = time.time()
    try:
        comm = edge_tts.Communicate(text, voice)
        mp3 = bytearray()

        async def collect():
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    mp3.extend(chunk["data"])

        await asyncio.wait_for(collect(), timeout=45)
        wav = await asyncio.get_running_loop().run_in_executor(
            None, mp3_to_wav, bytes(mp3))
    except Exception as e:
        log.warning("synth 失败 voice=%s text=%r: %s: %s",
                    voice, text[:60], e.__class__.__name__, e)
        return web.json_response(
            {"error": "%s: %s" % (e.__class__.__name__, e)}, status=502)

    log.info("synth ok %.2fs %dB voice=%s text=%r",
             time.time() - started, len(wav), voice, text[:60])
    return web.Response(body=wav, content_type="audio/wav")


async def idle_watchdog(app):
    while True:
        await asyncio.sleep(60)
        if time.time() - last_activity > IDLE_EXIT_SEC:
            log.info("空闲 %ds,退出", IDLE_EXIT_SEC)
            os._exit(0)


async def on_startup(app):
    app["watchdog"] = asyncio.create_task(idle_watchdog(app))


def main():
    log.info("edge-tts 服务启动 pid=%d port=%d ffmpeg=%s", os.getpid(), PORT, FFMPEG)
    app = web.Application()
    app.router.add_get("/health", handle_health)
    app.router.add_post("/synth", handle_synth)
    app.on_startup.append(on_startup)
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()
