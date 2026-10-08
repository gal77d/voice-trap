/*
 * Shows the photo with four draggable corner handles and a live preview of
 * the grid. While dragging, a magnifier shows what is under the finger.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  const L = HW.LAYOUT;
  const IP = HW.imageproc;
  const HANDLE_CSS = 16;   // visible handle radius (CSS px)
  const HIT_CSS = 44;      // touch radius (CSS px)
  const LENS_CSS = 62;     // magnifier radius (CSS px)
  const ZOOM = 3;

  class CornerEditor {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.photo = null;
      this.corners = null;
      this.active = -1;
      this.grab = [0, 0];
      this.onChange = null;

      canvas.addEventListener('pointerdown', (e) => this.onDown(e));
      canvas.addEventListener('pointermove', (e) => this.onMove(e));
      canvas.addEventListener('pointerup', (e) => this.onUp(e));
      canvas.addEventListener('pointercancel', (e) => this.onUp(e));
      window.addEventListener('resize', () => this.resize());
    }

    setImage(photo, corners) {
      this.photo = photo;
      this.corners = corners.map((p) => p.slice());
      this.resize();
    }

    getCorners() {
      return this.corners.map((p) => p.slice());
    }

    resize() {
      if (!this.photo || !this.canvas.parentElement) return;
      const maxW = this.canvas.parentElement.clientWidth || 320;
      const maxH = window.innerHeight * 0.68;
      let scale = maxW / this.photo.width;
      if (this.photo.height * scale > maxH) scale = maxH / this.photo.height;
      const cssW = this.photo.width * scale, cssH = this.photo.height * scale;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.style.width = cssW + 'px';
      this.canvas.style.height = cssH + 'px';
      this.canvas.width = Math.round(cssW * this.dpr);
      this.canvas.height = Math.round(cssH * this.dpr);
      this.viewScale = this.canvas.width / this.photo.width; // canvas px per photo px
      this.draw();
    }

    toPhoto(e) {
      const r = this.canvas.getBoundingClientRect();
      return [
        (e.clientX - r.left) * this.photo.width / r.width,
        (e.clientY - r.top) * this.photo.height / r.height
      ];
    }

    cssToPhoto(v) {
      return v * this.dpr / this.viewScale;
    }

    onDown(e) {
      if (!this.photo) return;
      const p = this.toPhoto(e);
      let best = -1, bestDist = this.cssToPhoto(HIT_CSS);
      this.corners.forEach((c, i) => {
        const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      if (best < 0) return;
      e.preventDefault();
      this.active = best;
      this.grab = [this.corners[best][0] - p[0], this.corners[best][1] - p[1]];
      this.canvas.setPointerCapture(e.pointerId);
      this.draw();
    }

    onMove(e) {
      if (this.active < 0) return;
      e.preventDefault();
      const p = this.toPhoto(e);
      const x = Math.min(this.photo.width, Math.max(0, p[0] + this.grab[0]));
      const y = Math.min(this.photo.height, Math.max(0, p[1] + this.grab[1]));
      this.corners[this.active] = [x, y];
      this.draw();
    }

    onUp() {
      if (this.active < 0) return;
      this.active = -1;
      this.draw();
      if (this.onChange) this.onChange(this.getCorners());
    }

    draw() {
      if (!this.photo) return;
      const ctx = this.ctx, s = this.viewScale;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.photo, 0, 0, this.canvas.width, this.canvas.height);

      // Grid preview through the current perspective.
      const H = IP.solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]], this.corners);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      if (H) {
        ctx.strokeStyle = 'rgba(0, 150, 255, 0.85)';
        ctx.lineWidth = this.cssToPhoto(1.2);
        ctx.beginPath();
        for (let c = 0; c <= L.cols; c++) {
          const a = IP.applyHomography(H, c / L.cols, 0), b = IP.applyHomography(H, c / L.cols, 1);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        }
        for (let r = 0; r <= L.rows; r++) {
          const a = IP.applyHomography(H, 0, r / L.rows), b = IP.applyHomography(H, 1, r / L.rows);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(255, 90, 0, 0.95)';
      ctx.lineWidth = this.cssToPhoto(2.5);
      ctx.beginPath();
      this.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();

      const r = this.cssToPhoto(HANDLE_CSS);
      this.corners.forEach(([x, y], i) => {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = i === this.active ? 'rgba(255, 90, 0, 0.55)' : 'rgba(255, 90, 0, 0.3)';
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.18, 0, Math.PI * 2);
        ctx.fillStyle = '#ff5a00';
        ctx.fill();
      });

      if (this.active >= 0) this.drawLens(this.corners[this.active]);
    }

    drawLens([px, py]) {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const R = LENS_CSS * this.dpr;
      const margin = 10 * this.dpr;
      const onLeft = px > this.photo.width / 2;
      const cx = onLeft ? R + margin : this.canvas.width - R - margin;
      const cy = py < this.photo.height / 2 ? this.canvas.height - R - margin : R + margin;

      // Source square in photo pixels, clamped to the image so Safari draws it.
      const half = R / (ZOOM * this.viewScale);
      const sx0 = Math.max(0, px - half), sy0 = Math.max(0, py - half);
      const sx1 = Math.min(this.photo.width, px + half), sy1 = Math.min(this.photo.height, py + half);
      const k = R / half; // canvas px per photo px inside the lens

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#777';
      ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      if (sx1 > sx0 && sy1 > sy0) {
        ctx.drawImage(this.photo, sx0, sy0, sx1 - sx0, sy1 - sy0,
          cx + (sx0 - px) * k, cy + (sy0 - py) * k, (sx1 - sx0) * k, (sy1 - sy0) * k);
      }
      ctx.restore();

      ctx.lineWidth = 2 * this.dpr;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#ff5a00';
      ctx.beginPath();
      ctx.moveTo(cx - R * 0.35, cy); ctx.lineTo(cx + R * 0.35, cy);
      ctx.moveTo(cx, cy - R * 0.35); ctx.lineTo(cx, cy + R * 0.35);
      ctx.stroke();
    }
  }

  HW.CornerEditor = CornerEditor;
})(window.HW);
