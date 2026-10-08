/*
 * Lays out typed text with the user's glyphs on A4 pages (150 dpi).
 * Handles Hebrew RTL, embedded LTR words/numbers, final letters, and adds a
 * little random variation so the result looks hand-written.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  const PAGE_W = 1240, PAGE_H = 1754;
  const MARGIN = { top: 150, bottom: 110, side: 110 };
  const BASE = HW.LAYOUT.baseline;
  const MIRROR = { '(': ')', ')': '(' };
  const FALLBACK_FONT = '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';

  const measureCtx = document.createElement('canvas').getContext('2d');
  const tintCache = new Map();
  HW.store.onChange(() => tintCache.clear());

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function tinted(key, color) {
    const id = key + '|' + color;
    if (tintCache.has(id)) return tintCache.get(id);
    const img = HW.store.image(key);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    tintCache.set(id, c);
    return c;
  }

  /** Finds the stored glyph to use for a character (with sensible fallbacks). */
  function resolveGlyph(ch) {
    if (HW.store.has(ch)) return ch;
    const lower = ch.toLowerCase();
    if (lower !== ch && HW.store.has(lower)) return lower;
    const regular = HW.REGULAR_FORMS[ch];
    if (regular && HW.store.has(regular)) return regular;
    return null;
  }

  /** כ/מ/נ/פ/צ at the end of a Hebrew word become ך/ם/ן/ף/ץ. */
  function applyFinals(chars) {
    return chars.map((ch, i) => {
      const final = HW.FINAL_FORMS[ch];
      if (!final) return ch;
      const prev = chars[i - 1], next = chars[i + 1];
      const endsWord = !next || !HW.isHebrewLetter(next);
      return prev && HW.isHebrewLetter(prev) && endsWord ? final : ch;
    });
  }

  function charDir(ch) {
    if (HW.isHebrewLetter(ch)) return 'rtl';
    if (HW.isLatinOrDigit(ch)) return 'ltr';
    return null; // punctuation: neutral
  }

  /** Splits a word into runs of one direction ("ו-2024" → "ו", "-", "2024"). */
  function splitByDirection(chars) {
    const segs = [];
    for (const ch of chars) {
      const d = charDir(ch);
      const last = segs[segs.length - 1];
      if (last && last.dir === d) last.chars.push(ch);
      else segs.push({ dir: d, chars: [ch] });
    }
    return segs;
  }

  function paragraphDir(text) {
    for (const ch of text) {
      if (HW.isHebrewLetter(ch)) return 'rtl';
      if (/[A-Za-z]/.test(ch)) return 'ltr';
    }
    return null;
  }

  function makeItem(ch, opt, rnd, em) {
    const v = opt.variation;
    const scale = 1 + (rnd() - 0.5) * 0.12 * v;
    const rot = (rnd() - 0.5) * 0.07 * v;
    const dy = (rnd() - 0.5) * 0.035 * v * em;
    const gap = opt.letterSpacing * em + (rnd() - 0.5) * 0.04 * v * em;
    // Brackets are drawn mirrored inside right-to-left text.
    const mirrorCh = MIRROR[ch];
    const key = resolveGlyph(ch);
    if (key) {
      const g = HW.store.get(key);
      const w = g.w * em * scale;
      const mirrorKey = mirrorCh ? resolveGlyph(mirrorCh) : null;
      return { type: 'glyph', key, mirrorKey, scale, rot, dy, w, advance: w + gap };
    }
    const size = em * 0.42 * scale;
    measureCtx.font = `${size}px ${FALLBACK_FONT}`;
    const w = measureCtx.measureText(ch).width;
    return { type: 'font', ch, mirrorCh, size, rot, dy, w, advance: w + gap };
  }

  function tokenWidth(items) {
    if (!items.length) return 0;
    const last = items[items.length - 1];
    return items.reduce((s, it) => s + it.advance, 0) - last.advance + last.w;
  }

  /** Splits items into chunks no wider than maxW (for words longer than a line). */
  function chunkItems(items, maxW) {
    const chunks = [];
    let cur = [];
    for (const it of items) {
      if (cur.length && tokenWidth(cur.concat(it)) > maxW) { chunks.push(cur); cur = []; }
      cur.push(it);
    }
    chunks.push(cur);
    return chunks;
  }

  /**
   * A word becomes one or more tokens, one per direction run. Only the first
   * token carries the word gap; the rest are glued with letter spacing.
   */
  function makeWord(word, opt, rnd, em, spaceW, maxW) {
    let chars = Array.from(word);
    if (opt.autoFinals) chars = applyFinals(chars);
    const gap = spaceW * (1 + (rnd() - 0.5) * 0.4 * opt.variation);
    const dy = (rnd() - 0.5) * 0.03 * opt.variation * em;
    const tokens = [];
    for (const seg of splitByDirection(chars)) {
      const items = seg.chars.map((ch) => makeItem(ch, opt, rnd, em));
      for (const chunk of chunkItems(items, maxW)) {
        tokens.push({
          items: chunk,
          dir: seg.dir,
          gap: tokens.length ? Math.max(0, opt.letterSpacing * em) : gap,
          dy,
          width: tokenWidth(chunk)
        });
      }
    }
    return tokens;
  }

  function layout(text, opt) {
    const em = opt.size;
    const spaceW = em * opt.wordSpacing;
    const contentW = PAGE_W - 2 * MARGIN.side;
    const rnd = mulberry32(opt.seed);
    const lines = [];

    for (const para of text.replace(/\r/g, '').split('\n')) {
      const baseDir = paragraphDir(para) || opt.defaultDir;
      const words = para.split(/[ \t]+/).filter(Boolean);
      let cur = [], curW = 0;
      const breakLine = () => { lines.push({ tokens: cur, baseDir }); cur = []; curW = 0; };
      for (const word of words) {
        const tokens = makeWord(word, opt, rnd, em, spaceW, contentW);
        const wordW = tokens.reduce((s, t, i) => s + t.width + (i ? t.gap : 0), 0);
        if (wordW <= contentW) {
          if (cur.length && curW + tokens[0].gap + wordW > contentW) breakLine();
          curW += (cur.length ? tokens[0].gap : 0) + wordW;
          cur.push(...tokens);
          continue;
        }
        // Longer than a whole line: break between its pieces.
        for (const tok of tokens) {
          if (cur.length && curW + tok.gap + tok.width > contentW) breakLine();
          curW += (cur.length ? tok.gap : 0) + tok.width;
          cur.push(tok);
        }
      }
      lines.push({ tokens: cur, baseDir });
    }
    return lines;
  }

  /**
   * Gives punctuation-only tokens a direction: the direction of the strong
   * text on both sides when they agree ("10:30", "Hello, world"), otherwise
   * the paragraph direction.
   */
  function resolveDirections(line) {
    const toks = line.tokens;
    toks.forEach((tok, i) => {
      if (tok.dir) { tok.eff = tok.dir; return; }
      let prev = null, next = null;
      for (let j = i - 1; j >= 0 && !prev; j--) prev = toks[j].dir;
      for (let j = i + 1; j < toks.length && !next; j++) next = toks[j].dir;
      tok.eff = prev && prev === next ? prev : line.baseDir;
    });
  }

  /**
   * Places the tokens of one line. Runs whose direction differs from the
   * paragraph (e.g. English or numbers inside Hebrew) are laid out as a block.
   * Returns [{ token, left, right }].
   */
  function placeLine(line, x0, x1) {
    resolveDirections(line);
    const rtl = line.baseDir === 'rtl';
    const runs = [];
    for (const tok of line.tokens) {
      const last = runs[runs.length - 1];
      if (last && last.dir === tok.eff) last.tokens.push(tok);
      else runs.push({ dir: tok.eff, tokens: [tok] });
    }

    const placed = [];
    let cursor = rtl ? x1 : x0;
    const step = rtl ? -1 : 1;
    let first = true;
    for (const run of runs) {
      if (run.dir === line.baseDir) {
        for (const tok of run.tokens) {
          if (!first) cursor += step * tok.gap;
          first = false;
          const a = cursor, b = cursor + step * tok.width;
          placed.push({ token: tok, left: Math.min(a, b), right: Math.max(a, b) });
          cursor = b;
        }
      } else {
        if (!first) cursor += step * run.tokens[0].gap;
        first = false;
        const total = run.tokens.reduce((s, t, i) => s + t.width + (i ? t.gap : 0), 0);
        // inside the run, tokens go in the run's own direction
        let x = rtl ? cursor - total : cursor + total;
        run.tokens.forEach((tok, i) => {
          if (i) x += -step * tok.gap;
          const a = x, b = x - step * tok.width;
          placed.push({ token: tok, left: Math.min(a, b), right: Math.max(a, b) });
          x = b;
        });
        cursor += step * total;
      }
    }
    return placed;
  }

  function drawItem(ctx, it, xLeft, baseline, em, color, rtl) {
    ctx.save();
    ctx.translate(xLeft + it.w / 2, baseline + it.dy);
    ctx.rotate(it.rot);
    if (it.type === 'glyph') {
      const key = rtl && it.mirrorKey ? it.mirrorKey : it.key;
      const g = HW.store.get(key);
      const w = g.w * em * it.scale;
      ctx.drawImage(tinted(key, color), -w / 2, (g.top - BASE) * em * it.scale, w, g.h * em * it.scale);
    } else {
      ctx.fillStyle = color;
      ctx.font = `${it.size}px ${FALLBACK_FONT}`;
      ctx.direction = 'ltr';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(rtl && it.mirrorCh ? it.mirrorCh : it.ch, -it.w / 2, 0);
    }
    ctx.restore();
  }

  function drawToken(ctx, p, baseline, em, color) {
    const tok = p.token;
    const rtl = tok.eff === 'rtl';
    let x = rtl ? p.right : p.left;
    for (const it of tok.items) {
      const left = rtl ? x - it.w : x;
      drawItem(ctx, it, left, baseline + tok.dy, em, color, rtl);
      x += rtl ? -it.advance : it.advance;
    }
  }

  function drawPaper(ctx, paper, lineH, lineCount, marginSide) {
    ctx.fillStyle = '#fffefa';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    if (paper === 'lined') {
      ctx.strokeStyle = '#a9c6e6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < lineCount; i++) {
        const y = Math.round(MARGIN.top + (i + 1) * lineH) + 0.5;
        ctx.moveTo(40, y);
        ctx.lineTo(PAGE_W - 40, y);
      }
      ctx.stroke();
      ctx.strokeStyle = '#ec9f9f';
      ctx.beginPath();
      const mx = marginSide === 'right' ? PAGE_W - MARGIN.side + 35 : MARGIN.side - 35;
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, PAGE_H);
      ctx.stroke();
    } else if (paper === 'grid') {
      const step = lineH / 2;
      ctx.strokeStyle = '#cfe0f2';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let y = MARGIN.top + lineH; y < PAGE_H; y += step) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
      for (let y = MARGIN.top + lineH - step; y > 0; y -= step) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
      for (let x = PAGE_W / 2; x < PAGE_W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, PAGE_H); }
      for (let x = PAGE_W / 2 - step; x > 0; x -= step) { ctx.moveTo(x, 0); ctx.lineTo(x, PAGE_H); }
      ctx.stroke();
    }
  }

  /**
   * opt: { size, lineSpacing, letterSpacing, wordSpacing, variation (0..1),
   *        color, paper, autoFinals, seed, defaultDir }
   * Returns an array of page canvases.
   */
  function render(text, opt) {
    const em = opt.size;
    const lineH = em * opt.lineSpacing;
    const lines = layout(text, opt);
    const perPage = Math.max(1, Math.floor((PAGE_H - MARGIN.top - MARGIN.bottom) / lineH));
    const marginSide = (lines.find((l) => l.tokens.length) || { baseDir: opt.defaultDir }).baseDir === 'rtl' ? 'right' : 'left';
    const rnd = mulberry32(opt.seed + 1);
    const pages = [];

    for (let start = 0; start < Math.max(1, lines.length); start += perPage) {
      const canvas = document.createElement('canvas');
      canvas.width = PAGE_W;
      canvas.height = PAGE_H;
      const ctx = canvas.getContext('2d');
      drawPaper(ctx, opt.paper, lineH, perPage, marginSide);
      lines.slice(start, start + perPage).forEach((line, i) => {
        const baseline = MARGIN.top + (i + 1) * lineH + (rnd() - 0.5) * 0.03 * opt.variation * em;
        for (const p of placeLine(line, MARGIN.side, PAGE_W - MARGIN.side)) {
          drawToken(ctx, p, baseline, em, opt.color);
        }
      });
      pages.push(canvas);
    }
    return pages;
  }

  HW.composer = { render, PAGE_W, PAGE_H };
})(window.HW);
