# character-forge · 办公白领迷你角色生成器

程序化生成「办公白领」风格的 3D 智能体角色,在**骨架、体量、材质、动画**四个维度上与项目内置的
Kenney Mini Characters 逐项对齐 —— 这样自制角色和原版角色同场出现时不会「一眼看出不是一套」。

**为什么不下载现成素材**:免费素材库里的职业角色风格/骨骼/命名互不相同,拿来做智能体头像会和
场里其他 12 个 Kenney 角色打架;程序化生成可以精确对齐,顺带零版权风险。

---

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `generate.mjs` | 生成器:骨架 + 部件库 + 参数表 + 角色定义 + 动画移植,输出 GLB |
| `distinct.mjs` | 去重自检:算两两「撞脸」相似度,新增角色前先跑 |
| `analyze.mjs` | 量原版模型:节点层级、关节静止位姿、按关节分组的顶点包围盒、动画名 |
| `viewer.html` / `viewer.js` | 预览台(浏览器):最左 Kenney 原版参照 + 全部自制角色一字排开,同步播动画 |
| `preview/*.png` | 截图存档(20–25 为当前批次;01–16 是加个性化维度之前的旧存档) |

## 用法

```bash
node tools/character-forge/generate.mjs                    # 生成全部角色
node tools/character-forge/generate.mjs office-female-*    # 支持通配
node tools/character-forge/generate.mjs office-male-suit-navy

node tools/character-forge/distinct.mjs                    # 去重自检(必跑)
node tools/character-forge/distinct.mjs 0.8                # 自定义阈值

# 量原版模型(改部件尺寸前先量,别猜)
node tools/character-forge/analyze.mjs public/assets/characters/character-female-a.glb

# 预览(需要 vite dev server 在跑)
#   http://localhost:5173/tools/character-forge/viewer.html
```

输出到 `public/assets/characters/office/<name>.glb`,单个约 165–210 KB / 1200–1700 三角面。

## 角色清单(8 个,刻意做到互相一眼可分)

| 名字 | 发型/发色 | 眼镜 | 脸 | 体型 | 主色 |
| --- | --- | --- | --- | --- | --- |
| `office-male-suit` | 短寸 · 炭黑 | 方框 | — | 中等 | 石板灰蓝西装 + 红领带 |
| `office-male-suit-black` | 背头 · 深棕 | 无 | — | 高瘦 | 黑西装 + 琥珀条纹领带 |
| `office-male-suit-navy` | 寸头 · 银灰 | 细金属框 | — | 矮壮 | 藏青西装 + 蓝领带 |
| `office-male-casual-vest` | 三七分 · 亚麻金 | 圆框 | 八字胡 | 中等偏壮 | 墨绿马甲 + 浅蓝衬衫(无领带) |
| `office-male-casual-shirt` | 秃顶 · 银白 | 墨镜 | 络腮胡 | 高个 | 白衬衫挽袖 + 棕卡其裤 |
| `office-female-skirt` | 披肩长发 · 栗棕 | 方框 | — | 清瘦 | 酒红套裙 + 金领巾 |
| `office-female-skirt-bun` | 发髻 · 银白 | 无 | — | 矮个 | 驼色套裙 + 铁锈红领巾 |
| `office-female-pants` | 马尾 · 紫黑 | 细金属框 | 耳麦 | 高瘦 | 紫灰裤装 + 青绿领结 |

8 个人的发型、发色、眼镜、身高体型、主色几乎两两都不同 —— 这是刻意的:
头占整个角色视觉面积的一大半,发型/发色/眼镜才是远距离识别的关键,衣服颜色是第二位的。

## 个性化参数(改角色只动这里)

角色 = 一组参数的组合,定义在 `generate.mjs` 末尾的 `CHARACTERS`:

| 参数 | 取值 |
| --- | --- |
| `hair` | `short` `buzz` `slick` `side` `long` `bob` `ponytail` `bun` `bald` |
| `glasses` | `none` `square` `round` `sun` `half`(细金属框) |
| `facial` | `none` `mustache` `beard` |
| `headset` | `none` `mic`(单耳耳麦) |
| `height` | `short` 0.93 / `normal` 1.0 / `tall` 1.07 |
| `build` | `slim` 0.94 / `normal` 1.0 / `stocky` 1.07 |
| `torso` | `suit` `vest` `casual`(开领衬衫) `blouse`(女式收腰) |
| `bottom` | `pants` `pants-slim` `skirt` |
| `arms` | `suit` `slim` `shirt` `rolled`(挽袖露小臂) |
| `tie` | `solid` `stripe` `bow`(领巾) `none` |
| `shoeSize` | `normal` / `small` |
| `colors` | `palette({...})`,可覆盖 `skin hair eyes suit shirt tie pants shoes sole skirt vest gear` |

身高/体型是对 `root` 的缩放(不是改几何),关节位姿一起缩放,所以动画照常、脚底仍贴地。

## 去重自检(distinct.mjs)

新增角色后**必须**跑一遍:

```bash
node tools/character-forge/distinct.mjs
```

它从 GLB 里按**三角形面积加权**统计颜色直方图(6×6×6 sRGB)+ 身高,
两两算相似度 = `0.85 × 直方图交集 + 0.15 × 身高接近度`,超阈值(默认 0.85)标 ⚠。

用面积加权是因为「看起来是什么颜色」取决于面积占比:领带再亮也只占不到 2% 面积,
在统计里就该只占很小权重 —— 这也正是「只换领带颜色不够区分」的量化解释。

当前 8 个角色的最高分是 **0.673**(`office-female-pants` ↔ `office-male-suit`),全部合格。

## 骨架(与原作者 12 个角色逐位一致)

```
root (0, 0, 0)
├─ leg-left  ( 0.0836, 0.1762, -0.0288)
├─ leg-right (-0.0836, 0.1762, -0.0288)
└─ torso     ( 0,      0.1762, -0.0288)
   ├─ arm-left  ( 0.0999, 0.1115, 0.0115)   ← 相对 torso
   ├─ arm-right (-0.0999, 0.1115, 0.0115)
   └─ head      ( 0,      0.167,  0.0264)
```

7 个关节、身高 0.6713、脚底 y=0、面朝 +Z —— 全部来自 `analyze.mjs` 对原版的实测,
所以原版动画数据、应用内的缩放/朝向逻辑都天然兼容。

**绑定方式**:刚性单关节(和原版一样,没有蒙皮权重插值)。每个部件 `box()` 挂到某个关节下,
整体跟随该关节运动 —— 裙子挂 `torso`、头发挂 `head`、裤腿挂各自的 `leg`。
因此导出的是「节点动画 + 刚体子网格」,不是 SkinnedMesh;three.js 的 `AnimationMixer` 原生支持。

## 动画

- **移植**:`character-male-a.glb` 里的原版动画,按关节名回放进自制骨架(Kenney 素材 CC0,
  移植无版权问题)。因为关节名/位姿逐位一致,动作数据可以直接复用,不需要重定向。
- **自制**:`working`(伏案打字,1.2s 循环 —— 双臂交替敲击 + 点头 + 躯干前倾 7°)。
  原版 32 条动画里没有「办公」语义,所以补了这一条。

### ⚠️ 导出顺序是有约束的

应用内 `SkillsPanel.tsx` 上传自定义角色时会自动映射动画,用的是**「第一个命中的赢」**:

| 语义槽 | 命中规则 |
| --- | --- |
| idle | 第一个名字含 `idle` 或等于 `static` 的 |
| walk | 第一个含 `walk` / `run` 的 |
| working | 第一个含 `work` / `action` / `attack` / `jump` 的 |

所以 `CLIP_ORDER` 必须是 `['idle', 'walk', 'working', 'static', ...]` ——
如果 `static` 排在 `idle` 前面,idle 槽会被 `static` 抢占;如果 `working` 不在前面,
working 槽会落到 `jump` 上(原版动画里 `jump` 排在 `working` 之前)。
**改 `CLIP_ORDER` 前先读 `SkillsPanel.tsx` 的自动映射代码。**

## 加一个新角色

1. 先在 `CHARACTERS` 里加一条参数组合(参考上面的参数表):

```js
'office-female-suit-crimson': {
  label: '白领女 · 酒红套装 / 波波头',
  height: 'normal',
  build: 'normal',
  hair: 'bob',
  glasses: 'round',
  facial: 'none',
  headset: 'none',
  torso: 'blouse',
  bottom: 'skirt',
  arms: 'slim',
  tie: 'bow',
  shoeSize: 'small',
  colors: palette({ skin: SKIN.tan, suit: '#6b2737', skirt: '#6b2737', shirt: '#f2ece2', tie: '#ffc044', hair: '#2f2620' }),
},
```

2. `node tools/character-forge/generate.mjs office-female-suit-crimson`
3. `node tools/character-forge/distinct.mjs` —— 超阈值就回来换 `hair` / 主色 / `height`|`build` 再生成。

`palette()` 会补上皮肤/眼睛/鞋底等默认色,`validateSpec()` 会检查枚举参数拼错(拼错直接报错,不静默降级);
颜色键缺了也会报错。肤色预设:`SKIN.light` / `SKIN.tan` / `SKIN.deep`。

改部件尺寸就改「部件库」里对应的 `addXxx()` —— 数值都注了出处,改之前先 `analyze.mjs` 量原版。

## 接入应用(零改码)

不用改 `AGENT_CLASS_MODELS`:走应用的「自定义角色类」上传入口
(SkillsPanel → 上传 GLB),选文件时会自动算好动画映射,保存即可用。

## 已知取舍

- 裙摆绑在 `torso` 上(骨架里没有裙骨),走路摆腿幅度大时理论上可能穿模;
  现在的裙摆尺寸按 ±60° 摆腿验算过,实测不穿。
- 头发/裙子都是刚性跟随,没有布料效果 —— 与原版同款做法。
- 颜色比原版色板略扩了几个(黑/藏青/酒红等深色),保持同一明度区间,不改变整体观感。
- 身高体型靠 `root` 缩放实现,0.93–1.11× 之间(原版 12 个角色本身也在 0.67–0.78 之间浮动,
  所以这个幅度是「原版风格内」的)。如果应用里有按固定身高定位的装饰(名牌/选中环),
  极端身高可能略有偏差 —— 目前没发现这类依赖。
