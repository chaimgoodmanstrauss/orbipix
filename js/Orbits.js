// Orbits.js — the parts of the contravariant-distribution method that need the
// group as a list of elements rather than as folding rules.
//
// The method (see NOTES.md): every output pixel p is folded into the fundamental
// domain F, giving f. Its orbit, as far as the bitmap is concerned, is
// { g(f) : g in G, g(f) lies on the image }. The output colour is the weighted
// average of the image over that orbit, weights from the mask. So we need the
// finitely many g whose tile g(F) meets the image: `enumerate` finds them by a
// breadth-first walk over tiles, starting from the tile under the image centre.
//
// Elements:
//   2D (disk, plane):  { M: [a, b, c, d] (complex [re, im]), conj }
//                      g(z) = (aZ + b) / (cZ + d),  Z = conj ? z̄ : z,  det = 1
//   sphere:            { R: 3x3 row-major orthogonal matrix }
//
// The image sits in the "image plane": the world itself in 2D, and for the
// sphere the stereographic plane from pole (0, 0, pole), so the equator is the
// unit circle. A placement { c, a, flip, pole } maps image coordinates to it:
//   s = ((u − ½)·W/L, (½ − v)·H/L)·2,  L = max(W, H)   (s spans [−1, 1] on the long side)
//   z = c + a · (flip ? s̄ : s)                          (a: complex, scale + rotation)

import { C, dist2, dot3, apply2, apply3, hypLerp, hypDist } from './geom.js';

// ── image plane ↔ world ────────────────────────────────────────────────────
export function planeOfWorld(mode, w, pole = 1) {
  if (mode !== 'sph') return w;
  const d = 1 - pole * w[2];
  return d < 1e-12 ? [1e12, 0] : [w[0] / d, w[1] / d];
}
export function worldOfPlane(mode, z, pole = 1) {
  if (mode !== 'sph') return z;
  const q = z[0] * z[0] + z[1] * z[1];
  return [2 * z[0] / (1 + q), 2 * z[1] / (1 + q), pole * (q - 1) / (1 + q)];
}

export function uvOfPlane(place, img, z) {
  let s = C.div(C.sub(z, place.c), place.a);
  if (place.flip) s = [s[0], -s[1]];
  const L = Math.max(img.w, img.h);
  return [s[0] * L / img.w * 0.5 + 0.5, 0.5 - s[1] * L / img.h * 0.5];
}
export function planeOfUV(place, img, uv) {
  const L = Math.max(img.w, img.h);
  let s = [(uv[0] - 0.5) * 2 * img.w / L, (0.5 - uv[1]) * 2 * img.h / L];
  if (place.flip) s = [s[0], -s[1]];
  return C.add(place.c, C.mul(place.a, s));
}
const inUV = uv => uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;

// ── elements ───────────────────────────────────────────────────────────────
const cmul = C.mul, cadd = C.add, cconj = C.conj;
function reflElem2(w) {
  if (w.type === 1) {
    const c = w.c, r2 = w.r * w.r;
    return { M: [c, [r2 - (c[0] * c[0] + c[1] * c[1]), 0], [1, 0], cconj(c).map(x => -x)], conj: true };
  }
  const n = w.n, n2 = cmul(n, n);
  return { M: [[-n2[0], -n2[1]], [2 * w.d * n[0], 2 * w.d * n[1]], [0, 0], [1, 0]], conj: true };
}
function compose2(A, B) { // A∘B
  const Bm = A.conj ? B.M.map(cconj) : B.M;
  const [a, b, c, d] = A.M, [e, f, g, h] = Bm;
  return norm2({ M: [cadd(cmul(a, e), cmul(b, g)), cadd(cmul(a, f), cmul(b, h)), cadd(cmul(c, e), cmul(d, g)), cadd(cmul(c, f), cmul(d, h))], conj: A.conj !== B.conj });
}
function norm2(E) {
  const [a, b, c, d] = E.M;
  const det = C.sub(cmul(a, d), cmul(b, c));
  const r = Math.sqrt(C.abs(det)) || 1, th = Math.atan2(det[1], det[0]) / 2;
  const s = [r * Math.cos(th), r * Math.sin(th)];
  return { M: E.M.map(x => C.div(x, s)), conj: E.conj };
}
export function apply2E(E, z) {
  const Z = E.conj ? [z[0], -z[1]] : z;
  const [a, b, c, d] = E.M;
  return C.div(cadd(cmul(a, Z), b), cadd(cmul(c, Z), d));
}
// |g'(z)|
export function deriv2E(E, z) {
  const Z = E.conj ? [z[0], -z[1]] : z;
  const den = cadd(cmul(E.M[2], Z), E.M[3]);
  return 1 / (den[0] * den[0] + den[1] * den[1] || 1e-300);
}
function reflElem3(n) {
  const [x, y, z] = n;
  return { R: [1 - 2 * x * x, -2 * x * y, -2 * x * z, -2 * y * x, 1 - 2 * y * y, -2 * y * z, -2 * z * x, -2 * z * y, 1 - 2 * z * z] };
}
function compose3(A, B) {
  const a = A.R, b = B.R, R = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return { R };
}
export function apply3E(E, p) { const A = E.R; return [A[0] * p[0] + A[1] * p[1] + A[2] * p[2], A[3] * p[0] + A[4] * p[1] + A[5] * p[2], A[6] * p[0] + A[7] * p[1] + A[8] * p[2]]; }

export const identity = mode => mode === 'sph' ? { R: [1, 0, 0, 0, 1, 0, 0, 0, 1] } : { M: [[1, 0], [0, 0], [0, 0], [1, 0]], conj: false };
export const applyE = (mode, E, p) => mode === 'sph' ? apply3E(E, p) : apply2E(E, p);
export const compose = (mode, A, B) => mode === 'sph' ? compose3(A, B) : compose2(A, B);
// g⁻¹. 2D: for g(z) = M(Z), Z = conj ? z̄ : z, the inverse is M⁻¹, conjugated entrywise when g reverses orientation
export function invertE(mode, E) {
  if (mode === 'sph') { const R = E.R; return { R: [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]] }; }
  const [a, b, c, d] = E.M;
  const Mi = [d, [-b[0], -b[1]], [-c[0], -c[1]], a];
  return { M: E.conj ? Mi.map(cconj) : Mi, conj: E.conj };
}

// G_i: the element carrying F across face i (the inverse of the face's folding transform)
export function faceGenerators(geo) {
  const sph = geo.mode === 'sph';
  return geo.faces.map(f => {
    let E = identity(geo.mode);
    for (const w of f.tr) E = compose(geo.mode, E, sph ? reflElem3(w) : reflElem2(w));
    return E;
  });
}
// the element taking F to the tile reached by a reduction word
export function elementOfWord(geo, gens, word) {
  let E = identity(geo.mode);
  for (const i of word) E = compose(geo.mode, E, gens[i]);
  return E;
}

// ── fundamental domain samples ─────────────────────────────────────────────
function domainSamples(geo) {
  const pts = [geo.comma.c];
  if (geo.mode === 'sph') return pts;
  const lerp = (a, b, t) => geo.mode === 'hyp' ? hypLerp(a, b, t) : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (const f of geo.faces) {
    if (!f.ends || !f.ends[0] || !f.ends[1]) continue;
    for (const t of [0, 0.25, 0.5, 0.75]) pts.push(lerp(f.ends[0], f.ends[1], t));
  }
  return pts;
}
const bbox = pts => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
};
const lam = (mode, p) => mode === 'hyp' ? 2 / Math.max(1 - (p[0] * p[0] + p[1] * p[1]), 1e-9) : 1;

// feather radius unit: the comma's size, in the metric of the geometry
export function featherUnit(geo) {
  const m = geo.comma;
  return m.size * lam(geo.mode, m.c);
}

// signed distance from p to the boundary of F (> 0 inside), in the geometry's metric (roughly)
export function domainDistance(geo, p) {
  const sph = geo.mode === 'sph';
  let s = 1e9;
  for (const f of geo.faces) {
    if (sph) { s = Math.min(s, -dot3(f.wall, p)); continue; }
    if (!f.bounds.every(b => dist2(b, p) > 0)) continue;
    s = Math.min(s, -dist2(f.wall, p));
  }
  return sph ? s : s * lam(geo.mode, p);
}
export function smoothstep(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }

export const MAX_COPIES = 4096;     // the shader loops and textures are sized for this

// ── enumeration ────────────────────────────────────────────────────────────
// Every element whose tile meets the image, up to `max`. `near` marks tiles
// close to F (only those can carry weight from a feathered domain mask).
export function enumerate(geo, place, img, { max = MAX_COPIES, feather = 0 } = {}) {
  const mode = geo.mode, sph = mode === 'sph';
  if (!geo.faces.length) return { list: [{ ...identity(mode), near: true }], truncated: false, nearCount: 1 };   // no symmetry: one copy
  const gens = faceGenerators(geo);
  const S = domainSamples(geo);
  const c0 = geo.comma.c;
  const pole = place.pole || 1;

  // image footprint in the image plane (bbox of its corners)
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(uv => planeOfUV(place, img, uv));
  const ib = bbox(corners);
  const texel = 2 * C.abs(place.a) / Math.max(img.w, img.h);         // plane units per image pixel

  // `near`: tiles that come within the feather radius of F (only they get weight from the
  // domain mask). Tested on boundary samples, with the samples' spacing as slack.
  const dist = mode === 'hyp' ? hypDist : (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let gap = 0;
  for (let i = 2; i < S.length; i++) if ((i - 1) % 4) gap = Math.max(gap, dist(S[i - 1], S[i]));
  const reach = feather + gap;
  const nearTest = T => {
    if (sph) return true;               // finite group, few faces: weigh every tile
    for (const t of T) for (const s of S) if (dist(t, s) < reach) return true;
    return false;
  };

  // start from the tile under the image centre
  let start = identity(mode);
  const ctr = worldOfPlane(mode, place.c, pole);
  const r = (mode !== 'hyp' || ctr[0] * ctr[0] + ctr[1] * ctr[1] < 1) ? geo.reduce(ctr) : null;
  if (r && r.ok) start = elementOfWord(geo, gens, r.word);

  const key = q => q.map(v => Math.round(v * 1e6)).join(',');
  const seen = new Set();
  const out = [];
  const queue = [start];
  seen.add(key(applyE(mode, start, c0)));
  let truncated = false;
  while (queue.length) {
    const E = queue.shift();
    let ok, T = null, b = null;
    if (sph) ok = true;
    else {
      T = S.map(p => apply2E(E, p));
      b = bbox(T);
      const pad = 0.15 * Math.max(b[2] - b[0], b[3] - b[1]);
      ok = b[0] - pad <= ib[2] && b[2] + pad >= ib[0] && b[1] - pad <= ib[3] && b[3] + pad >= ib[1];
      if (ok && mode === 'hyp' && Math.max(b[2] - b[0], b[3] - b[1]) < texel) ok = false;          // tiles smaller than one image pixel: below the image's resolution
    }
    if (!ok) continue;
    // the tile's box in image uv (for skipping copies with no mask weight)
    let uvBox = null;
    if (b) {
      const pad = 0.2 * Math.max(b[2] - b[0], b[3] - b[1]);
      const us = [[b[0] - pad, b[1] - pad], [b[2] + pad, b[1] - pad], [b[2] + pad, b[3] + pad], [b[0] - pad, b[3] + pad]].map(z => uvOfPlane(place, img, z));
      uvBox = [Math.min(...us.map(u => u[0])), Math.min(...us.map(u => u[1])), Math.max(...us.map(u => u[0])), Math.max(...us.map(u => u[1]))];
    }
    out.push({ ...E, near: nearTest(T), uvBox });
    if (out.length >= max) { truncated = true; break; }
    for (const G of gens) {
      const N = compose(mode, E, G);
      const k = key(applyE(mode, N, c0));
      if (seen.has(k)) continue;
      if (mode === 'hyp') { const z = applyE(mode, N, c0); if (z[0] * z[0] + z[1] * z[1] > 0.999999) continue; }
      seen.add(k);
      queue.push(N);
    }
    if (sph && seen.size > 400) { truncated = true; }
  }
  // near ones first (the shader computes domain weights only for those)
  out.sort((a, b) => (b.near ? 1 : 0) - (a.near ? 1 : 0));
  return { list: out, truncated, nearCount: out.filter(e => e.near).length };
}

// the orbit of world point x as image-plane points on the image: [{ uv, E, z, d }]
export function orbitOnImage(geo, els, place, img, x) {
  const mode = geo.mode, pole = place.pole || 1;
  const r = geo.reduce(x);
  if (!r.ok) return [];
  const f = r.p, out = [];
  for (const E of els) {
    const q = applyE(mode, E, f);
    const z = planeOfWorld(mode, q, pole);
    const uv = uvOfPlane(place, img, z);
    if (inUV(uv)) out.push({ uv, E, q });
  }
  return out;
}

export { inUV };

// Euclidean groups: the translation lattice, from a walk over the group (shortest translation t1,
// shortest one not parallel to it t2) — its cell has area |t1 × t2|
export function translationLattice(geo, maxNodes = 3000) {
  if (geo.mode !== 'euc' || !geo.faces.length) return null;
  const gens = faceGenerators(geo), c0 = geo.comma.c;
  const key = q => q.map(v => Math.round(v * 1e6)).join(',');
  const seen = new Set([key(c0)]), queue = [identity('euc')], ts = [];
  while (queue.length && seen.size < maxNodes) {
    const E = queue.shift();
    for (const G of gens) {
      const N = compose('euc', E, G), q = apply2E(N, c0), k = key(q);
      if (seen.has(k)) continue;
      seen.add(k); queue.push(N);
      const [a, b, cc, d] = N.M;
      if (!N.conj && C.abs(cc) < 1e-9) {
        const r = C.div(a, d);
        if (Math.abs(r[0] - 1) < 1e-9 && Math.abs(r[1]) < 1e-9) ts.push(C.div(b, d));
      }
    }
  }
  ts.sort((u, v) => C.abs(u) - C.abs(v));
  const t1 = ts[0];
  if (!t1) return null;
  const t2 = ts.find(t => Math.abs(t1[0] * t[1] - t1[1] * t[0]) > 1e-9 * C.abs(t1) * C.abs(t));
  if (!t2) return null;
  return { t1, t2, area: Math.abs(t1[0] * t2[1] - t1[1] * t2[0]) };
}
