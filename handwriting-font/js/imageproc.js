/*
 * Low-level image processing helpers. Everything works on plain typed arrays
 * so it runs fast in any browser without libraries.
 *
 * A "gray image" is { data: Uint8ClampedArray, w, h } with one byte per pixel.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  function grayFromCanvas(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
    return { data, w, h };
  }

  /** Otsu's method: the threshold that best separates dark from light pixels. */
  function otsu(data) {
    const hist = new Float64Array(256);
    for (let i = 0; i < data.length; i++) hist[data[i]]++;
    const total = data.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = t; }
    }
    return threshold;
  }

  /**
   * 4-connected component labelling of a binary mask.
   * Returns per-pixel labels (0 = background) and component statistics.
   */
  function labelComponents(mask, w, h) {
    const n = w * h;
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);
    const comps = [];
    let next = 1;
    for (let start = 0; start < n; start++) {
      if (!mask[start] || labels[start]) continue;
      const c = { id: next, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, sx: 0, sy: 0 };
      let sp = 0;
      stack[sp++] = start;
      labels[start] = next;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        c.area++; c.sx += x; c.sy += y;
        if (x < c.minX) c.minX = x;
        if (x > c.maxX) c.maxX = x;
        if (y < c.minY) c.minY = y;
        if (y > c.maxY) c.maxY = y;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
      }
      comps.push(c);
      next++;
    }
    return { labels, comps };
  }

  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat(b[i]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) return null;
      [M[col], M[pivot]] = [M[pivot], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        if (!f) continue;
        for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  /** Perspective transform (3x3, row-major) mapping 4 src points onto 4 dst points. */
  function solveHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solveLinear(A, b);
    return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
  }

  function applyHomography(H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
  }

  /** Builds an outW x outH gray image; H maps output pixels to source pixels. */
  function warpGray(src, H, outW, outH) {
    const { data, w, h } = src;
    const out = new Uint8ClampedArray(outW * outH);
    for (let y = 0; y < outH; y++) {
      const py = y + 0.5;
      for (let x = 0; x < outW; x++) {
        const px = x + 0.5;
        const d = H[6] * px + H[7] * py + H[8];
        const sx = (H[0] * px + H[1] * py + H[2]) / d - 0.5;
        const sy = (H[3] * px + H[4] * py + H[5]) / d - 0.5;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { out[y * outW + x] = 255; continue; }
        const fx = sx - x0, fy = sy - y0;
        const i = y0 * w + x0;
        const top = data[i] + (data[i + 1] - data[i]) * fx;
        const bottom = data[i + w] + (data[i + w + 1] - data[i + w]) * fx;
        out[y * outW + x] = top + (bottom - top) * fy;
      }
    }
    return { data: out, w: outW, h: outH };
  }

  function maxFilter(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
        tmp[y * w + x] = m;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
        out[y * w + x] = m;
      }
    }
    return out;
  }

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += src[y * w + k]; n++; }
        tmp[y * w + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; n++; }
        out[y * w + x] = s / n;
      }
    }
    return out;
  }

  /**
   * Removes uneven lighting and shadows: estimates the paper brightness around
   * every pixel and divides by it. Returns Float32Array where 1 = clean paper
   * and values near 0 = dark ink.
   */
  function normalizeIllumination(img, block) {
    block = block || 8;
    const { data, w, h } = img;
    const bw = Math.ceil(w / block), bh = Math.ceil(h / block);
    let small = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      const yEnd = Math.min(h, (by + 1) * block);
      for (let bx = 0; bx < bw; bx++) {
        const xEnd = Math.min(w, (bx + 1) * block);
        let m = 0;
        for (let y = by * block; y < yEnd; y++) {
          const row = y * w;
          for (let x = bx * block; x < xEnd; x++) if (data[row + x] > m) m = data[row + x];
        }
        small[by * bw + bx] = m;
      }
    }
    small = maxFilter(small, bw, bh, 2);
    small = boxBlur(small, bw, bh, 2);
    small = boxBlur(small, bw, bh, 2);

    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.max(0, (y + 0.5) / block - 0.5);
      const y0 = Math.min(bh - 1, Math.floor(fy)), y1 = Math.min(bh - 1, y0 + 1);
      const ty = Math.min(1, fy - y0);
      for (let x = 0; x < w; x++) {
        const fx = Math.max(0, (x + 0.5) / block - 0.5);
        const x0 = Math.min(bw - 1, Math.floor(fx)), x1 = Math.min(bw - 1, x0 + 1);
        const tx = Math.min(1, fx - x0);
        const top = small[y0 * bw + x0] + (small[y0 * bw + x1] - small[y0 * bw + x0]) * tx;
        const bottom = small[y1 * bw + x0] + (small[y1 * bw + x1] - small[y1 * bw + x0]) * tx;
        const bg = Math.max(16, top + (bottom - top) * ty);
        out[y * w + x] = Math.min(1, data[y * w + x] / bg);
      }
    }
    return out;
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      a += x0 * y1 - x1 * y0;
    }
    return a / 2;
  }

  function isConvex(pts) {
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length], [cx, cy] = pts[(i + 2) % pts.length];
      const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      if (cross === 0) continue;
      if (!sign) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  }

  HW.imageproc = {
    grayFromCanvas, otsu, labelComponents, solveHomography, applyHomography,
    warpGray, normalizeIllumination, polygonArea, isConvex
  };
})(window.HW);
