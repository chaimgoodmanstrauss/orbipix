# Orbipix — working notes

Bitmap patterns by **contravariant distributions** (C. Goodman-Strauss, patent draft "Method for
producing symmetric patterns with contravariant distributions"), built on a copy of Orbiscope
(`../orbiscope`, commit 592941e) for the orbifold engine, signature editor and feature dragging.

Run: from `orbipix/`, `python3 -m http.server <port>` and open `http://localhost:<port>/`.
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
  1 − Π(1 − b_i)), at most 48 dabs per pass. Brushing works on either view.
  History: CPU scatter (speckled) → CPU gather (~50 ms/dab on `*2223`) → CPU gather without the
  per-pixel fold (~10 ms) → GPU (~3.4 ms per pass, however many dabs; see Benchmarks).
- **One WebGL context** for both views: it draws into a hidden canvas that is copied into each
  view's 2D canvas, so both views and the mask passes share textures. Undo reads the mask back
  (~19 ms) once per committed change.
- **Video / camera** input re-uploads each frame (claims 13 and 14). **⤓** saves the pattern view
  as a PNG.
- **Views**: Source (the image where it lies, dimmed by weight, with the tiles on top) and Pattern,
  side by side or one at a time. They share one view state and one WebGL context.

## Decisions

- Undo covers the signature, parameters, comma, image placement and mask (each history entry keeps a
  mask copy only when the mask changed). Capped at 60 entries.
- The URL keeps the signature, parameters and placement (`p=`). The image and mask are not saved.
- Orbiscope's Surface tab and the comma (now off by default; it can be turned back on) are dropped.
  Orbiscope's feature hovering and dragging are kept under the Navigate tool.
- Default image: a procedural landscape with nothing symmetric in it (`textures.makeDefaultPicture`).

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
