#!/usr/bin/env node
// Execution coverage of the 04763555 firmware under the emulator: run a set of scenarios, record every executed PC
// and every access outside RAM / ROM, then list the instructions that never ran.
//   node tools/coverage.mjs [out.txt]        (about a minute; needs ../analysis/VIPER_04763555.disasm.txt)
// What the remaining gaps are, and the recipe or calibration byte behind each, is in findings/COVERAGE_DIG.txt.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ViperMachine } from '../machine/viper_machine.js';
import * as sc from '../machine/scenarios.js';
const DISASM = fileURLToPath(new URL('../../analysis/VIPER_04763555.disasm.txt', import.meta.url));

const seen = new Uint32Array(0x10000);
const regR = new Map(), regW = new Map();
function instrument(m) {
  const cpu = m.cpu, step = cpu.step.bind(cpu);
  cpu.step = () => { seen[cpu.pc]++; return step(); };   // (also counts a PC whose step only took an interrupt)
  const rs = m._readSlow.bind(m), wr = m._write.bind(m);
  m._readSlow = (a, c) => { regR.set(a, (regR.get(a) || 0) + 1); return rs(a, c); };
  m._write = (a, v, c) => { if (a >= 0x200 && a < 0x8000) regW.set(a, (regW.get(a) || 0) + 1); return wr(a, v, c); };
  m.idleSkip = false;
  return m;
}
const mk = (o = {}) => instrument(new ViperMachine({ cop: true, ...o }));
const runs = [];
const R = (name, fn) => { const t = Date.now(); let m; try { m = fn(); } catch (e) { console.log('ERR', name, e.message); return; }
  runs.push({ name, faults: m.faults.map((f) => f.kind), codes: [m.mem[0xF8], m.mem[0xF9]], ms: Date.now() - t }); };

R('koeo', () => sc.keyOnEngineOff(mk(), 4000));
R('idle warm', () => { const m = mk(); m.inputs.coolantC = 90; m.inputs.airC = 30; sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 800, map: 0x50, settleMs: 30000 }); sc.keyOff(m); return m; });
R('cold start', () => { const m = mk(); m.inputs.coolantC = -20; m.inputs.airC = -20; sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 1200, map: 0x60, settleMs: 15000 }); return m; });
R('hot fans ac', () => { const m = mk(); m.inputs.coolantC = 105; sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 900, map: 0x50, settleMs: 5000 }); m.inputs.smartReply = [0, 0, 0, 0]; m.run(8000); m.inputs.smartReply = [0, 0x80, 0, 0]; m.run(3000); return m; });
R('drive', () => { const m = mk(); m.inputs.coolantC = 90; sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 800, map: 0x50, settleMs: 3000 });
  for (const [rpm, map, tps, mph, ms] of [[1500, 0x70, 0x50, 10, 3000], [2500, 0x90, 0x70, 30, 4000], [1300, 0x70, 0x48, 25, 6000], [4000, 0xD0, 0xC0, 60, 3000], [5800, 0xE0, 0xE0, 120, 3000], [6500, 0xE0, 0xE0, 150, 2000], [3000, 0x30, 0x30, 90, 4000], [2000, 0x60, 0x50, 50, 20000], [800, 0x50, 0x30, 0, 4000]]) {
    m.inputs.mapCounts = map; m.inputs.tpsCounts = tps; m.stimulus.setRpm(rpm, { rampMs: 800 }); m.stimulus.setSpeedMph(mph); m.run(ms);
  }
  sc.keyOff(m); m.inputs.key = true; m.run(2000); return m; });
R('sensor faults', () => { const m = mk(); sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 1500, map: 0x60, settleMs: 3000 });
  for (const [ch, v] of [[0, 0], [0, 255], [1, 255], [1, 60], [3, 0], [3, 255], [4, 0], [4, 255], [5, 0], [5, 255], [2, 255], [7, 255]]) { m.inputs.setRaw(ch, v); m.run(6000); m.inputs.setRaw(ch, null); m.run(1000); }
  m.inputs.o2Mode = 'fixed'; m.run(40000);
  return m; });
R('discrete faults', () => { const m = mk(); sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 1500, map: 0x60, settleMs: 3000 });
  m.inputs.relayFeed = false; m.run(4000); m.inputs.relayFeed = true;
  m.inputs.injectorStatusOk = false; m.run(4000); m.inputs.injectorStatusOk = true;
  m.inputs.smartReply = [0, 0x80, 0, 0x94]; m.run(6000); m.inputs.smartReply = [0, 0x80, 0, 0];
  m.inputs.smartChecksumOk = false; m.run(4000); m.inputs.smartChecksumOk = true;
  m.inputs.spiBusy = true; m.run(3000); m.inputs.spiBusy = false;
  m.inputs.fdFeedbackMode = 'value'; m.inputs.fdFeedbackValue = 0xFF; m.run(5000); m.inputs.fdFeedbackValue = 0; m.run(5000); m.inputs.fdFeedbackMode = 'shift';
  for (const b of [0x80, 0x40, 0x84, 0x44]) { m.sideChannelSend([b]); m.run(300); } for (let i = 0; i < 20; i++) { m.sideChannelSend([0x7F]); m.run(11); } m.sideChannelSend([0x05, 0x05, 0x05], 'fe'); m.run(3000);
  m.inputs.spiStallAfter = 2; m.run(2000); m.inputs.spiStallAfter = null; m.inputs.fdFeedbackXor = 0x20; m.run(15000); m.inputs.fdFeedbackXor = 0;
  m.stimulus.setCamPattern('none'); m.run(5000); m.stimulus.setCamPattern('candidate');
  m.inputs.ccdRxMessage = null; m.run(4000);
  m.stimulus.setRpm(0); m.run(3000);
  return m; });
R('no ccd from key on', () => { const m = mk(); m.inputs.ccdRxMessage = null; sc.keyOnEngineOff(m, 3000); sc.startEngine(m, { rpm: 800, settleMs: 3000 }); return m; });
R('no battery', () => { const m = mk({ ramFill: 'random' }); m.inputs.batteryConnected = false; sc.keyOnEngineOff(m, 2000); m.powerCycle({ batteryConnected: false }); m.run(2000); m.powerCycle({ batteryConnected: true, fill: 'zero' }); m.run(2000); return m; });
R('sci all', () => { const m = mk(); sc.keyOnEngineOff(m, 1000);
  const tx = (b, o) => { try { m.sciRequest(b, { timeoutMs: 600, ...o }); } catch (e) { } };
  for (let c = 0; c < 0x30; c++) for (const arg of [0, 1, 2, 5, 0x10, 0x40, 0x80, 0xFF]) { if (c === 0x12) continue; tx([c, arg]); m.run(120); tx([c, arg, 0x10, 0x00]); m.run(60); }
  tx([0x10]); for (let i = 0; i < 26; i++) tx([0x17]);
  for (let t = 0; t < 0x40; t++) { tx([0x13, t]); m.run(400); } tx([0x13, 0]);
  for (let t = 0; t < 0x20; t++) { tx([0x19, t]); m.run(100); tx([0x1A, t]); tx([0x14, t], { count: 3 }); tx([0x22, t], { count: 3 }); }
  tx([0x18, 0xD2]); m.run(800); tx([0x00]);
  tx([0x1B]); m.run(50); for (const b of [0xF8, 0xF9, 0xFB]) tx([b]); tx([0xF9, 0x00, 0x95, 0xCC]); m.run(100); tx([0xFE, 0x0C]); m.run(900); tx([0x14]); m.run(200);
  tx([0x12]); m.run(200); for (let i = 0; i < 0x100; i += 7) { tx([0xF4, i, 0x80]); m.run(30); } tx([0xFE]); m.run(200);
  return m; });
R('long warm idle, lean engine', () => { const m = mk(); m.inputs.coolantC = 90; m.inputs.airC = 30; m.inputs.o2BiasCounts = 30; sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 704, map: 0x50, settleMs: 200000 });
  for (const [rpm, map] of [[900, 0x40], [1500, 0x40], [1500, 0x60]]) { m.stimulus.setRpm(rpm, { rampMs: 500 }); m.inputs.mapCounts = map; m.inputs.tpsCounts = 0x50; m.run(90000); }
  m.stimulus.setRpm(1500); m.stimulus.setSpeedMph(14); m.run(4000); m.stimulus.setRpm(1000); m.run(3000);
  sc.keyOff(m, { map: null }); m.inputs.key = true; m.run(1500); return m; });
R('o2 open circuit', () => { const m = mk(); m.inputs.coolantC = 90; sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 1500, map: 0x60, settleMs: 2000 }); m.inputs.o2Open = [true, true]; m.run(240000); return m; });
R('flash codes, clear flood, hot start', () => { const m = mk(); for (let i = 0; i < 3; i++) { m.inputs.key = true; m.run(1000); m.inputs.key = false; m.run(300); } m.inputs.key = true; m.run(20000);
  m.inputs.tpsCounts = 0xE0; sc.crank(m, { rpm: 250, ms: 1500 }); m.inputs.tpsCounts = 0x30; m.stimulus.setRpm(0); m.run(1000); m.inputs.coolantC = 125; m.inputs.airC = 125; sc.crank(m, { rpm: 250, ms: 2000 }); m.pulseXirq(); m.run(500); return m; });
R('sci running', () => { const m = mk(); sc.keyOnEngineOff(m, 500); sc.startEngine(m, { rpm: 900, settleMs: 2000 });
  const tx = (b, o) => { try { m.sciRequest(b, { timeoutMs: 600, ...o }); } catch (e) { } };
  for (let c = 0x10; c < 0x30; c++) for (const arg of [0, 1, 4, 0x41]) { if (c === 0x12) continue; tx([c, arg, 0x10, 0x00]); m.run(60); }
  for (let t = 0; t < 0x40; t++) { tx([0x13, t]); m.run(300); } tx([0x13, 0]); m.run(2000);
  return m; });

// ---- report -------------------------------------------------------------------------------------
const dis = readFileSync(DISASM, 'utf8').split(/\r?\n/);
const insns = [];
for (const l of dis) { const mm = /^([0-9A-F]{4})  ((?:[0-9A-F]{2} )+) +(\S+)(.*)$/.exec(l); if (mm && !/^(fcb|fdb|fcc)$/.test(mm[3])) insns.push({ a: parseInt(mm[1], 16), text: l }); }
const un = insns.filter((i) => !seen[i.a]);
const ranges = []; let cur = null;
for (let k = 0; k < insns.length; k++) { const i = insns[k]; if (!seen[i.a]) { if (cur && cur.lastIdx === k - 1) { cur.end = i.a; cur.n++; cur.lastIdx = k; } else { cur = { start: i.a, end: i.a, n: 1, lastIdx: k }; ranges.push(cur); } } }
const hx = (v) => v.toString(16).toUpperCase().padStart(4, '0');
console.log(`instructions ${insns.length}, executed ${insns.length - un.length} (${(100 * (insns.length - un.length) / insns.length).toFixed(1)} %), unexecuted ranges ${ranges.length}`);
// executed PCs that the disassembly does not list as instructions
const known = new Set(insns.map((i) => i.a)); const odd = [];
for (let a = 0; a < 0x10000; a++) if (seen[a] && !known.has(a)) odd.push(hx(a));
console.log('executed but not in disasm as insn:', odd.length, odd.slice(0, 60).join(' '));
console.log(runs.map((r) => `${r.name}: faults=[${[...new Set(r.faults)]}] F8=${hx(r.codes[0] << 8 | r.codes[1])} ${r.ms}ms`).join('\n'));
const fmt = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${hx(a)}:${n}`).join(' ');
console.log('slow reads:', fmt(regR)); console.log('non-RAM writes:', fmt(regW));
if (process.argv[2]) writeFileSync(process.argv[2], ranges.slice().sort((a, b) => b.n - a.n).map((r) => `${hx(r.start)}-${hx(r.end)} ${r.n}`).join('\n'));
console.log('largest unexecuted ranges: ' + ranges.slice().sort((a, b) => b.n - a.n).slice(0, 40).map((r) => `${hx(r.start)}-${hx(r.end)}(${r.n})`).join(' '));
