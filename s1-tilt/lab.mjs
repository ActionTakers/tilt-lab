// lab.mjs: the S1 tilt lab page: how tilt steering behaves on a phone (five steering signals, noise, lag, a buoy slalom, sound and
// screen checks). ES module, no build step. v0.3, 2026-11-06; its history and reviews are in the project's LOG.md and review folder.
// Desktop and headless numbers are smoke tests only, never phone numbers. What each number means: s1-tilt/README.md.
import * as M from '../shared/tilt-math.mjs';
import { makeCourse, Slalom } from '../shared/slalom.mjs';

const VERSION = 's1-tilt v0.3';
const CANDS = ['GWH', 'CWH', 'QTW', 'GLN', 'EUL'];
const LETTER = { GWH: 'A', CWH: 'B', QTW: 'C', GLN: 'D', EUL: 'E' };
const NAMES = { GWH: 'gravity wheel', CWH: 'gravity + gyro wheel', QTW: 'orientation twist', GLN: 'gravity lean', EUL: 'Euler, naive' };
const SOURCE = { GWH: 'mot', CWH: 'mot', GLN: 'mot', QTW: 'ori', EUL: 'ori' };
const COL = Object.fromEntries(CANDS.map((k, i) => [k, 3 + i]));   // frame row: t, raf, age, five candidates, filtered, steer, x, y, heading
const STORE = 's1-tilt-session';
const ANSWERS = {   // the answer buttons: key -> label on the card
  prompt: 'motion prompt seen', autoLock: 'Auto-Lock', brightness: 'brightness', autoBrightness: 'Auto-Brightness', charging: 'charging',
  lpm: 'Low Power Mode', offHeard: 'tone heard, silent mode off', onHeard: 'tone heard, silent mode on', onPlayback: 'tone heard, silent on + play anyway',
  vibFelt: 'vibration felt', dimmed: 'screen dimmed in idle check', best: 'best signal', worst: 'worst signal',
};
const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const rd = (v, d = 2) => (fin(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const fmt = (v, d = 1) => (fin(v) ? v.toFixed(d) : '-');
const cap = (arr, v, n) => { arr.push(v); if (arr.length > n) arr.splice(0, arr.length - n); };

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return (window.orientation + 360) % 360;   // older iOS: 90, -90, 180
  return 0;
}

const S = {
  version: VERSION, loadedAt: new Date().toISOString(), secure: window.isSecureContext,
  perm: { motion: 'not asked', orientation: 'not asked', prompted: false },
  starting: false, started: false, listening: false, listenT: null,
  angle: screenAngle(), orientationChanges: 0, lockWarn: false, lockWarnCount: 0,
  ori: null, mot: null, gEma: null, buf: { g: [], q: [] },
  counts: { ori: 0, mot: 0 }, nulls: { ori: 0, mot: 0 }, tsFallback: 0,
  win: { ori: [], mot: [] }, intervals: [],
  cal: null, cals: [], cwh: 0, gyroLock: null,
  gw: null, gyro: { alpha: [], beta: [], gamma: [], ys: [] }, gyroMap: { verdict: 'not measured yet', trusted: false, k: NaN, r2: NaN, n: 0, sign: 1, scale: 1, component: null },
  res: Object.fromEntries(['ax', 'ay', 'az', 'ra', 'rb', 'rg', 'alpha', 'beta', 'gamma'].map((k) => [k, new M.Resolution()])),
  cand: null, flat: false,
  settings: { deadDeg: 2, maxDeg: 25, expo: 1.5, filter: 'ema60', yawRateDeg: 75, speed: 14, gravityTauMs: 60, cwhTauS: 0.25 },
  rafDeltas: [], frameNo: 0, dpr: 1,
  calib: null, run: null, runs: [], restRun: null, rests: [], idle: null, idles: [], vis: [], restored: null,
  audio: { ctx: null, state: 'not started', session: 'audioSession' in navigator ? 'supported' : 'not supported', tones: [] },
  vib: { supported: 'vibrate' in navigator, calls: [] },
  wake: { supported: 'wakeLock' in navigator, state: 'not requested', sentinel: null, releases: 0 },
  answers: {}, typed: {}, auto: {},
  rec: { ori: [], mot: [], max: 60000 },
};

// ---------- sensors ----------
function tsOf(e, th) {   // the event's own time stamp when it is on the performance.now() clock, else the handler time
  const t = e && e.timeStamp;
  if (fin(t) && t > 0 && t <= th + 50 && t > th - 10000) return t;
  S.tsFallback++; return th;
}
function countIn(win, th) { cap(win, th, 2000); while (win.length && th - win[0] > 5000) win.shift(); }
function keep(buf, th, ms = 700) { while (buf.length && th - buf[0][0] > ms) buf.shift(); }
const recording = () => !!(S.run || S.restRun || S.calib);

function onOri(e, th = now()) {
  if (e.alpha === null && e.beta === null && e.gamma === null) { S.nulls.ori++; return; }
  const s = { th, te: tsOf(e, th), alpha: +e.alpha || 0, beta: +e.beta || 0, gamma: +e.gamma || 0, absolute: !!e.absolute };
  S.ori = s; S.counts.ori++; countIn(S.win.ori, th);
  S.res.alpha.push(s.alpha); S.res.beta.push(s.beta); S.res.gamma.push(s.gamma);
  S.buf.q.push([th, M.quatFromEuler(s.alpha, s.beta, s.gamma), s.beta, s.gamma]); keep(S.buf.q, th);
  if (recording() && S.rec.ori.length < S.rec.max) S.rec.ori.push([rd(th, 1), rd(s.te, 1), rd(s.alpha, 2), rd(s.beta, 2), rd(s.gamma, 2)]);
}

function onMot(e, th = now()) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null || a.x === undefined) { S.nulls.mot++; return; }
  const aig = [+a.x, +a.y, +a.z], r = e.rotationRate;
  const rr = r && r.alpha !== null && r.alpha !== undefined ? { alpha: +r.alpha, beta: +r.beta, gamma: +r.gamma } : null;
  const prev = S.mot, dtMs = prev ? th - prev.th : 0, dtS = M.clamp(dtMs / 1000, 0, 0.1);
  if (!S.gEma) S.gEma = aig.slice();
  else { const k = 1 - Math.exp(-Math.max(0, dtMs) / S.settings.gravityTauMs); for (let i = 0; i < 3; i++) S.gEma[i] += k * (aig[i] - S.gEma[i]); }
  S.buf.g.push([th, aig]); keep(S.buf.g, th);
  S.res.ax.push(aig[0]); S.res.ay.push(aig[1]); S.res.az.push(aig[2]);
  if (rr) { S.res.ra.push(rr.alpha); S.res.rb.push(rr.beta); S.res.rg.push(rr.gamma); }
  if (rr && prev) gyroWindow(aig, rr, th, dtS);
  if (S.cal && S.cal.g0 && prev) {
    const meas = M.inPlaneRatio(aig) >= 0.25 ? M.gwhDeg(aig, S.cal.g0) : null;
    if (rr && S.gyroLock) {
      const g = S.gyroLock;
      S.cwh = M.complementaryStep(S.cwh, g.sign * g.scale * -rr[g.component], dtS, meas, S.settings.cwhTauS);
    } else if (meas !== null) S.cwh = meas;   // B is gravity only until the gyro mapping is measured: no axis is assumed
  }
  if (S.restRun && S.restRun.phase === 'go') {
    const R = S.restRun; R.ax.push(aig[0]); R.ay.push(aig[1]); R.az.push(aig[2]);
    if (rr) { R.ra.push(rr.alpha); R.rb.push(rr.beta); R.rg.push(rr.gamma); }
  }
  S.mot = { th, te: tsOf(e, th), aig, rr, interval: e.interval };
  S.counts.mot++; countIn(S.win.mot, th); if (fin(e.interval)) cap(S.intervals, e.interval, 600);
  if (recording() && S.rec.mot.length < S.rec.max) {
    S.rec.mot.push([rd(th, 1), rd(S.mot.te, 1), ...aig.map((v) => rd(v, 3)), ...(rr ? [rd(rr.alpha, 2), rd(rr.beta, 2), rd(rr.gamma, 2)] : [null, null, null]), rd(e.interval, 4)]);
  }
}

// 100 ms windows: per rotationRate component, x = the steer-right change it predicts (-rate * dt), y = the change of the raw
// in-plane gravity angle over the same window. The component whose slope fits best carries the rotation about the screen normal;
// its slope gives the sign and the unit (M.gyroMappingBest). Needs no calibration.
function gyroWindow(aig, rr, th, dtS) {
  const raw = M.inPlaneRatio(aig) >= 0.35 ? M.gwhDeg(aig, [1, 0, 0]) : null;
  if (raw === null) { S.gw = null; return; }
  if (!S.gw) { S.gw = { t0: th, xa: 0, xb: 0, xg: 0, y0: raw }; return; }
  const w = S.gw; w.xa += -rr.alpha * dtS; w.xb += -rr.beta * dtS; w.xg += -rr.gamma * dtS;
  if (th - w.t0 >= 100) {
    const y = M.wrapDeg(raw - w.y0);
    if (Math.max(Math.abs(w.xa), Math.abs(w.xb), Math.abs(w.xg), Math.abs(y)) >= 1) {
      cap(S.gyro.alpha, w.xa, 400); cap(S.gyro.beta, w.xb, 400); cap(S.gyro.gamma, w.xg, 400); cap(S.gyro.ys, y, 400);
    }
    S.gw = { t0: th, xa: 0, xb: 0, xg: 0, y0: raw };
    S.gyroMap = M.gyroMappingBest(S.gyro, S.gyro.ys, { minN: 12, minR2: 0.8 });
    // A phone's axes do not change mid-session: once a fit is trusted, B keeps using it even when the live fit dips below the
    // threshold for a while (0.67 deg accelerometer steps did that in the smoke test); a better trusted fit replaces it.
    if (S.gyroMap.trusted && (!S.gyroLock || S.gyroMap.component === S.gyroLock.component || S.gyroMap.r2 > S.gyroLock.r2 + 0.05)) S.gyroLock = { ...S.gyroMap };
  }
}

// ---------- calibration (the mean of the last 500 ms, with its spread) and the five candidates ----------
// measureNeutral() only measures; commitCal() makes a pose the neutral. A pose that moved too much is recorded as rejected and
// never replaces the current neutral (review r2 N8).
function calSummary(c, reason, rejected = false) {
  return { t: rd(c.t, 1), reason, rejected, g0: c.g0 && c.g0.map((v) => rd(v, 3)), e0: c.e0 && { alpha: rd(c.e0.alpha, 2), beta: rd(c.e0.beta, 2), gamma: rd(c.e0.gamma, 2) },
    angle: c.angle, conv: c.conv, convFrom: c.convFrom, screenCheck: c.screenCheck, tiltBack: rd(c.tiltBack, 1), spreadDeg: rd(c.spread, 2), samples: c.samples };
}
function commitCal(c, reason) { S.cal = { ...c, reason }; S.cwh = 0; S.cals.push(calSummary(c, reason)); }
function calibrateNow(reason) { const c = measureNeutral(); if (!c) return false; commitCal(c, reason); return true; }
function measureNeutral() {
  if (!S.gEma && !S.ori) return null;
  const t = now(), gw = S.buf.g.filter((s) => t - s[0] <= 500), qw = S.buf.q.filter((s) => t - s[0] <= 500);
  let g0 = null, q0 = null, e0 = null, spread = 0;
  if (gw.length >= 5) { g0 = [0, 1, 2].map((i) => M.mean(gw.map((s) => s[1][i]))); spread = Math.max(...gw.map((s) => M.vAngleDeg(s[1], g0))); }
  else if (S.gEma) g0 = S.gEma.slice();
  if (qw.length >= 3) {
    q0 = M.quatMean(qw.map((s) => s[1])); spread = Math.max(spread, ...qw.map((s) => M.quatAngleDeg(s[1], q0)));
    e0 = { alpha: S.ori.alpha, beta: M.mean(qw.map((s) => s[2])), gamma: M.mean(qw.map((s) => s[3])) };
  } else if (S.ori) { q0 = M.quatFromEuler(S.ori.alpha, S.ori.beta, S.ori.gamma); e0 = { alpha: S.ori.alpha, beta: S.ori.beta, gamma: S.ori.gamma }; }
  const angle = S.angle; let conv = 0, convFrom = 'unclear', screenCheck = 'unknown';
  if (g0 && q0) { const R = M.matFromQuat(q0), up = [R[2][0], R[2][1], R[2][2]]; conv = M.convFromOrientation(g0, up); convFrom = 'orientation'; screenCheck = M.screenAngleCheck(up, angle); }
  if (g0 && conv === 0) { conv = M.gravityConvention(g0, angle); convFrom = conv ? 'screen angle' : 'unclear'; }
  const tiltBack = g0 ? Math.asin(M.clamp(Math.abs(g0[2]) / (M.vLen(g0) || 1), 0, 1)) / M.DEG : null;
  return { t, g0, q0, e0, angle, conv, convFrom, screenCheck, tiltBack, spread, lean0: g0 ? M.leanAbsDeg(g0, angle, conv || 1) : 0, samples: [gw.length, qw.length] };
}

function candidates() {
  const c = S.cal; if (!c) return null;
  const out = { GWH: null, CWH: null, QTW: null, GLN: null, EUL: null };
  if (S.gEma && c.g0) {
    S.flat = M.inPlaneRatio(S.gEma) < 0.25;
    out.GWH = S.flat ? null : M.gwhDeg(S.gEma, c.g0);
    out.GLN = M.leanAbsDeg(S.gEma, c.angle, c.conv || 1) - c.lean0;
    out.CWH = S.cwh;
  }
  if (S.ori && c.q0) {
    out.QTW = M.qtwDeg(M.quatFromEuler(S.ori.alpha, S.ori.beta, S.ori.gamma), c.q0);
    out.EUL = M.eulDeg(S.ori, c.e0, c.angle);
  }
  return out;
}

// ---------- the frame loop ----------
let lastRaf = null;
function frame(rafTs) {
  const t = now();
  if (lastRaf !== null) { const d = rafTs - lastRaf; if (d > 0 && d < 250) cap(S.rafDeltas, d, 1200); }
  lastRaf = rafTs; S.frameNo++;
  const cand = candidates(); if (cand) S.cand = cand;
  if (S.calib) calibStep(t);
  if (S.restRun) restStep(t, cand);
  if (S.run) runStep(t, rafTs, cand);
  if (S.idle) idleStep(t);
  if (S.frameNo % 4 === 0) paintLive();
  if (S.frameNo % 12 === 0) paintRaw();
  if (S.run) draw();
  requestAnimationFrame(frame);
}

function calibStep(t) {
  const C = S.calib;
  if (C.phase === 'still' && t >= C.until) {
    const c = measureNeutral();
    if (!c) { msg('No sensor data yet: press 1. Start and allow motion first.'); S.calib = null; return; }
    if (c.spread > 1.5) { S.cals.push(calSummary(c, 'calibrate', true)); msg(`You moved while it measured (${c.spread.toFixed(1)} deg). Hold still and press 2. Calibrate again.`); S.calib = null; return; }
    commitCal(c, 'calibrate');
    C.phase = 'wiggle'; C.until = t + 4000; msg('Now turn the phone like a steering wheel: left, right, left, right (4 s).');
  } else if (C.phase === 'wiggle' && t >= C.until) {
    S.calib = null;
    msg(S.gyroLock ? 'Calibrated, and the gyro is found. Next: 3. Rest test.' : 'Calibrated, but the gyro is not found yet: press 2. Calibrate again and turn the phone a little further and faster.');
  }
}

// ---------- rest test ----------
function startRest(o = {}) {
  if (!S.started) return msg('Press 1. Start first.');
  S.restRun = { phase: 'count', goAt: now() + (o.countdownMs ?? 3000), durMs: o.durationMs ?? 5000, endAt: 0, v: Object.fromEntries(CANDS.map((k) => [k, []])), ax: [], ay: [], az: [], ra: [], rb: [], rg: [] };
  msg('Rest test: prop the phone up in landscape (against a mug or a book) or hold it as still as you can. Starts in 3 s, lasts 5 s.');
}
function restStep(t, cand) {
  const R = S.restRun;
  if (R.phase === 'count') {
    if (t >= R.goAt) {
      if (!calibrateNow('rest')) { S.restRun = null; msg('No sensor data: press 1. Start and allow motion, then try again.'); return; }
      R.phase = 'go'; R.endAt = t + R.durMs; msg('Measuring: keep still for 5 s.');
    }
    return;
  }
  if (cand) for (const k of CANDS) if (fin(cand[k])) R.v[k].push(cand[k]);
  if (t < R.endAt) return;
  const g = S.gyroLock, comp = g ? { alpha: R.ra, beta: R.rb, gamma: R.rg }[g.component] : null;
  const res = { t: rd(t, 0), std: {}, p2p: {}, n: {}, hold: holdText(),
    accStd: [R.ax, R.ay, R.az].map((a) => rd(M.std(a), 4)), gyroStdRaw: [R.ra, R.rb, R.rg].map((a) => rd(M.std(a), 4)),
    gyroScreenNormalStdDegS: comp ? rd(M.std(comp) * g.scale, 4) : null, gyroBiasRaw: [R.ra, R.rb, R.rg].map((a) => rd(M.mean(a), 4)) };
  for (const k of CANDS) { const a = R.v[k]; res.std[k] = rd(M.std(a), 4); res.p2p[k] = a.length ? rd(Math.max(...a) - Math.min(...a), 3) : null; res.n[k] = a.length; }
  S.rests.push(res); S.restRun = null; save();
  msg('Rest test done (the numbers are on the card, step 7). Next: 4. Slalom.');
}

// ---------- slalom runs ----------
function startRun(id, o = {}) {
  if (!S.started) return msg('Press 1. Start first.');
  if (S.run || !CANDS.includes(id)) return;
  if (id === 'CWH' && !S.gyroLock) return msg('B needs the gyro first: press 2. Calibrate and turn the phone like a steering wheel when asked.');
  const sl = new Slalom(makeCourse(), { speed: +S.settings.speed, yawRateDeg: +S.settings.yawRateDeg, maxS: o.maxS ?? 60 });
  S.run = { id, phase: 'count', goAt: now() + (o.countdownMs ?? 3000), sl, filt: M.FILTERS[S.settings.filter](), filter: S.settings.filter,
    settings: { ...S.settings }, frames: [], ages: [], agesTs: [], nulls: 0, orientationChanges: 0, startedAt: new Date().toISOString(), prev: null, lastF: null, lastS: 0, gyroMappedFrames: 0, calAttempts: 0, retake: '' };
  showOverlay(true); $('ovbtn').textContent = 'Stop';
}
function runStep(t, rafTs, cand) {
  const R = S.run;
  if (R.phase === 'count') {
    ovText(`${LETTER[R.id]}  ${NAMES[R.id]}\n${R.retake || 'Hold the phone as you will play, still.'}\nStarting in ${Math.max(1, Math.ceil((R.goAt - t) / 1000))}`);
    if (t >= R.goAt) {
      const c = measureNeutral();
      if (!c) { S.run = null; showOverlay(false); msg('No sensor data: press 1. Start and allow motion, then try the run again.'); return; }
      R.calAttempts++;
      // the neutral pose must be taken while the phone is still: up to 3 tries; a shaky last try starts anyway and says so
      if (c.spread > 1.5 && R.calAttempts < 3) { S.cals.push(calSummary(c, 'run ' + R.id, true)); R.goAt = t + 1500; R.retake = `You moved (${c.spread.toFixed(1)} deg): hold still.`; return; }
      commitCal(c, 'run ' + R.id); R.calSpread = c.spread; R.unsteady = c.spread > 1.5;
      R.phase = 'go'; R.prev = t; R.filt.reset();
      ovText(R.unsteady ? `Not quite still (${c.spread.toFixed(1)} deg): the run starts anyway, the card notes it.` : ''); R.noteUntil = R.unsteady ? t + 2500 : 0;
    }
    return;
  }
  if (R.phase !== 'go') return;
  if (R.noteUntil && t > R.noteUntil) { ovText(''); R.noteUntil = 0; }
  const raw = cand ? cand[R.id] : null, dt = (t - R.prev) / 1000; R.prev = t;
  let s = 0;
  if (fin(raw)) { R.lastF = R.filt.step(raw, t); s = M.mapSteer(R.lastF, R.settings); } else R.nulls++;
  R.lastS = s; R.sl.step(s, dt);
  const src = SOURCE[R.id] === 'mot' ? S.mot : S.ori, age = src ? t - src.th : null;
  if (fin(age)) R.ages.push(age);
  if (src && fin(src.te)) R.agesTs.push(rafTs - src.te);
  R.frames.push([rd(t, 1), rd(rafTs, 1), rd(age, 2), ...CANDS.map((k) => rd(cand ? cand[k] : null, 3)), rd(R.lastF, 3), rd(s, 3), rd(R.sl.x, 2), rd(R.sl.y, 2), rd(R.sl.h, 1)]);
  if (S.gyroLock && S.mot && S.mot.rr) R.gyroMappedFrames++;   // frames on which B really had a gyro reading to fuse (review r2 N7)
  if (R.sl.done) finishRun(R.sl.finishT !== null ? 'finished' : 'time limit');
}
function finishRun(why) {
  const R = S.run; if (!R) return; S.run = null;
  const sum = R.sl.summary();
  const res = { n: S.runs.length + 1, id: R.id, letter: LETTER[R.id], filter: R.filter, settings: R.settings, why, startedAt: R.startedAt, ...sum, nulls: R.nulls,
    orientationChanges: R.orientationChanges, calSpread: rd(R.calSpread, 2), calAttempts: R.calAttempts, unsteady: !!R.unsteady, ageMedian: rd(M.median(R.ages), 2), ageP95: rd(M.percentile(R.ages, 95), 2),
    stampAgeMedian: rd(M.median(R.agesTs), 2), stampAgeP95: rd(M.percentile(R.agesTs, 95), 2), lag: runLags(R),
    gyroMappedShare: R.frames.length ? rd(R.gyroMappedFrames / R.frames.length, 3) : null, frames: R.frames };
  S.runs.push(res); save();
  ovText(`${LETTER[R.id]}  ${NAMES[R.id]}: ${gatesText(res)}` + (fin(sum.lapS) ? `, ${sum.lapS.toFixed(1)} s` : '') +
    `, ${sum.corrections} corrections` + (why === 'finished' ? '' : ` (${why})`) + (R.orientationChanges ? `\nThe screen rotated ${R.orientationChanges}x` : '') + '\nTap Close');
  $('ovbtn').textContent = 'Close';
  paintRuns();
}
// Filter lag per setting on this run's own raw signal, and each candidate's lag against the orientation twist (C).
function runLags(R) {
  const out = { filters: {}, vsQTW: {} }, step = 4, ts = [], raw = [];
  for (const f of R.frames) { const v = f[COL[R.id]]; if (fin(v)) { ts.push(f[0]); raw.push(v); } }
  if (ts.length >= 60) {
    const A = M.resample(ts, raw, step);
    for (const name of Object.keys(M.FILTERS)) {
      const f = M.FILTERS[name](), fl = raw.map((v, i) => f.step(v, ts[i])), L = M.lagMs(A, M.resample(ts, fl, step), step, 300, 0);
      out.filters[name] = L ? rd(L.lagMs, 1) : null;
    }
  }
  for (const k of CANDS) {
    if (k === 'QTW') continue;
    const t2 = [], a = [], b = [];
    for (const fr of R.frames) { const q = fr[COL.QTW], v = fr[COL[k]]; if (fin(q) && fin(v)) { t2.push(fr[0]); a.push(q); b.push(v); } }
    const L = t2.length >= 60 ? M.lagMs(M.resample(t2, a, step), M.resample(t2, b, step), step, 300, -300) : null;
    out.vsQTW[k] = L ? rd(L.lagMs, 1) : null;
  }
  return out;
}

// ---------- idle (screen dimming), sound, vibration, wake lock ----------
function startIdle(o = {}) {
  if (!S.started) return msg('Press 1. Start first.');
  S.idle = { t0: now(), end: now() + (o.durationMs ?? 60000), wakeAtStart: S.wake.state, touched: 0, hidden: 0, autoLock: S.answers.autoLock || '?' };
  msg('Idle check: do not touch the screen for 60 s and watch whether it dims.' + (S.answers.autoLock === '30 s' ? '' : ' For a fair check, set Auto-Lock to 30 seconds first and tell the page (step 5).'));
}
function idleStep(t) {
  const I = S.idle, left = Math.ceil((I.end - t) / 1000);
  if (left > 0) { if (S.frameNo % 30 === 0) msg(`Idle check: ${left} s left. Do not touch the screen.`); return; }
  S.idles.push({ durMs: rd(I.end - I.t0, 0), wakeAtStart: I.wakeAtStart, wakeAtEnd: S.wake.state, touched: I.touched, hidden: I.hidden, autoLock: I.autoLock });
  S.idle = null; save(); msg('Idle check done: did the screen dim? Answer with the buttons.');
}
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { S.audio.state = 'no Web Audio'; return; }
    if (!S.audio.ctx) S.audio.ctx = new AC();
    S.audio.ctx.resume().then(() => { S.audio.state = S.audio.ctx.state; }, (e) => { S.audio.state = 'resume failed: ' + (e && e.name); });
    S.audio.state = S.audio.ctx.state;
    tone(0.12, 660, 0.08);
  } catch (e) { S.audio.state = 'error: ' + (e && e.name); }
}
function tone(dur, freq, gain) {
  const c = S.audio.ctx; if (!c) return false;
  const o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime;
  o.frequency.value = freq; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.setValueAtTime(gain, t0 + dur - 0.05); g.gain.linearRampToValueAtTime(0, t0 + dur);
  o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  return true;
}
function playTone(mode) {
  let session = 'n/a';
  if ('audioSession' in navigator) { try { navigator.audioSession.type = mode; session = navigator.audioSession.type; } catch (e) { session = 'error ' + (e && e.name); } }
  if (!S.audio.ctx) unlockAudio();
  else if (S.audio.ctx.state !== 'running') S.audio.ctx.resume();
  const ok = tone(0.5, 440, 0.3);
  S.audio.tones.push({ t: rd(now(), 0), mode, session, ctx: S.audio.ctx ? S.audio.ctx.state : 'none', ok });
}
function vibrate() {
  let r = 'no vibration API in this browser (normal on iPhone)';
  if (S.vib.supported) { try { r = 'returned ' + String(navigator.vibrate(200)); } catch (e) { r = 'error ' + (e && e.name); } }
  S.vib.calls.push(r); msg('Vibrate: ' + r);
}
async function requestWake() {
  if (!S.wake.supported) { S.wake.state = 'not supported'; return; }
  try {
    const s = await navigator.wakeLock.request('screen');
    S.wake.sentinel = s; S.wake.state = 'active';
    s.addEventListener('release', () => { S.wake.state = 'released'; S.wake.releases++; });
  } catch (e) { S.wake.state = 'error: ' + (e && e.name); }
}

// ---------- start (one tap: permission, sound, wake lock; everything gesture-bound runs before the first await) ----------
async function start() {
  if (S.starting || S.started) return;
  S.starting = true; $('start').disabled = true;
  const ask = (C, key) => {
    if (!C) { S.perm[key] = 'API missing'; return Promise.resolve(); }
    if (typeof C.requestPermission !== 'function') { S.perm[key] = 'no prompt needed'; return Promise.resolve(); }
    S.perm.prompted = true;
    return C.requestPermission().then((v) => { S.perm[key] = v; }, (e) => { S.perm[key] = 'error: ' + ((e && e.name) || e); });
  };
  const asked = Promise.all([ask(window.DeviceMotionEvent, 'motion'), ask(window.DeviceOrientationEvent, 'orientation')]);
  unlockAudio(); requestWake();
  // a question that never gets an answer must not leave Start disabled for good (review r2, UX-5 edge)
  const answered = await Promise.race([asked.then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))]);
  if (!answered) for (const k of ['motion', 'orientation']) if (S.perm[k] === 'not asked') S.perm[k] = 'no answer after 8 s';
  const ok = (v) => v === 'granted' || v === 'no prompt needed';
  if (!ok(S.perm.motion) && !ok(S.perm.orientation)) {
    S.starting = false; $('start').disabled = false;
    msg(`Motion access: ${S.perm.motion}. Tap 1. Start again. If no question appears: close this tab, quit Safari (swipe it away), open the link again and tap Allow.`);
    return;
  }
  if (!S.listening) { window.addEventListener('deviceorientation', (e) => onOri(e)); window.addEventListener('devicemotion', (e) => onMot(e)); S.listening = true; }
  S.started = true; S.starting = false; S.listenT = now();
  setTimeout(() => {
    if (S.counts.mot + S.counts.ori === 0) msg('No sensor data after 2.5 s. Open the link in Safari itself (not inside another app), and allow motion access.');
    else msg('Sensors running. Next: 2. Calibrate.');
  }, 2500);
}

// ---------- screen orientation, visibility, touch ----------
function onAngle() { const a = screenAngle(); if (a !== S.angle) { S.angle = a; S.orientationChanges++; if (S.run) S.run.orientationChanges++; } }
if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', onAngle);
window.addEventListener('orientationchange', onAngle);
window.addEventListener('resize', () => { onAngle(); if (S.run) resizeCanvas(); });
document.addEventListener('visibilitychange', () => {
  S.vis.push([rd(now(), 0), document.visibilityState]);
  if (document.hidden) { if (S.run) finishRun('page hidden'); if (S.idle) S.idle.hidden++; }
  else if (S.started && S.wake.state === 'released') requestWake();
});
document.addEventListener('pointerdown', () => { if (S.idle) S.idle.touched++; }, true);

// ---------- drawing ----------
function showOverlay(on) { $('ov').classList.toggle('on', on); if (on) resizeCanvas(); }
function resizeCanvas() { const cv = $('cv'), d = Math.min(devicePixelRatio || 1, 2); S.dpr = d; cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d); }
function ovText(t) { const el = $('ovtxt'); if (el.textContent !== t) el.textContent = t; }
function draw() {
  const R = S.run, cv = $('cv'), g = cv.getContext('2d'), W = cv.width, H = cv.height, d = S.dpr;
  const sl = R.sl, gates = sl.course.gates, sc = (Math.min(W, H) * 0.75) / 45;
  const X = (x) => W / 2 + (x - sl.x) * sc, Y = (y) => H * 0.72 - (y - sl.y) * sc;
  g.fillStyle = '#0c4a73'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = d;
  for (let y = Math.floor((sl.y - 30) / 10) * 10; y < sl.y + 80; y += 10) { g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(W, Y(y)); g.stroke(); }
  g.strokeStyle = 'rgba(255,200,80,0.35)'; g.lineWidth = 2 * d;
  for (const x of [-sl.course.halfWidthM, sl.course.halfWidthM]) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), H); g.stroke(); }
  for (let i = Math.max(0, sl.next - 2); i < Math.min(gates.length, sl.next + 4); i++) {
    const q = gates[i], yy = Y(q.y), xl = X(q.x - q.width / 2), xr = X(q.x + q.width / 2), next = i === sl.next;
    g.strokeStyle = next ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.25)'; g.setLineDash([6 * d, 6 * d]);
    g.beginPath(); g.moveTo(xl, yy); g.lineTo(xr, yy); g.stroke(); g.setLineDash([]);
    for (const [x, c] of [[xl, '#e53935'], [xr, '#43a047']]) { g.fillStyle = c; g.beginPath(); g.arc(x, yy, (next ? 0.9 : 0.7) * sc, 0, 2 * Math.PI); g.fill(); }
  }
  const fy = Y(sl.course.finishY); if (fy > -10 && fy < H + 10) { g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(0, fy - 2 * d, W, 4 * d); }
  g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 3 * d; g.beginPath();
  sl.trail.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.lineTo(X(sl.x), Y(sl.y)); g.stroke();
  g.save(); g.translate(X(sl.x), Y(sl.y)); g.rotate(sl.h * M.DEG); g.fillStyle = '#ffd54f';
  g.beginPath(); g.moveTo(0, -1.6 * sc); g.lineTo(0.7 * sc, 1.2 * sc); g.lineTo(-0.7 * sc, 1.2 * sc); g.closePath(); g.fill(); g.restore();
  g.fillStyle = '#fff'; g.font = `${Math.round(16 * d)}px system-ui, sans-serif`; g.textBaseline = 'top';
  g.fillText(`${LETTER[R.id]} ${NAMES[R.id]}   gate ${Math.min(sl.next + 1, gates.length)}/${gates.length}   ${sl.t.toFixed(1)} s`, 24 * d, 14 * d);
  const bw = Math.min(W * 0.4, 300 * d), by = H - 28 * d;
  g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(W / 2 - bw / 2, by, bw, 10 * d);
  g.fillStyle = '#4fc3f7'; g.fillRect(W / 2 + (Math.min(0, R.lastS) * bw) / 2, by, (Math.abs(R.lastS) * bw) / 2, 10 * d);
}

// ---------- texts ----------
function msg(t) { $('msg').textContent = t; }
function convText() {
  if (!S.cal) return '?';
  const c = S.cal.conv > 0 ? 'as the spec (points up)' : S.cal.conv < 0 ? 'INVERTED (points down)' : 'unclear';
  return `${c}, from ${S.cal.convFrom}`;
}
function holdText() { return S.cal && fin(S.cal.tiltBack) ? `tilt-back ${S.cal.tiltBack.toFixed(0)} deg (0 upright, 90 flat)` : '?'; }
function rates() {
  const t = now(), span = S.listenT === null ? null : Math.min(5, Math.max(0.001, (t - S.listenT) / 1000));
  const f = (w) => (span === null ? null : w.filter((x) => t - x <= 5000).length / span);
  return { ori: f(S.win.ori), mot: f(S.win.mot) };
}
function intervalText() {   // the spec says milliseconds; WebKit is reported to give seconds: show what came and what it means
  const m = M.median(S.intervals);
  if (!fin(m)) return '-';
  return m < 1 ? `${(m * 1000).toFixed(1)} ms (reported as ${m.toPrecision(3)}, i.e. in seconds)` : `${m.toFixed(1)} ms`;
}
function resolutionText() {
  const v = (...ks) => { const a = ks.map((k) => S.res[k].value).filter(fin); return a.length ? Math.min(...a) : null; };
  const acc = v('ax', 'ay', 'az'), ori = v('beta', 'gamma'), gyr = v('ra', 'rb', 'rg');
  const gIn = S.cal && S.cal.g0 ? M.vLen(S.cal.g0) * M.inPlaneRatio(S.cal.g0) : null;
  const wheel = fin(acc) && fin(gIn) && gIn > 0 ? (acc / gIn) / M.DEG : null;
  const st = (x) => (!fin(x) ? '-' : x >= 0.001 ? x.toFixed(4) : 'finer than 0.001');
  return `accel ${st(acc)} m/s2${fin(wheel) ? ` (= ${wheel.toFixed(2)} deg of A at this hold)` : ''}, orientation ${st(ori)} deg, gyro ${st(gyr)} (raw unit)`;
}
function buildLive() {
  $('live').innerHTML = CANDS.map((k) => `<div class="row"><span class="lbl">${LETTER[k]} ${NAMES[k]}</span><span class="bar"><i id="bar-${k}"></i></span><span class="num" id="num-${k}">-</span></div>`).join('');
}
function paintLive() {
  const c = S.cand, max = +S.settings.maxDeg || 25;
  for (const k of CANDS) {
    const v = c ? c[k] : null, bar = $('bar-' + k), num = $('num-' + k);
    if (fin(v)) {
      const f = M.clamp(v / max, -1, 1); bar.style.left = (f < 0 ? 50 + f * 50 : 50) + '%'; bar.style.width = Math.abs(f) * 50 + '%';
      num.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)} deg${k === 'CWH' && !S.gyroLock ? ' (no gyro yet)' : ''}`;
    } else { bar.style.width = '0'; num.textContent = !S.cal ? 'calibrate' : k === 'GWH' && S.flat ? 'too flat' : 'no data'; }
  }
  const rt = rates();
  $('status').textContent = `https ${S.secure ? 'yes' : 'NO'} | motion ${S.perm.motion} | orientation ${S.perm.orientation} | events/s: orientation ${fmt(rt.ori, 0)}, motion ${fmt(rt.mot, 0)} | frame ${fmt(M.median(S.rafDeltas.slice(-120)), 1)} ms | screen angle ${S.angle}`;
  $('flags').textContent = S.cal ? `gravity reading: ${convText()} | screen angle check: ${S.cal.screenCheck} | ${holdText()} | gyro: ${S.gyroLock ? S.gyroLock.verdict + ' (' + S.gyroLock.component + ')' : S.gyroMap.verdict}${S.flat ? ' | TOO FLAT for A' : ''}` : 'not calibrated yet';
  // Portrait Orientation Lock: the phone is held in landscape (its x axis is the more vertical one) but the screen did not turn
  if (S.ori) {
    const up = M.upFromEuler(S.ori.alpha, S.ori.beta, S.ori.gamma), warn = Math.abs(up[0]) > Math.abs(up[1]) + 0.25 && S.angle % 180 === 0;
    if (warn !== S.lockWarn) { S.lockWarn = warn; $('warn').style.display = warn ? 'block' : 'none'; if (warn) S.lockWarnCount++; }
  }
}
function paintRaw() {
  if (!$('rawbox').open) return;
  const o = S.ori, m = S.mot, f = (v) => fmt(v, 3);
  $('raw').textContent = `orientation  alpha ${o ? f(o.alpha) : '-'}  beta ${o ? f(o.beta) : '-'}  gamma ${o ? f(o.gamma) : '-'}  absolute ${o ? o.absolute : '-'}\n` +
    `accel+gravity  x ${m ? f(m.aig[0]) : '-'}  y ${m ? f(m.aig[1]) : '-'}  z ${m ? f(m.aig[2]) : '-'}  m/s2\n` +
    `rotationRate  alpha ${m && m.rr ? f(m.rr.alpha) : '-'}  beta ${m && m.rr ? f(m.rr.beta) : '-'}  gamma ${m && m.rr ? f(m.rr.gamma) : '-'}\n` +
    `interval ${m ? m.interval : '-'} | screen angle ${S.angle} | events ${S.counts.ori}/${S.counts.mot}`;
}
function gatesText(r) { return `${r.passed} of ${r.passed + r.missed} gates` + (r.notReached ? ` (${r.notReached} of ${r.gates} not reached)` : ''); }
function paintRuns() {
  $('runs').innerHTML = S.runs.map((r) => `Run ${r.n}: ${r.letter} ${NAMES[r.id]}, ${gatesText(r)}, ${fin(r.lapS) ? r.lapS.toFixed(1) + ' s' : r.why}, ${r.corrections} corrections${r.restored ? ' (restored)' : ''}`).join('<br>');
}
function paintAnswers() { $('answers').textContent = Object.entries(S.answers).map(([k, v]) => `${ANSWERS[k] || k}: ${v}`).join(' | ') || 'no answers yet'; }
function shortUA() { const u = navigator.userAgent; const m = u.match(/(iPhone OS [\d_]+|Android [\d.]+|Windows NT [\d.]+|Mac OS X [\d_]+)/); const b = u.match(/(CriOS|FxiOS|EdgiOS|Chrome|Version|Firefox)\/([\d.]+)/); return `${m ? m[1].replace(/_/g, '.') : '?'} ${b ? b[1] + ' ' + b[2] : ''}`.trim(); }

function recapText() {
  const C = { ...S.auto, ...S.typed }, rt = rates(), A = S.answers;
  // ages from the run summaries, so they survive a reload (review r2 N4): the median of the runs' medians and of their p95s
  const runStat = (src, key) => M.median(S.runs.filter((r) => SOURCE[r.id] === src).map((r) => r[key]).filter(fin));
  const fr = M.median(S.rafDeltas), rest = S.rests[S.rests.length - 1];
  const lagOf = (name) => M.median(S.runs.map((r) => r.lag && r.lag.filters[name]).filter(fin));
  const vsQ = (k) => M.median(S.runs.map((r) => r.lag && r.lag.vsQTW[k]).filter(fin));
  const stamp = (id) => M.median(S.runs.filter((r) => SOURCE[r.id] === id).map((r) => r.stampAgeMedian).filter(fin));
  const gl = S.gyroLock, L = [];
  L.push(`S1 tilt lab ${VERSION} | device clock ${new Date().toISOString()} | ${location.host}${S.restored ? ' | includes results restored after a reload' : ''}`);
  L.push(`Phone: ${C.model || '?'} | OS/browser: ${C.os || shortUA() + ' (from the browser, may be frozen)'} | GPU: ${C.gpu} | DPR ${C.dpr} | screen ${C.screen} | in a frame: ${C.inFrame ? 'YES' : 'no'}`);
  L.push(`Battery ${C.battery || C.batteryApi || '?'} | charging ${A.charging || '?'} | Low Power ${A.lpm || '?'} | brightness ${A.brightness || '?'}, auto ${A.autoBrightness || '?'} | Auto-Lock ${A.autoLock || '?'} | room ${C.room || '?'} C`);
  L.push(`https ${S.secure ? 'yes' : 'NO'} | permission: motion ${S.perm.motion}, orientation ${S.perm.orientation} | prompt seen: ${A.prompt || '?'} | orientation-lock warnings ${S.lockWarnCount}`);
  L.push(`Events/s: orientation ${fmt(rt.ori, 1)}, motion ${fmt(rt.mot, 1)} | motion interval ${intervalText()} | empty events ${S.nulls.ori}/${S.nulls.mot} | own time stamps ${S.tsFallback ? 'not usable ' + S.tsFallback + 'x' : 'ok'}`);
  L.push(`Frames: median ${fmt(fr, 2)} ms (${fmt(1000 / fr, 0)} Hz), p95 ${fmt(M.percentile(S.rafDeltas, 95), 2)} | handler to frame callback, median/p95 over runs, ms: motion ${fmt(runStat('mot', 'ageMedian'), 1)}/${fmt(runStat('mot', 'ageP95'), 1)}, orientation ${fmt(runStat('ori', 'ageMedian'), 1)}/${fmt(runStat('ori', 'ageP95'), 1)} | event stamp to frame stamp median ms: motion ${fmt(stamp('mot'), 1)}, orientation ${fmt(stamp('ori'), 1)}`);
  L.push(`Gravity reading: ${convText()} | screen angle check: ${S.cal ? S.cal.screenCheck : '?'} | ${holdText()} | gyro: ${gl ? `${gl.verdict}, in rotationRate.${gl.component} (k ${fmt(gl.k, 2)}, r2 ${fmt(gl.r2, 2)}, n ${gl.n})${gl.restored ? ', from before the reload' : ''}` : 'NOT FOUND (B was not run)'}`);
  L.push(`Resolution (smallest step seen): ${resolutionText()}`);
  L.push(rest ? `Rest noise std deg (A and D include a 60 ms gravity smoothing): ${CANDS.map((k) => `${LETTER[k]} ${fmt(rest.std[k], 3)}`).join(' ')} | accel std x/y/z ${rest.accStd.map((v) => fmt(v, 3)).join('/')} m/s2 | gyro std about the screen normal ${fmt(rest.gyroScreenNormalStdDegS, 3)} deg/s` : 'Rest noise: rest test not run');
  L.push(`Filter lag ms (on each run's own signal): ${Object.keys(M.FILTERS).map((f) => `${f} ${fmt(lagOf(f), 0)}`).join(' | ')} | lag vs C ms: ${CANDS.filter((k) => k !== 'QTW').map((k) => `${LETTER[k]} ${fmt(vsQ(k), 0)}`).join(' ')}`);
  const shown = S.runs.slice(-12);
  if (S.runs.length > shown.length) L.push(`(${S.runs.length - shown.length} earlier runs not shown here)`);
  shown.forEach((r) => L.push(`Run ${r.n} ${r.letter} ${r.filter}: ${gatesText(r)}, ${fin(r.lapS) ? r.lapS.toFixed(1) + ' s' : r.why}, ${r.corrections} corrections, offset ${fmt(r.meanAbsOffsetM, 2)} m, calibration spread ${fmt(r.calSpread, 1)} deg${r.unsteady ? ' (NOT STILL)' : ''}, rotations ${r.orientationChanges}, no data ${r.nulls}${r.id === 'CWH' ? `, gyro readings on ${fmt((r.gyroMappedShare || 0) * 100, 0)}% of frames` : ''}${r.restored ? ' (restored)' : ''}`));
  if (!S.runs.length) L.push('Runs: none yet');
  const idle = S.idles[S.idles.length - 1];
  L.push(`Screen rotations, all: ${S.orientationChanges} | wake lock: ${S.wake.state} (released ${S.wake.releases}x) | idle ${idle ? Math.round(idle.durMs / 1000) + ' s, hidden ' + idle.hidden + 'x, touched ' + idle.touched + 'x' : 'not run'}, dimmed: ${A.dimmed || '?'}`);
  L.push(`Sound: ${S.audio.state}, audioSession ${S.audio.session} | heard: silent mode off ${A.offHeard || '?'}, silent on ${A.onHeard || '?'}, silent on + play anyway ${A.onPlayback || '?'}`);
  L.push(`Vibrate: ${S.vib.calls.length ? S.vib.calls[S.vib.calls.length - 1] : S.vib.supported ? 'API present, not tried' : 'no API'} | felt: ${A.vibFelt || '?'}`);
  L.push(`Verdict: best ${A.best || '?'}, worst ${A.worst || '?'}, comfort ${C.comfort || '?'}, fun ${C.fun || '?'} | notes: ${C.notes || '-'}`);
  return L.join('\n');
}

function recordingObject() {
  return {
    kind: 's1-tilt-recording', version: VERSION, deviceClock: new Date().toISOString(), loadedAt: S.loadedAt, url: location.origin + location.pathname,
    auto: S.auto, typed: S.typed, answers: S.answers, settings: S.settings, perm: S.perm, lockWarnCount: S.lockWarnCount,
    wake: { supported: S.wake.supported, state: S.wake.state, releases: S.wake.releases }, audio: { state: S.audio.state, session: S.audio.session, tones: S.audio.tones },
    vib: S.vib, gyroMap: S.gyroMap, gyroLock: S.gyroLock, gyroPairs: S.gyro, cals: S.cals, rests: S.rests, idles: S.idles, vis: S.vis, orientationChanges: S.orientationChanges,
    rafDeltas: S.rafDeltas.map((d) => rd(d, 2)), intervals: S.intervals, counts: S.counts, nulls: S.nulls, tsFallback: S.tsFallback,
    frameCols: ['t', 'raf', 'ageMs', ...CANDS, 'filtered', 'steer', 'x', 'y', 'heading'], runs: S.runs,
    events: { oriCols: ['th', 'te', 'alpha', 'beta', 'gamma'], ori: S.rec.ori, motCols: ['th', 'te', 'ax', 'ay', 'az', 'ra', 'rb', 'rg', 'interval'], mot: S.rec.mot },
  };
}
// Results survive a reload or a tab discard: the summaries (not the raw frames) are kept in this browser for 6 hours.
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ savedAt: new Date().toISOString(), version: VERSION, runs: S.runs.map(({ frames, ...r }) => r),
      rests: S.rests, idles: S.idles, answers: S.answers, typed: S.typed, cals: S.cals, gyroLock: S.gyroLock, gyroMap: S.gyroMap,
      orientationChanges: S.orientationChanges, lockWarnCount: S.lockWarnCount }));
  } catch (e) { /* private browsing or storage full: the page works without it */ }
}
function restore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!d || !d.savedAt || Date.now() - Date.parse(d.savedAt) > 6 * 3600e3) return;
    S.restored = d.savedAt;
    S.runs = (d.runs || []).map((r) => ({ ...r, frames: [], restored: true }));
    S.rests = d.rests || []; S.idles = d.idles || []; Object.assign(S.answers, d.answers || {}); Object.assign(S.typed, d.typed || {});
    S.cals = d.cals || []; S.orientationChanges = d.orientationChanges || 0; S.lockWarnCount = d.lockWarnCount || 0;
    // the gyro mapping belongs to this phone and browser, so it stays valid after a reload (review r2 N3); a new fit replaces it
    if (d.gyroLock) S.gyroLock = { ...d.gyroLock, restored: true };
    if (d.gyroMap) S.gyroMap = d.gyroMap;
    msg(`Results from earlier (saved at ${new Date(d.savedAt).toLocaleTimeString()}) are restored. "Start over" clears them.`);
  } catch (e) { /* unreadable: start fresh */ }
}
function download() {
  const blob = new Blob([JSON.stringify(recordingObject())], { type: 'application/json' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 's1-recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
async function copyCard() {
  const t = recapText(); $('card').textContent = t;
  try { await navigator.clipboard.writeText(t); msg('Recap card copied: paste it to Claude.'); return; } catch (e) { /* fall back below */ }
  const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove(); msg(ok ? 'Recap card copied: paste it to Claude.' : 'Copy did not work: take screenshots of the card instead (it may need two).');
}

function autoConditions() {
  const c = { ua: navigator.userAgent, dpr: devicePixelRatio, screen: `${screen.width}x${screen.height}`, inner: `${innerWidth}x${innerHeight}`,
    touchPoints: navigator.maxTouchPoints, inFrame: window.top !== window.self, standalone: matchMedia('(display-mode: standalone)').matches, gpu: '?' };
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) c.gpu = 'no WebGL';
    else { const ext = gl.getExtension('WEBGL_debug_renderer_info'); c.gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
  } catch (e) { c.gpu = 'error ' + (e && e.name); }
  if (navigator.getBattery) navigator.getBattery().then((b) => { c.batteryApi = Math.round(b.level * 100) + '%' + (b.charging ? ' charging' : ''); }, () => {});
  return c;
}

function bindUi() {
  const sel = document.querySelector('select[data-s="filter"]');
  sel.innerHTML = Object.keys(M.FILTERS).map((f) => `<option value="${f}">${f}</option>`).join('');
  for (const el of document.querySelectorAll('[data-s]')) {
    el.value = S.settings[el.dataset.s];
    el.onchange = () => { const k = el.dataset.s; S.settings[k] = k === 'filter' ? el.value : +el.value; };
  }
  for (const el of document.querySelectorAll('[data-c]')) {
    if (S.typed[el.dataset.c]) el.value = S.typed[el.dataset.c];
    el.oninput = () => { S.typed[el.dataset.c] = el.value.trim(); };
    el.onchange = () => save();
  }
  for (const el of document.querySelectorAll('[data-a]')) {
    el.onclick = () => {   // a second tap on the chosen answer clears it (review r2 N11)
      const k = el.dataset.a, clear = S.answers[k] === el.dataset.v;
      if (clear) delete S.answers[k]; else S.answers[k] = el.dataset.v;
      save(); paintAnswers();
      for (const b of document.querySelectorAll(`[data-a="${k}"]`)) { const on = !clear && b === el; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    };
    const on = S.answers[el.dataset.a] === el.dataset.v; el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on));
  }
  $('runbtns').innerHTML = CANDS.map((k) => `<button data-run="${k}">${LETTER[k]} ${NAMES[k]}</button>`).join('');
  for (const el of document.querySelectorAll('[data-run]')) el.onclick = () => startRun(el.dataset.run);
  $('start').onclick = () => start();
  $('cal').onclick = () => { if (!S.started) return msg('Press 1. Start first.'); S.calib = { phase: 'still', until: now() + 1500 }; msg('Hold the phone as you will play and keep it still...'); };
  $('rest').onclick = () => startRest();
  $('t1').onclick = () => playTone('auto'); $('t2').onclick = () => playTone('auto'); $('t3').onclick = () => playTone('playback');
  $('vib').onclick = () => vibrate();
  $('idle').onclick = () => startIdle();
  $('recap').onclick = () => { $('card').textContent = recapText(); };
  $('copy').onclick = () => copyCard();
  $('dl').onclick = () => download();
  $('reset').onclick = () => {
    if (!confirm('Clear all saved results of this test and start over?')) return;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    location.reload();
  };
  $('ovbtn').onclick = () => { if (S.run) finishRun('stopped'); else showOverlay(false); };
}

window.addEventListener('error', (e) => { window.__error = String(e.message || e); });
S.auto = autoConditions();
restore();
$('ver').textContent = VERSION;
buildLive(); bindUi(); paintAnswers(); paintRuns();
if (!S.secure) msg('This page is not on https: motion sensors will not work on a phone. Open the https link.');
requestAnimationFrame(frame);
// hooks for tools/smoke-s1.mjs (the page works the same without them)
window.__lab = {
  version: VERSION, S, CANDS,
  start, calibrate: (why = 'test') => calibrateNow(why), rest: startRest, run: startRun, stop: () => finishRun('stopped'), idle: startIdle,
  feed: {
    ori: (o, th = now()) => onOri({ alpha: o.alpha, beta: o.beta, gamma: o.gamma, absolute: false, timeStamp: th }, th),
    mot: (m, th = now()) => onMot({ accelerationIncludingGravity: { x: m.aig[0], y: m.aig[1], z: m.aig[2] }, rotationRate: m.rr || null, interval: m.interval ?? 16.7, timeStamp: th }, th),
  },
  recap: recapText, recording: recordingObject,
  state: () => ({ perm: S.perm, counts: S.counts, cand: S.cand, cal: S.cal && { conv: S.cal.conv, convFrom: S.cal.convFrom, screenCheck: S.cal.screenCheck, tiltBack: S.cal.tiltBack, angle: S.cal.angle, spread: S.cal.spread },
    gyroMap: S.gyroMap, gyroLock: S.gyroLock, flat: S.flat, angle: S.angle, lockWarn: S.lockWarn, runs: S.runs.map(({ frames, ...r }) => ({ ...r, frames: (frames || []).length })), rests: S.rests,
    run: !!S.run, restRun: !!S.restRun, rates: rates(), audio: S.audio.state, wake: S.wake.state, frameMs: M.median(S.rafDeltas), started: S.started }),
};
window.__ready = true;
