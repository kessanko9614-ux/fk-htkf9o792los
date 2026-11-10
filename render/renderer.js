// render/renderer.js — WebGLRenderer / トーンマッピング / HDRI(PMREM) / 太陽の影（追従）/ フォグ / ポスト処理 / 画質3段階
//
//   const R = createRenderer({ canvas, quality: 'high' | 'mid' | 'low', autoQuality: true });
//   await R.loadEnvironment('assets/hdri/dresden_square_2k.hdr');
//   R.setFocus(x, z)           // 影の範囲とフォーカスを馬車に追従
//   R.render(dtReal)           // 毎フレーム。フレーム時間を測って自動ダウングレード
//   R.getStats()               // { calls, triangles, frameMs, quality }
//   R.onQualityChange = (q) => {}
//
// 座標: x 東, z 南, y 上（メートル）。

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

export const QUALITY = {
  high: { pixelRatio: 2.0, shadow: 2048, shadowType: 'pcfsoft', ao: true, bloom: 0.5, smaa: true, msaa: 4, composer: true, envBg: true, shadowRange: 38 },
  mid:  { pixelRatio: 1.5, shadow: 1024, shadowType: 'pcfsoft', ao: false, bloom: 0.25, smaa: false, msaa: 4, composer: true, envBg: true, shadowRange: 32 },
  // 2026-10-14 見た目 第2回: 低画質は 0.75 倍のまま FXAA を 1 パス足す（composer 経由。MSAA は切る）。tests/_visual2_perf.html で測った:
  // 解像度を 1.0 にすると粒のちらつき（speckle）が 2.3〜3.3 倍に増え GPU +10〜20%。0.75+FXAA は speckle −27〜30%、GPU +0〜9%（VISUAL2_REPORT §2）
  // 2026-11-09 自分のサイトへ移す（Artifact の枠の外）ので、スマホ用の段を足す。影あり・細かさ 1.5 倍まで・FXAA。
  // 遅ければ自動で low に下がる。
  mobile: { pixelRatio: 1.5, shadow: 1024, shadowType: 'pcfsoft', ao: false, bloom: 0, smaa: false, fxaa: true, msaa: 0, composer: true, envBg: true, shadowRange: 26 },
  low:  { pixelRatio: 0.75, shadow: 0, shadowType: 'none', ao: false, bloom: 0, smaa: false, fxaa: true, msaa: 0, composer: true, envBg: true, shadowRange: 0 },
};
const ORDER = ['high', 'mid', 'mobile', 'low'];

// 光のプリセット（research/vienna-reference.md §7 E「快晴・日中」をベースに、太陽を少し低くして影を長く）
export const LIGHT = {
  // 2026-10-14 見た目の質（LOOK_REPORT）: 写真 dc318c81 / 65fe9db7（晴れた午後）に寄せる。
  // 太陽を強く・暖かく、環境光（曇りの HDRI）を弱めて日向と日陰の差を出す。影の中は半球光の空色で青みに。
  // CITY2 2026-11-10（主ループ「灰色で平ら・コントラストが低い」）: 太陽を強く・より暖かく、日陰の空色を濃く、露出を少し下げて白飛びを防ぐ。仕上げの色調補正は GRADE
  sunColor: 0xffd9a8,
  sunIntensity: 5.4,
  // 地面→太陽の向き。高度 54°・方位は右前 35°。
  // 高度を 41° にすると 24m の建物の影が 27m 伸びて幅 21m の通りを丸ごと覆い、「影が無い＝平たい」に見えた（周 2 の失敗）。
  // 62° だと壁面（鉛直）に当たる光が cos 62°=0.47 で弱く、どの向きの壁も同じ明るさ＝平板だった（LOOK_REPORT 周 1）。
  // 54° なら壁の日向は 0.59、24m の建物の影は 17m（幅 21m の通りの 8 割、10m の通りは全部影だが縁は画面に入る）。
  sunDir: new THREE.Vector3(0.482, 0.809, -0.337).normalize(),
  envIntensity: 0.30,
  // CITY2 第 3 周（主ループ「日陰が青黒くつぶれる」）: 半球光 0.72 → 1.0・空色を明るく、暗部の青を半分に、コントラスト 1.12 → 1.06
  hemiSky: 0xa9c4ec,
  hemiGround: 0x6a6356,
  hemiIntensity: 1.0,
  exposure: 0.92,
  // 空気遠近: フォグは灰色でなく空の地平の色（青白）。密度は少し下げて遠景の建物の形を残す
  fogColor: 0xc3cfe0,
  fogDensity: 0.0012,
  // HDRI の太陽（quattro_canti: u=0.595, 高度 10°）の方位を sunDir の方位に合わせる回転（three の equirect: u = atan2(z,x)/2π + 0.5）
  envRotation: 1.21,
  skyZenith: 0x2a63bd,
  skyHorizon: 0xd3dfeb,
};
// CITY2 2026-11-10: 仕上げの色調補正（OutputPass の後、sRGB で）。コントラスト・彩度・暗部を青く明部を暖かく・軽いビネット
export const GRADE = { contrast: 1.06, saturation: 1.2, vignette: 0.18, shadowTint: new THREE.Vector3(-0.01, -0.004, 0.018), highlightTint: new THREE.Vector3(0.03, 0.012, -0.025) };
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uContrast: { value: GRADE.contrast }, uSat: { value: GRADE.saturation }, uVig: { value: GRADE.vignette }, uShadow: { value: GRADE.shadowTint }, uHigh: { value: GRADE.highlightTint } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uContrast, uSat, uVig; uniform vec3 uShadow, uHigh; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec3 col = c.rgb;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, uSat);
      col = (col - 0.5) * uContrast + 0.5;
      col += uShadow * (1.0 - smoothstep(0.0, 0.55, l)) + uHigh * smoothstep(0.45, 1.0, l);
      vec2 d = vUv - 0.5; col *= 1.0 - uVig * dot(d, d) * 2.0;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a); }`,
};

export function createRenderer({ canvas, quality = 'high', autoQuality = true, width, height, preserveDrawingBuffer = false } = {}) {
  let level = QUALITY[quality] ? quality : 'high';
  let Q = QUALITY[level];

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LIGHT.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(LIGHT.fogColor, LIGHT.fogDensity);
  // 2026-10-03 主ループ: near を 0.3→0.6 に。near/far の比が大きいほど深度バッファの精度が落ち、
  // 遠くで重なる面（道路/広場/横断歩道）が Z-fight しやすくなる（CONTROLS_REPORT.md の撮影diff計測）
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.6, 900);
  camera.position.set(0, 3, 10);

  // ---- 太陽（平行光・影は馬車周辺だけ、テクセルにスナップしてチラつきを止める）
  const sun = new THREE.DirectionalLight(LIGHT.sunColor, LIGHT.sunIntensity);
  sun.castShadow = true;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 260;
  sun.shadow.bias = -0.00035; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  // 空の色の補助光（建物の影の中が真っ黒にならない。HDRI が来るまでのつなぎにもなる）
  const hemi = new THREE.HemisphereLight(LIGHT.hemiSky, LIGHT.hemiGround, LIGHT.hemiIntensity);
  scene.add(hemi);

  // ---- 空ドーム（HDRI の背景を使わない時／低画質用。常に作っておいて切り替える）
  const skyDome = makeSkyDome();
  skyDome.visible = false;
  scene.add(skyDome);

  const focus = new THREE.Vector3(0, 0, 0);
  const size = { w: width || canvas.clientWidth || innerWidth, h: height || canvas.clientHeight || innerHeight };

  // ---- ポスト処理
  let composer = null, passes = {};
  function buildComposer() {
    disposeComposer();
    if (!Q.composer) return;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: Q.msaa, colorSpace: THREE.LinearSRGBColorSpace });
    composer = new EffectComposer(renderer, rt);
    passes.render = new RenderPass(scene, camera);
    composer.addPass(passes.render);
    if (Q.ao) {
      const gtao = new GTAOPass(scene, camera, size.w, size.h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1, scale: 1.2, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 12 });
      gtao.setSceneClipBox(new THREE.Box3(new THREE.Vector3(-600, -2, -600), new THREE.Vector3(600, 200, 600)));
      passes.ao = gtao; composer.addPass(gtao);
    }
    if (Q.bloom > 0) {
      const bloom = new UnrealBloomPass(new THREE.Vector2(size.w * Q.bloom, size.h * Q.bloom), 0.28, 0.55, 0.92);
      passes.bloom = bloom; composer.addPass(bloom);
    }
    passes.output = new OutputPass(); composer.addPass(passes.output);
    passes.grade = new ShaderPass(GradeShader); composer.addPass(passes.grade);   // CITY2: 色調補正（全段。AA の前）
    if (Q.smaa) { passes.smaa = new SMAAPass(size.w, size.h); composer.addPass(passes.smaa); }
    if (Q.fxaa) { passes.fxaa = new ShaderPass(FXAAShader); composer.addPass(passes.fxaa); }
  }
  function setFxaaResolution(w, h) {
    if (!passes.fxaa) return;
    const pr = renderer.getPixelRatio();
    passes.fxaa.material.uniforms.resolution.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
  }
  function disposeComposer() {
    if (composer) { composer.passes.forEach((p) => p.dispose && p.dispose()); composer.dispose(); }
    composer = null; passes = {};
  }

  function applyQuality() {
    Q = QUALITY[level];
    const dpr = Math.min(window.devicePixelRatio || 1, Q.pixelRatio);
    renderer.setPixelRatio(level === 'low' ? Math.min(window.devicePixelRatio || 1, 1) * Q.pixelRatio : dpr);
    renderer.shadowMap.enabled = Q.shadow > 0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sun.castShadow = Q.shadow > 0;
    if (Q.shadow > 0) {
      sun.shadow.mapSize.set(Q.shadow, Q.shadow);
      const S = Q.shadowRange;
      Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
      sun.shadow.camera.updateProjectionMatrix();
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    // 影の無い段は、マテリアルの needsUpdate を促す（shadowMap.enabled の切替はプログラム再構築が要る）
    scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => (m.needsUpdate = true)); } });
    buildComposer();
    resize(size.w, size.h);
    if (api.onQualityChange) api.onQualityChange(level);
  }

  function setQuality(q) { if (!QUALITY[q] || q === level) return; level = q; applyQuality(); }

  function resize(w, h) {
    size.w = w; size.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (composer) {
      composer.setSize(w, h);
      if (passes.ao) passes.ao.setSize(w, h);
      if (passes.smaa) passes.smaa.setSize(w, h);
      if (passes.bloom) passes.bloom.setSize(w * Q.bloom, h * Q.bloom);
      setFxaaResolution(w, h);
    }
  }

  // ---- HDRI
  let envLoaded = false;
  function loadEnvironment(url, { background = true, rotation = LIGHT.envRotation, blur = 0.06 } = {}) {
    return new Promise((resolve, reject) => {
      const onHDR = (hdr) => {
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        const env = pmrem.fromEquirectangular(hdr).texture;
        scene.environment = env;
        scene.environmentIntensity = LIGHT.envIntensity;
        scene.environmentRotation.y = rotation;
        if (background) {
          scene.background = hdr;
          scene.backgroundRotation.y = rotation;
          scene.backgroundBlurriness = blur;
          scene.backgroundIntensity = 0.7;
          skyDome.visible = false;
        } else {
          hdr.dispose();
          skyDome.visible = true;
        }
        pmrem.dispose();
        envLoaded = true;
        resolve(env);
      };
      // 公開版（隔離枠）は素材を FK_PACK から読む（render/assets.js の注記）。RGBELoader.load と同じ設定で DataTexture を作る
      const key = url.slice(url.indexOf('assets/') + 7);
      const packed = globalThis.FK_PACK ? globalThis.FK_PACK[key] : undefined;
      if (packed) {
        try {
          const bin = atob(packed), u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          const d = new RGBELoader().parse(u.buffer);
          const hdr = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, d.type);
          hdr.colorSpace = THREE.LinearSRGBColorSpace;
          hdr.minFilter = hdr.magFilter = THREE.LinearFilter;
          hdr.generateMipmaps = false; hdr.flipY = true; hdr.needsUpdate = true;
          onHDR(hdr);
        } catch (e) { reject(e); }
      } else {
        new RGBELoader().load(url + (globalThis.FK_BIN_SUFFIX || ''), onHDR, undefined, reject);
      }
    });
  }
  function useSkyDome(on) { skyDome.visible = on; if (on) scene.background = null; }

  // ---- 影の追従＋スナップ
  const _p = new THREE.Vector3();
  function updateSun() {
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(LIGHT.sunDir, 120);
    if (sun.castShadow) {
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
      const cam = sun.shadow.camera;
      cam.updateMatrixWorld();
      const texel = (2 * Q.shadowRange) / sun.shadow.mapSize.x;
      _p.copy(sun.position).applyMatrix4(cam.matrixWorldInverse);
      _p.x = Math.round(_p.x / texel) * texel; _p.y = Math.round(_p.y / texel) * texel;
      _p.applyMatrix4(cam.matrixWorld);
      const d = _p.sub(sun.position);
      sun.position.add(d); sun.target.position.add(d);
      sun.target.updateMatrixWorld();
    }
    skyDome.position.set(camera.position.x, 0, camera.position.z);
  }
  function setFocus(x, z) { focus.set(x, 0, z); }

  // ---- フレーム時間と自動ダウングレード
  const ft = { last: 0, over: 0, samples: [], ms: 0, warm: 0 };
  function render(dt) {
    const t0 = performance.now();
    if (ft.last) {
      const ms = t0 - ft.last;
      if (ms < 200) {
        ft.ms = ft.ms ? ft.ms * 0.9 + ms * 0.1 : ms;
        ft.warm += ms;
        if (autoQuality && ft.warm > 2500) {
          if (ms > 22) ft.over++; else ft.over = Math.max(0, ft.over - 2);
          if (ft.over >= 40) {
            ft.over = 0; ft.warm = 0;
            const i = ORDER.indexOf(level);
            if (i < ORDER.length - 1) setQuality(ORDER[i + 1]);
          }
        }
      }
    }
    ft.last = t0;
    updateSun();
    renderer.info.reset();
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  function getStats() {
    return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frameMs: ft.ms, quality: level, programs: renderer.info.programs?.length };
  }

  const api = { renderer, scene, camera, sun, hemi, skyDome, LIGHT, loadEnvironment, useSkyDome, setQuality, getQuality: () => level, render, resize, setFocus, getStats, onQualityChange: null, get composer() { return composer; }, get envLoaded() { return envLoaded; } };
  applyQuality();
  return api;
}

// 天頂→地平のグラデーションの空（太陽のにじみ・手続きの雲付き）。背景に HDRI を出さない時に使う。
// 2026-10-14 見た目の質: 写真 dc318c81 の「上が濃い青、地平が白く明るい、ちぎれ雲」。雲は 3 オクターブの値ノイズを
// 空の方向ベクトルを平面に投影した座標で引く（高さ 1.2km の雲底を見上げた形）。フラグメントの計算だけで三角形・テクスチャは増えない。
function makeSkyDome() {
  const geo = new THREE.SphereGeometry(700, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(LIGHT.skyZenith) },
      horizon: { value: new THREE.Color(LIGHT.skyHorizon) },
      sunDir: { value: LIGHT.sunDir.clone() },
    },
    vertexShader: `varying vec3 vW; void main(){ vW = normalize((modelMatrix * vec4(position,1.0)).xyz - cameraPosition); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 zenith, horizon, sunDir; varying vec3 vW;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y); }
      void main(){
        vec3 d = normalize(vW);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 c = mix(horizon, zenith, pow(h, 0.5));
        float s = max(dot(d, sunDir), 0.0);
        // 太陽のにじみ（広い光輪 + 芯）
        c += vec3(1.0, 0.93, 0.8) * (pow(s, 220.0) * 2.2 + pow(s, 10.0) * 0.16 + pow(s, 2.5) * 0.05);
        if (d.y > 0.0) {
          // 雲: 雲底 1.2km の平面に投影。地平近くは密に見えるので圧縮し、地平では消す
          vec2 p = d.xz / (d.y + 0.08) * 1.2;
          float n = vnoise(p * 0.55) * 0.5 + vnoise(p * 1.3 + 7.1) * 0.3 + vnoise(p * 3.1 + 2.3) * 0.2;
          float cov = smoothstep(0.52, 0.72, n);
          float fade = smoothstep(0.0, 0.18, d.y);
          vec3 cloud = mix(vec3(0.74, 0.77, 0.83), vec3(1.05, 1.02, 0.98), smoothstep(0.55, 0.9, n)) * (0.85 + 0.35 * pow(s, 3.0));
          c = mix(c, cloud, cov * fade * 0.92);
        }
        if (d.y < 0.0) c = mix(horizon, horizon * 0.85, clamp(-d.y * 4.0, 0.0, 1.0));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.toneMapped = true;
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -1000;
  m.frustumCulled = false;
  return m;
}
