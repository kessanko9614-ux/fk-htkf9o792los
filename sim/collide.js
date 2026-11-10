// sim/collide.js — OBB/円の衝突(SAT)・撃力・吹っ飛び(擬似高さ y)。
// 前作 proto/sim.js の考え方(OBB の SAT・位置補正つき撃力・吹っ飛びの重力積分)を
// 3D(XZ平面, +y=上)向けに書き直したもの。three.js にも DOM にも依存しない。

import { TUNE } from './tune.js';

// box: { cx, cz, yaw, hl, hw } (hl=進行方向半長, hw=横半幅)
export function obbAxes(box) {
  const f = { x: Math.cos(box.yaw), z: Math.sin(box.yaw) };
  const l = { x: -f.z, z: f.x };
  return { f, l };
}

export function obbCorners(box) {
  const { f, l } = obbAxes(box);
  const { cx, cz, hl, hw } = box;
  return [
    { x: cx + f.x * hl + l.x * hw, z: cz + f.z * hl + l.z * hw },
    { x: cx + f.x * hl - l.x * hw, z: cz + f.z * hl - l.z * hw },
    { x: cx - f.x * hl + l.x * hw, z: cz - f.z * hl + l.z * hw },
    { x: cx - f.x * hl - l.x * hw, z: cz - f.z * hl - l.z * hw },
  ];
}

function projExtent(pts, axis) {
  let min = Infinity, max = -Infinity;
  for (const p of pts) {
    const d = p.x * axis.x + p.z * axis.z;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

// 2つの OBB の SAT。重なっていれば {normal:{x,z}(A→Bの向き), depth} を返す
export function satOBB(boxA, boxB) {
  const ax = obbAxes(boxA), bx = obbAxes(boxB);
  const axes = [ax.f, ax.l, bx.f, bx.l];
  const cA = obbCorners(boxA), cB = obbCorners(boxB);
  let minOverlap = Infinity, minAxis = null;
  for (const axis of axes) {
    const [aMin, aMax] = projExtent(cA, axis);
    const [bMin, bMax] = projExtent(cB, axis);
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) { minOverlap = overlap; minAxis = axis; }
  }
  const dx = boxB.cx - boxA.cx, dz = boxB.cz - boxA.cz;
  let normal = { x: minAxis.x, z: minAxis.z };
  if (dx * normal.x + dz * normal.z < 0) normal = { x: -normal.x, z: -normal.z };
  return { normal, depth: minOverlap, cA, cB };
}

export function contactPointFromB(cB, normal) {
  let best = cB[0], bestProj = Infinity;
  for (const p of cB) {
    const proj = p.x * normal.x + p.z * normal.z;
    if (proj < bestProj) { bestProj = proj; best = p; }
  }
  return best;
}

function inertiaOf(mass, hl, hw) {
  return mass * ((2 * hl) * (2 * hl) + (2 * hw) * (2 * hw)) / 12;
}

// 剛体衝突解決（A は常に動く。B は isStaticB なら無限質量）。
// A/B は { cx, cz, yaw, hl, hw, mass, vx, vz, yawRate } を持つ。
// 戻り値: 衝突の相対速度の大きさ（イベント・弁償計算用）
export function resolveOBBImpact(A, B, normal, depth, contact, isStaticB, restitution) {
  const rest = restitution != null ? restitution : TUNE.collide.restitution;
  const invMassA = 1 / A.mass;
  const invMassB = isStaticB ? 0 : 1 / B.mass;
  const invIA = 1 / inertiaOf(A.mass, A.hl, A.hw);
  const invIB = isStaticB ? 0 : 1 / inertiaOf(B.mass, B.hl, B.hw);

  const rAx = contact.x - A.cx, rAz = contact.z - A.cz;
  const rBx = isStaticB ? 0 : contact.x - B.cx, rBz = isStaticB ? 0 : contact.z - B.cz;

  const vAx = A.vx - (A.yawRate || 0) * rAz, vAz = A.vz + (A.yawRate || 0) * rAx;
  const vBx = isStaticB ? 0 : B.vx - (B.yawRate || 0) * rBz, vBz = isStaticB ? 0 : B.vz + (B.yawRate || 0) * rBx;

  const rvx = vBx - vAx, rvz = vBz - vAz;
  const velAlongNormal = rvx * normal.x + rvz * normal.z;
  const impactSpeed = Math.abs(velAlongNormal);

  if (velAlongNormal <= 0) {
    const raCrossN = rAx * normal.z - rAz * normal.x;
    const rbCrossN = rBx * normal.z - rBz * normal.x;
    const denom = invMassA + invMassB + raCrossN * raCrossN * invIA + rbCrossN * rbCrossN * invIB;
    const j = denom > 1e-9 ? -(1 + rest) * velAlongNormal / denom : 0;

    const ix = normal.x * j, iz = normal.z * j;
    A.vx -= ix * invMassA; A.vz -= iz * invMassA;
    A.yawRate = (A.yawRate || 0) - raCrossN * j * invIA;
    if (!isStaticB) {
      B.vx += ix * invMassB; B.vz += iz * invMassB;
      B.yawRate = (B.yawRate || 0) + rbCrossN * j * invIB;
    }
  }

  // 位置補正（めり込み解消）
  const corrDenom = invMassA + invMassB;
  if (corrDenom > 0) {
    const corr = (depth * 0.8) / corrDenom;
    A.cx -= normal.x * corr * invMassA;
    A.cz -= normal.z * corr * invMassA;
    if (!isStaticB) {
      B.cx += normal.x * corr * invMassB;
      B.cz += normal.z * corr * invMassB;
    }
  }
  return impactSpeed;
}

// 円(circle: cx,cz,r) と OBB(box) — box は無限質量として扱い、円だけが押し出される。
// 戻り値: null か {normal(box→circleの向き), depth, contact}
export function circleVsOBB(circle, box) {
  const { f, l } = obbAxes(box);
  const dx0 = circle.cx - box.cx, dz0 = circle.cz - box.cz;
  const localF = dx0 * f.x + dz0 * f.z;
  const localL = dx0 * l.x + dz0 * l.z;
  const cf = Math.max(-box.hl, Math.min(box.hl, localF));
  const cl = Math.max(-box.hw, Math.min(box.hw, localL));
  const diffF = localF - cf, diffL = localL - cl;
  const distSq = diffF * diffF + diffL * diffL;
  if (distSq >= circle.r * circle.r) return null;
  const dist = Math.sqrt(distSq);
  let nF, nL;
  if (dist > 1e-6) { nF = diffF / dist; nL = diffL / dist; } else { nF = 0; nL = localL >= 0 ? 1 : -1; }
  const normal = { x: nF * f.x + nL * l.x, z: nF * f.z + nL * l.z };
  const depth = circle.r - dist;
  const contact = { x: box.cx + f.x * cf + l.x * cl, z: box.cz + f.z * cf + l.z * cl };
  return { normal, depth, contact };
}

// 円と円
export function circleVsCircle(a, b) {
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  const rsum = a.r + b.r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rsum * rsum) return null;
  const d = Math.sqrt(d2);
  const normal = d > 1e-6 ? { x: dx / d, z: dz / d } : { x: 1, z: 0 };
  return { normal, depth: rsum - d };
}

// 動く物体(円)が静的/動的な相手から押し出し力を受け、閾値を超えたら吹っ飛ぶ。
// obj: {vx,vz,vy,y,spinX,spinY,spinZ,launched}
export function launchIfFast(obj, impactSpeed, rng) {
  if (impactSpeed <= TUNE.launch.speedThresh) return false;
  const vy = Math.min(impactSpeed * TUNE.launch.vyMult, TUNE.launch.vyCap);
  obj.vy = vy;
  obj.spinX = (rng.next() * 2 - 1) * 6;
  obj.spinY = (rng.next() * 2 - 1) * 6;
  obj.spinZ = (rng.next() * 2 - 1) * 6;
  return true;
}

// 擬似高さ(y)の積分。地面(y<=0)で跳ね返り、十分遅くなれば静止する。戻り値: 着地したか
export function integrateAirborne(obj, dt) {
  if (obj.y <= 0 && obj.vy === 0) { obj.resting = true; return false; }
  obj.resting = false;
  obj.y += obj.vy * dt;
  obj.vy -= TUNE.launch.gravity * dt;
  if (obj.y <= 0 && obj.vy < 0) {
    const impactVy = obj.vy;
    obj.y = 0;
    obj.vy = -impactVy * TUNE.launch.bounce;
    obj.vx *= 0.6; obj.vz *= 0.6;
    if (Math.abs(obj.vy) < 0.4) { obj.vy = 0; obj.resting = true; }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// 簡易な空間グリッド（ブロードフェーズ）。props/peds の O(n^2) を避ける。
// ---------------------------------------------------------------------
export function buildGrid(items, cellSize, getXZ) {
  const map = new Map();
  for (let i = 0; i < items.length; i++) {
    const [x, z] = getXZ(items[i]);
    const key = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  }
  return { map, cellSize };
}

export function queryGrid(grid, x, z, radius, out) {
  out.length = 0;
  const cs = grid.cellSize;
  const x0 = Math.floor((x - radius) / cs), x1 = Math.floor((x + radius) / cs);
  const z0 = Math.floor((z - radius) / cs), z1 = Math.floor((z + radius) / cs);
  for (let gx = x0; gx <= x1; gx++) {
    for (let gz = z0; gz <= z1; gz++) {
      const bucket = grid.map.get(`${gx}:${gz}`);
      if (bucket) for (const idx of bucket) out.push(idx);
    }
  }
  return out;
}
