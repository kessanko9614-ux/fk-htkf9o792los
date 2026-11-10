// render/camera.js — 追従カメラ（馬車の後ろ上。バネで遅れて追う。速さで FOV 60→78。全力で細かい揺れ）
//
//   const follow = createFollowCamera(camera);
//   follow.setWorld(g.world)                  // 建物の当たり（OBB・円）を読んで、カメラが壁の中に入らないようにする
//   follow.snap(player)                       // 初期化・リトライ時に即座に合わせる
//   follow.update(dt, player, { shake })      // 毎フレーム。shake は fx.js の { x, y, z, roll }
//
// player = g.player（carriage.x/z/yaw, speed, lateralG）。yaw は forward = (cos yaw, sin yaw)。

import * as THREE from 'three';

export const CAM = {
  // 主ループ 2026-10-02: 高さ 3.2m では馬車（約2.5m）と御者の陰に馬2頭が隠れていた → 高く・少し引いて・馬の先を見る
  dist: 9.0, height: 5.2, lookAhead: 9.0, lookHeight: 1.0,
  stiffness: 7.0, dampingRatio: 0.85,
  heightStiffness: 4.0,
  // 2026-10-14 見た目: 走りの担当が最高速を 13→17.0 m/s（61 km/h）に確定。FOV と揺れの基準を 17 m/s にする（13 で 78° に張り付かない）
  fovBase: 60, fovMax: 78, maxSpeed: 17.0,
  // 2026-10-03 主ループ: 1.8°/(m/s²) を lateralG に毎フレーム即掛けしていたため、通常のコーナリング（横G 3〜5 m/s²）でも
  // 5〜9° 傾き、さらに lateralG 自体の1フレームごとのノイズがそのままカメラの傾きのブレになっていた
  // （「馬車が左右揺れてる」の一因。sim/carriage.js の横滑り計算が低速域で振動する既知の問題と合わさると特に目立つ。
  // 詳細は CONTROLS_REPORT.md）。控えめ（最大2〜3°）にし、傾き自体も時間でなめらかにする
  rollPerG: 0.6,            // 横 G 1 m/s² あたりの傾き（度）
  rollMaxDeg: 3.0,          // 傾きの上限（度）
  rollSmoothTime: 0.15,     // 傾きのなめらかさ（秒、一次遅れ）
  shakeAmp: 0,              // FIX3 2026-10-14: 全力時の常時揺れは廃止（「上下に振り子現象」）。外部シェイク（fx.js）だけ残す
  // 2026-10-14 見た目（天才さん「建物スレスレにいる時中が透けて見える」）: 馬車→カメラの線が建物の壁を横切るなら、
  // 壁の手前（馬車側）までカメラを寄せる。near 面（0.6m）が壁を切らないよう、壁から wallMargin 離す。
  // 寄せるのは速く（壁に入る前に）、戻すのはゆっくり（バネ的に）。横に ±sideProbe の線も調べ、near 面の横幅（約 ±1.1m）が壁に掛からないようにする
  wallMargin: 0.9,
  sideProbe: 1.0,
  minDist: 3.2,             // これ以上は寄せない（馬車に埋まる）
  pullInTime: 0.04,         // 寄せる時定数（秒）
  releaseTime: 0.45,        // 戻す時定数（秒）
  // 2026-10-14 見た目 第2回: 壁に背を向けて壁のすぐそば（2.5m）にいると、寄せても minDist で止まり 0.1〜0.7m 壁に入っていた（VISUAL_REPORT §1）。
  // 寄せきれない時はカメラを馬車の周りに横へ回す（15° 刻みで最大 sideMaxDeg、壁が無い側）。回すのは sideInTime、戻すのは sideOutTime
  sideStepDeg: 15, sideMaxDeg: 75, sideClear: 1.5, sideInTime: 0.12, sideOutTime: 0.6,
};

export function createFollowCamera(camera, opts = {}) {
  const P = { ...CAM, ...opts };
  const pos = new THREE.Vector3(), vel = new THREE.Vector3();
  const target = new THREE.Vector3(), look = new THREE.Vector3(), fwd = new THREE.Vector3();
  const smoothYaw = { v: 0, init: false };
  let t = 0, fov = P.fovBase, rollShown = 0;
  // 建物の当たり（sim の g.world.buildings: {type:'box',cx,cz,yaw,hl,hw} / {type:'circle',cx,cz,r}）。kind が building/landmark のものだけ
  let walls = [];
  let pulled = 0;          // 現在どれだけ寄せているか（m、0 = 寄せていない）
  const shown = new THREE.Vector3();

  function setWorld(world) {
    // ランドマークの当たり（kind 'landmark'）は外す: シュテファン大聖堂の箱は広場の出発点まで覆っていて、出発直後にカメラが馬車に貼り付いた（shots/visual/compare_floor_t4.00.png 右）
    walls = (world?.buildings || []).filter((b) => b.kind === 'building').map((b) => {
      if (b.type === 'box') return { box: true, cx: b.cx, cz: b.cz, c: Math.cos(b.yaw || 0), s: Math.sin(b.yaw || 0), hl: b.hl, hw: b.hw, br: Math.hypot(b.hl, b.hw) };
      return { box: false, cx: b.cx, cz: b.cz, r: b.r, br: b.r };
    });
  }

  // 線分 A→B（2D）と壁の最初の交点のパラメータ t（0..1）。交わらなければ 1
  function firstHit(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 1e-4) return 1;
    let best = 1;
    const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5, half = len * 0.5;
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      // 広域: 線分の中点から br + half 以内だけ
      const ddx = w.cx - mx, ddz = w.cz - mz;
      if (ddx * ddx + ddz * ddz > (w.br + half) * (w.br + half)) continue;
      if (w.box) {
        // 箱ローカル（u: 長さ hl の向き、v: 直交）へ
        const lx = ax - w.cx, lz = az - w.cz;
        const ou = lx * w.c + lz * w.s, ov = -lx * w.s + lz * w.c;
        const du = dx * w.c + dz * w.s, dv = -dx * w.s + dz * w.c;
        let t0 = 0, t1 = 1;
        // スラブ u
        if (Math.abs(du) < 1e-6) { if (Math.abs(ou) > w.hl) continue; }
        else { let ta = (-w.hl - ou) / du, tb = (w.hl - ou) / du; if (ta > tb) [ta, tb] = [tb, ta]; t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); }
        if (Math.abs(dv) < 1e-6) { if (Math.abs(ov) > w.hw) continue; }
        else { let ta = (-w.hw - ov) / dv, tb = (w.hw - ov) / dv; if (ta > tb) [ta, tb] = [tb, ta]; t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); }
        if (t0 <= t1 && t0 < best) best = Math.max(0, t0);
      } else {
        // 円: |A + t d - C|² = r²
        const fx = ax - w.cx, fz = az - w.cz;
        const a = dx * dx + dz * dz, b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - w.r * w.r;
        const disc = b * b - 4 * a * c; if (disc < 0) continue;
        const tt = (-b - Math.sqrt(disc)) / (2 * a);
        if (tt >= 0 && tt <= 1 && tt < best) best = tt;
      }
    }
    return best;
  }

  // 馬車の少し上（1.2m）から pos へ向かう線（と左右 ±sideProbe の線）が壁に当たるなら、当たる手前までの距離を返す
  function allowedDist(c, p) {
    const dx = p.x - c.x, dz = p.z - c.z, len = Math.hypot(dx, dz);
    if (len < 1e-3 || walls.length === 0) return len;
    const nx = dx / len, nz = dz / len, rx = -nz, rz = nx;   // 右向き
    let tmin = firstHit(c.x, c.z, p.x, p.z);
    tmin = Math.min(tmin, firstHit(c.x, c.z, p.x + rx * P.sideProbe, p.z + rz * P.sideProbe));
    tmin = Math.min(tmin, firstHit(c.x, c.z, p.x - rx * P.sideProbe, p.z - rz * P.sideProbe));
    if (tmin >= 1) return len;
    return Math.max(P.minDist, tmin * len - P.wallMargin);
  }
  // 同じ判定で、minDist で切らない生の距離（横へ回す判断に使う）
  function rawAllowed(c, px, pz) {
    const dx = px - c.x, dz = pz - c.z, len = Math.hypot(dx, dz);
    if (len < 1e-3 || walls.length === 0) return len;
    const nx = dx / len, nz = dz / len, rx = -nz, rz = nx;
    let tmin = firstHit(c.x, c.z, px, pz);
    tmin = Math.min(tmin, firstHit(c.x, c.z, px + rx * P.sideProbe, pz + rz * P.sideProbe));
    tmin = Math.min(tmin, firstHit(c.x, c.z, px - rx * P.sideProbe, pz - rz * P.sideProbe));
    return tmin >= 1 ? len : tmin * len - P.wallMargin;
  }
  let sideAng = 0;   // 現在の横逃げ角（rad、0 = 真後ろ）
  const _q = new THREE.Vector3();
  // 寄せても minDist に届かない時、馬車の周りに回して壁の無い向きを探す。返り値は回した後のカメラ位置（_q）
  function sideStep(c, p, dt) {
    const dx = p.x - c.x, dz = p.z - c.z, len = Math.hypot(dx, dz);
    let want = 0;
    if (len > 1e-3 && walls.length && rawAllowed(c, p.x, p.z) < P.minDist) {
      const base = Math.atan2(dz, dx), step = THREE.MathUtils.degToRad(P.sideStepDeg), need = Math.min(len, P.minDist + P.sideClear);
      const first = sideAng < 0 ? -1 : 1;   // いま回している側を先に試す（左右でパタパタしない）
      outer: for (let k = 1; k * P.sideStepDeg <= P.sideMaxDeg; k++) for (const sgn of [first, -first]) {
        const a = base + sgn * k * step;
        if (rawAllowed(c, c.x + Math.cos(a) * len, c.z + Math.sin(a) * len) >= need) { want = sgn * k * step; break outer; }
      }
      if (want === 0) want = sideAng;   // 見つからなければ今の角を保つ
    }
    const tau = Math.abs(want) > Math.abs(sideAng) ? P.sideInTime : P.sideOutTime;
    sideAng += (want - sideAng) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 1);
    const a = Math.atan2(dz, dx) + sideAng;
    return _q.set(c.x + Math.cos(a) * len, p.y, c.z + Math.sin(a) * len);
  }

  function forwardOf(yaw) { return fwd.set(Math.cos(yaw), 0, Math.sin(yaw)); }

  function idealPos(player, out) {
    const c = player.carriage;
    // 向きは少し遅らせる（急な切り返しでカメラが振り回されない）
    if (!smoothYaw.init) { smoothYaw.v = c.yaw; smoothYaw.init = true; }
    let d = c.yaw - smoothYaw.v; d = Math.atan2(Math.sin(d), Math.cos(d));
    smoothYaw.v += d * 0.5;
    forwardOf(smoothYaw.v);
    out.set(c.x, 0, c.z).addScaledVector(fwd, -P.dist); out.y = P.height;
    return out;
  }

  function snap(player) {
    smoothYaw.init = false;
    rollShown = 0; pulled = 0; sideAng = 0;
    idealPos(player, pos); vel.set(0, 0, 0); update._prev = null;
    apply(player, null, 0);
  }

  function apply(player, shake, dt) {
    const c = player.carriage;
    // 壁の手前へ寄せる（寄せるのは速く、戻すのはゆっくり）
    const q = sideStep(c, pos, dt);   // 寄せきれない時は横へ回す（バネの pos 自体は変えない）
    const dx = q.x - c.x, dz = q.z - c.z, len = Math.hypot(dx, dz);
    const allowed = allowedDist(c, q);
    const wantPull = Math.max(0, len - allowed);
    const tau = wantPull > pulled ? P.pullInTime : P.releaseTime;
    pulled += (wantPull - pulled) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 1);
    if (pulled > wantPull) pulled = wantPull;  // 戻しの途中でも壁の中には入らない
    const k = len > 1e-3 ? (len - pulled) / len : 1;
    shown.set(c.x + dx * k, pos.y, c.z + dz * k);
    camera.position.copy(shown);
    // FIX3 2026-10-14（天才さん「上下に振り子現象が起きる」）: 全力時に正弦波 3 本（11.3・7.1 rad/s = 周期 0.56・0.88 秒、
    // 合計 ±4〜5cm）をカメラの y に足し続けていた。注視点は固定の高さなので、カメラが 9cm 上下するたびに画面全体が
    // ±0.2〜0.4° うなずき、走っている間ずっと止まらない（計測: tests/_fix3_bob.py、全力で 9.2cm / 周期 0.33〜0.5 秒）。
    // 正弦波の常時揺れはやめる。残すのは衝突・到着の外部シェイク（fx.js、0.6 秒以内に減衰）と高さのバネ（臨界減衰）だけ
    const r = THREE.MathUtils.clamp((player.speed || 0) / P.maxSpeed, 0, 1);
    if (shake) { camera.position.x += shake.x || 0; camera.position.y += shake.y || 0; camera.position.z += shake.z || 0; }
    forwardOf(c.yaw);
    look.set(c.x, P.lookHeight, c.z).addScaledVector(fwd, P.lookAhead);
    camera.lookAt(look);
    // 傾きはなめらかに追従させ、上限で切る（lateralG の1フレームごとのノイズがそのままカメラの揺れになるのを防ぐ）
    const rollTargetDeg = THREE.MathUtils.clamp(-(player.lateralG || 0) * P.rollPerG, -P.rollMaxDeg, P.rollMaxDeg);
    const rollAlpha = dt > 0 ? 1 - Math.exp(-dt / P.rollSmoothTime) : 1;
    rollShown += (rollTargetDeg - rollShown) * rollAlpha;
    const roll = THREE.MathUtils.degToRad(rollShown) + (shake?.roll || 0);
    camera.rotateZ(roll);
    // FOV は速さの 2 乗で効かせる
    const fovTarget = THREE.MathUtils.lerp(P.fovBase, P.fovMax, r * r);
    fov += (fovTarget - fov) * (dt > 0 ? 1 - Math.exp(-4 * dt) : 1);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  function update(dt, player, { shake = null } = {}) {
    dt = Math.min(dt, 1 / 30);
    t += dt;
    idealPos(player, target);
    // 主ループ 2026-10-02: 減衰を「目標の速さとの差」にかける。以前はカメラ自身の速さにかけていたため、
    // 一定速度で走るあいだ速さに比例した遅れが残り（全力 13 m/s で約 8m）、馬車が遠くに小さく見えていた
    if (!update._prev) update._prev = target.clone();
    const tvx = dt > 0 ? (target.x - update._prev.x) / dt : 0, tvz = dt > 0 ? (target.z - update._prev.z) / dt : 0;
    update._prev.copy(target);
    const k = P.stiffness, cdamp = 2 * Math.sqrt(k) * P.dampingRatio;
    // 水平はバネ、高さは別の弱いバネ（段差で柔らかく）
    const ax = (target.x - pos.x) * k - (vel.x - tvx) * cdamp;
    const az = (target.z - pos.z) * k - (vel.z - tvz) * cdamp;
    // FIX3: 高さは臨界減衰（ζ=1）。行き過ぎず 1 秒以内に収まる
    const ay = (target.y - pos.y) * P.heightStiffness - vel.y * 2 * Math.sqrt(P.heightStiffness);
    vel.x += ax * dt; vel.z += az * dt; vel.y += ay * dt;
    pos.addScaledVector(vel, dt);
    apply(player, shake, dt);
  }

  return { update, snap, setWorld, params: P, pos, get pulled() { return pulled; }, get sideDeg() { return THREE.MathUtils.radToDeg(sideAng); }, firstHit, allowedDist };
}
