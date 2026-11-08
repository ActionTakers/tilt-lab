// water-lab.mjs: the S2 water and headroom lab. A boat runs a fixed 60-second path over Gerstner water while the page measures how
// many extra full frames each step of the water ladder leaves before frames drop at the phone's refresh rate.
// Written 2026-11-08. Smoke test: node tools/smoke-s2.mjs (headless Chrome; never phone numbers). Wave math: ../shared/waves.mjs,
// the same function the S3 boat floats on. three.js 0.186.1: ../vendor/three-0.186.1 (local copy, hashes in SOURCE.txt).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as W from '../shared/waves.mjs';

export const VERSION = 's2-water v0.1';
const now = () => performance.now();
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const rd = (v, d = 2) => (fin(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const fmt = (v, d = 1) => (fin(v) ? v.toFixed(d) : '-');
const $ = (id) => document.getElementById(id);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

// ---------- the ladder ----------
const RUNGS = [
  { name: 'flat' },
  { name: 'normal maps', nmap: 1 },
  { name: 'vertex waves', nmap: 1, waves: 1 },
  { name: '+ foam', nmap: 1, waves: 1, foam: 1 },
  { name: '+ wake', nmap: 1, waves: 1, foam: 1, wake: 1 },
  { name: '+ spray', nmap: 1, waves: 1, foam: 1, wake: 1, spray: 1 },
  { name: '+ bloom', nmap: 1, waves: 1, foam: 1, wake: 1, spray: 1, bloom: 1 },
  { name: '+ reflection', nmap: 1, waves: 1, foam: 1, wake: 1, spray: 1, bloom: 1, refl: 1 },
];
const TOP = RUNGS.length - 1;
const LIMIT = 10;                       // a window fails when more than 10 % of the refresh slots were missed
const LEVELS = [1, 2, 4, 8, 16, 32];    // extra full frames drawn per frame (hidden: the last draw wins)
const PATH_S = 60;
const STORE = 's2-session', ACTIVE = 's2-active';

const S = {
  version: VERSION, loadedAt: new Date().toISOString(), firstFrameMs: null, started: false,
  settings: { seg: 160, waveCount: 5, reflSize: 512, radius: 300, fade: [90, 260], sprayCount: 700, bloom: [0.55, 0.35, 0.82] },
  rung: TOP, scale: 1, load: 0, pathT0: now(), freezeT: null, interval: 1000 / 60, refresh: null,
  win: null, roll: [], active: null, abort: false, testBusyMs: 0, testBusyRung: -1,
  ladders: [], paths: [], heat: null, lost: [], restoredCtx: 0, reloads: [], answers: {}, typed: {}, auto: {}, restored: null,
  wake: { supported: 'wakeLock' in navigator, state: 'not requested', sentinel: null, releases: 0 },
};

// ---------- renderer and scene ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const gl = renderer.getContext();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 3000);
const lookTarget = new THREE.Vector3();
const SUN = new THREE.Vector3(-0.35, 0.3, -0.89).normalize();

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

// Shared uniforms (one object, so water, skirt, wake and probe always agree)
const U = {
  uTime: { value: 0 }, uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: SUN }, uFade: { value: new THREE.Vector2(...S.settings.fade) },
  uWA: { value: new Float32Array(4 * W.MAXW) }, uWB: { value: new Float32Array(4 * W.MAXW) }, uWaveCount: { value: 0 },
  tNormal: { value: null }, tFoam: { value: null }, tRefl: { value: null }, uTexMat: { value: new THREE.Matrix4() },
};
let waves = [];
function setWaves() {
  waves = W.makeWaves({ count: Math.max(1, Math.min(W.MAXW, +S.settings.waveCount || 5)) });
  const u = W.waveUniformArrays(waves); U.uWA.value = u.A; U.uWB.value = u.B; U.uWaveCount.value = u.count;
}

// ---------- procedural textures (nothing downloaded) ----------
function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function tileTerms(seed, n, fmin, fmax, slope) {   // integer frequencies, so the texture tiles
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

// ---------- the water: a camera-centred grid, denser near the middle, clamped to a disc; a flat skirt to the horizon ----------
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
const waterMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: WATER_VS, fragmentShader: WATER_FS });
const skirtMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: WATER_VS, fragmentShader: WATER_FS });
let water = null; const skirtGeo = new THREE.RingGeometry(1, 4000, 64, 1).rotateX(-Math.PI / 2);
const skirt = new THREE.Mesh(skirtGeo, skirtMat); skirt.frustumCulled = false; scene.add(skirt);
function buildWater() {
  if (water) { scene.remove(water); water.geometry.dispose(); }
  water = new THREE.Mesh(waterGeometry(Math.max(16, Math.min(512, +S.settings.seg || 160)), S.settings.radius), waterMat);
  water.frustumCulled = false; scene.add(water);
  const inner = S.settings.radius - 2; skirt.geometry.dispose(); skirt.geometry = new THREE.RingGeometry(inner, 4000, 96, 1).rotateX(-Math.PI / 2);
}

// ---------- sky, boat, light ----------
const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), new THREE.ShaderMaterial({
  uniforms: { uSunDir: U.uSunDir }, side: THREE.BackSide, depthWrite: false,
  vertexShader: 'varying vec3 vDir; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vDir = w.xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
  fragmentShader: `${SKY_GLSL} varying vec3 vDir; void main() { gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
}));
sky.frustumCulled = false; sky.renderOrder = 10; scene.add(sky);
scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x0b2a3a, 1.4));
const sunLight = new THREE.DirectionalLight(0xfff0dd, 2.6); sunLight.position.copy(SUN).multiplyScalar(100); scene.add(sunLight);
function makeBoat() {   // a greybox runabout, bow toward +z
  const g = new THREE.Group(), sh = new THREE.Shape();
  sh.moveTo(-1.2, -3.4); sh.lineTo(1.2, -3.4); sh.lineTo(1.25, 1.2); sh.quadraticCurveTo(1.0, 3.0, 0, 3.8); sh.quadraticCurveTo(-1.0, 3.0, -1.25, 1.2); sh.closePath();
  const hull = new THREE.ExtrudeGeometry(sh, { depth: 1.0, bevelEnabled: false, curveSegments: 6 }); hull.rotateX(Math.PI / 2); hull.translate(0, 0.6, 0);
  g.add(new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.45 })));
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.56, 0.14, 4.6), new THREE.MeshStandardMaterial({ color: 0xc8302a, roughness: 0.5 })); stripe.position.set(0, 0.3, -0.9); g.add(stripe);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.75, 2.0), new THREE.MeshStandardMaterial({ color: 0x1b2c3c, roughness: 0.2, metalness: 0.3 })); cabin.position.set(0, 0.95, -0.5); g.add(cabin);
  return g;
}
const boat = makeBoat(); scene.add(boat);

// ---------- the fixed path, the boat on the waves, the camera ----------
const LUT_N = 1200; let LUT = null, pathLen = 0, speed = 0;
function buildPath() {
  const pts = [[0, 0], [110, 30], [190, 140], [130, 250], [-20, 260], [-130, 160], [-120, 30]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal'); pathLen = curve.getLength(); speed = pathLen / PATH_S;
  LUT = new Float32Array(2 * (LUT_N + 1)); curve.getSpacedPoints(LUT_N).forEach((p, i) => { LUT[2 * i] = p.x; LUT[2 * i + 1] = p.z; });
}
function pathAt(t) {   // position and unit forward on the loop, by arc length (a lap is exactly PATH_S seconds)
  const u = ((((t / PATH_S) % 1) + 1) % 1) * LUT_N, i = Math.floor(u) % LUT_N, f = u - Math.floor(u);
  const P = (k) => { const m = ((k % LUT_N) + LUT_N) % LUT_N; return [LUT[2 * m], LUT[2 * m + 1]]; };
  const a = P(i), b = P(i + 1), p0 = P(i - 2), p1 = P(i + 3);
  let fx = p1[0] - p0[0], fz = p1[1] - p0[1]; const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
  return { x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, fx, fz };
}
const B = { x: 0, y: 0, z: 0, fx: 0, fz: 1, rx: -1, rz: 0 };
function placeBoat(t) {   // a pure function of t: four floats on the same waves as the shader, plus a lean into the turn
  const p = pathAt(t), rx = -p.fz, rz = p.fx;   // right = forward x up
  const wv = !!RUNGS[S.rung].waves, h = (dx, dz) => (wv ? W.heightAt(waves, p.x + dx, p.z + dz, t, 3) : 0);
  const hb = h(p.fx * 2.8, p.fz * 2.8), hs = h(-p.fx * 3.2, -p.fz * 3.2), hp = h(-rx * 1.1, -rz * 1.1), hr = h(rx * 1.1, rz * 1.1);
  const ya = Math.atan2(p.fx, p.fz), q = pathAt(t + 0.15), yb = Math.atan2(q.fx, q.fz);
  let dy = yb - ya; if (dy > Math.PI) dy -= 2 * Math.PI; if (dy < -Math.PI) dy += 2 * Math.PI;
  boat.position.set(p.x, (hb + hs + hp + hr) / 4 + 0.22, p.z);
  boat.rotation.set(-(Math.atan2(hb - hs, 6) + 0.05), ya, Math.atan2(hp - hr, 2.2) - Math.max(-0.3, Math.min(0.3, (dy / 0.15) * 0.22)), 'YXZ');
  Object.assign(B, { x: p.x, y: boat.position.y, z: p.z, fx: p.fx, fz: p.fz, rx, rz });
}
function placeCamera(t) {   // four views in a fixed 60 s sequence; height fixed above the sea (no bobbing)
  const tm = ((t % PATH_S) + PATH_S) % PATH_S, c = B; let o, l, fov;
  if (tm < 18) { o = [-14, 4.2, 0]; l = [12, 0.5, 0]; fov = 60; }
  else if (tm < 30) { o = [-2, 3.2, 11]; l = [6, 0.6, 0]; fov = 55; }
  else if (tm < 44) { o = [-34, 17, 0]; l = [30, 0, 0]; fov = 60; }
  else { o = [-11, 3.4, 0]; l = [16, 0.8, 0]; fov = 72; }
  const at = (v) => [c.x + c.fx * v[0] + c.rx * v[2], v[1], c.z + c.fz * v[0] + c.rz * v[2]];
  camera.position.set(...at(o)); lookTarget.set(...at(l)); camera.lookAt(lookTarget);
  if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ---------- wake (a ribbon behind the boat, rebuilt from the path each frame) and spray (points) ----------
const NW = 150, DTW = 0.08;
const wakeGeo = new THREE.BufferGeometry();
wakeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NW * 3 * 3), 3).setUsage(THREE.DynamicDrawUsage));
{ const aw = new Float32Array(NW * 6), idx = []; for (let i = 0; i < NW; i++) { const g = i / (NW - 1), a = 3 * i, b = a + 3; aw.set([-1, g, 0, g, 1, g], 6 * i); if (i < NW - 1) idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); }
  wakeGeo.setAttribute('aw', new THREE.BufferAttribute(aw, 2)); wakeGeo.setIndex(idx); }
const wake = new THREE.Mesh(wakeGeo, new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  vertexShader: `${W.WAVE_GLSL}\nuniform float uTime; uniform vec3 uCamPos; uniform vec2 uFade; attribute vec2 aw; varying vec2 vAw; varying vec3 vWorld;
void main() { vec3 pos, nrm; float jac; float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(position.xz - uCamPos.xz));
  gerstner(position.xz, uTime, fade, pos, nrm, jac); pos += nrm * 0.06; vAw = aw; vWorld = pos; gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0); }`,
  fragmentShader: `uniform sampler2D tFoam; varying vec2 vAw; varying vec3 vWorld;
void main() { float s = abs(vAw.x), age = vAw.y, n = texture2D(tFoam, vWorld.xz / 4.0).r;
  float arms = smoothstep(0.72, 0.9, s) * smoothstep(1.0, 0.92, s) * pow(1.0 - age, 1.2);      // the two arms of the V
  float churn = smoothstep(0.6, 0.0, s) * (1.0 - smoothstep(0.0, 0.28, age));                 // churned water right behind the boat
  gl_FragColor = vec4(0.9, 0.95, 1.0, clamp((arms * 0.85 + churn * 0.9) * (0.3 + 0.7 * n), 0.0, 1.0));\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
}));
wake.frustumCulled = false; scene.add(wake);
function updateWake(t) {
  const a = wakeGeo.attributes.position.array;
  for (let i = 0; i < NW; i++) {
    const p = pathAt(t - i * DTW), rx = -p.fz, rz = p.fx, sx = p.x - p.fx * 3.4, sz = p.z - p.fz * 3.4, hw = Math.min(32, 1.0 + 0.36 * i * DTW * speed);   // a Kelvin-like V: about 20 deg each side
    a.set([sx - rx * hw, 0, sz - rz * hw, sx, 0, sz, sx + rx * hw, 0, sz + rz * hw], 9 * i);
  }
  wakeGeo.attributes.position.needsUpdate = true;
}
let spray = null, sprayK = null; const LIFE = 0.9;
function buildSpray() {
  if (spray) { scene.remove(spray); spray.geometry.dispose(); }
  const n = S.settings.sprayCount, r = mulberry(5), g = new THREE.BufferGeometry();
  sprayK = Array.from({ length: n }, () => ({ ph: r() * LIFE, side: r() < 0.5 ? -1 : 1, out: 3 + 3 * r(), up: 3.5 + 3.5 * r(), fwd: 0.3 + 0.4 * r() }));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aAge', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  spray = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 } }, transparent: true, depthWrite: false,
    vertexShader: 'uniform float uScale; attribute float aAge; varying float vAge; void main() { vec4 mv = viewMatrix * vec4(position, 1.0); vAge = aAge; gl_PointSize = min(128.0, 0.32 * (0.5 + 1.5 * aAge) * uScale / max(-mv.z, 0.5)); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vAge; void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(0.95, 0.98, 1.0, smoothstep(0.5, 0.1, d) * pow(1.0 - vAge, 1.5) * 0.85);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
  }));
  spray.frustumCulled = false; scene.add(spray);
}
function updateSpray(t) {
  const pos = spray.geometry.attributes.position.array, age = spray.geometry.attributes.aAge.array;
  for (let i = 0; i < sprayK.length; i++) {
    const k = sprayK[i], a = ((((t - k.ph) % LIFE) + LIFE) % LIFE), p = pathAt(t - a), rx = -p.fz, rz = p.fx;
    const bx = p.x + p.fx * 2.4 + rx * k.side * 1.0, bz = p.z + p.fz * 2.4 + rz * k.side * 1.0, v = speed * k.fwd;
    pos[3 * i] = bx + (rx * k.side * k.out + p.fx * v) * a; pos[3 * i + 1] = 0.3 + k.up * a - 4.9 * a * a; pos[3 * i + 2] = bz + (rz * k.side * k.out + p.fz * v) * a;
    age[i] = a / LIFE;
  }
  spray.geometry.attributes.position.needsUpdate = true; spray.geometry.attributes.aAge.needsUpdate = true;
  spray.material.uniforms.uScale.value = renderer.getDrawingBufferSize(tmpV2).y / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
const tmpV2 = new THREE.Vector2();

// ---------- reflection (a mirrored camera into a render target) and bloom ----------
let reflRT = null; const reflCam = new THREE.PerspectiveCamera();
function buildRefl() {
  if (reflRT) reflRT.dispose();
  const s = Math.max(64, Math.min(2048, +S.settings.reflSize || 512));
  reflRT = new THREE.WebGLRenderTarget(s, s, { type: THREE.HalfFloatType, depthBuffer: true }); U.tRefl.value = reflRT.texture;
}
function renderReflection() {
  reflCam.copy(camera); reflCam.position.set(camera.position.x, -camera.position.y, camera.position.z);
  reflCam.up.set(0, -1, 0); reflCam.lookAt(lookTarget.x, -lookTarget.y, lookTarget.z); reflCam.updateMatrixWorld();
  U.uTexMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse);
  const hid = [water, skirt, wake, spray].map((o) => [o, o.visible]); hid.forEach(([o]) => { o.visible = false; });
  sky.position.copy(reflCam.position);
  renderer.setRenderTarget(reflRT); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, reflCam); renderer.setRenderTarget(null);
  hid.forEach(([o, v]) => { o.visible = v; }); sky.position.copy(camera.position);
}
let composer = null, bloomPass = null;
function buildComposer() {
  composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
  const [st, ra, th] = S.settings.bloom; bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), st, ra, th);
  composer.addPass(bloomPass); composer.addPass(new OutputPass()); sizeAll();
}

// ---------- rung, scale, size ----------
function setRung(i) {
  S.rung = Math.max(0, Math.min(TOP, i)); const R = RUNGS[S.rung];
  const d = {}; if (R.waves) d.WAVES = ''; if (R.nmap) d.NMAP = ''; if (R.foam) d.FOAM = ''; if (R.refl) d.REFLECT = '';
  waterMat.defines = d; waterMat.needsUpdate = true;
  skirtMat.defines = R.nmap ? { NMAP: '' } : {}; skirtMat.needsUpdate = true;
  wake.visible = !!R.wake; spray.visible = !!R.spray;
  if (R.bloom && !composer) buildComposer();
  paintRungButtons();
}
function setScale(s) { S.scale = s; sizeAll(); document.querySelectorAll('[data-scale]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.scale === s))); }
function sizeAll() {
  const w = window.innerWidth, h = window.innerHeight, pr = Math.min(window.devicePixelRatio || 1, 3) * S.scale;
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(pr); composer.setSize(w, h); }
}
window.addEventListener('resize', sizeAll);

// ---------- one frame ----------
function pathTime() { return S.freezeT !== null ? S.freezeT : (now() - S.pathT0) / 1000; }
function restartPath() { S.pathT0 = now(); }
function updateScene(t) {
  placeBoat(t); placeCamera(t);
  U.uTime.value = t; U.uCamPos.value.copy(camera.position);
  const cell = (2 * S.settings.radius) / (+S.settings.seg || 160) * 0.25, sx = Math.round(camera.position.x / cell) * cell, sz = Math.round(camera.position.z / cell) * cell;
  water.position.set(sx, 0, sz); skirt.position.set(sx, -0.03, sz); sky.position.copy(camera.position);
  const R = RUNGS[S.rung]; if (R.wake) updateWake(t); if (R.spray) updateSpray(t);
}
function draw() {
  const R = RUNGS[S.rung];
  if (R.refl) renderReflection();
  if (R.bloom) composer.render(); else { renderer.setClearColor(0x000000, 1); renderer.render(scene, camera); }
}

// ---------- measuring ----------
function newWindow() { return { t0: now(), frames: 0, missed: 0, deltas: [], cpu: [] }; }
function summarize(w) {
  const frames = w.frames, missed = w.missed;
  return { frames, missed, dropsPct: frames ? rd((100 * missed) / (frames + missed), 2) : null, medianMs: rd(median(w.deltas), 2), meanMs: rd(w.deltas.reduce((s, v) => s + v, 0) / (w.deltas.length || 1), 2),
    p95Ms: rd(pct(w.deltas, 95), 2), maxMs: rd(w.deltas.length ? Math.max(...w.deltas) : NaN, 1), cpuMs: rd(median(w.cpu), 2), stalls50: w.deltas.filter((d) => d > 50).length,
    hist: [17.5, 25, 34, 50, Infinity].map((lim, i, a) => w.deltas.filter((d) => d <= lim && (i === 0 || d > a[i - 1])).length) };
}
function record(d, cpu) {
  if (!fin(d) || d <= 0) return;
  const missed = Math.max(0, Math.round(d / S.interval) - 1);
  S.roll.push([now(), d, missed]); while (S.roll.length && now() - S.roll[0][0] > 1000) S.roll.shift();
  const w = S.win; if (!w) return;
  w.frames++; w.missed += missed; w.deltas.push(d); w.cpu.push(cpu);
}
const waiters = [];
function waitMs(ms) { return new Promise((res, rej) => waiters.push({ until: now() + ms, res, rej })); }
async function measure(ms) { S.win = newWindow(); try { await waitMs(ms); } finally { var w = S.win; S.win = null; } return summarize(w); }

let lastRaf = null, frameNo = 0, mode = 'scene';
function loop(ts) {
  requestAnimationFrame(loop);
  const d = lastRaf === null ? null : ts - lastRaf; lastRaf = ts; frameNo++;
  const c0 = now();
  if (mode === 'blank') { renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 1); renderer.clear(); }
  else {
    updateScene(pathTime());
    for (let k = 0; k < S.load; k++) draw();
    draw();
    if (S.testBusyMs > 0 && (S.testBusyRung < 0 || S.testBusyRung === S.rung)) { const e = now() + S.testBusyMs; while (now() < e) { /* test hook: a planted slow frame */ } }
    if (S.firstFrameMs === null) { S.firstFrameMs = rd(now(), 0); paintCard(); }
  }
  record(d, now() - c0);
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (S.abort) { waiters.splice(i, 1); w.rej(new Error('stopped')); } else if (now() >= w.until) { waiters.splice(i, 1); w.res(); }
  }
  if (S.active && frameNo % 30 === 0) beat();
  if (frameNo % 15 === 0) paintHud();
}

// ---------- protocols ----------
function timings(o = {}) {
  const f = o.fast ? 0.1 : 1;   // the smoke test runs everything 10x shorter
  return { settle: 700 * f, base: 2500 * f, rs: 350 * f, rw: 1300 * f, path: (o.pathS ?? PATH_S) * 1000 * f, heatMin: (o.heatMinutes ?? 10), minute: 60000 * f, refresh: 2000 * f };
}
function busy() { if (S.active) { msg('A test is running: wait for it or press Stop.'); return true; } return false; }
function begin(kind) {
  S.abort = false; S.active = { kind, startedAt: new Date().toISOString(), t0: Date.now() }; beat();
  $('panel').classList.add('hidden'); $('show').style.display = 'none'; $('stop').style.display = 'block';
  requestWake();
}
function end(text) {
  S.active = null; S.load = 0; S.abort = false; S.testBusyMs = 0;
  try { localStorage.removeItem(ACTIVE); } catch (e) { /* storage blocked */ }
  $('stop').style.display = 'none'; $('panel').classList.remove('hidden'); save(); paintCard(); if (text) msg(text);
}
function beat() { try { localStorage.setItem(ACTIVE, JSON.stringify({ ...S.active, beat: Date.now() })); } catch (e) { /* storage blocked */ } }
function conditions() { return { lpm: S.answers.lpm || '?', charging: S.answers.charging || '?', brightness: S.answers.brightness || '?' }; }

async function measureRefresh(o = {}) {
  const T = timings(o); mode = 'blank';
  try { await waitMs(300 * (o.fast ? 0.1 : 1)); const m = await measure(T.refresh); S.refresh = { ...m, hz: rd(1000 / m.meanMs, 1), at: new Date().toISOString() }; if (fin(m.meanMs) && m.meanMs > 2) S.interval = m.meanMs; }
  finally { mode = 'scene'; }
  return S.refresh;
}
async function start(o = {}) {
  if ((S.started && !o.again) || busy()) return;
  S.started = true; $('start').disabled = true; collectAuto(); begin('refresh');
  try { await measureRefresh(o); end(`Refresh ${fmt(S.refresh.hz, 1)} Hz. Next: 2. Look through the steps, then 3. Ladder.`); }
  catch (e) { end('Stopped.'); }
  $('start').disabled = false;
}
async function runLadder(o = {}) {
  if (!S.started) return msg('Press 1. Start first.');
  if (busy()) return;
  const T = timings(o), list = o.rungs || RUNGS.map((_, i) => i), scales = o.scales || [1, 0.5], results = [];
  const keep = [S.rung, S.scale]; begin('ladder');
  const entry = { at: new Date().toISOString(), conditions: conditions(), limitPct: LIMIT, levels: LEVELS, fast: !!o.fast, results, done: false };
  S.ladders.push(entry);
  try {
    for (const scale of scales) for (const r of list) {
      setScale(scale); setRung(r); S.load = 0; restartPath();
      const sw = await measure(T.settle), base = await measure(T.base), ramp = [];
      let kmax = 0, failAt = null;
      if (base.dropsPct !== null && base.dropsPct <= LIMIT) {
        for (const L of LEVELS) { S.load = L; await waitMs(T.rs); const m = await measure(T.rw); ramp.push({ L, dropsPct: m.dropsPct, cpuMs: m.cpuMs }); if (m.dropsPct === null || m.dropsPct > LIMIT) { failAt = L; break; } kmax = L; }
        if (failAt !== null && kmax >= 1 && failAt - kmax > 1) {
          const mid = Math.round((kmax + failAt) / 2); S.load = mid; await waitMs(T.rs); const m = await measure(T.rw);
          ramp.push({ L: mid, dropsPct: m.dropsPct, cpuMs: m.cpuMs }); if (m.dropsPct !== null && m.dropsPct <= LIMIT) kmax = mid; else failAt = mid;
        }
      } else failAt = 0;
      S.load = 0;
      const db = renderer.getDrawingBufferSize(tmpV2);
      results.push({ scale, rung: r, name: RUNGS[r].name, canvas: `${db.x}x${db.y}`, switchMs: sw.maxMs, base, kmax: failAt === 0 ? null : kmax, capped: failAt === null, failAt, ramp, memMB: rd(gpuEstimateMB(), 1) });
      save(); paintCard();
    }
    entry.done = true; end('Ladder done. Next: 4. Path.');
  } catch (e) { end(e.message === 'stopped' ? 'Ladder stopped; the steps measured so far are on the card.' : 'Ladder failed: ' + e.message); }
  setScale(keep[1]); setRung(keep[0]);
}
async function runPath(o = {}) {
  if (!S.started) return msg('Press 1. Start first.');
  if (busy()) return;
  const T = timings(o), scales = o.scales || [1, 0.5], rung = o.rung ?? TOP, keep = [S.rung, S.scale]; begin('path');
  const entry = { at: new Date().toISOString(), conditions: conditions(), rung, results: [], done: false }; S.paths.push(entry);
  try {
    for (const scale of scales) {
      setScale(scale); setRung(rung); restartPath(); await waitMs(T.settle);
      restartPath(); const m = await measure(T.path); const db = renderer.getDrawingBufferSize(tmpV2);
      entry.results.push({ scale, canvas: `${db.x}x${db.y}`, ...m }); save(); paintCard();
    }
    entry.done = true; end('Path done. Next: 5. Heat run (optional) or 6. Answers.');
  } catch (e) { end(e.message === 'stopped' ? 'Path stopped.' : 'Path failed: ' + e.message); }
  setScale(keep[1]); setRung(keep[0]);
}
async function runHeat(o = {}) {
  if (!S.started) return msg('Press 1. Start first.');
  if (busy()) return;
  const T = timings(o), keep = [S.rung, S.scale]; begin('heat');
  S.heat = { at: new Date().toISOString(), conditions: conditions(), batteryStart: S.typed.batteryStart || '?', planned: T.heatMin, minutes: [], done: false }; save();
  try {
    setScale(1); setRung(TOP); restartPath();
    for (let i = 0; i < T.heatMin; i++) { const m = await measure(T.minute); S.heat.minutes.push({ dropsPct: m.dropsPct, medianMs: m.medianMs, p95Ms: m.p95Ms, stalls50: m.stalls50, frames: m.frames }); save(); paintCard(); }
    S.heat.done = true; end('Heat run done. Feel the back of the phone, note the battery %, then answer in 6.');
  } catch (e) { end(e.message === 'stopped' ? 'Heat run stopped.' : 'Heat run failed: ' + e.message); }
  setScale(keep[1]); setRung(keep[0]);
}
function stop() { if (S.active) S.abort = true; }

// ---------- GPU memory estimate (what this page allocates for the rung; driver overhead not counted) ----------
function geoBytes(g) { let b = 0; for (const k in g.attributes) b += g.attributes[k].array.byteLength; if (g.index) b += g.index.array.byteLength; return b; }
function gpuEstimateMB() {
  const R = RUNGS[S.rung], db = renderer.getDrawingBufferSize(tmpV2), rt = (t, bpp) => (t ? t.width * t.height * (bpp + (t.depthBuffer ? 4 : 0)) : 0);
  let b = db.x * db.y * (4 * 3 + 4);   // the drawing buffer: colour, assumed triple-buffered, plus depth
  b += 256 * 256 * (R.nmap ? 4 : 0) * 4 / 3 + 256 * 256 * (R.foam || R.wake ? 1 : 0) * 4 / 3;
  b += geoBytes(water.geometry) + geoBytes(skirt.geometry) + geoBytes(sky.geometry);
  boat.traverse((o) => { if (o.geometry) b += geoBytes(o.geometry); });
  if (R.wake) b += geoBytes(wakeGeo); if (R.spray) b += geoBytes(spray.geometry);
  if (R.bloom && composer) { b += rt(composer.renderTarget1, 8) + rt(composer.renderTarget2, 8); for (const t of [bloomPass.renderTargetBright, ...bloomPass.renderTargetsHorizontal, ...bloomPass.renderTargetsVertical]) b += rt(t, 8); }
  if (R.refl) b += rt(reflRT, 8);
  return b / 1048576;
}

// ---------- context loss, reloads, wake lock, saving ----------
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); S.lost.push({ at: new Date().toISOString(), during: S.active ? S.active.kind : 'idle' }); if (S.active) S.abort = true; msg('The phone took the graphics away (context lost). It is on the card. Reload the page before measuring again.'); save(); });
canvas.addEventListener('webglcontextrestored', () => { S.restoredCtx++; save(); });
async function requestWake() {
  if (!S.wake.supported || S.wake.sentinel) return;
  try { S.wake.sentinel = await navigator.wakeLock.request('screen'); S.wake.state = 'active'; S.wake.sentinel.addEventListener('release', () => { S.wake.releases++; S.wake.sentinel = null; S.wake.state = 'released'; }); }
  catch (e) { S.wake.state = 'refused: ' + (e && e.name); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.started) requestWake(); });
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ savedAt: new Date().toISOString(), version: VERSION, ladders: S.ladders, paths: S.paths, heat: S.heat, lost: S.lost, restoredCtx: S.restoredCtx, reloads: S.reloads, answers: S.answers, typed: S.typed, refresh: S.refresh, settings: S.settings })); }
  catch (e) { /* private browsing or storage full: the page works without it */ }
}
function restore() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE) || 'null');
    if (a && a.kind) S.reloads.push({ during: a.kind, startedAt: a.startedAt, ranS: rd((a.beat - a.t0) / 1000, 0), noticedAt: new Date().toISOString() });
    localStorage.removeItem(ACTIVE);
    const d = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (d && d.savedAt && Date.now() - Date.parse(d.savedAt) < 6 * 3600e3) {
      S.restored = d.savedAt; S.ladders = d.ladders || []; S.paths = d.paths || []; S.heat = d.heat || null; S.lost = d.lost || []; S.restoredCtx = d.restoredCtx || 0;
      S.reloads = [...(d.reloads || []), ...S.reloads]; Object.assign(S.answers, d.answers || {}); Object.assign(S.typed, d.typed || {}); S.refresh = d.refresh || null;
      if (d.settings) Object.assign(S.settings, d.settings);
      if (S.refresh && fin(S.refresh.meanMs)) S.interval = S.refresh.meanMs;
    }
  } catch (e) { /* unreadable: start fresh */ }
}

// ---------- conditions, card, recording ----------
function shortUA() { const u = navigator.userAgent; const m = u.match(/(iPhone OS [\d_]+|Android [\d.]+|Windows NT [\d.]+|Mac OS X [\d_]+)/); const b = u.match(/(CriOS|FxiOS|EdgiOS|Chrome|Version|Firefox)\/([\d.]+)/); return `${m ? m[1].replace(/_/g, '.') : '?'} ${b ? b[1] + ' ' + b[2] : ''}`.trim(); }
function collectAuto() {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info'), hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  Object.assign(S.auto, { ua: shortUA(), gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), dpr: window.devicePixelRatio, screen: `${screen.width}x${screen.height}`,
    inFrame: window.self !== window.top, webgpu: 'gpu' in navigator, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), fragHighp: hp ? hp.precision : null,
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), floatRT: !!gl.getExtension('EXT_color_buffer_float'), three: THREE.REVISION });
}
function payload() {
  const es = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
  const sum = (k) => es.reduce((s, e) => s + (e[k] || 0), 0);
  return { files: es.length, transferKB: rd(sum('transferSize') / 1024, 0), encodedKB: rd(sum('encodedBodySize') / 1024, 0), decodedKB: rd(sum('decodedBodySize') / 1024, 0) };
}
const SC = (s) => (s === 1 ? 'full' : s === 0.5 ? 'half' : `${s * 100}%`);
function cardText() {
  const A = S.answers, T = S.typed, C = S.auto, L = [], p = payload();
  L.push(`S2 water lab ${VERSION} | device clock ${new Date().toISOString()} | ${location.host}${S.restored ? ' | includes results restored after a reload' : ''}`);
  L.push(`Phone: ${T.model || '?'} | OS/browser: ${C.ua || shortUA()} (from the browser, may be frozen) | GPU: ${C.gpu || '?'} | DPR ${C.dpr ?? window.devicePixelRatio} | screen ${C.screen || '?'} | in a frame: ${C.inFrame ? 'YES' : 'no'} | WebGPU present: ${C.webgpu ? 'yes' : 'no'}`);
  L.push(`Battery start ${T.batteryStart || '?'} %, end ${T.batteryEnd || '?'} % | charging ${A.charging || '?'} | Low Power ${A.lpm || '?'} | brightness ${A.brightness || '?'} | room ${T.room || '?'} C | wake lock ${S.wake.state} (released ${S.wake.releases}x)`);
  const rf = S.refresh;
  L.push(`Refresh seen: ${rf ? `${fmt(rf.hz, 1)} Hz (mean frame ${fmt(rf.meanMs, 2)} ms over ${rf.frames} frames with nothing drawn)` : 'not measured (press 1. Start)'} | first frame ${fmt(S.firstFrameMs, 0)} ms after the page began loading | payload ${p.files} files, transfer ${fmt(p.transferKB, 0)} KB (0 = not reported or cached), encoded ${fmt(p.encodedKB, 0)} KB`);
  L.push(`Renderer: three.js r${C.three || THREE.REVISION} WebGL 2, no antialias | grid ${S.settings.seg}x${S.settings.seg} over ${S.settings.radius} m, ${waves.length} waves, reflection ${S.settings.reflSize} px | fragment highp ${C.fragHighp === undefined ? '?' : C.fragHighp ? 'yes' : 'no'} | GPU timer ${C.timerQuery === undefined ? '?' : C.timerQuery ? 'yes' : 'no'} | float targets ${C.floatRT === undefined ? '?' : C.floatRT ? 'yes' : 'no'}`);
  if (!S.ladders.length) L.push('Ladder: not run');
  S.ladders.forEach((lad, n) => {
    L.push(`Ladder ${n + 1} (${lad.at.slice(11, 19)}Z, Low Power ${lad.conditions.lpm}, charging ${lad.conditions.charging}${lad.done ? '' : ', NOT FINISHED'}${lad.fast ? ', test timings' : ''}): drops = missed refresh slots with no extra load; headroom = extra full frames per frame before more than ${lad.limitPct} % of slots are missed; mem = estimate`);
    lad.results.forEach((r) => L.push(`  ${SC(r.scale)} ${r.canvas} R${r.rung} ${r.name}: drops ${fmt(r.base.dropsPct, 1)} % (frame median ${fmt(r.base.medianMs, 1)} ms, cpu ${fmt(r.base.cpuMs, 1)} ms), headroom ${r.kmax === null ? 'NONE (drops at no extra load)' : r.capped ? `${r.kmax}+ (never dropped)` : `${r.kmax} (dropped at ${r.failAt})`}, switch ${fmt(r.switchMs, 0)} ms, mem ~${fmt(r.memMB, 0)} MB`));
  });
  if (!S.paths.length) L.push('Path: not run');
  S.paths.forEach((pa) => L.push(`Path 60 s, R${pa.rung} ${RUNGS[pa.rung].name} (Low Power ${pa.conditions.lpm}${pa.done ? '' : ', NOT FINISHED'}): ` + (pa.results.length ? '' : 'no results') + pa.results.map((r) => `${SC(r.scale)} ${r.canvas}: drops ${fmt(r.dropsPct, 1)} % (${r.missed} missed of ${r.frames + r.missed}), median ${fmt(r.medianMs, 1)} ms, p95 ${fmt(r.p95Ms, 1)}, worst ${fmt(r.maxMs, 0)} ms, stalls over 50 ms ${r.stalls50}, cpu ${fmt(r.cpuMs, 1)} ms`).join(' | ')));
  const H = S.heat;
  L.push(H ? `Heat ${H.minutes.length} of ${H.planned || 10} min, R${TOP}, full (${H.done ? 'done' : 'NOT FINISHED'}; battery at start ${H.batteryStart} %): drops % per minute ${H.minutes.map((m) => fmt(m.dropsPct, 1)).join(' ')} | median frame first ${fmt(H.minutes[0]?.medianMs, 1)} ms, last ${fmt(H.minutes[H.minutes.length - 1]?.medianMs, 1)} ms` : 'Heat: not run');
  L.push(`Lost graphics context: ${S.lost.length}${S.lost.length ? ' (' + S.lost.map((l) => `${l.during} ${l.at.slice(11, 19)}Z`).join(', ') + ')' : ''} | page restarted during a test: ${S.reloads.length}${S.reloads.length ? ' (' + S.reloads.map((r) => `${r.during} after ${r.ranS} s`).join(', ') + ')' : ''}`);
  L.push(`Answers: cheapest step that still looks like water ${A.cheap ? 'R' + A.cheap : '?'}, best-looking ${A.best ? 'R' + A.best : '?'}, stutter in the path ${A.stutter || '?'}, phone after the heat run ${A.warm || '?'} | notes: ${T.notes || '-'}`);
  return L.join('\n');
}
function recording() {
  return { kind: 's2-water-recording', version: VERSION, deviceClock: new Date().toISOString(), loadedAt: S.loadedAt, url: location.origin + location.pathname,
    auto: S.auto, typed: S.typed, answers: S.answers, settings: S.settings, waves, refresh: S.refresh, firstFrameMs: S.firstFrameMs, payload: payload(),
    ladders: S.ladders, paths: S.paths, heat: S.heat, lost: S.lost, restoredCtx: S.restoredCtx, reloads: S.reloads, wake: { state: S.wake.state, releases: S.wake.releases } };
}

// ---------- UI ----------
function msg(t) { $('msg').textContent = t; }
function paintCard() { $('card').textContent = cardText(); }
function paintHud() {
  const R = RUNGS[S.rung], db = renderer.getDrawingBufferSize(tmpV2), sl = S.roll.reduce((s, r) => s + r[2], 0), fr = S.roll.length;
  $('hud').textContent = `R${S.rung} ${R.name} | ${SC(S.scale)} ${db.x}x${db.y} | ${fr} fps, missed ${sl} | load ${S.load}${S.active ? ' | ' + S.active.kind : ''}`;
}
function paintRungButtons() {
  const box = $('rungs');
  if (!box.childElementCount) RUNGS.forEach((r, i) => { const b = document.createElement('button'); b.dataset.rung = i; b.textContent = `R${i} ${r.name}`; b.onclick = () => { if (!S.active) setRung(i); }; box.appendChild(b); });
  box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.rung === S.rung)));
}
function wire() {
  for (const id of ['ans-cheap', 'ans-best']) { const k = id.slice(4); RUNGS.forEach((_, i) => { const b = document.createElement('button'); b.dataset.a = k; b.dataset.v = String(i); b.textContent = 'R' + i; $(id).appendChild(b); }); }
  document.querySelectorAll('button[data-a]').forEach((b) => {
    b.onclick = () => { const k = b.dataset.a, v = b.dataset.v; if (S.answers[k] === v) delete S.answers[k]; else S.answers[k] = v; paintAnswers(); save(); paintCard(); };
  });
  document.querySelectorAll('[data-t]').forEach((el) => { el.value = S.typed[el.dataset.t] || ''; el.oninput = () => { S.typed[el.dataset.t] = el.value.trim(); save(); paintCard(); }; });
  document.querySelectorAll('[data-s]').forEach((el) => { el.value = S.settings[el.dataset.s]; el.onchange = () => { if (S.active) return; S.settings[el.dataset.s] = +el.value; rebuild(); save(); paintCard(); }; });
  document.querySelectorAll('[data-scale]').forEach((b) => { b.onclick = () => { if (!S.active) setScale(+b.dataset.scale); }; });
  $('start').onclick = () => start();
  $('ladder').onclick = () => runLadder(); $('path').onclick = () => runPath(); $('heat').onclick = () => runHeat();
  $('stop').onclick = () => stop();
  $('hide').onclick = () => { $('panel').classList.add('hidden'); $('show').style.display = 'block'; };
  $('show').onclick = () => { $('panel').classList.remove('hidden'); $('show').style.display = 'none'; };
  $('copy').onclick = async () => { paintCard(); try { await navigator.clipboard.writeText(cardText()); msg('Card copied: paste it in the chat.'); } catch (e) { msg('Copy failed: select the card text and copy it by hand.'); } };
  $('dl').onclick = () => { const blob = new Blob([JSON.stringify(recording())], { type: 'application/json' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 's2-recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); };
  $('reset').onclick = () => { if (!confirm('Clear every saved result of this test on this phone?')) return; try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ } location.reload(); };
  $('ver').textContent = `${VERSION}, three.js r${THREE.REVISION}`;
  paintAnswers();
}
function paintAnswers() { document.querySelectorAll('button[data-a]').forEach((b) => b.setAttribute('aria-pressed', String(S.answers[b.dataset.a] === b.dataset.v))); }
function rebuild() { setWaves(); buildWater(); buildSpray(); buildRefl(); setRung(S.rung); }

// ---------- boot ----------
restore();
U.tNormal.value = makeNormalTexture(); U.tFoam.value = makeFoamTexture();
buildPath(); rebuild(); sizeAll(); collectAuto(); wire(); paintRungButtons(); paintCard();
if (S.reloads.length) msg(`The page restarted during a test (${S.reloads[S.reloads.length - 1].during}); that is on the card. Press 1. Start to go on.`);
requestAnimationFrame(loop);
window.__ready = true;

// ---------- test hooks (the smoke test drives the page through these) ----------
function probeWaves(pts, t) {   // the GPU runs WAVE_GLSL at each (x0, z0): returns [x, y, z, jac, nx, ny, nz] per point
  const n = pts.length, g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('p0', new THREE.BufferAttribute(new Float32Array(pts.flat()), 2));
  g.setAttribute('idx', new THREE.BufferAttribute(new Float32Array(pts.map((_, i) => i)), 1));
  const mat = new THREE.ShaderMaterial({ uniforms: { ...U, uT: { value: t }, uN: { value: n }, uWhich: { value: 0 } }, toneMapped: false,
    vertexShader: `${W.WAVE_GLSL}\nuniform float uT; uniform float uN; attribute vec2 p0; attribute float idx; varying vec4 vA; varying vec4 vB;
void main() { vec3 pos, nrm; float jac; gerstner(p0, uT, 1.0, pos, nrm, jac); vA = vec4(pos, jac); vB = vec4(nrm, 0.0); gl_Position = vec4((idx + 0.5) / uN * 2.0 - 1.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }`,
    fragmentShader: 'uniform int uWhich; varying vec4 vA; varying vec4 vB; void main() { gl_FragColor = uWhich == 0 ? vA : vB; }' });
  const pts3 = new THREE.Points(g, mat); pts3.frustumCulled = false; const sc = new THREE.Scene(); sc.add(pts3);
  const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, depthBuffer: false }), out = [];
  for (const which of [0, 1]) {
    mat.uniforms.uWhich.value = which; renderer.setRenderTarget(rt); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(sc, camera);
    const buf = new Float32Array(n * 4); renderer.readRenderTargetPixels(rt, 0, 0, n, 1, buf); out.push(buf);
  }
  renderer.setRenderTarget(null); rt.dispose(); g.dispose(); mat.dispose();
  return pts.map((_, i) => [out[0][4 * i], out[0][4 * i + 1], out[0][4 * i + 2], out[0][4 * i + 3], out[1][4 * i], out[1][4 * i + 1], out[1][4 * i + 2]]);
}
function snapshot() {   // draw one frame now and read it back before the browser presents it
  updateScene(pathTime()); draw();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(4); let sum = 0, white = 0, n = 0, hash = 2166136261;
  for (let j = 0; j < 36; j++) for (let i = 0; i < 64; i++) {
    gl.readPixels(Math.floor(((i + 0.5) / 64) * w), Math.floor(((j + 0.5) / 36) * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const l = (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255; sum += l; n++; if (l > 0.82) white++;
    for (let c = 0; c < 3; c++) hash = Math.imul(hash ^ px[c], 16777619) >>> 0;
  }
  return { luma: rd(sum / n, 4), white: rd(white / n, 4), hash: hash.toString(16), w, h };
}
window.__s2 = { version: VERSION, S, RUNGS, start, setRung, setScale, ladder: runLadder, path: runPath, heat: runHeat, stop, card: cardText, recording, refresh: measureRefresh,
  probeWaves, snapshot, waves: () => waves, mem: gpuEstimateMB, freeze: (t) => { S.freezeT = t; }, boat: () => ({ ...B, rot: [boat.rotation.x, boat.rotation.y, boat.rotation.z] }), info: () => renderer.info };
