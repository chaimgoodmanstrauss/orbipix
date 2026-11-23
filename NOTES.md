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
placement, settings, mode and tool, view (V, R, zoom), image size, mask mode and canvas size. A
brushed or loaded mask goes along as `maskPng`, a grayscale PNG data URL, box-filtered down to at
most 256 px on the long side. With a brushed mask the paste is about 14 KB; restored, the mean error
is 0.0003 and the maximum 0.056 at brush edges. Paste it into the chat. To reproduce it, Claude runs
`await orbipix.applyState(<that JSON>)`, for example in `tools/browser-check.mjs`. The image itself
is left out; describe it, or drop the file into the project folder.

## Two kinds of mask (2026-11-23)

Only one is in use at a time; the Mask radio chooses it (`settings.avg`):
- **Height map** (`'height'`, the default). A height over the image, not contravariant. Each orbit
  shows its highest copies, with heights within 0.004 averaged (patent claim 3, "the average of the
  colour values with the greatest weights"). It starts flat (`maskMode 'domain'` = level 0.5, no
  texture needed), so every copy is averaged; this replaces the old "No mask: average all".
  Brushing raises or lowers it, with no counterbalancing (`MaskGPU` brush with `uContra = 0`).
  **It stays attached to the image**: it survives signature changes and moves with the image. A new
  picture starts flat.
- **Contravariant** (`'mean'`). Weighted average; starts as the feathered domain; contravariant
  brushing. **It resets to the domain when the signature changes** (`Scene.symmetryChanged`), but not
  on shape drags. Feather is shown only for this kind.
- **No mask: first hit** (`'first'`) is kept as a third choice. Brushing does nothing in that mode.
- Switching between height and contravariant starts the new kind afresh. Undo restores the mask and
  the kind (the history entries carry `avg`). The kind travels in shared states too.
- Cost: a flat or brushed height map visits every copy (no culling by weight), so domain-texture
  recomputes run at "average all" cost: 27 ms on `*2223` and up to 137 ms on `456` with the image
  over the disk. Redraws are unaffected.

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
