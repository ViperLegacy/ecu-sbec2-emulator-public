// Key-off / key-on with the battery connected keeps 0000-0043 (stored codes, adaptive cells, AIS position, baro);
// a power cycle with the battery disconnected wipes them (cold init). Also checks the key-off save sequence timing.
import { ViperMachine } from '../../machine/viper_machine.js';
import { startEngine, keyOff } from '../../machine/scenarios.js';
import { makeChecker, hex, hx } from './util.mjs';
const { check, done } = makeChecker('key cycle / keep-alive RAM');

const m = new ViperMachine();
m.inputs.coolantC = 85;
m.run(1500);
startEngine(m, { rpm: 800, map: 0x50 });
m.run(5000);
m.stimulus.setRpm(0); m.run(3000);
m.poke(0x40, 0x1E); m.poke(0x3F, 0x24);     // two stored codes
m.poke(0x1C, 0x05); m.poke(0x32, 0xFB);     // adaptive cells
m.run(100);
const before = m.getKeepAlive();
let saveAt = null;
const offF0E6 = m.addBreakpoint(0xF0E6, (mm) => { if (saveAt === null) saveAt = mm.ms; });
const tOff = m.ms;
keyOff(m, { ms: 8000 });
offF0E6();
const saved = m.getKeepAlive();
let sum = 0; for (let a = 2; a < 0x44; a++) sum += saved[a];
check('key off: word 0000 = sum(0002..0043)', ((saved[0] << 8) | saved[1]) === (sum & 0xFFFF), `0000=${hx(saved[0])}${hx(saved[1])} sum=${hx(sum & 0xFFFF, 4)}`);
check('key off: save reached within ~0.3 s + 2 x 1.75 s', saveAt !== null && saveAt - tOff > 200 && saveAt - tOff < 5000, `F0E6 at +${saveAt === null ? '-' : (saveAt - tOff).toFixed(0)} ms`);
const diffs = [];
for (let a = 2; a < 0x44; a++) if (before[a] !== saved[a]) diffs.push(`${hx(a)}:${hx(before[a])}->${hx(saved[a])}`);
console.log(`  note keep-alive bytes the firmware changed during power-down: ${diffs.join(' ') || 'none'}`);
check('key off: latch 0440 = 07 and outputs off', m.asic.latch === 0x07);

// key on again (battery connected all the time)
m.inputs.key = true; m.run(1000);
const after = m.getKeepAlive();
const d2 = [];
for (let a = 2; a < 0x44; a++) if (saved[a] !== after[a]) d2.push(`${hx(a)}:${hx(saved[a])}->${hx(after[a])}`);
console.log(`  note keep-alive bytes changed by the warm start: ${d2.join(' ') || 'none'}`);
check('key on: codes 1E and 24 still stored', m.storedCodes().includes(0x1E) && m.storedCodes().includes(0x24), hex(m.storedCodes()));
check('key on: adaptive cells $1C/$32 kept', m.mem[0x1C] === saved[0x1C] && m.mem[0x32] === saved[0x32], `${hx(m.mem[0x1C])} ${hx(m.mem[0x32])}`);
check('key on: no cold init ($04.6 clear)', !(m.mem[0x04] & 0x40), `$04=${hx(m.mem[4])}`);
const r = m.sciRequest([0x10]);
check('key on: SCI 10 lists both codes', r[1] === 0x24 || r[1] === 0x1E, hex(r));

// full power cycle, battery connected
m.inputs.key = false; m.run(8000);
const ka = m.getKeepAlive();
m.powerCycle({ batteryConnected: true });
const kb = m.getKeepAlive();
check('powerCycle battery connected: 0000-0043 identical right after power-up reset', kb.every((v, i) => v === ka[i]));
m.inputs.key = true; m.run(500);
check('powerCycle battery connected: codes kept, warm start', m.storedCodes().includes(0x1E) && !(m.mem[0x04] & 0x40) && m.mem[0x1C] === ka[0x1C], `${hex(m.storedCodes())} $04=${hx(m.mem[4])}`);

// battery disconnected
m.inputs.key = false; m.run(8000);
m.powerCycle({ batteryConnected: false }); m.inputs.key = true; m.run(500);
check('powerCycle battery disconnected: cold init, codes lost, adaptives cleared',
  m.storedCodes().length === 0 && !!(m.mem[0x04] & 0x40) && m.mem[0x1C] === 0 && m.mem[0x32] === 0, `${hex(m.storedCodes())} $04=${hx(m.mem[4])} $1C=${hx(m.mem[0x1C])}`);
// key-off while the engine is running (ignition cut at speed)
{
  const n = new ViperMachine();
  n.inputs.coolantC = 85; n.run(1500); startEngine(n, { rpm: 800, map: 0x50 }); n.run(2000);
  n.poke(0x40, 0x1E); n.run(50);
  n.inputs.key = false; n.run(300); n.stimulus.setRpm(0); n.run(8000);
  n.inputs.key = true; n.run(500);
  check('key off with the engine running then key on: code kept, no faults', n.storedCodes().includes(0x1E) && n.faults.length === 0, `${hex(n.storedCodes())} ${JSON.stringify(n.faults.slice(0, 1))}`);
}
check('no machine faults', m.faults.length === 0, JSON.stringify(m.faults.slice(0, 2)));
done();
