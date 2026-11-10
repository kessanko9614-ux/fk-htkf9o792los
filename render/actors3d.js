// render/actors3d.js — 馬（glb アニメ）・馬車（手続き）・御者・歩行者（glb アニメ）・車・トラム
//
//   const assets = await loadActorAssets();
//   const carriage = createCarriage(assets);  scene.add(carriage.group);  carriage.update(g.player, dt);
//   const ped = createPedestrian(assets, look); scene.add(ped.group);  ped.update(pedState, dt, camDist);
//   const car = createCar('taxi');               scene.add(car.group);  car.update(carState, dt);
//
// 向きの規約: yaw は +x から +z へ測る角（forward = (cos yaw, sin yaw)）。three.js では rotation.y = -yaw。
// 全ての手続きモデルはローカル +x が前。

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadGLB, normalizeModel } from './assets.js';

// 賑わい 2026-10-03: createCar('fiaker') が馬の glb を使えるよう、loadActorAssets の戻りをここにも置く
let ACTOR_ASSETS = null;

// 寸法（research/vienna-reference.md §5.1）
export const CARRIAGE = {
  bodyL: 2.8, bodyW: 1.6, floorY: 0.6, sideTopY: 1.5,
  rearR: 0.575, rearX: -0.9, rearZ: 0.8,
  frontR: 0.45, frontX: 1.1, frontZ: 0.75,
  boxX: 1.6, boxSeatY: 1.6,
  poleStartX: 2.2, poleLen: 2.1,
  horseX: 4.0, horseGap: 1.1,   // 馬の胴の中心（馬車中心からの距離）と 2 頭の間隔
  withers: 1.65,
};

// 馬の歩様 → アニメ。Walk 1 周期 1.17s で約 1.6m 進む（≒1.4 m/s）, Gallop 0.58s で約 4.5m（≒7.8 m/s）
const GAIT_ANIM = [
  { clip: 'Idle', rate: () => 1 },
  { clip: 'Walk', rate: (v) => Math.max(0.6, v / 1.5) },
  { clip: 'Walk', rate: (v) => Math.max(0.9, v / 1.6) },
  { clip: 'Gallop', rate: (v) => Math.max(0.7, v / 7.5) },
  { clip: 'Gallop', rate: (v) => Math.max(0.9, v / 7.5) },
];

const PED_PALETTE = [
  { Shirt: 0x3b4a6b, Pants: 0x2a2a2e, Hair: 0x2b1d14 },
  { Shirt: 0xd9d3c4, Pants: 0x4b5564, Hair: 0x5a3a22 },
  { Shirt: 0x8b2323, Pants: 0x1f1f22, Hair: 0x111111 },
  { Shirt: 0x6f8a5a, Pants: 0xc9c2b0, Hair: 0xb59a6a },
  { Shirt: 0xeae5da, Pants: 0x2d3a52, Hair: 0x3a2a22 },
  { Shirt: 0x2e3330, Pants: 0x6d6a66, Hair: 0x8a8a8a },
  { Dress: 0x7fa394, Hair: 0x2b1d14 },
  { Dress: 0xe9d4c6, Hair: 0x5a3a22 },
  { Dress: 0x3a2a52, Hair: 0x111111 },
  { Dress: 0xd9b24a, Hair: 0xb59a6a },
];

function findClip(anims, name) {
  return anims.find((a) => a.name === name) || anims.find((a) => a.name.endsWith('|' + name) || a.name.endsWith('_' + name)) || null;
}

export async function loadActorAssets() {
  const [hw, hb, mc, ms, wc, wd] = await Promise.all([
    loadGLB('models/horse/horse_white_quaternius.glb'),
    loadGLB('models/horse/horse_brown_quaternius.glb'),
    loadGLB('models/people/man_casual_quaternius.glb'),
    loadGLB('models/people/man_suit_quaternius.glb'),
    loadGLB('models/people/woman_casual_quaternius.glb'),
    loadGLB('models/people/woman_dress_quaternius.glb'),
  ]);
  const horseOpts = { targetHeight: 2.2, forward: '+z' };  // 頭の天辺まで 2.2m（き甲 ≒ 1.65m）
  const pedOpts = { targetHeight: 1.72, forward: '+z' };
  const assets = {
    horses: { white: normalizeModel(hw, horseOpts), brown: normalizeModel(hb, horseOpts) },
    people: [normalizeModel(mc, pedOpts), normalizeModel(ms, pedOpts), normalizeModel(wc, pedOpts), normalizeModel(wd, pedOpts)],
  };
  // 馬の毛色: 白は葦毛 #d9d6d2、茶は黒鹿毛寄り #3d2a22（写真 P2/P3）
  tintHorse(assets.horses.white, 0xd9d6d2, 0xbdb8b2, 0xe8e5e0, 0x9c9590);
  tintHorse(assets.horses.brown, 0x3d2a22, 0x241712, 0x5a3f33, 0x1a1210);
  for (const p of assets.people) p.scene.traverse((o) => { if (o.isMesh && o.material) { o.material.roughness = 0.85; o.material.envMapIntensity = 0.7; } });
  ACTOR_ASSETS = assets;
  return assets;
}

function tintHorse(model, main, dark, light, hair) {
  model.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = o.material;
    if (m.name === 'Main') m.color.set(main);
    else if (m.name === 'Main_Dark') m.color.set(dark);
    else if (m.name === 'Main_Light') m.color.set(light);
    else if (m.name === 'Hair') m.color.set(hair);
    else if (m.name === 'Hooves') m.color.set(0x2a2320);
    else if (m.name === 'Muzzle') m.color.set(dark);
    m.roughness = 0.75; m.envMapIntensity = 0.7;
  });
}

// ---- 共有マテリアル ----
let MAT = null;
function mats() {
  if (MAT) return MAT;
  MAT = {
    lacquer: new THREE.MeshPhysicalMaterial({ color: 0x17151a, roughness: 0.18, metalness: 0.05, clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.8 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 1.0, envMapIntensity: 1.3 }),
    redLeather: new THREE.MeshStandardMaterial({ color: 0x8b2323, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.8 }),
    blackLeather: new THREE.MeshStandardMaterial({ color: 0x17151a, roughness: 0.85, metalness: 0.0 }),
    wheel: new THREE.MeshStandardMaterial({ color: 0xe6e6e4, roughness: 0.5, metalness: 0.0, envMapIntensity: 0.8 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x222224, roughness: 0.7, metalness: 0.3 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.6 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x1e1f22, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.9 }),
    lampGlass: new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffe2a0, emissiveIntensity: 0.6, roughness: 0.2 }),
    blanket: new THREE.MeshStandardMaterial({ color: 0x8b2323, roughness: 0.9 }),
    hat: new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.45, metalness: 0.0 }),
    rein: new THREE.LineBasicMaterial({ color: 0x15130f }),
    carPaint: {
      car: new THREE.MeshPhysicalMaterial({ color: 0x1b2230, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.1 }),
      taxi: new THREE.MeshPhysicalMaterial({ color: 0xf2f2ee, roughness: 0.35, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.1 }),
      tram: new THREE.MeshStandardMaterial({ color: 0xcc0605, roughness: 0.45, metalness: 0.1 }),
    },
    carGlass: new THREE.MeshStandardMaterial({ color: 0x1f262d, roughness: 0.1, metalness: 0.7, envMapIntensity: 1.4 }),
    tramWhite: new THREE.MeshStandardMaterial({ color: 0xf1ece1, roughness: 0.5 }),
    tramRoof: new THREE.MeshStandardMaterial({ color: 0xb5b0a1, roughness: 0.7 }),
    sign: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }),
    signText: new THREE.MeshStandardMaterial({ color: 0xf2c200, emissive: 0xf2c200, emissiveIntensity: 0.3, roughness: 0.6 }),
    hazard: new THREE.MeshStandardMaterial({ color: 0xffa020, emissive: 0xff9010, emissiveIntensity: 0.0, roughness: 0.4 }),
  };
  return MAT;
}

function mesh(geo, mat, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = shadow; return m;
}

// ---- 車輪（トーラスのリム + 14 本スポーク + ハブ + 細いタイヤ）。軸は z ----
function makeWheel(R, nSpokes = 14) {
  const M = mats();
  const g = new THREE.Group();
  const rim = mesh(new THREE.TorusGeometry(R - 0.03, 0.03, 8, 32), M.wheel); g.add(rim);
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.05, 32, 1, true), M.tire); tire.rotation.x = Math.PI / 2; tire.castShadow = true; g.add(tire);
  const hub = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.16, 12), M.wheel); hub.rotation.x = Math.PI / 2; g.add(hub);
  const spokeGeo = new THREE.BoxGeometry(0.03, R - 0.06, 0.03);
  for (let i = 0; i < nSpokes; i++) {
    const s = new THREE.Mesh(spokeGeo, M.wheel);
    const a = (i / nSpokes) * Math.PI * 2;
    s.position.set(Math.cos(a) * (R / 2 - 0.02), Math.sin(a) * (R / 2 - 0.02), 0);
    s.rotation.z = a - Math.PI / 2;
    s.castShadow = true;
    g.add(s);
  }
  return g;
}

// ---- 泥除け（車輪の上に掛かる帯） ----
function makeFender(R, width) {
  const geo = new THREE.CylinderGeometry(R + 0.07, R + 0.07, width, 20, 1, true, -Math.PI * 0.15, Math.PI * 0.75);
  const m = new THREE.Mesh(geo, mats().lacquer);
  m.rotation.x = Math.PI / 2; m.rotation.y = 0;
  m.material.side = THREE.DoubleSide;
  m.castShadow = true;
  return m;
}

// ============================================================================
// 馬 1 頭（アニメ付き）
// ============================================================================
function createHorse(assets, color) {
  const src = assets.horses[color] || assets.horses.white;
  const pivot = SkeletonUtils.clone(src.pivot);
  pivot.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const mixer = new THREE.AnimationMixer(pivot);
  const actions = {};
  for (const name of ['Idle', 'Walk', 'Gallop']) {
    const clip = findClip(src.animations, name);
    if (clip) { actions[name] = mixer.clipAction(clip); actions[name].enabled = true; actions[name].setEffectiveWeight(name === 'Idle' ? 1 : 0); actions[name].play(); }
  }
  // 馬具: 腹帯と首輪（黒革）
  const M = mats();
  const girth = mesh(new THREE.TorusGeometry(0.46, 0.025, 6, 24), M.blackLeather, 0.05, 1.05, 0); girth.rotation.y = Math.PI / 2; girth.scale.set(1, 0.9, 1); pivot.add(girth);
  const collar = mesh(new THREE.TorusGeometry(0.34, 0.045, 8, 24), M.blackLeather, 0.78, 1.2, 0); collar.rotation.y = Math.PI / 2; collar.rotation.x = Math.PI * 0.12; collar.scale.set(1, 1.25, 1); pivot.add(collar);
  const buckle = mesh(new THREE.BoxGeometry(0.05, 0.06, 0.04), M.brass, 0.78, 0.86, 0.0); pivot.add(buckle);
  let current = 'Idle';
  return {
    group: pivot, mixer, actions,
    setGait(gait, speed, dt) {
      const spec = GAIT_ANIM[Math.max(0, Math.min(4, gait | 0))];
      const name = actions[spec.clip] ? spec.clip : 'Walk';
      if (name !== current) {
        const from = actions[current], to = actions[name];
        if (from && to) { to.reset().setEffectiveWeight(1).play(); from.crossFadeTo(to, 0.35, false); }
        current = name;
      }
      const act = actions[current];
      if (act) act.setEffectiveTimeScale(spec.rate(speed));
      mixer.update(dt);
    },
  };
}

// ============================================================================
// 馬車（2 頭立て）
// ============================================================================
export function createCarriage(assets, { horseColors = ['white', 'brown'] } = {}) {
  const C = CARRIAGE, M = mats();
  const root = new THREE.Group(); root.name = 'carriage';
  const body = new THREE.Group(); root.add(body);          // 車体（サスペンションで揺れる）
  const chassis = new THREE.Group(); root.add(chassis);    // 車軸・車輪

  // --- 車体: 客室の箱（下を少し丸める: 本体 + 下部の丸い帯）
  const shellH = C.sideTopY - C.floorY;
  const shell = mesh(new THREE.BoxGeometry(C.bodyL, shellH, C.bodyW), M.lacquer, 0, C.floorY + shellH / 2, 0);
  body.add(shell);
  const belly = mesh(new THREE.CylinderGeometry(0.28, 0.28, C.bodyL - 0.3, 14, 1, false, 0, Math.PI), M.lacquer, 0, C.floorY + 0.02, 0);
  belly.rotation.z = Math.PI / 2; belly.rotation.y = 0; belly.scale.set(1, 1, C.bodyW / 0.56);
  body.add(belly);
  // 客室の内側（暗い底）と赤い座席（向かい合わせ）
  body.add(mesh(new THREE.BoxGeometry(C.bodyL - 0.2, 0.05, C.bodyW - 0.2), M.blackLeather, 0, C.floorY + 0.15, 0));
  for (const sx of [1, -1]) {
    const seat = mesh(new THREE.BoxGeometry(0.5, 0.2, C.bodyW - 0.3), M.redLeather, sx * 0.85, C.floorY + 0.5, 0); body.add(seat);
    const back = mesh(new THREE.BoxGeometry(0.14, 0.62, C.bodyW - 0.3), M.redLeather, sx * 1.15, C.floorY + 0.85, 0); body.add(back);
    // 座面の縫い目（細い黒線）
    for (let k = -1; k <= 1; k++) body.add(mesh(new THREE.BoxGeometry(0.5, 0.01, 0.015), M.blackLeather, sx * 0.85, C.floorY + 0.605, k * 0.4, false));
  }
  // 金の縁取り（車体の上端・下端・コーナーのピンストライプ）
  const gl = (w, h, d, x, y, z) => body.add(mesh(new THREE.BoxGeometry(w, h, d), M.brass, x, y, z, false));
  for (const sz of [1, -1]) {
    gl(C.bodyL + 0.01, 0.025, 0.02, 0, C.sideTopY - 0.06, sz * (C.bodyW / 2 + 0.005));
    gl(C.bodyL + 0.01, 0.015, 0.02, 0, C.floorY + 0.25, sz * (C.bodyW / 2 + 0.005));
    gl(C.bodyL + 0.01, 0.015, 0.02, 0, C.floorY + 0.21, sz * (C.bodyW / 2 + 0.005));
  }
  for (const sx of [1, -1]) {
    gl(0.02, 0.025, C.bodyW + 0.01, sx * (C.bodyL / 2 + 0.005), C.sideTopY - 0.06, 0);
    gl(0.02, 0.015, C.bodyW + 0.01, sx * (C.bodyL / 2 + 0.005), C.floorY + 0.25, 0);
  }
  // ドアの線と取っ手
  for (const sz of [1, -1]) {
    body.add(mesh(new THREE.BoxGeometry(0.012, shellH - 0.2, 0.01), M.iron, -0.3, C.floorY + shellH / 2, sz * (C.bodyW / 2 + 0.006), false));
    body.add(mesh(new THREE.BoxGeometry(0.012, shellH - 0.2, 0.01), M.iron, 0.5, C.floorY + shellH / 2, sz * (C.bodyW / 2 + 0.006), false));
    body.add(mesh(new THREE.BoxGeometry(0.12, 0.03, 0.03), M.brass, 0.42, C.floorY + 0.55, sz * (C.bodyW / 2 + 0.02), false));
  }
  // 畳んだ幌（後席の後ろ）: 黒革の塊 + 3 本の骨
  const hood = mesh(new THREE.BoxGeometry(0.42, 0.26, C.bodyW - 0.1), M.blackLeather, -1.25, C.sideTopY + 0.05, 0); body.add(hood);
  for (let i = 0; i < 3; i++) {
    const rib = mesh(new THREE.TorusGeometry(0.75, 0.02, 6, 20, Math.PI * 0.5), M.iron, -1.2 + i * 0.07, C.sideTopY - 0.35, 0);
    rib.rotation.y = Math.PI / 2; rib.rotation.z = Math.PI * 0.55; rib.scale.set(1, 1, (C.bodyW - 0.2) / 1.7);
    body.add(rib);
  }
  // 御者台（ボックス）+ 赤い毛布 + 足板
  const boxBase = mesh(new THREE.BoxGeometry(0.7, C.boxSeatY - C.floorY - 0.25, 1.3), M.lacquer, C.boxX, (C.boxSeatY - 0.25 + C.floorY) / 2, 0); body.add(boxBase);
  body.add(mesh(new THREE.BoxGeometry(0.72, 0.22, 1.34), M.blanket, C.boxX, C.boxSeatY - 0.11, 0));
  body.add(mesh(new THREE.BoxGeometry(0.08, 0.14, 1.34), M.lacquer, C.boxX - 0.33, C.boxSeatY + 0.07, 0)); // 御者台の低い背もたれ（高いと後方カメラから馬が隠れる）
  const foot = mesh(new THREE.BoxGeometry(0.6, 0.04, 1.2), M.lacquer, C.boxX + 0.62, C.floorY + 0.55, 0); foot.rotation.z = 0.5; body.add(foot);
  // 前の曲がった泥除け板（ダッシュボード）
  const dash = mesh(new THREE.BoxGeometry(0.04, 0.5, 1.3), M.lacquer, C.boxX + 0.85, C.floorY + 0.95, 0); dash.rotation.z = -0.35; body.add(dash);
  // ランプ ×2（真鍮 + ガラス）
  for (const sz of [1, -1]) {
    const lampG = new THREE.Group(); lampG.position.set(C.boxX + 0.1, C.boxSeatY + 0.15, sz * (C.bodyW / 2 + 0.12));
    lampG.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 10), M.brass, 0, 0, 0));
    lampG.add(mesh(new THREE.BoxGeometry(0.16, 0.2, 0.16), M.lampGlass, 0, 0.0, 0));
    lampG.add(mesh(new THREE.ConeGeometry(0.11, 0.1, 10), M.brass, 0, 0.2, 0));
    lampG.add(mesh(new THREE.BoxGeometry(0.03, 0.03, 0.16), M.brass, 0, -0.1, -sz * 0.1));
    body.add(lampG);
  }
  // 泥除け（4 輪）
  for (const [x, z, R] of [[C.rearX, C.rearZ, C.rearR], [C.rearX, -C.rearZ, C.rearR], [C.frontX, C.frontZ, C.frontR], [C.frontX, -C.frontZ, C.frontR]]) {
    const f = makeFender(R, 0.26); f.position.set(x, R, z); body.add(f);
  }
  // 板バネ（車体と車軸をつなぐ、黒）
  for (const sz of [1, -1]) {
    body.add(mesh(new THREE.BoxGeometry(1.2, 0.05, 0.08), M.iron, -0.6, C.floorY - 0.08, sz * 0.7));
    body.add(mesh(new THREE.BoxGeometry(0.9, 0.05, 0.08), M.iron, 1.1, C.floorY - 0.08, sz * 0.65));
  }
  // --- 車軸と車輪
  const wheels = [];
  for (const [x, z, R] of [[C.rearX, C.rearZ, C.rearR], [C.rearX, -C.rearZ, C.rearR], [C.frontX, C.frontZ, C.frontR], [C.frontX, -C.frontZ, C.frontR]]) {
    const w = makeWheel(R, R > 0.5 ? 14 : 12); w.position.set(x, R, z); chassis.add(w); wheels.push({ g: w, R });
  }
  chassis.add(mesh(new THREE.BoxGeometry(0.08, 0.08, C.rearZ * 2), M.iron, C.rearX, C.rearR, 0));
  chassis.add(mesh(new THREE.BoxGeometry(0.08, 0.08, C.frontZ * 2), M.iron, C.frontX, C.frontR, 0));
  chassis.add(mesh(new THREE.BoxGeometry(C.frontX - C.rearX, 0.07, 0.07), M.iron, (C.frontX + C.rearX) / 2, 0.5, 0));
  // 轅（ながえ）と横木: 馬の向きに合わせて回す
  const poleG = new THREE.Group(); poleG.position.set(C.poleStartX - 0.2, 0.75, 0); chassis.add(poleG);
  const pole = mesh(new THREE.CylinderGeometry(0.035, 0.045, C.poleLen + 0.4, 8), M.wood, (C.poleLen + 0.4) / 2, 0, 0); pole.rotation.z = -Math.PI / 2; poleG.add(pole);
  poleG.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 8), M.wood, 0.3, 0, 0).rotateX(Math.PI / 2));
  poleG.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), M.brass, C.poleLen + 0.15, 0, 0));
  // ナンバープレート（黄）
  body.add(mesh(new THREE.BoxGeometry(0.01, 0.15, 0.3), new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 }), -C.bodyL / 2 - 0.01, C.floorY + 0.3, 0.4, false));

  // --- 馬 2 頭
  const horses = horseColors.map((c, i) => {
    const h = createHorse(assets, c);
    h.group.position.set(0, 0, (i === 0 ? -1 : 1) * C.horseGap / 2);
    return h;
  });
  const horsePair = new THREE.Group(); root.add(horsePair);
  horses.forEach((h) => horsePair.add(h.group));

  // --- 御者（座った人 + 山高帽）
  const driver = createPedestrianInner(assets, 1, { Shirt: 0xd9d9d6, Pants: 0x1a1a1c, Hair: 0x3a2a22, Details: 0x6f6f72, TieTexture: 0x6f6f72 });
  driver.group.position.set(C.boxX - 0.05, C.boxSeatY - 0.02, 0);
  driver.group.scale.setScalar(1.0);
  driver.playOnly('Sitting');
  body.add(driver.group);
  const hat = new THREE.Group();
  hat.add(mesh(new THREE.CylinderGeometry(0.1, 0.105, 0.12, 16), M.hat, 0, 0.06, 0));
  hat.add(mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.015, 16), M.hat, 0, 0.0, 0));
  hat.add(mesh(new THREE.TorusGeometry(0.1, 0.012, 6, 16), M.blackLeather, 0, 0.015, 0).rotateX(Math.PI / 2));
  root.add(hat);
  let headBone = null; driver.group.traverse((o) => { if (!headBone && o.isBone && /head/i.test(o.name)) headBone = o; });

  // --- 手綱（御者の手 → 各馬の首）
  const reinGeo = new THREE.BufferGeometry(); reinGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
  const reins = new THREE.LineSegments(reinGeo, M.rein); reins.frustumCulled = false; root.add(reins);

  // --- 影の無い画質用の「接地の黒丸」
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.01; blob.scale.set(7.5, 2.2, 1); blob.position.x = 1.2; root.add(blob);

  const tmpV = new THREE.Vector3(), tmpW = new THREE.Vector3(), tmpH = new THREE.Vector3();
  let wheelAngle = 0;
  const sway = { roll: 0, pitch: 0, rollV: 0, pitchV: 0 };

  function update(player, dt, { blobShadow = false } = {}) {
    const car = player.carriage, hr = player.horse;
    const speed = player.speed ?? Math.hypot(car.vx || 0, car.vz || 0);
    root.position.set(car.x, car.airborne || 0, car.z);
    root.rotation.y = -car.yaw;
    // 馬: 馬車に対する相対位置（sim が別座標を持つ）
    const dx = hr.x - car.x, dz = hr.z - car.z;
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    const lx = dx * cy + dz * sy, lz = -dx * sy + dz * cy;   // ワールド差分 → 馬車ローカル
    horsePair.position.set(lx, 0, lz);
    horsePair.rotation.y = -(hr.yaw - car.yaw);
    for (const h of horses) h.setGait(hr.gait ?? 0, speed, dt);
    // 轅: 馬の方向へ
    const ang = Math.atan2(lz - 0, lx - (C.poleStartX - 0.2));
    poleG.rotation.y = -ang;
    // 車輪
    // 2026-10-14 見た目: sim の wheelSpin は「半径 0.5m の車輪の絶対角（0..2π）」。以前は毎フレーム足し込んでいたので
    // 車輪が角度に比例した速さで回り、ガクガクと不規則に回って見えた（カクつきの一因）。絶対角として使う
    if (car.wheelSpin != null) wheelAngle = car.wheelSpin * (0.5 / C.rearR);
    else wheelAngle += speed * dt / C.rearR;
    for (const w of wheels) w.g.rotation.z = -wheelAngle * (C.rearR / w.R);
    // サスペンション: 横 G でロール、前後 G でピッチ、歩様で上下
    const targetRoll = THREE.MathUtils.clamp((player.lateralG || 0) * 0.018, -0.08, 0.08);
    const targetPitch = THREE.MathUtils.clamp(-(player.longG || 0) * 0.012, -0.06, 0.06);
    // FIX3 2026-10-14（「上下に振り子現象」）: 車体のバネは k=40, c=7（減衰比 0.55、固有周期 1.2 秒）で、ブレーキや段差のあと
    // 前後に 3〜6° 振り子のように揺れ続けていた → 臨界減衰（c = 2√k）。慣性でひと呼吸遅れるのは残り、0.5 秒で収まる。
    // 歩様の上下も 2cm（全力で 7.7 Hz・4cm ピークピーク）を 0.5cm に。馬車はばね付きなので馬の足取りはほぼ伝わらない
    const k = 40, c = 2 * Math.sqrt(k);
    sway.rollV += ((targetRoll - sway.roll) * k - sway.rollV * c) * dt; sway.roll += sway.rollV * dt;
    sway.pitchV += ((targetPitch - sway.pitch) * k - sway.pitchV * c) * dt; sway.pitch += sway.pitchV * dt;
    const bob = (hr.gait >= 3 ? 0.005 : 0.003) * Math.sin((hr.phase || 0) * Math.PI * 2);
    body.rotation.x = sway.roll; body.rotation.z = sway.pitch; body.position.y = bob;
    // 帽子: 頭の骨の上
    if (headBone) {
      headBone.getWorldPosition(tmpH);
      hat.position.copy(root.worldToLocal(tmpH.clone())); hat.position.y += 0.13;
      hat.rotation.set(0, 0, 0);
    }
    // 手綱
    const pos = reinGeo.attributes.position;
    const hand = tmpW.set(C.boxX + 0.3, C.boxSeatY + 0.45, 0);
    horses.forEach((h, i) => {
      tmpV.set(0.95, 1.35, 0).applyMatrix4(h.group.matrixWorld);
      root.worldToLocal(tmpV);
      pos.setXYZ(i * 2, hand.x, hand.y, hand.z + (i === 0 ? -0.12 : 0.12));
      pos.setXYZ(i * 2 + 1, tmpV.x, tmpV.y, tmpV.z);
    });
    pos.needsUpdate = true;
    blob.material.opacity = blobShadow ? 0.35 : 0.0;
    root.updateMatrixWorld(true);
  }

  return { group: root, body, horses, driver, update, wheels };
}

// ============================================================================
// 歩行者
// ============================================================================
const matCache = new Map();
function recolored(model, modelIndex, palette) {
  const key = modelIndex + ':' + JSON.stringify(palette);
  if (matCache.has(key)) return matCache.get(key);
  const map = new Map();
  model.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = o.material;
    if (!map.has(m)) {
      const c = m.clone();
      if (palette[m.name] != null) c.color.set(palette[m.name]);
      map.set(m, c);
    }
  });
  matCache.set(key, map);
  return map;
}

function createPedestrianInner(assets, modelIndex, palette) {
  const model = assets.people[modelIndex % assets.people.length];
  const pivot = SkeletonUtils.clone(model.pivot);
  const mm = recolored(model, modelIndex, palette);
  pivot.traverse((o) => { if (o.isMesh) { o.material = mm.get(o.material) || o.material; o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const mixer = new THREE.AnimationMixer(pivot);
  const actions = {};
  for (const name of ['Idle', 'Walk', 'Run', 'Jump', 'Sitting', 'Death', 'Punch', 'Standing', 'Clapping']) {
    const clip = findClip(model.animations, name);
    if (clip) actions[name] = mixer.clipAction(clip);
  }
  let current = null;
  function play(name, { fade = 0.25, once = false, timeScale = 1 } = {}) {
    const a = actions[name] || actions.Idle; if (!a) return;
    if (current === a) { a.setEffectiveTimeScale(timeScale); return; }
    a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(timeScale);
    if (once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; } else a.setLoop(THREE.LoopRepeat, Infinity);
    a.play();
    if (current) current.crossFadeTo(a, fade, false);
    current = a;
  }
  function playOnly(name) { play(name, { fade: 0 }); mixer.update(0.5); }
  return { group: pivot, mixer, actions, play, playOnly, animations: model.animations };
}

export function createPedestrian(assets, look = 0) {
  const pal = PED_PALETTE[look % PED_PALETTE.length];
  const modelIndex = pal.Dress ? 3 : [0, 1, 2][look % 3];
  const p = createPedestrianInner(assets, modelIndex, pal);
  let lastState = null, frame = 0, lastX = null, lastZ = null, grow = 1, lastTick = 0, skipped = 0;
  // 賑わい 2026-10-03: sit（カフェ）/ idle・browse・watch（立ち止まる）/ perform（大道芸人: Jump をゆっくり繰り返す）
  const STATE_ANIM = { walk: 'Walk', cross: 'Walk', wait: 'Idle', flee: 'Run', dodge: 'Jump', fly: 'Jump', down: 'Death', angry: 'Punch', sit: 'Sitting', stand: 'Standing', clap: 'Clapping', idle: 'Idle', browse: 'Idle', watch: 'Idle', perform: 'Jump' };
  // 2026-10-03: フレームカリングを有効にする（以前は false で全員を毎フレーム描いていた）。スキンの外接球は
  // 立ちポーズで計算されるので、歩き・跳びでもはみ出さないよう半径を 1.8 倍に広げる
  // 主ループ 2026-10-14: 部位ごと（シャツ・肌・ズボン…）の画面外判定をやめる。外接球を最初の姿勢で一度だけ計算するため、
  // 歩き・跳びで形が変わると一部の部位だけ省かれ「透明な人が混じる」（天才さんの指摘）。代わりに人1人まるごと距離で省く
  p.group.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
  function update(ped, dt, camDist = 0) {
    p.group.visible = camDist < 120;
    // 位置が一気に飛んだ（sim が遠くから近くの見えない所へ出し直した）→ 0.4 秒で伸び上がる
    const tick = ped._spawnTick || 0;
    if (lastX != null && (tick !== lastTick || Math.hypot(ped.x - lastX, ped.z - lastZ) > 12)) grow = 0;
    lastX = ped.x; lastZ = ped.z; lastTick = tick;
    if (grow < 1) { grow = Math.min(1, grow + dt * 2.5); const s = 0.05 + 0.95 * grow; p.group.scale.set(s, s, s); } else if (p.group.scale.x !== 1) p.group.scale.set(1, 1, 1);
    p.group.position.set(ped.x, ped.y || 0, ped.z);
    p.group.rotation.set(0, -ped.yaw, 0);
    if (ped.state === 'fly') p.group.rotation.z = ped.spin || 0;
    if (ped.state !== lastState) {
      lastState = ped.state;
      const name = STATE_ANIM[ped.state] || 'Idle';
      p.play(name, { once: ped.state === 'down' || ped.state === 'fly' || ped.state === 'dodge', timeScale: ped.state === 'fly' ? 0.4 : ped.state === 'perform' ? 0.75 : 1 });
      if (ped.state === 'fly' && p.actions.Jump) { p.actions.Jump.paused = false; }
    }
    if (ped.state === 'walk' || ped.state === 'cross') {
      const v = ped.speed ?? (Math.hypot(ped.vx || 0, ped.vz || 0) || 1.3);
      p.play('Walk', { timeScale: Math.max(0.7, v / 1.3) });
    }
    // 遠い個体は更新を間引く。2026-10-14 見た目: 35m から 2 フレームに 1 回（＝30Hz 相当）にしていたので、
    // 画面の中ほどの人が歩き出した途端にカクついて見えた。近く（60m 以内）は毎フレーム、60〜120m は 2 フレームに 1 回、それ以遠は 3 フレームに 1 回。
    // 間引いたぶんは dt を積んで渡す（アニメの進みは同じ）
    frame++;
    skipped += dt;
    if (camDist > 120 && frame % 3 !== 0) return;
    if (camDist > 60 && frame % 2 !== 0) return;
    p.mixer.update(skipped); skipped = 0;
  }
  return { group: p.group, update, inner: p };
}

// ============================================================================
// 他のフィアカー（NPC。賑わい 2026-10-03）: 同じ寸法の馬車を軽量に組む（部品は材質ごとに結合 ≒ 15 draw call）
//   sim の car {x,z,yaw,vx,vz,look} の位置が「馬＋馬車の中央」。馬車の車体はローカル x=-1.5、馬は x=+2.5
// ============================================================================
const FIAKER_LOOKS = [
  { body: 0x17151a, wheel: 0xe6e6e4, seat: 0x8b2323, horses: ['white', 'brown'] },  // 定番: 黒車体・白車輪・葦毛+黒鹿毛
  { body: 0x5a1d1d, wheel: 0x141214, seat: 0x3a2a22, horses: ['brown', 'brown'] },  // 写真 P3: 深紅の車体・黒車輪・黒鹿毛 2 頭
  { body: 0x1f3a2e, wheel: 0xe6e6e4, seat: 0x8b2323, horses: ['white', 'white'] },  // 深緑・白馬 2 頭
  { body: 0x17151a, wheel: 0xc8102e, seat: 0x3a2a22, horses: ['brown', 'white'] },  // 黒・赤い車輪
];
function createNpcFiaker(look = 0) {
  const A = ACTOR_ASSETS, C = CARRIAGE, M = mats();
  const L = FIAKER_LOOKS[look % FIAKER_LOOKS.length];
  const g = new THREE.Group(); g.name = 'fiaker';
  const OX = -1.5; // 車体の中心（ローカル）
  const bx = (w, h, d, x, y, z) => { const b = new THREE.BoxGeometry(w, h, d); b.translate(x + OX, y, z); return b; };
  const shellH = C.sideTopY - C.floorY;
  // 車体（ラッカー、色違い）
  const bodyMat = M.lacquer.clone(); bodyMat.color.set(L.body);
  const body = mergeGeometries([
    bx(C.bodyL, shellH, C.bodyW, 0, C.floorY + shellH / 2, 0),
    bx(0.7, C.boxSeatY - C.floorY - 0.25, 1.3, C.boxX, (C.boxSeatY - 0.25 + C.floorY) / 2, 0),
    bx(0.04, 0.5, 1.3, C.boxX + 0.85, C.floorY + 0.95, 0),
    ...[[C.rearX, C.rearZ, C.rearR], [C.rearX, -C.rearZ, C.rearR], [C.frontX, C.frontZ, C.frontR], [C.frontX, -C.frontZ, C.frontR]].map(([x, z, R]) => bx(R * 1.6, 0.05, 0.26, x, R * 2 + 0.06, z)),
  ], false);
  g.add(mesh(body, bodyMat));
  // 座席（赤）+ 毛布 + 畳んだ幌（黒革）
  const seatMat = M.redLeather.clone(); seatMat.color.set(L.seat);
  g.add(mesh(mergeGeometries([bx(0.5, 0.2, C.bodyW - 0.3, 0.85, C.floorY + 0.5, 0), bx(0.14, 0.62, C.bodyW - 0.3, 1.15, C.floorY + 0.85, 0), bx(0.5, 0.2, C.bodyW - 0.3, -0.85, C.floorY + 0.5, 0), bx(0.14, 0.62, C.bodyW - 0.3, -1.15, C.floorY + 0.85, 0), bx(0.72, 0.22, 1.34, C.boxX, C.boxSeatY - 0.11, 0)], false), seatMat));
  g.add(mesh(bx(0.42, 0.26, C.bodyW - 0.1, -1.25, C.sideTopY + 0.05, 0), M.blackLeather));
  // 金の縁・ランプ（真鍮）
  const brassParts = [];
  for (const sz of [1, -1]) {
    brassParts.push(bx(C.bodyL + 0.01, 0.025, 0.02, 0, C.sideTopY - 0.06, sz * (C.bodyW / 2 + 0.005)));
    const lamp = new THREE.CylinderGeometry(0.07, 0.07, 0.3, 8); lamp.translate(C.boxX + 0.1 + OX, C.boxSeatY + 0.15, sz * (C.bodyW / 2 + 0.12)); brassParts.push(lamp);
  }
  g.add(mesh(mergeGeometries(brassParts, false), M.brass, 0, 0, 0, false));
  // 車軸・轅（鉄・木）
  const pole = new THREE.CylinderGeometry(0.035, 0.045, C.poleLen + 0.4, 6); pole.rotateZ(-Math.PI / 2); pole.translate(C.poleStartX - 0.2 + (C.poleLen + 0.4) / 2 + OX, 0.75, 0);
  g.add(mesh(mergeGeometries([bx(0.08, 0.08, C.rearZ * 2, C.rearX, C.rearR, 0), bx(0.08, 0.08, C.frontZ * 2, C.frontX, C.frontR, 0), bx(C.frontX - C.rearX, 0.07, 0.07, (C.frontX + C.rearX) / 2, 0.5, 0), pole], false), M.wood));
  // 車輪 4 つ（リム + 12 本スポーク + ハブを 1 つに結合）。色違い
  const wheelMat = M.wheel.clone(); wheelMat.color.set(L.wheel);
  const wheels = [];
  for (const [x, z, R] of [[C.rearX, C.rearZ, C.rearR], [C.rearX, -C.rearZ, C.rearR], [C.frontX, C.frontZ, C.frontR], [C.frontX, -C.frontZ, C.frontR]]) {
    const parts = [new THREE.TorusGeometry(R - 0.03, 0.035, 6, 24)];
    const hub = new THREE.CylinderGeometry(0.08, 0.08, 0.16, 8); hub.rotateX(Math.PI / 2); parts.push(hub);
    for (let i = 0; i < 12; i++) { const s = new THREE.BoxGeometry(0.03, R - 0.06, 0.03); const a = (i / 12) * Math.PI * 2; s.rotateZ(a - Math.PI / 2); s.translate(Math.cos(a) * (R / 2 - 0.02), Math.sin(a) * (R / 2 - 0.02), 0); parts.push(s); }
    const w = mesh(mergeGeometries(parts, false), wheelMat, x + OX, R, z); g.add(w); wheels.push({ g: w, R });
  }
  // 御者（座った人 + 山高帽。アニメは止めておく）
  let driver = null;
  if (A) {
    driver = createPedestrianInner(A, 1, { Shirt: 0xd9d9d6, Pants: 0x1a1a1c, Hair: 0x3a2a22, Details: 0x6f6f72, TieTexture: 0x6f6f72 });
    driver.group.position.set(C.boxX - 0.05 + OX, C.boxSeatY - 0.02, 0);
    driver.playOnly('Sitting');
    driver.group.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingSphere(); if (o.boundingSphere) o.boundingSphere.radius *= 1.5; o.frustumCulled = true; } });
    g.add(driver.group);
    const hat = mesh(mergeGeometries([new THREE.CylinderGeometry(0.1, 0.105, 0.12, 12).translate(0, 0.06, 0), new THREE.CylinderGeometry(0.165, 0.165, 0.015, 12)], false), M.hat, C.boxX - 0.05 + OX, C.boxSeatY + 1.08, 0);
    g.add(hat);
  }
  // 馬 2 頭
  const horses = [];
  if (A) {
    L.horses.forEach((col, i) => { const h = createHorse(A, col); h.group.position.set(2.5, 0, (i === 0 ? -1 : 1) * C.horseGap / 2); g.add(h.group); horses.push(h); });
  }
  let wheelAngle = 0, lastX = null, lastZ = null, lastTick = 0, grow = 1;
  return {
    group: g,
    update(c, dt = 0) {
      const tick = c._spawnTick || 0;
      if (lastX != null && (tick !== lastTick || Math.hypot(c.x - lastX, c.z - lastZ) > 20)) grow = 0;
      lastX = c.x; lastZ = c.z; lastTick = tick;
      if (grow < 1) { grow = Math.min(1, grow + dt * 2.5); const s = 0.05 + 0.95 * grow; g.scale.set(s, s, s); } else if (g.scale.x !== 1) g.scale.set(1, 1, 1);
      g.position.set(c.x, 0, c.z); g.rotation.y = -c.yaw;
      const speed = Math.hypot(c.vx || 0, c.vz || 0);
      wheelAngle += speed * dt / C.rearR;
      for (const w of wheels) w.g.rotation.z = -wheelAngle * (C.rearR / w.R);
      for (const h of horses) h.setGait(speed > 0.3 ? 2 : 0, speed, dt);
    },
  };
}

// ============================================================================
// 車・タクシー・トラム（簡略形）
// ============================================================================
export function createCar(kind = 'car', look = 0) {
  const M = mats();
  if (kind === 'fiaker') return createNpcFiaker(look);
  const g = new THREE.Group();
  if (kind === 'tram') {
    const L = 34, W = 2.4, H = 3.5;
    for (let i = 0; i < 5; i++) {
      const x = -L / 2 + (L / 5) * (i + 0.5);
      g.add(mesh(new THREE.BoxGeometry(L / 5 - 0.15, 1.3, W), M.carPaint.tram, x, 0.65 + 0.2, 0));
      g.add(mesh(new THREE.BoxGeometry(L / 5 - 0.15, 1.1, W - 0.05), M.carGlass, x, 1.85 + 0.2, 0));
      g.add(mesh(new THREE.BoxGeometry(L / 5 - 0.15, 0.6, W), M.tramWhite, x, 2.7 + 0.2, 0));
      g.add(mesh(new THREE.BoxGeometry(L / 5 - 0.15, 0.3, W - 0.3), M.tramRoof, x, 3.15 + 0.2, 0));
    }
    g.add(mesh(new THREE.BoxGeometry(L, 0.3, W - 0.6), M.iron, 0, 0.2, 0));
    return { group: g, update(c) { g.position.set(c.x, 0, c.z); g.rotation.y = -c.yaw; } };
  }
  const paint = M.carPaint[kind] || M.carPaint.car;
  g.add(mesh(new THREE.BoxGeometry(4.5, 0.55, 1.8), paint, 0, 0.62, 0));
  const hood = mesh(new THREE.BoxGeometry(1.3, 0.12, 1.7), paint, 1.4, 0.95, 0); g.add(hood);
  const cabin = mesh(new THREE.BoxGeometry(2.3, 0.55, 1.65), M.carGlass, -0.2, 1.17, 0); g.add(cabin);
  g.add(mesh(new THREE.BoxGeometry(2.1, 0.06, 1.5), paint, -0.2, 1.47, 0));
  g.add(mesh(new THREE.BoxGeometry(0.9, 0.12, 1.7), paint, -1.7, 0.95, 0));
  for (const [x, z] of [[1.4, 0.85], [1.4, -0.85], [-1.4, 0.85], [-1.4, -0.85]]) {
    const w = mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 16), M.tire, x, 0.33, z); w.rotation.x = Math.PI / 2; g.add(w);
  }
  const hz = [];
  for (const sz of [1, -1]) {
    g.add(mesh(new THREE.BoxGeometry(0.05, 0.15, 0.35), M.lampGlass, 2.25, 0.7, sz * 0.6, false));
    const h = mesh(new THREE.BoxGeometry(0.05, 0.12, 0.2), M.hazard.clone(), 2.25, 0.7, sz * 0.85, false); g.add(h); hz.push(h);
    const h2 = mesh(new THREE.BoxGeometry(0.05, 0.12, 0.3), M.hazard.clone(), -2.25, 0.7, sz * 0.7, false); g.add(h2); hz.push(h2);
  }
  if (kind === 'taxi') {
    g.add(mesh(new THREE.BoxGeometry(0.5, 0.12, 0.12), M.sign, -0.2, 1.56, 0));
    g.add(mesh(new THREE.BoxGeometry(0.36, 0.06, 0.125), M.signText, -0.2, 1.56, 0, false));
  }
  let t = 0, lastX = null, lastZ = null, lastTick = 0, grow = 1;
  return {
    group: g,
    update(c, dt = 0) {
      // 出し直し（sim が遠くから近くへ飛ばした）→ 伸び上がり
      const tick = c._spawnTick || 0;
      if (lastX != null && (tick !== lastTick || Math.hypot(c.x - lastX, c.z - lastZ) > 20)) grow = 0;
      lastX = c.x; lastZ = c.z; lastTick = tick;
      if (grow < 1) { grow = Math.min(1, grow + dt * 2.5); const s = 0.05 + 0.95 * grow; g.scale.set(s, s, s); } else if (g.scale.x !== 1) g.scale.set(1, 1, 1);
      g.position.set(c.x, 0, c.z); g.rotation.y = -c.yaw;
      t += dt;
      const on = c.hazard && Math.floor(t * 2.5) % 2 === 0;
      for (const h of hz) h.material.emissiveIntensity = on ? 2.0 : 0.0;
    },
  };
}
