// Regression checks for the third emulator review (2026-11-13). Node only, no DOM.
//   node emulator/tests/fix_review3.test.mjs
import { DATA } from '../rom/viper_rom.js';
import { ViperMachine } from '../machine/viper_machine.js';
import { HC11, VEC } from '../hc11/cpu.js';
import { startEngine, keyOnEngineOff, keyOff, hex } from '../machine/scenarios.js';
import { decodeBits, FC_BITS, FD_BITS, LATCH_BITS } from '../machine/outputs.js';
import { buildSciIndex, findUnsafe, nextParserStates, decodeReply, PARSER_IDLE } from '../gui/sci_decode.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '   ' + info : ''}`); };
const idx = buildSciIndex(DATA);

// gui-1 / gui-2: the unsafe gate follows high-speed mode and owed argument bytes across requests
check('gate: 12 15 FE 13 01 refused (13 after FE leaves high-speed)', findUnsafe(idx, [0x12, 0x15, 0xFE, 0x13, 0x01])?.code === 0x13);
check('gate: 12 13 01 refused (12 may not reach high-speed)', findUnsafe(idx, [0x12, 0x13, 0x01])?.code === 0x13);
check('gate: 92 13 01 refused', findUnsafe(idx, [0x92, 0x13, 0x01])?.code === 0x13);
let st = nextParserStates(idx, [PARSER_IDLE], [0x14]);
check('gate: "14" then "15 13 01" refused', findUnsafe(idx, [0x15, 0x13, 0x01], st)?.code === 0x13);
check('gate: "14" then "16 80" allowed', findUnsafe(idx, [0x16, 0x80], st) === null);
st = nextParserStates(idx, [PARSER_IDLE], [0x12, 0x6E]);
check('gate: "12 6E" then "FE 13 01" refused', findUnsafe(idx, [0xFE, 0x13, 0x01], st)?.code === 0x13);
check('gate: "12 6E" then "6F 7B" allowed', findUnsafe(idx, [0x6F, 0x7B], st) === null);
check('gate: plain 15 13 01 still a read', findUnsafe(idx, [0x15, 0x13, 0x01]) === null);

// gui-3: 14 10 is the $6E high byte: rpm = byte * 32
const d = decodeReply(idx, [0x14, 0x10], [0x14, 0x10, 0x19]);
check('14 10 = 0x19 decodes as 800 rpm', d.lines.some((l) => /= 800 rpm/.test(l)), d.lines[1]);

// cpu-1: CLI / TAP delay the I clear by one instruction (RM 5.5.2)
{
  const mem = new Uint8Array(0x10000);
  mem.set([0x0E, 0x01, 0x01], 0xC000); mem[0xFFFE] = 0xC0; mem[0xFFFF] = 0; mem[0xFFF2] = 0xD0; mem[0xFFF3] = 0; mem[0xD000] = 0x3B;
  const cpu = new HC11({ read8: (a) => mem[a], write8: (a, v) => { mem[a] = v; } }); cpu.sp = 0x1FF;
  cpu.requestInterrupt(VEC.IRQ); cpu.step(); cpu.step();
  check('CLI: next instruction runs before the IRQ', cpu.pc === 0xC002, cpu.pc.toString(16));
  cpu.step();
  check('CLI: IRQ taken after it', cpu.pc === 0xD000, cpu.pc.toString(16));
}

// machine-1: a PCM reset with tester bytes queued does not stall the queue
{
  const m = new ViperMachine(); m.run(1500);
  m.sciSend([0x16, 0x80]); m.runCycles(100); m.reset(); m.run(3000);
  check('reset mid-request: tester queue drains', !m.sci.testerBusy());
  check('reset mid-request: next request answers', hex(m.sciRequest([0x10], { timeoutMs: 1000 })) === '10 FE 0E');
}

// stimulus-3 / stimulus-4: high-speed reads paced by the reply; framing after a stream
{
  const m = new ViperMachine(); m.run(500); startEngine(m, { rpm: 800 });
  check('12 echoed', hex(m.sciRequest([0x12])) === '12');
  const t0 = m.ms; const r = m.sciRequest([0x0A, 0x6E, 0x6F], { count: 3 });
  check('high-speed: 3 reads in < 20 ms', m.ms - t0 < 20 && r.length === 3, `${(m.ms - t0).toFixed(1)} ms`);
  check('high-speed: 6E answers RAM $6E', r[1] === m.ram[0x6E] || Math.abs(r[1] - m.ram[0x6E]) <= 1);
  const fe = m.sciRequest([0xFE], { count: 1 }); m.run(50);
  check('FE leaves high-speed', fe.length === 1 && !m.sci.tester.hs && hex(m.sciRequest([0x16, 0x80])) === '16 80 04 76 35 55 9A');
  let bad = 0;
  for (let i = 0; i < 20; i++) { m.sciRequest([0x14, 0x05], { count: 3 + (i % 7) }); m.run((i * 1.37) % 11); if (m.sciRequest([0x10])[0] !== 0x10) bad++; }
  check('reply framing after a 14 stream', bad === 0, `${bad}/20 bad`);
}

// stimulus-1 / gui-6: active-low relay bits
check('FC.7 fan / FD.1 / FD.0 active low', decodeBits(0x7F, FC_BITS).fanRelay1 && decodeBits(0xFC, FD_BITS).fanRelay2 && decodeBits(0xFC, FD_BITS).acClutch &&
  !decodeBits(0xFF, FC_BITS).fanRelay1 && !decodeBits(0x03, FD_BITS).acClutch);
check('$0440.2 FD select active low', decodeBits(0x00, LATCH_BITS).fdSelect && !decodeBits(0x04, LATCH_BITS).fdSelect);

// stimulus-2: key-off from running does not log code 24
{
  const m = new ViperMachine(); keyOnEngineOff(m, 500); startEngine(m, { rpm: 800 });
  keyOff(m); m.inputs.key = true; m.run(1000);
  check('key-off: no false code 24', !m.dtcs().stored.some((x) => x.code === '24') && !m.dtcs().pending.some((x) => x.code === '24'),
    m.dtcs().stored.map((x) => x.code).join(','));
}

// stimulus-6: reset-time ASIC writes are not pulses
{ const m = new ViperMachine(); m.run(1500); check('no injector pulses at key-on engine off', m.outputs.inj.every((s) => s.count === 0)); }

// machine-3: idle-loop breakpoints fire as often as single-stepping
{
  const hits = [true, false].map((skip) => { const m = new ViperMachine({ idleSkip: skip }); m.run(1000); let n = 0; m.addBreakpoint(0x9E14, () => { n++; }); m.run(50); return n; });
  check('idle-loop breakpoint hits equal with/without idle skip', hits[0] === hits[1], hits.join(' / '));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
