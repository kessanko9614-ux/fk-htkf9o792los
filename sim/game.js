// sim/game.js — createGame(seed) / step(g, input, dt) / 採点 / イベント。
// three.js にも DOM にも依存しない。固定ステップ(TUNE.FIXED_DT)・シード付き乱数・決定論。

import { TUNE } from './tune.js';
import { createRng, fnv1a } from './rng.js';
import { buildWorld, nearestSegment, crossSection } from './world.js';
import { findRoute } from './route.js';
import { createCarriageRig, stepCarriageRig, teamBox, carriageBox } from './carriage.js';
import {
  createPedestrians, stepPedestrians, updatePedCarriageAvoidance, pedKnockback, stepFlyingPed,
  createCars, stepCars, createTrams, stepTrams, createPigeonFlocks, stepPigeons,
} from './actors.js';
import { satOBB, circleVsOBB, resolveOBBImpact, integrateAirborne, contactPointFromB, queryGrid } from './collide.js';

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function r3(n) { return Math.round(n * 1000) / 1000; }

function asBox(o) {
  if (o.type === 'box') return { cx: o.cx, cz: o.cz, yaw: o.yaw, hl: o.hl, hw: o.hw };
  return { cx: o.cx, cz: o.cz, yaw: 0, hl: o.r, hw: o.r };
}

function inStopRect(rect, x, z) {
  const dx = x - rect.cx, dz = z - rect.cz;
  const c = Math.cos(rect.yaw), s = Math.sin(rect.yaw);
  const along = dx * c + dz * s, lat = -dx * s + dz * c;
  return Math.abs(along) <= rect.hl && Math.abs(lat) <= rect.hw;
}

function findStopRect(world, pt) {
  const key = `${pt.x},${pt.z}`;
  return world.stopRects.find((r) => r.key === key) || null;
}

function uniqueRidePoints(world) {
  const map = new Map();
  for (const pair of world.ridePairs) {
    for (const pt of [pair.from, pair.to]) {
      const k = `${pt.x},${pt.z}`;
      if (!map.has(k)) map.set(k, pt);
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------
// 採点（GAME_DESIGN §5 の式）。純粋関数でテストしやすくする。
// ---------------------------------------------------------------------
export function computeRideScore(routeLen, elapsedSec, safety, damage, isDriftArrival) {
  const refTime = routeLen / TUNE.parSpeed; // 主ループ 2026-10-02: 7→5 m/s（設計は「速足で真面目に走った時間」なのに 7 m/s で計算していた。速足は 4.5）
  let speedFactor = elapsedSec > 0.001 ? refTime / elapsedSec : 2.0;
  speedFactor = clamp(speedFactor, 0.4, 2.0);
  let arrivalPoints = 1000 * speedFactor;
  if (isDriftArrival) arrivalPoints *= TUNE.arrival.driftMultiplier;
  const safetyMult = 0.3 + 1.2 * (clamp(safety, 0, 100) / 100);
  const score = arrivalPoints * safetyMult - damage;
  return { speedFactor, safetyMult, arrivalPoints, score };
}

function moodFromSafety(safety) {
  if (safety >= 75) return 'happy';
  if (safety >= 50) return 'ok';
  if (safety >= 25) return 'scared';
  return 'panic';
}

// ---------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------
export function createGame(seed) {
  const rng = createRng(seed);
  const world = buildWorld(rng);
  const ridePoints = uniqueRidePoints(world);

  const firstPair = world.ridePairs[0];
  const dir0 = findRoute(world, firstPair.from, firstPair.to);
  const yaw0 = dir0 && dir0.points.length > 1
    ? Math.atan2(dir0.points[1].z - dir0.points[0].z, dir0.points[1].x - dir0.points[0].x)
    : 0;
  const rig = createCarriageRig(firstPair.from.x, firstPair.from.z, yaw0);

  const pedCount = TUNE.pedestrian.count[0] + rng.int(0, TUNE.pedestrian.count[1] - TUNE.pedestrian.count[0] + 1);
  const carCount = TUNE.cars.count[0] + rng.int(0, TUNE.cars.count[1] - TUNE.cars.count[0] + 1);

  const g = {
    time: TUNE.shift.time,
    started: false,
    over: false,
    overReason: null,
    seed,
    elapsed: 0,
    rng,
    world,
    player: { horse: rig.horse, carriage: rig.carriage, speed: 0, lateralG: 0, longG: 0 },
    ride: {
      from: firstPair.from, to: firstPair.to, startedAt: 0,
      route: dir0 ? dir0.points : [firstPair.from, firstPair.to],
      routeLen: dir0 ? dir0.length : Math.hypot(firstPair.to.x - firstPair.from.x, firstPair.to.z - firstPair.from.z),
      safety: 100, damage: 0, mood: 'happy', hatLost: false,
      _lastDriftAt: -999, _lastBigSlipAt: -999,
    },
    peds: createPedestrians(world, rng, pedCount, { x: firstPair.from.x, z: firstPair.from.z }),
    cars: createCars(world, rng, carCount, { x: firstPair.from.x, z: firstPair.from.z }),
    trams: createTrams(world),
    pigeonFlocks: createPigeonFlocks(world, rng),
    pigeons: [],
    props: world.propLayout.map((p) => ({
      id: p.id, kind: p.kind, x: p.x, z: p.z, yaw: p.yaw, y: 0,
      vx: 0, vz: 0, vy: 0, spinX: 0, spinY: 0, spinZ: 0, broken: false, resting: true,
    })),
    totals: { score: 0, rides: 0, damage: 0, best: null },
    events: [],
    _touching: {},
    _ridePoints: ridePoints,
    _pairFallbackPos: 1,
    _prevGait: 0,
  };
  g.pigeons = flattenPigeons(g);
  return g;
}

function flattenPigeons(g) {
  const out = [];
  for (const flock of g.pigeonFlocks) for (const b of flock.birds) out.push(b);
  return out;
}

// ---------------------------------------------------------------------
// 次のライドを選ぶ: 直前の到着地点から、別の地点へ道路グラフ上の経路を探す
// ---------------------------------------------------------------------
function pickNextRide(g, originPt) {
  const points = g._ridePoints;
  let dest = null, route = null;
  // 2026-10-02 主ループ: 経路長 RIDE_MIN〜RIDE_MAX の候補から選ぶ（以前は無制限で最長 1,178m、
  // 150秒のシフトで bot が1〜3件しか運べなかった）。範囲内が無ければ範囲に一番近いもの
  const RIDE_MIN = 220, RIDE_MAX = 520;
  const cands = [];
  for (const candidate of points) {
    if (Math.hypot(candidate.x - originPt.x, candidate.z - originPt.z) < 1) continue;
    const r = findRoute(g.world, originPt, candidate);
    if (r && r.length > 1) cands.push({ candidate, r });
  }
  const inRange = cands.filter(c => c.r.length >= RIDE_MIN && c.r.length <= RIDE_MAX);
  const pool = inRange.length ? inRange : cands.slice().sort((a, b) =>
    Math.abs(a.r.length - (RIDE_MIN + RIDE_MAX) / 2) - Math.abs(b.r.length - (RIDE_MIN + RIDE_MAX) / 2)).slice(0, 1);
  if (pool.length) { const pick = pool[g.rng.int(0, pool.length)]; dest = pick.candidate; route = pick.r; }
  if (!route) {
    const pair = g.world.ridePairs[g._pairFallbackPos % g.world.ridePairs.length];
    g._pairFallbackPos++;
    dest = pair.to.x === originPt.x && pair.to.z === originPt.z ? pair.from : pair.to;
    route = findRoute(g.world, originPt, dest) || {
      points: [originPt, dest],
      length: Math.hypot(dest.x - originPt.x, dest.z - originPt.z),
    };
  }
  g.ride = {
    from: { name: '(出発)', x: originPt.x, z: originPt.z }, to: dest, startedAt: g.elapsed,
    route: route.points, routeLen: route.length,
    safety: 100, damage: 0, mood: 'happy', hatLost: false,
    _lastDriftAt: -999, _lastBigSlipAt: -999,
  };
  g.events.push({ type: 'newRide', from: g.ride.from, to: g.ride.to, routeLen: g.ride.routeLen });
}

// ---------------------------------------------------------------------
// 安全度
// ---------------------------------------------------------------------
function applySafetyDelta(g, delta, reason) {
  if (delta === 0) return;
  // 主ループ追加: 原因別の合計（調整・検証用。描画は読まなくてよい）
  const by = g.ride.safetyBy || (g.ride.safetyBy = {});
  by[reason] = (by[reason] || 0) + Math.min(0, Math.max(delta, -g.ride.safety));
  g.ride.safety = clamp(g.ride.safety + delta, 0, 100);
  g.ride.mood = moodFromSafety(g.ride.safety);
  if (!g.ride.hatLost && g.ride.safety < 20) {
    g.ride.hatLost = true;
    g.events.push({ type: 'hatLost', x: g.player.carriage.x, z: g.player.carriage.z });
  }
}

function applyYenPenalty(g, amount, x, z, src) {
  if (amount <= 0) return;
  g.ride.damage += amount;
  g.events.push({ type: 'penalty', amount, x, z, src });
}

function applyContinuousSafety(g, driftActive, dt) {
  const S = TUNE.safety;
  const latExcess = Math.max(0, Math.abs(g.player.lateralG) - S.latGThresh);
  if (latExcess > 0) applySafetyDelta(g, -latExcess * S.latGCoef * dt, 'lateralG');
  const decelExcess = Math.max(0, -g.player.longG - S.decelThresh);
  if (decelExcess > 0) applySafetyDelta(g, -decelExcess * S.decelCoef * dt, 'brake');
  if (driftActive) applySafetyDelta(g, -S.driftCoef * dt, 'drift');
}

function checkCurb(g) {
  const c = g.player.carriage;
  const near = nearestSegment(g.world, c.x, c.z);
  if (!near || near.seg.kind === 'ped') { c.onSidewalk = false; return; }
  const cs = crossSection(near.seg);
  const onSidewalk = Math.abs(near.lateral) > cs.carLane + 0.1 && Math.abs(near.lateral) <= near.seg.width / 2 + 0.3;
  if (onSidewalk && !c.onSidewalk) {
    applySafetyDelta(g, -TUNE.safety.curbPenalty, 'curb');
    g.events.push({ type: 'safety', delta: -TUNE.safety.curbPenalty, reason: 'curb' });
  }
  c.onSidewalk = onSidewalk;
}

// ---------------------------------------------------------------------
// 衝突
// ---------------------------------------------------------------------
function resolveAllCollisions(g, dt) {
  const rng = g.rng;
  const bodies = [
    { name: 'horse', obj: g.player.horse, box: teamBox(g.player.horse) },
    { name: 'carriage', obj: g.player.carriage, box: carriageBox(g.player.carriage) },
  ];
  const newTouching = {};
  const prevTouching = g._touching || {};

  function firstTouch(key) {
    const isNew = !prevTouching[key];
    newTouching[key] = true;
    return isNew;
  }

  // --- 建物・ランドマーク・ボラード（静的）。
  // ランドマークは大きい物があり(中心は遠くても端が近い)グリッドでは取りこぼすので毎回全件、
  // 街区の建物・ボラード(小さいが数が多い)は空間グリッドで近くのものだけに絞る。
  function hitStaticBuilding(b, key) {
    const box = asBox(b);
    for (const body of bodies) {
      const res = satOBB(body.box, box);
      if (!res) continue;
      const contact = contactPointFromB(res.cB, res.normal);
      const rigid = { cx: body.obj.x, cz: body.obj.z, yaw: body.obj.yaw, hl: body.box.hl, hw: body.box.hw, mass: body.box.mass, vx: body.obj.vx, vz: body.obj.vz, yawRate: body.obj.yawRate || 0 };
      const impactSpeed = resolveOBBImpact(rigid, null, res.normal, res.depth, contact, true);
      body.obj.x = rigid.cx; body.obj.z = rigid.cz;
      body.obj.vx = rigid.vx; body.obj.vz = rigid.vz;
      if (body.name === 'carriage') body.obj.yawRate = rigid.yawRate;
      body.box.cx = body.obj.x; body.box.cz = body.obj.z;
      if (firstTouch(key) && impactSpeed > 0.3) {
        const safetyHit = TUNE.safety.collisionCoef * TUNE.safety.bigCollisionMult * impactSpeed;
        applySafetyDelta(g, -safetyHit, 'collision');
        // 主ループ 2026-10-14: 駐車中の車（リング通りの列）は「建物」でなく車として扱う（弁償・クラクション）
        if (b.kind === 'parkedCar') applyYenPenalty(g, impactSpeed * TUNE.damage.parkedCarPerSpeed, contact.x, contact.z, 'car');
        g.events.push({ type: 'crash', v: impactSpeed, x: contact.x, z: contact.z, with: b.kind === 'bollard' ? 'bollard' : b.kind === 'parkedCar' ? 'car' : 'building' });
      }
    }
  }

  g.world.landmarkColliders.forEach((b, bi) => hitStaticBuilding(b, `landmark:${bi}`));

  const nearBuildingIdx = [];
  const candidateSet = new Set();
  for (const body of bodies) {
    const reach = Math.hypot(body.box.hl, body.box.hw) + 30; // 30 > 街区建物の最大外接半径(約17.5m)
    queryGrid(g.world.smallBuildingsGrid, body.obj.x, body.obj.z, reach, nearBuildingIdx);
    for (const idx of nearBuildingIdx) candidateSet.add(idx);
  }
  candidateSet.forEach((bi) => {
    hitStaticBuilding(g.world.smallBuildings[bi], `small:${bi}`);
  });

  // --- 停車中/走行中の車（可動 OBB） ---
  g.cars.forEach((car) => {
    // 主ループ 2026-10-14: 衝突の計算では車を軽く扱い、馬車が押し勝って蹴散らす（以前は車 1300kg に馬車が大きく減速）
    const cbox = { cx: car.x, cz: car.z, yaw: car.yaw, hl: TUNE.cars.radiusLen, hw: TUNE.cars.radiusWid, mass: TUNE.cars.collideMass ?? TUNE.cars.mass, vx: car.vx, vz: car.vz, yawRate: 0 };
    for (const body of bodies) {
      const res = satOBB(body.box, cbox);
      if (!res) continue;
      const contact = contactPointFromB(res.cB, res.normal);
      const rigid = { cx: body.obj.x, cz: body.obj.z, yaw: body.obj.yaw, hl: body.box.hl, hw: body.box.hw, mass: body.box.mass, vx: body.obj.vx, vz: body.obj.vz, yawRate: body.obj.yawRate || 0 };
      const impactSpeed = resolveOBBImpact(rigid, cbox, res.normal, res.depth, contact, false);
      body.obj.x = rigid.cx; body.obj.z = rigid.cz;
      body.obj.vx = rigid.vx; body.obj.vz = rigid.vz;
      if (body.name === 'carriage') body.obj.yawRate = rigid.yawRate;
      body.box.cx = body.obj.x; body.box.cz = body.obj.z;
      car.x = cbox.cx; car.z = cbox.cz; car.vx = cbox.vx; car.vz = cbox.vz;
      const key = `car:${car.id}`;
      if (firstTouch(key) && impactSpeed > 0.3) {
        car._knockedT = 1.5;
        applyYenPenalty(g, impactSpeed * TUNE.damage.parkedCarPerSpeed, contact.x, contact.z, 'car');
        applySafetyDelta(g, -TUNE.safety.collisionCoef * impactSpeed, 'collision');
        g.events.push({ type: 'crash', v: impactSpeed, x: contact.x, z: contact.z, with: 'car' });
      }
    }
  });

  // --- トラム（静的・弾かれない） ---
  g.trams.forEach((tram) => {
    const tbox = { cx: tram.x, cz: tram.z, yaw: tram.yaw, hl: TUNE.trams.len / 2, hw: TUNE.trams.hw };
    for (const body of bodies) {
      const res = satOBB(body.box, tbox);
      if (!res) continue;
      const contact = contactPointFromB(res.cB, res.normal);
      const rigid = { cx: body.obj.x, cz: body.obj.z, yaw: body.obj.yaw, hl: body.box.hl, hw: body.box.hw, mass: body.box.mass, vx: body.obj.vx, vz: body.obj.vz, yawRate: body.obj.yawRate || 0 };
      const impactSpeed = resolveOBBImpact(rigid, null, res.normal, res.depth, contact, true);
      body.obj.x = rigid.cx; body.obj.z = rigid.cz;
      body.obj.vx = rigid.vx; body.obj.vz = rigid.vz;
      if (body.name === 'carriage') body.obj.yawRate = rigid.yawRate;
      body.box.cx = body.obj.x; body.box.cz = body.obj.z;
      const key = `tram:${tram.id}`;
      if (firstTouch(key) && impactSpeed > 0.3) {
        applyYenPenalty(g, impactSpeed * TUNE.damage.tramPerSpeed, contact.x, contact.z, 'tram');
        applySafetyDelta(g, -50, 'collision');
        g.events.push({ type: 'crash', v: impactSpeed, x: contact.x, z: contact.z, with: 'tram' });
      }
    }
  });

  // --- 小物(props) 円 vs 馬車OBB ---
  g.props.forEach((p) => {
    if (p.y > 0.6) return; // 飛んでいる間は当たらない
    const circle = { cx: p.x, cz: p.z, r: 0.35 };
    for (const body of bodies) {
      const res = circleVsOBB(circle, body.box);
      if (!res) continue;
      p.x += res.normal.x * res.depth; p.z += res.normal.z * res.depth;
      const relVx = body.obj.vx - p.vx, relVz = body.obj.vz - p.vz;
      const impactSpeed = relVx * res.normal.x + relVz * res.normal.z;
      if (impactSpeed <= 0) continue;
      const key = `prop:${p.id}`;
      if (firstTouch(key) && impactSpeed > TUNE.launch.speedThresh) {
        p.vx += res.normal.x * impactSpeed * 1.1;
        p.vz += res.normal.z * impactSpeed * 1.1;
        p.vy = Math.min(impactSpeed * TUNE.launch.vyMult, TUNE.launch.vyCap);
        p.spinX = (rng.next() * 2 - 1) * 6; p.spinY = (rng.next() * 2 - 1) * 6; p.spinZ = (rng.next() * 2 - 1) * 6;
        p.resting = false;
        const price = TUNE.props.price[p.kind] || 0;
        applyYenPenalty(g, price, p.x, p.z, p.kind);
        applySafetyDelta(g, -TUNE.safety.collisionCoef * impactSpeed, 'collision');
        g.events.push({ type: 'launch', id: p.id, kind: p.kind, x: p.x, z: p.z, vy: p.vy });
        g.events.push({ type: 'crash', v: impactSpeed, x: p.x, z: p.z, with: 'prop' });
      }
    }
  });

  // --- 歩行者 円 vs 馬車OBB（避けきれなかった場合） ---
  g.peds.forEach((ped) => {
    if (ped.state === 'fly' || ped.state === 'down') return;
    const circle = { cx: ped.x, cz: ped.z, r: TUNE.pedestrian.radius };
    for (const body of bodies) {
      const res = circleVsOBB(circle, body.box);
      if (!res) continue;
      const relVx = body.obj.vx - ped.vx, relVz = body.obj.vz - ped.vz;
      const impactSpeed = relVx * res.normal.x + relVz * res.normal.z;
      if (impactSpeed <= 0.2) continue;
      const key = `ped:${ped.id}`;
      // 主ループ 2026-10-05: ゆっくり当たった（3.5 m/s 未満）場合は「はねた」ではなく、人を押しのけただけにする。
      // 人を増やした後、速足の慎重運転でも1シフトで10人前後に当たって弁償と減点が積み、点が 1,122→41 に崩れていた
      if (impactSpeed < (TUNE.pedestrian.gentleSpeed ?? 3.5)) {
        const push = (res.depth ?? 0.2) + 0.08;
        ped.x += res.normal.x * push; ped.z += res.normal.z * push;
        if (firstTouch(key)) g.events.push({ type: 'pedNudge', id: ped.id, x: ped.x, z: ped.z });
        continue;
      }
      if (firstTouch(key)) {
        pedKnockback(ped, res.normal, Math.max(impactSpeed, 1), rng);
        applyYenPenalty(g, TUNE.damage.ped, ped.x, ped.z, 'ped');
        applySafetyDelta(g, -TUNE.safety.pedHitPenalty, 'pedHit');
        g.events.push({ type: 'pedHit', id: ped.id, x: ped.x, z: ped.z });
        g.events.push({ type: 'crash', v: impactSpeed, x: ped.x, z: ped.z, with: 'ped' });
      }
    }
  });

  g._touching = newTouching;
}

// ---------------------------------------------------------------------
// 到着
// ---------------------------------------------------------------------
function checkArrival(g) {
  if (g.over) return;
  const rect = findStopRect(g.world, g.ride.to);
  if (!rect) return;
  const c = g.player.carriage;
  // 主ループ 2026-10-05: 停車枠に車が止まって塞ぐと到着できなかった（bot が 0件、tests/_stuck_probe.html）。
  // 枠の中、または「車が枠に被っていて、枠の中心から 6m 以内」なら到着とする
  if (!inStopRect(rect, c.x, c.z)) {
    // 停車枠のまわりが渋滞して近づけないとき（馬車の 12m 以内に車がいる）、枠の中心から 18m 以内なら到着（客は手前で降りる）。
    // 車は前方 12m に何かいると止まるため、馬車が近づくと車が止まり、その車に馬車が阻まれる詰まりが起きていた（tests/_stuck2_probe.html）
    const blocked = g.cars.some((car) => Math.hypot(car.x - c.x, car.z - c.z) < 12);
    if (!(blocked && Math.hypot(c.x - rect.cx, c.z - rect.cz) < 18)) return;
  }
  if (g.player.speed >= TUNE.arrival.speedMax) return;

  const isDrift = (g.elapsed - g.ride._lastBigSlipAt) <= TUNE.arrival.driftWindow;
  const elapsedSec = Math.max(0.01, g.elapsed - g.ride.startedAt);
  const { speedFactor, safetyMult, score } = computeRideScore(g.ride.routeLen, elapsedSec, g.ride.safety, g.ride.damage, isDrift);

  // バチン（吸着）
  const dx = rect.cx - c.x, dz = rect.cz - c.z;
  const h = g.player.horse;
  h.x += dx; h.z += dz;
  h.yaw = rect.yaw; h.vx = 0; h.vz = 0; h._speed = 0; h.gait = 0;
  c.x = rect.cx; c.z = rect.cz; c.yaw = rect.yaw;
  c.vx = 0; c.vz = 0; c.yawRate = 0; c._vF = 0; c._vL = 0; c.slip = 0;
  g.player.speed = 0; g.player.lateralG = 0; g.player.longG = 0;

  g.totals.score += score;
  g.totals.rides += 1;
  g.totals.damage += g.ride.damage;
  if (!g.totals.best || score > g.totals.best.score) {
    g.totals.best = { score, timeSec: elapsedSec, routeLen: g.ride.routeLen, speedFactor, safetyMult, damage: g.ride.damage, drift: isDrift };
  }

  g.events.push({
    type: 'arrive',
    ride: { timeSec: elapsedSec, routeLen: g.ride.routeLen, speedFactor, safety: g.ride.safety, safetyMult, damage: g.ride.damage, drift: isDrift, score },
  });

  const bonus = TUNE.shift.bonusBase * Math.pow(TUNE.shift.bonusDecay, g.totals.rides - 1);
  g.time += bonus;

  pickNextRide(g, { x: rect.cx, z: rect.cz });
}

// ---------------------------------------------------------------------
// メインステップ
// ---------------------------------------------------------------------
export function step(g, input, dt) {
  g.events = [];
  if (g.over) return g;
  input = input || {};

  if (!g.started && (input.up || input.down || input.left || input.right || input.hand)) {
    g.started = true;
  }

  const prevGait = g.player.horse.gait;
  const { driftActive } = stepCarriageRig(g.player, input, dt);
  if (g.player.horse.gait !== prevGait) g.events.push({ type: 'gait', gait: g.player.horse.gait });
  if (input.up && !g._prevUp) g.events.push({ type: 'whip' });
  g._prevUp = !!input.up;

  if (driftActive) g.ride._lastDriftAt = g.elapsed;
  if (g.player.carriage.slip > TUNE.arrival.driftSpeedThresh) g.ride._lastBigSlipAt = g.elapsed;

  applyContinuousSafety(g, driftActive, dt);
  checkCurb(g);
  resolveAllCollisions(g, dt);
  // 主ループ 2026-10-05: 安全網。車に押し込まれ続けて馬車が 31〜33 m/s（全力 13 の2倍超）に弾き飛ばされていた
  {
    const vmax = TUNE.gaits[TUNE.gaits.length - 1] * 1.15;
    for (const b of [g.player.horse, g.player.carriage]) {
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > vmax) { b.vx *= vmax / sp; b.vz *= vmax / sp; }
    }
  }

  const dodgeEvents = updatePedCarriageAvoidance(g, dt, g.rng);
  g.events.push(...dodgeEvents);
  stepPedestrians(g, dt, g.rng);
  stepCars(g, dt, g.rng);
  stepTrams(g, dt);
  stepPigeons(g, dt);
  g.pigeons = flattenPigeons(g);

  for (const p of g.props) {
    if (p.y > 0 || p.vy !== 0 || Math.hypot(p.vx, p.vz) > 0.01) {
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.yaw += (p.spinY || 0) * dt;
      const landed = integrateAirborne(p, dt);
      if (landed) g.events.push({ type: 'land', id: p.id, kind: p.kind, x: p.x, z: p.z, v: Math.abs(p.vy) });
      if (p.y <= 0) {
        const sp = Math.hypot(p.vx, p.vz);
        if (sp > 0) {
          const ns = Math.max(0, sp - 6 * dt);
          const sc = sp > 1e-6 ? ns / sp : 0;
          p.vx *= sc; p.vz *= sc;
        }
        if (Math.hypot(p.vx, p.vz) < 0.05 && p.vy === 0) p.resting = true;
      }
    }
  }
  for (const p of g.peds) if (p.state === 'fly') stepFlyingPed(p, dt);

  checkArrival(g);

  if (g.started && !g.over) {
    g.elapsed += dt;
    g.time -= dt;
    if (g.time <= 0) {
      g.time = 0;
      g.over = true;
      g.overReason = 'time';
      g.events.push({ type: 'over', reason: 'time' });
    }
  }

  return g;
}

// ---------------------------------------------------------------------
// 決定論ハッシュ（determinism テスト用）
// ---------------------------------------------------------------------
export function hashGame(g) {
  const parts = [];
  const h = g.player.horse, c = g.player.carriage;
  parts.push(r3(h.x), r3(h.z), r3(h.yaw), r3(h.vx), r3(h.vz), h.gait);
  parts.push(r3(c.x), r3(c.z), r3(c.yaw), r3(c.vx), r3(c.vz), r3(c.yawRate), r3(c.slip));
  parts.push(r3(g.time), r3(g.elapsed), g.started, g.over, g.overReason || '');
  parts.push(r3(g.ride.safety), r3(g.ride.damage), g.ride.mood);
  parts.push(r3(g.totals.score), g.totals.rides, r3(g.totals.damage));
  parts.push(g.rng.s);
  for (const p of g.props) parts.push(p.kind, r3(p.x), r3(p.z), r3(p.y), r3(p.vx), r3(p.vz));
  for (const pd of g.peds) parts.push(pd.state, r3(pd.x), r3(pd.z), r3(pd.y));
  for (const car of g.cars) parts.push(r3(car.x), r3(car.z), r3(car.yaw));
  for (const tram of g.trams) parts.push(r3(tram.x), r3(tram.z));
  return fnv1a(parts.join('|'));
}
