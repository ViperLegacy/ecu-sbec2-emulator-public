// Output observation: injectors (four driver paths), spark frames, $FC/$FD/$FE(0440) decoding, AIS stepper, tach,
// side-channel decoding. Names/meanings carry the brief's confidence tags; nothing here names a connector pin.

// Slot -> cylinder: high after the 2026-11-13 revisit. Three independent derivations agree: the injector fault table
// F613, the SCI 13 actuator-test numbering, and the 1995 wiring (the Ignition Control Module drives injectors 1 and
// 5 = the two side-channel slots 4 and 0). See findings/TIMING_LINK_SYNC_REVISIT.txt.
export const SLOT_TO_CYL = [5, 8, 7, 2, 1, 10, 9, 4, 3, 6];
export const SLOT_PATH = [
  { path: 'side', resource: 'SCI 9-bit frame (T8=1) to the Ignition Control Module' },
  { path: 'oc', resource: 'OC2 / PA6' },
  { path: 'spi', resource: 'SPI smart device FE frame' },
  { path: 'asic', resource: 'ext $040E' },
  { path: 'side', resource: 'SCI 9-bit frame (T8=1) to the Ignition Control Module' },
  { path: 'oc', resource: 'OC3 / PA5' },
  { path: 'asic', resource: 'ext $040C' },
  { path: 'oc', resource: 'OC4 / PA4' },
  { path: 'asic', resource: 'ext $040A' },
  { path: 'asic', resource: 'ext $0408' },
];
const OC_PIN_SLOT = { 6: 1, 5: 5, 4: 7 };

export const FC_BITS = [
  { bit: 7, name: 'fanRelay1', label: 'Low-speed radiator fan relay (0 = ON; on 97 C, off 94 C, on with A/C; high)', activeHigh: false },
  { bit: 6, name: 'mil', label: 'MIL / check-engine lamp (0 = ON, high)', activeHigh: false },
  { bit: 5, name: 'skipShiftLamp', label: 'Skip-shift indicator lamp (0 = ON; lamp vs solenoid split of bits 5/4 INFERRED)', activeHigh: false },
  { bit: 4, name: 'skipShiftSolenoid', label: 'Skip-shift (2-3 lockout) solenoid (0 = ON; 12-18 mph, warm, light load; high)', activeHigh: false },
  { bit: 3, name: 'emr', label: 'EMR / maintenance lamp (1 = ON, JEEP logic, low; no test, no fault bit)', activeHigh: true },
  { bit: 2, name: 'fc2', label: '$FC bit2 (unused: no control law)', activeHigh: true },
  { bit: 1, name: 'fc1', label: '$FC bit1 (unused: no control law)', activeHigh: true },
  { bit: 0, name: 'fc0', label: '$FC bit0 (unused: no control law)', activeHigh: true },
];
export const FD_BITS = [
  { bit: 7, name: 'fd7', label: '$FD bit7 (unused; driven only by actuator test 14)', activeHigh: true },
  { bit: 6, name: 'fd6', label: '$FD bit6 (unused; driven only by actuator test 14)', activeHigh: true },
  { bit: 5, name: 'purge', label: 'EVAP purge (1 = purge allowed; held 0 below 60 C; high)', activeHigh: true },
  { bit: 4, name: 'asd', label: 'ASD relay (0 = ON; ~1 s prime at key-on; high)', activeHigh: false },
  { bit: 3, name: 'diagHighSpeed', label: 'High-speed diag flag (set by SCI 12; receiver not in the image, low)', activeHigh: true },
  { bit: 2, name: 'speedGated', label: 'Reverse-lockout solenoid? (0 below 5 mph; law shown, load INFERRED)', activeHigh: true },
  { bit: 1, name: 'fanRelay2', label: 'High-speed radiator fan relay (0 = ON; on 102 C, off 96 C; high)', activeHigh: false },
  { bit: 0, name: 'acClutch', label: 'A/C clutch relay (0 = engaged; WOT / 113 C / rpm cut-outs; high)', activeHigh: false },
];
export const LATCH_BITS = [
  { bit: 7, name: 'an4AltSelect', label: 'Second thermistor switched onto AN4 (two-point reading -> $88, medium)' },
  { bit: 6, name: 'l6', label: 'unchanged after init' },
  { bit: 5, name: 'airRange', label: 'Air-temp pull-up range (1 = ~10 k cold range, table B800)' },
  { bit: 4, name: 'coolantRange', label: 'Coolant pull-up range (1 = ~10 k cold range, table B800)' },
  { bit: 3, name: 'o2DiagOut', label: 'O2 open-circuit test bias (both banks; codes 20/41, medium)' },
  { bit: 2, name: 'fdSelect', label: '$FD driver select (0 = selected)', activeHigh: false },
  { bit: 1, name: 'tach', label: 'Tach output, toggles per cylinder event (medium-high)' },
  { bit: 0, name: 'spiStrobe', label: 'SPI strobe (AIS / FE frame)' },
];

export function decodeBits(v, table) {
  const o = {};
  for (const d of table) { const b = !!(v & (1 << d.bit)); o[d.name] = d.activeHigh === false ? !b : b; }
  return o;
}

const SIDE_TESTS = { 0x81: 'coil 1', 0x82: 'coil 2', 0x83: 'coil 3', 0x84: 'injector #1', 0x85: 'injector #5', 0x86: 'coil 4', 0x87: 'coil 5' };

// Side-channel writer PCs (SCDR stores with T8=1), from the listing.
const SIDE_PC = {
  0xFC17: 'spark', 0xFC3E: 'pwHi', 0xFC46: 'pwLo',
  0xD740: 'clear', 0xD869: 'actuator', 0xDA70: 'testEnd', 0xA09B: 'testEnd', 0xF08C: 'testEnd', 0xF813: 'testEnd',
};

export class Outputs {
  constructor(m) { this.m = m; this.reset(); }
  reset() {
    this.inj = SLOT_PATH.map((p, slot) => ({ slot, cyl: SLOT_TO_CYL[slot], ...p, count: 0, nonzero: 0,
      lastPwTicks: 0, lastPwMs: 0, lastCycle: -1 }));
    this.ocRise = { 4: -1, 5: -1, 6: -1 };
    this.ocPins = 0;
    this.spark = { raw: null, deg: null, slot: null, cyl: null, count: 0, lastCycle: -1 };
    this.fc = null; this.fd = null; this.latch = 0; this.asdOnAt = -Infinity;
    this.ais = { phaseIndex: -1, pattern: null, steps: 0, bytes: 0, invalid: 0, lastCycle: -1 };
    this.tach = { toggles: 0, lastCycle: -1, periodCycles: 0, avgPeriodCycles: 0 };
    this._tachHist = [];
    this.side = { pending: null, frames: 0 };
    this.smart = { frames: 0, injFrames: 0, lastStatusFrame: null };
  }
  _cylOf(slot) { return slot >= 0 && slot < 10 ? SLOT_TO_CYL[slot] : null; }

  injector(slot, pwTicks, path, resource, cycle, extra) {
    const m = this.m;
    const ms = pwTicks * m.tickUs() / 1000;
    const s = this.inj[slot];
    s.count++; if (pwTicks > 0) s.nonzero++;
    s.lastPwTicks = pwTicks; s.lastPwMs = ms; s.lastCycle = cycle;
    m.log('inj', { slot, cyl: this._cylOf(slot), path, resource, pwTicks, pwMs: +ms.toFixed(3), ...extra }, cycle);
  }

  ocPin(bit, level, cycle) {
    const mask = 1 << bit;
    this.ocPins = level ? (this.ocPins | mask) : (this.ocPins & ~mask);
    const slot = OC_PIN_SLOT[bit];
    if (slot === undefined) return;
    if (level) { this.ocRise[bit] = cycle; return; }
    const r = this.ocRise[bit];
    this.ocRise[bit] = -1;
    if (r < 0) return;
    const ticks = Math.round((cycle - r) / this.m.timer.div);
    this.injector(slot, ticks, 'oc', SLOT_PATH[slot].resource, r);
  }

  /** ASD relay output powered: commanded on ($FD.4 = 0 as last shifted to the driver) for the pull-in time. */
  asdFeed(c) {
    if (this.fd === null || (this.fd & 0x10)) return false;
    return c - this.asdOnAt >= this.m.inputs.asdPullInMs * this.m.eClock / 1000;
  }

  fdByte(v, cycle) {
    if (v !== this.fd) {
      const old = this.fd; this.fd = v;
      if (!(v & 0x10) && (old === null || (old & 0x10))) this.asdOnAt = cycle;
      this.m.log('fd', { value: v, old, bits: decodeBits(v, FD_BITS) }, cycle);
    }
  }

  fcByte(v, cycle) {
    if (v !== this.fc) {
      const old = this.fc; this.fc = v;
      this.m.log('fc', { value: v, old, bits: decodeBits(v, FC_BITS) }, cycle);
      if (old === null || ((old ^ v) & 0x40)) this.m.log('mil', { on: !(v & 0x40) }, cycle);
    }
  }

  latchWrite(v, old, cycle) {
    this.latch = v;
    if ((v ^ old) & 0x02) {
      const t = this.tach;
      if (t.lastCycle >= 0) t.periodCycles = cycle - t.lastCycle;
      t.toggles++; t.lastCycle = cycle;
      // the toggle is written in the TIC1 ISR (F90F) and jitters with interrupt latency: average the last 10 toggles
      const h = this._tachHist; h.push(cycle); if (h.length > 11) h.shift();
      t.avgPeriodCycles = h.length > 1 ? (h[h.length - 1] - h[0]) / (h.length - 1) : 0;
    }
    const ch = (v ^ old) & 0xF8;          // bits 0-2 (strobe/tach/FD select) toggle constantly: not logged
    if (ch) this.m.log('latch', { value: v, old, changed: ch }, cycle);
  }

  aisByte(b, cycle) {
    const a = this.ais;
    const p = b & 0x0F;
    a.bytes++; a.pattern = b; a.lastCycle = cycle;
    const idx = [0x06, 0x05, 0x09, 0x0A].indexOf(p);
    if (idx < 0 || ((b >> 4) & 0x0F) !== (~p & 0x0F)) { a.invalid++; this.m.log('ais', { byte: b, valid: false }, cycle); return; }
    let step = 0;
    if (a.phaseIndex >= 0) {
      const d = (idx - a.phaseIndex) & 3;
      step = d === 1 ? 1 : d === 3 ? -1 : d === 2 ? 2 : 0;
    }
    a.phaseIndex = idx;
    if (step === 1 || step === -1) a.steps += step;
    this.m.log('ais', { byte: b, valid: true, phaseIndex: idx, step, steps: a.steps }, cycle);
  }

  smartFrame(bytes, start, end) {
    const sm = this.smart;
    if (bytes[0] === 0x61) {
      sm.frames++; sm.lastStatusFrame = bytes;
      if (bytes.length >= 4) this.fcByte(bytes[3], start);
      this.m.log('smart', { bytes }, start);
    } else if (bytes[0] === 0xFE && bytes.length >= 3) {
      sm.injFrames++;
      const pw = bytes[1] | (bytes[2] << 8);
      const sumOk = bytes.length >= 4 ? (((bytes[1] + bytes[2] + 0xFE) & 0xFF) === bytes[3]) : false;
      this.injector(2, pw, 'spi', SLOT_PATH[2].resource, start, { frame: bytes, sumOk });
    } else if (bytes[0] === 0x93 || bytes[0] === 0x80) {
      sm.ccdFrames = (sm.ccdFrames || 0) + 1;
      this.m.log('ccd', { bytes, id: bytes[1] }, start);
    } else this.m.log('smart', { bytes, note: 'unrecognised frame' }, start);
  }

  /** Side-channel (T8=1) byte; classified by the PC of the SCDR store. */
  sideByte(b, pc, cycle) {
    const m = this.m;
    const kind = (!m.generic && SIDE_PC[pc]) || (b === 0x00 ? 'testEnd' : (b >= 0x81 && b <= 0x87) ? 'actuator' : b === 0xFF ? 'clear' : 'unknown');
    const slot = m.ram[0x63];
    const ev = { byte: b, kind, pc };
    if (kind === 'spark') {
      const sp = this.spark;
      sp.raw = b; sp.deg = b * 0.5; sp.slot = slot; sp.cyl = this._cylOf(slot); sp.count++; sp.lastCycle = cycle;
      const gi = m.stimulus.lastEdgeIdx;
      m.log('spark', { raw: b, deg: b * 0.5, slot, cyl: this._cylOf(slot), fromMap: !!(m.ram[0x44] & 1), genSlot: gi >= 0 ? gi >> 1 : null }, cycle);
      return;
    }
    if (kind === 'pwHi') { this.side.pending = { hi: b, cycle, slot }; return; }
    if (kind === 'pwLo' && this.side.pending) {
      const p = this.side.pending; this.side.pending = null; this.side.frames++;
      this.injector(p.slot, (p.hi << 8) | b, 'side', SLOT_PATH[p.slot]?.resource || 'side channel', p.cycle, { frame: [p.hi, b] });
      return;
    }
    // module test codes (D82E list): $81-$83 coils 1-3, $84 injector #1, $85 injector #5, $86/$87 coils 4/5
    if (kind === 'actuator') { ev.test = b - 0x80; ev.target = SIDE_TESTS[b] || null; }
    m.log('sideTx', ev, cycle);
  }

  snapshot() {
    const m = this.m;
    const fc = this.fc ?? m.ram[0xFC], fd = this.fd ?? m.ram[0xFD];
    return {
      injectors: this.inj.map((s) => ({ ...s })),
      spark: { ...this.spark },
      fc, fd, latch: this.latch,
      lamps: decodeBits(fc, FC_BITS), relays: decodeBits(fd, FD_BITS), latchBits: decodeBits(this.latch, LATCH_BITS),
      milOn: !(fc & 0x40),
      ocPins: { PA6_OC2: !!(this.ocPins & 0x40), PA5_OC3: !!(this.ocPins & 0x20), PA4_OC4: !!(this.ocPins & 0x10) },
      ais: { ...this.ais, ramPosition: m.ram[0x05], ramTarget: m.ram[0x10A], ramPhase: m.ram[0x0B] },
      tach: { ...this.tach, hz: (this.tach.avgPeriodCycles && m.cpu.cycles - this.tach.lastCycle < 4 * this.tach.avgPeriodCycles + m.eClock / 10)
        ? m.eClock / this.tach.avgPeriodCycles / 2 : 0 },
      smart: { ...this.smart },
    };
  }
}
