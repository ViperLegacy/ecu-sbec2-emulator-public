// GUI scenarios (input presets + timed steps), cam-pattern / crank-edge helpers. DOM-free.
// All values are GUESS operating points chosen so the firmware shows the behaviour; none is measured on a car.

/** Cam pattern as IRQ pulses per slot ("second half of slot s"); n pulses are spread at k/(n+1). */
export function camCountsToPattern(counts) {
  const p = [];
  counts.forEach((n, slot) => { for (let k = 1; k <= n; k++) p.push({ slot, frac: k / (n + 1) }); });
  return p;
}
export function patternToCounts(pattern) {
  const c = new Array(10).fill(0);
  for (const x of pattern) if (x.slot >= 0 && x.slot < 10) c[x.slot]++;
  return c;
}

/**
 * 20 TIC1 rising-edge angles: cylinder edge of slot s at 72*s (+ offset0), intermediate edge `interDeg` later.
 * interDeg = 36 gives the default even spacing (evenEdgeAngles()).
 */
export function edgeAnglesFromSpacing(interDeg = 36, offset0 = 0) {
  const d = Math.max(1, Math.min(71, interDeg));
  const a = [];
  for (let s = 0; s < 10; s++) { a.push((offset0 + 72 * s) % 720); a.push((offset0 + 72 * s + d) % 720); }
  return a;
}

const warm = { coolantC: 90, airC: 30 };
const crankIfStopped = (m) => (m.stimulus.rpm < 400 || !(m.mem[0x44] & 0x40));

/**
 * Scenario: inputs = properties assigned to m.inputs; steps = [{at: ms after start, label, run(m)}].
 * `needsStart` scenarios crank first (250 rpm for 1.5 s) when the engine is not already running.
 */
export const GUI_SCENARIOS = [
  { id: 'koeo', label: 'Key on, engine off', note: 'MIL bulb check ~2.8 s, AIS homing (cold init)',
    inputs: { key: true, mapCounts: 0xE8, tpsCounts: 0x30 }, rpm: 0, mph: 0 },
  { id: 'crank_start', label: 'Crank + start (cold, 20 C)', note: 'crank 250 rpm 1.5 s, then ramp to 800 rpm',
    inputs: { key: true, coolantC: 20, airC: 20, mapCounts: 0xC8, tpsCounts: 0x30 }, mph: 0,
    steps: [
      { at: 0, label: 'crank 250 rpm', run: (m) => m.stimulus.setRpm(250) },
      { at: 1500, label: 'MAP 50, ramp to 800 rpm', run: (m) => { m.inputs.mapCounts = 0x50; m.stimulus.setRpm(800, { rampMs: 1000 }); } },
    ] },
  { id: 'idle', label: 'Warm idle 800 rpm', note: 'coolant 90 C, MAP 50, closed throttle',
    inputs: { key: true, ...warm, mapCounts: 0x50, tpsCounts: 0x30 }, mph: 0, rpm: 800, rampMs: 1000, needsStart: true },
  { id: 'cruise', label: 'Cruise 2500 rpm / 60 mph', note: 'part throttle, MAP 90',
    inputs: { key: true, ...warm, mapCounts: 0x90, tpsCounts: 0x60 }, mph: 60, rpm: 2500, rampMs: 2000, needsStart: true },
  { id: 'wot', label: 'WOT 5500 rpm', note: 'TPS E0, MAP E4 (near baro)',
    inputs: { key: true, ...warm, mapCounts: 0xE4, tpsCounts: 0xE0 }, mph: 100, rpm: 5500, rampMs: 3000, needsStart: true },
  { id: 'revlimit', label: 'Rev limit (6600 rpm)', note: 'fuel cut $50.0 above rpm16 $C1C0 (~6200 rpm INFERRED)',
    inputs: { key: true, ...warm, mapCounts: 0xE4, tpsCounts: 0xE0 }, mph: 0, rpm: 6600, rampMs: 3000, needsStart: true },
];

/** Runs scenario steps against emulated time (poll it every frame). */
export class Sequencer {
  constructor() { this.active = null; }
  start(m, sc) {
    Object.assign(m.inputs, sc.inputs || {});
    if (sc.mph !== undefined) m.stimulus.setSpeedMph(sc.mph);
    let steps = (sc.steps || []).slice();
    if (sc.rpm !== undefined && !sc.steps) {
      if (sc.needsStart && crankIfStopped(m)) {
        const target = sc.inputs.mapCounts;
        steps = [
          { at: 0, label: 'crank 250 rpm (MAP C8)', run: (mm) => { mm.inputs.mapCounts = 0xC8; mm.stimulus.setRpm(250); } },
          { at: 1500, label: `ramp to ${sc.rpm} rpm`, run: (mm) => { mm.inputs.mapCounts = target; mm.stimulus.setRpm(sc.rpm, { rampMs: sc.rampMs || 1000 }); } },
        ];
      } else steps = [{ at: 0, label: `ramp to ${sc.rpm} rpm`, run: (mm) => mm.stimulus.setRpm(sc.rpm, { rampMs: sc.rpm ? (sc.rampMs || 0) : 0 }) }];
    }
    this.active = { sc, t0: m.ms, steps, i: 0 };
    this.poll(m);
  }
  poll(m) {
    const a = this.active;
    if (!a) return;
    while (a.i < a.steps.length && m.ms - a.t0 >= a.steps[a.i].at) { a.steps[a.i].run(m); a.i++; }
    if (a.i >= a.steps.length) this.active = null;
  }
  status() {
    const a = this.active;
    return a ? `${a.sc.label}: step ${a.i + 1}/${a.steps.length} ${a.steps[a.i]?.label || ''}` : '';
  }
  cancel() { this.active = null; }
}
