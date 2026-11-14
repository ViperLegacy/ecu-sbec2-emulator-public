#!/usr/bin/env node
// Flash-write worker example, end to end in the emulator (design: ../../FLASH_WRITE_WORKER.txt, code:
// ../machine/flash_worker.js). EMULATOR ONLY: 1E and 20 must never be sent to the car on the strength of this.
//   node tools/flash_write_example.mjs            the worked example: VE cell $DB -> $DA in both maps + checksum
//   node tools/flash_write_example.mjs --no-fix   skip the checksum compensation: the next key-off stores code 02
//   node tools/flash_write_example.mjs --raise    try a 0 -> 1 edit ($DB -> $DC): not taken, the cell ends as old AND new
import { ViperMachine } from '../machine/viper_machine.js';
import { keyOnEngineOff, keyOff } from '../machine/scenarios.js';
import { runFlashWriteExample, exampleEdit, FLASH_WORKER_T0, workerHeader } from '../machine/flash_worker.js';

const arg = (n) => process.argv.includes(n);
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const codes = (m) => m.sciRequest([0x10], { timeoutMs: 1500 }).slice(1, -2);   // 10 -> echo, codes..., FE, sum
const romSum = (m) => { let s = 0; for (let a = 0x8000; a < 0x10000; a++) if (a < 0xB600 || a >= 0xB800) s = (s + m.romByte(a)) & 0xFF; return s; };

const m = new ViperMachine({ cop: true });
keyOnEngineOff(m, 1000);
console.log(`image sum (8000-FFFF without B600-B7FF) = $${hx(romSum(m))}, [8005] = $${hx(m.romByte(0x8005))}`);

let patches = exampleEdit((a) => m.romByte(a));
if (arg('--no-fix')) patches = patches.filter((p) => !p.label.startsWith('checksum'));
if (arg('--raise')) patches = [{ addr: 0x83FF, old: m.romByte(0x83FF), data: (m.romByte(0x83FF) + 1) & 0xFF, label: 'VE map row 8 col 4 (0 -> 1 bits)' }];

const t0 = m.ms;
const r = runFlashWriteExample(m, { log: (l) => console.log(l), patches });
const flashEvents = m.log_.since(0).filter((e) => e.type === 'flash');
console.log(`session: ${r.steps.length} requests, ${((m.ms - t0) / 1000).toFixed(1)} s of PCM time (at the MCU's 62500 baud; the car's 7812.5 line is slower)`);
console.log(`flash programs seen by the model: ${flashEvents.map((e) => `$${hx(e.addr, 4)} ${hx(e.old)}&${hx(e.value)}=${hx(e.result)}`).join(', ') || 'none'}`);
console.log(`image sum now $${hx(romSum(m))}; machine faults: ${m.faults.map((f) => f.kind).join(', ') || 'none'}; pending worker flag $F1 = ${hx(m.mem[0xF1])}`);

// the firmware checks the image at key-off (DDE1-DE3A) and stores code 02 on a mismatch
keyOff(m, { ms: 8000 }); m.inputs.key = true; m.run(1500);
const c = codes(m);
console.log(`after a key cycle, SCI 10 codes: ${c.length ? c.map((b) => hx(b)).join(' ') : 'none'}${c.includes(0x02) ? '  <- code 02, flash checksum' : ''}`);

const { L, sum } = workerHeader(FLASH_WORKER_T0);
console.log(`\nworker bytes (L = $${hx(L)}, sum = $${hx(sum)}): ${FLASH_WORKER_T0.map((b) => hx(b)).join(' ')}`);
const expectOk = !arg('--raise');
if (r.ok !== expectOk) { console.error('unexpected result'); process.exit(1); }
