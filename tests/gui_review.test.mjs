// Regression checks for bugs found in the adversarial GUI review (2026-11-12). Node only, no DOM.
//   node emulator/tests/gui_review.test.mjs
import { DATA } from '../rom/viper_rom.js';
import { ViperMachine } from '../machine/viper_machine.js';
import { buildSciIndex, findUnsafe } from '../gui/sci_decode.js';
import { tableByAddr, liveCurveInput, rpmRounded } from '../gui/maps.js';
import { RAM_SCALES } from '../gui/format.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '   ' + info : ''}`); };

const idx = buildSciIndex(DATA);
check('unsafe gate: 13 01 refused', findUnsafe(idx, [0x13, 0x01])?.code === 0x13);
check('unsafe gate: 10 13 01 refused (13 after a complete 10)', findUnsafe(idx, [0x10, 0x13, 0x01])?.code === 0x13);
check('unsafe gate: 14 05 1C 00 00 refused', findUnsafe(idx, [0x14, 0x05, 0x1C, 0, 0])?.code === 0x1C);
check('unsafe gate: 15 13 13 is a read (13 are address bytes)', findUnsafe(idx, [0x15, 0x13, 0x13]) === null);
check('unsafe gate: 17 x25 allowed', findUnsafe(idx, new Array(25).fill(0x17)) === null);
check('unsafe gate: 16 80 / 22 01 allowed', findUnsafe(idx, [0x16, 0x80, 0x22, 0x01]) === null);
check('unsafe gate: alias 9C (-> 1C EEPROM write) refused', findUnsafe(idx, [0x9C])?.code === 0x9C);
check('unsafe gate: 10 9D (alias of 1D) refused', findUnsafe(idx, [0x10, 0x9D])?.code === 0x9D);
check('unsafe gate: alias 90 / 96 (-> 10 / 16) allowed', findUnsafe(idx, [0x90, 0x96]) === null);

// EFCE: ldd $6E / aslb / adca #0 wraps (no saturation)
check('rpmRounded wraps like adca #0', rpmRounded((a) => (a === 0x6E ? 0xFF : 0x80)) === 0x00 && rpmRounded((a) => (a === 0x6E ? 0x18 : 0x80)) === 0x19);
// 85CF input is $6E NOT rounded (D11B ldaa <$6E)
const li = liveCurveInput(tableByAddr(DATA, '85CF'), (a) => (a === 0x6E ? 0x18 : 0x80));
check('85CF live input is $6E not rounded', li && li.a === 0x18, JSON.stringify(li));
check('8058 live input is rounded', liveCurveInput(tableByAddr(DATA, '8058'), (a) => (a === 0x6E ? 0x18 : 0x80)).a === 0x19);
// $B0: D1F7 builds D = $01:$B0 -> unsigned
check('$B0 scale unsigned 1+x/256', RAM_SCALES['00B0'].f(0xC0) === 1 + 0xC0 / 256);

// the machine actually runs the second command of "10 13 01" (why the gate must walk the whole request)
const m = new ViperMachine();
m.run(1500);
const r = m.sciRequest([0x10, 0x13, 0x01], { timeoutMs: 1500 });
check('machine: "10 13 01" echoes the 13 as a new command', r.includes(0x13), r.slice(0, 8).map((b) => b.toString(16)).join(' ') + ' ...');

// why the alias family must be gated: $9C runs the 1C handler with zeroed args -> EEPROM B600 := 00
const m2 = new ViperMachine();
m2.run(2000);
const b600 = m2.getEeprom()[0];
m2.sciRequest([0x9C], { timeoutMs: 500 });
m2.run(500);
check('machine: alias 9C writes 00 to EEPROM B600', b600 !== 0 && m2.getEeprom()[0] === 0, `B600 ${b600.toString(16)} -> ${m2.getEeprom()[0].toString(16)}`);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
