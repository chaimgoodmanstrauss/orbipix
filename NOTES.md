# Orbipix — working notes

Bitmap patterns by **contravariant distributions** (C. Goodman-Strauss, patent draft "Method for
producing symmetric patterns with contravariant distributions"), built on a copy of Orbiscope
(`../orbiscope`, commit 592941e) for the orbifold engine, signature editor and feature dragging.

Run: from `orbipix/`, `python3 tools/serve.py <port>` and open `http://localhost:<port>/` (use this,
not a plain `http.server`, for the "browser" trigger: it also receives shared states).
Console: `window.orbipix` (`model`, `view`, `sview`, `scene`, `setTool`, `setView`, …).
Checks: `node tools/browser-check.mjs <url> [steps.json]`; `node --import ./tools/register.mjs tools/test-model.mjs`.
Deploy (not yet done): `./deploy.sh` → https://chaimgoodmanstrauss.com/orbipix/.

## The method, as implemented

- **Orbits.** Each output pixel is folded into the fundamental domain F (the Orbiscope shader's
  rule), giving f. Its orbit on the image is { g(f) : g ∈ list }, where the list
  (`Orbits.enumerate`) is every group element whose tile g(F) meets the image. The list is found
  by a breadth-first walk over tiles from the tile under the image centre, keeping tiles whose
  bounding box meets the image. It is capped at 768 elements, and hyperbolic tiles smaller than
  about one image pixel are dropped.
- **Colour = weighted average over the orbit** (patent claim 1), with weights from the mask.
  "Highest weight wins" is claim 3, the mask read as a height.
- **Image placement**: the image sits in the image plane (the world in 2D; the stereographic plane
  on the sphere, projected from the pole opposite the comma) by z = c + a·(flip ? s̄ : s). You can
  move, turn, scale and flip it (objects a and e). The default placement puts the domain mid-image,
  as in the patent's preferred embodiment.
- **Masks.** `domain` (default) is F feathered by a signed distance (claims 10 and 11),
  computed analytically in the shader, so it follows the domain live during reshaping. The pattern
  shader computes it only for elements flagged `near` (tiles near F). `custom` is an R32F texture
  on the GPU (`js/MaskGPU.js`, ≤ 1024 px on the long side), baked from the domain mask by a GPU pass
  on the first brush stroke. Other mask options: **Uniform** (every orbit point equal) and
  **Load mask** (a grayscale image, uploaded).
- **Contravariant brush** (patent, "Masks"; claim 12), as a GPU pass. Two mask textures take
  turns as source and target. In one pass, each mask pixel y under the brush becomes old ± B(y);
  any other pixel folds, tries each listed copy of its orbit, and at the first one under the brush,
  x, is scaled by (1 − new_x)/(1 − old_x). Each pointer move's dabs go in one pass (B = soft union
  1 − Π(1 − b_i)), at most 48 dabs per pass. 
  History: CPU scatter (speckled) → CPU gather (~50 ms/dab on `*2223`) → CPU gather without the
  per-pixel fold (~10 ms) → GPU (~3.4 ms per pass, however many dabs; see Benchmarks).
- **One WebGL context**, drawing into a hidden canvas that is copied into the view's 2D canvas, and
  shared with the mask passes. It is kept from the two-view version: it would also allow a second view
  again. Undo reads the mask back
  (~19 ms) once per committed change.
- **Video / camera** input re-uploads each frame (claims 13 and 14). **⤓** saves the pattern view
  as a PNG.
- **One canvas, two modes** (2026-11-23). *Pattern*: the pattern, with Orbiscope's feature hovering
  and dragging. *Adjust image* (A; P goes back): the same canvas shows the pattern at 65% saturation,
  with the image laid over it where it lies. The image is fully opaque where its weight is high and at
  30% opacity where the mask is dark, with a thin gray line round its edge. The Move / Brush / Erase tools appear only
  in this mode. The canvas is a square up to the viewport height minus 150 px.

## Sharing a state with a Claude session

**Opt-Cmd-C** (Ctrl-Alt-C off the Mac) copies one line of JSON: URL, signature, parameters,
placement, settings, mode and tool, view (V, R, zoom), image size, mask mode and canvas size.
Paste it into the chat. To reproduce it, Claude runs `orbipix.applyState(<that JSON>)`, for example
in `tools/browser-check.mjs`. The image and a brushed mask are left out because they are too big to
paste; describe them, or drop the image file into the project folder.

## Speed (2026-11-23, after "very laggy")

The case was `456`, with the image covering the whole disk (621–768 copies) on a 950 px canvas at
DPR 2 (1900² pixels). A frame took **265 ms**. Fixes:
- **Draw straight to the canvas.** No hidden-canvas copy now that there is one view.
- **Half resolution while interacting** (`PatternView.interacting()`, called on drag, wheel and
  pinch), then sharp 180 ms after the last move. The overlay stays at full resolution.
- **Domain mask: loop only over `near` copies.** Near now depends on the feather: tiles whose
  boundary samples come within the feather radius of F, about 13 instead of 56.
- **Brushed mask: skip copies with no weight.** After each mask change, a max-pyramid of the mask
  plus an "active" pass flag each copy, and each block of 16, whose tile box (element texel 2,
  uv) holds any weight. The shader skips inactive blocks and copies. Copies with zero weight at the
  pixel skip the image sample. Checked: pixel-identical to the unculled render (3.6M px, max diff 0).
- Hyperbolic tiles smaller than 4 image pixels were dropped for speed; now one pixel (see the crown section below).

| `456` state, 1900² px | before | after |
|---|---|---|
| Frame, domain mask | 261 ms | 12 ms (3.5 interactive) |
| Frame, brushed mask | 228 ms | 25 ms (6 interactive) |
| Brush pass (8 dabs) + frame, interactive | — | 26 ms |

## Averaging options and the crown (2026-11-23)

- Four ways to colour an orbit: **Weighted average** (claim 1), **Highest weight wins** (claim 3),
  **No mask: average all** (every copy that lands on the image counts equally), and **No mask: first
  hit** (the first copy in list order that lands on the image; the list has the copies near F first,
  then the rest outward from the image centre). With the two no-mask options the mask is ignored,
  and Adjust mode shows the image fully opaque.
- **The crown** (Kaleidesign's `crowntransformregistry`: every transform taking a point of F into the
  image) is `Orbits.enumerate`. Completeness test: take 20,000 random image points, fold each, and
  check that its copy is in the list. Hyperbolic tiles under 4 image pixels were cut, missing 0.4%
  (`*2223`) to 1.9% (`456`, image covering the disk) of the image. Now only tiles under one image
  pixel are cut, with a cap of 4096 copies: misses are 0.08% / 0.39%, and **every** missed tile is
  smaller than one image pixel (largest 0.99). `632` and `*532` miss nothing.
- Cost: "average all" has to visit every copy, so it is slow when the image reaches the rim:
  278 ms (`*2223`, 979 copies) and 380 ms (`456`, 1209 copies) per frame at 1900² px, about 80–90 ms
  while interacting. The other three modes took 4.5–12 ms. Fixed by the domain texture (below).

## Domain texture (always on, 2026-11-23)

An orbit's colour depends only on its point in F, so it is computed once per point of F into a texture
(`CACHE_FS`, which is `orbitColor()` over a chart of F). Drawing then folds each pixel and samples
that texture, with mipmaps and an explicit LOD. The texture is premultiplied: alpha 0 where no copy
lands on the image.
- **Chart:** in 2D, a box round F's edges in world coordinates; on the sphere, a box round F in the
  stereographic chart about the comma (capped at ±4; the empty signature uses all of it). Texels
  just outside F are folded first, so bilinear sampling across F's edges is seamless.
- **Resolution:** as many texels as the screen shows of the most magnified copy of F, measured at
  full resolution, in √2 buckets, capped at 2048.
- **Recomputed only when its inputs change:** geometry, image (every video frame), mask, list of
  copies, averaging option, feather, placement or resolution bucket. Panning and zooming within a
  bucket only redraw.
- Timings (1900² px): redraw 3–6 ms in every option. A recompute costs 5–10 ms (weighted, height,
  first hit), 27 ms for "average all" on `*2223`, and 137 ms for "average all" on `456` (image over
  the disk, 1209 copies). A brush stroke plus redraw takes about 20 ms.
- Bug fixed on the way: when the texture was reallocated it got bound to the active unit (5, the
  pass's own `uActive`). That made a feedback loop, GL refused the draw and the cache came out empty
  after every signature change. The texture now lives on unit 6 only. Also, the empty signature's
  one copy is now marked near (it drew nothing before).

## Decisions

- Undo covers the signature, parameters, comma, image placement and mask (each history entry keeps a
  mask copy only when the mask changed). Capped at 60 entries.
- The URL keeps the signature, parameters and placement (`p=`). The image and mask are not saved.
- Orbiscope's Surface tab and the comma (now off by default; it can be turned back on) are dropped.
  Orbiscope's feature hovering and dragging are kept under the Navigate tool.
- Default image: `images/duck.png`, the rubber duck from Kaleidesign (`orbifold webgl/Kaleidesign Nov 10 2019 stable/library/images/duck.png`). If it fails to load, the procedural landscape (`textures.makeDefaultPicture`) is used instead.
- **Transparency and white backgrounds** (`Scene.clearWhiteBackground`). Transparent pixels keep
  their alpha, and their colour becomes white. If at least 60% of the image's edge is near-white
  (all channels ≥ 232, or transparent), the near-white region connected to the edge is made
  transparent, with a half-alpha rim one pixel wide. White inside the picture (eyes, highlights, a
  hole) stays opaque. Alpha multiplies the weight in every option. "Average all" and the no-weight
  fallback average only opaque parts (all transparent gives white), and "first hit" skips transparent
  hits. Still images go to the GPU as raw bytes, because a canvas would lose the colour of transparent
  pixels.

## Open

- Patent (g): blending several images in one pattern.
- Claims 6–9: distorting maps, and non-periodic (substitution / random) tilings as orbit sources.
  The orbifold engine gives only group symmetries.
- The element cap (768) truncates very large images or placements near the hyperbolic rim. The
  stats line says so when it happens.
- Not checked on touch devices. No gallery icon yet; `project.json` has `"live": false`.

## Benchmarks (2026-11-23, headless Chrome on this Mac, ANGLE/Metal; mask 1024×768, radius 25 mask px)

| | `*2223` (125 copies) | `632` (73) | `*532` (120) |
|---|---|---|---|
| CPU gather, first version (ms/dab) | 50.6 | 102.8 | 29.9 |
| CPU gather, no per-pixel fold (ms/dab) | 9.8 | 13.1 | 10.0 |
| GPU, one pass per dab (ms, warm) | 3.4 | 2.7 | 4.5 |
| GPU, 8 dabs in one pass (ms) | 3.3 | 3.1 | 8.0 |
| Pattern frame (ms) | 2.2 | 2.3 | 2.7 |

GPU rows: `*2223` measured after a warm-up run (cold: 5.1 / 10.3); `632` and `*532` measured once. GPU vs CPU (same single dabs): mean
difference ≤ 7e-6, a few edge pixels up to 0.06 (where the brush's edge or the self-test falls between pixels).
