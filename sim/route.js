// sim/route.js — 道路グラフ上の経路探索(A*) → 誘導用の折れ線。
// RIDE_PAIRS の座標は map/vienna.js の ROADS の頂点と一致するので、
// 出発/目的地はそのままグラフのノードとして扱える。

import { nodeKey } from './world.js';

function heuristic(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// A*: world.nodes (Map key->{x,z}) / world.adjacency (Map key->[{to,length}]) を使う
export function findRoute(world, fromXZ, toXZ) {
  const startKey = nodeKey(fromXZ.x, fromXZ.z);
  const goalKey = nodeKey(toXZ.x, toXZ.z);
  if (!world.nodes.has(startKey) || !world.nodes.has(goalKey)) {
    return null; // マップ外・道路グラフに無い点
  }
  if (startKey === goalKey) {
    return { points: [{ x: fromXZ.x, z: fromXZ.z }], length: 0 };
  }

  const goalNode = world.nodes.get(goalKey);
  const open = new Set([startKey]);
  const cameFrom = new Map();
  const gScore = new Map([[startKey, 0]]);
  const fScore = new Map([[startKey, heuristic(world.nodes.get(startKey), goalNode)]]);

  function lowestF() {
    let best = null, bestF = Infinity;
    for (const k of open) {
      const f = fScore.has(k) ? fScore.get(k) : Infinity;
      if (f < bestF) { bestF = f; best = k; }
    }
    return best;
  }

  let guard = 0;
  while (open.size > 0 && guard++ < 20000) {
    const current = lowestF();
    if (current === goalKey) {
      // 復元
      const path = [current];
      let c = current;
      while (cameFrom.has(c)) { c = cameFrom.get(c); path.push(c); }
      path.reverse();
      const points = path.map((k) => {
        const n = world.nodes.get(k);
        return { x: n.x, z: n.z };
      });
      let length = 0;
      for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      return { points, length };
    }
    open.delete(current);
    const edges = world.adjacency.get(current) || [];
    for (const e of edges) {
      const tentative = gScore.get(current) + e.length;
      if (tentative < (gScore.has(e.to) ? gScore.get(e.to) : Infinity)) {
        cameFrom.set(e.to, current);
        gScore.set(e.to, tentative);
        fScore.set(e.to, tentative + heuristic(world.nodes.get(e.to), goalNode));
        open.add(e.to);
      }
    }
  }
  return null; // 到達不能
}

// 経路の折れ線上で、ある位置(x,z)から前方 lookahead m 先の点を返す（bot のpure pursuit / HUDのコンパス用）
export function lookaheadPoint(route, x, z, lookahead) {
  if (!route || route.points.length === 0) return null;
  const pts = route.points;
  // 最も近いセグメントを探す
  let bestIdx = 0, bestDist = Infinity, bestT = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z, bx = pts[i + 1].x, bz = pts[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestDist) { bestDist = d; bestIdx = i; bestT = t; }
  }
  // bestIdx地点からlookahead分だけ経路を前進する
  let remaining = lookahead;
  let idx = bestIdx;
  let cx = pts[idx].x + (pts[idx + 1].x - pts[idx].x) * bestT;
  let cz = pts[idx].z + (pts[idx + 1].z - pts[idx].z) * bestT;
  while (remaining > 0 && idx < pts.length - 1) {
    const segLen = Math.hypot(pts[idx + 1].x - cx, pts[idx + 1].z - cz);
    if (segLen >= remaining) {
      const t2 = remaining / segLen;
      return { x: cx + (pts[idx + 1].x - cx) * t2, z: cz + (pts[idx + 1].z - cz) * t2, idx, atEnd: false };
    }
    remaining -= segLen;
    idx += 1;
    cx = pts[idx].x; cz = pts[idx].z;
  }
  return { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z, idx: pts.length - 1, atEnd: true };
}

export function distanceAlongRoute(route, x, z) {
  // 経路始点からの進行距離（経路を外れたかの判定などに使う）
  if (!route) return 0;
  const pts = route.points;
  let bestIdx = 0, bestDist = Infinity, bestT = 0, acc = 0, best = 0;
  let cum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z, bx = pts[i + 1].x, bz = pts[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const len2 = len * len;
    let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestDist) { bestDist = d; best = cum + len * t; }
    cum += len;
  }
  return best;
}

export function perpendicularOffset(route, x, z) {
  if (!route) return 0;
  const pts = route.points;
  let bestDist = Infinity, bestSigned = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z, bx = pts[i + 1].x, bz = pts[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-9;
    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;
    let t = ((x - ax) * ux + (z - az) * uz);
    t = Math.max(0, Math.min(len, t));
    const px = ax + ux * t, pz = az + uz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestDist) { bestDist = d; bestSigned = (x - px) * nx + (z - pz) * nz; }
  }
  return bestSigned;
}
