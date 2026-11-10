// sim/tune.js — 調整用定数を1つにまとめる（DV.TUNE 相当）。
// ARCHITECTURE.md のファイル一覧には無いが、carriage/collide/actors/game/bot が
// 循環 import なしに同じ定数を読めるよう独立ファイルにした（既定からの逸脱。SIM_REPORT.md に記載）。

export const TUNE = {
  FIXED_DT: 1 / 120,

  // 馬車（チーム=馬2頭 + 馬車、トレーラー連結）
  team: { len: 2.6, wid: 1.6, mass: 1200 },
  carriage: { len: 2.8, wid: 1.6, mass: 600, hitchL: 3.0 },

  // 歩様 [停止, 並足, 速足, 駆け足, 全力] の代表速度 m/s（bot が「この歩様まで」と言うときの目標。最後 = 最高速）
  // 2026-10-14 挙動担当: 全力 13→17 m/s（61 km/h）。歩様ギアで速度を段付きに上げる方式をやめ、アクセル式（下の accel*）にした
  gaits: [0, 1.8, 4.5, 8.5, 17.0],
  gaitNames: ['stop', 'walk', 'trot', 'canter', 'gallop'],
  speedMax: 17.0,
  // 表示・音の歩様は速さから決める: この速さ以上で [停止, 並足, 速足, 駆け足, 全力]。下がるときは gaitHysteresis 分だけ粘る
  gaitThresholds: [0, 0.3, 3.0, 6.5, 12.0],
  gaitHysteresis: 0.6,
  gaitMax: 4,
  // 上を押している間の加速度: accelPeak × (1 − (v/speedMax)^accelCurve)、ただし accelFloor 以上
  // 0 m/s で 5.5、8.5 で 3.6、13 で 1.8、16 で 0.6（低速で力強く、高速で伸びが鈍る）
  accelPeak: 5.5,
  accelCurve: 1.5,
  accelFloor: 0.6,
  coastDecel: 0.9,     // 放したときの自然減速 m/s²（全力から止まるまで 19 秒。角で 1 秒放しても 1 m/s しか落ちない）
  brakeSoft: 3.0,      // 手綱の踏み始め m/s²
  brakeHard: 9.0,      // 押し続けたときの最大 m/s²（safety.decelThresh より下。普通の手綱は罰しない）
  brakeRampTime: 0.7,  // 踏み始めから最大まで（秒）
  reverseSpeed: 1.2,
  reverseAccel: 1.5,
  reverseHoldTime: 0.25, // 止まってから後退に入るまで押し続ける秒数（止めたいだけのときに勝手に下がらない）
  reverseAlignSpeed: 2.5, // 後退中に馬車の折れ角が戻る速さの下限（m/s 換算。時定数 hitchL/2.5 = 1.2 秒）
  // 馬車（トレーラー）が理想の位置へ戻る時定数（秒）。小さいほど硬い。横は慣性で振られた分がこの時定数で収束する
  hitchSettleTime: 0.05,
  hitchAccelMax: 20,
  lateralSettleTime: 0.25,

  // 曲がり: 最大ヨー角速度 rad/s。停止〜並足(gaitSpeed=0) で 1.5、全力(17 m/s)で 0.75 に速さで補間（全力の旋回半径 23m）
  yawRateAtRest: 1.5,
  yawRateAtFull: 0.75,
  yawRateRefSpeed: 17.0,
  // ハンドルの効き始め・戻りのランプ時間(秒)。2026-10-03 主ループ: 直進中にタッチの微小ジッタ（手の震え相当）があると
  // steer が即座に最大角速度へ飛んでいた（計測: tests/_flicker_steer.html で 8Hz ジッタ→320回/10秒フリップ、yaw が
  // 0.05rad 振れ、sim 直結のワーストケースでは 0.34rad まで振れた）。0.15〜0.25秒の一次遅れで滑らかにする
  steerRampTime: 0.2,

  // 横グリップ: 超えると滑る（m/s^2）
  lateralGripNormal: 6,
  lateralGripHand: 1.5,

  // 到着判定
  arrival: {
    rectLen: 8,
    rectWid: 4,
    speedMax: 2.5,
    driftWindow: 1.5,
    driftSpeedThresh: 2.0,
    driftMultiplier: 1.5,
  },

  // シフト
  parSpeed: 5, // 採点の基準速度 m/s（主ループ 2026-10-02）
  shift: {
    time: 180, // 150→180 主ループ 2026-10-02（1シフトで運べる件数を増やす）
    bonusBase: 20,
    bonusDecay: 0.85,
  },

  // 安全度（お客さんの気分）係数。GAME_DESIGN §5 は「超えた分×時間」とだけ指定、
  // 係数自体は主ループ(このファイル)の担当として決めた値。SIM_REPORT.md に根拠を書く。
  safety: {
    latGThresh: 3.5,
    latGCoef: 2.5,     // 安全度/秒 を 横G超過1 m/s^2 あたり（初期値6は全力コーナーで2〜3秒で0に張り付いたため緩めた。根拠はSIM_REPORT.md）
    decelThresh: 9.5, // 5→7.5 主ループ 2026-10-02 / 7.5→9.5 挙動担当 2026-10-14: 手綱の最大(brakeHard 9)を罰しない。急停止・衝突だけを罰する
    decelCoef: 2.5,     // 安全度/秒 を 減速超過1 m/s^2 あたり
    driftCoef: 1.5,       // 安全度/秒 をドリフト中ずっと
    collisionCoef: 1.2,  // 安全度 を 衝突速度(m/s) 1 あたり（通常物）
    bigCollisionMult: 3, // 建物・トラム・ボラードはこの倍率
    pedHitPenalty: 8,    // 歩行者に直撃した時の一撃
    curbPenalty: 4,      // 段差・縁石乗り上げ 1回ごと
  },

  // 吹っ飛び
  launch: {
    speedThresh: 2,
    vyMult: 0.6,
    vyCap: 9,
    gravity: 9.8 * 1.6,
    bounce: 0.35,
    airborneHeight: 0.6,
  },

  // 衝突の重さ（跳ね返り・速度ロス）
  collide: {
    restitution: 0.35,
    carrierSpeedLossMult: 0.55, // 衝突で馬車速度が落ちる割合
  },

  pedestrian: {
    count: [46, 52],      // 賑わい 2026-10-03: 馬車の周り 120m に 25〜40 人を保つ（遠い人を近くの見えない所へ出し直す）
    nearRadius: 120,      // 「近く」の半径
    nearMin: 32,          // 近くの人数がこれを割ったら出し直す
    nearMax: 42,          // これ以上は出し直さない
    farRadius: 165,       // これより遠い人が出し直しの候補
    spawnMin: 45, spawnMax: 130, // 出し直す距離
    unseenAngle: 1.45,    // 近く(95m未満)に出すときは進行方向からこの角度(rad)以上外れた所＝カメラの外
    recycleEvery: 0.5,    // 秒
    idleChance: 0.025,    // 歩行者が毎秒この確率で立ち止まる／店を覗く
    pairRatio: 0.3,       // 2人連れの割合
    sitRatio: 0.3,        // 出し直すときカフェの席があればこの確率で座る
    radius: 0.25,
    walkSpeed: 1.3,
    sidewalkWidth: 3.5,
    furnitureBand: 1.6,    // FEEL2 2026-10-14: 広い歩道（5m 以上）で歩行者が歩き始める縁石からの距離。縁石側 1.4m は家具帯（広告塔・花壇・キオスク・街灯）
    dodgePredictTime: 1.6, // 主ループ 2026-10-05: 1.0→1.6（人が増えて、速足でも避けきれず当たっていた）
    dodgeSpeedThresh: 9,
    clipBonusSpeedThresh: 6,
    clipBonusAmount: 50,
    carriageNearDist: 15,
    downTime: 1.2,
    angryTime: 1.0,
    leaveSpeed: 1.2,
  },

  cars: {
    count: [16, 20],
    fiakers: 4,           // 賑わい 2026-10-03: うち何台が他のフィアカー（馬車）か。遅い（下の fiakerSpeed）
    fiakerSpeed: [2.6, 3.4],
    nearRadius: 150, nearMin: 9, farRadius: 240, spawnMin: 45, spawnMax: 200, recycleEvery: 0.7, // 主ループ 2026-10-05: nearMin 7→9, spawnMin 70→45 // 馬車の周りに出し直す
    speedMin: 8,
    speedMax: 11,
    aheadDist: 12,
    radiusLen: 2.2,
    radiusWid: 0.95,
    mass: 1300,
    collideMass: 450, // 主ループ 2026-10-14: 馬車との衝突の計算だけで使う重さ（気持ちよく蹴散らす）
  },

  trams: {
    speed: 9,
    count: 2,
    len: 17, hw: 1.2,
  },

  pigeons: {
    flocks: 5,            // 賑わい 2026-10-03: 広場ごとに 1 群（描画は 64 羽まで）
    perFlockMin: 8,
    perFlockMax: 12,
    triggerDist: 8,
    returnTime: 20,
  },

  props: {
    total: [120, 180],
    price: {
      chair: 30, table: 60, pot: 40, bike: 80,
      adColumn: 300, stand: 120, bollard: 0,
      parasol: 90, trash: 40, // 賑わい 2026-10-03: カフェのパラソル・オレンジのゴミ箱
    },
  },

  damage: {
    ped: 200,
    pedGraze: 50,
    parkedCarPerSpeed: 8,
    tramPerSpeed: 24,
  },
};
