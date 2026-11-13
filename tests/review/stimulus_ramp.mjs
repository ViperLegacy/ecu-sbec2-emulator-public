// Crank generator during rpm ramps: the number of TIC1 edges must equal the integral of the ramp (20 edges per
// 720 deg), including ramps out of and into standstill. (Regression: the generator used to freeze the rate at each
// event, so a ramp from 0 rpm produced its first few edges seconds late: 0->250 rpm in 500 ms gave 15 edges in 2 s
// instead of 73.)
import { ViperMachine } from '../../machine/viper_machine.js';
import { makeChecker } from './util.mjs';
const { check, done } = makeChecker('crank generator ramps');
for (const [from, to, ramp] of [[0, 800, 1000], [0, 250, 500], [0, 250, 0.001], [250, 3000, 300], [3000, 250, 300], [800, 0, 1000], [6000, 300, 2000]]) {
  const m = new ViperMachine();
  m.run(1000);
  if (from) { m.stimulus.setRpm(from); m.run(500); }
  const edges = [];
  const orig = m.timer.inputEdge.bind(m.timer);
  m.timer.inputEdge = (p, l, c) => { if (p === 2 && l) edges.push(c); return orig(p, l, c); };
  const a0 = m.stimulus.crankAngle, c0 = m.cpu.cycles;
  m.stimulus.setRpm(to, { rampMs: ramp });
  const runMs = ramp + 1500;
  m.run(runMs);
  const T = ramp / 1000, tt = runMs / 1000;
  const deg = 6 * (Math.min(tt, T) * (from + to) / 2 + Math.max(0, tt - T) * to);
  // edges at 0,36,72..: count the multiples of 36 in (a0, a0+deg]
  const ideal = Math.floor((a0 + deg) / 36 + 1e-9) - Math.floor(a0 / 36 + 1e-9);
  const angleNow = m.stimulus.crankAngle;
  const wantAngle = (a0 + deg) % 720;
  const angErr = Math.min(Math.abs(angleNow - wantAngle), 720 - Math.abs(angleNow - wantAngle));
  check(`${from} -> ${to} rpm in ${ramp} ms: TIC1 edges follow the ramp integral`, Math.abs(edges.length - ideal) <= 1 && angErr < 0.5,
    `${edges.length} edges, ideal ${ideal}; angle ${angleNow.toFixed(2)} vs ${wantAngle.toFixed(2)}; first edge +${edges.length ? ((edges[0] - c0) / 2000).toFixed(2) : '-'} ms`);
}
{
  const m = new ViperMachine(); m.inputs.coolantC = 85; m.run(1000);
  m.stimulus.setRpm(250, { rampMs: 300 });
  const synced = m.runUntil((mm) => !!(mm.mem[0x4F] & 0x80), { timeoutMs: 1500 });
  check('a 300 ms ramp from standstill to 250 rpm syncs within 1.5 s', synced, `${(m.ms - 1000).toFixed(0)} ms`);
}
{
  // custom wheel with edges 6 deg apart (closer than the 10 deg high time): every rising edge must still reach TIC1
  const m = new ViperMachine(); m.run(500);
  const ang = []; for (let i = 0; i < 10; i++) { ang.push(i * 72, i * 72 + 6); }
  m.stimulus.setEdgeAngles(ang);
  let rises = 0; const orig = m.timer.inputEdge.bind(m.timer);
  m.timer.inputEdge = (p, l, c) => { if (p === 2 && l && !(m.timer.paIn & 4)) rises++; return orig(p, l, c); };
  m.stimulus.setRpm(600); m.run(1000);              // 600 rpm = 5 x 720 deg/s
  check('edges 6 deg apart: 20 real rising edges per 720 deg', Math.abs(rises - 100) <= 2, `${rises} rising edges in 1 s (expected 100)`);
}
done();
