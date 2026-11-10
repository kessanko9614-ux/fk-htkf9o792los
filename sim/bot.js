// sim/bot.js — 自動運転 3種（careful / fast / wild）。経路の折れ線を追う pure pursuit。
// three.js にも DOM にも依存しない。Math.random は使わない（g の状態と g.elapsed だけで決まる）。

import { lookaheadPoint } from './route.js';
import { TUNE } from './tune.js';

function normalizeAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const PROFILES = {
  // careful: 速足(gait2)まで。角の手前で並足(gait1)へ落とす
  careful: { maxGait: 2, cornerGait: 1, lookahead: 9, cornerLook: 14, cornerAngleThresh: 0.30 },
  // fast: 直線は全力(gait4)。角は駆け足(gait3)まで落とす
  fast: { maxGait: 4, cornerGait: 3, lookahead: 13, cornerLook: 13, cornerAngleThresh: 0.40 },
  // wild: 常に全力。角でも落とさない（目的地の手前だけは停車のため落とす）
  wild: { maxGait: 4, cornerGait: 4, lookahead: 16, cornerLook: 10, cornerAngleThresh: 999 },
};

function estimateTurnAhead(points, x, z, dist) {
  if (!points || points.length < 2) return 0;
  let bestIdx = 0, bestD = Infinity, bestT = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x, az = points[i].z, bx = points[i + 1].x, bz = points[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestD) { bestD = d; bestIdx = i; bestT = t; }
  }
  // 現在位置から「今いるセグメントの終端(次の頂点)」までの残り距離を先に消費してから
  // 各頂点の曲がり角を見る。でないと、はるか先の角まで永遠に検出し続けてしまう。
  const firstSegLen = Math.hypot(points[bestIdx + 1].x - points[bestIdx].x, points[bestIdx + 1].z - points[bestIdx].z);
  let remaining = dist - firstSegLen * (1 - bestT);
  let maxTurn = 0;
  for (let i = bestIdx; i < points.length - 2; i++) {
    if (remaining <= 0) break; // 次の頂点は lookahead の外
    const dir1 = Math.atan2(points[i + 1].z - points[i].z, points[i + 1].x - points[i].x);
    const dir2 = Math.atan2(points[i + 2].z - points[i + 1].z, points[i + 2].x - points[i + 1].x);
    const turn = Math.abs(normalizeAngle(dir2 - dir1));
    if (turn > maxTurn) maxTurn = turn;
    const nextSegLen = Math.hypot(points[i + 2].x - points[i + 1].x, points[i + 2].z - points[i + 1].z);
    remaining -= nextSegLen;
  }
  return maxTurn;
}

// kind: 'careful' | 'fast' | 'wild'
export function botInput(g, kind) {
  const profile = PROFILES[kind] || PROFILES.careful;
  const points = g.ride && g.ride.route;
  const horse = g.player.horse;
  if (!points || points.length === 0) return { up: false, down: false, left: false, right: false, hand: false };

  const look = lookaheadPoint({ points }, horse.x, horse.z, profile.lookahead);
  const dest = points[points.length - 1];
  const destDist = Math.hypot(dest.x - horse.x, dest.z - horse.z);

  let targetGaitCap = profile.maxGait;
  // 2026-10-14 挙動担当: 最高速 17 m/s・手綱は踏み始めが柔らかい（3→9 m/s² を 0.7 秒で）ので、角・目的地を見る距離は
  // 「今の速さからそこまで落とすのに要る距離」以上にする（全力から駆け足 8.5 へは約 26m。固定 13m では角に全力で突っ込んでいた）
  const v0 = horse._speed;
  const brakeDist = (vTo) => { const dv = Math.max(0, v0 - vTo); return (v0 * v0 - vTo * vTo) / (2 * 6.5) + dv * 0.25; };
  const cornerLook = Math.max(profile.cornerLook, brakeDist(TUNE.gaits[profile.cornerGait]) + 4);
  const turnAhead = estimateTurnAhead(points, horse.x, horse.z, cornerLook);
  if (turnAhead > profile.cornerAngleThresh) targetGaitCap = Math.min(targetGaitCap, profile.cornerGait);
  if (destDist < brakeDist(TUNE.gaits[1]) + 10) targetGaitCap = Math.min(targetGaitCap, 1);

  // 目的地に近づいたら、bot の種類によらず止まれる速さまで落とす（到着できないのはバグ扱い）。
  // ただし完全に gait0(停止) にはしない — 停車枠に実際に乗り入れるまで並足で進み続けないと、
  // 枠のすぐ手前で速度0のまま永遠に止まってしまう（2026-10-02 に実際に踏んだ不具合）。
  let forceBrake = false;
  if (destDist < 20) {
    targetGaitCap = Math.min(targetGaitCap, 1);
    if (g.player.speed > 3.2) forceBrake = true;
  }
  if (destDist < 9) {
    targetGaitCap = Math.min(targetGaitCap, 1);
    if (g.player.speed > 2.1) forceBrake = true;
  }

  // 2026-10-14 挙動担当: アクセル式（上を押している間だけ加速・放すと緩やかに減速・下は押し続ける手綱）になったので、
  // 歩様の段ではなく代表速度 TUNE.gaits[cap] を目標に、上は目標の手前まで押す・下は目標を超えている間押し続ける
  const targetSpeed = TUNE.gaits[targetGaitCap];
  const v = horse._speed;
  const up = v < targetSpeed - 0.3 && !forceBrake;
  const down = forceBrake || v > targetSpeed + 0.8;

  let left = false, right = false;
  const steerTarget = look || dest;
  const desiredYaw = Math.atan2(steerTarget.z - horse.z, steerTarget.x - horse.x);
  const err = normalizeAngle(desiredYaw - horse.yaw);
  const deadzone = 0.04;
  if (err > deadzone) right = true;
  else if (err < -deadzone) left = true;

  return { up, down, left, right, hand: false };
}
