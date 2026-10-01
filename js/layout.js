/*
 * Layout engine: text -> wrapped lines -> physical pen strokes (millimetres).
 *
 * Page coordinates: origin at the TOP-LEFT corner of the sheet, +X to the right,
 * +Y downward. These are also the machine coordinates sent to the plotter.
 */
(function (g) {
  'use strict';
  const PW = (g.PW = g.PW || {});

  const A4 = { w: 210, h: 297 };

  const DEFAULTS = {
    fontSize: 8,        // cap height in mm
    letterSpacing: 0.8, // extra mm between letters
    lineSpacing: 1.7,   // line pitch as a multiple of the cap height
    margin: 15,         // mm, all four sides
    align: 'left',      // left | center | right
  };

  function layoutText(rawText, userOpts) {
    const F = PW.Font;
    const o = Object.assign({}, DEFAULTS, userOpts);
    const s = o.fontSize / F.CAP; // mm per font unit
    const gap = F.GAP * s + o.letterSpacing;

    const area = {
      x0: o.margin, y0: o.margin,
      x1: A4.w - o.margin, y1: A4.h - o.margin,
    };
    const maxW = Math.max(0, area.x1 - area.x0);
    const maxH = Math.max(0, area.y1 - area.y0);

    const widthCache = new Map();
    const charW = (ch) => {
      let w = widthCache.get(ch);
      if (w === undefined) { w = F.glyph(ch).w * s; widthCache.set(ch, w); }
      return w;
    };
    const textWidth = (str) => {
      let w = 0, n = 0;
      for (const ch of str) { w += charW(ch); n++; }
      return n ? w + (n - 1) * gap : 0;
    };

    // ---- Word wrap ------------------------------------------------------
    const paragraphs = F.normalize(rawText).split('\n');
    const lines = []; // plain strings
    for (const para of paragraphs) {
      let cur = '', first = true;
      for (const word of para.split(' ')) {
        const cand = first ? word : cur + ' ' + word;
        if (textWidth(cand) <= maxW) { cur = cand; first = false; continue; }
        if (!first) { lines.push(cur); cur = ''; first = true; }
        if (textWidth(word) <= maxW) { cur = word; first = false; continue; }
        // A single word wider than the line: break it by characters.
        let piece = '';
        for (const ch of word) {
          if (piece === '' || textWidth(piece + ch) <= maxW) piece += ch;
          else { lines.push(piece); piece = ch; }
        }
        cur = piece; first = false;
      }
      lines.push(cur);
    }

    // ---- Place glyphs ---------------------------------------------------
    const pitch = o.fontSize * o.lineSpacing;
    const descent = -F.DESC * s;
    const out = [];       // line metadata
    const strokes = [];   // { pts: [{x,y}], line, overflow }
    let overflowLines = 0;
    let wideLines = 0;

    lines.forEach((raw, li) => {
      const text = raw.replace(/\s+$/, '');
      const baseline = area.y0 + o.fontSize + li * pitch;
      const hasDesc = /[gjpqy,;()[\]/\\|]/.test(text);
      const bottom = baseline + (hasDesc ? descent : 0);
      const width = textWidth(text);
      const tooTall = bottom > area.y1 + 1e-6;
      const tooWide = width > maxW + 1e-6;
      if (tooTall) overflowLines++;
      if (tooWide) wideLines++;

      let x = area.x0;
      if (o.align === 'center') x = area.x0 + (maxW - width) / 2;
      else if (o.align === 'right') x = area.x1 - width;

      out.push({ text, baseline, x, width, overflow: tooTall || tooWide });

      for (const ch of text) {
        const gl = F.glyph(ch);
        for (const st of gl.strokes) {
          strokes.push({
            line: li,
            overflow: tooTall || tooWide,
            pts: st.map(([gx, gy]) => ({ x: round3(x + gx * s), y: round3(baseline - gy * s) })),
          });
        }
        x += gl.w * s + gap;
      }
    });

    const usedHeight = lines.length ? o.fontSize + (lines.length - 1) * pitch : 0;
    return {
      opts: o,
      paper: A4,
      area,
      lines: out,
      strokes,
      overflow: overflowLines > 0 || wideLines > 0,
      overflowLines,
      stats: {
        chars: out.reduce((n, l) => n + l.text.length, 0),
        lines: out.length,
        strokes: strokes.length,
        usedHeight,
        availHeight: maxH,
        fillPct: maxH ? Math.min(999, (usedHeight / maxH) * 100) : 0,
      },
    };
  }

  const round3 = (v) => Math.round(v * 1000) / 1000;

  PW.Layout = { A4, DEFAULTS, layoutText };
})(typeof window !== 'undefined' ? window : globalThis);
