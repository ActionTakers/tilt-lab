// water-view.mjs: the three.js water, sky, wakes and spray for the S3 feel lab and the game. Adapted from the S2 water lab
// (s2-water/water-lab.mjs at project commit 5916046; S2 keeps its own copy, so its published files stay unchanged). Browser only
// (imports 'three' through the page's import map). The water shader and the boat's buoyancy use the same waves (shared/waves.mjs).
// Written 2026-11-08. Checked in the browser by tools/smoke-s3.mjs (GPU waves against the JS waves).
import * as THREE from 'three';
import * as W from './waves.mjs';

export const SUN = new THREE.Vector3(-0.35, 0.3, -0.89).normalize();
const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
vec3 skyColor(vec3 d) {
  float y = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(vec3(0.46, 0.62, 0.83), vec3(0.05, 0.2, 0.56), pow(y, 0.5));
  float sd = max(dot(d, uSunDir), 0.0);
  c += vec3(1.0, 0.86, 0.62) * (pow(sd, 900.0) * 24.0 + pow(sd, 10.0) * 0.32);
  return c;
}
`;
function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function tileTerms(seed, n, fmin, fmax, slope) {
  const r = mulberry(seed), out = [];
  while (out.length < n) {
    const m = Math.round((r() * 2 - 1) * fmax), k = Math.round((r() * 2 - 1) * fmax), f = Math.hypot(m, k);
    if (f < fmin || f > fmax) continue;
    out.push({ m, k, a: 1 / f ** slope, p: r() * 6.2832 });
  }
  return out;
}
function makeNormalTexture() {
  const N = 256, terms = tileTerms(11, 26, 2, 14, 1.4), data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = i / N, v = j / N; let du = 0, dv = 0;
    for (const t of terms) { const c = t.a * Math.cos(6.2832 * (t.m * u + t.k * v) + t.p) * 6.2832; du += c * t.m; dv += c * t.k; }
    let nx = -du * 0.012, ny = -dv * 0.012, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = 4 * (j * N + i); data[o] = nx * 127.5 + 127.5; data[o + 1] = ny * 127.5 + 127.5; data[o + 2] = nz * 127.5 + 127.5; data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true; return tex;
}
function makeFoamTexture() {
  const N = 256, terms = tileTerms(23, 30, 3, 24, 0.9), h = new Float32Array(N * N); let lo = 1e9, hi = -1e9;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let s = 0; for (const t of terms) s += t.a * Math.sin(6.2832 * (t.m * i / N + t.k * j / N) + t.p);
    h[j * N + i] = s; lo = Math.min(lo, s); hi = Math.max(hi, s);
  }
  const data = new Uint8Array(N * N); for (let i = 0; i < N * N; i++) data[i] = Math.round(255 * Math.pow((h[i] - lo) / (hi - lo), 1.6));
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.needsUpdate = true; return tex;
}

const WATER_VS = /* glsl */ `
${W.WAVE_GLSL}
uniform float uTime; uniform vec3 uCamPos; uniform vec2 uFade;
varying vec3 vWorld; varying vec3 vNrm; varying float vJac;
#ifdef REFLECT
uniform mat4 uTexMat; varying vec4 vRefl;
#endif
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec3 pos = w.xyz, nrm = vec3(0.0, 1.0, 0.0); float jac = 1.0;
#ifdef WAVES
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(w.xz - uCamPos.xz));
  gerstner(w.xz, uTime, fade, pos, nrm, jac);
  pos.y += w.y;
#endif
  vWorld = pos; vNrm = nrm; vJac = jac;
#ifdef REFLECT
  vRefl = uTexMat * vec4(pos, 1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;
const WATER_FS = /* glsl */ `
${SKY_GLSL}
uniform float uTime; uniform vec3 uCamPos;
uniform sampler2D tNormal; uniform sampler2D tFoam;
varying vec3 vWorld; varying vec3 vNrm; varying float vJac;
#ifdef REFLECT
uniform sampler2D tRefl; varying vec4 vRefl;
#endif
void main() {
  vec3 n = normalize(vNrm);
  float dist = length(vWorld.xz - uCamPos.xz);
#ifdef NMAP
  vec3 d1 = texture2D(tNormal, vWorld.xz / 9.0 + vec2(uTime * 0.034, uTime * 0.021)).xyz * 2.0 - 1.0;
  vec3 d2 = texture2D(tNormal, vWorld.xz / 23.0 + vec2(-uTime * 0.019, uTime * 0.031)).xyz * 2.0 - 1.0;
  vec2 dxy = (d1.xy + d2.xy) * (0.75 * (1.0 - smoothstep(40.0, 700.0, dist)) + 0.12);
  n = normalize(n + vec3(dxy.x, 0.0, dxy.y));
#endif
  vec3 v = normalize(uCamPos - vWorld);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n); r.y = abs(r.y);
  vec3 refl = skyColor(r);
#ifdef REFLECT
  vec4 rc = texture2D(tRefl, vRefl.xy / vRefl.w + n.xz * 0.035);
  refl = mix(refl, rc.rgb, rc.a);
#endif
  float crest = clamp(vWorld.y * 0.7 + 0.35, 0.0, 1.0);
  float back = max(dot(-v, uSunDir) * 0.5 + 0.5, 0.0);
  vec3 water = vec3(0.004, 0.03, 0.065) + vec3(0.0, 0.15, 0.16) * crest * (0.35 + 0.65 * back);
  vec3 col = mix(water, refl, fres);
#ifdef FOAM
  float f = texture2D(tFoam, vWorld.xz / 7.0 + vec2(uTime * 0.012, 0.0)).r;
  float foam = smoothstep(0.78, 0.42, vJac) * smoothstep(0.15, 0.65, f + 0.25 * crest);
  col = mix(col, vec3(0.86, 0.92, 0.96), clamp(foam, 0.0, 1.0) * (1.0 - smoothstep(150.0, 400.0, dist)));
#endif
  float fog = 1.0 - exp(-dist * 0.0017);
  col = mix(col, skyColor(normalize(vec3(-v.x, 0.0, -v.z))), fog);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
function waterGeometry(seg, R) {
  const n = seg + 1, pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let u = (i / seg) * 2 - 1, v = (j / seg) * 2 - 1; u *= 0.25 + 0.75 * u * u; v *= 0.25 + 0.75 * v * v;
    let x = u * R, z = v * R; const r = Math.hypot(x, z); if (r > R) { x *= R / r; z *= R / r; }
    pos.set([x, 0, z], 3 * (j * n + i));
  }
  const idx = new (n * n > 65535 ? Uint32Array : Uint16Array)(seg * seg * 6); let k = 0;
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; idx.set([a, c, b, b, c, d], k); k += 6; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// The sea: a camera-centred grid with waves, normal maps and foam, a flat skirt to the horizon, a sky dome and an optional planar
// reflection. quality: { nmap, foam, refl } booleans; seg and radius set the grid.
export class Sea {
  constructor(renderer, scene, { seg = 160, radius = 300, fade = [90, 260], reflSize = 512 } = {}) {
    Object.assign(this, { renderer, scene, seg, radius, reflSize });
    this.U = {
      uTime: { value: 0 }, uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: SUN }, uFade: { value: new THREE.Vector2(...fade) },
      uWA: { value: new Float32Array(4 * W.MAXW) }, uWB: { value: new Float32Array(4 * W.MAXW) }, uWaveCount: { value: 0 },
      tNormal: { value: makeNormalTexture() }, tFoam: { value: makeFoamTexture() }, tRefl: { value: null }, uTexMat: { value: new THREE.Matrix4() },
    };
    this.waterMat = new THREE.ShaderMaterial({ uniforms: this.U, vertexShader: WATER_VS, fragmentShader: WATER_FS });
    this.skirtMat = new THREE.ShaderMaterial({ uniforms: this.U, vertexShader: WATER_VS, fragmentShader: WATER_FS });
    this.water = new THREE.Mesh(waterGeometry(seg, radius), this.waterMat); this.water.frustumCulled = false; scene.add(this.water);
    this.skirt = new THREE.Mesh(new THREE.RingGeometry(radius - 2, 4000, 96, 1).rotateX(-Math.PI / 2), this.skirtMat); this.skirt.frustumCulled = false; scene.add(this.skirt);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), new THREE.ShaderMaterial({
      uniforms: { uSunDir: this.U.uSunDir }, side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vDir; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vDir = w.xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
      fragmentShader: `${SKY_GLSL} varying vec3 vDir; void main() { gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
    }));
    this.sky.frustumCulled = false; this.sky.renderOrder = 10; scene.add(this.sky);
    this.reflRT = null; this.reflCam = new THREE.PerspectiveCamera(); this.hideInRefl = [];
    this.quality = null; this.setQuality({ nmap: true, foam: true, refl: false });
  }
  setWaves(waves) { const u = W.waveUniformArrays(waves); this.U.uWA.value = u.A; this.U.uWB.value = u.B; this.U.uWaveCount.value = u.count; }
  setQuality(q) {
    this.quality = { ...q };
    const d = { WAVES: '' }; if (q.nmap) d.NMAP = ''; if (q.foam) d.FOAM = ''; if (q.refl) d.REFLECT = '';
    this.waterMat.defines = d; this.waterMat.needsUpdate = true;
    this.skirtMat.defines = q.nmap ? { NMAP: '' } : {}; this.skirtMat.needsUpdate = true;
    if (q.refl && !this.reflRT) { this.reflRT = new THREE.WebGLRenderTarget(this.reflSize, this.reflSize, { type: THREE.HalfFloatType, depthBuffer: true }); this.U.tRefl.value = this.reflRT.texture; }
  }
  update(camera, t) {
    this.U.uTime.value = t; this.U.uCamPos.value.copy(camera.position);
    const cell = ((2 * this.radius) / this.seg) * 0.25, sx = Math.round(camera.position.x / cell) * cell, sz = Math.round(camera.position.z / cell) * cell;
    this.water.position.set(sx, 0, sz); this.skirt.position.set(sx, -0.03, sz); this.sky.position.copy(camera.position);
  }
  renderReflection(camera, lookTarget) {
    if (!this.quality.refl) return;
    const rc = this.reflCam; rc.copy(camera); rc.position.set(camera.position.x, -camera.position.y, camera.position.z);
    rc.up.set(0, -1, 0); rc.lookAt(lookTarget.x, -lookTarget.y, lookTarget.z); rc.updateMatrixWorld();
    this.U.uTexMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    const hid = [this.water, this.skirt, ...this.hideInRefl].map((o) => [o, o.visible]); hid.forEach(([o]) => { o.visible = false; });
    this.sky.position.copy(rc.position);
    const r = this.renderer; r.setRenderTarget(this.reflRT); r.setClearColor(0x000000, 0); r.clear(); r.render(this.scene, rc); r.setRenderTarget(null);
    hid.forEach(([o, v]) => { o.visible = v; }); this.sky.position.copy(camera.position);
  }
  // GPU check: the shader's gerstner() at world grid points, rendered into a float target and read back (null without float RT)
  probe(points, t) {
    const n = points.length, r = this.renderer;
    const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, depthBuffer: false });
    const g = new THREE.BufferGeometry(), pos = new Float32Array(n * 3), src = new Float32Array(n * 2);
    points.forEach(([x, z], i) => { pos.set([((i + 0.5) / n) * 2 - 1, 0, 0], 3 * i); src.set([x, z], 2 * i); });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSrc', new THREE.BufferAttribute(src, 2));
    const m = new THREE.ShaderMaterial({ uniforms: { ...this.U, uT: { value: t } }, toneMapped: false,
      vertexShader: `${W.WAVE_GLSL}\nuniform float uT; attribute vec2 aSrc; varying vec4 vOut; void main() { vec3 p, nn; float j; gerstner(aSrc, uT, 1.0, p, nn, j); vOut = vec4(p, j); gl_PointSize = 1.0; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: 'varying vec4 vOut; void main() { gl_FragColor = vOut; }' });
    const sc = new THREE.Scene(), pts = new THREE.Points(g, m); pts.frustumCulled = false; sc.add(pts);
    const cam = new THREE.Camera(), out = new Float32Array(n * 4);
    try { r.setRenderTarget(rt); r.setClearColor(0, 0); r.clear(); r.render(sc, cam); r.readRenderTargetPixels(rt, 0, 0, n, 1, out); }
    catch { return null; } finally { r.setRenderTarget(null); rt.dispose(); g.dispose(); m.dispose(); }
    return Array.from({ length: n }, (_, i) => [out[4 * i], out[4 * i + 1], out[4 * i + 2], out[4 * i + 3]]);
  }
}

// A wake: a V-shaped ribbon behind a boat, rebuilt each frame from the boat's recent track (positions every dtw seconds).
export class Wake {
  constructor(scene, U, { n = 150, dtw = 0.08, stern = 3.4, spread = 0.36, maxHalf = 32 } = {}) {
    Object.assign(this, { n, dtw, stern, spread, maxHalf }); this.track = []; this.lastT = -Infinity;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 9), 3).setUsage(THREE.DynamicDrawUsage));
    const aw = new Float32Array(n * 6), idx = [];
    for (let i = 0; i < n; i++) { const a = 3 * i, b = a + 3, gg = i / (n - 1); aw.set([-1, gg, 0, gg, 1, gg], 6 * i); if (i < n - 1) idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); }
    g.setAttribute('aw', new THREE.BufferAttribute(aw, 2)); g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { ...U, uStrength: { value: 1 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      vertexShader: `${W.WAVE_GLSL}\nuniform float uTime; uniform vec3 uCamPos; uniform vec2 uFade; attribute vec2 aw; varying vec2 vAw; varying vec3 vWorld;
void main() { vec3 pos, nrm; float jac; float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(position.xz - uCamPos.xz));
  gerstner(position.xz, uTime, fade, pos, nrm, jac); pos += nrm * 0.06; vAw = aw; vWorld = pos; gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0); }`,
      fragmentShader: `uniform sampler2D tFoam; uniform float uStrength; varying vec2 vAw; varying vec3 vWorld;
void main() { float s = abs(vAw.x), age = vAw.y, n = texture2D(tFoam, vWorld.xz / 4.0).r;
  float arms = smoothstep(0.72, 0.9, s) * smoothstep(1.0, 0.92, s) * pow(1.0 - age, 1.2);
  float churn = smoothstep(0.6, 0.0, s) * (1.0 - smoothstep(0.0, 0.09, age));   // about 1 s of churned water (longer read as a road at speed)
  gl_FragColor = vec4(0.9, 0.95, 1.0, clamp((arms * 0.85 + churn * 0.9) * (0.3 + 0.7 * n) * uStrength, 0.0, 1.0));\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
    }));
    this.mesh.frustumCulled = false; scene.add(this.mesh);
  }
  reset() { this.track = []; this.lastT = -Infinity; }
  // b: { x, z, h, u } (h: heading with forward (-sin h, cos h)); t: seconds
  update(b, t) {
    if (t - this.lastT >= this.dtw || !this.track.length) { this.track.unshift({ x: b.x, z: b.z, h: b.h, u: Math.max(0, b.u), t }); this.lastT = t; if (this.track.length > this.n) this.track.pop(); }
    else { const f = this.track[0]; f.x = b.x; f.z = b.z; f.h = b.h; f.u = Math.max(0, b.u); }
    const a = this.mesh.geometry.attributes.position.array, T = this.track;
    for (let i = 0; i < this.n; i++) {
      const p = T[Math.min(i, T.length - 1)], fx = -Math.sin(p.h), fz = Math.cos(p.h), rx = -Math.cos(p.h), rz = -Math.sin(p.h);
      const age = t - p.t, sx = p.x - fx * this.stern, sz = p.z - fz * this.stern, hw = i >= T.length ? 0 : Math.min(this.maxHalf, 0.8 + this.spread * age * p.u);
      a.set([sx - rx * hw, 0, sz - rz * hw, sx, 0, sz, sx + rx * hw, 0, sz + rz * hw], 9 * i);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.material.uniforms.uStrength.value = Math.min(1, Math.max(0, b.u) / 10);
  }
}

// Spray: points thrown from the hull's sides in proportion to speed, plus bursts on landings. CPU-simulated, n points recycled.
export class Spray {
  constructor(scene, { n = 500 } = {}) {
    this.n = n; this.p = Array.from({ length: n }, () => ({ x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 0.9 })); this.next = 0; this.acc = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAge', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 } }, transparent: true, depthWrite: false,
      // small, crisp droplets; points closer than 4 m to the camera fade out (a chase camera sits inside the spray)
      vertexShader: 'uniform float uScale; attribute float aAge; varying float vAge; varying float vNear; void main() { vec4 mv = viewMatrix * vec4(position, 1.0); vAge = aAge; vNear = smoothstep(1.5, 4.0, -mv.z); gl_PointSize = min(40.0, 0.14 * (0.6 + 1.2 * aAge) * uScale / max(-mv.z, 0.5)); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying float vAge; varying float vNear; void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(0.95, 0.98, 1.0, smoothstep(0.5, 0.15, d) * pow(1.0 - min(vAge, 1.0), 1.5) * 0.9 * vNear);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
    }));
    this.points.frustumCulled = false; scene.add(this.points);
    this.rnd = mulberry(5);
  }
  emit(b, count, { up = 4, out = 3, bow = 1.2, beam = 1.0 } = {}) {
    const fx = -Math.sin(b.h), fz = Math.cos(b.h), rx = -Math.cos(b.h), rz = -Math.sin(b.h), r = this.rnd;
    for (let k = 0; k < count; k++) {
      const q = this.p[this.next]; this.next = (this.next + 1) % this.n;
      const side = r() < 0.5 ? -1 : 1, o = out * (0.6 + 0.8 * r()), f = Math.max(0, b.u) * (0.3 + 0.4 * r());
      Object.assign(q, { x: b.x + fx * bow + rx * side * beam, y: b.y + 0.1, z: b.z + fz * bow + rz * side * beam,
        vx: rx * side * o + fx * f, vy: up * (0.6 + 0.8 * r()), vz: rz * side * o + fz * f, age: 0, life: 0.6 + 0.5 * r() });
    }
  }
  // b: the boat, dt: seconds since the last frame, size: hull length factor
  update(b, dt, camera, renderer, { rate = 1, bow = 1.2, beam = 1.0 } = {}) {
    const u = Math.max(0, b.u);
    if (!b.air && u > 6) { this.acc += dt * rate * Math.min(260, u * 9); const k = Math.floor(this.acc); this.acc -= k; this.emit(b, k, { bow, beam, up: 2.5 + u * 0.12 }); }
    const pos = this.points.geometry.attributes.position.array, age = this.points.geometry.attributes.aAge.array;
    for (let i = 0; i < this.n; i++) {
      const q = this.p[i];
      if (q.age < 1) { q.vy -= 9.81 * dt; q.vx *= 1 - 1.2 * dt; q.vz *= 1 - 1.2 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt; q.age += dt / q.life; }
      pos[3 * i] = q.x; pos[3 * i + 1] = q.age < 1 ? q.y : -100; pos[3 * i + 2] = q.z; age[i] = Math.min(1, q.age);
    }
    this.points.geometry.attributes.position.needsUpdate = true; this.points.geometry.attributes.aAge.needsUpdate = true;
    const v = new THREE.Vector2(); renderer.getDrawingBufferSize(v);
    this.points.material.uniforms.uScale.value = v.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }
}
