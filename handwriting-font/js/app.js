/*
 * Connects the screens, buttons and modules together.
 */
(async function (HW) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const U = HW.util;
  const SETTINGS_KEY = 'hwfont.settings.v1';
  const SAMPLE_TEXT = 'שלום! זה כתב היד שלי, הפך לפונט.\nHello, this is my handwriting 123.';

  await HW.store.init();

  /* ---------------- navigation ---------------- */

  const SCREENS = ['template', 'scan', 'write'];
  let current = null;

  function show(name) {
    if (!SCREENS.includes(name)) name = 'template';
    current = name;
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.goto === name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    window.scrollTo(0, 0);
    if (name === 'template') showTemplatePreview();
    if (name === 'scan' && photo) editor.resize();
    if (name === 'write') renderWriting();
  }

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-goto]');
    if (target) show(target.dataset.goto);
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  function updateCount() {
    const n = HW.store.count();
    $('glyph-count').textContent = `${n}/${HW.CHARS.length} אותיות`;
  }

  /* ---------------- glyph tiles ---------------- */

  function glyphTile(char, source, g, extraClass) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'glyph-tile' + (extraClass ? ' ' + extraClass : '');
    const c = document.createElement('canvas');
    c.width = 108;
    c.height = 120;
    const ctx = c.getContext('2d');
    const em = c.height;
    ctx.strokeStyle = '#d6e2f2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, HW.LAYOUT.baseline * em);
    ctx.lineTo(c.width, HW.LAYOUT.baseline * em);
    ctx.stroke();
    if (source && g) {
      let w = g.w * em, h = g.h * em, top = g.top * em;
      const fit = Math.min(1, (c.width - 4) / w);
      w *= fit; h *= fit;
      ctx.drawImage(source, (c.width - w) / 2, top, w, h);
    }
    const label = document.createElement('span');
    label.textContent = char;
    tile.append(c, label);
    return tile;
  }

  /* ---------------- screen 1: template ---------------- */

  let templateCanvas = null;
  let templateUrl = null;

  function getTemplate() {
    if (!templateCanvas) templateCanvas = HW.template.render(8);
    return templateCanvas;
  }

  async function showTemplatePreview() {
    if (templateUrl) return;
    const blob = await U.canvasToBlob(getTemplate(), 'image/png');
    templateUrl = URL.createObjectURL(blob);
    $('template-preview').src = templateUrl;
  }

  $('btn-template-pdf').addEventListener('click', () => U.busy('יוצר PDF…', async () => {
    U.downloadBlob(await HW.pdf.fromCanvases([getTemplate()], 0.92), 'handwriting-template.pdf');
  }));

  $('btn-template-png').addEventListener('click', async () => {
    U.downloadBlob(await U.canvasToBlob(getTemplate(), 'image/png'), 'handwriting-template.png');
  });

  $('btn-template-print').addEventListener('click', async () => {
    await showTemplatePreview();
    const img = $('print-img');
    if (img.src === templateUrl && img.complete) { window.print(); return; }
    img.onload = () => window.print();
    img.src = templateUrl;
  });

  /* ---------------- screen 2: scan ---------------- */

  const editor = new HW.CornerEditor($('corner-canvas'));
  let photo = null;
  let grid = null;
  let found = null;
  const excluded = new Set();

  async function onPhotoChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await U.busy('טוען תמונה…', async () => {
        photo = await HW.scanner.loadImage(file);
        $('align-card').hidden = false;
        $('result-card').hidden = true;
        autoDetect();
      });
      $('align-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      U.toast(err.message || 'שגיאה בטעינת התמונה');
    }
  }

  function autoDetect() {
    const corners = HW.scanner.detect(photo);
    if (corners) {
      editor.setImage(photo, corners);
      $('align-status').textContent = '✅ הדף זוהה. בדקו שהקווים הכחולים יושבים על הרשת ואז לחצו „חיתוך האותיות".';
    } else {
      editor.setImage(photo, HW.scanner.defaultCorners(photo));
      $('align-status').textContent = '⚠️ לא הצלחתי למצוא את 4 הריבועים. גררו את העיגולים לפינות הרשת ידנית.';
    }
  }

  $('input-camera').addEventListener('change', onPhotoChosen);
  $('input-gallery').addEventListener('change', onPhotoChosen);

  $('btn-detect').addEventListener('click', () => U.busy('מחפש את הדף…', async () => autoDetect()));

  $('btn-rotate').addEventListener('click', () => U.busy('מסובב…', async () => {
    photo = HW.scanner.rotate(photo);
    autoDetect();
  }));

  function runExtraction() {
    found = HW.scanner.extractGlyphs(grid, Number($('sensitivity').value));
    renderResultGrid();
  }

  function renderResultGrid() {
    const box = $('result-grid');
    box.textContent = '';
    HW.CHARS.forEach((ch) => {
      const g = found.glyphs[ch];
      if (!g) {
        box.append(glyphTile(ch, null, null, 'missing'));
        return;
      }
      const tile = glyphTile(ch, g.canvas, g, excluded.has(ch) ? 'excluded' : '');
      tile.addEventListener('click', () => {
        if (excluded.has(ch)) excluded.delete(ch); else excluded.add(ch);
        tile.classList.toggle('excluded', excluded.has(ch));
        updateResultStatus();
      });
      box.append(tile);
    });
    updateResultStatus();
  }

  function updateResultStatus() {
    const selected = Object.keys(found.glyphs).filter((ch) => !excluded.has(ch)).length;
    $('result-status').textContent = `נמצאו ${found.count} מתוך ${HW.CHARS.length} תווים · ${selected} נבחרו לשמירה. משבצות ריקות לא ידרסו אותיות ששמרתם קודם.`;
  }

  $('btn-extract').addEventListener('click', async () => {
    try {
      await U.busy('מיישר וחותך אותיות…', async () => {
        grid = HW.scanner.rectify(photo, editor.getCorners());
        excluded.clear();
        runExtraction();
      });
      $('result-card').hidden = false;
      $('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      U.toast(err.message || 'החיתוך נכשל');
    }
  });

  const rerunExtraction = U.debounce(() => { if (grid) runExtraction(); }, 150);
  $('sensitivity').addEventListener('input', () => {
    $('sensitivity-out').textContent = $('sensitivity').value;
    rerunExtraction();
  });

  $('btn-save-glyphs').addEventListener('click', () => U.busy('שומר…', async () => {
    const map = {};
    for (const ch of Object.keys(found.glyphs)) {
      if (excluded.has(ch)) continue;
      const g = found.glyphs[ch];
      map[ch] = {
        src: g.canvas.toDataURL('image/png'),
        top: +g.top.toFixed(4),
        w: +g.w.toFixed(4),
        h: +g.h.toFixed(4)
      };
    }
    const ok = await HW.store.setMany(map);
    U.toast(ok ? `נשמרו ${Object.keys(map).length} אותיות ✓` : 'האותיות נטענו, אבל הדפדפן לא מאפשר לשמור אותן לפעם הבאה. מומלץ ללחוץ „גיבוי".', 4500);
    show('write');
  }));

  function renderSavedGrid() {
    const box = $('saved-grid');
    box.textContent = '';
    const n = HW.store.count();
    $('saved-status').textContent = n
      ? `${n} אותיות שמורות במכשיר הזה. לחיצה על אות מוחקת אותה.`
      : 'עוד לא נשמרו אותיות.';
    HW.CHARS.forEach((ch) => {
      if (!HW.store.has(ch)) return;
      const tile = glyphTile(ch, HW.store.image(ch), HW.store.get(ch));
      tile.addEventListener('click', () => {
        if (confirm(`למחוק את האות „${ch}"?`)) HW.store.remove(ch);
      });
      box.append(tile);
    });
  }

  $('btn-export').addEventListener('click', () => {
    if (!HW.store.count()) { U.toast('אין אותיות לגבות'); return; }
    U.downloadBlob(new Blob([HW.store.exportJSON()], { type: 'application/json' }), 'my-handwriting-backup.json');
  });

  $('input-import').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await HW.store.importJSON(await file.text());
      U.toast(res.ok ? 'הגיבוי שוחזר ✓' : 'הגיבוי נטען אך לא נשמר במכשיר');
    } catch (err) {
      U.toast('קובץ הגיבוי לא תקין');
    }
  });

  $('btn-clear').addEventListener('click', () => {
    if (confirm('למחוק את כל האותיות השמורות?')) HW.store.clear();
  });

  /* ---------------- screen 3: write ---------------- */

  const textInput = $('text-input');
  const ranges = {
    size: $('opt-size'),
    lineSpacing: $('opt-line'),
    letterSpacing: $('opt-letter'),
    wordSpacing: $('opt-word'),
    variation: $('opt-variation')
  };
  let seed = Math.floor(Math.random() * 1e9);
  let pages = [];

  function loadSettings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { /* ignore */ }
    textInput.value = s && typeof s.text === 'string' ? s.text : SAMPLE_TEXT;
    if (!s) return;
    for (const k of Object.keys(ranges)) if (s[k] != null) ranges[k].value = s[k];
    if (s.paper) $('opt-paper').value = s.paper;
    if (typeof s.autoFinals === 'boolean') $('opt-finals').checked = s.autoFinals;
    if (s.color) {
      const radio = document.querySelector(`input[name="ink"][value="${s.color}"]`);
      if (radio) radio.checked = true;
    }
    if (typeof s.seed === 'number') seed = s.seed;
  }

  function readOptions() {
    return {
      size: Number(ranges.size.value),
      lineSpacing: Number(ranges.lineSpacing.value),
      letterSpacing: Number(ranges.letterSpacing.value),
      wordSpacing: Number(ranges.wordSpacing.value),
      variation: Number(ranges.variation.value) / 100,
      color: document.querySelector('input[name="ink"]:checked').value,
      paper: $('opt-paper').value,
      autoFinals: $('opt-finals').checked,
      seed,
      defaultDir: 'rtl'
    };
  }

  function saveSettings(opt) {
    const s = Object.assign({}, opt, { text: textInput.value, variation: ranges.variation.value });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  function updateOutputs() {
    document.querySelectorAll('output[data-for]').forEach((o) => { o.textContent = $(o.dataset.for).value; });
  }

  function renderWriting() {
    updateOutputs();
    const opt = readOptions();
    saveSettings(opt);
    $('no-glyphs-notice').hidden = HW.store.count() > 0;
    pages = HW.composer.render(textInput.value, opt);
    const box = $('pages');
    box.textContent = '';
    pages.forEach((p) => box.append(p));
  }

  const renderSoon = U.debounce(() => { if (current === 'write') renderWriting(); }, 250);
  textInput.addEventListener('input', renderSoon);
  document.querySelector('.settings').addEventListener('input', () => { updateOutputs(); renderSoon(); });
  document.querySelector('.settings').addEventListener('change', renderSoon);

  $('btn-reshuffle').addEventListener('click', () => {
    seed = Math.floor(Math.random() * 1e9);
    renderWriting();
  });

  $('btn-png').addEventListener('click', () => U.busy('יוצר תמונה…', async () => {
    U.downloadBlob(await U.canvasToBlob(U.stackCanvases(pages), 'image/png'), 'my-handwriting.png');
  }));

  $('btn-pdf').addEventListener('click', () => U.busy('יוצר PDF…', async () => {
    U.downloadBlob(await HW.pdf.fromCanvases(pages, 0.9), 'my-handwriting.pdf');
  }));

  // Sharing is offered only where the browser can share files (most phones).
  const probe = [new File([new Blob(['x'], { type: 'image/png' })], 'probe.png', { type: 'image/png' })];
  $('btn-share').hidden = !U.canShareFiles(probe);
  $('btn-share').addEventListener('click', async () => {
    try {
      const files = await U.busy('מכין לשיתוף…', async () => Promise.all(pages.map(async (p, i) => {
        const blob = await U.canvasToBlob(p, 'image/png');
        return new File([blob], `my-handwriting-${i + 1}.png`, { type: 'image/png' });
      })));
      await navigator.share({ files, title: 'הכתב שלי' });
    } catch (err) {
      if (err && err.name !== 'AbortError') U.toast('השיתוף נכשל');
    }
  });

  /* ---------------- start ---------------- */

  HW.store.onChange(() => {
    updateCount();
    renderSavedGrid();
    if (current === 'write') renderWriting();
  });

  loadSettings();
  updateCount();
  renderSavedGrid();
  show(location.hash.slice(1) || (HW.store.count() ? 'write' : 'template'));
})(window.HW);
