// ui/input.js — キーボード（↑↓←→ / WASD / Space / R / M）とタッチ（左下固定の半透明十字キー + 右下「ドリフト」）
//
//   const input = createInput(rootEl);
//   const i = input.read();   // { up, down, left, right, hand }（sim の step に渡す形）+ retry / mute は onRetry / onMute コールバック
//   input.onRetry = () => {}; input.onMute = () => {};
//
// 十字キー: 画面左下に固定位置（触った場所を中心にしない）。上下左右は 4 つの別ボタン。各ボタンの当たり判定は
// 見た目より大きく、隣とボタン境界で少し重なるようにしてある（corner のゾーンだけ 2 方向が重なる）→
// 複数の指で別ボタンを同時に押す（例: 上+左の2本指）でも、1本の指が境界/corner をスライドしても斜め押しができる。
// 2026-10-03 主ループ: 前の「触った位置が中心になる仮想スティック」は、手の震え程度の微小な位置ジッタで
// left/right がオン/オフを高速フリップし（計測: 8Hz のジッタで 320回/10秒、yaw が 0.05rad 振れた。
// tests/_flicker_steer.html）、「まっすぐ進んでるのに揺れる」の主因の一つだった。固定位置のボタンにすると、
// 指を置いたままの震えでは閾値をまたがない（ボタンの当たり判定が指の震え幅より大きい）ので、この経路のブレが無くなる。

export function createInput(root) {
  const keys = new Set();
  const api = { onRetry: null, onMute: null, touch: false };
  const codeMap = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'hand',
  };
  addEventListener('keydown', (e) => {
    const k = codeMap[e.code];
    if (k) { keys.add(k); e.preventDefault(); }
    if (e.code === 'KeyR' && !e.repeat) api.onRetry?.();
    if (e.code === 'KeyM' && !e.repeat) api.onMute?.();
  });
  addEventListener('keyup', (e) => { const k = codeMap[e.code]; if (k) keys.delete(k); });
  addEventListener('blur', () => keys.clear());

  // ---- タッチ UI
  const ui = document.createElement('div');
  ui.className = 'touch-ui';
  ui.innerHTML = `
    <div class="dpad" id="touch-dpad">
      <div class="dbtn dbtn-up" data-dir="up"><span class="ico">▲</span></div>
      <div class="dbtn dbtn-down" data-dir="down"><span class="ico">▼</span></div>
      <div class="dbtn dbtn-left" data-dir="left"><span class="ico">◀</span></div>
      <div class="dbtn dbtn-right" data-dir="right"><span class="ico">▶</span></div>
    </div>
    <button class="drift" id="touch-drift" type="button">ドリフト<span>Drift</span></button>
    <button class="retry" id="touch-retry" type="button">R</button>`;
  root.appendChild(ui);

  const dpad = ui.querySelector('#touch-dpad');
  const dirEls = {
    up: dpad.querySelector('.dbtn-up'), down: dpad.querySelector('.dbtn-down'),
    left: dpad.querySelector('.dbtn-left'), right: dpad.querySelector('.dbtn-right'),
  };
  const dirState = { up: false, down: false, left: false, right: false };
  const dpadPointers = new Map(); // pointerId -> Set(dir) （その指が今乗っているボタン。複数同時可）

  function dirsAtPoint(x, y) {
    const els = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
    const s = new Set();
    for (const el of els) { const d = el && el.dataset && el.dataset.dir; if (d) s.add(d); }
    return s;
  }
  function recomputeDirState() {
    const next = { up: false, down: false, left: false, right: false };
    for (const set of dpadPointers.values()) for (const d of set) next[d] = true;
    for (const d of Object.keys(dirState)) {
      if (dirState[d] !== next[d]) { dirState[d] = next[d]; dirEls[d].classList.toggle('on', next[d]); }
    }
  }
  function onDpadDown(e) {
    try { dpad.setPointerCapture(e.pointerId); } catch {}
    dpadPointers.set(e.pointerId, dirsAtPoint(e.clientX, e.clientY));
    recomputeDirState();
    api.touch = true; ui.classList.add('on');
    e.preventDefault();
  }
  function onDpadMove(e) {
    if (!dpadPointers.has(e.pointerId)) return;
    dpadPointers.set(e.pointerId, dirsAtPoint(e.clientX, e.clientY));
    recomputeDirState();
    e.preventDefault();
  }
  function onDpadUp(e) {
    if (!dpadPointers.has(e.pointerId)) return;
    dpadPointers.delete(e.pointerId);
    recomputeDirState(); // 2026-10-03: 離した方向だけ止める（以前の仮想スティックは離した直後に自動で手綱＝減速を入れていたが、
                          // 固定十字キーでは「下」ボタンを押していない限り減速しない。やめる操作は単純に止まるだけにする）
  }
  dpad.addEventListener('pointerdown', onDpadDown);
  dpad.addEventListener('pointermove', onDpadMove);
  dpad.addEventListener('pointerup', onDpadUp);
  dpad.addEventListener('pointercancel', onDpadUp);
  dpad.addEventListener('contextmenu', (e) => e.preventDefault());

  let drift = false;
  const driftBtn = ui.querySelector('#touch-drift');
  driftBtn.addEventListener('touchstart', (e) => { drift = true; driftBtn.classList.add('on'); api.touch = true; ui.classList.add('on'); e.preventDefault(); e.stopPropagation(); }, { passive: false });
  driftBtn.addEventListener('touchend', (e) => { drift = false; driftBtn.classList.remove('on'); e.preventDefault(); e.stopPropagation(); });
  driftBtn.addEventListener('touchcancel', () => { drift = false; driftBtn.classList.remove('on'); });
  ui.querySelector('#touch-retry').addEventListener('click', () => api.onRetry?.());
  driftBtn.addEventListener('click', (e) => e.preventDefault());

  function read() {
    return {
      up: keys.has('up') || dirState.up,
      down: keys.has('down') || dirState.down,
      left: keys.has('left') || dirState.left,
      right: keys.has('right') || dirState.right,
      hand: keys.has('hand') || drift,
    };
  }
  return Object.assign(api, { read, keys, element: ui });
}
