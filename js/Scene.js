// Scene.js — the bitmap side of Orbipix: the input image, where it sits in the
// world (its placement), the mask (a contravariant distribution over the
// image), and the element list the shader averages over.
//
// Mask modes
//   'domain'  the mask is the fundamental domain, feathered by `feather`; it is
//             computed analytically (in the shader and here), so it follows the
//             domain live while the group is reshaped.
//   'custom'  a Float32 weight per mask pixel. The first brush stroke bakes the
//             domain mask into one. Brushing is contravariant (patent, "Masks"):
//             raising the weight at a pixel lowers the rest of its orbit in
//             proportion, so each orbit's weights keep summing to one.
// Averaging ('mean' | 'height'): weighted mean over the orbit, or the colour
// of the orbit point with the greatest weight (the mask read as a height).

import { enumerate, planeOfUV, worldOfPlane, planeOfWorld, uvOfPlane, applyE, inUV, domainDistance, featherUnit, smoothstep } from './Orbits.js';
import { C, applyInv2, applyInv3 } from './geom.js';

const MAX_IMG = 2048, MAX_MASK = 1024;

export class Scene {
  constructor(model) {
    this.model = model;
    this.img = null;          // { el, w, h, video, version }
    this.place = null;        // { c, a, flip, pole }
    this.maskMode = 'domain';
    this.mask = null;         // { w, h, data: Float32Array }
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
    if (!video && Math.max(w, h) > MAX_IMG) {
      const s = MAX_IMG / Math.max(w, h);
      const c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      el = c; w = c.width; h = c.height;
    }
    const prevAspect = this.img ? this.img.w / this.img.h : null;
    this.img = { el, w, h, video, version: (this.img?.version || 0) + 1 };
    if (this.maskMode === 'custom' && prevAspect !== w / h) this.resetMask(true);
    else if (this.maskMode === 'custom') this.mask = this._resizeMask(this.mask);
    if (!this.place) this.fit();
    this._invalidate();
    this.emit('image');
  }
  bumpVideoFrame() { if (this.img?.video) { this.img.version++; this.emit('frame'); } }

  maskDims() {
    const s = Math.min(1, MAX_MASK / Math.max(this.img.w, this.img.h));
    return [Math.max(1, Math.round(this.img.w * s)), Math.max(1, Math.round(this.img.h * s))];
  }
  _resizeMask(m) {
    const [w, h] = this.maskDims();
    if (m && m.w === w && m.h === h) return m;
    const out = new Float32Array(w * h);
    if (m) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = m.data[Math.min(m.h - 1, Math.floor(y * m.h / h)) * m.w + Math.min(m.w - 1, Math.floor(x * m.w / w))];
    return { w, h, data: out };
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
    const key = `${g.version}|${g.mode}|${JSON.stringify(this.place)}|${this.img.w}x${this.img.h}|${g.comma.c}`;
    if (key !== this._elsKey) {
      if (this.place.mode !== g.mode) { this.fit(); return this.elements(); }
      this._els = enumerate(g, this.place, this.img);
      this._elsKey = key;
      this.elVersion++;
    }
    return this._els;
  }

  featherRadius() { const g = this.model.geo; return Math.max(this.settings.feather * featherUnit(g), 1e-5); }

  // ── mask ───────────────────────────────────────────────────────────────
  resetMask(silent) { this.maskMode = 'domain'; this.mask = null; this.maskVersion++; if (!silent) this.emit('mask'); }

  // the domain mask, computed at mask resolution
  bake() {
    const g = this.model.geo, [w, h] = this.maskDims();
    const data = new Float32Array(w * h), r = this.featherRadius();
    const pole = this.place.pole || 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = worldOfPlane(g.mode, planeOfUV(this.place, this.img, [(x + 0.5) / w, (y + 0.5) / h]), pole);
      if (g.mode === 'hyp' && p[0] * p[0] + p[1] * p[1] >= 1) continue;
      data[y * w + x] = smoothstep(-r, r, domainDistance(g, p));
    }
    return { w, h, data };
  }
  ensureCustom() {
    if (this.maskMode === 'custom' && this.mask) return;
    this.mask = this.bake();
    this.maskMode = 'custom';
    this.maskVersion++;
  }
  fillUniform() { const [w, h] = this.maskDims(); this.mask = { w, h, data: new Float32Array(w * h).fill(0.5) }; this.maskMode = 'custom'; this.maskVersion++; this.emit('mask'); }
  // a grayscale image read as weights (claim 3: a height function)
  maskFromImage(src) {
    const [w, h] = this.maskDims();
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, data = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = (0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]) / 255 * px[4 * i + 3] / 255;
    this.mask = { w, h, data }; this.maskMode = 'custom'; this.maskVersion++; this.emit('mask');
  }
  maskSnapshot() { return this.maskMode === 'custom' && this.mask ? { mode: 'custom', w: this.mask.w, h: this.mask.h, data: this.mask.data.slice() } : { mode: 'domain' }; }
  restoreMask(s) {
    if (!s || s.mode === 'domain') { this.resetMask(); return; }
    this.mask = this._resizeMask({ w: s.w, h: s.h, data: s.data.slice() }); this.maskMode = 'custom'; this.maskVersion++; this.emit('mask');
  }

  // One brush dab at image point uv, radius R in mask pixels, strength s in (0,1],
  // sign +1 (bring this part of the image forward) or −1 (push it back).
  // Contravariant (patent, "Masks"): a pixel x under the brush goes from old to
  // new; every other pixel u of its orbit is scaled by (1 − new)/(1 − old), so
  // each orbit keeps summing to one. Done as a gather — every pixel u near a copy
  // of the brush is visited once and pulls its factor from its orbit point in
  // the brush — so the copies come out without holes, whatever their scale.
  dab(uv, R, s, sign) {
    const g = this.model.geo;
    if (!g || !this.img) return;
    this.ensureCustom();
    const { w, h, data } = this.mask, els = this.elements().list;
    const old = data.slice();
    const pole = this.place.pole || 1, mode = g.mode;
    const cx = uv[0] * w, cy = uv[1] * h;
    const worldAt = (x, y) => worldOfPlane(mode, planeOfUV(this.place, this.img, [x / w, y / h]), pole);
    const pixOf = q => { const u = uvOfPlane(this.place, this.img, planeOfWorld(mode, q, pole)); return [u[0] * w, u[1] * h]; };
    const okWorld = p => !(mode === 'hyp' && p[0] * p[0] + p[1] * p[1] >= 0.9999);
    const sample = (A, x, y) => {
      const x0 = Math.min(w - 2, Math.max(0, Math.floor(x - 0.5))), y0 = Math.min(h - 2, Math.max(0, Math.floor(y - 0.5)));
      const fx = Math.min(1, Math.max(0, x - 0.5 - x0)), fy = Math.min(1, Math.max(0, y - 0.5 - y0));
      const i = y0 * w + x0;
      return (A[i] * (1 - fx) + A[i + 1] * fx) * (1 - fy) + (A[i + w] * (1 - fx) + A[i + w + 1] * fx) * fy;
    };
    const brush = (x, y) => { const d = Math.hypot(x - cx, y - cy) / R; return d >= 1 ? 0 : s * (1 - d * d) * (1 - d * d); };
    const after = (o, b) => sign > 0 ? Math.min(o + b, 1) : Math.max(o - b, 0);

    // 1. the brushed pixels themselves
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const b = brush(x + 0.5, y + 0.5);
      if (b > 0) data[y * w + x] = after(old[y * w + x], b);
    }

    // 2. which tiles the brush covers: sample it, group the samples by reduction word
    const groups = new Map();
    const N = 8;
    for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
      if (i * i + j * j > N * N) continue;
      const p = worldAt(cx + R * i / N, cy + R * j / N);
      if (!okWorld(p)) continue;
      const r = g.reduce(p); if (!r.ok) continue;
      const k = r.word.join(',');
      if (!groups.has(k)) groups.set(k, { word: r.word, fs: [] });
      groups.get(k).fs.push(r.p);
    }

    // 3. every copy of each part, as a pixel box; visit each pixel once
    const stamp = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (brush(x + 0.5, y + 0.5) > 0) stamp[y * w + x] = 1;
    for (const { word, fs } of groups.values()) {
      for (const E of els) {
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const f of fs) { const q = pixOf(applyE(mode, E, f)); bx0 = Math.min(bx0, q[0]); by0 = Math.min(by0, q[1]); bx1 = Math.max(bx1, q[0]); by1 = Math.max(by1, q[1]); }
        const pad = 2 + 0.25 * Math.max(bx1 - bx0, by1 - by0);
        const X0 = Math.max(0, Math.floor(bx0 - pad)), X1 = Math.min(w - 1, Math.ceil(bx1 + pad));
        const Y0 = Math.max(0, Math.floor(by0 - pad)), Y1 = Math.min(h - 1, Math.ceil(by1 + pad));
        if (X0 > X1 || Y0 > Y1) continue;
        for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
          const j = y * w + x;
          if (stamp[j]) continue;
          const p = worldAt(x + 0.5, y + 0.5);
          if (!okWorld(p)) continue;
          const r = g.reduce(p); if (!r.ok) continue;
          // its orbit point in this part of the brush
          let q = r.p;
          for (let t = word.length - 1; t >= 0; t--) q = mode === 'sph' ? applyInv3(g.faces[word[t]].tr, q) : applyInv2(g.faces[word[t]].tr, q);
          const [qx, qy] = pixOf(q);
          const b = brush(qx, qy);
          if (b <= 0) continue;
          stamp[j] = 1;
          const o = sample(old, qx, qy), n = after(o, b);
          if (1 - o > 1e-4) data[j] *= (1 - n) / (1 - o);
          else if (sign < 0) data[j] = 1 - n;          // the orbit had all its weight at x: hand back the rest
        }
      }
    }
    this.maskVersion++;
    this.emit('mask');
  }
}
