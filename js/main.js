// main.js — boot Orbipix and wire the pieces together.

import { OrbifoldModel } from './OrbifoldModel.js';
import { Highlight } from './Highlight.js';
import { PatternView } from './PatternView.js';
import { FeatureTool } from './FeatureTool.js';
import { SignatureEditor } from './SignatureEditor.js';
import { Scene } from './Scene.js';
import { MaskGPU } from './MaskGPU.js';
import * as Saved from './Saved.js';
import { PRESETS } from './presets.js';
import { makeDefaultPicture } from './textures.js';
import * as Sig from './Signature.js';

const $ = s => document.querySelector(s);
// what a first visit shows (everyone after that gets their own last state back, see Saved.js)
const DEFAULT_STATE = {
  signature: '344', params: {}, motif: null,
  place: { c: [-0.018007841176228945, -0.030922140667925056], a: [0.28210912100031726, 0], flip: false, pole: 1, mode: 'hyp' },
  settings: { feather: 0.35, avg: 'height', guides: true, showComma: false, brush: 36, strength: 0.35 },
  mode: 'pattern', tool: 'navigate',
  view: { mode: 'hyp', V: [[1, 0], [0, 0], [0, 0], [1, 0]], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], zoom: 1, off: [0, 0] },
  mask: 'domain',
};

const model = new OrbifoldModel();
const highlight = new Highlight();
const scene = new Scene(model);
const view = new PatternView($('#pattern'), $('#overlay'), model, highlight, { scene, kind: 'pattern' });
scene.gpu = new MaskGPU(view);
let currentTool = 'navigate';     // 'navigate' in Pattern mode; 'move' | 'brush' | 'erase' while adjusting the image
let adjustTool = 'move';

// ── history (signature + parameters) ────────────────────────────────────
const undo = [], redo = [];
let maskSnap = null, maskSnapVer = -1;
const snapMask = () => { if (maskSnapVer !== scene.maskVersion) { maskSnap = scene.maskSnapshot(); maskSnapVer = scene.maskVersion; } return maskSnap; };
const snap = () => ({ sig: model.getSignature(), params: model.bad ? (undo[undo.length - 1]?.params || {}) : model.params.snapshot(), motif: model.bad ? null : model.motif,
  place: scene.place ? { ...scene.place } : null, mask: snapMask(), avg: scene.settings.avg });
const same = (a, b) => a && b && a.sig === b.sig && JSON.stringify(a.params) === JSON.stringify(b.params) && JSON.stringify(a.motif) === JSON.stringify(b.motif)
  && JSON.stringify(a.place) === JSON.stringify(b.place) && a.mask === b.mask && a.avg === b.avg;
const UNDO_MAX = 60;
let saveTimer = 0, booted = false;
function saveSoon() {
  if (!booted) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (model.bad || !scene.img) return;
    const st = collectState(); delete st.maskPng;
    Saved.set('state', st);
    Saved.set('mask', scene.maskSnapshot());
  }, 500);
}
function commit() {
  saveSoon();
  const s = snap();
  if (!same(undo[undo.length - 1], s)) { undo.push(s); if (undo.length > UNDO_MAX) undo.shift(); redo.length = 0; }
  writeHash();
  updateUndoButtons();
}
function restore(s) {
  applySignature(s.sig, { params: s.params, motif: s.motif, history: false });
  editor.set(s.sig);
  if (s.place) scene.setPlace(s.place);
  if (s.avg && s.avg !== scene.settings.avg) { scene.settings.avg = s.avg; syncSettingsUI(); }
  if (s.mask !== snapMask()) { scene.restoreMask(s.mask); maskSnap = s.mask; maskSnapVer = scene.maskVersion; }
}
function updateUndoButtons() { $('#undo').disabled = undo.length < 2; $('#redo').disabled = redo.length === 0; }
$('#undo').onclick = () => doUndo();
$('#redo').onclick = () => doRedo();
function doUndo() { if (undo.length < 2) return; redo.push(undo.pop()); restore(undo[undo.length - 1]); writeHash(); updateUndoButtons(); }
function doRedo() { if (!redo.length) return; const s = redo.pop(); undo.push(s); restore(s); writeHash(); updateUndoButtons(); }

// ── URL hash: #<signature>&name=value… ──────────────────────────────────
function writeHash() {
  const p = model.bad ? {} : model.params.snapshot();
  const parts = [encodeURIComponent(model.getSignature()).replace(/%2A/gi, '*') || '-'];
  const num = v => (+v).toFixed(4).replace(/\.?0+$/, '') || '0';
  for (const [k, v] of Object.entries(p)) parts.push(`${k}=${num(v)}`);
  const m = model.bad ? null : model.motif;      // user-placed comma: m=c…,frame…,size
  if (m) parts.push('m=' + [...m.c, ...(m.A || [...m.e1, ...m.e2]), m.size].map(num).join(','));
  const pl = scene.place;
  if (pl && !model.bad) parts.push('p=' + [...pl.c, ...pl.a, pl.flip ? 1 : 0, pl.pole || 1].map(num).join(','));
  history.replaceState(null, '', '#' + parts.join('&'));
}
function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return null;
  const [sig, ...rest] = h.split('&');
  const params = {};
  let motif = null, place = null;
  for (const kv of rest) {
    const [k, v] = kv.split('=');
    if (k === 'p' && v) {
      const a = v.split(',').map(Number);
      if (a.length === 6 && a.every(Number.isFinite)) place = { c: a.slice(0, 2), a: a.slice(2, 4), flip: !!a[4], pole: a[5] };
    } else if (k === 'm' && v) {
      const a = v.split(',').map(Number);
      if (a.every(Number.isFinite)) {
        if (a.length === 7) motif = { c: a.slice(0, 2), A: a.slice(2, 6), size: a[6] };
        else if (a.length === 10) motif = { c: a.slice(0, 3), e1: a.slice(3, 6), e2: a.slice(6, 9), size: a[9] };
      }
    } else if (k && v !== undefined && Number.isFinite(+v)) params[k] = +v;
  }
  return { sig: sig === '-' ? '' : sig, params, motif, place };
}

// ── signature changes ───────────────────────────────────────────────────
function applySignature(text, { params, motif = null, history: hist = true, resetView = false } = {}) {
  const prevMode = model.geo?.mode;
  if (text !== model.getSignature() || !motif) tool?.select(false);
  if (text !== model.getSignature()) scene.symmetryChanged();
  model.setSignature(text, { params, motif });
  if (!model.bad && (resetView || model.geo.mode !== prevMode)) view.resetView();
  if (hist) commit();
}

const editor = new SignatureEditor({
  root: $('#sig-editor'), model, highlight,
  onChange: (text) => applySignature(text),
  onPreset: dir => {
    const cur = PRESETS.findIndex(p => p.signature === model.getSignature());
    const i = cur < 0 ? (dir > 0 ? 0 : PRESETS.length - 1) : (cur + dir + PRESETS.length) % PRESETS.length;
    loadPreset(PRESETS[i]);
  },
});

function loadPreset(p) {
  applySignature(p.signature, { params: p.params || {}, resetView: true });
  editor.set(model.getSignature());
}

const toolOpts = {
  model, highlight, scene, getTool: () => currentTool,
  onOrder: (i, d) => { const t = model.tokens[i]; if (t) editor.setOrderAt(i, t.n + d); },
  onCommit: () => commit(),
  onBrushSize: f => setBrush(scene.settings.brush * f),
};
const tool = new FeatureTool({ ...toolOpts, view, canvas: $('#pattern'), tip: $('#tip') });


// ── reacting to model changes ───────────────────────────────────────────
model.on('change', ev => {
  const bad = model.isBad();
  view.dim = bad ? 0.55 : 0;
  $('.pane-pattern').classList.toggle('is-bad', bad);
  view.markDataDirty();
  renderStats();
  if (ev.kind === 'motif') { writeHash(); return; }
  if (ev.kind !== 'params') {
    renderCaption();
    renderExamples();
    highlight.clear();
  }
  renderParams();
  renderHint();
});

function renderCaption() {
  const p = PRESETS.find(p => p.signature === model.getSignature());
  $('#caption').textContent = model.error ? model.error : p ? p.caption : '';
}

function renderHint() {
  const g = model.geo;
  if (model.isBad()) { $('#hint').textContent = 'No pattern has this signature — the last good one is shown faded.'; return; }
  if (!g) return;
  if (currentTool === 'move') { $('#hint').textContent = 'Adjusting the image: drag to move it, shift-drag to turn it, wheel to scale it · alt-drag pans · P returns to the pattern.'; return; }
  if (currentTool === 'brush' || currentTool === 'erase') {
    $('#hint').textContent = (currentTool === 'brush' ? 'Brush: pulls the image under it into the pattern' : 'Erase: pushes the image under it out of the pattern') + ' · shift-wheel resizes the brush · alt-drag pans · P returns to the pattern.';
    return;
  }
  const m = g.mode === 'hyp' ? 'Poincaré disk: drag empty space to slide the plane, hover edges to reshape'
    : g.mode === 'euc' ? 'The flat plane: drag to slide, wheel to zoom' + (g.handles.some(h => !h.fixed) ? ', round handles reshape the lattice' : '; this lattice is rigid')
      : 'A sphere: drag to turn it, wheel to zoom';
  $('#hint').textContent = m + ' · 0 resets the view.';
}

function renderParams() {
  const el = $('#params');
  const g = model.geo;
  if (model.isBad() || !g) { el.innerHTML = ''; return; }
  const names = model.params.names();
  if (!names.length) {
    el.innerHTML = `<p class="none">${g.mode === 'sph' ? 'Spherical patterns are rigid: nothing to reshape, only to turn.' : g.mode === 'euc' ? 'This lattice is rigid: only its size could change, and that is just zoom.' : 'This pattern is rigid: its shape is fixed by its corners.'}</p>`;
    return;
  }
  const label = n => {
    const [key, idx, s] = n.split('_');
    if (key === 'lattice') return { b: 'lattice shape', c: 'gyration offset', x: 'lattice arrow, across', y: 'lattice arrow, up' }[idx];
    const nice = { cornerPair: 'mirror edge', conePair: 'folded edge', fold: 'fold', handle: 'handle', cap: 'crosscap', tube: 'cut (tube)', slice: 'cut (slice)', band: 'band' }[key] || key;
    return `${nice} ${idx} · ${s === 'l' ? 'length' : 'twist'}`;
  };
  el.innerHTML = `<table>${names.map(n => `<tr data-p="${n}"><td>${label(n)}</td><td class="v">${(+model.values[n]).toFixed(3)}</td></tr>`).join('')}</table>`;
}
$('#params').addEventListener('pointerover', e => {
  const tr = e.target.closest('tr[data-p]'); if (!tr) return;
  const n = tr.dataset.p, g = model.geo;
  highlight.set({
    source: 'params', tokens: [],
    faces: g.faces.map((f, i) => (f.params || []).includes(n) ? i : -1).filter(i => i >= 0),
    inner: (g.inner || []).map((f, i) => (f.params || []).includes(n) ? i : -1).filter(i => i >= 0), points: [],
  });
});
$('#params').addEventListener('pointerleave', () => highlight.clear());

// ── examples ────────────────────────────────────────────────────────────
function renderExamples() {
  const el = $('#examples');
  const groups = { plane: 'The plane: the 17 wallpaper groups', sphere: 'The sphere', hyperbolic: 'The hyperbolic plane' };
  const cur = model.getSignature();
  el.innerHTML = Object.entries(groups).map(([g, title]) => `<section><h3>${title}</h3>${PRESETS.map((p, i) => p.group !== g ? '' :
    `<button class="ex${p.signature === cur ? ' cur' : ''}" data-i="${i}"><code>${p.signature ? p.signature.replace(/\*/g, '∗') : '—'}</code><span>${p.caption}</span></button>`).join('')}</section>`).join('');
}
$('#examples').addEventListener('click', e => { const b = e.target.closest('.ex'); if (b) loadPreset(PRESETS[+b.dataset.i]); });

// ── tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tab;
  document.querySelectorAll('.tabs [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('[data-tab-only]').forEach(p => { p.hidden = p.dataset.tabOnly !== t; });
}));

// ── keyboard ────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
  if (mod && (e.key === 'y')) { e.preventDefault(); doRedo(); return; }
  const inEditor = document.activeElement?.closest?.('.cells');
  if (e.key === 'Escape' && tool.selected) { tool.select(false); return; }
  const typing = inEditor || e.target.closest?.('input');
  if (!typing && !mod && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'p') { setMode('pattern'); return; }
    if (key === 'a') { setMode(view.adjusting ? 'pattern' : 'adjust'); return; }
    const k = { m: 'move', b: 'brush', e: 'erase' }[key];
    if (k) { setTool(k); return; }
    if (e.key === '[') { setBrush(scene.settings.brush / 1.2); return; }
    if (e.key === ']') { setBrush(scene.settings.brush * 1.2); return; }
  }
  if (!inEditor && !mod && (e.key === '0' || (e.key === 'Home' && document.activeElement === $('#pattern')))) { view.resetView(); view.requestRender(); }
});
$('#home').onclick = () => { view.resetView(); view.requestRender(); };

// ── image panel ─────────────────────────────────────────────────────────
// two modes on the one canvas: the pattern, or adjusting the image (it is shown in place over the pattern)
function setMode(m) {
  const adj = m === 'adjust';
  document.querySelectorAll('#modes [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#tools').hidden = !adj;
  view.adjusting = adj;
  setTool(adj ? adjustTool : 'navigate');
}
function setTool(t) {
  if (t !== 'navigate' && !view.adjusting) { setMode('adjust'); if (t !== adjustTool) setTool(t); return; }
  if (t !== 'navigate') adjustTool = t;
  currentTool = t;
  document.querySelectorAll('#tools [data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  $('#pattern').style.cursor = t === 'move' ? 'move' : t === 'navigate' ? 'grab' : 'none';
  if (t !== 'brush' && t !== 'erase') view.cursor = null;
  tool._setHover?.(null);
  view.requestRender();
  renderHint();
  saveSoon();
}
$('#modes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
$('#tools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });

const S = scene.settings;
function bindSlider(id, key, fmt, after) {
  const el = $('#' + id), out = $('#' + id + '-v');
  el.value = S[key]; out.textContent = fmt(S[key]);
  el.addEventListener('input', () => { S[key] = +el.value; out.textContent = fmt(S[key]); after?.(); saveSoon(); });
}
function setBrush(px) { S.brush = Math.min(240, Math.max(4, px)); $('#brush').value = S.brush; $('#brush-v').textContent = Math.round(S.brush) + ' px'; }
bindSlider('feather', 'feather', v => v.toFixed(2), () => { if (scene.maskMode === 'domain') view.requestRender(); });
renderMaskState();
bindSlider('brush', 'brush', v => Math.round(v) + ' px');
bindSlider('strength', 'strength', v => Math.round(v * 100) + '%');
document.querySelectorAll('input[name=avg]').forEach(r => r.addEventListener('change', () => { scene.setAveraging(r.value); renderMaskState(); commit(); }));
$('#guides').addEventListener('change', e => { S.guides = e.target.checked; view.requestRender(); saveSoon(); });
$('#comma').addEventListener('change', e => { S.showComma = e.target.checked; view.requestRender(); saveSoon(); });
view.onViewChange(saveSoon);
$('#mask-reset').onclick = () => { scene.resetMask(); commit(); };
$('#fit').onclick = () => { scene.fit(); commit(); };
$('#flip').onclick = () => { scene.flip(); commit(); };

function renderMaskState() {
  const custom = scene.maskMode === 'custom';
  $('#mask-state').textContent =
    S.avg === 'first' ? 'No mask: each orbit takes the first copy that lands on the image.'
      : S.avg === 'height' ? (custom ? 'Your height map. It stays with the image when the symmetry changes.' : 'Flat: every copy stands level, so each orbit averages them all. Brush to raise parts (Erase lowers).')
        : (custom ? 'Your contravariant mask. It goes back to the domain when the signature changes.' : 'The fundamental domain, feathered. Brush to start shaping it.');
  $('#feather-row').hidden = S.avg !== 'mean';
}
function renderStats() {
  const e = scene.elements();
  $('#stats').textContent = scene.img ? `${scene.img.w}×${scene.img.h} image · ${e.list.length} copies of the domain touch it${e.truncated ? ' (capped — shrink the image for an exact result)' : ''}.` : '';
}
scene.on(kind => {
  if (kind === 'mask') renderMaskState();
  if (kind === 'place' || kind === 'image') { renderStats(); writeHash(); }
  view.requestRender();
});

// loading
let stream = null;
function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }
async function loadFile(file, asMask = false) {
  if (!file) return;
  if (file.type.startsWith('video/') && !asMask) {
    stopCamera();
    const v = document.createElement('video');
    v.src = URL.createObjectURL(file); v.loop = true; v.muted = true; v.playsInline = true;
    await v.play().catch(() => {});
    await new Promise(r => v.readyState >= 2 ? r() : v.addEventListener('loadeddata', r, { once: true }));
    scene.setImage(v, { video: true }); videoLoop();
    return;
  }
  try {
    const bmp = await createImageBitmap(file);
    if (asMask) { scene.maskFromImage(bmp); commit(); return; }
    stopCamera();
    scene.setImage(bmp);
    Saved.set('image', file);
    commit();
  } catch { $('#hint').textContent = 'That file could not be read as an image.'; }
}
$('#file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
$('#mask-file').addEventListener('change', e => { loadFile(e.target.files[0], true); e.target.value = ''; });
$('#camera').onclick = async () => {
  if (stream) { stopCamera(); scene.setImage(await duck()); scene.img.isDefault = true; Saved.del('image'); $('#camera').textContent = 'Camera'; return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; v.playsInline = true; await v.play();
    scene.setImage(v, { video: true }); videoLoop();
    $('#camera').textContent = 'Stop camera';
  } catch { $('#hint').textContent = 'No camera available (or permission was refused).'; }
};
let videoRunning = false;
function videoLoop() {
  if (videoRunning) return;
  videoRunning = true;
  const step = () => {
    if (!scene.img?.video) { videoRunning = false; return; }
    scene.bumpVideoFrame();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// drop and paste
let dragDepth = 0;
window.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; loadFile(e.dataTransfer.files[0]); });
window.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])][0]; if (f) loadFile(f); });

$('#save').onclick = () => {
  view.render();
  $('#pattern').toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = `orbipix-${(model.getSignature() || 'none').replace(/\*/g, 'S')}.png`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
};

// ── boot ────────────────────────────────────────────────────────────────
// ── boot: the user's last state if they have one (unless the URL names a different one), else
//    the URL's state, else DEFAULT_STATE ──
async function duck() {
  try { return await createImageBitmap(await (await fetch('images/duck.png')).blob()); } catch { return makeDefaultPicture(); }
}
const fromHash = readHash();
applySignature(fromHash && Sig.parse(fromHash.sig) ? fromHash.sig : DEFAULT_STATE.signature,
  { params: fromHash?.params || {}, motif: fromHash?.motif, resetView: true, history: false });
editor.set(model.getSignature());
(async () => {
  const saved = await Saved.get('state');
  const hashNow = location.hash.slice(1), hashSaved = saved?.url?.split('#')[1] || '';
  const useSaved = saved && saved.app === 'orbipix' && (!hashNow || decodeURIComponent(hashNow) === decodeURIComponent(hashSaved));
  let pic = null, isDefault = true;
  if (useSaved && saved.image && !saved.image.default && !saved.image.video) {
    const blob = await Saved.get('image');
    if (blob) { try { pic = await createImageBitmap(blob); isDefault = false; } catch {} }
  }
  if (!pic) pic = await duck();
  if (!scene.img || scene.img.isDefault) { scene.setImage(pic); scene.img.isDefault = isDefault; }
  if (useSaved) {
    await applyState(saved);
    const m = await Saved.get('mask');
    if (m && m.mode === 'custom') scene.restoreMask(m);
  } else if (fromHash && Sig.parse(fromHash.sig)) {
    if (fromHash.place) scene.setPlace({ ...fromHash.place, mode: model.geo.mode });
  } else await applyState(DEFAULT_STATE);
  renderMaskState();
  renderStats();
  undo.length = 0; redo.length = 0;
  booted = true;
  commit();
})();
updateUndoButtons();
view.requestRender();

window.addEventListener('hashchange', () => {
  const h = readHash();
  if (h && (h.sig !== model.getSignature() || JSON.stringify(h.params) !== JSON.stringify(model.params.snapshot()))) {
    applySignature(h.sig, { params: h.params, motif: h.motif, resetView: true });
    editor.set(model.getSignature());
  }
});

// console access for checks
// ── sharing a state with a Claude Code session: Opt-Cmd-C (Ctrl-Alt-C elsewhere) copies a
//    short text to paste into the chat; orbipix.applyState(obj) puts it back. A brushed mask
//    goes along as a small grayscale PNG (maskPng, ≤ 256 px, 8-bit); the image itself does not.
const SHARE_MASK = 256;
function maskPng() {
  if (scene.maskMode !== 'custom' || !scene.gpu?.w) return null;
  const { w, h } = scene.gpu, data = scene.gpu.read();
  const k = Math.min(1, SHARE_MASK / Math.max(w, h)), W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'), im = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {           // box filter down
    const x0 = Math.floor(x * w / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / W));
    const y0 = Math.floor(y * h / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / H));
    let sum = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += data[yy * w + xx];
    const v = Math.round(Math.min(1, Math.max(0, sum / ((x1 - x0) * (y1 - y0)))) * 255);
    im.data.set([v, v, v, 255], 4 * (y * W + x));
  }
  ctx.putImageData(im, 0, 0);
  return c.toDataURL('image/png');
}
function collectState() {
  const v = view.view;
  return {
    app: 'orbipix', saved: new Date().toISOString(), url: location.href,
    signature: model.getSignature(), params: model.bad ? {} : model.params.snapshot(), motif: model.motif || null,
    geometry: model.geo?.mode, place: scene.place, settings: { ...scene.settings },
    mode: view.adjusting ? 'adjust' : 'pattern', tool: currentTool,
    view: { mode: v.mode, V: v.V, R: v.R, zoom: v.zoom, off: v.off },
    image: scene.img ? { w: scene.img.w, h: scene.img.h, video: !!scene.img.video, default: scene.img.isDefault || false } : null,
    mask: scene.maskMode, copies: scene.elements().list.length,
    canvas: { w: view.cssW, h: view.cssH }, ua: navigator.userAgent,
    maskPng: maskPng(),
  };
}
async function copyState() {
  const st = collectState();
  const text = `Orbipix state (${st.saved}):\n${JSON.stringify(st)}`;
  try { await navigator.clipboard.writeText(text); $('#hint').textContent = 'State copied — paste it into the Claude session.'; }
  catch { prompt('Copy this state:', text); }
}
async function applyState(st) {
  applySignature(st.signature, { params: st.params, motif: st.motif, history: false });
  editor.set(model.getSignature());
  if (st.place) scene.setPlace({ ...st.place, mode: model.geo.mode });
  Object.assign(scene.settings, st.settings || {});
  if (st.settings?.avg) scene.maskKind = Scene.kindOf(st.settings.avg);
  syncSettingsUI();
  if (st.view && st.view.mode === model.geo.mode) Object.assign(view.view, st.view);
  setMode(st.mode === 'adjust' ? 'adjust' : 'pattern');
  if (st.mode === 'adjust' && st.tool) setTool(st.tool);
  if (st.maskPng) {
    const img = new Image(); img.src = st.maskPng;
    await img.decode().catch(() => {});
    if (img.naturalWidth) scene.maskFromImage(img);
  } else if (st.mask === 'domain') scene.resetMask();
  commit();
  view.requestRender();
}
function syncSettingsUI() {
  for (const [id, key, fmt] of [['feather', 'feather', v => v.toFixed(2)], ['brush', 'brush', v => Math.round(v) + ' px'], ['strength', 'strength', v => Math.round(v * 100) + '%']]) {
    $('#' + id).value = S[key]; $('#' + id + '-v').textContent = fmt(S[key]);
  }
  document.querySelectorAll('input[name=avg]').forEach(r => { r.checked = r.value === S.avg; });
  renderMaskState();
  $('#guides').checked = S.guides; $('#comma').checked = S.showComma;
}
document.addEventListener('keydown', e => {
  if (e.code === 'KeyC' && e.altKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); copyState(); }
});

window.orbipix = { model, view, scene, highlight, editor, tool, presets: PRESETS, setTool, setMode, collectState, applyState };
window.model = model;
