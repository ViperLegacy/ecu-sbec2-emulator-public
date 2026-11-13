// Decode-coverage smoke test: run the Viper PCM image (04763555) from its reset vector on flat RAM.
// Run from ecu/sbec2/viper:  node emulator/tests/viper_smoke.test.mjs [steps]
// Everything outside 8000..FFFF (including the 1000..103F register block) is plain RAM, so peripheral
// polling loops may spin; the point is only that the core decodes everything the firmware reaches.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HC11, disassemble } from '../hc11/cpu.js';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = join(here, '..', '..', 'dumps', 'VIPER_04763555_8000-FFFF.bin');
const STEPS = Number(process.argv.find((v, i) => i > 1 && /^\d+$/.test(v)) || 200000);

const img = readFileSync(IMG);
if (img.length !== 0x8000) throw new Error(`image is ${img.length} bytes, expected 32768`);
const mem = new Uint8Array(65536);
mem.set(img, 0x8000);

const illegal = [];
const rom = (a) => a >= 0x8000;
let romWrites = 0; const romWriteAddrs = new Set();
// Minimal "status bits always ready" assist so polling loops fall through (decode coverage only, not a model):
// ADCTL.CCF (1030 b7), SCSR TDRE|TC (102E b7,b6), TCNT (100E/100F) = E-cycle count. Disable with --raw.
const RAW = process.argv.includes('--raw');
const ASSIST = { 0x1030: 0x80, 0x102E: 0xC0 };
const bus = {
  read8: (a, cyc) => {
    if (RAW) return mem[a];
    if (a === 0x100E) return (cyc >> 8) & 0xFF;
    if (a === 0x100F) return cyc & 0xFF;
    return ASSIST[a] === undefined ? mem[a] : mem[a] | ASSIST[a];
  },
  write8: (a, v) => { if (rom(a)) { romWrites++; romWriteAddrs.add(a); return; } mem[a] = v; },
  onIllegal: (addr, bytes) => illegal.push({ addr, bytes }),
};
const cpu = new HC11(bus);
cpu.reset();
const resetPC = cpu.PC;

const visits = new Map();
const recent = new Map();
let errors = null, steps = 0;
try {
  for (; steps < STEPS; steps++) {
    const pc = cpu.PC;
    visits.set(pc, (visits.get(pc) || 0) + 1);
    if (steps >= STEPS - 5000) recent.set(pc, (recent.get(pc) || 0) + 1);
    cpu.step();
    if (cpu.waiting || cpu.stopped) break;
  }
} catch (e) { errors = e; }

const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
console.log(`reset vector -> ${h4(resetPC)}`);
console.log(`steps executed: ${steps}, E cycles: ${cpu.cycles}, unique PCs: ${visits.size}, writes to ROM ignored: ${romWrites}`);
console.log(`final state: PC=${h4(cpu.PC)} SP=${h4(cpu.SP)} X=${h4(cpu.X)} Y=${h4(cpu.Y)} D=${h4(cpu.D)} CCR=${cpu.CCR.toString(2).padStart(8, '0')}` +
  `${cpu.waiting ? ' (WAI)' : ''}${cpu.stopped ? ' (STOP)' : ''}`);
console.log(`ROM-area write addresses: ${[...romWriteAddrs].sort((a, b) => a - b).slice(0, 16).map(h4).join(" ")}${romWriteAddrs.size > 16 ? " ..." : ""}`);
console.log(`illegal-opcode traps: ${illegal.length}`);
for (const t of illegal.slice(0, 20)) console.log(`  illegal at ${h4(t.addr)}: ${t.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
const hot = [...recent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('hottest PCs in the last 5000 steps (where it is spinning):');
for (const [pc, n] of hot) console.log(`  ${h4(pc)} x${n}  ${disassemble((a) => mem[a], pc).text}`);
// Static check: recursive-descent walk from every vector; every reached opcode must decode legally.
{
  const seen = new Set(), bad = [], work = [];
  for (let v = 0xFFD6; v <= 0xFFFE; v += 2) work.push((mem[v] << 8) | mem[v + 1]);
  while (work.length) {
    let pc = work.pop();
    while (pc >= 0x8000 && !seen.has(pc)) {
      seen.add(pc);
      const d = disassemble((a) => mem[a], pc);
      if (d.text.startsWith('FCB')) { bad.push(pc); break; }
      const mn = d.text.split(' ')[0];
      if (d.target !== null && d.target !== undefined) work.push(d.target);
      if (['RTS', 'RTI', 'JMP', 'BRA', 'SWI', 'STOP', 'WAI'].includes(mn)) break;
      pc = (pc + d.length) & 0xFFFF;
    }
  }
  console.log(`static walk from vectors: ${seen.size} instructions reached, ${bad.length} undecodable` +
    (bad.length ? ': ' + bad.slice(0, 10).map(h4).join(' ') : ''));
}
if (errors) console.log('EXCEPTION:', errors.message);
const ok = !errors && illegal.length === 0;
console.log(ok ? 'viper smoke: PASS (no unimplemented/illegal opcodes reached)' : 'viper smoke: FAIL');
if (!ok) process.exit(1);
