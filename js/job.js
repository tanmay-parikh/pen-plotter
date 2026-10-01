/*
 * Job builder: turns pen strokes into the plotter command stream.
 *
 * Wire protocol (one ASCII command per line, firmware answers "ok" per command):
 *   PEN_UP | PEN_DOWN | HOME | ZERO | PING | STOP | ?
 *   G X<mm> Y<mm>        move to absolute position (pen state unchanged)
 *   JOG X<mm> Y<mm>      relative move with the pen lifted
 *   CFG <KEY> <value>    UP DN SPD TSPD SPMX SPMY INVX INVY
 */
(function (g) {
  'use strict';
  const PW = (g.PW = g.PW || {});

  const EPS = 0.02;      // mm: ignore moves shorter than this
  const PEN_TIME = 0.35; // s: estimated servo settle time per pen change

  const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /**
   * @param strokes  [{pts:[{x,y}]}] in page mm
   * @param opts     { drawSpeed, travelSpeed, returnHome }
   * @returns { items:[{c,x,y,pen}], commands:[string], stats }
   *   items[i] is the machine state AFTER command i completes (used by the preview).
   */
  function buildJob(strokes, opts) {
    const o = Object.assign({ drawSpeed: 6, travelSpeed: 8, returnHome: true }, opts);
    const items = [];
    let cur = { x: 0, y: 0 };
    let penDown = false;
    let drawLen = 0, travelLen = 0, lifts = 0;

    const emit = (c) => items.push({ c, x: cur.x, y: cur.y, pen: penDown });
    const penUp = () => { if (penDown) { penDown = false; emit('PEN_UP'); lifts++; } };
    const penDn = () => { if (!penDown) { penDown = true; emit('PEN_DOWN'); } };
    const goto = (p) => {
      const d = dist(cur, p);
      if (d < EPS) return;
      if (penDown) drawLen += d; else travelLen += d;
      cur = { x: p.x, y: p.y };
      emit(`G X${fmt(p.x)} Y${fmt(p.y)}`);
    };

    emit('PEN_UP');
    for (const st of strokes) {
      const pts = st.pts;
      if (!pts.length) continue;
      if (dist(cur, pts[0]) >= EPS) { penUp(); goto(pts[0]); }
      penDn();
      for (let i = 1; i < pts.length; i++) goto(pts[i]);
    }
    penUp();
    if (o.returnHome && (cur.x || cur.y)) {
      travelLen += dist(cur, { x: 0, y: 0 });
      cur = { x: 0, y: 0 };
      emit('HOME');
    }

    const estSeconds = drawLen / o.drawSpeed + travelLen / o.travelSpeed + lifts * 2 * PEN_TIME;
    return {
      items,
      commands: items.map((i) => i.c),
      stats: { commands: items.length, drawLen, travelLen, penLifts: lifts, estSeconds },
    };
  }

  /** A 50 mm square 10 mm from the top-left corner: used to calibrate steps/mm. */
  function calibrationSquare(size = 50, offset = 10) {
    const a = offset, b = offset + size;
    return [{ pts: [{ x: a, y: a }, { x: b, y: a }, { x: b, y: b }, { x: a, y: b }, { x: a, y: a }] }];
  }

  function toSVG(strokes, paper) {
    const d = strokes
      .map((s) => s.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' '))
      .join(' ');
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${paper.w}mm" height="${paper.h}mm" viewBox="0 0 ${paper.w} ${paper.h}">\n` +
      `<rect width="${paper.w}" height="${paper.h}" fill="#fff"/>\n` +
      `<path d="${d}" fill="none" stroke="#111" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round"/>\n</svg>\n`
    );
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '–';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min ${s} s`;
    return `${s} s`;
  }

  PW.Job = { buildJob, calibrationSquare, toSVG, formatDuration };
})(typeof window !== 'undefined' ? window : globalThis);
