// ViperMachine: the 1995 Dodge Viper SBEC2 PCM (68HC11, part 04763555) around the cpu.js core.
// Memory map (brief sec. 3), peripherals (sec. 2/6), stimulus (sec. 5), inputs (sec. 4), outputs (sec. 8).
// Pure ES module, no Node APIs: runs in Node (tests) and in a browser served over http.
//
// Quick use:
//   import { ViperMachine } from './machine/viper_machine.js';
//   const m = new ViperMachine();            // loads the bundled image + EEPROM (rom/viper_rom.js)
//   m.run(3000);                              // 3 s of emulated time
//   m.sciRequest([0x16, 0x80]);               // -> [0x16,0x80,0x04,0x76,0x35,0x55,0x9A]
//   m.stimulus.setRpm(250); m.run(2000); m.stimulus.setRpm(800, { rampMs: 1000 }); m.run(3000);
//
// No PCM connector pin is known: every input/output is named by MCU resource. See INPUT_INFO / outputs.js tables.

import { HC11, VEC, MASKABLE_PRIORITY, PSEL_VECTOR } from '../hc11/cpu.js';
import { loadImage, loadEeprom, DATA } from '../rom/viper_rom.js';
import { Timer } from './timer.js';
import { ADC } from './adc.js';
import { SCI } from './sci.js';
import { SPI } from './spi.js';
import { Asic } from './asic.js';
import { Eeprom } from './eeprom.js';
import { Inputs } from './inputs.js';
import { Outputs, SLOT_TO_CYL } from './outputs.js';
import { Stimulus } from './stimulus.js';

const IDLE_PC = 0x9E0E;          // main-loop 11 ms wait: ldd TCNT / subd $0142 / cpd #$0ABE / bcs (19 E cycles)
const IDLE_ITER = 19;
const IDLE_END = 0x9E1A;          // first address after the loop's bcs (9E18)
const SPURIOUS_HANDLER = 0xFD04;

class EventLog {
  constructor(size) { this.size = size; this.buf = new Array(size); this.n = 0; }
  push(e) { this.buf[this.n % this.size] = e; this.n++; }
  /** Entries with seq >= since (default: everything still in the ring), oldest first. */
  since(since = 0) {
    const out = [];
    const first = Math.max(since, this.n - this.size, 0);
    for (let s = first; s < this.n; s++) out.push(this.buf[s % this.size]);
    return out;
  }
  clear() { this.n = 0; this.buf = new Array(this.size); }
}

/**
 * Compare a 32 K image (CPU 8000-FFFF) with the bundled 04763555 image.
 *   stock:    byte-identical
 *   sameCode: identical outside the calibration block 8000-93FF and the EEPROM overlay B600-B7FF (the same
 *             firmware with another calibration, e.g. after tuning edits)
 * Everything keyed to 04763555 addresses (idle skip, pass counter, RAM names, maps, fault names, SCI decode) only
 * applies when sameCode is true; any other image runs as plain 68HC11 code on the same board model.
 */
export function classifyImage(image) {
  const ref = loadImage();
  let stock = image.length === ref.length, sameCode = stock;
  if (stock) {
    for (let i = 0; i < ref.length; i++) {
      if (image[i] === ref[i]) continue;
      stock = false;
      const a = 0x8000 + i;
      if (a >= 0x9400 && !(a >= 0xB600 && a < 0xB800)) { sameCode = false; break; }
    }
  }
  return { stock, sameCode, profile: sameCode ? '04763555' : 'generic' };
}

/** Normalise a dump to the 32 K the CPU sees at 8000-FFFF. Accepts 32768 bytes, or 65536 (a full 0000-FFFF map:
 *  the upper half is used). Throws on anything else or on a reset vector that does not point into the image. */
export function normaliseImage(bytes) {
  let b = Uint8Array.from(bytes);
  if (b.length === 0x10000) b = b.slice(0x8000);
  if (b.length !== 0x8000) throw new Error(`flash dump must be 32768 bytes (CPU 8000-FFFF) or 65536 (0000-FFFF); got ${b.length}`);
  const rv = (b[0x7FFE] << 8) | b[0x7FFF];
  if (rv < 0x8000 || rv === 0xFFFF) throw new Error(`reset vector $${rv.toString(16).toUpperCase().padStart(4, '0')} does not point into 8000-FFFF: not a 68HC11 image for this memory map`);
  return b;
}

export class ViperMachine {
  constructor(opts = {}) {
    this.eClock = opts.eClock ?? 2_000_000;
    this.copEnabled = !!opts.cop;
    this.idleSkip = opts.idleSkip !== false;
    this.data = opts.data ?? DATA;
    this.rom = opts.image ? Uint8Array.from(opts.image) : loadImage();
    if (this.rom.length !== 0x8000) throw new Error('image must be 32768 bytes (CPU 8000-FFFF)');
    this.imageInfo = { ...classifyImage(this.rom), name: opts.imageName ?? (opts.image ? 'custom image' : '04763555 (bundled)') };
    this.generic = this.imageInfo.profile === 'generic';
    if (this.generic) this.idleSkip = false;       // the idle skip is keyed to the 04763555 wait loop at 9E0E
    this.mem = new Uint8Array(0x10000);
    this.ram = this.mem;                       // ram[a] for a < 0x200 is internal RAM
    this.mem.set(this.rom, 0x8000);
    this.log_ = new EventLog(opts.logSize ?? 8192);
    this.listeners = new Map();
    this.logMute = new Set(opts.logMute ?? []);
    this.faults = [];
    this.diag = [];                            // every diagnostic (T8=0) byte the PCM sent, in order
    this.romWrites = 0;
    this.inputs = new Inputs(this);
    this.timer = new Timer(this);
    this.adc = new ADC(this);
    this.sci = new SCI(this);
    this.spi = new SPI(this);
    this.asic = new Asic(this);
    // EEPROM default: the bundled dump, or for a supplied image whatever its own B600-B7FF holds (a full-map dump
    // carries that car's EEPROM there; for the bundled image the two are identical)
    this.eeprom = new Eeprom(this, opts.eeprom ? Uint8Array.from(opts.eeprom) : (opts.image ? this.rom.slice(0x3600, 0x3800) : loadEeprom()));
    this.outputs = new Outputs(this);
    this.cop = { next: Infinity, armed: false, last: 0, maxGap: 0, service: (at) => this._copTimeout(at) };
    this.stimulus = new Stimulus(this);
    this.sources = [this.timer, this.sci, this.stimulus, this.cop];
    this.nextEvent = Infinity;
    this.irqPin = true; this.irqLatch = false;
    this.portd = 0; this.ddrd = 0;
    this.regs = new Uint8Array(0x40);
    this._spur = { count: 0, windowStart: 0, reported: new Set() };
    this._dtcSnap = '';
    this.passes = 0;
    this.breakpoints = new Map();              // pc -> fn(machine); return 'stop' to end the current run early
    this.perf = { hostMs: 0, emuCycles: 0 };
    this._syncEepromToMem();
    const self = this;
    this.cpu = new HC11({
      read8: (a, c) => ((a < 0x200 || a >= 0x8000) ? self.mem[a] : self._readSlow(a, c)),
      write8: (a, v, c) => self._write(a, v, c),
      getPendingVector: () => self._pending(),
      xirqAsserted: () => false,
      onInterrupt: (v) => self._onInterrupt(v),
      onIllegal: (addr, bytes) => self.fault('illegal-opcode', { addr, bytes }),
    });
    // Power-on RAM: the saved keep-alive bytes, or an SRAM-like pseudo-random pattern (battery never connected).
    // NOTE: an all-zero RAM is accepted by the firmware as a VALID keep-alive block (sum 0 == marker 0000).
    this._fillRam(opts.ramFill ?? 'random');
    if (opts.keepAlive) this.mem.set(opts.keepAlive.subarray ? opts.keepAlive.subarray(0, 0x44) : opts.keepAlive.slice(0, 0x44), 0);
    this.reset();
  }

  // ======================================================================================================
  // time
  get cycles() { return this.cpu.cycles; }
  get ms() { return this.cpu.cycles * 1000 / this.eClock; }
  tickUs() { return this.timer.div * 1e6 / this.eClock; }
  msToCycles(ms) { return Math.round(ms * this.eClock / 1000); }

  /** Advance the emulation by `ms` milliseconds of PCM time. */
  run(ms) { return this.runCycles(this.msToCycles(ms)); }

  /** Advance by n E cycles (instruction granularity). Returns cycles actually run. */
  runCycles(n) {
    const cpu = this.cpu;
    const start = cpu.cycles, end = start + n;
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    if (cpu.cycles >= this.nextEvent) this._service();
    if (this.breakpoints.size) {
      const bp = this.breakpoints;
      while (cpu.cycles < end) {
        const f = bp.get(cpu.pc);
        if (f && f(this) === 'stop') break;
        if (cpu.pc === IDLE_PC && this.idleSkip && !this._bpIdle && this._idleSkip(end)) {
          // the skip may land exactly on the next event or on the end of this run: behave like single-stepping
          if (cpu.cycles >= this.nextEvent) this._service();
          if (cpu.cycles >= end) break;
        }
        cpu.step();
        if (cpu.cycles >= this.nextEvent) this._service();
      }
    } else {
      while (cpu.cycles < end) {
        if (cpu.pc === IDLE_PC && this.idleSkip && this._idleSkip(end)) {
          // the skip may land exactly on the next event or on the end of this run: behave like single-stepping
          if (cpu.cycles >= this.nextEvent) this._service();
          if (cpu.cycles >= end) break;
        }
        cpu.step();
        if (cpu.cycles >= this.nextEvent) this._service();
      }
    }
    this.perf.hostMs += (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    this.perf.emuCycles += cpu.cycles - start;
    return cpu.cycles - start;
  }
  /** Run until predicate(machine) is true (checked every `stepMs`) or `timeoutMs` elapses. Returns true if met. */
  runUntil(pred, { timeoutMs = 5000, stepMs = 1 } = {}) {
    const end = this.cpu.cycles + this.msToCycles(timeoutMs);
    while (this.cpu.cycles < end) { if (pred(this)) return true; this.run(stepMs); }
    return !!pred(this);
  }
  /** Call fn(machine) whenever the CPU is about to execute `pc` (fn returning 'stop' ends run()). Returns remover. */
  /** Breakpoint at pc; fn(machine) may return 'stop'. A breakpoint inside the idle wait loop turns the idle skip off
   *  while it is set, so it fires on every pass of the loop as it would when single-stepping. */
  addBreakpoint(pc, fn) {
    this.breakpoints.set(pc & 0xFFFF, fn);
    this._bpIdle = [...this.breakpoints.keys()].some((a) => a >= IDLE_PC && a < IDLE_END);
    return () => {
      this.breakpoints.delete(pc & 0xFFFF);
      this._bpIdle = [...this.breakpoints.keys()].some((a) => a >= IDLE_PC && a < IDLE_END);
    };
  }
  /** Emulated time / host time since construction (or since resetPerf()). */
  speedRatio() { const emuMs = this.perf.emuCycles * 1000 / this.eClock; return this.perf.hostMs > 0 ? emuMs / this.perf.hostMs : Infinity; }
  resetPerf() { this.perf = { hostMs: 0, emuCycles: 0 }; }

  _idleSkip(end) {
    const cpu = this.cpu;
    if (cpu.waiting || cpu.stopped) return;
    if (!(cpu.ccr & 0x10) && this._pending() !== null) return;
    const c = cpu.cycles, t = this.timer;
    const tick = t.tick(c);
    const M = (this.mem[0x142] << 8) | this.mem[0x143];
    const diff = (tick - M) & 0xFFFF;
    if (diff >= 0x0ABE) return;
    const exitCycle = t.t0 + (tick + (0x0ABE - diff)) * t.div;
    let n = Math.ceil((exitCycle - c) / IDLE_ITER);
    const limit = Math.min(this.nextEvent, end);
    const maxN = Math.floor((limit - c) / IDLE_ITER);
    if (maxN < n) n = maxN;
    if (n <= 0) return false;
    cpu.cycles += n * IDLE_ITER;
    // leave D and the N/Z/V/C flags exactly as the last skipped pass of ldd TCNT / subd $0142 / cpd #$0ABE left them
    // (an interrupt taken next stacks them, so the stack bytes match single-stepping)
    const D = (t.tcnt(c + (n - 1) * IDLE_ITER) - M) & 0xFFFF;
    const r = (D - 0x0ABE) & 0xFFFF;
    cpu.D = D;
    cpu.ccr = (cpu.ccr & 0xF0) | (r & 0x8000 ? 0x08 : 0) | (r === 0 ? 0x04 : 0) |
      ((D ^ 0x0ABE) & (D ^ r) & 0x8000 ? 0x02 : 0) | (D < 0x0ABE ? 0x01 : 0);
    return true;
  }

  // ======================================================================================================
  // event scheduling
  reschedule() {
    let n = Infinity;
    for (const s of this.sources) if (s.next < n) n = s.next;
    this.nextEvent = n;
  }
  _service() {
    const now = this.cpu.cycles;
    for (let guard = 0; guard < 100000; guard++) {
      let src = null, t = Infinity;
      for (const s of this.sources) if (s.next < t) { t = s.next; src = s; }
      if (t > now) { this.nextEvent = t; return; }
      src.service(t);
    }
    this.fault('scheduler-runaway', {});
    this.reschedule();
  }

  // ======================================================================================================
  // reset / power
  /** Hardware reset (RESET pin or COP/clock-monitor reset via `vector`). RAM is not touched. */
  reset(vector = VEC.RESET) {
    const c = this.cpu.cycles;
    this.timer.reset(c); this.adc.reset(); this.sci.reset(c); this.spi.reset(); this.asic.reset();
    this.eeprom.reset(c); this.outputs.reset();
    this.regs.fill(0);
    this.regs[0x39] = 0x10;                  // OPTION: DLY=1
    this.regs[0x3C] = 0x25;                  // HPRIO: MDA=1 (expanded), PSEL=0101 (IRQ)
    this.regs[0x3D] = 0x01;                  // INIT: RAM 0000, registers 1000
    this.regs[0x2B] = 0x04;
    this.portd = 0; this.ddrd = 0;
    this.irqLatch = false;
    this.resetCycle = c;
    this.cop.armed = false; this.cop.last = c;
    this.cop.next = this.copEnabled ? c + this._copTimeoutCycles() : Infinity;
    this._spur = { count: 0, windowStart: c, reported: new Set() };
    this.cpu.reset(vector);
    this.reschedule();
    this.log('reset', { vector, pc: this.cpu.pc });
  }
  /**
   * Remove and restore power. batteryConnected (default inputs.batteryConnected) keeps keep-alive RAM 0000-0043;
   * otherwise all RAM is zeroed (stored codes lost). Peripherals and CPU reset; EEPROM is kept.
   */
  powerCycle({ batteryConnected = this.inputs.batteryConnected, fill = 'random' } = {}) {
    const keep = this.mem.slice(0, 0x44);
    this._fillRam(fill);
    if (batteryConnected) this.mem.set(keep, 0);
    this.asic.extRam.fill(0);
    this.log('power', { batteryConnected, fill });
    this.reset();
  }
  /** fill: 'random' (deterministic SRAM-like pattern, fails the keep-alive check), 'zero', or a byte value. */
  _fillRam(fill) {
    if (fill === 'zero') { this.mem.fill(0, 0, 0x200); return; }
    if (typeof fill === 'number') { this.mem.fill(fill & 0xFF, 0, 0x200); return; }
    let x = (this._seed = ((this._seed ?? 0x1995) * 1103515245 + 12345) >>> 0);
    for (let a = 0; a < 0x200; a++) { x = (x * 1664525 + 1013904223) >>> 0; this.mem[a] = x >>> 24; }
  }
  getKeepAlive() { return this.mem.slice(0, 0x44); }
  setKeepAlive(bytes) { this.mem.set(bytes.subarray ? bytes.subarray(0, 0x44) : bytes.slice(0, 0x44), 0); }

  // ======================================================================================================
  // EEPROM persistence
  getEeprom() { return this.eeprom.data.slice(); }
  loadEeprom(bytes) { this.eeprom.data.set(bytes.subarray ? bytes.subarray(0, 512) : bytes.slice(0, 512)); this._syncEepromToMem(); }
  /** fn(event, data) on every applied program/erase: event = {kind, addr, data, changed, blocked, value}. */
  onEepromWrite(fn) { this.eeprom.listeners.push(fn); return () => { this.eeprom.listeners = this.eeprom.listeners.filter((f) => f !== fn); }; }
  _syncEepromToMem() { this.mem.set(this.eeprom.data, 0xB600); }
  _onEepromChange() { this._syncEepromToMem(); }
  romByte(a) { return (a >= 0xB600 && a < 0xB800) ? this.eeprom.data[a - 0xB600] : this.rom[(a - 0x8000) & 0x7FFF]; }

  // ======================================================================================================
  // bus
  _readSlow(a, c) {
    if (a >= 0x1000 && a < 0x1040) return this._readReg(a & 0x3F, c);
    if (a >= 0x0400 && a < 0x0500) return this.asic.read(a, c);
    return a & 0xFF;                           // unmapped: the multiplexed bus returns the low address byte
  }
  _write(a, v, c) {
    if (a < 0x200) { this.mem[a] = v; if (a === 0x6D && !this.generic) this._onPass(c); return; }
    if (a >= 0x8000) {
      if (a >= 0xB600 && a < 0xB800) this.eeprom.write(a - 0xB600, v, c);
      else this.romWrites++;                   // flash is read-only (JEDEC program sequence ignored)
      return;
    }
    if (a >= 0x1000 && a < 0x1040) return this._writeReg(a & 0x3F, v, c);
    if (a >= 0x0400 && a < 0x0500) return this.asic.write(a, v, c);
    // unmapped: ignored
  }
  /** Side-effect-free read for GUIs/watches (registers return their stored value). */
  peek(a) {
    a &= 0xFFFF;
    if (a < 0x200 || a >= 0x8000) return this.mem[a];
    if (a >= 0x0480 && a < 0x0500) return this.asic.extRam[a - 0x0480];
    if (a >= 0x1000 && a < 0x1040) {
      const off = a & 0x3F;
      if (off === 0x2F) return this.sci.rxData;
      if (off === 0x2A) return this.spi.rx;
      if (off === 0x29 || off === 0x2E || off === 0x30 || (off >= 0x31 && off <= 0x34)) {
        if (off >= 0x31) { this.adc._update(this.cpu.cycles); return this.adc.adr[off - 0x31]; }
        if (off === 0x29) return (this.spi._spif(this.cpu.cycles) ? 0x80 : 0) | (this.spi.wcol ? 0x40 : 0);
        return this._readReg(off, this.cpu.cycles);
      }
      return this._readReg(off, this.cpu.cycles);
    }
    if (a >= 0x0400 && a < 0x0480) return this.asic.read(a, this.cpu.cycles);
    return a & 0xFF;
  }
  poke(a, v) { a &= 0xFFFF; if (a < 0x200) this.mem[a] = v & 0xFF; else if (a >= 0x0480 && a < 0x0500) this.asic.extRam[a - 0x0480] = v & 0xFF; }
  peek16(a) { return (this.peek(a) << 8) | this.peek(a + 1); }

  _readReg(off, c) {
    if (off === 0x00 || (off >= 0x0B && off <= 0x27)) return this.timer.read(off, c);
    if (off >= 0x28 && off <= 0x2A) return this.spi.read(off, c);
    if (off >= 0x2B && off <= 0x2F) return this.sci.read(off, c);
    if (off >= 0x30 && off <= 0x34) return this.adc.read(off, c);
    switch (off) {
      case 0x08: return (this.portd & 0x3F) | (~this.ddrd & 0x01);   // PD0/RxD idles high
      case 0x09: return this.ddrd;
      case 0x0A: return 0;                                            // PORTE digital read (ADC pins)
      case 0x35: return this.eeprom.bprot;
      case 0x3B: return this.eeprom.pprog;
      case 0x3F: return 0x08 | (this.copEnabled ? 0 : 0x04) | 0x01;   // CONFIG GUESS: NOSEC, NOCOP per option, EEON
    }
    return this.regs[off];
  }
  _writeReg(off, v, c) {
    if (off === 0x00 || (off >= 0x0B && off <= 0x27)) return this.timer.write(off, v, c);
    if (off >= 0x28 && off <= 0x2A) return this.spi.write(off, v, c);
    if (off >= 0x2B && off <= 0x2F) return this.sci.write(off, v, c);
    if (off === 0x30) return this.adc.write(v, c);
    const early = c - this.resetCycle < 64;
    switch (off) {
      case 0x08: {
        const old = this.portd; this.portd = v & 0x3F;
        if ((old ^ this.portd) & 0x20) this.spi.pd5(this.portd & 0x20, c);
        return;
      }
      case 0x09: this.ddrd = v & 0x3F; return;
      case 0x35: this.eeprom.writeBprot(v, c); return;
      case 0x39: {                                   // OPTION: IRQE, DLY, CR1:0 time-protected
        const prot = 0x20 | 0x10 | 0x03;
        this.regs[0x39] = early ? v : ((this.regs[0x39] & prot) | (v & ~prot & 0xFF));
        return;
      }
      case 0x3A:                                     // COPRST
        if (v === 0x55) this.cop.armed = true;
        else if (v === 0xAA && this.cop.armed) {
          this.cop.armed = false;
          const gap = c - this.cop.last; if (gap > this.cop.maxGap) this.cop.maxGap = gap;
          this.cop.last = c;
          if (this.copEnabled) { this.cop.next = c + this._copTimeoutCycles(); this.reschedule(); }
        }
        return;
      case 0x3B: this.eeprom.writePprog(v, c); return;
      case 0x3C: this.regs[0x3C] = (this.regs[0x3C] & 0xF0) | (v & 0x0F); return;  // RBOOT/SMOD/MDA/IRV ignored
      case 0x3D: if (v !== this.regs[0x3D]) this.log('initWrite', { value: v, note: 'INIT remap not modelled' }); return;
      case 0x3F: return;
    }
    this.regs[off] = v;
  }

  // ======================================================================================================
  // interrupts
  setIrqPin(level, cycle = this.cpu.cycles) {
    const old = this.irqPin; this.irqPin = !!level;
    if (old && !level && (this.regs[0x39] & 0x20)) this.irqLatch = true;   // IRQE=1: falling edge
  }
  _has(v) {
    const t = this.timer;
    switch (v) {
      case VEC.IRQ: return this.irqLatch || (!(this.regs[0x39] & 0x20) && !this.irqPin);
      case VEC.RTII: return !!(t.tflg2 & t.tmsk2 & 0x40);
      case VEC.TIC1: return !!(t.tflg1 & t.tmsk1 & 0x04);
      case VEC.TIC2: return !!(t.tflg1 & t.tmsk1 & 0x02);
      case VEC.TIC3: return !!(t.tflg1 & t.tmsk1 & 0x01);
      case VEC.TOC1: return !!(t.tflg1 & t.tmsk1 & 0x80);
      case VEC.TOC2: return !!(t.tflg1 & t.tmsk1 & 0x40);
      case VEC.TOC3: return !!(t.tflg1 & t.tmsk1 & 0x20);
      case VEC.TOC4: return !!(t.tflg1 & t.tmsk1 & 0x10);
      case VEC.TOC5: return !!(t.tflg1 & t.tmsk1 & 0x08);
      case VEC.TOF: return !!(t.tflg2 & t.tmsk2 & 0x80);
      case VEC.PAOV: return !!(t.tflg2 & t.tmsk2 & 0x20);
      case VEC.PAI: return !!(t.tflg2 & t.tmsk2 & 0x10);
      case VEC.SPI: return !!(this.spi.spcr & 0x80) && this.spi._spif(this.cpu.cycles);
      case VEC.SCI: return this.sci.irq();
    }
    return false;
  }
  _pending() {
    const t = this.timer;
    if (!(t.tflg1 & t.tmsk1) && !(t.tflg2 & t.tmsk2 & 0xF0) && !this.irqLatch &&
      ((this.regs[0x39] & 0x20) || this.irqPin) && !(this.sci.sccr2 & 0xF0 && this.sci.irq()) &&
      !((this.spi.spcr & 0x80) && this.spi._spif(this.cpu.cycles))) return null;
    const promoted = PSEL_VECTOR[this.regs[0x3C] & 0x0F];
    if (this._has(promoted)) return promoted;
    for (const v of MASKABLE_PRIORITY) if (this._has(v)) return v;
    return null;
  }
  _onInterrupt(v) {
    if (v === VEC.IRQ) this.irqLatch = false;
    const handler = (this.mem[v] << 8) | this.mem[v + 1];
    if (!this.generic && handler === SPURIOUS_HANDLER) {
      const c = this.cpu.cycles, s = this._spur;
      if (c - s.windowStart > this.eClock / 1000) { s.windowStart = c; s.count = 0; }
      s.count++;
      if (s.count > 20 && !s.reported.has(v)) { s.reported.add(v); this.fault('fd04-spurious-loop', { vector: v }); }
    }
  }

  // ======================================================================================================
  // COP
  _copTimeoutCycles() { return 32768 * [1, 4, 16, 64][this.regs[0x39] & 3]; }
  _copTimeout(at) {
    this.fault('cop-timeout', { lastService: this.cop.last });
    this.cop.next = Infinity;
    this.reset(VEC.COP);
  }
  setCopEnabled(on) {
    this.copEnabled = !!on;
    this.cop.next = on ? this.cpu.cycles + this._copTimeoutCycles() : Infinity;
    this.reschedule();
  }

  // ======================================================================================================
  // peripheral callbacks
  _onPortAPin(bit, level, cycle) { this.outputs.ocPin(bit, level, cycle); }
  _onSciTx(byte, t8, pc, at, written = at) {
    if (t8 === 0) {
      this.diag.push(byte);
      if (this.diag.length > 65536) this.diag.splice(0, 32768);
      this.log('diagTx', { byte, pc, written }, at);
    } else this.outputs.sideByte(byte, pc, at);
  }
  _onSciRx(byte, r8, at, accepted) { this.log(r8 ? 'sideRx' : 'diagRx', { byte, accepted }, at); }
  _onPass(c) {
    this.passes++;
    const m = this.mem;
    let s = '';
    for (let a = 0x39; a <= 0x40; a++) s += m[a].toString(16).padStart(2, '0');
    s += '/' + m[0xF8].toString(16).padStart(2, '0') + m[0xF9].toString(16).padStart(2, '0');
    if (s !== this._dtcSnap) {
      const prev = this._dtcSnap; this._dtcSnap = s;
      this.log('dtc', { stored: this.storedCodes(), pending: [m[0xF8], m[0xF9]], prev }, c);
    }
  }

  // ======================================================================================================
  // log / events
  /** Append an event to the ring buffer (types in logMute are only passed to listeners) and notify listeners. */
  log(type, data = {}, cycle = this.cpu.cycles) {
    const muted = this.logMute.has(type);
    if (muted && !this.listeners.get(type)?.size && !this.listeners.get('*')?.size) return;
    const e = { seq: this.log_.n, type, cycle, ms: +(cycle * 1000 / this.eClock).toFixed(4), ...data };
    if (!muted) this.log_.push(e);
    const ls = this.listeners.get(type), all = this.listeners.get('*');
    if (ls) for (const fn of ls) fn(e, this);
    if (all) for (const fn of all) fn(e, this);
  }
  /** Subscribe to an event type ('inj','spark','diagTx','diagRx','sideTx','sideRx','fc','fd','mil','latch','ais',
   *  'smart','eeprom','dtc','fault','reset','sciTimeout','spiUnselected','initWrite') or '*'. Returns unsubscribe. */
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }
  events(since = 0, type = null) { const ev = this.log_.since(since); return type ? ev.filter((e) => e.type === type) : ev; }
  get eventSeq() { return this.log_.n; }
  fault(kind, info = {}) {
    const f = { kind, cycle: this.cpu.cycles, ms: this.ms, pc: this.cpu.pc, ...info };
    this.faults.push(f);
    this.log('fault', { kind, ...info });
  }

  // ======================================================================================================
  // SCI diagnostic interface
  /** Queue scan-tool bytes (R8=0). The next byte goes out only after the PCM echoed the previous one (or 100 ms). */
  sciSend(bytes) { this.sci.testerSend(Array.isArray(bytes) ? bytes : [bytes], this.cpu.cycles); }
  /** Inject side-channel status bytes (R8=1 frames) as the unknown 9-bit device would send them. */
  sideChannelSend(bytes) { this.sci.sideSend(Array.isArray(bytes) ? bytes : [bytes], this.cpu.cycles); }
  onDiagTx(fn) { return this.on('diagTx', (e) => fn(e.byte, e)); }
  /** Drain the diagnostic bytes received from the PCM since the last call. */
  readDiag() { const d = this.diag.slice(); this.diag.length = 0; return d; }
  /**
   * Send a request and collect what the PCM sends back (echo of each request byte + reply bytes).
   * Stops `quietMs` after the last diagnostic byte once all request bytes are echoed, or after `count` bytes,
   * or at `timeoutMs`. Returns an array of byte values.
   * Bytes the PCM wrote to SCDR before it received the first request byte (the tail of a running 14/22 stream)
   * are not part of the reply and are dropped, as is a stream byte written in the same pass ahead of the echo.
   */
  sciRequest(bytes, { timeoutMs = 3000, quietMs = 120, count = null } = {}) {
    bytes = Array.isArray(bytes) ? bytes : [bytes];
    const got = [];
    let lastAt = this.cpu.cycles, delivered = null;
    const offTx = this.on('diagTx', (e) => { lastAt = this.cpu.cycles; got.push(e); });
    const offRx = this.on('diagRx', (e) => { if (delivered === null && e.byte === bytes[0]) delivered = e.cycle; });
    const hs = this.sci.tester.hs;     // high-speed answers are not echoes: no echo alignment
    const frame = () => {
      if (delivered === null) return [];
      let r = got.filter((e) => e.written >= delivered).map((e) => e.byte);
      const k = r.indexOf(bytes[0]);
      if (!hs && k > 0 && k <= 2) r = r.slice(k);
      return r;
    };
    this.sciSend(bytes);
    const end = this.cpu.cycles + this.msToCycles(timeoutMs);
    const quiet = this.msToCycles(quietMs);
    try {
      while (this.cpu.cycles < end) {
        this.run(1);
        if (count !== null) { if (frame().length >= count) break; continue; }
        if (!this.sci.testerBusy() && this.cpu.cycles - lastAt >= quiet && frame().length >= bytes.length) break;
      }
    } finally { offTx(); offRx(); }
    const out = frame();
    return count !== null ? out.slice(0, count) : out;
  }

  // ======================================================================================================
  // observations
  storedCodes() { const c = []; for (let a = 0x40; a >= 0x39; a--) if (this.mem[a]) c.push(this.mem[a]); return c; }
  faultInfo(code) {
    const hex = code.toString(16).toUpperCase().padStart(2, '0');
    const f = this.data.faults.faults.find((x) => x.code === hex);
    return f ? { code: hex, name: f.name, flash: f.flash_code, condition: f.set_condition, nameSource: 'generic Chrysler list (unverified for Viper)' }
      : { code: hex, name: 'unknown' };
  }
  dtcs() { return { stored: this.storedCodes().map((c) => this.faultInfo(c)), pending: [this.mem[0xF8], this.mem[0xF9]].filter((x) => x).map((c) => this.faultInfo(c)) }; }

  /** Engine view decoded from RAM (all scales INFERRED unless noted). */
  engine() {
    const m = this.mem;
    const rpm16 = (m[0x6E] << 8) | m[0x6F];
    return {
      rpm16, rpm: rpm16 / 8, slot: m[0x63], cylinder: m[0x63] < 10 ? SLOT_TO_CYL[m[0x63]] : null,
      synced: !!(m[0x4F] & 0x80), irqSeen: !!(m[0x4F] & 0x40), running: !!(m[0x44] & 0x40), sparkFromMap: !!(m[0x44] & 0x01),
      period: (m[0x5E] << 8) | m[0x5F], spark71: m[0x71], spark75: m[0x75], sparkDeg: m[0x71] * 0.5,
      pwEven: (m[0x89] << 8) | m[0x8A], pwOdd: (m[0x8B] << 8) | m[0x8C], crankPw: (m[0x8D] << 8) | m[0x8E],
      fuelCut: { revLimit: !!(m[0x50] & 1), speedLimit: !!(m[0x50] & 2), decel: !!(m[0x50] & 0x80) },
      map: m[0x76], mapFiltered: m[0xC6], baro: m[0x08], tps: m[0x77], tpsRaw: m[0x7F], tpsMin: m[0x03],
      coolantC: m[0x7B] - 128, airC: m[0x78] - 128, batteryV: m[0x80] / 16, o2_1: m[0x79], o2_2: m[0x7A],
      passes: m[0x6D], runTime: m[0x6C], aisPosition: m[0x05], aisTarget: m[0x10A],
      targetIdle: ((m[0xE7] << 8) | m[0xE8]) / 8, vss: m[0x84],
      fc: m[0xFC], fd: m[0xFD], fe: m[0xFE], milOn: !(m[0xFC] & 0x40),
    };
  }
  /** RAM symbol table helpers (data/ram_symbols.json). */
  symbol(name) { return this.data.ram_symbols.ram.find((r) => r.name === name) || null; }
  readSymbol(name) { const s = this.symbol(name); if (!s) return undefined; const a = parseInt(s.addr, 16); return s.size === 2 ? this.peek16(a) : this.peek(a); }
  watchList() {
    return this.data.ram_symbols.ram.filter((r) => r.watch).map((r) => {
      const a = parseInt(r.addr, 16);
      return { addr: r.addr, name: r.name, size: r.size, scale: r.scale, units: r.units, confidence: r.confidence,
        value: r.size === 2 ? this.peek16(a) : this.peek(a) };
    });
  }
  status() {
    return {
      ms: this.ms, cycles: this.cpu.cycles, pc: this.cpu.pc, passes: this.passes,
      engine: this.engine(), outputs: this.outputs.snapshot(), stimulus: this.stimulus.snapshot(),
      dtcs: this.dtcs(), faults: this.faults.slice(),
      asic: { w0400: this.asic.w0400, ctrl: Array.from(this.asic.ctrl), watchdogKicks: this.asic.kicks,
        lastKickMs: this.asic.lastKick * 1000 / this.eClock, irqAcks: this.asic.irqAcks, pw: { ...this.asic.pw } },
      cop: { enabled: this.copEnabled, maxGapMs: this.cop.maxGap * 1000 / this.eClock },
      eeprom: { writes: this.eeprom.writes, blocked: this.eeprom.blocked, pprog: this.eeprom.pprog, bprot: this.eeprom.bprot },
      speedRatio: this.speedRatio(),
    };
  }
}

export { SLOT_TO_CYL };
