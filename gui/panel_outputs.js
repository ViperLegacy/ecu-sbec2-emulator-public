// OUTPUTS panel: injectors (four driver paths), spark frames, engine state, fuel cut, lamps/relays decoded from
// $FC/$FD/$0440, AIS stepper, tach, DTCs, and a timing scope of the last ~2 crank cycles (720 deg each).

import { FC_BITS, FD_BITS, LATCH_BITS, SLOT_PATH, SLOT_TO_CYL } from '../machine/outputs.js';
import { h, fill, tag, setText, setClass, fitCanvas, cssVar } from './dom.js';
import { hex2, hex4, bits8 } from './format.js';
import { createWorkspaces } from './workspaces.js';

const SHORT_PATH = ['side-ch T8=1', 'OC2 / PA6', 'SPI FE frame', 'ext $040E', 'side-ch T8=1', 'OC3 / PA5', 'ext $040C', 'OC4 / PA4', 'ext $040A', 'ext $0408'];
const PATH_CONF = { oc: 'high', asic: 'medium', spi: 'medium', side: 'low-medium' };

export function createOutputsPanel(app) {
  const M = () => app.m;
  const flashUntil = new Array(10).fill(0);
  const lastCount = new Array(10).fill(0);

  // ---- injectors ------------------------------------------------------------------------------------
  const injCells = SLOT_PATH.map((p, s) => {
    const pw = h('div.pw'), cnt = h('div.cnt');
    const el = h('div.inj', { title: `${p.resource} - path ${p.path} (${PATH_CONF[p.path]} confidence). Cylinder mapping INFERRED (medium).` },
      h('div.slot', 'slot ' + s), h('div.path', SHORT_PATH[s]), h('div.cyl', `cyl #${SLOT_TO_CYL[s]} `, h('span.inf', 'inferred')), pw, cnt);
    return { el, pw, cnt };
  });
  const injBox = h('div.injgrid', injCells.map((c) => c.el));

  // ---- spark / engine ---------------------------------------------------------------------------------
  const v = {};
  const kv = (k, label, title = '') => h('div.kv', { title }, h('span.k', label), (v[k] = h('span.v', '-')));
  const sparkBig = h('div.big', '-');
  const stateBig = h('div.big.state', '-');
  const sparkBox = h('div.box',
    h('h3', 'Spark advance ', tag('INFERRED 0.5 deg/count', 't-inf'), tag('medium', 'c-med')),
    sparkBig,
    kv('spRaw', 'last frame', 'side-channel byte (T8=1) at each cylinder edge (FC00); $7F while $44.0 = 0'),
    kv('spSlot', 'slot / cyl', 'slot $63 at the frame; cylinder INFERRED'),
    kv('spCount', 'frames'),
    kv('sp71', '$71 / $75 RAM'),
    h('div.hint', 'No coil output exists on the MCU: spark leaves on the 9-bit side channel to an unknown device.'));
  const engBox = h('div.box',
    h('h3', 'Engine state'),
    stateBig,
    kv('rpm', 'rpm (rpm16/8 INFERRED)'), kv('rpm16', 'rpm16 $6E'), kv('period', 'period $5E', 'ticks between cylinder edges (4 us ASSUMED)'),
    kv('slot', 'slot $63 / cyl'), kv('flags', '$4F / $44'), kv('pw', 'PW even $89 / odd $8B'), kv('crankpw', 'crank PW $8D'),
    kv('fuelcut', 'fuel cut $50'), kv('ccd', 'CCD inhibit $F5.5', 'set ~2 s after key-on without a valid CCD reply -> running PW forced to 0'),
    kv('idle', 'target idle $E7 / AIS'));

  // ---- lamps / relays ---------------------------------------------------------------------------------
  const lampRow = (src, d) => {
    const dot = h('span.dot'), val = h('span.lv');
    return { d, src, dot, val, el: h('div.lamp', { title: d.label }, dot, h('span.ln', `${src}.${d.bit}`), h('span.ll', d.label), val) };
  };
  const fcRows = FC_BITS.map((d) => lampRow('$FC', d));
  const fdRows = FD_BITS.map((d) => lampRow('$FD', d));
  const lrRows = LATCH_BITS.map((d) => lampRow('$0440', d));
  const milBig = h('div.mil', 'MIL');
  const lampsHdr = { fc: h('span.v'), fd: h('span.v'), lt: h('span.v') };
  const aisBox = h('div.box', h('h3', 'AIS stepper ', tag('high', 'c-hi')),
    kv('aisPos', 'position $05'), kv('aisTgt', 'target $010A'), kv('aisPh', 'phase $0B / SPI byte'), kv('aisSteps', 'steps decoded', 'net steps decoded from SPI phase bytes; +phase = +$05 is a GUESS'),
    h('h3', 'Tach ', tag('INFERRED $0440.1', 't-inf')), kv('tach', 'toggles / Hz'),
    h('h3', 'OC pins (PORTA readback)'), kv('ocpins', 'PA6 / PA5 / PA4'));
  const lampsBox = h('div.box.lamps',
    h('div.milrow', milBig, h('span.hint', '$FC.6, 0 = ON (INFERRED, medium); bulb check ~256 passes at key-on')),
    h('div.row3',
      h('div', h('h3', 'SPI smart-device byte $FC (61/62 frame) ', lampsHdr.fc), fcRows.map(r => r.el)),
      h('div', h('h3', 'SPI output driver $FD ', lampsHdr.fd), fdRows.map(r => r.el)),
      h('div', h('h3', 'Latch $0440 (write-only, shadow $FE) ', lampsHdr.lt), lrRows.map(r => r.el))));

  // ---- DTCs ------------------------------------------------------------------------------------------
  const dtcBox = h('div.box.dtc', h('h3', 'Fault codes ', tag('names: generic Chrysler list, unverified for Viper', 't-inf')));
  const dtcBody = h('div');
  dtcBox.appendChild(dtcBody);
  let dtcKey = '';

  // ---- scope -----------------------------------------------------------------------------------------
  const cv = h('canvas.scope');
  const scopeInfo = h('span.hint');
  const scopeBox = h('section.panel.p-scope', h('h2', 'Timing scope'), h('p.hint', scopeInfo), cv,
    h('div.hint', 'TIC1/PA2 rising edges (cylinder edge starts slot s, then intermediate edge), IRQ cam pulses (low), injector pulses per slot (commanded PW for ASIC/SPI/side paths), spark frames (raw $71 byte). Window = 2 x 120000/rpm ms.'));

  const el = h('section.panel.p-outputs', h('h2', 'OUTPUTS'),
    createWorkspaces('Output groups', [
      ['injectors', 'Injectors', h('div.box', h('h3', '10 slots, 4 driver paths ', tag('paths high', 'c-hi'), tag('cylinders INFERRED medium', 't-inf')), injBox)],
      ['engine', 'Engine & spark', h('div.row3', engBox, sparkBox, aisBox)],
      ['lamps', 'Lamps & relays', lampsBox],
      ['faults', 'Fault codes', dtcBox],
    ]).el);

  function drawScope() {
    const m = M();
    const W = cv.clientWidth;
    const rows = [['TIC1', 'tic1'], ['IRQ', 'irq'], ...Array.from({ length: 10 }, (_, s) => [`inj ${s} #${SLOT_TO_CYL[s]}`, 's' + s]), ['spark', 'spark'], ['VSS', 'vss']];
    const RH = 15, top = 4, left = 78, H = top + rows.length * RH + 18;
    const ctx = fitCanvas(cv, W, H);
    const col = { bg: cssVar('--scope-bg', '#0b0f14'), grid: cssVar('--grid', '#223'), fg: cssVar('--fg', '#ddd'), dim: cssVar('--dim', '#889'),
      tic: cssVar('--c-tic', '#6cf'), irq: cssVar('--c-irq', '#fc6'), inj: cssVar('--c-inj', '#5d8'), spark: cssVar('--c-spark', '#f66'), vss: cssVar('--c-vss', '#c9f') };
    ctx.fillStyle = col.bg; ctx.fillRect(0, 0, W, H);
    const rpm = m.stimulus.rpm;
    let winMs = rpm > 20 ? 2 * 120000 / rpm : 500;
    winMs = Math.max(20, Math.min(2500, winMs));
    const cyc = m.cycles, cPerMs = m.eClock / 1000;
    const c0 = cyc - winMs * cPerMs;
    const X = (c) => left + (c - c0) / (cyc - c0) * (W - left - 6);
    const Y = (i) => top + i * RH;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    // grid
    const stepMs = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => winMs / s <= 10) || 500;
    ctx.strokeStyle = col.grid; ctx.fillStyle = col.dim; ctx.lineWidth = 1;
    const msNow = m.ms;
    for (let t = Math.ceil((msNow - winMs) / stepMs) * stepMs; t <= msNow; t += stepMs) {
      const x = X(t * cPerMs); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, Y(rows.length)); ctx.stroke();
      ctx.fillText((t / 1000).toFixed(stepMs < 10 ? 3 : 2) + 's', x - 14, Y(rows.length) + 9);
    }
    rows.forEach(([label], i) => { ctx.fillStyle = col.dim; ctx.fillText(label, 3, Y(i) + RH / 2); ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(left, Y(i + 1) - 0.5); ctx.lineTo(W, Y(i + 1) - 0.5); ctx.stroke(); });
    const w = app.probe.window(c0);
    const square = (sig, i, color, activeLow) => {
      const y1 = Y(i) + 3, y0 = Y(i) + RH - 3;
      ctx.strokeStyle = color; ctx.beginPath();
      let lvl = sig.initial ?? (activeLow ? 1 : 0);
      ctx.moveTo(left, lvl ? y1 : y0);
      for (const e of sig.edges) { const x = X(e.c); ctx.lineTo(x, lvl ? y1 : y0); lvl = e.level; ctx.lineTo(x, lvl ? y1 : y0); }
      ctx.lineTo(W, lvl ? y1 : y0); ctx.stroke();
    };
    square(w.tic1, 0, col.tic, false);
    square(w.irq, 1, col.irq, true);
    square(w.vss, 13, col.vss, false);
    const div = m.timer.div;
    ctx.fillStyle = col.inj;
    for (const p of w.inj) {
      const x0 = X(p.c), x1 = X(p.c + p.ticks * div);
      if (x1 < left || x0 > W) continue;
      ctx.globalAlpha = p.ticks ? 0.85 : 0.35;
      ctx.fillRect(Math.max(left, x0), Y(2 + p.slot) + 3, Math.max(1.5, Math.min(W, x1) - Math.max(left, x0)), RH - 6);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col.spark; ctx.fillStyle = col.spark;
    for (const s of w.spark) {
      const x = X(s.c); if (x < left) continue;
      ctx.beginPath(); ctx.moveTo(x, Y(12) + 2); ctx.lineTo(x, Y(13) - 2); ctx.stroke();
      ctx.fillText(hex2(s.raw), x + 2, Y(12) + RH / 2);
      ctx.fillStyle = col.dim; ctx.fillText(String(s.slot), x + 2, Y(0) + 4); ctx.fillStyle = col.spark;
    }
    setText(scopeInfo, `window ${winMs.toFixed(0)} ms @ ${rpm.toFixed(0)} rpm (stimulus)  edges ${w.tic1.edges.length}  cam ${w.irq.edges.filter((e) => !e.level).length}  inj ${w.inj.length}  spark ${w.spark.length}`);
  }

  function updateFast(now) {
    const m = M();
    const inj = m.outputs.inj;
    for (let s = 0; s < 10; s++) {
      const st = inj[s];
      if (st.count !== lastCount[s]) { lastCount[s] = st.count; if (st.lastPwTicks > 0) flashUntil[s] = now + 90; }
      setClass(injCells[s].el, 'on', now < flashUntil[s]);
    }
  }

  function updateSlow(now) {
    const m = M();
    const e = m.engine();
    const o = m.outputs.snapshot();
    for (let s = 0; s < 10; s++) {
      const st = o.injectors[s];
      // a slot that stopped being issued (fuel cut, engine stopped) keeps its last PW: show it as stale after two
      // engine cycles without a pulse (at least 300 ms)
      const staleMs = Math.min(2000, Math.max(300, e.rpm > 0 ? 2 * 120000 / e.rpm : 2000));
      const stale = st.count > 0 && (m.cpu.cycles - st.lastCycle) * 1000 / m.eClock > staleMs;
      setText(injCells[s].pw, stale ? `not firing (last ${st.lastPwTicks} t)` : `${st.lastPwTicks} t  ${st.lastPwMs.toFixed(2)} ms`);
      setClass(injCells[s].el, 'stale', stale);
      setText(injCells[s].cnt, `${st.count} pulses (${st.nonzero} >0)`);
      setClass(injCells[s].el, 'zero', st.count > 0 && st.lastPwTicks === 0);
    }
    // engine state
    const stimRpm = m.stimulus.rpm;
    const lastEdge = app.probe.tic1.last();
    const quietMs = lastEdge ? (m.cycles - lastEdge.c) / m.eClock * 1000 : Infinity;
    let st;
    if (e.running) st = 'RUNNING';
    else if (e.synced && stimRpm > 0) st = 'CRANKING (synced)';
    else if (stimRpm > 0) st = 'CRANKING - no sync';
    else if (e.synced) st = quietMs > 200 ? 'STALL (no TIC1 edges)' : 'stopping';
    else st = lastEdge && quietMs < 3000 ? 'STALL / stopped' : 'stopped';
    setText(stateBig, st);
    stateBig.dataset.state = e.running ? 'run' : stimRpm > 0 ? 'crank' : 'stop';
    setText(v.rpm, e.rpm.toFixed(0));
    setText(v.rpm16, `${hex4(e.rpm16)} (${e.rpm16})`);
    setText(v.period, `${e.period} t = ${(e.period * m.tickUs() / 1000).toFixed(2)} ms`);
    setText(v.slot, `${e.slot} / #${e.cylinder ?? '-'}`);
    setText(v.flags, `sync ${e.synced ? 1 : 0} irq ${e.irqSeen ? 1 : 0} run ${e.running ? 1 : 0} map-spark ${e.sparkFromMap ? 1 : 0}`);
    const tms = (t) => (t * m.tickUs() / 1000).toFixed(2);
    setText(v.pw, `${e.pwEven} / ${e.pwOdd} t (${tms(e.pwEven)} / ${tms(e.pwOdd)} ms)`);
    setText(v.crankpw, `${e.crankPw} t (${tms(e.crankPw)} ms)`);
    const fc = [e.fuelCut.revLimit && 'REV LIMIT b0', e.fuelCut.speedLimit && 'SPEED b1', e.fuelCut.decel && 'DECEL b7'].filter(Boolean);
    setText(v.fuelcut, `${hex2(m.peek(0x50))} ${fc.join(' ') || 'none'}`);
    setClass(v.fuelcut, 'alert', fc.length > 0);
    const inh = !!(m.peek(0xF5) & 0x20);
    setText(v.ccd, inh ? 'SET - running PW = 0' : 'clear'); setClass(v.ccd, 'alert', inh);
    setText(v.idle, `${e.targetIdle.toFixed(0)} rpm / ${e.aisPosition}`);
    // spark
    const sp = o.spark;
    setText(sparkBig, sp.raw === null ? '-' : sp.raw === 0x7F ? '$7F (no map)' : `${sp.deg.toFixed(1)} deg`);
    setText(v.spRaw, sp.raw === null ? '-' : `$${hex2(sp.raw)} (${sp.raw})`);
    setText(v.spSlot, sp.slot === null ? '-' : `${sp.slot} / #${sp.cyl}`);
    setText(v.spCount, String(sp.count));
    setText(v.sp71, `${hex2(e.spark71)} / ${hex2(e.spark75)} = ${(e.spark71 / 2).toFixed(1)} deg`);
    // lamps
    setClass(milBig, 'on', o.milOn); setText(milBig, o.milOn ? 'MIL ON' : 'MIL off');
    setText(lampsHdr.fc, `${hex2(o.fc)} ${bits8(o.fc ?? 0)}  (RAM $FC ${hex2(e.fc)})`);
    setText(lampsHdr.fd, `${hex2(o.fd)} ${bits8(o.fd ?? 0)}  (RAM $FD ${hex2(e.fd)})`);
    setText(lampsHdr.lt, `${hex2(o.latch)} ${bits8(o.latch)}  (RAM $FE ${hex2(e.fe)})`);
    const upd = (rows, byte) => rows.forEach((r) => {
      const bit = !!((byte ?? 0) & (1 << r.d.bit));
      const on = r.d.activeHigh === false ? !bit : bit;
      setClass(r.dot, 'on', on); setText(r.val, bit ? '1' : '0');
    });
    upd(fcRows, o.fc); upd(fdRows, o.fd); upd(lrRows, o.latch);
    // AIS / tach
    setText(v.aisPos, String(o.ais.ramPosition)); setText(v.aisTgt, String(o.ais.ramTarget));
    setText(v.aisPh, `${o.ais.ramPhase} / ${o.ais.pattern === null ? '-' : '$' + hex2(o.ais.pattern)}`);
    setText(v.aisSteps, `${o.ais.steps} (${o.ais.bytes} bytes, ${o.ais.invalid} invalid)`);
    setText(v.tach, `${o.tach.toggles} / ${o.tach.hz.toFixed(1)} Hz`);
    setText(v.ocpins, `${o.ocPins.PA6_OC2 ? 1 : 0} / ${o.ocPins.PA5_OC3 ? 1 : 0} / ${o.ocPins.PA4_OC4 ? 1 : 0}`);
    // DTCs
    const d = m.dtcs();
    const key = JSON.stringify(d);
    if (key !== dtcKey) {
      dtcKey = key;
      fill(dtcBody, 
        h('div.dh', `stored ($0039-$0040, newest first): ${d.stored.length || 'none'}`),
        d.stored.map((f) => h('div.dtcrow', h('b', f.code), h('span', f.name), h('span.hint', `flash ${f.flash ?? '-'}`), f.condition ? h('div.hint', f.condition) : null)),
        h('div.dh', `pending ($F8/$F9): ${d.pending.length || 'none'}`),
        d.pending.map((f) => h('div.dtcrow', h('b', f.code), h('span', f.name))));
    }
  }

  return {
    el,
    scope: scopeBox,
    attach() { lastCount.fill(0); dtcKey = ''; },
    frame(now) {
      if (!el.hidden) updateFast(now);
      if (!scopeBox.hidden && cv.clientWidth) drawScope();
    },
    slow(now) { updateSlow(now); },
  };
}
