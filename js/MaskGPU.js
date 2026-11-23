// MaskGPU.js — the mask (a contravariant distribution over the image) as a GPU
// texture, and the passes that change it. Shares the views' WebGL context and
// their domain / element textures (PatternView.prepare uploads those).
//
//   bake   the fundamental domain, feathered: w = smoothstep(−r, r, signed distance)
//   brush  one pass per pointer move, for all its dabs at once. Every mask pixel y
//          runs independently, reading only the old mask:
//            – under the brush:      new = old ± B(y), clamped to [0, 1]
//            – otherwise: fold y, try each listed copy g(f) of its orbit; at the
//              first one under the brush, x, scale: new = old·(1 − n_x)/(1 − o_x)
//          so each orbit keeps summing to one (patent, "Masks"). B is the soft
//          union of the dabs, 1 − Π(1 − b_i).
// Two R32F textures take turns as source and target (a pass cannot read what it writes).

import { COMMON } from './PatternView.js';

export const MAX_DABS = 48;

const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0., 1.); }`;

const PRE = COMMON + `
uniform vec2 uMS;            // mask size in pixels
out vec4 outColor;
// world point of mask pixel centre y (false: off the hyperbolic disk)
bool worldOfPx(vec2 y, out vec2 p, out vec3 P){
  vec2 z = planeOfUV(y / uMS);
  p = z; P = vec3(0.);
  if (uMode == 2) { P = sphOfPlane(z); return true; }
  return !(uMode == 0 && dot(z, z) >= 0.9999);
}
`;

const BAKE = PRE + `
void main(){
  vec2 p; vec3 P;
  outColor = vec4(worldOfPx(gl_FragCoord.xy, p, P) ? wdom(p, P) : 0., 0., 0., 1.);
}`;

const BRUSH = PRE + `
uniform sampler2D uOld;
uniform vec4 uDabs[${MAX_DABS}];   // centre (mask px), radius (mask px), strength
uniform int uNDab;
uniform float uSign;
uniform vec4 uBox;                 // bounding box of the dabs, mask px
float B(vec2 x){
  if (x.x < uBox.x || x.y < uBox.y || x.x > uBox.z || x.y > uBox.w) return 0.;
  float keep = 1.;
  for (int i = 0; i < ${MAX_DABS}; i++) {
    if (i >= uNDab) break;
    vec4 d = uDabs[i];
    float t = length(x - d.xy) / d.z;
    if (t < 1.) { float b = d.w * (1. - t * t) * (1. - t * t); keep *= 1. - b; }
  }
  return 1. - keep;
}
float after(float o, float b){ return uSign > 0. ? min(o + b, 1.) : max(o - b, 0.); }
float oldAt(vec2 x){             // bilinear, by hand (R32F need not be filterable)
  vec2 s = x - .5; ivec2 i = ivec2(floor(s)); vec2 f = fract(s);
  ivec2 M = ivec2(uMS) - 1;
  float a = texelFetch(uOld, clamp(i, ivec2(0), M), 0).r, b = texelFetch(uOld, clamp(i + ivec2(1, 0), ivec2(0), M), 0).r;
  float c = texelFetch(uOld, clamp(i + ivec2(0, 1), ivec2(0), M), 0).r, d = texelFetch(uOld, clamp(i + ivec2(1, 1), ivec2(0), M), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main(){
  vec2 y = gl_FragCoord.xy;
  float old = texelFetch(uOld, ivec2(y), 0).r;
  float by = B(y);
  if (by > 0.) { outColor = vec4(after(old, by), 0., 0., 1.); return; }
  outColor = vec4(old, 0., 0., 1.);
  vec2 p; vec3 P;
  if (!worldOfPx(y, p, P) || !foldP(p, P)) return;
  for (int e = 0; e < 1024; e++) {
    if (e >= uNG) break;
    vec2 q; vec3 Q; float gd;
    applyEl(e, p, P, q, Q, gd);
    vec2 x = uvOf(planeOf(q, Q)) * uMS;
    float bx = B(x);
    if (bx <= 0. || distance(x, y) < 0.5) continue;
    float o = oldAt(x), n = after(o, bx);
    if (1. - o > 1e-4) outColor.r = old * (1. - n) / (1. - o);
    else if (uSign < 0.) outColor.r = 1. - n;     // the orbit had all its weight at x: hand back the rest
    return;
  }
}`;

export class MaskGPU {
  constructor(view) {
    this.view = view;               // any PatternView: for the shared context and its textures
    this.w = this.h = 0;
    this.tex = []; this.fbo = []; this.cur = 0;
    this.ok = false;
  }
  get gl() { return this.view.gl; }

  _init() {
    if (this.progs) return true;
    const gl = this.gl;
    if (!gl || !this.view.G.floatRender) return false;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const mk = src => {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, src));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, name); }
      return { p, u };
    };
    this.progs = { bake: mk(BAKE), brush: mk(BRUSH) };
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return true;
  }

  // (re)allocate both textures at w×h; contents undefined until written
  ensure(w, h) {
    if (!this._init()) return false;
    if (w === this.w && h === this.h) return true;
    const gl = this.gl;
    const filt = this.view.G.floatLinear ? gl.LINEAR : gl.NEAREST;
    for (let i = 0; i < 2; i++) {
      if (this.tex[i]) { gl.deleteTexture(this.tex[i]); gl.deleteFramebuffer(this.fbo[i]); }
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.tex[i] = t; this.fbo[i] = f;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.w = w; this.h = h; this.cur = 0;
    return true;
  }
  texture() { return this.w ? this.tex[this.cur] : null; }

  // uniforms the shared GLSL needs: domain data, elements, placement
  _common(prog, scene) {
    const gl = this.gl, u = prog.u, v = this.view, pl = scene.place, img = scene.img, g = scene.model.geo;
    const L = Math.max(img.w, img.h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, v.dataTex); gl.uniform1i(u.uData, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, v.elTex); gl.uniform1i(u.uEl, 1);
    gl.uniform1i(u.uMode, g.mode === 'hyp' ? 0 : g.mode === 'euc' ? 1 : 2);
    gl.uniform1i(u.uNF, v._counts ? v._counts[0] : 0);
    if (u.uNG) gl.uniform1i(u.uNG, v._ng || 0);
    gl.uniform1i(u.uFlip, pl.flip ? 1 : 0);
    gl.uniform4f(u.uPlace, pl.c[0], pl.c[1], pl.a[0], pl.a[1]);
    gl.uniform2f(u.uK, L / img.w, L / img.h);
    gl.uniform1f(u.uPole, pl.pole || 1);
    if (u.uFeather) gl.uniform1f(u.uFeather, scene.featherRadius());
    gl.uniform2f(u.uMS, this.w, this.h);
  }
  _draw(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[target]);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bake(scene) {
    if (!this.view.prepare()) return false;
    const [w, h] = scene.maskDims();
    if (!this.ensure(w, h)) return false;
    const P = this.progs.bake, gl = this.gl;
    gl.useProgram(P.p);
    this._common(P, scene);
    this._draw(this.cur);
    return true;
  }

  fill(value) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.clearBufferfv(gl.COLOR, 0, [value, 0, 0, 1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  upload(data, w, h) {
    if (!this.ensure(w, h)) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return true;
  }
  read() {
    const gl = this.gl, n = this.w * this.h;
    const rgba = new Float32Array(4 * n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = rgba[4 * i];
    return out;
  }

  // dabs: [{ x, y, r, s }] in mask pixels; sign ±1. One pass.
  brush(scene, dabs, sign) {
    if (!dabs.length || !this.view.prepare()) return false;
    const gl = this.gl, P = this.progs.brush;
    gl.useProgram(P.p);
    this._common(P, scene);
    for (let k = 0; k < dabs.length; k += MAX_DABS) {
      const part = dabs.slice(k, k + MAX_DABS);
      const arr = new Float32Array(4 * MAX_DABS);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      part.forEach((d, i) => { arr.set([d.x, d.y, d.r, d.s], 4 * i); x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); });
      gl.uniform4fv(P.u.uDabs, arr);
      gl.uniform1i(P.u.uNDab, part.length);
      gl.uniform1f(P.u.uSign, sign);
      gl.uniform4f(P.u.uBox, x0, y0, x1, y1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]); gl.uniform1i(P.u.uOld, 2);
      this._draw(1 - this.cur);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
      this.cur = 1 - this.cur;
    }
    return true;
  }
}
