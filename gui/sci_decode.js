// SCI scan-tool command index and reply decoder for the GUI. DOM-free (tested by tests/gui_smoke.test.mjs).
// Source: data/sci_commands.json + data/faults.json + data/ram_symbols.json (bundled as DATA in rom/viper_rom.js).
// Replies include the PCM's echo of every request byte (brief sec. 7).

import { hex2, hex4, hexBytes, scaleWatch } from './format.js';

/** Commands that actuate outputs or write memory (brief sec. 7). Plus anything with a `danger` text in the JSON. */
export const UNSAFE_CMDS = new Set([0x13, 0x18, 0x19, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x21, 0x23]);
/** Commands whose reply is a continuous stream (one byte per main-loop pass until another command). */
export const STREAM_CMDS = new Set([0x14, 0x1A, 0x22]);

export function buildSciIndex(DATA) {
  const cmds = [];
  const byCmd = new Map();
  for (const c of Object.values(DATA.sci_commands)) {
    if (!c || !c.cmd || !/^[0-9A-F]{2}$/i.test(c.cmd)) continue;
    const code = parseInt(c.cmd, 16);
    const e = { code, hex: c.cmd.toUpperCase(), name: c.name, args: c.args ?? 0, request: c.request || [c.cmd],
      reply: c.reply_format || '', danger: c.danger || null, unsafe: UNSAFE_CMDS.has(code) || !!c.danger,
      gates: c.gates || '', selectors: c.selectors || [], decode: c.decode || null, groundTruth: c.ground_truth || null };
    cmds.push(e); byCmd.set(code, e);
  }
  cmds.sort((a, b) => a.code - b.code);
  const ram = new Map(DATA.ram_symbols.ram.map((r) => [r.addr.toUpperCase(), r]));
  const faults = new Map(DATA.faults.faults.map((f) => [f.code.toUpperCase(), f]));
  const sel = (code) => new Map((byCmd.get(code)?.selectors || []).map((s) => [parseInt(s.sel, 16), s]));
  return { cmds, byCmd, ram, faults, sel14: sel(0x14), sel22: sel(0x22), sel1A: sel(0x1A), sel16: sel(0x16) };
}

/** PCM receive-parser state as the gate models it (D4A5): hs = high-speed mode (12 .. FE), pending = argument
 *  bytes still owed to the last command. */
export const PARSER_IDLE = Object.freeze({ hs: false, pending: 0 });

/**
 * Walk req from a set of parser states (a small NFA). Returns {unsafe, states}: the first unsafe command (entry or
 * null) and the possible states after the last byte. In high-speed mode every byte is a RAM address except FE,
 * which exits (F41E-F498). Outside it the byte after a complete command (its argument bytes included) is the next
 * command. 12 (and its alias 92) may or may not reach high-speed mode, so both branches are followed: assuming
 * high-speed when the PCM is not in it would let a following 13 through.
 */
export function walkParser(index, starts, req) {
  let cur = Array.isArray(starts) ? starts : [starts];
  let unsafe = null;
  const key = (s) => `${s.hs ? 1 : 0}:${s.pending}`;
  for (const b of req) {
    const nxt = new Map();
    const add = (s) => nxt.set(key(s), s);
    for (const s of cur) {
      if (s.hs) { add(b === 0xFE ? PARSER_IDLE : s); continue; }
      if (s.pending > 0) { add({ hs: false, pending: s.pending - 1 }); continue; }
      // $90-$A3 alias onto the $10-$23 handlers with zeroed arguments (D791 drops the aslb carry; no argument
      // bytes are read, D549). Unsafe when the aliased handler is, e.g. $9C = 1C writes 00 to EEPROM B600.
      const alias = b >= 0x90 && b <= 0xA3;
      const c = index.byCmd.get(alias ? b - 0x80 : b);
      if (c && c.unsafe && !unsafe) unsafe = alias ? { ...c, code: b, hex: b.toString(16).toUpperCase(), name: `alias of ${c.hex} (${c.name}, zeroed args)` } : c;
      if (b === 0x12 || b === 0x92) { add({ hs: true, pending: 0 }); add(PARSER_IDLE); }
      else add({ hs: false, pending: alias || !c ? 0 : c.args });
    }
    cur = [...nxt.values()];
  }
  return { unsafe, states: cur };
}

/** Every parser state the PCM could be in after the possible states `states` receive req. A pending argument can
 *  also time out (15 idle passes, D50F) and a PCM reset returns to idle, so idle is always included. */
export function nextParserStates(index, states, req) {
  const out = [PARSER_IDLE];
  for (const st of walkParser(index, states, req).states) { out.push(st); if (st.pending) out.push({ hs: st.hs, pending: 0 }); }
  const seen = new Set();
  return out.filter((st) => { const k = `${st.hs}:${st.pending}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** States to assume when nothing is known (e.g. after monitor mode, 1B): any of them. */
export const PARSER_UNKNOWN = Object.freeze([PARSER_IDLE, { hs: false, pending: 1 }, { hs: false, pending: 2 }, { hs: true, pending: 0 }]);

/**
 * First unsafe command in a byte sequence, checked from every possible starting parser state (default: idle).
 * Returns the command entry or null.
 */
export function findUnsafe(index, req, states = [PARSER_IDLE]) {
  return walkParser(index, states, req).unsafe;
}

export function faultName(index, code) {
  const f = index.faults.get(hex2(code));
  return f ? f.name : 'unknown code';
}

/** RAM symbol for a 4-hex-digit address (or null). */
export function ramSymbol(index, addr) {
  return index.ram.get(String(addr).toUpperCase().padStart(4, '0')) || null;
}

/** Address class for SCI 15: what the bus returns there. */
export function addressClass(a) {
  if (a < 0x0200) return 'internal RAM';
  if (a < 0x0400) return 'unmapped (returns low address byte)';
  if (a < 0x0410) return 'external ASIC';
  if (a === 0x0440) return 'latch 0440 (write-only)';
  if (a >= 0x0480 && a < 0x0500) return 'external RAM';
  if (a < 0x1000) return 'unmapped (returns low address byte)';
  if (a < 0x1040) return 'HC11 register';
  if (a < 0x8000) return 'unmapped (returns low address byte)';
  if (a >= 0xB600 && a < 0xB800) return 'EEPROM overlay';
  return 'flash';
}

/**
 * Decode one transaction. req = request bytes, bytes = everything the PCM sent after the request started
 * (echoes + reply). opts.romByte(addr) (optional) lets 15 hh ll compare with the image.
 * Returns {echo, echoOk, reply, complete, title, lines: [string], value?: {...}}.
 */
export function decodeReply(index, req, bytes, opts = {}) {
  const n = req.length;
  const echo = bytes.slice(0, n);
  const echoOk = echo.length === n && echo.every((b, i) => b === req[i]);
  const reply = bytes.slice(n);
  const cmd = req[0];
  const e = index.byCmd.get(cmd);
  const out = { echo, echoOk, reply, complete: false, title: e ? `${e.hex} ${e.name}` : `${hex2(cmd)} unknown command`, lines: [] };
  if (!echoOk) out.lines.push(echo.length < n ? `waiting for echo (${echo.length}/${n})` : `echo mismatch: sent ${hexBytes(req)}, got ${hexBytes(echo)}`);
  const L = (s) => out.lines.push(s);
  const fname = (c) => faultName(index, c);
  switch (cmd) {
    case 0x16: {
      if (reply.length >= 5) {
        const id = reply.slice(0, 4);
        const sum = (req[0] + req[1] + id.reduce((a, b) => a + b, 0)) & 0xFF;
        out.value = { partNumber: id.map(hex2).join(''), checksum: reply[4], checksumOk: sum === reply[4] };
        L(`part number ${out.value.partNumber}   checksum ${hex2(reply[4])} ${out.value.checksumOk ? 'OK' : `BAD (expected ${hex2(sum)})`}`);
        const s = index.sel16.get(req[1]); if (s) L(`selector ${hex2(req[1])}: ${s.meaning}`);
        out.complete = true;
      } else L(`id bytes so far: ${hexBytes(reply)}`);
      break;
    }
    case 0x10: {
      const fe = reply.indexOf(0xFE);
      if (fe >= 0 && reply.length > fe + 1) {
        const codes = reply.slice(0, fe);
        const sum = (0x10 + 0xFE + codes.reduce((a, b) => a + b, 0)) & 0xFF;
        out.value = { codes, checksum: reply[fe + 1], checksumOk: sum === reply[fe + 1] };
        if (!codes.length) L('no stored codes');
        for (const c of codes) L(`code ${hex2(c)}  ${fname(c)}`);
        L(`terminator FE, checksum ${hex2(reply[fe + 1])} ${out.value.checksumOk ? 'OK' : `BAD (expected ${hex2(sum)})`}`);
        out.complete = true;
      } else L(`codes so far: ${hexBytes(reply)}`);
      break;
    }
    case 0x11: {
      if (reply.length >= 2) {
        out.value = { pending: [reply[0], reply[1]], word: (reply[0] << 8) | reply[1] };
        L(`status word ${hex4(out.value.word)}  ($F8 ${hex2(reply[0])}, $F9 ${hex2(reply[1])})`);
        for (const c of reply.slice(0, 2)) if (c) L(`pending ${hex2(c)}  ${fname(c)}`);
        if (!reply[0] && !reply[1]) L('no pending codes');
        out.complete = true;
      }
      break;
    }
    case 0x15: {
      if (n >= 3 && reply.length >= 1) {
        const addr = (req[1] << 8) | req[2];
        const cls = addressClass(addr);
        out.value = { addr, byte: reply[0], cls };
        let extra = '';
        if (cls.startsWith('unmapped')) extra = reply[0] === (addr & 0xFF) ? '  (= low address byte, as on the car)' : `  (car would give ${hex2(addr & 0xFF)})`;
        else if ((cls === 'flash' || cls === 'EEPROM overlay') && opts.romByte) {
          const img = opts.romByte(addr);
          extra = img === reply[0] ? '  (= image byte)' : `  (image ${hex2(img)})`;
        } else if (cls === 'internal RAM') { const s = ramSymbol(index, hex4(addr)); if (s) extra = `  ${s.name}`; }
        L(`[$${hex4(addr)}] = ${hex2(reply[0])}  ${cls}${extra}`);
        out.complete = true;
      }
      break;
    }
    case 0x14: {
      const s = index.sel14.get(req[1]);
      const src = s ? s.source_addr : null;
      const sym = src && s.kind && s.kind.startsWith('RAM') ? ramSymbol(index, src) : null;
      out.value = { selector: req[1], source: src, symbol: sym ? sym.name : null, samples: reply.slice(), latest: reply.length ? reply[reply.length - 1] : null };
      if (!s) L(`selector ${hex2(req[1])}: not in the D9D6 table / FF entry -> no data bytes`);
      else L(`selector ${hex2(req[1])}: ${s.kind === 'function' ? 'function ' + src : 'RAM $' + src}${sym ? ' ' + sym.name : ''} - ${s.meaning}`);
      if (reply.length) {
        const v = reply[reply.length - 1];
        // a one-byte read of a word symbol (e.g. 14 10 -> $6E high byte): scale it as the word's high byte, v << 8
        const sc = sym ? (sym.size === 2 ? scaleWatch(sym, v << 8) : scaleWatch(sym, v)) : null;
        L(`latest ${hex2(v)} (${v})${sc && sc.unit ? `  = ${sc.scaled} ${sc.unit} [${sc.tag}]` : ''}   samples ${reply.length}`);
      }
      break;
    }
    case 0x22: {
      const s = index.sel22.get(req[1]);
      const words = [];
      for (let i = 0; i + 1 < reply.length; i += 2) words.push((reply[i] << 8) | reply[i + 1]);
      out.value = { selector: req[1], source: s ? s.source_addr : null, words, latest: words.length ? words[words.length - 1] : null };
      L(s ? `selector ${hex2(req[1])}: $${s.source_addr} ${s.meaning}` : `selector ${hex2(req[1])}: unknown`);
      if (words.length) {
        const w = words[words.length - 1];
        const sym = s ? ramSymbol(index, s.source_addr) : null;
        const sc = sym ? scaleWatch({ ...sym, size: 2 }, w) : null;
        L(`latest ${hex4(w)} (${w})${sc && sc.unit ? `  = ${sc.scaled} ${sc.unit} [${sc.tag}]` : ''}   words ${words.length}`);
      }
      break;
    }
    case 0x1A: {
      const s = index.sel1A.get(req[1]);
      out.value = { selector: req[1], latest: reply.length ? reply[reply.length - 1] : null };
      L(s ? `selector ${hex2(req[1])}: $${s.source_addr} ${s.meaning}` : `selector ${hex2(req[1])}: unknown`);
      if (reply.length) L(`latest ${hex2(out.value.latest)} = ${out.value.latest.toString(2).padStart(8, '0')}b`);
      break;
    }
    case 0x17: {
      const ff = reply.filter((b) => b === 0xFF).length;
      const done = reply.includes(0xE0);
      out.value = { ffCount: ff, cleared: done };
      L(done ? `codes CLEARED (E0) after ${ff} x FF` : `${ff} x FF (needs 25 consecutive 17 requests; engine stopped)`);
      out.complete = done;
      break;
    }
    default:
      if (reply.length) L(`reply ${hexBytes(reply)}`);
      if (!e) L('commands 01-09, 0B-0F, 24-FF: echo then 00');
  }
  return out;
}

/** Known car vectors (brief sec. 7) as {req, expect} for tests and the GUI self-check button. */
export const CAR_VECTORS = [
  { req: [0x16, 0x80], expect: [0x16, 0x80, 0x04, 0x76, 0x35, 0x55, 0x9A] },
  { req: [0x10], expect: [0x10, 0xFE, 0x0E] },
  { req: [0x11], expect: [0x11, 0x00, 0x00] },
  { req: [0x15, 0x20, 0x02], expect: [0x15, 0x20, 0x02, 0x02] },
];
