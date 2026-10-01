/*
 * Interactive A4 canvas preview: wheel / pinch-less zoom, drag to pan,
 * double-click to fit. Also renders live plot progress and the pen position.
 */
(function (g) {
  'use strict';
  const PW = (g.PW = g.PW || {});

  class Preview {
    constructor(canvas, hooks = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.hooks = hooks; // { hover(mm|null) }
      this.paper = PW.Layout.A4;
      this.layout = null;
      this.job = null;        // { items }
      this.done = 0;          // number of completed job commands
      this.pen = null;        // { x, y, down } marker
      this.show = { margins: true, travel: false };
      this.view = { scale: 1, ox: 0, oy: 0 };
      this.userView = false;  // true once the user zoomed/panned
      this._raf = 0;
      this._colors = {};
      this._bind();
      this.resize();
    }

    // ------------------------------------------------------------- state --
    setLayout(l) { this.layout = l; this.requestDraw(); }
    setJob(job) { this.job = job; this.done = 0; this.requestDraw(); }
    setProgress(done) { this.done = done; this.requestDraw(); }
    setPen(p) { this.pen = p; this.requestDraw(); }
    setShow(k, v) { this.show[k] = v; this.requestDraw(); }
    refreshTheme() { this._colors = {}; this.requestDraw(); }

    // -------------------------------------------------------------- view --
    resize() {
      const r = this.canvas.parentElement.getBoundingClientRect();
      const dpr = Math.max(1, g.devicePixelRatio || 1);
      this.dpr = dpr;
      this.w = Math.max(100, r.width);
      this.h = Math.max(100, r.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      if (!this.userView) this.fit(); else this.requestDraw();
    }

    fit() {
      const pad = 28;
      const s = Math.min((this.w - pad * 2) / this.paper.w, (this.h - pad * 2) / this.paper.h);
      this.view.scale = Math.max(0.2, s);
      this.view.ox = (this.w - this.paper.w * this.view.scale) / 2;
      this.view.oy = (this.h - this.paper.h * this.view.scale) / 2;
      this.userView = false;
      this.requestDraw();
    }

    zoomBy(factor, cx = this.w / 2, cy = this.h / 2) {
      const v = this.view;
      const ns = Math.min(40, Math.max(0.3, v.scale * factor));
      const k = ns / v.scale;
      v.ox = cx - (cx - v.ox) * k;
      v.oy = cy - (cy - v.oy) * k;
      v.scale = ns;
      this.userView = true;
      this.requestDraw();
    }

    toMM(px, py) { return { x: (px - this.view.ox) / this.view.scale, y: (py - this.view.oy) / this.view.scale }; }

    _bind() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      c.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy };
        c.setPointerCapture(e.pointerId);
        c.classList.add('grabbing');
      });
      c.addEventListener('pointermove', (e) => {
        const r = c.getBoundingClientRect();
        if (drag) {
          this.view.ox = drag.ox + (e.clientX - drag.x);
          this.view.oy = drag.oy + (e.clientY - drag.y);
          this.userView = true;
          this.requestDraw();
        }
        this.hooks.hover && this.hooks.hover(this.toMM(e.clientX - r.left, e.clientY - r.top));
      });
      const end = () => { drag = null; c.classList.remove('grabbing'); };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => this.hooks.hover && this.hooks.hover(null));
      c.addEventListener('dblclick', () => this.fit());
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(c.parentElement);
    }

    // -------------------------------------------------------------- draw --
    requestDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
    }

    color(name) {
      if (!this._colors[name]) this._colors[name] = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim() || '#888';
      return this._colors[name];
    }

    draw() {
      const { ctx, view, paper } = this;
      const s = view.scale;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.fillStyle = this.color('canvas-bg');
      ctx.fillRect(0, 0, this.w, this.h);

      // subtle dot grid every 10 mm
      if (s > 1.2) {
        ctx.fillStyle = this.color('grid');
        const step = 10 * s;
        const x0 = ((view.ox % step) + step) % step, y0 = ((view.oy % step) + step) % step;
        for (let x = x0; x < this.w; x += step) for (let y = y0; y < this.h; y += step) ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
      }

      ctx.save();
      ctx.translate(view.ox, view.oy);
      ctx.scale(s, s);

      // paper + shadow
      ctx.shadowColor = 'rgba(0,0,0,0.28)'; ctx.shadowBlur = 18 / 1; ctx.shadowOffsetY = 4;
      ctx.fillStyle = this.color('paper');
      ctx.fillRect(0, 0, paper.w, paper.h);
      ctx.shadowColor = 'transparent';

      const lw = Math.max(0.4, 1.1 / s); // keep hairlines visible when zoomed out
      const L = this.layout;

      if (L && this.show.margins) {
        ctx.setLineDash([2 / s * 3, 2 / s * 3]);
        ctx.lineWidth = 1 / s;
        ctx.strokeStyle = this.color('guide');
        ctx.strokeRect(L.area.x0, L.area.y0, L.area.x1 - L.area.x0, L.area.y1 - L.area.y0);
        ctx.setLineDash([]);
      }

      // text strokes
      if (L) {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.lineWidth = lw;
        for (const pass of [false, true]) {
          ctx.strokeStyle = this.color(pass ? 'danger' : 'ink');
          ctx.beginPath();
          for (const st of L.strokes) {
            if (st.overflow !== pass) continue;
            const p = st.pts;
            ctx.moveTo(p[0].x, p[0].y);
            if (p.length === 1) ctx.lineTo(p[0].x + 0.01, p[0].y);
            for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
          }
          ctx.stroke();
        }
      }

      // pen-up travel moves (optional)
      const items = this.job && this.job.items;
      if (items && this.show.travel) {
        ctx.strokeStyle = this.color('travel');
        ctx.lineWidth = 1 / s; ctx.setLineDash([3 / s, 3 / s]);
        ctx.beginPath();
        let px = 0, py = 0;
        for (const it of items) {
          if (it.c[0] === 'G' && !it.pen) { ctx.moveTo(px, py); ctx.lineTo(it.x, it.y); }
          px = it.x; py = it.y;
        }
        ctx.stroke(); ctx.setLineDash([]);
      }

      // executed (plotted) segments
      if (items && this.done > 0) {
        ctx.strokeStyle = this.color('plotted');
        ctx.lineWidth = lw * 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        let px = 0, py = 0;
        const n = Math.min(this.done, items.length);
        for (let i = 0; i < n; i++) {
          const it = items[i];
          if (it.c[0] === 'G' && it.pen) { ctx.moveTo(px, py); ctx.lineTo(it.x, it.y); }
          px = it.x; py = it.y;
        }
        ctx.stroke();
      }

      // home marker at the machine origin
      ctx.strokeStyle = this.color('muted'); ctx.lineWidth = 1 / s;
      const m = 4;
      ctx.beginPath(); ctx.moveTo(-m, 0); ctx.lineTo(m, 0); ctx.moveTo(0, -m); ctx.lineTo(0, m); ctx.stroke();

      // pen marker
      if (this.pen) {
        const { x, y, down } = this.pen;
        ctx.strokeStyle = this.color(down ? 'danger' : 'accent');
        ctx.fillStyle = this.color(down ? 'danger' : 'accent');
        ctx.lineWidth = 1.4 / s;
        ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 0.7, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x - 2.6, y); ctx.moveTo(x + 2.6, y); ctx.lineTo(x + 5, y);
        ctx.moveTo(x, y - 5); ctx.lineTo(x, y - 2.6); ctx.moveTo(x, y + 2.6); ctx.lineTo(x, y + 5); ctx.stroke();
      }
      ctx.restore();

      // rulers: a 50 mm scale bar bottom-left of the paper
      ctx.fillStyle = this.color('muted'); ctx.strokeStyle = this.color('muted');
      ctx.font = '11px system-ui, sans-serif'; ctx.lineWidth = 1;
      const bx = view.ox, by = view.oy + paper.h * s + 16;
      if (by < this.h - 4) {
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + 50 * s, by);
        ctx.moveTo(bx, by - 3); ctx.lineTo(bx, by + 3); ctx.moveTo(bx + 50 * s, by - 3); ctx.lineTo(bx + 50 * s, by + 3); ctx.stroke();
        ctx.fillText('50 mm', bx + 50 * s + 6, by + 4);
      }
    }
  }

  PW.Preview = Preview;
})(typeof window !== 'undefined' ? window : globalThis);

