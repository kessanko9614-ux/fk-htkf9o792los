# assets/ の素材と入手元・ライセンス

作成 2026-10-02（調査: research/tech-assets.md §1）。ゲームに組み込んで配布する用途で、すべて帰属表示なしで使える。
**素材ファイルそのものを「素材集」として再配布・再販しない**（Quaternius の新ライセンス QAL v1.0 が禁じるのはこれだけ）。

## 3D モデル（glb）

| ファイル | 作者 | 入手元 | ライセンス表記 |
|---|---|---|---|
| `models/horse/horse_white_quaternius.glb` | Quaternius | https://poly.pizza/m/bEdE4rmZy9 | poly.pizza のページに Public Domain (CC0) 表記、https://creativecommons.org/publicdomain/zero/1.0/ へのリンク |
| `models/horse/horse_brown_quaternius.glb` | Quaternius | https://poly.pizza/m/qvTrSG9pZF | 同上 |
| `models/people/man_casual_quaternius.glb` | Quaternius | https://poly.pizza/m/HMnuH5geEG | 同上 |
| `models/people/man_suit_quaternius.glb` | Quaternius | https://poly.pizza/m/mQnGoME1ez | 同上 |
| `models/people/woman_casual_quaternius.glb` | Quaternius | https://poly.pizza/m/jpKRgGDxhk | 同上 |
| `models/people/woman_dress_quaternius.glb` | Quaternius | https://poly.pizza/m/zMyPlQXBzq | 同上 |
| `models/props/bench_quaternius.glb` | Quaternius | https://poly.pizza/m/jLxjFxFRpw | 同上 |
| `models/props/table_round_small_a_quaternius.glb` | Quaternius | https://poly.pizza/m/oEArSZykyi | 同上 |
| `models/props/table_round_small_b_quaternius.glb` | Quaternius | https://poly.pizza/m/57W671WvS2 | 同上 |
| `models/props/houseplant_a_quaternius.glb` | Quaternius | https://poly.pizza/m/bfLOqIV5uP | 同上 |
| `models/props/houseplant_b_quaternius.glb` | Quaternius | https://poly.pizza/m/VtJh4Irl4w | 同上 |
| `models/props/street_lantern_isalousberg.glb` | Isa Lousberg | https://poly.pizza/m/Zp1b44poac | Public Domain (CC0) |

### Quaternius のライセンスについての注記

- poly.pizza 経由の各ページは **CC0** 表記（CC0 は撤回不能なので、この配布は有効）。
- 作者の本家 https://quaternius.com/license.html は **2026-08-28 付で「Quaternius Asset License (QAL) v1.0」に変更**された。
  内容: **帰属表示不要・商用利用可**。禁止されるのは**素材そのものを素材として再配布・再販すること**だけ。
- 本ゲームは素材を組み込んで配布するだけなので、CC0 でも QAL でも問題ない。
  ただし `assets/` の glb を zip にまとめて「素材集」として配布することはしない。

## PBR テクスチャ（1K JPG）

| フォルダ | 入手元 | ライセンス |
|---|---|---|
| `textures/cobblestone_floor_08/`（diff / nor_gl / arm） | https://polyhaven.com/a/cobblestone_floor_08 | CC0 — https://polyhaven.com/license |
| `textures/asphalt_02/`（diff / nor_gl / arm） | https://polyhaven.com/a/asphalt_02 | CC0 — 同上 |
| `textures/painted_plaster_wall/`（diff / nor_gl / arm） | https://polyhaven.com/a/painted_plaster_wall | CC0 — 同上 |
| `textures/Metal058C/`（Color / NormalGL / Roughness / Metalness） | https://ambientcg.com/view?id=Metal058C | CC0 1.0 — https://docs.ambientcg.com/license/ |

## HDRI

| ファイル | 入手元 | ライセンス |
|---|---|---|
| `hdri/dresden_square_2k.hdr` | https://polyhaven.com/a/dresden_square | CC0 — https://polyhaven.com/license |
| `hdri/quattro_canti_1k.hdr` | https://polyhaven.com/a/quattro_canti | CC0 — 同上 |

## 手続き生成（ファイル無し）

花崗岩の板石（歩道）、シュテファン大聖堂のジグザグ瓦、空のグラデーションは `render/assets.js` と `render/renderer.js` が実行時に Canvas / シェーダで生成する。外部素材ではない。

## 外部から読み込むもの（assets/ 外）

- three.js 0.170.0 — MIT — https://cdn.jsdelivr.net/npm/three@0.170.0/
- Google Fonts: Cormorant Garamond（SIL OFL 1.1）、Barlow Semi Condensed（SIL OFL 1.1）
