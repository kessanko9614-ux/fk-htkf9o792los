// map/vienna.js — ウィーン旧市街 簡略マップデータ
// 出典: research/vienna-reference.md §6（道路・広場・ランドマーク・出発/目的地）
// 座標系: メートル、原点=マップ中央、+x=東、+z=南。sim/ はこれを読むだけで three.js には依存しない。

export const ROADS = [
  { id: 'R01', name: 'Graben',            width: 30, kind: 'ped',    pts: [[-10,-80],[-100,-130],[-200,-175]] },
  { id: 'R02', name: 'Kohlmarkt',         width: 14, kind: 'ped',    pts: [[-200,-175],[-260,-120],[-290,-80]] },
  { id: 'R03', name: 'Herrengasse',       width: 14, kind: 'street', pts: [[-310,-95],[-320,-200],[-345,-280],[-372,-300]] },
  { id: 'R04', name: 'Augustinerstrasse', width: 12, kind: 'street', pts: [[-310,-25],[-300,90],[-250,230],[-230,330]] },
  { id: 'R05', name: 'Kaerntner Strasse', width: 17, kind: 'ped',    pts: [[-10,-80],[5,-20],[10,40],[-30,180],[-60,345]] },
  { id: 'R06', name: 'Opernring',         width: 50, kind: 'ring',   pts: [[360,290],[300,312],[200,350],[0,355],[-60,345],[-230,330],[-320,270]] },
  { id: 'R07', name: 'Burgring',          width: 50, kind: 'ring',   pts: [[-320,270],[-390,120],[-400,-50],[-390,-220],[-372,-300]] },
  { id: 'R08', name: 'Universitaetsring', width: 50, kind: 'ring',   pts: [[-372,-300],[-330,-370],[-250,-395],[-150,-395]] },
  { id: 'R09', name: 'Rotenturmstrasse',  width: 16, kind: 'street', pts: [[130,-150],[150,-250],[230,-370],[250,-395]] },
  { id: 'R10', name: 'Wollzeile',         width: 12, kind: 'street', pts: [[130,-100],[250,-115],[380,-130]] },
  { id: 'R11', name: 'Parkring',          width: 50, kind: 'ring',   pts: [[360,290],[372,190],[375,40],[380,-130],[370,-300],[330,-390]] },
  { id: 'R12', name: 'Singerstrasse',     width: 10, kind: 'street', pts: [[5,-20],[150,0],[300,30],[375,40]] },
  { id: 'R13', name: 'Johannesgasse',     width: 10, kind: 'street', pts: [[-30,180],[150,200],[310,195],[372,190]] },
  { id: 'R14', name: 'Tuchlauben',        width: 10, kind: 'street', pts: [[-100,-130],[-110,-230],[-80,-330]] },
  { id: 'R15', name: 'Hoher Markt',       width: 10, kind: 'street', pts: [[-80,-330],[50,-330],[150,-250]] },
  { id: 'R16', name: 'Freyung',           width: 12, kind: 'street', pts: [[-320,-200],[-200,-300],[-80,-330]] },
  { id: 'R17', name: 'Michaelerplatz',    width: 12, kind: 'street', pts: [[-290,-80],[-310,-95],[-340,-60],[-310,-25],[-280,-50],[-290,-80]] },
  { id: 'R19', name: 'Schwedenplatz',     width: 16, kind: 'street', pts: [[250,-395],[330,-390]] },
  { id: 'R20', name: 'Seilerstaette',     width: 12, kind: 'street', pts: [[300,30],[310,195],[300,312]] },
  { id: 'R21', name: 'Postgasse',         width: 10, kind: 'street', pts: [[250,-115],[280,-250],[370,-300]] },
  { id: 'R22', name: 'Neuer Markt',       width: 12, kind: 'street', pts: [[10,40],[-150,70],[-300,90]] },
];

// R18 Stephansplatz は矩形の全面走行可広場なので PLAZAS 側に持つ（研究資料と同じ扱い）。
export const PLAZAS = [
  { id: 'Stephansplatz',  rect: [[-20,-170],[130,-60]] },
  { id: 'Michaelerplatz', circle: { c: [-310,-60], r: 40 } },
  { id: 'Albertinaplatz', rect: [[-250,280],[-190,330]] },
  { id: 'NeuerMarkt',     rect: [[-150,50],[-90,90]] },
  { id: 'Schwedenplatz',  rect: [[240,-400],[340,-380]] },
];

// ランドマーク: sim では当たり判定(OBB/円)と誘導(光の柱)の目印として使う。
// 寸法は research/vienna-reference.md §3 を簡略化。
export const LANDMARKS = [
  { id: 'Stephansdom', name: 'シュテファン大聖堂', x: 80, z: -120, yaw: 0, shape: 'box', hl: 53.5, hw: 17, height: 136 },
  { id: 'Hofburg', name: 'ホーフブルク ミヒャエラー翼', x: -357, z: -82, yaw: Math.atan2(-60 - (-82), -310 - (-357)), shape: 'box', hl: 48, hw: 12, height: 54 },
  { id: 'Staatsoper', name: '国立歌劇場', x: -150, z: 275, yaw: 0, shape: 'box', hl: 60, hw: 48, height: 40 },
  { id: 'Albertina', name: 'アルベルティーナ', x: -220, z: 285, yaw: 0, shape: 'box', hl: 25, hw: 15, height: 20 },
  { id: 'Burgtheater', name: 'ブルク劇場', x: -260, z: -330, yaw: 0, shape: 'box', hl: 80, hw: 35, height: 28 },
  { id: 'Pestsaeule', name: 'ペスト記念柱', x: -105, z: -132, shape: 'circle', r: 5, height: 21 },
  { id: 'Peterskirche', name: 'ペーター教会', x: -130, z: -190, yaw: 0, shape: 'box', hl: 10, hw: 8, height: 30 },
  { id: 'HoherMarkt', name: 'アンカー時計', x: -15, z: -330, shape: 'circle', r: 5, height: 8 },
];

// フィアカー乗り場（出発地候補。出典: de.wikipedia Fiaker、研究資料 §6.4）
export const STANDS = [
  { id: 'stephansplatz', name: 'シュテファン広場', x: 40, z: -70 },
  { id: 'michaelerplatz', name: 'ミヒャエラー広場', x: -285, z: -60 },
  { id: 'peterplatz', name: 'ペーター広場', x: -130, z: -165 },
  { id: 'burgtheater', name: 'ブルク劇場前', x: -300, z: -350 },
  { id: 'albertina', name: 'アルベルティーナ', x: -215, z: 305 },
  { id: 'heldenplatz', name: 'ホーフブルク裏', x: -385, z: -90 },
];

// 出発地 → 目的地 8 組（研究資料 §6.5。座標はすべて ROADS の頂点と一致＝経路探索のノードに直結する）。
// stopRect の向きは route.js 側で到着直前の経路方向から計算する。
export const RIDE_PAIRS = [
  { from: { name: 'シュテファン大聖堂前', x: -10, z: -80 },  to: { name: '国立歌劇場', x: -60, z: 345 } },
  { from: { name: 'ミヒャエラー広場', x: -290, z: -80 },     to: { name: 'シュテファン大聖堂', x: -10, z: -80 } },
  { from: { name: '国立歌劇場', x: -60, z: 345 },            to: { name: 'ブルク劇場', x: -372, z: -300 } },
  { from: { name: 'ペスト記念柱', x: -100, z: -130 },        to: { name: 'シュヴェーデン広場', x: 250, z: -395 } },
  { from: { name: 'ブルク劇場', x: -372, z: -300 },          to: { name: 'ミヒャエラー広場', x: -310, z: -95 } },
  { from: { name: 'アルベルティーナ', x: -230, z: 330 },     to: { name: 'ペスト記念柱', x: -100, z: -130 } },
  { from: { name: 'シュヴェーデン広場', x: 250, z: -395 },   to: { name: '国立歌劇場', x: -60, z: 345 } },
  { from: { name: 'ミヒャエラー広場', x: -310, z: -25 },     to: { name: '国立歌劇場', x: -230, z: 330 } },
];

export const MAP_BOUNDS = { x0: -400, x1: 400, z0: -400, z1: 400 };
