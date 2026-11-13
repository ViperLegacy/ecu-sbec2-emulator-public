// Discrete-input fault paths: each documented provoking input gives its code, and the default inputs give none.
//   cam pattern 'none' -> 01, 'quick' syncs (6-edge rule), $0400.3 SPI busy -> 44, $0405.2 = 0 -> injector codes,
//   side channel bits -> 15/45/coil codes, $048E bits -> 19/22/5C, AIS decode follows $05.
import { ViperMachine } from '../../machine/viper_machine.js';
import { startEngine } from '../../machine/scenarios.js';
import { makeChecker, hex, hx } from './util.mjs';
const { check, done } = makeChecker('discrete fault inputs');
const codesOf = (m) => [...m.storedCodes(), m.mem[0xF8], m.mem[0xF9]].filter((x) => x);
function running(setup, { ms = 10000, rpm = 800 } = {}) {
  const m = new ViperMachine();
  m.inputs.coolantC = 85; m.run(1500);
  setup?.(m, 'pre');
  startEngine(m, { rpm, map: 0x50 });
  setup?.(m, 'run');
  m.run(ms);
  return m;
}
{
  const m = running((mm, ph) => { if (ph === 'pre') mm.stimulus.setCamPattern('none'); });
  // F849: the TIC1 sync logic runs only once $4F.6 (an IRQ seen) is set, so with no cam at all the engine never syncs
  check('cam pattern none: code 01 (no cam signal) and no sync (F849 needs $4F.6)', codesOf(m).includes(0x01) && !(m.mem[0x4F] & 0x80) && !(m.mem[0x44] & 0x40), `codes ${hex(codesOf(m))} $44=${hx(m.mem[0x44])}`);
}
{
  const m = running((mm, ph) => { if (ph === 'pre') mm.stimulus.setCamPattern('quick'); });
  check('cam pattern quick: syncs and runs, no code 01', !!(m.mem[0x4F] & 0x80) && !!(m.mem[0x44] & 0x40) && !codesOf(m).includes(0x01), `codes ${hex(codesOf(m))}`);
}
{
  const m = new ViperMachine(); m.run(1500); m.inputs.spiBusy = true; m.run(5000);
  check('$0400.3 held busy: code 44 (SPI communications)', codesOf(m).includes(0x44), `codes ${hex(codesOf(m))}`);
}
{
  // one status byte only makes the code pending (it matures over repeated frames): 15 pending right after it
  const m = running(null, { ms: 500 });
  m.sideChannelSend([0x05]); m.run(40);
  check('side channel 05 (bit2 + bit0): $0115.2 set and code 15 pending', !!(m.mem[0x115] & 0x04) && [m.mem[0xF8], m.mem[0xF9]].includes(0x15),
    `$0115=${hx(m.mem[0x115])} pending ${hex([m.mem[0xF8], m.mem[0xF9]])}`);
}
{
  const m = new ViperMachine(); m.run(1500); m.inputs.smartReply = [0, 0, 0, 0x94]; m.run(6000);
  const c = codesOf(m);
  check('$048E bits 2/4/7: codes 19, 22, 5C', c.includes(0x19) && c.includes(0x22) && c.includes(0x5C), `codes ${hex(c)}`);
}
{
  const m = new ViperMachine(); m.run(500);
  m.run(5000);
  check('AIS decode: SPI phase steps == change of $05 (cold init homes from DF)', 0xDF + m.outputs.ais.steps === m.mem[0x05] && m.outputs.ais.invalid === 0, `steps ${m.outputs.ais.steps} $05=${hx(m.mem[5])} invalid ${m.outputs.ais.invalid}`);
}
{
  const m = running(null, { ms: 3000 });
  check('defaults while running: no codes (23 needs VSS: run is short)', codesOf(m).length === 0, `codes ${hex(codesOf(m))}`);
}
done();
