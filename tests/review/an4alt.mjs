// AN4-alt input (second AN4 measurement, $0440.7 = 1 -> $014B, ratio -> curve BCCA -> $88).
// Regression: the setter used to invert q = A*B/(A-B), but the firmware (95B2-95D7, BC68-BC95) computes
// q = A*B / (A - B + round(A*B/256)), so inputs.an4AltC = 20 C gave $88 = 34 C. Now $88 must follow the setting.
import { ViperMachine } from '../../machine/viper_machine.js';
import { an4AltRatio } from '../../machine/inputs.js';
import { makeChecker } from './util.mjs';
const { check, done } = makeChecker('AN4-alt (second AN4 measurement)');
check('an4AltRatio follows BC68: A=F5 B=48 -> 72', an4AltRatio(0xF5, 0x48) === Math.floor((0xF5 * 0x48) / (0xF5 - 0x48 + ((0xF5 * 0x48) >> 8) + (((0xF5 * 0x48) >> 7) & 1))));
check('an4AltRatio skips B >= A (bls)', an4AltRatio(0x40, 0x40) === null && an4AltRatio(0x40, 0x50) === null);
const m = new ViperMachine();
m.run(1500);
for (const t of [-20, 0, 20, 40, 60, 75]) {
  m.inputs.an4AltC = t;
  m.run(15000);                       // measured once per 128 passes and slew-limited
  check(`an4AltC ${t} C -> $88 = ${t} C (+-2)`, Math.abs(m.mem[0x88] - 128 - t) <= 2, `$88 = ${m.mem[0x88] - 128} C, $014B=${m.mem[0x14B].toString(16)} $0149=${m.mem[0x149].toString(16)}`);
}
check('no codes, no faults', m.storedCodes().length === 0 && m.faults.length === 0);
done();
