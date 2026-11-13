// Sync from every starting crank phase: start the generator just before each of the 20 TIC1 edges (and mid-way
// between edges) and require the firmware slot $63 to equal the generator slot on every spark frame after sync,
// i.e. all starting phases lock to the SAME slot phase and keep it through a ramp to 800 and 3000 rpm.
import { ViperMachine } from '../../machine/viper_machine.js';
import { makeChecker } from './util.mjs';
const { check, done } = makeChecker('sync from every crank phase');

const base = new ViperMachine();
base.inputs.coolantC = 85;
base.run(1000);
const results = [];
for (let k = 0; k < 40; k++) {
  const m = new ViperMachine();
  m.inputs.coolantC = 85;
  m.run(1000);
  const s = m.stimulus;
  const startAngle = k % 2 === 0 ? (s.edgeAngles[k / 2] - 1 + 720) % 720 : (s.edgeAngles[(k - 1) / 2] + 18) % 720;
  s.angle = startAngle; s.lastCycle = m.cpu.cycles; s._rebuild();
  const seq = m.eventSeq;
  s.setRpm(250);
  const synced = m.runUntil((mm) => !!(mm.mem[0x4F] & 0x80), { timeoutMs: 3000 });
  const syncMs = m.ms;
  m.run(1500);
  m.inputs.mapCounts = 0x50;
  s.setRpm(800, { rampMs: 1000 }); m.run(2000);
  s.setRpm(3000, { rampMs: 1000 }); m.run(2000);
  const sp = m.events(seq, 'spark').filter((e) => e.cycle > m.msToCycles(syncMs + 200));
  const bad = sp.filter((e) => e.genSlot !== e.slot);
  const lost = m.events(seq, 'spark').length;
  results.push({ k, startAngle, synced, syncMs: syncMs - 1000, frames: sp.length, bad: bad.length, offset: bad.length ? ((bad[0].slot - bad[0].genSlot + 10) % 10) : 0, running: !!(m.mem[0x44] & 0x40), codes: m.storedCodes() });
}
for (const r of results) {
  check(`start at ${r.startAngle.toFixed(0)} deg: sync, $63 == generator slot`, r.synced && r.frames > 50 && r.bad === 0 && r.running && r.codes.length === 0,
    `sync ${r.syncMs.toFixed(0)} ms, ${r.frames} frames, ${r.bad} mismatched (fw-gen offset ${r.offset}), codes ${r.codes}`);
}
done();
