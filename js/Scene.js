// Scene.js — the bitmap side of Orbipix: the input image, where it sits in the
// world (its placement), the mask (a contravariant distribution over the
// image), and the element list the shader averages over.
//
// Two kinds of mask, one at a time (settings.avg chooses):
//   height ('height', the default; also used by 'first')  a height over the image, not
//             contravariant: each orbit shows the copies standing highest (level ones
//             averaged), so it starts flat = every copy averaged. Brushing raises or lowers
//             it. It belongs to the image: it stays when the symmetry changes.
//   contravariant ('mean')  weights summing to one over each orbit; the colour is their
//             weighted average. It starts as the feathered fundamental domain, brushing is
//             contravariant (patent, "Masks"), and it goes back to the domain whenever the
//             signature changes.
// maskMode 'domain' = the kind's starting mask, drawn analytically (flat height / feathered
// domain, which follows the domain live); 'custom' = a float texture on the GPU (MaskGPU.js).

import { enumerate, planeOfWorld, worldOfPlane, identity, featherUnit, faceGenerators, elementOfWord, applyE, compose, invertE, uvOfWorld } from './Orbits.js';
import { C } from './geom.js';

const MAX_IMG = 2048, MAX_MASK = 1024;
const FIT = 0.4;          // the fitted image's size, relative to the first version's (domain mid-image, image twice its size)

export class Scene {
  constructor(model) {
    this.model = model;
    this.img = null;          // { el, w, h, video, version }
    this.place = null;        // { c, a, flip, pole }
    this.maskMode = 'domain';
    this.maskKind = 'height';  // the kind the current mask belongs to
    this.gpu = null;          // MaskGPU, set by main.js once the views exist
    this.maskVersion = 0;
    this.settings = { feather: 0.35, avg: 'height', guides: true, showComma: false, brush: 36, strength: 0.35 };
    this._ls = [];
    this._els = null; this._elsKey = '';
    this.elVersion = 0;
  }
  on(cb) { this._ls.push(cb); }
  emit(kind) { this._ls.forEach(cb => cb(kind)); }

  // ── image ──────────────────────────────────────────────────────────────
  setImage(src, { video = false } = {}) {
    let el = src, w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height;
    let pixels = null, whiteBackground = false;
    if (!video) {
      // still images: scaled down if big; transparency kept (as weight), transparent colour = white;
      // a white background (white all along the edge, flood-filled inwards) counts as transparent
      const k = Math.min(1, MAX_IMG / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      w = c.width; h = c.height;
      const data = c.getContext('2d').getImageData(0, 0, w, h).data;
      whiteBackground = clearWhiteBackground(data, w, h);
      pixels = data;
      el = c;
    }
    const prevAspect = this.img ? this.img.w / this.img.h : null;
    this.img = { el, pixels, w, h, video, whiteBackground, version: (this.img?.version || 0) + 1 };
    if (!video) this.resetMask(true);          // a new picture starts with a fresh mask
    else if (this.maskMode === 'custom') {
      const [mw, mh] = this.maskDims();
      if (prevAspect !== w / h || mw !== this.gpu?.w || mh !== this.gpu?.h) this.resetMask(true);
    }
    if (!this.place) this.fit();
    this._invalidate();
    this.emit('image');
  }
  bumpVideoFrame() { if (this.img?.video) { this.img.version++; this.emit('frame'); } }

  maskDims() {
    const s = Math.min(1, MAX_MASK / Math.max(this.img.w, this.img.h));
    return [Math.max(1, Math.round(this.img.w * s)), Math.max(1, Math.round(this.img.h * s))];
  }
  // ── placement ──────────────────────────────────────────────────────────
  // Patent, "preferred embodiment": the domain sits in the middle of the image,
  // the image about twice its size.
  fit() {
    const g = this.model.geo;
    if (!g || !this.img) return;
    if (g.mode === 'hyp') this.place = { c: [0, 0], a: [0.78 * FIT, 0], flip: false, pole: 1 };
    else if (g.mode === 'euc') {
      const pts = g.faces.flatMap(f => f.ends || []).filter(Boolean);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const d = pts.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 1;
      this.place = { c: [...g.comma.c], a: [1.25 * d * FIT, 0], flip: false, pole: 1 };
    } else {
      const cc = g.comma.c, pole = cc[2] > 0 ? -1 : 1;
      const z = planeOfWorld('sph', cc, pole), q = 1 + z[0] * z[0] + z[1] * z[1];
      this.place = { c: z, a: [0.95 * q / 2 * FIT, 0], flip: false, pole };
    }
    this.place.mode = g.mode;
    this._invalidate();
    this.emit('place');
  }
  // Pull the image back to the canvas: of all the copies of the image (the image moved by the group),
  // take the one that best covers world point x0 (the canvas centre) — x0 deepest inside it — and
  // make it the placed copy by composing the placement's isometry with that group element. The
  // pattern does not change (the mask moves with the image; a domain-shaped contravariant mask is
  // baked first, since it belongs to the domain, not the image). Returns whether it moved.
  recenter(x0) {
    const g = this.model.geo, pl = this.place;
    if (!g || !this.img || !pl || !x0 || !g.faces.length || pl.mode !== g.mode) return false;
    const mode = g.mode;
    if (mode === 'hyp' && x0[0] * x0[0] + x0[1] * x0[1] >= 1 - 1e-9) return false;
    const els = this.elements().list;
    const r = g.reduce(x0);
    if (!els.length || !r.ok) return false;
    const depth = uv => Math.max(Math.abs(uv[0] - 0.5), Math.abs(uv[1] - 0.5));   // 0 at the centre, 0.5 at the edge
    const cur = depth(uvOfWorld(mode, pl, this.img, x0));
    let best = null;
    for (const E of els) {
      const d = depth(uvOfWorld(mode, pl, this.img, applyE(mode, E, r.p)));
      if (!best || d < best.d) best = { d, E };
    }
    if (!best || best.d >= cur - 0.02) return false;          // a little hysteresis: no flicker between two copies
    const W = elementOfWord(g, faceGenerators(g), r.word);
    const gEl = compose(mode, W, invertE(mode, best.E));        // carries the image so that copy lands on x0
    if (this.maskKind === 'contra' && this.maskMode === 'domain') this.ensureCustom();
    const iso = pl.iso ? compose(mode, gEl, pl.iso) : gEl;
    this.setPlace({ iso: mode === 'sph' ? { R: iso.R } : { M: iso.M, conj: iso.conj } });
    return true;
  }

  setPlace(p, { silent = false } = {}) {
    this.place = { ...this.place, ...p };
    this._canonHyp();
    this._invalidate(); if (!silent) this.emit('place');
  }
  // In the disk the image's centre is kept at the origin of its own frame (c = 0), and where it sits is
  // carried wholly by the isometry iso. Moves are isometries, so the image can never leave the disk.
  // A placement with c ≠ 0 (old states, links, the plane-style pin after a change of geometry) is
  // re-expressed: frame ← τ_c (the disk translation taking 0 to c), a ← a / (1 − |c|²), exact at the
  // centre. One with c outside the disk cannot be seen at all and is refitted.
  _canonHyp() {
    const pl = this.place;
    if (!pl || pl.mode !== 'hyp' || !pl.c) return;
    const r2 = pl.c[0] * pl.c[0] + pl.c[1] * pl.c[1];
    if (r2 < 1e-24) return;
    if (r2 >= 0.999 * 0.999) { this.fit(); return; }
    const iso = compose('hyp', pl.iso || identity('hyp'), tau(pl.c));
    this.place = { ...pl, c: [0, 0], a: C.scale(pl.a, 1 / (1 - r2)), iso: { M: iso.M, conj: iso.conj } };
  }
  // move / scale / turn about an image-plane point
  movePlace(dz) { this.setPlace({ c: C.add(this.place.c, dz) }); }
  scalePlace(f, about) {
    if (this.place.mode === 'hyp') {        // scale about the centre, then slide rigidly so `about` stays put
      const z = C.add(this.place.c, C.scale(C.sub(about, this.place.c), f));
      this.setPlace({ a: C.scale(this.place.a, f) }, { silent: true });
      const E = C.abs(z) < 0.999 && C.abs(about) < 0.999 ? hypSlide(z, about) : null;
      if (E) this._isoAfter(E); else this.emit('place');
      return;
    }
    this.setPlace({ c: C.add(about, C.scale(C.sub(this.place.c, about), f)), a: C.scale(this.place.a, f) });
  }
  turnPlace(rot, about) { this.setPlace({ c: C.add(about, C.mul(C.sub(this.place.c, about), rot)), a: C.mul(this.place.a, rot) }); }
  flip() { this.setPlace({ flip: !this.place.flip }); }
  // Drag / turn the image rigidly in the geometry's own metric. In the plane, moving c is an isometry;
  // in the disk or on the sphere it is not (the image grows towards the rim / the far pole), so there
  // the image frame is moved by an isometry E instead: iso ← iso∘E, c and a unchanged.
  slidePlace(from, to) {
    const mode = this.place.mode;
    if (mode !== 'hyp' && mode !== 'sph') { this.movePlace(C.sub(to, from)); return; }
    const E = mode === 'hyp' ? hypSlide(from, to) : sphSlide(worldOfPlane('sph', from, this.place.pole || 1), worldOfPlane('sph', to, this.place.pole || 1));
    if (!E) return;
    if (mode === 'hyp') {                    // keep the image's centre off the very rim (it is re-centred on release)
      const iso = compose('hyp', this.place.iso || identity('hyp'), E), w = applyE('hyp', iso, this.place.c);
      if (w[0] * w[0] + w[1] * w[1] > 0.995 * 0.995) return;
    }
    this._isoAfter(E);
  }
  turnPlaceRigid(t, about) {
    const mode = this.place.mode;
    if (mode === 'euc') { this.turnPlace([Math.cos(t), Math.sin(t)], about); return; }
    const E = mode === 'hyp' ? hypTurn(about, t) : sphTurn(worldOfPlane('sph', about, this.place.pole || 1), t);
    this._isoAfter(E);
  }
  _isoAfter(E) {
    const mode = this.place.mode, iso = compose(mode, this.place.iso || identity(mode), E);
    this.setPlace({ iso: mode === 'sph' ? { R: iso.R } : { M: iso.M, conj: iso.conj } });
  }

  // ── elements ───────────────────────────────────────────────────────────
  _invalidate() { this._elsKey = ''; }
  elements() {
    const g = this.model.geo;
    if (!g || !this.img || !this.place) return { list: [], nearCount: 0 };
    const fr = this.featherRadius();
    const key = `${g.version}|${g.mode}|${JSON.stringify(this.place)}|${this.img.w}x${this.img.h}|${g.comma.c}|${fr.toFixed(4)}`;
    if (key !== this._elsKey) {
      if (this.place.mode !== g.mode) {
        // a change of geometry: remember this placement for its geometry, bring back the new one's
        (this._placeByMode ||= {})[this.place.mode] = { ...this.place };
        const back = this._placeByMode[g.mode];
        if (back) { this.place = { ...back }; this._invalidate(); this.emit('place'); }
        else this.fit();
        return this.elements();
      }
      this._els = enumerate(g, this.place, this.img, { feather: fr });
      this._elsKey = key;
      this.elVersion++;
      // An image touching no copy of the domain lies wholly outside the world (in the disk model:
      // outside the unit circle), so nothing can sample it. However it got there (an old bug, a saved
      // state, a shared link), refit it. Once only, in case it is still empty after the refit.
      if (!this._els.list.length && !this._refitting) {
        this._refitting = true;
        try { this.fit(); return this.elements(); } finally { this._refitting = false; }
      }
    }
    return this._els;
  }

  featherRadius() { const g = this.model.geo; return Math.max(this.settings.feather * featherUnit(g), 1e-5); }

  // ── mask ───────────────────────────────────────────────────────────────
  _bump() { this.maskVersion++; this.emit('mask'); }
  static kindOf(avg) { return avg === 'mean' ? 'contra' : 'height'; }
  // back to the starting mask of the current kind
  resetMask(silent) { this.maskMode = 'domain'; this.maskVersion++; if (!silent) this.emit('mask'); }
  // choose how orbits are coloured; switching between the two kinds starts that kind afresh
  setAveraging(avg) {
    this.settings.avg = avg;
    const k = Scene.kindOf(avg);
    if (k !== this.maskKind) { this.maskKind = k; this.resetMask(true); }
    this._bump();
  }
  // the signature changed: a contravariant mask was made for the old orbits, so it starts over;
  // a height map stays with the image
  symmetryChanged() { if (this.maskKind === 'contra' && this.maskMode === 'custom') this.resetMask(true); }
  // the starting mask becomes an editable texture
  ensureCustom() {
    if (this.maskMode === 'custom') return true;
    if (!this.gpu) return false;
    if (this.maskKind === 'contra') { if (!this.gpu.bake(this)) return false; }
    else { const [w, h] = this.maskDims(); if (!this.gpu.ensure(w, h)) return false; this.gpu.fill(0.5); }
    this.maskMode = 'custom';
    return true;
  }
  // a grayscale image read as weights (claim 3: a height function)
  maskFromImage(src) {
    const [w, h] = this.maskDims();
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, data = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = (0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]) / 255 * px[4 * i + 3] / 255;
    if (!this.gpu?.upload(data, w, h)) return;
    this.maskMode = 'custom'; this._bump();
  }
  // for undo: a CPU copy (read back once per committed change)
  maskSnapshot() { return this.maskMode === 'custom' && this.gpu?.w ? { mode: 'custom', kind: this.maskKind, w: this.gpu.w, h: this.gpu.h, data: this.gpu.read() } : { mode: 'domain', kind: this.maskKind }; }
  restoreMask(s) {
    if (s?.kind) this.maskKind = s.kind;
    if (!s || s.mode === 'domain') { this.resetMask(); return; }
    const [w, h] = this.maskDims();
    if (s.w !== w || s.h !== h || !this.gpu?.upload(s.data, w, h)) { this.resetMask(); return; }
    this.maskMode = 'custom'; this._bump();
  }

  // Brush dabs [{ uv, R (mask px), s (strength) }], sign +1 (bring forward) or −1
  // (push back): one GPU pass for the lot (MaskGPU.brush).
  dabs(list, sign) {
    if (this.settings.avg === 'first') return;            // no mask in that mode
    if (!list.length || !this.model.geo || !this.img || !this.ensureCustom()) return;
    this.elements();
    this.gpu.brush(this, list.map(d => ({ x: d.uv[0] * this.gpu.w, y: d.uv[1] * this.gpu.h, r: d.R, s: d.s })), sign, this.maskKind === 'contra');
    this._bump();
  }
}

// In place on RGBA bytes: transparent pixels take the colour white (keeping their alpha); and if the
// image's edge is mostly near-white, the near-white region connected to the edge becomes transparent,
// with a one-pixel soft rim. Returns whether a white background was found.
const NEAR_WHITE = 232;
export function clearWhiteBackground(d, w, h) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = d[4 * i + 3] / 255;
    if (a < 1) for (let c = 0; c < 3; c++) d[4 * i + c] = Math.round(d[4 * i + c] * a + 255 * (1 - a));
  }
  const white = i => d[4 * i + 3] < 8 || (d[4 * i] >= NEAR_WHITE && d[4 * i + 1] >= NEAR_WHITE && d[4 * i + 2] >= NEAR_WHITE);
  let edge = 0, wEdge = 0;
  const edgePx = [];
  for (let x = 0; x < w; x++) edgePx.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edgePx.push(y * w, y * w + w - 1);
  for (const i of edgePx) { edge++; if (white(i)) wEdge++; }
  if (wEdge < 0.6 * edge) return false;
  const bg = new Uint8Array(n), stack = [];
  for (const i of edgePx) if (white(i) && !bg[i]) { bg[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
      if (j >= 0 && !bg[j] && white(j)) { bg[j] = 1; stack.push(j); }
  }
  for (let i = 0; i < n; i++) {
    if (bg[i]) { d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = 255; d[4 * i + 3] = 0; continue; }
    const x = i % w, y = (i - x) / w;
    if ((x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w])) d[4 * i + 3] = Math.min(d[4 * i + 3], 128);
  }
  return true;
}

// ── isometries for rigid image moves ─────────────────────────────────────────
const tau = a => ({ M: [[1, 0], a, C.conj(a), [1, 0]], conj: false });          // disk translation taking 0 to a
const neg = a => [-a[0], -a[1]];
// the disk translation along the geodesic through p and q that takes p to q
function hypSlide(p, q) {
  if (C.abs(p) >= 1 || C.abs(q) >= 1) return null;
  const w = C.div(C.sub(q, p), C.sub([1, 0], C.mul(C.conj(p), q)));               // τ_{−p}(q)
  return compose('hyp', compose('hyp', tau(p), tau(w)), tau(neg(p)));
}
// the disk rotation by t about c
function hypTurn(c, t) {
  const h = [Math.cos(t / 2), Math.sin(t / 2)];
  return compose('hyp', compose('hyp', tau(c), { M: [h, [0, 0], [0, 0], C.conj(h)], conj: false }), tau(neg(c)));
}
// rotation by t about the unit axis n (Rodrigues), row-major
function rot3(n, t) {
  const [x, y, z] = n, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
  return { R: [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k] };
}
// the sphere rotation along the great circle through P and Q taking P to Q
function sphSlide(P, Q) {
  const n = [P[1] * Q[2] - P[2] * Q[1], P[2] * Q[0] - P[0] * Q[2], P[0] * Q[1] - P[1] * Q[0]];
  const s = Math.hypot(...n), c = P[0] * Q[0] + P[1] * Q[1] + P[2] * Q[2];
  if (s < 1e-12) return null;
  return rot3(n.map(v => v / s), Math.atan2(s, c));
}
const sphTurn = (P, t) => rot3(P, t);
