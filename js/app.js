/* PlotWrite — application controller (UI wiring, settings, connection, job lifecycle). */
(function () {
  'use strict';
  const PW = window.PW;
  const { Layout, Job, Transport } = PW;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ settings --
  const STORE_KEY = 'plotwrite.v1';
  const DEFAULTS = {
    text: 'Hello, plotter!\n\nThe quick brown fox jumps over the lazy dog.\n0123456789  .,;:!?\'"-()',
    fontSize: 8, letterSpacing: 0.8, lineSpacing: 1.7, margin: 15, align: 'left',
    drawSpeed: 6, travelSpeed: 8, penUp: 60, penDown: 30,
    spmX: 102.4, spmY: 102.4, invX: false, invY: false, returnHome: true,
    window: 3, simScale: 20,
    blePreset: 'hm10', bleService: '', bleTx: '', bleRx: '',
    jogStep: 5, showMargins: true, showTravel: false, theme: null,
  };
  const LAYOUT_KEYS = ['text', 'fontSize', 'letterSpacing', 'lineSpacing', 'margin', 'align'];
  const JOB_KEYS = [...LAYOUT_KEYS, 'drawSpeed', 'travelSpeed', 'returnHome'];
  const CFG_MAP = {
    penUp: ['UP', (v) => Math.round(v)], penDown: ['DN', (v) => Math.round(v)],
    drawSpeed: ['SPD', (v) => v], travelSpeed: ['TSPD', (v) => v],
    spmX: ['SPMX', (v) => v], spmY: ['SPMY', (v) => v],
    invX: ['INVX', (v) => (v ? 1 : 0)], invY: ['INVY', (v) => (v ? 1 : 0)],
  };

  let settings = Object.assign({}, DEFAULTS);
  try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (_) { /* first run / blocked */ }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ } };

  // --------------------------------------------------------------- state --
  let layout = null, job = null;
  let transport = null, mode = null; // mode: 'ble' | 'sim' | null
  let manualBusy = 0;
  let wakeLock = null;
  const pen = { x: 0, y: 0, down: false };

  // ------------------------------------------------------------- helpers --
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
  }

  const logEl = $('log');
  function log(kind, text) {
    const near = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const d = document.createElement('div');
    d.className = kind;
    d.textContent = text;
    logEl.appendChild(d);
    while (logEl.childElementCount > 600) logEl.firstChild.remove();
    if (near) logEl.scrollTop = logEl.scrollHeight;
  }

  const num = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString();

  // ------------------------------------------------------ plotter + view --
  const plotter = new PW.Plotter({
    log,
    state: () => refreshControls(),
    disconnected: () => {
      mode = null; transport = null;
      setConn('off', 'Disconnected');
      toast('Plotter disconnected', 'error');
      log('info', 'Disconnected.');
      refreshControls();
    },
    progress: (done, total) => onProgress(done, total),
  });

  const preview = new PW.Preview($('preview'), {
    hover: (p) => {
      $('coord').textContent = p && p.x >= 0 && p.y >= 0 && p.x <= 210 && p.y <= 297
        ? `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)} mm` : 'A4 · 210 × 297 mm';
    },
  });

  // -------------------------------------------------------- recomputation --
  let relayoutQueued = false;
  function scheduleRelayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => { relayoutQueued = false; recompute(); });
  }

  let recomputeAfterJob = false;
  function recompute() {
    if (plotter.running) { recomputeAfterJob = true; return; } // never disturb a live job's preview
    layout =Layout.layoutText(settings.text, {
      fontSize: settings.fontSize, letterSpacing: settings.letterSpacing,
      lineSpacing: settings.lineSpacing, margin: settings.margin, align: settings.align,
    });
    job = Job.buildJob(layout.strokes, {
      drawSpeed: settings.drawSpeed, travelSpeed: settings.travelSpeed, returnHome: settings.returnHome,
    });
    preview.setLayout(layout);
    preview.setJob(job);
    updateStats();
    setProgressUI(0, 0);
    refreshControls();
  }

  function updateStats() {
    const s = job.stats, l = layout.stats;
    $('stLines').textContent = l.lines;
    $('stStrokes').textContent = l.strokes;
    $('stDraw').textContent = s.drawLen >= 1000 ? (s.drawLen / 1000).toFixed(2) + ' m' : Math.round(s.drawLen) + ' mm';
    $('stLifts').textContent = s.penLifts;
    $('stFill').textContent = Math.round(l.fillPct) + '%';
    $('stTime').textContent = Job.formatDuration(s.estSeconds);
    $('charCount').textContent = `${settings.text.length} character${settings.text.length === 1 ? '' : 's'}`;

    const w = $('jobWarning');
    if (layout.overflow) {
      w.hidden = false;
      w.textContent = `Text does not fit on the page (${layout.overflowLines || 'some'} line${layout.overflowLines === 1 ? '' : 's'} overflow, shown in red). Reduce font size, spacing or margins, or shorten the text.`;
    } else if (!l.strokes) {
      w.hidden = false;
      w.textContent = 'Nothing to plot yet. Type some text.';
    } else w.hidden = true;
  }

  // ------------------------------------------------- settings <-> inputs --
  function typeOf(el) {
    return el.dataset.type || (el.type === 'range' || el.type === 'number' ? 'number' : 'text');
  }

  function syncInputs(key, except) {
    document.querySelectorAll(`[data-setting="${key}"]`).forEach((el) => {
      if (el === except) return;
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key] ?? '';
    });
    if (key === 'align') {
      document.querySelectorAll('#alignSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.align === settings.align)));
    }
  }

  function setSetting(key, value, source) {
    settings[key] = value;
    save();
    syncInputs(key, source);
    onSettingChanged(key);
  }

  let cfgTimers = {};
  function onSettingChanged(key) {
    if (JOB_KEYS.includes(key)) scheduleRelayout();
    if (key in CFG_MAP) { clearTimeout(cfgTimers[key]); cfgTimers[key] = setTimeout(() => pushCfg(key), 250); }
    if (key === 'showMargins' || key === 'showTravel') preview.setShow(key === 'showMargins' ? 'margins' : 'travel', settings[key]);
    if (key === 'window') plotter.window = Math.min(6, Math.max(1, settings.window | 0));
    if (key === 'simScale' && mode === 'sim' && transport) transport.timeScale = settings.simScale;
    if (key === 'blePreset') applyPreset();
  }

  function bindInputs() {
    document.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.dataset.setting, type = typeOf(el);
      const read = () => (el.type === 'checkbox' ? el.checked : type === 'number' ? parseFloat(el.value) : el.value);
      const inRange = (v) => (!el.min || v >= +el.min) && (!el.max || v <= +el.max);

      el.addEventListener('input', () => {
        const v = read();
        if (type === 'number' && (!Number.isFinite(v) || !inRange(v))) return; // wait for a valid value
        setSetting(key, v, el);
      });
      el.addEventListener('change', () => { // commit: clamp out-of-range typing
        let v = read();
        if (type === 'number') {
          if (!Number.isFinite(v)) v = DEFAULTS[key];
          if (el.min) v = Math.max(+el.min, v);
          if (el.max) v = Math.min(+el.max, v);
          setSetting(key, v);
        }
      });
    });
    document.querySelectorAll('#alignSeg button').forEach((b) => b.addEventListener('click', () => setSetting('align', b.dataset.align)));
    Object.keys(settings).forEach((k) => syncInputs(k));
  }

  function applyPreset() {
    const p = Transport.BLE_PRESETS[settings.blePreset];
    $('bleCustom').hidden = settings.blePreset !== 'custom';
    if (settings.blePreset !== 'custom' && p) {
      // keep the (hidden) custom fields in sync as a starting point for editing
      settings.bleService = p.service; settings.bleTx = p.tx; settings.bleRx = p.rx;
      ['bleService', 'bleTx', 'bleRx'].forEach((k) => syncInputs(k));
    }
  }

  // ------------------------------------------------------------- theming --
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    const eff = settings.theme || (mq && mq.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = eff;
    preview.refreshTheme();
  }

  // ---------------------------------------------------------- connection --
  function setConn(state, text) {
    $('connPill').dataset.state = state;
    $('connText').textContent = text;
  }

  function parseUuid(s) {
    s = (s || '').trim().toLowerCase();
    if (/^(0x)?[0-9a-f]{4}$/.test(s)) return parseInt(s.replace('0x', ''), 16);
    return s;
  }

  async function connectBle() {
    let cfg;
    if (settings.blePreset === 'custom') {
      cfg = { service: parseUuid(settings.bleService), tx: parseUuid(settings.bleTx), rx: parseUuid(settings.bleRx || settings.bleTx) };
      if (!cfg.service || !cfg.tx) { toast('Enter the service and write-characteristic UUIDs in Machine settings.', 'error'); return; }
    } else {
      const p = Transport.BLE_PRESETS[settings.blePreset];
      cfg = { service: p.service, tx: p.tx, rx: p.rx };
    }
    const t = new Transport.BleTransport(cfg);
    setConn('busy', 'Connecting…');
    try {
      await t.connect();
    } catch (e) {
      setConn('off', 'Disconnected');
      if (e && e.name === 'NotFoundError' && /cancel/i.test(e.message)) return; // user closed the chooser
      log('err', 'Bluetooth: ' + e.message);
      toast('Bluetooth connection failed: ' + e.message, 'error');
      return;
    }
    await afterConnect(t, 'ble', `Connected · ${t.name}`);
  }

  async function connectSim() {
    const t = new Transport.SimTransport({ timeScale: settings.simScale });
    setConn('busy', 'Starting…');
    await t.connect();
    await afterConnect(t, 'sim', 'Simulator');
  }

  async function afterConnect(t, m, label) {
    transport = t; mode = m;
    plotter.attach(t);
    plotter.window = Math.min(6, Math.max(1, settings.window | 0));
    setConn(m === 'sim' ? 'sim' : 'on', label);
    log('info', `Connected to ${t.name}.`);
    refreshControls();
    try {
      await plotter.exec('PING', 4000);
    } catch (e) {
      toast('Connected, but the Arduino did not answer. Check wiring, baud rate and that the firmware is flashed.', 'error');
    }
    await pushAllCfg();
  }

  async function pushAllCfg() {
    for (const key of Object.keys(CFG_MAP)) {
      if (!plotter.connected) return;
      try { await plotter.exec(cfgLine(key), 4000); } catch (e) { log('err', `CFG ${key}: ${e.message}`); }
    }
  }
  const cfgLine = (key) => `CFG ${CFG_MAP[key][0]} ${CFG_MAP[key][1](settings[key])}`;
  function pushCfg(key) {
    if (!plotter.connected || plotter.running) return;
    plotter.exec(cfgLine(key), 4000).catch((e) => log('err', e.message));
  }

  // ------------------------------------------------------ manual control --
  async function manual(cmd, after) {
    if (!plotter.connected) { toast('Connect to the plotter (or start the simulator) first.', 'error'); return; }
    if (plotter.running) return;
    manualBusy++; refreshControls();
    try {
      await plotter.exec(cmd, 120000);
      if (after) after();
    } catch (e) {
      if (e.message !== 'aborted') toast(`${cmd}: ${e.message}`, 'error');
    } finally { manualBusy--; refreshControls(); }
  }

  function setPen(x, y, down) {
    if (x !== undefined) pen.x = x;
    if (y !== undefined) pen.y = y;
    if (down !== undefined) pen.down = down;
    preview.setPen(plotter.connected ? { ...pen } : null);
    $('posText').textContent = plotter.connected ? `≈ X ${num(pen.x)}  Y ${num(pen.y)} · pen ${pen.down ? 'down' : 'up'}` : '';
  }

  function track(cmd) { // dead-reckon the pen marker for manually entered commands
    const c = cmd.trim().toUpperCase();
    const n = (axis) => { const m = new RegExp(axis + '(-?[0-9.]+)').exec(c); return m ? parseFloat(m[1]) : null; };
    if (c === 'PEN_UP') setPen(undefined, undefined, false);
    else if (c === 'PEN_DOWN') setPen(undefined, undefined, true);
    else if (c === 'HOME') setPen(0, 0, false);
    else if (c === 'ZERO') setPen(0, 0);
    else if (c.startsWith('G ')) setPen(n('X') ?? pen.x, n('Y') ?? pen.y);
    else if (c.startsWith('JOG')) setPen(pen.x + (n('X') ?? 0), pen.y + (n('Y') ?? 0), false);
  }
  const send = (cmd) => manual(cmd, () => track(cmd));

  // ----------------------------------------------------------- job runner --
  let currentEst = 0;

  function setProgressUI(done, total) {
    const pct = total ? (done / total) * 100 : 0;
    $('progressBar').style.width = pct.toFixed(1) + '%';
    if (!total) { $('progressText').textContent = plotter.connected ? 'Ready' : 'Idle'; return; }
    const left = currentEst * (1 - done / total);
    $('progressText').textContent = done >= total
      ? 'Finished'
      : `${Math.floor(pct)}% · ${done}/${total} commands · about ${Job.formatDuration(left)} left`;
  }

  function onProgress(done, total) {
    setProgressUI(done, total);
    preview.setProgress(done);
    const it = preview.job && preview.job.items[done - 1];
    if (it) setPen(it.x, it.y, it.pen);
  }

  function confirmPreflight() {
    const dlg = $('preflight');
    if (typeof dlg.showModal !== 'function') return Promise.resolve(confirm('Pen at the top-left corner and origin set? Start plotting?'));
    $('preflightSummary').textContent =
      `${layout.stats.lines} lines · ${layout.stats.strokes} strokes · ${Job.formatDuration(job.stats.estSeconds)} estimated.`;
    return new Promise((resolve) => {
      dlg.returnValue = ''; // otherwise Esc would reuse the previous answer
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'go'), { once: true });
      dlg.showModal();
    });
  }

  async function runPlot(j, label, { calibration = false } = {}) {
    currentEst = j.stats.estSeconds;
    preview.setJob(j);
    if (calibration) preview.setLayout(null);
    setProgressUI(0, j.items.length);
    log('info', `${label}: ${j.items.length} commands, about ${Job.formatDuration(j.stats.estSeconds)}.`);
    // Keep the screen awake while streaming (best effort; must never delay or block the job).
    let jobOver = false;
    try {
      if (navigator.wakeLock) {
        navigator.wakeLock.request('screen').then((l) => { if (jobOver) l.release(); else wakeLock = l; }).catch(() => {});
      }
    } catch (_) { /* optional */ }
    try {
      const res = await plotter.runJob(j.items);
      if (res.aborted) { toast('Plot stopped.'); log('info', 'Job stopped.'); }
      else { toast('Plot finished.', 'ok'); log('info', 'Job finished.'); }
    } catch (e) {
      toast('Plot failed: ' + e.message, 'error');
      log('err', 'Job failed: ' + e.message);
      try { await plotter.stop(); } catch (_) { /* already gone */ }
    } finally {
      jobOver = true;
      try { wakeLock && wakeLock.release(); } catch (_) { /* ignore */ }
      wakeLock = null;
      if (calibration) preview.setLayout(layout);
      if (recomputeAfterJob) { recomputeAfterJob = false; recompute(); }
      refreshControls();
    }
  }

  async function startJob() {
    if (!plotter.connected || plotter.running || layout.overflow || job.stats.drawLen <= 0) return;
    if (!(await confirmPreflight())) return;
    runPlot(job, 'Plot');
  }

  // ------------------------------------------------------------ controls --
  function refreshControls() {
    const connected = plotter.connected;
    const idle = connected && !plotter.running && manualBusy === 0;
    document.querySelectorAll('[data-needs="idle"]').forEach((b) => { b.disabled = !idle; });
    $('btnStart').disabled = !(idle && layout && !layout.overflow && job && job.stats.drawLen > 0);
    $('btnStart').title = !connected ? 'Connect Bluetooth or start the simulator first' : '';
    $('btnPause').disabled = !plotter.running;
    $('btnPause').textContent = plotter.paused ? 'Resume' : 'Pause';
    $('btnStop').disabled = !(connected && (plotter.running || manualBusy > 0));

    // lock the design inputs while a job is streaming
    document.querySelectorAll('[data-setting]').forEach((el) => {
      if (LAYOUT_KEYS.includes(el.dataset.setting)) el.disabled = plotter.running;
    });
    document.querySelectorAll('#alignSeg button').forEach((b) => { b.disabled = plotter.running; });

    $('btnConnect').textContent = connected && mode === 'ble' ? 'Disconnect' : 'Connect Bluetooth';
    $('btnConnect').disabled = connected && mode === 'sim';
    $('btnSim').textContent = connected && mode === 'sim' ? 'Stop simulator' : 'Simulator';
    $('btnSim').disabled = connected && mode === 'ble';
    if (!connected) { setPen(undefined, undefined, undefined); if (!plotter.running) setProgressUI(0, 0); }
  }

  function wireControls() {
    $('btnConnect').addEventListener('click', async () => {
      if (plotter.connected) await plotter.disconnect(); else await connectBle();
    });
    $('btnSim').addEventListener('click', async () => {
      if (plotter.connected) await plotter.disconnect(); else await connectSim();
    });
    $('btnTheme').addEventListener('click', () => {
      const eff = document.documentElement.dataset.theme;
      settings.theme = eff === 'dark' ? 'light' : 'dark';
      save(); applyTheme();
    });

    $('btnHome').addEventListener('click', () => send('HOME'));
    $('btnPenUp').addEventListener('click', () => send('PEN_UP'));
    $('btnPenDown').addEventListener('click', () => send('PEN_DOWN'));
    $('btnTestUp').addEventListener('click', async () => { await plotter.exec(cfgLine('penUp'), 4000).catch(() => {}); send('PEN_UP'); });
    $('btnTestDown').addEventListener('click', async () => { await plotter.exec(cfgLine('penDown'), 4000).catch(() => {}); send('PEN_DOWN'); });
    $('btnZero').addEventListener('click', () => send('ZERO'));
    document.querySelectorAll('[data-jog]').forEach((b) => b.addEventListener('click', () => {
      const [dx, dy] = b.dataset.jog.split(',').map(Number);
      const st = +settings.jogStep;
      send(`JOG X${(dx * st).toFixed(2)} Y${(dy * st).toFixed(2)}`);
    }));

    $('btnStart').addEventListener('click', startJob);
    $('btnPause').addEventListener('click', () => (plotter.paused ? plotter.resume() : plotter.pause()));
    $('btnStop').addEventListener('click', () => plotter.stop());
    $('btnCalibrate').addEventListener('click', async () => {
      if (!(await confirmPreflight())) return;
      runPlot(Job.buildJob(Job.calibrationSquare(), { drawSpeed: settings.drawSpeed, travelSpeed: settings.travelSpeed, returnHome: true }), 'Calibration square', { calibration: true });
    });

    $('zoomIn').addEventListener('click', () => preview.zoomBy(1.25));
    $('zoomOut').addEventListener('click', () => preview.zoomBy(0.8));
    $('zoomFit').addEventListener('click', () => preview.fit());
    $('btnSvg').addEventListener('click', exportSvg);

    $('btnClearLog').addEventListener('click', (e) => { e.preventDefault(); logEl.textContent = ''; });
    $('cmdForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('cmdInput').value.trim().toUpperCase();
      if (!v) return;
      $('cmdInput').value = '';
      if (v === 'STOP') plotter.stop(); else send(v);
    });

    $('btnResetType').addEventListener('click', () => LAYOUT_KEYS.filter((k) => k !== 'text').forEach((k) => setSetting(k, DEFAULTS[k])));
    $('btnResetAll').addEventListener('click', () => {
      if (!confirm('Reset every setting (including the text) to its default?')) return;
      try { localStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
      location.reload();
    });

    window.addEventListener('beforeunload', (e) => { if (plotter.running) { e.preventDefault(); e.returnValue = ''; } });
    if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (!settings.theme) applyTheme(); });
  }

  function exportSvg() {
    if (!layout || !layout.strokes.length) { toast('Nothing to export yet.', 'error'); return; }
    const blob = new Blob([Job.toSVG(layout.strokes, layout.paper)], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    a.download = `plotwrite-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.svg`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------- boot --
  function boot() {
    const sel = $('blePreset');
    Object.entries(Transport.BLE_PRESETS).forEach(([k, v]) => sel.add(new Option(v.label, k)));
    if (!Transport.BLE_PRESETS[settings.blePreset]) settings.blePreset = 'hm10';

    bindInputs();
    wireControls();
    applyPreset();
    preview.setShow('margins', settings.showMargins);
    preview.setShow('travel', settings.showTravel);
    applyTheme();

    const banner = $('banner');
    if (!Transport.BleTransport.supported()) {
      banner.hidden = false;
      banner.textContent = 'Web Bluetooth is not available in this browser. Open this page in Chrome or Edge (desktop or Android) to connect to the plotter. Layout, preview and the Simulator work everywhere.';
      $('btnConnect').title = 'Web Bluetooth is not supported in this browser';
    } else if (!window.isSecureContext) {
      banner.hidden = false;
      banner.textContent = 'Web Bluetooth needs a secure context: open this page via https:// (GitHub Pages) or http://localhost.';
    }

    recompute();
    log('info', 'PlotWrite ready. Start the Simulator to test, or connect your plotter over Bluetooth.');
  }

  boot();
})();
