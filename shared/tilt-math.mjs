// tilt-math.mjs: the pure math of the S1 tilt lab (no DOM, no browser APIs), shared by the page, the tests and later spikes.
// Written 2026-11-06. Tests: `node --test tests/` (tests/tilt-math.test.mjs).
// Angles are degrees unless a name ends in Rad. "Steer right" is positive everywhere.
//
// Frames and conventions (W3C DeviceOrientation and DeviceMotion):
// - Device frame: x to the right of the screen in its natural (portrait) orientation, y up the screen, z out of the screen.
// - DeviceOrientation (alpha, beta, gamma): R = Rz(alpha) * Rx(beta) * Ry(gamma) rotates device vectors into the earth frame.
// - DeviceMotion.accelerationIncludingGravity: by the spec a phone lying flat, screen up, reads z = +9.81 (the reaction to gravity,
//   pointing up). Some platforms are reported to invert it; S1 measures that (gravityConvention below). A WHEEL angle is the same
//   under either sign, a LEAN angle flips.
// - DeviceMotion.rotationRate: the current W3C editor draft returns the x axis rate as alpha, y as beta, z as gamma (fetched
//   2026-11-08, lines 1622-1624; an older wording named alpha for z). Chrome 156 (2026-11-06) and Safari 26.6.1 on his iPhone
//   (2026-11-08) both deliver the z rate in gamma, deg/s. Nothing here assumes a component: S1 measures which one carries the turn,
//   its sign and its unit (gyroMappingBest below).
// - Wheel steering: the phone turns like a steering wheel about the screen normal. Turning it clockwise as the player sees it is
//   a negative rotation about +z; a world-fixed vector seen from the device then turns by the opposite angle (positive).

export const DEG = Math.PI / 180;
export const G0 = 9.80665;

export function wrapDeg(a) {               // into (-180, 180]
  const x = ((((a + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- vectors and quaternions ([w, x, y, z]) ----
export const vLen = (v) => Math.hypot(v[0], v[1], v[2]);
export function vNorm(v) { const n = vLen(v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }

export function quatFromEuler(alpha, beta, gamma) {
  const hx = ((beta || 0) * DEG) / 2, hy = ((gamma || 0) * DEG) / 2, hz = ((alpha || 0) * DEG) / 2;
  const cX = Math.cos(hx), cY = Math.cos(hy), cZ = Math.cos(hz), sX = Math.sin(hx), sY = Math.sin(hy), sZ = Math.sin(hz);
  return [cX * cY * cZ - sX * sY * sZ, sX * cY * cZ - cX * sY * sZ, cX * sY * cZ + sX * cY * sZ, cX * cY * sZ + sX * sY * cZ];
}
export function quatMul(a, b) {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];
}
export const quatConj = (q) => [q[0], -q[1], -q[2], -q[3]];
export function quatNorm(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; }
export function quatFromAxisAngle(axis, deg) {
  const [x, y, z] = vNorm(axis), h = (deg * DEG) / 2, s = Math.sin(h);
  return [Math.cos(h), x * s, y * s, z * s];
}
export function quatRotate(q, v) {            // q v q*
  const p = quatMul(quatMul(q, [0, v[0], v[1], v[2]]), quatConj(q));
  return [p[1], p[2], p[3]];
}
// Angle between two vectors and between two rotations, in degrees; the mean of nearby rotations (sign-aligned, normalised sum).
export function vAngleDeg(a, b) {
  const n = vLen(a) * vLen(b); if (!n) return NaN;
  return Math.acos(clamp((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / n, -1, 1)) / DEG;
}
export function quatAngleDeg(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
  return (2 * Math.acos(clamp(d, -1, 1))) / DEG;
}
export function quatMean(qs) {
  if (!qs.length) return null;
  const ref = qs[0], s = [0, 0, 0, 0];
  for (const q of qs) { const k = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1; for (let i = 0; i < 4; i++) s[i] += k * q[i]; }
  return quatNorm(s);
}
export function matFromQuat(q) {
  const [w, x, y, z] = quatNorm(q);
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
}
// Inverse of quatFromEuler with the W3C ranges: alpha [0, 360), beta [-180, 180), gamma [-90, 90).
// Follows the case split of the W3C DeviceOrientation spec's worked example (rotation matrix to Euler angles).
export function eulerFromQuat(q) {
  const R = matFromQuat(q), PI = Math.PI;
  let alpha, beta, gamma;
  const asin = (v) => Math.asin(clamp(v, -1, 1));
  if (R[2][2] > 1e-12) { alpha = Math.atan2(-R[0][1], R[1][1]); beta = asin(R[2][1]); gamma = Math.atan2(-R[2][0], R[2][2]); }
  else if (R[2][2] < -1e-12) {
    alpha = Math.atan2(R[0][1], -R[1][1]); beta = -asin(R[2][1]); beta += beta >= 0 ? -PI : PI; gamma = Math.atan2(R[2][0], -R[2][2]);
  } else if (R[2][0] > 1e-12) { alpha = Math.atan2(-R[0][1], R[1][1]); beta = asin(R[2][1]); gamma = -PI / 2; }
  else if (R[2][0] < -1e-12) {
    alpha = Math.atan2(R[0][1], -R[1][1]); beta = -asin(R[2][1]); beta += beta >= 0 ? -PI : PI; gamma = -PI / 2;
  } else { alpha = Math.atan2(R[1][0], R[0][0]); beta = R[2][1] > 0 ? PI / 2 : -PI / 2; gamma = 0; }
  if (alpha < 0) alpha += 2 * PI;
  return { alpha: alpha / DEG, beta: beta / DEG, gamma: gamma / DEG };
}
// Twist (swing-twist decomposition) of q about the device z axis, degrees, (-180, 180].
export function twistZDeg(q) { return wrapDeg((2 * Math.atan2(q[3], q[0])) / DEG); }

// ---- screen coordinates ----
// angle = screen.orientation.angle (or window.orientation mod 360): how far the device is turned counterclockwise from its
// natural orientation. Screen-right and screen-up expressed in device coordinates:
export function screenAxes(angleDeg) {
  const a = angleDeg * DEG, c = Math.cos(a), s = Math.sin(a);
  return { right: [c, -s, 0], up: [s, c, 0] };
}
export function toScreen(v, angleDeg) {
  const { right, up } = screenAxes(angleDeg);
  return [v[0] * right[0] + v[1] * right[1], v[0] * up[0] + v[1] * up[1], v[2]];
}

// ---- the five steering candidates, each relative to a calibrated neutral pose ----
// EUL: the naive Euler reading: gamma in portrait, beta in landscape, sign by screen angle. Breaks near the vertical (kept as the
// baseline that many tilt tutorials use).
export function eulDeg(e, e0, angleDeg) {
  const a = ((Math.round(angleDeg / 90) * 90) % 360 + 360) % 360;
  if (a === 0) return wrapDeg(e.gamma - e0.gamma);
  if (a === 180) return -wrapDeg(e.gamma - e0.gamma);
  if (a === 90) return wrapDeg(e.beta - e0.beta);
  return -wrapDeg(e.beta - e0.beta);
}
// GWH: wheel angle from the gravity reading's in-plane direction. Valid while the in-plane part is large enough (not flat).
export function inPlaneRatio(g) { const n = vLen(g); return n > 0 ? Math.hypot(g[0], g[1]) / n : 0; }
export function gwhDeg(g, g0) { return wrapDeg((Math.atan2(g[1], g[0]) - Math.atan2(g0[1], g0[0])) / DEG); }
// Which way the platform reports accelerationIncludingGravity: +1 = as the spec (reaction, points up), -1 = inverted, 0 = cannot
// tell from this pose. In a normal hold, "up" lies along screen-up and/or out of the screen.
export function gravityConvention(g0, angleDeg, minRatio = 0.3) {
  const s = toScreen(g0, angleDeg), n = vLen(g0) || 1, k = (s[1] + s[2]) / n;
  return Math.abs(k) < minRatio ? 0 : Math.sign(k);
}
// World "up" in device coordinates from a DeviceOrientation reading: R^T e_z, the third row of R (does not depend on alpha).
export function upFromEuler(alpha, beta, gamma) { const R = matFromQuat(quatFromEuler(alpha, beta, gamma)); return [R[2][0], R[2][1], R[2][2]]; }
// The gravity convention measured against the fused orientation, independent of the screen angle: +1 spec, -1 inverted, 0 unclear.
export function convFromOrientation(g, up, minCos = 0.5) {
  const n = vLen(g); if (!n) return 0;
  const c = (g[0] * up[0] + g[1] * up[1] + g[2] * up[2]) / n;
  return Math.abs(c) < minCos ? 0 : Math.sign(c);
}
// Does the reported screen angle agree with the fused orientation? In a normal hold the top of the screen is higher than its
// bottom, so world-up has a non-negative screen-up part. 'ok', 'mirrored' or 'unclear' (phone near flat).
export function screenAngleCheck(up, angleDeg) {
  const s = toScreen(up, angleDeg);
  if (Math.abs(s[2]) > 0.9) return 'unclear';
  return s[1] >= -0.2 ? 'ok' : 'mirrored';
}
// GLN: lean angle (rotation about screen-up: right edge down = steer right), absolute, from the screen-x part of gravity.
export function leanAbsDeg(g, angleDeg, convention) {
  const s = toScreen(g, angleDeg), n = vLen(g) || 1;
  return (-(convention || 1) * Math.asin(clamp(s[0] / n, -1, 1))) / DEG;
}
// QTW: twist of the orientation change since calibration about the device z axis. q0^-1 * q is the change in the neutral
// device frame; a clockwise (steer right) turn is a negative twist, so the sign flips.
export function qtwDeg(q, q0) { return -twistZDeg(quatMul(quatConj(q0), q)); }

// CWH: complementary filter. Gyro rate integrated for the fast part, the gravity wheel angle for the slow, drift-free part.
// rateDeg is the steer-right rate (already mapped by gyroMapping); measDeg is GWH or null when the phone is too flat.
export function complementaryStep(prevDeg, rateDeg, dtS, measDeg, tauS) {
  const pred = prevDeg + rateDeg * dtS;
  if (measDeg === null || measDeg === undefined || !Number.isFinite(measDeg)) return pred;
  const k = tauS / (tauS + dtS);
  const meas = pred + wrapDeg(measDeg - pred);    // nearest branch, no jump at +-180
  return k * pred + (1 - k) * meas;
}

// ---- filters (applied to a candidate angle before mapping) ----
export class Ema {
  constructor(tauMs) { this.tau = tauMs; this.y = null; this.t = null; }
  reset() { this.y = null; this.t = null; }
  step(x, tMs) {
    if (this.y === null || this.tau <= 0) { this.y = x; this.t = tMs; return x; }
    const dt = Math.max(0, tMs - this.t); this.t = tMs;
    this.y += (1 - Math.exp(-dt / this.tau)) * (x - this.y);
    return this.y;
  }
}
// One Euro filter (Casiez, Roussel, Vogel, CHI 2012): little lag when moving fast, strong smoothing when still.
export class OneEuro {
  constructor(minCutoffHz = 1, beta = 0.02, dCutoffHz = 1) { Object.assign(this, { minCutoffHz, beta, dCutoffHz }); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoffHz, dtS) { const tau = 1 / (2 * Math.PI * cutoffHz); return 1 / (1 + tau / dtS); }
  step(x, tMs) {
    if (this.x === null) { this.x = x; this.t = tMs; return x; }
    const dtS = Math.max(1e-4, (tMs - this.t) / 1000); this.t = tMs;
    const dxRaw = (x - this.x) / dtS;
    this.dx += OneEuro.alpha(this.dCutoffHz, dtS) * (dxRaw - this.dx);
    const cutoff = this.minCutoffHz + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dtS) * (x - this.x);
    return this.x;
  }
}
export const FILTERS = {
  none: () => ({ step: (x) => x, reset() {} }),
  ema30: () => new Ema(30), ema60: () => new Ema(60), ema100: () => new Ema(100),
  euro: () => new OneEuro(1.0, 0.02, 1.0),
};

// ---- angle to steering value in [-1, 1] ----
export function mapSteer(deg, { deadDeg = 2, maxDeg = 25, expo = 1.5 } = {}) {
  const m = Math.abs(deg);
  if (m <= deadDeg) return 0;
  const u = clamp((m - deadDeg) / Math.max(1e-6, maxDeg - deadDeg), 0, 1);
  return Math.sign(deg) * Math.pow(u, expo);
}

// ---- statistics ----
export function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
export function std(a) { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); }
export function percentile(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), i = clamp(p, 0, 100) / 100 * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (a) => percentile(a, 50);
export function histogram(values, lo, hi, bins) {
  const h = new Array(bins).fill(0);
  for (const v of values) { if (!Number.isFinite(v)) continue; h[clamp(Math.floor(((v - lo) / (hi - lo)) * bins), 0, bins - 1)]++; }
  return h;
}
// Least squares through the origin: y = k x. r2 against the mean of y.
export function slopeThroughOrigin(xs, ys) {
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
  const k = sxx > 0 ? sxy / sxx : NaN, my = mean(ys);
  let sse = 0, sst = 0;
  for (let i = 0; i < xs.length; i++) { sse += (ys[i] - k * xs[i]) ** 2; sst += (ys[i] - my) ** 2; }
  return { k, r2: sst > 0 ? 1 - sse / sst : NaN, n: xs.length };
}
// Gyro mapping from paired samples: x = -(one rotationRate component) * dt (the steer-right change in deg if that component is the
// z rate in deg/s; the spec's z rate is gamma, see the header),
// y = the measured change of the gravity wheel angle. k near +1: spec deg/s; near -1: inverted; near 57.3 or 1/57.3: rad/deg mixup.
export function gyroMapping(xs, ys, { minN = 60, minR2 = 0.8 } = {}) {
  const fit = slopeThroughOrigin(xs, ys);
  if (fit.n < minN || !(fit.r2 >= minR2)) return { ...fit, sign: 1, scale: 1, verdict: 'not enough clean movement yet', trusted: false };
  const a = Math.abs(fit.k), sign = Math.sign(fit.k);
  let scale = 1, verdict;
  if (a > 0.6 && a < 1.6) verdict = sign > 0 ? 'deg/s, right-hand rule (as the spec)' : 'deg/s, sign inverted';
  else if (a > 35 && a < 90) { scale = 1 / DEG; verdict = 'rad/s (not deg/s)' + (sign > 0 ? '' : ', sign inverted'); }
  else if (a > 0.01 && a < 0.03) { scale = DEG; verdict = 'unit looks 57x too large' + (sign > 0 ? '' : ', sign inverted'); }
  else { verdict = 'unexpected slope'; return { ...fit, sign: 1, scale: 1, verdict, trusted: false }; }
  return { ...fit, sign, scale, verdict, trusted: true };
}

// The spec puts the rotation about the screen normal in rotationRate.alpha; Chrome 156 (desktop, DevTools sensors) delivers it in
// gamma (measured 2026-11-06). So test all three components and keep the trusted fit with the highest r2.
// xsBy = { alpha: [...], beta: [...], gamma: [...] }, each paired with ys.
export function gyroMappingBest(xsBy, ys, opts) {
  let best = null;
  for (const comp of ['alpha', 'beta', 'gamma']) {
    const m = { ...gyroMapping(xsBy[comp] || [], ys, opts), component: comp };
    if (m.trusted && (!best || !best.trusted || m.r2 > best.r2)) best = m;
    else if (!best || (!best.trusted && (m.r2 || 0) > (best.r2 || 0))) best = m;
  }
  if (best && !best.trusted) best.component = null;
  return best;
}
// The smallest non-zero change between successive readings: the sensor's resolution (quantisation) as this browser delivers it.
export class Resolution {
  constructor() { this.min = Infinity; this.prev = null; }
  push(v) { if (this.prev !== null && Number.isFinite(v)) { const d = Math.abs(v - this.prev); if (d > 1e-9 && d < this.min) this.min = d; } this.prev = v; }
  get value() { return Number.isFinite(this.min) ? this.min : null; }
}

// Resample (t, v) pairs onto a uniform grid (linear interpolation). t in ms, ascending.
export function resample(ts, vs, stepMs) {
  const out = [];
  if (ts.length < 2) return out;
  let j = 0;
  for (let t = ts[0]; t <= ts[ts.length - 1]; t += stepMs) {
    while (j < ts.length - 2 && ts[j + 1] < t) j++;
    const t0 = ts[j], t1 = ts[j + 1], f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    out.push(vs[j] + (vs[j + 1] - vs[j]) * clamp(f, 0, 1));
  }
  return out;
}
// Lag of b behind a (ms) by normalised cross-correlation over lags minLagMs..maxLagMs (a negative lag: b leads), with a
// parabolic refinement of the peak. Both series are uniformly sampled with stepMs. Returns { lagMs, peak } or null when there
// is too little movement or too little data.
export function lagMs(a, b, stepMs, maxLagMs = 300, minLagMs = 0) {
  const n = Math.min(a.length, b.length), kMin = Math.ceil(minLagMs / stepMs), kMax = Math.floor(maxLagMs / stepMs);
  if (n < 20 || kMax - kMin < 2 || Math.abs(kMin) > n - 2 || Math.abs(kMax) > n - 2) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  const da = a.slice(0, n).map((v) => v - ma), db = b.slice(0, n).map((v) => v - mb);
  const ea = Math.sqrt(da.reduce((s, v) => s + v * v, 0)), eb = Math.sqrt(db.reduce((s, v) => s + v * v, 0));
  if (ea < 1e-9 || eb < 1e-9) return null;
  // Pearson correlation over the overlap of each shift. Dividing by the full energies instead would weight each lag by its
  // overlap (n - k) / n and pull the peak towards 0 (measured: -5 ms on a 6 s run at 0.5 Hz, smoke test of 2026-11-06).
  const c = [];
  for (let k = kMin; k <= kMax; k++) {
    let sab = 0, saa = 0, sbb = 0;
    for (let i = Math.max(0, -k); i < n && i + k < n; i++) { const x = da[i], y = db[i + k]; sab += x * y; saa += x * x; sbb += y * y; }
    c.push(saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : -1);
  }
  let best = 0;
  for (let j = 1; j < c.length; j++) if (c[j] > c[best]) best = j;
  let frac = 0;
  if (best > 0 && best < c.length - 1) { const y0 = c[best - 1], y1 = c[best], y2 = c[best + 1], d = y0 - 2 * y1 + y2; if (d !== 0) frac = clamp((0.5 * (y0 - y2)) / d, -0.5, 0.5); }
  return { lagMs: (kMin + best + frac) * stepMs, peak: c[best] };
}
