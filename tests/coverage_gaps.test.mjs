// Model features added after the execution-coverage dig (findings/COVERAGE_DIG.txt): each one makes firmware code
// reachable that a static input could not.
import { ViperMachine } from '../machine/viper_machine.js';
import { keyOnEngineOff, startEngine } from '../machine/scenarios.js';
import { makeChecker, hex } from './review/util.mjs';

const { check, done } = makeChecker('coverage-gap models');
const hits = (m, pcs) => { const n = {}; for (const pc of pcs) { n[pc] = 0; m.addBreakpoint(pc, () => { n[pc]++; }); } return n; };
const codes = (m) => Array.from(m.mem.slice(0x3C, 0x44)).filter((c) => c);   // not used for asserts, detail only

// ---- ASD feed follows $FD.4 -----------------------------------------------------------------------------
{
  const m = new ViperMachine();
  const n = hits(m, [0x9AC6]);
  keyOnEngineOff(m, 300);
  check('boot waits for the ASD feed to rise (9AC6 polled)', n[0x9AC6] > 0, `${n[0x9AC6]} polls`);
  check('feed is up during the key-on prime', (m.asic.read0400() & 0x10) !== 0 && !(m.outputs.fd & 0x10));
  m.run(4000);
  check('feed drops when the prime ends (ASD off)', (m.outputs.fd & 0x10) !== 0 && !(m.asic.read0400() & 0x10));
  startEngine(m, { rpm: 800, settleMs: 2000 });
  check('feed is up with the engine running', (m.asic.read0400() & 0x10) !== 0);
  check('no fault code from the feed model', m.mem[0xF8] === 0 && m.mem[0xF9] === 0, `F8 ${hex([m.mem[0xF8], m.mem[0xF9]])}`);
  m.inputs.relayFeedMode = 'level'; m.stimulus.setRpm(0); m.run(4000);
  check("'level' mode keeps the old static feed", (m.asic.read0400() & 0x10) !== 0);
}
// ---- smart-device busy pulse and mid-frame stall --------------------------------------------------------
{
  const m = new ViperMachine();
  const n = hits(m, [0x995C, 0x997D, 0xDF42]);
  keyOnEngineOff(m, 1000);
  check('per-byte busy pulse makes the boot handshake loops count (995C, 997D)', n[0x995C] > 0 && n[0x997D] > 0, `${n[0x995C]} / ${n[0x997D]}`);
  check('frames still complete: $048C holds the reply', m.peek(0x048C) === 0x80, hex([m.peek(0x048C)]));
  startEngine(m, { rpm: 800, settleMs: 1000 });
  m.inputs.spiStallAfter = 2; m.run(3000);
  check('stall after byte 2 reaches the mid-frame time-out (DF42)', n[0xDF42] > 0, `${n[0xDF42]} hits`);
  m.inputs.spiStallAfter = null; m.run(500);
  check('handshake recovers when the stall is removed', !m.spi.handshakeBusy(m.cpu.cycles + 1000));
}
// ---- O2 open circuit ------------------------------------------------------------------------------------
{
  const m = new ViperMachine();
  m.inputs.o2Open = [true, false];
  check('open sensor, bias off: inside the $14..$22 window', m.inputs.adc(2) === 0x1B);
  m.asic.latch |= 0x08;
  check('open sensor, $0440.3 = 1: at or above $4D', m.inputs.adc(2) >= 0x4D && m.inputs.adc(7) < 0x4D);
}
// ---- $FD feedback XOR -----------------------------------------------------------------------------------
{
  const m = new ViperMachine();
  m.inputs.coolantC = 90; keyOnEngineOff(m, 500); startEngine(m, { rpm: 1500, map: 0x60, settleMs: 3000 });
  const n = hits(m, [0xDED4]);
  m.inputs.fdFeedbackXor = 0x20; m.run(20000);
  check('one stuck output bit (purge, b5) reaches the code 12 store (DED4)', n[0xDED4] > 0, `${n[0xDED4]} hits, codes ${hex(codes(m))}`);
}
// ---- flash programming ----------------------------------------------------------------------------------
{
  const m = new ViperMachine();
  keyOnEngineOff(m, 200);
  const A = 0x9500, old = m.mem[A], nv = old ^ 0x41;
  m._write(A, 0x00, m.cycles);
  check('a plain store to the flash does nothing', m.mem[A] === old);
  m._write(0xD555, 0xAA, m.cycles); m._write(0xAAAA, 0x55, m.cycles); m._write(0xD555, 0xA0, m.cycles); m._write(A, nv, m.cycles);
  check('during the write the cell reads back with bit 7 inverted', m.mem[A] === (nv ^ 0x80));
  m.inputs.key = true; m.run(m.flashWriteMs + 1);
  check('after the write time the cell holds the new byte (image too)', m.mem[A] === nv && m.rom[A - 0x8000] === nv);
}
// ---- SCI receive errors ---------------------------------------------------------------------------------
{
  const m = new ViperMachine();
  keyOnEngineOff(m, 500);
  const n = hits(m, [0xFD2A]);
  m.sideChannelSend([0x05], 'fe'); m.run(50);
  check('a framing error reaches the receive-error path (FD2A)', n[0xFD2A] > 0, `${n[0xFD2A]} hits`);
  check('the error flags clear on the SCDR read', !m.sci.fe && !m.sci.nf);
}
// ---- XIRQ -----------------------------------------------------------------------------------------------
{
  const m = new ViperMachine();
  keyOnEngineOff(m, 500);
  const n = hits(m, [0x9400]);
  m.pulseXirq(); m.run(100);
  check('XIRQ restarts through 9400 once and releases', n[0x9400] === 1 && !m.inputs.xirq, `${n[0x9400]} hits`);
  m.run(500);
  check('the firmware runs on after the restart', m.passes > 0 && m.faults.length === 0, `faults ${m.faults.map((f) => f.kind)}`);
}
done();
