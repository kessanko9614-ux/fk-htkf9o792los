// sim/carriage.js — 馬(チーム)＋馬車の物理（連結）。
// g.player.horse = チーム(馬2頭をまとめた1剛体)。g.player.carriage = 馬車(トレーラー)。
// トレーラーの運動学 carriageYawRate = (v/L) * sin(teamYaw - carriageYaw) をベースに、
// 横方向だけ「グリップ上限で目標横速度へ近づく」形で横滑りを足す（決め方は SIM_REPORT.md に記載）。

import { TUNE } from './tune.js';

function normalizeAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function approach(cur, target, maxDelta) {
  const d = target - cur;
  if (d > maxDelta) return cur + maxDelta;
  if (d < -maxDelta) return cur - maxDelta;
  return target;
}

export function createCarriageRig(x, z, yaw) {
  const hitchSetback = TUNE.team.len / 2 + TUNE.carriage.hitchL;
  return {
    horse: { x, z, yaw, vx: 0, vz: 0, gait: 0, phase: 0, _speed: 0, _gaitHoldT: 0, _upWasHeld: false, _downWasHeld: false, _steer: 0 },
    carriage: {
      x: x - Math.cos(yaw) * hitchSetback, z: z - Math.sin(yaw) * hitchSetback, yaw,
      vx: 0, vz: 0, yawRate: 0, slip: 0, airborne: 0, wheelSpin: 0,
      _vF: 0, _vL: 0, onSidewalk: false,
    },
    speed: 0, lateralG: 0, longG: 0,
  };
}

// input: {up,down,left,right,hand}（そのフレームで押されているか）
// 戻り値: { driftActive, crossedCurb? } — 安全度計算用のフラグ
export function stepCarriageRig(player, input, dt) {
  const horse = player.horse, carriage = player.carriage;
  const T = TUNE;

  // --- チームの前後速度（2026-10-14 挙動担当: 歩様ギアの段付き加速をやめ、アクセル式にした。FEEL_REPORT.md）---
  // 上を押している間: 低速で力強く・高速で伸びが鈍る加速（a = accelPeak × (1 − (v/vmax)^accelCurve)、下限 accelFloor）
  // 放す: 緩やかに減速（coastDecel）。下: 手綱。踏み始め brakeSoft から brakeRampTime 秒で brakeHard へ強まる。
  // 止まったら reverseHoldTime 秒だけ止まり、押し続けていれば後退（reverseSpeed）
  const upHeld = !!input.up, downHeld = !!input.down;
  const upEdge = upHeld && !horse._upWasHeld;
  horse._upWasHeld = upHeld;
  horse._downWasHeld = downHeld;
  let speed = horse._speed;
  const vmax = T.speedMax;
  if (downHeld) {
    horse._brakeT = (horse._brakeT || 0) + dt;
    if (speed > 0) {
      const ramp = Math.min(1, horse._brakeT / T.brakeRampTime);
      const b = T.brakeSoft + (T.brakeHard - T.brakeSoft) * ramp;
      speed = Math.max(0, speed - b * dt);
      if (speed === 0) horse._stopT = 0;
    } else {
      horse._stopT = (horse._stopT || 0) + dt;
      if (horse._stopT >= T.reverseHoldTime) speed = Math.max(-T.reverseSpeed, speed - T.reverseAccel * dt);
    }
  } else {
    horse._brakeT = 0; horse._stopT = 0;
    if (speed < 0) {
      speed = Math.min(0, speed + T.reverseAccel * dt);
    } else if (upHeld) {
      const frac = Math.min(1, speed / vmax);
      const a = Math.max(T.accelFloor, T.accelPeak * (1 - Math.pow(frac, T.accelCurve)));
      speed = Math.min(vmax, speed + a * dt);
    } else {
      speed = Math.max(0, speed - T.coastDecel * dt);
    }
  }
  horse._speed = speed;

  // --- 歩様（表示・音・bot 用）: 速さから決める。閾値にヒステリシスを持たせて境目でちらつかせない ---
  {
    const th = T.gaitThresholds, hys = T.gaitHysteresis;
    let gait = horse.gait || 0;
    const v = Math.abs(speed);
    while (gait < T.gaitMax && v >= th[gait + 1]) gait++;
    while (gait > 0 && v < th[gait] - hys) gait--;
    horse.gait = gait;
  }

  // --- チームの向き ---
  // 2026-10-02 主ループ: steer（ボタンの on/off）をそのまま角速度に使うと、入力が一瞬フリップするだけで
  // 最大角速度に飛ぶ（測定: tests/_flicker_steer.html）。切り始め・戻しを steerRampTime 秒の一次遅れにする
  const steerTarget = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const steerMaxDelta = T.steerRampTime > 0 ? dt / T.steerRampTime : Infinity;
  horse._steer = approach(horse._steer ?? 0, steerTarget, steerMaxDelta);
  const speedFrac = Math.max(0, Math.min(1, Math.abs(speed) / T.yawRateRefSpeed));
  const yawRateMax = T.yawRateAtRest + (T.yawRateAtFull - T.yawRateAtRest) * speedFrac;
  const teamYawRate = horse._steer * yawRateMax * (speed < 0 ? -1 : 1);
  horse.yaw = normalizeAngle(horse.yaw + teamYawRate * dt);
  horse.vx = Math.cos(horse.yaw) * speed;
  horse.vz = Math.sin(horse.yaw) * speed;
  horse.x += horse.vx * dt;
  horse.z += horse.vz * dt;
  horse.phase = (horse.phase + (Math.abs(speed) / 2.2) * dt) % 1;

  // --- 馬車(トレーラー)の運動学 + 横滑り ---
  const hitchX = horse.x - Math.cos(horse.yaw) * (T.team.len / 2);
  const hitchZ = horse.z - Math.sin(horse.yaw) * (T.team.len / 2);
  const L = T.carriage.hitchL;
  // 2026-10-14 挙動担当: 後退中は本来のトレーラー運動学だと折れ角が発散する（ジャックナイフ。計測: 後退 6.6 秒で 0.04→0.58 rad）。
  // ゲームでは後退は数mの切り返しなので、後退中は「押される荷車」として折れ角が戻る向きにする
  const bend = normalizeAngle(horse.yaw - carriage.yaw);
  carriage.yawRate = ((speed < 0 ? Math.max(-speed, T.reverseAlignSpeed) : speed) / L) * Math.sin(bend);
  carriage.yaw = normalizeAngle(carriage.yaw + carriage.yawRate * dt);

  const kinCx = hitchX - Math.cos(carriage.yaw) * L;
  const kinCz = hitchZ - Math.sin(carriage.yaw) * L;
  // 2026-10-14 挙動担当: 以前は目標速度 = (理想位置 − 今の位置) ÷ dt（1/120 秒で追いつけという高ゲイン）を、横は grip の
  // 加速度上限で追っていた。ズレが大きいと上限いっぱいで行き過ぎ→戻り過ぎの減衰しないリレー振動になる（計測: サイドブレーキ後に
  // _vL が ±1.4〜2.1 m/s で 6 秒以上、符号反転 10 回）。理想位置の速度 u に「ズレ ÷ 時定数」を足す形（一次遅れ）に変えた。
  // ズレは指数関数で収束し、行き過ぎない。慣性（カーブで外へ振られる）は grip の上限で残る
  const hasKin = carriage._kinX !== undefined;
  const uX = hasKin && dt > 1e-6 ? (kinCx - carriage._kinX) / dt : 0;
  const uZ = hasKin && dt > 1e-6 ? (kinCz - carriage._kinZ) / dt : 0;
  carriage._kinX = kinCx; carriage._kinZ = kinCz;
  const eX = kinCx - carriage.x, eZ = kinCz - carriage.z;

  const cf = Math.cos(carriage.yaw), sf = Math.sin(carriage.yaw);
  // forward軸=(cf,sf) lateral軸=(-sf,cf)
  const forwardTarget = (uX * cf + uZ * sf) + (eX * cf + eZ * sf) / T.hitchSettleTime;
  const lateralTarget = (uX * -sf + uZ * cf) + (eX * -sf + eZ * cf) / T.lateralSettleTime;

  const grip = input.hand ? T.lateralGripHand : T.lateralGripNormal;
  carriage._vF = approach(carriage._vF, forwardTarget, T.hitchAccelMax * dt);
  carriage._vL = approach(carriage._vL, lateralTarget, grip * dt);

  const prevVF = carriage.__prevVF !== undefined ? carriage.__prevVF : carriage._vF;
  const longG = dt > 1e-6 ? (carriage._vF - prevVF) / dt : 0;
  const lateralG = carriage.yawRate * carriage._vF;
  carriage.__prevVF = carriage._vF;

  carriage.vx = carriage._vF * cf + carriage._vL * -sf;
  carriage.vz = carriage._vF * sf + carriage._vL * cf;
  carriage.x += carriage.vx * dt;
  carriage.z += carriage.vz * dt;
  carriage.slip = Math.abs(carriage._vL);
  carriage.wheelSpin = (carriage.wheelSpin + (carriage._vF / 0.5) * dt) % (Math.PI * 2);

  player.speed = Math.hypot(carriage.vx, carriage.vz);
  player.lateralG = lateralG;
  player.longG = longG;

  // 2026-10-02 主ループ: サイドブレーキ中だけをドリフトとする。以前は普通のカーブの横流れ（>1.2 m/s）も
  // ドリフトと数え、慎重運転の bot でも安全度が 100→0〜37 に落ちていた（原因別集計: ドリフト扱い −77〜−150）
  const driftActive = !!input.hand && Math.abs(carriage._vL) > 1.0;
  return { driftActive, gaitChanged: upEdge };
}

export function teamBox(horse) {
  return { cx: horse.x, cz: horse.z, yaw: horse.yaw, hl: TUNE.team.len / 2, hw: TUNE.team.wid / 2, mass: TUNE.team.mass };
}
export function carriageBox(carriage) {
  return { cx: carriage.x, cz: carriage.z, yaw: carriage.yaw, hl: TUNE.carriage.len / 2, hw: TUNE.carriage.wid / 2, mass: TUNE.carriage.mass };
}
