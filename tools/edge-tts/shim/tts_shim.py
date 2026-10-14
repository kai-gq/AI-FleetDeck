"""piper.exe 兼容垫片:把 piper CLI 调用转成 edge-tts(微软在线神经语音)或
火山引擎(豆包大模型 TTS)合成,按 voices.local.json 的 "engine" 字段切换。

调用约定(tts.ts 同款):
  piper.exe --model <voices_dir>/<voice>.onnx --output_file <out.wav>
            [--rate <±百分比>] [--volume <±百分比>]
  文本从 stdin 读入;成功时 <out.wav> 为 mp3(见下)。语言由 --model 文件名
  前缀承载(zh_CN-huayan-medium.onnx → zh),据此选音色。
  --rate/--volume 可选:CLI 传值 > voices.local.json(设置页「文字转语音」
  保存的全局语速/音量)> 0(原速原音量)。数值为百分数:10 = 快 10%。

引擎(voices.local.json → "engine","edge-tts"(默认)| "volcano";老配置
无此键 = edge-tts,行为与历史逐字一致;env TC_TTS_ENGINE 可临时覆盖):
  - edge-tts:微软在线语音(免费);音色取 cfg[lang]。
  - volcano:火山引擎 V3 HTTP 单向流式接口;音色取 cfg["volcano"][lang]
    (空串/缺失 = 该语言回退 edge-tts);凭据取 cfg["volcanoApiKey"] 或
    复用 tools/voice-companion/config.json 的 stt.volcengine(env
    TC_TTS_VOLCANO_API_KEY 覆盖)。按字符计费。
失败回退链:volcano 失败 → edge-tts(语速/音量照传)→ 仍失败 → piper_real。
每跳都写 shim.log;成功/回退结果另写 shim-state.json(设置页「上次播报」读它)。

单次合成:本进程直接合成,播完即退(无常驻进程、不占常驻内存);
代价是每句多 ~0.5s 的 edge-tts import 时间(volcano 路径无需该 import)。

输出格式:默认直返 mp3 —— 省掉每次合成的 ffmpeg 转码段(24kHz WAV),
播放端按服务端 Content-Type 判型(mp3 亦为浏览器原生格式)。设
EDGE_TTS_MP3=0 回退旧行为(转 16-bit PCM WAV;注意环境变量随服务端进程
生效,切换需重启服务端)。
任何失败(断网、接口失效)→ 回退同目录 piper_real.exe(原版 piper):
新参数会先剥离(--rate 非 0 时映射为 --length_scale = 1/(1+rate/100)),
最坏 = 原来的机器音,绝不更差。日志:tools/edge-tts/shim.log
"""

import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent            # tools/edge-tts/shim
TOOL_DIR = HERE.parent                            # tools/edge-tts
REPO_ROOT = TOOL_DIR.parents[1]
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"

# 播报引擎:edge-tts(默认,微软在线)/ volcano(火山引擎·豆包大模型 TTS,按字符计费)。
# 配置键 "engine" 由设置页写入 voices.local.json;老配置无此键 = edge-tts(等价现状)。
DEFAULT_ENGINE = "edge-tts"
ENGINE_ALIASES = {
    "edge-tts": "edge-tts", "edge": "edge-tts",
    "volcano": "volcano", "volcengine": "volcano", "doubao": "volcano",
}
VOLCANO_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
VOLCANO_URL_SSE = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"
VOICE_COMPANION_CONFIG = REPO_ROOT / "tools" / "voice-companion" / "config.json"
STATE_FILE = TOOL_DIR / "shim-state.json"   # 设置页「上次播报」读它(gitignored)


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


def lang_from_model(model):
    """语言由 --model 文件名前缀承载(zh_CN-huayan-medium.onnx → zh);无前缀 → zh。"""
    lang = "zh"
    if model:
        stem = Path(model).name
        if "_" in stem:
            lang = stem.split("_", 1)[0].lower()
    return lang


def pick_voice(model, cfg):
    """EDGE_TTS_VOICE 环境变量(临时试音色)> cfg(设置页保存的覆盖配置)按语言前缀。"""
    env = os.environ.get("EDGE_TTS_VOICE")
    if env:
        return env
    val = cfg.get(lang_from_model(model)) or cfg.get("zh")
    if isinstance(val, str) and val:
        return val
    return DEFAULT_VOICE


def pick_tuning(cfg, cli_rate, cli_volume):
    """语速/音量(百分数):CLI 显式传值 > 配置文件 > 0(缺字段/非法值走默认)。"""
    rate = cli_rate if cli_rate is not None else parse_pct(cfg.get("rate"))
    volume = cli_volume if cli_volume is not None else parse_pct(cfg.get("volume"))
    return (0.0 if rate is None else rate), (0.0 if volume is None else volume)


def pick_engine(cfg):
    """TC_TTS_ENGINE 环境变量(临时覆盖)> cfg["engine"] > edge-tts。非法值/老配置 = 现状。"""
    raw = os.environ.get("TC_TTS_ENGINE") or cfg.get("engine") or ""
    return ENGINE_ALIASES.get(str(raw).strip().lower(), DEFAULT_ENGINE)


def pick_volcano_voice(model, cfg):
    """火山音色:只认 cfg["volcano"][当前语言];缺失/空串 → None(=该语言回退 edge-tts)。

    注意:此处空串是**有效值**(设置页「不用火山 · 回退 edge-tts」选项),
    与 edge 音色字段 cfg[lang](空串 = 保持默认)语义相反;
    不做 zh 兜底——否则英语文本会拿中文音色读。"""
    volc = cfg.get("volcano")
    if not isinstance(volc, dict):
        return None
    val = volc.get(lang_from_model(model))
    return val.strip() if isinstance(val, str) and val.strip() else None


def pick_volcano_key(cfg):
    """火山凭据优先级:TC_TTS_VOLCANO_API_KEY > cfg["volcanoApiKey"] > voice-companion
    config.json 的 stt.volcengine(凭据复用,ASR 同款)。

    返回 (credential, kind):kind="apikey"(新版控制台,单个 API Key)或
    "legacy"(旧版,AppID+AccessToken 二元组)。返回值绝不写日志/状态文件。"""
    env = os.environ.get("TC_TTS_VOLCANO_API_KEY")
    if env and env.strip():
        return env.strip(), "apikey"
    local = cfg.get("volcanoApiKey")
    if isinstance(local, str) and local.strip():
        return local.strip(), "apikey"
    vc = _read_voices(VOICE_COMPANION_CONFIG)
    stt = vc.get("stt") if isinstance(vc.get("stt"), dict) else {}
    volc = stt.get("volcengine") if isinstance(stt.get("volcengine"), dict) else {}
    key = volc.get("apiKey")
    if isinstance(key, str) and key.strip():
        return key.strip(), "apikey"
    app_id, token = volc.get("appId"), volc.get("accessToken")
    if isinstance(app_id, str) and app_id.strip() and isinstance(token, str) and token.strip():
        return (app_id.strip(), token.strip()), "legacy"
    return None, None


def pick_resource_id(voice, cfg):
    """resource 按**当前音色**推导(2.0 uranus 音色 → seed-tts-2.0,其余 → seed-tts-1.0),
    支持 zh 1.0 / en 2.0 混搭;cfg["volcanoResourceId"] 显式配置优先。"""
    r = cfg.get("volcanoResourceId")
    if isinstance(r, str) and r.strip():
        return r.strip()
    return "seed-tts-2.0" if "_uranus_" in (voice or "") else "seed-tts-1.0"


def volcano_timeout():
    """火山单次请求总预算(秒):urlopen 的 timeout 只管单次 recv,总时长另设护栏。"""
    try:
        return max(3.0, float(os.environ.get("TC_TTS_VOLCANO_TIMEOUT") or 20))
    except ValueError:
        return 20.0


def clamp_volcano_tuning(n):
    """火山 speech_rate/loudness_rate 范围 [-50, 100](100=2 倍速、-50=0.5 倍),
    与 edge 的百分数同刻度 → 恒等映射,仅钳位(edge 允许到 -100,火山最慢 -50)。"""
    try:
        v = float(n or 0.0)
    except (TypeError, ValueError):
        return 0
    return int(round(max(-50.0, min(100.0, v))))


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


class VolcanoApiError(RuntimeError):
    """火山接口错误:code 为业务码(None = HTTP 层错误);audio_seen = 已收到音频分片。"""

    def __init__(self, message, code=None, audio_seen=False):
        super().__init__(message)
        self.code = code
        self.audio_seen = audio_seen


def build_volcano_body(text, voice, rate, volume, additions=None):
    """V3 请求体(无凭据,可安全打印)。additions 必须是 JSON **字符串**(接口约定)。"""
    return {
        "user": {"uid": "fleetdeck-tts"},
        "req_params": {
            "text": text,
            "speaker": voice,
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": clamp_volcano_tuning(rate),
                "loudness_rate": clamp_volcano_tuning(volume),
            },
            "additions": json.dumps(additions or {"disable_markdown_filter": True}, ensure_ascii=False),
        },
    }


def _iter_json_objects(s):
    """按 JSON 完整性切分字符串(一行可含多个对象,对象也可跨行);解析不动即停。"""
    dec = json.JSONDecoder()
    i, n = 0, len(s)
    while i < n:
        while i < n and s[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        try:
            obj, i = dec.raw_decode(s, i)
        except ValueError:
            break
        yield obj


def _parse_binary_frames(raw):
    """二进制帧响应(HTTP 变体未见过,防御分支):尽力从帧流里捞 JSON 的 data 字段。"""
    text = raw.decode("utf-8", "replace")
    audio = bytearray()
    if "{" in text:
        for obj in _iter_json_objects(text[text.find("{"):]):
            d = obj.get("data") if isinstance(obj, dict) else None
            if isinstance(d, str) and d:
                try:
                    audio += base64.b64decode(d, validate=False)
                except Exception:
                    pass
    if not audio:
        raise VolcanoApiError("二进制帧响应未支持 first200=%s" % raw[:200].hex())
    return bytes(audio), None


def parse_volcano_response(raw, ctype=""):
    """解析火山 V3 响应,容错三形态:(a) SSE `data:` 行;(b) 逐行/连写纯 JSON;
    (c) 二进制帧(防御)。返回 (mp3 字节, usage);失败抛 VolcanoApiError(带前 200 字节 hex)。

    成功码:0(分片)/ 20000000(收尾帧,顺带取 usage 计费字符数)。"""
    if not raw:
        raise VolcanoApiError("空响应")
    if raw[:1] in (b"\x11", b"\x12") or "octet-stream" in (ctype or ""):
        return _parse_binary_frames(raw)
    text = raw.decode("utf-8", "replace")
    audio = bytearray()
    usage = None
    done = False
    saw_ok = False                        # 见过成功帧(为「零音频」给出可读原因)
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("data:"):
            s = s[5:].strip()
        if not s or s[0] not in "[{":
            continue                      # 跳过 event:/id: 行、空行、文本说明
        for obj in _iter_json_objects(s):
            if not isinstance(obj, dict):
                continue
            code = obj.get("code", 0)
            if code not in (0, 20000000):
                raise VolcanoApiError(
                    "code=%s msg=%s" % (code, obj.get("message") or obj.get("msg") or ""),
                    code=code, audio_seen=bool(audio))
            saw_ok = True
            if code == 20000000:          # 服务端收尾帧(非错误码)
                done = True
                if obj.get("usage"):
                    usage = obj["usage"]
            d = obj.get("data")
            if isinstance(d, str) and d:
                try:
                    audio += base64.b64decode(d, validate=False)
                except Exception:
                    pass
        if done:
            break
    if not audio:                         # 兜底:整段正则捞 base64 data
        m = re.search(r'"data"\s*:\s*"([A-Za-z0-9+/=]{16,})"', text)
        if m:
            audio += base64.b64decode(m.group(1))
    if not audio:
        if saw_ok:
            # 2026-10-14 实测:音色不支持文本语言时服务端回 200 + code=0 + data:null 零音频
            raise VolcanoApiError(
                "服务端未返回音频分片(音色与文本语言不匹配?) first200=%s" % raw[:200].hex())
        raise VolcanoApiError("响应无法解析 ctype=%s first200=%s" % (ctype, raw[:200].hex()))
    return bytes(audio), usage


def _volcano_post(url, text, voice, rid, key, kind, rate, volume, timeout, additions=None, extra_params=None):
    """单次 V3 请求,返回 (mp3 字节, usage)。key 只进请求头,绝不进日志。

    extra_params: 追加进 req_params 的实验参数(探针试 explicit_language 等,生产路径不传)。"""
    import urllib.error
    import urllib.request
    import uuid
    headers = {
        "Content-Type": "application/json",
        "X-Api-Resource-Id": rid,
        "X-Api-Request-Id": str(uuid.uuid4()),
        "X-Control-Require-Usage-Tokens-Return": "*",   # 免费拿计费字符数(usage)
    }
    if kind == "apikey":
        headers["X-Api-Key"] = key
    else:  # 旧版控制台 AppID + AccessToken(与本仓 ASR 客户端同款双形态)
        headers["X-Api-App-Id"], headers["X-Api-Access-Key"] = key
    payload = build_volcano_body(text, voice, rate, volume, additions)
    if extra_params:
        payload["req_params"].update(extra_params)
    body = json.dumps(payload, ensure_ascii=False)
    req = urllib.request.Request(url, data=body.encode("utf-8"), method="POST", headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            detail = ""
        logid = e.headers.get("X-Tt-Logid", "-") if e.headers else "-"
        raise VolcanoApiError("HTTP %s %s logid=%s" % (e.code, detail, logid))
    deadline = time.monotonic() + timeout
    buf = bytearray()
    with resp:
        ctype = resp.headers.get("Content-Type", "") if resp.headers else ""
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            buf += chunk
            if b'"code":20000000' in buf[-4096:] or b'"code": 20000000' in buf[-4096:]:
                break                     # 收尾帧已到,服务端可能不关连接
            if time.monotonic() > deadline:
                raise RuntimeError("火山响应超时(%.0fs)" % timeout)
    return parse_volcano_response(bytes(buf), ctype)


def synth_volcano(text, voice, rate, volume, cfg, url=None):
    """火山引擎(豆包大模型 TTS)V3 合成 → mp3。

    resource 与音色不匹配(code 55000000 且尚未收到任何音频)→ 自动换另一
    resource 重试一次;其它失败直接抛出,由 main 走回退链。"""
    key, kind = pick_volcano_key(cfg)
    if not key:
        raise RuntimeError("未配置火山凭据(volcanoApiKey 或 voice-companion stt.volcengine)")
    url = url or os.environ.get("TC_TTS_VOLCANO_URL") or VOLCANO_URL
    timeout = volcano_timeout()
    first = pick_resource_id(voice, cfg)
    order = [first, "seed-tts-1.0" if first == "seed-tts-2.0" else "seed-tts-2.0"]
    last = None
    for i, rid in enumerate(order):
        try:
            return _volcano_post(url, text, voice, rid, key, kind, rate, volume, timeout)
        except VolcanoApiError as e:
            last = e
            if i == 0 and e.code == 55000000 and not e.audio_seen:
                log("volcano resource=%s 不匹配(55000000),换 %s 重试" % (rid, order[1]))
                continue
            raise
    raise last


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


def usage_str(usage):
    """usage → 简短可读串(「123字」);无则 None。"""
    if isinstance(usage, dict):
        w = usage.get("text_words")
        if w is not None:
            return "%s字" % w
        return json.dumps(usage, ensure_ascii=False)[:60]
    return str(usage)[:60] if usage else None


def write_state(**kw):
    """原子写 shim-state.json(设置页「上次播报」读它;temp + os.replace 防读到半截)。

    reason 截断 200 字符;凭据绝不写入(调用方不传 key,只传 used/ok/voice 等)。"""
    obj = {"ts": int(time.time()), "time": time.strftime("%Y-%m-%d %H:%M:%S")}
    for k, v in kw.items():
        if isinstance(v, str) and len(v) > 200:
            v = v[:200]
        obj[k] = v
    try:
        tmp = STATE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except OSError:
        pass


def main():
    argv = sys.argv[1:]
    model, out, cli_rate, cli_volume = parse_args(argv)
    text = sys.stdin.buffer.read().decode("utf-8", "replace").strip()
    if not out or not text:
        log("参数不足: model=%s out=%s text_len=%d" % (model, out, len(text)))
        return fallback(argv, text) if text else 1
    want_mp3 = os.environ.get("EDGE_TTS_MP3", "1") != "0"
    cfg = _read_voices(TOOL_DIR / "voices.local.json") or _read_voices(TOOL_DIR / "voices.json")
    rate, volume = pick_tuning(cfg, cli_rate, cli_volume)
    engine = pick_engine(cfg)
    lang = lang_from_model(model)
    fmt = "mp3" if want_mp3 else "wav"
    t0 = time.monotonic()
    skip_reason = None      # volcano 未配置 → 该语言走 edge(常态,非回退)
    fail_reason = None      # volcano 失败 → 回退 edge(会写进状态卡)

    if engine == "volcano":
        volc_voice = pick_volcano_voice(model, cfg)
        if not volc_voice:
            skip_reason = "该语言(%s)未配置火山音色" % lang
            log("volcano 跳过(%s),用 edge-tts" % skip_reason)
        else:
            try:
                audio, usage = synth_volcano(text, volc_voice, rate, volume, cfg)
                if len(audio) < 100:
                    raise RuntimeError("返回音频异常(%d 字节)" % len(audio))
                if not want_mp3:
                    audio = to_wav(audio)
                Path(out).write_bytes(audio)
                ms = int((time.monotonic() - t0) * 1000)
                write_state(engine=engine, used="volcano", ok=True, voice=volc_voice, lang=lang,
                            fmt=fmt, bytes=len(audio), ms=ms, usage=usage_str(usage))
                log("ok %dB fmt=%s engine=volcano voice=%s rate=%s volume=%s usage=%s ms=%d text=%r"
                    % (len(audio), fmt, volc_voice, format_pct(rate), format_pct(volume),
                       usage_str(usage), ms, text[:30]))
                return 0
            except Exception as e:
                fail_reason = "%s: %s" % (e.__class__.__name__, e)
                log("volcano 失败(%s),回退 edge-tts" % fail_reason)

    voice = pick_voice(model, cfg)
    try:
        audio = synth(text, voice, rate, volume, want_mp3=want_mp3)
        if len(audio) < 100:
            raise RuntimeError("返回音频异常(%d 字节)" % len(audio))
        Path(out).write_bytes(audio)
        ms = int((time.monotonic() - t0) * 1000)
        write_state(engine=engine, used="edge-tts", ok=True, voice=voice, lang=lang, fmt=fmt,
                    bytes=len(audio), ms=ms,
                    fallback=("volcano->edge-tts" if fail_reason else None),
                    reason=fail_reason or skip_reason)
        log("ok %dB fmt=%s engine=edge-tts voice=%s rate=%s volume=%s ms=%d%s text=%r"
            % (len(audio), fmt, voice, format_pct(rate), format_pct(volume), ms,
               (" fallback=" + fail_reason) if fail_reason else "", text[:30]))
        return 0
    except Exception as e:
        log("synth 失败(%s: %s),回退 piper" % (e.__class__.__name__, e))
        write_state(engine=engine, used="piper", ok=False, voice=voice, lang=lang,
                    fallback="piper_real", ms=int((time.monotonic() - t0) * 1000),
                    reason="%s: %s" % (e.__class__.__name__, e))
        return fallback(argv, text, rate)


if __name__ == "__main__":
    sys.exit(main())
