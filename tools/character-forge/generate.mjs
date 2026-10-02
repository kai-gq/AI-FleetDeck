#!/usr/bin/env node
/**
 * character-forge —— 程序化生成「办公白领」迷你角色(风格对齐 Kenney Mini Characters)
 *
 * 为什么要自制:下载素材风格/骨骼/命名各不相同,混进现有 12 个 Kenney 角色会不协调。
 * 本脚本用与 Kenney 完全一致的 7 关节骨架、同样的身高基准(0.6713)、同样的斜切方块语言,
 * 程序化拼出办公着装,并把 Kenney 原版动画(CC0)按关节名移植过来,
 * 另自制办公语义动画(working = 伏案打字)。
 *
 * 角色 = 一组「个性化参数」的组合(发型/发色/肤色/眼镜/胡须/体型/配色/上衣款式…),
 * 参数在下方 CHARACTERS 里;两两是否"撞脸"用 `node tools/character-forge/distinct.mjs` 自检。
 *
 * 用法:
 *   node tools/character-forge/generate.mjs                    # 生成全部角色
 *   node tools/character-forge/generate.mjs office-female-*    # 支持通配
 *
 * 输出: public/assets/characters/office/<name>.glb
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const KENNEY_SRC = path.join(REPO, 'public', 'assets', 'characters', 'character-male-a.glb');
const OUT_DIR = path.join(REPO, 'public', 'assets', 'characters', 'office');

// ---------------------------------------------------------------------------
// Node 垫片:GLTFExporter 的 GLB 输出路径用了浏览器 FileReader
// ---------------------------------------------------------------------------
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReaderShim {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        if (typeof this.onloadend === 'function') this.onloadend();
      });
    }
  };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

// ---------------------------------------------------------------------------
// GLB 读写 / 去纹理(解析源文件只需要动画数据,去掉贴图引用即可在 Node 里无 DOM 解析)
// ---------------------------------------------------------------------------
const GLB_MAGIC = 0x46546c67;

function readGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('不是 GLB 文件');
  let off = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf-8'));
    else if (type === 0x004e4942) bin = Buffer.from(data);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk');
  return { json, bin };
}

function writeGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf-8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBuf = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(GLB_MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jHead = Buffer.alloc(8);
  jHead.writeUInt32LE(jsonBuf.length, 0);
  jHead.writeUInt32LE(0x4e4f534a, 4);
  const bHead = Buffer.alloc(8);
  bHead.writeUInt32LE(binBuf.length, 0);
  bHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jHead, jsonBuf, bHead, binBuf]);
}

/** 去掉贴图引用,让 GLTFLoader 在 Node(无 DOM)下也能解析 */
function stripTextures(json) {
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const mat of json.materials ?? []) {
    const pbr = mat.pbrMetallicRoughness;
    if (pbr) {
      delete pbr.baseColorTexture;
      delete pbr.metallicRoughnessTexture;
      delete pbr.normalTexture;
      delete pbr.occlusionTexture;
      delete pbr.emissiveTexture;
    }
    if (mat.extensions) {
      delete mat.extensions.KHR_texture_transform;
      if (Object.keys(mat.extensions).length === 0) delete mat.extensions;
    }
  }
  if (json.extensionsUsed) {
    json.extensionsUsed = json.extensionsUsed.filter((e) => e !== 'KHR_texture_transform');
    if (json.extensionsUsed.length === 0) delete json.extensionsUsed;
  }
  return json;
}

// ---------------------------------------------------------------------------
// 骨架:与 Kenney Mini Characters 完全一致的 7 关节
// ---------------------------------------------------------------------------
const RIG = [
  ['root', null, [0, 0, 0]],
  ['leg-left', 'root', [0.0836, 0.1762, -0.0288]],
  ['leg-right', 'root', [-0.0836, 0.1762, -0.0288]],
  ['torso', 'root', [0, 0.1762, -0.0288]],
  ['arm-left', 'torso', [0.0999, 0.1115, 0.0115]],
  ['arm-right', 'torso', [-0.0999, 0.1115, 0.0115]],
  ['head', 'torso', [0, 0.167, 0.0264]],
];

function buildRig() {
  const nodes = {};
  for (const [name, parent, pos] of RIG) {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(...pos);
    nodes[name] = g;
    if (parent) nodes[parent].add(g);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// 几何:斜切方块 —— Kenney 迷你角色的关键视觉语言(直角盒像 Minecraft,
// 圆角盒太贵且不是原版的平斜切风格)。非索引 + 平坦法线,44 面/件。
// rX/rY/rZ 可分轴指定,用来做「圆片」之类的异形(如圆框镜片)。
// ---------------------------------------------------------------------------
function chamferBoxGeometry(w, h, d, rX, rY, rZ) {
  const half = [w / 2, h / 2, d / 2];
  const r = [rX, rY, rZ].map((v, i) => Math.min(v, half[i] * 0.9));
  const c = [half[0] - r[0], half[1] - r[1], half[2] - r[2]];
  const corner = (sx, sy, sz) => [
    [sx * half[0], sy * c[1], sz * c[2]], // 属于 ±X 面的顶点
    [sx * c[0], sy * half[1], sz * c[2]], // 属于 ±Y 面的顶点
    [sx * c[0], sy * c[1], sz * half[2]], // 属于 ±Z 面的顶点
  ];
  const pos = [];
  const tri = (a, b, cc) => {
    // 凸体且中心在原点:按质心方向校正绕序,保证法线朝外
    const nx = (b[1] - a[1]) * (cc[2] - a[2]) - (b[2] - a[2]) * (cc[1] - a[1]);
    const ny = (b[2] - a[2]) * (cc[0] - a[0]) - (b[0] - a[0]) * (cc[2] - a[2]);
    const nz = (b[0] - a[0]) * (cc[1] - a[1]) - (b[1] - a[1]) * (cc[0] - a[0]);
    const gx = a[0] + b[0] + cc[0], gy = a[1] + b[1] + cc[1], gz = a[2] + b[2] + cc[2];
    if (nx * gx + ny * gy + nz * gz < 0) pos.push(...a, ...cc, ...b);
    else pos.push(...a, ...b, ...cc);
  };
  const quad = (a, b, cc, d2) => {
    tri(a, b, cc);
    tri(a, cc, d2);
  };
  const cyc = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (const sx of [1, -1]) quad(...cyc.map(([sy, sz]) => corner(sx, sy, sz)[0]));
  for (const sy of [1, -1]) quad(...cyc.map(([sx, sz]) => corner(sx, sy, sz)[1]));
  for (const sz of [1, -1]) quad(...cyc.map(([sx, sy]) => corner(sx, sy, sz)[2]));
  for (const sx of [1, -1]) for (const sy of [1, -1])
    quad(corner(sx, sy, 1)[0], corner(sx, sy, 1)[1], corner(sx, sy, -1)[1], corner(sx, sy, -1)[0]);
  for (const sx of [1, -1]) for (const sz of [1, -1])
    quad(corner(sx, 1, sz)[0], corner(sx, 1, sz)[2], corner(sx, -1, sz)[2], corner(sx, -1, sz)[0]);
  for (const sy of [1, -1]) for (const sz of [1, -1])
    quad(corner(1, sy, sz)[1], corner(1, sy, sz)[2], corner(-1, sy, sz)[2], corner(-1, sy, sz)[1]);
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) tri(...corner(sx, sy, sz));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function makeMaterials(colors) {
  const cache = new Map();
  return (hex) => {
    if (!cache.has(hex)) {
      cache.set(
        hex,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(hex),
          roughness: 1,
          metalness: 0, // 与 Kenney 材质一致(metallic=0)
        })
      );
    }
    return cache.get(hex);
  };
}

/** chamfer 传数字 = 三轴同值,传 [rX,rY,rZ] 可分轴;默认 min(0.022, 最小边 × 0.3) */
function box(matOf, parent, color, size, pos, rotDeg = null, chamfer = null) {
  const [w, h, d] = size;
  const r = chamfer == null ? Math.min(0.022, Math.min(w, h, d) * 0.3) : chamfer;
  const [rX, rY, rZ] = Array.isArray(r) ? r : [r, r, r];
  const geo = Math.max(rX, rY, rZ) > 0.003 ? chamferBoxGeometry(w, h, d, rX, rY, rZ) : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, matOf(color));
  mesh.position.set(...pos);
  if (rotDeg) {
    mesh.rotation.set(
      THREE.MathUtils.degToRad(rotDeg[0] ?? 0),
      THREE.MathUtils.degToRad(rotDeg[1] ?? 0),
      THREE.MathUtils.degToRad(rotDeg[2] ?? 0)
    );
  }
  parent.add(mesh);
  return mesh;
}

// Quaternion 帮助函数(角度制)
const D = THREE.MathUtils.degToRad;
function quat(ax, ay, az) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(D(ax), D(ay), D(az), 'XYZ'));
}

// ---------------------------------------------------------------------------
// 参数表(个性化维度)
// ---------------------------------------------------------------------------
const HAIR_STYLES = ['short', 'buzz', 'slick', 'side', 'long', 'bob', 'ponytail', 'bun', 'bald'];
const GLASSES_STYLES = ['none', 'square', 'round', 'sun', 'half'];
const FACIAL_STYLES = ['none', 'mustache', 'beard'];
const HEADSET_STYLES = ['none', 'mic'];
/** 体型 → root 的 x/z 缩放(肩宽/胖瘦) */
const BUILD = { slim: 0.94, normal: 1.0, stocky: 1.07 };
/** 身高 → root 的 y 缩放。等比缩放不影响动画(关节位姿一起缩放,脚底仍贴地) */
const HEIGHT = { short: 0.93, normal: 1.0, tall: 1.07 };

// ---------------------------------------------------------------------------
// 部件库:所有角色共用这些积木
// 尺寸来源 = 对原版 12 个角色的顶点级测量(node tools/character-forge/analyze.mjs <glb>)
// 坐标均为「相对所属关节」,脚底 y = 0,前方 = +Z。
// 关节绝对位置:leg (±0.0836, 0.1762, -0.0288) / torso (0, 0.1762, -0.0288)
//               arm (±0.0999, 0.2878, -0.0173) / head (0, 0.3432, -0.0024)
// ---------------------------------------------------------------------------

function addShoes(c, leg, small = false) {
  const w = small ? 0.118 : 0.132;
  const d = small ? 0.168 : 0.178;
  c(leg, 'shoes', [w, 0.028, d], [0, -0.149, 0.024]); // 鞋面
  c(leg, 'sole', [w - 0.006, 0.015, d - 0.006], [0, -0.1685, 0.024]); // 浅色鞋底
}

function addPantsLeg(c, leg, slim = false) {
  c(leg, 'pants', slim ? [0.122, 0.16, 0.128] : [0.135, 0.16, 0.14], [0, -0.083, 0.012]);
}

/** 裙装时的小腿(裙子盖到 abs y≈0.095,以下露皮肤) */
function addBareLeg(c, leg) {
  c(leg, 'skin', [0.112, 0.152, 0.118], [0, -0.09, 0.008]);
}

/** A 字裙(绑在 torso 关节;下摆 abs y≈0.095,按 ±60° 摆腿验算过不穿模) */
function addSkirt(c, torso) {
  c(torso, 'skirt', [0.29, 0.042, 0.24], [0, -0.009, 0.009]); // 裙腰
  c(torso, 'skirt', [0.36, 0.056, 0.29], [0, -0.054, 0.009]); // 裙摆
}

/** 领带 / 领巾:tie = solid(素色) | stripe(条纹) | bow(领巾) | none */
function addTie(c, torso, spec, zf) {
  if (spec.tie === 'none' || spec.tie == null) return;
  if (spec.tie === 'bow') {
    c(torso, 'tie', [0.044, 0.028, 0.02], [0, 0.116, zf + 0.012]); // 领巾结
    c(torso, 'tie', [0.028, 0.04, 0.02], [0.027, 0.079, zf + 0.012]);
    c(torso, 'tie', [0.028, 0.04, 0.02], [-0.027, 0.079, zf + 0.012]);
    return;
  }
  c(torso, 'tie', [0.058, 0.03, 0.02], [0, 0.1215, zf + 0.014]); // 领带结
  c(torso, 'tie', [0.046, 0.09, 0.02], [0, 0.0535, zf + 0.014]); // 领带
  if (spec.tie === 'stripe') {
    for (const y of [0.032, 0.072]) c(torso, 'shirt', [0.048, 0.013, 0.022], [0, y, zf + 0.014]); // 亮色条纹
  }
}

/** 男式西装上身:西服 + 衬衫前襟 + 领带 + 领口 */
function addSuitTorso(c, torso, spec, { w = 0.3022, d = 0.22 } = {}) {
  const zf = d / 2;
  c(torso, 'suit', [w, 0.167, d], [0, 0.0835, 0]);
  c(torso, 'shirt', [0.11, 0.13, 0.02], [0, 0.0755, zf + 0.002]);
  addTie(c, torso, spec, zf);
  c(torso, 'shirt', [0.15, 0.022, 0.022], [0, 0.1555, zf + 0.003]); // 领口
}

/** 女式西服上身:收腰外套 + 衬衫 V 领 + 领巾 */
function addBlouseTorso(c, torso, spec, { w = 0.2811, d = 0.235 } = {}) {
  const zf = d / 2;
  c(torso, 'suit', [w, 0.167, d], [0, 0.0835, 0]);
  c(torso, 'shirt', [0.085, 0.122, 0.02], [0, 0.0755, zf + 0.002]);
  addTie(c, torso, spec, zf);
  c(torso, 'shirt', [0.058, 0.032, 0.018], [-0.034, 0.152, zf + 0.002], [0, 0, -38]); // 衬衫领(左)
  c(torso, 'shirt', [0.058, 0.032, 0.018], [0.034, 0.152, zf + 0.002], [0, 0, 38]); // 衬衫领(右)
}

/** 马甲款:衬衫本体 + 左右马甲前片 + 后片(前中留缝露出衬衫) */
function addVestTorso(c, torso, spec, { w = 0.277, d = 0.2 } = {}) {
  c(torso, 'shirt', [w, 0.167, d], [0, 0.0835, -0.005]);
  c(torso, 'vest', [0.088, 0.169, d + 0.015], [0.1005, 0.0835, -0.002]);
  c(torso, 'vest', [0.088, 0.169, d + 0.015], [-0.1005, 0.0835, -0.002]);
  c(torso, 'vest', [0.115, 0.169, 0.045], [0, 0.0835, -d / 2 - 0.003]);
  c(torso, 'shirt', [0.14, 0.022, 0.022], [0, 0.1555, d / 2 - 0.002]);
}

/** 开领休闲衬衫:衬衫 + 敞开领口 */
function addCasualShirtTorso(c, torso, spec, { w = 0.29, d = 0.21 } = {}) {
  const zf = d / 2;
  c(torso, 'shirt', [w, 0.167, d], [0, 0.0835, 0]);
  c(torso, 'skin', [0.062, 0.05, 0.02], [0, 0.14, zf - 0.004]); // 敞领露出的颈部
  c(torso, 'shirt', [0.08, 0.042, 0.02], [-0.045, 0.146, zf - 0.002], [0, 0, -40]);
  c(torso, 'shirt', [0.08, 0.042, 0.02], [0.045, 0.146, zf - 0.002], [0, 0, 40]);
}

/** 手臂(袖 + 手),臂骨沿 ±X 呈 T-pose */
function addArm(c, arm, s, style) {
  const styles = {
    suit: [
      ['suit', [0.2, 0.15, 0.16], [0.115, 0, 0.012]],
      ['skin', [0.105, 0.125, 0.135], [0.2625, 0, 0.012]],
    ],
    slim: [
      ['suit', [0.195, 0.128, 0.14], [0.113, 0, 0.012]],
      ['skin', [0.095, 0.108, 0.118], [0.2575, 0, 0.012]],
    ],
    shirt: [
      ['shirt', [0.2, 0.148, 0.158], [0.115, 0, 0.012]],
      ['skin', [0.105, 0.125, 0.135], [0.2625, 0, 0.012]],
    ],
    rolled: [
      ['shirt', [0.16, 0.148, 0.155], [0.105, 0, 0.012]], // 挽起的袖子
      ['skin', [0.105, 0.102, 0.112], [0.235, 0, 0.012]], // 小臂
      ['skin', [0.09, 0.105, 0.115], [0.315, 0, 0.012]], // 手
    ],
  };
  for (const [colorKey, size, [x, y, z]] of styles[style]) c(arm, colorKey, size, [s * x, y, z]);
}

function addHeadBase(c, head, { w = 0.4, h = 0.3, d = 0.3 } = {}) {
  c(head, 'skin', [0.1, 0.035, 0.1], [0, 0.004, 0.02]); // 颈
  c(head, 'skin', [w, h, d], [0, 0.155, 0.005]); // 头
  c(head, 'skin', [0.035, 0.075, 0.07], [w / 2 + 0.005, 0.125, 0]); // 耳
  c(head, 'skin', [0.035, 0.075, 0.07], [-(w / 2 + 0.005), 0.125, 0]);
}

/**
 * 头发。头部宽 0.40 / 身高 0.6713 —— 头占了整个角色视觉面积的一大半,
 * 所以「发型 + 发色」是远距离识别度最高的两个参数,务必让人人不同。
 */
function addHair(c, head, style) {
  const top = () => c(head, 'hair', [0.43, 0.08, 0.32], [0, 0.29, 0]); // 发顶
  if (style === 'bald') {
    for (const sx of [1, -1]) c(head, 'hair', [0.05, 0.05, 0.28], [sx * 0.195, 0.26, -0.01]); // 两侧一圈
    c(head, 'hair', [0.36, 0.1, 0.06], [0, 0.245, -0.15]); // 后脑一圈
    return;
  }
  if (style === 'buzz') {
    c(head, 'hair', [0.415, 0.045, 0.315], [0, 0.3, 0]); // 贴头皮薄壳
    c(head, 'hair', [0.415, 0.14, 0.07], [0, 0.235, -0.135]);
    return;
  }
  if (style === 'slick') {
    c(head, 'hair', [0.43, 0.075, 0.33], [0, 0.295, 0.005]);
    c(head, 'hair', [0.4, 0.06, 0.09], [0, 0.325, 0.125]); // 前额上翘
    c(head, 'hair', [0.43, 0.2, 0.1], [0, 0.205, -0.115]);
    return;
  }
  if (style === 'side') {
    top();
    c(head, 'hair', [0.24, 0.055, 0.05], [0.075, 0.253, 0.135]); // 侧扫刘海(偏一侧)
    c(head, 'hair', [0.1, 0.045, 0.04], [-0.135, 0.258, 0.13]);
    c(head, 'hair', [0.43, 0.19, 0.1], [0, 0.21, -0.115]);
    return;
  }
  top();
  if (style === 'short') {
    c(head, 'hair', [0.43, 0.19, 0.1], [0, 0.21, -0.115]);
    c(head, 'hair', [0.41, 0.06, 0.04], [0, 0.245, 0.14]);
  } else if (style === 'long') {
    c(head, 'hair', [0.42, 0.36, 0.115], [0, 0.125, -0.155]); // 披到肩
    c(head, 'hair', [0.055, 0.24, 0.22], [0.2, 0.145, -0.03]);
    c(head, 'hair', [0.055, 0.24, 0.22], [-0.2, 0.145, -0.03]);
    c(head, 'hair', [0.09, 0.1, 0.03], [0.17, 0.21, 0.135]);
    c(head, 'hair', [0.09, 0.1, 0.03], [-0.17, 0.21, 0.135]);
    c(head, 'hair', [0.41, 0.06, 0.04], [0, 0.245, 0.14]);
  } else if (style === 'bob') {
    c(head, 'hair', [0.42, 0.26, 0.11], [0, 0.18, -0.15]);
    c(head, 'hair', [0.06, 0.2, 0.2], [0.195, 0.165, -0.02]);
    c(head, 'hair', [0.06, 0.2, 0.2], [-0.195, 0.165, -0.02]);
    c(head, 'hair', [0.41, 0.06, 0.04], [0, 0.245, 0.14]);
  } else if (style === 'ponytail') {
    c(head, 'hair', [0.43, 0.17, 0.1], [0, 0.225, -0.12]);
    c(head, 'hair', [0.1, 0.09, 0.1], [0, 0.31, -0.17]); // 发根
    c(head, 'hair', [0.11, 0.26, 0.115], [0, 0.185, -0.185]); // 垂下的马尾
    c(head, 'hair', [0.41, 0.06, 0.04], [0, 0.245, 0.14]);
  } else if (style === 'bun') {
    c(head, 'hair', [0.43, 0.19, 0.1], [0, 0.21, -0.115]);
    c(head, 'hair', [0.15, 0.145, 0.145], [0, 0.315, -0.16]); // 发髻
    c(head, 'hair', [0.41, 0.06, 0.04], [0, 0.245, 0.14]);
  }
}

/** 五官:眼镜 5 款 + 胡须 3 款 + 耳麦 */
function addFace(c, head, spec) {
  const g = spec.glasses ?? 'square';
  const faceZ = 0.155; // 头前表面
  if (g === 'none') {
    for (const sx of [1, -1]) {
      c(head, 'eyes', [0.045, 0.055, 0.016], [sx * 0.075, 0.128, faceZ + 0.002]); // 眼
      c(head, 'hair', [0.062, 0.013, 0.014], [sx * 0.075, 0.168, faceZ + 0.002]); // 眉
    }
  } else if (g === 'square') {
    for (const sx of [1, -1]) {
      c(head, 'hair', [0.112, 0.096, 0.012], [sx * 0.077, 0.13, faceZ - 0.003]);
      c(head, 'shirt', [0.095, 0.08, 0.014], [sx * 0.077, 0.13, faceZ + 0.002]);
      c(head, 'eyes', [0.022, 0.03, 0.014], [sx * 0.077, 0.127, faceZ + 0.006]);
      c(head, 'hair', [0.012, 0.014, 0.13], [sx * 0.138, 0.135, 0.09]);
    }
    c(head, 'hair', [0.048, 0.014, 0.012], [0, 0.132, faceZ + 0.001]);
  } else if (g === 'round') {
    // 用大圆角切出八边形镜片,视觉上接近圆框
    for (const sx of [1, -1]) {
      c(head, 'hair', [0.108, 0.1, 0.012], [sx * 0.077, 0.13, faceZ - 0.003], null, [0.046, 0.042, 0.005]);
      c(head, 'shirt', [0.098, 0.09, 0.014], [sx * 0.077, 0.13, faceZ + 0.002], null, [0.042, 0.038, 0.006]);
      c(head, 'eyes', [0.022, 0.03, 0.014], [sx * 0.077, 0.127, faceZ + 0.006]);
      c(head, 'hair', [0.012, 0.014, 0.12], [sx * 0.138, 0.135, 0.09]);
    }
    c(head, 'hair', [0.05, 0.012, 0.012], [0, 0.132, faceZ + 0.001]);
  } else if (g === 'sun') {
    c(head, 'gear', [0.31, 0.088, 0.022], [0, 0.132, faceZ + 0.004], null, [0.012, 0.03, 0.005]); // 一整条墨镜(深色镜片)
    c(head, 'gear', [0.318, 0.016, 0.016], [0, 0.178, faceZ + 0.004]); // 镜框上沿
    for (const sx of [1, -1]) c(head, 'gear', [0.012, 0.014, 0.12], [sx * 0.155, 0.14, 0.09]);
  } else if (g === 'half') {
    // 细金属框(无镜片挡脸):只有细上梁 + 外侧立柱 + 镜腿,眼睛完全露出。
    // 和粗白镜片的 square 在远处也一眼能分。
    for (const sx of [1, -1]) {
      c(head, 'hair', [0.104, 0.012, 0.014], [sx * 0.077, 0.158, faceZ + 0.002]); // 上沿
      c(head, 'hair', [0.104, 0.012, 0.014], [sx * 0.077, 0.1, faceZ + 0.002]);   // 下沿(没它远看像一道眉)
      c(head, 'hair', [0.012, 0.07, 0.014], [sx * 0.129, 0.129, faceZ + 0.002]); // 外侧立柱
      c(head, 'eyes', [0.042, 0.048, 0.016], [sx * 0.077, 0.129, faceZ + 0.002]); // 眼睛(露出)
      c(head, 'hair', [0.012, 0.014, 0.12], [sx * 0.138, 0.135, 0.09]);           // 镜腿
    }
    c(head, 'hair', [0.05, 0.01, 0.012], [0, 0.158, faceZ + 0.001]); // 鼻梁
  }
  // 胡须
  // y=0.07:在镜片下沿(0.081)之下,戴眼镜时不会被镜片挡住
  if (spec.facial === 'mustache') {
    c(head, 'hair', [0.075, 0.018, 0.022], [0, 0.07, faceZ + 0.004]);
  } else if (spec.facial === 'beard') {
    c(head, 'hair', [0.145, 0.06, 0.03], [0, 0.04, faceZ - 0.006]); // 下巴
    for (const sx of [1, -1]) c(head, 'hair', [0.026, 0.1, 0.026], [sx * 0.078, 0.075, faceZ - 0.004]); // 络腮
    c(head, 'hair', [0.075, 0.016, 0.022], [0, 0.07, faceZ + 0.004]); // 胡子
  }
  // 耳麦(挂右耳)
  if (spec.headset === 'mic') {
    c(head, 'gear', [0.05, 0.075, 0.075], [0.208, 0.125, 0.02]);
    c(head, 'gear', [0.016, 0.016, 0.17], [0.185, 0.1, 0.09]);
    c(head, 'gear', [0.032, 0.032, 0.032], [0.185, 0.098, 0.18]);
  }
}

/** 按参数拼一个完整角色 */
function buildCharacter(spec) {
  return (nodes, c) => {
    const { 'leg-left': legL, 'leg-right': legR, torso, 'arm-left': armL, 'arm-right': armR, head } = nodes;
    for (const leg of [legL, legR]) {
      if (spec.bottom === 'skirt') addBareLeg(c, leg);
      else addPantsLeg(c, leg, spec.bottom === 'pants-slim');
      addShoes(c, leg, spec.shoeSize === 'small');
    }
    if (spec.bottom === 'skirt') addSkirt(c, torso);
    const torsos = {
      suit: addSuitTorso,
      vest: addVestTorso,
      casual: addCasualShirtTorso,
      blouse: addBlouseTorso,
    };
    torsos[spec.torso](c, torso, spec);
    for (const [arm, s] of [[armL, 1], [armR, -1]]) addArm(c, arm, s, spec.arms);
    addHeadBase(c, head);
    addHair(c, head, spec.hair ?? 'short');
    addFace(c, head, spec);
  };
}

// ---------------------------------------------------------------------------
// 角色定义 = 个性化参数组合
// 设计约束(用 distinct.mjs 自检):任意两人的主色相、发型、体型至少各差一项。
// ---------------------------------------------------------------------------
const COLORS_DEFAULT = { skin: '#f2bf99', eyes: '#1a1a1e', hair: '#38383d', shoes: '#26262b', sole: '#6a6f7a', gear: '#23262b' };
const palette = (over) => ({ ...COLORS_DEFAULT, ...over });
const SKIN = { light: '#f2bf99', tan: '#d9a077', deep: '#b3764f' };

const CHARACTERS = {
  'office-male-suit': {
    label: '白领男 · 石板灰蓝西装 / 短发方镜',
    height: 'normal',
    build: 'normal',
    hair: 'short',
    glasses: 'square',
    facial: 'none',
    headset: 'none',
    torso: 'suit',
    bottom: 'pants',
    arms: 'suit',
    tie: 'solid',
    colors: palette({ skin: SKIN.light, suit: '#4f5260', shirt: '#ffffff', tie: '#cf534f', pants: '#38383d', hair: '#38383d' }),
  },
  'office-male-suit-black': {
    label: '白领男 · 黑西装高个背头 / 无镜、琥珀条纹领带',
    height: 'tall',
    build: 'slim',
    hair: 'slick',
    glasses: 'none',
    facial: 'none',
    headset: 'none',
    torso: 'suit',
    bottom: 'pants',
    arms: 'suit',
    tie: 'stripe',
    colors: palette({ skin: SKIN.tan, suit: '#26262b', shirt: '#d0e8ff', tie: '#ffc044', pants: '#26262b', hair: '#4a3628' }),
  },
  'office-male-suit-navy': {
    label: '白领男 · 藏青西装矮壮寸头 / 银灰发、半框镜',
    height: 'short',
    build: 'stocky',
    hair: 'buzz',
    glasses: 'half',
    facial: 'none',
    headset: 'none',
    torso: 'suit',
    bottom: 'pants',
    arms: 'suit',
    tie: 'solid',
    colors: palette({ skin: SKIN.deep, suit: '#33415e', shirt: '#ffffff', tie: '#6794d9', pants: '#33415e', hair: '#8b9199' }),
  },
  'office-male-casual-vest': {
    label: '休闲商务男 · 墨绿马甲三七分 / 圆镜、八字胡',
    height: 'normal',
    build: 'stocky',
    hair: 'side',
    glasses: 'round',
    facial: 'mustache',
    headset: 'none',
    torso: 'vest',
    bottom: 'pants',
    arms: 'shirt',
    tie: 'none',
    colors: palette({ skin: SKIN.light, suit: '#2f4a3a', vest: '#2f4a3a', shirt: '#d0e8ff', pants: '#575046', hair: '#b08d57' }),
  },
  'office-male-casual-shirt': {
    label: '休闲商务男 · 白衬衫挽袖秃顶 / 络腮胡、墨镜',
    height: 'tall',
    build: 'normal',
    hair: 'bald',
    glasses: 'sun',
    facial: 'beard',
    headset: 'none',
    torso: 'casual',
    bottom: 'pants',
    arms: 'rolled',
    tie: 'none',
    colors: palette({ skin: SKIN.deep, shirt: '#eceff4', suit: '#eceff4', pants: '#5f4b3a', hair: '#d8dce2' }),
  },
  'office-female-skirt': {
    label: '白领女 · 酒红套裙长发 / 方镜、金领巾',
    height: 'normal',
    build: 'slim',
    hair: 'long',
    glasses: 'square',
    facial: 'none',
    headset: 'none',
    torso: 'blouse',
    bottom: 'skirt',
    arms: 'slim',
    tie: 'bow',
    shoeSize: 'small',
    colors: palette({ skin: SKIN.light, suit: '#6b2f3a', skirt: '#6b2f3a', shirt: '#f2ece2', tie: '#ffc044', hair: '#6b4a3a' }),
  },
  'office-female-skirt-bun': {
    label: '白领女 · 驼色套裙发髻矮个 / 银白发、铁锈红领巾',
    height: 'short',
    build: 'normal',
    hair: 'bun',
    glasses: 'none',
    facial: 'none',
    headset: 'none',
    torso: 'blouse',
    bottom: 'skirt',
    arms: 'slim',
    tie: 'bow',
    shoeSize: 'small',
    colors: palette({ skin: SKIN.tan, suit: '#6d5136', skirt: '#6d5136', shirt: '#f2ece2', tie: '#8a3b2f', hair: '#d6d9dd' }),
  },
  'office-female-pants': {
    label: '白领女 · 紫灰裤装高个马尾 / 耳麦、青绿领结',
    height: 'tall',
    build: 'slim',
    hair: 'ponytail',
    glasses: 'half',
    facial: 'none',
    headset: 'mic',
    torso: 'blouse',
    bottom: 'pants-slim',
    arms: 'slim',
    tie: 'bow',
    shoeSize: 'small',
    colors: palette({ skin: SKIN.tan, suit: '#514a63', skirt: '#514a63', pants: '#514a63', shirt: '#ffffff', tie: '#5f9e94', hair: '#3a2f45' }),
  },
};

// ---------------------------------------------------------------------------
// 动画:移植 Kenney 原版(CC0)+ 自制 working(打字)
// ---------------------------------------------------------------------------
async function loadKenneyClips() {
  const { json, bin } = readGlb(fs.readFileSync(KENNEY_SRC));
  stripTextures(json);
  const glb = writeGlb(json, bin);
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) =>
    loader.parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '', resolve, reject)
  );
  return gltf.animations;
}

/** 打字动画(working):伏案 + 双臂交替敲击 + 轻微点头 */
function makeWorkingClip() {
  const FPS = 15;
  const DUR = 1.2;
  const N = Math.round(DUR * FPS) + 1;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * DUR);

  const armBase = { left: [-24, 0, -64], right: [-24, 0, 64] };
  const tracks = [];
  const armL = [];
  const armR = [];
  const headV = [];
  const torsoV = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const tap = Math.sin(t * Math.PI * 2 * 3); // 每循环敲 3 下
    const tapL = tap;
    const tapR = -tap;
    armL.push(...quat(armBase.left[0] - 4 * tapL, 0, armBase.left[2] + 3 * tapL).toArray());
    armR.push(...quat(armBase.right[0] - 4 * tapR, 0, armBase.right[2] - 3 * tapR).toArray());
    const nod = Math.sin(t * Math.PI * 2 * 3 + 1.2);
    headV.push(...quat(3 + 1.5 * nod, 1.5 * Math.sin(t * Math.PI * 2), 0).toArray());
    torsoV.push(...quat(7 + 0.8 * nod, 0, 0).toArray());
  }
  tracks.push(new THREE.QuaternionKeyframeTrack('arm-left.quaternion', times, armL));
  tracks.push(new THREE.QuaternionKeyframeTrack('arm-right.quaternion', times, armR));
  tracks.push(new THREE.QuaternionKeyframeTrack('head.quaternion', times, headV));
  tracks.push(new THREE.QuaternionKeyframeTrack('torso.quaternion', times, torsoV));
  return new THREE.AnimationClip('working', DUR, tracks);
}

/**
 * 排序规则(应用内 SkillsPanel 的自动映射是「第一个命中」,顺序敏感):
 *   idle 槽 → 第一个含 'idle' 或 === 'static'
 *   walk 槽 → 第一个含 'walk'/'run'
 *   working 槽 → 第一个含 'work'/'action'/'attack'/'jump'
 * 因此 idle、walk、working 必须排在最前,static 紧随其后避免抢占 idle。
 */
const CLIP_ORDER = ['idle', 'walk', 'working', 'static', 'sprint', 'jump', 'fall', 'crouch', 'sit', 'die', 'emote-yes', 'emote-no', 'pick-up', 'interact-right'];

function orderClips(kenneyClips) {
  const byName = new Map(kenneyClips.map((c) => [c.name, c]));
  const out = [];
  for (const name of CLIP_ORDER) {
    if (name === 'working') {
      out.push(makeWorkingClip());
    } else if (byName.has(name)) {
      out.push(byName.get(name));
    } else {
      console.warn(`  [warn] Kenney 源里没有动画 "${name}",跳过`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成单个角色
// ---------------------------------------------------------------------------
function validateSpec(name, def) {
  const checks = [
    ['hair', HAIR_STYLES],
    ['glasses', GLASSES_STYLES],
    ['facial', FACIAL_STYLES],
    ['headset', HEADSET_STYLES],
    ['height', Object.keys(HEIGHT)],
    ['build', Object.keys(BUILD)],
  ];
  for (const [key, allowed] of checks) {
    if (def[key] != null && !allowed.includes(def[key])) {
      throw new Error(`${name}: 参数 ${key}="${def[key]}" 不在 ${allowed.join('|')} 里`);
    }
  }
}

async function generate(name, def, kenneyClips) {
  validateSpec(name, def);
  const nodes = buildRig();
  const matOf = makeMaterials(def.colors);
  const c = (parent, colorKey, size, pos, rot, chamfer) => {
    const hex = def.colors[colorKey];
    if (!hex) throw new Error(`${name}: 缺少颜色键 "${colorKey}"`);
    return box(matOf, parent, hex, size, pos, rot, chamfer);
  };
  buildCharacter(def)(nodes, c);

  // 体型/身高:整体缩放 root。关节位姿随之等比缩放,动画(纯旋转)不受影响、脚底仍贴地。
  const bw = BUILD[def.build ?? 'normal'];
  const bh = HEIGHT[def.height ?? 'normal'];
  nodes.root.scale.set(bw, bh, bw);

  const scene = new THREE.Group();
  scene.name = name;
  scene.add(nodes.root);

  const clips = orderClips(kenneyClips);

  const exporter = new GLTFExporter();
  const glb = await new Promise((resolve, reject) =>
    exporter.parse(scene, resolve, reject, { binary: true, animations: clips, onlyVisible: true })
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${name}.glb`);
  fs.writeFileSync(outPath, Buffer.from(glb));

  // 自检:重新解析输出,确认命名/动画/网格
  const check = readGlb(fs.readFileSync(outPath));
  const j = check.json;
  let tri = 0;
  for (const m of j.meshes ?? [])
    for (const p of m.primitives ?? [])
      tri += (p.indices != null ? j.accessors[p.indices].count : j.accessors[p.attributes.POSITION].count) / 3;
  console.log(
    `✓ ${name.padEnd(26)} ${(fs.statSync(outPath).size / 1024).toFixed(1).padStart(6)} KB | ` +
      `网格 ${String(j.meshes.length).padStart(2)} | 三角面 ${String(tri).padStart(4)} | 动画 ${j.animations.length} | ` +
      `${def.hair}/${def.glasses} ${def.height}/${def.build}`
  );
  return outPath;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const filter = process.argv[2];
const matches = (name) => !filter || (filter.includes('*') ? new RegExp(`^${filter.replace(/\*/g, '.*')}$`).test(name) : name === filter);

let kenneyClips = [];
try {
  kenneyClips = await loadKenneyClips();
  console.log(`已载入 Kenney 原版动画 ${kenneyClips.length} 条(CC0,按关节名移植)\n`);
} catch (err) {
  console.warn('[warn] 载入 Kenney 动画失败,将只导出自制动画:', err.message);
}

let okCount = 0;
for (const [name, def] of Object.entries(CHARACTERS)) {
  if (!matches(name)) continue;
  console.log(`== ${def.label} (${name}) ==`);
  await generate(name, def, kenneyClips);
  okCount++;
}
console.log(`\n完成 ${okCount} 个角色。去重自检: node tools/character-forge/distinct.mjs`);
console.log(`预览: http://localhost:5173/tools/character-forge/viewer.html`);
