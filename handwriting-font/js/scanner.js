/*
 * Turns a photo of the filled-in template into transparent letter images:
 *   1. find the four black corner markers (and which side is up),
 *   2. straighten the grid with a perspective transform,
 *   3. even out lighting, cut every cell and keep only the ink.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  const L = HW.LAYOUT;
  const IP = HW.imageproc;
  const CELL_PX = 150; // width of one straightened cell in pixels

  function loadImage(file, maxSide) {
    maxSide = maxSide || 2400;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('לא ניתן לקרוא את התמונה'));
      };
      img.src = url;
    });
  }

  /** Returns a copy of the canvas rotated 90° clockwise. */
  function rotate(src) {
    const canvas = document.createElement('canvas');
    canvas.width = src.height;
    canvas.height = src.width;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, 0, 0);
    return canvas;
  }

  function defaultCorners(photo) {
    const w = photo.width, h = photo.height, mx = w * 0.12, my = h * 0.12;
    return [[mx, my], [w - mx, my], [w - mx, h - my], [mx, h - my]];
  }

  function argBest(list, score) {
    let best = null, bestScore = -Infinity;
    for (const item of list) {
      const s = score(item);
      if (s > bestScore) { bestScore = s; best = item; }
    }
    return best;
  }

  /** Finds the four solid square markers. Returns centres TL,TR,BR,BL (image orientation) or null. */
  function findMarkerQuad(gray, threshold) {
    const { data, w, h } = gray;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i] < threshold ? 1 : 0;
    const { comps } = IP.labelComponents(mask, w, h);

    const minArea = Math.max(20, w * h * 0.00003);
    const maxArea = w * h * 0.02;
    const cands = comps.filter((c) => {
      if (c.area < minArea || c.area > maxArea) return false;
      if (c.minX === 0 || c.minY === 0 || c.maxX === w - 1 || c.maxY === h - 1) return false;
      const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
      const aspect = bw / bh;
      return aspect > 0.5 && aspect < 2 && c.area / (bw * bh) > 0.65;
    }).map((c) => ({ area: c.area, x: c.sx / c.area, y: c.sy / c.area }))
      .sort((a, b) => b.area - a.area)
      .slice(0, 40);

    let best = null;
    for (const ref of cands) {
      const group = cands.filter((c) => c.area >= ref.area * 0.5 && c.area <= ref.area * 2);
      if (group.length < 4) continue;
      const quad = [
        argBest(group, (c) => -(c.x + c.y)),
        argBest(group, (c) => c.x - c.y),
        argBest(group, (c) => c.x + c.y),
        argBest(group, (c) => c.y - c.x)
      ];
      if (new Set(quad).size < 4) continue;
      const pts = quad.map((c) => [c.x, c.y]);
      const area = Math.abs(IP.polygonArea(pts));
      if (area < w * h * 0.05 || !IP.isConvex(pts)) continue;
      if (!best || area > best.area) best = { pts, area };
    }
    return best ? best.pts : null;
  }

  /**
   * The quad's order follows the image, but the page may be rotated.
   * Only the title band above the grid holds printed text, so try all four
   * rotations and keep the one whose band has the most light/dark edges
   * (plain dark background outside the page has very few).
   */
  function orientQuad(quad, gray, threshold) {
    const mmPts = L.markerCenters();
    const { data, w, h } = gray;
    let best = quad, bestScore = -1;
    for (let shift = 0; shift < 4; shift++) {
      const pts = [0, 1, 2, 3].map((i) => quad[(i + shift) % 4]);
      const H = IP.solveHomography(mmPts, pts);
      if (!H) continue;
      let edges = 0;
      for (let y = L.header.y0; y <= L.header.y1; y += 0.5) {
        let prev = null;
        for (let x = L.header.x0; x <= L.header.x1; x += 0.25) {
          const [px, py] = IP.applyHomography(H, x, y);
          const ix = Math.round(px), iy = Math.round(py);
          const dark = ix >= 0 && iy >= 0 && ix < w && iy < h && data[iy * w + ix] < threshold;
          if (prev !== null && dark !== prev) edges++;
          prev = dark;
        }
      }
      if (edges > bestScore) { bestScore = edges; best = pts; }
    }
    return best;
  }

  /** Grid corners (TL,TR,BR,BL in photo pixels) derived from the markers, or null. */
  function detect(photo) {
    const scale = Math.min(1, 1000 / Math.max(photo.width, photo.height));
    const small = document.createElement('canvas');
    small.width = Math.round(photo.width * scale);
    small.height = Math.round(photo.height * scale);
    small.getContext('2d').drawImage(photo, 0, 0, small.width, small.height);
    const gray = IP.grayFromCanvas(small);
    const threshold = IP.otsu(gray.data);

    const quad = findMarkerQuad(gray, threshold);
    if (!quad) return null;
    const markers = orientQuad(quad, gray, threshold).map(([x, y]) => [x / scale, y / scale]);

    const H = IP.solveHomography(L.markerCenters(), markers);
    if (!H) return null;
    return L.gridCorners().map(([x, y]) => IP.applyHomography(H, x, y));
  }

  /** Straightens the grid area and evens out lighting. */
  function rectify(photo, corners) {
    const outW = L.cols * CELL_PX;
    const outH = Math.round(outW * L.gridH / L.gridW);
    const H = IP.solveHomography([[0, 0], [outW, 0], [outW, outH], [0, outH]], corners);
    if (!H) throw new Error('הפינות שסומנו לא תקינות');
    const warped = IP.warpGray(IP.grayFromCanvas(photo), H, outW, outH);
    return {
      norm: IP.normalizeIllumination(warped, 8),
      w: outW,
      h: outH,
      cellW: outW / L.cols,
      cellH: outH / L.rows
    };
  }

  /**
   * Cuts every cell into a transparent glyph.
   * sensitivity: 0..100, higher keeps fainter strokes.
   * Returns { glyphs: { char: { canvas, top, w, h } }, count }.
   * Glyph metrics are fractions of the cell height ("em").
   */
  function extractGlyphs(grid, sensitivity) {
    const { norm, w: W, cellW, cellH } = grid;
    const threshold = 0.42 - (sensitivity / 100) * 0.34;
    const soft = 0.07;
    const C = L.crop;
    const glyphs = {};
    let count = 0;

    HW.CHARS.forEach((char, i) => {
      const col = i % L.cols, row = Math.floor(i / L.cols);
      const cellX = col * cellW, cellY = row * cellH;
      const x0 = Math.round(cellX + C.x0 * cellW), x1 = Math.round(cellX + C.x1 * cellW);
      const y0 = Math.round(cellY + C.y0 * cellH), y1 = Math.round(cellY + C.y1 * cellH);
      const cw = x1 - x0, chh = y1 - y0;

      const ink = new Float32Array(cw * chh);
      const mask = new Uint8Array(cw * chh);
      for (let y = 0; y < chh; y++) {
        const relY = (y0 + y - cellY) / cellH;
        for (let x = 0; x < cw; x++) {
          const relX = (x0 + x - cellX) / cellW;
          if (relX < L.labelBox.w && relY < L.labelBox.h) continue; // printed label
          const v = 1 - norm[(y0 + y) * W + x0 + x];
          ink[y * cw + x] = v;
          mask[y * cw + x] = v > threshold ? 1 : 0;
        }
      }

      const { labels, comps } = IP.labelComponents(mask, cw, chh);
      const minArea = Math.max(6, cw * chh * 0.0004);
      const keep = new Uint8Array(comps.length + 1);
      let kept = 0, bx0 = cw, by0 = chh, bx1 = -1, by1 = -1;
      for (const c of comps) {
        if (c.area < minArea) continue;
        const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
        const touchesEdge = c.minX === 0 || c.minY === 0 || c.maxX === cw - 1 || c.maxY === chh - 1;
        if (touchesEdge) {
          const thin = Math.min(bw, bh) <= Math.max(3, cw * 0.05);
          const long = Math.max(bw, bh) >= 4 * Math.min(bw, bh);
          if ((thin && long) || c.area < minArea * 4) continue; // leftovers of grid lines
        }
        keep[c.id] = 1;
        kept += c.area;
        bx0 = Math.min(bx0, c.minX); by0 = Math.min(by0, c.minY);
        bx1 = Math.max(bx1, c.maxX); by1 = Math.max(by1, c.maxY);
      }
      if (kept < 12) return; // empty cell

      const pad = 2;
      bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad);
      bx1 = Math.min(cw - 1, bx1 + pad); by1 = Math.min(chh - 1, by1 + pad);
      const gw = bx1 - bx0 + 1, gh = by1 - by0 + 1;

      const canvas = document.createElement('canvas');
      canvas.width = gw;
      canvas.height = gh;
      const ctx = canvas.getContext('2d');
      const out = ctx.createImageData(gw, gh);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const sx = bx0 + x, sy = by0 + y;
          // keep anti-aliased edges only next to a kept stroke
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = sx + dx, ny = sy + dy;
              if (nx >= 0 && ny >= 0 && nx < cw && ny < chh && keep[labels[ny * cw + nx]] && labels[ny * cw + nx]) {
                near = true;
                break;
              }
            }
          }
          if (!near) continue;
          const a = Math.min(1, Math.max(0, (ink[sy * cw + sx] - (threshold - soft)) / (2 * soft)));
          out.data[(y * gw + x) * 4 + 3] = Math.round(a * 255);
        }
      }
      ctx.putImageData(out, 0, 0);

      glyphs[char] = {
        canvas,
        top: (y0 - cellY + by0) / cellH,
        w: gw / cellH,
        h: gh / cellH
      };
      count++;
    });

    return { glyphs, count };
  }

  HW.scanner = { loadImage, rotate, defaultCorners, detect, rectify, extractGlyphs };
})(window.HW);
