// main.js — sim（sim/game.js）と描画（render/）・HUD・入力・音をつなぐ本番のループ
//   固定ステップ 1/120 のアキュムレータ、fx の timeScale（ヒットストップ/スロー）、R でリトライ、シフト終了のリザルト
//   URL: ?seed=<文字列>（既定は今日の YYYYMMDD） ?q=high|mid|low  ?t=<秒>（同期撮影。rAF 無し） ?bot=careful|fast|reckless（自動運転・検証用）
import * as THREE from 'three';
import { TUNE } from './sim/tune.js';
import { createGame, step } from './sim/game.js';
import { createRenderer } from './render/renderer.js';
import { loadCityAssets, buildCity, worldFromSim } from './render/city.js';
import { loadActorAssets, createCarriage, createPedestrian, createCar } from './render/actors3d.js';
import { createProps } from './render/props3d.js';
import { createFollowCamera } from './render/camera.js';
import { createGuide } from './render/guide3d.js';
import { createFX } from './render/fx.js';
import { createHUD } from './ui/hud.js';
import { createInput } from './ui/input.js';
import { createAudio } from './ui/audio.js';

const params = new URLSearchParams(location.search);
const SHOT_T = params.has('t') ? parseFloat(params.get('t')) : null;
// 主ループ 2026-10-03: スマホは「低」から始める（「中」でも半精度・MSAA4 のバッファと影を確保し、スマホで開けなかった疑い）。
// iPad はパソコンの UA を名乗るのでタッチ点数で拾う。足りていれば自動で上げることはしない（落ちるより確実に開く）
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
const QUALITY = params.get('q') || (IS_MOBILE ? 'mobile' : (navigator.hardwareConcurrency <= 4 ? 'mid' : 'high'));
const BOT = params.get('bot');
const todaySeed = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const SEED = params.get('seed') || todaySeed();

const canvas = document.getElementById('view');
const hudRoot = document.getElementById('hud');
const VW = () => canvas.clientWidth || innerWidth, VH = () => canvas.clientHeight || innerHeight;
const R = createRenderer({ canvas, quality: QUALITY, autoQuality: SHOT_T == null, width: VW(), height: VH(), preserveDrawingBuffer: SHOT_T != null });
const _v = new THREE.Vector3();
const hud = createHUD(hudRoot, { project: (x, y, z) => { _v.set(x, y, z).project(R.camera); return { sx: (_v.x * 0.5 + 0.5) * VW(), sy: (-_v.y * 0.5 + 0.5) * VH(), visible: _v.z < 1 && Math.abs(_v.x) < 1.2 && Math.abs(_v.y) < 1.2 }; } });
hud.setQuality(R.getQuality());
R.onQualityChange = (q) => hud.setQuality(q);
const input = createInput(document.body);
const audio = createAudio();
const resultEl = document.getElementById('result');
const titleEl = document.getElementById('title');

let g, bot = null;
let carriage, peds = [], pedById = new Map(), cars = [], props, fx, guide, follow, city;
let actorAssets, cityAssets;
let acc = 0, lastRoute = null, lastTo = null, running = false, overShown = false;

function resumeAudioOnce(e) { if (e && e.isTrusted === false) return; audio.resume(); removeEventListener('keydown', resumeAudioOnce); removeEventListener('pointerdown', resumeAudioOnce); removeEventListener('touchstart', resumeAudioOnce); }
addEventListener('keydown', resumeAudioOnce); addEventListener('pointerdown', resumeAudioOnce); addEventListener('touchstart', resumeAudioOnce);
input.onMute = () => audio.setMuted(!audio.muted);
input.onRetry = () => restart(SEED);

function buildActors() {
  for (const p of peds) R.scene.remove(p.group); peds = []; pedById = new Map();
  for (const c of cars) R.scene.remove(c.group); cars = [];
  if (carriage) R.scene.remove(carriage.group);
  if (props) R.scene.remove(props.group);
  carriage = createCarriage(actorAssets); R.scene.add(carriage.group);
  // 動くもの担当 2026-11-10: sim の look は 0..9。服の色 18 種を使い切るため id で散らす（見た目だけ。sim は触らない）
  for (const pd of g.peds) { const p = createPedestrian(actorAssets, (pd.look + (pd.id * 7) % 18) % 18); R.scene.add(p.group); peds.push(p); pedById.set(pd.id, p); }
  for (const cr of [...g.cars, ...(g.trams || [])]) { const c = createCar(cr.kind, cr.id || 0) /* 2026-11-10: id で塗装色を散らす（見た目だけ） */; R.scene.add(c.group); cars.push({ o: c, s: cr }); }
  props = createProps(R.scene, g.props, cityAssets);
}

function restart(seed) {
  g = createGame(seed);
  window.__game = () => g;   // tests/looptest.html が読む
  // 動くもの担当 2026-11-10: tests/_actor2_smooth.html が描画側の位置（補間後）を読む（計測専用）
  window.__view = () => ({ carriage, peds, cars, props, camera: R.camera, follow, interp: INTERP, acc, timeScale: fx.timeScale });
  if (BOT) import('./sim/bot.js').then((m) => { bot = (gg) => m.botInput(gg, BOT); });
  if (!city) city = buildCity(R.scene, worldFromSim(g.world), cityAssets, { quality: R.getQuality() });
  buildActors();
  city.update(g.player.carriage.x, g.player.carriage.z, 999); // 主ループ: 出発点の近くの区画はまとめて作る（以後は毎フレーム1区画ずつ）
  // 2026-10-14 見た目: 壁寄せカメラ（建物の壁の手前へ寄せる。VISUAL_REPORT.md §1）。?campull=0 で切れる
  if (params.get('campull') !== '0') follow.setWorld(g.world); follow.snap(g.player);
  resetInterp();
  guide.setRoute(g.ride.route); guide.setDestination(g.ride.to); lastRoute = g.ride.route; lastTo = g.ride.to;
  hud.hideCard(); resultEl.classList.remove('show'); overShown = false; acc = 0;
  hud.setScore(0); hud.setTime(g.time);
  titleEl.classList.add('show');
}

async function boot() {
  const loading = document.getElementById('loading');
  const hdri = new URL(params.get('hdri') === 'dresden' ? './assets/hdri/dresden_square_2k.hdr' : './assets/hdri/quattro_canti_1k.hdr', import.meta.url).href;
  [, cityAssets, actorAssets] = await Promise.all([R.loadEnvironment(hdri, { background: false }) /* 主ループ 2026-10-02: 写真の背景だとドレスデンの建物が空にぼやけて浮く → 空ドーム */, loadCityAssets({ anisotropy: QUALITY === 'low' ? 2 : 8 }), loadActorAssets()]);
  R.useSkyDome(true); // 主ループ: 空はドーム（写真の背景を使わない）
  fx = createFX(R.scene); guide = createGuide(R.scene); follow = createFollowCamera(R.camera);
  restart(SEED);
  console.log('MAIN BOOT OK seed=' + SEED + ' quality=' + R.getQuality());
  if (SHOT_T != null) loading.remove(); else loading.classList.add('hide');
  running = true;
  if (SHOT_T != null) {
    const dt = 1 / 60; const n = Math.round(SHOT_T / dt);
    // FIX3 2026-10-14（天才さん「上下に振り子現象」）: ?trace=1 で毎フレームの カメラ y・馬車の y・車体の上下/ピッチ を時系列で出す（計測用。tests/_fix3_bob.py が読む）
    const TRACE = params.has('trace') ? [] : null;
    const _bw = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      frame(dt, BOT ? null : { up: i < n * 0.8, down: false, left: false, right: false, hand: false });
      if (TRACE) { carriage.body.getWorldPosition(_bw); TRACE.push([+(i * dt).toFixed(3), +R.camera.position.y.toFixed(4), +follow.pos.y.toFixed(4), +carriage.group.position.y.toFixed(4), +_bw.y.toFixed(4), +carriage.body.rotation.z.toFixed(4), +g.player.speed.toFixed(2), +(g.player.longG || 0).toFixed(2), +R.camera.rotation.x.toFixed(4)]); }
    }
    if (TRACE) console.log('MAIN TRACE ' + JSON.stringify(TRACE));
    R.render(dt);
    const st = R.getStats();
    // 主ループ 2026-10-03: スマホで開けない原因調査。3D データの総量と JS のメモリを出す
    let geoBytes = 0, texPx = 0; const seenG = new Set(), seenT = new Set();
    R.scene.traverse((o) => {
      const gg = o.geometry; if (gg && !seenG.has(gg)) { seenG.add(gg); for (const k in gg.attributes) geoBytes += gg.attributes[k].array.byteLength; if (gg.index) geoBytes += gg.index.array.byteLength; }
      if (o.isInstancedMesh && o.instanceMatrix) geoBytes += o.instanceMatrix.array.byteLength;
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'emissiveMap']) { const t = m[k]; if (t && !seenT.has(t) && t.image) { seenT.add(t); texPx += (t.image.width || 0) * (t.image.height || 0); } }
    });
    if (params.has('membreak')) {
      const by = {};
      for (const top of R.scene.children) { let b = 0, n = 0; const sg = new Set(); top.traverse((o) => { const gg = o.geometry; if (gg && !sg.has(gg)) { sg.add(gg); n++; for (const k in gg.attributes) b += gg.attributes[k].array.byteLength; if (gg.index) b += gg.index.array.byteLength; } }); if (b > 1e6) by[(top.name || top.type) + '#' + R.scene.children.indexOf(top)] = (b / 1e6).toFixed(0) + 'MB/' + n; }
      console.log('MAIN MEMBREAK ' + JSON.stringify(by));
    }
    const heap = performance.memory ? (performance.memory.usedJSHeapSize / 1e6).toFixed(0) + 'MB' : 'n/a';
    document.documentElement.dataset.mem = (`geo=${(geoBytes / 1e6).toFixed(0)}MB textures=${seenT.size} texPx=${(texPx / 1e6).toFixed(1)}M (RGBA≒${(texPx * 4 * 1.33 / 1e6).toFixed(0)}MB) jsHeap=${heap} meshes=${seenG.size}`);
    const line = `MAIN q=${st.quality} calls=${st.calls} tris=${st.triangles} ${VW()}x${VH()} seed=${SEED} t=${g.time.toFixed(1)} score=${g.totals.score.toFixed(0)} pos=${g.player.carriage.x.toFixed(1)},${g.player.carriage.z.toFixed(1)} speed=${g.player.speed.toFixed(1)} pull=${follow.pulled.toFixed(2)} camd=${Math.hypot(R.camera.position.x - g.player.carriage.x, R.camera.position.z - g.player.carriage.z).toFixed(1)} camy=${R.camera.position.y.toFixed(1)} body=${carriage.group.position.x.toFixed(1)},${carriage.group.position.y.toFixed(2)},${carriage.group.position.z.toFixed(1)}`;
    console.log(line); document.title = line;
    const hold = () => { R.render(dt); requestAnimationFrame(hold); }; requestAnimationFrame(hold);
    window.__shotReady = true;
    return;
  }
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dtReal = Math.min(0.1, (now - last) / 1000); last = now;
    frame(dtReal, null);
    R.render(dtReal);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const DT = TUNE.FIXED_DT;

// 2026-10-14 見た目（天才さん「キャラなどのカクツキ」）: 描画が sim の固定ステップ（1/120）の位置をそのまま使っていたため、
// 1 フレームに入るステップ数が 1/2/3 と揺れる（60Hz で 2 が基本、アキュムレータの余りで 1 や 3）たびに動きが段付きになっていた。
// 直し方: 各ステップの前に「前の位置」を控え、描く時は前と今の位置をアキュムレータの余り（acc/DT）で補間する。
// 位置が 6m 以上飛んだ（出し直し・リトライ）ときは補間しない。アニメの dt も固定ステップの合計ではなく実時間（timeScale 込み）を使う。
const SNAP_D2 = 6 * 6;
const INTERP = params.get('interp') !== '0';   // 動くもの担当 2026-11-10: ?interp=0 で補間を切る（計測の対照用）
const prevPl = { hx: 0, hz: 0, hyaw: 0, cx: 0, cz: 0, cyaw: 0, air: 0, spin: 0, phase: 0 };
const viewPl = { horse: {}, carriage: {} };
let prevPeds = [], viewPeds = [];
// 動くもの担当 2026-11-10: 小物（吹っ飛ぶ椅子など）と鳩も補間する。sim のオブジェクトは書き換えず、別の Map に前の位置を控える
const prevProps = new Map(), prevBirds = new Map();
const viewProp = { x: 0, y: 0, z: 0, yaw: 0 }, viewBird = { x: 0, y: 0, z: 0 };
let interpValid = false;
function resetInterp() { interpValid = false; prevProps.clear(); prevBirds.clear(); }
function snapshotPrev() {
  const h = g.player.horse, c = g.player.carriage;
  prevPl.hx = h.x; prevPl.hz = h.z; prevPl.hyaw = h.yaw; prevPl.cx = c.x; prevPl.cz = c.z; prevPl.cyaw = c.yaw; prevPl.air = c.airborne || 0;
  prevPl.spin = c.wheelSpin || 0; prevPl.phase = h.phase || 0;
  const n = g.peds.length;
  if (prevPeds.length !== n) { prevPeds = Array.from({ length: n }, () => ({})); viewPeds = Array.from({ length: n }, () => ({})); }
  for (let i = 0; i < n; i++) { const pd = g.peds[i], q = prevPeds[i]; q.x = pd.x; q.z = pd.z; q.yaw = pd.yaw; q.y = pd.y || 0; q.tick = pd._spawnTick || 0; }
  for (const c of cars) { const s = c.s; (c.prev || (c.prev = {})).x = s.x; c.prev.z = s.z; c.prev.yaw = s.yaw; c.prev.tick = s._spawnTick || 0; }
  for (const p of g.props) {
    if (p.resting && !(p.y > 0)) { if (prevProps.has(p)) prevProps.delete(p); continue; }   // 止まっている小物は控えない（動く物だけ）
    let q = prevProps.get(p); if (!q) { q = {}; prevProps.set(p, q); }
    q.x = p.x; q.z = p.z; q.y = p.y || 0; q.yaw = p.yaw || 0;
  }
  for (const b of g.pigeons || []) { let q = prevBirds.get(b); if (!q) { q = {}; prevBirds.set(b, q); } q.x = b.x; q.z = b.z; q.y = b.y || 0; }
  interpValid = true;
}
function lerpYaw(a, b, t) { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; }
function lerpWrap(a, b, t, period) { let d = b - a; d -= Math.round(d / period) * period; return a + d * t; }
function mix(prev, cur, a, out) {
  // prev/cur: {x,z,yaw,(y)} → out に書く。飛んだら cur
  const dx = cur.x - prev.x, dz = cur.z - prev.z;
  if (dx * dx + dz * dz > SNAP_D2 || (cur._spawnTick || 0) !== (prev.tick || 0)) { out.x = cur.x; out.z = cur.z; out.yaw = cur.yaw; if ('y' in prev) out.y = cur.y || 0; return out; }
  out.x = prev.x + dx * a; out.z = prev.z + dz * a; out.yaw = lerpYaw(prev.yaw, cur.yaw, a);
  if ('y' in prev) out.y = prev.y + ((cur.y || 0) - prev.y) * a;
  return out;
}
// 小物・鳩の「描画用の位置」（補間）。prev が無い（止まっている・出たばかり）物は sim の位置そのまま
let curAlpha = 1;
function propView(p) {
  const q = prevProps.get(p); if (!q) return null;
  const dx = p.x - q.x, dz = p.z - q.z; if (dx * dx + dz * dz > SNAP_D2) return null;
  viewProp.x = q.x + dx * curAlpha; viewProp.z = q.z + dz * curAlpha; viewProp.y = q.y + ((p.y || 0) - q.y) * curAlpha; viewProp.yaw = lerpYaw(q.yaw, p.yaw || 0, curAlpha);
  return viewProp;
}
function birdView(b) {
  const q = prevBirds.get(b); if (!q) return null;
  const dx = b.x - q.x, dz = b.z - q.z; if (dx * dx + dz * dz > SNAP_D2) return null;
  viewBird.x = q.x + dx * curAlpha; viewBird.z = q.z + dz * curAlpha; viewBird.y = q.y + ((b.y || 0) - q.y) * curAlpha;
  return viewBird;
}
function onHoof(x, z, speed) { fx.puffDust(x, z, { n: speed > 9 ? 2 : 1, spread: 0.25, up: 0.25 + speed * 0.015, size: 0.26 }); }   // 控えめ（近景で白い塊にならない）
function frame(dtReal, forcedInput) {
  const { timeScale, shake } = fx.update(dtReal);
  const inp = forcedInput || (bot ? bot(g) : input.read(dtReal));
  if ((inp.up || inp.down || inp.left || inp.right) && titleEl.classList.contains('show')) titleEl.classList.remove('show');
  // 固定ステップ
  let simDt = 0;
  if (!g.over) {
    acc += dtReal * timeScale;
    let steps = 0;
    while (acc >= DT && steps < 12) { snapshotPrev(); step(g, inp, DT); handleEvents(); acc -= DT; steps++; simDt += DT; }
    if (steps >= 12) acc = 0;
  }
  const p = g.player;
  const animDt = g.over ? 0 : Math.min(dtReal, 0.1) * timeScale;
  // 補間した「描画用の位置」
  const alpha = INTERP && interpValid && !g.over ? Math.max(0, Math.min(1, acc / DT)) : 1;
  curAlpha = alpha;
  let pv = p;
  if (alpha < 1) {
    const h = p.horse, c = p.carriage;
    const dcx = c.x - prevPl.cx, dcz = c.z - prevPl.cz;
    if (dcx * dcx + dcz * dcz < SNAP_D2) {
      Object.assign(viewPl.horse, h); Object.assign(viewPl.carriage, c);
      viewPl.horse.x = prevPl.hx + (h.x - prevPl.hx) * alpha; viewPl.horse.z = prevPl.hz + (h.z - prevPl.hz) * alpha; viewPl.horse.yaw = lerpYaw(prevPl.hyaw, h.yaw, alpha);
      viewPl.carriage.x = prevPl.cx + dcx * alpha; viewPl.carriage.z = prevPl.cz + dcz * alpha; viewPl.carriage.yaw = lerpYaw(prevPl.cyaw, c.yaw, alpha);
      viewPl.carriage.airborne = prevPl.air + ((c.airborne || 0) - prevPl.air) * alpha;
      // 2026-11-10 動くもの担当: 車輪の角と歩様の位相も補間する（車輪は 1/120 秒の段で回っていて、30fps で角速度が ±57% 揺れていた。tests/_actor2_smooth.html）
      if (c.wheelSpin != null) viewPl.carriage.wheelSpin = lerpWrap(prevPl.spin, c.wheelSpin, alpha, Math.PI * 2);
      viewPl.horse.phase = lerpWrap(prevPl.phase, h.phase || 0, alpha, 1);
      viewPl.speed = p.speed; viewPl.lateralG = p.lateralG; viewPl.longG = p.longG;
      pv = viewPl;
    }
  }
  const lowQ = R.getQuality() === 'low';
  const pedFar = R.getQuality() === 'high' ? 120 : 90;   // 2026-11-10 スマホの重さ: high 以外は 90m より遠い人を描かない（sim の人数は変えない）
  // 蹄が地面に着いた瞬間に、その蹄の位置で土ぼこり（以前は馬の中心で 1.6m ごと）
  carriage.update(pv, animDt, { blobShadow: lowQ, hatLost: !!g.ride.hatLost, onHoof: simDt > 0 ? onHoof : null });
  const cp = R.camera.position;
  g.peds.forEach((pd, i) => {
    const o = peds[i]; if (!o) return;
    let v = pd;
    if (alpha < 1 && prevPeds[i]) { v = viewPeds[i]; Object.assign(v, pd); mix(prevPeds[i], pd, alpha, v); }
    o.update(v, animDt, Math.hypot(pd.x - cp.x, pd.z - cp.z), { blobShadow: lowQ, farCut: pedFar });
  });
  for (const c of cars) {
    let v = c.s;
    if (alpha < 1 && c.prev) { v = c.view || (c.view = {}); Object.assign(v, c.s); mix(c.prev, c.s, alpha, v); }
    c.o.update(v, animDt);
  }
  props.update(g.props, g.pigeons, simDt, alpha < 1 ? propView : null, alpha < 1 ? birdView : null);
  guide.update(dtReal, pv.carriage);
  if (g.ride.route !== lastRoute) { guide.setRoute(g.ride.route); lastRoute = g.ride.route; }
  if (g.ride.to !== lastTo) { guide.setDestination(g.ride.to); lastTo = g.ride.to; }
  follow.update(dtReal, pv, { shake });
  R.setFocus(pv.carriage.x, pv.carriage.z);   // 影の枠も補間した位置に追従（影の縁がコマ落ちしない）
  city.update(p.carriage.x, p.carriage.z, 1); // 主ループ 2026-10-03: 近くの区画だけ詳細を作り、遠くは捨てる
  audio.update(simDt, p);
  // HUD
  const to = g.ride.to;
  const dist = Math.hypot(to.x - p.carriage.x, to.z - p.carriage.z);
  const bw = Math.atan2(to.z - p.carriage.z, to.x - p.carriage.x);
  let rel = bw - p.carriage.yaw; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  hud.setDestination({ name: to.name, dist, bearing: rel, turn: nextTurn(g.ride.route, p) });
  hud.setTime(g.time); hud.setScore(Math.round(g.totals.score));
  hud.setGait(p.horse.gait, p.speed); hud.setPassenger(g.ride.mood, g.ride.safety);
  hud.update(dtReal);
  if (g.over && !overShown) showResult();
}

// 次の曲がり角: 経路の折れ線で 25° 以上折れる最初の頂点
function nextTurn(route, p) {
  if (!route || route.length < 3) return null;
  // 最寄りの区間
  let best = 0, bestD = 1e9;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1]; const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
    let t = ((p.carriage.x - a.x) * dx + (p.carriage.z - a.z) * dz) / L2; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(a.x + dx * t - p.carriage.x, a.z + dz * t - p.carriage.z); if (d < bestD) { bestD = d; best = i; }
  }
  let acc = 0;
  for (let i = best + 1; i < route.length - 1; i++) {
    const a = route[i - 1], b = route[i], c = route[i + 1];
    acc = Math.hypot(b.x - p.carriage.x, b.z - p.carriage.z);
    const a1 = Math.atan2(b.z - a.z, b.x - a.x), a2 = Math.atan2(c.z - b.z, c.x - b.x);
    let d = a2 - a1; d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.44) return { dist: acc, dir: d > 0 ? 'right' : 'left' };
    if (acc > 400) break;
  }
  const dEnd = Math.hypot(route[route.length - 1].x - p.carriage.x, route[route.length - 1].z - p.carriage.z);
  return dEnd < 40 ? { dir: 'arrive' } : null;
}

function handleEvents() {
  for (const ev of g.events) {
    fx.onEvent(ev); audio.onEvent(ev);
    switch (ev.type) {
      case 'penalty': hud.float({ kind: 'penalty', amount: ev.amount, x: ev.x, y: 1.2, z: ev.z, src: ev.src }); break;
      case 'bonus': hud.float({ kind: 'bonus', amount: ev.amount, x: ev.x, y: 1.4, z: ev.z, src: ev.kind, label: ev.kind === 'drift' ? 'ドリフト' : 'かすり回避' }); break;
      case 'arrive': hud.toast('バチン'); hud.showCard(ev.ride); break;
      case 'pedAngry': { const pd = pedById.get(ev.id); break; }
      case 'launch': if (ev.kind === 'pot') fx.burstDebris(ev.x, 0.5, ev.z, { n: 8, color: 0xb86b3a, power: 3 }); break;
    }
  }
}

function showResult() {
  overShown = true;
  const t = g.totals;
  resultEl.querySelector('#res-score').textContent = Math.round(t.score).toLocaleString('en-US');
  resultEl.querySelector('#res-rides').textContent = t.rides;
  resultEl.querySelector('#res-damage').textContent = '¥' + Math.round(t.damage).toLocaleString('en-US');
  resultEl.querySelector('#res-best').textContent = t.best ? Math.round(t.best.score).toLocaleString('en-US') : '—';
  resultEl.classList.add('show');
}
resultEl.querySelector('#res-retry').addEventListener('click', () => restart(SEED));
resultEl.querySelector('#res-newseed').addEventListener('click', () => restart(String(Date.now() % 100000)));

addEventListener('resize', () => R.resize(VW(), VH()));
boot().catch((e) => { console.error('BOOT FAILED', e); const l = document.getElementById('loading'); if (l) l.textContent = 'ERROR: ' + e.message; });
