// Smoke tests of the DOM-free GUI modules (formatters, SCI decoder, map live-cell math, scenarios, probe).
// Run from ecu/sbec2/viper:  node emulator/tests/gui_smoke.test.mjs        (prints "N passed, M failed")
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HC11 } from '../hc11/cpu.js';
import { ViperMachine } from '../machine/viper_machine.js';
import { evalCurveEE4B } from '../machine/inputs.js';
import { CAM_PATTERNS, evenEdgeAngles } from '../machine/stimulus.js';
import { keyOff, startEngine } from '../machine/scenarios.js';
import { loadImage, DATA } from '../rom/viper_rom.js';
import { hex2, hex4, parseHexBytes, parseHexAddr, scaleWatch, ccrStr, eventText, confClass, signed8 } from '../gui/format.js';
import { buildSciIndex, decodeReply, CAR_VECTORS, addressClass, faultName } from '../gui/sci_decode.js';
import { tableByAddr, evalCurve, evalMap, mapCell, liveMapInputs, liveCurveInput, rpmRounded, FEATURED_MAPS, FEATURED_CURVES } from '../gui/maps.js';
import { camCountsToPattern, patternToCounts, edgeAnglesFromSpacing, GUI_SCENARIOS, Sequencer } from '../gui/gui_scenarios.js';
import { Probe } from '../gui/probe.js';
import { Calibration, tuningValue } from '../gui/calibration.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -- ' + detail : ''}`); }
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const img = loadImage();
const rd = (a) => img[a - 0x8000];
const t0 = Date.now();

// ---------------------------------------------------------------------------------------------------------
console.log('format');
check('parseHexBytes "16 80"', eq(parseHexBytes('16 80'), [0x16, 0x80]));
check('parseHexBytes "1680" / "0x15,$20,02"', eq(parseHexBytes('1680'), [0x16, 0x80]) && eq(parseHexBytes('0x15,$20,02'), [0x15, 0x20, 0x02]));
let threw = false; try { parseHexBytes('16 8G'); } catch { threw = true; }
check('parseHexBytes rejects bad hex', threw);
check('parseHexAddr $006E', parseHexAddr('$006E') === 0x6E && parseHexAddr('0x1c') === 0x1C);
check('hex2/hex4', hex2(0x9A) === '9A' && hex4(0x944E) === '944E' && hex2(null) === '--');
check('scaleWatch rpm16 6400 -> 800 rpm', scaleWatch({ addr: '006E', size: 2 }, 6400).scaled === '800');
check('scaleWatch coolant $D2 -> 82 degC', scaleWatch({ addr: '007B', size: 1 }, 0xD2).scaled === '82');
check('scaleWatch battery $E0 -> 14.00 V', scaleWatch({ addr: '0080', size: 1 }, 0xE0).scaled === '14.00');
check('scaleWatch stored codes newest first', scaleWatch({ addr: '0039', size: 8 }, [0, 0, 0, 0, 0, 0, 0x24, 0x01], (c) => 'n' + hex2(c)).scaled === '01 n01, 24 n24');
check('ccrStr', ccrStr(0xD0) === 'SX-I----');
check('eventText', eventText({ seq: 1, type: 'diagTx', cycle: 5, ms: 1, byte: 0x9A, pc: 0xD878 }) === 'byte=$9A pc=$D878');
check('confClass', confClass('high') === 'c-hi' && confClass('medium-low') === 'c-mlo' && confClass('low') === 'c-lo');

// ---------------------------------------------------------------------------------------------------------
console.log('maps: recipe vs firmware port / image / cpu.js EEB9');
const T = DATA.tables.tables;
{
  let n = 0, bad = 0;
  for (const t of T.filter((x) => x.kind === 'curve')) {
    const addr = parseInt(t.addr, 16);
    for (let a = 0; a < 256; a++) { n++; if (evalCurve(t, a) !== evalCurveEE4B(rd, addr, a)) bad++; }
  }
  check('evalCurve(tables.json) == EE4B port on image bytes for every curve and input', bad === 0, `${n} evaluations, ${bad} mismatches`);
}
{
  // cells of every map in tables.json equal the image bytes after the 3-byte header
  let bad = 0;
  for (const t of T.filter((x) => x.kind === 'map')) {
    const a = parseInt(t.addr, 16);
    if (rd(a) !== t.rows || rd(a + 1) !== t.cols) bad++;
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) if ((t.values[r][c] & 255) !== rd(a + 3 + r * t.cols + c)) bad++;
  }
  check('map cells in tables.json == image bytes', bad === 0, `${bad} mismatches`);
}
{
  // run the real EEB9 on cpu.js for a grid of inputs
  const mem = new Uint8Array(65536); mem.set(img, 0x8000);
  const cpu = new HC11({ read8: (a) => mem[a], write8: (a, v) => { if (a < 0x8000) mem[a] = v; } });
  const call = (addr, regs) => {
    cpu.setState({ SP: 0x01F0, PC: addr, ...regs, CCR: 0xD0 });
    mem[0x01F1] = 0x03; mem[0x01F2] = 0x00; cpu.SP = 0x01F0;
    for (let i = 0; i < 5000; i++) { if (cpu.PC === 0x0300) return cpu.getState(); cpu.step(); }
    throw new Error('no return');
  };
  let n = 0, bad = 0;
  for (const t of T.filter((x) => x.kind === 'map')) {
    const addr = parseInt(t.addr, 16);
    for (let A = 0; A < 256; A += 17) for (let B = 0; B < 256; B += 15) { n++; if (call(0xEEB9, { X: addr, A, B }).A !== evalMap(t, A, B)) bad++; }
    for (const [A, B] of [[255, 255], [0, 255], [255, 0]]) { n++; if (call(0xEEB9, { X: addr, A, B }).A !== evalMap(t, A, B)) bad++; }
  }
  check('evalMap == firmware EEB9 run on cpu.js (grid incl. 255 edges)', bad === 0, `${n} evaluations, ${bad} mismatches`);
}
{
  const t = tableByAddr(DATA, '80B1');
  const c = mapCell(t, 255, 255);
  check('input 255 never reaches the last row/col (80B1: 15+240/256, 7+248/256)', c.ri === 15 && c.rf === 240 && c.ci === 7 && c.cf === 248);
  const c2 = mapCell(t, 128, 64);
  check('mapCell 80B1 A=128 B=64 -> row 8+0, col 2+0', c2.ri === 8 && c2.rf === 0 && c2.ci === 2 && c2.cf === 0);
  check('evalMap at a node equals the cell (80B1 row 8 col 2)', evalMap(t, 128, 64) === t.values[8][2]);
  check('featured tables exist', [...FEATURED_MAPS, ...FEATURED_CURVES].every((a) => tableByAddr(DATA, a)));
}

// ---------------------------------------------------------------------------------------------------------
console.log('SCI decode against the car vectors (machine run)');
const idx = buildSciIndex(DATA);
check('command index has 10..23 + 00/0A', idx.byCmd.has(0x10) && idx.byCmd.has(0x23) && idx.byCmd.has(0x00) && idx.byCmd.has(0x0A));
check('unsafe set: 13 18 19 1B-1F 20 21 23 flagged, 10/14/16 safe',
  [0x13, 0x18, 0x19, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x21, 0x23].every((c) => idx.byCmd.get(c).unsafe) && ![0x10, 0x14, 0x16, 0x22].some((c) => idx.byCmd.get(c).unsafe));
check('fault name lookup (01)', /CAM/i.test(faultName(idx, 0x01)));
const m = new ViperMachine();
m.run(3000);
{
  const got = CAR_VECTORS.map((v) => m.sciRequest(v.req));
  CAR_VECTORS.forEach((v, i) => check(`car vector ${hexs(v.req)} -> ${hexs(v.expect)}`, eq(got[i], v.expect), hexs(got[i])));
  const d16 = decodeReply(idx, [0x16, 0x80], got[0]);
  check('decode 16 80: part number 04763555, checksum OK', d16.echoOk && d16.value.partNumber === '04763555' && d16.value.checksumOk && d16.complete);
  const d10 = decodeReply(idx, [0x10], got[1]);
  check('decode 10: no codes, checksum 0E OK', d10.value.codes.length === 0 && d10.value.checksumOk);
  const d11 = decodeReply(idx, [0x11], got[2]);
  check('decode 11: status word 0000', d11.value.word === 0);
  const d15 = decodeReply(idx, [0x15, 0x20, 0x02], got[3]);
  check('decode 15 20 02: unmapped, byte 02 = low address byte', d15.value.byte === 0x02 && d15.value.cls.startsWith('unmapped') && /as on the car/.test(d15.lines.join()));
  const r = m.sciRequest([0x15, 0x80, 0x02]);
  const d = decodeReply(idx, [0x15, 0x80, 0x02], r, { romByte: (a) => m.romByte(a) });
  check('15 80 02 returns the image byte 04 and decodes as "= image byte"', r[3] === img[2] && r[3] === 0x04 && /image byte/.test(d.lines.join()));
  const rr = m.sciRequest([0x15, 0x94, 0x4E]);
  check('15 94 4E returns the image byte', rr[3] === img[0x144E], hexs(rr));
  const s14 = m.sciRequest([0x14, 0x05], { count: 6 });
  const d14 = decodeReply(idx, [0x14, 0x05], s14);
  check('14 05 stream decodes RAM $007B CoolantTemp', d14.value.source === '007B' && d14.value.symbol === 'CoolantTemp' && d14.value.samples.length === 4, hexs(s14) + ' ' + d14.lines.join(' | '));
  check('14 05 sample equals RAM $7B', d14.value.latest === m.peek(0x7B));
  const s22 = m.sciRequest([0x22, 0x01], { count: 6 });
  const d22 = decodeReply(idx, [0x22, 0x01], s22);
  check('22 01 stream decodes words of $006E', d22.value.source === '006E' && d22.value.words.length === 2, hexs(s22));
  check('addressClass', addressClass(0x2002).startsWith('unmapped') && addressClass(0x8002) === 'flash' && addressClass(0xB600) === 'EEPROM overlay' && addressClass(0x1030) === 'HC11 register');
  const dUnk = decodeReply(idx, [0x05], [0x05, 0x00]);
  check('decode unknown command 05: echo + 00', dUnk.echoOk && dUnk.reply[0] === 0);
}
function hexs(a) { return Array.from(a, hex2).join(' '); }

// ---------------------------------------------------------------------------------------------------------
console.log('scenarios / cam helpers / probe / live map cell on a running engine');
check('cam counts <-> pattern reproduce the candidate pattern', (() => {
  const p = camCountsToPattern(patternToCounts(CAM_PATTERNS.candidate));
  const c = CAM_PATTERNS.candidate;
  return p.length === c.length && p.every((x, i) => x.slot === c[i].slot && Math.abs(x.frac - c[i].frac) < 1e-9);
})());
check('edgeAnglesFromSpacing(36) == evenEdgeAngles()', eq(edgeAnglesFromSpacing(36), evenEdgeAngles()));
check('GUI scenarios defined', ['koeo', 'crank_start', 'idle', 'cruise', 'wot', 'revlimit'].every((id) => GUI_SCENARIOS.some((s) => s.id === id)));
{
  const mm = new ViperMachine();
  const probe = new Probe(mm);
  const seq = new Sequencer();
  mm.run(1000);
  seq.start(mm, GUI_SCENARIOS.find((s) => s.id === 'crank_start'));
  let sparks = 0, inj = 0;
  mm.on('spark', () => sparks++); mm.on('inj', (e) => { if (e.pwTicks > 8) inj++; });
  for (let i = 0; i < 400; i++) { mm.run(10); seq.poll(mm); }
  const e = mm.engine();
  check('crank+start scenario: synced and running at ~800 rpm', e.synced && e.running && Math.abs(e.rpm - 800) < 40, `rpm ${e.rpm.toFixed(0)} sync ${e.synced} run ${e.running}`);
  check('crank+start scenario: injector pulses and spark frames', inj > 50 && sparks > 50, `inj ${inj} spark ${sparks}`);
  const w = probe.window(mm.cycles - mm.msToCycles(300));
  check('probe records TIC1 edges, IRQ pulses, injector pulses and spark frames', w.tic1.edges.length > 20 && w.irq.edges.length > 2 && w.inj.length > 10 && w.spark.length > 10,
    `tic1 ${w.tic1.edges.length} irq ${w.irq.edges.length} inj ${w.inj.length} spark ${w.spark.length}`);
  check('probe TIC1 rising edges match stimulus counts', probe.tic1.len / 2 === mm.stimulus.counts.crankEdges || Math.abs(probe.tic1.len / 2 - mm.stimulus.counts.crankEdges) <= 1);
  const peek = (a) => mm.peek(a);
  const L = liveMapInputs(tableByAddr(DATA, '80B1'), DATA, peek);
  check('live cell 80B1 uses $70 / $C6', L && L.A === mm.peek(0x70) && L.B === mm.peek(0xC6), L && `A ${L.A} B ${L.B} -> ${L.ri}+${L.rf}/256, ${L.ci}+${L.cf}/256 value ${L.value}`);
  const L90 = liveMapInputs(tableByAddr(DATA, '90BB'), DATA, peek);
  check('live cell 90BB: rows curve 9096(rpm rounded), cols curve 9112(baro)', L90 && L90.A === evalCurve(tableByAddr(DATA, '9096'), rpmRounded(peek)) && L90.B === evalCurve(tableByAddr(DATA, '9112'), mm.peek(0x08)));
  const L85 = liveMapInputs(tableByAddr(DATA, '85E2'), DATA, peek);
  check('live cell 85E2 row = $0105', L85 && L85.A === mm.peek(0x105));
  const dt = liveCurveInput(tableByAddr(DATA, '867C'), peek);
  check('live curve 867C input = battery $80, output = $DD', dt && dt.a === mm.peek(0x80) && evalCurve(tableByAddr(DATA, '867C'), dt.a) === mm.peek(0xDD), dt && `a ${dt.a} -> ${evalCurve(tableByAddr(DATA, '867C'), dt.a)} $DD ${mm.peek(0xDD)}`);
  check('live curve with computed input returns null (8C16)', liveCurveInput(tableByAddr(DATA, '8C16'), peek) === null);
  check('live curve 8058 -> $70', evalCurve(tableByAddr(DATA, '8058'), rpmRounded(peek)) === mm.peek(0x70));
  probe.detach();
  const before = mm.stimulus.counts.crankEdges; const len = probe.tic1.len; mm.run(100);
  check('probe detach stops recording', probe.tic1.len === len && mm.stimulus.counts.crankEdges > before);
}
{
  // 3000 rpm open throttle: firmware $71 = live 80B1 value + corrections (machine test shows the corrections are 0)
  const mm = new ViperMachine();
  mm.run(500); mm.inputs.coolantC = 90; mm.inputs.tpsCounts = 0x70;
  startEngine(mm, { rpm: 3000, map: 0x80, settleMs: 2000 });
  const L = liveMapInputs(tableByAddr(DATA, '80B1'), DATA, (a) => mm.peek(a));
  check('3000 rpm, TPS 70: live 80B1 value == firmware spark $71 (+trim $72)', L && L.value + signed8(mm.peek(0x72)) === mm.peek(0x71), L && `map ${L.value} $72 ${mm.peek(0x72)} $71 ${mm.peek(0x71)}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('tuning');
{
  const m = new ViperMachine();
  const calibration = new Calibration(DATA, img);
  m.inputs.coolantC = 90;
  m.inputs.tpsCounts = 0x70;
  m.run(500);
  startEngine(m, { rpm: 3000, map: 0x80, settleMs: 2000 });
  const before = m.engine();
  const spark = liveMapInputs(calibration.table('80B1', 'applied'), DATA, a => m.peek(a));
  const fuel = liveMapInputs(calibration.table('83B3', 'applied'), DATA, a => m.peek(a));
  for (const [id, point, increase] of [['80B1', spark, 8], ['83B3', fuel, 24]]) {
    const table = calibration.tables.get(id);
    for (const row of [point.ri, point.ri + 1]) {
      for (const col of [point.ci, point.ci + 1]) {
        calibration.setDraft(id, row, col, Math.min(255, table.values[row][col] + increase));
      }
    }
  }
  check('tuning displays degrees BTDC and VE multiplier', tuningValue('80B1', 28, { fullUnit: true }) === '14.0° BTDC' &&
    tuningValue('83B3', 33) === '1.129×' && tuningValue('83B3', 2, { delta: true }) === '+0.008×');
  check('staged edits leave the running image unchanged', calibration.pending() && eq(m.rom, img));
  calibration.apply(m);
  const fuelOffset = 3 + fuel.ri * 9 + fuel.ci;
  check('apply updates both VE copies and preserves the identification bytes', !calibration.pending() &&
    m.peek(0x83B3 + fuelOffset) === m.peek(0x844F + fuelOffset) &&
    m.peek(0x83B3 + fuelOffset) !== rd(0x83B3 + fuelOffset) &&
    eq(m.rom.slice(0, 12), img.slice(0, 12)) && eq(m.rom.slice(13, 17), img.slice(13, 17)));
  m.run(300);
  const after = m.engine();
  check('firmware consumes the applied spark and fuel changes', after.spark71 === before.spark71 + 8 && after.pwEven > before.pwEven);
}
{
  const m = new ViperMachine();
  const calibration = new Calibration(DATA, img);
  const stock = calibration.tables.get('80B1').values[3][2];
  calibration.setDraft('80B1', 3, 2, stock + 0x28);
  calibration.apply(m);
  const { sum, expected } = calibration.checksum();
  check('a $28 calibration increase is offset at $800C', sum === 0x55 && expected === 0x55 &&
    m.peek(0x800C) === 0xC0 && m.romByte(0x800C) === 0xC0);
  const compare = [];
  m.addBreakpoint(0xDE32, () => { compare.push(m.cpu.a); });
  m.run(3500);
  keyOff(m, { ms: 8000 });
  check('the emulated key-off checksum accepts the adjusted image', compare.includes(0x55) &&
    compare.every(value => value === 0x55) && !m.storedCodes().includes(0x02));
  calibration.setDraft('80B1', 3, 2, stock);
  calibration.apply(m);
  check('reverting the last edit restores the stock image including $800C', eq(m.rom, img));
}

console.log('static checks of gui sources');
{
  const dir = fileURLToPath(new URL('../gui/', import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  let pins = [], nodeApi = [], crlf = [];
  for (const f of files) {
    const s = readFileSync(dir + f, 'utf8');
    if (/\bpin\s*#?\s*\d+/i.test(s)) pins.push(f);
    if (/from\s+['"]node:|require\(/.test(s)) nodeApi.push(f);
    if (s.includes('\r\n')) crlf.push(f);
  }
  check('no "pin N" connector numbers in gui sources / index.html', !pins.length && !/\bpin\s*#?\s*\d+/i.test(html), pins.join(','));
  check('no Node APIs in gui modules', !nodeApi.length, nodeApi.join(','));
  check('LF line endings', !crlf.length && !html.includes('\r\n'), crlf.join(','));
  check('index.html loads gui/app.js as a module and the stylesheet', /<script type="module" src="gui\/app.js">/.test(html) && /href="gui\/style.css"/.test(html));
}

console.log(`total host time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
