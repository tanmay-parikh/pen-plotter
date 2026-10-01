/*
 * Plotter controller: command/ack bookkeeping and job streaming on top of a transport.
 *
 * Flow control is credit based. The firmware owns an 8-entry command queue and
 * answers "ok" after it has FINISHED a command, so the app keeps at most
 * `window` (default 3) commands in flight and can never overflow the Arduino.
 */
(function (g) {
  'use strict';
  const PW = (g.PW = g.PW || {});

  class Plotter {
    constructor(hooks = {}) {
      this.hooks = Object.assign({ log() {}, state() {}, progress() {}, disconnected() {} }, hooks);
      this.t = null;
      this.pending = [];       // FIFO of { resolve, reject, cmd, timer }
      this.window = 3;
      this.timeoutMs = 180000; // longest single move we are willing to wait for
      this.running = false;
      this.paused = false;
      this.aborted = false;
      this.awaitingStop = false;
      this._pump = null;
    }

    get connected() { return !!this.t && this.t.connected; }
    get busy() { return this.running; }

    attach(transport) {
      this.t = transport;
      transport.onLine((l) => this._onLine(l));
      transport.onDisconnect(() => this._onDisconnect());
    }

    // ------------------------------------------------------------ inbound --
    _onLine(line) {
      const low = line.toLowerCase();
      if (this.awaitingStop) {
        this.hooks.log('rx', line);
        if (low === 'stopped') { this.awaitingStop = false; this._stopWaiter && this._stopWaiter(); }
        return; // swallow late acks of commands that were flushed
      }
      if (low === 'ok' || low.startsWith('ok ')) { this.hooks.log('rx', line); this._ack(null); return; }
      if (low.startsWith('err')) { this.hooks.log('err', line); this._ack(new Error(line)); return; }
      this.hooks.log('rx', line);
    }

    _ack(err) {
      const w = this.pending.shift();
      if (!w) return;
      clearTimeout(w.timer);
      err ? w.reject(err) : w.resolve();
    }

    _failAll(err) {
      const list = this.pending.splice(0);
      list.forEach((w) => { clearTimeout(w.timer); w.reject(err); });
    }

    _onDisconnect() {
      this._failAll(new Error('Device disconnected'));
      this.hooks.disconnected();
    }

    // ----------------------------------------------------------- outbound --
    /** Send one command; resolves when the firmware acknowledges completion. */
    exec(cmd, timeoutMs = this.timeoutMs) {
      if (!this.connected) return Promise.reject(new Error('Not connected'));
      return new Promise((resolve, reject) => {
        const w = { resolve, reject, cmd };
        w.timer = setTimeout(() => {
          const i = this.pending.indexOf(w);
          if (i >= 0) this.pending.splice(i, 1);
          reject(new Error(`Timed out waiting for "${cmd}"`));
        }, timeoutMs);
        this.pending.push(w);
        this.hooks.log('tx', cmd);
        this.t.write(cmd + '\n').catch((e) => {
          const i = this.pending.indexOf(w);
          if (i >= 0) this.pending.splice(i, 1);
          clearTimeout(w.timer);
          reject(e);
        });
      });
    }

    /** Stream a job. Resolves { aborted, done } or rejects on the first error. */
    runJob(items) {
      if (this.running) return Promise.reject(new Error('A job is already running'));
      const cmds = items.map((i) => i.c);
      this.running = true; this.paused = false; this.aborted = false;
      this.hooks.state();

      let next = 0, done = 0, inflight = 0, failure = null, finished = false;
      return new Promise((resolve, reject) => {
        const finish = () => {
          if (finished) return;
          finished = true;
          this.running = false; this.paused = false; this._pump = null;
          this.hooks.state();
          failure ? reject(failure) : resolve({ aborted: this.aborted, done });
        };
        const pump = () => {
          if (finished) return;
          if (!failure && !this.aborted) {
            while (!this.paused && next < cmds.length && inflight < this.window) {
              const i = next++;
              inflight++;
              this.exec(cmds[i]).then(
                () => { inflight--; done++; this.hooks.progress(done, cmds.length); pump(); },
                (e) => { inflight--; if (!this.aborted && !failure) failure = e; pump(); },
              );
            }
          }
          if (inflight === 0 && (failure || this.aborted || next >= cmds.length)) finish();
        };
        this._pump = pump;
        pump();
      });
    }

    pause() { if (this.running && !this.paused) { this.paused = true; this.hooks.state(); } }
    resume() { if (this.running && this.paused) { this.paused = false; this.hooks.state(); this._pump && this._pump(); } }

    /** Emergency stop: flush the firmware queue, lift the pen, abort the job. */
    async stop() {
      if (!this.connected) return;
      this.aborted = true;
      this.paused = false;
      this._failAll(new Error('aborted'));
      this.awaitingStop = true;
      const stopped = new Promise((res) => { this._stopWaiter = res; setTimeout(res, 4000); });
      this.hooks.log('tx', 'STOP');
      try { await this.t.write('STOP\n'); await stopped; } finally { this.awaitingStop = false; }
      if (this.running) this._pump && this._pump();
      this.hooks.state();
    }

    async disconnect() {
      if (this.running) await this.stop().catch(() => {});
      if (this.t) await this.t.disconnect();
    }
  }

  PW.Plotter = Plotter;
})(typeof window !== 'undefined' ? window : globalThis);
