/*
 * Draws the printable A4 template: a title, four corner markers used for
 * automatic alignment, and a grid with one labelled cell per character.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  const L = HW.LAYOUT;
  const FONT = 'Arial, "Noto Sans Hebrew", "Segoe UI", sans-serif';

  function render(pxPerMm) {
    pxPerMm = pxPerMm || 8;
    const mm = (v) => v * pxPerMm;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(mm(L.pageW));
    canvas.height = Math.round(mm(L.pageH));
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title band (also tells the scanner which side is up).
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = 'rtl';
    ctx.font = `bold ${mm(6)}px ${FONT}`;
    ctx.fillText('תבנית כתב יד · Handwriting', mm(L.pageW / 2), mm(13.5));
    ctx.font = `${mm(3.1)}px ${FONT}`;
    ctx.fillText('כתבו כל תו במשבצת שלו בעט כהה. הקווים הקטנים בצדדים = קו השורה.', mm(L.pageW / 2), mm(20.5));

    // Corner markers.
    const s = L.markerSize;
    for (const [cx, cy] of L.markerCenters()) {
      ctx.fillRect(mm(cx - s / 2), mm(cy - s / 2), mm(s), mm(s));
    }

    // Grid lines.
    const cw = L.gridW / L.cols, ch = L.gridH / L.rows;
    ctx.strokeStyle = '#8a8a8a';
    ctx.lineWidth = mm(0.3);
    ctx.beginPath();
    for (let c = 0; c <= L.cols; c++) {
      const x = mm(L.gridX + c * cw);
      ctx.moveTo(x, mm(L.gridY));
      ctx.lineTo(x, mm(L.gridY + L.gridH));
    }
    for (let r = 0; r <= L.rows; r++) {
      const y = mm(L.gridY + r * ch);
      ctx.moveTo(mm(L.gridX), y);
      ctx.lineTo(mm(L.gridX + L.gridW), y);
    }
    ctx.stroke();

    // Cell labels and baseline ticks.
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `${mm(3.2)}px ${FONT}`;
    ctx.lineWidth = mm(0.35);
    HW.CHARS.forEach((char, i) => {
      const x0 = L.gridX + (i % L.cols) * cw;
      const y0 = L.gridY + Math.floor(i / L.cols) * ch;
      ctx.fillStyle = '#9a9a9a';
      ctx.fillText(char, mm(x0 + 1), mm(y0 + 0.8));

      const by = mm(y0 + ch * L.baseline);
      ctx.strokeStyle = '#b5b5b5';
      ctx.beginPath();
      ctx.moveTo(mm(x0), by);
      ctx.lineTo(mm(x0 + cw * L.tick), by);
      ctx.moveTo(mm(x0 + cw * (1 - L.tick)), by);
      ctx.lineTo(mm(x0 + cw), by);
      ctx.stroke();
    });

    return canvas;
  }

  HW.template = { render };
})(window.HW);
