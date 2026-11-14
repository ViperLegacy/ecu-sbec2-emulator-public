// Disassembly model for the GUI's DISASSEMBLY / CPU view. DOM-free (tests/disasm.test.mjs).
//   Listing    instruction / data rows for 8000-FFFF from the analysis code map (code_ranges, data_ranges, labels),
//              decoded from LIVE memory each time they are shown, so flash or RAM changes appear at once. Code outside
//              the map (the RAM worker at 0490, a foreign image) is decoded on the fly from the PC.
//   Symbols    routine names (ram_symbols.routines), code labels, RAM names, MCU registers, external I/O.
//   operandInfo / branchTaken  what the current instruction touches and whether its branch will be taken.

import { disassemble } from '../hc11/cpu.js';

export const REG_NAMES = {
  0x00: 'PORTA', 0x02: 'PIOC', 0x03: 'PORTC', 0x04: 'PORTB', 0x05: 'PORTCL', 0x07: 'DDRC', 0x08: 'PORTD', 0x09: 'DDRD',
  0x0A: 'PORTE', 0x0B: 'CFORC', 0x0C: 'OC1M', 0x0D: 'OC1D', 0x0E: 'TCNT', 0x0F: 'TCNT+1', 0x10: 'TIC1', 0x11: 'TIC1+1',
  0x12: 'TIC2', 0x13: 'TIC2+1', 0x14: 'TIC3', 0x15: 'TIC3+1', 0x16: 'TOC1', 0x17: 'TOC1+1', 0x18: 'TOC2', 0x19: 'TOC2+1',
  0x1A: 'TOC3', 0x1B: 'TOC3+1', 0x1C: 'TOC4', 0x1D: 'TOC4+1', 0x1E: 'TI4O5', 0x1F: 'TI4O5+1', 0x20: 'TCTL1', 0x21: 'TCTL2',
  0x22: 'TMSK1', 0x23: 'TFLG1', 0x24: 'TMSK2', 0x25: 'TFLG2', 0x26: 'PACTL', 0x27: 'PACNT', 0x28: 'SPCR', 0x29: 'SPSR',
  0x2A: 'SPDR', 0x2B: 'BAUD', 0x2C: 'SCCR1', 0x2D: 'SCCR2', 0x2E: 'SCSR', 0x2F: 'SCDR', 0x30: 'ADCTL', 0x31: 'ADR1',
  0x32: 'ADR2', 0x33: 'ADR3', 0x34: 'ADR4', 0x35: 'BPROT', 0x39: 'OPTION', 0x3A: 'COPRST', 0x3B: 'PPROG', 0x3C: 'HPRIO',
  0x3D: 'INIT', 0x3E: 'TEST1', 0x3F: 'CONFIG',
};
const EXT_NAMES = {
  0x0400: 'ASIC $0400 (in: key/feed/busy; out: kick)', 0x0401: 'ASIC $0401', 0x0402: 'ASIC $0402 (SPI strobe b3)', 0x0403: 'ASIC $0403',
  0x0404: 'ASIC $0404', 0x0405: 'ASIC $0405 (injector status)', 0x0406: 'ASIC $0406', 0x0408: 'ASIC inj PW slot 9', 0x040A: 'ASIC inj PW slot 8',
  0x040C: 'ASIC inj PW slot 6', 0x040E: 'ASIC inj PW slot 3', 0x0440: 'output latch $0440',
};
const WORD_OPS = new Set(['LDD', 'STD', 'LDX', 'LDY', 'STX', 'STY', 'LDS', 'STS', 'CPX', 'CPY', 'CPD', 'ADDD', 'SUBD', 'JMP', 'JSR']);
const BRANCH = new Set(['BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE', 'BSR', 'BRSET', 'BRCLR']);
const NO_EA = new Set(['JMP', 'JSR']);     // their operand is a destination, not data
const h2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const h4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

/** Names for addresses. data = the bundled DATA (ram_symbols, codemap); generic = foreign image (code names off). */
export class Symbols {
  constructor(data, { generic = false } = {}) {
    this.code = new Map();         // addr -> name (routine names win over the listing's sub_/loc_ labels)
    this.routine = new Map();      // addr -> { name, role }
    this.ram = new Map();          // addr -> { name, base, size }
    if (!generic && data?.codemap) for (const [a, n] of Object.entries(data.codemap.labels)) this.code.set(parseInt(a, 16), n);
    if (!generic) for (const r of data?.ram_symbols?.routines ?? []) {
      const a = parseInt(r.addr, 16); this.code.set(a, r.name); this.routine.set(a, { name: r.name, role: r.role });
    }
    for (const r of data?.ram_symbols?.ram ?? []) {
      const base = parseInt(r.addr, 16), size = r.size || 1;
      if (generic || !r.name || r.confidence === 'auto') continue;
      for (let i = 0; i < size; i++) this.ram.set(base + i, { name: r.name, base, size });
    }
  }
  /** Label to print in front of a row, or null. */
  label(a) { return this.code.get(a) ?? null; }
  /** Short description of what lives at address a (for operands and pointers). */
  name(a) {
    a &= 0xFFFF;
    if (a < 0x0200) { const r = this.ram.get(a); return r ? (a === r.base ? r.name : `${r.name}+${a - r.base}`) : null; }
    if (a >= 0x1000 && a < 0x1040) return REG_NAMES[a - 0x1000] ?? null;
    if (a >= 0x0400 && a < 0x0480) return EXT_NAMES[a] ?? null;
    if (a >= 0x0480 && a < 0x0500) return a >= 0x0490 && a < 0x04C0 ? 'ext RAM (worker / 1B stub)' : 'ext RAM';
    if (a >= 0xB600 && a < 0xB800) return this.code.get(a) ?? 'EEPROM';
    if (a >= 0x8000) return this.code.get(a) ?? null;
    return null;
  }
  /** Region of an address, for pointer views. */
  region(a) {
    a &= 0xFFFF;
    if (a < 0x0200) return 'RAM';
    if (a >= 0x1000 && a < 0x1040) return 'register';
    if (a >= 0x0400 && a < 0x0480) return 'ASIC';
    if (a >= 0x0480 && a < 0x0500) return 'ext RAM';
    if (a >= 0xB600 && a < 0xB800) return 'EEPROM';
    if (a >= 0x8000) return 'flash';
    return 'unmapped';
  }
}

/**
 * Static row index of 8000-FFFF. Rows: { addr, len, kind: 'code' | 'data' }. rowAt[a] = index of the row that
 * covers a (-1 outside). Without a code map (foreign image) the whole image is swept linearly from 8000.
 */
export class Listing {
  constructor(read, codemap = null, symbols = null) {
    this.read = read; this.codemap = codemap; this.sym = symbols;
    this.build();
  }
  build() {
    const rows = [], rowAt = new Int32Array(0x10000).fill(-1), read = this.read;
    const isLabel = (a) => !!this.sym?.label(a);
    const push = (addr, len, kind) => { const i = rows.length; rows.push({ addr, len, kind }); for (let k = 0; k < len; k++) rowAt[(addr + k) & 0xFFFF] = i; };
    const ranges = [];
    if (this.codemap) {
      for (const r of this.codemap.code_ranges) { const [s, e] = r.split('-').map((x) => parseInt(x, 16)); ranges.push([s, e, 'code']); }
      for (const r of this.codemap.data_ranges) { const [s, e] = r.split('-').map((x) => parseInt(x, 16)); ranges.push([s, e, 'data']); }
    } else ranges.push([0x8000, 0xFFFF, 'code']);
    ranges.sort((x, y) => x[0] - y[0]);
    let cur = 0x8000;
    const data = (s, e) => {                         // FCB rows of up to 8 bytes, split at labels; vectors as words
      let a = s;
      while (a <= e) {
        const n = a >= 0xFFC0 ? 2 : 8;
        let len = 1;
        while (len < n && a + len <= e && (n === 2 || !isLabel(a + len))) len++;   // vector words never split
        push(a, len, 'data'); a += len;
      }
    };
    // segments in address order, gaps as data, adjacent data merged (so a vector word never splits at a range end)
    const segs = [];
    const add = (s, e, kind) => {
      const last = segs[segs.length - 1];
      if (last && kind === 'data' && last.kind === 'data' && last.e + 1 >= s) last.e = Math.max(last.e, e);
      else segs.push({ s, e, kind });
    };
    for (const [s, e, kind] of ranges) {
      if (s > cur) add(cur, s - 1, 'data');
      if (e >= cur) add(Math.max(s, cur), e, kind);
      cur = Math.max(cur, e + 1);
      if (cur > 0xFFFF) break;
    }
    if (cur <= 0xFFFF) add(cur, 0xFFFF, 'data');
    for (const { s, e, kind } of segs) {
      if (kind === 'data') { data(s, e); continue; }
      let a = s;
      while (a <= e) {
        const d = disassemble(read, a);
        push(a, Math.min(d.length, e - a + 1), 'code'); a += d.length;
      }
    }
    this.rows = rows; this.rowAt = rowAt;
  }

  /** Decoded row (live bytes). */
  decode(row) {
    if (row.kind === 'data') {
      const bytes = []; for (let i = 0; i < row.len; i++) bytes.push(this.read(row.addr + i) & 0xFF);
      const text = row.addr >= 0xFFC0 && row.len === 2 ? `FDB $${h4((bytes[0] << 8) | bytes[1])}` : `FCB ${bytes.map((b) => '$' + h2(b)).join(',')}`;
      return { addr: row.addr, length: row.len, bytes, text, target: row.addr >= 0xFFC0 && row.len === 2 ? (bytes[0] << 8) | bytes[1] : null, kind: 'data' };
    }
    return { ...disassemble(this.read, row.addr), kind: 'code' };
  }

  /**
   * Rows around address `pc`: `before` rows above it, `after` below (pc's row included). When pc starts a static
   * code row the static listing is used; otherwise (RAM code, a data byte, a misaligned PC) the instructions are
   * decoded on the fly from pc, with a back-synchronised run of instructions that ends exactly at pc above it.
   */
  window(pc, before = 12, after = 30) {
    pc &= 0xFFFF;
    const i = this.rowAt[pc];
    // static rows: pc starts a code row, or lies in a data row (a view moved there by hand). A PC inside a code row
    // (misaligned) or outside the map is decoded on the fly.
    if (i >= 0 && (this.rows[i].kind === 'data' || this.rows[i].addr === pc)) {
      const s = Math.max(0, i - before), e = Math.min(this.rows.length, i + after);
      return { rows: this.rows.slice(s, e).map((r) => this.decode(r)), focus: i - s, dynamic: false };
    }
    const above = backSync(this.read, pc, before);
    const rows = above.map((a) => ({ ...disassemble(this.read, a), kind: 'code' }));
    let a = pc;
    for (let k = 0; k < after; k++) { const d = disassemble(this.read, a); rows.push({ ...d, kind: 'code' }); a = (a + d.length) & 0xFFFF; }
    return { rows, focus: above.length, dynamic: true };
  }
  /** Row index for scrolling a pinned view (nearest row at or below a). */
  indexOf(a) { a &= 0xFFFF; if (a < 0x8000) return -1; let i = this.rowAt[a]; return i; }
}

/** Start addresses of up to n instructions that run, back to back and without illegal opcodes, into `pc`. */
export function backSync(read, pc, n) {
  for (let back = Math.min(3 * n, 48); back > 0; back--) {
    const out = [];
    let a = (pc - back) & 0xFFFF, ok = true;
    while (a !== pc) {
      const d = disassemble(read, a);
      if (d.text.includes('illegal')) { ok = false; break; }
      out.push(a);
      const next = (a + d.length) & 0xFFFF;
      if (((pc - a) & 0xFFFF) < d.length) { ok = false; break; }     // overshoots pc
      a = next;
    }
    if (ok && out.length) return out.slice(-n);
  }
  return [];
}

/**
 * What the instruction touches, from its disassembly text and the live registers:
 *   { mnem, ea, size (1 | 2), mask, target, imm } (null fields when not applicable).
 */
export function operandInfo(d, cpu) {
  const t = d.text;
  const mnem = t.split(' ')[0];
  const out = { mnem, ea: null, size: WORD_OPS.has(mnem) ? 2 : 1, mask: null, target: d.target ?? null, imm: null };
  if (t.startsWith('FCB') || t.startsWith('FDB')) return out;
  const ops = t.slice(mnem.length).trim();
  if (!ops) return out;
  const parts = ops.split(',');
  const reg = (r) => (r === 'Y' ? cpu.y : cpu.x);
  const bitOp = /^(BSET|BCLR|BRSET|BRCLR)$/.test(mnem);
  if (bitOp) {
    const off = parseInt(parts[0].slice(1), 16);
    if (parts[1] === 'X' || parts[1] === 'Y') { out.ea = (reg(parts[1]) + off) & 0xFFFF; out.mask = parseInt(parts[2].slice(2), 16); }
    else { out.ea = off; out.mask = parseInt(parts[1].slice(2), 16); }
    out.size = 1;
    return out;
  }
  if (BRANCH.has(mnem)) return out;
  if (parts[0].startsWith('#')) { out.imm = parseInt(parts[0].slice(2), 16); return out; }
  const v = parseInt(parts[0].slice(1), 16);
  if (parts[1] === 'X' || parts[1] === 'Y') {
    const ea = (reg(parts[1]) + v) & 0xFFFF;
    if (NO_EA.has(mnem)) out.target = ea; else out.ea = ea;
  } else if (NO_EA.has(mnem)) out.target = v;
  else out.ea = v;
  return out;
}

/** true / false for a conditional branch from the current CCR (and memory for BRSET / BRCLR), null otherwise. */
export function branchTaken(d, cpu, read) {
  const mnem = d.text.split(' ')[0], c = cpu.ccr;
  const C = c & 1, V = (c >> 1) & 1, Z = (c >> 2) & 1, N = (c >> 3) & 1;
  switch (mnem) {
    case 'BRA': case 'BSR': return true;
    case 'BRN': return false;
    case 'BHI': return !(C | Z); case 'BLS': return !!(C | Z);
    case 'BCC': return !C; case 'BCS': return !!C;
    case 'BNE': return !Z; case 'BEQ': return !!Z;
    case 'BVC': return !V; case 'BVS': return !!V;
    case 'BPL': return !N; case 'BMI': return !!N;
    case 'BGE': return !(N ^ V); case 'BLT': return !!(N ^ V);
    case 'BGT': return !(Z | (N ^ V)); case 'BLE': return !!(Z | (N ^ V));
    case 'BRSET': case 'BRCLR': {
      const o = operandInfo(d, cpu);
      const v = read(o.ea) & 0xFF;
      return mnem === 'BRSET' ? (v & o.mask) === o.mask : (v & o.mask) === 0;
    }
  }
  return null;
}

/** Address of the instruction after d, and whether "step over" should run to it (a call). */
export function nextAddr(d) {
  const mnem = d.text.split(' ')[0];
  return { next: (d.addr + d.length) & 0xFFFF, isCall: mnem === 'JSR' || mnem === 'BSR' };
}

export { h2, h4 };
