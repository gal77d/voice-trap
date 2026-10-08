/*
 * Minimal PDF writer: one JPEG image per A4 page. No external library.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  const A4 = { w: 595.28, h: 841.89 }; // points

  function canvasToJpegBytes(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('JPEG encoding failed')); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      }, 'image/jpeg', quality);
    });
  }

  async function fromCanvases(canvases, quality) {
    quality = quality || 0.9;
    const images = [];
    for (const c of canvases) {
      images.push({ bytes: await canvasToJpegBytes(c, quality), w: c.width, h: c.height });
    }

    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let offset = 0;
    const push = (data) => {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(bytes);
      offset += bytes.length;
    };
    const obj = (id, body, stream) => {
      offsets[id] = offset;
      push(`${id} 0 obj\n${body}\n`);
      if (stream) {
        push('stream\n');
        push(stream);
        push('\nendstream\n');
      }
      push('endobj\n');
    };

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    const pageIds = images.map((_, i) => 3 + i * 3);
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => id + ' 0 R').join(' ')}] /Count ${images.length} >>`);

    images.forEach((img, i) => {
      const pageId = pageIds[i], contentId = pageId + 1, imageId = pageId + 2;
      obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      const content = enc.encode(`q ${A4.w} 0 0 ${A4.h} 0 0 cm /Im0 Do Q`);
      obj(contentId, `<< /Length ${content.length} >>`, content);
      obj(imageId, `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`, img.bytes);
    });

    const count = 3 + images.length * 3;
    const xrefOffset = offset;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id++) xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    push(xref);
    push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  HW.pdf = { fromCanvases };
})(window.HW);
