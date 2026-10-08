/*
 * Keeps the user's letters in the browser (localStorage). Nothing leaves the
 * device. Each glyph: { src: PNG data URL, top, w, h } (fractions of em).
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  const KEY = 'hwfont.glyphs.v1';
  const glyphs = {};
  const images = {};
  const listeners = [];

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function isValidGlyph(g) {
    return g && typeof g.src === 'string' && g.src.startsWith('data:image/') &&
      [g.top, g.w, g.h].every((v) => typeof v === 'number' && isFinite(v));
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, glyphs }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function notify() {
    listeners.forEach((fn) => fn());
  }

  async function addAll(map) {
    await Promise.all(Object.keys(map).map(async (ch) => {
      if (!isValidGlyph(map[ch])) return;
      try {
        images[ch] = await loadImage(map[ch].src);
        glyphs[ch] = map[ch];
      } catch (e) { /* skip unreadable glyph */ }
    }));
  }

  async function init() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (e) { /* storage unavailable or corrupt */ }
    if (saved && saved.glyphs) await addAll(saved.glyphs);
    notify();
  }

  /** Adds or replaces glyphs. Returns false if they could not be saved permanently. */
  async function setMany(map) {
    await addAll(map);
    const ok = persist();
    notify();
    return ok;
  }

  function remove(ch) {
    delete glyphs[ch];
    delete images[ch];
    persist();
    notify();
  }

  function clear() {
    Object.keys(glyphs).forEach((ch) => { delete glyphs[ch]; delete images[ch]; });
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    notify();
  }

  function exportJSON() {
    return JSON.stringify({ app: 'handwriting-font', version: 1, glyphs });
  }

  async function importJSON(text) {
    const data = JSON.parse(text);
    if (!data || typeof data.glyphs !== 'object') throw new Error('קובץ גיבוי לא תקין');
    const before = Object.keys(glyphs).length;
    const ok = await setMany(data.glyphs);
    return { ok, added: Object.keys(glyphs).length - before };
  }

  HW.store = {
    init,
    setMany,
    remove,
    clear,
    exportJSON,
    importJSON,
    get: (ch) => glyphs[ch],
    image: (ch) => images[ch],
    has: (ch) => Object.prototype.hasOwnProperty.call(glyphs, ch),
    count: () => Object.keys(glyphs).length,
    onChange: (fn) => listeners.push(fn)
  };
})(window.HW);
