// ui/input.js — キーボード（↑↓←→ / WASD / Space / R / M）とタッチ（左手 ◀▶、右手 鞭・手綱・ドリフト）
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

  // ---- タッチ UI（2026-11-09 作り直し）
  // 天才さん「操作ボタンも変だった」。前の十字キーは左下で「客」の表示に、ドリフトは右下で「歩様」の表示にかぶっていた。
  // スマホのレースゲームでよくある並びにする: 左手 = ◀ ▶（曲がる）、右手 = 鞭（進む）・手綱（止まる）・ドリフト。
  // 同じ手のボタンはすき間なく並べ、指を滑らせると隣に乗り換えられる（押したまま ◀ → ▶ など）。
  // 指ごとに「いま乗っているボタン」を持つので、左右の手で同時に押せる。
  const ui = document.createElement('div');
  ui.className = 'touch-ui';
  ui.innerHTML = `
    <div class="tgroup tg-steer">
      <div class="tbtn tb-left" data-key="left"><span class="ico">◀</span></div>
      <div class="tbtn tb-right" data-key="right"><span class="ico">▶</span></div>
    </div>
    <div class="tgroup tg-drive">
      <div class="tbtn tb-hand" data-key="hand"><span class="lbl">ドリフト</span></div>
      <div class="tbtn tb-down" data-key="down"><span class="ico">▼</span><span class="lbl">手綱</span></div>
      <div class="tbtn tb-up" data-key="up"><span class="ico">▲</span><span class="lbl">鞭</span></div>
    </div>
    <button class="retry" id="touch-retry" type="button" aria-label="やり直し">↺</button>`;
  root.appendChild(ui);

  const btnEls = {};
  for (const el of ui.querySelectorAll('.tbtn')) btnEls[el.dataset.key] = el;
  const tState = { up: false, down: false, left: false, right: false, hand: false };
  const pointers = new Map(); // pointerId -> { group, keys:Set }

  function keysAt(x, y, group) {
    const s = new Set();
    for (const el of document.elementsFromPoint(x, y)) {
      const k = el.dataset && el.dataset.key;
      if (k && group.contains(el)) s.add(k);
    }
    return s;
  }
  function recompute() {
    const next = { up: false, down: false, left: false, right: false, hand: false };
    for (const p of pointers.values()) for (const k of p.keys) next[k] = true;
    for (const k of Object.keys(tState)) {
      if (tState[k] !== next[k]) {
        tState[k] = next[k]; btnEls[k].classList.toggle('on', next[k]);
        if (next[k] && navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
      }
    }
  }
  function useTouch() { if (!api.touch) { api.touch = true; ui.classList.add('on'); document.body.classList.add('touch-mode'); } }
  for (const group of ui.querySelectorAll('.tgroup')) {
    group.addEventListener('pointerdown', (e) => {
      try { group.setPointerCapture(e.pointerId); } catch {}
      pointers.set(e.pointerId, { group, keys: keysAt(e.clientX, e.clientY, group) });
      recompute(); useTouch(); e.preventDefault();
    });
    group.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId); if (!p) return;
      p.keys = keysAt(e.clientX, e.clientY, group); recompute(); e.preventDefault();
    });
    const up = (e) => { if (pointers.delete(e.pointerId)) recompute(); };
    group.addEventListener('pointerup', up);
    group.addEventListener('pointercancel', up);
    group.addEventListener('lostpointercapture', up);
  }
  ui.querySelector('#touch-retry').addEventListener('click', () => api.onRetry?.());
  if (matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch')) useTouch(); // ?touch で PC でも出す（撮影用）
  // 画面が裏に回ったら全部離す（押しっぱなしで戻ってこないように）
  addEventListener('visibilitychange', () => { if (document.hidden) { pointers.clear(); recompute(); } });

  // 長押しで文字選択・コピーのメニュー・拡大鏡が出ないようにする（天才さん「コピペもできないようにしないと長押し対応しない」）
  for (const ev of ['contextmenu', 'selectstart', 'gesturestart', 'dblclick']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  function read() {
    return {
      up: keys.has('up') || tState.up,
      down: keys.has('down') || tState.down,
      left: keys.has('left') || tState.left,
      right: keys.has('right') || tState.right,
      hand: keys.has('hand') || tState.hand,
    };
  }
  return Object.assign(api, { read, keys, element: ui });
}
