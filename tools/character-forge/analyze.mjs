#!/usr/bin/env node
/**
 * 量原版模型的结构:节点层级、关节静止位姿、按关节分组的顶点包围盒、动画名。
 * 用于在自制角色时对齐原版的体量与绑定方式(例如女性角色的裙子绑在哪个关节)。
 *
 * 用法: node tools/character-forge/analyze.mjs public/assets/characters/character-female-a.glb
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLB_MAGIC = 0x46546c67;

function readGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('不是 GLB');
  let off = 12, json = null, bin = Buffer.alloc(0);
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

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const T = COMP[acc.componentType];
  const n = NUM[acc.type];
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new T(acc.count * n);
  const view = new DataView(bin.buffer, bin.byteOffset + start, acc.count * n * T.BYTES_PER_ELEMENT);
  for (let i = 0; i < acc.count * n; i++) out[i] = T === Float32Array ? view.getFloat32(i * 4, true) : view.getUint16(i * 2, true);
  return out;
}

const file = process.argv[2] ?? path.join(path.resolve(__dirname, '..', '..'), 'public/assets/characters/character-female-a.glb');
const { json, bin } = readGlb(fs.readFileSync(file));
console.log(`== ${path.basename(file)} ==`);
console.log(`generator: ${json.asset?.generator}  | 节点 ${json.nodes.length} | 网格 ${json.meshes.length} | 皮肤 ${(json.skins ?? []).length} | 材质 ${(json.materials ?? []).length}`);

// 节点层级 + 静止平移 + 世界位置
const world = new Map();
function walk(idx, parentPos) {
  const n = json.nodes[idx];
  const t = n.translation ?? [0, 0, 0];
  const pos = [parentPos[0] + t[0], parentPos[1] + t[1], parentPos[2] + t[2]];
  world.set(idx, pos);
  const rot = n.rotation ? n.rotation.map((v) => +v.toFixed(3)).join(',') : '-';
  const sc = n.scale ? n.scale.map((v) => +v.toFixed(3)).join(',') : '-';
  console.log(`  ${idx} ${n.name ?? '(mesh)'}  t=[${t.map((v) => +v.toFixed(4)).join(', ')}] 世界=[${pos.map((v) => +v.toFixed(4)).join(', ')}] rot=[${rot}] scale=[${sc}]${n.mesh != null ? ` mesh=${json.meshes[n.mesh].name}` : ''}`);
  for (const c of n.children ?? []) walk(c, pos);
}
for (const s of json.scenes[0].nodes) walk(s, [0, 0, 0]);

// 按关节分组统计顶点包围盒(静止位姿 = 顶点原始位置,Kenney 为刚性单关节绑定)
// JOINTS_0 里的索引指向 skin.joints[](不是 nodes[]),先建立映射
const meshNodes = json.nodes.filter((n) => n.mesh != null && n.skin != null);
console.log('-- 按关节分组的部件包围盒(model 空间,脚底 y=0) --');
for (const node of meshNodes) {
  const jointNodes = json.skins[node.skin].joints; // jointIdx → nodeIdx
  const mesh = json.meshes[node.mesh];
  for (const prim of mesh.primitives) {
    const pos = readAccessor(json, bin, prim.attributes.POSITION);
    const jnt = prim.attributes.JOINTS_0 != null ? readAccessor(json, bin, prim.attributes.JOINTS_0) : null;
    const wgt = prim.attributes.WEIGHTS_0 != null ? readAccessor(json, bin, prim.attributes.WEIGHTS_0) : null;
    const groups = new Map();
    const vcount = pos.length / 3;
    for (let v = 0; v < vcount; v++) {
      let j = 0;
      if (jnt) {
        let best = -1;
        for (let k = 0; k < 4; k++) if (wgt[v * 4 + k] > best) { best = wgt[v * 4 + k]; j = jnt[v * 4 + k]; }
      }
      const name = json.nodes[jointNodes[j]]?.name ?? `joint${j}`;
      let g = groups.get(name);
      if (!g) groups.set(name, (g = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], n: 0 }));
      for (let a = 0; a < 3; a++) {
        const val = pos[v * 3 + a];
        if (val < g.min[a]) g.min[a] = val;
        if (val > g.max[a]) g.max[a] = val;
      }
      g.n++;
    }
    console.log(`  [${mesh.name}] 顶点 ${vcount}`);
    for (const [name, g] of groups) {
      const size = g.max.map((v, i) => +(v - g.min[i]).toFixed(4));
      const center = g.max.map((v, i) => +((v + g.min[i]) / 2).toFixed(4));
      console.log(`   ${name.padEnd(12)} n=${String(g.n).padStart(4)} 尺寸=${size.join(' × ')} 中心=[${center.join(', ')}] y范围=[${g.min[1].toFixed(4)}..${g.max[1].toFixed(4)}] z范围=[${g.min[2].toFixed(4)}..${g.max[2].toFixed(4)}]`);
    }
  }
}

console.log(`-- 动画(${(json.animations ?? []).length}): ${(json.animations ?? []).map((a) => a.name).join(', ')}`);
