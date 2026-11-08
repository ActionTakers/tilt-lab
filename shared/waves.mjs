// waves.mjs: ONE Gerstner wave set for the water shader (S2) and the boat's buoyancy (S3), so the boat rides the waves you see.
// Written 2026-11-08. Tests: `node --test tests/` (tests/waves.test.mjs); the smoke test
// (tools/smoke-s2.mjs) also renders WAVE_GLSL on the GPU and compares it with displace() below.
// Pure module: no DOM, no three.js. World frame: y up, the sea at y = 0, x and z horizontal. Metres, seconds, radians.
//
// Gerstner (GPU Gems 1, ch. 1): a grid point p0 = (x0, z0) moves to
//   x = x0 + sum Q_i a_i Dx_i cos(ph_i),  y = sum a_i sin(ph_i),  z = z0 + sum Q_i a_i Dz_i cos(ph_i),
//   ph_i = k_i (D_i . p0) - w_i t + p_i,  deep-water dispersion w_i^2 = g k_i.
// sum Q_i k_i a_i <= 1 keeps crests from looping over; makeWaves() sets it to `steep`.

export const G = 9.81;
export const MAXW = 8;   // the shader's array size; makeWaves() refuses more

function mulberry32(seed) {   // small deterministic generator: the same seed gives the same sea on every device
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// count waves, wavelengths from baseLength down by `ratio`, amplitude in proportion to wavelength (so each wave has the same
// slope), directions within +-spreadDeg/2 of windDeg (0 = travelling toward +x, 90 = toward +z).
export function makeWaves({ count = 4, seed = 7, baseLength = 28, ratio = 0.62, amp = 0.55, steep = 0.55, windDeg = 25, spreadDeg = 60 } = {}) {
  if (!(count >= 1 && count <= MAXW)) throw new Error(`count must be 1..${MAXW}`);
  const rnd = mulberry32(seed), out = [];
  for (let i = 0; i < count; i++) {
    const L = baseLength * ratio ** i, k = (2 * Math.PI) / L, a = amp * (L / baseLength);
    const dirDeg = windDeg + (rnd() - 0.5) * spreadDeg, d = (dirDeg * Math.PI) / 180;
    out.push({ L, k, a, w: Math.sqrt(G * k), dx: Math.cos(d), dz: Math.sin(d), p: rnd() * 2 * Math.PI, q: 0 });
  }
  const ka = out.reduce((s, v) => s + v.k * v.a, 0);
  for (const v of out) v.q = steep / ka;   // then sum q k a = steep exactly
  return out;
}

export function steepness(waves) { return waves.reduce((s, v) => s + v.q * v.k * v.a, 0); }

// Position, normal and Jacobian of the grid point (x0, z0) at time t. `fade` scales every amplitude (the shader fades waves out
// with distance); buoyancy uses fade 1. The Jacobian det(d(x,z)/d(x0,z0)) falls toward 0 where crests pinch: foam.
export function displace(waves, x0, z0, t, fade = 1) {
  let x = x0, y = 0, z = z0;
  let Tx = 1, Ty = 0, Tz = 0, Bx = 0, By = 0, Bz = 1;   // d/dx0 and d/dz0 of the position
  for (const v of waves) {
    const ph = v.k * (v.dx * x0 + v.dz * z0) - v.w * t + v.p, s = Math.sin(ph), c = Math.cos(ph);
    const a = v.a * fade, qa = v.q * a, ka = v.k * a, qka = v.q * ka;
    x += qa * v.dx * c; z += qa * v.dz * c; y += a * s;
    Tx -= qka * v.dx * v.dx * s; Ty += ka * v.dx * c; Tz -= qka * v.dx * v.dz * s;
    Bx -= qka * v.dx * v.dz * s; By += ka * v.dz * c; Bz -= qka * v.dz * v.dz * s;
  }
  // normal = B x T (y up: z x x = +y)
  let nx = By * Tz - Bz * Ty, ny = Bz * Tx - Bx * Tz, nz = Bx * Ty - By * Tx;
  const n = Math.hypot(nx, ny, nz) || 1; nx /= n; ny /= n; nz /= n;
  return { x, y, z, nx, ny, nz, jac: Tx * Bz - Bx * Tz, Tx, Tz, Bx, Bz };
}

// Height of the sea under the WORLD point (x, z): Gerstner moves points sideways, so find the grid point that lands on (x, z) with
// Newton steps on the horizontal map (its Jacobian is jac; a plain fixed-point step where jac is near 0), then return its height
// and normal. err = the remaining miss in metres.
export function surfaceAt(waves, x, z, t, iters = 4) {
  let x0 = x, z0 = z, d = displace(waves, x0, z0, t);
  for (let i = 0; i < iters; i++) {
    const ex = x - d.x, ez = z - d.z;
    if (Math.abs(d.jac) > 0.05) { x0 += (d.Bz * ex - d.Bx * ez) / d.jac; z0 += (d.Tx * ez - d.Tz * ex) / d.jac; }
    else { x0 += ex; z0 += ez; }
    d = displace(waves, x0, z0, t);
  }
  return { y: d.y, nx: d.nx, ny: d.ny, nz: d.nz, err: Math.hypot(d.x - x, d.z - z) };
}
export const heightAt = (waves, x, z, t, iters = 4) => surfaceAt(waves, x, z, t, iters).y;

// Uniform arrays for the shader: uWA[i] = (dx, dz, k, a), uWB[i] = (w, q, p, 0).
export function waveUniformArrays(waves) {
  const A = new Float32Array(4 * MAXW), B = new Float32Array(4 * MAXW);
  waves.forEach((v, i) => { A.set([v.dx, v.dz, v.k, v.a], 4 * i); B.set([v.w, v.q, v.p, 0], 4 * i); });
  return { A, B, count: waves.length };
}

// The same formulas in GLSL (WebGL 2 / GLSL ES 3.0). Kept next to displace() so a change to one is a change to both; the smoke
// test renders this chunk on the GPU and compares it with displace() at sample points.
export const WAVE_GLSL = /* glsl */ `
#define MAXW ${MAXW}
uniform vec4 uWA[MAXW];
uniform vec4 uWB[MAXW];
uniform int uWaveCount;
void gerstner(vec2 p0, float t, float fade, out vec3 pos, out vec3 nrm, out float jac) {
  vec3 T = vec3(1.0, 0.0, 0.0), B = vec3(0.0, 0.0, 1.0);
  pos = vec3(p0.x, 0.0, p0.y);
  for (int i = 0; i < MAXW; i++) {
    if (i >= uWaveCount) break;
    vec4 A = uWA[i], W = uWB[i];
    float ph = A.z * dot(A.xy, p0) - W.x * t + W.z;
    float s = sin(ph), c = cos(ph);
    float a = A.w * fade, qa = W.y * a, ka = A.z * a, qka = W.y * ka;
    pos += vec3(qa * A.x * c, a * s, qa * A.y * c);
    T += vec3(-qka * A.x * A.x * s, ka * A.x * c, -qka * A.x * A.y * s);
    B += vec3(-qka * A.x * A.y * s, ka * A.y * c, -qka * A.y * A.y * s);
  }
  nrm = normalize(cross(B, T));
  jac = T.x * B.z - B.x * T.z;
}
`;
