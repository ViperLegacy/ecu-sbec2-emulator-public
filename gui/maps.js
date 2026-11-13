// Calibration table math for the MAPS panel. DOM-free (tested by tests/gui_smoke.test.mjs).
// Exactly the recipe of data/tables.json `conventions` (same as analysis/tools/maps_verify.mjs, which checked it
// against the real EE4B/EEB9 routines on cpu.js):
//   curve (EE4B): A<=x0 -> y0; A>=x_last -> y_last; else y_i + dx*slope_hi + round(dx*slope_lo/256), mod 256
//   map   (EEB9): idx=((n-1)*in)>>8, frac=((n-1)*in)&255, linear in col then row; input 255 never reaches
//                 the last row/col.

import { signed8 } from './format.js';

export function tableByAddr(DATA, addr) {
  const a = String(addr).toUpperCase();
  return DATA.tables.tables.find((t) => t.addr === a) || null;
}

/** Curve value (byte 0..255) at input a. */
export function evalCurve(t, a) {
  const xs = t.x_axis.breakpoints, raw = t.values[0].map((v) => v & 255), sl = t.slopes_8p8;
  a &= 255;
  if (a <= xs[0]) return raw[0];
  for (let i = 0; i < xs.length - 1; i++) {
    if (a < xs[i + 1]) {
      const dx = a - xs[i];
      const s = sl[i] & 0xFFFF, hi = s >> 8, lo = s & 255;
      const p = dx * lo;
      return (raw[i] + dx * hi + (p >> 8) + ((p >> 7) & 1)) & 255;
    }
  }
  return raw[raw.length - 1];
}

/** Row/column index + fraction for map inputs A (row) and B (col). */
export function mapCell(t, A, B) {
  const r = t.rows, c = t.cols;
  A &= 255; B &= 255;
  const ri = ((r - 1) * A) >> 8, rf = ((r - 1) * A) & 255;
  const ci = ((c - 1) * B) >> 8, cf = ((c - 1) * B) & 255;
  return { ri, rf, ci, cf, rowPos: ri + rf / 256, colPos: ci + cf / 256 };
}

/** Map value (byte 0..255; use displayValue() for signed maps) at row input A, column input B (EEB9 + EF37/EF33). */
export function evalMap(t, A, B) {
  const r = t.rows, c = t.cols, signed = !!t.signed;
  const cell = (i, j) => (i < r && j < c) ? (t.values[i][j] & 255) : 0;
  const { ri, rf, ci, cf } = mapCell(t, A, B);
  const interp = (p, q, f) => {
    const d = (p - q) & 255;
    const lt = signed ? (signed8(p) - signed8(q)) < 0 : p < q;
    let res;
    if (lt) { const nd = (-d) & 255; const m = nd * f; res = (m >> 8) + ((m >> 7) & 1); }
    else { const m = d * f; res = (-(((m >> 8) + ((m >> 7) & 1)) & 255)) & 255; }
    return (res + p) & 255;
  };
  const a0 = interp(cell(ri, ci), cell(ri, ci + 1), cf);
  const a1 = ri + 1 < r ? interp(cell(ri + 1, ci), cell(ri + 1, ci + 1), cf) : 0;
  return interp(a0, a1, rf);
}

export const displayValue = (t, v) => (t.signed ? signed8(v) : v & 255);

/** rpm16 high byte rounded by bit7 of the low byte (EFCE: ldd $6E / aslb / adca #0). Wraps like the firmware
 *  ($FF80 and above give 00; only reached above ~8176 rpm INFERRED). */
export function rpmRounded(peek) {
  return (peek(0x6E) + ((peek(0x6F) & 0x80) ? 1 : 0)) & 0xFF;
}

/**
 * Resolve the live input byte of a curve from its x_axis.source_ram text.
 * Returns {a, src} or null when the input is a computed expression the GUI does not reproduce.
 */
export function liveCurveInput(t, peek) {
  const s = (t.x_axis && t.x_axis.source_ram) || '';
  if (/^\$6E/i.test(s) && /not rounded/i.test(s)) return { a: peek(0x6E), src: '$6E (rpm/32)' };   // 85CF (D11B ldaa $6E)
  if (/\$6E/.test(s) && /round/i.test(s)) return { a: rpmRounded(peek), src: '$6E rounded (rpm/32)' };
  if (/^\$6E rpm high byte/i.test(s)) return { a: peek(0x6E), src: '$6E (rpm/32)' };
  const m = s.match(/^\$([0-9A-F]{2,4})\b(.*)$/i);
  if (!m) return null;
  const rest = m[2];
  if (/^\s*[-+*/]|\s[-+*/]\s|ratio|minus/i.test(rest.split('(')[0])) return null;   // "$08 baro - $76 MAP" etc.
  const addr = parseInt(m[1], 16);
  return { a: peek(addr), src: '$' + m[1].toUpperCase() };
}

function axisInput(axis, DATA, peek) {
  if (!axis) return null;
  if (axis.precurve === '8058') return { v: peek(0x70), src: '$70 (curve 8058 of rpm)' };
  if (axis.precurve) {
    const pc = tableByAddr(DATA, axis.precurve);
    if (axis.precurve === '85BC') return { v: peek(0x105), src: '$0105 (curve 85BC of $7B)' };
    const li = pc ? liveCurveInput(pc, peek) : null;
    if (!li) return null;
    return { v: evalCurve(pc, li.a), src: `curve ${axis.precurve}(${li.src}=${li.a})` };
  }
  const m = String(axis.source_ram || '').match(/^\$([0-9A-F]{2,4})/i);
  if (!m) return null;
  return { v: peek(parseInt(m[1], 16)), src: '$' + m[1].toUpperCase() };
}

/** Live row/col inputs for a map from RAM (same idx/frac arithmetic as the firmware). */
export function liveMapInputs(t, DATA, peek) {
  const row = axisInput(t.y_axis, DATA, peek), col = axisInput(t.x_axis, DATA, peek);
  if (!row || !col) return null;
  const cell = mapCell(t, row.v, col.v);
  return { A: row.v, B: col.v, rowSrc: row.src, colSrc: col.src, ...cell, value: displayValue(t, evalMap(t, row.v, col.v)) };
}

/** Interpolate an axis' engineering value at a fractional cell position (for labels of the live marker). */
export function axisEngAt(axis, pos) {
  if (!axis || !axis.eng) return null;
  const e = axis.eng, i = Math.max(0, Math.min(e.length - 1, Math.floor(pos)));
  const f = pos - i;
  return i + 1 < e.length ? e[i] + (e[i + 1] - e[i]) * f : e[i];
}

/** Tables featured in the GUI (brief sec. 10). */
export const FEATURED_MAPS = ['80B1', '83B3', '8B57', '85E2', '833C', '8294', '82E8', '90BB'];
export const FEATURED_CURVES = ['867C', '86AF', '86D2', '86E5', '8708', 'B800', 'B81B', '8058', 'BCCA', '8659', '8CA2', '8CB5'];
