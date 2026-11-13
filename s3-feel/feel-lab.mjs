// feel-lab.mjs: the S3 boat feel lab. A greybox boat on the S2 waves, steered by tilt (signal B by default), on a buoy course with
// one rival; two handling presets (offshore, jet), three chase cameras, a tuning panel, scores per run, a recap card, and a recording
// of every run's steering that replays exactly on the same browser.
// Written 2026-11-08; v0.2 2026-11-13: a moored yacht beside the course (assets/yacht-b04.glb) and the sound-output question.
// Smoke test: node tools/smoke-s3.mjs (headless Chrome; never phone numbers).
// Simulation: ../shared/boat-sim.mjs; steering: ../shared/tilt-input.mjs; water: ../shared/water-view.mjs; waves: ../shared/waves.mjs.
import * as THREE from 'three';
import * as W from '../shared/waves.mjs';
import * as B from '../shared/boat-sim.mjs';
import { TiltInput, TILT_DEFAULTS } from '../shared/tilt-input.mjs';
import { Sea, Wake, Spray } from '../shared/water-view.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const VERSION = 's3-feel v0.2';
const now = () => performance.now();
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const rd = (v, d = 2) => (fin(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const fmt = (v, d = 1) => (fin(v) ? v.toFixed(d) : '-');
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const mmss = (s) => (fin(s) ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}` : '-');

// ---------- what the test compares ----------
const CAMS = {
  A: { label: 'A close chase', back: 7, up: 2.4, look: 7, lookUp: 1.0, fov0: 62, fovK: 10, roll: 0, lead: 0 },
  B: { label: 'B high chase, looks into turns', back: 10.5, up: 4.6, look: 12, lookUp: 0.4, fov0: 58, fovK: 4, roll: 0, lead: 0.45 },
  C: { label: 'C low and wide, leans with the boat', back: 5, up: 1.5, look: 8, lookUp: 1.2, fov0: 70, fovK: 18, roll: 0.35, lead: 0.15 },
};
const PROTOCOL = [{ preset: 'offshore', cam: 'A' }, { preset: 'jet', cam: 'A' }, { preset: 'jet', cam: 'B' }, { preset: 'offshore', cam: 'B' },
  { preset: 'offshore', cam: 'C' }, { preset: 'jet', cam: 'C' }];   // each camera with both boats, the boat order alternating
const SEAS = { calm: 0.15, normal: 0.4, rough: 0.7 };
const QUALITY = { low: { nmap: false, foam: false, refl: false, spray: 0.4 }, mid: { nmap: true, foam: true, refl: false, spray: 1 }, high: { nmap: true, foam: true, refl: true, spray: 1 } };
const TUNE = [   // [key, label, min, max, step, where]: where = 'tilt' or 'boat'
  ['deadDeg', 'Dead zone, deg', 0, 6, 0.5, 'tilt'], ['maxDeg', 'Full lock at, deg', 10, 40, 1, 'tilt'], ['expo', 'Curve (1 = straight)', 1, 2.5, 0.1, 'tilt'],
  ['euroMin', 'Smoothing, min cutoff Hz (lower = smoother)', 0.3, 3, 0.1, 'tilt'], ['euroBeta', 'Smoothing, speed gain', 0, 0.1, 0.005, 'tilt'],
  ['top', 'Top speed, m/s', 15, 40, 1, 'boat'], ['turnRate', 'Turn rate, deg/s', 25, 110, 1, 'boat'], ['yawTau', 'Turn response time, s', 0.05, 0.6, 0.01, 'boat'],
  ['grip', 'Grip (lower = more slide)', 0.8, 6, 0.1, 'boat'],
];
const STORE = 's3-session', ACTIVE = 's3-active';

const S = {
  version: VERSION, loadedAt: new Date().toISOString(), started: false, starting: false, perm: null, calibrating: null,
  settings: { preset: 'offshore', cam: 'A', rival: 'fair', signal: 'B', sea: 'normal', quality: 'mid', scale: 1, sound: 'on', invert: 'no', skill: 0.9 },
  tilt: { ...TILT_DEFAULTS }, tune: { offshore: {}, jet: {} },
  runs: [], replays: [], active: null, lastSummary: null, timeScale: 1, auto: false, brake: false, interval: 1000 / 60, idleDeltas: [],
  lost: [], restoredCtx: 0, reloads: [], answers: {}, typed: {}, auto_: {}, restored: null, firstFrameMs: null,
  wake: { supported: 'wakeLock' in navigator, state: 'not requested', sentinel: null, releases: 0 },
  audio: { state: 'not started', session: 'audioSession' in navigator ? 'supported' : 'not supported', ctx: null, tones: 0 },
};
const input = new TiltInput();
const course = B.makeCourse();

// ---------- renderer, scene, sea ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
const gl = renderer.getContext();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 3000);
const look = new THREE.Vector3();
const sea = new Sea(renderer, scene, { seg: 160, radius: 300 });
scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x0b2a3a, 1.4));
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6); sun.position.set(-35, 30, -89); scene.add(sun);

// ---------- greybox boats (no real hull, brand or person) ----------
function offshoreMesh(stripe) {   // bow toward +z, 7.2 m long
  const g = new THREE.Group(), sh = new THREE.Shape();
  sh.moveTo(-1.2, -3.4); sh.lineTo(1.2, -3.4); sh.lineTo(1.25, 1.2); sh.quadraticCurveTo(1.0, 3.0, 0, 3.8); sh.quadraticCurveTo(-1.0, 3.0, -1.25, 1.2); sh.closePath();
  const hull = new THREE.ExtrudeGeometry(sh, { depth: 1.0, bevelEnabled: false, curveSegments: 6 }); hull.rotateX(Math.PI / 2); hull.translate(0, 0.6, 0);
  g.add(new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.45 })));
  const st = new THREE.Mesh(new THREE.BoxGeometry(2.56, 0.14, 4.6), new THREE.MeshStandardMaterial({ color: stripe, roughness: 0.5 })); st.position.set(0, 0.3, -0.9); g.add(st);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.75, 2.0), new THREE.MeshStandardMaterial({ color: 0x1b2c3c, roughness: 0.2, metalness: 0.3 })); cab.position.set(0, 0.95, -0.5); g.add(cab);
  return g;
}
function jetMesh(stripe) {   // 3.2 m long
  const g = new THREE.Group(), sh = new THREE.Shape();
  sh.moveTo(-0.55, -1.5); sh.lineTo(0.55, -1.5); sh.lineTo(0.6, 0.6); sh.quadraticCurveTo(0.45, 1.4, 0, 1.7); sh.quadraticCurveTo(-0.45, 1.4, -0.6, 0.6); sh.closePath();
  const hull = new THREE.ExtrudeGeometry(sh, { depth: 0.55, bevelEnabled: false, curveSegments: 5 }); hull.rotateX(Math.PI / 2); hull.translate(0, 0.25, 0);   // bottom 0.3 m below the boat's origin (draft 0.18)
  g.add(new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.45 })));
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 1.3), new THREE.MeshStandardMaterial({ color: stripe, roughness: 0.6 })); seat.position.set(0, 0.38, -0.4); g.add(seat);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.08), new THREE.MeshStandardMaterial({ color: 0x222831 })); bar.position.set(0, 0.75, 0.45); g.add(bar);
  const rider = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.8, 0.35), new THREE.MeshStandardMaterial({ color: 0x2b3a4a, roughness: 0.8 })); rider.position.set(0, 0.9, -0.2); g.add(rider);
  return g;
}
const boats = { player: null, rival: null, kind: null };
function setBoats(preset) {
  if (boats.kind === preset) return;
  for (const k of ['player', 'rival']) if (boats[k]) scene.remove(boats[k]);
  boats.player = preset === 'jet' ? jetMesh(0xc8302a) : offshoreMesh(0xc8302a);
  boats.rival = preset === 'jet' ? jetMesh(0x2a62c8) : offshoreMesh(0x2a62c8);
  boats.rival.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; } });
  scene.add(boats.player); scene.add(boats.rival); boats.kind = preset;
}
const wakeP = new Wake(scene, sea.U), wakeR = new Wake(scene, sea.U, { n: 90 });
const sprayP = new Spray(scene, { n: 500 }), sprayR = new Spray(scene, { n: 220 });
sea.hideInRefl = [wakeP.mesh, wakeR.mesh, sprayP.points, sprayR.points];

// ---------- the course: gate buoys, edge markers, next-gate arch, start line, ramps ----------
const GATE_COL = { slalom: new THREE.Color(0xff7a1a), corner: new THREE.Color(0xffd21a), ok: new THREE.Color(0x3ccf6e), miss: new THREE.Color(0xe0303a) };
const buoyGeo = new THREE.CylinderGeometry(0.35, 0.6, 1.8, 10); buoyGeo.translate(0, 0.5, 0);
const gateBuoys = new THREE.InstancedMesh(buoyGeo, new THREE.MeshStandardMaterial({ roughness: 0.5 }), course.gates.length * 2);
const buoyPos = [];
course.gates.forEach((g, i) => { for (const lat of [g.lo, g.hi]) { const p = B.pointAt(course, g.s, lat); buoyPos.push({ x: p.x, z: p.z }); gateBuoys.setColorAt(buoyPos.length - 1, GATE_COL[g.kind]); } });
scene.add(gateBuoys);
const EDGE_STEP = 30, edgePos = [];
for (let s = 0; s < course.len; s += EDGE_STEP) for (const lat of [-course.halfWidth, course.halfWidth]) { const p = B.pointAt(course, s, lat); edgePos.push({ x: p.x, z: p.z }); }
const edges = new THREE.InstancedMesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.4 }), edgePos.length); scene.add(edges);
const arch = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 6, 40, Math.PI), new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.8 })); scene.add(arch);
function startLine() {
  const g = new THREE.Group(), pole = new THREE.CylinderGeometry(0.25, 0.3, 6, 8), m = new THREE.MeshStandardMaterial({ color: 0xdddddd });
  for (const lat of [-13, 13]) { const p = B.pointAt(course, 0, lat), o = new THREE.Mesh(pole, m); o.position.set(p.x, 3, p.z); g.add(o); }
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 8; const cx = cv.getContext('2d');
  for (let i = 0; i < 64; i++) for (let j = 0; j < 8; j++) { cx.fillStyle = (i + j) % 2 ? '#111' : '#eee'; cx.fillRect(i, j, 1, 1); }
  const tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
  const ban = new THREE.Mesh(new THREE.PlaneGeometry(26, 1.6), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  const p0 = B.pointAt(course, 0, 0); ban.position.set(p0.x, 5.6, p0.z); ban.lookAt(p0.x - Math.sin(p0.h) * 10, 5.6, p0.z + Math.cos(p0.h) * 10); g.add(ban);
  return g;
}
scene.add(startLine());
const rampMeshes = course.ramps.map((r) => {
  const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(r.len, 0); sh.lineTo(r.len, r.height); sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth: 2 * r.halfW, bevelEnabled: false }); geo.translate(0, 0, -r.halfW); geo.rotateY(-Math.PI / 2);   // length along +z
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3d4b5a, roughness: 0.7 }));
  const p = B.pointAt(course, r.s, 0); m.position.set(p.x, 0, p.z); m.rotation.y = -p.h; scene.add(m); return { m, r, p };
});

// ---------- a moored yacht beside the course: a 3D model made from a turnaround picture, slimmed to 11,998 triangles ----------
// It loads in the background (1.7 MB); a run never waits for it, and a failed load only shows on the card.
const YACHT = { url: './assets/yacht-b04.glb', length: 24, waterline: 1.45, s: 120, off: 58, turn: 0.35 };
const yacht = { state: 'loading', ms: null, bytes: null, tris: null, err: null, obj: null, seen: 0, y: 0, pitch: 0, roll: 0 };
const yachtAt = (() => {   // the outside of the loop at s = 120 m, 58 m from the line (the course is 28 m wide each side)
  let cx = 0, cz = 0, n = 0; for (let s = 0; s < course.len; s += 20) { const p = B.pointAt(course, s, 0); cx += p.x; cz += p.z; n++; }
  const a = B.pointAt(course, YACHT.s, YACHT.off), b = B.pointAt(course, YACHT.s, -YACHT.off);
  const p = Math.hypot(a.x - cx / n, a.z - cz / n) > Math.hypot(b.x - cx / n, b.z - cz / n) ? a : b;
  return { x: p.x, z: p.z, h: p.h + YACHT.turn };
})();
{
  const t0 = now();
  new GLTFLoader().load(YACHT.url, (g) => {
    const inner = g.scene; inner.rotation.y = -Math.PI / 2;   // the model's bow points +x; the game's boats point +z
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner), size = box.getSize(new THREE.Vector3()), k = YACHT.length / Math.max(size.x, size.z);
    inner.scale.setScalar(k); inner.position.y = -box.min.y * k - YACHT.waterline;   // the keel sits 1.45 m under the water
    const outer = new THREE.Group(); outer.add(inner); outer.position.set(yachtAt.x, 0, yachtAt.z); outer.rotation.set(0, -yachtAt.h, 0, 'YXZ');
    let tris = 0; inner.traverse((o) => { if (o.isMesh) { const gm = o.geometry; tris += (gm.index ? gm.index.count : gm.attributes.position.count) / 3; } });
    let bytes = null; try { const pe = performance.getEntriesByName(new URL(YACHT.url, location.href).href)[0]; bytes = pe ? (pe.decodedBodySize || pe.encodedBodySize || null) : null; } catch (e) { /* no timing */ }
    scene.add(outer); Object.assign(yacht, { state: 'loaded', ms: Math.round(now() - t0), tris, obj: outer, bytes: bytes || yacht.bytes });
  }, (e) => { if (e && e.total) yacht.bytes = e.total; }, (e) => { yacht.state = 'failed'; yacht.err = String((e && e.message) || e).slice(0, 120); });
}
const camDir = new THREE.Vector3();
function placeYacht(wv, t, dt) {   // slow heave, pitch and roll on the same waves (a 24 m hull answers slowly), and whether it was in view
  const o = yacht.obj; if (!o) return;
  const f = fadeAt(o.position.x, o.position.z), fx = -Math.sin(yachtAt.h), fz = Math.cos(yachtAt.h), rx = -Math.cos(yachtAt.h), rz = -Math.sin(yachtAt.h);
  const h = (dx, dz) => (f > 0.01 ? W.heightAt(wv, o.position.x + dx, o.position.z + dz, t, 3) * f : 0);
  const hb = h(fx * 10, fz * 10), hs = h(-fx * 10, -fz * 10), hp = h(-rx * 3, -rz * 3), hr = h(rx * 3, rz * 3), k = 1 - Math.exp(-dt / 0.8);
  yacht.y += ((hb + hs + hp + hr) / 4 - yacht.y) * k; yacht.pitch += (Math.atan2(hb - hs, 20) - yacht.pitch) * k; yacht.roll += (Math.atan2(hp - hr, 6) - yacht.roll) * k;
  o.position.y = yacht.y; o.rotation.set(-yacht.pitch, -yachtAt.h, yacht.roll, 'YXZ');
  camera.getWorldDirection(camDir); v3.set(o.position.x - camera.position.x, o.position.y + 3 - camera.position.y, o.position.z - camera.position.z);
  if (S.active && v3.dot(camDir) > 0) { v3.set(o.position.x, o.position.y + 3, o.position.z).project(camera); if (Math.abs(v3.x) < 1 && Math.abs(v3.y) < 1) yacht.seen++; }   // run frames only
}

// ---------- runs ----------
function simSettings(preset, rival) {
  const s = B.defaultSettings(preset);
  Object.assign(s.P, S.tune[preset] || {});
  s.rival = rival; s.skill = S.settings.skill; s.waves = { ...s.waves, amp: SEAS[S.settings.sea] ?? 0.4 };
  return s;
}
let idle = null;
function makeIdle() { const s = simSettings(S.settings.preset, 'off'); idle = new B.Run(s, course); idle.go = 1e9; setBoats(s.preset); sea.setWaves(idle.waves); wakeP.reset(); wakeR.reset(); }
function busy() { if (S.active) { msg('A run is going: finish it or press Stop.'); return true; } return false; }
function startRun(o) {
  if (busy()) return false;
  if (o.kind !== 'replay') {
    if (!S.started) { msg('Press 1. Start first.'); return false; }
    if (input.source === 'tilt' && !input.cal) { msg('Calibrate first: hold the phone like a wheel, keep still, press Calibrate again.'); return false; }
  }
  $('score').style.display = 'none';
  const settings = o.settings ? JSON.parse(JSON.stringify(o.settings)) : simSettings(o.preset, o.rival ?? S.settings.rival);
  const run = new B.Run(settings, course);
  S.active = { kind: o.kind, idx: o.idx ?? null, cam: o.cam, run, acc: 0, t0: now(), startedAt: new Date().toISOString(), frames: { n: 0, missed: 0, deltas: [] },
    counts0: { ...input.counts }, th0: now(), recentres: 0, replay: o.replay || null, replayOf: o.replayOf ?? null, source: input.source, signal: input.signalInUse(),
    landings: 0, steerLog: [], lastHud: '' };
  setBoats(settings.preset); sea.setWaves(run.waves); wakeP.reset(); wakeR.reset(); camState.h = null;
  rampMeshes.forEach((rm) => { rm.m.visible = !!settings.ramps; });
  $('panel').classList.add('hidden'); $('show').style.display = 'none'; $('stop').style.display = 'block';
  $('recentre').style.display = o.kind === 'replay' || input.source !== 'tilt' ? 'none' : 'block';
  for (const id of ['hud', 'count', 'steerbar']) $(id).style.display = 'block';
  $('info').style.display = 'none';
  paintDeadZone(); beat(); requestWake(); audioOn(true);
  return true;
}
function stopRun() { if (S.active) finishRun('stopped'); }
function frameSummary(f) {
  return { frames: f.n, missed: f.missed, dropsPct: f.n ? rd((100 * f.missed) / (f.n + f.missed), 2) : null, medianMs: rd(median(f.deltas), 2), worstMs: rd(f.deltas.length ? Math.max(...f.deltas) : NaN, 1) };
}
function finishRun(why) {
  const A = S.active; if (!A) return;
  if (!A.run.done) A.run.finish(why);
  if (A.hiddenAt !== null && A.hiddenAt !== undefined) { A.hiddenMs = (A.hiddenMs || 0) + (now() - A.hiddenAt); A.hiddenAt = null; }
  const sm = A.run.summary(), durS = Math.max(0.001, (now() - A.th0 - (A.hiddenMs || 0)) / 1000);   // sensor rates over visible time only
  const entry = { n: (A.kind === 'replay' ? S.replays : S.runs).length + 1, kind: A.kind, idx: A.idx, at: A.startedAt, preset: A.run.settings.preset, cam: A.cam,
    rival: A.run.settings.rival, sea: S.settings.sea, quality: S.settings.quality, scale: S.settings.scale, render: renderSize(), settings: A.run.settings,
    tilt: { ...input.o }, signal: A.signal, source: A.source, summary: sm, why: sm.why, frames: frameSummary(A.frames),
    sensor: { motPerS: rd((input.counts.mot - A.counts0.mot) / durS, 1), oriPerS: rd((input.counts.ori - A.counts0.ori) / durS, 1) },
    recentres: A.recentres, inputs: B.encodeInputs(A.run.in.steer, A.run.in.brake), scores: {}, replayOf: A.replayOf, timeScale: S.timeScale, auto: S.auto,
    hidden: { times: A.hides || 0, s: rd((A.hiddenMs || 0) / 1000, 1) } };
  if (A.kind === 'replay') {
    const src = A.replaySource;
    if (src) entry.check = { lapS: [src.lapS, sm.lapS], sameEnd: JSON.stringify(src.end) === JSON.stringify(sm.end), dEndM: rd(Math.hypot(src.end.x - sm.end.x, src.end.z - sm.end.z), 4) };
    S.replays.push(entry);
  } else S.runs.push(entry);
  S.active = null; S.brake = false;
  try { localStorage.removeItem(ACTIVE); } catch (e) { /* storage blocked */ }
  for (const id of ['hud', 'count', 'steerbar', 'stop', 'recentre']) $(id).style.display = 'none';
  audioOn(false); makeIdle(); save(); paintCard(); paintRuns();
  if (A.kind === 'replay') { $('panel').classList.remove('hidden'); msg(replayText(entry)); return; }
  showScore(entry);
}
function replayText(e) {
  if (!e.check) return `Replay done: ${fmt(e.summary.lapS, 3)} s.`;
  return `Replay done: lap ${fmt(e.check.lapS[0], 3)} s recorded, ${fmt(e.check.lapS[1], 3)} s replayed; end point ${e.check.sameEnd ? 'identical' : `differs by ${e.check.dEndM} m (a different browser computes the waves slightly differently)`}.`;
}
function nextProtocolIdx() { for (let i = 0; i < PROTOCOL.length; i++) if (!S.runs.some((r) => r.kind === 'protocol' && r.idx === i && r.why === 'finished')) return i; return null; }
function startNext() {
  const i = nextProtocolIdx();
  if (i === null) { msg('All six runs are done. Answer 4, then copy the card (5).'); $('panel').classList.remove('hidden'); $('score').style.display = 'none'; return; }
  const p = PROTOCOL[i]; startRun({ kind: 'protocol', idx: i, preset: p.preset, cam: p.cam });
}
function runLabel(r) { return r.kind === 'protocol' ? `run ${r.idx + 1} of 6` : r.kind; }
function showScore(e) {
  const sm = e.summary, el = $('score');
  $('score-title').textContent = `${e.why === 'finished' ? 'Lap done' : 'Stopped'}: ${runLabel(e)}, ${B.PRESETS[e.preset].label}, camera ${e.cam}`;
  $('score-sum').textContent = `${sm.lapS !== null ? mmss(sm.lapS) : 'no lap'} | gates ${sm.passed} of ${sm.gates}${sm.missed ? ` (${sm.missed} missed, +${2 * sm.missed} s)` : ''} | ${sm.rivalGapS === null ? 'no rival' : sm.rivalGapS < 0 ? `rival ${fmt(-sm.rivalGapS, 1)} s ahead` : `you led by ${fmt(sm.rivalGapS, 1)} s`} | top ${fmt(sm.topKmh, 0)} km/h`;
  for (const k of ['fun', 'comfort']) {
    const box = $(k); box.innerHTML = '';
    for (let v = 0; v <= 10; v++) {
      const b = document.createElement('button'); b.textContent = v; b.dataset.score = k; b.dataset.v = v;
      b.onclick = () => { if (e.scores[k] === v) delete e.scores[k]; else e.scores[k] = v; paintScore(e); save(); paintCard(); paintRuns(); };
      box.appendChild(b);
    }
  }
  paintScore(e);
  $('score-next').textContent = nextProtocolIdx() === null ? 'Done: to the answers' : `Next run (${nextProtocolIdx() + 1} of 6)`;
  $('score-next').onclick = () => { el.style.display = 'none'; startNext(); };
  $('score-again').onclick = () => { el.style.display = 'none'; startRun({ kind: e.kind, idx: e.idx, preset: e.preset, cam: e.cam, rival: e.rival }); };
  $('score-panel').onclick = () => { el.style.display = 'none'; $('panel').classList.remove('hidden'); };
  el.style.display = 'block';
}
function paintScore(e) { document.querySelectorAll('#score [data-score]').forEach((b) => b.setAttribute('aria-pressed', String(e.scores[b.dataset.score] === +b.dataset.v))); }

// ---------- one frame ----------
const camState = { h: null, y: 0, fov: 62 };
function placeCamera(b, P, camKey, dt) {
  // the camera looks mostly along the hull and 40 % toward the direction of travel, so a slide shows without the boat going side-on
  const C = CAMS[camKey] || CAMS.A, k = P.length < 5 ? 0.72 : 1, hv = Math.abs(b.u) > 2 ? b.h + 0.4 * wrapA(Math.atan2(-b.vx, b.vz) - b.h) : b.h;
  if (camState.h === null) { camState.h = hv; camState.y = b.y; }
  camState.h = wrapA(camState.h + wrapA(hv - camState.h) * (1 - Math.exp(-dt / 0.18)));
  camState.y += (b.y - camState.y) * (1 - Math.exp(-dt / 0.5));             // steady camera height (R5b-feel-03)
  const fx = -Math.sin(camState.h), fz = Math.cos(camState.h), lh = camState.h + C.lead * clamp(b.r, -1.2, 1.2);
  camera.position.set(b.x - fx * C.back * k, camState.y + C.up * k, b.z - fz * C.back * k);
  look.set(b.x - Math.sin(lh) * C.look * k, camState.y + C.lookUp * k, b.z + Math.cos(lh) * C.look * k);
  camera.up.set(0, 1, 0); camera.lookAt(look);
  if (C.roll) camera.rotateZ(-C.roll * b.roll);
  const fov = C.fov0 + C.fovK * clamp(b.u / P.top, 0, 1.2);
  camState.fov += (fov - camState.fov) * (1 - Math.exp(-dt / 0.3));
  if (Math.abs(camera.fov - camState.fov) > 0.05) { camera.fov = camState.fov; camera.updateProjectionMatrix(); }
}
const fadeAt = (x, z) => 1 - smooth(90, 260, Math.hypot(x - camera.position.x, z - camera.position.z));
const rivalVis = { y: 0, pitch: 0, roll: 0 };
const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
function placeScene(run, dt, camKey) {
  const b = run.b, P = run.P, t = run.t, wv = run.waves;
  boats.player.position.set(b.x, b.y, b.z);   // b.y is the water under the hull + draft + planing lift, as S2's +0.22 boats.player.rotation.set(-b.pitch, -b.h, b.roll, 'YXZ');
  const R = run.rv, rOn = run.settings.rival !== 'off' && run.go < 1e8; boats.rival.visible = rOn;
  if (rOn) {   // the rival floats visually on the same waves (faded like the shader), its motion is kinematic
    const f = fadeAt(R.x, R.z), fx = -Math.sin(R.h), fz = Math.cos(R.h), rx = -Math.cos(R.h), rz = -Math.sin(R.h), L = P.length * 0.45, Bm = P.beam * 0.5;
    const h = (dx, dz) => W.heightAt(wv, R.x + dx, R.z + dz, t, 3) * f;
    const hb = h(fx * L, fz * L), hs = h(-fx * L, -fz * L), hp = h(-rx * Bm, -rz * Bm), hr = h(rx * Bm, rz * Bm);
    const k = 1 - Math.exp(-dt / 0.12);
    rivalVis.y += ((hb + hs + hp + hr) / 4 + P.lift * clamp(R.v / P.top, 0, 1) - rivalVis.y) * k;
    rivalVis.pitch += (Math.atan2(hb - hs, 2 * L) + P.trim * clamp(R.v / P.top, 0, 1) - rivalVis.pitch) * k;
    rivalVis.roll += (Math.atan2(hp - hr, 2 * Bm) - rivalVis.roll) * k;
    boats.rival.position.set(R.x, rivalVis.y + P.draft, R.z); boats.rival.rotation.set(-rivalVis.pitch, -R.h, rivalVis.roll, 'YXZ');
    const op = smooth(3, 8, Math.hypot(R.x - camera.position.x, R.z - camera.position.z));   // fades out at the camera
    boats.rival.traverse((o) => { if (o.material) { o.material.opacity = op; o.material.depthWrite = op > 0.95; } });
  }
  placeCamera(b, P, camKey, dt);
  sea.update(camera, t);
  wakeP.stern = P.length * 0.47; wakeR.stern = P.length * 0.47;
  wakeP.update(b, t); wakeP.mesh.visible = true;
  if (rOn) wakeR.update({ x: R.x, z: R.z, h: R.h, u: R.v }, t); wakeR.mesh.visible = rOn;
  const Q = QUALITY[S.settings.quality] || QUALITY.mid;
  sprayP.update({ ...b, u: b.u }, dt, camera, renderer, { rate: Q.spray, bow: P.length * 0.22, beam: P.beam * 0.45 });
  sprayR.update({ x: R.x, y: rivalVis.y, z: R.z, h: R.h, u: rOn ? R.v : 0, air: false }, dt, camera, renderer, { rate: Q.spray * 0.6, bow: P.length * 0.22, beam: P.beam * 0.45 });
  // buoys, markers, the next gate's arch, ramps: on the waves near the camera
  buoyPos.forEach((p, i) => { const y = W.heightAt(wv, p.x, p.z, t, 2) * fadeAt(p.x, p.z); mtx.compose(v3.set(p.x, y, p.z), q.identity(), one); gateBuoys.setMatrixAt(i, mtx); });
  const gs = run.m.gates;
  course.gates.forEach((g, i) => { const last = i < run.m.nextGate ? [...gs].reverse().find((x) => x.i === i && x.lap === run.m.lapGate + 1) : null;   // this lap only
    const c = last ? (last.ok ? GATE_COL.ok : GATE_COL.miss) : GATE_COL[g.kind]; gateBuoys.setColorAt(2 * i, c); gateBuoys.setColorAt(2 * i + 1, c); });
  gateBuoys.instanceMatrix.needsUpdate = true; if (gateBuoys.instanceColor) gateBuoys.instanceColor.needsUpdate = true;
  edgePos.forEach((p, i) => { const f = fadeAt(p.x, p.z), y = f > 0.01 ? W.heightAt(wv, p.x, p.z, t, 2) * f : 0; mtx.compose(v3.set(p.x, y + 0.15, p.z), q.identity(), one); edges.setMatrixAt(i, mtx); });
  edges.instanceMatrix.needsUpdate = true;
  const ng = course.gates[run.m.nextGate], ap = B.pointAt(course, ng.s, (ng.lo + ng.hi) / 2), w = (ng.hi - ng.lo) / 2;
  arch.position.set(ap.x, W.heightAt(wv, ap.x, ap.z, t, 2) * fadeAt(ap.x, ap.z), ap.z); arch.scale.set(w, w * 0.45, 1); arch.rotation.set(0, -ap.h, 0);
  arch.material.opacity = 0.55 + 0.35 * Math.sin(t * 6);
  rampMeshes.forEach((rm) => { if (rm.m.visible) rm.m.position.y = W.heightAt(wv, rm.p.x, rm.p.z, t, 2) * fadeAt(rm.p.x, rm.p.z) - 0.05; });
  placeYacht(wv, t, dt);
}
function draw() { sea.renderReflection(camera, look); renderer.setClearColor(0x000000, 1); renderer.render(scene, camera); }

let lastRaf = null, frameNo = 0, lastFrameT = null;
function loop(ts) {
  requestAnimationFrame(loop);
  const d = lastRaf === null ? null : ts - lastRaf; lastRaf = ts; frameNo++;
  const th = now(), dt = d === null ? 1 / 60 : clamp(d / 1000, 0, 0.1);
  const st = input.steer(th);
  if (S.calibrating) calibStep(th);
  const A = S.active;
  if (A) {
    if (A.skipFrame) A.skipFrame = false;   // the first frame back from a hidden page: its gap is the pause, not a drop
    else if (d !== null && d > 0) { const f = A.frames, missed = Math.max(0, Math.round(d / S.interval) - 1); f.n++; f.missed += missed; f.deltas.push(d); }
    A.acc += dt * S.timeScale;
    const run = A.run;
    while (A.acc >= B.DT && !run.done) {
      let s, br;
      if (A.replay) { const i = run.step; s = i < A.replay.steer.length ? A.replay.steer[i] / 100 : 0; br = i < A.replay.brake.length ? A.replay.brake[i] : 0; if (i >= A.replay.steer.length) { run.finish('recording ended'); break; } }
      else if (S.auto) { s = B.autopilot(run); br = B.autoBrake(run); }
      else { s = st.value; br = S.brake ? 1 : 0; }
      run.stepOnce(s, br); A.acc -= B.DT;
    }
    if (run.m.landings.length > A.landings) { A.landings = run.m.landings.length; sprayP.emit(run.b, 70, { up: 5.5, out: 4.5, bow: 0, beam: run.P.beam * 0.5 }); }
    placeScene(run, dt, A.cam);
    paintHud(run, st);
    if (frameNo % 30 === 0) beat();
    if (run.done) finishRun(run.why);
  } else {
    if (d !== null && d > 0 && d < 100) { S.idleDeltas.push(d); if (S.idleDeltas.length > 120) S.idleDeltas.shift(); if (frameNo % 60 === 0 && S.idleDeltas.length >= 60) S.interval = median(S.idleDeltas); }
    idle.stepOnce(0, 0); idle.stepOnce(0, 0);
    if (idle.in.steer.length > 6000) { idle.in.steer.length = 0; idle.in.brake.length = 0; }   // the idle boat keeps no log
    placeScene(idle, dt, S.settings.cam);
    if (S.started && frameNo % 6 === 0) paintInfo(st);
  }
  if (S.testBusyMs > 0) { const e = now() + S.testBusyMs; while (now() < e) { /* test hook: a planted slow frame */ } }
  draw();
  updateAudio();
  if (S.firstFrameMs === null) { S.firstFrameMs = rd(now(), 0); paintCard(); }
}

// ---------- HUD ----------
function paintHud(run, st) {
  const b = run.b, m = run.m, lapT = run.lapT, R = run.rv, passed = m.gates.filter((g) => g.ok).length, missed = m.gates.length - passed;
  let riv = '';
  if (run.settings.rival !== 'off') { const gap = (b.prog - R.prog) / Math.max(5, b.u); riv = gap >= 0 ? `you lead ${fmt(gap, 1)} s` : `rival +${fmt(-gap, 1)} s`; }
  const txt = `${mmss(lapT)}   gates ${passed}/${course.gates.length * run.settings.laps}${missed ? ` (${missed} missed)` : ''}   ${riv}   ${fmt(b.u * 3.6, 0)} km/h${S.brake ? '  BRAKE' : ''}${S.active.replay ? '  REPLAY' : ''}`;
  if (txt !== S.active.lastHud) { $('hud').textContent = txt; S.active.lastHud = txt; }
  const left = run.go - run.t, cd = $('count');
  const ct = left > 0 ? String(Math.ceil(left)) : left > -0.7 ? 'GO' : '';
  if (cd.textContent !== ct) cd.textContent = ct;
  $('knob').style.left = `${50 + 50 * clamp(st.value, -1, 1)}%`;
}
function paintDeadZone() { const o = input.o, w = (o.deadDeg / o.maxDeg) * 50; $('dead').style.left = `${50 - w}%`; $('dead').style.width = `${2 * w}%`; }
function paintInfo(st) {
  const I = input.info(), r = input.rates();
  $('info').style.display = 'block';
  $('info').textContent = `steer ${fmt(st.value, 2)} (${st.source}${st.deg !== null ? `, ${fmt(st.deg, 1)} deg` : ''}) | gyro: ${I.gyro} | ${fmt(r.mot, 0)}/${fmt(r.ori, 0)} events/s`;
}

// ---------- start, calibration, touch ----------
async function start() {
  if (S.starting) return;
  S.starting = true; $('start').disabled = true;
  const permP = TiltInput.requestPermission(window);   // inside the tap: one prompt grants both on iOS (S1)
  startAudio(); requestWake();
  let perm;
  try { perm = await permP; } catch (e) { perm = { motion: 'error', orientation: 'error' }; }
  S.perm = perm; input.attach(window); input.rec = input.rec || []; input.start(now());
  S.started = true; S.starting = false; $('start').disabled = false; collectAuto();
  if ([perm.motion, perm.orientation].includes('denied')) {
    input.source = 'touch';
    msg('Motion access was refused, so steering is by touch: hold the left or right half of the screen. For tilt: Settings, Apps, Safari, Motion and Orientation Access on, then reload and press Start.');
  } else { S.calibrating = { t0: now(), last: 0 }; msg('Hold the phone like a steering wheel, as you will play, and keep it still...'); }
  save(); paintCard();
}
function calibStep(th) {
  const C = S.calibrating;
  if (input.source === 'touch-auto' || input.source === 'touch') { S.calibrating = null; msg('No motion data came from this browser, so steering is by touch: hold the left or right half of the screen. Next: 2. Practice lap.'); return; }
  if (th - C.t0 < 900 || th - C.last < 250) return;
  C.last = th;
  const r = input.calibrate(th);
  if (r.ok) { S.calibrating = null; msg(`Straight ahead is set (the phone moved ${fmt(r.spread, 1)} deg while measuring; tilted back ${fmt(r.tiltBack, 0)} deg). Next: 2. Practice lap.`); paintCard(); return; }
  if (th - C.t0 > 12000) { S.calibrating = null; msg(`Could not get a still pose (${r.why}${r.spread ? ', ' + fmt(r.spread, 1) + ' deg' : ''}). Rest your elbows and press Calibrate again.`); paintCard(); return; }
  msg(`Keep still... (${r.why}${r.spread ? ': ' + fmt(r.spread, 1) + ' deg' : ''})`);
}
function recentre() {
  const A = S.active, r = input.recentre(now());
  if (A) A.recentres++;
  if (!r.ok) flash(`Recentre refused: moved ${fmt(r.spread, 1)} deg`);
}
function flash(t) { const w = $('warn'); w.textContent = t; w.style.display = 'block'; setTimeout(() => { w.style.display = 'none'; }, 1800); }
const pointers = new Map();
function touchUpdate() {
  let l = 0, r = 0; for (const x of pointers.values()) { if (x < innerWidth / 2) l++; else r++; }
  if (input.source === 'touch' || input.source === 'touch-auto') { input.setTouch((r ? 1 : 0) - (l ? 1 : 0)); S.brake = false; }
  else S.brake = pointers.size > 0;
}
canvas.addEventListener('pointerdown', (e) => { pointers.set(e.pointerId, e.clientX); touchUpdate(); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, (e) => { pointers.delete(e.pointerId); touchUpdate(); });

// ---------- sound: a synthesized engine and water rush (nothing downloaded) ----------
function startAudio() {
  try {
    if (navigator.audioSession && S.settings.sound === 'on') { navigator.audioSession.type = 'playback'; S.audio.session = 'playback'; }   // plays with the silent switch on (R7-audio-02)
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { S.audio.state = 'no Web Audio'; return; }
    const ctx = S.audio.ctx || new AC(); S.audio.ctx = ctx; ctx.resume();
    if (!S.audio.master) {
      const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; lp.connect(master);
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 50; o1.connect(lp); o1.start();
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 101; const g2 = ctx.createGain(); g2.gain.value = 0.35; o2.connect(g2); g2.connect(lp); o2.start();
      const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), ch = nb.getChannelData(0); let s = 7; for (let i = 0; i < ch.length; i++) { s = (1664525 * s + 1013904223) >>> 0; ch[i] = s / 2147483648 - 1; }
      const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
      const ng = ctx.createGain(); ng.gain.value = 0; ns.connect(bp); bp.connect(ng); ng.connect(ctx.destination); ns.start();
      Object.assign(S.audio, { master, lp, o1, o2, ng });
    }
    S.audio.state = ctx.state;
  } catch (e) { S.audio.state = 'error: ' + (e && e.name); }
}
let audioActive = false;
function audioOn(on) { audioActive = on; }
function updateAudio() {
  const Au = S.audio; if (!Au.ctx || !Au.master) return;
  Au.state = Au.ctx.state;
  const run = S.active ? S.active.run : null, u = run ? Math.max(0, run.b.u) / run.P.top : 0, on = audioActive && S.settings.sound === 'on' && run && run.t > 0.2;
  const t = Au.ctx.currentTime, air = run && run.b.air ? 1.25 : 1;
  Au.o1.frequency.setTargetAtTime((45 + 120 * u) * air, t, 0.05); Au.o2.frequency.setTargetAtTime((90 + 240 * u) * air * 1.01, t, 0.05);
  Au.lp.frequency.setTargetAtTime(350 + 1800 * u, t, 0.08);
  Au.master.gain.setTargetAtTime(on ? 0.06 + 0.1 * u : 0, t, 0.08);
  Au.ng.gain.setTargetAtTime(on && !(run && run.b.air) ? 0.12 * u : 0, t, 0.1);
}
function testTone() {
  startAudio(); const Au = S.audio; if (!Au.ctx) { msg('No sound engine in this browser.'); return; }
  const ctx = Au.ctx, o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 660; g.gain.value = 0.2; o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.4); Au.tones++; msg(`Played a short tone (sound engine ${ctx.state}, audio session ${S.audio.session}). Did you hear it? Answer under 4.`); save(); paintCard();
}

// ---------- wake lock, context loss, reloads, saving ----------
async function requestWake() {
  if (!S.wake.supported || S.wake.sentinel) return;
  try { S.wake.sentinel = await navigator.wakeLock.request('screen'); S.wake.state = 'active'; S.wake.sentinel.addEventListener('release', () => { S.wake.releases++; S.wake.sentinel = null; S.wake.state = 'released'; }); }
  catch (e) { S.wake.state = 'refused: ' + (e && e.name); }
}
// v0.2: leaving the page during a run (a notification, the app switcher) pauses the run (no frames come while hidden and dt is capped),
// is counted on the card, and does not count as dropped frames or sensor gaps; the engine sound is resumed on the way back.
document.addEventListener('visibilitychange', () => {
  const A = S.active, vis = document.visibilityState === 'visible';
  if (!vis) { if (A) { A.hides = (A.hides || 0) + 1; A.hiddenAt = now(); } return; }
  if (A && A.hiddenAt !== null && A.hiddenAt !== undefined) { A.hiddenMs = (A.hiddenMs || 0) + (now() - A.hiddenAt); A.hiddenAt = null; A.skipFrame = true; }
  if (S.started) requestWake();
  const ctx = S.audio.ctx;
  if (ctx && ctx.state !== 'running') { S.audio.resumes = (S.audio.resumes || 0) + 1; try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not resumable */ } }
});
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); S.lost.push({ at: new Date().toISOString(), during: S.active ? S.active.kind : 'idle' }); if (S.active) finishRun('lost graphics'); msg('The phone took the graphics away (context lost). It is on the card. Reload the page to go on.'); save(); });
canvas.addEventListener('webglcontextrestored', () => { S.restoredCtx++; save(); });
function beat() { try { localStorage.setItem(ACTIVE, JSON.stringify({ kind: S.active.kind, startedAt: S.active.startedAt, t0: Date.now() - (now() - S.active.th0), beat: Date.now() })); } catch (e) { /* storage blocked */ } }
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ savedAt: new Date().toISOString(), version: VERSION, runs: S.runs, replays: S.replays, lost: S.lost, restoredCtx: S.restoredCtx, reloads: S.reloads,
    answers: S.answers, typed: S.typed, settings: S.settings, tilt: S.tilt, tune: S.tune, cals: input.cals, audio: { tones: S.audio.tones } })); }
  catch (e) { /* private browsing or storage full: the page works without it */ }
}
function restore() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE) || 'null');
    if (a && a.kind) S.reloads.push({ during: a.kind, startedAt: a.startedAt, ranS: rd((a.beat - a.t0) / 1000, 0), noticedAt: new Date().toISOString() });
    localStorage.removeItem(ACTIVE);
    const d = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (d && d.savedAt && Date.now() - Date.parse(d.savedAt) < 6 * 3600e3) {
      S.restored = d.savedAt; S.runs = d.runs || []; S.replays = d.replays || []; S.lost = d.lost || []; S.restoredCtx = d.restoredCtx || 0;
      S.reloads = [...(d.reloads || []), ...S.reloads]; Object.assign(S.answers, d.answers || {}); Object.assign(S.typed, d.typed || {});
      if (d.settings) Object.assign(S.settings, d.settings); if (d.tilt) Object.assign(S.tilt, d.tilt); if (d.tune) S.tune = { offshore: {}, jet: {}, ...d.tune };
      if (d.cals) input.cals = d.cals; if (d.audio) S.audio.tones = d.audio.tones || 0;
    }
  } catch (e) { /* unreadable: start fresh */ }
}

// ---------- conditions, card, recording ----------
function shortUA() { const u = navigator.userAgent; const m = u.match(/(iPhone OS [\d_]+|Android [\d.]+|Windows NT [\d.]+|Mac OS X [\d_]+)/); const b = u.match(/(CriOS|FxiOS|EdgiOS|Chrome|Version|Firefox)\/([\d.]+)/); return `${m ? m[1].replace(/_/g, '.') : '?'} ${b ? b[1] + ' ' + b[2] : ''}`.trim(); }
function collectAuto() {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  Object.assign(S.auto_, { ua: shortUA(), gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), dpr: window.devicePixelRatio, screen: `${screen.width}x${screen.height}`, three: THREE.REVISION });
}
const tmpV2 = new THREE.Vector2();
function renderSize() { const v = renderer.getDrawingBufferSize(tmpV2); return `${v.x}x${v.y}`; }
function runLine(r) {
  const s = r.summary, f = r.frames, h = s.hist.map((v) => Math.round(v)).join(' ');
  const gap = s.rivalGapS === null ? 'no rival' : `rival gap ${s.rivalGapS > 0 ? '+' : ''}${fmt(s.rivalGapS, 1)} s`;
  return `Run ${r.n} ${runLabel(r)} ${B.PRESETS[r.preset].label} cam ${r.cam} (rival ${r.rival}, ${r.source}${r.signal ? ' ' + r.signal : ''}${r.auto ? ', AUTOPILOT' : ''}${r.timeScale !== 1 ? `, time x${r.timeScale}` : ''}${r.why !== 'finished' ? ', ' + r.why.toUpperCase() : ''}): `
    + `lap ${fmt(s.lapS, 2)} s${s.missed ? ` (+${2 * s.missed} = ${fmt(s.penaltyS, 2)})` : ''}, gates ${s.passed}/${s.gates}, off course ${fmt(s.offCourseS, 1)} s, contacts ${s.contacts}, air ${fmt(s.airS, 1)} s (${s.landings} landings, ${s.cleanLandings} clean), top ${fmt(s.topKmh, 0)}, mean ${fmt(s.meanKmh, 0)} km/h, ${gap}`
    + ` | steer % left..right ${h}, at full lock ${fmt(s.saturationPct, 1)} %, mean ${fmt(s.meanAbsSteer, 2)}, corrections ${s.corrections} (${fmt(s.correctionsPerCorner, 2)} per corner, ${fmt(s.correctionsPerMin, 0)}/min), steer rate rms ${fmt(s.steerRateRms, 2)}/s`
    + ` | frames drops ${fmt(f.dropsPct, 1)} %, median ${fmt(f.medianMs, 1)} ms, worst ${fmt(f.worstMs, 0)} ms | sensors ${fmt(r.sensor.motPerS, 0)}/${fmt(r.sensor.oriPerS, 0)} per s | recentres ${r.recentres}${r.hidden && r.hidden.times ? ` | page hidden ${r.hidden.times}x, ${fmt(r.hidden.s, 1)} s` : ''} | fun ${r.scores.fun ?? '?'}, comfort ${r.scores.comfort ?? '?'}`;
}
function cardText() {
  const A = S.answers, T = S.typed, C = S.auto_, L = [], I = input.info(), o = input.o, sets = S.settings;
  L.push(`S3 feel lab ${VERSION} | device clock ${new Date().toISOString()} | ${location.host}${S.restored ? ' | includes results restored after a reload' : ''}`);
  L.push(`Phone: ${T.model || '?'} | OS/browser: ${C.ua || shortUA()} (may be frozen) | GPU: ${C.gpu || '?'} | DPR ${C.dpr ?? window.devicePixelRatio} | screen ${C.screen || '?'} | render ${renderSize()} (${sets.scale === 1 ? 'full' : sets.scale * 100 + ' %'}) | water ${sets.quality}, sea ${sets.sea} | refresh seen ${fmt(1000 / S.interval, 1)} Hz`);
  L.push(`Battery start ${T.batteryStart || '?'} %, end ${T.batteryEnd || '?'} % | charging ${A.charging || '?'} | Low Power ${A.lpm || '?'} | brightness ${A.brightness || '?'} | silent switch ${A.silent || '?'} | wake lock ${S.wake.state} (released ${S.wake.releases}x) | sound ${sets.sound}, engine ${S.audio.state}, audio session ${S.audio.session}, test tones ${S.audio.tones}, sound resumed after a hidden page ${S.audio.resumes || 0}x`);
  const cOk = input.cals.filter((c) => c.ok), cl = cOk[cOk.length - 1];
  L.push(`Steering: ${I.source}, signal ${o.signal} (in use ${I.inUse || '-'}), gyro ${I.gyro} | One Euro min ${o.euroMin} Hz, gain ${o.euroBeta} | dead ${o.deadDeg} deg, full lock ${o.maxDeg} deg, curve ${o.expo}, invert ${o.invert ? 'yes' : 'no'} | calibrations ${cOk.length} ok${cl ? ` (last: moved ${fmt(cl.spread, 2)} deg, tilted back ${fmt(cl.tiltBack, 0)} deg)` : ''}, ${input.cals.length - cOk.length} refused | interval ${I.interval || '?'} | permission ${S.perm ? `${S.perm.motion}/${S.perm.orientation}` : 'not asked'}`);
  const tuned = Object.entries(S.tune).filter(([, v]) => Object.keys(v).length).map(([k, v]) => `${k} ${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(' ')}`).join('; ');
  L.push(`Boats: Offshore top ${B.PRESETS.offshore.top} m/s, turn ${B.PRESETS.offshore.turnRate} deg/s; Jet top ${B.PRESETS.jet.top} m/s, turn ${B.PRESETS.jet.turnRate} deg/s, ramps | rival skill ${sets.skill} | tuning changed: ${tuned || 'none'}`);
  L.push(`Moored yacht: ${yacht.state}${yacht.state === 'loaded' ? ` in ${yacht.ms} ms${yacht.bytes ? `, ${(yacht.bytes / 1048576).toFixed(2)} MB` : ''}, ${yacht.tris} triangles, in view on ${yacht.seen} frames` : yacht.err ? ` (${yacht.err})` : ''} | looks right: ${A.yachtLook || '?'}`);
  if (!S.runs.length) L.push('Runs: none yet');
  S.runs.forEach((r) => L.push(runLine(r)));
  const done = PROTOCOL.filter((_, i) => S.runs.some((r) => r.kind === 'protocol' && r.idx === i && r.why === 'finished')).length;
  S.replays.forEach((r) => L.push(`Replay ${r.n} of run ${r.replayOf ?? '?'}: ${r.check ? `lap ${fmt(r.check.lapS[0], 3)} -> ${fmt(r.check.lapS[1], 3)} s, end ${r.check.sameEnd ? 'identical' : 'differs by ' + r.check.dEndM + ' m'}` : fmt(r.summary.lapS, 3) + ' s'}`));
  L.push(`Lost graphics context: ${S.lost.length}${S.lost.length ? ' (' + S.lost.map((l) => `${l.during} ${l.at.slice(11, 19)}Z`).join(', ') + ')' : ''} | page restarted during a run: ${S.reloads.length}${S.reloads.length ? ' (' + S.reloads.map((r) => `${r.during} after ${r.ranS} s`).join(', ') + ')' : ''}`);
  L.push(`Protocol ${done} of 6 | Answers: better boat ${A.bestBoat || '?'}, camera ${A.bestCam || '?'}, steering ${A.steering || '?'}, rival ${A.rival || '?'}, felt sick ${A.sick || '?'}, heard the engine ${A.heard || '?'} (sound out of ${A.output || '?'}) | notes: ${T.notes || '-'}`);
  return L.join('\n').replace(/[^\x20-\x7e\n]/g, '?');
}
function recordingObject(full = false) {
  const runs = S.runs.map((r) => ({ n: r.n, kind: r.kind, idx: r.idx, preset: r.preset, cam: r.cam, settings: r.settings, inputs: r.inputs, end: r.summary.end, lapS: r.summary.lapS, steps: r.summary.steps, tilt: r.tilt }));
  const o = { kind: 's3-recording', version: VERSION, deviceClock: new Date().toISOString(), dt: B.DT, runs };
  if (full) Object.assign(o, { auto: S.auto_, typed: S.typed, answers: S.answers, settings: S.settings, tune: S.tune, perm: S.perm, cals: input.cals, info: input.info(), runsFull: S.runs, replays: S.replays, lost: S.lost, reloads: S.reloads, sensorEvents: input.rec || [] });
  return o;
}
function replayFrom(rec, n) {
  const r = (rec.runs || []).find((x) => x.n === n) || (rec.runs || [])[0];
  if (!r) { msg('No run found in that recording.'); return false; }
  const d = B.decodeInputs(r.inputs);
  const ok = startRun({ kind: 'replay', settings: r.settings, cam: r.cam || 'A', replay: d, replayOf: r.n });
  if (ok) S.active.replaySource = { lapS: r.lapS, end: r.end };
  return ok;
}
function verifyReplay(n = S.runs.length, flipAt = null) {   // synchronous: the recorded inputs through a fresh simulation
  const r = S.runs.find((x) => x.n === n); if (!r) return null;
  const d = B.decodeInputs(r.inputs); if (flipAt !== null && d.steer.length > flipAt) d.steer[flipAt] = d.steer[flipAt] > 0 ? -100 : 100;
  const sm = B.replay(r.settings, d.steer, d.brake, course).summary();
  return { lapS: [r.summary.lapS, sm.lapS], end: [r.summary.end, sm.end], same: JSON.stringify(r.summary.end) === JSON.stringify(sm.end) && r.summary.lapS === sm.lapS };
}

// ---------- UI ----------
function msg(t) { $('msg').textContent = t; }
function paintCard() { $('card').textContent = cardText(); }
function paintRuns() {
  const box = $('runs'); box.innerHTML = '';
  PROTOCOL.forEach((p, i) => {
    const done = S.runs.filter((r) => r.kind === 'protocol' && r.idx === i), last = done[done.length - 1], li = document.createElement('li');
    li.textContent = `${i + 1}. ${B.PRESETS[p.preset].label}, camera ${p.cam}: ${last ? `${last.why === 'finished' ? mmss(last.summary.lapS) : last.why}, fun ${last.scores.fun ?? '?'}, comfort ${last.scores.comfort ?? '?'}` : 'not run'}`;
    box.appendChild(li);
  });
  const ni = nextProtocolIdx(); $('next').textContent = ni === null ? '3. All six done (run one again from the list)' : `3. Next run (${ni + 1} of 6: ${B.PRESETS[PROTOCOL[ni].preset].label}, camera ${PROTOCOL[ni].cam})`;
}
function applyTilt() { input.setOptions({ ...S.tilt, signal: S.settings.signal, invert: S.settings.invert === 'yes' }); paintDeadZone(); }
function applySettings() {
  sea.setQuality(QUALITY[S.settings.quality] || QUALITY.mid); sizeAll(); applyTilt();
  document.querySelectorAll('[data-set]').forEach((b) => b.setAttribute('aria-pressed', String(String(S.settings[b.dataset.set]) === b.dataset.v)));
  paintSliders();
  if (!S.active) makeIdle();
}
function paintSliders() {
  const box = $('sliders');
  if (!box.childElementCount) TUNE.forEach(([k, label, lo, hi, step, where]) => {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label><span></span></label><input type="range" min="${lo}" max="${hi}" step="${step}" data-tune="${k}" data-where="${where}">`;
    row.querySelector('input').oninput = (e) => {
      const v = +e.target.value;
      if (where === 'tilt') S.tilt[k] = v; else S.tune[S.settings.preset][k] = v;
      applyTilt(); paintSliders(); save(); paintCard();
    };
    box.appendChild(row);
  });
  box.querySelectorAll('input[data-tune]').forEach((el) => {
    const k = el.dataset.tune, where = el.dataset.where, P = B.PRESETS[S.settings.preset];
    const v = where === 'tilt' ? S.tilt[k] : (S.tune[S.settings.preset][k] ?? P[k]);
    el.value = v; el.previousElementSibling.querySelector('span').textContent = `${TUNE.find((t) => t[0] === k)[1]}: ${v}${where === 'boat' ? ` (${B.PRESETS[S.settings.preset].label})` : ''}`;
  });
}
function sizeAll() {
  const w = window.innerWidth, h = window.innerHeight, pr = Math.min(window.devicePixelRatio || 1, 3) * (+S.settings.scale || 1);
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', sizeAll);
function wire() {
  document.querySelectorAll('button[data-a]').forEach((b) => {
    b.onclick = () => { const k = b.dataset.a, v = b.dataset.v; if (S.answers[k] === v) delete S.answers[k]; else S.answers[k] = v; paintAnswers(); save(); paintCard(); };
  });
  document.querySelectorAll('[data-t]').forEach((el) => { el.value = S.typed[el.dataset.t] || ''; el.oninput = () => { S.typed[el.dataset.t] = el.value.trim(); save(); paintCard(); }; });
  document.querySelectorAll('[data-set]').forEach((b) => {
    b.onclick = () => { if (S.active) return; const k = b.dataset.set, v = b.dataset.v; S.settings[k] = k === 'scale' ? +v : v; if (k === 'sound' && v === 'on') startAudio(); applySettings(); save(); paintCard(); };
  });
  $('start').onclick = () => start();
  $('cal').onclick = () => { if (!S.started) return msg('Press 1. Start first.'); S.calibrating = { t0: now() - 400, last: 0 }; msg('Hold the phone like a steering wheel and keep it still...'); };
  $('tone').onclick = () => testTone();
  $('practice').onclick = () => startRun({ kind: 'practice', preset: 'offshore', cam: 'A', rival: 'off' });
  $('next').onclick = () => { const i = nextProtocolIdx(); if (i === null) return msg('All six runs are done; use Run this again on the score screen or a free run.'); startNext(); };
  $('free').onclick = () => startRun({ kind: 'free', preset: S.settings.preset, cam: S.settings.cam, rival: S.settings.rival });
  $('resettune').onclick = () => { S.tilt = { ...TILT_DEFAULTS }; S.tune = { offshore: {}, jet: {} }; applySettings(); save(); paintCard(); };
  $('stop').onclick = () => stopRun();
  $('recentre').onclick = () => recentre();
  $('show').onclick = () => { $('panel').classList.remove('hidden'); $('show').style.display = 'none'; };
  $('copy').onclick = async () => { paintCard(); try { await navigator.clipboard.writeText(cardText()); msg('Card copied: paste it in the chat.'); } catch (e) { msg('Copy failed: select the card text and copy it by hand.'); } };
  $('copyrec').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(recordingObject())); msg(`Recording of ${S.runs.length} runs copied: paste it in the chat after the card.`); } catch (e) { msg('Copy failed: use Download the details instead.'); } };
  $('dl').onclick = () => { const blob = new Blob([JSON.stringify(recordingObject(true))], { type: 'application/json' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 's3-details-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); };
  $('replay').onclick = () => { const r = S.runs[S.runs.length - 1]; if (!r) return msg('No run to play back yet.'); replayFrom(recordingObject(), r.n); };
  $('replaypaste').onclick = () => { let rec; try { rec = JSON.parse($('paste').value); } catch (e) { return msg('That is not a recording (it must start with {"kind":"s3-recording").'); } replayFrom(rec, +$('pasten').value || 1); };
  $('reset').onclick = () => { if (!confirm('Clear every saved result of this test on this phone?')) return; try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ } location.reload(); };
  $('ver').textContent = `${VERSION}, three.js r${THREE.REVISION}, course ${fmt(course.len, 0)} m, ${course.gates.length} gates, ${course.corners.length} corners`;
  paintAnswers();
}
function paintAnswers() { document.querySelectorAll('button[data-a]').forEach((b) => b.setAttribute('aria-pressed', String(S.answers[b.dataset.a] === b.dataset.v))); }

// ---------- boot ----------
restore(); collectAuto(); wire(); applySettings(); paintRuns(); paintCard();
if (S.reloads.length && !S.restored) msg('The page restarted during a run; that is on the card.');
else if (S.reloads.length) msg(`The page restarted during a run (${S.reloads[S.reloads.length - 1].during}); that is on the card. Press 1. Start to go on.`);
requestAnimationFrame(loop);
window.__ready = true;

// ---------- test hooks (the smoke test drives the page through these) ----------
window.__s3 = { version: VERSION, S, input, course, start, startRun, stopRun, startNext, finishRun, verifyReplay, replayFrom, recordingObject, cardText,
  setAuto: (on) => { S.auto = !!on; }, setTimeScale: (x) => { S.timeScale = x; }, setBrake: (on) => { S.brake = !!on; },
  run: () => (S.active ? S.active.run : null), idle: () => idle, camera: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z, fov: camera.fov, up: camera.up.toArray() }),
  boatMesh: () => ({ y: boats.player.position.y, rot: boats.player.rotation.toArray().slice(0, 3) }), probe: (pts, t) => sea.probe(pts, t),
  waves: () => (S.active ? S.active.run.waves : idle.waves), renderSize, calibrate: () => input.calibrate(now()), recentre, testTone,
  yacht: () => ({ state: yacht.state, ms: yacht.ms, bytes: yacht.bytes, tris: yacht.tris, err: yacht.err, seen: yacht.seen, at: yachtAt,
    y: yacht.obj ? yacht.obj.position.y : null, inScene: !!(yacht.obj && yacht.obj.parent === scene),
    box: yacht.obj ? (() => { const b = new THREE.Box3().setFromObject(yacht.obj); return { keel: b.min.y - yacht.obj.position.y, top: b.max.y - yacht.obj.position.y, len: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) }; })() : null }) };
