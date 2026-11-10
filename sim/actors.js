// sim/actors.js — 歩行者・車・タクシー・他のフィアカー・トラム・鳩の振る舞い。
// three.js にも DOM にも依存しない。
//
// 賑わい 2026-10-03（天才さん「自分以外の存在がなさすぎる」）:
//   - 歩行者は地図全体に散らさず、馬車の周り 120m に 28〜40 人を保つ。遠い人（165m 超）を、
//     近くの「見えていない所」（進行方向から 83° 以上外れた所、または 95m 以上先）の歩道へ出し直す。
//     描画側は位置の飛びを見て伸び上がりで出す（render/actors3d.js）
//   - 歩き方の種類: 立ち止まる(idle)・店を覗く(browse)・カフェに座る(sit)・2人連れ(_buddyOf)・
//     広場の大道芸人(perform)と観客(watch)
//   - 車も同じく馬車の周りへ出し直す。うち数台は他のフィアカー（kind 'fiaker'、速足の速さ）
//   - 🔴 歩行者は車道（carLane+0.15 の内側）に 0.5 秒以上いない／車・建物と重ならない（tests/tests.js 4,5）。
//     出し直す位置は歩道帯の内側だけ、建物・ボラード・屋台・他の歩行者との重なりを確かめてから置く

import { TUNE } from './tune.js';
import { crossSection, nearestSegment, pointInPlaza } from './world.js';
import { buildGrid, queryGrid, circleVsOBB } from './collide.js';

function normalizeAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function asBox(o) { return o.type === 'box' ? { cx: o.cx, cz: o.cz, yaw: o.yaw, hl: o.hl, hw: o.hw } : { cx: o.cx, cz: o.cz, yaw: 0, hl: o.r, hw: o.r }; }

// 車道(カーレーン)の上かどうか。ped種別・広場は常に false（車道ではない）
function inCarLane(world, x, z) {
  if (pointInPlaza(x, z)) return false;
  const near = nearestSegment(world, x, z);
  if (!near) return false;
  const seg = near.seg;
  if (seg.kind === 'ped') return false;
  const cs = crossSection(seg);
  return Math.abs(near.lateral) <= cs.carLane + 0.15;
}

export function inCrosswalk(world, x, z) {
  for (const cw of world.crosswalks) {
    const dx = x - cw.cx, dz = z - cw.cz;
    const along = dx * cw.dx + dz * cw.dz;
    const lat = dx * cw.nx + dz * cw.nz;
    if (Math.abs(along) <= cw.halfDepth && Math.abs(lat) <= cw.halfWidth) return cw;
  }
  return null;
}

// ---------------------------------------------------------------------
// 歩行者
// ---------------------------------------------------------------------
function pickWalkSegment(world, rng) {
  const candidates = world.segments.filter((s) => s.len > 10);
  const seg = candidates[rng.int(0, candidates.length)];
  return seg;
}

// 挙動担当 2026-10-14 (FEEL2) 配置規則: 広い歩道（幅 5m 以上＝リング通り）は縁石側 1.4m を「家具帯」
// （街灯・広告塔・花壇・キオスク・ボラードの列。sim/world.js buildRingFurniture）とし、歩行者の歩く帯は
// その外側（縁石から furnitureBand 以上）に限る。狭い歩道（街路）は家具帯を持たず従来どおり 0.6m から歩く
export function walkBandInner(seg) {
  const cs = crossSection(seg);
  return cs.carLane + cs.tram + (cs.sidewalk >= 5 ? (TUNE.pedestrian.furnitureBand ?? 1.6) : 0.6);
}
// 歩道帯（街・リング）または歩行者ゾーン全幅の中の横位置。side は ±1
function sidewalkLateral(seg, rng, side) {
  const hw = seg.width / 2;
  if (seg.kind === 'ped') return rng.range(-hw + 0.5, hw - 0.5);
  const inner = walkBandInner(seg), outer = Math.max(inner + 0.3, hw - 0.5);
  return side * rng.range(inner, outer);
}
function clampSidewalk(seg, lat) {
  const hw = seg.width / 2;
  if (seg.kind === 'ped') return clamp(lat, -hw + 0.5, hw - 0.5);
  const inner = walkBandInner(seg), outer = Math.max(inner + 0.3, hw - 0.5);
  const side = Math.sign(lat) || 1;
  return side * clamp(Math.abs(lat), inner, outer);
}

// 挙動担当 2026-10-14 (FEEL2): 位置 (x,z) の半径 r の円を、走行中・停車中の車と駐車車両（world.parkedCars の箱）の
// 外へ押し出す。飛びのき（dodge）中と歩行中の両方で使う。以前は dodge 中に何も避けず、停車中のタクシーや駐車列に
// 飛び込んで重なっていた（FEEL_REPORT 既知の問題）
function pushOutOfVehicles(g, x, z, r) {
  for (const car of g.cars) {
    const dx = x - car.x, dz = z - car.z;
    if (dx * dx + dz * dz > 36) continue;
    const res = circleVsOBB({ cx: x, cz: z, r }, { cx: car.x, cz: car.z, yaw: car.yaw, hl: TUNE.cars.radiusLen, hw: TUNE.cars.radiusWid });
    if (res) { x += res.normal.x * res.depth; z += res.normal.z * res.depth; }
  }
  for (const b of g.world.parkedCars || []) {
    const dx = x - b.cx, dz = z - b.cz;
    if (dx * dx + dz * dz > 25) continue;
    const res = circleVsOBB({ cx: x, cz: z, r }, { cx: b.cx, cz: b.cz, yaw: b.yaw, hl: b.hl, hw: b.hw });
    if (res) { x += res.normal.x * res.depth; z += res.normal.z * res.depth; }
  }
  return { x, z };
}
// 位置が車・駐車車両・建物（箱）に入っているか（飛びのく向きを選ぶとき用）
function insideVehicleOrBox(g, x, z, r) {
  const circle = { cx: x, cz: z, r };
  for (const car of g.cars) {
    if (Math.abs(x - car.x) > 6 || Math.abs(z - car.z) > 6) continue;
    if (circleVsOBB(circle, { cx: car.x, cz: car.z, yaw: car.yaw, hl: TUNE.cars.radiusLen, hw: TUNE.cars.radiusWid })) return true;
  }
  const scratch = [];
  queryGrid(g.world.smallBuildingsGrid, x, z, 8, scratch);
  for (const idx of scratch) { const b = g.world.smallBuildings[idx]; if (b.type === 'box' && circleVsOBB(circle, asBox(b))) return true; }
  return false;
}

function placePedOnSeg(ped, seg, t, lateral, dir) {
  ped.x = seg.x0 + seg.dx * t + seg.nx * lateral;
  ped.z = seg.z0 + seg.dz * t + seg.nz * lateral;
  ped.yaw = Math.atan2(seg.dz * dir, seg.dx * dir);
  ped._segIdx = seg.segIdx; ped._t = t; ped._lateral = lateral; ped._dir = dir;
}


// 主ループ 2026-10-05: 開始時の人・車を出発点の周りに寄せる。以前は地図全体に一様に置いていたため、
// 最初の5秒は馬車の60m以内に人が1〜3人しかいなかった（tests/_crowd_probe.html で実測）。総数は変えない
function segNear(segs, focus, radius, rng) {
  const near = [];
  for (const s of segs) {
    const px = focus.x - s.x0, pz = focus.z - s.z0;
    const t = clamp(px * s.dx + pz * s.dz, 0, s.len);
    const d = Math.hypot(s.x0 + s.dx * t - focus.x, s.z0 + s.dz * t - focus.z);
    if (d < radius) near.push({ s, t });
  }
  if (!near.length) return null;
  const pick = near[rng.int(0, near.length)];
  return { seg: pick.s, t: clamp(pick.t + rng.range(-radius * 0.5, radius * 0.5), 2, Math.max(2.1, pick.s.len - 2)) };
}

export function createPedestrians(world, rng, count, focus = null) {
  const peds = [];
  const P = TUNE.pedestrian;
  for (let i = 0; i < count; i++) {
    let seg = pickWalkSegment(world, rng);
    let t = rng.range(2, seg.len - 2);
    if (focus && rng.next() < 0.7) {
      const n = segNear(world.segments.filter((q) => q.len > 10), focus, 80, rng);
      if (n) { seg = n.seg; t = n.t; }
    }
    const side = rng.next() < 0.5 ? -1 : 1;
    const lateral = sidewalkLateral(seg, rng, side);
    const dir = rng.next() < 0.5 ? 1 : -1;
    const ped = {
      id: i, x: 0, z: 0, yaw: 0,
      state: 'walk', y: 0, vy: 0, spin: 0, look: rng.int(0, 10), animPhase: rng.next(),
      vx: 0, vz: 0,
      _segIdx: seg.segIdx, _t: t, _lateral: lateral, _dir: dir, _stateT: 0,
      _crossCooldown: rng.range(3, 12), _wanderPhase: rng.range(0, Math.PI * 2),
      _buddyOf: -1, _seat: -1, _scene: -1, _watcher: -1, _idleT: 0,
    };
    placePedOnSeg(ped, seg, t, lateral, dir);
    peds.push(ped);
    // 2人連れ: 次の人を相棒にして横に並べる
    if (i + 1 < count && (P.pairRatio || 0) > 0 && rng.next() < P.pairRatio) {
      const b = { ...ped, id: i + 1, look: rng.int(0, 10), animPhase: rng.next(), _buddyOf: i, _crossCooldown: 999 };
      const lat2 = clampSidewalk(seg, lateral + (Math.abs(lateral + 0.8) <= Math.abs(lateral - 0.8) ? 0.8 : -0.8));
      placePedOnSeg(b, seg, t, lat2 === lateral ? lateral + 0.01 : lat2, dir);
      peds.push(b);
      i++;
    }
  }
  return peds;
}

function pedDesiredVelocity(world, ped, dt, peds) {
  const seg = world.segments[ped._segIdx];
  const speed = TUNE.pedestrian.walkSpeed;
  if (ped.state === 'cross') {
    // 横断中: 経路の方向に沿って横に渡る（t はほぼ固定）
    const targetLateral = ped._crossTargetLateral;
    const dLat = targetLateral - ped._lateral;
    const dir = Math.sign(dLat) || 1;
    return { vx: seg.nx * dir * speed, vz: seg.nz * dir * speed, mode: 'lateral' };
  }
  // 2人連れの相棒: 先導者の横（0.8m）に付いていく。先導者が別の区間・別の状態なら普通に歩く
  if (ped._buddyOf >= 0) {
    const L = peds[ped._buddyOf];
    if (L && L._segIdx === ped._segIdx && (L.state === 'walk' || L.state === 'idle' || L.state === 'browse')) {
      ped._dir = L._dir;
      const want = clampSidewalk(seg, L._lateral + (Math.abs(L._lateral + 0.8) <= Math.abs(L._lateral - 0.8) ? 0.8 : -0.8));
      const tx = seg.x0 + seg.dx * L._t + seg.nx * want, tz = seg.z0 + seg.dz * L._t + seg.nz * want;
      const dx = tx - ped.x, dz = tz - ped.z, d = Math.hypot(dx, dz);
      if (d < 0.12) return { vx: L.vx * 0.9, vz: L.vz * 0.9, mode: 'buddy' };
      const sp = Math.min(speed * 1.45, d * 2.2 + Math.hypot(L.vx, L.vz) * 0.8);
      return { vx: (dx / d) * sp, vz: (dz / d) * sp, mode: 'buddy' };
    }
  }
  if (seg.kind === 'ped' || pointInPlaza(ped.x, ped.z)) {
    // 自由歩行ゾーン: tに沿って往復しつつ横方向にもゆっくり揺れる
    const alongDir = ped._dir;
    let lateralDrift = Math.sin(ped._wanderPhase) * 0.15;
    // 2026-10-03: 揺れで道の端（建物は hw+1）まで出ないよう、端 1.2m 手前から内側へ戻す
    // （出し直しで人数が増えたら、グラーベンの端で建物と重なる人がテストに出た）
    const over = Math.abs(ped._lateral) - (seg.width / 2 - 1.2);
    if (over > 0) lateralDrift = -(Math.sign(ped._lateral) || 1) * Math.min(1.2, 0.3 + over * 1.5);
    const vAlong = seg.dx * alongDir * speed, vAlongZ = seg.dz * alongDir * speed;
    const vLat = seg.nx * lateralDrift * speed, vLatZ = seg.nz * lateralDrift * speed;
    return { vx: vAlong + vLat, vz: vAlongZ + vLatZ, mode: 'free' };
  }
  // 歩道: tに沿って往復しつつ、横位置を自分側の歩道帯に引き戻す。
  // （dodge や分離力で車道側へ押し出された後、何もしないと車道に留まり続けてしまうため）
  const dir = ped._dir;
  const cs = crossSection(seg);
  const hw = seg.width / 2;
  const innerBound = walkBandInner(seg) - 0.2; // FEEL2: 広い歩道では家具帯（縁石側 1.4m）の外に引き戻す
  const outerBound = Math.max(innerBound + 0.1, hw - 0.4);
  const side = Math.sign(ped._lateral) || ped._dir || 1;
  const targetLateral = Math.max(innerBound, Math.min(outerBound, Math.abs(ped._lateral))) * side;
  const latDiff = targetLateral - ped._lateral;
  const correctSpeed = Math.max(-2.0, Math.min(2.0, latDiff * 2));
  const vAlong = seg.dx * dir * speed, vAlongZ = seg.dz * dir * speed;
  const vLat = seg.nx * correctSpeed, vLatZ = seg.nz * correctSpeed;
  return { vx: vAlong + vLat, vz: vAlongZ + vLatZ, mode: 'sidewalk' };
}

function tryStartCrossing(world, ped, rng, carBoxes) {
  const seg = world.segments[ped._segIdx];
  if (seg.kind === 'ped') return false;
  ped._crossCooldown -= 0; // (dt は呼び出し側で既に引いてある)
  if (ped._crossCooldown > 0) return false;
  // 近くの横断歩道を探す
  for (const cw of world.crosswalks) {
    if (cw.segIdx !== seg.segIdx) continue;
    const along = (ped.x - cw.cx) * cw.dx + (ped.z - cw.cz) * cw.dz;
    // 横断中は横方向にしか動かないので、開始時点で横断歩道の帯(halfDepth)の
    // 内側にきっちり揃えておく。でないと帯の外で「横断中」になり続け、
    // 車道に長時間いる判定(0.5秒ルール)に引っかかる。
    if (Math.abs(along) > cw.halfDepth) continue;
    // 交通確認: 車・馬車が近くにあれば待つ
    let blocked = false;
    for (const b of carBoxes) {
      if (Math.hypot(b.x - cw.cx, b.z - cw.cz) < TUNE.pedestrian.carriageNearDist) { blocked = true; break; }
    }
    if (blocked) { ped.state = 'wait'; ped._stateT = 0; return true; }
    ped.state = 'cross';
    ped._stateT = 0;
    // 経路沿いの位置(t)を横断歩道の位置へスナップし、帯の内側に固定する
    ped._t = clamp((cw.cx - seg.x0) * seg.dx + (cw.cz - seg.z0) * seg.dz, 0, seg.len);
    ped.x = seg.x0 + seg.dx * ped._t + seg.nx * ped._lateral;
    ped.z = seg.z0 + seg.dz * ped._t + seg.nz * ped._lateral;
    ped._crossTargetLateral = -ped._lateral;
    ped._crossCooldown = rng.range(8, 20);
    return true;
  }
  return false;
}

// 座席・舞台の枠を手放す（出し直し・吹っ飛びのとき）
function releaseSlots(world, ped) {
  if (ped._seat >= 0 && world.cafeSeats) { const s = world.cafeSeats[ped._seat]; if (s && s.occupant === ped.id) s.occupant = -1; }
  if (ped._scene >= 0 && world.scenes) {
    const sc = world.scenes[ped._scene];
    if (sc) { if (ped._watcher >= 0) { const w = sc.watchers[ped._watcher]; if (w && w.occupant === ped.id) w.occupant = -1; } else if (sc.occupant === ped.id) sc.occupant = -1; }
  }
  ped._seat = -1; ped._scene = -1; ped._watcher = -1;
}

// 馬車から見て「出しても気づかれない所」か。近く(95m 未満)なら進行方向から unseenAngle 以上外れていること
function unseenFrom(carrier, x, z, d, angle) {
  if (d >= 95) return true;
  const fx = Math.cos(carrier.yaw), fz = Math.sin(carrier.yaw);
  const dot = ((x - carrier.x) * fx + (z - carrier.z) * fz) / (d || 1);
  return dot < Math.cos(angle);
}

function overlapsStatic(world, x, z, r, scratch) {
  const circle = { cx: x, cz: z, r };
  queryGrid(world.smallBuildingsGrid, x, z, 30, scratch);
  for (const idx of scratch) if (circleVsOBB(circle, asBox(world.smallBuildings[idx]))) return true;
  for (const l of world.landmarkColliders) if (circleVsOBB(circle, asBox(l))) return true;
  return false;
}

// 遠い歩行者を馬車の近く（見えない所）の歩道へ出し直す。0.5 秒に 1 回、最大 3 人
function recyclePedestrians(g, rng) {
  const world = g.world, P = TUNE.pedestrian, peds = g.peds;
  const c = g.player.carriage;
  const near = P.nearRadius ?? 120, spawnMin = P.spawnMin ?? 45, spawnMax = P.spawnMax ?? 130;
  let nearCount = 0;
  const far = [];
  // 主ループ 2026-10-05: 後ろに置き去りにした人は「近く」に数えず、出し直しの候補にする。以前は追い越した人も
  // 120m 以内なら数えたため、全力走行で前方が空になっても出し直されず、前方の人が 3人前後まで減っていた
  const fx = Math.cos(c.yaw), fz = Math.sin(c.yaw);
  for (const p of peds) {
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    const along = (p.x - c.x) * fx + (p.z - c.z) * fz;
    if (d < near && along > -30) nearCount++;
    else if ((d > (P.farRadius ?? 165) || (along < -40 && d > 40)) && (p.state === 'walk' || p.state === 'idle' || p.state === 'browse' || p.state === 'sit' || p.state === 'watch' || p.state === 'perform' || p.state === 'wait')) far.push(p);
  }
  if (nearCount >= (P.nearMin ?? 28) || !far.length) return;
  // 近くの区間（馬車から spawnMax 以内）
  const segs = [];
  for (const s of world.segments) { if (s.len < 8) continue; const n = nearestSegment({ segments: [s] }, c.x, c.z); if (n && n.dist < spawnMax) segs.push(s); }
  if (!segs.length) return;
  const scratch = [];
  const grid = buildGrid(peds, 4, (p) => [p.x, p.z]);
  // 近くがガラ空き（開始直後）なら一度に多く出す。普段は 3 人まで
  const budget = Math.min(nearCount < (P.nearMin ?? 28) / 2 ? 10 : 3, (P.nearMax ?? 40) - nearCount);
  let placed = 0;
  for (const ped of far) {
    if (placed >= budget) break;
    if (ped._buddyOf >= 0) { // 相棒は先導者と一緒に動かす（先導者がそばで歩いている時だけ。離れていれば単独で出し直す）
      const L = peds[ped._buddyOf];
      if (L && Math.hypot(L.x - ped.x, L.z - ped.z) < 6 && (L.state === 'walk' || L.state === 'idle' || L.state === 'browse' || L.state === 'wait' || L.state === 'cross')) continue;
    }
    releaseSlots(world, ped);
    // カフェの席（空いている・近い・見えない）
    if (world.cafeSeats && rng.next() < (P.sitRatio ?? 0.3)) {
      const cands = [];
      world.cafeSeats.forEach((s, i) => { if (s.occupant >= 0) return; const d = Math.hypot(s.x - c.x, s.z - c.z); if (d >= spawnMin && d <= spawnMax && unseenFrom(c, s.x, s.z, d, P.unseenAngle ?? 1.45)) cands.push(i); });
      if (cands.length) {
        const si = cands[rng.int(0, cands.length)], s = world.cafeSeats[si];
        ped.x = s.x; ped.z = s.z; ped.yaw = s.yaw; ped.state = 'sit'; ped._stateT = 0; ped._seat = si; s.occupant = ped.id;
        ped._segIdx = s.segIdx; const seg = world.segments[s.segIdx]; ped._t = clamp((s.x - seg.x0) * seg.dx + (s.z - seg.z0) * seg.dz, 0, seg.len);
        ped._lateral = (s.x - (seg.x0 + seg.dx * ped._t)) * seg.nx + (s.z - (seg.z0 + seg.dz * ped._t)) * seg.nz;
        ped.vx = 0; ped.vz = 0; ped._spawnTick = (ped._spawnTick || 0) + 1;
        placed++; continue;
      }
    }
    // 広場の舞台（大道芸人 → 観客の順に埋める）
    if (world.scenes) {
      let done = false;
      for (let si = 0; si < world.scenes.length && !done; si++) {
        const sc = world.scenes[si];
        const d = Math.hypot(sc.x - c.x, sc.z - c.z);
        if (d < spawnMin || d > spawnMax || !unseenFrom(c, sc.x, sc.z, d, P.unseenAngle ?? 1.45)) continue;
        let slot = null, wi = -1;
        if (sc.occupant < 0) slot = sc; else { wi = sc.watchers.findIndex((w) => w.occupant < 0); if (wi >= 0) slot = sc.watchers[wi]; }
        if (!slot) continue;
        ped.x = slot.x; ped.z = slot.z; ped.yaw = slot.yaw; ped.state = wi >= 0 ? 'watch' : 'perform'; ped._stateT = 0;
        ped._scene = si; ped._watcher = wi; slot.occupant = ped.id; ped.vx = 0; ped.vz = 0;
        const n = nearestSegment(world, ped.x, ped.z); if (n) { ped._segIdx = n.seg.segIdx; ped._t = n.t; ped._lateral = n.lateral; }
        ped._spawnTick = (ped._spawnTick || 0) + 1;
        placed++; done = true;
      }
      if (done) continue;
    }
    // 歩道へ。走っている時は 3/4 を「前方の遠く（95m 以上）」に出す: 後ろに出した人は置き去りになるだけで、前方の人はやがて視界に入る
    const moving = Math.hypot(c.vx || 0, c.vz || 0) > 3;
    const fx = Math.cos(c.yaw), fz = Math.sin(c.yaw);
    for (let tries = 0; tries < 12; tries++) {
      const seg = segs[rng.int(0, segs.length)];
      const t = rng.range(2, seg.len - 2);
      const lateral = sidewalkLateral(seg, rng, rng.next() < 0.5 ? -1 : 1);
      const x = seg.x0 + seg.dx * t + seg.nx * lateral, z = seg.z0 + seg.dz * t + seg.nz * lateral;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < spawnMin || d > spawnMax) continue;
      if (!unseenFrom(c, x, z, d, P.unseenAngle ?? 1.45)) continue;
      if (moving && tries < 9 && ((x - c.x) * fx + (z - c.z) * fz) / d < 0.5) continue; // 前方（±60°）を優先。9 回外れたら後ろでもよい
      if (seg.kind !== 'ped' && inCrosswalk(world, x, z)) continue;
      if (overlapsStatic(world, x, z, P.radius + 0.3, scratch)) continue;
      let crowded = false;
      queryGrid(grid, x, z, 2, scratch);
      for (const idx of scratch) { const o = peds[idx]; if (o !== ped && Math.hypot(o.x - x, o.z - z) < 1.3) { crowded = true; break; } }
      if (crowded) continue;
      const dir = rng.next() < 0.5 ? 1 : -1;
      placePedOnSeg(ped, seg, t, lateral, dir);
      ped.state = 'walk'; ped._stateT = 0; ped._crossCooldown = rng.range(3, 12); ped.vx = 0; ped.vz = 0;
      ped._spawnTick = (ped._spawnTick || 0) + 1;
      // 相棒も横に
      const buddy = peds.find((o) => o._buddyOf === ped.id);
      if (buddy) {
        releaseSlots(world, buddy);
        const lat2 = clampSidewalk(seg, lateral + (Math.abs(lateral + 0.8) <= Math.abs(lateral - 0.8) ? 0.8 : -0.8));
        placePedOnSeg(buddy, seg, t, lat2 === lateral ? lateral + 0.01 : lat2, dir);
        buddy.state = 'walk'; buddy._stateT = 0; buddy.vx = 0; buddy.vz = 0; buddy._spawnTick = (buddy._spawnTick || 0) + 1;
      }
      placed++;
      break;
    }
  }
}

export function stepPedestrians(g, dt, rng) {
  const world = g.world;
  const peds = g.peds;
  const P = TUNE.pedestrian;
  const carBoxes = [
    { x: g.player.horse.x, z: g.player.horse.z, vx: g.player.horse.vx, vz: g.player.horse.vz },
    { x: g.player.carriage.x, z: g.player.carriage.z, vx: g.player.carriage.vx, vz: g.player.carriage.vz },
  ];
  for (const c of g.cars) carBoxes.push({ x: c.x, z: c.z, vx: c.vx, vz: c.vz });

  // 出し直し（一定間隔）
  g._pedRecycleT = (g._pedRecycleT || 0) + dt;
  if (g._pedRecycleT >= (P.recycleEvery ?? 0.5)) { g._pedRecycleT = 0; recyclePedestrians(g, rng); }

  const grid = buildGrid(peds, 4, (p) => [p.x, p.z]);
  const nearIdx = [];

  for (const ped of peds) {
    if (ped.state === 'down' || ped.state === 'fly') {
      if (ped._seat >= 0 || ped._scene >= 0) releaseSlots(world, ped); // 座っていた席・舞台の枠を空ける
      // 物理(airborne)は game.js 側で処理。down はタイマーだけ進める。
      if (ped.state === 'down') {
        ped._stateT += dt;
        if (ped._stateT > TUNE.pedestrian.downTime) { ped.state = 'angry'; ped._stateT = 0; }
      }
      continue;
    }
    if (ped.state === 'angry') {
      ped._stateT += dt;
      if (ped._stateT > TUNE.pedestrian.angryTime) {
        ped.state = 'walk';
        ped._stateT = 0;
        const near = nearestSegment(world, ped.x, ped.z);
        if (near) { ped._segIdx = near.seg.segIdx; ped._t = near.t; ped._lateral = near.lateral; }
      }
      continue;
    }
    if (ped.state === 'dodge') {
      ped._stateT += dt;
      // FEEL2: 飛びのき中も車・駐車車両の外へ押し出す（停車中のタクシーや駐車列に飛び込まない）
      const pushed = pushOutOfVehicles(g, ped.x + ped.vx * dt, ped.z + ped.vz * dt, TUNE.pedestrian.radius + 0.05);
      ped.x = pushed.x; ped.z = pushed.z;
      ped.vx *= 0.9; ped.vz *= 0.9;
      if (ped._stateT > 0.4) {
        ped.state = 'walk';
        const near = nearestSegment(world, ped.x, ped.z);
        if (near) { ped._segIdx = near.seg.segIdx; ped._lateral = near.lateral; }
      }
      continue;
    }
    // 座っている: 椅子が動かされたら立って歩く
    if (ped.state === 'sit') {
      ped._stateT += dt;
      const seat = world.cafeSeats && world.cafeSeats[ped._seat];
      const chair = seat && g.props[seat.propId];
      if (!seat || !chair || !chair.resting || chair.broken || Math.hypot(chair.x - seat.x, chair.z - seat.z) > 0.4) {
        releaseSlots(world, ped); ped.state = 'walk'; ped._stateT = 0; ped._crossCooldown = rng.range(3, 12);
      }
      ped.vx = 0; ped.vz = 0;
      continue;
    }
    // 大道芸人・観客: その場にいる
    if (ped.state === 'perform' || ped.state === 'watch') { ped._stateT += dt; ped.vx = 0; ped.vz = 0; continue; }
    // 立ち止まり・店を覗く
    if (ped.state === 'idle' || ped.state === 'browse') {
      ped._stateT += dt; ped.vx = 0; ped.vz = 0;
      if (ped._stateT > ped._idleT) { ped.state = 'walk'; ped._stateT = 0; }
      continue;
    }

    ped._crossCooldown -= dt;

    if (ped.state === 'wait') {
      ped._stateT += dt;
      let blocked = false;
      const cw = world.crosswalks.find((c) => c.segIdx === ped._segIdx);
      if (cw) {
        for (const b of carBoxes) if (Math.hypot(b.x - ped.x, b.z - ped.z) < TUNE.pedestrian.carriageNearDist) { blocked = true; break; }
      }
      if (!blocked) { ped.state = 'cross'; ped._stateT = 0; ped._crossTargetLateral = -ped._lateral; }
      continue;
    }

    if (ped.state === 'walk') {
      if (ped._buddyOf < 0) {
        if (tryStartCrossing(world, ped, rng, carBoxes)) {
          // 相棒も一緒に渡る（同じ横断歩道に揃える）
          if (ped.state === 'cross') for (const b of peds) if (b._buddyOf === ped.id && b.state === 'walk' && b._segIdx === ped._segIdx && Math.hypot(b.x - ped.x, b.z - ped.z) < 4) {
            const seg = world.segments[ped._segIdx];
            b.state = 'cross'; b._stateT = 0; b._t = ped._t;
            b.x = seg.x0 + seg.dx * b._t + seg.nx * b._lateral; b.z = seg.z0 + seg.dz * b._t + seg.nz * b._lateral;
            b._crossTargetLateral = -b._lateral;
          }
        } else if ((P.idleChance || 0) > 0 && rng.next() < P.idleChance * dt) {
          // 歩道の外側（建物側）にいれば店を覗く、そうでなければ立ち止まる
          const seg = world.segments[ped._segIdx];
          const hw = seg.width / 2;
          const nearFacade = Math.abs(ped._lateral) > hw - 2.2;
          ped.state = nearFacade && rng.next() < 0.6 ? 'browse' : 'idle';
          ped._stateT = 0; ped._idleT = rng.range(2, 6);
          if (ped.state === 'browse') { const s = Math.sign(ped._lateral) || 1; ped.yaw = Math.atan2(seg.nz * s, seg.nx * s); }
          ped.vx = 0; ped.vz = 0;
          continue;
        }
      }
    }

    const desired = pedDesiredVelocity(world, ped, dt, peds);
    let vx = desired.vx, vz = desired.vz;

    // 分離力: 近くの歩行者から離れる
    queryGrid(grid, ped.x, ped.z, 1.6, nearIdx);
    for (const idx of nearIdx) {
      const other = peds[idx];
      if (other === ped) continue;
      const dx = ped.x - other.x, dz = ped.z - other.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.001 && d < 1.2) {
        const push = (1.2 - d) * 1.5;
        vx += (dx / d) * push; vz += (dz / d) * push;
      }
    }

    const sp = Math.hypot(vx, vz);
    const maxSp = TUNE.pedestrian.walkSpeed * 1.8;
    if (sp > maxSp) { vx = (vx / sp) * maxSp; vz = (vz / sp) * maxSp; }

    // 2026-10-02 主ループ追加: ボラード（動かない円）を避ける。以前は建物だけ避け、ボラードは歩いて通り抜けていた
    // （建物の生成を変えてボラードの位置が歩道に来たとき、テストで 84 回の重なりとして露見）
    // 賑わい 2026-10-03: 広場の屋台（円 r=1.7）も同じ仕組みで避ける
    // 当たり判定は円を「半径 r の正方形」として扱う（collide の asBox）ので、避ける半径は r×√2 にする
    // 円のランドマーク（ペスト記念柱 r=5）も同じ: 以前は避けておらず、人が増えたらトゥーフラウベンの歩道から柱に入る人が出た
    const bols = world._bollards || (world._bollards = world.buildings.filter(b => b.type === 'circle').map(b => ({ cx: b.cx, cz: b.cz, r: b.kind === 'bollard' ? b.r : b.r * 1.42 })));
    const pr = TUNE.pedestrian.radius;
    for (const b of bols) {
      const dx = ped.x - b.cx, dz = ped.z - b.cz;
      if (Math.abs(dx) > b.r + 2 || Math.abs(dz) > b.r + 2) continue;
      const d = Math.hypot(dx, dz), want = b.r + pr + 0.25;
      if (d < want + 0.6 && d > 0.001) { const k = (want + 0.6 - d) * 2.0; vx += (dx / d) * k; vz += (dz / d) * k; }
    }

    ped.vx = vx; ped.vz = vz;
    let nx = ped.x + vx * dt, nz = ped.z + vz * dt;
    // 車・他のフィアカー（可動の箱）に入らない: 次の位置が箱に重なるなら外へ押し出す
    // （2026-10-03: 馬車に弾かれて滑る馬車や、歩道際に止まった車を歩いて通り抜けていた）
    { const pushed = pushOutOfVehicles(g, nx, nz, pr + 0.05); nx = pushed.x; nz = pushed.z; } // FEEL2: 駐車車両も含む
    for (const b of bols) {
      const dx = nx - b.cx, dz = nz - b.cz;
      if (Math.abs(dx) > b.r + 2 || Math.abs(dz) > b.r + 2) continue;
      const d = Math.hypot(dx, dz), want = b.r + pr + 0.02;
      if (d < want) { const ux = d > 0.001 ? dx / d : 1, uz = d > 0.001 ? dz / d : 0; nx = b.cx + ux * want; nz = b.cz + uz * want; }
    }

    if (desired.mode === 'lateral') {
      ped.x = nx; ped.z = nz;
      const seg = world.segments[ped._segIdx];
      ped._lateral = (nx - (seg.x0 + seg.dx * ped._t)) * seg.nx + (nz - (seg.z0 + seg.dz * ped._t)) * seg.nz;
      if (Math.abs(ped._lateral - ped._crossTargetLateral) < 0.15 || Math.sign(ped._lateral) === Math.sign(ped._crossTargetLateral) && Math.abs(ped._lateral) >= Math.abs(ped._crossTargetLateral)) {
        ped.state = 'walk';
        ped._dir *= -1;
      }
    } else {
      ped.x = nx; ped.z = nz;
      const seg = world.segments[ped._segIdx];
      const px = ped.x - seg.x0, pz = ped.z - seg.z0;
      ped._t = clamp(px * seg.dx + pz * seg.dz, 0, seg.len);
      const cx = seg.x0 + seg.dx * ped._t, cz = seg.z0 + seg.dz * ped._t;
      ped._lateral = (ped.x - cx) * seg.nx + (ped.z - cz) * seg.nz;
      ped._wanderPhase += dt * 0.7;
      if (ped._t <= 0.05 || ped._t >= seg.len - 0.05) ped._dir *= -1;
    }
    if (sp > 0.05) ped.yaw = Math.atan2(vz, vx);
    ped.animPhase = (ped.animPhase + sp * dt * 0.6) % 1;
  }
}

// 馬車が1秒以内にぶつかると予測されるか調べ、飛びのき(dodge)を発生させる。
// game.js の衝突判定より前に毎フレーム呼ぶ。戻り値: イベント配列
export function updatePedCarriageAvoidance(g, dt, rng) {
  const events = [];
  const T = TUNE.pedestrian;
  const carrier = [g.player.horse, g.player.carriage];
  const speed = g.player.speed;
  for (const ped of g.peds) {
    if (ped.state !== 'walk' && ped.state !== 'cross' && ped.state !== 'idle' && ped.state !== 'browse' && ped.state !== 'watch') continue;
    for (const body of carrier) {
      const relx = ped.x - body.x, relz = ped.z - body.z;
      const dist0 = Math.hypot(relx, relz);
      if (dist0 > 10) continue; // 主ループ 2026-10-05: 6→10m（速足でも避ける判断が間に合っていなかった）
      // 予測: body の速度で t=predictT 秒後の位置と ped の距離
      const predT = T.dodgePredictTime;
      const bx = body.x + body.vx * predT, bz = body.z + body.vz * predT;
      const px = ped.x + ped.vx * predT, pz = ped.z + ped.vz * predT;
      const predDist = Math.hypot(bx - px, bz - pz);
      if (predDist < 2.2 && speed < T.dodgeSpeedThresh) {
        // 主ループ 2026-10-05: 進路に対して横へ逃げる（その人がいる側へ）。以前は馬車の中心から真っすぐ遠ざかる向きで、
        // 進路の正面の人は馬車の進む方向へ逃げて追いつかれていた（慎重運転で当たった人の半数が飛びのく途中だった）
        const bsp = Math.hypot(body.vx, body.vz) || 1;
        const fx = body.vx / bsp, fz = body.vz / bsp;
        let side = Math.sign(fx * relz - fz * relx);
        if (side === 0) side = rng.next() < 0.5 ? -1 : 1;
        let awayX = -fz * side, awayZ = fx * side;
        // FEEL2: 飛びのく先（1.2m 先）が車・駐車車両・建物の中なら反対側へ。両側とも塞がっていれば元の側（押し出しに任せる）
        if (insideVehicleOrBox(g, ped.x + awayX * 1.2, ped.z + awayZ * 1.2, T.radius) && !insideVehicleOrBox(g, ped.x - awayX * 1.2, ped.z - awayZ * 1.2, T.radius)) { awayX = -awayX; awayZ = -awayZ; }
        releaseSlots(g.world, ped);
        ped.state = 'dodge';
        ped._stateT = 0;
        ped.vx = awayX * 3.0; ped.vz = awayZ * 3.0;
        events.push({ type: 'pedDodge', id: ped.id, x: ped.x, z: ped.z });
        if (speed > T.clipBonusSpeedThresh) {
          events.push({ type: 'bonus', amount: T.clipBonusAmount, x: ped.x, z: ped.z, kind: 'dodge' });
        }
        break;
      }
    }
  }
  return events;
}

export function pedKnockback(ped, normal, impactSpeed, rng) {
  ped.state = 'fly';
  ped._stateT = 0;
  const vy = Math.min(impactSpeed * TUNE.launch.vyMult, TUNE.launch.vyCap);
  ped.vy = vy;
  ped.vx = normal.x * Math.min(impactSpeed, 6);
  ped.vz = normal.z * Math.min(impactSpeed, 6);
  ped.spin = (rng.next() * 2 - 1) * 8;
}

export function stepFlyingPed(ped, dt) {
  ped.x += ped.vx * dt; ped.z += ped.vz * dt;
  ped.y += ped.vy * dt;
  ped.vy -= TUNE.launch.gravity * dt;
  ped.vx *= 0.98; ped.vz *= 0.98;
  ped.spin += dt * 10;
  if (ped.y <= 0 && ped.vy < 0) {
    ped.y = 0; ped.vy = 0; ped.vx = 0; ped.vz = 0;
    ped.state = 'down'; ped._stateT = 0;
  }
}

// ---------------------------------------------------------------------
// 車・タクシー・他のフィアカー
// ---------------------------------------------------------------------
function driveSegments(world) {
  return world.segments.filter((s) => s.kind === 'street' || s.kind === 'ring');
}

function laneLateral(seg, dir) {
  const cs = crossSection(seg);
  const laneOffset = seg.kind === 'ring' ? (cs.tram + cs.carLane / 2) : 0;
  return dir > 0 ? laneOffset : -laneOffset;
}

export function createCars(world, rng, count, focus = null) {
  const segs = driveSegments(world);
  const cars = [];
  const nFiaker = Math.min(count, TUNE.cars.fiakers || 0);
  for (let i = 0; i < count; i++) {
    let seg = segs[rng.int(0, segs.length)];
    const dir = rng.next() < 0.5 ? 1 : -1;
    let t = rng.range(0, seg.len);
    if (focus && rng.next() < 0.5) { const n = segNear(segs, focus, 200, rng); if (n) { seg = n.seg; t = n.t; } }
    const lateral = laneLateral(seg, dir);
    const x = seg.x0 + seg.dx * t + seg.nx * lateral;
    const z = seg.z0 + seg.dz * t + seg.nz * lateral;
    const isFiaker = i < nFiaker;
    const fs = TUNE.cars.fiakerSpeed || [2.6, 3.4];
    cars.push({
      id: i, kind: isFiaker ? 'fiaker' : (rng.next() < 0.25 ? 'taxi' : 'car'), x, z,
      yaw: Math.atan2(seg.dz * dir, seg.dx * dir), vx: 0, vz: 0, hazard: false,
      look: rng.int(0, 1000), // 見た目の種（車の色・馬の毛色）
      _segIdx: seg.segIdx, _t: t, _dir: dir, _lateral: lateral,
      _speed: isFiaker ? fs[0] + rng.next() * (fs[1] - fs[0]) : TUNE.cars.speedMin + rng.next() * (TUNE.cars.speedMax - TUNE.cars.speedMin),
    });
  }
  return cars;
}

function pickNextSegment(world, nodeKeyFn, car, seg, atEndPositive, rng) {
  const key = nodeKeyFn(atEndPositive ? seg.x1 : seg.x0, atEndPositive ? seg.z1 : seg.z0);
  const edges = (world.adjacency.get(key) || []).filter((e) => {
    const s = world.segments[e.segIdx];
    return (s.kind === 'street' || s.kind === 'ring');
  });
  if (edges.length === 0) return null;
  const choice = edges[rng.int(0, edges.length)];
  const ns = world.segments[choice.segIdx];
  const startsAtNode = Math.hypot(ns.x0 - (atEndPositive ? seg.x1 : seg.x0), ns.z0 - (atEndPositive ? seg.z1 : seg.z0)) < 0.5;
  return { seg: ns, dir: startsAtNode ? 1 : -1, t: startsAtNode ? 0 : ns.len };
}

// 遠い車を馬車の近く（見えない所）の車道へ出し直す。0.7 秒に 1 回、1 台
function recycleCars(g, rng) {
  const C = TUNE.cars, world = g.world, c = g.player.carriage;
  let nearCount = 0, farthest = null, farD = 0;
  // 主ループ 2026-10-05: 歩行者と同じく、後ろに置き去りにした車は数えず、出し直しの候補にする（前方に車がほぼいなかった）
  const fx = Math.cos(c.yaw), fz = Math.sin(c.yaw);
  for (const car of g.cars) {
    const d = Math.hypot(car.x - c.x, car.z - c.z);
    const along = (car.x - c.x) * fx + (car.z - c.z) * fz;
    if (d < (C.nearRadius ?? 150) && along > -40) nearCount++;
    const score = along < -50 ? d + 1000 : d;
    if ((d > (C.farRadius ?? 240) || (along < -50 && d > 50)) && score > farD && !(car._knockedT > 0) && car.kind !== 'tram') { farD = score; farthest = car; }
  }
  if (nearCount >= (C.nearMin ?? 7) || !farthest) return;
  const segs = [];
  for (const s of driveSegments(world)) { const n = nearestSegment({ segments: [s] }, c.x, c.z); if (n && n.dist < (C.spawnMax ?? 200)) segs.push(s); }
  if (!segs.length) return;
  for (let tries = 0; tries < 12; tries++) {
    const seg = segs[rng.int(0, segs.length)];
    const dir = rng.next() < 0.5 ? 1 : -1;
    const t = rng.range(4, seg.len - 4);
    const lateral = laneLateral(seg, dir);
    const x = seg.x0 + seg.dx * t + seg.nx * lateral, z = seg.z0 + seg.dz * t + seg.nz * lateral;
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < (C.spawnMin ?? 70) || d > (C.spawnMax ?? 200)) continue;
    if (d < 140 && !unseenFrom(c, x, z, d, TUNE.pedestrian.unseenAngle ?? 1.45)) continue;
    let blocked = false;
    for (const o of g.cars) if (o !== farthest && Math.hypot(o.x - x, o.z - z) < 16) { blocked = true; break; }
    if (!blocked) for (const p of g.peds) if (Math.hypot(p.x - x, p.z - z) < 5) { blocked = true; break; }
    if (blocked) continue;
    farthest.x = x; farthest.z = z; farthest._segIdx = seg.segIdx; farthest._t = t; farthest._dir = dir; farthest._lateral = lateral;
    farthest.yaw = Math.atan2(seg.dz * dir, seg.dx * dir); farthest._curSpeed = farthest._speed * 0.6;
    farthest.vx = Math.cos(farthest.yaw) * farthest._curSpeed; farthest.vz = Math.sin(farthest.yaw) * farthest._curSpeed;
    farthest.hazard = false; farthest._spawnTick = (farthest._spawnTick || 0) + 1;
    return;
  }
}

export function stepCars(g, dt, rng) {
  const world = g.world;
  g._carRecycleT = (g._carRecycleT || 0) + dt;
  if (g._carRecycleT >= (TUNE.cars.recycleEvery ?? 0.7)) { g._carRecycleT = 0; recycleCars(g, rng); }
  const obstacles = [{ x: g.player.carriage.x, z: g.player.carriage.z }, { x: g.player.horse.x, z: g.player.horse.z }];
  for (const p of g.peds) if (p.state !== 'down' && p.state !== 'fly') obstacles.push({ x: p.x, z: p.z });
  for (const car of g.cars) {
    if ((car._knockedT || 0) > 0) {
      // 衝突で押された直後: しばらく自由に滑らせてからレーンへ復帰する
      car._knockedT -= dt;
      // 滑っている先に人がいたらそこで止まる（人を轢いて重ならない。2026-10-03）
      const nx = car.x + car.vx * dt, nz = car.z + car.vz * dt;
      let hitPed = false;
      for (const p of g.peds) {
        if (p.state === 'fly' || p.state === 'down') continue;
        const dx = p.x - nx, dz = p.z - nz; if (dx * dx + dz * dz > 25) continue;
        if (circleVsOBB({ cx: p.x, cz: p.z, r: TUNE.pedestrian.radius + 0.3 }, { cx: nx, cz: nz, yaw: car.yaw, hl: TUNE.cars.radiusLen, hw: TUNE.cars.radiusWid })) { hitPed = true; break; }
      }
      if (hitPed) { car.vx = 0; car.vz = 0; car._knockedT = Math.min(car._knockedT, 0.05); }
      car.x += car.vx * dt; car.z += car.vz * dt;
      const sp = Math.hypot(car.vx, car.vz);
      if (sp > 0) { const ns = Math.max(0, sp - 4 * dt); const sc = sp > 1e-6 ? ns / sp : 0; car.vx *= sc; car.vz *= sc; }
      if (car._knockedT <= 0) {
        // 復帰先は車道（street/ring）だけ。以前は最寄りの区間に歩行者ゾーンも含まれ、押された馬車がケルントナー通りを走って人と重なった（probe で露見）
        const near = nearestSegment({ segments: driveSegments(world) }, car.x, car.z);
        if (near) {
          car._segIdx = near.seg.segIdx; car._t = near.t;
          car._lateral = near.lateral;
          car._dir = (car.vx * near.seg.dx + car.vz * near.seg.dz) >= 0 ? 1 : -1;
        }
        car._curSpeed = 0;
      }
      continue;
    }
    // 主ループ 2026-10-05: 馬車と接触している（ごく近い）車は前へ進まない。車は毎ステップ車線の速さに戻るため、
    // 押し込み続けて馬車に勢いを足し続けていた
    {
      const pc = g.player.carriage, ph = g.player.horse;
      const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
      const touching = [pc, ph].some((b) => { const dx = b.x - car.x, dz = b.z - car.z; const along = dx * fx + dz * fz; return along > 0 && along < TUNE.cars.radiusLen + 3.2 && Math.abs(-dx * fz + dz * fx) < TUNE.cars.radiusWid + 1.4; });
      if (touching) { car.vx = 0; car.vz = 0; car._curSpeed = 0; continue; }
    }
    const seg = world.segments[car._segIdx];
    // 前方確認
    let aheadBlocked = false;
    for (const other of g.cars) {
      if (other === car) continue;
      const dx = other.x - car.x, dz = other.z - car.z;
      const fwd = dx * Math.cos(car.yaw) + dz * Math.sin(car.yaw);
      const lat = -dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
      if (fwd > 0 && fwd < TUNE.cars.aheadDist && Math.abs(lat) < 2.5) { aheadBlocked = true; break; }
    }
    if (!aheadBlocked) {
      for (const o of obstacles) {
        const dx = o.x - car.x, dz = o.z - car.z;
        const fwd = dx * Math.cos(car.yaw) + dz * Math.sin(car.yaw);
        const lat = -dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
        if (fwd > 0 && fwd < TUNE.cars.aheadDist && Math.abs(lat) < 2.2) { aheadBlocked = true; break; }
      }
    }
    const targetSpeed = aheadBlocked ? 0 : car._speed;
    let speedScalar = car._curSpeed || 0;
    if (speedScalar < targetSpeed) speedScalar = Math.min(targetSpeed, speedScalar + 4 * dt);
    else speedScalar = Math.max(targetSpeed, speedScalar - 8 * dt);
    car._curSpeed = speedScalar;

    car._t += car._dir * speedScalar * dt;
    if (car._t > seg.len || car._t < 0) {
      const atEndPositive = car._t > seg.len;
      const next = pickNextSegment(world, (x, z) => `${Math.round(x * 100) / 100}:${Math.round(z * 100) / 100}`, car, seg, atEndPositive, rng);
      if (next) {
        car._segIdx = next.seg.segIdx; car._dir = next.dir; car._t = next.t;
        car._lateral = laneLateral(next.seg, next.dir);
      } else {
        car._dir *= -1;
        car._t = clamp(car._t, 0, seg.len);
      }
    }
    const s2 = world.segments[car._segIdx];
    const px = s2.x0 + s2.dx * car._t, pz = s2.z0 + s2.dz * car._t;
    car.x = px + s2.nx * car._lateral;
    car.z = pz + s2.nz * car._lateral;
    car.yaw = Math.atan2(s2.dz * car._dir, s2.dx * car._dir);
    car.vx = Math.cos(car.yaw) * speedScalar;
    car.vz = Math.sin(car.yaw) * speedScalar;
    car.hazard = aheadBlocked && car.kind !== 'fiaker';
  }
  // FEEL2 2026-10-14: 車が動いた後に歩行者と重なっていたら、歩行者を車の外へ押し出す。
  // stepPedestrians（歩行者が車を避ける）→ stepCars（車が動く）の順なので、動いた車が人の足元に入ると
  // そのステップの終わりでは重なっていた（全力走行の probe で 12 seed × 30 秒に 44〜46 回、全部 walk 状態）
  const pr = TUNE.pedestrian.radius + 0.05;
  for (const car of g.cars) {
    if (Math.abs(car.vx) + Math.abs(car.vz) < 1e-6 && !(car._knockedT > 0)) continue;
    for (const p of g.peds) {
      if (p.state === 'fly' || p.state === 'down') continue;
      const dx = p.x - car.x, dz = p.z - car.z;
      if (dx * dx + dz * dz > 36) continue;
      const res = circleVsOBB({ cx: p.x, cz: p.z, r: pr }, { cx: car.x, cz: car.z, yaw: car.yaw, hl: TUNE.cars.radiusLen, hw: TUNE.cars.radiusWid });
      if (res) { p.x += res.normal.x * res.depth; p.z += res.normal.z * res.depth; }
    }
  }
}

// ---------------------------------------------------------------------
// トラム
// ---------------------------------------------------------------------
export function createTrams(world) {
  const trams = [];
  if (world.tramLines.length === 0) return trams;
  for (let i = 0; i < TUNE.trams.count; i++) {
    const line = world.tramLines[i % world.tramLines.length];
    const phase = (i / TUNE.trams.count) * line.length;
    trams.push({ id: i, kind: 'tram', line, s: phase, dir: 1, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, hazard: false });
  }
  for (const tram of trams) placeTramAtS(tram);
  return trams;
}

function placeTramAtS(tram) {
  const pts = tram.line.pts;
  let remaining = clamp(tram.s, 0, tram.line.length);
  let idx = 0;
  while (idx < pts.length - 1) {
    const segLen = Math.hypot(pts[idx + 1].x - pts[idx].x, pts[idx + 1].z - pts[idx].z);
    if (remaining <= segLen || idx === pts.length - 2) {
      const t = segLen > 1e-6 ? remaining / segLen : 0;
      tram.x = pts[idx].x + (pts[idx + 1].x - pts[idx].x) * t;
      tram.z = pts[idx].z + (pts[idx + 1].z - pts[idx].z) * t;
      const dx = pts[idx + 1].x - pts[idx].x, dz = pts[idx + 1].z - pts[idx].z;
      tram.yaw = Math.atan2(dz * tram.dir, dx * tram.dir);
      tram.vx = Math.cos(tram.yaw) * TUNE.trams.speed;
      tram.vz = Math.sin(tram.yaw) * TUNE.trams.speed;
      return;
    }
    remaining -= segLen;
    idx++;
  }
}

export function stepTrams(g, dt) {
  for (const tram of g.trams) {
    tram.s += tram.dir * TUNE.trams.speed * dt;
    if (tram.s > tram.line.length) { tram.s = tram.line.length; tram.dir = -1; }
    if (tram.s < 0) { tram.s = 0; tram.dir = 1; }
    placeTramAtS(tram);
  }
}

// ---------------------------------------------------------------------
// 鳩
// ---------------------------------------------------------------------
export function createPigeonFlocks(world, rng) {
  const flocks = [];
  let id = 0;
  const kiosks = world.kiosks || [];
  const spots = world.plazas.length > 0 ? world.plazas : [{ rect: [[-50, -50], [50, 50]] }];
  for (let f = 0; f < TUNE.pigeons.flocks; f++) {
    let cx, cz;
    const k = kiosks[f % Math.max(1, kiosks.length)];
    if (k) {
      // 屋台の脇（大道芸人の反対側）4.5m: 人の集まる所に鳩が寄る絵
      const a = k.yaw - Math.PI / 2;
      cx = k.cx + Math.cos(a) * 4.5; cz = k.cz + Math.sin(a) * 4.5;
    } else {
      const spot = spots[f % spots.length];
      if (spot.rect) { cx = (spot.rect[0][0] + spot.rect[1][0]) / 2; cz = (spot.rect[0][1] + spot.rect[1][1]) / 2; }
      else { cx = spot.circle.c[0]; cz = spot.circle.c[1]; }
    }
    const n = TUNE.pigeons.perFlockMin + rng.int(0, TUNE.pigeons.perFlockMax - TUNE.pigeons.perFlockMin + 1);
    const birds = [];
    for (let i = 0; i < n; i++) {
      birds.push({ id: id++, x: cx + rng.range(-3, 3), z: cz + rng.range(-3, 3), y: 0, state: 'ground' });
    }
    flocks.push({ cx, cz, birds, flyT: 0 });
  }
  return flocks;
}

export function stepPigeons(g, dt) {
  const carrier = g.player.carriage;
  for (const flock of g.pigeonFlocks) {
    const flying = flock.birds[0] && flock.birds[0].state === 'fly';
    if (!flying) {
      const d = Math.hypot(carrier.x - flock.cx, carrier.z - flock.cz);
      if (d < TUNE.pigeons.triggerDist) {
        for (const b of flock.birds) { b.state = 'fly'; b.y = 0.3; }
        flock.flyT = 0;
        g.events.push({ type: 'pigeons', x: flock.cx, z: flock.cz, n: flock.birds.length });
      }
    } else {
      flock.flyT += dt;
      for (const b of flock.birds) b.y = Math.min(8, b.y + dt * 6);
      if (flock.flyT > TUNE.pigeons.returnTime) {
        for (const b of flock.birds) { b.state = 'ground'; b.y = 0; }
      }
    }
  }
  // g.pigeons はレンダー向けのフラットな配列（ARCHITECTURE の g.pigeons 形）
  const out = [];
  for (const flock of g.pigeonFlocks) for (const b of flock.birds) out.push(b);
  return out;
}
