"""火山引擎 TTS 探针(一次性排障工具,不是运行时依赖)。

把「火山播报引擎」接进设置页之前,先用**垫片将来运行的同一份代码**
(tts_shim 的 build_volcano_body / _volcano_post / parse_volcano_response)
实测账号,回答六问:

  1. seed-tts-1.0(大模型 1.0 音色,moon/mars)开通否?
  2. seed-tts-2.0(2.0 音色,uranus)开通否?
  3. X-Api-Key 单凭据够不够(还是要旧版 AppID+AccessToken)?
  4. 哪个端点可用(chunked / sse)、返回什么 framing?
  5. speech_rate/loudness_rate 生效否(-50/0/+50 三连对比字节数)?
  6. --es-probe:西语(多语种 2.0 音色 + explicit_language)能不能用?

用法:
  venv/Scripts/python.exe tools/edge-tts/shim/volcano_probe.py --offline
      # 零花费:夹具断言解析器 + 引擎分派纯函数(改 tts_shim 后先跑这个)
  venv/Scripts/python.exe tools/edge-tts/shim/volcano_probe.py --live
      # 实网矩阵(每格一句 ~17 字,按字符计费);产物 probe-out/*.mp3 可直接听
      # 可选:--endpoint chunked|sse|both(默认 both) --text "..." --es-probe

凭据与垫片同优先级(env TC_TTS_VOLCANO_API_KEY > voices.local.json 的
volcanoApiKey > tools/voice-companion/config.json 的 stt.volcengine),
只打印掩码(前 4 + 后 4)。probe-out/ 与日志均已 gitignore。
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tts_shim  # noqa: E402  与垫片共用同一份请求体/解析器,杜绝两份实现漂移

OUT_DIR = tts_shim.TOOL_DIR / "probe-out"
URLS = {"chunked": tts_shim.VOLCANO_URL, "sse": tts_shim.VOLCANO_URL_SSE}

# 候选音色 × 期望 resource(音色名以火山控制台「音色列表」为准;moon/mars=1.0,uranus=2.0)
CELLS = [
    ("sissi-1.0", "zh_female_shuangkuaisisi_moon_bigtts", "seed-tts-1.0"),
    ("xiaoya-2.0", "zh_female_wenrouxiaoya_uranus_bigtts", "seed-tts-2.0"),
    ("tim-en-2.0", "en_male_tim_uranus_bigtts", "seed-tts-2.0"),
]
ES_VOICE = "zh_female_vv_uranus_bigtts"   # Vivi(2.0 多语种);西语试 explicit_language


def mask(s):
    return (s[:4] + "…" + s[-4:]) if isinstance(s, str) and len(s) >= 12 else "(过短/缺)"


# ---------------------------------------------------------------- offline

def offline():
    ok_count = 0
    fails = []

    def check(name, cond):
        nonlocal ok_count
        if cond:
            ok_count += 1
        else:
            fails.append(name)
        print(("PASS  " if cond else "FAIL  ") + name)

    mp3 = b"\xff\xfb\x90\x00" + b"fakemp3" * 8
    b64 = base64.b64encode(mp3).decode()

    # (a) SSE `data:` 行(含收尾帧 usage)
    sse = ('data: {"code":0,"data":"%s","message":""}\n\n'
           'data: {"code":20000000,"message":"ok","usage":{"text_words":7}}\n\n' % b64).encode()
    a, u = tts_shim.parse_volcano_response(sse, "text/event-stream")
    check("解析: SSE data: 行", a == mp3 and (u or {}).get("text_words") == 7)

    # (b) 连写纯 JSON(无换行,一行多对象)
    concat = ('{"code":0,"data":"%s"}{"code":20000000,"usage":{"text_words":7}}' % b64).encode()
    a, u = tts_shim.parse_volcano_response(concat)
    check("解析: 连写纯 JSON", a == mp3 and (u or {}).get("text_words") == 7)

    # (c) 二进制帧(防御分支:0x11 开头,帧内嵌 JSON payload)
    payload = json.dumps({"code": 0, "data": b64}).encode()
    frame = b"\x11\x14\x11\x00" + b"\x00" * 4 + payload
    a, _ = tts_shim.parse_volcano_response(frame, "application/octet-stream")
    check("解析: 二进制帧(防御)", a == mp3)

    # (d) 垃圾响应 → 抛错且带前 200 字节 hex
    try:
        tts_shim.parse_volcano_response(b"not-a-json-at-all")
        check("解析: 垃圾响应抛错", False)
    except tts_shim.VolcanoApiError as e:
        check("解析: 垃圾响应抛错", "first200" in str(e))

    # (e) 业务错误码 → VolcanoApiError.code(55000000 自动换 resource 的判据)
    try:
        tts_shim.parse_volcano_response(b'{"code":55000000,"message":"resource mismatch"}')
        check("解析: 业务错误码带 code", False)
    except tts_shim.VolcanoApiError as e:
        check("解析: 业务错误码带 code", e.code == 55000000)

    # 引擎分派纯函数(垫片默认档)
    check("lang_from_model", tts_shim.lang_from_model("zh_CN-huayan-medium.onnx") == "zh"
          and tts_shim.lang_from_model("D:/x/en_US-amy.onnx") == "en")
    check("pick_engine 非法值/老配置→edge",
          tts_shim.pick_engine({}) == "edge-tts"
          and tts_shim.pick_engine({"engine": "xxx"}) == "edge-tts"
          and tts_shim.pick_engine({"engine": "Volcano"}) == "volcano")
    v = {"volcano": {"zh": "zh_female_shuangkuaisisi_moon_bigtts", "es": ""}}
    check("pick_volcano_voice 空串/缺失=回退",
          tts_shim.pick_volcano_voice("zh_CN-x.onnx", v) == "zh_female_shuangkuaisisi_moon_bigtts"
          and tts_shim.pick_volcano_voice("es_MX-x.onnx", v) is None
          and tts_shim.pick_volcano_voice("en_US-x.onnx", v) is None
          and tts_shim.pick_volcano_voice("zh_CN-x.onnx", {}) is None)
    check("pick_resource_id 按音色推导(显式优先)",
          tts_shim.pick_resource_id("zh_female_wenrouxiaoya_uranus_bigtts", {}) == "seed-tts-2.0"
          and tts_shim.pick_resource_id("zh_female_shuangkuaisisi_moon_bigtts", {}) == "seed-tts-1.0"
          and tts_shim.pick_resource_id("x", {"volcanoResourceId": "seed-tts-1.0"}) == "seed-tts-1.0")
    check("clamp 恒等映射 + [-50,100] 钳位",
          tts_shim.clamp_volcano_tuning(20) == 20
          and tts_shim.clamp_volcano_tuning(-80) == -50
          and tts_shim.clamp_volcano_tuning(200) == 100)
    p = tts_shim.build_volcano_body("hi", "zh_x", 10, 0)["req_params"]
    check("请求体形状(additions 为 JSON 字符串)",
          p["speaker"] == "zh_x" and p["audio_params"]["speech_rate"] == 10
          and isinstance(p["additions"], str) and "disable_markdown_filter" in p["additions"])

    total = ok_count + len(fails)
    print("\n%d/%d 通过%s" % (ok_count, total, ("  失败: " + ", ".join(fails)) if fails else ""))
    return 1 if fails else 0


# ---------------------------------------------------------------- live

def run_cell(ep, voice, rid, text, key, kind, rate=0, volume=0, extra_params=None, tag=None):
    """一格 = 走垫片真实请求函数(_volcano_post,含超时护栏与错误体读取),返回诊断 dict。"""
    t0 = time.monotonic()
    try:
        audio, usage = tts_shim._volcano_post(URLS[ep], text, voice, rid, key, kind,
                                              rate, volume, 30.0, extra_params=extra_params)
        ms = int((time.monotonic() - t0) * 1000)
        fname = "%s--%s%s.mp3" % (ep, voice, ("--" + tag) if tag else "")
        (OUT_DIR / fname).write_bytes(audio)
        magic = audio[:3] == b"ID3" or (len(audio) > 1 and audio[0] == 0xFF and (audio[1] & 0xE0) == 0xE0)
        return {"ok": True, "ms": ms, "bytes": len(audio), "usage": tts_shim.usage_str(usage),
                "magic": bool(magic), "head": audio[:8].hex(), "file": fname}
    except tts_shim.VolcanoApiError as e:
        return {"ok": False, "ms": int((time.monotonic() - t0) * 1000), "code": e.code, "msg": str(e)[:300]}
    except Exception as e:
        return {"ok": False, "ms": int((time.monotonic() - t0) * 1000), "code": None,
                "msg": ("%s: %s" % (type(e).__name__, e))[:300]}


def describe(r):
    if r["ok"]:
        return ("OK   %6dB %5dms usage=%s magic=%s head=%s -> %s"
                % (r["bytes"], r["ms"], r["usage"] or "-", "yes" if r["magic"] else "NO!", r["head"], r["file"]))
    return "FAIL %5dms code=%s msg=%s" % (r["ms"], r["code"], r["msg"])


def live(args):
    cfg = tts_shim._read_voices(tts_shim.TOOL_DIR / "voices.local.json")
    key, kind = tts_shim.pick_volcano_key(cfg)
    if not key:
        print("未找到火山凭据 → 检查 TC_TTS_VOLCANO_API_KEY / voices.local.json.volcanoApiKey /\n"
              "  tools/voice-companion/config.json 的 stt.volcengine")
        return 2
    if kind == "apikey":
        print("凭据: X-Api-Key=%s (len=%d,新版单 Key)" % (mask(key), len(key)))
    else:
        print("凭据: 旧版 AppID=%s AccessToken=%s" % (mask(key[0]), mask(key[1])))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    text = args.text
    endpoints = ["chunked", "sse"] if args.endpoint == "both" else [args.endpoint]
    print("文本: %r(%d 字)\n" % (text, len(text)))

    wins = []
    print("== 1) 矩阵:端点 × 音色/resource ==")
    for ep in endpoints:
        for name, voice, rid in CELLS:
            r = run_cell(ep, voice, rid, text, key, kind)
            print("[%-7s] %-10s rid=%-12s %s" % (ep, name, rid, describe(r)))
            if r["ok"]:
                wins.append({"ep": ep, "name": name, "voice": voice, "rid": rid})

    if not wins:
        print("\n矩阵全失败:账号可能未开通 TTS(控制台 console.volcengine.com/speech/service/10035\n"
              "(2.0)/ service/10(1.0))或凭据无效。不接 UI,先处理账号侧。")
        return 1

    win = wins[0]

    print("\n== 2) 端到端:直接调垫片 synth_volcano(生产路径) ==")
    os.environ["TC_TTS_VOLCANO_URL"] = URLS[win["ep"]]
    try:
        audio, usage = tts_shim.synth_volcano(text, win["voice"], 0, 0, cfg)
        (OUT_DIR / "e2e.mp3").write_bytes(audio)
        print("OK   %dB usage=%s -> probe-out/e2e.mp3(端点 %s)" % (len(audio), tts_shim.usage_str(usage), win["ep"]))
        e2e_ok = True
    except Exception as e:
        print("FAIL %s: %s" % (type(e).__name__, e))
        e2e_ok = False

    print("\n== 3) resource 不匹配自动重试(故意用错 resource 开局) ==")
    if win["rid"] == "seed-tts-1.0":
        try:
            wrong = {"volcanoApiKey": key, "volcanoResourceId": "seed-tts-2.0"} if kind == "apikey" else dict(cfg, volcanoResourceId="seed-tts-2.0")
            audio, usage = tts_shim.synth_volcano(text, win["voice"], 0, 0, wrong)
            print("OK   55000000→换 resource 重试成功(%dB,看 shim.log 的「不匹配」行)" % len(audio))
        except Exception as e:
            print("注意 重试链未成功:%s: %s" % (type(e).__name__, e))
    else:
        print("跳过(首个成功音色是 2.0;反向重试同理,不额外计费)")

    print("\n== 4) tuning 生效否(speech_rate -50 / 0 / +50) ==")
    sizes = {}
    base_params = {"TC_TTS_VOLCANO_TIMEOUT": "60"}
    for r in (-50, 0, 50):
        cell = run_cell(win["ep"], win["voice"], win["rid"], text, key, kind, rate=r, tag="rate%+d" % r)
        print("rate=%+3d: %s" % (r, describe(cell)))
        if cell["ok"]:
            sizes[r] = cell["bytes"]
    if len(sizes) == 3:
        print("字节数 %s → %s" % (sizes, "单调变化,tuning 生效" if sizes[-50] < sizes[0] < sizes[50] or sizes[50] < sizes[0] < sizes[-50] else "未见明显变化(文本太短也可能)"))
    del base_params

    if args.es_probe:
        print("\n== 5) 西语探针(多语种 2.0 音色 + explicit_language=es-mx) ==")
        cell = run_cell(win["ep"], ES_VOICE, "seed-tts-2.0",
                        "Hola, esta es una prueba de voz en español.",
                        key, kind, extra_params={"explicit_language": "es-mx"}, tag="es")
        print(describe(cell))

    print("\n== SUMMARY(六问) ==")
    def cell_ok(name, rid):
        return any(w["name"] == name and w["rid"] == rid for w in wins)
    print("1) seed-tts-1.0 可用否: %s" % ("可用" if cell_ok("sissi-1.0", "seed-tts-1.0") else "不可用/未开通"))
    print("2) seed-tts-2.0 可用否: %s" % ("可用" if cell_ok("xiaoya-2.0", "seed-tts-2.0") else "不可用/未开通"))
    print("3) X-Api-Key 单凭据: %s" % ("够用(矩阵有成功格)" if kind == "apikey" else "用的是旧版双凭据,新版单 Key 未验证"))
    print("4) 端点: 成功于 %s;另一端点见上方矩阵行" % sorted({w["ep"] for w in wins}))
    print("5) tuning: 见第 4 节字节对比")
    if args.es_probe:
        print("6) 西语: 见第 5 节")
    print("\n垫片落地值(以本轮为准): engine=volcano;zh→%s;en→%s;es 视探针"
          % (next((w["voice"] for w in wins if w["name"] == "sissi-1.0"),
                  next((w["voice"] for w in wins if w["name"] == "xiaoya-2.0"), "?")),
             next((w["voice"] for w in wins if w["name"] == "tim-en-2.0"), "?")))
    return 0 if e2e_ok else 1


def main():
    ap = argparse.ArgumentParser(description="火山 TTS 探针(离线夹具 / 实网矩阵)")
    ap.add_argument("--offline", action="store_true", help="零花费:夹具断言解析器与分派纯函数")
    ap.add_argument("--live", action="store_true", help="实网矩阵(按字符计费,每格一句)")
    ap.add_argument("--endpoint", choices=["chunked", "sse", "both"], default="both")
    ap.add_argument("--text", default="这是火山引擎合成测试，一二三四五。")
    ap.add_argument("--es-probe", action="store_true", help="追加一格西语多语种探测")
    args = ap.parse_args()
    if args.offline:
        return offline()
    if args.live:
        return live(args)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
