#!/usr/bin/env node
// The emulated PCM on a virtual SCI line, driven over stdin/stdout in lock step by a test harness
// (sci_reader/tests/sim_hs.cpp runs the Arduino sketch logic hs_link.h against it).
//
//   node tools/sci_pipe.mjs [--rpm N] [--map HH] [--tps HH] [--coolant C] [--air C] [--battery V]
//                           [--line switch|fixed] [--cut-at MS] [--cut-ms MS] [--reset-at MS]
//                           [--settle MS] [--trace FILE]
//
// Engine: --rpm 0 = key on, engine off; otherwise crank and run at N rpm (startEngine), then --settle ms.
// Line model (findings/SCI_COMMANDS.txt 2.3, HYP): the vehicle line runs at 62500 baud while the last SPI
// byte sent to the $FD output driver had bit 3 set, else 7812.5 (--line fixed: always 7812.5). Every byte
// is a 10-bit 8N1 frame at the line rate. A byte sent at the other rate is decoded bit by bit the way a
// UART would (uartDecode: start on a falling edge, start bit checked half a bit later, data and stop bits
// sampled in the middle, then hunt for the next falling edge):
//   fast byte into a slow receiver: 0xFF or nothing
//   slow byte into a fast receiver: one to four bytes, each 0x00 or 0x80; those with a framing error
//   (stop bit read as 0) are dropped by the PCM (FD26). The harness uses the same model on its side.
// The MCU side is the emulator's own SCI (9-bit frames at BAUD=$01); a line byte is handed to it when its
// line frame has ended. Nothing in machine/ is changed: bytes go in through sci.rxQueue like sideSend().
// Faults: --cut-at/--cut-ms drop every byte in both directions in that window (cut-ms < 0 = for ever);
// --reset-at resets the CPU (a key cycle; the line interface returns to 7812.5).
// All times are microseconds (ms for options) from READY.
//
// Protocol (one line each):
//   harness -> pipe   W <end_us> <hex> <baud>   a byte whose line frame ends at end_us (>= the last T)
//                     T <us>                    run the PCM to us; answered by B lines, then K <us>
//                     Q                         write the trace and exit
//   pipe -> harness   READY <rpm>               after the warm-up
//                     B <end_us> <hex> <baud>   a PCM byte whose line frame ends at end_us
//                     K <us>
// --trace FILE writes JSON lines: ready/end (engine view + RAM 0000-01FF), hs (every reply of the
// high-speed TOC1 handler at F48A: request byte [$0100], reply B, page/table bits), rx (every byte the
// MCU received, with $F4.7 = high-speed state), tx, rate, garble, cut, reset.
import fs from 'node:fs';
import { ViperMachine } from '../machine/viper_machine.js';
import { keyOnEngineOff, startEngine } from '../machine/scenarios.js';

const argv = process.argv.slice(2);
const opt = { rpm: 800, line: 'switch', cutAt: null, cutMs: 0, resetAt: null, settle: 2000, trace: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { if (i + 1 >= argv.length) die(`missing value for ${a}`); return argv[++i]; };
  switch (a) {
    case '--rpm': opt.rpm = Number(val()); break;
    case '--map': opt.map = parseInt(val(), 16); break;
    case '--tps': opt.tps = parseInt(val(), 16); break;
    case '--coolant': opt.coolant = Number(val()); break;
    case '--air': opt.air = Number(val()); break;
    case '--battery': opt.battery = Number(val()); break;
    case '--line': opt.line = val(); if (!['switch', 'fixed'].includes(opt.line)) die('--line switch|fixed'); break;
    case '--cut-at': opt.cutAt = Number(val()); break;
    case '--cut-ms': opt.cutMs = Number(val()); break;
    case '--reset-at': opt.resetAt = Number(val()); break;
    case '--settle': opt.settle = Number(val()); break;
    case '--trace': opt.trace = val(); break;
    default: die(`unknown option ${a}`);
  }
}
function die(msg) { process.stderr.write(`sci_pipe: ${msg}\n`); process.exit(2); }

const FAST = 62500, SLOW = 7812.5;
const m = new ViperMachine();
if (opt.coolant !== undefined) m.inputs.coolantC = opt.coolant;
if (opt.air !== undefined) m.inputs.airC = opt.air;
if (opt.battery !== undefined) m.inputs.batteryV = opt.battery;
if (opt.tps !== undefined) m.inputs.tpsCounts = opt.tps;
if (opt.rpm > 0) {
  keyOnEngineOff(m, 500);
  startEngine(m, { rpm: opt.rpm, map: opt.map ?? (opt.rpm >= 2000 ? 0x80 : 0x50), settleMs: 0 });
} else {
  keyOnEngineOff(m, 500);
  if (opt.map !== undefined) m.inputs.mapCounts = opt.map;
}
m.run(opt.settle);

const c0 = m.cpu.cycles;
const cycToUs = (c) => (c - c0) * 1e6 / m.eClock;
const usToCyc = (us) => c0 + Math.round(us * m.eClock / 1e6);
const trace = [];
const rec = (o) => { if (opt.trace) trace.push(JSON.stringify(o)); };
const ramDump = () => Array.from(m.mem.subarray(0, 0x200));
const isFast = (baud) => baud > 20000;
const cut = (us) => opt.cutAt !== null && us >= opt.cutAt * 1000 && (opt.cutMs < 0 || us < (opt.cutAt + opt.cutMs) * 1000);

// line rate from the $FD driver's bit 3 (outputs.fdByte logs 'fd' on every change of the driven byte)
let lineFast = false;
const lineBaud = () => (lineFast ? FAST : SLOW);
m.on('fd', (e) => {
  if (opt.line !== 'switch') return;
  const f = !!(e.value & 0x08);
  if (f !== lineFast) { lineFast = f; rec({ k: 'rate', t: Math.round(cycToUs(e.cycle)), baud: lineBaud() }); }
});

// PCM -> line: one frame at a time at the line rate, starting when the MCU has shifted the byte out
let lineFree = 0;
const toHarness = [];
m.on('diagTx', (e) => {
  const t = cycToUs(e.cycle);
  if (t < 0) return;
  if (cut(t)) { rec({ k: 'cut', t: Math.round(t), dir: 'tx', byte: e.byte }); return; }
  const baud = lineBaud();
  const start = Math.max(t, lineFree);
  const end = start + 10e6 / baud;
  lineFree = end;
  toHarness.push({ end: Math.ceil(end), byte: e.byte, baud });
  rec({ k: 'tx', t: Math.round(t), byte: e.byte, baud });
});
m.on('diagRx', (e) => {
  const t = cycToUs(e.cycle);
  if (t >= 0) rec({ k: 'rx', t: Math.round(t), byte: e.byte, hs: !!(m.mem[0xF4] & 0x80), accepted: e.accepted });
});
// every reply of the high-speed handler (F48A sei, B = reply, $0100 = the request byte)
m.addBreakpoint(0xF48A, (mm) => {
  rec({ k: 'hs', t: Math.round(cycToUs(mm.cpu.cycles)), req: mm.mem[0x100], b: mm.cpu.b,
    page: (mm.mem[0x45] & 0x40) ? 1 : 0, table: (mm.mem[0x5A] & 0x04) ? 1 : 0 });
});

// One isolated 8N1 frame of `byte` sent with bit time ts, as a receiver with bit time tr decodes it:
// [{byte, fe}], fe = framing error.
function uartDecode(byte, ts, tr) {
  const bits = [0];
  for (let i = 0; i < 8; i++) bits.push((byte >> i) & 1);
  bits.push(1);
  const level = (t) => { if (t < 0) return 1; const k = Math.floor(t / ts); return k < 10 ? bits[k] : 1; };
  const out = [];
  let hunt = -1;
  while (out.length < 8) {
    let te = -1;
    for (let k = 0; k <= 9; k++) {
      if ((k ? bits[k - 1] : 1) === 1 && bits[k] === 0 && k * ts > hunt) { te = k * ts; break; }
    }
    if (te < 0) break;
    if (level(te + 0.5 * tr)) { hunt = te + 0.5 * tr; continue; }   // false start
    let v = 0;
    for (let i = 0; i < 8; i++) if (level(te + (1.5 + i) * tr)) v |= 1 << i;
    out.push({ byte: v, fe: !level(te + 9.5 * tr) });
    hunt = te + 9.5 * tr;
  }
  return out;
}

// line -> PCM
const pending = [];   // {cyc, us, byte, baud}, sorted by cyc
function deliver(p) {
  if (cut(p.us)) { rec({ k: 'cut', t: p.us, dir: 'rx', byte: p.byte }); return; }
  const lb = lineBaud();
  let got = [p.byte];
  if (isFast(p.baud) !== isFast(lb)) {
    const dec = uartDecode(p.byte, 1e6 / p.baud, 1e6 / lb);
    got = dec.filter((d) => !d.fe).map((d) => d.byte);   // the PCM drops framing errors (FD26)
    rec({ k: 'garble', t: p.us, dir: 'rx', sent: p.byte, sentBaud: p.baud, lineBaud: lb, decoded: dec, got });
    if (!got.length) return;
  }
  const sci = m.sci;
  for (const v of got) sci.rxQueue.push({ byte: v, r8: 0, fromTester: false });
  sci._pump(m.cpu.cycles);
  sci._next();
  m.reschedule();
}

let resetDone = opt.resetAt === null;
function runTo(cyc) {
  if (!resetDone) {
    const rc = usToCyc(opt.resetAt * 1000);
    if (rc <= cyc) {
      if (rc > m.cpu.cycles) m.runCycles(rc - m.cpu.cycles);
      m.reset();
      lineFast = false;
      resetDone = true;
      rec({ k: 'reset', t: Math.round(cycToUs(m.cpu.cycles)) });
    }
  }
  if (cyc > m.cpu.cycles) m.runCycles(cyc - m.cpu.cycles);
}

function step(us) {
  const target = usToCyc(us);
  while (pending.length && pending[0].cyc <= target) {
    const p = pending.shift();
    runTo(p.cyc);
    deliver(p);
  }
  runTo(target);
  let out = '';
  while (toHarness.length && toHarness[0].end <= us) {
    const b = toHarness.shift();
    out += `B ${b.end} ${b.byte.toString(16).padStart(2, '0')} ${b.baud}\n`;
  }
  return out + `K ${us}\n`;
}

function finish() {
  rec({ k: 'end', t: Math.round(cycToUs(m.cpu.cycles)), engine: m.engine(), ram: ramDump(), faults: m.faults });
  if (opt.trace) fs.writeFileSync(opt.trace, trace.join('\n') + '\n');
  process.exit(0);
}

rec({ k: 'ready', t: 0, engine: m.engine(), ram: ramDump(), line: opt.line });
process.stdout.write(`READY ${m.engine().rpm.toFixed(1)}\n`);

let buf = '';
process.stdin.setEncoding('ascii');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let out = '';
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const f = line.split(' ');
    if (f[0] === 'W') {
      const us = Number(f[1]);
      const p = { cyc: usToCyc(us), us, byte: parseInt(f[2], 16), baud: Number(f[3]) };
      // runCycles stops on an instruction boundary, so the PCM can be up to one instruction (41 E cycles) past the
      // requested time: deliver such a byte now instead of failing
      if (p.cyc < m.cpu.cycles && m.cpu.cycles - p.cyc <= 41) p.cyc = m.cpu.cycles;
      if (p.cyc < m.cpu.cycles) die(`W at ${us} us is in the past (PCM at ${cycToUs(m.cpu.cycles).toFixed(0)} us)`);
      let i = pending.length;
      while (i > 0 && pending[i - 1].cyc > p.cyc) i--;
      pending.splice(i, 0, p);
    } else if (f[0] === 'T') {
      out += step(Number(f[1]));
    } else if (f[0] === 'Q') {
      if (out) process.stdout.write(out);
      finish();
    } else die(`bad line ${line}`);
  }
  if (out) process.stdout.write(out);
});
process.stdin.on('end', finish);
