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
  computed analytically, so it follows the domain live during reshaping. The shader computes it
  only for elements flagged `near` (tiles near F). `custom` is a Float32 weight per mask pixel
  (≤ 1024 px on the long side), baked from the domain mask on the first brush stroke.
  Other mask options: **Uniform** (every orbit point equal) and **Load mask** (grayscale image).
- **Contravariant brush** (patent, "Masks"; claim 12). At a brushed pixel the weight goes from
  old to new, and every other pixel of its orbit is scaled by (1 − new)/(1 − old). Implemented as
  a *gather*: each pixel near any copy of the brush is visited once, pulls back to its orbit point
  inside the brush and takes that point's factor. This leaves no holes at any copy scale; the
  first version used scatter-to-nearest-pixel and left speckle. Brushing works on either view, on
  the image under the pointer.
- **Video / camera** input re-uploads each frame (claims 13 and 14). **⤓** saves the pattern view
  as a PNG.
- **Views**: Source (the image where it lies, dimmed by weight, with the tiles on top) and Pattern,
  side by side or one at a time. They share one view state. Two WebGL contexts each upload the image,
  mask and element textures.

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
- Brush speed: a dab costs about 30 ms on hyperbolic groups (125 tiles). Strokes space dabs at a
  quarter of the brush size.
- The element cap (768) truncates very large images or placements near the hyperbolic rim. The
  stats line says so when it happens.
- Not checked on touch devices. No gallery icon yet; `project.json` has `"live": false`.
