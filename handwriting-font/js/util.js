/*
 * Small UI helpers: downloads, sharing, toast messages, busy overlay.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('export failed'))), type || 'image/png', quality);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function canShareFiles(files) {
    return !!(navigator.canShare && navigator.share && navigator.canShare({ files }));
  }

  /** Stacks several canvases vertically into one image. */
  function stackCanvases(canvases, gap) {
    if (canvases.length === 1) return canvases[0];
    gap = gap || 20;
    const w = Math.max(...canvases.map((c) => c.width));
    const h = canvases.reduce((s, c) => s + c.height, 0) + gap * (canvases.length - 1);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#d0d0d0';
    ctx.fillRect(0, 0, w, h);
    let y = 0;
    for (const c of canvases) { ctx.drawImage(c, 0, y); y += c.height + gap; }
    return out;
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 3000);
  }

  /** Shows a spinner, lets the browser paint, runs the task, hides the spinner. */
  async function busy(text, task) {
    const el = document.getElementById('busy');
    document.getElementById('busy-text').textContent = text;
    el.hidden = false;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    try {
      return await task();
    } finally {
      el.hidden = true;
    }
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  HW.util = { canvasToBlob, downloadBlob, canShareFiles, stackCanvases, toast, busy, debounce };
})(window.HW);
