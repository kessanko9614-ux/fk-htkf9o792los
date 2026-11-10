// render/guide3d.js — 誘導の 3D 表示: 路面の光るシェブロン / 目的地の光の柱 / 停車枠
//
//   const guide = createGuide(scene);
//   guide.setRoute(g.ride.route)                 // [{x,z}] 経路の折れ線（変わった時だけ呼ぶ）
//   guide.setDestination(g.ride.to)              // { x, z, stopRect:{x,z,yaw,w,d} }
//   guide.update(dt, playerPos)                  // 毎フレーム（流れるアニメ・距離フェード）
//
// シェブロンは経路に沿って 4m 間隔、手前から奥へ流れる。馬車から 120m 以内だけ明るい。
// 光の柱は depthTest を切って建物越しに見せる（加算合成・空まで伸びる）。

import * as THREE from 'three';

const CHEVRON_PITCH = 4.0;
const CHEVRON_RANGE = 120;
const MAX_CHEVRONS = 220;
const GUIDE_COLOR = new THREE.Color(0xd4b45a);  // 金（HUD と同じ系統）
const PILLAR_COLOR = new THREE.Color(0xd4b45a);
// 2026-10-14 見た目 第2回（天才さん「変な表示がずっとチカチカ」）: 路面のシェブロンの流れ。x = 振幅（明るさの揺れ幅）、y = 速さ（rad/s）。
// 以前 0.38 / 5.5（0.88 Hz、明るさ×不透明度で 3.0 倍の揺れ）→ 0.25 / 3.8（0.60 Hz、1.9 倍）。tests/_visual2_guide.html が前後比較で切り替える
export const GUIDE_FLOW = { value: new THREE.Vector2(0.25, 3.8) };

function chevronGeometry() {
  // 進行方向 +x を向いた「く」の字。幅 2.2m, 奥行 1.4m, 線の太さ 0.5m
  const s = new THREE.Shape();
  s.moveTo(-0.7, -1.1); s.lineTo(0.0, -1.1); s.lineTo(0.7, 0.0); s.lineTo(0.0, 1.1); s.lineTo(-0.7, 1.1); s.lineTo(0.0, 0.0); s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2); // XY → XZ（y が -z になるので向きは +x のまま）
  return g;
}

export function createGuide(scene) {
  const group = new THREE.Group(); group.name = 'guide'; scene.add(group);

  // ---- シェブロン（インスタンス + シェーダ: 流れ + 距離フェード）
  const chevMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    uniforms: {
      uTime: { value: 0 }, uColor: { value: GUIDE_COLOR }, uPlayer: { value: new THREE.Vector3() }, uRange: { value: CHEVRON_RANGE }, uFlow: GUIDE_FLOW,
    },
    vertexShader: `
      attribute float aDist;
      varying float vDist; varying vec2 vUv; varying vec3 vW;
      void main(){
        vDist = aDist; vUv = uv;
        vec4 w = instanceMatrix * vec4(position, 1.0);
        w = modelMatrix * w; vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor; uniform vec3 uPlayer; uniform float uRange; uniform vec2 uFlow;
      varying float vDist; varying vec2 vUv; varying vec3 vW;
      void main(){
        float d = distance(vW.xz, uPlayer.xz);
        float fade = 1.0 - smoothstep(uRange * 0.55, uRange, d);
        float near = smoothstep(2.0, 7.0, d);               // 真下は消す（カメラが近すぎる）
        // 2026-10-03 主ループ: 常に動き続ける表示は「安定感」を削るという指摘に合わせ、流れを少し落ち着かせる（9.0→5.5、振幅も少し絞る）
        float flow = (1.0 - uFlow.x) + uFlow.x * sin(vDist * 1.6 - uTime * uFlow.y);   // 振幅・速さは GUIDE_FLOW（見た目 第2回）
        float a = fade * near * (0.35 + 0.65 * flow);
        gl_FragColor = vec4(uColor * (1.4 + 1.2 * flow), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const chevGeo = chevronGeometry();
  const chevrons = new THREE.InstancedMesh(chevGeo, chevMat, MAX_CHEVRONS);
  chevrons.frustumCulled = false; chevrons.renderOrder = 10; chevrons.count = 0;
  const distAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CHEVRONS), 1);
  chevGeo.setAttribute('aDist', distAttr);
  group.add(chevrons);

  // ---- 光の柱（建物越しに見える: depthTest false, 加算）
  const pillarMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: PILLAR_COLOR }, uStrength: { value: 1.0 } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uStrength; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        float h = vUv.y;
        float fres = pow(abs(dot(normalize(vN), normalize(vV))), 1.2);   // 縁は薄く、正面は濃く（柱らしく）
        float rise = (1.0 - smoothstep(0.0, 1.0, h)) * 0.9 + 0.1;
        // 2026-10-03 主ループ: 光の柱のゆらぎを控えめに（振幅を半分程度に、流れも少し遅く）
        float pulse = 0.92 + 0.08 * sin(uTime * 1.6 + h * 10.0);
        float streak = 0.85 + 0.15 * sin(h * 60.0 - uTime * 1.8);
        float a = fres * rise * pulse * streak * 0.55 * uStrength;
        gl_FragColor = vec4(uColor * 2.2, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const pillarGeo = new THREE.CylinderGeometry(1.6, 2.2, 320, 24, 1, true); pillarGeo.translate(0, 160, 0);
  const pillar = new THREE.Mesh(pillarGeo, pillarMat); pillar.renderOrder = 1000; pillar.frustumCulled = false; pillar.visible = false;
  group.add(pillar);
  const coreGeo = new THREE.CylinderGeometry(0.35, 0.5, 320, 12, 1, true); coreGeo.translate(0, 160, 0);
  const coreMat = pillarMat.clone(); coreMat.uniforms.uStrength.value = 1.8;
  const core = new THREE.Mesh(coreGeo, coreMat); core.renderOrder = 1001; core.frustumCulled = false; core.visible = false;
  group.add(core);
  // 柱の足元の光輪（地面）
  const haloMat = new THREE.MeshBasicMaterial({ color: GUIDE_COLOR, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.0, 3.2, 40), haloMat); halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; halo.renderOrder = 11; halo.visible = false;
  group.add(halo);

  // ---- 停車枠（地面の光る矩形枠）
  const frameMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    uniforms: { uTime: { value: 0 }, uColor: { value: GUIDE_COLOR }, uAlpha: { value: 1.0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
      void main(){
        vec2 d = abs(vUv - 0.5) * 2.0;             // 0 中心 → 1 縁
        float edge = max(d.x, d.y);
        float line = smoothstep(0.86, 0.9, edge) * (1.0 - smoothstep(0.98, 1.0, edge));
        float inner = (1.0 - smoothstep(0.0, 0.86, edge)) * 0.12;
        float pulse = 0.8 + 0.2 * sin(uTime * 3.0);
        float dash = step(0.5, fract((vUv.x + vUv.y) * 8.0 - uTime * 0.8)) * 0.3 + 0.7;
        float a = (line * dash + inner) * pulse * uAlpha;
        gl_FragColor = vec4(uColor * 2.0, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), frameMat); frame.rotation.x = -Math.PI / 2; frame.position.y = 0.025; frame.renderOrder = 12; frame.visible = false;
  group.add(frame);

  let time = 0;
  const dest = { x: 0, z: 0, set: false };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);

  function setRoute(pts) {
    let n = 0;
    if (pts && pts.length >= 2) {
      let acc = 0, carry = 0;
      for (let i = 0; i < pts.length - 1 && n < MAX_CHEVRONS; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;
        const yaw = Math.atan2(dz, dx);
        let s = carry;
        while (s <= len && n < MAX_CHEVRONS) {
          const t = s / len;
          _p.set(a.x + dx * t, 0.03, a.z + dz * t);
          _q.setFromAxisAngle(_up, -yaw);
          _m.compose(_p, _q, _s);
          chevrons.setMatrixAt(n, _m);
          distAttr.setX(n, acc + s);
          n++; s += CHEVRON_PITCH;
        }
        carry = s - len; acc += len;
      }
    }
    chevrons.count = n;
    chevrons.instanceMatrix.needsUpdate = true;
    distAttr.needsUpdate = true;
  }

  function setDestination(to) {
    if (!to) { pillar.visible = core.visible = halo.visible = frame.visible = false; dest.set = false; return; }
    dest.x = to.x; dest.z = to.z; dest.set = true;
    pillar.position.set(to.x, 0, to.z); core.position.copy(pillar.position); halo.position.set(to.x, 0.02, to.z);
    pillar.visible = core.visible = halo.visible = true;
    const r = to.stopRect;
    if (r) { // sim の stopRect は {cx,cz,yaw,hl,hw}、showcase は {x,z,yaw,w,d} の両方を受ける
      const rx = r.x ?? r.cx, rz = r.z ?? r.cz, rd = r.d ?? (r.hl != null ? r.hl * 2 : 8), rw = r.w ?? (r.hw != null ? r.hw * 2 : 4);
      frame.position.set(rx, 0.025, rz); frame.rotation.set(-Math.PI / 2, 0, -(r.yaw || 0)); frame.scale.set(rd, rw, 1); frame.visible = true; }
    else { frame.position.set(to.x, 0.025, to.z); frame.rotation.set(-Math.PI / 2, 0, 0); frame.scale.set(8, 4, 1); frame.visible = true; }
  }

  function update(dt, playerPos) {
    time += dt;
    chevMat.uniforms.uTime.value = time;
    if (playerPos) chevMat.uniforms.uPlayer.value.set(playerPos.x, 0, playerPos.z);
    pillarMat.uniforms.uTime.value = coreMat.uniforms.uTime.value = frameMat.uniforms.uTime.value = time;
    if (dest.set && playerPos) {
      const d = Math.hypot(playerPos.x - dest.x, playerPos.z - dest.z);
      // 近づくと柱は細く薄く、停車枠がはっきり
      const nearF = THREE.MathUtils.clamp((d - 15) / 45, 0, 1);
      pillarMat.uniforms.uStrength.value = 0.35 + 0.65 * nearF;
      coreMat.uniforms.uStrength.value = 0.6 + 1.2 * nearF;
      frameMat.uniforms.uAlpha.value = 1.0 - THREE.MathUtils.clamp((d - 40) / 60, 0, 1);
      haloMat.opacity = 0.25 * (1 - nearF) + 0.08;
    }
  }

  return { group, setRoute, setDestination, update, chevrons, pillar, frame };
}
