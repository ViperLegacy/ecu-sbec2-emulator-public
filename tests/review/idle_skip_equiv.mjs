// The main-loop idle skip (9E0E wait) must be cycle-exact: a machine with idleSkip:false must end in exactly the
// same CPU/RAM state, event log and SCI traffic as the default machine over boot, SCI, crank, run and key-off.
import { ViperMachine } from '../../machine/viper_machine.js';
import { makeChecker, hex, hx } from './util.mjs';
const { check, done } = makeChecker('idle-skip equivalence');
function script(m) {
  const log = [];
  const snap = (tag) => log.push(`${tag} pc=${hx(m.cpu.pc, 4)} cyc=${m.cpu.cycles} sp=${hx(m.cpu.sp, 4)} ram=${hashRam(m)} ev=${m.eventSeq}`);
  m.inputs.coolantC = 85;
  m.run(1500); snap('boot');
  log.push('sci ' + hex(m.sciRequest([0x16, 0x80]))); snap('sci');
  m.stimulus.setRpm(250); m.run(1500); snap('crank');
  m.inputs.mapCounts = 0x50; m.stimulus.setRpm(800, { rampMs: 800 }); m.run(2000); snap('idle');
  m.stimulus.setSpeedMph(40); m.inputs.tpsCounts = 0x70; m.stimulus.setRpm(3000, { rampMs: 800 }); m.run(2000); snap('3000');
  log.push('sci ' + hex(m.sciRequest([0x22, 0x01], { count: 6 }))); m.sciRequest([0]); snap('sci2');
  m.stimulus.setRpm(0); m.stimulus.setSpeedMph(0); m.run(2500); m.inputs.key = false; m.run(6000); snap('keyoff');
  m.inputs.key = true; m.run(500); snap('keyon');
  return log;
}
function hashRam(m) { let h = 2166136261; for (let a = 0; a < 0x200; a++) h = Math.imul(h ^ m.mem[a], 16777619) >>> 0; for (let a = 0; a < 0x80; a++) h = Math.imul(h ^ m.asic.extRam[a], 16777619) >>> 0; return hx(h, 8); }
const a = script(new ViperMachine());
const b = script(new ViperMachine({ idleSkip: false }));
{
  // fine-grained: 1 ms runs end on the same instruction boundary with the same registers (regression: a skip that
  // landed exactly on the end of a run still executed one more instruction, so run(ms) overshot)
  const x = new ViperMachine(), y = new ViperMachine({ idleSkip: false });
  for (const m of [x, y]) { m.inputs.coolantC = 85; m.run(1500); m.stimulus.setRpm(250); m.run(1500); m.inputs.mapCounts = 0x50; m.stimulus.setRpm(800, { rampMs: 500 }); }
  let bad = null;
  for (let t = 0; t < 1500 && !bad; t++) {
    x.run(1); y.run(1);
    const sx = [x.cpu.pc, x.cpu.cycles, x.cpu.D, x.cpu.ccr, x.cpu.sp].join(','), sy = [y.cpu.pc, y.cpu.cycles, y.cpu.D, y.cpu.ccr, y.cpu.sp].join(',');
    if (sx !== sy) bad = `t=${t} ms: skip ${sx} / noskip ${sy}`;
  }
  check('1500 x run(1): PC, cycles, D, CCR, SP identical with and without the idle skip', !bad, bad || 'identical');
}
for (let i = 0; i < a.length; i++) check(`step ${i}: ${a[i].split(' ')[0]}`, a[i] === b[i], a[i] === b[i] ? a[i] : `\n      skip:   ${a[i]}\n      noskip: ${b[i]}`);
done();
