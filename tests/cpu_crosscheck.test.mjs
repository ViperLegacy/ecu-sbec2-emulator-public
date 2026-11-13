// Cross-check of the JavaScript 68HC11 core (emulator/hc11/cpu.js) against two independent sources:
//   1. analysis/hc11_opcodes.json  - opcode table extracted from M68HC11E data sheet Table 4-2 by a different tool
//      (analysis/tools/extract_opcodes.py). Every opcode on every prebyte page is compared for legality, length,
//      addressing mode, mnemonic and cycle count, both through cpu.js's disassembler and by executing it.
//   2. analysis/VIPER_04763555.disasm.txt - the listing produced by analysis/tools/hc11dis.py from the Viper image.
//      Every instruction line is re-decoded and executed by cpu.js from the real image bytes; length, opcode bytes,
//      branch target and cycle count must agree.
// Then family tests whose expected values are computed from plain integer arithmetic (not from the
// carry/overflow bit formulas cpu.js uses), exhaustive over all 8-bit operands where that is cheap:
//   ADD/ADC/SUB/SBC/CMP (H N Z V C), NEG/COM/INC/DEC/TST/CLR/ASL/LSR/ASR/ROL/ROR (all 256 inputs, both carries),
//   ADDD/SUBD/CPD/CPX/CPY (random + edge values), IDIV/FDIV (random + edges, vs BigInt), MUL (all 65536),
//   addressing-mode equivalence (every 8-bit ALU op: IMM == DIR == EXT == ,X == ,Y; memory unary == accumulator
//   unary; ,Y forms == ,X forms for 16-bit ops), H-flag isolation (only ADD/ADC/ABA write H).
// Run from ecu/sbec2/viper:  node emulator/tests/cpu_crosscheck.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HC11, CC, VEC, opcodeCycles, isLegal, disassemble } from '../hc11/cpu.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const TABLE = JSON.parse(readFileSync(join(ROOT, 'analysis', 'hc11_opcodes.json'), 'utf8'));
const LISTING = readFileSync(join(ROOT, 'analysis', 'VIPER_04763555.disasm.txt'), 'utf8');
const IMG = readFileSync(join(ROOT, 'dumps', 'VIPER_04763555_8000-FFFF.bin'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') { if (cond) pass++; else { fail++; if (failures.length < 200) failures.push(`${name}${detail ? ' :: ' + detail : ''}`); } }
const hx = (v, w = 2) => v.toString(16).toUpperCase().padStart(w, '0');
function eq(name, got, want) { check(name, got === want, `got ${typeof got === 'number' ? '$' + hx(got) : JSON.stringify(got)} want ${typeof want === 'number' ? '$' + hx(want) : JSON.stringify(want)}`); }

const PAGE_OF = { null: 1, '18': 2, '1A': 3, 'CD': 4 };
const PREBYTE = [0, 0, 0x18, 0x1A, 0xCD];
const tableMap = new Map();
for (const e of TABLE) tableMap.set(PAGE_OF[e.prefix] * 256 + parseInt(e.opcode, 16), e);
const names = (e) => [e.mnemonic, ...(e.aliases || [])].map((s) => s.toUpperCase());

// Classify the addressing mode from cpu.js's own disassembly text (independent of the table).
function modeFromText(text) {
  const [mn, ...rest] = text.split(' ');
  const ops = rest.join(' ');
  if (!ops) return 'INH';
  if (/^(B(RA|RN|HI|LS|CC|CS|NE|EQ|VC|VS|PL|MI|GE|LT|GT|LE)|BSR)$/.test(mn)) return 'REL';
  if (ops.startsWith('#')) return 'IMM';
  if (/,X/.test(ops)) return 'INDX';
  if (/,Y/.test(ops)) return 'INDY';
  if (/^\$[0-9A-F]{2}(,|$)/.test(ops)) return 'DIR';
  if (/^\$[0-9A-F]{4}$/.test(ops)) return 'EXT';
  return '?';
}
const isFlow = (mn) => /^(B(RA|RN|HI|LS|CC|CS|NE|EQ|VC|VS|PL|MI|GE|LT|GT|LE|SR|RSET|RCLR)|JMP|JSR|RTS|RTI|SWI|WAI|STOP|TEST)$/.test(mn);

// Flat-RAM machine; returns {cpu, mem}.
function machine(bytes, at = 0x2000, regs = {}) {
  const mem = new Uint8Array(65536);
  mem.set(bytes, at);
  mem[0xFFFE] = at >> 8; mem[0xFFFF] = at & 0xFF;
  const cpu = new HC11({ read8: (a) => mem[a], write8: (a, v) => { mem[a] = v; } });
  cpu.reset();
  cpu.setState({ CCR: 0, SP: 0x01FF, ...regs });
  return { cpu, mem };
}

// =====================================================================================================
// 1. opcode table vs cpu.js
// =====================================================================================================
{
  let compared = 0;
  for (let page = 1; page <= 4; page++) for (let op = 0; op < 256; op++) {
    if (page === 1 && (op === 0x18 || op === 0x1A || op === 0xCD)) continue; // prebytes
    const e = tableMap.get(page * 256 + op);
    const legal = isLegal(page, op);
    const id = `${page > 1 ? hx(PREBYTE[page]) + ' ' : ''}${hx(op)}`;
    if (page === 1 && op === 0x00) { // TEST: in the table (test mode only); cpu.js treats it as illegal in normal modes
      check('table has TEST', !!e && e.mnemonic === 'TEST' && e.cycles === null);
      check('cpu treats TEST as illegal outside test mode', !legal);
      compared++;
      continue;
    }
    if (!e && !legal) continue;
    compared++;
    check(`legality ${id}`, !!e === legal, `table ${!!e} cpu ${legal}`);
    if (!e || !legal) continue;
    const bytes = page === 1 ? [op, 0x12, 0x34, 0x56, 0x78] : [PREBYTE[page], op, 0x12, 0x34, 0x56];
    const d = disassemble((a) => bytes[a - 0x2000] ?? 0, 0x2000);
    const mn = d.text.split(' ')[0];
    eq(`length ${id} ${e.mnemonic}`, d.length, e.length);
    check(`mnemonic ${id}`, names(e).includes(mn), `cpu ${mn} table ${names(e)}`);
    eq(`mode ${id} ${e.mnemonic}`, modeFromText(d.text), e.mode);
    eq(`cycles ${id} ${e.mnemonic}`, opcodeCycles(page, op), e.cycles);
    // execute it: PC must advance by the table length (non-flow), and the step must cost the table cycles
    const m = machine(bytes, 0x2000, { X: 0x0100, Y: 0x0100, CCR: CC.S | CC.I });
    const c = m.cpu.step();
    if (!isFlow(mn)) eq(`exec length ${id} ${mn}`, m.cpu.PC, 0x2000 + e.length);
    if (mn === 'WAI') eq('exec WAI stacks in 12 (table 14 = 12 + 2 at wake)', c, 12);
    else eq(`exec cycles ${id} ${mn}`, c, e.cycles);
  }
  eq('opcodes compared (incl. TEST)', compared, TABLE.length);
  eq('table size', TABLE.length, 308);
}

// =====================================================================================================
// 2. Viper listing vs cpu.js (decode + execute every instruction line from the real image bytes)
// =====================================================================================================
{
  const rom = (a) => IMG[(a - 0x8000) & 0x7FFF];
  const re = /^([0-9A-F]{4})  ((?:[0-9A-F]{2} )+)\s*([a-z]+)\s+(.*?)\s*; ~(\d+)/;
  const base = new Uint8Array(65536); base.set(IMG, 0x8000);
  let lines = 0, lenBad = 0, byteBad = 0, cycBad = 0, tgtBad = 0, execBad = 0, nameBad = 0;
  const aliasOf = new Map();
  for (const e of TABLE) for (const n of names(e)) aliasOf.set(n, names(e));
  for (const line of LISTING.split(/\r?\n/)) {
    const mt = re.exec(line);
    if (!mt) continue;
    lines++;
    const addr = parseInt(mt[1], 16);
    const lbytes = mt[2].trim().split(' ').map((b) => parseInt(b, 16));
    const lname = mt[3].toUpperCase(), operand = mt[4], lcyc = Number(mt[5]);
    const d = disassemble(rom, addr);
    const mn = d.text.split(' ')[0];
    if (d.length !== lbytes.length) { lenBad++; check(`listing length ${hx(addr, 4)}`, false, `cpu ${d.length} listing ${lbytes.length} (${line.trim()})`); continue; }
    if (d.bytes.some((b, i) => b !== lbytes[i])) { byteBad++; check(`listing bytes ${hx(addr, 4)}`, false, line.trim()); }
    if (!(aliasOf.get(mn) || [mn]).includes(lname)) { nameBad++; check(`listing mnemonic ${hx(addr, 4)}`, false, `cpu ${mn} listing ${lname}`); }
    // decoded cycle count from cpu.js tables
    let page = 1, op = lbytes[0];
    if (op === 0x18 || op === 0x1A || op === 0xCD) { page = PREBYTE.indexOf(op); op = lbytes[1]; }
    if (opcodeCycles(page, op) !== lcyc) { cycBad++; check(`listing cycles ${hx(addr, 4)}`, false, `cpu ${opcodeCycles(page, op)} listing ${lcyc}`); }
    // static target (branches, BSR, JMP/JSR ext): listing names it loc_/sub_/VEC_ label or $xxxx
    if (d.target !== null && /^(B|JMP|JSR)/.test(mn) && !/,(X|Y)/.test(operand)) {
      const tm = /(?:loc|sub)_([0-9A-F]{4})|\$([0-9A-F]{4})\b(?!.*\$[0-9A-F]{4}\b)/.exec(operand);
      if (tm) {
        const t = parseInt(tm[1] || tm[2], 16);
        if (t !== d.target) { tgtBad++; check(`listing target ${hx(addr, 4)}`, false, `cpu $${hx(d.target, 4)} listing ${operand}`); }
      }
    }
    // execute the instruction from the image (writes into a scratch copy, ROM area included - harmless)
    const mem = new Uint8Array(base);
    const cpu = new HC11({ read8: (a) => mem[a], write8: (a, v) => { mem[a] = v; } });
    cpu.setState({ PC: addr, CCR: CC.S | CC.X | CC.I, SP: 0x01FF, X: 0x0100, Y: 0x0180, D: 0x1234 });
    let c;
    try { c = cpu.step(); } catch (err) { execBad++; check(`listing exec ${hx(addr, 4)}`, false, err.message); continue; }
    if (c !== lcyc) { execBad++; check(`listing exec cycles ${hx(addr, 4)} ${mn}`, false, `${c} vs ${lcyc}`); }
    const next = (addr + d.length) & 0xFFFF;
    if (!isFlow(mn)) { if (cpu.PC !== next) { execBad++; check(`listing exec PC ${hx(addr, 4)} ${mn}`, false, `PC ${hx(cpu.PC, 4)} want ${hx(next, 4)}`); } }
    else if (/^B/.test(mn) && mn !== 'BSR') {
      if (cpu.PC !== next && cpu.PC !== d.target) { execBad++; check(`listing exec branch ${hx(addr, 4)}`, false, `PC ${hx(cpu.PC, 4)}`); }
    } else if ((mn === 'BSR' || mn === 'JSR' || mn === 'JMP') && d.target !== null && !/,(X|Y)/.test(d.text)) {
      if (cpu.PC !== d.target) { execBad++; check(`listing exec ${mn} ${hx(addr, 4)}`, false, `PC ${hx(cpu.PC, 4)} want ${hx(d.target, 4)}`); }
      if (mn !== 'JMP') { const ret = (mem[0x01FE] << 8) | mem[0x01FF]; if (ret !== next) { execBad++; check(`listing ${mn} return addr ${hx(addr, 4)}`, false, hx(ret, 4)); } }
    }
  }
  check('listing has instruction lines', lines > 9000, `${lines}`);
  eq('listing length mismatches', lenBad, 0);
  eq('listing byte mismatches', byteBad, 0);
  eq('listing mnemonic mismatches', nameBad, 0);
  eq('listing cycle mismatches', cycBad, 0);
  eq('listing static-target mismatches', tgtBad, 0);
  eq('listing execution mismatches', execBad, 0);
  console.log(`listing: ${lines} instruction lines decoded and executed`);
}

// =====================================================================================================
// 3. Family tests against integer-arithmetic definitions (Reference Manual Appendix A)
// =====================================================================================================
const sx8 = (v) => (v << 24) >> 24, sx16 = (v) => (v << 16) >> 16;
function flagsOf(cpu) { return cpu.CCR & (CC.H | CC.N | CC.Z | CC.V | CC.C); }
function mk({ h = 0, n, z, v, c }) { return (h ? CC.H : 0) | (n ? CC.N : 0) | (z ? CC.Z : 0) | (v ? CC.V : 0) | (c ? CC.C : 0); }

// One reusable machine for the exhaustive loops (much faster than a fresh 64 KiB each time).
const M = machine([]);
function exec1(bytes, regs) {
  M.mem.set(bytes, 0x2000);
  M.cpu.setState({ PC: 0x2000, SP: 0x01FF, waiting: false, stopped: false, ...regs });
  return M.cpu.step();
}

// ---- 8-bit ADD/ADC/SUB/SBC/CMP, all a, m, carry-in, starting with H preset to both states ------------
{
  let bad = { ADD: 0, ADC: 0, SUB: 0, SBC: 0, CMP: 0, ABA: 0, SBA: 0, CBA: 0 };
  for (let a = 0; a < 256; a++) for (let m = 0; m < 256; m++) for (const cin of [0, 1]) for (const hin of [0, CC.H]) {
    const ccr0 = (cin ? CC.C : 0) | hin;
    // ADD (8B) / ADC (89)
    for (const [nm, op, useC] of [['ADD', 0x8B, 0], ['ADC', 0x89, 1]]) {
      const ci = useC ? cin : 0, u = a + m + ci, r = u & 0xFF, s = sx8(a) + sx8(m) + ci;
      const want = mk({ h: (a & 0xF) + (m & 0xF) + ci > 0xF, n: r & 0x80, z: r === 0, v: s > 127 || s < -128, c: u > 0xFF });
      exec1([op, m], { A: a, CCR: ccr0 });
      if (M.cpu.A !== r || flagsOf(M.cpu) !== want) bad[nm]++;
    }
    // SUB (80) / SBC (82) / CMP (81): H must be preserved
    for (const [nm, op, useC, keep] of [['SUB', 0x80, 0, 0], ['SBC', 0x82, 1, 0], ['CMP', 0x81, 0, 1]]) {
      const ci = useC ? cin : 0, u = a - m - ci, r = u & 0xFF, s = sx8(a) - sx8(m) - ci;
      const want = hin | mk({ n: r & 0x80, z: r === 0, v: s > 127 || s < -128, c: u < 0 });
      exec1([op, m], { A: a, CCR: ccr0 });
      if (M.cpu.A !== (keep ? a : r) || flagsOf(M.cpu) !== want) bad[nm]++;
    }
    if (cin === 0) {
      { const u = a + m, r = u & 0xFF, s = sx8(a) + sx8(m);
        exec1([0x1B], { A: a, B: m, CCR: ccr0 });
        if (M.cpu.A !== r || flagsOf(M.cpu) !== mk({ h: (a & 0xF) + (m & 0xF) > 0xF, n: r & 0x80, z: r === 0, v: s > 127 || s < -128, c: u > 0xFF })) bad.ABA++; }
      { const u = a - m, r = u & 0xFF, s = sx8(a) - sx8(m), want = hin | mk({ n: r & 0x80, z: r === 0, v: s > 127 || s < -128, c: u < 0 });
        exec1([0x10], { A: a, B: m, CCR: ccr0 }); if (M.cpu.A !== r || flagsOf(M.cpu) !== want) bad.SBA++;
        exec1([0x11], { A: a, B: m, CCR: ccr0 }); if (M.cpu.A !== a || flagsOf(M.cpu) !== want) bad.CBA++; }
    }
  }
  for (const k of Object.keys(bad)) eq(`exhaustive 8-bit ${k} mismatches`, bad[k], 0);
}

// ---- unary ops, all 256 inputs x carry-in, accumulator A, B and memory (ext) forms ----------------------
{
  const defs = {
    NEG: [0x0, (m) => { const r = (-m) & 0xFF; return { r, n: r & 0x80, z: !r, v: m === 0x80, c: m !== 0 }; }],
    COM: [0x3, (m) => { const r = ~m & 0xFF; return { r, n: r & 0x80, z: !r, v: 0, c: 1 }; }],
    LSR: [0x4, (m) => { const r = m >>> 1, c = m & 1; return { r, n: 0, z: !r, v: c, c }; }],
    ROR: [0x6, (m, ci) => { const r = (m >>> 1) | (ci << 7), c = m & 1, n = r >> 7; return { r, n, z: !r, v: n ^ c, c }; }],
    ASR: [0x7, (m) => { const r = (m >>> 1) | (m & 0x80), c = m & 1, n = r >> 7; return { r, n, z: !r, v: n ^ c, c }; }],
    ASL: [0x8, (m) => { const u = m * 2, r = u & 0xFF, c = u >> 8, n = r >> 7; return { r, n, z: !r, v: n ^ c, c }; }],
    ROL: [0x9, (m, ci) => { const u = m * 2 + ci, r = u & 0xFF, c = u >> 8, n = r >> 7; return { r, n, z: !r, v: n ^ c, c }; }],
    DEC: [0xA, (m, ci) => { const r = (m - 1) & 0xFF, s = sx8(m) - 1; return { r, n: r & 0x80, z: !r, v: s < -128, c: ci }; }],
    INC: [0xC, (m, ci) => { const r = (m + 1) & 0xFF, s = sx8(m) + 1; return { r, n: r & 0x80, z: !r, v: s > 127, c: ci }; }],
    TST: [0xD, (m) => ({ r: m, n: m & 0x80, z: !m, v: 0, c: 0 })],
    CLR: [0xF, () => ({ r: 0, n: 0, z: 1, v: 0, c: 0 })],
  };
  for (const [nm, [lo, f]] of Object.entries(defs)) {
    let bad = 0;
    for (let m = 0; m < 256; m++) for (const ci of [0, 1]) for (const hin of [0, CC.H]) {
      const w = f(m, ci), want = hin | mk(w);
      exec1([0x40 | lo], { A: m, CCR: (ci ? CC.C : 0) | hin });
      if (M.cpu.A !== w.r || flagsOf(M.cpu) !== want) bad++;
      exec1([0x50 | lo], { B: m, CCR: (ci ? CC.C : 0) | hin });
      if (M.cpu.B !== w.r || flagsOf(M.cpu) !== want) bad++;
      M.mem[0x3000] = m;
      exec1([0x70 | lo, 0x30, 0x00], { CCR: (ci ? CC.C : 0) | hin });
      if (M.mem[0x3000] !== w.r || flagsOf(M.cpu) !== want) bad++;
      M.mem[0x3105] = m;
      exec1([0x18, 0x60 | lo, 0x05], { Y: 0x3100, CCR: (ci ? CC.C : 0) | hin });
      if (M.mem[0x3105] !== w.r || flagsOf(M.cpu) !== want) bad++;
    }
    eq(`exhaustive ${nm} (A, B, ext, ,Y) mismatches`, bad, 0);
  }
}

// ---- 16-bit ADDD / SUBD / CPD / CPX / CPY / LSRD / ASLD, edges + pseudo-random ---------------------------
{
  let seed = 0x13579BDF;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const edges = [0x0000, 0x0001, 0x7FFE, 0x7FFF, 0x8000, 0x8001, 0xFFFE, 0xFFFF, 0x00FF, 0x0100, 0x0FFF, 0x1000];
  const pairs = [];
  for (const a of edges) for (const b of edges) pairs.push([a, b]);
  for (let i = 0; i < 20000; i++) pairs.push([rnd() & 0xFFFF, rnd() & 0xFFFF]);
  const bad = { ADDD: 0, SUBD: 0, CPD: 0, CPX: 0, CPY: 0, 'CPY,X(1A AC)': 0, 'CPX,Y(CD AC)': 0, LSRD: 0, ASLD: 0 };
  const w16 = (a, v) => { M.mem[a] = v >> 8; M.mem[a + 1] = v & 0xFF; };
  for (const [a, b] of pairs) for (const hin of [0, CC.H]) {
    const add = a + b, ar = add & 0xFFFF, as = sx16(a) + sx16(b);
    const wantAdd = hin | mk({ n: ar & 0x8000, z: !ar, v: as > 32767 || as < -32768, c: add > 0xFFFF });
    const sub = a - b, sr = sub & 0xFFFF, ss = sx16(a) - sx16(b);
    const wantSub = hin | mk({ n: sr & 0x8000, z: !sr, v: ss > 32767 || ss < -32768, c: sub < 0 });
    exec1([0xC3, b >> 8, b & 0xFF], { D: a, CCR: hin }); if (M.cpu.D !== ar || flagsOf(M.cpu) !== wantAdd) bad.ADDD++;
    exec1([0x83, b >> 8, b & 0xFF], { D: a, CCR: hin }); if (M.cpu.D !== sr || flagsOf(M.cpu) !== wantSub) bad.SUBD++;
    exec1([0x1A, 0x83, b >> 8, b & 0xFF], { D: a, CCR: hin }); if (M.cpu.D !== a || flagsOf(M.cpu) !== wantSub) bad.CPD++;
    exec1([0x8C, b >> 8, b & 0xFF], { X: a, CCR: hin }); if (M.cpu.X !== a || flagsOf(M.cpu) !== wantSub) bad.CPX++;
    exec1([0x18, 0x8C, b >> 8, b & 0xFF], { Y: a, CCR: hin }); if (M.cpu.Y !== a || flagsOf(M.cpu) !== wantSub) bad.CPY++;
    w16(0x3010, b);
    exec1([0x1A, 0xAC, 0x10], { X: 0x3000, Y: a, CCR: hin }); if (flagsOf(M.cpu) !== wantSub) bad['CPY,X(1A AC)']++;
    exec1([0xCD, 0xAC, 0x10], { Y: 0x3000, X: a, CCR: hin }); if (flagsOf(M.cpu) !== wantSub) bad['CPX,Y(CD AC)']++;
    { const r = a >>> 1, c = a & 1; exec1([0x04], { D: a, CCR: hin }); if (M.cpu.D !== r || flagsOf(M.cpu) !== (hin | mk({ n: 0, z: !r, v: c, c }))) bad.LSRD++; }
    { const u = a * 2, r = u & 0xFFFF, c = u >> 16, n = r >> 15; exec1([0x05], { D: a, CCR: hin }); if (M.cpu.D !== r || flagsOf(M.cpu) !== (hin | mk({ n, z: !r, v: n ^ c, c }))) bad.ASLD++; }
  }
  for (const k of Object.keys(bad)) eq(`16-bit ${k} mismatches`, bad[k], 0);
}

// ---- MUL (exhaustive), IDIV / FDIV (edges + random, BigInt reference) -----------------------------------
{
  let bad = 0;
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    exec1([0x3D], { A: a, B: b, CCR: CC.N | CC.Z | CC.V | CC.H });
    const r = a * b;
    if (M.cpu.D !== r || (M.cpu.CCR & 0x2F) !== (CC.N | CC.Z | CC.V | CC.H | ((r & 0x80) ? CC.C : 0))) bad++;
  }
  eq('exhaustive MUL mismatches (C = result bit 7, N Z V H untouched)', bad, 0);

  let seed = 0x2468ACE1;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const edges = [0, 1, 2, 3, 0x7FFF, 0x8000, 0xFFFE, 0xFFFF, 0x0100, 0x00FF];
  const pairs = [];
  for (const d of edges) for (const x of edges) pairs.push([d, x]);
  for (let i = 0; i < 20000; i++) { const d = rnd() & 0xFFFF; let x = rnd() & 0xFFFF; if (i & 1) x >>>= (rnd() & 15); pairs.push([d, x]); }
  let ib = 0, fb = 0;
  for (const [d, x] of pairs) {
    // IDIV: X <- D / X, D <- D % X; Z if quotient 0; V cleared; C if X was 0 (quotient FFFF, remainder indeterminate)
    exec1([0x02], { D: d, X: x, CCR: CC.V | CC.N | CC.H });
    if (x === 0) { if (M.cpu.X !== 0xFFFF || (M.cpu.CCR & (CC.Z | CC.V | CC.C)) !== CC.C) ib++; }
    else {
      const q = Math.floor(d / x), r = d % x;
      if (M.cpu.X !== q || M.cpu.D !== r || (M.cpu.CCR & (CC.Z | CC.V | CC.C)) !== (q ? 0 : CC.Z)) ib++;
    }
    if ((M.cpu.CCR & (CC.N | CC.H)) !== (CC.N | CC.H)) ib++; // N and H untouched
    // FDIV: X <- (D * 65536) / X, D <- remainder; V if X <= D; C if X == 0; overflow/zero quotient FFFF
    exec1([0x03], { D: d, X: x, CCR: CC.N | CC.H });
    if (x === 0) { if (M.cpu.X !== 0xFFFF || (M.cpu.CCR & (CC.Z | CC.V | CC.C)) !== (CC.V | CC.C)) fb++; }
    else if (x <= d) { if (M.cpu.X !== 0xFFFF || (M.cpu.CCR & (CC.Z | CC.V | CC.C)) !== CC.V) fb++; }
    else {
      const num = BigInt(d) << 16n, q = Number(num / BigInt(x)), r = Number(num % BigInt(x));
      if (M.cpu.X !== q || M.cpu.D !== r || (M.cpu.CCR & (CC.Z | CC.V | CC.C)) !== (q ? 0 : CC.Z)) fb++;
    }
    if ((M.cpu.CCR & (CC.N | CC.H)) !== (CC.N | CC.H)) fb++;
  }
  eq('IDIV mismatches', ib, 0);
  eq('FDIV mismatches', fb, 0);
}

// ---- DAA: every input byte x C x H against the Reference Manual A-48 table ---------------------------
{
  // Table rows: [Cin, hiLo, hiHi, H, loLo, loHi, add, Cout]
  const rows = [
    [0, 0x0, 0x9, 0, 0x0, 0x9, 0x00, 0], [0, 0x0, 0x8, 0, 0xA, 0xF, 0x06, 0], [0, 0x0, 0x9, 1, 0x0, 0x3, 0x06, 0],
    [0, 0xA, 0xF, 0, 0x0, 0x9, 0x60, 1], [0, 0x9, 0xF, 0, 0xA, 0xF, 0x66, 1], [0, 0xA, 0xF, 1, 0x0, 0x3, 0x66, 1],
    [1, 0x0, 0x2, 0, 0x0, 0x9, 0x60, 1], [1, 0x0, 0x2, 0, 0xA, 0xF, 0x66, 1], [1, 0x0, 0x3, 1, 0x0, 0x3, 0x66, 1],
  ];
  let covered = 0, bad = 0;
  for (let a = 0; a < 256; a++) for (const c of [0, 1]) for (const h of [0, 1]) {
    const hi = a >> 4, lo = a & 15;
    const row = rows.find(([rc, h0, h1, rh, l0, l1]) => rc === c && rh === h && hi >= h0 && hi <= h1 && lo >= l0 && lo <= l1);
    if (!row) continue; // not reachable from a BCD addition: manual leaves it undefined
    covered++;
    const r = (a + row[6]) & 0xFF;
    exec1([0x19], { A: a, CCR: (c ? CC.C : 0) | (h ? CC.H : 0) });
    if (M.cpu.A !== r || !!(M.cpu.CCR & CC.C) !== !!row[7] || !!(M.cpu.CCR & CC.Z) !== (r === 0) || !!(M.cpu.CCR & CC.N) !== !!(r & 0x80)) bad++;
  }
  check('DAA covers > 200 legal inputs', covered > 200, `${covered}`);
  eq('DAA vs manual table mismatches', bad, 0);
}

// ---- H flag isolation: only ADD/ADC/ABA (and TAP/RTI) may change H ----------------------------------
{
  // Every page-1 opcode except ADDA/ADDB/ADCA/ADCB (all modes), ABA, TAP, RTI, plus flow/idle ops must leave H alone.
  const writesH = new Set([0x1B, 0x06, 0x3B]);
  for (const hi of [0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0xE, 0xF]) { writesH.add((hi << 4) | 0x9); writesH.add((hi << 4) | 0xB); }
  let bad = [];
  for (let op = 0; op < 256; op++) {
    if (!isLegal(1, op) || writesH.has(op) || op === 0x3E || op === 0xCF || op === 0x3F) continue;
    for (const hin of [0, CC.H]) {
      M.mem.fill(0x55, 0x3000, 0x3100);
      exec1([op, 0x30, 0x00, 0x10], { A: 0x99, B: 0x77, X: 0x3000, Y: 0x3000, CCR: CC.S | CC.I | hin });
      if ((M.cpu.CCR & CC.H) !== hin) { bad.push(hx(op)); break; }
    }
  }
  eq('opcodes that wrongly change H', bad.join(' '), '');
  // and ADD sets/clears H from the bit-3 carry even when H was preset
  exec1([0x8B, 0x01], { A: 0x0F, CCR: 0 }); eq('ADDA 0F+01 sets H', M.cpu.CCR & CC.H, CC.H);
  exec1([0x8B, 0x01], { A: 0x10, CCR: CC.H }); eq('ADDA 10+01 clears H', M.cpu.CCR & CC.H, 0);
  exec1([0xC3, 0x00, 0x0F], { D: 0x0001, CCR: 0 }); eq('ADDD never sets H', M.cpu.CCR & CC.H, 0);
}

// ---- addressing-mode equivalence for every 8-bit ALU op, both accumulators ----------------------------
{
  const ALU = { 0x0: 'SUB', 0x1: 'CMP', 0x2: 'SBC', 0x4: 'AND', 0x5: 'BIT', 0x6: 'LDA', 0x8: 'EOR', 0x9: 'ADC', 0xA: 'ORA', 0xB: 'ADD' };
  let seed = 0x0BADF00D;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const bad = [];
  for (const [loS, nm] of Object.entries(ALU)) for (const accB of [0, 1]) {
    const lo = Number(loS), baseHi = accB ? 0xC : 0x8;
    for (let t = 0; t < 300; t++) {
      const acc = rnd() & 0xFF, m = rnd() & 0xFF, ccr = rnd() & 0x2F;
      const regs = { A: accB ? 0x5A : acc, B: accB ? acc : 0x5A, CCR: ccr, X: 0x3000, Y: 0x3100 };
      exec1([(baseHi << 4) | lo, m], regs);
      const ref = { a: M.cpu.A, b: M.cpu.B, f: M.cpu.CCR };
      const forms = [
        ['DIR', [((baseHi + 1) << 4) | lo, 0x40], () => { M.mem[0x40] = m; }],
        ['EXT', [((baseHi + 3) << 4) | lo, 0x45, 0x67], () => { M.mem[0x4567] = m; }],
        [',X', [((baseHi + 2) << 4) | lo, 0xFE], () => { M.mem[0x30FE] = m; }],
        [',Y', [0x18, ((baseHi + 2) << 4) | lo, 0x07], () => { M.mem[0x3107] = m; }],
      ];
      for (const [fm, bytes, setup] of forms) {
        setup(); exec1(bytes, regs);
        if (M.cpu.A !== ref.a || M.cpu.B !== ref.b || M.cpu.CCR !== ref.f) { bad.push(`${nm}${accB ? 'B' : 'A'} ${fm}`); break; }
      }
    }
  }
  eq('8-bit ALU mode-equivalence failures', [...new Set(bad)].join(', '), '');

  // stores: STAA/STAB in DIR/EXT/,X/,Y write the same byte with the same flags
  let sbad = 0;
  for (let v = 0; v < 256; v++) for (const accB of [0, 1]) {
    const regs = { A: accB ? 0 : v, B: accB ? v : 0, X: 0x3000, Y: 0x3100, CCR: CC.V | CC.C };
    const want = CC.C | (v & 0x80 ? CC.N : 0) | (v ? 0 : CC.Z);
    const hi = accB ? 0xD : 0x9;
    for (const [bytes, addr] of [[[(hi << 4) | 7, 0x40], 0x40], [[((hi + 2) << 4) | 7, 0x12, 0x34], 0x1234], [[((hi + 1) << 4) | 7, 0x05], 0x3005], [[0x18, ((hi + 1) << 4) | 7, 0x05], 0x3105]]) {
      M.mem[addr] = ~v & 0xFF; exec1(bytes, regs);
      if (M.mem[addr] !== v || (M.cpu.CCR & 0x0F) !== want) sbad++;
    }
  }
  eq('STAA/STAB all modes mismatches', sbad, 0);

  // 16-bit memory ops: ,Y (18 xx) == ,X (xx) and DIR == EXT == IMM for SUBD/ADDD/LDD/LDX/LDS/CPX
  const W = [[0x83, 'SUBD'], [0xC3, 'ADDD'], [0xCC, 'LDD'], [0xCE, 'LDX'], [0x8E, 'LDS'], [0x8C, 'CPX']];
  const wbad = [];
  for (const [imm, nm] of W) for (let t = 0; t < 200; t++) {
    const v = rnd() & 0xFFFF, regs = { D: rnd() & 0xFFFF, X: rnd() & 0xFFFF, SP: 0x01FF, CCR: rnd() & 0x2F, Y: 0x3100 };
    exec1([imm, v >> 8, v & 0xFF], regs);
    const ref = M.cpu.getState();
    // ,Y form: 18 xx for D/SP ops; CD xx for the X-register ops (CD EE = LDX ,Y, CD AC = CPX ,Y)
    const yform = (imm === 0xCE || imm === 0x8C) ? [0xCD, imm + 0x20, 0x02] : [0x18, imm + 0x20, 0x02];
    const forms = [[[imm + 0x10, 0x40], 0x40], [[imm + 0x30, 0x45, 0x00], 0x4500], [yform, 0x3102]];
    for (const [bytes, addr] of forms) {
      M.mem[addr] = v >> 8; M.mem[addr + 1] = v & 0xFF; exec1(bytes, regs);
      const s = M.cpu.getState();
      if (s.D !== ref.D || s.X !== ref.X || s.SP !== ref.SP || s.CCR !== ref.CCR) { wbad.push(`${nm} ${bytes.map((x) => hx(x)).join(' ')}`); break; }
    }
  }
  eq('16-bit mode-equivalence failures', [...new Set(wbad)].join(', '), '');
}

// ---- prebyte register selection: every Y-page op touches Y, not X (and vice versa) ------------------
{
  let r = machine([0x18, 0x08], 0x2000, { X: 0x1000, Y: 0x2000 }); r.cpu.step(); eq('INY leaves X', r.cpu.X, 0x1000); eq('INY', r.cpu.Y, 0x2001);
  r = machine([0x18, 0xEF, 0x00], 0x2000, { X: 0x3000, Y: 0x3100 }); r.cpu.step(); eq('STY ,Y stores Y at Y+0', (r.mem[0x3100] << 8) | r.mem[0x3101], 0x3100); eq('STY ,Y leaves X target alone', r.mem[0x3000], 0);
  r = machine([0x1A, 0xEF, 0x00], 0x2000, { X: 0x3000, Y: 0x3100 }); r.cpu.step(); eq('STY ,X stores Y at X+0', (r.mem[0x3000] << 8) | r.mem[0x3001], 0x3100);
  r = machine([0xCD, 0xEF, 0x00], 0x2000, { X: 0x3000, Y: 0x3100 }); r.cpu.step(); eq('STX ,Y stores X at Y+0', (r.mem[0x3100] << 8) | r.mem[0x3101], 0x3000);
  r = machine([0x18, 0xDF, 0x50], 0x2000, { X: 0x1111, Y: 0x2222 }); r.cpu.step(); eq('STY dir', (r.mem[0x50] << 8) | r.mem[0x51], 0x2222);
  r = machine([0x18, 0x9C, 0x50], 0x2000, { X: 0x0001, Y: 0x2222 }); r.mem[0x50] = 0x22; r.mem[0x51] = 0x22; r.cpu.step(); eq('CPY dir uses Y', r.cpu.CCR & CC.Z, CC.Z);
  r = machine([0x18, 0x1E, 0x10, 0x01, 0x05], 0x2000, { X: 0x3000, Y: 0x3100 }); r.mem[0x3110] = 0x01; r.cpu.step(); eq('BRSET ,Y uses Y base', r.cpu.PC, 0x200A);
  r = machine([0x18, 0x6F, 0x10], 0x2000, { X: 0x3000, Y: 0x3100 }); r.mem[0x3110] = 0xAA; r.mem[0x3010] = 0xAA; r.cpu.step(); eq('CLR ,Y uses Y base', r.mem[0x3110], 0); eq('CLR ,Y leaves X+n', r.mem[0x3010], 0xAA);
}

// ---- stack frame order for SWI / RTI round trip, and X-bit rule through RTI --------------------------
{
  const m = machine([0x3F], 0x2000, { A: 0x11, B: 0x22, X: 0x3344, Y: 0x5566, SP: 0x01FF, CCR: 0x0F });
  m.mem[VEC.SWI] = 0x40; m.mem[VEC.SWI + 1] = 0x00; m.mem[0x4000] = 0x3B; // RTI
  const c1 = m.cpu.step();
  eq('SWI cycles', c1, 14); eq('SWI PC', m.cpu.PC, 0x4000); eq('SWI sets I', m.cpu.CCR & CC.I, CC.I); eq('SWI SP', m.cpu.SP, 0x01F6);
  const frame = Array.from(m.mem.slice(0x01F7, 0x0200)).map((b) => hx(b)).join(' ');
  eq('SWI frame CCR B A XH XL YH YL PCH PCL', frame, '0F 22 11 33 44 55 66 20 01');
  m.cpu.setState({ A: 0, B: 0, X: 0, Y: 0 });
  const c2 = m.cpu.step();
  eq('RTI cycles', c2, 12); eq('RTI PC', m.cpu.PC, 0x2001); eq('RTI A', m.cpu.A, 0x11); eq('RTI B', m.cpu.B, 0x22);
  eq('RTI X', m.cpu.X, 0x3344); eq('RTI Y', m.cpu.Y, 0x5566); eq('RTI CCR', m.cpu.CCR, 0x0F); eq('RTI SP', m.cpu.SP, 0x01FF);
  // RTI cannot set X once cleared
  const m2 = machine([0x3B], 0x2000, { SP: 0x01F6, CCR: 0x00 });
  m2.mem[0x01F7] = 0xFF; m2.mem[0x01FE] = 0x30; m2.mem[0x01FF] = 0x00;
  m2.cpu.step(); eq('RTI pulls FF with X=0: X stays clear', m2.cpu.CCR, 0xBF);
}

// ---- summary ---------------------------------------------------------------------------------------
for (const f of failures) console.log('FAIL', f);
console.log(`\nhc11 cross-check tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
