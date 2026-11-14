// Example: writing calibration flash through the SCI command-20 RAM worker (design: ../FLASH_WRITE_WORKER.txt).
// EMULATOR ONLY. 1E / 20 are on the do-not-send list for the car; nothing here has run on a PCM.
//
// Why a worker: SCI 1B can program flash only at 9400 and above (E8D4-E908), and every fuel / spark map lives below
// 9400. Command 20 runs code staged in external RAM, and that code can aim the firmware's own JEDEC byte-program
// sequence (E90F-E92B: AA -> D555, 55 -> AAAA, A0 -> D555, data -> target, poll) at any flash address.
//
// Worker T0: program ONE byte. The host stages target (04C0:04C1) and data (04C2) with 1E, then commits with 20.
// (The design text stages them at 0480-0482. That cannot work: the firmware itself rewrites 0480 / 0481 every pass
// for its SPI frames, so the worker would aim at whatever address it left there. 04C0-04FF is not touched.)
//   0492  7F 00 F1     clr  $00F1      defuse: without it the worker re-runs every main-loop pass
//   0495  F6 04 C2     ldab $04C2      B = data
//   0498  86 AA        ldaa #$AA
//   049A  B7 D5 55     staa $D555
//   049D  44           lsra            A = $55
//   049E  B7 AA AA     staa $AAAA
//   04A1  86 A0        ldaa #$A0
//   04A3  B7 D5 55     staa $D555
//   04A6  18 FE 04 C0  ldy  $04C0      Y = target
//   04AA  18 E7 00     stab $00,y      program
//   04AD  CE 00 00     ldx  #$0000     poll until it reads back, bounded like the firmware's stub
//   04B0  18 E1 00     cmpb $00,y
//   04B3  27 03        beq  $04B8
//   04B5  09           dex
//   04B6  26 F8        bne  $04B0
//   04B8  39           rts             the handshake requires a final RTS
// The defuse is CLR extended (7F 00 F1). The design text's "0F F1" is not a clear: 0F is SEI and the 68HC11 has no
// direct-mode CLR, so that listing would mask interrupts and run garbage (see findings/README.txt, revisit item 7).

export const WORKER_BASE = 0x0492;
export const ARGS_BASE = 0x04C0;          // target high, target low, data (1E offsets 40, 41, 42)
export const FLASH_WORKER_T0 = Object.freeze([
  0x7F, 0x00, 0xF1, 0xF6, 0x04, 0xC2, 0x86, 0xAA, 0xB7, 0xD5, 0x55, 0x44, 0xB7, 0xAA, 0xAA, 0x86, 0xA0, 0xB7, 0xD5, 0x55,
  0x18, 0xFE, 0x04, 0xC0, 0x18, 0xE7, 0x00, 0xCE, 0x00, 0x00, 0x18, 0xE1, 0x00, 0x27, 0x03, 0x09, 0x26, 0xF8, 0x39,
]);

/** Handshake numbers for command 20: L = code length (the RTS included), sum = 8-bit sum of the code bytes. */
export function workerHeader(code = FLASH_WORKER_T0) {
  if (code[code.length - 1] !== 0x39) throw new Error('worker must end in RTS ($39)');
  return { L: code.length, sum: code.reduce((a, b) => (a + b) & 0xFF, 0) };
}

/** 1E requests that plant the header and the code (1E oo vv stores vv at 0480+oo; echo + E5 each). */
export function stageWorkerRequests(code = FLASH_WORKER_T0) {
  const { L, sum } = workerHeader(code);
  return [[0x1E, 0x10, L], [0x1E, 0x11, sum], ...code.map((b, i) => [0x1E, 0x12 + i, b])];
}
/** 15 requests that read the planted bytes back (0490 .. end of code); verify before the first 20. */
export function verifyWorkerRequests(code = FLASH_WORKER_T0) {
  return Array.from({ length: code.length + 2 }, (_, i) => [0x15, 0x04, 0x90 + i]);
}
/** Requests that program one byte with an already staged worker: stage target + data, commit, read back. */
export function programByteRequests(addr, data, code = FLASH_WORKER_T0) {
  const { L, sum } = workerHeader(code);
  return [[0x1E, 0x40, addr >> 8], [0x1E, 0x41, addr & 0xFF], [0x1E, 0x42, data & 0xFF], [0x20, L, sum], [0x15, addr >> 8, addr & 0xFF]];
}

/** A byte program can only clear bits: the edit is expressible iff no bit goes 0 -> 1. */
export const programmable = (oldByte, newByte) => (oldByte & newByte) === newByte;

/** Unused $FF filler at the end of the calibration block (9161-93FF is all FF and nothing references it). */
export const SPARE_RANGE = [0x93F0, 0x93FF];

/**
 * Checksum compensation. The key-off check (DDE1-DE3A) sums 8000-FFFF without B600-B7FF and compares with [8005];
 * a mismatch stores code 02. The design text compensates at 800C (inside the sum, outside every ID reply):
 * new[800C] = old[800C] - delta. But a byte program only clears bits, so every edit LOWERS the sum, and the
 * compensating byte would have to RISE: for the worked example 800C would go $E8 -> $EA, which sets bit 1 and
 * cannot be programmed. What works with bit clears alone: lower the sum by the rest of a full 256. A spare $FF
 * filler byte programmed to $FF - R, with R = 256 - (total decrease mod 256), does that. Each spare byte is good
 * for one session (it can only go down again). 800C is still used when the value it needs happens to be reachable.
 */
export function checksumPatch(romByte, patches) {
  let delta = 0;
  for (const p of patches) delta += p.data - romByte(p.addr);
  delta &= 0xFF;
  if (delta === 0) return null;
  const old = romByte(0x800C), want = (old - delta) & 0xFF;
  if (programmable(old, want)) return { addr: 0x800C, data: want, old, label: 'checksum compensation at 800C' };
  for (let a = SPARE_RANGE[0]; a <= SPARE_RANGE[1]; a++) {
    if (romByte(a) === 0xFF) return { addr: a, data: 0xFF - delta, old: 0xFF, label: 'checksum compensation in spare $FF filler' };
  }
  throw new Error('no spare $FF byte left for the checksum compensation');
}

/**
 * The worked example of the design text: lean one VE cell by one count in BOTH copies of the map (83B3 and its twin
 * at 844F; the firmware picks one by $4C.6), then repair the checksum. Cell row 8, column 4: $DB -> $DA (bit 0
 * cleared). Order matters: map bytes first, the checksum byte last.
 */
export function exampleEdit(romByte) {
  const cells = [{ addr: 0x83FF, label: 'VE map row 8 col 4' }, { addr: 0x849B, label: 'VE twin map row 8 col 4' }]
    .map((c) => ({ ...c, old: romByte(c.addr), data: (romByte(c.addr) - 1) & 0xFF }));
  for (const c of cells) if (!programmable(c.old, c.data)) throw new Error(`${c.label}: $${hx2(c.old)} -> $${hx2(c.data)} sets bits (this image is not the stock calibration?)`);
  const fix = checksumPatch(romByte, cells);
  return fix ? [...cells, fix] : cells;
}

const hx2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const hx4 = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');
const hex = (a) => a.map(hx2).join(' ');
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Run the whole example on a machine through its scan-tool model (key on, engine stopped). Returns
 * { ok, steps: [{ title, req, reply, ok }], patches }. `log(line)` receives a readable transcript.
 */
export function runFlashWriteExample(m, { log = () => {}, patches = null, code = FLASH_WORKER_T0 } = {}) {
  const steps = [];
  const step = (title, req, expect, opts) => {
    const reply = m.sciRequest(req, { timeoutMs: 1500, ...opts });
    const ok = same(reply, expect);
    steps.push({ title, req, reply, expect, ok });
    if (!ok) log(`  FAIL ${title}: ${hex(req)} -> ${hex(reply)} (expected ${hex(expect)})`);
    return ok;
  };
  const { L, sum } = workerHeader(code);
  patches = patches || exampleEdit((a) => m.romByte(a));
  log(`worker T0: ${L} bytes at ${hx4(WORKER_BASE)}, 20 handshake = 20 ${hx2(L)} ${hx2(sum)}`);
  let ok = true;
  for (const r of stageWorkerRequests(code)) ok = step(`stage 0480+${hx2(r[1])}`, r, [...r, 0xE5]) && ok;
  log(`  staged ${code.length + 2} bytes with 1E (each echoes and answers E5)`);
  const want = [L, sum, ...code];
  verifyWorkerRequests(code).forEach((r, i) => { ok = step(`verify ${hx4(0x0490 + i)}`, r, [...r, want[i]]) && ok; });
  log(`  read every planted byte back with 15: ${ok ? 'all match' : 'MISMATCH, not committing'}`);
  if (!ok) return { ok: false, steps, patches };
  for (const p of patches) {
    const [th, tl, dd, commit, read] = programByteRequests(p.addr, p.data, code);
    for (const r of [th, tl, dd]) ok = step(`stage target/data for ${hx4(p.addr)}`, r, [...r, 0xE5]) && ok;
    ok = step(`commit ${hx4(p.addr)}`, commit, [...commit, 0xE4]) && ok;      // E4, then the worker runs on the next pass
    m.run(40);
    const good = step(`read back ${hx4(p.addr)}`, read, [...read, p.data]);
    ok = good && ok;
    log(`  ${hx4(p.addr)} ${p.label}: $${hx2(p.old)} -> $${hx2(p.data)}  20 ${hx2(L)} ${hx2(sum)} -> E4, 15 reads ${hx2(steps[steps.length - 1].reply.at(-1) ?? 0)} ${good ? 'ok' : 'NOT TAKEN'}`);
    if (!good) break;                                                         // never go on to the checksum byte after a failed one
  }
  return { ok, steps, patches };
}
