// 68HC11 CPU core (E-series behaviour), cycle counted.
//
// Written from the Motorola documents in ecu/sbec2/research/manuals:
//   M68HC11E Family Data Sheet Rev 5.1, Table 4-2 "Instruction Set" (opcodes, bytes, cycles, CCR effects)
//   M68HC11 Reference Manual (M68HC11RM/AD), Section 5 (resets/interrupts, XIRQ/X bit, HPRIO, illegal opcode
//   trap) and Appendix A (per-instruction descriptions: DAA table, IDIV/FDIV, MUL, STOP, WAI, SWI).
//
// Pure ES module: no DOM, no Node APIs. Works in browsers and in Node >= 14.
//
// ---------------------------------------------------------------------------------------------------------
// Machine interface
//
//   const cpu = new HC11({
//     read8(addr, cycle)          -> byte              (required)
//     write8(addr, value, cycle)                       (required)
//     getPendingVector(cpu)       -> vector | null     (optional) highest-priority I-bit-maskable source that is
//                                                       pending AND locally enabled (machine applies the
//                                                       peripheral enable bits and the HPRIO/PSEL promotion).
//                                                       Called only when the CPU is willing to take an I-bit
//                                                       interrupt (I = 0). If absent, the CPU's built-in
//                                                       request set is used (requestInterrupt/clearInterrupt).
//     xirqAsserted(cpu)           -> boolean           (optional) level of the XIRQ pin (true = asserted/low).
//                                                       If absent, cpu.setXIRQ(level) drives it.
//     onInterrupt(vector, cpu)                          (optional) called after stacking, when the vector is
//                                                       fetched (lets the machine clear edge latches).
//     onIllegal(addr, bytes, cpu)                       (optional) called on the illegal-opcode trap.
//   }, { testMode: false });
//
//   cpu.reset();               PC <- (FFFE), CCR <- S X I set
//   cycles = cpu.step();       executes one instruction or one interrupt entry, returns E-clock cycles used.
//                              While in WAI or STOP each step() returns 1 (one idle E cycle) so the machine can
//                              keep clocking timers; cpu.waiting / cpu.stopped expose the state.
//   cpu.cycles                 running E-cycle total. The `cycle` argument passed to read8/write8 is the value of
//                              cpu.cycles at the start of the instruction being executed (bus accesses are not
//                              individually time-stamped inside an instruction).
//
// Interrupt model (Reference Manual 5.3 / Fig 5-2..5-5):
//   * Checked between instructions. XIRQ is taken if X = 0 and the pin is asserted (level). Then, if I = 0,
//     the highest-priority maskable source is taken. Entry stacks PCL,PCH,IYL,IYH,IXL,IXH,A,B,CCR (9 bytes,
//     SP decremented after each byte), then sets I (and X for XIRQ) and loads PC from the vector.
//   * Hardware interrupt entry costs `cpu.interruptCycles` (default 14 = same bus sequence as SWI: 12 cycles to
//     stack incl. the aborted opcode fetch + 2 vector cycles; WAI documents the same 12 + 2 split).
//   * X bit is a set/reset flip-flop: TAP and RTI can clear it but never set it; only reset and XIRQ
//     acknowledge set it.
//   * Built-in request set: requestInterrupt(v)/clearInterrupt(v) are LEVEL requests (they stay pending until
//     cleared). Fixed E-series priority IRQ > RTI > IC1 > IC2 > IC3 > OC1 > OC2 > OC3 > OC4 > OC5/IC4 > TOF >
//     PAOV > PAI > SPI > SCI, with cpu.promotedVector (set it from HPRIO PSEL, see PSEL_VECTOR) taken first.
//   * Illegal opcode (any undefined opcode on any of the 4 pages, and TEST outside test mode): stacks the
//     address of the FIRST byte of the illegal opcode (the prebyte, for paged opcodes; RM 5.4.2), sets I,
//     vectors through FFF8. Cost `cpu.illegalCycles` (default 14; not specified by Motorola - assumption).
//   * STOP: acts as NOP when S = 1. Otherwise the CPU stops; it wakes on XIRQ (taking the interrupt if X = 0,
//     or simply continuing with the next opcode if X = 1) or on a pending maskable interrupt with I = 0.
//     Oscillator start-up delay (OPTION.DLY, 4064 cycles) is left to the machine.
//   * WAI: stacks everything (12 cycles), idles, and on an unmasked interrupt sets I (and X for XIRQ) and
//     fetches the vector (2 cycles) without stacking again.
// ---------------------------------------------------------------------------------------------------------

export const CC = { S: 0x80, X: 0x40, H: 0x20, I: 0x10, N: 0x08, Z: 0x04, V: 0x02, C: 0x01 };

export const VEC = {
  SCI: 0xFFD6, SPI: 0xFFD8, PAI: 0xFFDA, PAOV: 0xFFDC, TOF: 0xFFDE,
  TOC5: 0xFFE0, TOC4: 0xFFE2, TOC3: 0xFFE4, TOC2: 0xFFE6, TOC1: 0xFFE8,
  TIC3: 0xFFEA, TIC2: 0xFFEC, TIC1: 0xFFEE, RTII: 0xFFF0, IRQ: 0xFFF2,
  XIRQ: 0xFFF4, SWI: 0xFFF6, ILLEGAL: 0xFFF8, COP: 0xFFFA, CLKMON: 0xFFFC, RESET: 0xFFFE,
};

// Fixed hardware priority of the I-bit sources, highest first (RM Fig 5-4/5-5).
export const MASKABLE_PRIORITY = [
  VEC.IRQ, VEC.RTII, VEC.TIC1, VEC.TIC2, VEC.TIC3, VEC.TOC1, VEC.TOC2, VEC.TOC3, VEC.TOC4, VEC.TOC5,
  VEC.TOF, VEC.PAOV, VEC.PAI, VEC.SPI, VEC.SCI,
];

// HPRIO PSEL[3:0] -> promoted vector (RM Table 5-4; 0101 "reserved, defaults to IRQ").
export const PSEL_VECTOR = [
  VEC.TOF, VEC.PAOV, VEC.PAI, VEC.SPI, VEC.SCI, VEC.IRQ, VEC.IRQ, VEC.RTII,
  VEC.TIC1, VEC.TIC2, VEC.TIC3, VEC.TOC1, VEC.TOC2, VEC.TOC3, VEC.TOC4, VEC.TOC5,
];

const S = 0x80, XB = 0x40, H = 0x20, I = 0x10, N = 0x08, Z = 0x04, V = 0x02, C = 0x01;

// ---- Page-1 base cycle table (data sheet Table 4-2). 0 = illegal / prebyte. --------------------------
// Prebyte pages add exactly one cycle to the equivalent page-1 opcode (checked against every 18/1A/CD row
// of Table 4-2; CPD uses the SUBD cycle column).
const CYC1 = new Uint8Array(256);
const LEGAL = [null, new Uint8Array(256), new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
{
  const set = (op, c) => { CYC1[op] = c; LEGAL[1][op] = 1; };
  // 00-0F
  set(0x01, 2); set(0x02, 41); set(0x03, 41); set(0x04, 3); set(0x05, 3); set(0x06, 2); set(0x07, 2);
  set(0x08, 3); set(0x09, 3); for (let o = 0x0A; o <= 0x0F; o++) set(o, 2);
  // 10-1F
  set(0x10, 2); set(0x11, 2); set(0x12, 6); set(0x13, 6); set(0x14, 6); set(0x15, 6); set(0x16, 2);
  set(0x17, 2); set(0x19, 2); set(0x1B, 2); set(0x1C, 7); set(0x1D, 7); set(0x1E, 7); set(0x1F, 7);
  // 20-2F branches
  for (let o = 0x20; o <= 0x2F; o++) set(o, 3);
  // 30-3F
  [3, 3, 4, 4, 3, 3, 3, 3, 5, 5, 3, 12, 4, 10, 14, 14].forEach((c, i) => set(0x30 + i, c));
  // 40-7F unary
  const un = [0x0, 0x3, 0x4, 0x6, 0x7, 0x8, 0x9, 0xA, 0xC, 0xD, 0xF];
  for (const l of un) { set(0x40 | l, 2); set(0x50 | l, 2); set(0x60 | l, 6); set(0x70 | l, 6); }
  set(0x6E, 3); set(0x7E, 3);
  // 80-FF
  for (let l = 0; l < 16; l++) {
    for (const hi of [0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0xE, 0xF]) {
      const m = hi & 3; // 0 imm 1 dir 2 idx 3 ext
      set((hi << 4) | l, [2, 3, 4, 4][m]);
    }
  }
  // 16-bit and special columns
  set(0x83, 4); set(0x93, 5); set(0xA3, 6); set(0xB3, 6);   // SUBD
  set(0xC3, 4); set(0xD3, 5); set(0xE3, 6); set(0xF3, 6);   // ADDD
  set(0x8C, 4); set(0x9C, 5); set(0xAC, 6); set(0xBC, 6);   // CPX
  set(0x8D, 6); set(0x9D, 5); set(0xAD, 6); set(0xBD, 6);   // BSR, JSR
  set(0x8E, 3); set(0x9E, 4); set(0xAE, 5); set(0xBE, 5);   // LDS
  set(0x8F, 3); set(0x9F, 4); set(0xAF, 5); set(0xBF, 5);   // XGDX, STS
  set(0xCC, 3); set(0xDC, 4); set(0xEC, 5); set(0xFC, 5);   // LDD
  set(0xDD, 4); set(0xED, 5); set(0xFD, 5);                 // STD
  set(0xCE, 3); set(0xDE, 4); set(0xEE, 5); set(0xFE, 5);   // LDX
  set(0xCF, 2); set(0xDF, 4); set(0xEF, 5); set(0xFF, 5);   // STOP, STX
  // illegal on page 1
  for (const o of [0x00, 0x18, 0x1A, 0x87, 0xC7, 0xCD]) { CYC1[o] = 0; LEGAL[1][o] = 0; }

  const p2 = [0x08, 0x09, 0x1C, 0x1D, 0x1E, 0x1F, 0x30, 0x35, 0x38, 0x3A, 0x3C, 0x8C, 0x8F, 0x9C, 0xBC,
    0xCE, 0xDE, 0xDF, 0xFE, 0xFF];
  for (const o of p2) LEGAL[2][o] = 1;
  for (let o = 0x60; o <= 0x6F; o++) if (LEGAL[1][o]) LEGAL[2][o] = 1;
  for (let o = 0xA0; o <= 0xAF; o++) LEGAL[2][o] = 1;
  for (let o = 0xE0; o <= 0xEF; o++) LEGAL[2][o] = 1;
  for (const o of [0x83, 0x93, 0xA3, 0xB3, 0xAC, 0xEE, 0xEF]) LEGAL[3][o] = 1;
  for (const o of [0xA3, 0xAC, 0xEE, 0xEF]) LEGAL[4][o] = 1;
}

/** Cycles for an opcode on a page (1 = no prebyte, 2 = 18, 3 = 1A, 4 = CD), or 0 if illegal. */
export function opcodeCycles(page, op) {
  if (!LEGAL[page][op]) return 0;
  return CYC1[op] + (page === 1 ? 0 : 1);
}
export function isLegal(page, op) { return !!LEGAL[page][op]; }

export class HC11 {
  constructor(bus, opts = {}) {
    if (!bus || typeof bus.read8 !== 'function' || typeof bus.write8 !== 'function') {
      throw new Error('HC11: bus must provide read8(addr, cycle) and write8(addr, value, cycle)');
    }
    this.bus = bus;
    this.testMode = !!opts.testMode;
    this.interruptCycles = opts.interruptCycles ?? 14;
    this.illegalCycles = opts.illegalCycles ?? 14;
    this.cycles = 0;
    this.pendingSet = new Set();   // built-in maskable request set (used when bus.getPendingVector absent)
    this.promotedVector = null;    // HPRIO promotion for the built-in set
    this.xirqLine = false;
    this.a = 0; this.b = 0; this.x = 0; this.y = 0; this.sp = 0; this.pc = 0; this.ccr = S | XB | I;
    this.waiting = false; this.stopped = false; this.iDelay = false;
    this.lastOpAddr = 0;
    this.reset();
  }

  // ---- register accessors --------------------------------------------------------------------------
  get A() { return this.a; } set A(v) { this.a = v & 0xFF; }
  get B() { return this.b; } set B(v) { this.b = v & 0xFF; }
  get D() { return (this.a << 8) | this.b; } set D(v) { this.a = (v >> 8) & 0xFF; this.b = v & 0xFF; }
  get X() { return this.x; } set X(v) { this.x = v & 0xFFFF; }
  get Y() { return this.y; } set Y(v) { this.y = v & 0xFFFF; }
  get SP() { return this.sp; } set SP(v) { this.sp = v & 0xFFFF; }
  get PC() { return this.pc; } set PC(v) { this.pc = v & 0xFFFF; }
  get CCR() { return this.ccr; } set CCR(v) { this.ccr = v & 0xFF; }

  getState() {
    return { A: this.a, B: this.b, D: this.D, X: this.x, Y: this.y, SP: this.sp, PC: this.pc, CCR: this.ccr,
      cycles: this.cycles, waiting: this.waiting, stopped: this.stopped };
  }
  setState(s) {
    for (const k of ['A', 'B', 'X', 'Y', 'SP', 'PC', 'CCR']) if (s[k] !== undefined) this[k] = s[k];
    if (s.D !== undefined) this.D = s.D;
    if (s.cycles !== undefined) this.cycles = s.cycles;
    if (s.waiting !== undefined) this.waiting = !!s.waiting;
    if (s.stopped !== undefined) this.stopped = !!s.stopped;
  }

  reset(vector = VEC.RESET) {
    this.ccr = S | XB | I | (this.ccr & (H | N | Z | V | C)); // RM: reset sets S, X, I; others undefined
    this.waiting = false; this.stopped = false; this.iDelay = false;
    this.pc = this.rd16(vector);
  }

  // ---- interrupt request API (built-in set) ---------------------------------------------------------
  requestInterrupt(vector) { this.pendingSet.add(vector & 0xFFFF); }
  clearInterrupt(vector) { this.pendingSet.delete(vector & 0xFFFF); }
  setXIRQ(level) { this.xirqLine = !!level; }

  _xirq() { return this.bus.xirqAsserted ? !!this.bus.xirqAsserted(this) : this.xirqLine; }
  _pendingMaskable() {
    if (this.bus.getPendingVector) {
      const v = this.bus.getPendingVector(this);
      return (v === null || v === undefined) ? null : v & 0xFFFF;
    }
    if (this.pendingSet.size === 0) return null;
    if (this.promotedVector !== null && this.pendingSet.has(this.promotedVector)) return this.promotedVector;
    for (const v of MASKABLE_PRIORITY) if (this.pendingSet.has(v)) return v;
    return this.pendingSet.values().next().value; // nonstandard vector supplied by the machine
  }

  // ---- bus helpers ----------------------------------------------------------------------------------
  rd8(a) { return this.bus.read8(a & 0xFFFF, this.cycles) & 0xFF; }
  rd16(a) { return (this.rd8(a) << 8) | this.rd8(a + 1); }
  wr8(a, v) { this.bus.write8(a & 0xFFFF, v & 0xFF, this.cycles); }
  wr16(a, v) { this.wr8(a, v >> 8); this.wr8(a + 1, v); }
  fetch8() { const v = this.rd8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const v = this.rd16(this.pc); this.pc = (this.pc + 2) & 0xFFFF; return v; }
  push8(v) { this.wr8(this.sp, v); this.sp = (this.sp - 1) & 0xFFFF; }
  push16(v) { this.push8(v & 0xFF); this.push8(v >> 8); }
  pull8() { this.sp = (this.sp + 1) & 0xFFFF; return this.rd8(this.sp); }
  pull16() { const h = this.pull8(); return (h << 8) | this.pull8(); }

  _stackAll() {
    this.push16(this.pc); this.push16(this.y); this.push16(this.x);
    this.push8(this.a); this.push8(this.b); this.push8(this.ccr);
  }
  _vector(v) {
    this.pc = this.rd16(v);
    if (this.bus.onInterrupt) this.bus.onInterrupt(v, this);
  }
  // CCR write honouring the X flip-flop (can be cleared, never set, by software).
  _writeCCR(v) {
    const x = (this.ccr & XB) & v;
    this.ccr = (v & ~XB & 0xFF) | x;
  }

  // ---- main step ------------------------------------------------------------------------------------
  step() {
    let c;
    if (this.stopped) c = this._stepStopped();
    else if (this.waiting) c = this._stepWaiting();
    else {
      // RM 5.5.2: after CLI or TAP clears I, the next instruction always runs before a maskable interrupt.
      const inhibit = this.iDelay;
      this.iDelay = false;
      c = this._checkInterrupts(inhibit);
      if (!c) c = this._exec();
    }
    this.cycles += c;
    return c;
  }

  /** Run until at least `n` cycles have elapsed; returns cycles actually used. */
  run(n) { let used = 0; while (used < n) used += this.step(); return used; }

  _checkInterrupts(maskableInhibit = false) {
    if (!(this.ccr & XB) && this._xirq()) {
      this._stackAll(); this.ccr |= XB | I; this._vector(VEC.XIRQ);
      return this.interruptCycles;
    }
    if (!(this.ccr & I) && !maskableInhibit) {
      const v = this._pendingMaskable();
      if (v !== null) { this._stackAll(); this.ccr |= I; this._vector(v); return this.interruptCycles; }
    }
    return 0;
  }

  _stepWaiting() {
    if (!(this.ccr & XB) && this._xirq()) {
      this.waiting = false; this.ccr |= XB | I; this._vector(VEC.XIRQ); return 2;
    }
    if (!(this.ccr & I)) {
      const v = this._pendingMaskable();
      if (v !== null) { this.waiting = false; this.ccr |= I; this._vector(v); return 2; }
    }
    return 1;
  }

  _stepStopped() {
    if (this._xirq()) {
      this.stopped = false;
      if (!(this.ccr & XB)) { this._stackAll(); this.ccr |= XB | I; this._vector(VEC.XIRQ); return this.interruptCycles; }
      return 1; // X = 1: "STOP-continue", next step fetches the opcode after STOP
    }
    if (!(this.ccr & I)) {
      const v = this._pendingMaskable();
      if (v !== null) { this.stopped = false; this._stackAll(); this.ccr |= I; this._vector(v); return this.interruptCycles; }
    }
    return 1;
  }

  _illegal(opAddr, bytes) {
    this.pc = opAddr;
    this._stackAll(); this.ccr |= I;
    if (this.bus.onIllegal) this.bus.onIllegal(opAddr, bytes, this);
    this.pc = this.rd16(VEC.ILLEGAL);
    return this.illegalCycles;
  }

  // ---- flag helpers ---------------------------------------------------------------------------------
  _nz8(r) { this.ccr = (this.ccr & ~(N | Z)) | (r & 0x80 ? N : 0) | (r ? 0 : Z); }
  _nz16(r) { this.ccr = (this.ccr & ~(N | Z)) | (r & 0x8000 ? N : 0) | (r ? 0 : Z); }
  _ld8(r) { this.ccr = (this.ccr & ~(N | Z | V)) | (r & 0x80 ? N : 0) | (r ? 0 : Z); return r; }
  _ld16(r) { this.ccr = (this.ccr & ~(N | Z | V)) | (r & 0x8000 ? N : 0) | (r ? 0 : Z); return r; }

  _add8(a, m, cin) {
    const r = (a + m + cin) & 0xFF;
    const cbits = (a & m) | (m & ~r) | (~r & a);
    const v = (a & m & ~r) | (~a & ~m & r);
    this.ccr = (this.ccr & ~(H | N | Z | V | C)) | (cbits & 0x08 ? H : 0) | (r & 0x80 ? N : 0) | (r ? 0 : Z)
      | (v & 0x80 ? V : 0) | (cbits & 0x80 ? C : 0);
    return r;
  }
  _sub8(a, m, cin) {
    const r = (a - m - cin) & 0xFF;
    const cbits = (~a & m) | (m & r) | (r & ~a);
    const v = (a & ~m & ~r) | (~a & m & r);
    this.ccr = (this.ccr & ~(N | Z | V | C)) | (r & 0x80 ? N : 0) | (r ? 0 : Z)
      | (v & 0x80 ? V : 0) | (cbits & 0x80 ? C : 0);
    return r;
  }
  _add16(a, m) {
    const r = (a + m) & 0xFFFF;
    const cbits = (a & m) | (m & ~r) | (~r & a);
    const v = (a & m & ~r) | (~a & ~m & r);
    this.ccr = (this.ccr & ~(N | Z | V | C)) | (r & 0x8000 ? N : 0) | (r ? 0 : Z)
      | (v & 0x8000 ? V : 0) | (cbits & 0x8000 ? C : 0);
    return r;
  }
  _sub16(a, m) {
    const r = (a - m) & 0xFFFF;
    const cbits = (~a & m) | (m & r) | (r & ~a);
    const v = (a & ~m & ~r) | (~a & m & r);
    this.ccr = (this.ccr & ~(N | Z | V | C)) | (r & 0x8000 ? N : 0) | (r ? 0 : Z)
      | (v & 0x8000 ? V : 0) | (cbits & 0x8000 ? C : 0);
    return r;
  }

  // Column 0-F unary operation (NEG..CLR) on a byte; returns result (TST returns input unchanged).
  _unary(lo, m) {
    let r, c = this.ccr & C;
    switch (lo) {
      case 0x0: r = (-m) & 0xFF; // NEG
        this.ccr = (this.ccr & ~(N | Z | V | C)) | (r & 0x80 ? N : 0) | (r ? 0 : Z) | (r === 0x80 ? V : 0) | (r ? C : 0);
        return r;
      case 0x3: r = (~m) & 0xFF; this.ccr = (this.ccr & ~(N | Z | V | C)) | (r & 0x80 ? N : 0) | (r ? 0 : Z) | C; return r;
      case 0x4: r = m >> 1; return this._shiftFlags(r, m & 1);           // LSR
      case 0x6: r = (m >> 1) | (c << 7); return this._shiftFlags(r, m & 1);  // ROR
      case 0x7: r = (m >> 1) | (m & 0x80); return this._shiftFlags(r, m & 1); // ASR
      case 0x8: r = (m << 1) & 0xFF; return this._shiftFlags(r, m >> 7);     // ASL/LSL
      case 0x9: r = ((m << 1) | c) & 0xFF; return this._shiftFlags(r, m >> 7); // ROL
      case 0xA: r = (m - 1) & 0xFF; this.ccr = (this.ccr & ~(N | Z | V)) | (r & 0x80 ? N : 0) | (r ? 0 : Z) | (m === 0x80 ? V : 0); return r;
      case 0xC: r = (m + 1) & 0xFF; this.ccr = (this.ccr & ~(N | Z | V)) | (r & 0x80 ? N : 0) | (r ? 0 : Z) | (m === 0x7F ? V : 0); return r;
      case 0xD: this.ccr = (this.ccr & ~(N | Z | V | C)) | (m & 0x80 ? N : 0) | (m ? 0 : Z); return m; // TST
      case 0xF: this.ccr = (this.ccr & ~(N | V | C)) | Z; return 0; // CLR
    }
    throw new Error('unary ' + lo);
  }
  _shiftFlags(r, cout) {
    const n = (r & 0x80) ? 1 : 0;
    this.ccr = (this.ccr & ~(N | Z | V | C)) | (n ? N : 0) | (r ? 0 : Z) | ((n ^ cout) ? V : 0) | (cout ? C : 0);
    return r;
  }

  _branchCond(op) {
    const f = this.ccr, c = f & C, z = (f >> 2) & 1, n = (f >> 3) & 1, v = (f >> 1) & 1;
    switch (op & 0x0F) {
      case 0x0: return true;            // BRA
      case 0x1: return false;           // BRN
      case 0x2: return !(c | z);        // BHI
      case 0x3: return !!(c | z);       // BLS
      case 0x4: return !c;              // BCC/BHS
      case 0x5: return !!c;             // BCS/BLO
      case 0x6: return !z;              // BNE
      case 0x7: return !!z;             // BEQ
      case 0x8: return !v;              // BVC
      case 0x9: return !!v;             // BVS
      case 0xA: return !n;              // BPL
      case 0xB: return !!n;             // BMI
      case 0xC: return !(n ^ v);        // BGE
      case 0xD: return !!(n ^ v);       // BLT
      case 0xE: return !(z | (n ^ v));  // BGT
      case 0xF: return !!(z | (n ^ v)); // BLE
    }
    return false;
  }
  _rel(off) { this.pc = (this.pc + ((off << 24) >> 24)) & 0xFFFF; }

  // ---- instruction execution ------------------------------------------------------------------------
  _exec() {
    const opAddr = this.pc;
    this.lastOpAddr = opAddr;
    let op = this.fetch8();
    let page = 1;
    if (op === 0x18) { page = 2; op = this.fetch8(); }
    else if (op === 0x1A) { page = 3; op = this.fetch8(); }
    else if (op === 0xCD) { page = 4; op = this.fetch8(); }

    if (!LEGAL[page][op]) {
      if (page === 1 && op === 0x00 && this.testMode) { this.pc = opAddr; return 1; } // TEST: counts forever
      return this._illegal(opAddr, page === 1 ? [op] : [[0, 0, 0x18, 0x1A, 0xCD][page], op]);
    }
    const cyc = CYC1[op] + (page === 1 ? 0 : 1);
    const regY = page === 2 || page === 3;   // index register operated on is IY
    const baseY = page === 2 || page === 4;  // indexed addressing base is IY

    if (op >= 0x80) { this._execHigh(op, page, regY, baseY); return cyc; }
    if (op >= 0x40) { this._execUnary(op, baseY); return cyc; }
    this._execLow(op, regY, baseY);
    return op === 0x3E ? 12 : cyc; // WAI: table says 14 = 12 now + 2 at wake-up (vector fetch)
  }

  _idx(baseY) { return ((baseY ? this.y : this.x) + this.fetch8()) & 0xFFFF; }

  _execUnary(op, baseY) {
    const lo = op & 0x0F, row = op >> 4;
    if (row === 4 || row === 5) {
      if (row === 4) this.a = this._unary(lo, this.a); else this.b = this._unary(lo, this.b);
      return;
    }
    const ea = row === 6 ? this._idx(baseY) : this.fetch16();
    if (lo === 0xE) { this.pc = ea; return; } // JMP
    const m = this.rd8(ea); // every memory RMW form, CLR and TST included, reads the operand (RM A-41 CLR bus cycles)
    const r = this._unary(lo, m);
    if (lo !== 0xD) this.wr8(ea, r);
  }

  _execLow(op, regY, baseY) {
    switch (op) {
      case 0x01: return; // NOP
      case 0x02: { // IDIV
        const d = this.D, x = this.x;
        if (x === 0) { this.x = 0xFFFF; this.ccr = (this.ccr & ~(Z | V)) | C; return; }
        const q = Math.floor(d / x), r = d % x;
        this.x = q; this.D = r;
        this.ccr = (this.ccr & ~(Z | V | C)) | (q ? 0 : Z);
        return;
      }
      case 0x03: { // FDIV
        const d = this.D, x = this.x;
        if (x === 0) { this.x = 0xFFFF; this.ccr = (this.ccr & ~Z) | V | C; return; }
        if (x <= d) { this.x = 0xFFFF; this.ccr = (this.ccr & ~(Z | C)) | V; return; }
        const num = d * 65536;
        const q = Math.floor(num / x), r = num % x;
        this.x = q & 0xFFFF; this.D = r;
        this.ccr = (this.ccr & ~(Z | V | C)) | (q ? 0 : Z);
        return;
      }
      case 0x04: { // LSRD
        const d = this.D, c = d & 1, r = d >> 1;
        this.D = r;
        this.ccr = (this.ccr & ~(N | Z | V | C)) | (r ? 0 : Z) | (c ? V | C : 0);
        return;
      }
      case 0x05: { // ASLD/LSLD
        const d = this.D, c = d >> 15, r = (d << 1) & 0xFFFF, n = r >> 15;
        this.D = r;
        this.ccr = (this.ccr & ~(N | Z | V | C)) | (n ? N : 0) | (r ? 0 : Z) | ((n ^ c) ? V : 0) | (c ? C : 0);
        return;
      }
      case 0x06: { const wasI = this.ccr & I; this._writeCCR(this.a); if (wasI && !(this.ccr & I)) this.iDelay = true; return; } // TAP
      case 0x07: this.a = this.ccr; return;       // TPA
      case 0x08: // INX / INY
        if (regY) { this.y = (this.y + 1) & 0xFFFF; this.ccr = (this.ccr & ~Z) | (this.y ? 0 : Z); }
        else { this.x = (this.x + 1) & 0xFFFF; this.ccr = (this.ccr & ~Z) | (this.x ? 0 : Z); }
        return;
      case 0x09: // DEX / DEY
        if (regY) { this.y = (this.y - 1) & 0xFFFF; this.ccr = (this.ccr & ~Z) | (this.y ? 0 : Z); }
        else { this.x = (this.x - 1) & 0xFFFF; this.ccr = (this.ccr & ~Z) | (this.x ? 0 : Z); }
        return;
      case 0x0A: this.ccr &= ~V; return;
      case 0x0B: this.ccr |= V; return;
      case 0x0C: this.ccr &= ~C; return;
      case 0x0D: this.ccr |= C; return;
      case 0x0E: if (this.ccr & I) this.iDelay = true; this.ccr &= ~I; return; // CLI (I clear delayed one instruction)
      case 0x0F: this.ccr |= I; return;
      case 0x10: this.a = this._sub8(this.a, this.b, 0); return; // SBA
      case 0x11: this._sub8(this.a, this.b, 0); return;          // CBA
      case 0x12: case 0x13: case 0x1E: case 0x1F: { // BRSET / BRCLR
        const ea = op >= 0x1E ? this._idx(baseY) : this.fetch8();
        const mask = this.fetch8(), rel = this.fetch8();
        const m = this.rd8(ea);
        const isSet = (op & 1) === 0; // 12/1E = BRSET, 13/1F = BRCLR
        const take = isSet ? ((~m & mask) & 0xFF) === 0 : (m & mask) === 0;
        if (take) this._rel(rel);
        return;
      }
      case 0x14: case 0x15: case 0x1C: case 0x1D: { // BSET / BCLR
        const ea = op >= 0x1C ? this._idx(baseY) : this.fetch8();
        const mask = this.fetch8();
        const m = this.rd8(ea);
        const r = (op & 1) ? (m & ~mask) & 0xFF : (m | mask);
        this._ld8(r); this.wr8(ea, r);
        return;
      }
      case 0x16: this.b = this._ld8(this.a); return; // TAB
      case 0x17: this.a = this._ld8(this.b); return; // TBA
      case 0x19: { // DAA
        const a = this.a, c = this.ccr & C, h = this.ccr & H;
        const lo = a & 0x0F, hi = a >> 4;
        let corr = 0, cout = c;
        if (h || lo > 9) corr |= 0x06;
        if (c || hi > 9 || (hi >= 9 && lo > 9)) { corr |= 0x60; cout = 1; }
        const r = (a + corr) & 0xFF;
        // V is "not defined" (RM A-48); this core leaves V unchanged.
        this.a = r;
        this.ccr = (this.ccr & ~(N | Z | C)) | (r & 0x80 ? N : 0) | (r ? 0 : Z) | (cout ? C : 0);
        return;
      }
      case 0x1B: this.a = this._add8(this.a, this.b, 0); return; // ABA
      case 0x30: if (regY) this.y = (this.sp + 1) & 0xFFFF; else this.x = (this.sp + 1) & 0xFFFF; return; // TSX/TSY
      case 0x31: this.sp = (this.sp + 1) & 0xFFFF; return; // INS
      case 0x32: this.a = this.pull8(); return;
      case 0x33: this.b = this.pull8(); return;
      case 0x34: this.sp = (this.sp - 1) & 0xFFFF; return; // DES
      case 0x35: this.sp = ((regY ? this.y : this.x) - 1) & 0xFFFF; return; // TXS/TYS
      case 0x36: this.push8(this.a); return;
      case 0x37: this.push8(this.b); return;
      case 0x38: if (regY) this.y = this.pull16(); else this.x = this.pull16(); return; // PULX/PULY
      case 0x39: this.pc = this.pull16(); return; // RTS
      case 0x3A: if (regY) this.y = (this.y + this.b) & 0xFFFF; else this.x = (this.x + this.b) & 0xFFFF; return; // ABX/ABY
      case 0x3B: { // RTI
        this._writeCCR(this.pull8());
        this.b = this.pull8(); this.a = this.pull8();
        this.x = this.pull16(); this.y = this.pull16(); this.pc = this.pull16();
        return;
      }
      case 0x3C: this.push16(regY ? this.y : this.x); return; // PSHX/PSHY
      case 0x3D: { // MUL
        const r = this.a * this.b; this.D = r;
        this.ccr = (this.ccr & ~C) | (r & 0x80 ? C : 0);
        return;
      }
      case 0x3E: this._stackAll(); this.waiting = true; return; // WAI (12 cycles; +2 on wake)
      case 0x3F: this._stackAll(); this.ccr |= I; this.pc = this.rd16(VEC.SWI); return; // SWI
    }
    if (op >= 0x20 && op <= 0x2F) { const rel = this.fetch8(); if (this._branchCond(op)) this._rel(rel); return; }
    throw new Error(`HC11 internal: unhandled low opcode ${op.toString(16)}`);
  }

  _execHigh(op, page, regY, baseY) {
    const hi = op >> 4, lo = op & 0x0F, accB = hi >= 0xC, mode = hi & 3; // 0 imm 1 dir 2 idx 3 ext
    const ea = () => (mode === 1 ? this.fetch8() : mode === 2 ? this._idx(baseY) : this.fetch16());
    const op16 = () => (mode === 0 ? this.fetch16() : this.rd16(ea()));
    const op8 = () => (mode === 0 ? this.fetch8() : this.rd8(ea()));

    switch (lo) {
      case 0x3: { // SUBD / ADDD / CPD
        const m = op16();
        if (accB) this.D = this._add16(this.D, m);
        else if (page === 3 || page === 4) this._sub16(this.D, m);
        else this.D = this._sub16(this.D, m);
        return;
      }
      case 0x7: { const a = ea(); const r = this._ld8(accB ? this.b : this.a); this.wr8(a, r); return; } // STAA/STAB
      case 0xC: { // CPX/CPY  |  LDD
        const m = op16();
        if (accB) this.D = this._ld16(m);
        else this._sub16(regY ? this.y : this.x, m);
        return;
      }
      case 0xD: { // BSR/JSR  |  STD
        if (accB) { const a = ea(); this.wr16(a, this._ld16(this.D)); return; }
        if (mode === 0) { const rel = this.fetch8(); this.push16(this.pc); this._rel(rel); return; } // BSR
        const a = ea(); this.push16(this.pc); this.pc = a; return; // JSR
      }
      case 0xE: { // LDS  |  LDX/LDY
        const m = this._ld16(op16());
        if (!accB) this.sp = m; else if (regY) this.y = m; else this.x = m;
        return;
      }
      case 0xF: { // XGDX/XGDY, STS  |  STOP, STX/STY
        if (mode === 0) {
          if (!accB) { // XGDX / XGDY
            const d = this.D;
            if (regY) { this.D = this.y; this.y = d; } else { this.D = this.x; this.x = d; }
            return;
          }
          if (!(this.ccr & S)) this.stopped = true; // STOP (NOP when S = 1)
          return;
        }
        const a = ea();
        const v = !accB ? this.sp : (regY ? this.y : this.x);
        this.wr16(a, this._ld16(v));
        return;
      }
    }
    // 8-bit accumulator operations
    const m = op8();
    const acc = accB ? this.b : this.a;
    let r;
    switch (lo) {
      case 0x0: r = this._sub8(acc, m, 0); break;                    // SUB
      case 0x1: this._sub8(acc, m, 0); return;                        // CMP
      case 0x2: r = this._sub8(acc, m, this.ccr & C); break;          // SBC
      case 0x4: r = this._ld8(acc & m); break;                        // AND
      case 0x5: this._ld8(acc & m); return;                           // BIT
      case 0x6: r = this._ld8(m); break;                              // LDA
      case 0x8: r = this._ld8(acc ^ m); break;                        // EOR
      case 0x9: r = this._add8(acc, m, this.ccr & C); break;          // ADC
      case 0xA: r = this._ld8(acc | m); break;                        // ORA
      case 0xB: r = this._add8(acc, m, 0); break;                     // ADD
      default: throw new Error(`HC11 internal: unhandled opcode ${op.toString(16)}`);
    }
    if (accB) this.b = r; else this.a = r;
  }
}

// ---- Disassembler (shares the legality tables) -----------------------------------------------------------
const UN_NAMES = { 0x0: 'NEG', 0x3: 'COM', 0x4: 'LSR', 0x6: 'ROR', 0x7: 'ASR', 0x8: 'ASL', 0x9: 'ROL', 0xA: 'DEC', 0xC: 'INC', 0xD: 'TST', 0xE: 'JMP', 0xF: 'CLR' };
const LOW_NAMES = ['TEST', 'NOP', 'IDIV', 'FDIV', 'LSRD', 'ASLD', 'TAP', 'TPA', 'INX', 'DEX', 'CLV', 'SEV', 'CLC', 'SEC', 'CLI', 'SEI',
  'SBA', 'CBA', 'BRSET', 'BRCLR', 'BSET', 'BCLR', 'TAB', 'TBA', '', 'DAA', '', 'ABA', 'BSET', 'BCLR', 'BRSET', 'BRCLR',
  'BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE',
  'TSX', 'INS', 'PULA', 'PULB', 'DES', 'TXS', 'PSHA', 'PSHB', 'PULX', 'RTS', 'ABX', 'RTI', 'PSHX', 'MUL', 'WAI', 'SWI'];
const HI_A = ['SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDAA', 'STAA', 'EORA', 'ADCA', 'ORAA', 'ADDA', 'CPX', 'JSR', 'LDS', 'STS'];
const HI_B = ['SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDAB', 'STAB', 'EORB', 'ADCB', 'ORAB', 'ADDB', 'LDD', 'STD', 'LDX', 'STX'];

const h2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

/**
 * Disassemble one instruction. read(addr) -> byte. Returns { addr, length, bytes, text, target }.
 * target = branch/jump destination when statically known.
 */
export function disassemble(read, addr) {
  const rb = (a) => read(a & 0xFFFF) & 0xFF;
  let p = addr, op = rb(p++), page = 1;
  if (op === 0x18) { page = 2; op = rb(p++); } else if (op === 0x1A) { page = 3; op = rb(p++); } else if (op === 0xCD) { page = 4; op = rb(p++); }
  const done = (text, target = null) => {
    const length = (p - addr) & 0xFFFF;
    const bytes = []; for (let i = 0; i < length; i++) bytes.push(rb(addr + i));
    return { addr, length, bytes, text, target };
  };
  if (!LEGAL[page][op]) return done(page === 1 ? `FCB $${h2(op)}  ; illegal` : `FCB $${h2(rb(addr))},$${h2(op)}  ; illegal`);
  const regY = page === 2 || page === 3, baseY = page === 2 || page === 4, ix = baseY ? 'Y' : 'X';
  const YNAME = { INX: 'INY', DEX: 'DEY', TSX: 'TSY', TXS: 'TYS', PULX: 'PULY', ABX: 'ABY', PSHX: 'PSHY' };
  const rel = (o) => (p + ((o << 24) >> 24)) & 0xFFFF;
  if (op < 0x40) {
    let name = LOW_NAMES[op];
    if (regY && YNAME[name]) name = YNAME[name];
    if (op >= 0x20 && op <= 0x2F) { const o = rb(p++); const t = rel(o); return done(`${name} $${h4(t)}`, t); }
    if (op === 0x12 || op === 0x13) { const d = rb(p++), m = rb(p++), o = rb(p++); const t = rel(o); return done(`${name} $${h2(d)},#$${h2(m)},$${h4(t)}`, t); }
    if (op === 0x1E || op === 0x1F) { const d = rb(p++), m = rb(p++), o = rb(p++); const t = rel(o); return done(`${name} $${h2(d)},${ix},#$${h2(m)},$${h4(t)}`, t); }
    if (op === 0x14 || op === 0x15) { const d = rb(p++), m = rb(p++); return done(`${name} $${h2(d)},#$${h2(m)}`); }
    if (op === 0x1C || op === 0x1D) { const d = rb(p++), m = rb(p++); return done(`${name} $${h2(d)},${ix},#$${h2(m)}`); }
    return done(name);
  }
  if (op < 0x80) {
    const row = op >> 4, lo = op & 15, base = UN_NAMES[lo];
    if (row === 4) return done(base + 'A');
    if (row === 5) return done(base + 'B');
    if (row === 6) { const d = rb(p++); return done(`${base} $${h2(d)},${ix}`); }
    const e = (rb(p) << 8) | rb(p + 1); p += 2;
    return done(`${base} $${h4(e)}`, base === 'JMP' ? e : null);
  }
  const hi = op >> 4, lo = op & 15, accB = hi >= 0xC, mode = hi & 3;
  let name = (accB ? HI_B : HI_A)[lo];
  if (op === 0x8D) { const o = rb(p++); const t = rel(o); return done(`BSR $${h4(t)}`, t); }
  if (op === 0x8F) return done(regY ? 'XGDY' : 'XGDX');
  if (op === 0xCF) return done('STOP');
  if (lo === 0x3 && !accB && page >= 3) name = 'CPD';
  else if (regY && (lo === 0xC || lo === 0xE || lo === 0xF) && (lo === 0xC ? !accB : accB)) name = name.replace('X', 'Y');
  const wide = lo === 0x3 || lo === 0xC || lo === 0xE;
  let operand, target = null;
  if (mode === 0) { if (wide) { const v = (rb(p) << 8) | rb(p + 1); p += 2; operand = `#$${h4(v)}`; } else { operand = `#$${h2(rb(p++))}`; } }
  else if (mode === 1) { const d = rb(p++); operand = `$${h2(d)}`; if (name === 'JSR') target = d; }
  else if (mode === 2) { operand = `$${h2(rb(p++))},${ix}`; }
  else { const e = (rb(p) << 8) | rb(p + 1); p += 2; operand = `$${h4(e)}`; if (name === 'JSR') target = e; }
  return done(`${name} ${operand}`, target);
}
