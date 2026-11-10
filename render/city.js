// render/city.js — ウィーンの街並みを手続き生成する
//
//   const assets = await loadCityAssets();
//   const city = buildCity(scene, world, assets, { quality });
//
// world（sim の g.world を想定。無いフィールドは省略可）:
//   roads:      [{ pts:[{x,z},...], width, kind:'street'|'pedestrian'|'ring'|'plaza', surface?:'cobble'|'asphalt'|'granite' }]
//   plazas:     [{ x, z, yaw, w, d, surface? }]            // OBB。d は yaw 方向の長さ、w はその直交方向
//   sidewalks:  [{ x, z, yaw, w, d, curb?:'both'|'left'|'right'|'none' }]  // 一段高い (0.15m)
//   crosswalks: [{ x, z, yaw, w, d }]                      // 白線は yaw に沿って伸び、w 方向に並ぶ
//   buildings:  [{ x, z, yaw, w, d, style?:'A'|'B'|'C'|'D', faces?:['front','back','left','right'], seed?, floors? }]
//               yaw = 正面の向き。w = 正面の幅、d = 奥行き。正面はローカル +x
//   landmarks:  [{ kind:'stephansdom', x, z, yaw }]
//   lamps:      [{ x, z, yaw }]   trees: [{ x, z, r? }]   bollards: [{ x, z }]
//   furniture:  [{ kind:'table'|'tableB'|'bench'|'plant'|'plantB'|'chair', x, z, yaw }]  // 静的な小物（壊れる小物は props3d の担当）
//
// 向きの規約: yaw は +x から +z へ測る角（forward = (cos yaw, sin yaw)）。three.js では rotation.y = -yaw。

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadGLB, loadPBR, normalizeModel, instanceModel, makeGraniteSlabs, makeChevronRoof } from './assets.js';

// ---- 色（research/vienna-reference.md §1 の「ゲーム推奨」値） ----
export const PALETTE = {
  wallA: 0xe8e4da, wallB: 0xe3d9c4, wallC: 0xcdbd98, wallD: [0xefe0b0, 0xe3e7d5, 0xe9d4c6, 0xdde3e8],
  trim: 0xf2efe6, trimC: 0xe6dfcf, // CITY2 2026-11-10: 様式 C（ランドマーク・大きな建物）の飾り 0xbfae8a → 0xe6dfcf。壁 0xcdbd98 とほぼ同じ色で壁柱・帯が見えず「窓の格子だけの箱」に見えていた
  glass: 0x36414c, shopGlass: 0x2c3842,
  roofZinc: 0x7d7f82, roofTile: 0x8a5a3c, roofOpera: 0x8a9a8a,
  iron: 0x1e1f22, gold: 0xc9a227, wood: 0x4a3220, sign: 0x15130f,
  stone: 0xb3a79a, verdigris: 0x7fa394,
  granite: 0xb9b7ba, curb: 0xb0afb3, zebra: 0xd9dbd1,
  leaf: 0x5f7a3c, trunk: 0x6e6a5a,
};

// 賑わい 2026-10-03: 建物の色のばらつき（クリーム・黄・淡い緑・淡いピンク・白。写真 P2/P4/P5 と研究資料 §1.1）
const WALL_VARIANTS = {
  A: [0xe8e4da, 0xece7d8, 0xe6e9e4, 0xf0ece4],
  B: [0xe3d9c4, 0xefe0b0, 0xe3e7d5, 0xe9d4c6, 0xf0ece4, 0xdcd0b8, 0xe8dcc2, 0xf2e3c0],
  C: [0xcdbd98, 0xd3c4a0, 0xc8b58e],
  D: [0xefe0b0, 0xe3e7d5, 0xe9d4c6, 0xdde3e8, 0xf2e3c0, 0xe6d9a8],
};
// 1階の店（看板の文字は Canvas で描いた図鑑テクスチャ。行番号 = 下の並び順）
const SHOP_NAMES = [
  'CAFÉ', 'KONDITOREI', 'APOTHEKE', 'BUCHHANDLUNG', 'TRAFIK', 'BÄCKEREI', 'JUWELIER', 'WEINHAUS',
  'FEINKOST', 'BLUMEN', 'HUTMACHER', 'UHREN & SCHMUCK', 'SCHUHE', 'GALERIE', 'FLEISCHEREI', 'MODEHAUS',
  'ANTIQUITÄTEN', 'ZUCKERL', 'OPTIK', 'PARFÜMERIE', 'RESTAURANT', 'EIS-SALON', 'DELIKATESSEN', 'TEEHAUS',
  'SPIELWAREN', 'Café Donau', 'Café Melange', 'Café Kaiserin', 'Café Augustin', 'Café Lindner', 'Konditorei Huber', 'Würstelstand',
];
const CAFE_ROWS = [25, 26, 27, 28, 29];      // カフェ建物に使う行
const KIOSK_ROW = 31;
const AWNING_COLORS = [0xb0302e, 0x2e5a3b, 0x1f3f73, 0x8a6a2a, 0x5a2d4f, 0x2b2b2b, 0xc8102e, 0x3a6b8a];
const SHUTTER_COLORS = [0x3f6b4a, 0x5a3a22, 0x2f4f3a, 0x6b4a2a];

// 看板の文字の図鑑（1024×1024、2 列 × 16 行、1 セル 512×64）。document が無い環境では null
function makeSignAtlas() {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 1024;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 1024, 1024);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  SHOP_NAMES.forEach((name, i) => {
    const col = i >> 4, row = i & 15;
    const cx = col * 512 + 256, cy = row * 64 + 32;
    const serif = /^[A-ZÄÖÜ&\- ]+$/.test(name);
    ctx.font = (serif ? '600 ' : 'italic 700 ') + (name.length > 13 ? 34 : 42) + 'px Georgia, "Times New Roman", serif';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(30,24,10,0.9)'; ctx.strokeText(name, cx, cy);
    ctx.fillStyle = '#ecc85e'; ctx.fillText(name, cx, cy);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
// 平面の UV を図鑑のセル (row) に合わせる
function atlasUV(geo, row) {
  const col = row >> 4, r = row & 15;
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, col * 0.5 + uv.getX(i) * 0.5, 1 - (r + 1) / 16 + uv.getY(i) / 16);
  return geo;
}

const FACADE = {
  A: { wall: PALETTE.wallA, trim: 0xf7f6f1, floors: [4.8, 3.8, 3.6, 3.5, 3.4, 3.2], bay: 3.4, win: [1.2, 2.3], balcony: 'row', cornice: 1.2, roof: { color: PALETTE.roofZinc, h: 5.0 }, pediments: false, dentils: true, bands: 2 },
  B: { wall: PALETTE.wallB, trim: 0xf0efe8, floors: [4.8, 3.0, 4.0, 3.7, 3.5, 3.3], bay: 3.7, win: [1.2, 2.3], balcony: 'center', cornice: 1.0, roof: { color: PALETTE.roofZinc, h: 4.5 }, pediments: true, dentils: false, bands: 1 },
  C: { wall: PALETTE.wallC, trim: PALETTE.trimC, floors: [5.2, 4.2, 4.0, 3.8, 3.6], bay: 5.0, win: [1.6, 3.0], balcony: 'none', cornice: 1.3, roof: { color: PALETTE.roofOpera, h: 5.5 }, pediments: false, dentils: true, bands: 1, pilasters: true, arcade: true },
  D: { wall: PALETTE.wallD, trim: 0xffffff, floors: [4.2, 3.4, 3.2, 3.0], bay: 3.0, win: [1.0, 1.8], balcony: 'none', cornice: 0.6, roof: { color: PALETTE.roofTile, h: 6.0 }, pediments: false, dentils: false, bands: 1, dormers: true },
};

const WALL_T = 0.45;
// CITY2 第 4 周: スマホ（mobile/low）の段。buildCity が設定し、小物の影・木の近景距離を切り替える
let LITE_MODE = false;

function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ============================================================================
// 素材
// ============================================================================
export async function loadCityAssets({ anisotropy = 8 } = {}) {
  const [cobble, plaster, asphalt, lantern, tableA, tableB, bench, plantA, plantB] = await Promise.all([
    loadPBR('cobblestone_floor_08', 'cobblestone_floor_08', { anisotropy }),
    loadPBR('painted_plaster_wall', 'painted_plaster_wall', { anisotropy }),
    loadPBR('asphalt_02', 'asphalt_02', { anisotropy }),
    loadGLB('models/props/street_lantern_isalousberg.glb'),
    loadGLB('models/props/table_round_small_a_quaternius.glb'),
    loadGLB('models/props/table_round_small_b_quaternius.glb'),
    loadGLB('models/props/bench_quaternius.glb'),
    loadGLB('models/props/houseplant_a_quaternius.glb'),
    loadGLB('models/props/houseplant_b_quaternius.glb'),
  ]);
  const granite = makeGraniteSlabs({});
  const chevron = makeChevronRoof({});
  return {
    tex: { cobble, plaster, asphalt, granite, chevron },
    models: {
      lantern: normalizeModel(lantern, { targetHeight: 4.2, forward: '+z' }),
      table: normalizeModel(tableA, { targetHeight: 0.74, forward: '+z' }),
      tableB: normalizeModel(tableB, { targetHeight: 0.74, forward: '+z' }),
      bench: normalizeModel(bench, { targetHeight: 0.9, forward: '+z' }),
      plant: normalizeModel(plantA, { targetHeight: 1.1, forward: '+z' }),
      plantB: normalizeModel(plantB, { targetHeight: 0.9, forward: '+z' }),
    },
  };
}

// ============================================================================
// マテリアル（街全体で共有。頂点色で棟ごとの色を付ける）
// ============================================================================
// 路面の法線マップを距離で弱める（x: 弱め始める距離 m、y: 一番弱くなる距離 m、z: 遠くでの倍率）。tests/_visual_flicker.html が前後比較で切り替える
export const GROUND_NORMAL_FADE = { value: new THREE.Vector3(18, 70, 0.2) };
// 路面の粗さマップの下限（粗さ = roughness × mix(下限, 1, マップ)）。石ごとの粗さの違いは残しつつ「濡れていない石」（0.85 以上）にする。0 で元のマップどおり
export const GROUND_ROUGH_MIN = { value: 0.85 };
// CITY2 2026-11-10: 路面の大きなムラ（世界座標の値ノイズ 2 段: 約 25m と約 6m の斑。x: 振幅 大, y: 振幅 小, z: 暗い斑を少し青く＝湿り）。
// 1 枚の繰り返しテクスチャが遠くまで同じ明るさで並び「板」に見えていたのを、汚れ・摩耗のムラで崩す。三角形・テクスチャは増えない
export const GROUND_MOTTLE = { value: new THREE.Vector3(0.22, 0.12, 0.05) };
export function groundMaterial(mat, normalScale = 0.7) {
  mat.normalScale.set(normalScale, normalScale);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.fkNormalFade = GROUND_NORMAL_FADE;
    shader.uniforms.fkRoughMin = GROUND_ROUGH_MIN;
    shader.uniforms.fkMottle = GROUND_MOTTLE;
    const chunk = THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * mix(1.0, fkNormalFade.z, smoothstep(fkNormalFade.x, fkNormalFade.y, length(vViewPosition)));');
    const rchunk = THREE.ShaderChunk.roughnessmap_fragment.replace('roughnessFactor *= texelRoughness.g;', 'roughnessFactor *= mix(fkRoughMin, 1.0, texelRoughness.g) * (1.0 - 0.18 * vFkGM);');
    shader.vertexShader = 'varying vec3 vFkGW;\n' + shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vFkGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const fn = `uniform vec3 fkNormalFade; uniform float fkRoughMin; uniform vec3 fkMottle; varying vec3 vFkGW; float vFkGM;
      float fkGHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float fkGNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(fkGHash(i), fkGHash(i + vec2(1,0)), f.x), mix(fkGHash(i + vec2(0,1)), fkGHash(i + vec2(1,1)), f.x), f.y); }\n`;
    const apply = `#include <map_fragment>
      { float n1 = fkGNoise(vFkGW.xz * 0.04), n2 = fkGNoise(vFkGW.xz * 0.17 + 5.3), n3 = fkGNoise(vFkGW.xz * 0.6 + 1.7);
        float m = (n1 - 0.5) * 2.0 * fkMottle.x + (n2 - 0.5) * 2.0 * fkMottle.y + (n3 - 0.5) * 0.06;
        vFkGM = clamp(-m * 3.0, 0.0, 1.0);
        diffuseColor.rgb *= (1.0 + m) * mix(vec3(1.0), vec3(0.94, 0.97, 1.04), vFkGM * fkMottle.z * 10.0); }`;
    shader.fragmentShader = fn + shader.fragmentShader.replace('#include <map_fragment>', apply).replace('#include <normal_fragment_maps>', chunk).replace('#include <roughnessmap_fragment>', rchunk);
  };
  mat.customProgramCacheKey = () => 'fkGround';
  mat.userData.fkGround = true;
  return mat;
}
// 2026-10-14 見た目の質（LOOK_REPORT 周 2）: 壁の汚れと石積みをシェーダで付ける（三角形・テクスチャを増やさない。低画質でも効く）
//   grime: 世界座標の高さで下ほど暗く（0〜2.8m で 0.72→1.0。雨はね・排気の汚れ）、大きなまだら（3D の値ノイズ、±7%）で漆喰の塗りむらを出す
//   courses: 石積みの目地（stone 材質だけ）。高さ 0.82m おきに幅 5cm の溝を暗くする。窓を横切らない（石の壁板にだけ掛かる）
export const FACADE_GRIME = { value: new THREE.Vector4(0.64, 3.2, 0.10, 0.0) }; // CITY2: 足元 0.72→0.64・高さ 2.8→3.2・まだら 0.07→0.10（近くで壁が一色の板に見えていた） // x: 足元の暗さ, y: 汚れの高さ m, z: まだらの振幅, w: 未使用
//   windows: ファサードを作らない面（裏・横・軽量版）の素の壁板に、UV（boxUVMeters: 1 単位 = 3m、原点は板の左下）から窓の列を描く。
//            1 階 4.8m の上に 3.6m ごと、ベイ 3.4m に 1.2×2.3m の暗いガラス + 白い枠 + 窓台。三角形ゼロで「のっぺりした箱」を無くす（LOOK_REPORT 周 3）
function facadeMaterial(mat, { courses = false, windows = false } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.fkGrime = FACADE_GRIME;
    shader.vertexShader = 'varying vec3 vFkW;\n' + shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vFkW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const fn = `uniform vec4 fkGrime; varying vec3 vFkW;
      float fkHash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float fkNoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(fkHash(i), fkHash(i + vec3(1,0,0)), f.x), mix(fkHash(i + vec3(0,1,0)), fkHash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(fkHash(i + vec3(0,0,1)), fkHash(i + vec3(1,0,1)), f.x), mix(fkHash(i + vec3(0,1,1)), fkHash(i + vec3(1,1,1)), f.x), f.y), f.z); }\n`;
    const apply = `#include <map_fragment>
      { float g = mix(fkGrime.x, 1.0, smoothstep(0.0, fkGrime.y, vFkW.y));
        float n = fkNoise(vFkW * 0.45) * 0.6 + fkNoise(vFkW * 1.7) * 0.4;
        g *= 1.0 + (n - 0.5) * 2.0 * fkGrime.z;
        ${courses ? 'float fy = fract(vFkW.y / 0.82); float e = min(fy, 1.0 - fy) * 0.82; g *= 1.0 - 0.42 * (1.0 - smoothstep(0.02, 0.05, e)); g *= 0.97 + 0.06 * fkNoise(vFkW * 3.0);' : ''}
        diffuseColor.rgb *= g;
        ${windows ? `vec2 m = vMapUv * 3.0;
        if (m.y > 4.8) {
          // CITY2 2026-11-10: 窓を「薄い四角」から「奥まったガラス」へ。窓ごとのハッシュで明るさを変え、上と片側に枠の落ち影、
          // ガラスは上が明るい（空の映り込み）、窓台の下に影の帯と雨だれ。三角形ゼロのまま
          float fy = mod(m.y - 4.8, 3.6), fxs = mod(m.x, 3.4) - 1.7, fx = abs(fxs);
          float wid = fkHash(vec3(floor(m.x / 3.4), floor((m.y - 4.8) / 3.6), 1.0));
          float win = step(fx, 0.6) * step(0.95, fy) * step(fy, 3.25);
          float frame = step(fx, 0.72) * step(0.83, fy) * step(fy, 3.37) * (1.0 - win);
          float sillB = step(fx, 0.85) * step(0.78, fy) * step(fy, 0.88);
          float lintel = step(fx, 0.82) * step(3.37, fy) * step(fy, 3.55);
          float bar = win * (step(abs(fxs), 0.03) + step(abs(fy - 2.1), 0.03));
          float inset = max(1.0 - smoothstep(0.0, 0.28, 3.25 - fy), 1.0 - smoothstep(0.0, 0.2, fxs + 0.6));
          vec3 glass = mix(vec3(0.07, 0.085, 0.10), vec3(0.30, 0.38, 0.48), smoothstep(1.2, 3.2, fy)) * (0.65 + 0.7 * wid);
          glass *= 1.0 - 0.7 * inset;
          float curtain = step(0.72, wid) * step(fy, 2.2); glass = mix(glass, vec3(0.62, 0.58, 0.50), curtain * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.89, 0.85), max(max(frame, sillB), lintel) * 0.85 + bar * 0.9);
          float sillShadow = step(fx, 0.85) * smoothstep(0.78, 0.60, fy) * step(0.45, fy);
          float streak = step(fx, 0.55) * smoothstep(0.78, 0.1, fy) * (0.5 + 0.5 * fkNoise(vFkW * vec3(6.0, 0.3, 6.0)));
          diffuseColor.rgb *= 1.0 - 0.35 * sillShadow - 0.12 * streak;
          // CITY2 第 3 周: 階ごとの帯（床の線に高さ 0.42m の明るい帯）と帯の下の影。遠景の殻・裏の壁板でも階が読める
          float band = 1.0 - step(0.42, fy);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.89, 0.85), band * 0.9);
          diffuseColor.rgb *= 1.0 - 0.25 * (1.0 - step(0.08, 3.6 - fy));
        } else {
          if (m.y > 4.42) { diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.89, 0.85), 0.9); } else {
          float fy2 = fract(m.y / 0.82); float e2 = min(fy2, 1.0 - fy2) * 0.82; diffuseColor.rgb *= 1.0 - 0.35 * (1.0 - smoothstep(0.02, 0.05, e2));
          diffuseColor.rgb *= vec3(0.92, 0.88, 0.82); }
        }` : ''} }`;
    shader.fragmentShader = fn + shader.fragmentShader.replace('#include <map_fragment>', apply);
  };
  mat.customProgramCacheKey = () => courses ? 'fkFacadeStone' : windows ? 'fkFacadeWin' : 'fkFacade';
  return mat;
}
function makeMaterials(tex) {
  const wall = facadeMaterial(new THREE.MeshStandardMaterial({ map: tex.plaster.map, normalMap: tex.plaster.normalMap, roughnessMap: tex.plaster.roughnessMap, aoMap: tex.plaster.aoMap, roughness: 1.0, metalness: 0.0, vertexColors: true, envMapIntensity: 0.55 }));
  wall.color.setRGB(1.55, 1.55, 1.55); // 漆喰テクスチャの平均が暗いので持ち上げる（頂点色 × map × これ）
  wall.normalScale.set(0.85, 0.85); // CITY2: 0.6→0.85（漆喰の塗りむらを近くで見せる）
  wall.aoMapIntensity = 0.8;
  // ファサードを作らない面の壁板（シェーダで窓の列を描く。1 棟につき draw call +1）
  const wallPlain = facadeMaterial(new THREE.MeshStandardMaterial({ map: tex.plaster.map, normalMap: tex.plaster.normalMap, roughnessMap: tex.plaster.roughnessMap, aoMap: tex.plaster.aoMap, roughness: 1.0, metalness: 0.0, vertexColors: true, envMapIntensity: 0.55 }), { windows: true });
  wallPlain.color.setRGB(1.55, 1.55, 1.55);
  wallPlain.normalScale.set(0.6, 0.6);
  wallPlain.aoMapIntensity = 0.8;
  const trim = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.82, metalness: 0.0, vertexColors: true, envMapIntensity: 0.5 });
  // 窓ガラス: 青灰で空が映る（写真 65fe9db7 の窓は空の反射で青っぽく光る）
  const glass = new THREE.MeshStandardMaterial({ color: 0x4a5a6c, roughness: 0.1, metalness: 0.7, envMapIntensity: 1.6 });
  const shopGlass = new THREE.MeshStandardMaterial({ color: 0x8fa3b4, roughness: 0.05, metalness: 0.8, envMapIntensity: 1.6, transparent: true, opacity: 0.55, depthWrite: false });
  const shopLight = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 1.0, vertexColors: true });
  const iron = new THREE.MeshStandardMaterial({ color: PALETTE.iron, roughness: 0.55, metalness: 0.6, envMapIntensity: 0.8 });
  // 屋根: 空に溶けないよう少し暗く・艶なし（写真 65fe9db7 の亜鉛屋根は青灰で空より暗い）
  const roof = new THREE.MeshStandardMaterial({ color: 0xc4c6ca, roughness: 0.8, metalness: 0.15, vertexColors: true, envMapIntensity: 0.5 });
  // CITY2 2026-11-10: 屋根に立はぜ（亜鉛板の継ぎ目。0.7m おきの暗い線）と、板ごとの明るさのムラ。uv は hipRoof の棟ローカル座標（1 単位 = 3m）
  roof.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec2 vFkRUv;\n' + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vFkRUv = uv * 3.0;');
    shader.fragmentShader = 'varying vec2 vFkRUv;\nfloat fkRHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      { float sx = fract(vFkRUv.x / 0.7); float seam = 1.0 - smoothstep(0.0, 0.05, min(sx, 1.0 - sx) * 0.7);
        float panel = fkRHash(vec2(floor(vFkRUv.x / 0.7), floor(vFkRUv.y / 2.4)));
        diffuseColor.rgb *= (1.0 - 0.28 * seam) * (0.9 + 0.2 * panel); }`);
  };
  roof.customProgramCacheKey = () => 'fkRoof';
  // CITY2 2026-11-10: 建物の足元の接地影（壁から外へ 1.6m、壁際が濃く外側で透明）。影の無いスマホでも建物が地面に「置いてある」ように見える。
  // 1 棟 4 枚の板。影は落とさない（Bucket.build で castShadow を切る）。遠く（60〜130m）では消す
  const footAO = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    uniforms: { fkA: { value: 0.55 } },
    vertexShader: 'varying vec2 vUv; varying float vD; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying vec2 vUv; varying float vD; uniform float fkA; void main(){ float t = 1.0 - vUv.y; float a = fkA * t * t * smoothstep(130.0, 60.0, vD); gl_FragColor = vec4(0.03, 0.03, 0.05, a); }',
  });
  footAO.name = 'footAO';
  // 街灯の灯室（昼なので灯りは弱く。乳白のガラスに少し暖かい自発光）
  const lampGlass = new THREE.MeshStandardMaterial({ color: 0xf2ecdc, emissive: 0xffe2b0, emissiveIntensity: 0.6, roughness: 0.35, metalness: 0.0, envMapIntensity: 0.6 });
  const wood = new THREE.MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.62, metalness: 0.0 });
  const gold = new THREE.MeshStandardMaterial({ color: PALETTE.gold, roughness: 0.32, metalness: 1.0, envMapIntensity: 1.2 });
  const sign = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1, vertexColors: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.9 });
  // 石（1 階のラスティカ・ランドマーク）: 頂点色は使わず砂岩の色 + シェーダの目地（facadeMaterial courses）
  const stone = facadeMaterial(new THREE.MeshStandardMaterial({ map: tex.plaster.map, normalMap: tex.plaster.normalMap, roughnessMap: tex.plaster.roughnessMap, color: PALETTE.stone, roughness: 1.0, envMapIntensity: 0.45 }), { courses: true });
  stone.color.setRGB(1.30, 1.27, 1.21); // 砂岩の灰ベージュ（写真 65fe9db7 の 1 階。0xb3a79a×1.42 は暖色に寄りすぎた。LOOK_REPORT 周 4）
  stone.normalScale.set(0.9, 0.9);
  const verdigris = new THREE.MeshStandardMaterial({ color: PALETTE.verdigris, roughness: 0.6, metalness: 0.25, envMapIntensity: 0.7 });
  const chevron = new THREE.MeshStandardMaterial({ map: tex.chevron, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.6 });
  // 2026-10-14 見た目（天才さん「角度によって床の光が変わって床チカチカ」）: 測ったら石畳の粗さマップ（ARM の G）は平均 0.58、
  // 26% の画素が 0.5 未満 ＝ 半分濡れた石。そこへ法線マップ 0.9 倍と空の映り込みが乗り、見る角度で鏡面がきらめいていた
  // （低画質は 0.75 倍の解像度でさらに粗く）。直し方: 路面は「濡れていない石」— 粗さマップを外して 0.88〜0.92 の固定、
  // 映り込みを弱め、法線マップは近くで 0.7 倍・18〜70m で 0.2 倍まで弱める（距離で滑らかに。質感は近くに残す）。詳細は VISUAL_REPORT.md
  // 粗さマップは残し、シェーダで下限 0.85 に持ち上げる（GROUND_ROUGH_MIN。石ごとの違いは残る）。粗さマップを外して一律 0.9 にした版は
  // tests/_visual_flicker.html の移動テストで 1 割ほど悪化した（一様な粗さだと法線ごとの鈍い鏡面が床全体に出て、動くと粒になる）
  const cobble = groundMaterial(new THREE.MeshStandardMaterial({ map: tex.cobble.map, normalMap: tex.cobble.normalMap, roughnessMap: tex.cobble.roughnessMap, aoMap: tex.cobble.aoMap, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.25 }), 0.7);
  const asphalt = groundMaterial(new THREE.MeshStandardMaterial({ map: tex.asphalt.map, normalMap: tex.asphalt.normalMap, roughnessMap: tex.asphalt.roughnessMap, aoMap: tex.asphalt.aoMap, roughness: 1.0, envMapIntensity: 0.2 }), 0.6);
  // 2026-10-14 見た目の質: 板石の路面が白飛びして影の縁も読めなかった（LOOK_REPORT 周 1）。写真 65fe9db7 の路面は中間の灰（#8e8c88 前後）
  const granite = groundMaterial(new THREE.MeshStandardMaterial({ map: tex.granite.map, normalMap: tex.granite.normalMap, roughnessMap: tex.granite.roughnessMap, color: 0x8f8d8a, roughness: 1.0, envMapIntensity: 0.3 }), 0.6);
  const plaza = groundMaterial(new THREE.MeshStandardMaterial({ map: tex.granite.map, normalMap: tex.granite.normalMap, roughnessMap: tex.granite.roughnessMap, color: 0x8a8884, roughness: 1.0, envMapIntensity: 0.25 }), 0.6); // 広場は暗めの花崗岩（P1 シュテファン広場 #5e5d60 寄り。晴れだと白飛びするため）
  const curb = new THREE.MeshStandardMaterial({ color: PALETTE.curb, roughness: 0.85, envMapIntensity: 0.4 });
  const courtyard = groundMaterial(new THREE.MeshStandardMaterial({ map: tex.granite.map, normalMap: tex.granite.normalMap, roughnessMap: tex.granite.roughnessMap, color: 0x7a7872, roughness: 1.0, envMapIntensity: 0.25 }), 0.5);
  const zebra = new THREE.MeshStandardMaterial({ color: PALETTE.zebra, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: 0.4 });
  const leaf = new THREE.MeshStandardMaterial({ color: PALETTE.leaf, roughness: 0.9, envMapIntensity: 0.5 });
  const trunk = new THREE.MeshStandardMaterial({ color: PALETTE.trunk, roughness: 0.95 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9a9a98, roughness: 0.35, metalness: 0.9, envMapIntensity: 1.0 });
  // 賑わい 2026-10-03: 看板の文字（図鑑テクスチャ、透過）、日よけ・旗（頂点色、両面、布）、花・商品（頂点色、艶なし）
  const atlas = makeSignAtlas();
  const signText = new THREE.MeshStandardMaterial({ color: 0xffffff, map: atlas || null, transparent: true, alphaTest: 0.35, roughness: 0.35, metalness: 0.5, envMapIntensity: 1.0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const awning = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.0, vertexColors: true, side: THREE.DoubleSide, envMapIntensity: 0.4 });
  const matte = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0, vertexColors: true, envMapIntensity: 0.4 });
  return { wall, wallPlain, trim, glass, shopGlass, shopLight, courtyard, plaza, iron, roof, wood, gold, sign, dark, stone, verdigris, chevron, cobble, asphalt, granite, curb, zebra, leaf, trunk, steel, signText, awning, matte, footAO, lampGlass };
}

// ============================================================================
// ジオメトリのユーティリティ
// ============================================================================
const _c = new THREE.Color();
function colorize(geo, color) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  _c.set(color);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
// BoxGeometry の UV を実寸（m）に合わせる（テクスチャが 1 ユニット = metersPerUV m で貼れる）
function boxUVMeters(geo, w, h, d, metersPerUV = 3.0) {
  const uv = geo.attributes.uv;
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // +x -x +y -y +z -z
  for (let f = 0; f < 6; f++) {
    const [fu, fv] = faces[f];
    for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, uv.getX(k) * fu / metersPerUV, uv.getY(k) * fv / metersPerUV); }
  }
  return geo;
}

// 「バケツ」: マテリアルごとにジオメトリを溜めて最後に 1 メッシュにする
class Bucket {
  constructor() { this.map = new Map(); }
  add(matKey, geo, matrix, color) {
    if (geo.index) { const ni = geo.toNonIndexed(); geo.dispose(); geo = ni; }
    if (matrix) geo.applyMatrix4(matrix);
    if (!geo.attributes.color) colorize(geo, color ?? 0xffffff);
    if (!this.map.has(matKey)) this.map.set(matKey, []);
    this.map.get(matKey).push(geo);
  }
  absorb(other, matrix) {
    for (const [key, geos] of other.map) {
      if (!this.map.has(key)) this.map.set(key, []);
      const dst = this.map.get(key);
      for (const g of geos) { if (matrix) g.applyMatrix4(matrix); dst.push(g); }
    }
    other.map.clear();
  }
  build(materials, { castShadow = true, receiveShadow = true } = {}) {
    const group = new THREE.Group();
    for (const [key, geos] of this.map) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.castShadow = castShadow && key !== 'footAO'; mesh.receiveShadow = receiveShadow && key !== 'footAO';
      mesh.name = key;
      if (key === 'footAO') mesh.renderOrder = 5;
      group.add(mesh);
    }
    return group;
  }
}

const _m = new THREE.Matrix4();
function box(w, h, d, uvMeters) { const g = new THREE.BoxGeometry(w, h, d); if (uvMeters) boxUVMeters(g, w, h, d, uvMeters); return g; }
function translated(geo, x, y, z) { geo.applyMatrix4(_m.makeTranslation(x, y, z)); return geo; }

// ファサード座標 (u 横, v 上, n 外向き; 壁面が n = 0) → 棟ローカル座標への行列
function faceMatrix(face, w, d) {
  const M = new THREE.Matrix4();
  switch (face) {
    case 'front': M.makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).setPosition(d / 2, 0, 0); break;
    case 'back':  M.makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)).setPosition(-d / 2, 0, 0); break;
    case 'left':  M.makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)).setPosition(0, 0, w / 2); break;   // 正面から見て左（+z 側）
    case 'right': M.makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)).setPosition(0, 0, -w / 2); break;
  }
  return M;
}

// ============================================================================
// 建物 1 棟
// ============================================================================
function buildBuilding(b, materials, rng, { lite = false } = {}) {
  const B = buildBuildingBucket(b, materials, rng, { lite });
  const g = B.build(materials);
  g.position.set(b.x, 0, b.z);
  g.rotation.y = -(b.yaw || 0);
  g.userData.building = b;
  return g;
}

function buildBuildingBucket(b, materials, rng, { lite = false, boxOnly = false } = {}) {
  const style = FACADE[b.style] || FACADE.B;
  const seed = b.seed ?? Math.floor(rng() * 1e9);
  const r = mulberry(seed);
  const floors = b.floors || style.floors;
  const totalH = floors.reduce((a, c) => a + c, 0);
  // 壁の色: 様式ごとの候補から棟ごとに選ぶ（賑わい 2026-10-03。以前は B が全部クリーム）。ランドマーク（seed 77）は元の色
  const variants = WALL_VARIANTS[b.style] || null;
  const wallColor = variants && b.seed !== 77 ? variants[Math.floor(r() * variants.length)] : (Array.isArray(style.wall) ? style.wall[Math.floor(r() * style.wall.length)] : style.wall);
  const tint = new THREE.Color(wallColor).offsetHSL(0, 0, (r() - 0.5) * 0.06);
  // カフェ建物: 看板はカフェ名、日よけは全ベイ同色、正面の歩道に屋外席（席は sim の props）
  const cafeRow = b.cafe ? CAFE_ROWS[Math.floor(r() * CAFE_ROWS.length)] : -1;
  const cafeAwning = new THREE.Color(AWNING_COLORS[Math.floor(r() * AWNING_COLORS.length)]);
  const trimColor = new THREE.Color(style.trim);
  // CITY2 2026-11-10: 屋根の色と高さのばらつき（3 割は赤茶の瓦、1 割は暗いスレート。高さ 0.85〜1.25 倍）。通りの屋根並みが一色の帯にならない
  const roofPick = r();
  const roofColor = new THREE.Color(roofPick < 0.3 && b.seed !== 77 ? PALETTE.roofTile : roofPick < 0.4 && b.seed !== 77 ? 0x4e5259 : style.roof.color).offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.1, (r() - 0.5) * 0.12);
  const roofHMul = 0.85 + r() * 0.4;
  const B = new Bucket();
  const faces = boxOnly ? [] : (b.faces || ['front']);
  const w = b.w, d = b.d;

  // 本体（ファサードの裏を埋める。壁厚ぶん内側に引っ込めて、窓の奥に顔を出さないようにする）
  B.add('wall', translated(box(d - 2 * WALL_T - 0.04, totalH, w - 2 * WALL_T - 0.04, 3.0), 0, totalH / 2, 0), null, tint);
  // CITY2 2026-11-10: 足元の接地影（4 面。角は重ねて濃くする）。歩道の上面 0.15m のすぐ上に置く（道路・広場では 13〜16cm 浮くが、端は透明なので見えない）
  if (!boxOnly) {
    const L = 1.6;
    for (const face of ['front', 'back', 'left', 'right']) {
      const fw = (face === 'front' || face === 'back' ? w : d) + 2 * L;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-fw / 2, 0, 0, fw / 2, 0, 0, fw / 2, 0, L, -fw / 2, 0, L], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setIndex([0, 2, 1, 0, 3, 2]);   // 上向き（facade 座標は u 右・n 外向きで、[0,1,2] だと法線が下を向き裏面として消える。最初の撮影で見えなかった原因）
      B.add('footAO', translated(g, 0, 0.16, 0), faceMatrix(face, w, d));
    }
  }
  // ファサードを作らない面は、素の壁板で塞ぐ
  for (const face of ['front', 'back', 'left', 'right']) {
    if (faces.includes(face)) continue;
    const fw = face === 'front' || face === 'back' ? w : d;
    // 2026-10-14 見た目の質: 素の壁板は 'wallPlain'（シェーダで窓の列を描く。のっぺりした箱を無くす）
    B.add('wallPlain', translated(box(fw, totalH, WALL_T, 3.0), 0, totalH / 2, -WALL_T / 2), faceMatrix(face, w, d), tint);
  }

  for (const face of faces) {
    const fw = face === 'front' || face === 'back' ? w : d;
    const M = faceMatrix(face, w, d);
    const SIGN_COLORS = [0x15130f, 0x1f3a2e, 0x4a1a1a, 0x1b2436, 0x2e2a26, 0x3a2f14];
    const signColor = new THREE.Color(SIGN_COLORS[Math.floor(r() * SIGN_COLORS.length)]);
    const shopLightColor = new THREE.Color().setHSL(0.09 + r() * 0.04, 0.5, 0.6 + r() * 0.2);
    const isCafeFace = !!b.cafe && (b.cafeFace || 'front') === face;
    buildFacade(B, style, floors, fw, M, { tint, trimColor, r, isFront: face === 'front', d, w, face, signColor, shopLightColor, lite, cafeRow: isCafeFace ? cafeRow : -1, cafeAwning, shutterColor: new THREE.Color(SHUTTER_COLORS[Math.floor(r() * SHUTTER_COLORS.length)]) });
    // 赤白赤の旗（詳細版だけ。1 階の上に斜めの旗竿、旗は竿に沿って垂れる）
    if (!lite && (face === 'front' || isCafeFace) && r() < 0.35) {
      const u = (r() - 0.5) * fw * 0.6, v0 = floors[0] + 1.3, Lp = 2.2;
      const pole = new THREE.CylinderGeometry(0.03, 0.035, Lp, 6); pole.translate(0, Lp / 2, 0); pole.rotateX(Math.PI * 55 / 180); pole.translate(u, v0, 0);
      B.add('iron', pole, M);
      B.add('gold', new THREE.SphereGeometry(0.06, 6, 5).translate(u, v0 + Lp * Math.sin(Math.PI * 35 / 180), Lp * Math.cos(Math.PI * 35 / 180)), M);
      const cols = [0xc8102e, 0xf2efe6, 0xc8102e];
      for (let k = 0; k < 3; k++) {
        const s = new THREE.PlaneGeometry(1.4, 0.34); s.rotateY(Math.PI / 2); s.translate(0, -0.17 - k * 0.34, 1.2); s.rotateX(-Math.PI * 35 / 180); s.translate(u, v0, 0);
        B.add('awning', s, M, new THREE.Color(cols[k]));
      }
    }
  }

  // コーニス（全周）: 3 段の出 + 歯飾り
  const cz = style.cornice;
  const topY = totalH;
  const outs = [0.25, 0.5, 0.78];
  for (let i = 0; i < 3; i++) {
    const hh = cz / 3;
    const o = outs[i];
    B.add('trim', translated(box(d + 2 * o, hh, w + 2 * o), 0, topY - cz + hh * (i + 0.5), 0), null, trimColor);
  }
  if (style.dentils && !lite) {
    const dy = topY - cz + cz / 3 * 2 - 0.08;
    const pitch = LITE_MODE ? 0.84 : 0.42; // 2026-10-14 見た目の質: 0.32 → 0.42（三角形を減らす。歯飾りは遠目には帯に見える）。第 4 周: スマホは 0.84
    for (const face of faces) {
      const fw = face === 'front' || face === 'back' ? w : d;
      const M = faceMatrix(face, w, d);
      const n0 = Math.floor(fw / pitch);
      for (let i = 0; i < n0; i++) {
        const u = -fw / 2 + (i + 0.5) * pitch;
        B.add('trim', translated(box(0.15, 0.16, 0.22), u, dy, 0.67), M, trimColor);
      }
    }
  }
  // アティカ（屋根上の手すり壁）
  B.add('trim', translated(box(d + 0.2, 0.7, w + 0.2), 0, topY + 0.35, 0), null, trimColor);

  // 屋根（寄棟）
  const rh = style.roof.h * roofHMul;
  const eaveY = topY + 0.7;
  B.add('roof', hipRoof(d + 0.3, w + 0.3, rh, Math.min(d, w) * 0.28, eaveY), null, roofColor);
  // 煙突
  const nCh = 2 + Math.floor(r() * 2);
  for (let i = 0; i < nCh; i++) {
    const cx = (r() - 0.5) * (d * 0.5), cz2 = (r() - 0.5) * (w * 0.7);
    B.add('trim', translated(box(0.7, 1.4, 0.7), cx, eaveY + rh * 0.6 + 0.7, cz2), null, new THREE.Color(0xd8d0c0));
  }
  // ドーマー（正面の屋根面）
  if (!lite && (style.dormers || r() < 0.5)) {
    const nD = Math.max(1, Math.floor(w / 7));
    for (let i = 0; i < nD; i++) {
      const z = -w / 2 + (w / nD) * (i + 0.5);
      const x = d / 2 - 1.2;
      B.add('trim', translated(box(1.4, 1.4, 1.3), x, eaveY + 0.9, z), null, trimColor);
      const dg = new THREE.PlaneGeometry(0.8, 0.9); dg.rotateY(Math.PI / 2); dg.applyMatrix4(_m.makeTranslation(x + 0.71, eaveY + 0.95, z));
      B.add('glass', dg, null);
      B.add('roof', translated(box(1.2, 0.3, 1.6), x, eaveY + 1.7, z), null, roofColor);
    }
  }

  return B;
}

// 屋根面の板ガラスなどに使う: 平面を n 方向に向けた上で facade→local 行列を掛ける
function plane(wd, ht, u, v, n) {
  const g = new THREE.PlaneGeometry(wd, ht);
  g.applyMatrix4(_m.makeTranslation(u, v, n));
  return g;
}

function buildFacade(B, style, floors, fw, M, ctx) {
  const { tint, trimColor, r, isFront, lite } = ctx;
  const [ww0, wh0] = style.win;
  const endPier = Math.max(0.9, (fw % style.bay) / 2 + 0.6);
  let nBays = Math.max(1, Math.floor((fw - 2 * endPier) / style.bay));
  const bay = (fw - 2 * endPier) / nBays;
  const centerBay = Math.floor(nBays / 2);
  const T = WALL_T;
  let y0 = 0;
  const hasArcade = style.arcade && isFront;
  // CITY2 第 3 周: リザリート（中央 3 ベイの張り出し 0.55m）。幅 26m 以上・5 ベイ以上の面（詳細版）。「窓の格子が並ぶ平らな壁」を割る
  // t=20 の「大きな壁」は幅 15〜20m の棟が 4〜5 棟並んだもの（26m 以上の棟は無かった）。幅 18m 以上・4 ベイ以上なら中央を張り出す。屋根の上の飾りは 26m 以上だけ
  // 第 4 周: 幅 18m では 3 ベイにしかならず（端の壁柱が広い）条件に掛からなかった → 3 ベイ以上。5 ベイ未満は中央 1 ベイだけ張り出す
  const riz = !hasArcade && fw > 14 && nBays >= 3 ? (fw > 26 ? 0.55 : 0.4) : 0;
  const rizHalf = nBays >= 5 ? 1 : 0;
  const inRiz = (i) => riz > 0 && Math.abs(i - centerBay) <= rizHalf;
  const Mr = riz ? M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, riz)) : M;
  const M0 = M;

  for (let f = 0; f < floors.length; f++) {
    const H = floors[f];
    const ground = f === 0;
    const bel = f === (style.floors.length >= 6 ? 2 : 1); // Beletage
    const top = f === floors.length - 1;
    // CITY2 第 3 周: 窓の大きさを階で変える（最上階は小さく 0.85×0.75、Beletage は大きく +0.2/+0.5。階の高さに収まるように上限）
    const ww = ground ? Math.min(bay - 0.9, 3.0) : top ? ww0 * 0.85 : bel ? ww0 + 0.2 : ww0;
    const sill = ground ? (hasArcade ? 0.0 : 0.45) : 0.95;
    const wh = ground ? (hasArcade ? H - 0.9 : H - 1.2) : Math.min(H - sill - 0.3, top ? wh0 * 0.75 : bel ? wh0 + 0.5 : wh0);
    const above = H - sill - wh;

    // 2026-10-14 見た目の質: 1 階は石積み（ラスティカ）。'stone' 材質（砂岩 + シェーダの目地）で、上階の漆喰と色・質感を分ける（写真 dc318c81 / 65fe9db7 の 1 階）
    const wallKey = ground && !hasArcade ? 'stone' : 'wall';
    // 端の壁柱
    for (const s of [-1, 1]) {
      B.add(wallKey, translated(box(endPier, H, T, 3.0), s * (fw / 2 - endPier / 2), y0 + H / 2, -T / 2), M, tint);
    }
    for (let i = 0; i < nBays; i++) {
      const u = -fw / 2 + endPier + bay * (i + 0.5);
      const isDoor = ground && i === centerBay && !hasArcade;   // 第 4 周: 入口の扉を正面以外の面（広場側など）にも
      const rz = inRiz(i); const M = rz ? Mr : M0; const Tb = T + (rz ? riz : 0);   // リザリートのベイは面ごと前へ。壁は厚くして元の壁まで届かせる
      // 窓の左右の壁柱（隣のベイと共有するので右側だけ。左端は最初のベイだけ。リザリートのベイは左側も自分で持つ）
      const pierW = bay - ww;
      if (i === 0 || rz) B.add(wallKey, translated(box(pierW / 2, H, Tb, 3.0), u - ww / 2 - pierW / 4, y0 + H / 2, -Tb / 2), M, tint);
      B.add(wallKey, translated(box(i === nBays - 1 ? pierW / 2 : pierW, H, Tb, 3.0), u + ww / 2 + (i === nBays - 1 ? pierW / 4 : pierW / 2), y0 + H / 2, -Tb / 2), M, tint);
      // 窓上下の壁
      if (sill > 0.01 && !isDoor) B.add(wallKey, translated(box(ww, sill, Tb, 3.0), u, y0 + sill / 2, -Tb / 2), M, tint);
      if (above > 0.01) B.add(wallKey, translated(box(ww, above, Tb, 3.0), u, y0 + sill + wh + above / 2, -Tb / 2), M, tint);

      const wy = y0 + sill + wh / 2;
      // CITY2 2026-11-10: 窓の奥行き。ガラスの手前（n = −0.235）に、上枠の落ち影（上が濃く下へ透明、高さ 0.55m）と左枠の影（幅 0.22m）を置く。
      // 24cm 凹んでいても影が無いと正面からは平らに見えていた。材質は footAO（uv.y 0 で濃く 1 で透明）。1 窓 +4 三角形
      if (!ground || hasArcade) {
        const sh = Math.min(0.55, wh * 0.3), sw2 = Math.min(0.22, ww * 0.2), yTop = y0 + sill + wh - 0.05;
        const q = (x0, x1, yb, yt, flipU) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([x0, yb, -0.235, x1, yb, -0.235, x1, yt, -0.235, x0, yt, -0.235], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(flipU ? [0, 0, 1, 1, 1, 1, 0, 0] : [0, 1, 1, 1, 1, 0, 0, 0], 2)); g.setIndex([0, 1, 2, 0, 2, 3]); return g; };
        B.add('footAO', q(u - ww / 2 + 0.05, u + ww / 2 - 0.05, yTop - sh, yTop, false), M);
        B.add('footAO', q(u - ww / 2 + 0.05, u - ww / 2 + 0.05 + sw2, y0 + sill + 0.05, yTop, true), M);
      }
      if (lite) {
        // 軽量版（遠景・2 列目）: ガラス + 白い枠の板 + 店は看板帯だけ
        // CITY2 第 3 周: 軽量版にも窓上のまぐさ帯と Beletage のペディメント（スマホは 60m 先から軽量版なので平らに見えていた）。店の奥と看板は箱 → 板で相殺
        if (ground && !isDoor) { B.add('shopGlass', plane(ww - 0.16, wh - 0.16, u, wy, -0.26), M); B.add('dark', plane(ww, wh, u, wy, -T + 0.06), M); B.add('sign', plane(ww + 0.3, 0.55, u, y0 + sill + wh + 0.35, 0.06), M, ctx.signColor); }
        else if (isDoor) { B.add('wood', translated(box(ww - 0.3, wh - 0.2, 0.08), u, y0 + (wh - 0.2) / 2, -0.32), M); }
        else {
          B.add('trim', plane(ww, wh, u, wy, -0.18), M, trimColor); B.add('glass', plane(ww - 0.18, wh - 0.18, u, wy, -0.17), M); B.add('trim', plane(ww + 0.3, 0.12, u, y0 + sill - 0.06, 0.15), M, trimColor);
          if (!top) B.add('trim', plane(ww + 0.5, 0.3, u, y0 + sill + wh + 0.17, 0.19), M, trimColor);   // 第 4 周: 箱 → 板（三角形 1/6）
          if (bel && (style.pediments || style.dentils)) B.add('trim', pedimentGeo(ww + 0.7, 0.7, 0.3, u, y0 + sill + wh + 0.34), M, trimColor);
        }
        continue;
      }
      if (ground) {
        if (isDoor) {
          // 木の扉（二枚）+ 枠 + 半円のトランサム
          B.add('wood', translated(box(ww - 0.3, wh - 0.2, 0.08), u, y0 + (wh - 0.2) / 2, -0.32), M);
          B.add('trim', translated(box(0.12, wh, 0.3), u - ww / 2 + 0.06, y0 + wh / 2, -0.15), M, trimColor);
          B.add('trim', translated(box(0.12, wh, 0.3), u + ww / 2 - 0.06, y0 + wh / 2, -0.15), M, trimColor);
          B.add('trim', translated(box(ww, 0.14, 0.3), u, y0 + wh - 0.07, -0.15), M, trimColor);
          B.add('iron', translated(box(0.05, wh - 0.3, 0.05), u, y0 + (wh - 0.2) / 2, -0.27), M);
          B.add('gold', translated(box(0.04, 0.3, 0.04), u + 0.12, y0 + 1.05, -0.26), M);
          // 番地札（白地）と呼び鈴
          B.add('trim', translated(box(0.22, 0.14, 0.03), u + ww / 2 + 0.35, y0 + 2.2, 0.015), M, new THREE.Color(0xf4f1ea));
        } else if (hasArcade) {
          // アーケード: 暗い奥行き + 石の柱
          B.add('dark', translated(box(ww, wh, 0.1), u, wy, -T + 0.05), M);
          B.add('trim', translated(box(0.5, wh, 0.6), u - ww / 2 + 0.25, wy, -0.3), M, trimColor);
          B.add('trim', translated(box(ww + 0.4, 0.5, 0.5), u, y0 + wh + 0.25, -0.25), M, trimColor);
        } else {
          // 店舗: 大きなガラス + 黒い枠 + 看板帯（金の細線）+ 看板の文字 + 商品 + 日よけ（賑わい 2026-10-03）
          const isCafe = ctx.cafeRow >= 0;
          const row = isCafe ? ctx.cafeRow : Math.floor(r() * 25);
          B.add('shopGlass', plane(ww - 0.16, wh - 0.16, u, wy, -0.26), M);
          B.add('shopLight', plane(ww - 0.3, wh - 0.5, u, wy + 0.1, -0.42), M, ctx.shopLightColor);
          B.add('dark', translated(box(ww, wh, 0.06), u, wy, -T + 0.03), M);
          // ショーウィンドウの中の棚（暗いシルエット）と、色のついた商品（本・ケーキ・瓶の気配）
          B.add('dark', translated(box(ww - 0.6, 0.06, 0.3), u, y0 + sill + 0.9, -0.36), M);
          const nGoods = 3 + Math.floor(r() * 3);
          for (let gk = 0; gk < nGoods; gk++) {
            const gw = 0.18 + r() * 0.22, gh = 0.18 + r() * 0.3;
            const gu = u - (ww - 0.8) / 2 + ((ww - 0.8) * (gk + 0.5)) / nGoods;
            const gc = new THREE.Color().setHSL(r(), 0.45 + r() * 0.3, 0.42 + r() * 0.25);
            B.add('matte', translated(box(gw, gh, 0.16), gu, y0 + sill + 0.93 + gh / 2, -0.36), M, gc);
          }
          B.add('iron', translated(box(ww, 0.08, 0.1), u, y0 + sill + 0.04, -0.2), M);
          B.add('iron', translated(box(ww, 0.08, 0.1), u, y0 + sill + wh - 0.04, -0.2), M);
          B.add('iron', translated(box(0.08, wh, 0.1), u - ww / 2 + 0.04, wy, -0.2), M);
          B.add('iron', translated(box(0.08, wh, 0.1), u + ww / 2 - 0.04, wy, -0.2), M);
          B.add('iron', translated(box(0.05, wh, 0.06), u, wy, -0.22), M);
          const signY = y0 + sill + wh + 0.35;
          B.add('sign', translated(box(ww + 0.3, 0.55, 0.12), u, signY, 0.0), M, ctx.signColor);
          B.add('gold', translated(box(ww + 0.1, 0.02, 0.02), u, y0 + sill + wh + 0.12, 0.07), M);
          B.add('gold', translated(box(ww + 0.1, 0.02, 0.02), u, y0 + sill + wh + 0.58, 0.07), M);
          // 看板の文字（図鑑の 1 行。幅:高さ = 8:1）
          const tw = Math.min(ww + 0.1, 3.2), th = tw / 8;
          B.add('signText', atlasUV(plane(tw, th, u, signY, 0.075), row), M);
          // 日よけ（ストライプ。色 + 白の帯を 0.3m おき、傾き 24°、出 1.1m、前に垂れ 0.2m）。カフェは全ベイ同色
          if (isCafe || r() < 0.55) {
            const col = isCafe ? ctx.cafeAwning : new THREE.Color(AWNING_COLORS[Math.floor(r() * AWNING_COLORS.length)]);
            const white = new THREE.Color(0xf2efe6);
            const aw = ww + 0.5, len = 1.1, ang = Math.PI * 24 / 180, top = y0 + sill + wh + 0.06;
            const nS = Math.max(3, Math.round(aw / 0.3));
            const sw = aw / nS;
            // 布は厚みの無い平面（両面材質）。箱だと 6 倍の頂点になりメモリ上限（低画質 160MB）に迫った
            for (let k = 0; k < nS; k++) {
              const s = new THREE.PlaneGeometry(sw, len); s.rotateX(-Math.PI / 2); s.translate(0, 0, len / 2); s.rotateX(ang); s.translate(u - aw / 2 + sw * (k + 0.5), top, 0);
              B.add('awning', s, M, k % 2 ? white : col);
            }
            const val = new THREE.PlaneGeometry(aw, 0.2); val.translate(u, top - Math.sin(ang) * len - 0.1, Math.cos(ang) * len);
            B.add('awning', val, M, col);
            // 支え棒 2 本
            for (const s of [-1, 1]) { const rod = new THREE.CylinderGeometry(0.015, 0.015, len + 0.1, 5); rod.rotateX(Math.PI / 2 + ang); rod.translate(u + s * (aw / 2 - 0.1), top - Math.sin(ang) * len / 2, Math.cos(ang) * len / 2); B.add('iron', rod, M); }
          }
          // 玄関マット代わりの石段
          B.add('trim', translated(box(ww + 0.2, 0.12, 0.5), u, y0 + 0.06, 0.25), M, new THREE.Color(0xb0afb3));
        }
      } else {
        // 上階の窓: 奥まったガラス + 白い枠 + 十字の桟 + 窓台 + まぐさ
        // 賑わい 2026-10-03: 窓のばらつき（灯り・カーテン・鎧戸・花箱）。様式 D は鎧戸が多い
        const pick = r();
        const lit = pick < 0.10, curtain = pick >= 0.10 && pick < 0.26, shutters = pick >= 0.26 && pick < (style.dormers ? 0.6 : 0.42), flowers = pick >= 0.6 && pick < 0.78;
        if (lit) B.add('shopLight', plane(ww - 0.1, wh - 0.1, u, wy, -0.24), M, new THREE.Color().setHSL(0.09, 0.55, 0.62));
        else B.add('glass', plane(ww - 0.1, wh - 0.1, u, wy, -0.24), M);
        if (curtain) B.add('trim', plane(ww - 0.2, wh * 0.55, u, y0 + sill + wh * 0.275 + 0.05, -0.225), M, new THREE.Color(0xf3efe6));
        if (shutters) {
          for (const s of [-1, 1]) B.add('matte', translated(box(ww * 0.46, wh - 0.05, 0.05), u + s * (ww / 2 + ww * 0.23 + 0.06), wy, 0.03), M, ctx.shutterColor);
        }
        if (flowers) {
          B.add('matte', translated(box(ww - 0.05, 0.22, 0.26), u, y0 + sill + 0.11, 0.13), M, new THREE.Color(0x9a5a3a));
          const nF = 3;
          for (let k = 0; k < nF; k++) {
            const fx = u - (ww - 0.3) / 2 + ((ww - 0.3) * (k + 0.5)) / nF;
            B.add('matte', new THREE.OctahedronGeometry(0.13, 0).scale(1, 0.7, 1).translate(fx, y0 + sill + 0.3, 0.18), M, new THREE.Color([0xc8102e, 0xe0507a, 0xd8d0c0, 0xc8102e][Math.floor(r() * 4)]));
          }
          B.add('matte', new THREE.OctahedronGeometry(0.16, 0).scale(ww * 2.6, 0.5, 1.1).translate(u, y0 + sill + 0.22, 0.2), M, new THREE.Color(0x4f7a3a));
        }
        const fr = 0.09;
        if (LITE_MODE) {
          B.add('trim', plane(ww, wh, u, wy, -0.225), M, trimColor);   // 第 4 周: スマホは枠を 1 枚の板（ガラスの後ろ。4 箱 48 → 2 三角形）
        } else {
          B.add('trim', translated(box(fr, wh, 0.07), u - ww / 2 + fr / 2, wy, -0.19), M, trimColor);
          B.add('trim', translated(box(fr, wh, 0.07), u + ww / 2 - fr / 2, wy, -0.19), M, trimColor);
          B.add('trim', translated(box(ww, fr, 0.07), u, y0 + sill + wh - fr / 2, -0.19), M, trimColor);
          B.add('trim', translated(box(ww, fr, 0.07), u, y0 + sill + fr / 2, -0.19), M, trimColor);
        }
        B.add('trim', plane(0.06, wh, u, wy, -0.2), M, trimColor);   // 第 4 周: 十字の桟は板（箱の 1/6）
        B.add('trim', plane(ww, 0.06, u, y0 + sill + wh * 0.62, -0.2), M, trimColor);
        // 窓台
        B.add('trim', translated(box(ww + 0.3, 0.1, 0.22), u, y0 + sill - 0.05, 0.04), M, trimColor);
        // 窓上の飾り（まぐさ帯 / Beletage はペディメント）
        if (!top) {
          // CITY2 2026-11-10: 窓上の飾りを大きく。まぐさ帯 0.28→0.36・出 0.18→0.3、両端に持ち送り（ブラケット）。Beletage は三角ペディメント（様式 A/B）か太い段付きの庇（C/D）
          B.add('trim', translated(box(ww + 0.5, 0.36, 0.3), u, y0 + sill + wh + 0.2, 0.1), M, trimColor);
          if (!LITE_MODE) for (const sb of [-1, 1]) B.add('trim', translated(box(0.16, 0.3, 0.26), u + sb * (ww / 2 + 0.1), y0 + sill + wh - 0.1, 0.1), M, trimColor);   // 持ち送りは PC だけ
          if (bel && (style.pediments || style.dentils)) {
            B.add('trim', pedimentGeo(ww + 0.7, 0.7, 0.3, u, y0 + sill + wh + 0.38), M, trimColor);
          } else if (bel) {
            B.add('trim', translated(box(ww + 0.8, 0.18, 0.42), u, y0 + sill + wh + 0.47, 0.14), M, trimColor);
          }
          // 窓下の腰パネル
          if (bel) B.add('trim', translated(box(ww - 0.1, 0.32, 0.05), u, y0 + sill - 0.35, 0.0), M, trimColor);
        }
        // 壁柱（ピラスター）
        if (style.pilasters && i < nBays - 1) B.add('trim', translated(box(0.6, H, 0.25), u + bay / 2, y0 + H / 2, 0.1), M, trimColor);
        // バルコニー
        const balc = style.balcony === 'row' ? bel : style.balcony === 'center' ? bel && i === centerBay : false;
        if (balc) {
          const bw = style.balcony === 'center' ? Math.min(fw - 2, ww + 2.4) : ww + 0.9;
          B.add('trim', translated(box(bw, 0.2, 1.1), u, y0 + sill - 0.3, 0.55), M, trimColor);
          B.add('trim', translated(box(0.35, 0.5, 0.5), u - bw / 2 + 0.4, y0 + sill - 0.7, 0.3), M, trimColor);
          B.add('trim', translated(box(0.35, 0.5, 0.5), u + bw / 2 - 0.4, y0 + sill - 0.7, 0.3), M, trimColor);
          // 鋳鉄の手すり
          const ry = y0 + sill - 0.2;
          B.add('iron', translated(box(bw, 0.05, 0.05), u, ry + 1.0, 1.08), M);
          B.add('iron', translated(box(0.05, 1.0, 0.05), u - bw / 2 + 0.02, ry + 0.5, 1.08), M);
          B.add('iron', translated(box(0.05, 1.0, 0.05), u + bw / 2 - 0.02, ry + 0.5, 1.08), M);
          // 2026-10-14 見た目の質: 三角形が上限（低画質 90 万）に当たったので、手すりの縦棒を 0.13m → 0.2m 間隔、飾り棒 6→4 本に（画面では区別がつかない）
          const nb = Math.floor(bw / (LITE_MODE ? 0.32 : 0.2));   // 第 4 周: スマホは 0.32m 間隔
          for (let k = 1; k < nb; k++) B.add('iron', translated(box(0.025, 0.95, 0.025), u - bw / 2 + (bw / nb) * k, ry + 0.5, 1.08), M);
          if (!LITE_MODE) for (let k = 1; k < 5; k++) B.add('iron', translated(box(0.025, 0.95, 0.025), u + (k % 2 ? -1 : 1) * 0.5 * (1.1 - k * 0.05), ry + 0.5, 0.55 * 0.5 + 0.8), M);
        }
      }
    }
    // 階層帯（コルドン）
    // CITY2 2026-11-10: 階の帯（コルドン）を太く・出を大きく（0.3×0.16 → 0.46×0.34）、軽量版にも付ける。Beletage の下は 2 段。「大きな形」で階が読める
    if (!ground && (f % style.bands === 0 || bel)) { B.add('trim', translated(box(fw + 0.04, 0.46, 0.34), 0, y0 + 0.23, 0.17), M, trimColor); if (bel) B.add('trim', translated(box(fw + 0.04, 0.16, 0.5), 0, y0 + 0.54, 0.25), M, trimColor); }
    // 地上階のルスティカ: 横溝は窓を横切って黒線に見えたので廃止（周 5）。壁柱の上下に薄い石帯だけ残す
    if (ground && !hasArcade) B.add('trim', translated(box(fw + 0.04, 0.22, 0.12), 0, y0 + H - 0.11, 0.02), M, trimColor);
    y0 += H;
  }
  // CITY2 第 3 周: リザリートの上に切妻のペディメントと台（屋根の中央の飾り）。階の帯もリザリートの面に重ねる
  if (riz) {
    const rw = bay * (rizHalf * 2 + 1) + 0.2, uc = -fw / 2 + endPier + bay * (centerBay + 0.5);
    if (fw > 26) {
      B.add('trim', translated(box(rw + 0.6, 1.0, riz + 0.5), uc, y0 + 0.5, riz / 2 - 0.2), M, trimColor);
      B.add('trim', pedimentGeo(rw + 0.8, 2.2, riz + 0.5, uc, y0 + 1.0).translate(0, 0, riz), M, trimColor);
      B.add('gold', new THREE.SphereGeometry(0.3, 8, 6).translate(uc, y0 + 3.45, riz - 0.2), M);
    } else {
      B.add('trim', translated(box(rw + 0.4, 0.9, riz + 0.4), uc, y0 + 0.45, riz / 2 - 0.15), M, trimColor);   // 小さな棟はアティカ（手すり壁）だけ高くする
    }
    let yb = floors[0];
    for (let f = 1; f < floors.length; f++) { if (f % style.bands === 0 || f === (style.floors.length >= 6 ? 2 : 1)) B.add('trim', translated(box(rw, 0.46, 0.34), uc, yb + 0.23, riz + 0.17), M, trimColor); yb += floors[f]; }
  }
  // CITY2 2026-11-10: 角の隅石（クオイン）。正面の両端に 0.82m おきで長短の石を交互に積む（上階だけ。1 階は石積み）。詳細版だけ
  if (!lite && !hasArcade && !LITE_MODE) {
    const yq0 = floors[0];
    for (const sgn of [-1, 1]) {
      let k = 0;
      for (let yq = yq0 + 0.05; yq + 0.7 < y0 - style.cornice; yq += 0.82, k++) {
        const len = k % 2 ? 0.95 : 0.6;
        B.add('stone', translated(box(len, 0.72, 0.14, 3.0), sgn * (fw / 2 - len / 2), yq + 0.36, 0.05), M, tint);
      }
    }
  }
  // 雨樋（縦樋）
  B.add('iron', translated(box(0.12, y0, 0.12), -fw / 2 + 0.5, y0 / 2, 0.1), M);
}

function pedimentGeo(w, h, depth, u, y) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, h); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.applyMatrix4(_m.makeTranslation(u, y, -depth + 0.04));
  return g;
}

// 寄棟屋根: 軒の矩形 (dx × dz) から高さ h、棟は長辺方向に (長さ - 2*inset)
function hipRoof(dx, dz, h, inset, y) {
  const hx = dx / 2, hz = dz / 2;
  const alongZ = dz >= dx;
  const ridge = alongZ ? [[0, h, -(hz - inset)], [0, h, hz - inset]] : [[-(hx - inset), h, 0], [hx - inset, h, 0]];
  const pts = [];
  const tri = (a, b, c) => pts.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  const e = [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]];
  const [r0, r1] = ridge;
  if (alongZ) {
    quad(e[1], e[0], r0, r0); // 端は三角だが quad で扱う（r0 重複 → 退化三角は無害）
    quad(e[3], e[2], r1, r1);
    quad(e[2], e[1], r0, r1);
    quad(e[0], e[3], r1, r0);
  } else {
    quad(e[1], e[0], r0, r1);
    quad(e[3], e[2], r1, r0);
    quad(e[2], e[1], r1, r1);
    quad(e[0], e[3], r0, r0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const n = pts.length / 3;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { uv[i * 2] = pts[i * 3] / 3; uv[i * 2 + 1] = pts[i * 3 + 2] / 3; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  geo.applyMatrix4(_m.makeTranslation(0, y, 0));
  return geo;
}

// ============================================================================
// 地面
// ============================================================================
function obbMatrix(o, y = 0) { return new THREE.Matrix4().makeRotationY(-(o.yaw || 0)).setPosition(o.x, y, o.z); }

function buildGround(world, materials, assets) {
  const group = new THREE.Group();
  // 2026-10-03 主ループ: 路面のチラつき（PLAYTEST 第3回「交差点で石畳の帯が広場の板石の上に四角く乗って見える」）を
  // 撮影diffで測ったら、重なる面の高さ差が数mm（広場は道路の+2mm、横断歩道は+12mm）しかなく、near=0.3・far=900 の
  // 深度バッファ精度では解像できず Z-fighting していた（詳しい数値は CONTROLS_REPORT.md）。
  // 直し方: 層ごとに固定の高さ（2cm 以上の差）+ 描く順を固定 + 上の層には polygonOffset（カメラ側に少し引く）を足す。
  // polygonOffset は buildGround 専用のクローン材質に対してだけ設定する（同じ材質を使う他箇所には影響させない）。
  const GROUND_Y = { base: -0.03, road: 0, plaza: 0.03, sidewalk: 0.0, curb: 0.0, crosswalk: 0.05 };
  function withPolygonOffset(mat, factor, units) {
    const m = mat.clone(); m.polygonOffset = true; m.polygonOffsetFactor = factor; m.polygonOffsetUnits = units;
    // 2026-10-14: clone は onBeforeCompile を写さない。路面の法線フェード（groundMaterial）を引き継ぐ
    if (mat.userData.fkGround) { m.onBeforeCompile = mat.onBeforeCompile; m.customProgramCacheKey = mat.customProgramCacheKey; m.userData.fkGround = true; }
    return m;
  }
  const matBase = withPolygonOffset(materials.courtyard, 2, 2);       // 一番奥。カメラから遠ざける
  const matPlaza = withPolygonOffset(materials.plaza, -1, -1);        // 道路の上に乗る。カメラ側へ
  const matCurb = withPolygonOffset(materials.curb, -1, -1);
  // CITY2 2026-11-10: 歩道は車道より明るい板石（色 0x8f8d8a → 0xa39f99）で、車道と歩道を色でも分ける（LOOK_REPORT 未着手 2）。縁石は少し暗い花崗岩
  const matSidewalkGranite = withPolygonOffset(materials.granite, -1, -1); matSidewalkGranite.color.set(0xa39f99);
  matCurb.color.set(0x9a9995);
  // 側溝: 縁石の車道側に幅 0.35m の暗い帯（雨水の溝。石畳の路面に「縁」が出る）
  const matGutter = withPolygonOffset(materials.granite, -1, -1); matGutter.color.set(0x5e5c58); matGutter.roughness = 0.9;

  // 地図全体の下地（街区の中庭・道路以外）。暗めの花崗岩で、道路より 3cm 下（描く順: 一番先）
  if (world.bounds) {
    const bb = world.bounds; const w = bb.x1 - bb.x0, d = bb.z1 - bb.z0;
    const g = new THREE.PlaneGeometry(w + 200, d + 200);
    const uv = g.attributes.uv; const ts = assets.tex.granite.metersPerTile;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (w + 200) / ts, uv.getY(k) * (d + 200) / ts);
    g.rotateX(-Math.PI / 2); g.applyMatrix4(_m.makeTranslation((bb.x0 + bb.x1) / 2, GROUND_Y.base, (bb.z0 + bb.z1) / 2));
    const base = new THREE.Mesh(g, matBase); base.receiveShadow = true; base.renderOrder = 0; group.add(base);
  }
  // 道路: ポリライン 1 本を 1 枚の帯（リボン）で。描く順: 2番目
  // 2026-10-14 見た目（主ループの撮影「交差点で道路の石畳の帯が四角いパッチとして乗って見える」）: 以前は区間ごとの矩形で、
  // (a) 同じ道の曲がり角で隣の矩形と重なり（同じ材質・同じ高さで Z-fight → 石目が 2 方向にちらつく）、
  // (b) 交差点では各道の矩形が幅の 1/4 ずつ相手の帯に食い込み、高さが同じ（y=0）なので勝ち負けが画素ごとに変わっていた。
  // 直し方: (a) 曲がり角はマイター（1 本の帯なので重ならない）。(b) 道ごとに polygonOffset の順位を付け、
  // 幅の広い道（順位 0 = 一番手前）が狭い道に勝つ。狭い道の帯の端は広い道の帯の下に隠れ、交差点の面は広い道 1 枚になる。
  // 順位は正の値（奥へ押す）なので、広場（-1）・歩道（-1）・横断歩道（-2）は今までどおり道路に勝つ。
  const roads = (world.roads || []).filter((r) => r.pts.length >= 2);
  const rank = roads.map((r, i) => i).sort((a, b) => (roads[b].width - roads[a].width) || (a - b));
  const roadMats = new Map();
  rank.forEach((ri, order) => {
    const road = roads[ri];
    const base = road.surface === 'asphalt' ? materials.asphalt : road.surface === 'granite' ? materials.granite : materials.cobble;
    const key = road.surface + ':' + order;
    if (!roadMats.has(key)) roadMats.set(key, order === 0 ? base : withPolygonOffset(base, 0, order));   // factor は 0（傾き×factor は遠くで 3cm の段差を超えて下地が勝ってしまう）。units だけで順位を付ける
    road._mat = roadMats.get(key);
  });
  for (const road of roads) {
    const mat = road._mat; delete road._mat;
    const texScale = road.surface === 'granite' ? assets.tex.granite.metersPerTile : 2.2;
    const hw = road.width / 2, pts = road.pts.slice();
    const closed = pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 0.5;
    if (closed) pts.pop();
    const n = pts.length, ext = road.kind === 'plaza' ? 0 : road.width * 0.25;   // 端は幅の 1/4 だけ伸ばす（袋小路・同じ幅の道の継ぎ目を覆う）
    const dirs = [];   // 各区間の単位方向
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n]; const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      dirs.push({ x: (b.x - a.x) / L, z: (b.z - a.z) / L, L });
    }
    const pos = [], uvs = [], idx = [];
    let along = 0;
    const vcount = closed ? n + 1 : n;
    for (let i = 0; i < vcount; i++) {
      const p = pts[i % n];
      const dIn = closed ? dirs[(i - 1 + n) % n] : dirs[Math.max(0, i - 1)];
      const dOut = closed ? dirs[i % n] : dirs[Math.min(dirs.length - 1, i)];
      // マイター: 入る向きと出る向きの二等分線に、幅 / cos(θ/2) で置く（鋭角は 2.5 倍まで）
      let mx = (-dIn.z) + (-dOut.z), mz = dIn.x + dOut.x; const ml = Math.hypot(mx, mz);
      let sx, sz, scale = 1;
      if (ml < 1e-6) { sx = -dOut.z; sz = dOut.x; } else { sx = mx / ml; sz = mz / ml; scale = Math.min(2.5, 1 / Math.max(1e-3, sx * -dOut.z + sz * dOut.x)); }
      let cx = p.x, cz = p.z;
      if (!closed && i === 0) { cx -= dOut.x * ext; cz -= dOut.z * ext; }
      if (!closed && i === n - 1) { cx += dIn.x * ext; cz += dIn.z * ext; }
      if (i > 0) along += (closed ? dirs[(i - 1) % n].L : dirs[i - 1].L) + (!closed && i === 1 ? ext : 0) + (!closed && i === n - 1 ? ext : 0);
      const ox = sx * hw * scale, oz = sz * hw * scale;
      pos.push(cx - ox, GROUND_Y.road, cz - oz, cx + ox, GROUND_Y.road, cz + oz);
      uvs.push(along / texScale, 0, along / texScale, road.width / texScale);
      if (i > 0) { const b = (i - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat); mesh.receiveShadow = true; mesh.renderOrder = 1; group.add(mesh);
  }
  // 広場: 道路より 3cm 上（以前は 2mm しか無く、交差点で道路の石畳と Z-fight していた）。描く順: 3番目
  for (const p of world.plazas || []) {
    const g = new THREE.PlaneGeometry(p.d, p.w);
    const uv = g.attributes.uv; const ts = assets.tex.granite.metersPerTile;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * p.d / ts, uv.getY(k) * p.w / ts);
    g.rotateX(-Math.PI / 2); g.applyMatrix4(obbMatrix(p, GROUND_Y.plaza));
    const mesh = new THREE.Mesh(g, matPlaza); mesh.receiveShadow = true; mesh.renderOrder = 2; group.add(mesh);
  }
  // 歩道（0.15m 高い箱）+ 縁石。道路とは高さで十分離れている（0→0.15m）が、境界の seam 対策に polygonOffset も足す。描く順: 4番目
  const sw = new Bucket(), cb = new Bucket();
  for (const s of world.sidewalks || []) {
    const g = box(s.d, 0.15, s.w);
    boxUVMeters(g, s.d, 0.15, s.w, assets.tex.granite.metersPerTile);
    sw.add('granite', g, obbMatrix(s, 0.075 + GROUND_Y.sidewalk));
    const curb = s.curb || 'both';
    const sides = curb === 'both' ? [-1, 1] : curb === 'left' ? [1] : curb === 'right' ? [-1] : [];
    for (const side of sides) {
      const cg = translated(box(s.d, 0.16, 0.3), 0, 0, side * (s.w / 2 - 0.15 + 0.0));
      cb.add('curb', cg, obbMatrix(s, 0.08 + GROUND_Y.curb));
      const gg = new THREE.PlaneGeometry(s.d, 0.35); gg.rotateX(-Math.PI / 2); gg.translate(0, 0, side * (s.w / 2 + 0.175));
      const guv = gg.attributes.uv; for (let k = 0; k < guv.count; k++) guv.setXY(k, guv.getX(k) * s.d / 2, guv.getY(k) * 0.35 / 2);
      cb.add('gutter', gg, obbMatrix(s, GROUND_Y.road + 0.012));
    }
  }
  const swGroup = sw.build({ granite: matSidewalkGranite }, { castShadow: false });
  const cbGroup = cb.build({ curb: matCurb, gutter: matGutter }, { castShadow: false });
  swGroup.traverse((o) => { if (o.isMesh) o.renderOrder = 3; });
  cbGroup.traverse((o) => { if (o.isMesh) o.renderOrder = 3; });
  group.add(swGroup);
  group.add(cbGroup);
  // 横断歩道: 道路より 5cm 上（以前は 1.2cm）。zebra 材質は元から polygonOffset 済み。描く順: 一番上
  const zb = new Bucket();
  for (const c of world.crosswalks || []) {
    const n = Math.floor(c.w / 1.0);
    for (let i = 0; i < n; i++) {
      const z = -c.w / 2 + 0.25 + i * 1.0;
      const g = new THREE.PlaneGeometry(c.d, 0.5); g.rotateX(-Math.PI / 2); g.applyMatrix4(_m.makeTranslation(0, 0, z));
      zb.add('zebra', g, obbMatrix(c, GROUND_Y.crosswalk));
    }
  }
  // FIX3 2026-10-14: 横断歩道の縞（幅 0.5m・間隔 1m）も遠くで 1 画素未満になって縞がちらつく → 70m→110m で透明に薄れる写し（zebra は元から polygonOffset 済み）
  const zbGroup = zb.build(globalThis.__FIX3_OLD ? materials : { ...materials, zebra: distanceFadeMaterial(materials.zebra, 70, 110) }, { castShadow: false });
  zbGroup.traverse((o) => { if (o.isMesh) o.renderOrder = 4; });
  group.add(zbGroup);
  return group;
}

// ============================================================================
// 街灯・街路樹・ボラード・小物
// ============================================================================
function buildStreetFurniture(world, materials, assets) {
  const group = new THREE.Group();
  // CITY2 2026-11-10: 街灯は glb（1 本 ≒ 2,000 三角形。128 本で 25.6 万 = スマホの街の三角形の 1/4。tests/_city2_calls.html）をやめ、
  // 手続きの鋳鉄灯（台座・柱・襟・ガラスの灯室・笠・頂飾り ≒ 150 三角形）を 2 つのインスタンスメッシュ（鉄・ガラス）で描く
  if (world.lamps?.length) {
    const iron = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.2, 0.55, 6, 1, true).translate(0, 0.275, 0),
      new THREE.CylinderGeometry(0.05, 0.075, 3.0, 5, 1, true).translate(0, 0.55 + 1.5, 0),
      new THREE.CylinderGeometry(0.09, 0.06, 0.16, 5, 1, true).translate(0, 3.55, 0),
      new THREE.BoxGeometry(0.5, 0.05, 0.5).translate(0, 3.62, 0),
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => new THREE.BoxGeometry(0.03, 0.62, 0.03).translate(x * 0.22, 3.95, z * 0.22)),
      new THREE.ConeGeometry(0.42, 0.36, 4).translate(0, 4.44, 0),
      new THREE.ConeGeometry(0.06, 0.14, 4).translate(0, 4.68, 0),
    ], false);
    const glassG = new THREE.BoxGeometry(0.46, 0.62, 0.46).translate(0, 3.95, 0);
    const mk = (geo, mat, cast) => { const inst = new THREE.InstancedMesh(geo, mat, world.lamps.length); world.lamps.forEach((l, i) => inst.setMatrixAt(i, obbMatrix(l))); inst.castShadow = cast; inst.receiveShadow = false; return inst; };
    group.add(mk(iron, materials.iron, !LITE_MODE), mk(glassG, materials.lampGlass, false));   // 第 4 周: スマホは街灯の影を切る
  }
  const kinds = { table: [], tableB: [], plant: [], plantB: [] }; // bench は手続き（buildStreetFurnitureTail。glb は 376 三角形 × 140 台で重かった）
  for (const f of world.furniture || []) if (kinds[f.kind]) kinds[f.kind].push(f);
  for (const k in kinds) if (kinds[k].length) group.add(instanceModel(assets.models[k], kinds[k]).group);
  // 椅子（曲木風: 座面 + 背 + 脚）は手続き
  const chairs = (world.furniture || []).filter((f) => f.kind === 'chair');
  if (chairs.length) {
    const B = new Bucket();
    for (const c of chairs) {
      const M = obbMatrix(c);
      B.add('wood', translated(box(0.42, 0.04, 0.42), 0, 0.45, 0), M.clone());
      B.add('wood', translated(box(0.04, 0.42, 0.4), -0.19, 0.68, 0), M.clone());
      B.add('wood', translated(box(0.04, 0.04, 0.4), -0.19, 0.86, 0), M.clone());
      for (const [x, z] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) B.add('wood', translated(box(0.035, 0.45, 0.035), x, 0.225, z), M.clone());
    }
    group.add(B.build(materials));
  }
  // 街路樹（60m のチャンクに結合して 2 段 LOD: 120m 以内は葉の塊 8 個、遠くは 4 個の粗い球）
  if (world.trees?.length) {
    const cells = new Map();
    for (const t of world.trees) { const k = `${Math.floor(t.x / 60)},${Math.floor(t.z / 60)}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(t); }
    // 主ループ 2026-10-03: 近く用（葉8個）は近づいた区画だけ作り、離れたら捨てる。以前は全区画の2段を起動時に作り約65MB
    const treeCells = [];
    for (const [k, trees] of cells) {
      const cx = (Math.floor(trees[0].x / 60) + 0.5) * 60, cz = (Math.floor(trees[0].z / 60) + 0.5) * 60;
      const local = trees.map((t) => ({ ...t, x: t.x - cx, z: t.z - cz }));
      const lodObj = new THREE.LOD(); lodObj.position.set(cx, 0, cz);
      const far = buildTrees(local, 'far').build(materials, { castShadow: false });
      lodObj.addLevel(far, 0);
      treeCells.push({ cx, cz, local, lodObj, far, near: null });
      group.add(lodObj);
    }
    const TREE_NEAR = LITE_MODE ? 40 : 100, TREE_DROP = 40;   // CITY2 第 4 周: スマホは近景の木（葉 8 塊・細分 2）を 55m まで // FEEL2 2026-10-14: 120→100（近景の木の区画を減らして heap を 260MB 以下に収める）
    group.userData.streamTrees = (px, pz, maxBuild = 1) => {
      let built = 0;
      for (const c of treeCells) {
        const d = Math.hypot(c.cx - px, c.cz - pz);
        if (c.near && d > TREE_NEAR + TREE_DROP) {
          c.near.traverse((x) => x.geometry?.dispose());
          c.lodObj.remove(c.near); c.lodObj.remove(c.far); c.lodObj.levels.length = 0; c.lodObj.addLevel(c.far, 0); c.near = null;
        } else if (!c.near && d < TREE_NEAR && built < maxBuild) {
          c.near = buildTrees(c.local, 'near').build(materials, { castShadow: true });
          c.lodObj.remove(c.far); c.lodObj.levels.length = 0; c.lodObj.addLevel(c.near, 0); c.lodObj.addLevel(c.far, TREE_NEAR); built++;
        }
      }
    };
  }
  buildStreetFurnitureTail(world, materials, group);
  return group;
}

function buildTrees(trees, lod) {
  {
    const B = new Bucket();
    const r = mulberry(5);
    for (const t of trees) {
      const R = t.r || 2.6;
      const h = 3.2 + R * 0.4;
      B.add('trunk', translated(new THREE.CylinderGeometry(0.14, 0.24, h, 8), t.x, h / 2, t.z));
      for (let k = 0; k < 3; k++) { const a = k * 2.1 + r(); const br = new THREE.CylinderGeometry(0.05, 0.1, R * 0.9, 6); br.rotateZ(0.6); br.rotateY(a); B.add('trunk', translated(br, t.x + Math.cos(a) * 0.2, h + R * 0.25, t.z + Math.sin(a) * 0.2)); }
      // FEEL2 2026-10-14: 小さい木（2 列目 R<3.2）は近景でも葉 6 塊・細分 1 にして heap を下げる（近景 LOD が増分の大半だった）
      const small = R < 3.2;
      const n = lod === 'far' ? 4 : (small ? 6 : 8);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 1.5;
        const rr = i === 0 ? 0 : R * (0.45 + r() * 0.35);
        const s = i === 0 ? R * 0.75 : R * (0.38 + r() * 0.25);
        let g = mergeVertices(new THREE.IcosahedronGeometry(s, lod === 'far' || small ? 1 : 2));
        const pos = g.attributes.position;
        for (let k = 0; k < pos.count; k++) { const jit = 1 + (r() - 0.5) * 0.12; pos.setXYZ(k, pos.getX(k) * jit, pos.getY(k) * jit * 0.85, pos.getZ(k) * jit); }
        g.computeVertexNormals();
        B.add('leaf', translated(g, t.x + Math.cos(a) * rr, h + R * 0.5 + (i ? (r() - 0.5) * R * 0.8 : 0.1), t.z + Math.sin(a) * rr), null, new THREE.Color(PALETTE.leaf).offsetHSL((r() - 0.5) * 0.06, (r() - 0.5) * 0.2, (r() - 0.5) * 0.22));
      }
    }
    return B;
  }
}

// FIX3 2026-10-14: 材質の写しを作り、カメラからの距離 near→far で透明に薄れさせる（細い線が遠くで 1 画素未満になって点滅する前に消す）。
// onBeforeCompile で視点座標の奥行きを varying に渡し、color_fragment の後で alpha に掛ける。opts は写しに上書きする属性（polygonOffset など）
// softEdge: 平面の uv の端（0〜0.4・0.6〜1）で alpha を 0→1 に滑らかにする（白線を幅広の面にして端をぼかす。遠くで 1 画素未満になっても点滅せず薄れる）
function distanceFadeMaterial(mat, near, far, opts = {}, softEdge = false) {
  const m = mat.clone(); Object.assign(m, opts); m.transparent = true;
  m.onBeforeCompile = (sh) => {
    // 主ループ 2026-10-14: uv を読むのは端をぼかす時だけ。架線（LineSegments）は uv 属性を持たず、
    // 架線の区画が描画の準備に入った時だけ "Shader Error ... VALIDATE_STATUS false" で失敗していた（経路しだいで出たり出なかったり）
    sh.vertexShader = sh.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n vFix3Dist = -mvPosition.z;' + (softEdge ? ' vFix3Uv = uv;' : ' vFix3Uv = vec2(0.5);')).replace('void main() {', 'varying float vFix3Dist; varying vec2 vFix3Uv;\nvoid main() {');
    const edge = softEdge ? ' diffuseColor.a *= smoothstep(0.0, 0.4, vFix3Uv.x) * smoothstep(1.0, 0.6, vFix3Uv.x) * smoothstep(0.0, 0.4, vFix3Uv.y) * smoothstep(1.0, 0.6, vFix3Uv.y);' : '';
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n diffuseColor.a *= smoothstep(${far.toFixed(1)}, ${near.toFixed(1)}, vFix3Dist);${edge}`).replace('void main() {', 'varying float vFix3Dist; varying vec2 vFix3Uv;\nvoid main() {');
  };
  m.customProgramCacheKey = () => 'fix3fade' + near + '_' + far + (softEdge ? 's' : '');
  return m;
}

function buildStreetFurnitureTail(world, materials, group) {
  // ボラード（ステンレス）
  if (world.bollards?.length) {
    const g = new THREE.CapsuleGeometry(0.06, 0.85, 2, 6);   // CITY2: 4,10 → 2,6（三角形を 1/2 に。遠目には同じ）
    const inst = new THREE.InstancedMesh(g, materials.steel, world.bollards.length);
    const m = new THREE.Matrix4();
    world.bollards.forEach((b, i) => { m.makeTranslation(b.x, 0.5, b.z); inst.setMatrixAt(i, m); });
    inst.castShadow = !LITE_MODE;
    group.add(inst);
  }
  // 賑わい 2026-10-03: 静的な通りの小物（起動時に 1 回作る。インスタンス or 1 メッシュに結合なのでメモリは小さい）
  // ベンチ（木の板 2 枚 + 鋳鉄の脚。1 台 60 三角形、頂点色でインスタンス）
  const benches = (world.furniture || []).filter((f) => f.kind === 'bench');
  if (benches.length) {
    const wood = 0x6b4a2a, iron = 0x24262a;
    const parts = [
      colorize(box(0.5, 0.05, 1.8), wood).translate(0.05, 0.45, 0),
      colorize(box(0.05, 0.42, 1.8), wood).translate(-0.22, 0.72, 0),
      ...[-0.8, 0.8].map((z) => colorize(box(0.48, 0.05, 0.06), iron).translate(0.03, 0.42, z)),
      ...[-0.8, 0.8].flatMap((z) => [colorize(box(0.06, 0.42, 0.06), iron).translate(0.22, 0.21, z), colorize(box(0.06, 0.9, 0.06), iron).translate(-0.2, 0.45, z)]),
    ];
    const geo = mergeGeometries(parts, false);
    const inst = new THREE.InstancedMesh(geo, materials.matte, benches.length);
    benches.forEach((b, i) => inst.setMatrixAt(i, obbMatrix(b)));
    inst.castShadow = !LITE_MODE; group.add(inst);
  }
  // 自転車ラック（逆 U 字 × 3。粗い円環で 1 台 ≒ 250 三角形）
  if (world.racks?.length) {
    const parts = [];
    for (let k = 0; k < 3; k++) {
      const t = new THREE.TorusGeometry(0.36, 0.025, 3, 6, Math.PI); t.translate(k * 0.9 - 0.9, 0.44, 0); parts.push(t);   // CITY2 第 3 周: 4,8 → 3,6（軽量版の飾りの増分を相殺）
      for (const s of [-1, 1]) { const leg = new THREE.CylinderGeometry(0.025, 0.025, 0.44, 4); leg.translate(k * 0.9 - 0.9 + s * 0.36, 0.22, 0); parts.push(leg); }
    }
    const geo = mergeGeometries(parts, false);
    const inst = new THREE.InstancedMesh(geo, materials.steel, world.racks.length);
    world.racks.forEach((r, i) => inst.setMatrixAt(i, obbMatrix(r)));
    inst.castShadow = !LITE_MODE; group.add(inst);
  }
  // 標識（柱 + 板。種類: 歩行者ゾーン=青四角、進入禁止=赤丸に白、駐車=青四角に白 P）
  if (world.signs?.length) {
    const B = new Bucket();
    for (const s of world.signs) {
      const Mx = obbMatrix(s);
      B.add('steel', translated(new THREE.CylinderGeometry(0.03, 0.035, 2.5, 5, 1, true), 0, 1.25, 0), Mx.clone());
      if (s.kind === 'noentry') {
        B.add('matte', translated(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 8).rotateZ(Math.PI / 2), 0.0, 2.3, 0), Mx.clone(), new THREE.Color(0xc8102e));
        B.add('matte', translated(box(0.025, 0.1, 0.42), 0.0, 2.3, 0), Mx.clone(), new THREE.Color(0xf4f1ea));
      } else {
        B.add('matte', translated(box(0.02, 0.6, 0.6), 0, 2.25, 0), Mx.clone(), new THREE.Color(0x1f5bb5));
        if (s.kind === 'parking') { B.add('matte', translated(box(0.025, 0.36, 0.06), 0, 2.25, -0.08), Mx.clone(), new THREE.Color(0xf4f1ea)); B.add('matte', translated(new THREE.TorusGeometry(0.1, 0.03, 4, 10).rotateY(Math.PI / 2), 0, 2.33, 0.03), Mx.clone(), new THREE.Color(0xf4f1ea)); }
        else { B.add('matte', translated(new THREE.CapsuleGeometry(0.05, 0.22, 3, 6), 0, 2.22, -0.08), Mx.clone(), new THREE.Color(0xf4f1ea)); B.add('matte', translated(new THREE.CapsuleGeometry(0.04, 0.16, 3, 6), 0, 2.18, 0.08), Mx.clone(), new THREE.Color(0xf4f1ea)); }
      }
    }
    group.add(B.build(materials, { castShadow: !LITE_MODE }));
  }
  // 広場の屋台（Würstelstand）: 箱 + カウンター + 赤白の日よけ + 看板 + 煙突。当たり判定は sim の円（r 1.7）
  if (world.kiosks?.length) {
    const B = new Bucket();
    for (const k of world.kiosks) {
      const Mx = obbMatrix(k);
      const body = new THREE.Color(0xe9e2d2), roof = new THREE.Color(0x4a4f4c), red = new THREE.Color(0xc8102e), white = new THREE.Color(0xf2efe6);
      B.add('matte', translated(box(2.6, 2.4, 2.0), 0, 1.2, 0), Mx.clone(), body);
      B.add('matte', translated(box(2.64, 0.7, 2.04), 0, 0.35, 0), Mx.clone(), new THREE.Color(0x2f4f3a));   // 腰の緑の帯
      B.add('matte', translated(box(2.9, 0.12, 2.3), 0, 2.46, 0), Mx.clone(), roof);
      // 両側（±x）に カウンター・開口・看板・赤白の日よけ（広場のどちらから見ても屋台と分かるように）
      for (const sx of [1, -1]) {
        B.add('wood', translated(box(0.5, 0.08, 2.2), sx * 1.45, 1.05, 0), Mx.clone());
        B.add('dark', translated(box(0.04, 1.0, 2.2), sx * 1.31, 1.6, 0), Mx.clone());
        B.add('sign', translated(box(0.05, 0.4, 2.3), sx * 1.33, 2.25, 0), Mx.clone(), new THREE.Color(0x1f3a2e));
        B.add('signText', atlasUV(plane(2.0, 0.25, 0, 2.25, 0).rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2).translate(sx * 1.37, 0, 0), KIOSK_ROW), Mx.clone());
        for (let s = 0; s < 8; s++) B.add('awning', new THREE.PlaneGeometry(1.0, 0.3).rotateX(-Math.PI / 2).rotateZ(sx * -0.35).translate(sx * 1.75, 2.42, -1.2 + 0.3 * (s + 0.5)), Mx.clone(), s % 2 ? white : red);
      }
      // ソーセージの絵代わりの赤い丸看板（屋根の上）と煙突
      B.add('matte', translated(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 14).rotateZ(Math.PI / 2), 0, 2.95, 0.3), Mx.clone(), red);
      B.add('steel', translated(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), -0.8, 2.9, -0.5), Mx.clone());
      // 客用の立ち飲みテーブル 2 つ
      for (const [x, z] of [[2.9, 1.1], [2.9, -1.1]]) { B.add('steel', translated(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6), x, 0.55, z), Mx.clone()); B.add('matte', translated(new THREE.CylinderGeometry(0.35, 0.35, 0.04, 12), x, 1.1, z), Mx.clone(), new THREE.Color(0xd8d2c4)); }
    }
    group.add(B.build(materials, { castShadow: !LITE_MODE }));
  }
  // 挙動担当 2026-10-14: リング通りの線路・白線・架線柱（worldFromSim の out.ring）。路面の物は影を落とさない 1 メッシュ、柱は別メッシュ
  if (world.ring) {
    const R = world.ring, flat = new Bucket(), tall = new Bucket();
    // FIX3 2026-10-14（天才さん「電線とか床の線がチカチカしてる」）: 架線（太さ 2.5cm）・白線（幅 14〜16cm）は低画質（0.75 倍、
    // 633x292）では 10m 先で 0.45 画素、30m 先で 0.8 画素しかなく、1 画素未満の帯が画素の格子に掛かったり外れたりして点滅していた
    // （計測: tests/_fix3_lines.html）。直し方: (a) 架線・スパン線は細い箱をやめて 1 画素の線（LineSegments。何 m 先でも 1 画素で、消えない）、
    // 色を空とのコントラストが弱いものにし、45m から 75m で透明に消す。(b) 路面の白線・停止線・線路は距離で薄れる材質（50m→90m で透明）
    // + polygonOffset（道路との 2cm の段差が遠くで深度に負けないように）+ 白を少し落とす
    const OLD = !!globalThis.__FIX3_OLD;
    const white = new THREE.Color(OLD ? 0xe6e2d6 : 0xd6d2c6), rail = new THREE.Color(0x6a6c6e), wire = new THREE.Color(OLD ? 0x2a2a28 : 0x4a4c4a);
    // 白線は面を 2 倍強に広げ、端 40% を透明→不透明のぼかしにする（見える幅はほぼ同じ 18cm、端が 1 画素以上の勾配になる）
    const wmul = OLD ? 1 : 2.2;
    for (const r of R.rails) flat.add('rail', box(r.len, 0.03, 0.08), obbMatrix(r, 0.015), rail);
    for (const s of R.solids) flat.add('matte', new THREE.PlaneGeometry(s.len, 0.14 * wmul).rotateX(-Math.PI / 2), obbMatrix(s, 0.02), white);
    for (const d of R.dashes) flat.add('matte', new THREE.PlaneGeometry(3.0 + (wmul - 1) * 0.3, 0.16 * wmul).rotateX(-Math.PI / 2), obbMatrix(d, 0.02), white);
    for (const s of R.stops || []) flat.add('matte', new THREE.PlaneGeometry(0.45 * (OLD ? 1 : 1.6), s.len).rotateX(-Math.PI / 2), obbMatrix(s, 0.025), white); // FEEL2: 停止線（進行方向に直交）
    if (R.rails.length || R.dashes.length || (R.stops || []).length) {
      const po = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 };
      const mats = OLD ? { matte: materials.matte, rail: materials.matte } : { matte: distanceFadeMaterial(materials.matte, 50, 90, po, true), rail: distanceFadeMaterial(materials.matte, 50, 90, po) };
      const m = flat.build(mats, { castShadow: false, receiveShadow: true }); m.name = 'ringMarkings'; group.add(m);
    }
    for (const p of R.poles) {
      tall.add('steel', translated(new THREE.CylinderGeometry(0.09, 0.14, 7.0, 6, 1, true), 0, 3.5, 0), obbMatrix(p));
    }
    if (OLD) {
      for (const s of R.spans) {
        tall.add('matte', translated(box(0.03, 0.03, s.len), 0, 6.3, 0), obbMatrix(s), wire);     // 横断スパン線（両側の柱の間）
        tall.add('matte', translated(box(32, 0.025, 0.025), 0, 5.7, 0), obbMatrix(s), wire);      // 架線（線路の上、次の柱まで）
      }
    } else if (R.spans.length) {
      const pos = []; const v = new THREE.Vector3();
      const seg = (ax, ay, az, bx, by, bz, M) => { v.set(ax, ay, az).applyMatrix4(M); pos.push(v.x, v.y, v.z); v.set(bx, by, bz).applyMatrix4(M); pos.push(v.x, v.y, v.z); };
      for (const s of R.spans) {
        const M = obbMatrix(s);
        seg(0, 6.3, -s.len / 2, 0, 6.3, s.len / 2, M);    // 横断スパン線（両側の柱の間）
        seg(-16, 5.7, 0, 16, 5.7, 0, M);                  // 架線（線路の上、次の柱まで）
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const lm = distanceFadeMaterial(new THREE.LineBasicMaterial({ color: wire }), 45, 75);
      const lines = new THREE.LineSegments(g, lm); lines.name = 'ringWires'; lines.castShadow = false; lines.frustumCulled = true; tall.wires = lines;
    }
    if (R.poles.length) { const m = tall.build(materials, { castShadow: true }); m.name = 'ringCatenary'; if (tall.wires) m.add(tall.wires); group.add(m); }
  }
  // FEEL2 2026-10-14: 家具帯の広告塔（リトファスゾイレ: 緑の円柱 + 色とりどりのポスター + 笠）と花壇（石の鉢 + 緑 + 花）。
  // どちらも 1 メッシュに結合（広告塔 1 本 ≒ 160 三角形、花壇 1 つ ≒ 90）
  if (world.adColumns?.length || world.planters?.length) {
    const B = new Bucket();
    const green = new THREE.Color(0x3f6b4a), dark = new THREE.Color(0x2c3a30), stone = new THREE.Color(0xb9b2a4);
    const posters = [0xc62f36, 0x2e6b9b, 0xd9b24a, 0xe0e0d8, 0x7a3b8a, 0x2f8a6b, 0xe07a2a, 0x3a3a3a].map((c) => new THREE.Color(c));
    for (const a of world.adColumns || []) {
      const Mx = obbMatrix(a), r = mulberry(a.seed + 17);
      B.add('matte', translated(new THREE.CylinderGeometry(0.65, 0.7, 2.9, 12, 1), 0, 1.45, 0), Mx.clone(), green);
      B.add('matte', translated(new THREE.CylinderGeometry(0.74, 0.74, 0.14, 12, 1), 0, 2.97, 0), Mx.clone(), dark);
      B.add('matte', translated(new THREE.ConeGeometry(0.72, 0.5, 12, 1), 0, 3.28, 0), Mx.clone(), dark);
      B.add('matte', translated(new THREE.SphereGeometry(0.1, 6, 5), 0, 3.56, 0), Mx.clone(), dark);
      const n = 5, a0 = r() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const ang = a0 + (i / n) * Math.PI * 2, h = 1.2 + r() * 0.8, y = 0.75 + h / 2 + r() * 0.5;
        const g = new THREE.PlaneGeometry(0.62, h).rotateY(ang + Math.PI / 2).translate(Math.cos(ang) * 0.665, y, Math.sin(ang) * 0.665);
        B.add('matte', g, Mx.clone(), posters[Math.floor(r() * posters.length)]);
      }
    }
    const petals = [0xc8102e, 0xf2a1b8, 0xf4f1ea, 0xf0c030].map((c) => new THREE.Color(c));
    for (const p of world.planters || []) {
      const Mx = obbMatrix(p), r = mulberry(p.seed + 41);
      B.add('matte', translated(new THREE.CylinderGeometry(0.55, 0.45, 0.5, 10, 1), 0, 0.25, 0), Mx.clone(), stone);
      B.add('matte', translated(new THREE.CylinderGeometry(0.48, 0.48, 0.06, 10, 1), 0, 0.5, 0), Mx.clone(), new THREE.Color(0x4a3a28));
      B.add('leaf', translated(new THREE.IcosahedronGeometry(0.42, 1), 0, 0.72, 0), Mx.clone(), new THREE.Color(PALETTE.leaf).offsetHSL(0, 0.1, -0.05));
      for (let i = 0; i < 5; i++) { const ang = r() * Math.PI * 2, rr = 0.1 + r() * 0.25; B.add('matte', translated(new THREE.OctahedronGeometry(0.09, 0), Math.cos(ang) * rr, 0.98 + r() * 0.1, Math.sin(ang) * rr), Mx.clone(), petals[Math.floor(r() * petals.length)]); }
    }
    const m = B.build(materials, { castShadow: !LITE_MODE }); m.name = 'ringFurniture'; group.add(m);
  }
  // 挙動担当 2026-10-14: 駐車中の車（車体 + キャビン + 車輪 4。1 台 約 150 三角形、全部 1 メッシュに結合）
  if (world.parkedCars?.length) {
    const B = new Bucket();
    const paints = [0xd8d4c8, 0x2b2f3a, 0x8c1c1c, 0x1f4b7a, 0x5a5e62, 0xcfc3a1].map((c) => new THREE.Color(c));
    const glass = new THREE.Color(0x1c2228), tire = new THREE.Color(0x151515);
    for (const c of world.parkedCars) {
      const Mx = obbMatrix(c), paint = paints[c.color % paints.length];
      B.add('matte', translated(box(4.2, 0.55, 1.8), 0, 0.55, 0), Mx.clone(), paint);
      B.add('matte', translated(box(2.2, 0.5, 1.6), -0.1, 1.07, 0), Mx.clone(), paint);
      B.add('matte', translated(box(1.9, 0.42, 1.62), -0.1, 1.07, 0), Mx.clone(), glass);
      for (const [x, z] of [[1.35, -0.85], [1.35, 0.85], [-1.35, -0.85], [-1.35, 0.85]]) B.add('matte', translated(new THREE.CylinderGeometry(0.32, 0.32, 0.22, LITE_MODE ? 4 : 6).rotateX(Math.PI / 2), x, 0.32, z), Mx.clone(), tire);
    }
    const m = B.build(materials, { castShadow: !LITE_MODE }); m.name = 'parkedCars'; group.add(m);
  }
  return group;
}

// ============================================================================
// シュテファン大聖堂（簡略形。research/vienna-reference.md §3.1）
// ============================================================================
function buildStephansdom(lm, materials) {
  const B = new Bucket();
  const L = 100, W = 34, H = 27;
  // 身廊
  B.add('stone', translated(box(L, H, W, 6), 0, H / 2, 0), null);
  // 控え壁 + ピナクル + 大窓（南北面）
  const pitch = 7;
  for (let i = 0; i < L / pitch; i++) {
    const x = -L / 2 + pitch * i + 3.5;
    for (const s of [-1, 1]) {
      B.add('stone', translated(box(1.5, H + 2, 3, 6), x - 3.5, (H + 2) / 2, s * (W / 2 + 1.5)), null);
      B.add('stone', translated(new THREE.ConeGeometry(0.8, 4, 4), x - 3.5, H + 4, s * (W / 2 + 1.5)), null);
      // 尖頭アーチ窓（平面で近似: 矩形 + 三角）
      const wy = 5;
      B.add('glass', plane(4, 12, 0, wy + 6, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(s > 0 ? 0 : Math.PI).setPosition(x, 0, s * (W / 2 + 0.02))), null);
      const tri = new THREE.Shape(); tri.moveTo(-2, 0); tri.lineTo(2, 0); tri.lineTo(0, 3.5); tri.closePath();
      const tg = new THREE.ShapeGeometry(tri); tg.applyMatrix4(new THREE.Matrix4().makeRotationY(s > 0 ? 0 : Math.PI).setPosition(x, wy + 12, s * (W / 2 + 0.02)));
      B.add('glass', tg, null);
      // 窓の縦の石の桟
      B.add('stone', translated(box(0.25, 13, 0.4, 6), x, wy + 6.5, s * (W / 2 + 0.1)), null);
    }
  }
  // 大屋根（切妻、急勾配 66°）— 面ごとに UV を長さ方向に
  const rh = 38, hw = W / 2;
  const slopeLen = Math.hypot(hw, rh);
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(L, slopeLen);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * L / 7, uv.getY(k));
    const ang = Math.atan2(rh, hw);
    g.rotateX(-ang); // 棟に向かって立ち上がる
    if (s < 0) g.rotateY(Math.PI);
    g.applyMatrix4(_m.makeTranslation(0, H + rh / 2, s * hw / 2));
    B.add('chevron', g, null);
  }
  // 妻壁
  for (const s of [-1, 1]) {
    const tri = new THREE.Shape(); tri.moveTo(-hw, 0); tri.lineTo(hw, 0); tri.lineTo(0, rh); tri.closePath();
    const g = new THREE.ShapeGeometry(tri); g.applyMatrix4(new THREE.Matrix4().makeRotationY(s > 0 ? Math.PI / 2 : -Math.PI / 2).setPosition(s * L / 2, H, 0));
    B.add('stone', g, null);
  }
  // 棟飾り
  B.add('verdigris', translated(box(L, 0.6, 0.8), 0, H + rh + 0.3, 0), null);
  // 南塔（+z 側、x = +15）: 角柱 → 細い角柱 → 八角錐
  const tx = 15, tz = W / 2 + 6;
  B.add('stone', translated(box(20, 48, 20, 6), tx, 24, tz), null);
  B.add('stone', translated(box(15, 22, 15, 6), tx, 48 + 11, tz), null);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    B.add('stone', translated(box(3, 10, 3, 6), tx + dx * 8.5, 48 + 5, tz + dz * 8.5), null);
    B.add('stone', translated(new THREE.ConeGeometry(1.8, 7, 4), tx + dx * 8.5, 48 + 13.5, tz + dz * 8.5), null);
  }
  B.add('stone', translated(new THREE.ConeGeometry(7.5, 66, 8), tx, 70 + 33, tz), null);
  B.add('gold', translated(new THREE.SphereGeometry(1.2, 12, 8), tx, 136.5, tz), null);
  // 塔の細い窓（暗い縦長）
  for (let lvl = 0; lvl < 4; lvl++) {
    for (const [dx, dz, ry] of [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]]) {
      const g = new THREE.PlaneGeometry(2.4, 8);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(tx + dx * 10.02, 10 + lvl * 11, tz + dz * 10.02));
      B.add('glass', g, null);
      const g2 = new THREE.PlaneGeometry(1.6, 6);
      if (lvl < 2) { g2.applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(tx + dx * 7.52, 52 + lvl * 9, tz + dz * 7.52)); B.add('glass', g2, null); }
    }
  }
  // 北塔（-z 側）: 角柱 + 緑青ドーム
  const nz = -(W / 2 + 5);
  B.add('stone', translated(box(18, 56, 18, 6), tx, 28, nz), null);
  B.add('verdigris', translated(new THREE.SphereGeometry(9, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), tx, 56, nz), null);
  B.add('gold', translated(new THREE.SphereGeometry(0.9, 10, 8), tx, 65.5, nz), null);
  // 異教徒の塔 ×2（西正面）
  for (const s of [-1, 1]) {
    B.add('stone', translated(new THREE.CylinderGeometry(4.5, 4.5, 45, 8), -L / 2 + 2, 22.5, s * 11), null);
    B.add('stone', translated(new THREE.ConeGeometry(4.5, 20, 8), -L / 2 + 2, 55, s * 11), null);
  }
  // 附属屋（南塔の東、緑青の屋根）
  B.add('trim', translated(box(25, 8, 12), tx + 22, 4, tz + 2), null, new THREE.Color(0xd6d3cc));
  B.add('verdigris', hipRoof(25.6, 12.6, 3, 3, 8).applyMatrix4(_m.makeTranslation(tx + 22, 0, tz + 2)), null);
  const g = B.build(materials);
  g.position.set(lm.x, 0, lm.z); g.rotation.y = -(lm.yaw || 0);
  return g;
}

// ============================================================================
// その他のランドマーク（簡略形: 砂岩の大きな箱をファサード C で囲い、高さを合わせる。塔・ドームは種類で足す）
// ============================================================================
function buildGenericLandmark(lm, materials, rng) {
  if (lm.shape === 'circle') {
    // 記念柱など: 基壇 + 円錐 + 金の頂
    const B = new Bucket();
    const h = lm.height || 20, r = lm.r || 5;
    B.add('trim', translated(new THREE.CylinderGeometry(r, r, 1.6, 3), 0, 0.8, 0), null, new THREE.Color(0xd9d4c8));
    B.add('trim', translated(new THREE.CylinderGeometry(r * 0.75, r * 0.75, 1.0, 3), 0, 2.1, 0), null, new THREE.Color(0xd9d4c8));
    B.add('trim', translated(new THREE.CylinderGeometry(r * 0.3, r * 0.6, h - 6, 12), 0, 2.6 + (h - 6) / 2, 0), null, new THREE.Color(0xefeae2));
    B.add('gold', translated(new THREE.SphereGeometry(r * 0.3, 12, 8), 0, h - 2.5, 0), null);
    B.add('trim', translated(new THREE.CapsuleGeometry(r * 0.12, 1.6, 4, 8), 0, h - 1, 0), null, new THREE.Color(0xefeae2));
    const g = B.build(materials); g.position.set(lm.x, 0, lm.z); return g;
  }
  const w = lm.hl * 2, d = lm.hw * 2, H = Math.min(lm.height || 24, 30);
  // 階の高さを合わせる（地上階 5.5m + 残りを等分）
  const n = Math.max(2, Math.round((H - 5.5) / 4.2));
  const floors = [5.5, ...Array(n).fill((H - 5.5) / n)];
  // ランドマークの yaw は長軸の向き。描画の建物は「正面 = +x」なので、長軸を d（奥行き）、短辺を w（間口）に入れて 4 面にファサードを出す
  const b = { x: lm.x, z: lm.z, yaw: lm.yaw || 0, w: Math.max(d, 1), d: Math.max(w, 1), style: 'C', faces: ['front', 'back', 'left', 'right'], seed: 77, floors };
  const g = buildBuilding(b, materials, rng);
  // ドーム（ホーフブルク・ペーター教会）
  if (/Hofburg|Peterskirche/.test(lm.id)) {
    const R = Math.min(w, d) * (lm.id === 'Hofburg' ? 0.45 : 0.5);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), materials.verdigris);
    dome.position.set(0, H + 4.5, 0); dome.castShadow = true; g.add(dome);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 5, 24), materials.trim); drum.position.set(0, H + 2.5, 0); colorize(drum.geometry, 0xd6d3cc); g.add(drum);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), materials.gold); ball.position.set(0, H + 4.5 + R + 0.8, 0); g.add(ball);
  }
  return g;
}

// ============================================================================
// 街全体
// ============================================================================
export function buildCity(scene, world, assets, { quality = 'high' } = {}) {
  if (typeof globalThis !== 'undefined') globalThis.__scene = () => scene; // 計測用（tests/_life_stats.html が三角形の内訳を読む）
  const materials = makeMaterials(assets.tex);
  const root = new THREE.Group(); root.name = 'city';
  const rng = mulberry(world.seed ?? 1);
  root.add(buildGround(world, materials, assets));
  const buildings = new THREE.Group(); buildings.name = 'buildings';
  // 主ループ 2026-10-03: 区画ごとの詳細版・軽量版を「近づいたときだけ作り、離れたら捨てる」（ストリーミング）。
  // 以前は全190区画の3段階を起動時に全部作っていた: 詳細 404MB・軽量 174MB・遠景 13MB、作る途中で JS のメモリ 1.9GB
  // → スマホの Claude アプリで開けなかった原因（PLAYTEST 第6回）。起動時は遠景だけ作る
  const CELL = 50, LOD_DIST = 90, LOD_FAR = 240;
  const LITE_Q = quality === 'low' || quality === 'mobile';
  LITE_MODE = LITE_Q;
  const FULL_R = LITE_Q ? 40 : 100;     // この距離に入った区画だけ詳細版を作る（CITY2 第 4 周: スマホ 60 → 42）
  const LITE_R = LITE_Q ? 120 : 260;    // この距離に入った区画だけ軽量版を作る（CITY2: スマホ 170→130。その先は遠景の殻（シェーダの窓）で足りる。三角形を減らす）
  const SHADOW_R = 24;   // 第 4 周: 40 → 24（影の範囲 26m）                  // CITY2: スマホは、この距離より近い区画だけ影を落とす（影の範囲 26m + 区画の半径）
  const DROP = 40;                                 // 離れてからこれだけ余計に離れたら捨てる（行ったり来たりで作り直さない）
  const chunks = new Map();
  const list = world.buildings || [];
  list.forEach((b, i) => {
    const key = `${Math.floor(b.x / CELL)},${Math.floor(b.z / CELL)}`;
    if (!chunks.has(key)) chunks.set(key, { items: [], cx: (Math.floor(b.x / CELL) + 0.5) * CELL, cz: (Math.floor(b.z / CELL) + 0.5) * CELL, full: null, lite: null, far: null });
    const ch = chunks.get(key);
    const seedB = { ...b, seed: b.seed ?? 5000 + i };
    ch.items.push({ seedB, M: new THREE.Matrix4().makeRotationY(-(b.yaw || 0)).setPosition(b.x - ch.cx, 0, b.z - ch.cz) });
  });
  // 段階ごとに同じ見た目になるよう、建物ごとに同じ種から乱数を作る（共有の乱数だと作る順で見た目が変わる）
  const buildLevel = (ch, level) => {
    const bucket = new Bucket();
    for (const it of ch.items) {
      const opt = level === 'full' ? { lite: !!it.seedB.rear } : level === 'lite' ? { lite: true } : { lite: true, boxOnly: true };
      bucket.absorb(buildBuildingBucket(it.seedB, materials, mulberry(it.seedB.seed), opt), it.M);
    }
    // CITY2 2026-11-10: スマホ（mobile）は詳細版（60m 以内）だけ影を落とす。軽量版（170m まで）まで落とすと影パスの描画命令で上限 1,500 を超えていた（実測 1,920）
    const o = bucket.build(materials, { castShadow: level === 'full' ? quality !== 'low' : level === 'lite' && !LITE_Q });
    return o;
  };
  const disposeObj = (o) => o.traverse((x) => x.geometry?.dispose());
  // CITY2 2026-11-10: 遠景（boxOnly）は区画ごとの LOD 段ではなく、街全体で材質ごとに 1 メッシュに結合した「殻」にする（常に描く）。
  // 以前は 188 区画 × 3〜4 材質 = 656 メッシュで、スマホの描画命令の 1/4 近く（tests/_city2_calls.html: 建物 446 call / 全体 583）がこれだった。
  // 殻は各棟の足元中心について 0.97 倍に縮めてあるので、近くで詳細版・軽量版が出ている時はその壁の内側に隠れる（同じ面での Z-fight を避ける）
  const relevel = (ch) => {
    const lod = ch.lod;
    for (const l of lod.levels) lod.remove(l.object);
    lod.levels.length = 0;
    if (ch.full) { lod.addLevel(ch.full, 0); if (ch.lite) lod.addLevel(ch.lite, LOD_DIST); }
    else if (ch.lite) lod.addLevel(ch.lite, 0);
  };
  {
    // 殻は 200m 角の地域ごとに分けて結合する（視野の外の地域は描かない。地域 ≒ 9 個 × 材質 4 = 最大 36 call）
    const REGION = 200, shells = new Map();
    const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 0.97, 1), _up = new THREE.Vector3(0, 1, 0);
    for (const ch of chunks.values()) {
      ch.lod = new THREE.LOD();
      for (const it of ch.items) {
        const b = it.seedB;
        const rk = `${Math.floor(b.x / REGION)},${Math.floor(b.z / REGION)}`;
        if (!shells.has(rk)) shells.set(rk, new Bucket());
        const Mw = new THREE.Matrix4().compose(_p.set(b.x, 0, b.z), _q.setFromAxisAngle(_up, -(b.yaw || 0)), _s);
        // 殻は各面を 0.75m 内側に（0.97 倍だと大きな棟で 0.3m しか引っ込まず、店のガラスの奥（−0.36m の商品・−0.42m の灯り）を殻の壁板が隠して白い板に見えた。13:36 主ループの指摘）
        shells.get(rk).absorb(buildBuildingBucket({ ...b, w: Math.max(1, b.w - 1.5), d: Math.max(1, b.d - 1.5) }, materials, mulberry(b.seed), { lite: true, boxOnly: true }), Mw);
      }
      relevel(ch);
      ch.lod.position.set(ch.cx, 0, ch.cz);
      buildings.add(ch.lod);
    }
    for (const [rk, shell] of shells) { const o = shell.build(materials, { castShadow: false }); o.name = 'farShell:' + rk; buildings.add(o); }
  }
  const chunkList = [...chunks.values()];
  // 1回の呼び出しで作るのは最大 maxBuild 区画（近い順）。捨てるのは何区画でも
  function streamCity(px, pz, maxBuild = 1) {
    const want = [];
    for (const ch of chunkList) {
      const d = Math.hypot(ch.cx - px, ch.cz - pz);
      let changed = false;
      if (ch.full && d > FULL_R + DROP) { disposeObj(ch.full); ch.full = null; changed = true; }
      if (ch.lite && d > LITE_R + DROP) { disposeObj(ch.lite); ch.lite = null; changed = true; }
      if (changed) relevel(ch);
      if (LITE_Q && ch.full) { const cs = d < SHADOW_R; if (ch.full.userData.cs !== cs) { ch.full.userData.cs = cs; ch.full.traverse((o) => { if (o.isMesh && o.name !== 'footAO') o.castShadow = cs; }); } }
      if (!ch.lite && d < LITE_R) want.push({ ch, d, level: 'lite' });
      if (!ch.full && d < FULL_R) want.push({ ch, d: d - 1000, level: 'full' }); // 詳細を優先
    }
    want.sort((p, q) => p.d - q.d);
    for (let i = 0; i < Math.min(maxBuild, want.length); i++) {
      const w = want[i];
      w.ch[w.level] = buildLevel(w.ch, w.level);
      relevel(w.ch);
    }
    return want.length;
  }
  buildings.userData.stream = streamCity;
  root.add(buildings);
  for (const lm of world.landmarks || []) {
    if (lm.kind === 'stephansdom') root.add(buildStephansdom(lm, materials));
    else if (lm.kind === 'generic') root.add(buildGenericLandmark(lm, materials, rng));
  }
  const furniture = buildStreetFurniture(world, materials, assets);
  root.add(furniture);
  // 低画質: 遠くの建物は影を落とさない
  if (quality === 'low') root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  scene.add(root);
  let tris = 0, meshes = 0;
  root.traverse((o) => { if (o.isMesh) { meshes++; const g = o.geometry; const n = g.index ? g.index.count : g.attributes.position.count; tris += (n / 3) * (o.isInstancedMesh ? o.count : 1); } });
  return { group: root, materials, stats: { meshes, triangles: Math.round(tris) },
    // 馬車の位置を毎フレーム渡す。最初の1回は近くを全部作る（maxBuild を大きく）
    update(px, pz, maxBuild = 1) { furniture.userData.streamTrees?.(px, pz, maxBuild); return streamCity(px, pz, maxBuild); },
    dispose() { scene.remove(root); root.traverse((o) => o.geometry?.dispose()); } };
}

// ============================================================================
// sim の g.world → この描画の world 形式（main.js が buildCity の前に 1 回呼ぶ）
//   sim 側: roads(ROADS: pts が [[x,z]])、plazas(rect/circle)、segments、sidewalks(帯)、crosswalks(帯)、
//           buildings([{type:'box',kind:'building',cx,cz,yaw(通りの向き),hl(間口/2),hw(奥行/2),facade,rear}, 円のボラード, ランドマークの当たり])、
//           landmarks(map の生データ {id,x,z,yaw,shape,hl,hw,height})
//   街灯・街路樹は sim に無いので描画側で歩道沿いに置く。壊れる小物(propLayout)は props3d の担当なのでここでは描かない。
// ============================================================================
export function worldFromSim(sw) {
  const segs = sw.segments || [];
  const distToSeg = (x, z, s) => {
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0, L2 = dx * dx + dz * dz || 1;
    let t = ((x - s.x0) * dx + (z - s.z0) * dz) / L2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(s.x0 + dx * t - x, s.z0 + dz * t - z);
  };
  const nearestRoad = (x, z) => { let best = 1e9; for (const s of segs) { const d = distToSeg(x, z, s) - (s.width || 0) / 2; if (d < best) best = d; } return best; };
  const plazaRects = (sw.plazas || []).map((p) => p.rect ? { x0: Math.min(p.rect[0][0], p.rect[1][0]), x1: Math.max(p.rect[0][0], p.rect[1][0]), z0: Math.min(p.rect[0][1], p.rect[1][1]), z1: Math.max(p.rect[0][1], p.rect[1][1]) } : { cx: p.circle.c[0], cz: p.circle.c[1], r: p.circle.r });
  const nearPlaza = (x, z) => { for (const p of plazaRects) { if (p.r != null) { if (Math.hypot(x - p.cx, z - p.cz) < p.r + 30) return true; } else if (x > p.x0 - 30 && x < p.x1 + 30 && z > p.z0 - 30 && z < p.z1 + 30) return true; } return false; };   // CITY2 第 3 周: 14 → 30m
  const out = { seed: sw.seed ?? 1, bounds: sw.bounds, roads: [], plazas: [], sidewalks: [], crosswalks: [], buildings: [], landmarks: [], lamps: [], trees: [], bollards: [], furniture: [], racks: [], signs: [], kiosks: [] };
  // 道路
  for (const r of sw.roads || []) {
    const pts = r.pts.map((p) => (Array.isArray(p) ? { x: p[0], z: p[1] } : p));
    const kind = r.kind === 'ped' ? 'pedestrian' : r.kind;
    const surface = kind === 'pedestrian' ? 'granite' : kind === 'ring' ? 'asphalt' : 'cobble';
    out.roads.push({ pts, width: r.width, kind, surface });
  }
  for (const p of sw.plazas || []) {
    if (p.rect) { const [[x0, z0], [x1, z1]] = p.rect; out.plazas.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, yaw: 0, d: Math.abs(x1 - x0), w: Math.abs(z1 - z0) }); }
    else if (p.circle) { out.plazas.push({ x: p.circle.c[0], z: p.circle.c[1], yaw: 0, d: p.circle.r * 2, w: p.circle.r * 2 }); }
  }
  // 歩道の帯 → OBB（d = 区間の長さ、w = 帯の幅）。縁石は車道側
  for (const s of sw.sidewalks || []) {
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0, len = Math.hypot(dx, dz); if (len < 1) continue;
    const yaw = Math.atan2(dz, dx), nx = -Math.sin(yaw), nz = Math.cos(yaw);
    const lat = (s.innerLat + s.outerLat) / 2, w = Math.abs(s.outerLat - s.innerLat);
    const cx = (s.x0 + s.x1) / 2 + nx * lat, cz = (s.z0 + s.z1) / 2 + nz * lat;
    // ローカル +z = (nx, nz) 方向。車道は lat の逆側
    const curb = lat > 0 ? 'right' : 'left';
    out.sidewalks.push({ x: cx, z: cz, yaw, w, d: len, curb });
  }
  for (const c of sw.crosswalks || []) {
    out.crosswalks.push({ x: c.cx, z: c.cz, yaw: Math.atan2(c.nz, c.nx), w: c.halfDepth * 2, d: c.halfWidth * 2 });
  }
  // 建物: 正面は道路に近い側
  const boxes = (sw.buildings || []).filter((b) => b.type === 'box' && b.kind === 'building');
  const insideAnyBuilding = (x, z, self) => {
    for (const o of boxes) {
      if (o === self) continue;
      const dx = x - o.cx, dz = z - o.cz;
      if (dx * dx + dz * dz > (o.hl + o.hw) * (o.hl + o.hw)) continue;
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      const along = dx * c + dz * s, lat = -dx * s + dz * c;
      if (Math.abs(along) <= o.hl + 0.2 && Math.abs(lat) <= o.hw + 0.2) return true;
    }
    return false;
  };
  let i = 0;
  for (const b of sw.buildings || []) {
    if (b.type === 'circle' && b.kind === 'bollard') { out.bollards.push({ x: b.cx, z: b.cz }); continue; }
    if (b.type !== 'box' || b.kind !== 'building') continue;
    const nx = -Math.sin(b.yaw), nz = Math.cos(b.yaw);
    const dPlus = nearestRoad(b.cx + nx * b.hw, b.cz + nz * b.hw), dMinus = nearestRoad(b.cx - nx * b.hw, b.cz - nz * b.hw);
    const sign = dPlus <= dMinus ? 1 : -1;
    const facing = Math.atan2(nz * sign, nx * sign);
    // 4 面のうち「外に露出していて、道路か広場から 26m 以内」の面にファサードを出す（角地は 2〜3 面）。
    // 賑わい 2026-10-03: 以前は「面の中心が道路の縁から 10m 以内」だけで、交差点の角の建物の側面（2 列目の側面も）が
    // 通りに向いた大きな無地の壁として見えていた（shots/life/r2_high_t7.png）。露出 = 面の外 1.5m の 3 点が他の建物に入っていない
    const fx = Math.cos(facing), fz = Math.sin(facing);
    const lx = -fz, lz = fx; // 正面から見て左（+z 側）
    const sideCenters = { front: [b.cx + fx * b.hw, b.cz + fz * b.hw], back: [b.cx - fx * b.hw, b.cz - fz * b.hw], left: [b.cx + lx * b.hl, b.cz + lz * b.hl], right: [b.cx - lx * b.hl, b.cz - lz * b.hl] };
    const faceDirs = { front: [fx, fz, lx, lz, b.hl], back: [-fx, -fz, lx, lz, b.hl], left: [lx, lz, fx, fz, b.hw], right: [-lx, -lz, fx, fz, b.hw] };
    const faces = [];
    for (const [name, [px, pz]] of Object.entries(sideCenters)) {
      const [nx, nz, tx, tz, half] = faceDirs[name];
      let exposed = false, nearRoad = false;
      for (const s of [-0.6, 0, 0.6]) {
        const qx = px + nx * 1.5 + tx * half * s, qz = pz + nz * 1.5 + tz * half * s;
        if (!insideAnyBuilding(qx, qz, b)) exposed = true;
        if (nearestRoad(qx, qz) < 60 || nearPlaza(qx, qz)) nearRoad = true;   // CITY2 第 3 周: 26 → 40m、第 4 周: 60m（t=20 の広場の壁は rear 棟の back 面で、道路から 40m 以上離れていた。tests/_city2_calls.html?diag=1）
      }
      if (exposed && nearRoad) faces.push(name);
    }
    if (!faces.length) faces.push('front');   // 何にも面していなくても、のっぺりした箱は出さない（軽量版の正面）
    const ob = { x: b.cx, z: b.cz, yaw: facing, w: b.hl * 2, d: b.hw * 2, style: b.facade || 'B', faces, rear: !!b.rear, seed: 1000 + i++ };
    // カフェ建物（sim が決める）: 正面の点に一番近い面をカフェの面にする
    if (b.cafe) {
      let best = 'front', bd = 1e9;
      for (const [name, [px, pz]] of Object.entries(sideCenters)) { const d = Math.hypot(px - b.frontX, pz - b.frontZ); if (d < bd) { bd = d; best = name; } }
      ob.cafe = true; ob.cafeFace = best; if (!faces.includes(best)) faces.push(best);
    }
    out.buildings.push(ob);
  }
  // 広場の屋台（当たり判定は sim 側の円）
  for (const k of sw.kiosks || []) out.kiosks.push({ x: k.cx, z: k.cz, yaw: k.yaw || 0 });
  // 挙動担当 2026-10-14: リング通りの縁の駐車列（当たり判定は sim 側の箱）
  out.parkedCars = (sw.parkedCars || []).map((c) => ({ x: c.cx, z: c.cz, yaw: c.yaw || 0, color: c.color || 0 }));
  // FEEL2 2026-10-14: 家具帯の広告塔（リトファスゾイレ）・花壇（当たり判定は sim 側の円。sim/world.js buildRingFurniture）
  out.adColumns = (sw.ringFurniture || []).filter((f) => f.kind === 'adColumn').map((f, i) => ({ x: f.cx, z: f.cz, yaw: f.yaw || 0, seed: i }));
  out.planters = (sw.ringFurniture || []).filter((f) => f.kind === 'planter').map((f, i) => ({ x: f.cx, z: f.cz, yaw: f.yaw || 0, seed: i }));
  for (const l of sw.landmarks || []) {
    if (l.id === 'Stephansdom') out.landmarks.push({ kind: 'stephansdom', x: l.x, z: l.z, yaw: l.yaw || 0 });
    else out.landmarks.push({ kind: 'generic', id: l.id, name: l.name, x: l.x, z: l.z, yaw: l.yaw || 0, shape: l.shape, hl: l.hl, hw: l.hw, r: l.r, height: l.height });
  }
  // 街灯（歩道の縁石寄り、25m ピッチで左右交互）と街路樹（リング通りの歩道、12m ピッチ）
  let k = 0;
  for (const s of sw.sidewalks || []) {
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0, len = Math.hypot(dx, dz); if (len < 20) continue;
    const yaw = Math.atan2(dz, dx), nx = -Math.sin(yaw), nz = Math.cos(yaw);
    const edge = s.innerLat + Math.sign(s.innerLat) * 0.9;
    const seg = segs[s.segIdx];
    const isRing = seg && seg.kind === 'ring';
    for (let t = 12; t < len - 8; t += 25) {
      // FEEL2 2026-10-14: リング通りは街灯を増設（両側 25m ごと。街路は従来どおり左右交互 = 片側 50m ごと）
      if (!isRing && (k++ % 2 === 0) !== (s.side > 0)) continue;
      if (isRing) k++;
      out.lamps.push({ x: s.x0 + dx * (t / len) + nx * edge, z: s.z0 + dz * (t / len) + nz * edge, yaw: yaw + (s.side > 0 ? Math.PI / 2 : -Math.PI / 2) });
    }
    // 賑わい 2026-10-03: ベンチ（街灯の間、道路を向く）・自転車ラック（街灯の 6m 先）・標識（区間の両端から 9m）
    const sideYaw = yaw + (s.side > 0 ? -Math.PI / 2 : Math.PI / 2); // 歩道から車道を向く向き
    const wSide = Math.abs(s.outerLat - s.innerLat);
    if (wSide >= 2.0) {
      for (let t = 24; t < len - 10; t += 50) {
        const lat = s.innerLat + Math.sign(s.innerLat) * Math.min(wSide - 0.6, 1.6);
        if ((k + Math.floor(t / 50)) % 3 === 0) out.racks.push({ x: s.x0 + dx * (t / len) + nx * lat, z: s.z0 + dz * (t / len) + nz * lat, yaw });
        else out.furniture.push({ kind: 'bench', x: s.x0 + dx * (t / len) + nx * lat, z: s.z0 + dz * (t / len) + nz * lat, yaw: sideYaw });
      }
      const signLat = s.innerLat + Math.sign(s.innerLat) * 0.6;
      const kinds = ['noentry', 'parking', 'pedzone'];
      if (len > 40 && s.side > 0) out.signs.push({ x: s.x0 + dx * (9 / len) + nx * signLat, z: s.z0 + dz * (9 / len) + nz * signLat, yaw: yaw + Math.PI, kind: kinds[k % 3] });
      if (len > 40 && s.side < 0) out.signs.push({ x: s.x0 + dx * ((len - 9) / len) + nx * signLat, z: s.z0 + dz * ((len - 9) / len) + nz * signLat, yaw, kind: kinds[(k + 1) % 3] });
    }
    if (isRing) for (let t = 6; t < len - 6; t += 16) {
      const lat = s.innerLat + Math.sign(s.innerLat) * 3.5;
      out.trees.push({ x: s.x0 + dx * (t / len) + nx * lat, z: s.z0 + dz * (t / len) + nz * lat, r: 3.4 });
      // 挙動担当 2026-10-14: 並木を 2 列に（リング通りのプラタナス。建物寄りにもう 1 列、半ピッチずらす）
      if (t + 8 < len - 6 && Math.floor(t / 16) % 2 === 0) { const lat2 = s.innerLat + Math.sign(s.innerLat) * 6.3; out.trees.push({ x: s.x0 + dx * ((t + 8) / len) + nx * lat2, z: s.z0 + dz * ((t + 8) / len) + nz * lat2, r: 2.9 }); }
    }
  }
  // 挙動担当 2026-10-14: リング通り（幅 50m）の広い舗装を埋める: 路面電車の線路（中央）・架線柱と横断スパン線・車線の白線
  // （sim の交差点・停車枠・歩行者の帯には触れない。全部 1〜3 メッシュに結合するので draw call・メモリはほぼ増えない）
  out.ring = { rails: [], dashes: [], solids: [], poles: [], spans: [], stops: [] };
  // FEEL2 2026-10-14: 停止線 — 横断歩道の手前 1.3m、交差点へ向かう側の車線（sim の車は進行方向 +d で lateral +、街路は中央）に白い帯
  for (const c of sw.crosswalks || []) {
    const seg = segs[c.segIdx]; if (!seg) continue;
    const cs = { hw: (seg.width || 10) / 2 }; const sidewalk = seg.kind === 'ring' ? Math.min(12, cs.hw * 0.3) : Math.min(3.5, cs.hw * 0.4); const tram = seg.kind === 'ring' ? Math.min(3.5, cs.hw * 0.15) : 0;
    const carLane = Math.max(1, cs.hw - sidewalk - tram);
    const toStart = Math.hypot(c.cx - seg.x0, c.cz - seg.z0) < Math.hypot(c.cx - seg.x1, c.cz - seg.z1); // 横断歩道が区間の始点側か
    const approach = toStart ? -1 : 1;                       // 交差点（ノード）へ向かう進行方向の符号（+d = 1）
    const latCenter = approach * (tram + carLane / 2);       // 向かう側の車線の中心（街路は tram 0, carLane = 半幅 → 片側半分）
    const along = -approach * (c.halfDepth + 1.3);
    out.ring.stops.push({ x: c.cx + seg.dx * along + seg.nx * latCenter, z: c.cz + seg.dz * along + seg.nz * latCenter, yaw: Math.atan2(seg.dz, seg.dx), len: carLane - 0.4 });
  }
  for (const seg of segs) {
    if (seg.kind !== 'ring' || !(seg.len > 20)) continue;
    const yaw = Math.atan2(seg.dz, seg.dx), nx = seg.nx, nz = seg.nz;
    const at = (t, lat) => ({ x: seg.x0 + seg.dx * t + nx * lat, z: seg.z0 + seg.dz * t + nz * lat, yaw });
    const m0 = 7, m1 = seg.len - 7; // 交差点の手前は空ける
    if (m1 - m0 < 6) continue;
    const mid = (m0 + m1) / 2, L = m1 - m0;
    for (const lat of [-0.72, 0.72]) out.ring.rails.push({ ...at(mid, lat), len: L });
    for (const lat of [-2.0, 2.0]) out.ring.solids.push({ ...at(mid, lat), len: L });
    for (const lat of [-6, 6, -10, 10]) for (let t = m0 + 2; t + 3 < m1; t += 9) out.ring.dashes.push(at(t + 1.5, lat));
    const hw = (seg.width || 50) / 2, sidewalk = Math.min(12, hw * 0.3), tram = Math.min(3.5, hw * 0.15), curb = Math.max(1, hw - sidewalk - tram);
    for (let t = m0 + 9; t < m1 - 4; t += 32) {
      for (const side of [-1, 1]) out.ring.poles.push(at(t, side * (curb + tram + 0.6)));
      out.ring.spans.push({ ...at(t, 0), len: (curb + tram + 0.6) * 2 });
    }
  }
  return out;
}
