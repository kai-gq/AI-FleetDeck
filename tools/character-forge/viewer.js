/**
 * character-forge 预览台 —— 最左侧 Kenney 原版作参照,右侧一字排开全部自制角色,
 * 同步播放动画。供人工/截图风格比对;通过 window.__forge 暴露控制接口,便于自动化截图。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const OFFICE = [
  'office-male-suit',
  'office-male-suit-black',
  'office-male-suit-navy',
  'office-male-casual-vest',
  'office-male-casual-shirt',
  'office-female-skirt',
  'office-female-skirt-bun',
  'office-female-pants',
];
const SPACING = 0.42;
const rowX = (i, n) => (i - (n - 1) / 2) * SPACING;

const MODELS = [
  { url: '/assets/characters/character-male-a.glb', label: 'Kenney 原版 male-a', x: rowX(-1, OFFICE.length + 1), ref: true },
  ...OFFICE.map((n, i) => ({ url: `/assets/characters/office/${n}.glb`, label: n, x: rowX(i, OFFICE.length) })),
];

const app = document.getElementById('app');
const hud = document.getElementById('hud');
const bar = document.getElementById('bar');

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161c);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 100);

const CAMS = {
  front: { pos: [0, 0.46, 3.6], target: [0, 0.34, 0] },
  '3q': { pos: [2.6, 0.85, 2.6], target: [0, 0.34, 0] },
  side: { pos: [3.7, 0.45, 0.05], target: [0, 0.34, 0] },
  back: { pos: [0, 0.46, -3.6], target: [0, 0.34, 0] },
  top: { pos: [0.01, 1.9, 0.01], target: [0, 0.34, 0] },
};
/** 单角色特写相机;dist 为相机距离,y/ty 可改用平视高度(拍头部特写时抬高) */
function focusCam(x, dist = 1.5, side = 1, y = 0.42, ty = 0.34) {
  return { pos: [x + 0.55 * side * (dist / 1.5), y, dist], target: [x, ty, 0] };
}

/**
 * 相机锁:快照后每帧重新钉住机位。
 * 截图/重绘链路里有东西会把相机推回默认距离,只在设置那一刻生效不够稳;
 * 用户一旦拖动 OrbitControls(start 事件)就解锁。
 */
let camLock = null;
function aimCamera(p) {
  camLock = { pos: p.pos, target: p.target };
  camera.position.set(...p.pos);
  controls.target.set(...p.target);
  camera.lookAt(controls.target);
}

function setCam(name, x = null, dist = 1.5, side = 1, y, ty) {
  aimCamera(x != null ? focusCam(x, dist, side, y, ty) : CAMS[name] ?? CAMS['3q']);
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener('start', () => {
  camLock = null; // 用户开始拖动/滚轮 → 解锁
});
setCam('3q');

scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 2.2);
dir.position.set(2, 4, 3);
scene.add(dir);
const fill = new THREE.DirectionalLight(0xffffff, 0.7);
fill.position.set(-3, 2, -2);
scene.add(fill);

const grid = new THREE.GridHelper(8, 32, 0x3a4256, 0x232838);
scene.add(grid);

const loader = new GLTFLoader();
const entries = [];
const clipsState = { all: [], current: '(none)' };

async function loadAll() {
  for (const spec of MODELS) {
    try {
      const gltf = await loader.loadAsync(spec.url);
      const root = gltf.scene;
      root.position.x = spec.x;
      root.traverse((o) => {
        if (o.isMesh) o.castShadow = o.receiveShadow = true;
      });
      scene.add(root);
      const mixer = new THREE.AnimationMixer(root);
      entries.push({ spec, root, mixer, clips: gltf.animations });
      clipsState.all.push(...gltf.animations.map((c) => `${spec.label}::${c.name}`));
    } catch (err) {
      console.error('加载失败', spec.url, err);
      clipsState.all.push(`[加载失败] ${spec.url}: ${err.message}`);
    }
  }
  buildButtons();
  updateHud();
}

function playClip(name) {
  clipsState.current = name;
  for (const e of entries) {
    e.mixer.stopAllAction();
    // 该模型没有这条动画时回退到 idle,避免停在死姿势上
    const clip =
      e.clips.find((c) => c.name.toLowerCase() === name.toLowerCase()) ??
      e.clips.find((c) => c.name.toLowerCase() === 'idle');
    if (clip) {
      const action = e.mixer.clipAction(clip);
      action.reset().play();
    }
  }
  for (const b of bar.querySelectorAll('button[data-clip]')) {
    b.classList.toggle('on', b.dataset.clip === name);
  }
  updateHud();
}

function buildButtons() {
  for (const n of ['idle', 'walk', 'working', 'static', 'sprint', 'sit']) {
    const b = document.createElement('button');
    b.textContent = `▶ ${n}`;
    b.dataset.clip = n;
    b.onclick = () => playClip(n);
    bar.appendChild(b);
  }
  for (const cam of Object.keys(CAMS)) {
    const b = document.createElement('button');
    b.textContent = `📷 ${cam}`;
    b.onclick = () => setCam(cam);
    bar.appendChild(b);
  }
  const spin = document.createElement('button');
  spin.textContent = '⟳ 转台';
  let spinning = false;
  let spinTimer = null;
  spin.onclick = () => {
    spinning = !spinning;
    spin.classList.toggle('on', spinning);
    if (spinning) camLock = null;
    spinTimer = spinning
      ? setInterval(() => {
          const a = performance.now() / 1600;
          camera.position.set(Math.sin(a) * 1.35, 0.45, Math.cos(a) * 1.35);
          controls.target.set(0, 0.34, 0);
          controls.update();
        }, 33)
      : (clearInterval(spinTimer), null);
  };
  bar.appendChild(spin);
}

function updateHud() {
  const lines = [`当前动画: <b>${clipsState.current}</b>`];
  for (const e of entries) lines.push(`— ${e.spec.label}: ${e.clips.length} 条动画`);
  hud.innerHTML = lines.join('\n');
}

const clock = new THREE.Clock();
let frames = 0;
renderer.setAnimationLoop(() => {
  frames++;
  const dt = clock.getDelta();
  for (const e of entries) e.mixer.update(dt);
  if (camLock) {
    camera.position.set(...camLock.pos);
    controls.target.set(...camLock.target);
    camera.lookAt(controls.target);
  }
  renderer.render(scene, camera);
});

// 自动化控制接口(Chrome DevTools MCP 用)
window.__forge = {
  playClip,
  setCam,
  clips: () => entries.map((e) => ({ label: e.spec.label, clips: e.clips.map((c) => c.name) })),
  /** 按名字给单个角色摆姿势(截图特写用) */
  pose: (label, clip, time) => {
    const e = entries.find((x) => x.spec.label === label);
    if (!e) return `没有 ${label}`;
    e.mixer.stopAllAction();
    const c = e.clips.find((x) => x.name.toLowerCase() === clip.toLowerCase());
    if (c) e.mixer.clipAction(c).reset().play();
    e.mixer.setTime(time);
    renderer.render(scene, camera);
    return `${label} → ${c?.name ?? '未找到'}`;
  },
  ready: false,
};

window.__forge.debug = () => ({
  cam: camera.position.toArray().map((v) => +v.toFixed(3)),
  target: controls.target.toArray().map((v) => +v.toFixed(3)),
  size: [innerWidth, innerHeight],
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/**
 * 确定性快照:指定相机/动画/时间点后同步渲染一帧。
 * 标签页在后台时 rAF 会被浏览器节流,截图可能拿到陈旧帧;快照不依赖 rAF。
 * 传 x(世界坐标)即切到该处的特写;y/ty 调机位与目标高度(拍头部特写时抬到 ~0.6)。
 */
window.__forge.snap = async ({ cam = '3q', clip = null, time = 0, x = null, dist = 1.5, side = 1, y = undefined, ty = undefined } = {}) => {
  setCam(cam, x, dist, side, y, ty);
  if (clip) playClip(clip);
  for (const e of entries) e.mixer.setTime(time);
  renderer.render(scene, camera);
  // 同步渲染只写进 WebGL 缓冲;等两个 rAF 让合成器取走这一帧,截图才不会拿到旧画布
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (const e of entries) e.mixer.setTime(time);
  renderer.render(scene, camera);
  return { frames, visibility: document.visibilityState, cam: camera.position.toArray().map((v) => +v.toFixed(3)) };
};

loadAll().then(() => {
  window.__forge.ready = true;
  playClip('idle');
});
