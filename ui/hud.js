// ui/hud.js — DOM の HUD。three.js に依存しない（3D→画面の投影は project 関数を注入する）
//
// 使い方:
//   const hud = createHUD(document.getElementById('hud'), { project: (x,y,z) => ({ sx, sy, visible }) });
//   hud.setTime(sec); hud.setScore(n); hud.setDestination({ name, dist, bearing, turn:{ dist, dir:'left'|'right'|'straight' } });
//   hud.setGait(gait0to4, speedMs); hud.setPassenger(mood, safety0to100);
//   hud.float({ kind:'penalty'|'bonus', amount, x, y, z, src });   // 3D 位置に −¥/+¥ を浮かせる。近い同種は合算して膨らむ
//   hud.showCard(ride); hud.hideCard(); hud.toast('バチン');
//   hud.update(dt)  // 毎フレーム（カウントアップ・浮き文字の投影）
//   hud.setQuality('high'|'mid'|'low')

const GAITS = [
  { ja: '停止', de: 'Halt' },
  { ja: '並足', de: 'Schritt' },
  { ja: '速足', de: 'Trab' },
  { ja: '駆け足', de: 'Galopp' },
  { ja: '全力', de: 'Vollgalopp' },
];
const MOODS = {
  happy:  { ja: 'ご機嫌', brow: 0,   mouth: 1,   eye: 1 },
  ok:     { ja: '平気',   brow: 0.2, mouth: 0.3, eye: 1 },
  scared: { ja: '青ざめ', brow: 0.7, mouth: -0.5, eye: 1.25 },
  panic:  { ja: '悲鳴',   brow: 1,   mouth: -1,  eye: 1.5 },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function compassSVG() {
  // 外周の目盛り + 中央の矢印（矢印だけ回す）
  const ticks = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r1 = i % 6 === 0 ? 19 : 22, r2 = 25;
    ticks.push(`<line x1="${(27 + Math.sin(a) * r1).toFixed(2)}" y1="${(27 - Math.cos(a) * r1).toFixed(2)}" x2="${(27 + Math.sin(a) * r2).toFixed(2)}" y2="${(27 - Math.cos(a) * r2).toFixed(2)}" stroke="${i % 6 === 0 ? 'rgba(216,189,106,0.9)' : 'rgba(239,230,208,0.28)'}" stroke-width="${i % 6 === 0 ? 1.4 : 1}"/>`);
  }
  return `<svg viewBox="0 0 54 54">
    <circle cx="27" cy="27" r="25.5" fill="rgba(0,0,0,0.25)" stroke="rgba(201,162,39,0.5)" stroke-width="1"/>
    ${ticks.join('')}
    <g class="arrow">
      <path d="M27 7 L34 30 L27 25.5 L20 30 Z" fill="#e9c35a" stroke="#6b5214" stroke-width="0.6" stroke-linejoin="round"/>
      <circle cx="27" cy="27" r="2.2" fill="#efe6d0"/>
    </g>
  </svg>`;
}

function turnIcon(dir) {
  if (dir === 'left') return `<svg viewBox="0 0 14 14"><path d="M9 12 V6 a3 3 0 0 0 -3 -3 H3 M5 1 L2 3 L5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (dir === 'right') return `<svg viewBox="0 0 14 14"><path d="M5 12 V6 a3 3 0 0 1 3 -3 H11 M9 1 L12 3 L9 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<svg viewBox="0 0 14 14"><path d="M7 13 V2 M3 6 L7 2 L11 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function faceSVG() {
  // 円の外周に安全度の弧、内側に顔（眉・目・口はパラメータで変形）
  return `<svg viewBox="0 0 58 58">
    <circle cx="29" cy="29" r="26" fill="none" stroke="rgba(239,230,208,0.14)" stroke-width="3"/>
    <circle class="safety-ring" cx="29" cy="29" r="26" fill="none" stroke="#7fa394" stroke-width="3"
      stroke-dasharray="163.4" stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 29 29)"/>
    <circle cx="29" cy="29" r="21" fill="#e9d3b8"/>
    <path class="hair" d="M9 26 C10 12, 20 7, 29 8 C38 7, 48 12, 49 26 C44 20, 40 17, 29 17 C18 17, 14 20, 9 26 Z" fill="#3a2a22"/>
    <g class="brows" stroke="#3a2a22" stroke-width="2.2" stroke-linecap="round" fill="none">
      <path class="brow-l" d="M18 24 L26 24"/>
      <path class="brow-r" d="M32 24 L40 24"/>
    </g>
    <g class="eyes" fill="#2a2320">
      <ellipse class="eye-l" cx="22" cy="29" rx="2" ry="2.4"/>
      <ellipse class="eye-r" cx="36" cy="29" rx="2" ry="2.4"/>
    </g>
    <path class="mouth" d="M22 38 Q29 44 36 38" fill="none" stroke="#7a3b32" stroke-width="2" stroke-linecap="round"/>
    <ellipse class="shout" cx="29" cy="40" rx="4" ry="4.5" fill="#5a2a24" opacity="0"/>
  </svg>`;
}

function horseshoeSVG() {
  // 馬蹄: 開口部を下にした弧を 4 分割。左下から右下へ 並足→速足→駆け足→全力
  const cx = 33, cy = 34, r = 24;
  const a0 = Math.PI * 0.78, a1 = Math.PI * 2.22; // 開口部を下に（角度は x 軸基準、時計回りに増える表示系）
  const segs = [];
  for (let i = 0; i < 4; i++) {
    const s = a0 + ((a1 - a0) * i) / 4 + 0.05, e = a0 + ((a1 - a0) * (i + 1)) / 4 - 0.05;
    const p = (a) => `${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
    const large = e - s > Math.PI ? 1 : 0;
    segs.push(`<path class="seg seg-${i}" d="M ${p(s)} A ${r} ${r} 0 ${large} 1 ${p(e)}"/>`);
  }
  const nails = [];
  for (let i = 0; i < 7; i++) {
    const a = a0 + ((a1 - a0) * (i + 0.5)) / 7;
    nails.push(`<circle class="nail" cx="${(cx + Math.cos(a) * r).toFixed(2)}" cy="${(cy + Math.sin(a) * r).toFixed(2)}" r="1.2"/>`);
  }
  return `<svg viewBox="0 0 66 66">
    <path d="M ${(cx + Math.cos(a0) * (r + 5)).toFixed(2)} ${(cy + Math.sin(a0) * (r + 5)).toFixed(2)} A ${r + 5} ${r + 5} 0 1 1 ${(cx + Math.cos(a1) * (r + 5)).toFixed(2)} ${(cy + Math.sin(a1) * (r + 5)).toFixed(2)}" fill="none" stroke="rgba(201,162,39,0.35)" stroke-width="1"/>
    ${segs.join('')}
    ${nails.join('')}
  </svg>`;
}

export function createHUD(root, opts = {}) {
  const project = opts.project || (() => ({ sx: 0, sy: 0, visible: false }));
  root.classList.add('hud');
  root.innerHTML = `
    <div class="hud-panel hud-time"><div class="hud-label">Zeit<span class="ja">残り時間</span></div><div class="hud-num" id="hud-time">0:00</div></div>
    <div class="hud-panel hud-score"><div class="hud-label">Punkte<span class="ja">得点</span></div><div class="hud-num" id="hud-score">0</div></div>
    <div class="hud-quality" id="hud-quality"></div>
    <div class="hud-panel hud-compass">
      <div class="dial">${compassSVG()}</div>
      <div class="dest">
        <div class="name" id="hud-dest-name">—</div>
        <div class="dist"><span id="hud-dest-dist">0</span><small>m</small></div>
        <div class="turn none" id="hud-turn"><span class="ico"></span><span class="txt"></span></div>
      </div>
    </div>
    <div class="hud-panel hud-passenger">
      <div class="face">${faceSVG()}</div>
      <div class="meta">
        <div class="hud-label">Fahrgast<span class="ja">客</span></div>
        <div class="mood" id="hud-mood">ご機嫌</div>
        <div class="safety"><b id="hud-safety">100</b>安全度</div>
      </div>
    </div>
    <div class="hud-panel hud-gait">
      <div class="meta">
        <div class="hud-label">Gangart<span class="ja">歩様</span></div>
        <div class="gait-name" id="hud-gait-name">並足<span class="de">Schritt</span></div>
        <div class="speed"><b id="hud-speed">0</b>km/h</div>
      </div>
      <div class="shoe">${horseshoeSVG()}</div>
    </div>
    <div class="hud-floats" id="hud-floats"></div>
    <div class="hud-toast" id="hud-toast"></div>
    <div class="hud-panel hud-card" id="hud-card">
      <div class="stamp" id="hud-stamp">Drift</div>
      <div class="title"><div class="h">到着<span class="de">Angekommen</span></div><div class="time" id="hud-card-time"></div></div>
      <div class="row" data-row="0"><div class="op"></div><div class="k">到着点<small>速さ係数 <span id="hud-card-sf"></span></small></div><div class="v" id="hud-card-arrive">0</div></div>
      <div class="row" data-row="1"><div class="op">×</div><div class="k">安全倍率<small>安全度 <span id="hud-card-safety"></span></small></div><div class="v" id="hud-card-mult">×1.00</div></div>
      <div class="row damage" data-row="2"><div class="op">−</div><div class="k">破損の弁償</div><div class="v" id="hud-card-damage">¥0</div></div>
      <div class="row total" data-row="3"><div class="op">＝</div><div class="k">この一件</div><div class="v" id="hud-card-total">0</div></div>
    </div>
  `;
  const $ = (id) => root.querySelector('#' + id);
  const el = {
    time: $('hud-time'), timePanel: root.querySelector('.hud-time'),
    score: $('hud-score'), quality: $('hud-quality'),
    destName: $('hud-dest-name'), destDist: $('hud-dest-dist'), turn: $('hud-turn'),
    arrow: root.querySelector('.hud-compass .arrow'),
    passenger: root.querySelector('.hud-passenger'), mood: $('hud-mood'), safety: $('hud-safety'),
    face: root.querySelector('.hud-passenger .face svg'),
    gaitName: $('hud-gait-name'), speed: $('hud-speed'), segs: [...root.querySelectorAll('.hud-gait .seg')],
    floats: $('hud-floats'), toast: $('hud-toast'),
    card: $('hud-card'), stamp: $('hud-stamp'),
  };
  const face = {
    browL: el.face.querySelector('.brow-l'), browR: el.face.querySelector('.brow-r'),
    eyeL: el.face.querySelector('.eye-l'), eyeR: el.face.querySelector('.eye-r'),
    mouth: el.face.querySelector('.mouth'), shout: el.face.querySelector('.shout'),
    ring: el.face.querySelector('.safety-ring'),
  };

  const state = {
    scoreShown: 0, scoreTarget: 0, scoreVel: 0,
    floats: [], lastMood: 'happy', lastSafetyShown: 100,
    toastTimer: 0, cardTimer: null, now: 0,
  };

  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

  function setTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    el.time.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
    el.timePanel.classList.toggle('urgent', sec > 0 && sec <= 15);
  }
  function setScore(n) {
    if (n !== state.scoreTarget) {
      if (n > state.scoreTarget) { el.score.classList.remove('bump'); void el.score.offsetWidth; el.score.classList.add('bump'); }
      state.scoreTarget = n;
    }
  }
  function setQuality(q) { el.quality.textContent = q ? ({ high: 'Hoch · 高', mid: 'Mittel · 中', low: 'Niedrig · 低' })[q] || q : ''; }

  // bearing: 進行方向を 0 とした目的地の相対角（ラジアン、右回りが正）
  function setDestination({ name, dist, bearing = 0, turn = null }) {
    if (name != null) el.destName.textContent = name;
    if (dist != null) el.destDist.textContent = dist >= 1000 ? (dist / 1000).toFixed(2) + ' k' : String(Math.round(dist / 5) * 5);
    el.arrow.style.transform = `rotate(${(bearing * 180) / Math.PI}deg)`;
    if (turn && turn.dir && turn.dir !== 'straight' && turn.dist != null) {
      el.turn.classList.remove('none');
      el.turn.querySelector('.ico').innerHTML = turnIcon(turn.dir);
      el.turn.querySelector('.txt').textContent = `${Math.round(turn.dist / 10) * 10} m 先 ${turn.dir === 'left' ? '左' : '右'}`;
    } else if (turn && turn.dir === 'arrive') {
      el.turn.classList.remove('none');
      el.turn.querySelector('.ico').innerHTML = turnIcon('straight');
      el.turn.querySelector('.txt').textContent = '停車枠に止まれ';
    } else {
      el.turn.classList.add('none');
    }
  }

  function setGait(gait, speedMs = 0) {
    gait = Math.max(0, Math.min(4, Math.round(gait)));
    const g = GAITS[gait];
    el.gaitName.innerHTML = `${g.ja}<span class="de">${g.de}</span>`;
    el.segs.forEach((s, i) => { s.classList.toggle('on', i < gait); s.classList.toggle('hot', gait === 4); });
    el.speed.textContent = String(Math.round(speedMs * 3.6));
  }

  function setPassenger(mood, safety) {
    const m = MOODS[mood] || MOODS.ok;
    el.mood.textContent = m.ja;
    el.passenger.classList.toggle('scared', mood === 'scared');
    el.passenger.classList.toggle('panic', mood === 'panic');
    if (mood !== state.lastMood) {
      state.lastMood = mood;
      el.passenger.classList.remove('jolt'); void el.passenger.offsetWidth; el.passenger.classList.add('jolt');
    }
    // 顔: 眉は内側が上がる（心配）、目は見開く、口は笑み→への字→叫び
    const b = m.brow;
    face.browL.setAttribute('d', `M18 ${24 + b * 1.5} L26 ${24 - b * 3}`);
    face.browR.setAttribute('d', `M32 ${24 - b * 3} L40 ${24 + b * 1.5}`);
    face.eyeL.setAttribute('ry', (2.4 * m.eye).toFixed(2)); face.eyeR.setAttribute('ry', (2.4 * m.eye).toFixed(2));
    face.eyeL.setAttribute('rx', (2 * Math.sqrt(m.eye)).toFixed(2)); face.eyeR.setAttribute('rx', (2 * Math.sqrt(m.eye)).toFixed(2));
    if (m.mouth <= -0.9) { face.mouth.setAttribute('opacity', '0'); face.shout.setAttribute('opacity', '1'); }
    else { face.mouth.setAttribute('opacity', '1'); face.shout.setAttribute('opacity', '0'); face.mouth.setAttribute('d', `M22 38 Q29 ${38 + m.mouth * 6} 36 38`); }
    if (safety != null) {
      const s = Math.max(0, Math.min(100, safety));
      el.safety.textContent = String(Math.round(s));
      face.ring.setAttribute('stroke-dashoffset', (163.4 * (1 - s / 100)).toFixed(1));
      face.ring.setAttribute('stroke', s > 60 ? '#7fa394' : s > 30 ? '#d8bd6a' : '#c86a4a');
    }
  }

  // 浮く金額。近い同種（src が同じ or 3m 以内, 0.7 秒以内）は 1 つにまとめて膨らむ
  function float({ kind = 'penalty', amount = 0, x = 0, y = 1.5, z = 0, src = '', label = '' }) {
    const now = state.now;
    for (const f of state.floats) {
      const dx = f.x - x, dz = f.z - z;
      if (f.kind === kind && now - f.born < 0.7 && (f.src === src || dx * dx + dz * dz < 9)) {
        f.amount += amount; f.born = now; f.x = x; f.z = z; f.y = Math.max(f.y, y);
        f.inner.innerHTML = fmtAmount(kind, f.amount);
        f.inner.classList.remove('grow'); void f.inner.offsetWidth; f.inner.classList.add('grow');
        return;
      }
    }
    const node = document.createElement('div');
    node.className = `hud-float ${kind}`;
    const inner = document.createElement('span'); inner.className = 'inner grow';
    inner.innerHTML = fmtAmount(kind, amount);
    node.appendChild(inner);
    if (label) { const l = document.createElement('span'); l.className = 'label'; l.textContent = label; node.appendChild(l); }
    el.floats.appendChild(node);
    state.floats.push({ node, inner, kind, amount, x, y, z, src, born: now, rise: 0 });
  }
  function fmtAmount(kind, a) { return `<span class="yen">${kind === 'bonus' ? '+¥' : '−¥'}</span>${fmtInt(Math.abs(a))}`; }

  function toast(text, sec = 1.2) {
    el.toast.textContent = text; el.toast.classList.add('show'); state.toastTimer = sec;
  }

  // ride: { timeSec, routeLen, speedFactor, safety, safetyMult, damage, drift, score }
  function showCard(ride, holdSec = 2.6, { instant = false } = {}) {
    const c = el.card;
    c.querySelector('#hud-card-time').textContent = `${ride.timeSec.toFixed(1)} s · ${Math.round(ride.routeLen)} m`;
    c.querySelector('#hud-card-sf').textContent = `×${ride.speedFactor.toFixed(2)}`;
    c.querySelector('#hud-card-arrive').textContent = fmtInt(1000 * ride.speedFactor);
    c.querySelector('#hud-card-safety').textContent = Math.round(ride.safety);
    c.querySelector('#hud-card-mult').textContent = `×${ride.safetyMult.toFixed(2)}`;
    c.querySelector('#hud-card-damage').textContent = `¥${fmtInt(ride.damage)}`;
    c.querySelector('#hud-card-total').textContent = fmtInt(ride.score);
    el.stamp.classList.toggle('on', !!ride.drift);
    const rows = [...c.querySelectorAll('.row')];
    rows.forEach((r) => r.classList.remove('in'));
    c.classList.add('show');
    if (instant) rows.forEach((r) => r.classList.add('in'));
    else rows.forEach((r, i) => setTimeout(() => r.classList.add('in'), 120 + i * 220));
    if (state.cardTimer) clearTimeout(state.cardTimer);
    if (holdSec > 0) state.cardTimer = setTimeout(hideCard, holdSec * 1000);
  }
  function hideCard() { el.card.classList.remove('show'); }

  function update(dt) {
    // 得点のカウントアップ（差が大きいほど速く、最後は滑らかに）
    if (state.scoreShown !== state.scoreTarget) {
      const diff = state.scoreTarget - state.scoreShown;
      const step = Math.sign(diff) * Math.max(1, Math.abs(diff) * Math.min(1, dt * 6));
      state.scoreShown = Math.abs(step) >= Math.abs(diff) ? state.scoreTarget : state.scoreShown + step;
      el.score.textContent = fmtInt(state.scoreShown);
    }
    // 浮き文字（時計は update の dt で進める。同期撮影でも同じ結果になる）
    state.now += dt;
    const now = state.now;
    for (let i = state.floats.length - 1; i >= 0; i--) {
      const f = state.floats[i];
      const age = now - f.born;
      const life = 1.5;
      if (age > life) { f.node.remove(); state.floats.splice(i, 1); continue; }
      f.rise += dt * (0.6 + age * 0.4);
      const p = project(f.x, f.y + f.rise, f.z);
      if (!p.visible) { f.node.style.opacity = '0'; continue; }
      const fade = age < 0.15 ? age / 0.15 : age > life - 0.5 ? (life - age) / 0.5 : 1;
      f.node.style.opacity = String(fade);
      f.node.style.transform = `translate(${p.sx.toFixed(1)}px, ${p.sy.toFixed(1)}px) translate(-50%, -50%)`;
    }
    if (state.toastTimer > 0) { state.toastTimer -= dt; if (state.toastTimer <= 0) el.toast.classList.remove('show'); }
  }

  // 初期値
  setTime(150); setScore(0); setGait(0, 0); setPassenger('happy', 100); setDestination({ name: '—', dist: 0 });
  el.score.textContent = '0';

  return { setTime, setScore, setDestination, setGait, setPassenger, float, toast, showCard, hideCard, update, setQuality, el };
}
