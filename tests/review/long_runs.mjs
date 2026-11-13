// 60 s emulated at idle (800 rpm) and at 3000 rpm: no spurious DTCs, machine faults, COP timeout, FD04 loop,
// stack drift (SP identical at every main-loop wait) or stack overrun into used RAM.
import { ViperMachine } from '../../machine/viper_machine.js';
import { startEngine } from '../../machine/scenarios.js';
import { makeChecker, hex, hx, rpm16, trackMainLoop } from './util.mjs';
const { check, done } = makeChecker('long runs (60 s emulated)');

// 3000 rpm needs road speed, or code 23 (no VSS signal) is a correct firmware result.
for (const [label, rpm, map, tps, mph, passMs] of [['idle 800 rpm', 800, 0x50, 0x30, 0, 15], ['3000 rpm part throttle 50 mph', 3000, 0x80, 0x70, 50, 40]]) {
  const m = new ViperMachine({ cop: true });
  m.inputs.coolantC = 85; m.inputs.airC = 30;
  m.run(1500);
  startEngine(m, { rpm: 800, map: 0x50 });
  m.inputs.tpsCounts = tps; m.inputs.mapCounts = map;
  m.stimulus.setRpm(rpm, { rampMs: 1000 }); m.stimulus.setSpeedMph(mph);
  m.run(3000);
  const codes0 = m.storedCodes();
  const st = trackMainLoop(m);
  let maxDev = 0, minPw = Infinity, maxPw = 0, pend = new Set();
  const h = Date.now();
  for (let s = 0; s < 60; s++) {
    m.run(1000);
    const r = rpm16(m) / 8;
    maxDev = Math.max(maxDev, Math.abs(r - rpm) / rpm);
    const pw = (m.mem[0x89] << 8) | m.mem[0x8A];
    minPw = Math.min(minPw, pw); maxPw = Math.max(maxPw, pw);
    if (m.mem[0xF8]) pend.add(hx(m.mem[0xF8])); if (m.mem[0xF9]) pend.add(hx(m.mem[0xF9]));
  }
  st.stop();
  const hostS = (Date.now() - h) / 1000;
  check(`${label}: no machine faults`, m.faults.length === 0, JSON.stringify(m.faults.slice(0, 3)));
  check(`${label}: no stored DTC`, m.storedCodes().length === 0, `before ${hex(codes0)} after ${hex(m.storedCodes())}`);
  check(`${label}: no pending DTC bits`, pend.size === 0, [...pend].join(','));
  check(`${label}: SP identical at every main-loop wait`, st.sps.size === 1, [...st.sps].map(([k, v]) => `${hx(k, 4)}x${v}`).join(' '));
  check(`${label}: deepest stack stays above 0180`, st.minSp > 0x180, `min SP ${hx(st.minSp, 4)}`);
  check(`${label}: COP serviced (max gap < 65.5 ms)`, m.cop.maxGap * 1000 / m.eClock < 65.5, `${(m.cop.maxGap * 1000 / m.eClock).toFixed(1)} ms`);
  check(`${label}: rpm16 tracks the stimulus within 1%`, maxDev < 0.01, `max dev ${(maxDev * 100).toFixed(2)}%`);
  check(`${label}: PW stable and non-zero`, minPw > 0, `PW even ${minPw}..${maxPw} ticks`);
  // at 3000 rpm the firmware's own work exceeds the 11 ms floor (~16 ms average at E = 2 MHz ASSUMED)
  check(`${label}: longest main-loop pass < ${passMs} ms`, st.maxPassMs < passMs, `${st.maxPassMs.toFixed(2)} ms; host ${hostS.toFixed(1)} s`);
  check(`${label}: still synced`, !!(m.mem[0x4F] & 0x80) && !!(m.mem[0x44] & 0x40));
}
done();
