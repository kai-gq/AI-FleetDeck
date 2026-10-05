"""piper.exe 兼容垫片:把 piper CLI 调用转成 edge-tts(微软在线神经语音)合成。

调用约定(tts.ts 同款):
  piper.exe --model <voices_dir>/<voice>.onnx --output_file <out.wav>
            [--rate <±百分比>] [--volume <±百分比>]
  文本从 stdin 读入;成功时 <out.wav> 为 edge-tts 原生 mp3(见下)。
  --rate/--volume 可选:CLI 传值 > voices.local.json(工具箱「文字转语音」
  保存的全局语速/音量)> 0(原速原音量)。数值为百分数:10 = 快 10%。

单次合成:本进程直接 edge-tts 合成,播完即退(无常驻进程、不占常驻内存);
代价是每句多 ~0.5s 的 edge-tts import 时间。

输出格式:默认直返 mp3 —— 省掉每次合成的 ffmpeg 转码段(24kHz WAV),
播放端按服务端 Content-Type 判型(mp3 亦为浏览器原生格式)。设
EDGE_TTS_MP3=0 回退旧行为(转 16-bit PCM WAV;注意环境变量随服务端进程
生效,切换需重启服务端)。
任何失败(断网、接口失效)→ 回退同目录 piper_real.exe(原版 piper):
新参数会先剥离(--rate 非 0 时映射为 --length_scale = 1/(1+rate/100)),
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


def parse_pct(value):
    """解析 rate/volume:接受 10 / "+10" / "+10%" / "-5%";非法/越界 → None。"""
    if value is None:
        return None
    s = str(value).strip().rstrip("%")
    if s.startswith("+"):
        s = s[1:]
    try:
        n = float(s)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):  # NaN / ±inf
        return None
    return max(-100.0, min(100.0, n))


def format_pct(n):
    """百分比数字 → edge-tts 需要的 "+10%" / "-5%" 形式。"""
    r = int(round(n))
    return ("+%d%%" % r) if r >= 0 else ("-%d%%" % abs(r))


def parse_args(argv):
    """只关心 --model/--output_file/--rate/--volume,其余参数透传给回退路径。"""
    model = out = None
    rate = volume = None
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
        if a == "--rate" and i + 1 < len(argv):
            rate = parse_pct(argv[i + 1])
            i += 2
            continue
        if a == "--volume" and i + 1 < len(argv):
            volume = parse_pct(argv[i + 1])
            i += 2
            continue
        i += 1
    return model, out, rate, volume


def _read_voices(path):
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def pick_voice(model, cfg):
    """EDGE_TTS_VOICE 环境变量(临时试音色)> cfg(工具箱保存的覆盖配置)按语言前缀。"""
    env = os.environ.get("EDGE_TTS_VOICE")
    if env:
        return env
    lang = "zh"
    if model:
        stem = Path(model).name
        if "_" in stem:
            lang = stem.split("_", 1)[0].lower()
    val = cfg.get(lang) or cfg.get("zh")
    if isinstance(val, str) and val:
        return val
    return DEFAULT_VOICE


def pick_tuning(cfg, cli_rate, cli_volume):
    """语速/音量(百分数):CLI 显式传值 > 配置文件 > 0(缺字段/非法值走默认)。"""
    rate = cli_rate if cli_rate is not None else parse_pct(cfg.get("rate"))
    volume = cli_volume if cli_volume is not None else parse_pct(cfg.get("volume"))
    return (0.0 if rate is None else rate), (0.0 if volume is None else volume)


def find_ffmpeg():
    cand = REPO_ROOT / "tools" / "whisper" / "ffmpeg" / "bin" / "ffmpeg.exe"
    if cand.exists():
        return str(cand)
    import shutil
    return shutil.which("ffmpeg") or "ffmpeg"


def to_wav(mp3):
    """mp3 → 24kHz 单声道 16-bit WAV(ffmpeg;EDGE_TTS_MP3=0 回退路径专用)。"""
    p = subprocess.run(
        [find_ffmpeg(), "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-ar", "24000", "-ac", "1", "-f", "wav", "pipe:1"],
        input=mp3, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg: " + p.stderr.decode("utf-8", "replace")[:300])
    return p.stdout


def synth(text, voice, rate=0.0, volume=0.0, want_mp3=True):
    """edge-tts 在线合成(import 放函数内,回退路径不必付这份开销)。

    want_mp3=True 直返 edge-tts 原生 mp3(省一次 ffmpeg 转码,播放端按
    Content-Type 判型);False 转 24kHz WAV(旧行为)。"""
    import asyncio

    import edge_tts

    async def collect():
        mp3 = bytearray()
        communicate = edge_tts.Communicate(text, voice, rate=format_pct(rate), volume=format_pct(volume))
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                mp3.extend(chunk["data"])
        return bytes(mp3)

    mp3 = asyncio.run(asyncio.wait_for(collect(), timeout=45))
    if not mp3:
        raise RuntimeError("edge-tts 返回空音频")
    return mp3 if want_mp3 else to_wav(mp3)


def strip_tuning(argv):
    """剥离 --rate/--volume(连同其值):原版 piper 不认识这两个参数。"""
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--rate", "--volume") and i + 1 < len(argv):
            i += 2
            continue
        out.append(a)
        i += 1
    return out


def fallback(argv, text, rate=0.0):
    real = Path(sys.argv[0]).resolve().parent / "piper_real.exe"
    if not real.exists():
        log("fallback: piper_real.exe 不存在,放弃")
        return 127
    args = strip_tuning(argv)
    if rate and "--length_scale" not in args:
        # 语速映射: piper length_scale >1 更慢 → 1/(1+rate/100);钳到 [0.25, 4]
        scale = max(0.25, min(4.0, 1.0 / (1.0 + rate / 100.0)))
        args += ["--length_scale", "%.3f" % scale]
    log("fallback -> %s%s" % (real, (" (rate=%s)" % format_pct(rate)) if rate else ""))
    try:
        p = subprocess.run([str(real)] + args, input=text.encode("utf-8"))
        return p.returncode
    except Exception as e:
        log("fallback 执行失败:" + repr(e))
        return 126


def main():
    argv = sys.argv[1:]
    model, out, cli_rate, cli_volume = parse_args(argv)
    text = sys.stdin.buffer.read().decode("utf-8", "replace").strip()
    if not out or not text:
        log("参数不足: model=%s out=%s text_len=%d" % (model, out, len(text)))
        return fallback(argv, text) if text else 1
    rate = cli_rate if cli_rate is not None else 0.0
    want_mp3 = os.environ.get("EDGE_TTS_MP3", "1") != "0"
    try:
        cfg = _read_voices(TOOL_DIR / "voices.local.json") or _read_voices(TOOL_DIR / "voices.json")
        voice = pick_voice(model, cfg)
        rate, volume = pick_tuning(cfg, cli_rate, cli_volume)
        audio = synth(text, voice, rate, volume, want_mp3=want_mp3)
        if len(audio) < 100:
            raise RuntimeError("返回音频异常(%d 字节)" % len(audio))
        Path(out).write_bytes(audio)
        log("ok %dB fmt=%s voice=%s rate=%s volume=%s text=%r" % (len(audio), "mp3" if want_mp3 else "wav", voice, format_pct(rate), format_pct(volume), text[:30]))
        return 0
    except Exception as e:
        log("synth 失败(%s: %s),回退 piper" % (e.__class__.__name__, e))
        return fallback(argv, text, rate)


if __name__ == "__main__":
    sys.exit(main())
