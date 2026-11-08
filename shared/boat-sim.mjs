// boat-sim.mjs: the S3 feel lab's boat, course, rival and lap scoring. Pure (no DOM, no three.js) with a fixed time step, so the
// same inputs give the same run: a recorded run replays exactly on the same browser (other engines may differ in the last bits of
// Math.sin and friends; the replay reports the difference). Written 2026-11-08. Tests: tests/boat-sim.test.mjs.
// World: metres; x and z on the water, y up (three.js axes). Heading h in radians: forward f = (-sin h, cos h), right r = (-cos h,
// -sin h), because the view from behind a boat facing +z has screen right at -x. Positive steer, positive h and positive lateral
// offsets all mean right. The boat floats on shared/waves.mjs, the same function the water shader draws.
import * as W from './waves.mjs';

export const DT = 1 / 120;                     // physics step, s
export const COUNTDOWN_S = 3;
const AIR = 0.3;                               // m above the water before the hull counts as airborne
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// One handling preset per shortlisted hull class (R6 D1 offshore circuit racer, D2 jet and stunt racer). Tuned by eye (R5b-feel-05,
// -06: resistance forces tuned by eye); every value is in the tuning panel. turnRate is the yaw rate cap in deg/s, reached from
// turnRef m/s; yawTau the yaw response time; grip the decay rate of sideways speed (1/s); carve the share of lost sideways speed
// turned into forward speed; surf how much wave slopes push; gMul the extra gravity once the hull leaves the water (arcade weight).
export const PRESETS = {
  offshore: { label: 'Offshore', top: 28, accel: 7.5, brake: 9, turnRate: 46, turnRef: 12, yawTau: 0.32, grip: 3.2, gripBrake: 1.2,
    carve: 0.45, brakeTurn: 1.25, surf: 0.35, bankK: 0.5, length: 7.2, beam: 2.5, radius: 2.7, draft: 0.22, lift: 0.18, trim: 0.06,
    heaveK: 140, heaveZeta: 0.9, pitchK: 35, rollK: 30, gMul: 1.5, slamLoss: 0.025, jumpBoost: 0, ramps: false },
  jet: { label: 'Jet', top: 24, accel: 9.5, brake: 10, turnRate: 72, turnRef: 9, yawTau: 0.14, grip: 2.2, gripBrake: 0.8,
    carve: 0.6, brakeTurn: 1.35, surf: 0.45, bankK: 0.8, length: 3.2, beam: 1.2, radius: 1.7, draft: 0.18, lift: 0.12, trim: 0.09,
    heaveK: 160, heaveZeta: 0.8, pitchK: 45, rollK: 45, gMul: 1.3, slamLoss: 0.015, jumpBoost: 4, ramps: true },
};
export const PRESET_KEYS = Object.keys(PRESETS);

// ---------- the course: a closed centripetal Catmull-Rom loop resampled every metre ----------
const CONTROL = [[0, -60], [0, 160], [-30, 240], [-110, 270], [-190, 230], [-200, 150], [-150, 90], [-170, 20], [-260, -30],
  [-270, -130], [-200, -190], [-100, -190], [-30, -140]].map(([x, z]) => [x * 0.85, z * 0.85]);

function catmull(p0, p1, p2, p3, n, out) {
  const tj = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-6;
  const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
  for (let k = 0; k < n; k++) {
    const t = t1 + ((t2 - t1) * k) / n;
    const L = (a, b, ta, tb) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
    out.push(L(L(A1, A2, t0, t2), L(A2, A3, t1, t3), t1, t2));
  }
}

export function makeCourse({ halfWidth = 28, gateWidth = 20, slalom = { from: 50, count: 4, spacing: 45, offset: 6, width: 10 },
  ramps = [{ s: 915, len: 9, height: 1.8, halfW: 2.8 }, { s: 1075, len: 9, height: 1.8, halfW: 2.8 }] } = {}) {
  const raw = [], n = CONTROL.length;
  for (let i = 0; i < n; i++) catmull(CONTROL[(i - 1 + n) % n], CONTROL[i], CONTROL[(i + 1) % n], CONTROL[(i + 2) % n], 200, raw);
  // s = 0 (the start line) is the first control point, at the start of the long straight
  let len = 0; const cum = [0];
  for (let i = 1; i <= raw.length; i++) { const a = raw[i - 1], b = raw[i % raw.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); cum.push(len); }
  const N = Math.round(len), step = len / N, X = new Float64Array(N), Z = new Float64Array(N);
  const s0 = 0; let j = 0;
  for (let k = 0; k < N; k++) {
    const s = (k * step + s0) % len;
    if (k === 0 || cum[j] > s) j = 0;
    while (cum[j + 1] < s) j++;
    const f = (s - cum[j]) / (cum[j + 1] - cum[j]), a = raw[j], b = raw[(j + 1) % raw.length];
    X[k] = a[0] + (b[0] - a[0]) * f; Z[k] = a[1] + (b[1] - a[1]) * f;
  }
  const H = new Float64Array(N), K = new Float64Array(N);
  for (let i = 0; i < N; i++) { const a = (i - 1 + N) % N, b = (i + 1) % N; H[i] = Math.atan2(-(X[b] - X[a]), Z[b] - Z[a]); }
  for (let i = 0; i < N; i++) K[i] = wrapA(H[(i + 3) % N] - H[(i - 3 + N) % N]) / (6 * step);   // curvature, + = right turn
  const c = { N, step, len, X, Z, H, K, halfWidth };
  // corners: stretches tighter than 110 m radius (a correction inside one counts as a correction in a turn)
  c.corners = []; let cur = null;
  for (let i = 0; i < N; i++) {
    const on = Math.abs(K[i]) > 1 / 110;
    if (on && !cur) cur = { a: i * step, minR: Infinity, dir: K[i] > 0 ? 'right' : 'left' };
    if (cur) cur.minR = Math.min(cur.minR, 1 / Math.max(1e-9, Math.abs(K[i])));
    if (!on && cur) { cur.b = i * step; c.corners.push(cur); cur = null; }
  }
  if (cur) { cur.b = len; c.corners.push(cur); }
  // gates: the slalom on the start straight (narrow, alternating), then one wide gate at the tightest point of each corner
  c.gates = [];
  for (let k = 0; k < slalom.count; k++) {
    const o = k % 2 === 0 ? -slalom.offset : slalom.offset;
    // the racing line passes 2 m inside the gate's inner buoy, as a driver cuts it, not through the gate's centre
    c.gates.push({ s: slalom.from + k * slalom.spacing, lo: o - slalom.width / 2, hi: o + slalom.width / 2, kind: 'slalom', line: Math.sign(o) * (Math.abs(o) - slalom.width / 2 + 2) });
  }
  for (const z of c.corners) {
    let best = z.a, kmax = 0;
    for (let s = z.a; s < z.b; s += step) { const v = Math.abs(K[Math.floor(s / step) % N]); if (v > kmax) { kmax = v; best = s; } }
    c.gates.push({ s: Math.round(best), lo: -gateWidth / 2, hi: gateWidth / 2, kind: 'corner', line: 0 });
  }
  c.gates.sort((a, b) => a.s - b.s);
  c.ramps = ramps.map((r) => ({ ...r }));
  // the racing line: the centre line shifted through each gate's line point (cosine blend between neighbouring gates)
  c.lineOff = new Float64Array(N);
  const gs = c.gates.map((g) => ({ s: g.s, o: g.line }));
  for (let i = 0; i < N; i++) {
    const s = i * step; let a = gs[gs.length - 1], b = gs[0];
    for (let k = 0; k < gs.length; k++) if (gs[k].s > s) { b = gs[k]; a = gs[(k - 1 + gs.length) % gs.length]; break; }
    let span = b.s - a.s; if (span <= 0) span += len; let d = s - a.s; if (d < 0) d += len;
    const f = clamp(d / span, 0, 1), w = 0.5 - 0.5 * Math.cos(Math.PI * f);
    c.lineOff[i] = a.o + (b.o - a.o) * w;
  }
  return c;
}

export function at(c, s) {   // centre line point, heading and curvature at arc length s (wrapped), linear between samples
  const u = ((((s / c.step) % c.N) + c.N) % c.N), i = Math.floor(u) % c.N, k = (i + 1) % c.N, f = u - Math.floor(u);
  return { x: c.X[i] + (c.X[k] - c.X[i]) * f, z: c.Z[i] + (c.Z[k] - c.Z[i]) * f, h: c.H[i] + wrapA(c.H[k] - c.H[i]) * f,
    k: c.K[i] + (c.K[k] - c.K[i]) * f, off: c.lineOff[i] + (c.lineOff[k] - c.lineOff[i]) * f };
}
export function pointAt(c, s, lat) { const p = at(c, s); return { x: p.x - Math.cos(p.h) * lat, z: p.z - Math.sin(p.h) * lat, h: p.h }; }
// nearest centre-line sample near a hint index (a window, so a boat never jumps to another part of the loop)
export function project(c, x, z, hintS = null, win = 60) {
  let bi = 0, bd = Infinity;
  if (hintS === null) { for (let i = 0; i < c.N; i++) { const d = (c.X[i] - x) ** 2 + (c.Z[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } } }
  else {
    const h = Math.round(hintS / c.step), w = Math.round(win / c.step);
    for (let o = -w; o <= w; o++) { const i = (((h + o) % c.N) + c.N) % c.N, d = (c.X[i] - x) ** 2 + (c.Z[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
  }
  // refine along the local tangent
  const h = c.H[bi], fx = -Math.sin(h), fz = Math.cos(h), dx = x - c.X[bi], dz = z - c.Z[bi];
  const along = clamp(dx * fx + dz * fz, -c.step, c.step), s = (((bi * c.step + along) % c.len) + c.len) % c.len;
  const p = at(c, s), lat = (x - p.x) * -Math.cos(p.h) + (z - p.z) * -Math.sin(p.h);
  return { s, lat };
}
const wrapS = (c, d) => { if (d > c.len / 2) d -= c.len; if (d < -c.len / 2) d += c.len; return d; };

// ---------- the rival: kinematic along the racing line with a speed profile from the curvature ----------
export function rivalProfile(c, P, skill) {
  const N = c.N, R = new Float64Array(N), stretch = new Float64Array(N), vmax = new Float64Array(N);
  const pts = []; for (let i = 0; i < N; i++) pts.push(pointAt(c, i * c.step, c.lineOff[i]));
  const hd = pts.map((p, i) => { const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N]; stretch[i] = Math.hypot(b.x - a.x, b.z - a.z) / (2 * c.step); return Math.atan2(-(b.x - a.x), b.z - a.z); });
  for (let i = 0; i < N; i++) { const k = Math.abs(wrapA(hd[(i + 5) % N] - hd[(i - 5 + N) % N])) / (10 * c.step * stretch[i]); R[i] = 1 / Math.max(1e-6, k); }
  const vTop = P.top * skill, wr = P.turnRate * DEG * 0.92 * skill;
  for (let i = 0; i < N; i++) vmax[i] = Math.min(vTop, Math.max(6, R[i] * wr));
  const acc = (v) => Math.max(0.2, P.accel * (1 - (v / P.top) ** 2)), dec = 8;
  const v = Float64Array.from(vmax);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < N; i++) { const k = (i + 1) % N; v[k] = Math.min(v[k], Math.sqrt(v[i] ** 2 + 2 * acc(v[i]) * c.step * stretch[i])); }
    for (let i = N - 1; i >= 0; i--) { const k = (i + 1) % N; v[i] = Math.min(v[i], Math.sqrt(v[k] ** 2 + 2 * dec * c.step * stretch[i])); }
  }
  return { v, stretch, R };
}

// ---------- one run: countdown, laps, the player's boat, the rival, scoring ----------
export function defaultSettings(presetKey = 'offshore') {
  return { preset: presetKey, P: { ...PRESETS[presetKey] }, laps: 1, rival: 'fair', skill: 0.9, band: 0.04, ramps: PRESETS[presetKey].ramps,
    waves: { count: 5, seed: 7, amp: 0.4 } };
}

export class Run {
  constructor(settings, course = null) {
    this.settings = JSON.parse(JSON.stringify(settings));
    this.P = this.settings.P;
    this.c = course || makeCourse();
    const sea = this.settings.waves;   // amp 0 = a flat sea (makeWaves would divide 0 by 0 for the steepness)
    this.waves = sea.amp > 0 ? W.makeWaves({ count: sea.count, seed: sea.seed, amp: sea.amp }) : [];
    this.prof = rivalProfile(this.c, this.P, this.settings.skill);
    this.t = 0; this.step = 0; this.done = false; this.why = null;
    const s0 = -12, sp = pointAt(this.c, s0, -4);
    this.b = { x: sp.x, z: sp.z, h: sp.h, vx: 0, vz: 0, r: 0, y: this.P.draft, vy: 0, pitch: 0, pr: 0, roll: 0, rr: 0, air: false, airT: 0,
      s: (s0 + this.c.len) % this.c.len, lat: -4, prog: s0, u: 0, v: 0, onRamp: null, boost: 0 };
    const rs0 = s0 - 8, rp = pointAt(this.c, rs0, -4);
    this.rv = { s: (rs0 + this.c.len) % this.c.len, prog: rs0, v: 0, lat: -4, dodge: 0, x: rp.x, z: rp.z, h: rp.h, y: this.P.draft, pitch: 0, roll: 0, finishT: [] };
    this.in = { steer: [], brake: [] };          // per step: steer in hundredths, brake 0/1 (the recording)
    this.m = { gates: [], nextGate: 0, lapGate: 0, laps: [], offS: 0, contacts: 0, inContact: false, airS: 0, landings: [], top: 0, sumU: 0, nU: 0,
      corrections: 0, cornerCorr: 0, lastSign: 0, sat: 0, nSteer: 0, absSum: 0, hist: new Array(11).fill(0), rateSq: 0, prevS: 0, events: [] };
    this.go = COUNTDOWN_S;
  }
  get lapT() { return Math.max(0, this.t - this.go); }
  surface(x, z) { return W.heightAt(this.waves, x, z, this.t, 3); }
  rampAt(s, lat) {
    if (!this.settings.ramps) return null;
    for (const r of this.c.ramps) { let d = s - r.s; if (d < -this.c.len / 2) d += this.c.len; if (d >= 0 && d <= r.len && Math.abs(lat) <= r.halfW) return { r, d }; }
    return null;
  }
  // steer in [-1, 1] (quantised to hundredths here, so a live run and its replay see the same numbers), brake 0 or 1
  stepOnce(steerIn, brakeIn) {
    if (this.done) return;
    const q = Math.round(clamp(Number.isFinite(steerIn) ? steerIn : 0, -1, 1) * 100) || 0, s = q / 100, brk = brakeIn ? 1 : 0;   // || 0: no -0
    this.in.steer.push(q); this.in.brake.push(brk);
    const P = this.P, b = this.b, dt = DT, racing = this.t >= this.go;
    // ---- planar motion ----
    let fx = -Math.sin(b.h), fz = Math.cos(b.h), rx = -Math.cos(b.h), rz = -Math.sin(b.h);
    let u = b.vx * fx + b.vz * fz, v = b.vx * rx + b.vz * rz;
    const ctrl = b.air ? 0.2 : 1;
    const auth = clamp(Math.abs(u) / P.turnRef, 0, 1) * (Math.abs(u) > 0.5 ? 1 : 0);
    const rT = racing ? s * P.turnRate * DEG * auth * ctrl * (brk ? P.brakeTurn : 1) : 0;
    b.r += (rT - b.r) * (1 - Math.exp(-dt / P.yawTau));
    b.h = wrapA(b.h + b.r * dt);
    fx = -Math.sin(b.h); fz = Math.cos(b.h); rx = -Math.cos(b.h); rz = -Math.sin(b.h);
    u = b.vx * fx + b.vz * fz; v = b.vx * rx + b.vz * rz;
    if (!b.air) {
      const v1 = v * Math.exp(-(brk ? P.gripBrake : P.grip) * dt);
      // carving: part of the energy of the lost sideways speed goes forward (never more than all of it)
      u = Math.sign(u || 1) * Math.sqrt(u * u + P.carve * (v * v - v1 * v1)); v = v1;
    }
    const thrust = racing && !b.air && !brk ? P.accel : 0;
    let du = thrust - P.accel * (u / P.top) * Math.abs(u / P.top) - (brk && racing ? P.brake * Math.sign(u) * Math.min(1, Math.abs(u)) : 0);
    if (b.boost > 0) { du += 3; b.boost = Math.max(0, b.boost - dt); }
    const off = Math.abs(b.lat) > this.c.halfWidth;
    if (off) du -= 0.8 * u;
    // waves push along their slope (surfing), measured at the bow and stern
    const L = P.length * 0.45, Bm = P.beam * 0.5, hh = [];
    for (const al of [L, 0, -L]) for (const sd of [-Bm, Bm]) hh.push(this.surface(b.x + fx * al + rx * sd, b.z + fz * al + rz * sd));
    const hb = (hh[0] + hh[1]) / 2, hs = (hh[4] + hh[5]) / 2, hp = (hh[0] + hh[2] + hh[4]) / 3, hr = (hh[1] + hh[3] + hh[5]) / 3;
    if (!b.air) { du -= W.G * ((hb - hs) / (2 * L)) * P.surf; v -= W.G * ((hr - hp) / (2 * Bm)) * P.surf * 0.3 * dt; }
    if (!racing) { u = 0; v = 0; du = 0; }
    u += du * dt;
    b.vx = fx * u + rx * v; b.vz = fz * u + rz * v;
    if (off) { const p = at(this.c, b.s), dir = -Math.sign(b.lat); b.vx += -Math.cos(p.h) * dir * 3 * dt; b.vz += -Math.sin(p.h) * dir * 3 * dt; }
    // rival contact: a circle each; the player is pushed out and loses the speed towards the rival
    if (this.settings.rival !== 'off') {
      const dx = b.x - this.rv.x, dz = b.z - this.rv.z, d = Math.hypot(dx, dz), rr = P.radius * 2;
      if (d < rr && d > 1e-6) {
        const nx = dx / d, nz = dz / d, vn = b.vx * nx + b.vz * nz;
        b.x += nx * (rr - d); b.z += nz * (rr - d);
        if (vn < 0) { b.vx -= vn * nx * 1.3; b.vz -= vn * nz * 1.3; }
        if (!this.m.inContact) { this.m.contacts++; this.m.events.push(['contact', +this.lapT.toFixed(2)]); }
        this.m.inContact = true;
      } else this.m.inContact = false;
    }
    b.x += b.vx * dt; b.z += b.vz * dt; b.u = u; b.v = v;
    // ---- progress along the line ----
    const pr = project(this.c, b.x, b.z, b.s), ds = wrapS(this.c, pr.s - b.s);
    const prevProg = b.prog; b.s = pr.s; b.lat = pr.lat; b.prog += ds;
    // ---- vertical: water or ramp under the hull, one-sided buoyancy spring, free fall above ----
    // the hull bridges short chop: buoyancy follows the six-point mean through an 80 ms low-pass (the true surface under a boat at
    // 100 km/h accelerates up and down at 9 m/s2 median and 20 m/s2 at the 90th percentile, measured 2026-11-08, more than gravity)
    const mean = (hh[0] + hh[1] + hh[2] + hh[3] + hh[4] + hh[5]) / 6;
    b.hull = b.hull === undefined ? mean : b.hull + (mean - b.hull) * (1 - Math.exp(-dt / 0.08));
    const wantY = b.hull + P.draft + P.lift * clamp(u / P.top, 0, 1);
    const ramp = this.rampAt(b.s, b.lat);
    let support = wantY;
    if (ramp && !b.air) {
      const top = this.surface(b.x, b.z) + P.draft + ramp.r.height * (ramp.d / ramp.r.len);
      if (b.y <= top + 0.3) { support = top; b.y = top; b.vy = Math.max(b.vy, u * (ramp.r.height / ramp.r.len)); b.onRamp = ramp.r; }
    } else if (b.onRamp && !ramp) { b.onRamp = null; b.air = true; b.airT = 0; }
    const g = W.G * P.gMul;
    if (b.air || b.y > support + AIR) {
      if (!b.onRamp) { b.air = true; b.vy -= g * dt; b.y += b.vy * dt; }
      if (b.air && b.y <= support && b.vy < 0) {   // landing
        const impact = -b.vy, airT = b.airT;
        b.air = false; b.y = support; b.vy = 0;
        const clean = airT > 0.4 && Math.abs(b.pitch - Math.atan2(hb - hs, 2 * L)) < 0.25;
        const keep = 1 - Math.min(0.3, P.slamLoss * impact * (clean ? 0.4 : 1));
        b.vx *= keep; b.vz *= keep;
        if (clean && P.jumpBoost > 0) b.boost = P.jumpBoost / 3;
        if (airT > 0.15) { this.m.landings.push({ t: +this.lapT.toFixed(2), airS: +airT.toFixed(2), impact: +impact.toFixed(2), clean }); this.m.events.push(['landing', +this.lapT.toFixed(2)]); }
      }
    } else if (!b.onRamp) {
      const k = P.heaveK, c = 2 * P.heaveZeta * Math.sqrt(k);
      b.vy += (k * (support - b.y) - c * b.vy) * dt; b.y += b.vy * dt;
    }
    if (b.air) { b.airT += dt; if (racing) this.m.airS += dt; } else b.airT = 0;
    // ---- pitch and roll (springs to the water's slope, the planing trim and the bank into the turn) ----
    const pT = b.air ? Math.atan2(b.vy, Math.max(1, u)) * 0.6 : Math.atan2(hb - hs, 2 * L) + P.trim * clamp(u / P.top, 0, 1);
    const rT2 = b.air ? b.roll * 0.98 : Math.atan2(hp - hr, 2 * Bm) + clamp(b.r * Math.max(0, u) * P.bankK / 20, -0.45, 0.45);
    b.pr += (P.pitchK * (pT - b.pitch) - 2 * 0.7 * Math.sqrt(P.pitchK) * b.pr) * dt; b.pitch += b.pr * dt;
    b.rr += (P.rollK * (rT2 - b.roll) - 2 * 0.7 * Math.sqrt(P.rollK) * b.rr) * dt; b.roll += b.rr * dt;
    // ---- rival ----
    this.stepRival(racing);
    // ---- scoring ----
    if (racing) {
      const m = this.m;
      m.top = Math.max(m.top, u); m.sumU += u; m.nU++;
      if (off) m.offS += dt;
      m.nSteer++; m.absSum += Math.abs(s); if (Math.abs(s) >= 0.98) m.sat++;
      m.hist[clamp(Math.floor(((s + 1) / 2) * 11), 0, 10)]++;
      m.rateSq += ((s - m.prevS) / dt) ** 2; m.prevS = s;
      const sg = s > 0.15 ? 1 : s < -0.15 ? -1 : 0;   // a correction is a change of direction beyond +-0.15 (as the S1 slalom)
      if (sg !== 0) {
        if (m.lastSign !== 0 && sg !== m.lastSign) { m.corrections++; if (this.inCorner(b.s)) m.cornerCorr++; }
        m.lastSign = sg;
      }
      this.scoreGates(prevProg, b.prog);
      const lapsDone = m.laps.length;
      if (b.prog >= (lapsDone + 1) * this.c.len) {
        m.laps.push(+(this.lapT - (lapsDone ? m.laps.reduce((a, x) => a + x, 0) : 0)).toFixed(3));
        if (m.laps.length >= this.settings.laps) { this.finish('finished'); }
      }
    }
    this.t += dt; this.step++;
    if (this.lapT > 240) this.finish('time limit');
  }
  inCorner(s) { return this.c.corners.some((z) => s >= z.a && s < z.b); }
  scoreGates(p0, p1) {
    const gs = this.c.gates, m = this.m;
    for (;;) {
      const g = gs[m.nextGate], gp = m.lapGate * this.c.len + g.s;
      if (!(p0 < gp && p1 >= gp)) break;
      const lat = this.b.lat, ok = lat >= g.lo && lat <= g.hi;
      m.gates.push({ lap: m.lapGate + 1, i: m.nextGate, ok, lat: +lat.toFixed(2) });
      m.nextGate++; if (m.nextGate >= gs.length) { m.nextGate = 0; m.lapGate++; }
    }
  }
  stepRival(racing) {
    const R = this.rv, mode = this.settings.rival;
    if (mode === 'off') return;
    if (racing) {
      const i = Math.floor(R.s / this.c.step) % this.c.N;
      let target = this.prof.v[i];
      if (mode === 'band') {   // rubber band: slower when ahead of the player, faster when behind, within -15 % .. +12 %
        const gapS = (R.prog - this.b.prog) / Math.max(5, R.v);
        target *= clamp(1 - this.settings.band * gapS, 0.85, 1.12);
      }
      const acc = Math.max(0.2, this.P.accel * (1 - (R.v / this.P.top) ** 2));
      R.v = R.v < target ? Math.min(target, R.v + acc * DT) : Math.max(target, R.v - 8 * DT);
      const ds = (R.v / this.prof.stretch[i]) * DT; R.s = (R.s + ds) % this.c.len; R.prog += ds;
      if (R.prog >= (R.finishT.length + 1) * this.c.len) R.finishT.push(+this.lapT.toFixed(3));
    }
    // from its start slot (4 m left of the line) onto the racing line over the first 40 m; it swerves 4.5 m around the player
    // when it closes in from behind (deterministic, so replays hold)
    const latAt = (prog, ss) => { const w = clamp((prog + 20) / 40, 0, 1), i = Math.floor((((ss / this.c.step) % this.c.N) + this.c.N) % this.c.N); return -4 * (1 - w) + this.c.lineOff[i] * w; };
    const ahead = wrapS(this.c, this.b.s - R.s), base = latAt(R.prog, R.s);
    const want = racing && ahead > -2 && ahead < 14 && Math.abs(this.b.lat - (base + R.dodge)) < 4 ? (this.b.lat > base ? -4.5 : 4.5) : 0;
    R.dodge += clamp(want - R.dodge, -4 * DT, 4 * DT);
    const lat = base + R.dodge, p = pointAt(this.c, R.s, lat), p2 = pointAt(this.c, R.s + 3, latAt(R.prog + 3, R.s + 3) + R.dodge);
    R.x = p.x; R.z = p.z; R.h = Math.atan2(-(p2.x - p.x), p2.z - p.z); R.lat = lat;
  }
  finish(why) {
    if (this.done) return;
    this.done = true; this.why = why;
    this.m.events.push([why, +this.lapT.toFixed(2)]);
  }
  // rival gap at the player's finish, s: negative = the rival finished first; positive = the player led by that much time
  rivalGap() {
    if (this.settings.rival === 'off' || !this.m.laps.length) return null;
    const need = this.settings.laps * this.c.len, R = this.rv, pT = this.m.laps.reduce((a, x) => a + x, 0);
    if (R.finishT.length >= this.settings.laps) return +(R.finishT[this.settings.laps - 1] - pT).toFixed(2);
    return +((need - R.prog) / Math.max(1, R.v)).toFixed(2);
  }
  summary() {
    const m = this.m, n = Math.max(1, m.nSteer), lapS = m.laps.length ? m.laps.reduce((a, x) => a + x, 0) : null, minutes = Math.max(1e-6, m.nSteer * DT / 60);
    const passed = m.gates.filter((g) => g.ok).length, missed = m.gates.length - passed;
    return {
      why: this.why, laps: m.laps.slice(), lapS, penaltyS: lapS === null ? null : +(lapS + 2 * missed).toFixed(3), gates: m.gates.length, passed, missed,
      offCourseS: +m.offS.toFixed(2), contacts: m.contacts, airS: +m.airS.toFixed(2), landings: m.landings.length,
      cleanLandings: m.landings.filter((l) => l.clean).length, maxImpact: m.landings.length ? Math.max(...m.landings.map((l) => l.impact)) : 0,
      topKmh: +(m.top * 3.6).toFixed(1), meanKmh: +((m.sumU / Math.max(1, m.nU)) * 3.6).toFixed(1),
      hist: m.hist.map((h) => +((100 * h) / n).toFixed(1)), saturationPct: +((100 * m.sat) / n).toFixed(1), meanAbsSteer: +(m.absSum / n).toFixed(3),
      corrections: m.corrections, corners: this.c.corners.length * Math.max(1, m.laps.length || 1), cornerCorrections: m.cornerCorr,
      correctionsPerCorner: +(m.cornerCorr / (this.c.corners.length * Math.max(1, m.laps.length || 1))).toFixed(2),
      correctionsPerMin: +(m.corrections / minutes).toFixed(1), steerRateRms: +Math.sqrt(m.rateSq / n).toFixed(2),
      rivalGapS: this.rivalGap(), steps: this.step, end: { x: +this.b.x.toFixed(4), z: +this.b.z.toFixed(4), h: +this.b.h.toFixed(5) },
    };
  }
}

// A reference driver for tests, the smoke test and the demo: the racing line's curvature a little ahead as feed-forward, plus
// feedback on the heading of travel and the sideways distance to the line; the steer is the yaw rate it wants over the boat's cap.
export function autopilot(run, { tff = 0.6, kh = 2.2, ky = 0.03, latBias = 0 } = {}) {
  const b = run.b, c = run.c, P = run.P, u = Math.max(3, b.u);
  const line = (s) => { const i = Math.floor((((s / c.step) % c.N) + c.N) % c.N); return pointAt(c, s, c.lineOff[i] + latBias); };
  const hOf = (p, q) => Math.atan2(-(q.x - p.x), q.z - p.z);
  const sf = b.s + u * tff, kap = wrapA(hOf(line(sf), line(sf + 2)) - hOf(line(sf - 2), line(sf))) / 4;
  const hl = hOf(line(b.s + u * 0.2), line(b.s + u * 0.2 + 2)), hv = Math.atan2(-b.vx, b.vz);
  const i0 = Math.floor((((b.s / c.step) % c.N) + c.N) % c.N), ey = c.lineOff[i0] + latBias - b.lat;
  const rWant = u * kap + kh * wrapA(hl - (b.u > 3 ? hv : b.h)) + ky * ey;
  const auth = clamp(Math.abs(b.u) / P.turnRef, 0.2, 1);
  return clamp(rWant / (P.turnRate * DEG * auth), -1, 1);
}
export function autoBrake(run, margin = 1.05, ahead = 45, decel = 7) {
  const c = run.c; let lim = Infinity;
  for (let d = 0; d <= ahead; d += 3) { const i = Math.floor(((((run.b.s + d) / c.step) % c.N) + c.N) % c.N); lim = Math.min(lim, Math.sqrt((run.prof.v[i] / run.settings.skill) ** 2 + 2 * decel * d)); }
  return run.b.u > lim * margin ? 1 : 0;
}

// ---------- recording: per-step inputs, run-length encoded, base64 (copyable text) ----------
export function encodeInputs(steer, brake) {
  const bytes = [];
  for (let i = 0; i < steer.length;) {
    let k = 1; while (i + k < steer.length && k < 255 && steer[i + k] === steer[i] && brake[i + k] === brake[i]) k++;
    bytes.push(steer[i] + 100, brake[i] ? 1 : 0, k); i += k;   // value 0..200, brake, count
  }
  const u8 = Uint8Array.from(bytes);
  let bin = ''; for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(u8).toString('base64');
}
export function decodeInputs(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const steer = [], brake = [];
  for (let i = 0; i + 2 < bin.length; i += 3) { const v = bin.charCodeAt(i) - 100, br = bin.charCodeAt(i + 1), k = bin.charCodeAt(i + 2); for (let j = 0; j < k; j++) { steer.push(v); brake.push(br); } }
  return { steer, brake };
}
// Re-run recorded inputs through a fresh Run with the same settings; returns the new summary.
export function replay(settings, steer, brake, course = null) {
  const r = new Run(settings, course);
  for (let i = 0; i < steer.length && !r.done; i++) r.stepOnce(steer[i] / 100, brake[i]);
  return r;
}
