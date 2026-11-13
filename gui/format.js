// Formatting and scaling helpers for the Viper PCM GUI. DOM-free (imported by tests/gui_smoke.test.mjs).
// Every engineering scale below is INFERRED (brief sec. 9 / ram_symbols.json) unless the tag says otherwise.

export const hex2 = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '--' : (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '----' : (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
export const hexBytes = (arr) => Array.from(arr || [], hex2).join(' ');
export const signed8 = (v) => ((v & 0xFF) << 24) >> 24;
export const signed16 = (v) => ((v & 0xFFFF) << 16) >> 16;
export const bits8 = (v) => (v & 0xFF).toString(2).padStart(8, '0');

/** Parse "16 80", "1680", "0x16,0x80", "$16 $80" -> [0x16, 0x80]. Throws on bad input. */
export function parseHexBytes(str) {
  const s = String(str).trim();
  if (!s) return [];
  let toks = s.split(/[\s,;]+/).filter(Boolean).map((t) => t.replace(/^(0x|\$)/i, ''));
  if (toks.length === 1 && toks[0].length > 2 && toks[0].length % 2 === 0) toks = toks[0].match(/../g);
  return toks.map((t) => {
    if (!/^[0-9a-f]{1,2}$/i.test(t)) throw new Error(`not a hex byte: "${t}"`);
    return parseInt(t, 16);
  });
}

/** Parse a hex address "6E", "$006E", "0x1C" -> number (0..FFFF). */
export function parseHexAddr(str) {
  const t = String(str).trim().replace(/^(0x|\$)/i, '');
  if (!/^[0-9a-f]{1,4}$/i.test(t)) throw new Error(`not a hex address: "${str}"`);
  return parseInt(t, 16);
}

/** Confidence string -> css class / short tag. */
export function confClass(conf) {
  const c = String(conf || '').toLowerCase();
  if (!c) return 'c-unk';
  if (c.startsWith('high')) return 'c-hi';
  if (c.startsWith('medium-high')) return 'c-mhi';
  if (c.startsWith('medium-low') || c.startsWith('low-medium')) return 'c-mlo';
  if (c.startsWith('medium')) return 'c-med';
  if (c.startsWith('low')) return 'c-lo';
  return 'c-unk';
}

const TICK_MS = 0.004;  // 4 us per TCNT tick at the ASSUMED 2 MHz E clock

/**
 * Scale for a RAM address (4-hex-digit key as in ram_symbols.json). f(raw) -> number|string.
 * tag: INFERRED / SHOWN / ASSUMED. These follow brief sec. 9.
 */
export const RAM_SCALES = {
  '006E': { f: (x) => x / 8, unit: 'rpm', tag: 'INFERRED', digits: 0 },
  '00E7': { f: (x) => x / 8, unit: 'rpm', tag: 'INFERRED', digits: 0 },
  '005E': { f: (x) => x * TICK_MS, unit: 'ms', tag: 'ASSUMED 2 MHz', digits: 2 },
  '007B': { f: (x) => x - 128, unit: 'degC', tag: 'INFERRED', digits: 0 },
  '0078': { f: (x) => x - 128, unit: 'degC', tag: 'INFERRED', digits: 0 },
  '0088': { f: (x) => x - 128, unit: 'degC', tag: 'INFERRED', digits: 0 },
  '0080': { f: (x) => x / 16, unit: 'V', tag: 'INFERRED', digits: 2 },
  '0079': { f: (x) => x * 5 / 255, unit: 'V', tag: 'ASSUMED 5V=255', digits: 3 },
  '007A': { f: (x) => x * 5 / 255, unit: 'V', tag: 'ASSUMED 5V=255', digits: 3 },
  '007F': { f: (x) => x * 5 / 255, unit: 'V', tag: 'ASSUMED 5V=255', digits: 2 },
  '0077': { f: (x) => x * 5 / 255, unit: 'V', tag: 'ASSUMED 5V=255', digits: 2 },
  '0003': { f: (x) => x * 5 / 255, unit: 'V', tag: 'ASSUMED 5V=255', digits: 2 },
  '007E': { f: (x) => x * 5 / 255, unit: 'V', tag: 'ASSUMED 5V=255', digits: 2 },
  '007D': { f: (x) => x * 5 / 255, unit: 'V', tag: 'ASSUMED 5V=255', digits: 2 },
  '0071': { f: (x) => x * 0.5, unit: 'deg', tag: 'INFERRED 0.5/count', digits: 1 },
  '0075': { f: (x) => x * 0.5, unit: 'deg', tag: 'INFERRED 0.5/count', digits: 1 },
  '0072': { f: (x) => signed8(x), unit: 'counts', tag: 'signed', digits: 0 },
  '0089': { f: (x) => x * TICK_MS, unit: 'ms', tag: 'ASSUMED 4 us/tick', digits: 3 },
  '008B': { f: (x) => x * TICK_MS, unit: 'ms', tag: 'ASSUMED 4 us/tick', digits: 3 },
  '008D': { f: (x) => x * TICK_MS, unit: 'ms', tag: 'ASSUMED 4 us/tick', digits: 3 },
  '008F': { f: (x) => x * TICK_MS, unit: 'ms', tag: 'ASSUMED 4 us/tick', digits: 3 },
  '0091': { f: (x) => x * TICK_MS, unit: 'ms', tag: 'ASSUMED 4 us/tick', digits: 3 },
  '0093': { f: (x) => x / 256, unit: 'x', tag: 'INFERRED', digits: 3 },
  '0095': { f: (x) => x / 256, unit: 'x', tag: 'INFERRED', digits: 3 },
  '00BE': { f: (x) => 1 + x / 256, unit: 'x', tag: 'INFERRED (1+x/256)', digits: 3 },
  '00B1': { f: (x) => 1 + x / 256, unit: 'x', tag: 'INFERRED (1+x/256)', digits: 3 },
  '00B0': { f: (x) => 1 + x / 256, unit: 'x', tag: 'SHOWN D1F7 ($01:$B0)', digits: 3 },   // unsigned: D = $0100+$B0
  '00BC': { f: (x) => x / 64, unit: 'x add', tag: 'INFERRED (x/64)', digits: 3 },
  '00DD': { f: (x) => x * 4 * TICK_MS, unit: 'ms', tag: 'x4 ticks SHOWN, 4us ASSUMED', digits: 3 },
  '00A3': { f: (x) => signed8(x), unit: 'signed', tag: 'medium', digits: 0 },
  '00A4': { f: (x) => signed8(x), unit: 'signed', tag: 'medium', digits: 0 },
  '00A5': { f: (x) => signed8(x), unit: 'signed', tag: 'medium', digits: 0 },
  '00A6': { f: (x) => signed8(x), unit: 'signed', tag: 'medium', digits: 0 },
  '001C': { f: (x) => signed8(x), unit: 'signed?', tag: 'unknown', digits: 0 },
  '0032': { f: (x) => signed8(x), unit: 'signed?', tag: 'unknown', digits: 0 },
  '006C': { f: (x) => x * 256 * 11 / 1000, unit: 's (approx)', tag: '256 passes', digits: 0 },
};

/** Addresses whose value is best shown as bits. */
export const BIT_ADDRS = new Set(['0044', '0046', '004F', '0050', '0085', '00EC', '00ED', '00EE', '00EF', '00F0', '00F4',
  '00FC', '00FD', '00FE', '0400', '0115', '0116', '00F5']);

export function addrKey(a) { return (typeof a === 'number' ? a : parseInt(a, 16)).toString(16).toUpperCase().padStart(4, '0'); }

/**
 * Format a watch value. entry = ram_symbols row ({addr,size,name,...}); value = number (or array for size>2).
 * Returns {raw, scaled, unit, tag}.
 */
export function scaleWatch(entry, value, faultName = null) {
  const key = addrKey(entry.addr);
  if (Array.isArray(value)) {
    const raw = hexBytes(value);
    if (key === '0039') {
      const codes = value.slice().reverse().filter((x) => x);
      return { raw, scaled: codes.length ? codes.map((c) => hex2(c) + (faultName ? ' ' + faultName(c) : '')).join(', ') : 'none', unit: 'codes (newest first)', tag: 'SHOWN' };
    }
    return { raw, scaled: '', unit: '', tag: '' };
  }
  const raw = entry.size === 2 ? hex4(value) : hex2(value);
  if (key === '00F8' || key === '00F9') return { raw, scaled: value ? (faultName ? faultName(value) : hex2(value)) : 'none', unit: 'SCI code', tag: 'SHOWN' };
  const s = RAM_SCALES[key];
  if (s) {
    const v = s.f(value);
    return { raw, scaled: typeof v === 'number' ? v.toFixed(s.digits ?? 2) : String(v), unit: s.unit, tag: s.tag };
  }
  if (BIT_ADDRS.has(key) && entry.size !== 2) return { raw, scaled: bits8(value), unit: 'b7..b0', tag: 'bits' };
  return { raw, scaled: String(value), unit: entry.units || '', tag: 'raw' };
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '--';
  if (ms < 1000) return ms.toFixed(1) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(3) + ' s';
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms - m * 60000) / 1000).toFixed(2).padStart(5, '0')}`;
}

/** CCR as SXHINZVC with '-' for cleared bits. */
export function ccrStr(ccr) {
  const n = 'SXHINZVC';
  let s = '';
  for (let i = 0; i < 8; i++) s += (ccr & (0x80 >> i)) ? n[i] : '-';
  return s;
}

/** Compact one-line text for a machine log event (without seq/type/cycle/ms). */
export function eventText(e) {
  const skip = new Set(['seq', 'type', 'cycle', 'ms']);
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    if (skip.has(k) || v === undefined) continue;
    let t;
    if (k === 'byte' || k === 'value' || k === 'old') t = typeof v === 'number' ? '$' + hex2(v) : String(v);
    else if (k === 'pc' || k === 'addr' || k === 'vector') t = typeof v === 'number' ? '$' + hex4(v) : String(v);
    else if (Array.isArray(v)) t = v.every((x) => typeof x === 'number') ? '[' + hexBytes(v) + ']' : JSON.stringify(v);
    else if (v && typeof v === 'object') t = JSON.stringify(v);
    else t = String(v);
    parts.push(`${k}=${t}`);
  }
  return parts.join(' ');
}
