// tilt-input.mjs: tilt steering for the S3 feel lab and the game: sensor events in, a steering value in [-1, 1] out.
// Ported from the S1 tilt lab (s1-tilt/lab.mjs) into one reusable class, with the S1 findings applied: signal B (gravity wheel
// angle fused with the gyro's turn about the screen normal) is the default, the choice after the first phone test (2026-11-08);
// C (the orientation's twist) is the fallback when no gyro data comes. The neutral is taken only when the phone is still. No DOM
// needed: tests feed events directly. Written 2026-11-08. Tests: tests/tilt-input.test.mjs.
import * as M from './tilt-math.mjs';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const keep = (buf, th, ms) => { while (buf.length && th - buf[0][0] > ms) buf.shift(); };
const cap = (arr, v, n) => { arr.push(v); if (arr.length > n) arr.splice(0, arr.length - n); };
const rd = (v, d = 2) => (fin(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export const TILT_DEFAULTS = { signal: 'B', deadDeg: 2, maxDeg: 25, expo: 1.5, euroMin: 1.0, euroBeta: 0.02, invert: false,
  gravityTauMs: 60, cwhTauS: 0.25, stillDeg: 1.5, recentreDeg: 4, noDataMs: 1500 };

export class TiltInput {
  constructor(opts = {}) { this.o = { ...TILT_DEFAULTS, ...opts }; this.reset(); }
  reset() {
    Object.assign(this, {
      gEma: null, ori: null, mot: null, buf: { g: [], q: [] }, gw: null, gyro: { alpha: [], beta: [], gamma: [], ys: [] },
      gyroMap: { verdict: 'not measured yet', trusted: false }, gyroLock: null, gyroLockedAt: null, cal: null, cals: [], cwh: 0,
      counts: { ori: 0, mot: 0 }, nulls: { ori: 0, mot: 0 }, win: { ori: [], mot: [] }, intervals: [],
      filter: new M.OneEuro(this.o.euroMin, this.o.euroBeta, 1.0), last: { value: 0, deg: null, source: 'none' },
      source: 'none', startedAt: null, touch: { target: 0, value: 0, t: null }, rec: null,
    });
  }
  setOptions(o) { Object.assign(this.o, o); this.filter = new M.OneEuro(this.o.euroMin, this.o.euroBeta, 1.0); }
  start(th) { this.startedAt = th; if (this.source === 'none') this.source = 'waiting'; }
  // ---- events (th = performance.now() at the handler) ----
  onMotion(aig, rr, interval, th) {
    if (!aig || !aig.every(fin)) { this.nulls.mot++; return; }
    const prev = this.mot, dtMs = prev ? th - prev.th : 0, dtS = M.clamp(dtMs / 1000, 0, 0.1);
    if (!this.gEma) this.gEma = aig.slice();
    else { const k = 1 - Math.exp(-Math.max(0, dtMs) / this.o.gravityTauMs); for (let i = 0; i < 3; i++) this.gEma[i] += k * (aig[i] - this.gEma[i]); }
    this.buf.g.push([th, aig]); keep(this.buf.g, th, 1200);
    const r = rr && fin(rr.alpha) && fin(rr.beta) && fin(rr.gamma) ? rr : null;
    if (r && prev) this.gyroWindow(aig, r, th, dtS);
    if (this.cal && this.cal.g0 && prev) {
      const meas = M.inPlaneRatio(aig) >= 0.25 ? M.gwhDeg(aig, this.cal.g0) : null;
      if (r && this.gyroLock) { const g = this.gyroLock; this.cwh = M.complementaryStep(this.cwh, g.sign * g.scale * -r[g.component], dtS, meas, this.o.cwhTauS); }
      else if (meas !== null) this.cwh = meas;   // gravity only until the gyro's axis and sign are measured
    }
    this.mot = { th, aig, rr: r, interval };
    this.counts.mot++; this.win.mot.push(th); keep2(this.win.mot, th);
    if (fin(interval)) cap(this.intervals, interval, 300);
    if (this.source === 'waiting' || this.source === 'touch-auto') this.source = 'tilt';
    if (this.rec && this.rec.length < 120000) this.rec.push(['m', rd(th, 1), ...aig.map((v) => rd(v, 3)), ...(r ? [rd(r.alpha, 2), rd(r.beta, 2), rd(r.gamma, 2)] : [null, null, null])]);
  }
  onOrientation(alpha, beta, gamma, th) {
    if (!fin(alpha) && !fin(beta) && !fin(gamma)) { this.nulls.ori++; return; }
    const q = M.quatFromEuler(+alpha || 0, +beta || 0, +gamma || 0);
    this.ori = { th, alpha: +alpha || 0, beta: +beta || 0, gamma: +gamma || 0, q };
    this.buf.q.push([th, q]); keep(this.buf.q, th, 1200);
    this.counts.ori++; this.win.ori.push(th); keep2(this.win.ori, th);
    if (this.source === 'waiting' || this.source === 'touch-auto') this.source = 'tilt';
    if (this.rec && this.rec.length < 120000) this.rec.push(['o', rd(th, 1), rd(alpha, 2), rd(beta, 2), rd(gamma, 2)]);
  }
  // 100 ms windows: which rotationRate component (and sign and unit) carries the turn about the screen normal (S1 method)
  gyroWindow(aig, rr, th, dtS) {
    const raw = M.inPlaneRatio(aig) >= 0.35 ? M.gwhDeg(aig, [1, 0, 0]) : null;
    if (raw === null) { this.gw = null; return; }
    if (!this.gw) { this.gw = { t0: th, xa: 0, xb: 0, xg: 0, y0: raw }; return; }
    const w = this.gw; w.xa += -rr.alpha * dtS; w.xb += -rr.beta * dtS; w.xg += -rr.gamma * dtS;
    if (th - w.t0 >= 100) {
      const y = M.wrapDeg(raw - w.y0);
      if (Math.max(Math.abs(w.xa), Math.abs(w.xb), Math.abs(w.xg), Math.abs(y)) >= 1) {
        cap(this.gyro.alpha, w.xa, 400); cap(this.gyro.beta, w.xb, 400); cap(this.gyro.gamma, w.xg, 400); cap(this.gyro.ys, y, 400);
      }
      this.gw = { t0: th, xa: 0, xb: 0, xg: 0, y0: raw };
      this.gyroMap = M.gyroMappingBest(this.gyro, this.gyro.ys, { minN: 12, minR2: 0.8 });
      if (this.gyroMap.trusted && (!this.gyroLock || this.gyroMap.component === this.gyroLock.component || this.gyroMap.r2 > this.gyroLock.r2 + 0.05)) {
        if (!this.gyroLock) this.gyroLockedAt = th;
        this.gyroLock = { ...this.gyroMap };
      }
    }
  }
  // ---- calibration: the mean of the last 600 ms, refused when the phone moved more than stillDeg in that time ----
  measureNeutral(th, ms = 600) {
    const gw = this.buf.g.filter((s) => th - s[0] <= ms), qw = this.buf.q.filter((s) => th - s[0] <= ms);
    if (gw.length < 5 && qw.length < 3) return null;
    let g0 = null, q0 = null, spread = 0;
    if (gw.length >= 5) { g0 = [0, 1, 2].map((i) => M.mean(gw.map((s) => s[1][i]))); spread = Math.max(...gw.map((s) => M.vAngleDeg(s[1], g0))); }
    if (qw.length >= 3) { q0 = M.quatMean(qw.map((s) => s[1])); spread = Math.max(spread, ...qw.map((s) => M.quatAngleDeg(s[1], q0))); }
    const tiltBack = g0 ? Math.asin(M.clamp(Math.abs(g0[2]) / (M.vLen(g0) || 1), 0, 1)) / M.DEG : null;
    return { th, g0, q0, spread, tiltBack, samples: [gw.length, qw.length] };
  }
  calibrate(th, reason = 'calibrate', maxSpread = this.o.stillDeg) {
    const c = this.measureNeutral(th);
    if (!c) { this.cals.push({ th: rd(th, 0), reason, ok: false, why: 'no sensor data' }); return { ok: false, why: 'no sensor data' }; }
    const row = { th: rd(th, 0), reason, spread: rd(c.spread, 2), tiltBack: rd(c.tiltBack, 1), samples: c.samples };
    if (c.spread > maxSpread) { this.cals.push({ ...row, ok: false, why: 'moved' }); return { ok: false, why: 'moved', spread: c.spread }; }
    this.cal = c; this.cwh = 0; this.filter = new M.OneEuro(this.o.euroMin, this.o.euroBeta, 1.0);
    this.cals.push({ ...row, ok: true }); return { ok: true, spread: c.spread, tiltBack: c.tiltBack };
  }
  recentre(th) { return this.calibrate(th, 'recentre', this.o.recentreDeg); }
  // ---- the steering value ----
  angle() {   // degrees, steer-right positive, or null
    if (!this.cal) return null;
    const sig = this.signalInUse();
    if (sig === 'C') return this.ori && this.cal.q0 ? M.qtwDeg(this.ori.q, this.cal.q0) : null;
    if (sig === 'B') return this.gEma && this.cal.g0 && M.inPlaneRatio(this.gEma) >= 0.25 ? this.cwh : null;
    return null;
  }
  signalInUse() {   // B needs gravity; C needs orientation; each falls back to the other when its data is missing
    const hasG = !!(this.gEma && this.cal && this.cal.g0), hasQ = !!(this.ori && this.cal && this.cal.q0);
    if (this.o.signal === 'C') return hasQ ? 'C' : hasG ? 'B' : null;
    return hasG ? 'B' : hasQ ? 'C' : null;
  }
  checkNoData(th) {   // no event at all noDataMs after start: touch steering takes over
    if (this.source === 'waiting' && this.startedAt !== null && th - this.startedAt > this.o.noDataMs) this.source = 'touch-auto';
    return this.source;
  }
  setTouch(target) { this.touch.target = M.clamp(target, -1, 1); }
  touchStep(th) {
    const T = this.touch, dt = T.t === null ? 0 : M.clamp((th - T.t) / 1000, 0, 0.1); T.t = th;
    const rate = T.target === 0 ? 8 : 5;   // per second: back to the middle faster than out
    T.value += M.clamp(T.target - T.value, -rate * dt, rate * dt);
    return T.value;
  }
  // th: the frame time. Returns { value in [-1, 1], deg (filtered, null for touch), source }
  steer(th) {
    const src = this.checkNoData(th);
    if (src === 'touch' || src === 'touch-auto' || src === 'none' || src === 'waiting') {
      const v = src === 'touch' || src === 'touch-auto' ? this.touchStep(th) : 0;
      this.last = { value: v, deg: null, raw: null, source: src }; return this.last;
    }
    const raw = this.angle();
    if (raw === null) { this.last = { value: 0, deg: null, raw: null, source: 'no data' }; return this.last; }
    const deg = this.filter.step(raw, th);
    let v = M.mapSteer(deg, { deadDeg: this.o.deadDeg, maxDeg: this.o.maxDeg, expo: this.o.expo });
    if (this.o.invert) v = -v;
    this.last = { value: v, deg, raw, source: 'tilt ' + this.signalInUse() };
    return this.last;
  }
  rates() { return { ori: this.win.ori.length / 2, mot: this.win.mot.length / 2 }; }   // events per second over the last 2 s
  info() {
    const iv = this.intervals.length ? M.median(this.intervals) : null;
    return { source: this.source, signal: this.o.signal, inUse: this.signalInUse(), counts: { ...this.counts }, nulls: { ...this.nulls },
      gyro: this.gyroLock ? `${this.gyroLock.verdict} (${this.gyroLock.component}, r2 ${rd(this.gyroLock.r2, 2)})` : this.gyroMap.verdict,
      gyroLocked: !!this.gyroLock, interval: iv === null ? null : iv < 1 ? `${rd(iv * 1000, 1)} ms (sent as seconds)` : `${rd(iv, 1)} ms`,
      cal: this.cal ? { spread: rd(this.cal.spread, 2), tiltBack: rd(this.cal.tiltBack, 1) } : null,
      calRejected: this.cals.filter((c) => !c.ok).length, calOk: this.cals.filter((c) => c.ok).length };
  }
  // ---- browser glue (not used by the unit tests) ----
  attach(win = window, now = () => performance.now()) {
    if (this.attached) return; this.attached = true;
    win.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity, r = e.rotationRate;
      this.onMotion(a && a.x !== null && a.x !== undefined ? [+a.x, +a.y, +a.z] : null,
        r && r.alpha !== null && r.alpha !== undefined ? { alpha: +r.alpha, beta: +r.beta, gamma: +r.gamma } : null, e.interval, now());
    });
    win.addEventListener('deviceorientation', (e) => this.onOrientation(e.alpha, e.beta, e.gamma, now()));
  }
  // Must run inside a tap handler (transient activation, R2-tilt-08c). Resolves to { motion, orientation } states.
  static async requestPermission(win = window) {
    const ask = (C) => (C && typeof C.requestPermission === 'function' ? C.requestPermission().then((v) => v, (e) => 'error: ' + ((e && e.name) || e)) : Promise.resolve('no prompt needed'));
    const [motion, orientation] = await Promise.all([ask(win.DeviceMotionEvent), ask(win.DeviceOrientationEvent)]);
    return { motion, orientation };
  }
}
function keep2(arr, th) { while (arr.length && th - arr[0] > 2000) arr.shift(); }
