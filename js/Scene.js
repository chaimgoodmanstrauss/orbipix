// Scene.js — the bitmap side of Orbipix: the input image, where it sits in the
// world (its placement), the mask (a contravariant distribution over the
// image), and the element list the shader averages over.
//
// Mask modes
//   'domain'  the mask is the fundamental domain, feathered by `feather`; it is
//             computed analytically (in the shader and here), so it follows the
//             domain live while the group is reshaped.
//   'custom'  a float weight per mask pixel, held on the GPU (MaskGPU.js). The
//             first brush stroke bakes the domain mask into one. Brushing is
//             contravariant (patent, "Masks"): raising the weight at a pixel lowers
//             the rest of its orbit in proportion, so each orbit keeps summing to one.
// Averaging ('mean' | 'height'): weighted mean over the orbit, or the colour
// of the orbit point with the greatest weight (the mask read as a height).

import { enumerate, planeOfWorld, featherUnit } from './Orbits.js';
import { C } from './geom.js';

const MAX_IMG = 2048, MAX_MASK = 1024;

export class Scene {
  constructor(model) {
    this.model = model;
    this.img = null;          // { el, w, h, video, version }
    this.place = null;        // { c, a, flip, pole }
    this.maskMode = 'domain';
    this.gpu = null;          // MaskGPU, set by main.js once the views exist
    this.maskVersion = 0;
    this.settings = { feather: 0.35, avg: 'mean', guides: true, showComma: false, brush: 36, strength: 0.35 };
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
    if (this.maskMode === 'custom') {
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
    if (g.mode === 'hyp') this.place = { c: [0, 0], a: [0.78, 0], flip: false, pole: 1 };
    else if (g.mode === 'euc') {
      const pts = g.faces.flatMap(f => f.ends || []).filter(Boolean);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const d = pts.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 1;
      this.place = { c: [...g.comma.c], a: [1.25 * d, 0], flip: false, pole: 1 };
    } else {
      const cc = g.comma.c, pole = cc[2] > 0 ? -1 : 1;
      const z = planeOfWorld('sph', cc, pole), q = 1 + z[0] * z[0] + z[1] * z[1];
      this.place = { c: z, a: [0.95 * q / 2, 0], flip: false, pole };
    }
    this.place.mode = g.mode;
    this._invalidate();
    this.emit('place');
  }
  setPlace(p, { silent = false } = {}) { this.place = { ...this.place, ...p }; this._invalidate(); if (!silent) this.emit('place'); }
  // move / scale / turn about an image-plane point
  movePlace(dz) { this.setPlace({ c: C.add(this.place.c, dz) }); }
  scalePlace(f, about) { this.setPlace({ c: C.add(about, C.scale(C.sub(this.place.c, about), f)), a: C.scale(this.place.a, f) }); }
  turnPlace(rot, about) { this.setPlace({ c: C.add(about, C.mul(C.sub(this.place.c, about), rot)), a: C.mul(this.place.a, rot) }); }
  flip() { this.setPlace({ flip: !this.place.flip }); }

  // ── elements ───────────────────────────────────────────────────────────
  _invalidate() { this._elsKey = ''; }
  elements() {
    const g = this.model.geo;
    if (!g || !this.img || !this.place || this.model.isBad()) return { list: [], nearCount: 0 };
    const fr = this.featherRadius();
    const key = `${g.version}|${g.mode}|${JSON.stringify(this.place)}|${this.img.w}x${this.img.h}|${g.comma.c}|${fr.toFixed(4)}`;
    if (key !== this._elsKey) {
      if (this.place.mode !== g.mode) { this.fit(); return this.elements(); }
      this._els = enumerate(g, this.place, this.img, { feather: fr });
      this._elsKey = key;
      this.elVersion++;
    }
    return this._els;
  }

  featherRadius() { const g = this.model.geo; return Math.max(this.settings.feather * featherUnit(g), 1e-5); }

  // ── mask ───────────────────────────────────────────────────────────────
  _bump() { this.maskVersion++; this.emit('mask'); }
  resetMask(silent) { this.maskMode = 'domain'; this.maskVersion++; if (!silent) this.emit('mask'); }
  // the domain mask becomes an editable one
  ensureCustom() {
    if (this.maskMode === 'custom') return true;
    if (!this.gpu || !this.gpu.bake(this)) return false;
    this.maskMode = 'custom';
    return true;
  }
  fillUniform() {
    const [w, h] = this.maskDims();
    if (!this.gpu?.ensure(w, h)) return;
    this.gpu.fill(0.5); this.maskMode = 'custom'; this._bump();
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
  maskSnapshot() { return this.maskMode === 'custom' && this.gpu?.w ? { mode: 'custom', w: this.gpu.w, h: this.gpu.h, data: this.gpu.read() } : { mode: 'domain' }; }
  restoreMask(s) {
    if (!s || s.mode === 'domain') { this.resetMask(); return; }
    const [w, h] = this.maskDims();
    if (s.w !== w || s.h !== h || !this.gpu?.upload(s.data, w, h)) { this.resetMask(); return; }
    this.maskMode = 'custom'; this._bump();
  }

  // Brush dabs [{ uv, R (mask px), s (strength) }], sign +1 (bring forward) or −1
  // (push back): one GPU pass for the lot (MaskGPU.brush).
  dabs(list, sign) {
    if (!list.length || !this.model.geo || !this.img || !this.ensureCustom()) return;
    this.elements();
    this.gpu.brush(this, list.map(d => ({ x: d.uv[0] * this.gpu.w, y: d.uv[1] * this.gpu.h, r: d.R, s: d.s })), sign);
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
