// 68HC11 emulator GUI (SBEC2 board model; bundled image: 1995 Viper PCM 04763555): machine lifecycle, time-sliced run loop on the main thread, toolbar, persistence.
// The machine (../machine/viper_machine.js) runs in ~10 ms setTimeout chunks with a host-time budget so the
// page stays responsive at every speed; the scope is drawn on requestAnimationFrame. No connector pin is named anywhere: signals are MCU resources.

import { ViperMachine, normaliseImage, classifyImage } from '../machine/viper_machine.js';
import { DATA, IMAGE_SHA256, loadEeprom, loadImage } from '../rom/viper_rom.js';
import { h, $, setText, download, pickFile, store } from './dom.js';
import { Probe } from './probe.js';
import { GUI_SCENARIOS, Sequencer } from './gui_scenarios.js';
import { fmtMs, hexBytes } from './format.js';
import { createInputsPanel } from './panel_inputs.js';
import { createOutputsPanel } from './panel_outputs.js';
import { createSciPanel } from './panel_sci.js';
import { createWatchPanel } from './panel_watch.js';
import { createMapsPanel } from './panel_maps.js';
import { createLogPanel } from './panel_log.js';
import { createTuningPanel } from './panel_tuning.js';
import { Calibration } from './calibration.js';
import { createWorkspaces } from './workspaces.js';

const LS_EEPROM = 'viper04763555.eeprom';
const LS_KEEPALIVE = 'viper04763555.keepalive';
const LS_UI = 'viper04763555.ui';
// A flash dump loaded by the user replaces the bundled image until "Bundled image" is chosen. It lives in the
// browser only (never uploaded). Its EEPROM copy is kept apart from the bundled image's.
const LS_IMAGE = 'hc11emu.image';
const LS_IMAGE_NAME = 'hc11emu.image.name';
const LS_IMAGE_EEPROM = 'hc11emu.image.eeprom';
const SPEEDS = [['0.1', 0.1], ['1 (real time)', 1], ['10', 10], ['max', Infinity]];

class App {
  constructor(root) {
    this.root = root;
    this.DATA = DATA;
    let image = loadImage();
    this.imageName = '04763555 (bundled)';
    this.customImage = false;
    const stored = store.getBytes(LS_IMAGE);
    if (stored && stored.length) {
      try { image = normaliseImage(stored); this.imageName = store.get(LS_IMAGE_NAME) || 'custom image'; this.customImage = true; }
      catch { store.del(LS_IMAGE); store.del(LS_IMAGE_NAME); }
    }
    this.imageInfo = classifyImage(image);
    this.generic = this.imageInfo.profile === 'generic';
    this.lsEeprom = this.customImage ? LS_IMAGE_EEPROM : LS_EEPROM;
    this.calibration = new Calibration(DATA, image);
    this.speed = 1;
    this.paused = false;
    this.opts = { eClock: 2_000_000, cop: false };
    this.panels = [];
    this.seq = new Sequencer();
    this.keyCycle = null;
    this.lastSlow = 0;
    this.lastFrame = 0;
    this.perfWin = { host: 0, emu: 0, t0: 0, ratio: 0, load: 0 };
    this.errors = [];
    const ui = this._loadUi();
    if (ui.speed !== undefined) this.speed = ui.speed === 'max' ? Infinity : ui.speed;
    const ee = store.getBytes(this.lsEeprom);
    this.eepromSource = ee && ee.length === 512 ? 'browser storage' : 'dump file';
    this.m = this._newMachine({ eeprom: ee && ee.length === 512 ? ee : undefined });
    this._buildUi();
    // Emulation + slow panel updates run on a ~10 ms timer (keeps real time even where rAF is throttled);
    // the scope and injector flashes are drawn on requestAnimationFrame.
    this._tick();
    requestAnimationFrame((t) => this._draw(t));
  }

  _loadUi() { try { return JSON.parse(store.get(LS_UI) || '{}'); } catch { return {}; } }
  _saveUi(patch) { const u = { ...this._loadUi(), ...patch }; store.set(LS_UI, JSON.stringify(u)); }

  _newMachine(extra = {}) {
    const m = new ViperMachine({ eClock: this.opts.eClock, cop: this.opts.cop, image: this.calibration.image, imageName: this.imageName, logSize: 20000, ...extra });
    this.probe = new Probe(m);
    m.onEepromWrite(() => { if (store.setBytes(this.lsEeprom, m.getEeprom())) this.eepromSource = 'browser storage (auto-saved)'; });
    m.on('fault', (e) => this.flash(`machine fault: ${e.kind}`, 'bad'));
    return m;
  }

  /** Rebuild the machine (E clock change): keeps EEPROM, keep-alive RAM, inputs and stimulus settings. */
  rebuild() {
    const old = this.m;
    const ins = old.inputs.snapshot(); delete ins.adcCounts;
    const st = old.stimulus.snapshot();
    this.probe.detach();
    const m = this._newMachine({ eeprom: old.getEeprom(), keepAlive: old.getKeepAlive(), idleSkip: old.idleSkip });
    if (old.copEnabled) m.setCopEnabled(true);
    // a pending key cycle is timed in emulated ms, which restart at 0 on the new machine: rebase it
    if (this.keyCycle) this.keyCycle = { onAt: m.ms + Math.max(0, this.keyCycle.onAt - old.ms) };
    for (const [k, v] of Object.entries(ins)) m.inputs[k] = Array.isArray(v) ? v.slice() : v;
    m.stimulus.crankHighDeg = old.stimulus.crankHighDeg; m.stimulus.camLowDeg = old.stimulus.camLowDeg;
    m.stimulus.vssPulsesPerMile = old.stimulus.vssPulsesPerMile;
    m.stimulus.setEdgeAngles(st.edgeAngles); m.stimulus.setCamPattern(st.camPattern);
    if (st.rpmTarget) m.stimulus.setRpm(st.rpmTarget);
    if (st.mph) m.stimulus.setSpeedMph(st.mph);
    this.m = m;
    this.seq.cancel();
    for (const p of this.panels) p.attach && p.attach(m);
    this.flash(`machine rebuilt: E clock ${(this.opts.eClock / 1e6).toFixed(3)} MHz`);
  }

  // ---------------------------------------------------------------------------------------------------
  _guard(fn) {
    try { fn(); } catch (err) {
      this.paused = true;
      this.errors.push(err);
      console.error(err);
      this.flash('GUI error, paused: ' + err.message, 'bad');
      this._syncRunButtons();
    }
  }
  _tick() {
    const t = performance.now();
    const dt = this.lastFrame ? Math.min(1000, t - this.lastFrame) : 10;   // a throttled timer catches up (budget-limited)
    this.lastFrame = t;
    this._guard(() => {
      if (!this.paused) this._runFor(dt);
      this.seq.poll(this.m);
      this._pollKeyCycle();
      if (t - this.lastSlow > 200) {
        this.lastSlow = t;
        this._status(t);
        for (const p of this.panels) p.slow && p.slow(t);
      }
    });
    setTimeout(() => this._tick(), 10);
  }
  _draw(t) {
    this._guard(() => { for (const p of this.panels) p.frame && p.frame(t); });
    requestAnimationFrame((tt) => this._draw(tt));
  }

  _runFor(dtMs) {
    const m = this.m;
    const budget = this.speed === Infinity ? Math.max(9, Math.min(50, dtMs * 0.7)) : 30;   // host ms per tick we may spend emulating (tick every ~10 ms)
    const t0 = performance.now();
    let emuWanted = this.speed === Infinity ? Infinity : dtMs * this.speed;
    let emuDone = 0;
    while (emuDone < emuWanted) {
      const chunk = Math.min(5, emuWanted - emuDone);
      m.run(chunk);
      emuDone += chunk;
      this.seq.poll(m);
      if (performance.now() - t0 > budget) break;
    }
    const host = performance.now() - t0;
    const w = this.perfWin;
    w.host += dtMs; w.emu += emuDone; w.busy = (w.busy || 0) + host;
    if (w.host > 1000) { w.ratio = w.emu / w.host; w.load = w.busy / w.host; w.host = 0; w.emu = 0; w.busy = 0; }
  }

  step(kind) {
    const m = this.m;
    if (kind === 'insn') m.runCycles(1);
    else if (kind === 'ms') m.run(1);
    else if (kind === 'pass') { const p = m.passes; m.runUntil((mm) => mm.passes > p, { timeoutMs: 50, stepMs: 0.05 }); }
    for (const p of this.panels) { p.frame && p.frame(performance.now()); p.slow && p.slow(performance.now()); }
    this._status(performance.now());
  }

  setSpeed(s) { this.speed = s; this._saveUi({ speed: s === Infinity ? 'max' : s }); this._syncRunButtons(); }
  togglePause(force) { this.paused = force === undefined ? !this.paused : force; this._syncRunButtons(); }

  /** Key cycle: key OFF, wait for the firmware power-down (F024, ~5.5 s), key ON again. */
  startKeyCycle(offMs = 6000) {
    this.m.stimulus.setRpm(0);
    this.m.inputs.key = false;
    this.keyCycle = { onAt: this.m.ms + offMs };
    this.flash(`key OFF - firmware power-down; key ON again in ${offMs / 1000} s emulated`);
  }
  _pollKeyCycle() {
    if (this.keyCycle && this.m.ms >= this.keyCycle.onAt) { this.m.inputs.key = true; this.keyCycle = null; this.flash('key ON (end of key cycle)'); }
  }

  runScenario(id) {
    const sc = GUI_SCENARIOS.find((s) => s.id === id);
    if (!sc) return;
    this.seq.start(this.m, sc);
    this.flash(`scenario: ${sc.label} - ${sc.note}`);
    for (const p of this.panels) p.inputsChanged && p.inputsChanged();
  }

  flash(msg, cls = '') {
    const el = this.toast;
    if (!el) return;
    el.textContent = msg; el.className = 'toast show ' + cls;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { el.className = 'toast'; }, cls === 'bad' ? 6000 : 3500);
  }

  // ---------------------------------------------------------------------------------------------------
  _buildUi() {
    const speedBtns = SPEEDS.map(([label, v]) => h('button.spd', { 'data-speed': String(v), title: `x${label}`, on: { click: () => this.setSpeed(v) } }, 'x' + label.split(' ')[0]));
    this.btnPause = h('button', { on: { click: () => this.togglePause() } }, 'Pause');
    const scenSel = h('select', { title: 'Scenario: sets the inputs and stimulus (GUESS operating points)' },
      h('option', { value: '' }, 'Scenario...'), GUI_SCENARIOS.map((s) => h('option', { value: s.id }, s.label)));
    scenSel.addEventListener('change', () => { if (scenSel.value) this.runScenario(scenSel.value); scenSel.value = ''; });
    this.statusEl = h('span.status');
    this.toast = h('div.toast');

    const persist = h('div.menu',
      h('button', { title: 'Run another 68HC11 flash dump: 32768 bytes (CPU 8000-FFFF) or 65536 (0000-FFFF). Stays in this browser; the page reloads.', on: { click: () => this.loadImageFile() } }, 'Flash dump ↑ file'),
      h('button', { title: 'Go back to the bundled 04763555 image', disabled: !this.customImage, on: { click: () => this.useBundledImage() } }, 'Bundled image'),
      h('button', { title: 'Save the image the CPU is executing (tuning edits included)', on: { click: () => download(this.customImage ? 'flash_8000-FFFF.bin' : 'VIPER_04763555_8000-FFFF.bin', this.m.rom) } }, 'Flash ↓ file'),
      h('span.sep'),
      h('button', { on: { click: () => this.saveEepromFile() } }, 'EEPROM ↓ file'),
      h('button', { on: { click: () => this.loadEepromFile() } }, 'EEPROM ↑ file'),
      h('button', { on: { click: () => { store.setBytes(this.lsEeprom, this.m.getEeprom()); this.eepromSource = 'browser storage'; this.flash('EEPROM stored in browser'); } } }, 'EEPROM → browser'),
      h('button', { title: 'Reload the EEPROM from the dump (B600-B7FF) and forget the browser copy', on: { click: () => { store.del(this.lsEeprom); this.m.loadEeprom(this.customImage ? this.calibration.image.slice(0x3600, 0x3800) : loadEeprom()); this.eepromSource = 'dump file'; this.flash('EEPROM = dump file'); } } }, 'EEPROM = dump'),
      h('span.sep'),
      h('button', { on: { click: () => this.saveKeepAliveFile() } }, 'Keep-alive ↓ file'),
      h('button', { on: { click: () => this.loadKeepAliveFile() } }, 'Keep-alive ↑ file'),
      h('button', { title: 'Store RAM 0000-0043 (stored codes, adaptives, TPS min, AIS position) in the browser', on: { click: () => { store.setBytes(LS_KEEPALIVE, this.m.getKeepAlive()); this.flash('keep-alive RAM stored in browser'); } } }, 'Keep-alive → browser'),
      h('button', { title: 'Load RAM 0000-0043 from the browser and power-cycle (battery connected)', on: { click: () => {
        const b = store.getBytes(LS_KEEPALIVE);
        if (!b || b.length !== 0x44) return this.flash('no keep-alive copy in the browser', 'bad');
        this.m.setKeepAlive(b); this.m.powerCycle({ batteryConnected: true }); this.flash('keep-alive restored, power cycled');
      } } }, 'Keep-alive ← browser'));

    const bar = h('header.toolbar',
      h('div.brand', h('b', '68HC11 Emulator'), h('span.sub', { title: this.imageName }, ` SBEC2 · ${this.generic ? this.imageName : '04763555' + (this.imageInfo.stock ? '' : ' (' + this.imageName + ')')}`)),
      scenSel,
      h('div.grp', h('span.lbl', 'speed'), speedBtns, this.btnPause,
        h('button', { title: 'Execute one instruction (pauses)', on: { click: () => { this.togglePause(true); this.step('insn'); } } }, 'Step'),
        h('button', { title: 'Run 1 ms (pauses)', on: { click: () => { this.togglePause(true); this.step('ms'); } } }, '+1 ms'),
        h('button', { title: 'Run one main-loop pass, ~11 ms (pauses)', on: { click: () => { this.togglePause(true); this.step('pass'); } } }, '+pass')),
      h('div.grp',
        h('button', { title: 'Hardware reset through FFFE (RAM untouched)', on: { click: () => { this.m.reset(); this.flash('reset (vector FFFE -> 944E)'); } } }, 'Reset'),
        h('button', { title: 'Power loss: keeps 0000-0043 when "battery connected" is on, else random RAM = cold init', on: { click: () => { this.m.powerCycle(); this.flash(`power cycle (battery ${this.m.inputs.batteryConnected ? 'connected: keep-alive kept' : 'disconnected: cold init'})`); } } }, 'Power cycle'),
        h('button', { title: 'Key OFF ($0400.6 = 1), wait 6 s, key ON', on: { click: () => this.startKeyCycle() } }, 'Key cycle')),
      h('details.persist', h('summary', 'Save / load'), persist));
    scenSel.setAttribute('aria-label', 'Scenario');
    this.telemetry = {};
    const telemetry = h('section.telemetry', { 'aria-label': 'Engine telemetry' },
      [['rpm', 'Engine speed'], ['pw', 'Injector PW even / odd'], ['spark', 'Spark advance · inferred'], ['sync', 'Crank sync']].map(([key, label]) =>
        h('div.telemetry-reading', h('span.hint', label), (this.telemetry[key] = h('strong.mono', '—')))));
    const outputs = createOutputsPanel(this);
    this.panels = [outputs];
    const entries = [['scope', 'Scope', outputs.scope]];
    // A foreign image runs as plain 68HC11 code: the tuning tables are 04763555 addresses and must not be written
    const notice = this.generic ? h('div.image-notice', { role: 'status' },
      h('b', `Custom image: ${this.imageName}. `),
      'It runs as 68HC11 code on the SBEC2 board model (CPU, timer, SCI, SPI, ADC, EEPROM, I/O at 0400). ',
      'RAM names, engine readouts, maps, fault names, SCI decoding, scenarios and the pass counter are those of the 04763555 firmware and do not apply to it. ',
      'The CPU & log, SCI console (raw bytes) and raw RAM views do.') : null;
    for (const [id, label, makePanel] of [
      ['inputs', 'Inputs', createInputsPanel],
      ['outputs', 'Outputs', () => outputs],
      ['sci', 'SCI', createSciPanel],
      ['ram', 'RAM', createWatchPanel],
      ['maps', 'Maps', createMapsPanel],
      ['tuning', 'Tuning', createTuningPanel],
      ['log', 'CPU & log', createLogPanel],
    ]) {
      if (id === 'tuning' && this.generic) continue;
      const panel = makePanel(this);
      if (panel !== outputs) this.panels.push(panel);
      entries.push([id, label, panel.el]);
    }
    this.workspaces = createWorkspaces('Emulator workspaces', entries, {
      sidebar: true,
      initial: this._loadUi().workspace,
      onSelect: id => {
        this._saveUi({ workspace: id });
        this.refreshStatus();
      },
    });
    const note = h('span.build-info', { title: `Stock image SHA-256 ${IMAGE_SHA256}. Connector pinout unknown. Default E clock 2 MHz (assumed).` },
      this.generic ? `${this.imageName} · 68HC11 Emulator` : '04763555 · 68HC11 Emulator');
    note.title = `Image: ${this.imageName}${this.imageInfo.stock ? '' : this.generic ? ' (other firmware)' : ' (04763555 code, different calibration or EEPROM)'}. Bundled image SHA-256 ${IMAGE_SHA256}. E clock 2 MHz.`;
    this.root.append(bar, ...(notice ? [notice] : []), telemetry, this.workspaces.el, h('footer.workspace-status', note, this.statusEl), this.toast);
    for (const p of this.panels) p.attach && p.attach(this.m);
    this.refreshStatus();
    this._syncRunButtons();
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|select|textarea|button|summary/i.test(e.target.tagName)) return;
      if (e.key === ' ') { e.preventDefault(); this.togglePause(); }
    });
  }

  refreshStatus() {
    this._status();
    for (const panel of this.panels) panel.slow?.(performance.now());
  }

  _syncRunButtons() {
    for (const b of this.root.querySelectorAll('button.spd')) b.classList.toggle('on', Number(b.dataset.speed) === this.speed || (b.dataset.speed === 'Infinity' && this.speed === Infinity));
    if (this.btnPause) { this.btnPause.textContent = this.paused ? 'Run' : 'Pause'; this.btnPause.classList.toggle('on', this.paused); }
  }

  _status() {
    const m = this.m, w = this.perfWin;
    const engine = m.engine();
    const pulseWidth = ticks => (ticks * m.tickUs() / 1000).toFixed(2);
    if (this.generic) {       // these RAM addresses mean something only in the 04763555 firmware
      for (const k of ['rpm', 'pw', 'spark']) setText(this.telemetry[k], 'n/a');
      setText(this.telemetry.sync, 'PC $' + m.cpu.pc.toString(16).toUpperCase().padStart(4, '0'));
    } else {
      setText(this.telemetry.rpm, `${Math.round(engine.rpm).toLocaleString('en-US')} rpm`);
      setText(this.telemetry.pw, `${pulseWidth(engine.pwEven)} / ${pulseWidth(engine.pwOdd)} ms`);
      setText(this.telemetry.spark, `${(engine.spark75 / 2).toFixed(1)}° BTDC`);
      setText(this.telemetry.sync, engine.synced ? 'Synced' : 'Waiting');
      this.telemetry.sync.classList.toggle('ok', engine.synced);
    }
    const sp = this.paused ? 'paused' : (this.speed === Infinity ? 'max' : 'x' + this.speed);
    const seq = this.seq.status();
    const kc = this.keyCycle ? ` key-cycle (ON in ${((this.keyCycle.onAt - m.ms) / 1000).toFixed(1)} s)` : '';
    setText(this.statusEl, `t=${fmtMs(m.ms)}  pass ${m.passes}  ${sp}  achieved x${w.ratio.toFixed(w.ratio < 1 ? 2 : 1)}  host load ${(w.load * 100).toFixed(0)}%${m.faults.length ? `  FAULTS ${m.faults.length}` : ''}${seq ? '  | ' + seq : ''}${kc}`);
  }

  // ---------------------------------------------------------------------------------------------------
  saveEepromFile() { download(this.customImage ? 'eeprom_B600-B7FF.bin' : 'VIPER_04763555_eeprom_B600-B7FF.bin', this.m.getEeprom()); }
  /** Load another flash dump. Stored in the browser, then the page reloads so every panel starts from it. */
  async loadImageFile() {
    try {
      const raw = await pickFile('.bin,.rom,.BIN');
      const image = normaliseImage(raw);
      const info = classifyImage(image);
      if (!store.setBytes(LS_IMAGE, image)) return this.flash('cannot store the image in this browser (storage blocked or full)', 'bad');
      store.set(LS_IMAGE_NAME, String(raw.fileName || 'custom image').slice(0, 80));
      store.del(LS_IMAGE_EEPROM);
      this.flash(info.stock ? 'that is the bundled image' : info.sameCode ? '04763555 code with a different calibration: reloading' : 'other firmware: reloading as plain 68HC11 code');
      setTimeout(() => window.location.reload(), 600);
    } catch (e) { if (e.message !== 'no file') this.flash(e.message, 'bad'); }
  }
  useBundledImage() { store.del(LS_IMAGE); store.del(LS_IMAGE_NAME); store.del(LS_IMAGE_EEPROM); window.location.reload(); }
  async loadEepromFile() {
    try {
      const b = await pickFile('.bin');
      if (b.length !== 512) return this.flash(`EEPROM file must be 512 bytes (got ${b.length})`, 'bad');
      this.m.loadEeprom(b); store.setBytes(this.lsEeprom, b); this.eepromSource = 'file (also stored in browser)';
      this.flash('EEPROM loaded (takes effect immediately; reset to re-read it at init)');
    } catch (e) { if (e.message !== 'no file') this.flash(e.message, 'bad'); }
  }
  saveKeepAliveFile() { download('viper_keepalive_0000-0043.bin', this.m.getKeepAlive()); }
  async loadKeepAliveFile() {
    try {
      const b = await pickFile('.bin');
      if (b.length !== 0x44) return this.flash(`keep-alive file must be 68 bytes (got ${b.length})`, 'bad');
      this.m.setKeepAlive(b); this.m.powerCycle({ batteryConnected: true });
      this.flash(`keep-alive loaded (${hexBytes(b.slice(0, 4))}...), power cycled with battery connected`);
    } catch (e) { if (e.message !== 'no file') this.flash(e.message, 'bad'); }
  }
}

export function start(root) {
  const app = new App(root);
  window.hc11App = app;                       // debugging handle: hc11App.m is the machine
  window.viperApp = app;                      // debugging handle: viperApp.m is the machine
  return app;
}

if (typeof document !== 'undefined') {
  const root = $('#app');
  if (root) start(root);
}
