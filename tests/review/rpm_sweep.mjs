// rpm sweep 0 -> 7000 -> 0 in steps (each held 400 ms): rpm16 $6E:$6F must equal rpm*8 within 1% everywhere,
// $44.6 must follow the run thresholds, and the stall at 0 must clear sync/running.
import { ViperMachine } from '../../machine/viper_machine.js';
import { makeChecker, rpm16, hex } from './util.mjs';
const { check, done } = makeChecker('rpm sweep 0 -> 7000 -> 0');
const m = new ViperMachine();
m.inputs.coolantC = 85; m.inputs.mapCounts = 0x60; m.inputs.tpsCounts = 0x60;
m.run(1500);
m.stimulus.setRpm(250); m.run(1500);
const up = []; for (let r = 300; r <= 7000; r += 100) up.push(r);
const steps = [...up, ...up.slice().reverse().slice(1), 250];
let worst = 0, worstAt = 0, n = 0, tachWorst = 0, tachAt = 0, snapWorst = 0, snapAt = 0;
for (const r of steps) {
  m.stimulus.setRpm(r, { rampMs: 100 }); m.run(200);
  const tg0 = m.outputs.tach.toggles; m.run(200);
  const hz = (m.outputs.tach.toggles - tg0) / 2 / 0.2;
  const got = rpm16(m) / 8;
  const dev = Math.abs(got - r) / r;
  if (dev > worst) { worst = dev; worstAt = r; }
  n++;
  const tdev = Math.max(0, Math.abs(hz - r / 24) - 2.5 /* +-1 toggle in 0.2 s */) / (r / 24);   // $0440.1 toggles per cylinder edge
  if (tdev > tachWorst) { tachWorst = tdev; tachAt = r; }
  const sdev = Math.abs(m.outputs.snapshot().tach.hz - r / 24) / (r / 24);
  if (r >= 400 && sdev > snapWorst) { snapWorst = sdev; snapAt = r; }
  if (dev >= 0.01) console.log(`   dev ${(dev * 100).toFixed(2)}% at ${r} rpm (rpm16 ${rpm16(m)})`);
}
check('rpm16/8 within 1% of the stimulus on every step', worst < 0.01, `${n} steps, worst ${(worst * 100).toFixed(3)}% at ${worstAt} rpm`);
check('tach $0440.1 frequency = rpm/24 Hz (toggle per cylinder edge) on every step', tachWorst < 0.05, `worst ${(tachWorst * 100).toFixed(2)}% at ${tachAt} rpm`);
check('outputs.snapshot().tach.hz (10-toggle average) within 5% of rpm/24', snapWorst < 0.05, `worst ${(snapWorst * 100).toFixed(2)}% at ${snapAt} rpm`);
check('at 250 rpm after the sweep: still synced and running (run flag clears only < 200 rpm)', !!(m.mem[0x4F] & 0x80) && !!(m.mem[0x44] & 0x40), `$4F=${hex([m.mem[0x4F]])} $44=${hex([m.mem[0x44]])}`);
m.stimulus.setRpm(0); m.run(3000);
check('stall: no edges for >2.1 s clears running', !(m.mem[0x44] & 0x40), `$44=${hex([m.mem[0x44]])} $4F=${hex([m.mem[0x4F]])} rpm16 ${rpm16(m)}`);
check('tach snapshot hz reads 0 once the engine has stopped', m.outputs.snapshot().tach.hz === 0, `${m.outputs.snapshot().tach.hz}`);
check('no machine faults', m.faults.length === 0, JSON.stringify(m.faults.slice(0, 2)));
check('codes after the sweep (no VSS, so 23 is legitimate)', m.storedCodes().every((c) => c === 0x23), hex(m.storedCodes()));
done();
