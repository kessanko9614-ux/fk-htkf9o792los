// render/props3d.js — 壊れる小物（g.props）・鳩（g.pigeons）の描画
//
//   const props = createProps(scene, g.props, assets);   // assets は loadCityAssets() の戻り（table / plant の glb を使う）
//   props.update(g.props, g.pigeons, dt)                  // 毎フレーム。位置・高さ・回転を sim から読むだけ
//
// g.props: [{ id, kind:'chair'|'table'|'pot'|'bike'|'adColumn'|'stand', x, z, yaw, y, vx, vz, vy, spinX, spinY, spinZ, broken, resting }]
// g.pigeons: [{ id, x, z, y, state:'ground'|'fly' }]
// 種類ごとに InstancedMesh（1 種類 = 1〜4 draw call）。吹っ飛び中は spinX/spinZ で傾ける。影は castShadow。

import * as THREE from 'three';

const KINDS = ['chair', 'table', 'pot', 'bike', 'adColumn', 'stand', 'parasol', 'trash'];

function mat(color, extra = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra }); }

// 各種類の「部品」= [{ geometry, material, offset(Matrix4) }]。ローカル原点は足元の中心、+x 前
function buildParts(assets) {
  const wood = mat(0x5a3a1e, { roughness: 0.6 }), iron = mat(0x1e1f22, { roughness: 0.5, metalness: 0.6 }), marble = mat(0xf0ece2, { roughness: 0.4 });
  const terracotta = mat(0xb86b3a, { roughness: 0.85 }), green = mat(0x3d5a3a, { roughness: 0.9 }), bikeRed = mat(0xc62f36, { roughness: 0.4, metalness: 0.3 });
  const posterA = mat(0x8d9088, { roughness: 0.8 }), lid = mat(0x3c4a44, { roughness: 0.6 }), canvas = mat(0xefe6d0, { roughness: 0.9 }), paper = mat(0xe8e2d2, { roughness: 0.9 });
  const T = (x, y, z, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z);
  const parts = {};
  // 椅子（曲木風）
  parts.chair = [
    { geometry: new THREE.BoxGeometry(0.42, 0.04, 0.42), material: wood, offset: T(0, 0.45, 0) },
    { geometry: new THREE.BoxGeometry(0.04, 0.42, 0.4), material: wood, offset: T(-0.19, 0.68, 0) },
    { geometry: new THREE.BoxGeometry(0.04, 0.04, 0.4), material: wood, offset: T(-0.19, 0.86, 0) },
    ...[[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]].map(([x, z]) => ({ geometry: new THREE.BoxGeometry(0.035, 0.45, 0.035), material: wood, offset: T(x, 0.225, z) })),
  ];
  // テーブル（丸い大理石の天板 + 鋳鉄の脚）
  parts.table = [
    { geometry: new THREE.CylinderGeometry(0.33, 0.33, 0.03, 20), material: marble, offset: T(0, 0.72, 0) },
    { geometry: new THREE.CylinderGeometry(0.03, 0.03, 0.7, 8), material: iron, offset: T(0, 0.36, 0) },
    { geometry: new THREE.CylinderGeometry(0.22, 0.26, 0.03, 16), material: iron, offset: T(0, 0.015, 0) },
  ];
  // 植木鉢（テラコッタ + 丸い植え込み）
  parts.pot = [
    { geometry: new THREE.CylinderGeometry(0.32, 0.24, 0.5, 14), material: terracotta, offset: T(0, 0.25, 0) },
    { geometry: new THREE.SphereGeometry(0.4, 12, 9), material: green, offset: T(0, 0.75, 0) },
  ];
  // 自転車
  const wheel = new THREE.TorusGeometry(0.33, 0.025, 6, 18);
  parts.bike = [
    { geometry: wheel, material: iron, offset: T(0.5, 0.35, 0) },
    { geometry: wheel, material: iron, offset: T(-0.5, 0.35, 0) },
    { geometry: new THREE.BoxGeometry(0.9, 0.03, 0.03), material: bikeRed, offset: T(0, 0.6, 0) },
    { geometry: new THREE.BoxGeometry(0.03, 0.55, 0.03), material: bikeRed, offset: T(-0.15, 0.55, 0, 0, 0, 0.3) },
    { geometry: new THREE.BoxGeometry(0.03, 0.5, 0.03), material: bikeRed, offset: T(0.4, 0.6, 0, 0, 0, -0.35) },
    { geometry: new THREE.BoxGeometry(0.03, 0.03, 0.45), material: iron, offset: T(0.45, 0.95, 0) },
    { geometry: new THREE.BoxGeometry(0.25, 0.04, 0.12), material: iron, offset: T(-0.2, 0.9, 0) },
  ];
  // 広告塔（リトファスゾイレ）
  parts.adColumn = [
    { geometry: new THREE.CylinderGeometry(0.65, 0.65, 3.0, 20), material: posterA, offset: T(0, 1.5, 0) },
    { geometry: new THREE.CylinderGeometry(0.72, 0.72, 0.12, 20), material: lid, offset: T(0, 3.06, 0) },
    { geometry: new THREE.CylinderGeometry(0.25, 0.4, 0.3, 12), material: lid, offset: T(0, 3.25, 0) },
    // ポスター 3 枚（色違いの帯）
    ...[0, 2.1, 4.2].map((a, i) => ({ geometry: new THREE.PlaneGeometry(0.9, 1.6), material: mat([0xc62f36, 0x2e6b9b, 0xd9b24a][i], { roughness: 0.9 }), offset: new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeTranslation(0, 1.5, 0.655)) })),
  ];
  // 新聞スタンド（箱 + 幌 + 紙の束）
  parts.stand = [
    { geometry: new THREE.BoxGeometry(1.2, 1.0, 0.8), material: mat(0x2e3330), offset: T(0, 0.5, 0) },
    { geometry: new THREE.BoxGeometry(1.4, 0.05, 1.0), material: canvas, offset: T(0, 1.75, 0, 0.15, 0, 0) },
    ...[[-0.3, 0], [0.3, 0.05]].map(([x, dy]) => ({ geometry: new THREE.BoxGeometry(0.4, 0.12, 0.3), material: paper, offset: T(x, 1.06 + dy, 0.1) })),
    ...[[-0.6, -0.4], [0.6, -0.4], [-0.6, 0.4], [0.6, 0.4]].map(([x, z]) => ({ geometry: new THREE.BoxGeometry(0.04, 0.75, 0.04), material: iron, offset: T(x, 1.37, z) })),
  ];
  // 賑わい 2026-10-03: カフェのパラソル（木の支柱 + クリームの笠 Ø2.6）とウィーン市のオレンジのゴミ箱（MA48 色 #f07d1a）
  parts.parasol = [
    { geometry: new THREE.CylinderGeometry(0.025, 0.03, 2.3, 8), material: wood, offset: T(0, 1.15, 0) },
    { geometry: new THREE.ConeGeometry(1.3, 0.42, 10, 1, true), material: mat(0xefe6d0, { roughness: 0.9, side: THREE.DoubleSide }), offset: T(0, 2.22, 0) },
    { geometry: new THREE.SphereGeometry(0.05, 6, 5), material: wood, offset: T(0, 2.48, 0) },
    { geometry: new THREE.CylinderGeometry(0.2, 0.26, 0.04, 10), material: iron, offset: T(0, 0.02, 0) },
  ];
  parts.trash = [
    { geometry: new THREE.CylinderGeometry(0.2, 0.19, 0.86, 12), material: mat(0xf07d1a, { roughness: 0.6 }), offset: T(0, 0.45, 0) },
    { geometry: new THREE.CylinderGeometry(0.22, 0.22, 0.08, 12), material: mat(0x3c3c3a, { roughness: 0.6 }), offset: T(0, 0.92, 0) },
  ];
  // glb があれば table / pot をそれで置き換える（Quaternius の丸テーブルと鉢植え）
  // 2026-10-03: テーブルは手続きの方を使う（カフェの屋外席で 130 台になり、glb の 744 三角形 × 134 = 10 万三角形が低画質の上限 90 万を押していた）
  if (assets?.models?.plant) parts.pot = partsFromModel(assets.models.plant);
  return parts;
}

function partsFromModel(model) {
  model.pivot.updateMatrixWorld(true);
  const inv = model.pivot.matrixWorld.clone().invert();
  const out = [];
  model.scene.traverse((o) => { if (o.isMesh) out.push({ geometry: o.geometry, material: o.material, offset: inv.clone().multiply(o.matrixWorld) }); });
  return out;
}

export function createProps(scene, props, assets) {
  const group = new THREE.Group(); group.name = 'props'; scene.add(group);
  const parts = buildParts(assets);
  const byKind = {};
  for (const k of KINDS) byKind[k] = [];
  for (const p of props) if (byKind[p.kind]) byKind[p.kind].push(p);
  const meshes = []; // { kind, inst, offset, ids:[prop index list] }
  for (const k of KINDS) {
    const list = byKind[k]; if (!list.length) continue;
    for (const part of parts[k]) {
      const inst = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      inst.castShadow = true; inst.receiveShadow = true; inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(inst);
      meshes.push({ list, inst, offset: part.offset });
    }
  }
  // 鳩: 胴（楕円）+ 頭 + 翼 2 枚。翼は飛行中に羽ばたく（別インスタンスで回転）
  const pigeonBody = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 8, 6).scale(1.5, 0.8, 0.8), mat(0x6f6f78, { roughness: 0.9 }), 64);
  const pigeonHead = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 7, 5), mat(0x4a4f5e, { roughness: 0.9 }), 64);
  const wingGeo = new THREE.BoxGeometry(0.22, 0.01, 0.16);
  const pigeonWingL = new THREE.InstancedMesh(wingGeo, mat(0x7d7d86, { roughness: 0.9 }), 64);
  const pigeonWingR = new THREE.InstancedMesh(wingGeo, mat(0x7d7d86, { roughness: 0.9 }), 64);
  for (const m of [pigeonBody, pigeonHead, pigeonWingL, pigeonWingR]) { m.castShadow = true; m.frustumCulled = false; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); group.add(m); }

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _m2 = new THREE.Matrix4();
  let time = 0;

  function update(propsNow, pigeons, dt) {
    time += dt;
    for (const { list, inst, offset } of meshes) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        // 吹っ飛び中: spinX/spinZ で転がる（sim は角速度を持つので積算）
        if (p._rx == null) { p._rx = 0; p._rz = 0; }
        if (!p.resting || p.y > 0) { p._rx += (p.spinX || 0) * dt; p._rz += (p.spinZ || 0) * dt; }
        else if (p.broken) { p._rx = THREE.MathUtils.lerp(p._rx, Math.PI / 2 * Math.sign(p._rx || 1), 0.3); } // 壊れて倒れた
        _e.set(p._rx, -(p.yaw || 0), p._rz);
        _q.setFromEuler(_e); _p.set(p.x, p.y || 0, p.z);
        _m.compose(_p, _q, _s).multiply(offset);
        inst.setMatrixAt(i, _m);
      }
      inst.instanceMatrix.needsUpdate = true;
    }
    // 鳩
    const n = Math.min(64, pigeons?.length || 0);
    for (let i = 0; i < n; i++) {
      const b = pigeons[i];
      const flying = b.state === 'fly';
      const yaw = (b.id * 1.7) % (Math.PI * 2);
      const peck = flying ? 0 : Math.max(0, Math.sin(time * 6 + b.id)) * 0.25;   // 地面でついばむ（首を下げる）
      _e.set(peck, -yaw + (flying ? Math.sin(time * 2 + b.id) * 0.4 : 0), 0); _q.setFromEuler(_e);
      _p.set(b.x, (b.y || 0) + 0.1 + (flying ? Math.sin(time * 9 + b.id) * 0.05 : 0), b.z);
      _m.compose(_p, _q, _s);
      pigeonBody.setMatrixAt(i, _m);
      _m2.copy(_m).multiply(new THREE.Matrix4().makeTranslation(0.17, 0.06 - peck * 0.3, 0));
      pigeonHead.setMatrixAt(i, _m2);
      const flap = flying ? Math.sin(time * 22 + b.id * 2) * 0.9 : 0.1;
      _m2.copy(_m).multiply(new THREE.Matrix4().makeRotationX(flap)).multiply(new THREE.Matrix4().makeTranslation(0, 0.02, 0.14));
      pigeonWingL.setMatrixAt(i, _m2);
      _m2.copy(_m).multiply(new THREE.Matrix4().makeRotationX(-flap)).multiply(new THREE.Matrix4().makeTranslation(0, 0.02, -0.14));
      pigeonWingR.setMatrixAt(i, _m2);
    }
    for (const m of [pigeonBody, pigeonHead, pigeonWingL, pigeonWingR]) { m.count = n; m.instanceMatrix.needsUpdate = true; }
  }

  return { group, update, meshes };
}
