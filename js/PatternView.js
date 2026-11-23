// PatternView.js — WebGL2 tiling of the current orbifold group.
//
// A slim renderer (instead of SymmHub's SymRenderer, which builds its own
// dat.gui): every pixel is mapped to the world, then folded into the
// fundamental domain by the same rule as the engine's shader — while the point
// is outside some face (and inside that face's bounds), apply the face's
// transform. The folded point tells the tile parity (teal / sand), where the
// comma motif sits, and how close the pixel is to each edge, cone and corner,
// so edges and highlights are drawn on every copy of the domain at once.
//
// Views: hyperbolic — Poincaré disk, Möbius pan; Euclidean — the plane;
// spherical — an orthographic globe, drag to turn.

import { Mob, C, M3, toSphere, fromSphere, norm3, cross3, dot3, hypLerp, apply2, apply3 } from './geom.js';
import { makeCommaCanvas } from './textures.js';
import { unreduce } from './OrbifoldModel.js';

import { planeOfUV, worldOfPlane, translationLattice } from './Orbits.js';

const MAXF = 64, WIDTH = 16;
const EUC_CELLS_ACROSS = 2.5;      // lattice repeats across the canvas when a flat pattern opens
const INTERACTIVE_QUALITY = 1;     // resolution scale while dragging / brushing / zooming (1: off — the domain texture made it unnecessary)

const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0., 1.); }`;

// GLSL shared by the pattern shader and the mask passes (MaskGPU.js)
export const COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uData, uEl;
uniform int uMode, uNF, uNG, uFlip;
uniform vec4 uPlace;        // image placement: c.xy, a.xy (complex)
uniform vec2 uK;            // (L/W, L/H)
uniform float uPole, uFeather;

vec4 T(int c, int r) { return texelFetch(uData, ivec2(c, r), 0); }
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cdiv(vec2 a, vec2 b){ float q = dot(b,b); return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y)/q; }

// 2D walls: type 1 circle (c.xy, r in w), type 2 line (n.xy, d in w)
float dist2(vec4 v, float type, vec2 p){
  if (type < 1.5) { float d = length(p - v.xy) - abs(v.w); return v.w > 0. ? d : -d; }
  return dot(p, v.xy) - v.w;
}
vec3 refl2(vec4 v, float type, vec2 p){
  if (type < 1.5) { vec2 d = p - v.xy; float q = max(dot(d,d), 1e-30); float r2 = v.w*v.w; return vec3(v.xy + r2*d/q, r2/q); }
  float s = 2.*(dot(p, v.xy) - v.w); return vec3(p - s*v.xy, 1.);
}
float typeOf(int r, int slot){ // slot 0..3 bounds (texel 12), 4..9 transform (texel 13, 14)
  vec4 t = slot < 4 ? T(12, r) : (slot < 8 ? T(13, r) : T(14, r));
  int k = slot < 4 ? slot : (slot < 8 ? slot - 4 : slot - 8);
  return k == 0 ? t.x : k == 1 ? t.y : k == 2 ? t.z : t.w;
}

vec4 E(int c, int r) { return texelFetch(uEl, ivec2(c, r), 0); }
vec2 planeOf(vec2 p, vec3 P){ if (uMode == 2) return P.xy / max(1. - uPole * P.z, 1e-6); return p; }
float planeD(vec3 P){ return uMode == 2 ? 1. / max(1. - uPole * P.z, 1e-6) : 1.; }
vec2 uvOf(vec2 z){ vec2 s = cdiv(z - uPlace.xy, uPlace.zw); if (uFlip == 1) s.y = -s.y; return vec2(s.x * uK.x * .5 + .5, .5 - s.y * uK.y * .5); }
bool inImg(vec2 uv){ return all(greaterThanEqual(uv, vec2(0.))) && all(lessThanEqual(uv, vec2(1.))); }
// signed distance to the fundamental domain's boundary (> 0 inside), as in Orbits.domainDistance
float sdom(vec2 q, vec3 Q){
  float s = 1e9;
  for (int i = 0; i < ${MAXF}; i++) {
    if (i >= uNF) break;
    vec4 meta = T(11, i); vec4 w = T(0, i);
    if (uMode == 2) { s = min(s, -dot(w.xyz, Q)); continue; }
    bool inb = true; int nb = int(meta.y);
    for (int j = 0; j < 4; j++) { if (j >= nb) break; if (dist2(T(1 + j, i), typeOf(i, j), q) <= 0.) { inb = false; break; } }
    if (!inb) continue;
    s = min(s, -dist2(w, meta.x, q));
  }
  if (uMode == 0) s *= 2. / max(1. - dot(q, q), 1e-6);
  return s;
}
float wdom(vec2 q, vec3 Q){ return smoothstep(-uFeather, uFeather, sdom(q, Q)); }
// image uv -> image plane -> world (sphere: inverse stereographic from the pole)
vec2 planeOfUV(vec2 uv){ vec2 s = vec2((uv.x - .5) * 2. / uK.x, (.5 - uv.y) * 2. / uK.y); if (uFlip == 1) s.y = -s.y; return uPlace.xy + cmul(uPlace.zw, s); }
vec3 sphOfPlane(vec2 z){ float q = dot(z, z); return vec3(2. * z, uPole * (q - 1.)) / (1. + q); }
// fold into the fundamental domain (the engine's rule); false if it does not settle
bool foldP(inout vec2 p, inout vec3 P){
  bool sph = uMode == 2;
  for (int it = 0; it < 90; it++) {
    bool moved = false;
    for (int i = 0; i < ${MAXF}; i++) {
      if (i >= uNF) break;
      vec4 meta = T(11, i); vec4 w = T(0, i);
      float dd = sph ? dot(w.xyz, P) : dist2(w, meta.x, p);
      if (dd <= 0.) continue;
      bool inb = true; int nb = int(meta.y);
      for (int j = 0; j < 4; j++) { if (j >= nb) break; if (dist2(T(1 + j, i), typeOf(i, j), p) <= 0.) { inb = false; break; } }
      if (!inb) continue;
      int nt = int(meta.z);
      for (int j = 0; j < 6; j++) {
        if (j >= nt) break;
        vec4 sp = T(5 + j, i);
        if (sph) P = P - 2. * dot(sp.xyz, P) * sp.xyz; else p = refl2(sp, typeOf(i, 4 + j), p).xy;
      }
      moved = true; break;
    }
    if (!moved) return true;
  }
  return false;
}
// the e-th listed group element applied to a folded point; gd = |g'| (2D)
void applyEl(int e, vec2 p, vec3 P, out vec2 q, out vec3 Q, out float gd){
  vec4 t0 = E(0, e), t1 = E(1, e), t3 = E(3, e);
  q = vec2(0.); Q = vec3(0.); gd = 1.;
  if (uMode == 2) { vec4 t2 = E(2, e); Q = vec3(dot(t0.xyz, P), dot(t1.xyz, P), dot(t2.xyz, P)); }
  else {
    vec2 Z = t3.x > 0.5 ? vec2(p.x, -p.y) : p;
    vec2 den = cmul(t1.xy, Z) + t1.zw;
    q = cdiv(cmul(t0.xy, Z) + t0.zw, den);
    gd = 1. / dot(den, den);
  }
}
`;


// ── the method: the colour of an orbit, from the image and the mask ──
const ORBIT = `
uniform sampler2D uImg, uMask, uActive;
uniform int uMaskMode, uNNear;
uniform int uAvg;           // 0 weighted average, 1 highest weight wins, 2 no mask: average all, 3 no mask: first hit
uniform float uTexPer;      // image texels per image-plane unit
// the mask, bilinear by hand (float textures need not be filterable)
float maskAt(vec2 uv){
  ivec2 n = textureSize(uMask, 0);
  vec2 s = uv * vec2(n) - .5; ivec2 i = ivec2(floor(s)); vec2 f = fract(s); ivec2 M = n - 1;
  float a = texelFetch(uMask, clamp(i, ivec2(0), M), 0).r, b = texelFetch(uMask, clamp(i + ivec2(1, 0), ivec2(0), M), 0).r;
  float c = texelFetch(uMask, clamp(i + ivec2(0, 1), ivec2(0), M), 0).r, d = texelFetch(uMask, clamp(i + ivec2(1, 1), ivec2(0), M), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// the orbit of the folded point (p, P): its colour, alpha 0 when no copy lands on the image.
// pxw: folded world units per output pixel (for the image's mip level).
// uAvg 0: contravariant mask, the weighted average (claim 1)
//      1: height map, the average of the copies standing highest (claim 3; all level = average all)
//      3: no mask, the first copy in the crown that lands on the opaque image
const float HEPS = 0.004;     // heights this close count as level
vec4 orbitColor(vec2 p, vec3 P, float pxw){
  float sw = 0., cnt = 0., suma = 0., best = -1e9, nb = 0.;
  vec3 swc = vec3(0.), sumc = vec3(0.), bestc = vec3(0.);
  bool contra = uAvg == 0;
  int nLoop = !contra || uMaskMode == 1 ? uNG : uNNear;
  for (int e = 0; e < 4096; e++) {
    if (e >= nLoop) break;
    bool near = e < uNNear;                 // near copies also feed the no-weight fallback
    if (contra && uMaskMode == 1 && !near) {
      if (texelFetch(uActive, ivec2(e >> 4, 1), 0).r < 0.5) { e = e | 15; continue; }   // a block of 16 with no weight
      if (texelFetch(uActive, ivec2(e, 0), 0).r < 0.5) continue;
    }
    vec4 t3 = E(3, e);
    vec2 q; vec3 Q; float gd;
    applyEl(e, p, P, q, Q, gd);
    vec2 uv = uvOf(planeOf(q, Q));
    if (!inImg(uv)) continue;
    float w = 0.;
    if (contra) {
      w = uMaskMode == 1 ? maskAt(uv) : (t3.y > 0.5 ? wdom(q, Q) : 0.);
      if (w <= 0. && !near) continue;
    }
    vec4 c = textureLod(uImg, uv, log2(max(gd * planeD(Q) * uTexPer * pxw, 1.)));
    if (uAvg == 3) { if (c.a > 0.5) return vec4(c.rgb, 1.); continue; }
    cnt += 1.; sumc += c.a * c.rgb; suma += c.a;
    if (uAvg == 1) {
      if (c.a < 0.5) continue;                 // transparent parts stand nowhere
      float h = uMaskMode == 1 ? maskAt(uv) : 0.5;
      if (h > best + HEPS) { best = h; bestc = c.rgb; nb = 1.; }
      else if (h > best - HEPS) { bestc += c.rgb; nb += 1.; }
      continue;
    }
    w *= c.a;                                  // transparent parts (and a white background) carry no weight
    sw += w; swc += w * c.rgb;
  }
  if (cnt == 0.) return vec4(0.);
  // nothing to go by: the plain average of the opaque parts; all transparent: white
  vec3 plain = suma > 1e-4 ? sumc / suma : vec3(1.);
  if (uAvg == 1) return vec4(nb > 0. ? bestc / nb : plain, 1.);
  if (uAvg == 3) return vec4(plain, 1.);
  return vec4(sw > 1e-4 ? swc / sw : plain, 1.);
}

// the domain texture's chart of F: the world itself in 2D, stereographic about the comma on the sphere
uniform vec4 uChart;        // chart box x0, y0, x1, y1
uniform vec3 uChC, uChE1, uChE2;
uniform vec2 uDomSize;      // texels
vec2 chartOf(vec2 p, vec3 P){ return uMode == 2 ? vec2(dot(P, uChE1), dot(P, uChE2)) / max(1. + dot(P, uChC), 1e-4) : p; }
vec3 sphOfChart(vec2 x){ float r = dot(x, x); return ((1. - r) * uChC + 2. * x.x * uChE1 + 2. * x.y * uChE2) / (1. + r); }
float chartD(vec3 P){ return uMode == 2 ? 1. / max(1. + dot(P, uChC), 1e-4) : 1.; }   // chart units per world unit
`;

// one texel of the domain texture: the orbit colour of its point
const CACHE_FS = COMMON + ORBIT + `
out vec4 outColor;
void main(){
  vec2 x = mix(uChart.xy, uChart.zw, gl_FragCoord.xy / uDomSize);
  vec2 p = x; vec3 P = vec3(0.);
  if (uMode == 2) P = sphOfChart(x);
  else if (uMode == 0 && dot(p, p) >= 0.9999) { outColor = vec4(0.); return; }
  float pxw = (uChart.z - uChart.x) / uDomSize.x / chartD(P);
  if (!foldP(p, P)) { outColor = vec4(0.); return; }
  vec4 c = orbitColor(p, P, pxw);
  outColor = vec4(c.rgb * c.a, c.a);          // premultiplied, so mipmaps blend cleanly
}`;

const FS = COMMON + ORBIT + `
uniform sampler2D uMotif, uDom;
uniform int uNI, uNP;
uniform vec2 uCenter;      // canvas centre, device px
uniform float uS;          // device px per screen unit
uniform vec2 uOff;         // screen-unit offset (zoom about pointer)
uniform vec4 uV0, uV1;     // screen -> world Möbius  (a, b | c, d)
uniform mat3 uR;           // sphere: view -> world
uniform vec3 uCommaC, uCommaE1, uCommaE2;
uniform float uCommaSize;
uniform mat2 uCommaA;        // motif frame (2D): uv = A (p - c) / size
uniform int uCommaHL;        // 0 none, 1 hovered, 2 selected
uniform float uDpr;
uniform float uDim;
uniform int uHomeTint;
uniform int uShow;          // 0 the pattern; 1 adjusting the image: the image laid over the pattern where it lies
uniform int uGuides, uShowComma, uHasImg;
out vec4 outColor;

void main(){
  vec2 px = gl_FragCoord.xy;
  vec2 u = (px - uCenter) / uS - uOff;
  vec3 paper = vec3(0.984, 0.980, 0.965);
  vec3 ink = vec3(0.10, 0.10, 0.12);

  vec2 p; vec3 P; float J = 1.;    // |d world / d screen unit|
  bool sph = uMode == 2;
  if (sph) {
    float r2 = dot(u,u);
    if (r2 > 1.) {
      float a = clamp((sqrt(r2) - 1.) * uS / uDpr, 0., 1.);
      outColor = vec4(mix(mix(ink, paper, 0.55), paper, a), 1.); return;
    }
    P = normalize(uR * vec3(u, sqrt(1. - r2)));
  } else {
    vec2 a = uV0.xy, b = uV0.zw, c = uV1.xy, d = uV1.zw;
    vec2 den = cmul(c, u) + d;
    p = cdiv(cmul(a, u) + b, den);
    J = 1. / dot(den, den);              // det = 1
    if (uMode == 0 && dot(u,u) >= 1.) {
      float e = abs(length(u) - 1.) * uS / uDpr;
      outColor = vec4(mix(mix(ink, paper, 0.45), paper, clamp(e - 0.5, 0., 1.)), 1.);
      return;
    }
  }

  vec2 p0 = p; vec3 P0 = P;
  // ── fold into the fundamental domain ──
  float k = 1.;
  int parity = 0, steps = 0;
  bool ok = true;
  for (int it = 0; it < 90; it++) {
    bool moved = false;
    for (int i = 0; i < ${MAXF}; i++) {
      if (i >= uNF) break;
      vec4 meta = T(11, i);
      vec4 w = T(0, i);
      float dd = sph ? dot(w.xyz, P) : dist2(w, meta.x, p);
      if (dd <= 0.) continue;
      bool inb = true;
      int nb = int(meta.y);
      for (int j = 0; j < 4; j++) { if (j >= nb) break; if (dist2(T(1 + j, i), typeOf(i, j), p) <= 0.) { inb = false; break; } }
      if (!inb) continue;
      int nt = int(meta.z);
      for (int j = 0; j < 6; j++) {
        if (j >= nt) break;
        vec4 s = T(5 + j, i);
        if (sph) P = P - 2. * dot(s.xyz, P) * s.xyz;
        else { vec3 r = refl2(s, typeOf(i, 4 + j), p); p = r.xy; k *= r.z; }
      }
      parity ^= (nt & 1);
      steps++;
      moved = true;
      break;
    }
    if (!moved) break;
    if (it == 89) ok = false;
  }

  // px per world unit at the folded point
  float scale = sph ? uS : uS / (k * J);
  scale /= uDpr;      // in CSS px for line widths

  vec3 fillF = vec3(0.604, 0.835, 0.800), inkF = vec3(0.180, 0.490, 0.443);
  vec3 fillB = vec3(0.961, 0.902, 0.776), inkB = vec3(0.722, 0.573, 0.353);
  vec3 col = mix(paper, parity == 0 ? fillF : fillB, uHasImg == 1 ? 0.3 : 1.);
  if (uHomeTint == 1 && steps == 0 && uHasImg == 0) col = mix(col, vec3(1.), 0.35);
  float pxw = sph ? 1. / uS : k * J / uS;          // folded world units per device pixel
  bool guides = uGuides == 1;

  if (uHasImg == 1 && ok) {
    // the orbit colours, computed once per point of F (the domain texture), looked up at the folded point
    vec2 uvD = (chartOf(p, P) - uChart.xy) / (uChart.zw - uChart.xy);
    float tpw = uDomSize.x / (uChart.z - uChart.x) * chartD(P);
    vec4 c = textureLod(uDom, uvD, log2(max(tpw * pxw, 1.)));
    col = col * (1. - c.a) + c.rgb;
  }
  if (uHasImg == 1 && uShow == 1) {
    // ── adjusting: the pattern a little desaturated, the image over it where it lies,
    //    fully where its weight is high, at 30% where the mask is dark ──
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.65);
    vec2 uv = uvOf(planeOf(p0, P0));
    if (inImg(uv)) {
      float pxr = sph ? 1. / uS : J / uS;
      vec4 c = textureLod(uImg, uv, log2(max(planeD(P0) * uTexPer * pxr, 1.)));
      float w = uAvg == 3 ? 1. : uMaskMode == 1 ? maskAt(uv) : wdom(p0, P0);
      col = mix(col, c.rgb, mix(0.3, 1., clamp(w, 0., 1.)) * c.a);
    }
  }

  // ── comma ── (this tile's own, and those of tiles one or two steps away that poke in)
  if (uShowComma == 1) {
    vec4 best = vec4(0.); int bpar = parity;
    for (int pass = 0; pass < 1 + ${MAXF} + 144; pass++) {
      int i = -1, j = -1;
      if (pass > 0 && pass <= uNF) i = pass - 1;
      else if (pass > ${MAXF}) { if (uNF > 12) break; int q = pass - ${MAXF} - 1; i = q / 12; j = q - 12 * (q / 12); if (i >= uNF) break; if (j >= uNF) continue; }
      else if (pass > 0) continue;
      vec2 pp = p; vec3 PP = P; int par = parity;
      for (int s2 = 0; s2 < 2; s2++) {
        int f = s2 == 0 ? i : j;
        if (f < 0) continue;
        int nt = int(T(11, f).z);
        for (int t = 0; t < 6; t++) {
          if (t >= nt) break;
          vec4 sp = T(5 + t, f);
          if (sph) PP = PP - 2. * dot(sp.xyz, PP) * sp.xyz;
          else pp = refl2(sp, typeOf(f, 4 + t), pp).xy;
        }
        par ^= (nt & 1);
      }
      vec2 uv;
      if (sph) { vec3 dlt = PP - uCommaC; uv = vec2(dot(dlt, uCommaE1), dot(dlt, uCommaE2)) / uCommaSize; if (dot(PP, uCommaC) < 0.) uv = vec2(9.); }
      else uv = (uCommaA * (pp - uCommaC.xy)) / uCommaSize;
      vec2 tuv = vec2(uv.x, -uv.y) * 0.5 + 0.5;
      if (any(lessThanEqual(tuv, vec2(0.))) || any(greaterThanEqual(tuv, vec2(1.)))) continue;
      // explicit LOD: derivatives jump across tile seams, so texture() would blur there
      float lod = log2(max(256. / max(2. * uCommaSize * scale * uDpr, 1e-3), 1.));
      vec4 m = textureLod(uMotif, tuv, lod);
      if (max(m.r, m.g) > max(best.r, best.g)) { best = m; bpar = par; }
      if (best.r > 0.99) break;
    }
    if (max(best.r, best.g) > 0.) {
      vec3 ci = bpar == 0 ? inkF : inkB;
      vec3 oc = uCommaHL > 0 ? vec3(1., 0.75, 0.1) : mix(ci, ink, 0.25);
      col = mix(col, oc, best.g * (uCommaHL > 0 ? 1. : 0.9));
      col = mix(col, uCommaHL == 2 ? mix(ci, vec3(1., 0.84, 0.23), 0.35) : ci, best.r);
    }
  }

  // ── edges ── (thinner where tiles are tiny, e.g. near the rim of the disk)
  float tileFade = clamp(uCommaSize * scale / 22., 0.25, 1.);
  vec3 edgeCol = vec3(0.); float edgeA = 0.;
  vec3 glowCol = vec3(1., 0.84, 0.23); float glowA = 0.;
  for (int i = 0; i < ${MAXF}; i++) {
    if (i >= uNF) break;
    vec4 meta = T(11, i);
    vec4 w = T(0, i);
    float dd = abs(sph ? dot(w.xyz, P) : dist2(w, meta.x, p)) * scale;
    if (dd > 12.) continue;
    int nb = int(meta.y);
    bool inb = true;
    if (!sph) for (int j = 0; j < 4; j++) { if (j >= nb) break; if (dist2(T(1 + j, i), typeOf(i, j), p) <= -1e-7) { inb = false; break; } }
    if (!inb) continue;
    vec4 st = T(15, i);       // rgb, width
    st.w *= tileFade;
    vec4 hl = T(14, i);       // .w highlight
    float a = clamp(st.w * 0.5 - dd + 0.5, 0., 1.) * (guides ? 1. : 0.);
    if (a > edgeA) { edgeA = a; edgeCol = st.rgb; }
    if (hl.w > 0.5) glowA = max(glowA, clamp(4.5 * tileFade - dd + 0.5, 0., 1.));
  }
  // interior cuts
  for (int i = 0; i < 32; i++) {
    if (i >= uNI) break;
    int r = uNF + i;
    vec4 w = T(0, r), ab = T(1, r), meta = T(2, r), st = T(3, r);
    float dd = abs(dist2(w, meta.x, p)) * scale;
    if (dd > 12.) continue;
    // on the segment AB?
    bool on;
    if (meta.x < 1.5) {
      vec2 qa = normalize(ab.xy - w.xy), qb = normalize(ab.zw - w.xy), q = normalize(p - w.xy);
      vec2 bis = normalize(qa + qb);
      on = dot(q, bis) >= dot(qa, bis) - 1e-6;
    } else {
      vec2 d = ab.zw - ab.xy; float t = dot(p - ab.xy, d) / max(dot(d,d), 1e-12);
      on = t >= 0. && t <= 1.;
    }
    if (!on) continue;
    float a = clamp(st.w * tileFade * 0.5 - dd + 0.5, 0., 1.) * 0.7 * (guides ? 1. : 0.);
    if (a > edgeA) { edgeA = a; edgeCol = st.rgb; }
    if (meta.y > 0.5) glowA = max(glowA, clamp(4.5 - dd + 0.5, 0., 1.));
  }
  col = mix(col, glowCol, glowA * 0.9);
  col = mix(col, edgeCol, edgeA);

  // ── cone and corner points ──
  for (int i = 0; i < 48; i++) {
    if (i >= uNP) break;
    int r = uNF + uNI + i;
    vec4 pos = T(0, r), meta = T(1, r), st = T(2, r);
    float dd = sph ? length(P - pos.xyz) * scale : length(p - pos.xy) * scale;
    if (dd > 14.) continue;
    float R = (meta.z > 0.5 ? 6.5 : 4.5) * tileFade;
    if (R < 1.2 || (!guides && meta.z < 0.5)) continue;
    if (meta.z > 0.5) col = mix(col, glowCol, clamp(R + 4. - dd, 0., 1.));
    float ring = clamp(1.2 - abs(dd - R + 0.6), 0., 1.);
    float disc = clamp(R - dd, 0., 1.);
    col = mix(col, meta.x < 0.5 ? vec3(1.) : st.rgb, disc * (meta.x < 0.5 ? 0.95 : 0.85));
    col = mix(col, st.rgb, ring);
  }

  if (!ok) col = mix(col, paper, 0.6);
  col = mix(col, paper, uDim);
  outColor = vec4(col, 1.);
}`;

// state that lives with the shared WebGL context, not with one view
const SHARED = ['gl', 'prog', 'vao', 'uni', 'cacheProg', 'cacheUni', 'domTex', 'domFbo', 'domKey', 'domW', 'domH', 'chart', 'chartKey', 'dataTex', 'motifTex', 'imgTex', 'elTex', '_imgVer', '_elVer', '_ng', '_nnear', '_counts', '_uploadedVersion', '_dataDirty'];
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export class PatternView {
  // opts: scene (Scene), kind ('pattern' | 'source'), shareView (another PatternView whose view state this one follows)
  constructor(canvas, overlay, model, highlight, opts = {}) {
    this.canvas = canvas; this.overlay = overlay; this.model = model; this.highlight = highlight;
    this.scene = opts.scene || null;
    this.kind = opts.kind || 'pattern';
    this.octx = overlay.getContext('2d');
    this.partners = [];
    if (opts.shareView) { this.view = opts.shareView.view; this.partners.push(opts.shareView); opts.shareView.partners.push(this); this._listeners = opts.shareView._listeners; }
    else this.view = { mode: null, V: Mob.id(), R: M3.id(), zoom: 1, off: [0, 0] };
    this.cursor = null;       // brush ring { x, y, r } in CSS px
    this.hover = null;        // set by FeatureTool for drawing tooltips/handles
    this.dim = 0;
    this._dirty = true;
    this._listeners = this._listeners || [];
    // one WebGL context for every view (so they can share the mask texture): it draws
    // into a hidden canvas, which is copied into this view's 2D canvas
    // the first view draws straight into its own canvas; a second view (shareView) would draw
    // through the shared context and copy the result into its 2D canvas
    this.G = opts.shareView ? opts.shareView.G : { canvas, views: [] };
    this.G.views.push(this);
    this.direct = this.G.canvas === canvas;
    this.ctx2d = this.direct ? null : canvas.getContext('2d');
    this.quality = 1;         // < 1 while the user is interacting: fewer pixels, then a full-resolution redraw
    this._initGL();
    this._resize();
    new ResizeObserver(() => { this._resize(); this.requestRender(); }).observe(canvas.parentElement);
    highlight.on(() => { this._dataDirty = true; this.requestRender(); });
  }

  onViewChange(cb) { this._listeners.push(cb); }
  static {
    for (const k of SHARED) Object.defineProperty(this.prototype, k, { get() { return this.G?.[k]; }, set(v) { this.G[k] = v; } });
  }

  _initGL() {
    if (this.G.gl && !this.G.lost) return;
    const gl = this.G.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    this.gl = gl;
    if (!gl) { this._fail('This browser has no WebGL2, so the pattern cannot be drawn.'); return; }
    this.G.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.G.floatRender = !!gl.getExtension('EXT_color_buffer_float');
    if (!this.G.listening) {
      this.G.listening = true;
      this.G.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.G.lost = true; this.G.views.forEach(v => v._fail('The graphics context was lost. Reload the page to draw again.')); });
    }
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const link = fsrc => {
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fsrc));
      gl.bindAttribLocation(pr, 0, 'aPos');
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      return pr;
    };
    const prog = link(FS);
    this.cacheProg = link(CACHE_FS);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = 0;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uniforms = pr => { const u = {}, n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(pr, i).name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(pr, nm); } return u; };
    this.uni = uniforms(prog);
    this.cacheUni = uniforms(this.cacheProg);
    this.domTex = null; this.domKey = '';
    this.dataTex = gl.createTexture();
    this.motifTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.motifTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, makeCommaCanvas(256));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const mk = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    this.imgTex = mk(); this.elTex = mk();
    this._imgVer = this._elVer = -1;
    this._dataDirty = true;
  }

  // ── bitmap textures (image, mask, element list) ─────────────────────────
  _uploadScene() {
    const gl = this.gl, sc = this.scene;
    if (!sc || !sc.img) return;
    if (this._imgVer !== sc.img.version) {
      gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        // still images go up as raw bytes (a canvas would lose the colour of transparent pixels)
        if (sc.img.pixels) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sc.img.w, sc.img.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(sc.img.pixels.buffer));
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sc.img.el);
      } catch (e) { return; }
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this._imgVer = sc.img.version;
    }
    const els = sc.elements();
    if (this._elVer !== sc.elVersion) {
      const list = els.list, n = Math.max(1, list.length);
      const d = new Float32Array(4 * 4 * n);
      list.forEach((E, r) => {
        const o = r * 16;
        if (E.R) { d.set([E.R[0], E.R[1], E.R[2], 0, E.R[3], E.R[4], E.R[5], 0, E.R[6], E.R[7], E.R[8], 0], o); d.set([0, E.near ? 1 : 0, 0, 0], o + 12); }
        else { const [a, b, c, dd] = E.M; d.set([a[0], a[1], b[0], b[1], c[0], c[1], dd[0], dd[1]], o); d.set(E.uvBox || [-10, -10, 10, 10], o + 8); d.set([E.conj ? 1 : 0, E.near ? 1 : 0, 0, 0], o + 12); }
      });
      gl.bindTexture(gl.TEXTURE_2D, this.elTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, n, 0, gl.RGBA, gl.FLOAT, d);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this._elVer = sc.elVersion;
      this._ng = list.length;
      this._nnear = els.nearCount || 0;
    }
  }

  _fail(msg) {
    let el = this.canvas.parentElement.querySelector('.gl-msg');
    if (!el) { el = document.createElement('div'); el.className = 'gl-msg'; this.canvas.parentElement.appendChild(el); }
    el.textContent = msg;
  }
  _unfail() { this.canvas.parentElement.querySelector('.gl-msg')?.remove(); }

  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.odpr = Math.min(window.devicePixelRatio || 1, 2);     // overlay: always sharp
    this.dpr = this.odpr * this.quality;                       // the pattern: fewer pixels while interacting
    this.cssW = r.width; this.cssH = r.height;
    const set = (c, d) => { const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d)); if (c.width !== w) c.width = w; if (c.height !== h) c.height = h; };
    set(this.canvas, this.dpr);
    set(this.overlay, this.odpr);
  }
  // called on every pointer move / wheel that changes the picture: draw coarse now, sharp when it stops
  interacting() {
    if (INTERACTIVE_QUALITY >= 1) return;
    if (this.quality === 1) { this.quality = INTERACTIVE_QUALITY; this._resize(); }
    clearTimeout(this._sharpen);
    this._sharpen = setTimeout(() => { this.quality = 1; this._resize(); this.requestRender(); }, 180);
  }

  // ── view state ─────────────────────────────────────────────────────────
  resetView() {
    const g = this.model.geo;
    this.view.zoom = 1; this.view.off = [0, 0];
    this.view.V = Mob.id(); this.view.R = M3.id();
    if (!g) return;
    if (g.mode === 'euc') {
      const c = g.comma ? g.comma.c : [0, 0];
      // world z -> s (z - c), with s chosen so the canvas (its shorter side) spans about 2.5
      // lattice cells (cell size = √area of the translation lattice)
      const lat = translationLattice(g);
      const across = 2 / 0.96;                               // screen units across the shorter side at zoom 1
      const s = lat ? across / (EUC_CELLS_ACROSS * Math.sqrt(lat.area)) : 0.32;
      this.view.V = [[s, 0], C.scale(c, -s), [0, 0], [1, 0]];
    } else if (g.mode === 'sph') {
      const c = g.comma ? g.comma.c : [0, 0, 1];
      // world -> view: bring c to face the viewer, then tilt a little
      const Rwv = M3.mul(M3.axisAngle([1, 0, 0], -0.35), M3.fromTo(c, [0, 0, 1]));
      this.view.R = Rwv;
    }
    this.view.mode = g.mode;
    this._emitView();
  }

  baseScale() { return Math.min(this.canvas.width, this.canvas.height) / 2 * 0.96; }
  get S() { return this.baseScale() * this.view.zoom; }

  // CSS px (relative to canvas) -> screen units
  cssToScreen(x, y) {
    const d = this.dpr;
    return [(x * d - this.canvas.width / 2) / this.S - this.view.off[0], -((y * d - this.canvas.height / 2) / this.S) - this.view.off[1]];
  }
  screenToCss(u) {
    const d = this.dpr;
    return [((u[0] + this.view.off[0]) * this.S + this.canvas.width / 2) / d, (-(u[1] + this.view.off[1]) * this.S + this.canvas.height / 2) / d];
  }
  // world point at screen u (null if off the model)
  screenToWorld(u) {
    const g = this.model.geo;
    if (!g) return null;
    if (g.mode === 'sph') {
      const r2 = u[0] * u[0] + u[1] * u[1];
      if (r2 > 1) return null;
      const P = [u[0], u[1], Math.sqrt(1 - r2)];
      return norm3(M3.apply(M3.transpose(this.view.R), P));
    }
    const w = Mob.apply(Mob.inv(this.view.V), u);
    if (g.mode === 'hyp' && w[0] * w[0] + w[1] * w[1] >= 1) return null;
    return w;
  }
  worldToScreen(w) {
    const g = this.model.geo;
    if (g.mode === 'sph') { const P = M3.apply(this.view.R, w); return P[2] >= 0 ? [P[0], P[1]] : null; }
    return Mob.apply(this.view.V, w);
  }
  // CSS px per world unit at world point w
  cssPerWorld(w) {
    const g = this.model.geo;
    if (g.mode === 'sph') return this.S / this.dpr;
    return Mob.deriv(this.view.V, w) * this.S / this.dpr;
  }

  _emitView() { this._listeners.forEach(cb => cb()); }

  pan(u0, u1) {
    const g = this.model.geo; if (!g) return;
    if (g.mode === 'hyp') {
      const cl = u => { const l = Math.hypot(u[0], u[1]); return l > 0.97 ? C.scale(u, 0.97 / l) : u; };
      const a = cl(u0), b = cl(u1);
      const T = Mob.mul(Mob.diskTranslate(b), Mob.diskTranslate(C.scale(a, -1)));
      this.view.V = Mob.normalize(Mob.mul(T, this.view.V));
    } else if (g.mode === 'euc') {
      this.view.V = Mob.mul([[1, 0], C.sub(u1, u0), [0, 0], [1, 0]], this.view.V);
    } else {
      const toS = u => { const r2 = u[0] * u[0] + u[1] * u[1]; if (r2 >= 1) { const l = Math.sqrt(r2); return [u[0] / l, u[1] / l, 0]; } return [u[0], u[1], Math.sqrt(1 - r2)]; };
      this.view.R = M3.orthonormalize(M3.mul(M3.fromTo(toS(u0), toS(u1)), this.view.R));
    }
    this.requestRender(); this._emitView();
  }

  // move the view so world point w shows at css point (x, y) (no turning in 2D)
  placeAt(w, x, y) {
    const g = this.model.geo; if (!g) return;
    const t = this.cssToScreen(x, y);
    if (g.mode === 'sph') {
      const r2 = t[0] * t[0] + t[1] * t[1];
      const T = r2 >= 1 ? [t[0] / Math.sqrt(r2), t[1] / Math.sqrt(r2), 0] : [t[0], t[1], Math.sqrt(1 - r2)];
      this.view.R = M3.orthonormalize(M3.mul(M3.fromTo(norm3(M3.apply(this.view.R, w)), T), this.view.R));
    } else if (g.mode === 'hyp') {
      const l = Math.hypot(t[0], t[1]), tt = l > 0.97 ? C.scale(t, 0.97 / l) : t;
      const s = Mob.apply(this.view.V, w);
      this.view.V = Mob.normalize(Mob.mul(Mob.mul(Mob.diskTranslate(tt), Mob.diskTranslate(C.scale(s, -1))), this.view.V));
    } else {
      const s = Mob.apply(this.view.V, w);
      this.view.V = Mob.mul([[1, 0], C.sub(t, s), [0, 0], [1, 0]], this.view.V);
    }
    this.requestRender(); this._emitView();
  }

  // zoom by factor f about css point (x, y)
  zoomAt(f, x, y) {
    const g = this.model.geo; if (!g) return;
    if (g.mode === 'euc') {
      const u = this.cssToScreen(x, y);
      // scale world about the pointer
      const Z = [[f, 0], C.scale(u, 1 - f), [0, 0], [1, 0]];
      this.view.V = Mob.mul(Z, this.view.V);
    } else {
      const before = this.cssToScreen(x, y);
      const nz = Math.min(Math.max(this.view.zoom * f, 0.5), 8);
      this.view.zoom = nz;
      const after = this.cssToScreen(x, y);
      this.view.off = [this.view.off[0] + (after[0] - before[0]), this.view.off[1] + (after[1] - before[1])];
      if (nz <= 1.0001) this.view.off = this.view.off.map(v => v * 0.8);
    }
    this.requestRender(); this._emitView();
  }

  // keep world point W (in the copy) at screen point target (hyperbolic only),
  // with direction toward W1 matching target1
  anchor(Vstash, W, W1, target, target1) {
    const s = Mob.apply(Vstash, W), s1 = Mob.apply(Vstash, W1);
    const A = Mob.diskTranslate(C.scale(s, -1));          // s -> 0
    const d0 = Mob.apply(A, s1);
    const B = Mob.diskTranslate(C.scale(target, -1));
    const d1 = Mob.apply(B, target1);
    const phi = Math.atan2(d1[1], d1[0]) - Math.atan2(d0[1], d0[0]);
    const Cm = Mob.mul(Mob.diskTranslate(target), Mob.mul(Mob.rotate(phi), A));
    this.view.V = Mob.normalize(Mob.mul(Cm, Vstash));
  }

  requestRender(propagate = true) {
    if (propagate) this.partners.forEach(p => p.requestRender(false));
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  // bring the shared textures (domain data, image, elements) up to date without drawing
  prepare() {
    const g = this.model.geo;
    if (!this.gl || !g) return false;
    if (this._dataDirty || this._uploadedVersion !== g.version) this._upload();
    if (this.scene && this.scene.img && this.scene.place) this._uploadScene();
    return true;
  }
  markDataDirty() { this._dataDirty = true; this.partners.forEach(p => { p._dataDirty = true; }); this.requestRender(); }

  // ── data texture ───────────────────────────────────────────────────────
  _upload() {
    const g = this.model.geo, gl = this.gl;
    if (!g || !gl) return;
    const hl = this.highlight.current || {};
    const hf = new Set(hl.faces || []), hi = new Set(hl.inner || []), hp = new Set(hl.points || []);
    const faces = g.faces.slice(0, MAXF), inner = (g.inner || []).slice(0, 32), points = (g.points || []).slice(0, 48);
    const rows = Math.max(1, faces.length + inner.length + points.length);
    const data = new Float32Array(WIDTH * 4 * rows);
    const put = (row, col, v) => data.set(v, (row * WIDTH + col) * 4);
    const sph = g.mode === 'sph';
    const wv = w => sph ? [w[0], w[1], w[2], 0] : w.type === 1 ? [w.c[0], w.c[1], 0, w.r] : [w.n[0], w.n[1], 0, w.d];
    const wt = w => sph ? 2 : w.type;
    const widthOf = f => (f.kind === 'mirror' ? 3.2 : f.pair !== undefined ? 2.6 : 2.0);
    faces.forEach((f, r) => {
      put(r, 0, wv(f.wall));
      const nb = Math.min(f.bounds.length, 4), nt = Math.min(f.tr.length, 6);
      for (let j = 0; j < nb; j++) put(r, 1 + j, wv(f.bounds[j]));
      for (let j = 0; j < nt; j++) put(r, 5 + j, wv(f.tr[j]));
      put(r, 11, [wt(f.wall), nb, nt, 0]);
      const bt = [0, 0, 0, 0]; for (let j = 0; j < nb; j++) bt[j] = wt(f.bounds[j]);
      const tt = [0, 0, 0, 0, 0, 0]; for (let j = 0; j < nt; j++) tt[j] = wt(f.tr[j]);
      put(r, 12, bt);
      put(r, 13, tt.slice(0, 4));
      put(r, 14, [tt[4], tt[5], 0, hf.has(r) ? 1 : 0]);
      put(r, 15, [...hexToRgb(f.color), widthOf(f)]);
    });
    inner.forEach((e, i) => {
      const r = faces.length + i;
      put(r, 0, wv(e.wall));
      put(r, 1, [...(e.A || [0, 0]), ...(e.B || [0, 0])]);
      put(r, 2, [wt(e.wall), hi.has(i) ? 1 : 0, 0, 0]);
      put(r, 3, [...hexToRgb('#6b6a62'), 1.6]);
    });
    points.forEach((pt, i) => {
      const r = faces.length + inner.length + i;
      put(r, 0, sph ? [...pt.pos, 0] : [pt.pos[0], pt.pos[1], 0, 0]);
      put(r, 1, [pt.kind === 'cone' ? 0 : 1, pt.n, hp.has(i) ? 1 : 0, 0]);
      put(r, 2, [...hexToRgb(pt.kind === 'cone' ? '#e8590c' : '#c2255c'), 1]);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, WIDTH, rows, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this._counts = [faces.length, inner.length, points.length];
    this._uploadedVersion = g.version;
    this._dataDirty = false;
  }

  // uniforms shared by the pattern and the domain-texture programs (U: that program's locations)
  _orbitUniforms(U, sc, st, has, mode) {
    const gl = this.gl, set = (n, f, ...v) => { if (U[n]) gl['uniform' + f](U[n], ...v); };
    set('uData', '1i', 0); set('uImg', '1i', 2); set('uMask', '1i', 3); set('uEl', '1i', 4); set('uActive', '1i', 5);
    set('uMode', '1i', mode); set('uNF', '1i', this._counts ? this._counts[0] : 0);
    set('uNG', '1i', has ? this._ng || 0 : 0); set('uNNear', '1i', has ? this._nnear || 0 : 0);
    set('uMaskMode', '1i', has && sc.maskMode === 'custom' ? 1 : 0);
    set('uAvg', '1i', ({ mean: 0, height: 1, first: 3 })[st.avg] ?? 1);
    if (!has) return;
    const pl = sc.place, L = Math.max(sc.img.w, sc.img.h), ch = this.chart;
    set('uFlip', '1i', pl.flip ? 1 : 0); set('uPlace', '4f', pl.c[0], pl.c[1], pl.a[0], pl.a[1]);
    set('uK', '2f', L / sc.img.w, L / sc.img.h); set('uPole', '1f', pl.pole || 1);
    set('uTexPer', '1f', L / (2 * Math.hypot(pl.a[0], pl.a[1]))); set('uFeather', '1f', sc.featherRadius());
    if (ch) {
      set('uChart', '4f', ...ch.box); set('uChC', '3f', ...ch.c); set('uChE1', '3f', ...ch.e1); set('uChE2', '3f', ...ch.e2);
      set('uDomSize', '2f', this.domW || 1, this.domH || 1);
    }
  }

  // The chart of F the domain texture is laid out in: a box round F in world coordinates (2D),
  // or round F in the stereographic chart about the comma (sphere).
  _chartFor(g) {
    if (g.mode !== 'sph') {
      const pts = [g.comma.c];
      for (const f of g.faces) {
        if (!f.ends || !f.ends[0] || !f.ends[1]) continue;
        for (let i = 0; i <= 16; i++) pts.push(g.mode === 'hyp' ? hypLerp(f.ends[0], f.ends[1], i / 16) : [f.ends[0][0] + (f.ends[1][0] - f.ends[0][0]) * i / 16, f.ends[0][1] + (f.ends[1][1] - f.ends[0][1]) * i / 16]);
      }
      let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
      const pad = 0.03 * Math.max(x1 - x0, y1 - y0, 1e-3);
      x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
      if (g.mode === 'hyp') { x0 = Math.max(x0, -1); y0 = Math.max(y0, -1); x1 = Math.min(x1, 1); y1 = Math.min(y1, 1); }
      return { box: [x0, y0, x1, y1], c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0] };
    }
    const c = g.comma.c, a = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const e1 = norm3(cross3(a, c)), e2 = cross3(c, e1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const z = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - z * z), t = i * 2.399963229728653;
      const P = [r * Math.cos(t), r * Math.sin(t), z];
      if (g.faces.length && g.reduce(P).word.length) continue;          // outside F
      const d = Math.max(1 + dot3(P, c), 1e-4), x = dot3(P, e1) / d, y = dot3(P, e2) / d;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const pad = 0.05 * Math.max(x1 - x0, y1 - y0, 1e-3), cap = 4;
    return { box: [Math.max(x0 - pad, -cap), Math.max(y0 - pad, -cap), Math.min(x1 + pad, cap), Math.min(y1 + pad, cap)], c, e1, e2 };
  }

  // texels per chart unit the domain texture needs: as many as the screen shows of the most
  // magnified copy of F (measured at full resolution, so interaction doesn't change it)
  _domainDensity(g) {
    const S = Math.min(this.cssW, this.cssH) / 2 * 0.96 * this.odpr * this.view.zoom;
    if (g.mode === 'sph') return 2 * S;
    let m = Mob.deriv(this.view.V, g.comma.c);
    if (g.mode === 'hyp') {
      const w0 = this.screenToWorld([0, 0]);
      if (w0) { const r = g.reduce(w0); if (r.ok) m = Math.max(m, Mob.deriv(this.view.V, w0) / r.k); }
    }
    return S * m;
  }

  // (re)compute the domain texture when anything it depends on changed
  _updateDomain(sc, st, mode) {
    const gl = this.gl, g = this.model.geo;
    const ck = `${g.version}|${g.comma.c}`;
    if (this.chartKey !== ck) { this.chart = this._chartFor(g); this.chartKey = ck; }
    const b = this.chart.box, bw = b[2] - b[0], bh = b[3] - b[1];
    let dens = this._domainDensity(g);
    dens = Math.pow(2, Math.ceil(Math.log2(Math.max(dens, 1e-6)) * 2) / 2);      // buckets of √2, so small view changes reuse it
    const MAXT = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 2048);
    let W = Math.ceil(bw * dens), H = Math.ceil(bh * dens);
    const f = Math.min(1, MAXT / Math.max(W, H));
    W = Math.max(8, Math.round(W * f)); H = Math.max(8, Math.round(H * f));
    const key = [W, H, ck, sc.img.version, sc.maskMode, sc.maskVersion, sc.gpu?.cur, this._elVer, st.avg, sc.featherRadius().toFixed(5), JSON.stringify(sc.place)].join('|');
    if (key === this.domKey && this.domTex) return;
    gl.activeTexture(gl.TEXTURE6);       // unit 6 is the domain texture's own: never bind it where the pass samples
    if (!this.domTex || this.domW !== W || this.domH !== H) {
      if (this.domTex) { gl.deleteTexture(this.domTex); gl.deleteFramebuffer(this.domFbo); }
      this.domTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.domTex);
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(W, H))) + 1, gl.RGBA8, W, H);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.domFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.domFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.domTex, 0);
      this.domW = W; this.domH = H;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(this.cacheProg); gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.domFbo);
    gl.viewport(0, 0, W, H);
    this._orbitUniforms(this.cacheUni, sc, st, true, mode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.domTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.domKey = key;
    this.G.domainPasses = (this.G.domainPasses || 0) + 1;
  }

  render() {
    const gl = this.gl, g = this.model.geo;
    if (!gl || !this.prog || gl.isContextLost()) return;
    if (this.canvas.width < 2 || !this.canvas.offsetParent) return;
    const Gc = this.G.canvas;
    if (!this.direct && (Gc.width !== this.canvas.width || Gc.height !== this.canvas.height)) { Gc.width = this.canvas.width; Gc.height = this.canvas.height; }
    if (g && this.view.mode !== g.mode) this.resetView();
    if (g && (this._dataDirty || this._uploadedVersion !== g.version)) this._upload();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const U = this.uni;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dataTex); gl.uniform1i(U.uData, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.motifTex); gl.uniform1i(U.uMotif, 1);
    const mode = !g ? 2 : g.mode === 'hyp' ? 0 : g.mode === 'euc' ? 1 : 2;
    gl.uniform1i(U.uMode, mode);
    const [nf, ni, np] = g ? this._counts : [0, 0, 0];
    gl.uniform1i(U.uNF, nf); gl.uniform1i(U.uNI, ni); gl.uniform1i(U.uNP, np);
    gl.uniform2f(U.uCenter, this.canvas.width / 2, this.canvas.height / 2);
    gl.uniform1f(U.uS, this.S);
    gl.uniform2f(U.uOff, this.view.off[0], this.view.off[1]);
    const Vi = Mob.normalize(Mob.inv(this.view.V));
    gl.uniform4f(U.uV0, Vi[0][0], Vi[0][1], Vi[1][0], Vi[1][1]);
    gl.uniform4f(U.uV1, Vi[2][0], Vi[2][1], Vi[3][0], Vi[3][1]);
    // uR: view -> world = R^T ; GLSL mat3 is column-major, so pass R (row-major) untransposed
    gl.uniformMatrix3fv(U.uR, false, new Float32Array(this.view.R));
    const cm = g && g.comma ? g.comma : { c: [0, 0], size: 0.1 };
    if (mode === 2) {
      const c = cm.c.length === 3 ? cm.c : [0, 0, 1];
      let e1 = cm.e1, e2 = cm.e2;
      if (!e1) { const a = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; e1 = norm3(cross3(a, c)); e2 = cross3(c, e1); }
      gl.uniform3f(U.uCommaC, ...c); gl.uniform3f(U.uCommaE1, ...e1); gl.uniform3f(U.uCommaE2, ...e2);
    } else {
      gl.uniform3f(U.uCommaC, cm.c[0], cm.c[1], 0);
      const A = cm.A || [1, 0, 0, 1];
      gl.uniformMatrix2fv(U.uCommaA, false, new Float32Array([A[0], A[2], A[1], A[3]]));   // column-major
    }
    gl.uniform1i(U.uCommaHL, this.motifState || 0);
    gl.uniform1f(U.uCommaSize, cm.size);
    gl.uniform1f(U.uDpr, this.dpr);
    gl.uniform1f(U.uDim, this.dim);
    gl.uniform1i(U.uHomeTint, 1);
    // bitmap
    const sc = this.scene, st = sc ? sc.settings : {};
    const has = !!(sc && sc.img && sc.place && g);
    if (has) this._uploadScene();
    const act = has && sc.maskMode === 'custom' && sc.gpu && st.avg === 'mean' ? sc.gpu.activeTexture(sc, this._ng || 0, this._elVer) : null;
    // textures on fixed units for both programs
    const bind = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); };
    bind(0, this.dataTex); bind(1, this.motifTex); bind(2, this.imgTex); bind(3, sc?.gpu?.texture() || null); bind(4, this.elTex); bind(5, act);
    if (has) this._updateDomain(sc, st, mode);
    bind(6, has ? this.domTex : null);
    gl.useProgram(this.prog); gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._orbitUniforms(U, sc, st, has, mode);
    gl.uniform1i(U.uDom, 6);
    gl.uniform1i(U.uHasImg, has && this._imgVer >= 0 && this.domTex ? 1 : 0);
    gl.uniform1i(U.uShow, this.adjusting ? 1 : 0);
    gl.uniform1i(U.uGuides, st.guides ? 1 : 0);
    gl.uniform1i(U.uShowComma, st.showComma || !has ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!this.direct) { this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height); this.ctx2d.drawImage(Gc, 0, 0); }
    this.drawOverlay();
  }

  // ── 2D overlay: glue arrows on the home tile, lattice handles ───────────
  drawOverlay() {
    const ctx = this.octx, g = this.model.geo, d = this.odpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!g || this.dim > 0.3) return;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const toCss = w => { const s = this.worldToScreen(w); return s ? this.screenToCss(s) : null; };

    // arrows on paired edges of the home tile (not for the sphere)
    if (g.mode !== 'sph') {
      const lerp = (a, b, t) => g.mode === 'hyp' ? hypLerp(a, b, t) : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const seen = new Map();
      g.faces.forEach((f, i) => {
        if (f.pair === undefined || !f.ends) return;
        const [A, B] = f.ends;
        let from = A, to = B;
        // arrows on the partner run from tr(A) to tr(B)
        if (seen.has(f.pair)) {
          const first = g.faces[seen.get(f.pair)];
          const ta = apply2(first.tr, first.ends[0]).p, tb = apply2(first.tr, first.ends[1]).p;
          from = ta; to = tb;
        } else seen.set(f.pair, i);
        const count = (f.pair % 3) + 1;
        for (let c = 0; c < count; c++) {
          const t = 0.5 + (c - (count - 1) / 2) * 0.07;
          const p0 = toCss(lerp(from, to, t - 0.02)), p1 = toCss(lerp(from, to, t + 0.02));
          if (!p0 || !p1) continue;
          this._chevron(ctx, p0, p1, f.color);
        }
      });
    }

    // adjusting the image: a gray line round its edge
    const sc = this.scene;
    if (this.adjusting && sc && sc.img && sc.place) {
      const pole = sc.place.pole || 1, N = 64;
      ctx.beginPath();
      let pen = false;
      for (let e = 0; e < 4; e++) for (let i = 0; i <= N; i++) {
        const t = i / N;
        const uv = [[t, 0], [1, t], [1 - t, 1], [0, 1 - t]][e];
        const w = worldOfPlane(g.mode, planeOfUV(sc.place, sc.img, uv), pole);
        const c = (g.mode === 'hyp' && w[0] * w[0] + w[1] * w[1] >= 1) ? null : toCss(w);
        if (!c) { pen = false; continue; }
        if (pen) ctx.lineTo(c[0], c[1]); else ctx.moveTo(c[0], c[1]);
        pen = true;
      }
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#8a8a86'; ctx.stroke();
    }
    if (this.cursor) {
      ctx.beginPath(); ctx.arc(this.cursor.x, this.cursor.y, this.cursor.r, 0, 2 * Math.PI);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(251,250,246,.9)'; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = this.cursor.sign < 0 ? '#c2255c' : '#1a1a1f'; ctx.stroke();
    }

    // lattice handles
    for (const h of g.handles || []) {
      const p = toCss(h.pos); if (!p) continue;
      if (h.from) {
        const o = toCss(h.from);
        if (o) {
          ctx.strokeStyle = h.fixed ? '#52514a' : '#1a1a1f'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
          const ang = Math.atan2(p[1] - o[1], p[0] - o[0]);
          ctx.beginPath(); ctx.moveTo(p[0], p[1]);
          ctx.lineTo(p[0] - 10 * Math.cos(ang - 0.4), p[1] - 10 * Math.sin(ang - 0.4));
          ctx.lineTo(p[0] - 10 * Math.cos(ang + 0.4), p[1] - 10 * Math.sin(ang + 0.4));
          ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
        }
      }
      if (h.fixed) continue;
      const active = this.hover && this.hover.type === 'handle' && this.hover.handle.id === h.id;
      ctx.beginPath(); ctx.arc(p[0], p[1], active ? 9 : 7, 0, 2 * Math.PI);
      ctx.fillStyle = active ? '#ffd43b' : '#fbfaf6'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#1a1a1f'; ctx.stroke();
    }
  }

  _chevron(ctx, p0, p1, color) {
    const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    const m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], L = 6;
    ctx.beginPath();
    ctx.moveTo(m[0] - L * Math.cos(ang - 0.6), m[1] - L * Math.sin(ang - 0.6));
    ctx.lineTo(m[0] + 2 * Math.cos(ang), m[1] + 2 * Math.sin(ang));
    ctx.lineTo(m[0] - L * Math.cos(ang + 0.6), m[1] - L * Math.sin(ang + 0.6));
    ctx.lineWidth = 4.5; ctx.strokeStyle = '#fbfaf6'; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke();
  }

  // pixel distance helpers for FeatureTool: fold a CSS point
  probe(x, y) {
    const g = this.model.geo; if (!g) return null;
    const u = this.cssToScreen(x, y);
    const w = this.screenToWorld(u);
    if (!w) return null;
    const r = g.reduce(w);
    // CSS px per unit of folded coordinates
    const scale = g.mode === 'sph' ? this.S / this.dpr : this.cssPerWorld(w) / r.k;
    return { u, w, ...r, scale };
  }
}
