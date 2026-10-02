#!/usr/bin/env node
/**
 * 去重自检 —— 量化「撞脸」风险。
 *
 * 角色好不好区分,主要看两件事:
 *   1) 颜色分布(远距离第一眼):按三角形面积加权的 RGB 直方图(sRGB 6×6×6)
 *   2) 身高体型(剪影差异)
 *
 * 相似度 = 0.85 × 直方图交集 + 0.15 × 身高接近度   (两者都在 0..1,越小越好)
 * 直方图用面积加权,是因为角色视觉上「由什么颜色构成」取决于面积占比,
 * 而不是材质个数 —— 领带再亮也只占很小面积,统计里就该只占很小权重。
 *
 * 用法: node tools/character-forge/distinct.mjs [阈值]
 *   阈值默认 0.85;超阈值的角色对会标 ⚠,考虑换发型/换主色/改体型后再生成。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'public', 'assets', 'characters', 'office');
const THRESHOLD = Number(process.argv[2] ?? 0.85);
const BINS = 6;
const KENNEY_HEIGHT = 0.6713; // 原版 male-a 身高,作参照

// ---------------------------------------------------------------------------
// GLB 解析(与 analyze.mjs 同款最小实现)
// ---------------------------------------------------------------------------
const GLB_MAGIC = 0x46546c67;
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('不是 GLB');
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
  return { json, bin };
}

function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const T = COMP[acc.componentType];
  const n = NUM[acc.type];
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new (T === Float32Array ? Float32Array : T)(acc.count * n);
  const view = new DataView(bin.buffer, bin.byteOffset + start, acc.count * n * T.BYTES_PER_ELEMENT);
  for (let i = 0; i < acc.count * n; i++) {
    if (T === Float32Array) out[i] = view.getFloat32(i * 4, true);
    else if (T.BYTES_PER_ELEMENT === 4) out[i] = view.getUint32(i * 4, true);
    else if (T.BYTES_PER_ELEMENT === 2) out[i] = view.getUint16(i * 2, true);
    else out[i] = view.getUint8(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
/** 线性色 → sRGB(GLB 里的 baseColorFactor 是线性空间,直方图按人眼感知的 sRGB 分箱) */
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function binIndex(bin, i) {
  const r = Math.min(BINS - 1, Math.floor(toSrgb(bin[0]) * BINS));
  const g = Math.min(BINS - 1, Math.floor(toSrgb(bin[1]) * BINS));
  const b = Math.min(BINS - 1, Math.floor(toSrgb(bin[2]) * BINS));
  return r * BINS * BINS + g * BINS + b;
}

/** 分箱序号的中心色 → #rrggbb */
function binHex(i) {
  const r = Math.floor(i / (BINS * BINS));
  const g = Math.floor((i % (BINS * BINS)) / BINS);
  const b = i % BINS;
  return '#' + [r, g, b].map((v) => Math.round(((v + 0.5) / BINS) * 255).toString(16).padStart(2, '0')).join('');
}

function profile(file) {
  const name = path.basename(file, '.glb');
  const { json, bin } = readGlb(fs.readFileSync(file));
  const hist = new Float64Array(BINS ** 3);
  let area = 0;
  let topY = -Infinity;

  // 节点世界矩阵(含 root 的体型/身高缩放 —— 剪影差异要算进去)
  const world = new Map();
  const walk = (idx, parentMat) => {
    const n = json.nodes[idx];
    const local = new THREE.Matrix4();
    if (n.matrix) local.fromArray(n.matrix);
    else {
      local.compose(
        new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
        new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
        new THREE.Vector3(...(n.scale ?? [1, 1, 1]))
      );
    }
    const m = new THREE.Matrix4().multiplyMatrices(parentMat, local);
    world.set(idx, m);
    for (const ch of n.children ?? []) walk(ch, m);
  };
  const I = new THREE.Matrix4();
  for (const s of json.scenes?.[0]?.nodes ?? []) walk(s, I);

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (let ni = 0; ni < json.nodes.length; ni++) {
    const n = json.nodes[ni];
    if (n.mesh == null) continue;
    const mat4 = world.get(ni);
    for (const prim of json.meshes[n.mesh].primitives ?? []) {
      const pos = readAccessor(json, bin, prim.attributes.POSITION);
      const idx = prim.indices != null ? readAccessor(json, bin, prim.indices) : null;
      const bc = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
      const hbin = binIndex(bc, 0);
      const vcount = pos.length / 3;
      const triCount = idx ? idx.length / 3 : vcount / 3;
      for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx[t * 3] : t * 3;
        const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
        const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
        va.fromArray(pos, i0 * 3).applyMatrix4(mat4);
        vb.fromArray(pos, i1 * 3).applyMatrix4(mat4);
        vc.fromArray(pos, i2 * 3).applyMatrix4(mat4);
        const a = vb.clone().sub(va).cross(vc.clone().sub(va)).length() * 0.5;
        if (!(a > 0)) continue;
        hist[hbin] += a;
        area += a;
        if (va.y > topY) topY = va.y;
        if (vb.y > topY) topY = vb.y;
        if (vc.y > topY) topY = vc.y;
      }
    }
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= area;
  const topColors = [...hist.keys()]
    .filter((i) => hist[i] > 0.005)
    .sort((a, b) => hist[b] - hist[a])
    .slice(0, 4)
    .map((i) => ({ hex: binHex(i), pct: hist[i] }));
  return { name, hist, area, height: topY, topColors };
}

/** 0..1,越大越像 */
function similarity(A, B) {
  let inter = 0;
  for (let i = 0; i < A.hist.length; i++) inter += Math.min(A.hist[i], B.hist[i]);
  const heightSim = 1 - Math.abs(A.height - B.height) / Math.max(A.height, B.height);
  return { score: 0.85 * inter + 0.15 * heightSim, color: inter, height: heightSim };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
if (!fs.existsSync(OUT_DIR)) {
  console.error(`目录不存在: ${OUT_DIR}\n先运行: node tools/character-forge/generate.mjs`);
  process.exit(1);
}
const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.glb')).sort();
if (files.length < 2) {
  console.error(`只有 ${files.length} 个角色,没法两两比较`);
  process.exit(1);
}

const profiles = files.map((f) => profile(path.join(OUT_DIR, f)));

console.log(`== 角色档案(${profiles.length} 个,身高参照 Kenney 原版 ${KENNEY_HEIGHT}) ==`);
for (const p of profiles) {
  const h = (p.height / KENNEY_HEIGHT).toFixed(2);
  console.log(
    `  ${p.name.padEnd(26)} 身高 ${p.height.toFixed(3)} (${h}×)  面积 ${p.area.toFixed(3)}  ` +
      p.topColors.map((c) => `${c.hex} ${(c.pct * 100).toFixed(0)}%`).join('  ')
  );
}

const pairs = [];
for (let i = 0; i < profiles.length; i++) {
  for (let j = i + 1; j < profiles.length; j++) {
    pairs.push({ a: profiles[i], b: profiles[j], ...similarity(profiles[i], profiles[j]) });
  }
}
pairs.sort((x, y) => y.score - x.score);

console.log(`\n== 两两相似度(降序,共 ${pairs.length} 对;阈值 ${THRESHOLD}) ==`);
for (const p of pairs) {
  const flag = p.score >= THRESHOLD ? ' ⚠ 太像' : '';
  console.log(
    `  ${p.score.toFixed(3)}  颜色 ${p.color.toFixed(3)}  身高 ${p.height.toFixed(3)}  ` +
      `${p.a.name} ↔ ${p.b.name}${flag}`
  );
}

// 每个角色最近的对手,一眼看出谁最容易撞脸
console.log('\n== 每个角色最像的对手 ==');
for (const p of profiles) {
  const others = pairs.filter((x) => x.a === p || x.b === p).sort((x, y) => y.score - x.score);
  const best = others[0];
  const twin = best.a === p ? best.b : best.a;
  console.log(`  ${p.name.padEnd(26)} → ${twin.name} (${best.score.toFixed(3)})${best.score >= THRESHOLD ? ' ⚠' : ''}`);
}

const bad = pairs.filter((p) => p.score >= THRESHOLD);
console.log(
  bad.length === 0
    ? `\n✓ 全部 ${pairs.length} 对都在阈值内,区分度合格。`
    : `\n⚠ ${bad.length} 对超过阈值,建议给其中之一换发型 / 换主色 / 改体型后重新生成。`
);
process.exitCode = bad.length === 0 ? 0 : 2;
