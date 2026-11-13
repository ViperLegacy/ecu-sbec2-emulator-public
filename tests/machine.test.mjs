// Headless tests of the Viper PCM machine model (no framework).
// Run from ecu/sbec2/viper:  node emulator/tests/machine.test.mjs        (prints "N passed, M failed")
import { ViperMachine } from '../machine/viper_machine.js';
import { startEngine, keyOff, hex } from '../machine/scenarios.js';
import { evalCurveEE4B } from '../machine/inputs.js';
import { loadImage, DATA } from '../rom/viper_rom.js';

let passed = 0, failed = 0;
const notes = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -- ' + detail : ''}`); }
}
function note(s) { notes.push(s); console.log(`  note ${s}`); }
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const img = loadImage();
const t0 = Date.now();

// ---------------------------------------------------------------------------------------------------------
console.log('boot / main loop');
{
  const m = new ViperMachine();
  let cliAt = null;
  m.runUntil((mm) => { if (!(mm.cpu.ccr & 0x10) && cliAt === null) cliAt = mm.ms; return cliAt !== null; }, { timeoutMs: 500, stepMs: 0.1 });
  check('reset vector 944E reaches cli (main loop)', cliAt !== null, `I cleared at ${cliAt?.toFixed(1)} ms`);
  const p0 = m.passes, ms0 = m.ms;
  m.run(1100);
  const per = (m.ms - ms0) / (m.passes - p0);
  check('$6D pass counter increments every ~11 ms', per > 10.9 && per < 11.3, `${(m.passes - p0)} passes in 1100 ms = ${per.toFixed(2)} ms/pass`);
  check('no machine fault after boot', m.faults.length === 0, JSON.stringify(m.faults));
  check('cold start: keep-alive marker repaired (word 0000 valid)', (m.peek(0) ^ 0xFF) === m.peek(1), `0000 = ${hex([m.peek(0), m.peek(1)])}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('MIL bulb check, AIS homing, SCI vectors (key on, engine off)');
const koeo = new ViperMachine();
{
  const m = koeo;
  let aisMin = 255, aisMax = 0;
  for (let i = 0; i < 400; i++) { m.run(10); aisMin = Math.min(aisMin, m.mem[0x05]); aisMax = Math.max(aisMax, m.mem[0x05]); }
  const mil = m.events(0, 'mil');
  const on = mil.find((e) => e.on), off = mil.find((e) => !e.on);
  check('MIL ON at key-on ($FC.6 = 0 in the 61/62 SPI frame)', on && on.ms < 100, on ? `on at ${on.ms} ms` : 'never on');
  check('MIL OFF after ~256 passes (bulb check)', off && off.ms > 2500 && off.ms < 3300, off ? `off at ${off.ms} ms` : 'never off');
  check('AIS homes from $DF to 0 on a cold init, then drives to target', aisMin === 0 && aisMax >= 0xD0, `$05 min ${aisMin} max ${aisMax}, now ${m.mem[0x05]} target ${m.mem[0x10A]}`);
  const r1 = m.sciRequest([0x16, 0x80]);
  check('SCI 16 80 -> 16 80 04 76 35 55 9A', eq(r1, [0x16, 0x80, 0x04, 0x76, 0x35, 0x55, 0x9A]), hex(r1));
  const r2 = m.sciRequest([0x10]);
  check('SCI 10 -> 10 FE 0E', eq(r2, [0x10, 0xFE, 0x0E]), hex(r2));
  const r3 = m.sciRequest([0x11]);
  check('SCI 11 -> 11 00 00', eq(r3, [0x11, 0x00, 0x00]), hex(r3));
  const r4 = m.sciRequest([0x15, 0x20, 0x02]);
  check('SCI 15 20 02 -> 15 20 02 02 (unmapped bus = low address byte)', eq(r4, [0x15, 0x20, 0x02, 0x02]), hex(r4));
  for (const a of [0x8002, 0x8005, 0x944E, 0xB800, 0xFFFE, 0xD917, 0xB612]) {
    const r = m.sciRequest([0x15, a >> 8, a & 0xFF]);
    const want = img[a - 0x8000];
    check(`SCI 15 ${hex([a >> 8, a & 0xFF])} = image byte ${hex([want])}`, eq(r, [0x15, a >> 8, a & 0xFF, want]), hex(r));
  }
  // 14 nn: RAM table D9D6 (entry FF = no reply)
  for (const [nn, addr] of [[0x02, 0x79], [0x05, 0x7B], [0x0A, 0x80], [0x0B, 0x76], [0x0C, 0x05]]) {
    const before = m.mem[addr];
    const r = m.sciRequest([0x14, nn], { count: 4, timeoutMs: 1000 });
    const after = m.mem[addr];
    check(`SCI 14 ${hex([nn])} streams RAM $${hex([addr])}`, r.length === 4 && r[0] === 0x14 && r[1] === nn && (r[2] === before || r[2] === after),
      `${hex(r)} RAM=${hex([after])}`);
  }
  const r5 = m.sciRequest([0x14, 0x01], { timeoutMs: 400 });
  check('SCI 14 01 (table entry FF) gives only the echo', eq(r5, [0x14, 0x01]), hex(r5));
  m.sciRequest([0x00]);   // stop the stream
  m.run(7000);
  const codes = m.storedCodes();
  check('key-on engine-off 10 s: no stored DTC', codes.length === 0, codes.length ? m.dtcs().stored.map((d) => d.code + ' ' + d.name).join('; ') : 'none');
  const pend = [m.mem[0xF8], m.mem[0xF9]];
  check('key-on engine-off: no pending code ($F8/$F9)', pend[0] === 0 && pend[1] === 0, hex(pend));
  check('$5D climbs above $50 with the engine stopped', m.mem[0x5D] > 0x50, `$5D = ${hex([m.mem[0x5D]])}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('crank 250 rpm -> sync -> 800 rpm');
const run = new ViperMachine();
{
  const m = run;
  m.inputs.coolantC = 85; m.inputs.airC = 30;
  m.run(3000);
  let seq = m.eventSeq;
  m.stimulus.setRpm(250);
  const synced = m.runUntil((mm) => !!(mm.mem[0x4F] & 0x80), { timeoutMs: 3000 });
  check('cranking at 250 rpm syncs ($4F.7)', synced, `sync after ${(m.ms - 3000).toFixed(0)} ms, slot ${m.mem[0x63]}`);
  m.run(1500);
  const crankInj = m.events(seq, 'inj').filter((e) => e.pwTicks > 8);
  const slots = new Set(crankInj.map((e) => e.slot));
  check('cranking: injectors fire on all 10 slots (all four paths)', slots.size === 10, `slots ${[...slots].sort().join(',')}`);
  const crankPw = (m.mem[0x8D] << 8) | m.mem[0x8E];
  check('cranking PW $8D used for both groups', crankPw > 0 && crankInj.every((e) => Math.abs(e.pwTicks - crankPw) <= 4 || e.cycle < m.cycles - 2e6),
    `$8D = ${crankPw} ticks (${(crankPw * 0.004).toFixed(2)} ms)`);
  check('cranking: $44.6 (running) clear', !(m.mem[0x44] & 0x40));
  const crankSpark = m.events(seq, 'spark');
  check('cranking spark frames carry $7F until $44.0', crankSpark.length > 0 && crankSpark.filter((e) => !e.fromMap).every((e) => e.raw === 0x7F),
    `${crankSpark.length} frames`);
  const phase = crankSpark.filter((e) => e.genSlot !== null && e.cycle > crankSpark[0].cycle + 2e5);
  const phaseOk = phase.every((e) => e.genSlot === e.slot);
  check('firmware slot $63 equals the generator slot (candidate cam phase)', phaseOk && phase.length > 5,
    phaseOk ? `${phase.length} frames agree` : `mismatch e.g. gen ${phase.find((e) => e.genSlot !== e.slot)?.genSlot} fw ${phase.find((e) => e.genSlot !== e.slot)?.slot}`);
  seq = m.eventSeq;
  m.inputs.mapCounts = 0x50;
  m.stimulus.setRpm(800, { rampMs: 1000 });
  m.run(3000);
  check('ramp to 800 rpm sets $44.6 (running)', !!(m.mem[0x44] & 0x40), `rpm16 ${m.engine().rpm16} = ${m.engine().rpm.toFixed(0)} rpm`);
  const sp = m.events(m.eventSeq - 400, 'spark').filter((e) => e.fromMap);
  check('running spark frames carry the map value ($71 & $7F, not $7F)', sp.length > 10 && sp.every((e) => e.raw !== 0x7F),
    `last ${sp.slice(-3).map((e) => e.raw).join(',')} = $71 ${m.mem[0x71]}`);
  const runInj = m.events(m.eventSeq - 3000, 'inj').filter((e) => e.pwTicks > 0 && e.cycle > m.cycles - 1e6);
  const rs = new Set(runInj.map((e) => e.slot));
  const pwE = (m.mem[0x89] << 8) | m.mem[0x8A];
  check('running: all 10 slots inject with $89/$8B', rs.size === 10, `slots ${rs.size}, PW even ${pwE} ticks = ${(pwE * 0.004).toFixed(2)} ms`);
  check('running: no stored DTC', m.storedCodes().length === 0, m.dtcs().stored.map((d) => d.code + ' ' + d.name).join('; ') || 'none');
  check('tach output $0440.1 toggles per cylinder edge', m.outputs.tach.toggles > 100,
    `${m.outputs.tach.toggles} toggles, ${m.outputs.snapshot().tach.hz.toFixed(1)} Hz`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('3000 rpm, MAP mid: spark vs map prediction');
{
  const m = run;
  m.inputs.mapCounts = 0x80; m.inputs.tpsCounts = 0x30;
  m.stimulus.setRpm(3000, { rampMs: 1000 });
  m.run(3000);
  note(`3000 rpm closed throttle: $71 = ${m.mem[0x71]} with idle-spark term $0151 = ${(m.mem[0x151] << 24) >> 24} (8C16/8C21, rpm far above target idle)`);
  m.inputs.tpsCounts = 0x70;             // part throttle: leaves the idle-spark branch (AB24 $46.7)
  m.run(2000);
  const T = (a) => DATA.tables.tables.find((t) => t.addr === a);
  const rd = (a) => m.romByte(a);
  const mapEval = (t, A, B) => {
    const r = t.rows, c = t.cols, cell = (i, j) => t.values[i][j] & 255, signed = t.signed;
    const ci = ((c - 1) * B) >> 8, cf = ((c - 1) * B) & 255, ri = ((r - 1) * A) >> 8, rf = ((r - 1) * A) & 255;
    const ip = (p, q, f) => {
      const d = (p - q) & 255;
      const lt = signed ? ((p << 24 >> 24) - (q << 24 >> 24)) < 0 : p < q;
      let res;
      if (lt) { const nd = (-d) & 255; const mm = nd * f; res = (mm >> 8) + ((mm >> 7) & 1); }
      else { const mm = d * f; res = (-(((mm >> 8) + ((mm >> 7) & 1)) & 255)) & 255; }
      return (res + p) & 255;
    };
    const a0 = ip(cell(ri, ci), ci + 1 < c ? cell(ri, ci + 1) : 0, cf);
    const a1 = ri + 1 < r ? ip(cell(ri + 1, ci), ci + 1 < c ? cell(ri + 1, ci + 1) : 0, cf) : 0;
    return ip(a0, a1, rf);
  };
  const s8 = (v) => (v << 24) >> 24;
  const row = m.mem[0x70], col = m.mem[0xC6];
  const base = mapEval(T('80B1'), row, col);
  const cool = s8(mapEval(T('8294'), evalCurveEE4B(rd, 0x808D, m.mem[0x7B]), col));
  const air = s8(mapEval(T('82E8'), evalCurveEE4B(rd, 0x806B, m.mem[0x78]), col));
  const trim = s8(m.mem[0x72]);
  const idle = s8(m.mem[0x151]);
  const pred = base + cool + air + trim + idle;
  const actual = m.mem[0x71];
  note(`3000 rpm: $70=${row} $C6=${col}: 80B1 base ${base} + coolant 8294 ${cool} + air 82E8 ${air} + trim $72 ${trim} + idle $0151 ${idle} = ${pred}; firmware $71 = ${actual} (${actual * 0.5} deg INFERRED)`);
  check('spark $71 within 4 counts of the 80B1 + corrections prediction', Math.abs(actual - pred) <= 4, `pred ${pred} actual ${actual}`);
  const lastSpark = m.events(m.eventSeq - 200, 'spark').pop();
  check('side-channel spark frame = $71 & $7F', lastSpark && lastSpark.raw === (actual & 0x7F), `frame ${lastSpark?.raw}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('rev limit');
{
  const m = run;
  m.stimulus.setRpm(6500, { rampMs: 1000 });
  m.run(1500);
  const seq = m.eventSeq;
  m.run(500);
  const inj = m.events(seq, 'inj');
  check('above 6200 rpm: $50.0 (rev-limit fuel cut) set', !!(m.mem[0x50] & 1), `rpm ${m.engine().rpm.toFixed(0)} $50=${hex([m.mem[0x50]])}`);
  check('above 6200 rpm: no non-zero injector pulse', inj.filter((e) => e.pwTicks > 0).length === 0,
    `${inj.length} events, ${inj.filter((e) => e.pwTicks > 0).length} non-zero (side-channel slots send 00 00)`);
  m.stimulus.setRpm(5000, { rampMs: 300 });
  m.run(1500);
  const seq2 = m.eventSeq; m.run(300);
  check('below ~5800 rpm fuel resumes', !(m.mem[0x50] & 1) && m.events(seq2, 'inj').some((e) => e.pwTicks > 0));
  const r = m.sciRequest(new Array(1).fill(0x17));
  check('SCI 17 with the engine running -> 00 (not allowed)', eq(r, [0x17, 0x00]), hex(r));
}

// ---------------------------------------------------------------------------------------------------------
console.log('stored code, SCI 17 x25 clear');
{
  const m = koeo;
  m.inputs.raw[4] = 0x05;                 // AN4 (coolant) shorted low
  m.run(5000);
  m.inputs.raw[4] = null;
  m.run(1000);
  const codes = m.storedCodes();
  check('AN4 forced to 05 stores code 1E (coolant sensor low)', codes.includes(0x1E), m.dtcs().stored.map((d) => d.code + ' ' + d.name).join('; '));
  const r10 = m.sciRequest([0x10]);
  check('SCI 10 reports it', r10[1] === 0x1E && r10.includes(0xFE), hex(r10));
  // with the engine running nothing is cleared
  const mr = run;
  mr.poke(0x40, 0x1E); mr.run(50);
  for (let i = 0; i < 25; i++) mr.sciRequest([0x17], { quietMs: 30 });
  check('17 x25 while running leaves stored codes', mr.storedCodes().includes(0x1E));
  let last = null, ffs = 0;
  for (let i = 0; i < 25; i++) { const r = m.sciRequest([0x17], { quietMs: 30 }); last = r; if (r[1] === 0xFF) ffs++; }
  check('17 x25 engine stopped: FF x24 then E0', ffs === 24 && last[1] === 0xE0, `FF count ${ffs}, last ${hex(last)}`);
  m.run(200);
  check('codes cleared', m.storedCodes().length === 0, hex(m.storedCodes()));
  const side = m.events(0, 'sideTx').filter((e) => e.kind === 'clear');
  check('5 x FF sent on the side channel at code clear', side.length >= 5, `${side.length}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('EEPROM write through the firmware (SCI 1C -> F179 PPROG writer)');
{
  const m = koeo;
  const writes = [];
  m.onEepromWrite((ev, data) => writes.push({ ...ev, copy: data.slice() }));
  const before = m.romByte(0xB640);
  const r = m.sciRequest([0x1C, 0x40, 0x5A]);
  m.run(300);
  check('1C 40 5A accepted (E2)', r[3] === 0xE2, hex(r));
  check('EEPROM B640 programmed to 5A through PPROG', m.romByte(0xB640) === 0x5A, `before ${hex([before])} now ${hex([m.romByte(0xB640)])}, ${writes.length} PPROG ops: ${writes.map((w) => w.kind).join(',')}`);
  check('persistence hook received the new image', writes.length && writes[writes.length - 1].copy[0x40] === 0x5A);
  const r2 = m.sciRequest([0x15, 0xB6, 0x40]);
  check('SCI 15 B6 40 reads it back', r2[3] === 0x5A, hex(r2));
  const saved = m.getEeprom();
  const m2 = new ViperMachine({ eeprom: saved });
  check('a new machine loaded with getEeprom() sees it', m2.romByte(0xB640) === 0x5A);
  const prot = m.romByte(0xB6F0);
  const codes0 = m.storedCodes().length;
  m.sciRequest([0x1C, 0xF0, prot ^ 0xFF]);
  m.run(1500);
  check('BPROT: B6F0 (B6E0-B7FF protected) unchanged', m.romByte(0xB6F0) === prot, `still ${hex([m.romByte(0xB6F0)])}`);
  const c = m.storedCodes();
  check('protected write fails verify -> code 31 (EEPROM write denied)', c.includes(0x31), `codes ${hex(c)} (had ${codes0})`);
  m.sciRequest([0x1C, 0x40, before]); m.run(300);
}

// ---------------------------------------------------------------------------------------------------------
console.log('key off: checksum, keep-alive save, restart');
{
  const m = run;
  m.stimulus.setRpm(0);
  m.run(3000);
  const tpsMin = m.mem[0x03];
  keyOff(m, { ms: 8000 });
  let sum = 0; for (let a = 2; a < 0x44; a++) sum += m.mem[a];
  check('key off: keep-alive sum stored in word 0000', m.peek16(0) === (sum & 0xFFFF), `0000 = ${m.peek16(0).toString(16)} sum ${(sum & 0xFFFF).toString(16)}`);
  check('key off: outputs off, latch $0440 = 07', m.asic.latch === 0x07);
  check('key off: checksum ran without code 02', !m.storedCodes().includes(0x02), hex(m.storedCodes()));
  let jumped = false;
  const rm = m.addBreakpoint(0x944E, () => { jumped = true; });
  m.inputs.key = true; m.run(60);
  rm();
  check('key on again: firmware leaves the F123 loop and jumps to 944E', jumped);
  check('restart keeps keep-alive RAM (stored code 1E kept, no cold init: $04.6 clear)', !(m.mem[0x04] & 0x40) && m.storedCodes().includes(0x1E),
    `codes ${hex(m.storedCodes())}, $04 ${hex([m.mem[0x04]])}, $05 ${hex([m.mem[0x05]])}`);
  m.run(1000);
  // power cycle with battery connected vs disconnected
  m.inputs.key = false; m.run(8000);
  const ka = m.getKeepAlive();
  m.powerCycle({ batteryConnected: true }); m.inputs.key = true; m.run(60);
  check('power cycle, battery connected: keep-alive 0000-0043 retained', m.storedCodes().includes(0x1E) && !(m.mem[0x04] & 0x40),
    `codes ${hex(m.storedCodes())} $04=${hex([m.mem[0x04]])} (saved $05 ${hex([ka[5]])}, now ${hex([m.mem[0x05]])})`);
  m.powerCycle({ batteryConnected: false }); m.run(60);
  check('power cycle, battery disconnected: cold init ($04.6 AIS homing, $05 from DF)', (m.mem[0x04] & 0x40) && m.mem[0x05] > 0xC0, `$04=${hex([m.mem[0x04]])} $05=${hex([m.mem[0x05]])}`);
  check('battery disconnected: stored codes lost', m.storedCodes().length === 0);
}

// ---------------------------------------------------------------------------------------------------------
console.log('COP model, CCD fuel inhibit, speed');
{
  const m = new ViperMachine({ cop: true });
  m.run(1500);
  startEngine(m, { rpm: 2000, map: 0x70 });
  check('COP enabled: firmware services it, no timeout', !m.faults.some((f) => f.kind === 'cop-timeout'), `max COP gap ${(m.cop.maxGap * 1000 / m.eClock).toFixed(1)} ms`);
  const n = new ViperMachine();
  n.inputs.ccdRxMessage = null;
  n.run(500); startEngine(n, { rpm: 800 }); n.run(2000);
  const pw = (n.mem[0x89] << 8) | n.mem[0x8A];
  check('without the CCD message (ID low nibble 1) the firmware inhibits fuel ($F5.5)', !!(n.mem[0xF5] & 0x20) && pw === 0, `$F5=${hex([n.mem[0xF5]])} PW=${pw}`);
  const v = new ViperMachine();
  v.run(500); startEngine(v, { rpm: 2000, map: 0x70 });
  const c0 = (v.mem[0x09] << 8) | v.mem[0x0A];
  v.stimulus.setSpeedMph(60); v.run(3000);
  const c1 = (v.mem[0x09] << 8) | v.mem[0x0A];
  const expected = 3 * 60 * 8000 / 3600;
  check('VSS 60 mph: TIC2 pulse count $09:$0A follows (8000 pulses/mile INFERRED)', Math.abs((c1 - c0) - expected) < 5, `${c1 - c0} pulses in 3 s (expected ${expected}), $84 = ${v.mem[0x84]}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('peripheral units (registers driven directly, time advanced by hand)');
{
  const m = new ViperMachine();
  const W = (a, v) => m._write(a, v, m.cpu.cycles);
  const R = (a) => m.cpu.bus.read8(a, m.cpu.cycles);
  const adv = (n) => { m.cpu.cycles += n; if (m.cpu.cycles >= m.nextEvent) m._service(); };
  // timer: PR=/8 written inside the 64-cycle window, compare exactness, write-1-to-clear
  m.cpu.cycles = m.resetCycle; m.timer.reset(m.cpu.cycles); m.reschedule();
  W(0x1024, 0x02);
  const c0 = m.cpu.cycles, t = m.timer.tcnt(c0);
  W(0x1016, (t + 100) >> 8 & 0xFF); W(0x1017, (t + 100) & 0xFF);
  adv(799); check('timer: OC1F not set 1 cycle before TOC1 = TCNT+100 (E/8)', !(R(0x1023) & 0x80));
  adv(1); check('timer: OC1F set exactly at TCNT+100 ticks', !!(R(0x1023) & 0x80));
  W(0x1023, 0x80); check('timer: TFLG1 write-1-to-clear', !(R(0x1023) & 0x80));
  W(0x1024, 0x03); check('timer: PR is time-protected after 64 E cycles', (R(0x1024) & 3) === 2);
  // OC2 pin via TCTL1 + CFORC, then clear on compare
  W(0x1020, 0xC0); W(0x100B, 0x40); check('OC2: CFORC with OM2:OL2=11 drives PA6 high', !!(R(0x1000) & 0x40));
  W(0x1020, 0x80); const tt = m.timer.tcnt(m.cpu.cycles); W(0x1018, (tt + 50) >> 8 & 0xFF); W(0x1019, (tt + 50) & 0xFF);
  adv(50 * 8 + 8); check('OC2: compare clears PA6 (TCTL1 OM2:OL2=10)', !(R(0x1000) & 0x40));
  const ocEv = m.events(0, 'inj').filter((e) => e.path === 'oc').pop();
  check('OC2 high interval logged as slot-1 injector pulse', ocEv && ocEv.slot === 1 && Math.abs(ocEv.pwTicks - 50) <= 1, ocEv ? `${ocEv.pwTicks} ticks` : 'none');
  // input capture TIC1 on rising edge (TCTL2 = $1A)
  W(0x1021, 0x1A);
  const ce = m.cpu.cycles + 123; m.timer.inputEdge(2, 1, ce);
  check('TIC1 captures TCNT at the edge cycle', ((R(0x1010) << 8) | R(0x1011)) === m.timer.tcnt(ce) && !!(R(0x1023) & 0x04));
  m.timer.inputEdge(2, 0, ce + 10); W(0x1023, 0x04); m.timer.inputEdge(2, 0, ce + 20);
  check('TIC1 ignores falling edges (EDG1 = rising)', !(R(0x1023) & 0x04));
  // ADC: CCF 128 E cycles after the ADCTL write, MULT group select
  m.inputs.raw[5] = 0x42; W(0x1030, 0x14);
  adv(127); check('ADC: CCF clear at 127 E cycles', !(R(0x1030) & 0x80));
  adv(1); check('ADC: CCF set at 128 E cycles, ADR2 = AN5', !!(R(0x1030) & 0x80) && R(0x1032) === 0x42);
  W(0x1030, 0x05); adv(128); check('ADC: MULT=0 converts one channel into ADR1-4', [0x1031, 0x1032, 0x1033, 0x1034].every((a) => R(a) === 0x42));
  m.inputs.raw[5] = null;
  // SCI: 9-bit frame = 11 bit times at BAUD $01 = 352 E cycles; T8 routing
  W(0x102B, 0x01); W(0x102C, 0x50); W(0x102D, 0x08);
  const nd = m.diag.length, ns = m.events(0, 'sideTx').length + m.events(0, 'spark').length;
  W(0x102F, 0x33);
  check('SCI: TDRE stays 1 (byte moved to the shifter), TC 0', (R(0x102E) & 0xC0) === 0x80);
  W(0x102F, 0x34); check('SCI: second byte fills the buffer, TDRE 0', !(R(0x102E) & 0x80));
  adv(351); check('SCI: frame still in progress at 351 cycles', m.events(0, 'sideTx').length + m.events(0, 'spark').length === ns);
  adv(1); check('SCI: frame completes at 352 cycles (T8=1 -> side channel)', m.events(0, 'sideTx').length + m.events(0, 'spark').length === ns + 1 && m.diag.length === nd);
  W(0x102C, 0x10); adv(352); check('SCI: TC set after the last frame', !!(R(0x102E) & 0x40));
  W(0x102F, 0x55); adv(352); check('SCI: T8=0 byte routed to the diagnostic channel', m.diag[m.diag.length - 1] === 0x55);
  // SPI: WCOL on a write during a transfer
  W(0x1028, 0x54); W(0x102A, 0x11); W(0x102A, 0x22);
  R(0x1029); check('SPI: write during transfer sets WCOL', !!(m.spi.wcol));
  // EEPROM: BPROT blocks, PPROG reads back
  W(0x1035, 0x00); check('BPROT bits cannot be cleared after 64 cycles', m.eeprom.bprot !== 0);
  W(0x103B, 0x16); check('PPROG reads back what was written', R(0x103B) === 0x16); W(0x103B, 0);
}

console.log('machine faults are reported, the run never hangs');
{
  const m = new ViperMachine();
  m.run(200);
  m._write(0x1022, 0x86 | 0x40, m.cpu.cycles);       // enable OC2I: FD04 does not clear OC2F -> loops
  const h = Date.now(); m.run(200);
  check('OC2I enabled by force -> FD04 spurious loop detected', m.faults.some((f) => f.kind === 'fd04-spurious-loop'), `${Date.now() - h} ms host for 200 ms`);
  const n = new ViperMachine();
  n.run(100);
  n.asic.extRam[0x10] = 0x41;                         // illegal page-1 opcode at 0490
  n.cpu.pc = 0x0490; n.run(5);
  check('illegal opcode trap reported (vector FFF8 -> 9400 warm restart)', n.faults.some((f) => f.kind === 'illegal-opcode' && f.addr === 0x0490));
  const p0 = n.passes; n.run(300);
  check('after the illegal-opcode restart the firmware runs its main loop again', n.passes - p0 > 20, `${n.passes - p0} passes in 300 ms`);
  const c = new ViperMachine({ cop: true });
  c.run(200);
  c.asic.extRam[0x10] = 0x20; c.asic.extRam[0x11] = 0xFE;   // BRA * at 0490
  c._write(0x1022, 0x00, c.cpu.cycles);
  c.cpu.ccr |= 0x10; c.cpu.pc = 0x0490; c.run(100);
  check('COP enabled: stuck code -> COP timeout reset via FFFA', c.faults.some((f) => f.kind === 'cop-timeout') && c.events(0, 'reset').some((e) => e.vector === 0xFFFA));
}

console.log('side channel status input');
{
  const m = new ViperMachine();
  m.run(300);
  m.sideChannelSend([0x05]);                          // R8=1, bit2 set -> ORed into $0115 (bit0 = injector #1 status)
  m.run(50);
  check('R8=1 byte with bit2 set is ORed into $0115', !!(m.mem[0x115] & 0x04), `$0115 = ${hex([m.mem[0x115]])} (bit0 consumed by F6A0), codes ${hex(m.storedCodes())} pending ${hex([m.mem[0xF8], m.mem[0xF9]])}`);
  m.sideChannelSend([0x40]);
  m.run(50);
  check('R8=1 byte with bit2 clear lands in $0116', !!(m.mem[0x116] & 0x40), `$0116 = ${hex([m.mem[0x116]])}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('speed');
{
  const m = new ViperMachine();
  const h0 = Date.now(); m.run(10000); const koeoRatio = 10000 / (Date.now() - h0);
  startEngine(m, { rpm: 6000, map: 0xC0, settleMs: 0 });
  const h1 = Date.now(); m.run(5000); const runRatio = 5000 / (Date.now() - h1);
  check('run speed >= 20x real time (key on, engine off)', koeoRatio >= 20, `x${koeoRatio.toFixed(1)}`);
  check('run speed >= 20x real time (6000 rpm)', runRatio >= 20, `x${runRatio.toFixed(1)}`);
}

for (const n of notes) console.log('NOTE: ' + n);
console.log(`total host time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
