# MANUAL —— HC-42 真麦抽验手册（人工 · ~15–20 分钟）

> 目的：唯一"人不经键盘、走真麦克风"的链路验证——PC 麦 → 浏览器（5173 leader 页）→ STT →
> 秘书真回合 → TTS 播报回放。本探针机器不可代跑；`run.ts --wave=5` 时 HC-42 恒记 `manual`，
> 等你按本手册执行并回填后，`manual-ingest.ts` 合并进报告。

## 一、准备（2 分钟）

1. 确认 dev server 在跑、**5173 leader 页**已打开（播报真出声在本页；服务端只落日志行）。
2. 点一次页面麦克风按钮授权（若用 https 通道：`https://<IP>:6201`，见 `tools/lan-https/`）。
3. 确认无正在手动操作的任务；C3 场景若在场（装了「项目B」），第⑤条才有意义——不在场则该项记
   `fail` 备注"环境不在场"，或先跑 `--env-prep=setup`。
4. 建议另开 `npx tsx tools/human-campaign/manual-ingest.ts --lookup --minutes=30` 对照证据行。

## 二、逐条执行（每条：按下说话 → 松开 → 等播报说完 → 核对现象）

| # | 话术（逐字读） | 期望现象 | 对照探针 |
|---|---|---|---|
| ① | 那个弄好了没？ | 不凭空派活；指认最近任务或反问一句 | HC-01/02 |
| ② | 怎么这么久还没好啊？！我都等半天了 | 安抚 + 查进度；**不派发** | HC-05 |
| ③ | 让团队回我一句收到 | 派发**恰 1 条**、且只到主管（界面上主管名下任务 +1） | HC-15 |
| ④ | 别做了，取消刚才那个 | 刚才任务变取消（若在办）；无新派发 | HC-21 |
| ⑤ | 让项目B的团队回我一句收到 | 路由到「项目B」主管，不串到别的项目 | HC-27 |
| ★ | 打断：趁播报**正在说话**时再次按下说话 | 当前播报立刻停止，新回合正常应答 | speechQueue 双泵 |

判定口径：`pass`=现象完全符合；`partial`=大体符合但有偏差（备注写清）；`fail`=不符合。
每条备注建议抄上 `--lookup` 里的证据 `#id`（如 `#8123 dialog out action=delegate_to_boss`）。

## 三、回填（3 分钟）

```bash
cp tools/human-campaign/manual-fills.template.json tools/human-campaign/manual-fills.local.json
# 编辑 manual-fills.local.json：每次 verdict 填 pass|fail|partial，note 写现象+证据#id
npx tsx tools/human-campaign/manual-ingest.ts            # 默认合并进最新报告
```

全部 `pass` → 退出码 0；有 `fail/partial` 或未填 → 1（报告相应探针转 fail/manual）。
回填文件与报告均 gitignored；战役记录里只落精摘要。

## 四、常见问题

- **没声音**：先确认是 5173 leader 页（不是别的标签/窗口）；TTS 引擎见工具箱「文字转语音」
  （换声写入 `voices.local.json`，勿动 `tts.ts`）。
- **麦没反应**：刷新后重新授权；iOS/远程设备必须 https（6201）。
- **⑤ 路由到别家**：先记 `fail` + 证据行，属缺陷候选，不在现场调试。
- **播报不打断**：记 `fail`（双泵语义见 `client/voice/speechQueue.ts`）。
