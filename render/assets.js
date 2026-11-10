// render/assets.js — 素材の読み込み（glb / PBR テクスチャ / 手続きテクスチャ）と正規化
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const ASSET_ROOT = new URL('../assets/', import.meta.url).href;

const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

// 主ループ 2026-10-03: Artifact の隔離枠（出どころが null）では、別ファイルの fetch・モジュール読み込みが CORS で拒否される
// （手元の sandbox iframe で再現: "Access to script ... from origin 'null' has been blocked by CORS policy"）。
// 公開版は素材を base64 にして普通の <script> に入れ（globalThis.FK_PACK）、ここで取り出す。手元では FK_PACK が無いので従来どおり
export function packB64(path) { return globalThis.FK_PACK ? globalThis.FK_PACK[path] : undefined; }
export function b64ToBuf(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

export function loadGLB(path) {
  // 主ループ 2026-10-02: Artifact は .glb/.hdr を配信できないので、公開版だけ globalThis.FK_BIN_SUFFIX（例 '.wasm'）を付けた名前で置く。
  // GLTFLoader は拡張子でなく中身の先頭（glTF）で判定するので読める。手元では空文字＝従来どおり
  const packed = packB64(path);
  if (packed) return new Promise((resolve, reject) => gltfLoader.parse(b64ToBuf(packed), '', resolve, reject));
  return new Promise((resolve, reject) => gltfLoader.load(ASSET_ROOT + path + (globalThis.FK_BIN_SUFFIX || ''), resolve, undefined, reject));
}

export function loadTexture(path, { srgb = false, repeat = 1, anisotropy = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const packed = packB64(path);
    texLoader.load(packed ? 'data:image/jpeg;base64,' + packed : ASSET_ROOT + path, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = anisotropy;
      if (typeof repeat === 'number') t.repeat.set(repeat, repeat); else t.repeat.set(repeat[0], repeat[1]);
      resolve(t);
    }, undefined, reject);
  });
}

// Poly Haven 形式 (diff / nor_gl / arm) の 3 枚を読む。arm = R:AO G:Roughness B:Metalness
export async function loadPBR(folder, base, { anisotropy = 8 } = {}) {
  const [map, normalMap, arm] = await Promise.all([
    loadTexture(`textures/${folder}/${base}_diff_1k.jpg`, { srgb: true, anisotropy }),
    loadTexture(`textures/${folder}/${base}_nor_gl_1k.jpg`, { anisotropy }),
    loadTexture(`textures/${folder}/${base}_arm_1k.jpg`, { anisotropy }),
  ]);
  arm.channel = 0; // aoMap は既定で uv1 を見るので uv に揃える
  return { map, normalMap, aoMap: arm, roughnessMap: arm, metalnessMap: arm };
}

/**
 * glb のシーンを正規化する: 高さを targetHeight に、足元を y=0、中心を x=z=0 にし、
 * forward ('+z' | '-z' | '+x' | '-x') を +x に向けたピボットを返す。
 */
export function normalizeModel(gltf, { targetHeight, forward = '+z', castShadow = true, receiveShadow = true } = {}) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const size = new THREE.Vector3(); box.getSize(size);
  const s = targetHeight ? targetHeight / Math.max(size.y, 1e-6) : 1;
  const inner = new THREE.Group();
  inner.add(src);
  src.scale.setScalar(s);
  src.position.set(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s);
  const pivot = new THREE.Group();
  pivot.add(inner);
  inner.rotation.y = { '+z': Math.PI / 2, '-z': -Math.PI / 2, '+x': 0, '-x': Math.PI }[forward] ?? 0;
  src.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = castShadow; o.receiveShadow = receiveShadow;
      o.frustumCulled = true;
      if (o.material) { o.material.envMapIntensity = 0.9; }
    }
  });
  return { pivot, inner, scene: src, scale: s, size: size.multiplyScalar(s), animations: gltf.animations || [] };
}

// 複数の変換に同じ glb メッシュをインスタンス描画する（街灯・テーブルなど）
export function instanceModel(model, transforms, { castShadow = true, receiveShadow = true } = {}) {
  // model: normalizeModel の戻り値。transforms: [{x,z,yaw,y?,scale?}]
  const group = new THREE.Group();
  const meshes = [];
  model.pivot.updateMatrixWorld(true);
  model.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const m = new THREE.Matrix4(), base = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const out = [];
  for (const mesh of meshes) {
    const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, transforms.length);
    inst.castShadow = castShadow; inst.receiveShadow = receiveShadow;
    // メッシュの (pivot 基準の) ワールド行列
    base.copy(model.pivot.matrixWorld).invert().multiply(mesh.matrixWorld);
    transforms.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(t.yaw || 0));
      p.set(t.x, t.y || 0, t.z); sc.setScalar(t.scale || 1);
      m.compose(p, q, sc).multiply(base);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    out.push(inst);
  }
  return { group, meshes: out };
}

// ---- 手続きテクスチャ ----

// 高さ画像(グレースケールの ImageData)から法線マップを作る
export function normalFromHeight(imgData, strength = 2.0) {
  const { width: w, height: h, data } = imgData;
  const out = new Uint8ClampedArray(w * h * 4);
  const H = (x, y) => data[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
    const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    const nx = -dx, ny = dy, nz = 1; // OpenGL 規約 (Y+)
    const l = Math.hypot(nx, ny, nz);
    const i = (y * w + x) * 4;
    out[i] = (nx / l * 0.5 + 0.5) * 255; out[i + 1] = (ny / l * 0.5 + 0.5) * 255; out[i + 2] = (nz / l * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return new ImageData(out, w, h);
}

function canvasTexture(canvas, { srgb = false, anisotropy = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function rand(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** 花崗岩の板石（歩道・広場）。1 枚 = metersPerTile m 四方。map + normalMap + roughnessMap を返す */
// CITY2 2026-11-10: 板石を細かく（幅 0.4→0.28m、長さ 0.6〜1.2→0.35〜0.8m）、色のばらつきを増やす（暖色・寒色・暗い石を混ぜ、石ごとの明暗 ±10→±22）。
// 「タイルが大きく規則的すぎる」（主ループ 13:36）
export function makeGraniteSlabs({ size = 1024, metersPerTile = 2.0, slabW = 0.28, slabLens = [0.35, 0.45, 0.55, 0.65, 0.8], colors = ['#a3a1a3', '#8f8d8b', '#8a8683', '#aaa8a6', '#9a9593', '#7f7d7b', '#a59e95', '#8d9094', '#b0aca6', '#767472'], seed = 7 } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const hc = document.createElement('canvas'); hc.width = hc.height = size;
  const hg = hc.getContext('2d');
  const px = size / metersPerTile; // px per meter
  const r = rand(seed);
  g.fillStyle = '#6a6866'; g.fillRect(0, 0, size, size);
  hg.fillStyle = '#000'; hg.fillRect(0, 0, size, size);
  // 列ごとに長さ違いの板を馬目地で並べる（周期がタイルに収まるよう列を metersPerTile に合わせる）
  const rows = Math.round(metersPerTile / slabW);
  for (let row = 0; row < rows; row++) {
    let u = -r() * 1.0;
    const v = row * slabW;
    while (u < metersPerTile + 0.01) {
      const len = slabLens[Math.floor(r() * slabLens.length)];
      const col = colors[Math.floor(r() * colors.length)];
      const jitter = (r() - 0.5) * 22;
      const joint = 0.012;
      const x0 = (u + joint) * px, y0 = (v + joint) * px, w = (len - 2 * joint) * px, h = (slabW - 2 * joint) * px;
      for (const [ctx, fill] of [[g, shade(col, jitter)], [hg, '#e8e8e8']]) {
        ctx.fillStyle = fill;
        // タイル端で折り返す（RepeatWrapping で継ぎ目を消す）
        for (const dx of [0, -size, size]) for (const dy of [0, -size, size]) ctx.fillRect(x0 + dx, y0 + dy, w, h);
      }
      // 石の表面のざらつき
      u += len;
    }
  }
  // ノイズ
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const nr = rand(seed + 1);
  for (let i = 0; i < d.length; i += 4) { const n = (nr() - 0.5) * 18; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const himg = hg.getImageData(0, 0, size, size);
  const hd = himg.data;
  for (let i = 0; i < hd.length; i += 4) { const n = (nr() - 0.5) * 14; hd[i] = Math.max(0, Math.min(255, hd[i] + n)); hd[i + 1] = hd[i]; hd[i + 2] = hd[i]; }
  // 法線
  const nimg = normalFromHeight(himg, 1.6);
  const nc = document.createElement('canvas'); nc.width = nc.height = size;
  nc.getContext('2d').putImageData(nimg, 0, 0);
  // 粗さ: 目地は粗く、石面は 0.65
  const rc = document.createElement('canvas'); rc.width = rc.height = size;
  const rg = rc.getContext('2d');
  const rimg = rg.createImageData(size, size);
  for (let i = 0; i < hd.length; i += 4) { const stone = hd[i] > 100; const v = stone ? 150 + (nr() - 0.5) * 40 : 240; rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = v; rimg.data[i + 3] = 255; }
  rg.putImageData(rimg, 0, 0);
  return { map: canvasTexture(c, { srgb: true }), normalMap: canvasTexture(nc), roughnessMap: canvasTexture(rc), metersPerTile };
}

function shade(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + delta)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + delta)), b = Math.max(0, Math.min(255, (n & 255) + delta));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** シュテファン大聖堂のジグザグ瓦。u = 屋根の長さ方向（1 タイル = periodM m）、v = 軒(0)→棟(1) */
export function makeChevronRoof({ size = 1024, periodM = 7.0, slopeM = 41, stripeM = 0.9, eaveBandM = 7.0 } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const GREEN = [63, 122, 90], WHITE = [233, 228, 210], BLACK = [43, 45, 46], YELLOW = [217, 178, 74], DARK = [38, 40, 42];
  const seq = [GREEN, GREEN, GREEN, WHITE, BLACK, WHITE]; // 緑3 白1 黒1 白1
  const r = rand(11);
  for (let py = 0; py < size; py++) {
    const v = 1 - py / size;             // 画像の上が棟
    const ym = v * slopeM;               // 軒からの距離 m
    for (let px = 0; px < size; px++) {
      const xm = (px / size) * periodM;  // 周期内の位置 m
      let col;
      if (ym < eaveBandM) {
        // 黄と黒の菱形格子
        const p = 1.3;
        const a = ((xm + ym) / p) % 1, b = ((xm - ym + 100) / p) % 1;
        col = (a < 0.5) !== (b < 0.5) ? YELLOW : DARK;
      } else {
        // 周期の前半は右上がり、後半は左上がり → V 字
        const half = periodM / 2;
        const local = xm < half ? xm : periodM - xm;
        const t = ((ym - eaveBandM) + local) / stripeM;
        col = seq[((Math.floor(t) % seq.length) + seq.length) % seq.length];
      }
      const i = (py * size + px) * 4;
      const n = (r() - 0.5) * 14;
      d[i] = col[0] + n; d[i + 1] = col[1] + n; d[i + 2] = col[2] + n; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c, { srgb: true });
}
