// sim/world.js — 地図データ(map/vienna.js) → 道路グラフ・歩道・横断歩道・建物の当たり判定・小物の配置。
// three.js にも DOM にも依存しない。createGame() の最初に一度だけ buildWorld() を呼ぶ。

import { ROADS, PLAZAS, LANDMARKS, STANDS, RIDE_PAIRS, MAP_BOUNDS } from '../map/vienna.js';
import { TUNE } from './tune.js';
import { satOBB, buildGrid } from './collide.js';

function dist(x0, z0, x1, z1) {
  return Math.hypot(x1 - x0, z1 - z0);
}

function nodeKey(x, z) {
  return `${Math.round(x * 100) / 100}:${Math.round(z * 100) / 100}`;
}

// ---------------------------------------------------------------------
// 道路セグメント化 + グラフ
// ---------------------------------------------------------------------
function buildSegmentsAndGraph() {
  const segments = [];
  const nodes = new Map(); // key -> {x,z}
  const adjacency = new Map(); // key -> [{to,length,segIdx}]

  function ensureNode(x, z) {
    const k = nodeKey(x, z);
    if (!nodes.has(k)) nodes.set(k, { x, z, key: k });
    return k;
  }
  function addEdge(ka, kb, length, segIdx) {
    if (!adjacency.has(ka)) adjacency.set(ka, []);
    if (!adjacency.has(kb)) adjacency.set(kb, []);
    adjacency.get(ka).push({ to: kb, length, segIdx });
    adjacency.get(kb).push({ to: ka, length, segIdx });
  }

  ROADS.forEach((road, roadIdx) => {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const [x0, z0] = road.pts[i];
      const [x1, z1] = road.pts[i + 1];
      const len = dist(x0, z0, x1, z1);
      if (len < 1e-6) continue;
      const dx = (x1 - x0) / len, dz = (z1 - z0) / len;
      // 法線（右手系 XZ 平面で進行方向を90度回す）
      const nx = -dz, nz = dx;
      const segIdx = segments.length;
      segments.push({
        segIdx, roadIdx, roadId: road.id, name: road.name, kind: road.kind,
        width: road.width, x0, z0, x1, z1, dx, dz, nx, nz, len,
      });
      const ka = ensureNode(x0, z0);
      const kb = ensureNode(x1, z1);
      addEdge(ka, kb, len, segIdx);
    }
  });

  return { segments, nodes, adjacency };
}

// 道路の断面（歩道幅・車道半幅・トラム帯半幅）
export function crossSection(seg) {
  const hw = seg.width / 2;
  if (seg.kind === 'ped') return { sidewalk: 0, carLane: hw, tram: 0 };
  if (seg.kind === 'ring') {
    const sidewalk = Math.min(12, hw * 0.3);
    const tram = Math.min(3.5, hw * 0.15);
    const carLane = Math.max(1, hw - sidewalk - tram);
    return { sidewalk, carLane, tram };
  }
  const sidewalk = Math.min(3.5, hw * 0.4);
  const carLane = Math.max(1, hw - sidewalk);
  return { sidewalk, carLane, tram: 0 };
}

// 点 (x,z) に最も近い道路セグメントを返す（距離・射影 t・横方向オフセットつき）
export function nearestSegment(world, x, z) {
  let best = null, bestDist = Infinity;
  for (const seg of world.segments) {
    const px = x - seg.x0, pz = z - seg.z0;
    let t = px * seg.dx + pz * seg.dz;
    t = Math.max(0, Math.min(seg.len, t));
    const cx = seg.x0 + seg.dx * t, cz = seg.z0 + seg.dz * t;
    const d = dist(x, z, cx, cz);
    if (d < bestDist) {
      bestDist = d;
      const lateral = (x - cx) * seg.nx + (z - cz) * seg.nz;
      best = { seg, t, cx, cz, dist: d, lateral };
    }
  }
  return best;
}

export function pointInPlaza(x, z) {
  for (const p of PLAZAS) {
    if (p.rect) {
      const [[x0, z0], [x1, z1]] = p.rect;
      if (x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && z >= Math.min(z0, z1) && z <= Math.max(z0, z1)) return p;
    } else if (p.circle) {
      if (dist(x, z, p.circle.c[0], p.circle.c[1]) <= p.circle.r) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// 交差点 → 横断歩道
// ---------------------------------------------------------------------
function buildCrosswalks(graph) {
  const crosswalks = [];
  for (const [key, node] of graph.nodes) {
    const edges = graph.adjacency.get(key) || [];
    // 交わる道路の種類（roadId）が2つ以上ある交差点だけを対象にする
    const roadIds = new Set(edges.map((e) => graph.segments[e.segIdx].roadId));
    if (roadIds.size < 2) continue;
    for (const e of edges) {
      const seg = graph.segments[e.segIdx];
      if (seg.kind === 'ped') continue; // 歩行者ゾーンは横断不要（全幅歩ける）
      // ノードから道路に沿って内側へ offset だけ入った位置に横断帯を置く
      const atStart = dist(seg.x0, seg.z0, node.x, node.z) < 0.5;
      const offset = Math.min(6, seg.len * 0.3);
      const t = atStart ? offset : seg.len - offset;
      const cx = seg.x0 + seg.dx * t, cz = seg.z0 + seg.dz * t;
      crosswalks.push({
        segIdx: seg.segIdx, cx, cz, dx: seg.dx, dz: seg.dz, nx: seg.nx, nz: seg.nz,
        halfWidth: seg.width / 2, halfDepth: 2.2, nodeKey: key,
      });
    }
  }
  return crosswalks;
}

// ---------------------------------------------------------------------
// 建物（OBB/円の静的コライダー）
// ---------------------------------------------------------------------
function segAsBox(seg, margin) {
  return {
    cx: (seg.x0 + seg.x1) / 2, cz: (seg.z0 + seg.z1) / 2,
    yaw: Math.atan2(seg.dz, seg.dx), hl: seg.len / 2, hw: seg.width / 2 + margin,
  };
}

// ランドマークの箱が street/ring の車道にかぶっていたら、中心は動かさず収縮させて道を空ける。
// ped(歩行者ゾーン)・広場に立つのは資料どおりなのでそのままにする（ペスト記念柱など）。
function shrinkBoxToClearRoads(box, roadSegs) {
  let scale = 1;
  for (let iter = 0; iter < 40; iter++) {
    const testBox = { ...box, hl: box.hl * scale, hw: box.hw * scale };
    let hit = false;
    for (const seg of roadSegs) {
      if (satOBB(testBox, segAsBox(seg, 1.0))) { hit = true; break; }
    }
    if (!hit) return testBox;
    scale *= 0.92;
    if (scale < 0.2) return testBox;
  }
  return { ...box, hl: box.hl * scale, hw: box.hw * scale };
}

// HoherMarkt(アンカー時計)は通りをまたぐ「渡り廊下」なので地上の当たり判定からは除外する
const NO_COLLIDE_LANDMARKS = new Set(['HoherMarkt']);

function landmarkColliders(segments) {
  const roadSegs = segments.filter((s) => s.kind === 'street' || s.kind === 'ring');
  return LANDMARKS.filter((l) => !NO_COLLIDE_LANDMARKS.has(l.id)).map((l) => {
    if (l.shape === 'circle') {
      return { type: 'circle', kind: 'landmark', id: l.id, cx: l.x, cz: l.z, r: l.r };
    }
    const box = shrinkBoxToClearRoads({ cx: l.x, cz: l.z, yaw: l.yaw || 0, hl: l.hl, hw: l.hw }, roadSegs);
    return { type: 'box', kind: 'landmark', id: l.id, ...box };
  });
}

function obbCorners(b) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const fx = c, fz = s, lx = -s, lz = c;
  return [
    { x: b.cx + fx * b.hl + lx * b.hw, z: b.cz + fz * b.hl + lz * b.hw },
    { x: b.cx + fx * b.hl - lx * b.hw, z: b.cz + fz * b.hl - lz * b.hw },
    { x: b.cx - fx * b.hl + lx * b.hw, z: b.cz - fz * b.hl + lz * b.hw },
    { x: b.cx - fx * b.hl - lx * b.hw, z: b.cz - fz * b.hl - lz * b.hw },
  ];
}

function boxesRoughlyOverlap(a, b) {
  const ra = Math.hypot(a.hl, a.hw), rb = Math.hypot(b.hl, b.hw);
  return dist(a.cx, a.cz, b.cx, b.cz) < ra + rb;
}

function tooCloseToOtherRoad(world, ownSegIdx, cx, cz, clearance) {
  for (const seg of world.segments) {
    if (seg.segIdx === ownSegIdx) continue;
    const near = nearestSegment({ segments: [seg] }, cx, cz);
    if (near && near.dist < seg.width / 2 + clearance) return true;
  }
  return false;
}

function overlapsPlazaOrLandmark(cx, cz, radius, landmarks) {
  if (pointInPlaza(cx, cz)) return true;
  for (const l of landmarks) {
    const r = l.type === 'circle' ? l.r : Math.hypot(l.hl, l.hw);
    if (dist(cx, cz, l.cx, l.cz) < r + radius + 8) return true;
  }
  return false;
}

const FACADE_TYPES = [
  { type: 'B', weight: 50 }, { type: 'A', weight: 20 },
  { type: 'C', weight: 15, ringOnly: true }, { type: 'D', weight: 15 },
];

function pickFacadeType(rng, isRing) {
  const pool = FACADE_TYPES.filter((f) => isRing || !f.ringOnly);
  const total = pool.reduce((s, f) => s + f.weight, 0);
  let r = rng.next() * total;
  for (const f of pool) { r -= f.weight; if (r <= 0) return f.type; }
  return pool[0].type;
}

// 街区の建物を道路沿いに手続き生成する（厳密な街区ポリゴン分割はせず、
// 各道路の両側に間口15〜30mのOBBを並べる簡略法。sim は当たり判定だけ要るため、
// 見た目のファサード生成は render/city.js の担当 — ここでは type ヒントだけ残す）。
function buildBlockBuildings(world, rng, landmarks) {
  // 2026-10-02 主ループ改訂: 以前は建物の間に 0〜3m のすき間を空け、重なり判定を外接円で行っていたため
  // 隣り合うだけの建物が「重なり」とされて約半分が捨てられ、街区の内側も空き地だった
  // （3D で建物の隙間から暗い空き地が見える＝安っぽさの原因）。
  // → すき間なしで連続させ、重なりは OBB の正確な判定（2% 縮めて隣接は許す）、1列目の後ろに2列目を置いて街区を埋める
  const out = [];
  const ROWS = [{ depth: 18, offset: 0 }, { depth: 22, offset: 18 }];
  for (const seg of world.segments) {
    const hw = seg.width / 2;
    const cs = crossSection(seg);
    const setback = hw + 1.0; // 歩道の外側からさらに1m離す
    for (const sign of [-1, 1]) {
      for (let ri = 0; ri < ROWS.length; ri++) {
        const row = ROWS[ri];
        let pos = 8;
        const maxPos = seg.len - 8;
        while (pos < maxPos) {
          const frontage = Math.min(12 + rng.range(0, 12), maxPos - pos);
          if (frontage < 6) break;
          const mid = pos + frontage / 2;
          pos += frontage;
          const px = seg.x0 + seg.dx * mid, pz = seg.z0 + seg.dz * mid;
          const off = setback + row.offset + row.depth / 2;
          const cx = px + seg.nx * sign * off;
          const cz = pz + seg.nz * sign * off;
          const yaw = Math.atan2(seg.dz, seg.dx);
          const box = { type: 'box', kind: 'building', cx, cz, yaw, hl: frontage / 2, hw: row.depth / 2,
            facade: pickFacadeType(rng, seg.kind === 'ring'), rear: ri > 0 };

          if (cx < MAP_BOUNDS.x0 + 5 || cx > MAP_BOUNDS.x1 - 5 || cz < MAP_BOUNDS.z0 + 5 || cz > MAP_BOUNDS.z1 - 5) continue;
          if (overlapsPlazaOrLandmark(cx, cz, Math.min(box.hl, box.hw), landmarks)) continue;
          // 建物のどの部分も他の道路（歩道込み）にかからないこと: 箱の4隅と中心で判定
          const probe = { ...box, hl: box.hl * 0.98, hw: box.hw * 0.98 };
          let onRoad = false;
          for (const [qx, qz] of obbCorners(probe).map(c => [c.x, c.z]).concat([[cx, cz]])) {
            if (tooCloseToOtherRoad(world, seg.segIdx, qx, qz, 1.0) || pointInPlaza(qx, qz)) { onRoad = true; break; }
            if (ri > 0) { const n = nearestSegment({ segments: [seg] }, qx, qz); if (n && n.dist < hw + 0.5) { onRoad = true; break; } }
          }
          if (onRoad) continue;
          let clash = false;
          for (const other of out) {
            if (Math.hypot(other.cx - cx, other.cz - cz) > other.br0 + Math.hypot(box.hl, box.hw)) continue;
            if (satOBB({ ...box, hl: box.hl * 0.98, hw: box.hw * 0.98 }, { ...other, hl: other.hl * 0.98, hw: other.hw * 0.98 })) { clash = true; break; }
          }
          if (clash) continue;
          box.br0 = Math.hypot(box.hl, box.hw);
          // 賑わい 2026-10-03: 1列目の一部をカフェにする（正面の歩道に屋外席を並べ、看板・日よけを render が出す）。
          // 正面＝道路側。frontX/frontZ はファサードの中心（道路の縁から 1m 外）、frontNx/Nz は正面から道路へ向く法線
          if (ri === 0 && frontage >= 14 && seg.kind !== 'ring' && rng.next() < 0.18) {
            box.cafe = true;
            box.frontX = px + seg.nx * sign * setback; box.frontZ = pz + seg.nz * sign * setback;
            box.frontNx = -seg.nx * sign; box.frontNz = -seg.nz * sign;
            box.frontSegIdx = seg.segIdx;
          }
          out.push(box);
        }
      }
    }
  }
  for (const b of out) delete b.br0;
  return out;
}

// ---------------------------------------------------------------------
// トラム経路: ring 種別の道路だけをたどって2本の往復ラインを作る
// ---------------------------------------------------------------------
function buildTramLines(graph) {
  const ringSegs = graph.segments.filter((s) => s.kind === 'ring');
  if (ringSegs.length === 0) return [];
  // ring の隣接表を作る
  const adj = new Map();
  for (const seg of ringSegs) {
    const ka = nodeKey(seg.x0, seg.z0), kb = nodeKey(seg.x1, seg.z1);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ to: kb, seg });
    adj.get(kb).push({ to: ka, seg });
  }
  const lines = [];
  // 連結成分ごとに BFS で木を作り、最長パスを1本の折れ線として採用する（単純化）
  const compVisited = new Set();
  for (const [startKey] of adj) {
    if (compVisited.has(startKey)) continue;
    // 成分探索
    const compNodes = [];
    const stack = [startKey];
    const seen = new Set([startKey]);
    while (stack.length) {
      const k = stack.pop();
      compNodes.push(k);
      for (const e of adj.get(k) || []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
    compNodes.forEach((k) => compVisited.add(k));
    // 端点（次数1）を探す。なければ適当なノードから開始
    let startNode = compNodes.find((k) => (adj.get(k) || []).length === 1) || compNodes[0];
    // BFS で最も遠いノードを探す→そこから再度最遠ノードを探す（木の直径、簡易）
    function farthest(from) {
      const dist0 = new Map([[from, 0]]);
      const prev = new Map();
      const q = [from];
      while (q.length) {
        const k = q.shift();
        for (const e of adj.get(k) || []) {
          if (!dist0.has(e.to)) {
            dist0.set(e.to, dist0.get(k) + e.seg.len);
            prev.set(e.to, { from: k, seg: e.seg });
            q.push(e.to);
          }
        }
      }
      let far = from, best = 0;
      for (const [k, d] of dist0) if (d > best) { best = d; far = k; }
      return { far, prev };
    }
    const a = farthest(startNode);
    const b = farthest(a.far);
    // b.far から prev を辿って経路を復元
    const path = [];
    let cur = b.far;
    while (cur !== a.far) {
      const p = b.prev.get(cur);
      path.push(p.seg);
      cur = p.from;
    }
    path.reverse();
    if (path.length === 0) continue;
    const pts = [{ x: path[0].x0, z: path[0].z0 }];
    for (const seg of path) pts.push({ x: seg.x1, z: seg.z1 });
    const total = path.reduce((s, seg) => s + seg.len, 0);
    lines.push({ pts, length: total, nodeSet: seen });
  }
  lines.sort((x, y) => y.length - x.length);
  return lines;
}

// ---------------------------------------------------------------------
// 小物(props)の静的配置
// ---------------------------------------------------------------------
const PROP_KINDS = [
  { kind: 'chair', r: 0.25, weight: 30 },
  { kind: 'table', r: 0.4, weight: 10 },
  { kind: 'pot', r: 0.5, weight: 10 },
  { kind: 'bike', r: 0.4, weight: 8 },
  { kind: 'adColumn', r: 0.7, weight: 4 },
  { kind: 'stand', r: 0.6, weight: 6 },
  { kind: 'trash', r: 0.25, weight: 8 },   // 賑わい 2026-10-03: ウィーン市のオレンジのゴミ箱
];
const BOLLARD_WEIGHT = 32; // 全体数に占めるボラードの目安比率

function pickPropKind(rng) {
  const total = PROP_KINDS.reduce((s, p) => s + p.weight, 0);
  let r = rng.next() * total;
  for (const p of PROP_KINDS) { r -= p.weight; if (r <= 0) return p; }
  return PROP_KINDS[0];
}

// カフェの屋外席（賑わい 2026-10-03）: カフェ建物の正面の歩道に、通り沿いに丸テーブルを並べ、
// 両脇に椅子（通りの向きに向かい合わせ）、1つおきにパラソル。椅子は cafeSeats に登録し、歩行者が座る（sim/actors.js）。
// 横位置は「歩道の内側 0.9m 以上」に収めて、座っている人が車道判定（carLane+0.15）に掛からないようにする
function buildCafeClusters(world, rng, blockBuildings, props, stopRects) {
  const seats = [];
  for (const b of blockBuildings) {
    if (!b.cafe) continue;
    const seg = world.segments[b.frontSegIdx];
    const cs = crossSection(seg);
    const hw = seg.width / 2;
    // 道路中心からの横位置（絶対値）: ファサードは hw+1。テーブル列はファサードから 1.4m 外 = hw-0.4 → ただし歩道の内側 1.0m を保つ
    const lateralAbs = Math.max(cs.carLane + cs.tram + 1.0, hw - 1.3);
    if (lateralAbs > hw - 0.4) continue; // 歩道が狭すぎる
    const dFromFacade = (hw + 1) - lateralAbs;
    const n = Math.min(4, Math.max(2, Math.floor((b.hl * 2 - 6) / 2.6)));
    const ux = seg.dx, uz = seg.dz;                      // 通りの向き
    const ox = b.frontNx, oz = b.frontNz;                // ファサード → 道路
    const yawAlong = Math.atan2(uz, ux);
    for (let i = 0; i < n; i++) {
      const u = -((n - 1) / 2) * 2.6 + i * 2.6;
      const tx = b.frontX + ux * u + ox * dFromFacade, tz = b.frontZ + uz * u + oz * dFromFacade;
      let blocked = false;
      for (const r of stopRects) if (Math.abs(tx - r.cx) < r.hl + 2 && Math.abs(tz - r.cz) < r.hw + 2) { blocked = true; break; }
      if (dist(tx, tz, seg.x0, seg.z0) < 9 || dist(tx, tz, seg.x1, seg.z1) < 9) blocked = true;
      if (blocked) continue;
      props.push({ id: props.length, kind: 'table', x: tx, z: tz, yaw: rng.range(0, Math.PI * 2), r: 0.4, cafe: true });
      if (i % 2 === 0) props.push({ id: props.length, kind: 'parasol', x: tx, z: tz, yaw: rng.range(0, Math.PI * 2), r: 0.3, cafe: true });
      for (const s of [-1, 1]) {
        const cx = tx + ux * s * 0.72, cz = tz + uz * s * 0.72;
        const yaw = yawAlong + (s > 0 ? Math.PI : 0); // 椅子はテーブルの方を向く（+x が前）
        props.push({ id: props.length, kind: 'chair', x: cx, z: cz, yaw, r: 0.25, cafe: true });
        seats.push({ x: cx, z: cz, yaw, propId: props.length - 1, segIdx: seg.segIdx, occupant: -1 });
      }
    }
  }
  return seats;
}

function buildPropsAndBollards(world, rng, stopRects, blockBuildings) {
  const props = [];
  const bollards = [];
  const targetTotal = Math.round(TUNE.props.total[0] + rng.next() * (TUNE.props.total[1] - TUNE.props.total[0]));
  const targetBollards = Math.round(targetTotal * (BOLLARD_WEIGHT / (BOLLARD_WEIGHT + 100)));
  const cafeSeats = buildCafeClusters(world, rng, blockBuildings, props, stopRects);
  const cafeCount = props.length;
  const targetProps = targetTotal - targetBollards + cafeCount;

  function blockedByStopRect(x, z) {
    for (const r of stopRects) {
      if (Math.abs(x - r.cx) < r.hl + 2 && Math.abs(z - r.cz) < r.hw + 2) return true;
    }
    return false;
  }

  // 候補帯: ped 道路の路肩(小物ゾーン) + 街/リングの歩道、交差点・横断歩道・停車枠は避ける
  const candidateSegs = world.segments;
  let guardProps = 0, guardBollards = 0;
  while ((props.length < targetProps || bollards.length < targetBollards) && guardProps + guardBollards < (targetTotal + 400) * 6) {
    const seg = candidateSegs[rng.int(0, candidateSegs.length)];
    const t = rng.range(6, Math.max(6.01, seg.len - 6));
    const cs = crossSection(seg);
    const hw = seg.width / 2;
    const sign = rng.next() < 0.5 ? -1 : 1;
    let lateral;
    const wantBollard = bollards.length < targetBollards && (props.length >= targetProps || rng.next() < 0.5);
    if (seg.kind === 'ped') {
      // 中央レーンの外側(小物ゾーン)
      lateral = sign * (cs.carLane + 0.6 + rng.next() * (hw - cs.carLane - 1.2));
    } else {
      // 歩道帯の中
      const sidewalkInner = cs.carLane + 0.4;
      lateral = sign * (sidewalkInner + rng.next() * Math.max(0.5, cs.sidewalk - 0.8));
    }
    const px = seg.x0 + seg.dx * t, pz = seg.z0 + seg.dz * t;
    const x = px + seg.nx * lateral, z = pz + seg.nz * lateral;

    if (blockedByStopRect(x, z)) { wantBollard ? guardBollards++ : guardProps++; continue; }
    // 交差点付近(頂点から8m以内)は空ける
    if (dist(x, z, seg.x0, seg.z0) < 8 || dist(x, z, seg.x1, seg.z1) < 8) { wantBollard ? guardBollards++ : guardProps++; continue; }

    if (wantBollard) {
      const r = 0.12;
      let ok = true;
      for (const b of bollards) if (dist(x, z, b.cx, b.cz) < r * 2 + 0.3) { ok = false; break; }
      for (let i = 0; i < cafeCount && ok; i++) if (dist(x, z, props[i].x, props[i].z) < 1.0) ok = false; // 座っている人とボラードが重ならない
      if (ok && bollards.length < targetBollards) bollards.push({ type: 'circle', kind: 'bollard', cx: x, cz: z, r });
      else guardBollards++;
    } else {
      const spec = pickPropKind(rng);
      let ok = true;
      for (const p of props) if (dist(x, z, p.x, p.z) < spec.r * 2 + 0.3) { ok = false; break; }
      if (ok && props.length < targetProps) {
        props.push({ id: props.length, kind: spec.kind, x, z, yaw: rng.range(0, Math.PI * 2), r: spec.r });
      } else guardProps++;
    }
  }
  return { props, bollards, cafeSeats };
}

// ---------------------------------------------------------------------
// 広場の「生活の絵」（賑わい 2026-10-03）: 広場ごとに屋台（Würstelstand。円の当たり判定）と
// 大道芸人の立ち位置（観客 3 人の枠つき）。歩行者の歩く帯（道路の幅+4m）・ランドマーク・停車枠・乗り場を避ける
// ---------------------------------------------------------------------
function buildPlazaScenes(world, rng, landmarks, stopRects) {
  const kiosks = [], scenes = [];
  const clearOf = (x, z, margin) => {
    for (const seg of world.segments) {
      const near = nearestSegment({ segments: [seg] }, x, z);
      if (near && near.dist < seg.width / 2 + margin) return false;
    }
    for (const l of landmarks) {
      const r = l.type === 'circle' ? l.r : Math.hypot(l.hl, l.hw);
      if (dist(x, z, l.cx, l.cz) < r + margin) return false;
    }
    for (const r of stopRects) if (Math.abs(x - r.cx) < r.hl + margin && Math.abs(z - r.cz) < r.hw + margin) return false;
    for (const s of STANDS) if (dist(x, z, s.x, s.z) < margin + 4) return false;
    return true;
  };
  for (const p of PLAZAS) {
    let spot = null;
    for (let tries = 0; tries < 60 && !spot; tries++) {
      let x, z;
      if (p.rect) { const [[x0, z0], [x1, z1]] = p.rect; x = rng.range(Math.min(x0, x1) + 8, Math.max(x0, x1) - 8); z = rng.range(Math.min(z0, z1) + 8, Math.max(z0, z1) - 8); }
      else { const a = rng.range(0, Math.PI * 2), r = rng.range(0, p.circle.r - 10); x = p.circle.c[0] + Math.cos(a) * r; z = p.circle.c[1] + Math.sin(a) * r; }
      if (clearOf(x, z, 4.5)) spot = { x, z };
    }
    if (!spot) continue;
    const yaw = rng.range(0, Math.PI * 2);
    kiosks.push({ type: 'circle', kind: 'kiosk', id: 'kiosk:' + p.id, cx: spot.x, cz: spot.z, r: 1.7, yaw, plazaId: p.id });
    // 大道芸人は屋台から 7m 離れた所。観客 3 人は芸人の周り半径 2.4m（芸人の方を向く）
    const a = yaw + Math.PI / 2;
    const px = spot.x + Math.cos(a) * 7, pz = spot.z + Math.sin(a) * 7;
    if (clearOf(px, pz, 3.5)) {
      const watchers = [];
      for (let k = 0; k < 3; k++) { const wa = a + Math.PI * 0.55 + k * 0.9; watchers.push({ x: px + Math.cos(wa) * 2.4, z: pz + Math.sin(wa) * 2.4, yaw: wa + Math.PI, occupant: -1 }); }
      scenes.push({ kind: 'performer', x: px, z: pz, yaw: a + Math.PI, plazaId: p.id, occupant: -1, watchers });
    }
  }
  return { kiosks, scenes };
}

// ---------------------------------------------------------------------
// ライド(出発/目的地)の停車枠
// ---------------------------------------------------------------------
function buildStopRects(world) {
  return RIDE_PAIRS.flatMap((pair, i) => {
    return [pair.from, pair.to].map((pt) => {
      const near = nearestSegment(world, pt.x, pt.z);
      const yaw = near ? Math.atan2(near.seg.dz, near.seg.dx) : 0;
      return { key: `${pt.x},${pt.z}`, name: pt.name, cx: pt.x, cz: pt.z, yaw, hl: 4, hw: 2 };
    });
  }).filter((r, i, arr) => arr.findIndex((o) => o.key === r.key) === i); // 重複する地点は1つに
}

// 歩道帯（render が路面メッシュを作るための帯データ）。
// street/ring は車道の外側に帯を2本、ped は全幅が歩道なので帯を出さない（道路そのものが歩道）。
function buildSidewalks(segments) {
  const sidewalks = [];
  for (const seg of segments) {
    if (seg.kind === 'ped') continue;
    const cs = crossSection(seg);
    const hw = seg.width / 2;
    const innerLat = seg.kind === 'ring' ? cs.carLane + cs.tram : cs.carLane;
    for (const side of [-1, 1]) {
      sidewalks.push({
        segIdx: seg.segIdx, roadId: seg.roadId, side,
        x0: seg.x0, z0: seg.z0, x1: seg.x1, z1: seg.z1,
        innerLat: innerLat * side, outerLat: hw * side, width: hw - innerLat,
      });
    }
  }
  return sidewalks;
}

// 挙動担当 2026-10-14: リング通りの縁（車道の外側の帯 lat ±12.5〜14）に駐車中の車の列。当たり判定は箱（kind 'parkedCar'、
// game.js では建物と同じ扱い＝大きい衝突）。sim の走る車は lat ±10.5（laneLateral）、歩行者は ±18.1 より外、横断歩道は交差点の
// そば（端から 18m は空ける）、停車枠（±(hl+8)）も避けるので、どれとも重ならない
function buildParkedCars(world, rng, stopRects) {
  const out = [];
  for (const seg of world.segments) {
    if (seg.kind !== 'ring' || seg.len < 60) continue;
    const cs = crossSection(seg);
    const lat = cs.carLane - 1.0; // 13.0（車幅 1.9 → 12.05〜13.95）
    for (let t = 18; t + 5 < seg.len - 18; t += 7) {
      if (rng.next() < 0.45) continue; // 空きが混じる
      const side = rng.next() < 0.5 ? -1 : 1;
      const cx = seg.x0 + seg.dx * (t + 2.5) + seg.nx * lat * side, cz = seg.z0 + seg.dz * (t + 2.5) + seg.nz * lat * side;
      let ok = true;
      for (const r of stopRects) if (Math.abs(cx - r.cx) < r.hl + 8 && Math.abs(cz - r.cz) < r.hw + 8) { ok = false; break; }
      if (!ok) continue;
      const yaw = Math.atan2(seg.dz, seg.dx) + (side > 0 ? 0 : Math.PI);
      out.push({ type: 'box', kind: 'parkedCar', cx, cz, yaw, hl: 2.1, hw: 0.9, mass: 1300, color: rng.int(0, 6) });
    }
  }
  return out;
}

// 挙動担当 2026-10-14 (FEEL2) 配置規則「家具帯」: 広い歩道（crossSection.sidewalk ≥ 5m ＝ リング通り）の縁石側 1.4m
// （中心は縁石から 0.7m。街灯・架線柱・ボラードと同じ列）にだけ当たり判定のある物を置く。歩行者の歩く帯は縁石から
// TUNE.pedestrian.furnitureBand (1.6m) より外（sim/actors.js walkBandInner）なので重ならない。避ける所:
//   区間の両端 18m（交差点の角 + 横断歩道 6m±2.2 + 前後 6m）、停車枠の周り ±(hl+8, hw+8)、既存の小物 1.5m、他の家具 6m。
// 40m ピッチで 広告塔（静的な円 r0.65）→ 花壇（静的な円 r0.55）→ 新聞キオスク（sim の壊れる小物 'stand'。ぶつかると吹っ飛ぶ）→ 花壇 の順。
// 広場の縁: 矩形広場の 4 隅（内側 4m）に広告塔。道路・ランドマーク・乗り場・停車枠から離れている所だけ
function buildRingFurniture(world, stopRects, props, landmarks) {
  const statics = [];
  const nearStop = (x, z, m) => stopRects.some((r) => Math.abs(x - r.cx) < r.hl + m && Math.abs(z - r.cz) < r.hw + m);
  const nearProp = (x, z, d) => props.some((p) => dist(x, z, p.x, p.z) < d);
  const KINDS = ['adColumn', 'planter', 'stand', 'planter'];
  let k = 0;
  for (const seg of world.segments) {
    const cs = crossSection(seg);
    if (cs.sidewalk < 5 || seg.len < 60) continue;
    const lat = cs.carLane + cs.tram + 0.7;
    for (const side of [-1, 1]) {
      for (let t = 20 + (side > 0 ? 0 : 20); t < seg.len - 18; t += 40) {
        if (t < 18) continue;
        const kind = KINDS[k++ % KINDS.length];
        const x = seg.x0 + seg.dx * t + seg.nx * lat * side, z = seg.z0 + seg.dz * t + seg.nz * lat * side;
        if (nearStop(x, z, 8) || nearProp(x, z, 1.5)) continue;
        if (statics.some((s) => dist(x, z, s.cx, s.cz) < 6)) continue;
        if (tooCloseToOtherRoad(world, seg.segIdx, x, z, 2.0)) continue; // 斜めに突き当たる横道（アウグスティーナー通り等）の車道に入らない
        const yaw = Math.atan2(seg.dz, seg.dx);
        if (kind === 'stand') props.push({ id: props.length, kind: 'stand', x, z, yaw: yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), r: 0.6, kiosk: true });
        // 主ループ 2026-10-14: 広告塔・花壇は「動かない物」でなく吹っ飛ぶ小物にする（天才さん「ぶつかった時の減速強すぎる、
        // もう少し気持ちよく蹴散らしてほしい」。動かない物だと壁と同じく跳ね返って止まっていた）。花壇は鉢植え（pot）で描く
        else if (kind === 'adColumn') props.push({ id: props.length, kind: 'adColumn', x, z, yaw, r: 0.65 });
        else props.push({ id: props.length, kind: 'pot', x, z, yaw, r: 0.55 });
      }
    }
  }
  // 広場の縁（矩形の 4 隅）
  const clearOf = (x, z, m) => {
    for (const seg of world.segments) { const n = nearestSegment({ segments: [seg] }, x, z); if (n && n.dist < seg.width / 2 + m) return false; }
    for (const l of landmarks) { const r = l.type === 'circle' ? l.r : Math.hypot(l.hl, l.hw); if (dist(x, z, l.cx, l.cz) < r + m) return false; }
    if (nearStop(x, z, m)) return false;
    for (const s of STANDS) if (dist(x, z, s.x, s.z) < m + 4) return false;
    return true;
  };
  for (const p of PLAZAS) {
    if (!p.rect) continue;
    const [[ax, az], [bx, bz]] = p.rect;
    const x0 = Math.min(ax, bx) + 4, x1 = Math.max(ax, bx) - 4, z0 = Math.min(az, bz) + 4, z1 = Math.max(az, bz) - 4;
    for (const [x, z] of [[x0, z0], [x1, z1], [x0, z1], [x1, z0]]) {
      if (!clearOf(x, z, 3.5) || nearProp(x, z, 2) || statics.some((s) => dist(x, z, s.cx, s.cz) < 6)) continue;
      props.push({ id: props.length, kind: 'adColumn', x, z, yaw: props.length * 0.7, r: 0.65, plazaId: p.id }); // 主ループ 2026-10-14: 吹っ飛ぶ小物に（rng は使わない）
    }
  }
  return statics;
}

// ---------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------
export function buildWorld(rng) {
  const { segments, nodes, adjacency } = buildSegmentsAndGraph();
  const world = { segments, nodes, adjacency };

  const landmarkCollide = landmarkColliders(segments);
  const stopRects = buildStopRects(world);
  const crosswalks = buildCrosswalks({ nodes, adjacency, segments });
  const blockBuildings = buildBlockBuildings(world, rng, landmarkCollide);
  const { props: propLayout, bollards, cafeSeats } = buildPropsAndBollards(world, rng, stopRects, blockBuildings);
  const { kiosks, scenes } = buildPlazaScenes(world, rng, landmarkCollide, stopRects);
  const tramLines = buildTramLines({ segments });
  const parkedCars = buildParkedCars(world, rng, stopRects);
  const ringFurniture = buildRingFurniture(world, stopRects, propLayout, landmarkCollide); // FEEL2: 家具帯の広告塔・花壇（円）。キオスクは propLayout に入る

  const buildings = [...landmarkCollide, ...blockBuildings, ...bollards, ...kiosks, ...parkedCars, ...ringFurniture];
  for (const b of buildings) b.br = b.type === 'box' ? Math.hypot(b.hl, b.hw) : b.r;

  // 当たり判定の広域フィルタ用に、街区の建物・ボラード(数が多いが小さい)だけを空間グリッドにまとめる。
  // ランドマーク(大きい・8個だけ)はグリッドに入れると「中心は遠いが端は近い」を取りこぼすので
  // 毎フレーム全件チェックする側に残す（8個なら総当たりでも軽い）。
  const smallBuildings = [...blockBuildings, ...bollards, ...kiosks, ...parkedCars, ...ringFurniture];
  const smallBuildingsGrid = buildGrid(smallBuildings, 24, (b) => [b.cx, b.cz]);
  const sidewalks = buildSidewalks(segments);

  return {
    roads: ROADS,
    plazas: PLAZAS,
    landmarks: LANDMARKS, // 名前・高さなど render 向けの生データ（当たり判定は buildings 側）
    spawnPoints: STANDS,  // ARCHITECTURE.md の g.world.spawnPoints（フィアカー乗り場）
    stands: STANDS,       // 同じものへの別名（意図が分かりやすいので残す）
    ridePairs: RIDE_PAIRS,
    bounds: MAP_BOUNDS,
    segments,
    nodes,
    adjacency,
    sidewalks,
    crosswalks,
    buildings,
    landmarkColliders: landmarkCollide,
    smallBuildings,
    smallBuildingsGrid,
    bollards,
    propLayout,
    stopRects,
    tramLines,
    cafeSeats,   // 賑わい: 屋外席の椅子（歩行者が座る）
    kiosks,      // 賑わい: 広場の屋台（render は sw.kiosks を描く。当たり判定は buildings 側の円）
    parkedCars,  // 挙動担当 2026-10-14: リング通りの縁の駐車列（render は sw.parkedCars を描く。当たり判定は buildings 側の箱）
    ringFurniture, // FEEL2 2026-10-14: 家具帯の広告塔（adColumn）・花壇（planter）。静的な円。render は sw.ringFurniture を描く
    scenes,      // 賑わい: 広場の大道芸人の立ち位置と観客の枠
  };
}

export { nodeKey, obbCorners };
