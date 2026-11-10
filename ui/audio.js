// ui/audio.js — WebAudio 合成（素材ファイル無し）
//   蹄（歩様で間隔が変わる）/ 鞭 / 嘶き / 衝突の鈍い音 / 物が壊れる音 / 客の悲鳴 / 鳩の羽音 / 到着のチーン＋倍率の積み上がり / 街の環境音
//
//   const audio = createAudio();
//   audio.resume()                     // 最初のユーザー操作で呼ぶ（autoplay 制限）
//   audio.onEvent(ev)                  // g.events の各要素
//   audio.update(dt, g.player)         // 蹄・風・環境音
//   audio.setMuted(bool) / audio.muted

export function createAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, master = null, noiseBuf = null, ambient = null;
  const api = { muted: false, ready: false };

  function ensure() {
    if (ctx) return true;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
    // ノイズのバッファ（1 秒）
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    startAmbient();
    api.ready = true;
    return true;
  }
  function resume() { if (!ensure()) return; if (ctx.state === 'suspended') ctx.resume(); }
  function setMuted(m) { api.muted = m; if (master) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.05); }

  const now = () => ctx.currentTime;
  function noise(duration, { gain = 0.3, freq = 1000, q = 1, type = 'bandpass', attack = 0.002, decay = 0.1, delay = 0 } = {}) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); const t = now() + delay;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0005, t + attack + decay);
    src.connect(f); f.connect(g); g.connect(master); src.start(t); src.stop(t + attack + decay + duration);
    return { src, f, g };
  }
  function tone(freq, duration, { gain = 0.2, type = 'sine', attack = 0.005, decay = null, slide = null, delay = 0 } = {}) {
    const o = ctx.createOscillator(); o.type = type; const t = now() + delay;
    o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + duration);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0005, t + (decay ?? duration));
    o.connect(g); g.connect(master); o.start(t); o.stop(t + Math.max(duration, decay ?? 0) + 0.05);
    return o;
  }

  // ---- 蹄: 石畳をコツコツ。歩様で間隔と硬さが変わる
  function hoof(hard = 0.5) {
    noise(0.05, { gain: 0.18 + hard * 0.2, freq: 1400 + hard * 1200, q: 2, decay: 0.04 + hard * 0.03 });
    tone(140 + hard * 60, 0.05, { gain: 0.12, type: 'triangle', decay: 0.05, slide: 60 });
  }
  function whip() { noise(0.02, { gain: 0.35, freq: 4000, q: 0.7, type: 'highpass', attack: 0.001, decay: 0.07 }); tone(2200, 0.08, { gain: 0.08, type: 'square', slide: 600 }); }
  function neigh() {
    // 嘶き: 高い倍音の揺れる音を 2 段で下げる
    for (let i = 0; i < 3; i++) {
      const o = tone(900 + i * 420, 0.5, { gain: 0.06, type: 'sawtooth', delay: 0.02 * i, slide: 500 + i * 200, decay: 0.5 });
      const lfo = ctx.createOscillator(); lfo.frequency.value = 18; const lg = ctx.createGain(); lg.gain.value = 60; lfo.connect(lg); lg.connect(o.frequency); lfo.start(); lfo.stop(now() + 0.6);
    }
  }
  function crash(v = 5) {
    const k = Math.min(1, v / 12);
    noise(0.1, { gain: 0.4 + k * 0.5, freq: 120 + k * 200, q: 0.8, type: 'lowpass', decay: 0.25 + k * 0.2 });
    tone(70, 0.3, { gain: 0.35, type: 'sine', slide: 30, decay: 0.3 });
    if (k > 0.4) noise(0.05, { gain: 0.3, freq: 2500, q: 1.5, decay: 0.12, delay: 0.01 });
  }
  function breakSound(kind) {
    const wooden = kind === 'chair' || kind === 'table' || kind === 'stand';
    if (wooden) { for (let i = 0; i < 4; i++) noise(0.03, { gain: 0.25, freq: 900 + Math.random() * 1500, q: 4, decay: 0.08, delay: i * 0.03 }); }
    else { for (let i = 0; i < 6; i++) tone(2400 + Math.random() * 2500, 0.08, { gain: 0.07, type: 'sine', decay: 0.1 + Math.random() * 0.15, delay: i * 0.02 }); noise(0.05, { gain: 0.2, freq: 3500, q: 2, decay: 0.15 }); }
  }
  function scream(level = 1) {
    const base = 600 + Math.random() * 200;
    const o = tone(base, 0.45, { gain: 0.08 * level, type: 'sawtooth', slide: base * 1.6, decay: 0.45 });
    const lfo = ctx.createOscillator(); lfo.frequency.value = 9; const lg = ctx.createGain(); lg.gain.value = 40; lfo.connect(lg); lg.connect(o.frequency); lfo.start(); lfo.stop(now() + 0.5);
  }
  function wings(n = 8) { for (let i = 0; i < Math.min(n, 10); i++) noise(0.03, { gain: 0.12, freq: 600 + Math.random() * 400, q: 1.2, decay: 0.06, delay: i * 0.05 + Math.random() * 0.03 }); }
  function chime(mult = 1) {
    tone(1318, 0.9, { gain: 0.2, type: 'sine', decay: 0.9 }); tone(2637, 0.6, { gain: 0.08, type: 'sine', decay: 0.6 });
    // 倍率が積み上がる音: 上がる 3 音
    const steps = Math.round(2 + Math.min(4, mult * 2));
    for (let i = 0; i < steps; i++) tone(880 * Math.pow(2, i / 12 * 2), 0.18, { gain: 0.1, type: 'triangle', decay: 0.18, delay: 0.35 + i * 0.12 });
  }
  function yen() { tone(1760, 0.06, { gain: 0.06, type: 'square', decay: 0.06 }); }

  // ---- 街の環境音: 低いざわめき（フィルタしたノイズ）+ 風
  let windGain = null;
  function startAmbient() {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500; f.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0.04;
    src.connect(f); f.connect(g); g.connect(master); src.start();
    const w = ctx.createBufferSource(); w.buffer = noiseBuf; w.loop = true;
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 900; wf.Q.value = 0.4;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    w.connect(wf); wf.connect(windGain); windGain.connect(master); w.start();
    ambient = { src, g };
  }

  // ---- 毎フレーム: 蹄の間隔は歩様の周期（phase が一周するたび 2〜4 回）
  let lastPhase = 0;
  function update(dt, player) {
    if (!ctx || api.muted) return;
    const h = player?.horse; if (!h) return;
    const gait = h.gait || 0;
    if (gait > 0) {
      const beats = gait >= 3 ? 3 : 4;              // 駆け足は 3 拍、並足・速足は 4 拍
      const a = Math.floor(lastPhase * beats), b = Math.floor((h.phase || 0) * beats);
      if (b !== a) { hoof(gait / 4); if (gait >= 2) hoof(gait / 4 - 0.2); }
    }
    lastPhase = h.phase || 0;
    if (windGain) windGain.gain.setTargetAtTime(Math.max(0, (player.speed - 7) / 6) * 0.12, now(), 0.1);
  }

  function onEvent(ev) {
    if (!ctx || api.muted) return;
    switch (ev.type) {
      case 'whip': whip(); if (Math.random() < 0.25) neigh(); break;
      case 'gait': if (ev.gait === 4) neigh(); break;
      case 'crash': crash(ev.v); if (ev.with === 'prop') breakSound(ev.kind); break;
      case 'launch': breakSound(ev.kind); break;
      case 'penalty': yen(); break;
      case 'pedHit': scream(1); break;
      case 'pedDodge': if (Math.random() < 0.5) scream(0.5); break;
      case 'safety': if (ev.delta < -8) scream(0.7); break;
      case 'hatLost': scream(1); break;
      case 'pigeons': wings(ev.n); break;
      case 'arrive': chime(ev.ride?.safetyMult || 1); break;
      case 'over': tone(440, 0.6, { gain: 0.15, type: 'triangle', decay: 0.6 }); tone(330, 0.9, { gain: 0.15, type: 'triangle', decay: 0.9, delay: 0.3 }); break;
    }
  }

  return Object.assign(api, { resume, setMuted, onEvent, update, get context() { return ctx; } });
}
