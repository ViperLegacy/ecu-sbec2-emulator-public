#!/usr/bin/env node
// Headless runner for the Viper PCM machine model.
//   node run_headless.mjs --scenario idle --rpm 800 --ms 5000
//   node run_headless.mjs --sci "16 80" --sci "10"
//   node run_headless.mjs --scenario run --rpm 3000 --map 80 --ms 2000 --events 20
// Options:
//   --scenario koeo|crank|idle|run|revlimit|keyoff   (default koeo)
//   --rpm N            engine speed for crank/idle/run/revlimit (defaults 250 / 800 / 3000 / 6500)
//   --ms N             emulated time of the final phase (default 3000)
//   --map HH --tps HH  raw counts (hex) for AN0 / AN3; --coolant C --air C (degC); --battery V; --mph N
//   --cam candidate|quick|none     cam (IRQ) pattern
//   --sci "HH HH .."   send an SCI request after the scenario (repeatable); --count N after it = reply bytes
//                      to collect for streams (14/22)
//   --watch "6E:2,63,..."          RAM addresses to print (hex[:size]); default = brief sec. 9 list
//   --events N         print the last N log events (--types inj,spark,... to filter)
//   --cop              enable the COP watchdog model;  --no-ccd  remove the CCD message (fuel inhibit demo)
//   --json             machine-readable output
import { ViperMachine } from './machine/viper_machine.js';
import { readWatch, DEFAULT_WATCH, keyOnEngineOff, crank, startEngine, keyOff, hex } from './machine/scenarios.js';

const argv = process.argv.slice(2);
const opt = { sci: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => argv[++i];
  switch (a) {
    case '--scenario': opt.scenario = val(); break;
    case '--rpm': opt.rpm = Number(val()); break;
    case '--ms': opt.ms = Number(val()); break;
    case '--map': opt.map = parseInt(val(), 16); break;
    case '--tps': opt.tps = parseInt(val(), 16); break;
    case '--coolant': opt.coolant = Number(val()); break;
    case '--air': opt.air = Number(val()); break;
    case '--battery': opt.battery = Number(val()); break;
    case '--mph': opt.mph = Number(val()); break;
    case '--cam': opt.cam = val(); break;
    case '--sci': opt.sci.push({ text: val(), count: null }); break;
    case '--count': if (opt.sci.length) opt.sci[opt.sci.length - 1].count = Number(val()); break;
    case '--watch': opt.watch = val(); break;
    case '--events': opt.events = Number(val()); break;
    case '--types': opt.types = val().split(','); break;
    case '--cop': opt.cop = true; break;
    case '--no-ccd': opt.noCcd = true; break;
    case '--json': opt.json = true; break;
    case '-h': case '--help':
      console.log(readHelp()); process.exit(0);
    default: console.error(`unknown option ${a}`); process.exit(2);
  }
}
function readHelp() { return 'see the header of run_headless.mjs for options'; }

const m = new ViperMachine({ cop: !!opt.cop });
if (opt.map !== undefined) m.inputs.mapCounts = opt.map;
if (opt.tps !== undefined) m.inputs.tpsCounts = opt.tps;
if (opt.coolant !== undefined) m.inputs.coolantC = opt.coolant;
if (opt.air !== undefined) m.inputs.airC = opt.air;
if (opt.battery !== undefined) m.inputs.batteryV = opt.battery;
if (opt.cam) m.stimulus.setCamPattern(opt.cam);
if (opt.noCcd) m.inputs.ccdRxMessage = null;

const sc = opt.scenario || 'koeo';
const ms = opt.ms ?? 3000;
const t0 = Date.now();
switch (sc) {
  case 'koeo': keyOnEngineOff(m, ms); break;
  case 'crank': keyOnEngineOff(m, 500); crank(m, { rpm: opt.rpm ?? 250, ms }); break;
  case 'idle': case 'run': case 'revlimit': {
    keyOnEngineOff(m, 500);
    const rpm = opt.rpm ?? (sc === 'idle' ? 800 : sc === 'run' ? 3000 : 6500);
    startEngine(m, { rpm, map: opt.map ?? (sc === 'idle' ? 0x50 : 0x80), settleMs: 0 });
    if (opt.mph) m.stimulus.setSpeedMph(opt.mph);
    m.run(ms);
    break;
  }
  case 'keyoff': keyOnEngineOff(m, 2000); keyOff(m, { ms }); m.inputs.key = true; m.run(1000); break;
  default: console.error(`unknown scenario ${sc}`); process.exit(2);
}
const sciResults = opt.sci.map((s) => {
  const req = s.text.trim().split(/[\s,]+/).map((x) => parseInt(x, 16));
  const out = m.sciRequest(req, s.count ? { count: s.count + req.length, timeoutMs: 5000 } : {});
  return { request: hex(req), reply: hex(out) };
});
const hostMs = Date.now() - t0;

const watchList = opt.watch
  ? opt.watch.split(',').map((w) => { const [h, s] = w.split(':'); return [h.trim(), Number(s || 1), '']; })
  : DEFAULT_WATCH;
const watch = readWatch(m, watchList);
const result = {
  scenario: sc, emulatedMs: +m.ms.toFixed(1), hostMs, speedRatio: +(m.ms / Math.max(1, hostMs)).toFixed(1),
  engine: m.engine(), dtcs: m.dtcs(), faults: m.faults, sci: sciResults, watch,
  outputs: (({ lamps, relays, milOn, spark, tach, ais }) => ({ lamps, relays, milOn, spark, tach, ais }))(m.outputs.snapshot()),
  injectors: m.outputs.inj.map((s) => ({ slot: s.slot, cylInferred: s.cyl, resource: s.resource, count: s.count, lastPwTicks: s.lastPwTicks, lastPwMs: +s.lastPwMs.toFixed(3) })),
};
if (opt.events) {
  let ev = m.events();
  if (opt.types) ev = ev.filter((e) => opt.types.includes(e.type));
  result.events = ev.slice(-opt.events);
}
if (opt.json) { console.log(JSON.stringify(result, null, 1)); process.exit(0); }

console.log(`scenario ${sc}: ${result.emulatedMs} ms emulated in ${hostMs} ms host (x${result.speedRatio})`);
const e = result.engine;
console.log(`rpm ${e.rpm.toFixed(0)}  synced ${e.synced}  running ${e.running}  slot ${e.slot}  spark $71=${e.spark71} (${e.sparkDeg} deg INFERRED)  PW even ${e.pwEven} odd ${e.pwOdd} crank ${e.crankPw} ticks  MIL ${e.milOn ? 'ON' : 'off'}`);
console.log(`stored codes: ${result.dtcs.stored.map((d) => `${d.code} ${d.name}`).join('; ') || 'none'}   pending: ${result.dtcs.pending.map((d) => d.code).join(' ') || 'none'}`);
if (m.faults.length) console.log('machine faults:', JSON.stringify(m.faults));
for (const s of sciResults) console.log(`SCI ${s.request} -> ${s.reply}`);
console.log('RAM watch:');
for (const w of watch) console.log(`  $${w.addr} ${w.size === 2 ? w.value.toString(16).toUpperCase().padStart(4, '0') : w.value.toString(16).toUpperCase().padStart(2, '0')}  ${w.name}`);
console.log('injectors (slot / cylinder INFERRED / resource / pulses / last PW):');
for (const s of result.injectors) console.log(`  ${s.slot}  #${s.cylInferred}  ${s.resource.padEnd(44)} ${String(s.count).padStart(5)}  ${s.lastPwTicks} ticks ${s.lastPwMs} ms`);
if (result.events) for (const ev of result.events) console.log('  ' + JSON.stringify(ev));
