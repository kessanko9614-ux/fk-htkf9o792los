// render/fx.js — 破片・ほこりの粒子 / ヒットストップ・スロー（時間倍率）/ 画面の揺れ
//
//   const fx = createFX(scene);
//   fx.onEvent(ev)                 // g.events の各要素を渡す（crash / launch / land / pigeons / arrive …）
//   fx.burstDebris(x, y, z, { n, color, power })   fx.puffDust(x, z, { n })
//   fx.hitStop(0.08); fx.slowMo(0.35, 0.6); fx.shake(0.8)
//   const { timeScale, shake } = fx.update(dtReal)  // main は sim の dt に timeScale を掛ける。shake は camera.update に渡す
//
// ヒットストップ中 timeScale = 0、スロー中は指定倍率。main がこれを尊重する（fx は sim を触らない）。

import * as THREE from 'three';

const MAX_DUST = 900;
const MAX_DEBRIS = 160;

export function createFX(scene) {
  const group = new THREE.Group(); group.name = 'fx'; scene.add(group);

  // ---- ほこり（Points、CPU 更新）
  const dustGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(MAX_DUST * 3), dSize = new Float32Array(MAX_DUST), dAlpha = new Float32Array(MAX_DUST);
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
  dustGeo.setAttribute('aSize', new THREE.BufferAttribute(dSize, 1));
  dustGeo.setAttribute('aAlpha', new THREE.BufferAttribute(dAlpha, 1));
  const dustMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    uniforms: { uColor: { value: new THREE.Color(0xcfc3ae) }, uScale: { value: 400 } },
    vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
      void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; varying float vA;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); float a = smoothstep(0.5, 0.15, r) * vA; if (a < 0.01) discard; gl_FragColor = vec4(uColor, a * 0.32);
      #include <tonemapping_fragment>
      #include <colorspace_fragment> }`,
  });
  const dust = new THREE.Points(dustGeo, dustMat); dust.frustumCulled = false; dust.renderOrder = 20; group.add(dust);
  const dustP = []; // { x,y,z, vx,vy,vz, life, age, size }
  for (let i = 0; i < MAX_DUST; i++) dustP.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, life: 0, age: 1, size: 0 });
  let dustHead = 0;

  // ---- 破片（InstancedMesh の小箱、重力で落ちて転がる）
  const debGeo = new THREE.BoxGeometry(1, 1, 1);
  const debMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, vertexColors: false });
  const debris = new THREE.InstancedMesh(debGeo, debMat, MAX_DEBRIS);
  debris.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
  debris.castShadow = true; debris.frustumCulled = false; debris.count = 0;
  group.add(debris);
  const debP = [];
  for (let i = 0; i < MAX_DEBRIS; i++) debP.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, sx: 0.1, sy: 0.1, sz: 0.1, age: 0, life: 0 });
  let debHead = 0;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

  // ---- 時間・揺れ
  const T = { hitStop: 0, slow: 0, slowScale: 1, shake: 0, shakeT: 0, kick: 0, dirX: 0, dirZ: 0 };   // kick: 衝突の FOV の一瞬の広がり（0..1）。dir: 衝突の向き（揺れをその向きに寄せる）

  function puffDust(x, z, { n = 14, y = 0.1, spread = 0.8, up = 1.2, size = 1.0, color = null } = {}) {
    if (color) dustMat.uniforms.uColor.value.set(color);
    for (let i = 0; i < n; i++) {
      const p = dustP[dustHead]; dustHead = (dustHead + 1) % MAX_DUST;
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      p.x = x + Math.cos(a) * r; p.z = z + Math.sin(a) * r; p.y = y + Math.random() * 0.3;
      p.vx = Math.cos(a) * (0.5 + Math.random() * 1.5); p.vz = Math.sin(a) * (0.5 + Math.random() * 1.5); p.vy = up * (0.4 + Math.random() * 0.8);
      p.life = 0.8 + Math.random() * 0.9; p.age = 0; p.size = size * (0.5 + Math.random() * 0.8);
    }
  }

  function burstDebris(x, y, z, { n = 10, color = 0x8a5a3c, power = 5, size = 0.12, life = 2.5 } = {}) {
    _c.set(color);
    for (let i = 0; i < n; i++) {
      const d = debP[debHead]; debHead = (debHead + 1) % MAX_DEBRIS;
      d.on = true; d.x = x; d.y = y + 0.2; d.z = z;
      const a = Math.random() * Math.PI * 2, sp = power * (0.4 + Math.random() * 0.8);
      d.vx = Math.cos(a) * sp; d.vz = Math.sin(a) * sp; d.vy = power * (0.6 + Math.random() * 0.9);
      d.rx = Math.random() * 6; d.ry = Math.random() * 6; d.rz = Math.random() * 6;
      d.wx = (Math.random() - 0.5) * 20; d.wy = (Math.random() - 0.5) * 20; d.wz = (Math.random() - 0.5) * 20;
      d.sx = size * (0.5 + Math.random()); d.sy = size * (0.3 + Math.random() * 0.6); d.sz = size * (0.5 + Math.random() * 1.5);
      d.age = 0; d.life = life * (0.7 + Math.random() * 0.6);
      const idx = debP.indexOf(d);
      debris.instanceColor.setXYZ(idx, _c.r * (0.8 + Math.random() * 0.4), _c.g * (0.8 + Math.random() * 0.4), _c.b * (0.8 + Math.random() * 0.4));
    }
    debris.instanceColor.needsUpdate = true;
    puffDust(x, z, { n: 10, y, spread: 0.6 });
  }

  function hitStop(sec = 0.08) { T.hitStop = Math.max(T.hitStop, sec); }
  function slowMo(scale = 0.4, sec = 0.5) { T.slow = Math.max(T.slow, sec); T.slowScale = Math.min(T.slowScale === 1 ? scale : T.slowScale, scale); }
  function shake(amount = 1) { T.shake = Math.min(2.5, T.shake + amount); }

  const KIND_COLOR = { prop: 0x8a5a3c, building: 0xd6cfbd, car: 0x1b2230, tram: 0xcc0605, bollard: 0x9a9a98, ped: 0x3b4a6b, plant: 0x3d5a3a, table: 0x5a3a1e, chair: 0x5a3a1e, pot: 0xb86b3a };
  function onEvent(ev) {
    switch (ev.type) {
      case 'crash': {
        const v = ev.v || 3;
        const big = v > 6;
        hitStop(big ? 0.1 : 0.05); shake(Math.min(2, v / 5));
        if (big) slowMo(0.45, 0.35);
        // 2026-11-10 動くもの担当: 一瞬 FOV が広がる「ガツン」（最大 +5°、0.3 秒で戻る）。破片は少し多く・速さで散り方が変わる
        T.kick = Math.min(1, v / 9); T.dirX = ev.dirX || 0; T.dirZ = ev.dirZ || 0;
        burstDebris(ev.x, 0.5, ev.z, { n: Math.round(6 + v * 1.5), color: KIND_COLOR[ev.with] ?? 0x8a5a3c, power: 2.5 + v * 0.7, size: big ? 0.15 : 0.11 });
        puffDust(ev.x, ev.z, { n: 20 + v * 2, spread: 1.2, up: 1.5, size: 1.4 });
        break;
      }
      case 'launch': burstDebris(ev.x, 0.3, ev.z, { n: 6, color: KIND_COLOR[ev.kind] ?? 0x8a5a3c, power: 3 }); break;
      case 'land': puffDust(ev.x, ev.z, { n: 16, spread: 1.0, up: 1.0, size: 1.3 }); break;
      case 'pigeons': puffDust(ev.x, ev.z, { n: 10, spread: 1.5, up: 2.5, size: 0.8, color: 0xdcdcdc }); break;
      case 'arrive': hitStop(0.06); shake(0.5); puffDust(ev.x ?? 0, ev.z ?? 0, { n: 24, spread: 2.0, up: 0.8, size: 1.5 }); break;
      case 'hatLost': burstDebris(ev.x, 2.2, ev.z, { n: 1, color: 0x111112, power: 2.5, size: 0.3, life: 4 }); break;
    }
  }

  // 走行中の蹄のほこり（main/showcase が毎フレーム呼ぶ）
  let hoofAcc = 0;
  function hoofDust(x, z, speed, dt) {
    hoofAcc += speed * dt;
    if (speed > 4 && hoofAcc > 1.6) { hoofAcc = 0; puffDust(x, z, { n: 2 + (speed > 9 ? 2 : 0), spread: 0.7, up: 0.35, size: 0.4 }); }
  }

  const shakeOut = { x: 0, y: 0, z: 0, roll: 0, fov: 0 };
  function update(dtReal) {
    // 時間倍率
    let timeScale = 1;
    if (T.hitStop > 0) { T.hitStop -= dtReal; timeScale = 0; }
    else if (T.slow > 0) { T.slow -= dtReal; timeScale = T.slowScale; if (T.slow <= 0) T.slowScale = 1; }
    const dt = dtReal * (timeScale === 0 ? 0.05 : timeScale);   // 粒子はヒットストップ中もわずかに動く
    // 揺れ
    T.shakeT += dtReal;
    if (T.shake > 0) {
      const a = T.shake * 0.08;
      shakeOut.x = Math.sin(T.shakeT * 57) * a; shakeOut.y = Math.sin(T.shakeT * 43 + 1) * a * 0.7; shakeOut.z = Math.sin(T.shakeT * 61 + 2) * a * 0.5;
      shakeOut.roll = Math.sin(T.shakeT * 37) * a * 0.12;
      T.shake = Math.max(0, T.shake - dtReal * 3.2);
    } else { shakeOut.x = shakeOut.y = shakeOut.z = shakeOut.roll = 0; }
    // FOV の一瞬の広がり: 立ち上がりは即、戻りは 0.3 秒の指数
    shakeOut.fov = T.kick * 5;
    T.kick = Math.max(0, T.kick - dtReal / 0.3 * Math.max(0.35, T.kick));
    // ほこり
    for (let i = 0; i < MAX_DUST; i++) {
      const p = dustP[i];
      if (p.age >= p.life) { dAlpha[i] = 0; dPos[i * 3 + 1] = -10; continue; }
      p.age += dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vy -= 0.6 * dt; p.vx *= (1 - 1.5 * dt); p.vz *= (1 - 1.5 * dt);
      const t = p.age / p.life;
      dPos[i * 3] = p.x; dPos[i * 3 + 1] = p.y; dPos[i * 3 + 2] = p.z;
      dSize[i] = p.size * (0.6 + t * 1.6); dAlpha[i] = (1 - t) * (t < 0.1 ? t / 0.1 : 1);
    }
    dustGeo.attributes.position.needsUpdate = true; dustGeo.attributes.aSize.needsUpdate = true; dustGeo.attributes.aAlpha.needsUpdate = true;
    // 破片
    let count = 0;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const d = debP[i];
      if (d.on) { d.age += dt; if (d.age > d.life) d.on = false; }
      if (!d.on) { _m.makeScale(0, 0, 0); debris.setMatrixAt(i, _m); continue; }
      d.vy -= 9.8 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      if (d.y < d.sy / 2) { d.y = d.sy / 2; d.vy = -d.vy * 0.35; d.vx *= 0.7; d.vz *= 0.7; d.wx *= 0.6; d.wy *= 0.6; d.wz *= 0.6; }
      d.rx += d.wx * dt; d.ry += d.wy * dt; d.rz += d.wz * dt;
      const fade = d.age > d.life - 0.5 ? (d.life - d.age) / 0.5 : 1;
      _e.set(d.rx, d.ry, d.rz); _q.setFromEuler(_e); _p.set(d.x, d.y, d.z); _s.set(d.sx * fade, d.sy * fade, d.sz * fade);
      _m.compose(_p, _q, _s);
      debris.setMatrixAt(i, _m);
      count = i + 1;
    }
    debris.count = MAX_DEBRIS;
    debris.instanceMatrix.needsUpdate = true;
    return { timeScale, shake: shakeOut };
  }

  return { group, onEvent, puffDust, burstDebris, hoofDust, hitStop, slowMo, shake, update, get timeScale() { return T.hitStop > 0 ? 0 : T.slow > 0 ? T.slowScale : 1; } };
}
