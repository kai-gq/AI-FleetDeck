"""piper.exe 兼容垫片:把 piper CLI 调用转成 edge-tts(微软在线神经语音)合成。

调用约定(tts.ts 同款):
  piper.exe --model <voices_dir>/<voice>.onnx --output_file <out.wav>
  文本从 stdin 读入;成功时 <out.wav> 为 16-bit PCM WAV。

单次合成:本进程直接 edge-tts 合成 → ffmpeg 转 wav,播完即退(无常驻进程、
不占常驻内存);代价是每句多 ~0.5s 的 edge-tts import 时间。
任何失败(断网、接口失效)→ 回退同目录 piper_real.exe(原版 piper),
最坏 = 原来的机器音,绝不更差。日志:tools/edge-tts/shim.log
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent            # tools/edge-tts/shim
TOOL_DIR = HERE.parent                            # tools/edge-tts
REPO_ROOT = TOOL_DIR.parents[1]
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
    """EDGE_TTS_VOICE 环境变量(临时试音色)> voices.json 按语言前缀。"""
    env = os.environ.get("EDGE_TTS_VOICE")
    if env:
        return env
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


def find_ffmpeg():
    cand = REPO_ROOT / "tools" / "whisper" / "ffmpeg" / "bin" / "ffmpeg.exe"
    if cand.exists():
        return str(cand)
    import shutil
    return shutil.which("ffmpeg") or "ffmpeg"


def synth(text, voice):
    """edge-tts 在线合成(import 放函数内,回退路径不必付这份开销)。"""
    import asyncio

    import edge_tts

    async def collect():
        mp3 = bytearray()
        async for chunk in edge_tts.Communicate(text, voice).stream():
            if chunk["type"] == "audio":
                mp3.extend(chunk["data"])
        return bytes(mp3)

    mp3 = asyncio.run(asyncio.wait_for(collect(), timeout=45))
    if not mp3:
        raise RuntimeError("edge-tts 返回空音频")

    p = subprocess.run(
        [find_ffmpeg(), "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-ar", "24000", "-ac", "1", "-f", "wav", "pipe:1"],
        input=mp3, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg: " + p.stderr.decode("utf-8", "replace")[:300])
    return p.stdout


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
