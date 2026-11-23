// textures.js — the motif printed on every tile: a comma, a shape with no
// symmetry at all, so each tile shows whether it is a turned copy (teal) or a
// mirror image (sand). Drawn once into a canvas; the shader tints it.
// Red channel: comma body; green channel: its outline.

export function makeCommaCanvas(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, size, size);
  const s = size / 100;
  const path = new Path2D();
  // head: a fat disc; tail: a curling taper to the lower left
  path.moveTo(62 * s, 30 * s);
  path.bezierCurveTo(80 * s, 34 * s, 84 * s, 56 * s, 70 * s, 66 * s);
  path.bezierCurveTo(62 * s, 74 * s, 52 * s, 80 * s, 40 * s, 86 * s);
  path.bezierCurveTo(30 * s, 90 * s, 20 * s, 90 * s, 14 * s, 86 * s);
  path.bezierCurveTo(28 * s, 84 * s, 40 * s, 76 * s, 46 * s, 66 * s);
  path.bezierCurveTo(34 * s, 62 * s, 32 * s, 44 * s, 42 * s, 36 * s);
  path.bezierCurveTo(47 * s, 31 * s, 55 * s, 29 * s, 62 * s, 30 * s);
  path.closePath();
  // outline in green
  g.lineJoin = 'round';
  g.strokeStyle = 'rgb(0,255,0)';
  g.lineWidth = 7 * s;
  g.stroke(path);
  // body in red (drawn over, with additive-ish composition so both channels survive)
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgb(255,0,0)';
  g.fill(path);
  // a small eye so the comma's two faces differ even in silhouette
  g.globalCompositeOperation = 'destination-out';
  g.beginPath(); g.arc(59 * s, 44 * s, 5 * s, 0, 2 * Math.PI); g.fill();
  return cv;
}

// small preview for the side panel / legend (CSS-coloured)
export function commaSVG(fill, stroke, size = 22) {
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><path d="M62 30C80 34 84 56 70 66C62 74 52 80 40 86C30 90 20 90 14 86C28 84 40 76 46 66C34 62 32 44 42 36C47 31 55 29 62 30Z" fill="${fill}" stroke="${stroke}" stroke-width="5" stroke-linejoin="round"/><circle cx="59" cy="44" r="5" fill="#fbfaf6"/></svg>`;
}

// The starting picture: a little landscape with nothing symmetric in it, so
// every turn and flip of the pattern shows. Load any image to replace it.
export function makeDefaultPicture(w = 1200, h = 900) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // sky
  const sky = g.createLinearGradient(0, 0, w * 0.3, h * 0.7);
  sky.addColorStop(0, '#243b7a'); sky.addColorStop(0.55, '#e0785a'); sky.addColorStop(1, '#f6c76b');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  // sun with rays
  const sx = w * 0.72, sy = h * 0.3;
  g.save(); g.translate(sx, sy);
  for (let i = 0; i < 14; i++) {
    g.rotate(Math.PI * 2 / 14 + 0.04 * i);
    g.fillStyle = i % 2 ? 'rgba(255,230,150,.35)' : 'rgba(255,200,110,.25)';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(w * 0.5, -18 - 4 * i); g.lineTo(w * 0.5, 18 + 2 * i); g.fill();
  }
  g.restore();
  const sun = g.createRadialGradient(sx - 20, sy - 20, 10, sx, sy, 110);
  sun.addColorStop(0, '#fff7d1'); sun.addColorStop(0.6, '#ffd257'); sun.addColorStop(1, '#f08a2c');
  g.fillStyle = sun; g.beginPath(); g.arc(sx, sy, 105, 0, Math.PI * 2); g.fill();
  // hills
  const hill = (y0, amp, col, k) => {
    g.fillStyle = col; g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 10) g.lineTo(x, y0 - amp * Math.sin(x * k + y0) - amp * 0.4 * Math.sin(x * k * 2.7 + 1));
    g.lineTo(w, h); g.fill();
  };
  hill(h * 0.62, 50, '#5b6b9a', 0.006);
  hill(h * 0.72, 40, '#3f7d5c', 0.009);
  hill(h * 0.84, 30, '#2c5a3c', 0.013);
  // a tree, leaning
  g.save(); g.translate(w * 0.2, h * 0.86); g.rotate(-0.12);
  g.fillStyle = '#4a2f1e'; g.fillRect(-12, -210, 24, 220);
  for (let i = 0; i < 9; i++) {
    g.fillStyle = ['#2f8f4e', '#3fa65a', '#6cc070', '#257a42'][i % 4];
    g.beginPath(); g.arc(-70 + 140 * rnd(), -230 - 110 * rnd(), 45 + 30 * rnd(), 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#d93b3b';
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(-60 + 120 * rnd(), -210 - 110 * rnd(), 9, 0, Math.PI * 2); g.fill(); }
  g.restore();
  // a red house
  g.save(); g.translate(w * 0.55, h * 0.8);
  g.fillStyle = '#c23b2e'; g.fillRect(0, -110, 160, 110);
  g.fillStyle = '#5a2a20'; g.beginPath(); g.moveTo(-15, -110); g.lineTo(60, -175); g.lineTo(175, -110); g.fill();
  g.fillStyle = '#ffe08a'; g.fillRect(20, -80, 34, 34); g.fillStyle = '#3b2a1e'; g.fillRect(100, -70, 34, 70);
  g.restore();
  // birds
  g.strokeStyle = '#1a1a1f'; g.lineWidth = 4; g.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const bx = w * (0.25 + 0.08 * i + 0.03 * rnd()), by = h * (0.18 + 0.06 * rnd()), s = 14 + 6 * rnd();
    g.beginPath(); g.moveTo(bx - s, by - s * 0.4); g.quadraticCurveTo(bx - s * 0.4, by - s * 0.6, bx, by); g.quadraticCurveTo(bx + s * 0.3, by - s * 0.9, bx + s * 1.1, by - s * 0.6); g.stroke();
  }
  // a word, which reads wrong in every mirror image
  g.font = 'bold 120px Georgia, serif'; g.fillStyle = '#fbfaf6'; g.strokeStyle = '#1a1a1f'; g.lineWidth = 6;
  g.strokeText('Orbipix', w * 0.06, h * 0.2); g.fillText('Orbipix', w * 0.06, h * 0.2);
  return cv;
}
