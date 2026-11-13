// Sensor sweeps: the RAM conversions move monotonically with the inputs, and the out-of-range DTCs of faults.json
// (1A/1B TPS, 1E/1F coolant, 39/3A air, 24/25 MAP) set at the out-of-range ends and only there.
// Thresholds are read from the image: 9031/9032 (TPS), 901C/901D (coolant), 901F/9020 (air), 903D/903E (MAP).
import { ViperMachine } from '../../machine/viper_machine.js';
import { startEngine } from '../../machine/scenarios.js';
import { makeChecker, hex, hx } from './util.mjs';
const { check, done } = makeChecker('sensor sweeps');
const R = new ViperMachine();
const rb = (a) => R.romByte(a);
const TH = { tpsLo: rb(0x9031), tpsHi: rb(0x9032), clLo: rb(0x901C), clHi: rb(0x901D), atLo: rb(0x901F), atHi: rb(0x9020), mapLo: rb(0x903D), mapHi: rb(0x903E) };
console.log('  thresholds', JSON.stringify(Object.fromEntries(Object.entries(TH).map(([k, v]) => [k, hx(v)]))));

// ---- monotonic conversions (one machine, slow sweep) ----
{
  const m = new ViperMachine(); m.run(1500);
  const sweep = (setter, addr, values, settle = 250) => values.map((v) => { setter(v); m.run(settle); return m.mem[addr]; });
  const mono = (a) => a.every((v, i) => i === 0 || v >= a[i - 1]);
  const raws = Array.from({ length: 64 }, (_, i) => i * 4 + 2);
  const tpsIn = raws.filter((v) => v >= TH.tpsLo && v < TH.tpsHi);
  const tpsRaw = sweep((v) => { m.inputs.tpsCounts = v; }, 0x7F, tpsIn);
  check('TPS AN3 -> $7F raw equals the input', tpsRaw.every((v, i) => v === tpsIn[i]), tpsRaw.map((v) => hx(v)).join(' '));
  m.inputs.tpsCounts = 0x30; m.run(300);
  const tps = sweep((v) => { m.inputs.tpsCounts = v; }, 0x77, tpsIn);
  check('TPS -> $77 validated follows the raw input inside 08..EF', tps.every((v, i) => v === tpsIn[i]), tps.map((v) => hx(v)).join(' '));
  m.inputs.tpsCounts = 0x30; m.run(300);
  const volts = Array.from({ length: 33 }, (_, i) => 8 + i * 0.25);
  const bat = sweep((v) => { m.inputs.batteryV = v; }, 0x80, volts, 300);
  check('battery AN1 -> $80 = V*16 (refreshed every 4th pass)', bat.every((v, i) => v === Math.min(255, Math.round(volts[i] * 16))), bat.map((v) => hx(v)).join(' '));
  m.inputs.batteryV = 14; m.run(300);
  const temps = Array.from({ length: 34 }, (_, i) => -40 + i * 5);
  m.inputs.coolantC = -40; m.inputs.airC = -40; m.run(20000);       // $7B/$78 are slew-filtered (~1 count/100 ms)
  const cl = sweep((v) => { m.inputs.coolantC = v; }, 0x7B, temps, 2000);
  check('coolant degC -> $7B monotonic', mono(cl), cl.map((v) => hx(v)).join(' '));
  check('coolant $7B within 3 C of the setting over -40..125 C', cl.every((v, i) => Math.abs(v - 128 - temps[i]) <= 3), cl.map((v, i) => `${temps[i]}:${v - 128}`).join(' '));
  m.inputs.airC = -40; m.run(3000);
  const at = sweep((v) => { m.inputs.airC = v; }, 0x78, temps, 2000);
  check('air degC -> $78 monotonic', mono(at), at.map((v) => hx(v)).join(' '));
  check('air $78 within 3 C of the setting over -40..125 C', at.every((v, i) => Math.abs(v - 128 - temps[i]) <= 3), at.map((v, i) => `${temps[i]}:${v - 128}`).join(' '));
  const o2v = [0, 0.1, 0.3, 0.45, 0.6, 0.9, 1.0];
  const o2 = sweep((v) => { m.inputs.o2_1V = v; }, 0x79, o2v, 300);
  check('O2 1 AN2 -> $79 = V*51', o2.every((v, i) => v === Math.round(o2v[i] * 51)), o2.join(' '));
  m.inputs.coolantC = 85; m.inputs.airC = 30; m.run(3000);
  startEngine(m, { rpm: 800, map: 0x50 });
  const mapIn = raws.filter((v) => v >= 0x30 && v <= 0xC0);
  const map = sweep((v) => { m.inputs.mapCounts = v; }, 0x76, mapIn, 400);
  // $76 = (EFB9(new) + $014A(previous sample)) / 2 (FA0B-FA12): settled value = raw*264/256
  check('MAP AN0 -> $76 = min(255, raw*264/256) while running (sampled on crank events)', map.every((v, i) => Math.abs(v - Math.min(255, (mapIn[i] * 264) >> 8)) <= 1), map.map((v) => hx(v)).join(' '));
  m.inputs.mapCounts = 0x50; m.run(500);
  check('no DTC from in-range sweeps (23/27 are legitimate: no VSS / MAP sweep while idling)', m.storedCodes().filter((c) => c !== 0x23 && c !== 0x27).length === 0, hex(m.storedCodes()));
}

// ---- out-of-range codes, one fresh machine per value ----
function codesWith(ch, raw, { running = false, ms = 8000 } = {}) {
  const m = new ViperMachine();
  m.inputs.coolantC = 85;
  m.run(1500);
  if (running) { startEngine(m, { rpm: 800, map: 0x50 }); }
  m.inputs.setRaw(ch, raw);
  m.run(ms);
  return [...m.storedCodes(), m.mem[0xF8], m.mem[0xF9]].filter((x) => x);
}
const cases = [
  { name: 'TPS AN3', ch: 3, lo: 0x1A, hi: 0x1B, loTh: TH.tpsLo, hiTh: TH.tpsHi, hiIncl: true },
  { name: 'coolant AN4', ch: 4, lo: 0x1E, hi: 0x1F, loTh: TH.clLo, hiTh: TH.clHi, hiIncl: false },
  { name: 'air AN5', ch: 5, lo: 0x39, hi: 0x3A, loTh: TH.atLo, hiTh: TH.atHi, hiIncl: false },
  { name: 'MAP AN0 (idle 800 rpm)', ch: 0, lo: 0x24, hi: 0x25, loTh: TH.mapLo, hiTh: TH.mapHi, hiIncl: true, running: true },
];
for (const c of cases) {
  const vals = [...new Set([0, Math.max(0, c.loTh - 1), c.loTh, c.loTh + 1, 0x80, c.hiTh - 1, c.hiTh, Math.min(255, c.hiTh + 1), 255])];
  for (const v of vals) {
    const codes = codesWith(c.ch, v, { running: c.running });
    const wantLo = v < c.loTh, wantHi = c.hiIncl ? v >= c.hiTh : v > c.hiTh;
    const hasLo = codes.includes(c.lo), hasHi = codes.includes(c.hi);
    const others = codes.filter((x) => x !== c.lo && x !== c.hi && !(c.running && x === 0x23));
    check(`${c.name} raw ${hx(v)}: code ${hx(c.lo)} ${wantLo ? 'set' : 'clear'}, ${hx(c.hi)} ${wantHi ? 'set' : 'clear'}`,
      hasLo === wantLo && hasHi === wantHi, `codes ${hex(codes)}${others.length ? ' (others ' + hex(others) + ')' : ''}`);
  }
}
done();
