// Unit tests for emulator/hc11/cpu.js.  Run from ecu/sbec2/viper:  node emulator/tests/cpu.test.mjs
// Expected values come from the Motorola M68HC11E data sheet Table 4-2 and Reference Manual Appendix A,
// typed in independently of the CPU's own tables.
import { HC11, CC, VEC, opcodeCycles, isLegal, disassemble, PSEL_VECTOR } from '../hc11/cpu.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++; else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${fmt(got)} want ${fmt(want)}`);
}
const fmt = (v) => (typeof v === 'number' ? '$' + v.toString(16).toUpperCase() : JSON.stringify(v));

// ---- test machine: flat 64 KiB RAM ---------------------------------------------------------------
function machine(opts = {}) {
  const mem = new Uint8Array(65536);
  const bus = {
    read8: (a) => mem[a],
    write8: (a, v) => { mem[a] = v; },
    ...opts.bus,
  };
  // default vectors -> distinctive addresses
  const vec = (v, t) => { mem[v] = t >> 8; mem[v + 1] = t & 0xFF; };
  vec(VEC.RESET, 0x2000);
  for (let v = 0xFFD6; v < 0xFFFE; v += 2) vec(v, 0xE000 + (v - 0xFFD6) * 0x10); // E000.. per vector
  const cpu = new HC11(bus, opts.cpu);
  return { cpu, mem, vec };
}
const vtarget = (v) => 0xE000 + (v - 0xFFD6) * 0x10;

// Run program bytes at 0x2000 for one step with initial registers; returns {cpu, mem, cyc}.
function run1(bytes, regs = {}, setup) {
  const m = machine();
  m.mem.set(bytes, 0x2000);
  m.cpu.reset();
  m.cpu.setState({ CCR: 0x00, SP: 0x01FF, ...regs });
  if (setup) setup(m);
  const cyc = m.cpu.step();
  return { ...m, cyc };
}
const flags = (cpu) => cpu.CCR & 0x2F; // H N Z V C
const F = (s) => s.split('').reduce((a, ch) => a | ({ H: CC.H, N: CC.N, Z: CC.Z, V: CC.V, C: CC.C }[ch] || 0), 0);

// ---- reset ---------------------------------------------------------------------------------------
{
  const m = machine(); m.cpu.reset();
  eq('reset PC from FFFE', m.cpu.PC, 0x2000);
  eq('reset sets S X I', m.cpu.CCR & 0xD0, 0xD0);
}

// ---- ADD / ADC -----------------------------------------------------------------------------------
{
  let r = run1([0x8B, 0x01], { A: 0x7F });
  eq('ADDA 7F+01', r.cpu.A, 0x80); eq('ADDA 7F+01 flags', flags(r.cpu), F('HNV'));
  r = run1([0x8B, 0x01], { A: 0xFF });
  eq('ADDA FF+01', r.cpu.A, 0x00); eq('ADDA FF+01 flags', flags(r.cpu), F('HZC'));
  r = run1([0x8B, 0x80], { A: 0x80 });
  eq('ADDA 80+80 flags', flags(r.cpu), F('ZVC'));
  r = run1([0xCB, 0x10], { B: 0x10 });
  eq('ADDB 10+10', r.cpu.B, 0x20); eq('ADDB flags', flags(r.cpu), 0);
  r = run1([0x89, 0x00], { A: 0xFF, CCR: CC.C });
  eq('ADCA FF+00+C', r.cpu.A, 0x00); eq('ADCA flags', flags(r.cpu), F('HZC'));
  r = run1([0xC9, 0x0F], { B: 0x00, CCR: CC.C });
  eq('ADCB 00+0F+C', r.cpu.B, 0x10); eq('ADCB H', flags(r.cpu), F('H'));
  r = run1([0x1B], { A: 0x45, B: 0x45 });
  eq('ABA', r.cpu.A, 0x8A); eq('ABA flags', flags(r.cpu), F('NV')); eq('ABA cycles', r.cyc, 2);
  // ADD leaves H; SUB must not touch H
  r = run1([0x80, 0x01], { A: 0x10, CCR: CC.H });
  eq('SUBA keeps H', r.cpu.CCR & CC.H, CC.H);
}

// ---- SUB / SBC / CMP / 16-bit ---------------------------------------------------------------------
{
  let r = run1([0x80, 0x01], { A: 0x00 });
  eq('SUBA 00-01', r.cpu.A, 0xFF); eq('SUBA 00-01 flags', flags(r.cpu), F('NC'));
  r = run1([0x80, 0x01], { A: 0x80 });
  eq('SUBA 80-01', r.cpu.A, 0x7F); eq('SUBA 80-01 flags', flags(r.cpu), F('V'));
  r = run1([0x80, 0x80], { A: 0x00 });
  eq('SUBA 00-80 flags', flags(r.cpu), F('NVC'));
  r = run1([0x82, 0x00], { A: 0x00, CCR: CC.C });
  eq('SBCA 00-00-C', r.cpu.A, 0xFF); eq('SBCA flags', flags(r.cpu), F('NC'));
  r = run1([0xC2, 0x01], { B: 0x03, CCR: CC.C });
  eq('SBCB 03-01-C', r.cpu.B, 0x01); eq('SBCB flags', flags(r.cpu), 0);
  r = run1([0x81, 0x05], { A: 0x05 });
  eq('CMPA equal A unchanged', r.cpu.A, 0x05); eq('CMPA equal flags', flags(r.cpu), F('Z'));
  r = run1([0xC1, 0x06], { B: 0x05 });
  eq('CMPB less flags', flags(r.cpu), F('NC'));
  r = run1([0x10], { A: 0x05, B: 0x07 });
  eq('SBA', r.cpu.A, 0xFE); eq('SBA flags', flags(r.cpu), F('NC'));
  r = run1([0x11], { A: 0x05, B: 0x05 });
  eq('CBA flags', flags(r.cpu), F('Z')); eq('CBA A', r.cpu.A, 5);
  r = run1([0x83, 0x00, 0x01], { D: 0x8000 });
  eq('SUBD 8000-1', r.cpu.D, 0x7FFF); eq('SUBD flags', flags(r.cpu), F('V')); eq('SUBD imm cyc', r.cyc, 4);
  r = run1([0xC3, 0x00, 0x01], { D: 0xFFFF });
  eq('ADDD FFFF+1', r.cpu.D, 0); eq('ADDD flags', flags(r.cpu), F('ZC')); eq('ADDD imm cyc', r.cyc, 4);
  r = run1([0xC3, 0x40, 0x00], { D: 0x4000 });
  eq('ADDD 4000+4000 flags', flags(r.cpu), F('NV'));
  r = run1([0x1A, 0x83, 0x12, 0x34], { D: 0x1234 });
  eq('CPD imm equal', flags(r.cpu), F('Z')); eq('CPD keeps D', r.cpu.D, 0x1234); eq('CPD imm cyc', r.cyc, 5);
  r = run1([0x8C, 0x00, 0x10], { X: 0x0008 });
  eq('CPX imm less', flags(r.cpu), F('NC')); eq('CPX imm cyc', r.cyc, 4);
  r = run1([0x18, 0x8C, 0x00, 0x10], { Y: 0x0010 });
  eq('CPY imm equal', flags(r.cpu), F('Z')); eq('CPY imm cyc', r.cyc, 5);
}

// ---- unary: NEG COM INC DEC TST CLR shifts/rotates ------------------------------------------------
{
  let r = run1([0x40], { A: 0x80 }); eq('NEGA 80', r.cpu.A, 0x80); eq('NEGA 80 flags', flags(r.cpu), F('NVC'));
  r = run1([0x40], { A: 0x00 }); eq('NEGA 00 flags', flags(r.cpu), F('Z'));
  r = run1([0x50], { B: 0x01 }); eq('NEGB 01', r.cpu.B, 0xFF); eq('NEGB 01 flags', flags(r.cpu), F('NC'));
  r = run1([0x43], { A: 0x0F }); eq('COMA', r.cpu.A, 0xF0); eq('COMA flags', flags(r.cpu), F('NC'));
  r = run1([0x4C], { A: 0x7F }); eq('INCA 7F', r.cpu.A, 0x80); eq('INCA 7F flags', flags(r.cpu), F('NV'));
  r = run1([0x4C], { A: 0xFF, CCR: CC.C }); eq('INCA FF', r.cpu.A, 0); eq('INCA FF keeps C', flags(r.cpu), F('ZC'));
  r = run1([0x4A], { A: 0x80 }); eq('DECA 80', r.cpu.A, 0x7F); eq('DECA 80 flags', flags(r.cpu), F('V'));
  r = run1([0x5A], { B: 0x01, CCR: CC.C }); eq('DECB 01 flags', flags(r.cpu), F('ZC'));
  r = run1([0x4D], { A: 0x80, CCR: CC.V | CC.C }); eq('TSTA flags', flags(r.cpu), F('N'));
  r = run1([0x5F], { B: 0x55, CCR: CC.N | CC.V | CC.C }); eq('CLRB', r.cpu.B, 0); eq('CLRB flags', flags(r.cpu), F('Z'));
  r = run1([0x48], { A: 0x80 }); eq('ASLA 80', r.cpu.A, 0); eq('ASLA 80 flags', flags(r.cpu), F('ZVC'));
  r = run1([0x48], { A: 0x40 }); eq('ASLA 40 flags', flags(r.cpu), F('NV'));
  r = run1([0x48], { A: 0xC0 }); eq('ASLA C0 flags', flags(r.cpu), F('NC'));
  r = run1([0x47], { A: 0x81 }); eq('ASRA 81', r.cpu.A, 0xC0); eq('ASRA 81 flags', flags(r.cpu), F('NC'));
  r = run1([0x57], { B: 0x02 }); eq('ASRB 02', r.cpu.B, 0x01); eq('ASRB flags', flags(r.cpu), 0);
  r = run1([0x44], { A: 0x01 }); eq('LSRA 01', r.cpu.A, 0); eq('LSRA flags', flags(r.cpu), F('ZVC'));
  r = run1([0x54], { B: 0x80 }); eq('LSRB 80', r.cpu.B, 0x40); eq('LSRB flags', flags(r.cpu), 0);
  r = run1([0x49], { A: 0x80, CCR: CC.C }); eq('ROLA 80 C', r.cpu.A, 0x01); eq('ROLA flags', flags(r.cpu), F('VC'));
  r = run1([0x59], { B: 0x40 }); eq('ROLB 40', r.cpu.B, 0x80); eq('ROLB flags', flags(r.cpu), F('NV'));
  r = run1([0x46], { A: 0x01, CCR: CC.C }); eq('RORA 01 C', r.cpu.A, 0x80); eq('RORA flags', flags(r.cpu), F('NC'));
  r = run1([0x56], { B: 0x02 }); eq('RORB 02', r.cpu.B, 0x01); eq('RORB flags', flags(r.cpu), 0);
  // memory forms
  r = run1([0x70, 0x30, 0x00], {}, (m) => { m.mem[0x3000] = 0x01; });
  eq('NEG ext', r.mem[0x3000], 0xFF); eq('NEG ext cyc', r.cyc, 6);
  r = run1([0x6C, 0x05], { X: 0x3000 }, (m) => { m.mem[0x3005] = 0x7F; });
  eq('INC ,X', r.mem[0x3005], 0x80); eq('INC ,X V', flags(r.cpu), F('NV')); eq('INC ,X cyc', r.cyc, 6);
  r = run1([0x18, 0x6A, 0x02], { Y: 0x3000 }, (m) => { m.mem[0x3002] = 0x00; });
  eq('DEC ,Y', r.mem[0x3002], 0xFF); eq('DEC ,Y cyc', r.cyc, 7);
  r = run1([0x7D, 0x30, 0x00], {}, (m) => { m.mem[0x3000] = 0x00; });
  eq('TST ext Z', flags(r.cpu), F('Z')); eq('TST ext cyc', r.cyc, 6);
  r = run1([0x18, 0x6F, 0x01], { Y: 0x3000 }, (m) => { m.mem[0x3001] = 0xAA; });
  eq('CLR ,Y', r.mem[0x3001], 0); eq('CLR ,Y cyc', r.cyc, 7);
  r = run1([0x79, 0x30, 0x00], { CCR: CC.C }, (m) => { m.mem[0x3000] = 0x80; });
  eq('ROL ext', r.mem[0x3000], 0x01); eq('ROL ext flags', flags(r.cpu), F('VC'));
  r = run1([0x64, 0x00], { X: 0x3000 }, (m) => { m.mem[0x3000] = 0x03; });
  eq('LSR ,X', r.mem[0x3000], 0x01); eq('LSR ,X flags', flags(r.cpu), F('VC'));
  r = run1([0x77, 0x30, 0x00], {}, (m) => { m.mem[0x3000] = 0x80; });
  eq('ASR ext', r.mem[0x3000], 0xC0); eq('ASR ext flags', flags(r.cpu), F('NV'));
  // 16-bit shifts
  r = run1([0x04], { D: 0x0001 }); eq('LSRD 0001', r.cpu.D, 0); eq('LSRD flags', flags(r.cpu), F('ZVC')); eq('LSRD cyc', r.cyc, 3);
  r = run1([0x05], { D: 0x8001 }); eq('ASLD 8001', r.cpu.D, 0x0002); eq('ASLD flags', flags(r.cpu), F('VC')); eq('ASLD cyc', r.cyc, 3);
  r = run1([0x05], { D: 0x4000 }); eq('ASLD 4000 flags', flags(r.cpu), F('NV'));
}

// ---- DAA -----------------------------------------------------------------------------------------
{
  // program: LDAA #a ; ADDA #b ; DAA  (or ADCA when carry wanted)
  function daa(a, b, cin = 0) {
    const m = machine();
    m.mem.set([0x86, a, cin ? 0x89 : 0x8B, b, 0x19], 0x2000);
    m.cpu.reset(); m.cpu.setState({ CCR: cin ? CC.C : 0 });
    m.cpu.step(); m.cpu.step(); const c = m.cpu.step();
    return { A: m.cpu.A, C: m.cpu.CCR & CC.C, Z: m.cpu.CCR & CC.Z, N: m.cpu.CCR & CC.N, cyc: c };
  }
  let d = daa(0x99, 0x22); eq('DAA 99+22 (manual example) A', d.A, 0x21); eq('DAA 99+22 C', d.C, 1); eq('DAA cyc', d.cyc, 2);
  d = daa(0x09, 0x08); eq('DAA 09+08 (H set) A', d.A, 0x17); eq('DAA 09+08 C', d.C, 0);
  d = daa(0x12, 0x34); eq('DAA 12+34 A', d.A, 0x46); eq('DAA 12+34 C', d.C, 0);
  d = daa(0x15, 0x05); eq('DAA 15+05 (low A-F) A', d.A, 0x20);
  d = daa(0x50, 0x50); eq('DAA 50+50 (high A-F) A', d.A, 0x00); eq('DAA 50+50 C', d.C, 1); eq('DAA 50+50 Z', d.Z, CC.Z);
  d = daa(0x55, 0x45); eq('DAA 55+45 A', d.A, 0x00); eq('DAA 55+45 C', d.C, 1);
  d = daa(0x90, 0x90); eq('DAA 90+90 (C in) A', d.A, 0x80); eq('DAA 90+90 C', d.C, 1); eq('DAA 90+90 N', d.N, CC.N);
  d = daa(0x99, 0x99); eq('DAA 99+99 (C,H) A', d.A, 0x98); eq('DAA 99+99 C', d.C, 1);
  d = daa(0x99, 0x00, 1); eq('DAA 99+00+1 A', d.A, 0x00); eq('DAA 99+00+1 C', d.C, 1);
  d = daa(0x28, 0x19); eq('DAA 28+19 A', d.A, 0x47);
  // exhaustive: every valid BCD pair with and without carry-in
  let bad = 0;
  for (let x = 0; x < 100; x++) for (let y = 0; y < 100; y++) for (const ci of [0, 1]) {
    const bx = ((x / 10) | 0) * 16 + (x % 10), by = ((y / 10) | 0) * 16 + (y % 10);
    const s = x + y + ci, r = daa(bx, by, ci);
    const want = (((s % 100) / 10) | 0) * 16 + (s % 10);
    if (r.A !== want || r.C !== (s >= 100 ? 1 : 0)) bad++;
  }
  eq('DAA exhaustive BCD pairs mismatches', bad, 0);
}

// ---- MUL / IDIV / FDIV ---------------------------------------------------------------------------
{
  let r = run1([0x3D], { A: 0x80, B: 0x01 }); eq('MUL 80*01', r.cpu.D, 0x0080); eq('MUL C=B7', r.cpu.CCR & CC.C, CC.C); eq('MUL cyc', r.cyc, 10);
  r = run1([0x3D], { A: 0xFF, B: 0xFF, CCR: CC.Z | CC.N }); eq('MUL FF*FF', r.cpu.D, 0xFE01); eq('MUL FF*FF C', r.cpu.CCR & CC.C, 0);
  eq('MUL leaves N Z', r.cpu.CCR & (CC.N | CC.Z), CC.Z | CC.N);
  r = run1([0x02], { D: 1000, X: 7 }); eq('IDIV q', r.cpu.X, 142); eq('IDIV r', r.cpu.D, 6); eq('IDIV flags', flags(r.cpu), 0); eq('IDIV cyc', r.cyc, 41);
  r = run1([0x02], { D: 5, X: 7, CCR: CC.V }); eq('IDIV q=0', r.cpu.X, 0); eq('IDIV r', r.cpu.D, 5); eq('IDIV Z, V cleared', flags(r.cpu), F('Z'));
  r = run1([0x02], { D: 0x1234, X: 0 }); eq('IDIV /0 X', r.cpu.X, 0xFFFF); eq('IDIV /0 C', flags(r.cpu), F('C'));
  r = run1([0x02], { D: 0xFFFF, X: 1 }); eq('IDIV FFFF/1', r.cpu.X, 0xFFFF); eq('IDIV FFFF/1 r', r.cpu.D, 0);
  r = run1([0x03], { D: 1, X: 2 }); eq('FDIV 1/2', r.cpu.X, 0x8000); eq('FDIV 1/2 r', r.cpu.D, 0); eq('FDIV flags', flags(r.cpu), 0); eq('FDIV cyc', r.cyc, 41);
  r = run1([0x03], { D: 1, X: 3 }); eq('FDIV 1/3', r.cpu.X, 0x5555); eq('FDIV 1/3 r', r.cpu.D, 1);
  r = run1([0x03], { D: 5, X: 3 }); eq('FDIV overflow X', r.cpu.X, 0xFFFF); eq('FDIV overflow V', flags(r.cpu), F('V'));
  r = run1([0x03], { D: 3, X: 3 }); eq('FDIV equal -> overflow', flags(r.cpu) & CC.V, CC.V);
  r = run1([0x03], { D: 0, X: 0 }); eq('FDIV /0 X', r.cpu.X, 0xFFFF); eq('FDIV /0 C', r.cpu.CCR & CC.C, CC.C);
  r = run1([0x03], { D: 0, X: 5 }); eq('FDIV 0/5 Z', flags(r.cpu), F('Z'));
}

// ---- logic / loads / stores and every addressing mode ---------------------------------------------
{
  const setup = (m) => { m.mem[0x0042] = 0x81; m.mem[0x3456] = 0x82; m.mem[0x3010] = 0x83; m.mem[0x4020] = 0x84; };
  let r = run1([0x86, 0x80], { CCR: CC.V }); eq('LDAA imm', r.cpu.A, 0x80); eq('LDAA flags V cleared', flags(r.cpu), F('N')); eq('LDAA imm cyc', r.cyc, 2);
  r = run1([0x96, 0x42], {}, setup); eq('LDAA dir', r.cpu.A, 0x81); eq('LDAA dir cyc', r.cyc, 3);
  r = run1([0xB6, 0x34, 0x56], {}, setup); eq('LDAA ext', r.cpu.A, 0x82); eq('LDAA ext cyc', r.cyc, 4);
  r = run1([0xA6, 0x10], { X: 0x3000 }, setup); eq('LDAA ,X', r.cpu.A, 0x83); eq('LDAA ,X cyc', r.cyc, 4);
  r = run1([0x18, 0xA6, 0x20], { Y: 0x4000 }, setup); eq('LDAA ,Y', r.cpu.A, 0x84); eq('LDAA ,Y cyc', r.cyc, 5);
  r = run1([0xE6, 0xFF], { X: 0x3F11 }, (m) => { m.mem[0x4010] = 0x99; }); eq('LDAB ,X offset FF is unsigned (3F11+FF)', r.cpu.B, 0x99);
  r = run1([0xE6, 0xFF], { X: 0xFFF0 }, (m) => { m.mem[0x00EF] = 0x5C; }); eq(',X wraps at 64K', r.cpu.B, 0x5C);
  r = run1([0xD6, 0x42], {}, setup); eq('LDAB dir', r.cpu.B, 0x81);
  r = run1([0x97, 0x50], { A: 0x00, CCR: CC.N | CC.V }); eq('STAA dir', r.mem[0x50], 0); eq('STAA flags', flags(r.cpu), F('Z')); eq('STAA dir cyc', r.cyc, 3);
  r = run1([0xB7, 0x30, 0x00], { A: 0x5A }); eq('STAA ext', r.mem[0x3000], 0x5A); eq('STAA ext cyc', r.cyc, 4);
  r = run1([0x18, 0xE7, 0x01], { B: 0xA5, Y: 0x3000 }); eq('STAB ,Y', r.mem[0x3001], 0xA5); eq('STAB ,Y cyc', r.cyc, 5);
  r = run1([0x84, 0x0F], { A: 0xF5, CCR: CC.V }); eq('ANDA', r.cpu.A, 0x05); eq('ANDA flags', flags(r.cpu), 0);
  r = run1([0x85, 0x0F], { A: 0xF0 }); eq('BITA zero', flags(r.cpu), F('Z')); eq('BITA keeps A', r.cpu.A, 0xF0);
  r = run1([0xC8, 0xFF], { B: 0x0F }); eq('EORB', r.cpu.B, 0xF0); eq('EORB N', flags(r.cpu), F('N'));
  r = run1([0x8A, 0x80], { A: 0x01 }); eq('ORAA', r.cpu.A, 0x81);
  r = run1([0xCC, 0x80, 0x01]); eq('LDD imm', r.cpu.D, 0x8001); eq('LDD imm cyc', r.cyc, 3); eq('LDD flags', flags(r.cpu), F('N'));
  r = run1([0xDC, 0x42], {}, (m) => { m.mem[0x42] = 0x12; m.mem[0x43] = 0x34; }); eq('LDD dir', r.cpu.D, 0x1234); eq('LDD dir cyc', r.cyc, 4);
  r = run1([0x18, 0xEC, 0x02], { Y: 0x3000 }, (m) => { m.mem[0x3002] = 0xAB; m.mem[0x3003] = 0xCD; }); eq('LDD ,Y', r.cpu.D, 0xABCD); eq('LDD ,Y cyc', r.cyc, 6);
  r = run1([0xFD, 0x30, 0x00], { D: 0xBEEF }); eq('STD ext', (r.mem[0x3000] << 8) | r.mem[0x3001], 0xBEEF); eq('STD ext cyc', r.cyc, 5);
  r = run1([0xED, 0x00], { D: 0x0000, X: 0x3000 }); eq('STD ,X Z', flags(r.cpu), F('Z')); eq('STD ,X cyc', r.cyc, 5);
  r = run1([0xCE, 0x12, 0x34]); eq('LDX imm', r.cpu.X, 0x1234); eq('LDX imm cyc', r.cyc, 3);
  r = run1([0xFE, 0x30, 0x00], {}, (m) => { m.mem[0x3000] = 0x55; m.mem[0x3001] = 0x66; }); eq('LDX ext', r.cpu.X, 0x5566); eq('LDX ext cyc', r.cyc, 5);
  r = run1([0xCD, 0xEE, 0x00], { Y: 0x3000 }, (m) => { m.mem[0x3000] = 0x77; m.mem[0x3001] = 0x88; }); eq('LDX ,Y (CD EE)', r.cpu.X, 0x7788); eq('LDX ,Y cyc', r.cyc, 6);
  r = run1([0xCD, 0xEF, 0x04], { X: 0x1357, Y: 0x3000 }); eq('STX ,Y (CD EF)', (r.mem[0x3004] << 8) | r.mem[0x3005], 0x1357); eq('STX ,Y cyc', r.cyc, 6);
  r = run1([0x18, 0xCE, 0x9A, 0xBC]); eq('LDY imm', r.cpu.Y, 0x9ABC); eq('LDY imm cyc', r.cyc, 4); eq('LDY N', flags(r.cpu), F('N'));
  r = run1([0x18, 0xDE, 0x42], {}, (m) => { m.mem[0x42] = 1; m.mem[0x43] = 2; }); eq('LDY dir', r.cpu.Y, 0x0102); eq('LDY dir cyc', r.cyc, 5);
  r = run1([0x18, 0xFE, 0x30, 0x00], {}, (m) => { m.mem[0x3000] = 3; m.mem[0x3001] = 4; }); eq('LDY ext', r.cpu.Y, 0x0304); eq('LDY ext cyc', r.cyc, 6);
  r = run1([0x1A, 0xEE, 0x02], { X: 0x3000 }, (m) => { m.mem[0x3002] = 5; m.mem[0x3003] = 6; }); eq('LDY ,X (1A EE)', r.cpu.Y, 0x0506); eq('LDY ,X cyc', r.cyc, 6);
  r = run1([0x18, 0xEE, 0x02], { Y: 0x3000 }, (m) => { m.mem[0x3002] = 7; m.mem[0x3003] = 8; }); eq('LDY ,Y (18 EE)', r.cpu.Y, 0x0708); eq('LDY ,Y cyc', r.cyc, 6);
  r = run1([0x1A, 0xEF, 0x00], { X: 0x3000, Y: 0x2468 }); eq('STY ,X (1A EF)', (r.mem[0x3000] << 8) | r.mem[0x3001], 0x2468); eq('STY ,X cyc', r.cyc, 6);
  r = run1([0x18, 0xDF, 0x60], { Y: 0x1111 }); eq('STY dir', (r.mem[0x60] << 8) | r.mem[0x61], 0x1111); eq('STY dir cyc', r.cyc, 5);
  r = run1([0x18, 0xFF, 0x30, 0x00], { Y: 0x2222 }); eq('STY ext', r.mem[0x3001], 0x22); eq('STY ext cyc', r.cyc, 6);
  r = run1([0x8E, 0x01, 0xFF]); eq('LDS imm', r.cpu.SP, 0x01FF); eq('LDS imm cyc', r.cyc, 3);
  r = run1([0x9F, 0x70], { SP: 0x0123 }); eq('STS dir', (r.mem[0x70] << 8) | r.mem[0x71], 0x0123); eq('STS dir cyc', r.cyc, 4);
  r = run1([0x18, 0xAF, 0x00], { SP: 0x0456, Y: 0x3000 }); eq('STS ,Y', r.mem[0x3001], 0x56); eq('STS ,Y cyc', r.cyc, 6);
  // compares in every prebyte form
  const w = (a, v) => (m) => { m.mem[a] = v >> 8; m.mem[a + 1] = v & 0xFF; };
  r = run1([0x1A, 0x93, 0x40], { D: 0x1000 }, w(0x40, 0x1000)); eq('CPD dir', flags(r.cpu), F('Z')); eq('CPD dir cyc', r.cyc, 6);
  r = run1([0x1A, 0xB3, 0x30, 0x00], { D: 0x1000 }, w(0x3000, 0x2000)); eq('CPD ext', flags(r.cpu), F('NC')); eq('CPD ext cyc', r.cyc, 7);
  r = run1([0x1A, 0xA3, 0x00], { D: 0x1000, X: 0x3000 }, w(0x3000, 0x1000)); eq('CPD ,X', flags(r.cpu), F('Z')); eq('CPD ,X cyc', r.cyc, 7);
  r = run1([0xCD, 0xA3, 0x00], { D: 0x1000, Y: 0x3000 }, w(0x3000, 0x1000)); eq('CPD ,Y', flags(r.cpu), F('Z')); eq('CPD ,Y cyc', r.cyc, 7);
  r = run1([0x1A, 0xAC, 0x00], { Y: 0x5555, X: 0x3000 }, w(0x3000, 0x5555)); eq('CPY ,X (1A AC)', flags(r.cpu), F('Z')); eq('CPY ,X cyc', r.cyc, 7);
  r = run1([0x18, 0xAC, 0x00], { Y: 0x3000 }, w(0x3000, 0x3000)); eq('CPY ,Y (18 AC)', flags(r.cpu), F('Z')); eq('CPY ,Y cyc', r.cyc, 7);
  r = run1([0xCD, 0xAC, 0x00], { X: 0x4444, Y: 0x3000 }, w(0x3000, 0x4444)); eq('CPX ,Y (CD AC)', flags(r.cpu), F('Z')); eq('CPX ,Y cyc', r.cyc, 7);
  r = run1([0x18, 0x9C, 0x40], { Y: 0x0001 }, w(0x40, 0x0002)); eq('CPY dir', flags(r.cpu), F('NC')); eq('CPY dir cyc', r.cyc, 6);
  r = run1([0x18, 0xBC, 0x30, 0x00], { Y: 0x0001 }, w(0x3000, 0x0001)); eq('CPY ext cyc', r.cyc, 7);
  r = run1([0x9C, 0x40], { X: 0x8000 }, w(0x40, 0x0001)); eq('CPX dir V', flags(r.cpu), F('V')); eq('CPX dir cyc', r.cyc, 5);
  r = run1([0xAC, 0x00], { X: 0x3000 }, w(0x3000, 0x3000)); eq('CPX ,X cyc', r.cyc, 6);
  r = run1([0x18, 0xA3, 0x00], { D: 3, Y: 0x3000 }, w(0x3000, 1)); eq('SUBD ,Y', r.cpu.D, 2); eq('SUBD ,Y cyc', r.cyc, 7);
  r = run1([0x18, 0xE3, 0x00], { D: 3, Y: 0x3000 }, w(0x3000, 1)); eq('ADDD ,Y', r.cpu.D, 4); eq('ADDD ,Y cyc', r.cyc, 7);
  r = run1([0xF3, 0x30, 0x00], { D: 3 }, w(0x3000, 1)); eq('ADDD ext cyc', r.cyc, 6);
  r = run1([0xD3, 0x40], { D: 3 }, w(0x40, 1)); eq('ADDD dir cyc', r.cyc, 5);
}

// ---- transfers, stack, index ops -----------------------------------------------------------------
{
  let r = run1([0x16], { A: 0x80, CCR: CC.V }); eq('TAB', r.cpu.B, 0x80); eq('TAB flags', flags(r.cpu), F('N'));
  r = run1([0x17], { B: 0x00 }); eq('TBA Z', flags(r.cpu), F('Z'));
  r = run1([0x06], { A: 0xFF, CCR: 0x00 }); eq('TAP cannot set X', r.cpu.CCR, 0xBF);
  r = run1([0x06], { A: 0x00, CCR: 0xFF }); eq('TAP clears X', r.cpu.CCR, 0x00);
  r = run1([0x07], { CCR: 0xD5 }); eq('TPA', r.cpu.A, 0xD5);
  r = run1([0x30], { SP: 0x01F0 }); eq('TSX', r.cpu.X, 0x01F1); eq('TSX cyc', r.cyc, 3);
  r = run1([0x18, 0x30], { SP: 0x01F0 }); eq('TSY', r.cpu.Y, 0x01F1); eq('TSY cyc', r.cyc, 4);
  r = run1([0x35], { X: 0x0200 }); eq('TXS', r.cpu.SP, 0x01FF);
  r = run1([0x18, 0x35], { Y: 0x0200 }); eq('TYS', r.cpu.SP, 0x01FF); eq('TYS cyc', r.cyc, 4);
  r = run1([0x3C], { X: 0x1234, SP: 0x01FF }); eq('PSHX lo at SP', r.mem[0x01FF], 0x34); eq('PSHX hi at SP-1', r.mem[0x01FE], 0x12); eq('PSHX SP', r.cpu.SP, 0x01FD); eq('PSHX cyc', r.cyc, 4);
  r = run1([0x18, 0x3C], { Y: 0xABCD }); eq('PSHY', r.mem[0x01FE], 0xAB); eq('PSHY cyc', r.cyc, 5);
  r = run1([0x38], { SP: 0x01FD }, (m) => { m.mem[0x1FE] = 0x12; m.mem[0x1FF] = 0x34; }); eq('PULX', r.cpu.X, 0x1234); eq('PULX SP', r.cpu.SP, 0x01FF); eq('PULX cyc', r.cyc, 5);
  r = run1([0x18, 0x38], { SP: 0x01FD }, (m) => { m.mem[0x1FE] = 0x56; m.mem[0x1FF] = 0x78; }); eq('PULY', r.cpu.Y, 0x5678); eq('PULY cyc', r.cyc, 6);
  r = run1([0x36], { A: 0x99 }); eq('PSHA', r.mem[0x01FF], 0x99); eq('PSHA cyc', r.cyc, 3);
  r = run1([0x33], { SP: 0x01FE }, (m) => { m.mem[0x1FF] = 0x44; }); eq('PULB', r.cpu.B, 0x44); eq('PULB cyc', r.cyc, 4);
  r = run1([0x8F], { D: 0x1111, X: 0x2222 }); eq('XGDX D', r.cpu.D, 0x2222); eq('XGDX X', r.cpu.X, 0x1111); eq('XGDX cyc', r.cyc, 3);
  r = run1([0x18, 0x8F], { D: 0x1111, Y: 0x3333 }); eq('XGDY D', r.cpu.D, 0x3333); eq('XGDY Y', r.cpu.Y, 0x1111); eq('XGDY cyc', r.cyc, 4);
  r = run1([0x3A], { X: 0x00FF, B: 0xFF }); eq('ABX unsigned B', r.cpu.X, 0x01FE); eq('ABX cyc', r.cyc, 3);
  r = run1([0x18, 0x3A], { Y: 0xFFFF, B: 0x02, CCR: 0 }); eq('ABY wraps', r.cpu.Y, 0x0001); eq('ABY no flags', r.cpu.CCR, 0); eq('ABY cyc', r.cyc, 4);
  r = run1([0x08], { X: 0xFFFF }); eq('INX wrap Z', r.cpu.CCR & CC.Z, CC.Z); eq('INX cyc', r.cyc, 3);
  r = run1([0x18, 0x09], { Y: 0x0001 }); eq('DEY Z', r.cpu.CCR & CC.Z, CC.Z); eq('DEY cyc', r.cyc, 4);
  r = run1([0x18, 0x08], { Y: 0x0001 }); eq('INY', r.cpu.Y, 2); eq('INY cyc', r.cyc, 4);
  r = run1([0x31], { SP: 0x00FF }); eq('INS', r.cpu.SP, 0x0100); eq('INS cyc', r.cyc, 3);
  r = run1([0x34], { SP: 0x0100 }); eq('DES', r.cpu.SP, 0x00FF);
  for (const [op, mask, set] of [[0x0A, CC.V, 0], [0x0B, CC.V, 1], [0x0C, CC.C, 0], [0x0D, CC.C, 1], [0x0E, CC.I, 0], [0x0F, CC.I, 1]]) {
    r = run1([op], { CCR: set ? 0 : 0x3F }); eq(`flag op ${op.toString(16)}`, r.cpu.CCR & mask, set ? mask : 0); eq(`flag op cyc ${op.toString(16)}`, r.cyc, 2);
  }
  r = run1([0x01]); eq('NOP cyc', r.cyc, 2); eq('NOP PC', r.cpu.PC, 0x2001);
}

// ---- branches ------------------------------------------------------------------------------------
{
  // [opcode, CCR that makes it taken, CCR that makes it not taken]
  const tbl = [
    [0x20, 0, null], [0x21, null, 0],
    [0x22, 0, CC.C], [0x23, CC.Z, 0], [0x24, 0, CC.C], [0x25, CC.C, 0], [0x26, 0, CC.Z], [0x27, CC.Z, 0],
    [0x28, 0, CC.V], [0x29, CC.V, 0], [0x2A, 0, CC.N], [0x2B, CC.N, 0],
    [0x2C, CC.N | CC.V, CC.N], [0x2D, CC.V, CC.N | CC.V], [0x2E, 0, CC.Z], [0x2F, CC.N, CC.N | CC.V],
  ];
  for (const [op, t, n] of tbl) {
    if (t !== null) { const r = run1([op, 0x10], { CCR: t }); eq(`branch ${op.toString(16)} taken PC`, r.cpu.PC, 0x2012); eq(`branch ${op.toString(16)} taken cyc`, r.cyc, 3); }
    if (n !== null) { const r = run1([op, 0x10], { CCR: n }); eq(`branch ${op.toString(16)} not taken PC`, r.cpu.PC, 0x2002); eq(`branch ${op.toString(16)} not cyc`, r.cyc, 3); }
  }
  let r = run1([0x20, 0xFE]); eq('BRA * (self loop)', r.cpu.PC, 0x2000);
  r = run1([0x20, 0x80]); eq('BRA -128', r.cpu.PC, 0x2002 - 128);
  r = run1([0x22, 0x10], { CCR: CC.Z }); eq('BHI not taken on Z', r.cpu.PC, 0x2002);
  r = run1([0x2E, 0x10], { CCR: CC.N }); eq('BGT not taken N^V', r.cpu.PC, 0x2002);
  r = run1([0x8D, 0x10], { SP: 0x01FF }); eq('BSR PC', r.cpu.PC, 0x2012); eq('BSR ret lo', r.mem[0x1FF], 0x02); eq('BSR ret hi', r.mem[0x1FE], 0x20); eq('BSR cyc', r.cyc, 6);
  r = run1([0x9D, 0x80]); eq('JSR dir', r.cpu.PC, 0x0080); eq('JSR dir ret', r.mem[0x1FF], 0x02); eq('JSR dir cyc', r.cyc, 5);
  r = run1([0xBD, 0x40, 0x00]); eq('JSR ext', r.cpu.PC, 0x4000); eq('JSR ext ret', r.mem[0x1FF], 0x03); eq('JSR ext cyc', r.cyc, 6);
  r = run1([0xAD, 0x10], { X: 0x4000 }); eq('JSR ,X', r.cpu.PC, 0x4010); eq('JSR ,X cyc', r.cyc, 6);
  r = run1([0x18, 0xAD, 0x10], { Y: 0x4000 }); eq('JSR ,Y', r.cpu.PC, 0x4010); eq('JSR ,Y ret', r.mem[0x1FF], 0x03); eq('JSR ,Y cyc', r.cyc, 7);
  r = run1([0x7E, 0x40, 0x00]); eq('JMP ext', r.cpu.PC, 0x4000); eq('JMP ext cyc', r.cyc, 3);
  r = run1([0x6E, 0x05], { X: 0x4000 }); eq('JMP ,X', r.cpu.PC, 0x4005); eq('JMP ,X cyc', r.cyc, 3);
  r = run1([0x18, 0x6E, 0x05], { Y: 0x4000 }); eq('JMP ,Y', r.cpu.PC, 0x4005); eq('JMP ,Y cyc', r.cyc, 4);
  r = run1([0x39], { SP: 0x01FD }, (m) => { m.mem[0x1FE] = 0x45; m.mem[0x1FF] = 0x67; }); eq('RTS', r.cpu.PC, 0x4567); eq('RTS cyc', r.cyc, 5);
}

// ---- bit manipulation and bit branches ----------------------------------------------------------
{
  let r = run1([0x14, 0x40, 0x81], { CCR: CC.V }, (m) => { m.mem[0x40] = 0x01; }); eq('BSET dir', r.mem[0x40], 0x81); eq('BSET flags', flags(r.cpu), F('N')); eq('BSET dir cyc', r.cyc, 6);
  r = run1([0x15, 0x40, 0x01], {}, (m) => { m.mem[0x40] = 0x01; }); eq('BCLR dir', r.mem[0x40], 0x00); eq('BCLR Z', flags(r.cpu), F('Z')); eq('BCLR dir cyc', r.cyc, 6);
  r = run1([0x1C, 0x02, 0x10], { X: 0x1000 }, (m) => { m.mem[0x1002] = 0x01; }); eq('BSET ,X', r.mem[0x1002], 0x11); eq('BSET ,X cyc', r.cyc, 7);
  r = run1([0x1D, 0x02, 0x01], { X: 0x1000 }, (m) => { m.mem[0x1002] = 0x81; }); eq('BCLR ,X', r.mem[0x1002], 0x80); eq('BCLR ,X cyc', r.cyc, 7);
  r = run1([0x18, 0x1C, 0x02, 0x10], { Y: 0x1000 }, (m) => { m.mem[0x1002] = 0x00; }); eq('BSET ,Y', r.mem[0x1002], 0x10); eq('BSET ,Y cyc', r.cyc, 8);
  r = run1([0x18, 0x1D, 0x02, 0xFF], { Y: 0x1000 }, (m) => { m.mem[0x1002] = 0xFF; }); eq('BCLR ,Y', r.mem[0x1002], 0x00); eq('BCLR ,Y cyc', r.cyc, 8);
  r = run1([0x12, 0x40, 0x81, 0x10], {}, (m) => { m.mem[0x40] = 0x83; }); eq('BRSET dir taken', r.cpu.PC, 0x2014); eq('BRSET dir cyc', r.cyc, 6);
  r = run1([0x12, 0x40, 0x81, 0x10], {}, (m) => { m.mem[0x40] = 0x80; }); eq('BRSET dir not taken (partial)', r.cpu.PC, 0x2004);
  r = run1([0x13, 0x40, 0x81, 0x10], {}, (m) => { m.mem[0x40] = 0x7E; }); eq('BRCLR dir taken', r.cpu.PC, 0x2014);
  r = run1([0x13, 0x40, 0x81, 0x10], {}, (m) => { m.mem[0x40] = 0x01; }); eq('BRCLR dir not taken', r.cpu.PC, 0x2004);
  r = run1([0x1E, 0x25, 0x20, 0xFC], { X: 0x1000 }, (m) => { m.mem[0x1025] = 0x20; }); eq('BRSET ,X taken back', r.cpu.PC, 0x2000); eq('BRSET ,X cyc', r.cyc, 7);
  r = run1([0x1F, 0x25, 0x20, 0xFC], { X: 0x1000 }, (m) => { m.mem[0x1025] = 0x20; }); eq('BRCLR ,X not taken', r.cpu.PC, 0x2004); eq('BRCLR ,X cyc', r.cyc, 7);
  r = run1([0x18, 0x1E, 0x25, 0x20, 0x02], { Y: 0x1000 }, (m) => { m.mem[0x1025] = 0xFF; }); eq('BRSET ,Y taken', r.cpu.PC, 0x2007); eq('BRSET ,Y cyc', r.cyc, 8);
  r = run1([0x18, 0x1F, 0x25, 0x20, 0x02], { Y: 0x1000 }, (m) => { m.mem[0x1025] = 0x00; }); eq('BRCLR ,Y taken', r.cpu.PC, 0x2007); eq('BRCLR ,Y cyc', r.cyc, 8);
  r = run1([0x12, 0x40, 0x00, 0x10], {}, (m) => { m.mem[0x40] = 0x00; }); eq('BRSET mask 0 always taken', r.cpu.PC, 0x2014);
  r = run1([0x14, 0x40, 0x01], { CCR: CC.C }, (m) => { m.mem[0x40] = 0; }); eq('BSET keeps C', r.cpu.CCR & CC.C, CC.C);
}

// ---- SWI / RTI / interrupts ----------------------------------------------------------------------
function frameOK(name, mem, sp, regs) {
  // after stacking SP points one below CCR; order upward: CCR B A XH XL YH YL PCH PCL
  const want = [regs.CCR, regs.B, regs.A, regs.X >> 8, regs.X & 0xFF, regs.Y >> 8, regs.Y & 0xFF, regs.PC >> 8, regs.PC & 0xFF];
  const got = []; for (let i = 1; i <= 9; i++) got.push(mem[(sp + i) & 0xFFFF]);
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${got.map((v) => v.toString(16))} want ${want.map((v) => v.toString(16))}`);
}
{
  const regs = { A: 0x11, B: 0x22, X: 0x3344, Y: 0x5566, SP: 0x01FF, CCR: 0x05 };
  let r = run1([0x3F], regs);
  eq('SWI cycles', r.cyc, 14); eq('SWI SP', r.cpu.SP, 0x01F6); eq('SWI PC', r.cpu.PC, vtarget(VEC.SWI));
  eq('SWI sets I', r.cpu.CCR & CC.I, CC.I);
  frameOK('SWI stack frame order (CCR,B,A,XH,XL,YH,YL,PCH,PCL)', r.mem, r.cpu.SP, { ...regs, PC: 0x2001 });
  eq('SWI PCL at old SP', r.mem[0x01FF], 0x01);
  // RTI back
  r.mem[vtarget(VEC.SWI)] = 0x3B;
  r.cpu.setState({ A: 0, B: 0, X: 0, Y: 0, CCR: 0xD0 });
  const c = r.cpu.step();
  eq('RTI cycles', c, 12); eq('RTI PC', r.cpu.PC, 0x2001); eq('RTI A', r.cpu.A, 0x11); eq('RTI B', r.cpu.B, 0x22);
  eq('RTI X', r.cpu.X, 0x3344); eq('RTI Y', r.cpu.Y, 0x5566); eq('RTI SP', r.cpu.SP, 0x01FF);
  eq('RTI CCR (X cleared by stacked 0)', r.cpu.CCR, 0x05);
  // RTI cannot set X
  const m = machine(); m.cpu.reset();
  m.mem.set([0x3B], 0x2000); m.cpu.setState({ SP: 0x01F6, CCR: 0x00 });
  m.mem.set([0xFF, 0, 0, 0, 0, 0, 0, 0x20, 0x00], 0x01F7);
  m.cpu.step(); eq('RTI cannot set X', m.cpu.CCR, 0xBF);
}
{
  // IRQ (built-in request API)
  const m = machine(); m.mem.set([0x01, 0x01, 0x01], 0x2000); m.cpu.reset();
  m.cpu.setState({ A: 1, B: 2, X: 3, Y: 4, SP: 0x01FF, CCR: CC.I });
  m.cpu.requestInterrupt(VEC.IRQ);
  let c = m.cpu.step(); eq('IRQ masked by I: executes NOP', c, 2); eq('IRQ masked PC', m.cpu.PC, 0x2001);
  m.cpu.CCR = 0x00;
  c = m.cpu.step(); eq('IRQ entry cycles', c, 14); eq('IRQ vector', m.cpu.PC, vtarget(VEC.IRQ)); eq('IRQ sets I', m.cpu.CCR & CC.I, CC.I);
  eq('IRQ leaves X', m.cpu.CCR & CC.X, 0);
  frameOK('IRQ stack frame', m.mem, m.cpu.SP, { A: 1, B: 2, X: 3, Y: 4, CCR: 0x00, PC: 0x2001 });
  // priority: IRQ beats TOF; promoted vector beats IRQ
  m.cpu.clearInterrupt(VEC.IRQ);
  m.cpu.setState({ PC: 0x2000, SP: 0x01FF, CCR: 0 });
  m.cpu.requestInterrupt(VEC.TOF); m.cpu.requestInterrupt(VEC.SCI); m.cpu.requestInterrupt(VEC.TOC1);
  m.cpu.step(); eq('priority OC1 over TOF/SCI', m.cpu.PC, vtarget(VEC.TOC1));
  m.cpu.setState({ PC: 0x2000, SP: 0x01FF, CCR: 0 });
  m.cpu.promotedVector = PSEL_VECTOR[0x4]; // SCI
  m.cpu.step(); eq('HPRIO promoted SCI first', m.cpu.PC, vtarget(VEC.SCI));
  eq('PSEL table OC5', PSEL_VECTOR[15], VEC.TOC5);
}
{
  // XIRQ: masked when X=1 (even with I=0); non-maskable by I; sets X and I
  const m = machine(); m.mem.set([0x01, 0x01, 0x01], 0x2000); m.cpu.reset();
  m.cpu.setState({ SP: 0x01FF, CCR: CC.X });
  m.cpu.setXIRQ(true);
  let c = m.cpu.step(); eq('XIRQ ignored with X=1', c, 2);
  m.cpu.CCR = CC.I; // X cleared, I set
  c = m.cpu.step(); eq('XIRQ taken with I=1', m.cpu.PC, vtarget(VEC.XIRQ)); eq('XIRQ cycles', c, 14);
  eq('XIRQ sets X and I', m.cpu.CCR & (CC.X | CC.I), CC.X | CC.I);
  eq('XIRQ stacked CCR had X=0', m.mem[m.cpu.SP + 1], CC.I);
  // XIRQ beats IRQ
  const m2 = machine(); m2.mem.set([0x01], 0x2000); m2.cpu.reset(); m2.cpu.setState({ SP: 0x01FF, CCR: 0 });
  m2.cpu.requestInterrupt(VEC.IRQ); m2.cpu.setXIRQ(true); m2.cpu.step(); eq('XIRQ before IRQ', m2.cpu.PC, vtarget(VEC.XIRQ));
  // machine-supplied callbacks
  const acks = [];
  const m3 = machine({ bus: { getPendingVector: () => VEC.TIC2, xirqAsserted: () => false, onInterrupt: (v) => acks.push(v) } });
  m3.mem.set([0x01], 0x2000); m3.cpu.reset(); m3.cpu.setState({ SP: 0x01FF, CCR: 0 });
  m3.cpu.step(); eq('getPendingVector used', m3.cpu.PC, vtarget(VEC.TIC2)); eq('onInterrupt ack', acks[0], VEC.TIC2);
}
{
  // WAI: 12 cycles stacking, idle 1-cycle steps, wake -> 2 cycles, no second stacking
  const m = machine(); m.mem.set([0x3E, 0x01], 0x2000); m.cpu.reset();
  m.cpu.setState({ A: 9, B: 8, X: 7, Y: 6, SP: 0x01FF, CCR: 0 });
  let c = m.cpu.step(); eq('WAI cycles', c, 12); eq('WAI waiting', m.cpu.waiting, true); eq('WAI SP', m.cpu.SP, 0x01F6);
  frameOK('WAI stack frame', m.mem, m.cpu.SP, { A: 9, B: 8, X: 7, Y: 6, CCR: 0, PC: 0x2001 });
  c = m.cpu.step(); eq('WAI idle step', c, 1); eq('WAI still waiting', m.cpu.waiting, true);
  m.cpu.requestInterrupt(VEC.RTII);
  c = m.cpu.step(); eq('WAI wake cycles', c, 2); eq('WAI wake vector', m.cpu.PC, vtarget(VEC.RTII));
  eq('WAI wake SP unchanged', m.cpu.SP, 0x01F6); eq('WAI wake sets I', m.cpu.CCR & CC.I, CC.I); eq('WAI no longer waiting', m.cpu.waiting, false);
  // RTI resumes after WAI
  m.cpu.clearInterrupt(VEC.RTII);
  m.mem[vtarget(VEC.RTII)] = 0x3B; m.cpu.step();
  eq('RTI after WAI resumes at next instr', m.cpu.PC, 0x2001); eq('RTI after WAI A', m.cpu.A, 9);
  // masked WAI stays waiting; XIRQ wake from WAI
  const m2 = machine(); m2.mem.set([0x3E], 0x2000); m2.cpu.reset(); m2.cpu.setState({ SP: 0x01FF, CCR: CC.I });
  m2.cpu.step(); m2.cpu.requestInterrupt(VEC.IRQ); eq('WAI masked IRQ stays', m2.cpu.step(), 1);
  m2.cpu.setXIRQ(true); eq('WAI XIRQ wake', m2.cpu.step(), 2); eq('WAI XIRQ vector', m2.cpu.PC, vtarget(VEC.XIRQ));
  eq('WAI XIRQ sets X', m2.cpu.CCR & CC.X, CC.X);
}
{
  // STOP
  let r = run1([0xCF, 0x01], { CCR: CC.S }); eq('STOP with S=1 is NOP', r.cpu.stopped, false); eq('STOP S=1 cyc', r.cyc, 2); eq('STOP S=1 PC', r.cpu.PC, 0x2001);
  const m = machine(); m.mem.set([0xCF, 0x01], 0x2000); m.cpu.reset(); m.cpu.setState({ SP: 0x01FF, CCR: CC.X | CC.I });
  m.cpu.step(); eq('STOP S=0 stops', m.cpu.stopped, true);
  eq('STOP idle', m.cpu.step(), 1); eq('STOP PC holds', m.cpu.PC, 0x2001);
  m.cpu.requestInterrupt(VEC.IRQ); eq('STOP ignores masked IRQ', m.cpu.step(), 1);
  m.cpu.setXIRQ(true); m.cpu.step(); eq('STOP XIRQ with X=1 continues', m.cpu.stopped, false); eq('STOP-continue PC', m.cpu.PC, 0x2001);
  eq('STOP-continue no stacking', m.cpu.SP, 0x01FF);
  const m2 = machine(); m2.mem.set([0xCF], 0x2000); m2.cpu.reset(); m2.cpu.setState({ SP: 0x01FF, CCR: 0 });
  m2.cpu.step(); m2.cpu.requestInterrupt(VEC.IRQ);
  eq('STOP IRQ wake cycles', m2.cpu.step(), 14); eq('STOP IRQ wake vector', m2.cpu.PC, vtarget(VEC.IRQ)); eq('STOP IRQ stacked PC', m2.mem[0x01FF], 0x01);
}
{
  // illegal opcodes
  const ill = [];
  const m = machine({ bus: { onIllegal: (a, b) => ill.push([a, b]) } });
  m.mem.set([0x41], 0x2000); m.cpu.reset(); m.cpu.setState({ SP: 0x01FF, CCR: 0 });
  let c = m.cpu.step(); eq('illegal 41 vector', m.cpu.PC, vtarget(VEC.ILLEGAL)); eq('illegal stacked PC = opcode addr', (m.mem[0x1FE] << 8) | m.mem[0x1FF], 0x2000);
  eq('illegal sets I', m.cpu.CCR & CC.I, CC.I); eq('illegal cycles', c, 14); eq('onIllegal called', ill.length, 1);
  const m2 = machine(); m2.mem.set([0x18, 0x86], 0x3000); m2.cpu.reset(); m2.cpu.setState({ PC: 0x3000, SP: 0x01FF, CCR: 0 });
  m2.cpu.step(); eq('illegal 18 86 vector', m2.cpu.PC, vtarget(VEC.ILLEGAL)); eq('illegal 18 86 stacked prebyte addr', (m2.mem[0x1FE] << 8) | m2.mem[0x1FF], 0x3000);
  const m3 = machine(); m3.mem.set([0x00], 0x2000); m3.cpu.reset(); m3.cpu.setState({ SP: 0x01FF, CCR: 0 });
  m3.cpu.step(); eq('TEST outside test mode is illegal', m3.cpu.PC, vtarget(VEC.ILLEGAL));
  const m4 = machine({ cpu: { testMode: true } }); m4.mem.set([0x00], 0x2000); m4.cpu.reset();
  m4.cpu.step(); eq('TEST in test mode holds PC', m4.cpu.PC, 0x2000);
  for (const [pre, op] of [[0x1A, 0x86], [0xCD, 0x83], [0x18, 0x18], [0x1A, 0xCE], [0xCD, 0xEC], [0x18, 0x87], [0x18, 0x00]]) {
    const mm = machine(); mm.mem.set([pre, op], 0x2000); mm.cpu.reset(); mm.cpu.setState({ SP: 0x01FF, CCR: 0 });
    mm.cpu.step(); eq(`illegal ${pre.toString(16)} ${op.toString(16)}`, mm.cpu.PC, vtarget(VEC.ILLEGAL));
  }
  // legal opcode counts per page: page1 232 legal opcodes (+3 prebytes), page2 64, page3 7, page4 4
  let n1 = 0, n2 = 0, n3 = 0, n4 = 0;
  for (let o = 0; o < 256; o++) { n1 += isLegal(1, o); n2 += isLegal(2, o); n3 += isLegal(3, o); n4 += isLegal(4, o); }
  eq('page 1 legal count', n1, 232); eq('page 2 legal count', n2, 64); eq('page 3 legal count', n3, 7); eq('page 4 legal count', n4, 4);
}

// ---- cycle table spot checks (typed from Table 4-2, independent of cpu.js) ------------------------
{
  const T = [
    [1, 0x01, 2], [1, 0x02, 41], [1, 0x03, 41], [1, 0x04, 3], [1, 0x06, 2], [1, 0x08, 3], [1, 0x12, 6], [1, 0x14, 6], [1, 0x1C, 7], [1, 0x1E, 7],
    [1, 0x19, 2], [1, 0x20, 3], [1, 0x30, 3], [1, 0x32, 4], [1, 0x36, 3], [1, 0x38, 5], [1, 0x39, 5], [1, 0x3A, 3], [1, 0x3B, 12], [1, 0x3C, 4],
    [1, 0x3D, 10], [1, 0x3E, 14], [1, 0x3F, 14], [1, 0x40, 2], [1, 0x5F, 2], [1, 0x60, 6], [1, 0x6E, 3], [1, 0x70, 6], [1, 0x7E, 3], [1, 0x7F, 6],
    [1, 0x80, 2], [1, 0x83, 4], [1, 0x8C, 4], [1, 0x8D, 6], [1, 0x8E, 3], [1, 0x8F, 3], [1, 0x90, 3], [1, 0x93, 5], [1, 0x97, 3], [1, 0x9C, 5],
    [1, 0x9D, 5], [1, 0x9E, 4], [1, 0x9F, 4], [1, 0xA0, 4], [1, 0xA3, 6], [1, 0xA7, 4], [1, 0xAC, 6], [1, 0xAD, 6], [1, 0xAE, 5], [1, 0xAF, 5],
    [1, 0xB0, 4], [1, 0xB3, 6], [1, 0xB7, 4], [1, 0xBC, 6], [1, 0xBD, 6], [1, 0xBE, 5], [1, 0xBF, 5], [1, 0xC3, 4], [1, 0xCC, 3], [1, 0xCE, 3],
    [1, 0xCF, 2], [1, 0xD3, 5], [1, 0xD7, 3], [1, 0xDC, 4], [1, 0xDD, 4], [1, 0xDE, 4], [1, 0xDF, 4], [1, 0xE3, 6], [1, 0xEC, 5], [1, 0xED, 5],
    [1, 0xEE, 5], [1, 0xEF, 5], [1, 0xF3, 6], [1, 0xF7, 4], [1, 0xFC, 5], [1, 0xFD, 5], [1, 0xFE, 5], [1, 0xFF, 5],
    [2, 0x08, 4], [2, 0x09, 4], [2, 0x1C, 8], [2, 0x1D, 8], [2, 0x1E, 8], [2, 0x1F, 8], [2, 0x30, 4], [2, 0x35, 4], [2, 0x38, 6], [2, 0x3A, 4],
    [2, 0x3C, 5], [2, 0x60, 7], [2, 0x6E, 4], [2, 0x6D, 7], [2, 0x8C, 5], [2, 0x8F, 4], [2, 0x9C, 6], [2, 0xA0, 5], [2, 0xA3, 7], [2, 0xA7, 5],
    [2, 0xAC, 7], [2, 0xAD, 7], [2, 0xAE, 6], [2, 0xAF, 6], [2, 0xBC, 7], [2, 0xCE, 4], [2, 0xDE, 5], [2, 0xDF, 5], [2, 0xE0, 5], [2, 0xE3, 7],
    [2, 0xEC, 6], [2, 0xED, 6], [2, 0xEE, 6], [2, 0xEF, 6], [2, 0xFE, 6], [2, 0xFF, 6],
    [3, 0x83, 5], [3, 0x93, 6], [3, 0xA3, 7], [3, 0xB3, 7], [3, 0xAC, 7], [3, 0xEE, 6], [3, 0xEF, 6],
    [4, 0xA3, 7], [4, 0xAC, 7], [4, 0xEE, 6], [4, 0xEF, 6],
  ];
  for (const [p, o, c] of T) eq(`cycles page${p} ${o.toString(16)}`, opcodeCycles(p, o), c);
  // every legal opcode executes without throwing and returns its table cycle count
  let crash = 0, mism = 0;
  for (let p = 1; p <= 4; p++) for (let o = 0; o < 256; o++) {
    if (!isLegal(p, o)) continue;
    if (p === 1 && (o === 0x3E || o === 0xCF)) continue; // WAI/STOP idle, covered above
    const pre = [null, [], [0x18], [0x1A], [0xCD]][p];
    try {
      const r = run1([...pre, o, 0x00, 0x10, 0x00], { X: 0x3000, Y: 0x3000, SP: 0x01FF, CCR: CC.S });
      if (r.cyc !== opcodeCycles(p, o)) mism++;
    } catch (e) { crash++; failures.push(`exec page${p} ${o.toString(16)}: ${e.message}`); }
  }
  eq('all legal opcodes execute', crash, 0); eq('all legal opcodes return table cycles', mism, 0);
}

// ---- multi-instruction program, cycle accounting -----------------------------------------------------
{
  // loop: LDAA #3 ; L: DECA ; BNE L ; SWI -> 2 + 3*(2+3) + 14 = 31 cycles
  const m = machine(); m.mem.set([0x86, 0x03, 0x4A, 0x26, 0xFD, 0x3F], 0x2000); m.cpu.reset(); m.cpu.setState({ SP: 0x01FF });
  const c0 = m.cpu.cycles; let n = 0;
  while (m.cpu.PC !== vtarget(VEC.SWI) && n++ < 100) m.cpu.step();
  eq('program cycle total', m.cpu.cycles - c0, 31);
  // bus receives the cycle stamp
  let stamp = -1;
  const m2 = machine({ bus: { write8(a, v, cyc) { stamp = cyc; } } }); m2.mem.set([0x01, 0x97, 0x40], 0x2000); m2.cpu.reset();
  m2.cpu.step(); m2.cpu.step(); eq('write8 gets instruction-start cycle', stamp, 2);
}

// ---- disassembler --------------------------------------------------------------------------------
{
  const mem = new Uint8Array(65536);
  const rd = (a) => mem[a];
  const dis = (bytes) => { mem.set(bytes, 0x8000); return disassemble(rd, 0x8000); };
  eq('dis LDAA #', dis([0x86, 0x12]).text, 'LDAA #$12');
  eq('dis LDY ,X', dis([0x1A, 0xEE, 0x05]).text, 'LDY $05,X');
  eq('dis CPD ,Y', dis([0xCD, 0xA3, 0x05]).text, 'CPD $05,Y');
  eq('dis BRSET', dis([0x1E, 0x02, 0x80, 0xFC]).text, 'BRSET $02,X,#$80,$8000');
  eq('dis BSET ,Y', dis([0x18, 0x1C, 0x02, 0x80]).text, 'BSET $02,Y,#$80');
  eq('dis PULY', dis([0x18, 0x38]).text, 'PULY');
  eq('dis TYS', dis([0x18, 0x35]).text, 'TYS');
  eq('dis LDX imm', dis([0xCE, 0x10, 0x00]).text, 'LDX #$1000');
  eq('dis STY ext', dis([0x18, 0xFF, 0x10, 0x00]).text, 'STY $1000');
  eq('dis CPY imm', dis([0x18, 0x8C, 0x10, 0x00]).text, 'CPY #$1000');
  eq('dis JSR ext target', dis([0xBD, 0x94, 0x4E]).target, 0x944E);
  eq('dis length', dis([0x18, 0x1E, 0x02, 0x80, 0x00]).length, 5);
}

// ---- summary -------------------------------------------------------------------------------------
for (const f of failures) console.log('FAIL', f);
console.log(`\nhc11 cpu tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
