/*
 * Transports. Both expose the same interface so the controller does not care
 * whether it talks to real hardware or to the built-in simulator:
 *
 *   connect() / disconnect() / write(text)
 *   onLine(cb)        - cb(line) for every newline-terminated line from the device
 *   onDisconnect(cb)
 *   name, connected
 */
(function (g) {
  'use strict';
  const PW = (g.PW = g.PW || {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const BLE_PRESETS = {
    hm10: {
      label: 'HM-10 / AT-09 / CC41 (FFE0 / FFE1)',
      service: '0000ffe0-0000-1000-8000-00805f9b34fb',
      tx: '0000ffe1-0000-1000-8000-00805f9b34fb',
      rx: '0000ffe1-0000-1000-8000-00805f9b34fb',
    },
    nus: {
      label: 'Nordic UART Service',
      service: '6e400001-b5a3-f393-89c9-8d9c6c63d2d4',
      tx: '6e400002-b5a3-f393-89c9-8d9c6c63d2d4',
      rx: '6e400003-b5a3-f393-89c9-8d9c6c63d2d4',
    },
    custom: { label: 'Custom UUIDs', service: '', tx: '', rx: '' },
  };

  class Emitter {
    constructor() { this._line = []; this._disc = []; }
    onLine(cb) { this._line.push(cb); }
    onDisconnect(cb) { this._disc.push(cb); }
    _emitLine(l) { this._line.forEach((cb) => cb(l)); }
    _emitDisc() { this._disc.forEach((cb) => cb()); }
  }

  // ---------------------------------------------------------------- BLE ----
  class BleTransport extends Emitter {
    constructor(cfg) {
      super();
      this.cfg = cfg; // { service, tx, rx, chunkSize?, writeDelay? }
      this.chunk = cfg.chunkSize || 20;
      this.writeDelay = cfg.writeDelay ?? 12;
      this.device = null; this.txChar = null; this.rxChar = null;
      this.connected = false;
      this._buf = '';
      this._decoder = new TextDecoder();
      this._encoder = new TextEncoder();
      this._chain = Promise.resolve();
      this._onNotify = (e) => this._handleBytes(e.target.value);
      this._onGattDisc = () => { this.connected = false; this._emitDisc(); };
    }

    static supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
    get name() { return this.device?.name || 'BLE device'; }

    async connect() {
      if (!BleTransport.supported()) throw new Error('Web Bluetooth is not available in this browser. Use Chrome or Edge.');
      const { service } = this.cfg;
      this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [service] });
      this.device.addEventListener('gattserverdisconnected', this._onGattDisc);
      await this._open();
    }

    /** Re-open the GATT connection to the previously chosen device (no chooser). */
    async reconnect() {
      if (!this.device) throw new Error('No device selected yet.');
      await this._open();
    }

    async _open() {
      const { service, tx, rx } = this.cfg;
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(service);
      this.txChar = await svc.getCharacteristic(tx);
      this.rxChar = rx === tx ? this.txChar : await svc.getCharacteristic(rx);
      this.rxChar.removeEventListener('characteristicvaluechanged', this._onNotify);
      this.rxChar.addEventListener('characteristicvaluechanged', this._onNotify);
      await this.rxChar.startNotifications();
      this.connected = true;
    }

    async disconnect() {
      try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch (_) { /* ignore */ }
      this.connected = false;
    }

    _handleBytes(view) {
      this._buf += this._decoder.decode(view, { stream: true });
      let i;
      while ((i = this._buf.search(/[\r\n]/)) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (line) this._emitLine(line);
      }
    }

    write(text) {
      const bytes = this._encoder.encode(text);
      const job = this._chain.then(async () => {
        if (!this.connected) throw new Error('Bluetooth is not connected');
        for (let o = 0; o < bytes.length; o += this.chunk) {
          await this._writeChunk(bytes.slice(o, o + this.chunk));
          if (this.writeDelay) await sleep(this.writeDelay);
        }
      });
      this._chain = job.catch(() => {}); // a failed write must not poison later ones
      return job;
    }

    async _writeChunk(part) {
      const ch = this.txChar;
      const send = () => (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse
        ? ch.writeValueWithoutResponse(part) : ch.writeValue(part));
      try { await send(); } catch (e) {
        // "GATT operation already in progress" is transient: retry once.
        await sleep(40); await send();
      }
    }
  }

  // -------------------------------------------------------- Web Serial ----
  /**
   * Classic Bluetooth modules (HC-05 / HC-06 / JDY-31) are not visible to Web
   * Bluetooth. Once paired in the OS they appear as a COM port, which Web Serial
   * can open. The same transport also works over a USB cable.
   */
  class SerialTransport extends Emitter {
    constructor(cfg = {}) {
      super();
      this.baud = cfg.baud || 9600;
      this.port = null; this.writer = null; this.reader = null;
      this.connected = false;
      this._buf = '';
      this._decoder = new TextDecoder();
      this._encoder = new TextEncoder();
    }

    static supported() { return typeof navigator !== 'undefined' && !!navigator.serial; }
    get name() { return 'Serial port'; }

    async connect() {
      if (!SerialTransport.supported()) throw new Error('Web Serial is not available in this browser. Use Chrome or Edge.');
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.baud });
      this.writer = this.port.writable.getWriter();
      this.connected = true;
      this._readLoop();
    }

    async _readLoop() {
      try {
        while (this.port.readable && this.connected) {
          this.reader = this.port.readable.getReader();
          try {
            for (;;) {
              const { value, done } = await this.reader.read();
              if (done) break;
              if (value) this._handleBytes(value);
            }
          } finally { this.reader.releaseLock(); }
        }
      } catch (_) { /* port lost */ }
      if (this.connected) { this.connected = false; this._emitDisc(); }
    }

    _handleBytes(bytes) {
      this._buf += this._decoder.decode(bytes, { stream: true });
      let i;
      while ((i = this._buf.search(/[\r\n]/)) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (line) this._emitLine(line);
      }
    }

    async write(text) {
      if (!this.connected) throw new Error('Serial port is not connected');
      await this.writer.write(this._encoder.encode(text));
    }

    async disconnect() {
      this.connected = false;
      try { await this.reader?.cancel(); } catch (_) { /* ignore */ }
      try { this.writer?.releaseLock(); } catch (_) { /* ignore */ }
      try { await this.port?.close(); } catch (_) { /* ignore */ }
      this._emitDisc();
    }
  }

  // ---------------------------------------------------------- Simulator ----
  /**
   * A software model of the Arduino firmware: same protocol, same queue/ack
   * behaviour, durations derived from the configured speeds. `timeScale` lets
   * a whole page "plot" in seconds.
   */
  class SimTransport extends Emitter {
    constructor(opts = {}) {
      super();
      this.name = 'Simulator';
      this.connected = false;
      this.timeScale = opts.timeScale || 10;
      this.state = { x: 0, y: 0, pen: false };
      this.cfg = { SPD: 6, TSPD: 8 };
      this._in = '';
      this._queue = [];
      this._busy = false;
      this._timer = null;
    }

    async connect() { this.connected = true; setTimeout(() => this._emitLine('ready'), 40); }
    async disconnect() { this._abort(); this.connected = false; this._emitDisc(); }

    async write(text) {
      if (!this.connected) throw new Error('Simulator is not connected');
      this._in += text;
      let i;
      while ((i = this._in.indexOf('\n')) >= 0) {
        const line = this._in.slice(0, i).trim();
        this._in = this._in.slice(i + 1);
        if (line) this._receive(line);
      }
    }

    _reply(l) { setTimeout(() => this.connected && this._emitLine(l), 5); }

    _receive(line) {
      if (line === 'STOP') { this._abort(); this.state.pen = false; this._reply('stopped'); return; }
      if (this._queue.length >= 8) { this._reply('err full'); return; }
      this._queue.push(line);
      this._pump();
    }

    _abort() { clearTimeout(this._timer); this._timer = null; this._queue = []; this._busy = false; }

    _pump() {
      if (this._busy || !this._queue.length) return;
      this._busy = true;
      const line = this._queue.shift();
      const { seconds, apply } = this._plan(line);
      const ms = Math.max(4, (seconds * 1000) / this.timeScale);
      this._timer = setTimeout(() => {
        const res = apply();
        this._busy = false;
        this._reply(res || 'ok');
        this._pump();
      }, ms);
    }

    _num(line, axis) {
      const m = new RegExp(axis + '(-?[0-9.]+)').exec(line);
      return m ? parseFloat(m[1]) : null;
    }

    _plan(line) {
      const s = this.state;
      const cmd = line.split(/\s+/)[0];
      const move = (nx, ny, speed, pen) => {
        const d = Math.hypot(nx - s.x, ny - s.y);
        return { seconds: d / speed, apply: () => { s.x = nx; s.y = ny; if (pen !== undefined) s.pen = pen; } };
      };
      switch (cmd) {
        case 'PEN_UP': return { seconds: 0.25, apply: () => { s.pen = false; } };
        case 'PEN_DOWN': return { seconds: 0.3, apply: () => { s.pen = true; } };
        case 'HOME': return { ...move(0, 0, this.cfg.TSPD), apply: () => { s.pen = false; s.x = 0; s.y = 0; } };
        case 'ZERO': return { seconds: 0, apply: () => { s.x = 0; s.y = 0; } };
        case 'PING': return { seconds: 0, apply: () => 'ok' };
        case '?': return { seconds: 0, apply: () => { this._emitLine(`pos ${s.x.toFixed(2)} ${s.y.toFixed(2)} ${s.pen ? 1 : 0}`); } };
        case 'G': {
          const x = this._num(line, 'X'), y = this._num(line, 'Y');
          return move(x ?? s.x, y ?? s.y, s.pen ? this.cfg.SPD : this.cfg.TSPD);
        }
        case 'JOG': {
          const dx = this._num(line, 'X') ?? 0, dy = this._num(line, 'Y') ?? 0;
          const p = move(s.x + dx, s.y + dy, this.cfg.TSPD);
          return { seconds: p.seconds, apply: () => { s.pen = false; p.apply(); } };
        }
        case 'CFG': {
          const [, key, val] = line.split(/\s+/);
          return { seconds: 0, apply: () => { if (key in this.cfg) this.cfg[key] = parseFloat(val) || this.cfg[key]; } };
        }
        default: return { seconds: 0, apply: () => 'err unknown' };
      }
    }
  }

  PW.Transport = { BleTransport, SerialTransport, SimTransport, BLE_PRESETS, sleep };
})(typeof window !== 'undefined' ? window : globalThis);
