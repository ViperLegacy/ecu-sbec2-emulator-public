// MAPS panel: heat maps of the 3-D tables and plots of the curves in tables.json, with axis labels in raw and
// inferred units and a LIVE operating point computed from RAM with the firmware's own idx/frac arithmetic.

import { h, fill, tag, setText, fitCanvas, cssVar } from './dom.js';
import { hex2, confClass } from './format.js';
import { tableByAddr, evalCurve, liveMapInputs, liveCurveInput, axisEngAt, FEATURED_MAPS, FEATURED_CURVES } from './maps.js';
import { createWorkspaces } from './workspaces.js';

function heat(t) {   // 0..1 -> colour (perceptual-ish sequential)
  const stops = [[13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104], [244, 136, 73], [254, 188, 43], [240, 249, 33]];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}
function diverge(t) { // -1..1
  const x = Math.max(-1, Math.min(1, t));
  const c = x < 0 ? [59, 130, 246] : [239, 68, 68];
  const k = Math.abs(x);
  return `rgb(${c.map((v) => Math.round(40 + (v - 40) * k)).join(',')})`;
}

export function createMapsPanel(app) {
  const D = app.DATA;
  const M = () => app.m;
  const peek = (a) => M().peek(a);
  const tables = D.tables.tables;
  let mapT = tableByAddr(D, '80B1'), curveT = tableByAddr(D, '867C');

  const mapSel = h('select', tables.filter((t) => t.kind === 'map').map((t) => h('option', { value: t.addr }, `${t.addr} ${t.name} (${t.rows}x${t.cols})`)));
  const curveSel = h('select', tables.filter((t) => t.kind !== 'map').map((t) => h('option', { value: t.addr }, `${t.addr} ${t.name} (${t.kind}, ${t.cols} pts) - ${t.category}`)));
  mapSel.value = mapT.addr; curveSel.value = curveT.addr;
  mapSel.addEventListener('change', () => { mapT = tableByAddr(D, mapSel.value); describe(); });
  curveSel.addEventListener('change', () => { curveT = tableByAddr(D, curveSel.value); describe(); });
  const fm = h('div.btns', FEATURED_MAPS.map((a) => h('button.sm', { title: tableByAddr(D, a)?.name, on: { click: () => { mapSel.value = a; mapT = tableByAddr(D, a); describe(); } } }, a)));
  const fc = h('div.btns', FEATURED_CURVES.map((a) => h('button.sm', { title: tableByAddr(D, a)?.name, on: { click: () => { curveSel.value = a; curveT = tableByAddr(D, a); describe(); } } }, a)));
  const mapCv = h('canvas.mapcv'), curveCv = h('canvas.curvecv');
  const mapInfo = h('div.tinfo'), curveInfo = h('div.tinfo');
  const mapLive = h('div.live2'), curveLive = h('div.live2');

  const infoOf = (t) => [
    h('div', h('b', `${t.addr} ${t.name}`), ' ', tag(t.confidence || '-', confClass(t.confidence)), t.signed ? tag('signed', 't-shown') : null),
    h('div.hint', `${t.category}; out: ${t.output_ram || '-'}; units ${t.units || '-'}: ${t.scale_formula || ''}`),
    t.note ? h('div.hint', t.note) : null,
    h('div.hint', `consumer ${t.consumer_addr || '-'}; routine ${t.routine}${t.jeep_analogue ? '; Jeep ' + t.jeep_analogue : ''}`)];
  function describe() { fill(mapInfo, ...infoOf(mapT)); fill(curveInfo, ...infoOf(curveT)); }
  describe();

  function drawMap() {
    const tuningId = mapT.addr === '844F' ? '83B3' : mapT.addr;
    const t = app.calibration.tables.has(tuningId) ?
      { ...mapT, values: app.calibration.table(tuningId, 'applied').values } : mapT;
    const W = Math.max(320, mapCv.clientWidth || 600);
    const left = 92, top = 6, bottom = 44;
    const cw = (W - left - 8) / t.cols, ch = Math.max(10, Math.min(15, 194 / t.rows));
    const H = top + ch * t.rows + bottom;
    const ctx = fitCanvas(mapCv, W, H);
    ctx.fillStyle = cssVar('--scope-bg', '#0b0f14'); ctx.fillRect(0, 0, W, H);
    const vals = t.values.flat().map((x) => (t.signed ? x : x & 255));
    const lo = Math.min(...vals), hi = Math.max(...vals), amax = Math.max(1, ...vals.map(Math.abs));
    ctx.font = `${Math.min(11, ch - 2)}px ui-monospace, Consolas, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
      const v = t.signed ? t.values[r][c] : t.values[r][c] & 255;
      ctx.fillStyle = t.signed ? diverge(v / amax) : heat(hi > lo ? (v - lo) / (hi - lo) : 0.5);
      const x = left + c * cw, y = top + r * ch;
      ctx.fillRect(x, y, cw - 1, ch - 1);
      ctx.fillStyle = (t.signed ? Math.abs(v / amax) > 0.6 : (v - lo) / (hi - lo || 1) > 0.65) ? '#000' : '#fff';
      ctx.fillText(String(v), x + cw / 2, y + ch / 2);
    }
    const fg = cssVar('--dim', '#99a');
    ctx.fillStyle = fg; ctx.textAlign = 'right';
    const ya = t.y_axis, xa = t.x_axis;
    for (let r = 0; r < t.rows; r++) ctx.fillText(`${ya.eng ? ya.eng[r] : ''} | ${ya.breakpoints[r]}`, left - 4, top + r * ch + ch / 2);
    ctx.textAlign = 'center';
    for (let c = 0; c < t.cols; c++) {
      ctx.fillText(String(xa.breakpoints[c]), left + c * cw + cw / 2, top + t.rows * ch + 9);
      if (xa.eng && xa.eng[c] !== xa.breakpoints[c]) ctx.fillText(String(xa.eng[c]), left + c * cw + cw / 2, top + t.rows * ch + 21);
    }
    ctx.textAlign = 'left';
    ctx.fillText(`cols: ${xa.source_ram} [${xa.units}]`, left, H - 8);
    ctx.save(); ctx.translate(10, top + t.rows * ch / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    ctx.fillText(`rows: ${ya.units} | raw`, 0, 0); ctx.restore();
    // live marker
    const L = liveMapInputs(t, D, peek);
    if (L) {
      const x = left + (L.colPos + 0.5) * cw, y = top + (L.rowPos + 0.5) * ch;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W - 8, y); ctx.moveTo(x, top); ctx.lineTo(x, top + t.rows * ch); ctx.stroke();
      const re = axisEngAt(ya, L.rowPos), ce = axisEngAt(xa, L.colPos);
      setText(mapLive, `LIVE row A=${L.A} (${L.rowSrc}) idx ${L.ri}+${L.rf}/256 ~${re?.toFixed?.(0) ?? '-'} ${ya.units} | col B=${L.B} (${L.colSrc}) idx ${L.ci}+${L.cf}/256 ~${ce?.toFixed?.(0) ?? '-'} ${xa.units} | value ${L.value}`);
    } else setText(mapLive, 'LIVE: no live input for this map');
  }

  function drawCurve() {
    const t = curveT;
    const W = Math.max(280, curveCv.clientWidth || 600), H = 200;
    const left = 46, right = 10, top = 10, bottom = 40;
    const ctx = fitCanvas(curveCv, W, H);
    ctx.fillStyle = cssVar('--scope-bg', '#0b0f14'); ctx.fillRect(0, 0, W, H);
    ctx.font = '10px ui-monospace, Consolas, monospace';
    const dim = cssVar('--dim', '#99a'), grid = cssVar('--grid', '#223'), line = cssVar('--c-tic', '#6cf');
    if (t.kind === 'indexed') {
      const v = t.values[0];
      const bw = (W - left - right) / v.length;
      v.forEach((y, i) => { ctx.fillStyle = line; const hh = y / 255 * (H - top - bottom); ctx.fillRect(left + i * bw + 1, H - bottom - hh, bw - 2, hh); ctx.fillStyle = dim; ctx.fillText(String(y), left + i * bw + 2, H - bottom - hh - 4); ctx.fillText(String(i), left + i * bw + bw / 2 - 3, H - bottom + 12); });
      setText(curveLive, 'indexed by rpm cell (BC35)');
      return;
    }
    const sig = !!t.signed;
    const ys = Array.from({ length: 256 }, (_, a) => { const v = evalCurve(t, a); return sig ? ((v << 24) >> 24) : v; });
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const X = (a) => left + a / 255 * (W - left - right), Y = (v) => top + (hi - v) / (hi - lo) * (H - top - bottom);
    ctx.strokeStyle = grid; ctx.fillStyle = dim; ctx.lineWidth = 1;
    const xs = t.x_axis.breakpoints;
    xs.forEach((x, i) => {
      ctx.beginPath(); ctx.moveTo(X(x), top); ctx.lineTo(X(x), H - bottom); ctx.stroke();
      ctx.fillText(String(x), X(x) - 6, H - bottom + 11);
      if (t.x_axis.eng) ctx.fillText(String(t.x_axis.eng[i]), X(x) - 8, H - bottom + 23);
    });
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; ctx.beginPath(); ctx.moveTo(left, Y(v)); ctx.lineTo(W - right, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(0), 4, Y(v) + 3); }
    ctx.fillText(`x: ${t.x_axis.source_ram} [raw | ${t.x_axis.units || ''}]`, left, H - 4);
    ctx.strokeStyle = line; ctx.lineWidth = 1.5; ctx.beginPath();
    ys.forEach((v, a) => (a ? ctx.lineTo(X(a), Y(v)) : ctx.moveTo(X(a), Y(v)))); ctx.stroke();
    ctx.fillStyle = line;
    t.values[0].forEach((v, i) => { const vv = sig ? v : v & 255; ctx.beginPath(); ctx.arc(X(xs[i]), Y(vv), 2.5, 0, Math.PI * 2); ctx.fill(); });
    let li = liveCurveInput(t, peek);
    if (li && (t.addr === 'B800' || t.addr === 'B81B')) {
      // shared by coolant ($7E, range $0440.4) and air ($7D, range $0440.5): plot the sensor that uses THIS table now
      const lt = M().asic.latch, wantB800 = t.addr === 'B800';
      const coolOn = !!(lt & 0x10) === wantB800, airOn = !!(lt & 0x20) === wantB800;
      if (!coolOn && airOn) li = { a: peek(0x7D), src: '$7D air raw' };
      else li = { a: peek(0x7E), src: coolOn ? '$7E coolant raw' : '$7E coolant raw (table NOT active for either sensor)' };
    }
    if (li) {
      const y = ys[li.a];
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(li.a), Y(y), 5, 0, Math.PI * 2); ctx.stroke();
      const ve = t.values_eng && t.values_eng[0];
      let extra = '';
      if (t.addr === 'B800' || t.addr === 'B81B') {
        const ch = M().asic.latch;
        extra = `  active: coolant ${(ch & 0x10) ? 'B800' : 'B81B'}, air ${(ch & 0x20) ? 'B800' : 'B81B'}; ${y - 128} C INFERRED`;
      }
      setText(curveLive, `LIVE input ${li.src} = ${li.a} ($${hex2(li.a)}) -> ${y}${ve ? '' : ''}${extra}`);
    } else setText(curveLive, 'LIVE: input is a computed expression (not reproduced)');
  }

  const mapView = h('div.mapcol', h('div.scirow', mapSel), fm, mapInfo, mapCv, mapLive);
  const curveView = h('div.mapcol', h('div.scirow', curveSel), fc, curveInfo, curveCv, curveLive);
  function drawVisible() {
    if (!mapView.hidden && mapCv.clientWidth) drawMap();
    if (!curveView.hidden && curveCv.clientWidth) drawCurve();
  }
  const el = h('section.panel.p-maps',
    h('h2', 'MAPS ', h('span.hint', 'EE4B curves / EEB9 maps · units inferred')),
    createWorkspaces('Map views', [['maps', 'Heat maps', mapView], ['curves', 'Curves', curveView]], { onSelect: drawVisible }).el);

  return {
    el,
    slow: drawVisible,
  };
}


