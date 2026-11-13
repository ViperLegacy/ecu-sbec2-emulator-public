// Reusable scenario steps for headless runs, tests and the GUI. Each returns the machine for chaining.
// Times are emulated milliseconds. Defaults follow brief sec. 11 (all GUESS values, see Inputs).

export const DEFAULT_WATCH = [
  ['6E', 2, 'EngineRPM rpm16 (rpm = x/8)'], ['70', 1, 'RpmAxisIndex'], ['5E', 2, 'CylinderEventPeriod ticks'],
  ['63', 1, 'CylinderIndex slot'], ['4F', 1, 'CrankSyncState b7 sync b6 irq'], ['44', 1, 'EngineStateFlags b6 run b0 map'],
  ['76', 1, 'MapValue'], ['C6', 1, 'MapFiltered'], ['08', 1, 'Baro'], ['7F', 1, 'TPS raw'], ['77', 1, 'TPS validated'],
  ['03', 1, 'TPS minimum'], ['7E', 1, 'Coolant raw'], ['7B', 1, 'Coolant (degC = x-128)'], ['7D', 1, 'Air raw'],
  ['78', 1, 'Air (degC = x-128)'], ['80', 1, 'Battery (V = x/16)'], ['79', 1, 'O2 1'], ['7A', 1, 'O2 2'],
  ['8D', 2, 'Cranking PW ticks'], ['89', 2, 'PW even slots ticks'], ['8B', 2, 'PW odd slots ticks'],
  ['71', 1, 'Spark (0.5 deg/count)'], ['75', 1, 'Spark applied'], ['72', 1, 'EEPROM spark trim'],
  ['E7', 2, 'Target idle rpm*8'], ['010A', 1, 'AIS target'], ['05', 1, 'AIS position'], ['50', 1, 'Fuel-cut flags'],
  ['84', 1, 'Vehicle speed (mph = x/2)'], ['FC', 1, 'Lamp/relay byte'], ['FD', 1, 'Relay/solenoid byte'], ['FE', 1, '$0440 shadow'],
  ['F5', 1, 'Theft/CCD fuel enable (b5 inhibit, b7 valid msg seen, b4 armed)'], ['0115', 1, 'Side-channel status'], ['F8', 2, 'Pending codes'],
  ['6C', 1, 'Run-time counter'], ['6D', 1, 'Pass counter'],
];

export function readWatch(m, list = DEFAULT_WATCH) {
  return list.map(([hex, size, name]) => {
    const a = parseInt(hex, 16);
    return { addr: hex.padStart(4, '0').toUpperCase(), name, value: size === 2 ? m.peek16(a) : m.peek(a), size };
  });
}

/** Key on, engine off: just let the firmware boot and run. */
export function keyOnEngineOff(m, ms = 3000) { m.inputs.key = true; m.run(ms); return m; }

/** Crank at `rpm` (default 250) for `ms`. */
export function crank(m, { rpm = 250, ms = 1500 } = {}) { m.stimulus.setRpm(rpm); m.run(ms); return m; }

/** Crank, then ramp to `rpm` (MAP set to `map` counts when given). */
export function startEngine(m, { crankRpm = 250, crankMs = 1500, rpm = 800, rampMs = 1000, map = 0x50, settleMs = 1000 } = {}) {
  crank(m, { rpm: crankRpm, ms: crankMs });
  if (map !== null && map !== undefined) m.inputs.mapCounts = map;
  m.stimulus.setRpm(rpm, { rampMs });
  m.run(rampMs + settleMs);
  return m;
}

/** Engine-off MAP (counts): the Inputs default, atmospheric at sea level (GUESS). */
export const MAP_ENGINE_OFF = 0xE8;

/** Key off and let the power-down sequence (F024: 23 passes, checksum, 2 x 2.0 s waits, save) finish.
 *  MAP returns to atmospheric with the engine stopped (left at running vacuum, the PCM logs code 24 MAP low). */
export function keyOff(m, { ms = 6000, map = MAP_ENGINE_OFF } = {}) {
  m.stimulus.setRpm(0); if (map !== null && map !== undefined) m.inputs.mapCounts = map;
  m.inputs.key = false; m.run(ms); return m;
}

export function hex(a) { return Array.from(a, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '); }
