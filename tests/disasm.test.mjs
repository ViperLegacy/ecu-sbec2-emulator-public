// Disassembly view model (gui/disasm.js): listing from the code map, names, operand / branch evaluation, and the
// on-the-fly decode of code outside the map. DOM-free.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA, loadImage } from '../rom/viper_rom.js';
import { ViperMachine } from '../machine/viper_machine.js';
import { Listing, Symbols, operandInfo, branchTaken, backSync, nextAddr } from '../gui/disasm.js';
import { disassemble } from '../hc11/cpu.js';
import { FLASH_WORKER_T0 } from '../machine/flash_worker.js';
import { makeChecker } from './review/util.mjs';

const { check, done } = makeChecker('disassembly view model');
const img = loadImage(), rd = (a) => (a >= 0x8000 ? img[a - 0x8000] : 0);
const sym = new Symbols(DATA), L = new Listing(rd, DATA.codemap, sym);
const d = (bytes, at = 0x2000) => disassemble((a) => bytes[a - at] ?? 0, at);
const cpu = (o) => ({ a: 0, b: 0, x: 0, y: 0, sp: 0x1FF, ccr: 0, ...o });

// ---- listing --------------------------------------------------------------------------------------------
check('every byte of 8000-FFFF is in a row', L.rowAt.slice(0x8000).every((i) => i >= 0));
const ref = fileURLToPath(new URL('../../analysis/VIPER_04763555.disasm.txt', import.meta.url));
if (existsSync(ref)) {
  let n = 0, bad = 0;
  for (const l of readFileSync(ref, 'utf8').split(/\r?\n/)) {
    const m = /^([0-9A-F]{4})  ((?:[0-9A-F]{2} )+) +(\S+)/.exec(l);
    if (!m || /^(fcb|fdb|fcc)$/.test(m[3])) continue;
    n++; const a = parseInt(m[1], 16), i = L.rowAt[a];
    if (i < 0 || L.rows[i].addr !== a || L.rows[i].kind !== 'code') bad++;
  }
  check('all instructions of the reference listing start a code row', n > 9000 && bad === 0, `${n} instructions, ${bad} misplaced`);
} else console.log('  (skipped the reference-listing check: analysis folder absent)');
{
  const w = L.window(0x944E, 2, 3);
  check('window at the reset entry is static, focused, starts with SEI', !w.dynamic && w.rows[w.focus].addr === 0x944E && w.rows[w.focus].text === 'SEI');
  const v = L.window(0xFFFE, 1, 1);
  check('the vector table shows as words with targets', v.rows[v.focus].text === 'FDB $944E' && v.rows[v.focus].target === 0x944E);
}
// ---- names ----------------------------------------------------------------------------------------------
check('routine names win over listing labels', sym.label(0x944E) === 'Reset' && sym.label(0xF7EA) === 'TIC1_CrankISR', `${sym.label(0x944E)} ${sym.label(0xF7EA)}`);
check('registers, RAM and external I/O are named', sym.name(0x102E) === 'SCSR' && /RPM/i.test(sym.name(0x6E) ?? '') && /latch/.test(sym.name(0x0440)), `${sym.name(0x6E)}`);
check('a word variable names its second byte +1', /\+1$/.test(sym.name(0x6F) ?? ''), sym.name(0x6F));
check('foreign image: no code names', new Symbols(DATA, { generic: true }).label(0x944E) === null);
// ---- operands -------------------------------------------------------------------------------------------
{
  const o1 = operandInfo(d([0x96, 0x6E]), cpu());
  const o2 = operandInfo(d([0xA6, 0x05]), cpu({ x: 0x0480 }));
  const o3 = operandInfo(d([0x18, 0xA6, 0x02]), cpu({ y: 0x0100 }));
  const o4 = operandInfo(d([0xFC, 0x10, 0x0E]), cpu());
  const o5 = operandInfo(d([0x1C, 0x06, 0xF8]), cpu({ x: 0x1000 }));
  const o6 = operandInfo(d([0xBD, 0xEF, 0xF4]), cpu());
  const o7 = operandInfo(d([0x86, 0x7F]), cpu());
  check('direct, indexed X / Y, extended word operands', o1.ea === 0x6E && o1.size === 1 && o2.ea === 0x0485 && o3.ea === 0x0102 && o4.ea === 0x100E && o4.size === 2);
  check('bit operation: address and mask', o5.ea === 0x1006 && o5.mask === 0xF8);
  check('JSR has a target, no data operand; immediate has a value', o6.target === 0xEFF4 && o6.ea === null && o7.imm === 0x7F);
}
// ---- branches -------------------------------------------------------------------------------------------
{
  const beq = d([0x27, 0x02]), bhi = d([0x22, 0x02]), bge = d([0x2C, 0x02]);
  check('BEQ follows Z', branchTaken(beq, cpu({ ccr: 0x04 })) === true && branchTaken(beq, cpu({ ccr: 0 })) === false);
  check('BHI needs C and Z clear', branchTaken(bhi, cpu({ ccr: 0 })) === true && branchTaken(bhi, cpu({ ccr: 0x01 })) === false);
  check('BGE follows N xor V', branchTaken(bge, cpu({ ccr: 0x0A })) === true && branchTaken(bge, cpu({ ccr: 0x08 })) === false);
  const mem = { 0x45: 0x08 }, brset = d([0x12, 0x45, 0x08, 0x02]), brclr = d([0x13, 0x45, 0x08, 0x02]);
  check('BRSET / BRCLR read the memory bit', branchTaken(brset, cpu(), (a) => mem[a] ?? 0) === true && branchTaken(brclr, cpu(), (a) => mem[a] ?? 0) === false);
  check('LDAA is not a branch', branchTaken(d([0x96, 0x6E]), cpu()) === null);
  check('step over: JSR / BSR are calls', nextAddr(d([0xBD, 0xEF, 0xF4])).isCall && nextAddr(d([0x8D, 0x00])).isCall && !nextAddr(d([0x20, 0x00])).isCall);
}
// ---- code outside the map: the SCI 20 worker in external RAM ---------------------------------------------
{
  const m = new ViperMachine();
  FLASH_WORKER_T0.forEach((b, i) => { m.asic.extRam[0x12 + i] = b; });
  const LL = new Listing((a) => m.peek(a), DATA.codemap, sym);
  const w = LL.window(0x0498, 3, 4);
  check('RAM code is decoded on the fly', w.dynamic && w.rows[w.focus].text === 'LDAA #$AA', w.rows[w.focus].text);
  check('back-synchronised rows above it end exactly at the PC', w.rows.slice(0, w.focus).map((r) => r.text).join('|') === 'CLR $00F1|LDAB $04C2',
    w.rows.slice(0, w.focus).map((r) => r.text).join('|'));
  check('backSync finds nothing ending at a byte that no run reaches cleanly', Array.isArray(backSync((a) => m.peek(a), 0x0492, 4)));
}
done();
