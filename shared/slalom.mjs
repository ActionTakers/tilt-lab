// slalom.mjs: the buoy slalom of the S1 tilt lab: boat kinematics, gates and scoring. Pure (no DOM), so tests can drive it.
// Written 2026-11-06. Tests: tests/slalom.test.mjs.
// World: metres, x to the right, y forward (up the screen). Heading 0 = +y; positive heading turns right (towards +x).
import { DEG, clamp, histogram, mean } from './tilt-math.mjs';

// Gates alternate left and right of the centre line; the boat must cross each gate's line within its width.
export function makeCourse({ gates = 16, firstY = 40, spacing = 25, offset = 5, width = 6, halfWidthM = 18 } = {}) {
  const list = [];
  for (let k = 0; k < gates; k++) list.push({ y: firstY + k * spacing, x: k % 2 === 0 ? -offset : offset, width });
  return { gates: list, finishY: firstY + gates * spacing, halfWidthM };
}

export class Slalom {
  constructor(course, { speed = 14, yawRateDeg = 75, maxS = 60 } = {}) {
    Object.assign(this, { course, speed, yawRateDeg, maxS });
    this.reset();
  }
  reset() {
    Object.assign(this, { x: 0, y: 0, h: 0, t: 0, next: 0, passed: 0, missed: 0, done: false, finishT: null,
      corrections: 0, lastSign: 0, steer: [], offsets: [], offCourseS: 0, trail: [] });
  }
  // s: steering value in [-1, 1]; dtS: seconds since the last step (clamped to 0.1 s so a stalled frame cannot teleport the boat)
  step(s, dtS) {
    if (this.done) return;
    dtS = clamp(dtS, 0, 0.1); s = clamp(Number.isFinite(s) ? s : 0, -1, 1);
    const { gates, finishY, halfWidthM } = this.course;
    this.h += s * this.yawRateDeg * dtS;
    const v = this.speed * (Math.abs(this.x) > halfWidthM ? 0.5 : 1);   // a soft wall: off the course the boat slows down
    const px = this.x, py = this.y;
    this.x += v * Math.sin(this.h * DEG) * dtS; this.y += v * Math.cos(this.h * DEG) * dtS; this.t += dtS;
    if (Math.abs(this.x) > halfWidthM) this.offCourseS += dtS;
    while (this.next < gates.length && py < gates[this.next].y && this.y >= gates[this.next].y) {
      const g = gates[this.next], f = (g.y - py) / (this.y - py), xc = px + (this.x - px) * f, off = xc - g.x;
      this.offsets.push(off);
      if (Math.abs(off) <= g.width / 2) this.passed++; else this.missed++;
      this.next++;
    }
    // a correction is a change of steering direction beyond +-0.15 (hysteresis, so sensor noise around 0 does not count)
    const sg = s > 0.15 ? 1 : s < -0.15 ? -1 : 0;
    if (sg !== 0) { if (this.lastSign !== 0 && sg !== this.lastSign) this.corrections++; this.lastSign = sg; }
    this.steer.push(s);
    if (this.trail.length === 0 || this.t - this.trail[this.trail.length - 1][2] > 0.05) { this.trail.push([this.x, this.y, this.t]); if (this.trail.length > 160) this.trail.shift(); }
    if (this.y >= finishY) { this.done = true; this.finishT = this.t; }
    else if (this.t >= this.maxS) this.done = true;
  }
  summary() {
    const n = this.course.gates.length;
    return {
      gates: n, passed: this.passed, missed: this.missed, notReached: n - this.next,
      lapS: this.finishT, timeS: this.t, corrections: this.corrections,
      meanAbsOffsetM: this.offsets.length ? mean(this.offsets.map(Math.abs)) : null,
      histogram: histogram(this.steer, -1, 1, 10), maxAbsSteer: this.steer.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
      offCourseS: this.offCourseS,
    };
  }
}

// A reference controller for tests and for the demo mode: steer towards the next gate's centre.
export function autopilot(sl, gainPerDeg = 1 / 30) {
  const g = sl.course.gates[sl.next];
  const tx = g ? g.x : 0, ty = g ? g.y : sl.course.finishY + 50;
  const want = Math.atan2(tx - sl.x, ty - sl.y) / DEG;
  const err = ((((want - sl.h) + 180) % 360) + 360) % 360 - 180;
  return clamp(err * gainPerDeg, -1, 1);
}
