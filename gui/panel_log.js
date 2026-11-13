// EVENT LOG + CPU panel: the machine's event ring buffer (filterable by type and text), CPU registers, cycle count,
// speed, ASIC / COP / EEPROM status, and machine faults (illegal opcode, COP timeout, FD04 spurious-vector loop).

import { h, setText, setClass } from './dom.js';
import { hex2, hex4, ccrStr, eventText, fmtMs } from './format.js';

const TYPES = ['inj', 'spark', 'sideTx', 'diagTx', 'diagRx', 'sideRx', 'sciTimeout', 'fc', 'fd', 'mil', 'latch', 'ais', 'smart', 'ccd',
  'eeprom', 'dtc', 'fault', 'reset', 'power', 'spiUnselected', 'initWrite'];
const DEFAULT_ON = new Set(['sideTx', 'diagTx', 'diagRx', 'sideRx', 'sciTimeout', 'fc', 'fd', 'mil', 'latch', 'eeprom', 'dtc', 'fault', 'reset', 'power', 'spiUnselected', 'initWrite', 'ccd']);
const MAX_KEEP = 4000, MAX_SHOW = 400;

export function createLogPanel(app) {
  const M = () => app.m;
  let since = 0, dropped = 0;
  let buf = [];
  let dirty = true;
  const on = new Set(DEFAULT_ON);
  const boxes = TYPES.map((t) => {
    const cb = h('input', { type: 'checkbox', checked: on.has(t) });
    cb.addEventListener('change', () => { if (cb.checked) on.add(t); else on.delete(t); dirty = true; });
    return h('label.chk.sm', cb, t);
  });
  const text = h('input', { type: 'search', placeholder: 'text filter', style: { width: '140px' } });
  text.addEventListener('input', () => { dirty = true; });
  const follow = h('input', { type: 'checkbox', checked: true });
  const list = h('div.loglist');
  const info = h('span.hint');

  // CPU
  const reg = {};
  const r = (k, label) => h('div.kv', h('span.k', label), (reg[k] = h('span.v.mono', '-')));
  const faultsEl = h('div.faults');
  let faultN = -1;
  const cpuBox = h('div.box.cpu', h('h3', 'CPU (68HC11)'),
    r('pc', 'PC'), r('op', '[PC]'), r('a', 'A / B / D'), r('x', 'X / Y'), r('sp', 'SP'), r('ccr', 'CCR'), r('st', 'state'),
    r('cyc', 'E cycles'), r('ms', 'time'), r('ratio', 'speed (achieved / model)'),
    h('h3', 'Peripherals'), r('asic', 'ASIC $0400 w / ctrl'), r('wd', 'ext. watchdog kicks'), r('cop', 'COP'), r('ee', 'EEPROM'), r('rom', 'flash writes ignored'),
    h('h3', 'Machine faults'), faultsEl);

  const el = h('section.panel.p-log',
    h('h2', 'EVENT LOG / CPU'),
    h('div.logcols',
      h('div.logmain',
        h('div.typebox', h('button.sm', { on: { click: () => { TYPES.forEach((t) => on.add(t)); boxes.forEach((b) => { b.firstChild.checked = true; }); dirty = true; } } }, 'all'),
          h('button.sm', { on: { click: () => { on.clear(); boxes.forEach((b) => { b.firstChild.checked = false; }); dirty = true; } } }, 'none'), boxes),
        h('div.scirow', text, h('label.chk', follow, ' follow'), h('button.sm', { on: { click: () => { buf = []; dirty = true; } } }, 'clear'), info),
        list),
      cpuBox));

  function pull() {
    const m = M();
    const seq = m.eventSeq;
    if (seq === since) return;
    const ev = m.events(since);
    if (ev.length && ev[0].seq > since) dropped += ev[0].seq - since;
    since = seq;
    for (const e of ev) buf.push(e);
    if (buf.length > MAX_KEEP) buf = buf.slice(-MAX_KEEP);
    dirty = true;
  }
  function render() {
    if (!dirty) return;
    dirty = false;
    const q = text.value.trim().toLowerCase();
    const sel = [];
    for (let i = buf.length - 1; i >= 0 && sel.length < MAX_SHOW; i--) {
      const e = buf[i];
      if (!on.has(e.type)) continue;
      const tx = eventText(e);
      if (q && !(e.type.toLowerCase().includes(q) || tx.toLowerCase().includes(q))) continue;
      sel.push([e, tx]);
    }
    sel.reverse();
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    list.replaceChildren(...sel.map(([e, tx]) => h('div.le.t-' + e.type, h('span.ls', String(e.seq)), h('span.lm', e.ms.toFixed(3)), h('span.lt', e.type), h('span.lx', tx))));
    if (follow.checked || atBottom) list.scrollTop = list.scrollHeight;
    setText(info, `${buf.length} kept, ${sel.length} shown${dropped ? `, ${dropped} overwritten in the ring` : ''}`);
  }
  function cpu() {
    const m = M(), c = m.cpu;
    setText(reg.pc, '$' + hex4(c.pc));
    setText(reg.op, [0, 1, 2, 3].map((i) => hex2(m.peek(c.pc + i))).join(' '));
    setText(reg.a, `${hex2(c.a)} / ${hex2(c.b)} / ${hex4((c.a << 8) | c.b)}`);
    setText(reg.x, `${hex4(c.x)} / ${hex4(c.y)}`);
    setText(reg.sp, hex4(c.sp));
    setText(reg.ccr, `${hex2(c.ccr)} ${ccrStr(c.ccr)}`);
    setText(reg.st, c.stopped ? 'STOP' : c.waiting ? 'WAI' : app.paused ? 'paused' : 'running');
    setText(reg.cyc, String(c.cycles));
    setText(reg.ms, fmtMs(m.ms));
    const w = app.perfWin;
    setText(reg.ratio, `x${w.ratio.toFixed(2)} / x${Number.isFinite(m.speedRatio()) ? m.speedRatio().toFixed(1) : '-'} (load ${(w.load * 100).toFixed(0)}%)`);
    const a = m.asic;
    setText(reg.asic, `${hex2(a.w0400)} / ${Array.from(a.ctrl).slice(0, 8).map(hex2).join(' ')}`);
    setText(reg.wd, `${a.kicks} (last ${fmtMs(a.lastKick * 1000 / m.eClock)}) - counted, not enforced`);
    setText(reg.cop, `${m.copEnabled ? 'ENABLED' : 'off'}  max service gap ${(m.cop.maxGap * 1000 / m.eClock).toFixed(1)} ms`);
    const e = m.eeprom;
    setText(reg.ee, `writes ${e.writes} blocked ${e.blocked} PPROG ${hex2(e.pprog)} BPROT ${hex2(e.bprot)}; source ${app.eepromSource}`);
    setText(reg.rom, String(m.romWrites));
    if (m.faults.length !== faultN) {
      faultN = m.faults.length;
      faultsEl.replaceChildren(...(m.faults.length ? m.faults.slice(-20).map((f) => h('div.bad', `${fmtMs(f.ms)} ${f.kind} pc=$${hex4(f.pc)} ${eventText({ ...f, kind: undefined, ms: undefined, cycle: undefined, pc: undefined })}`)) : [h('div.ok', 'none')]));
      setClass(cpuBox, 'hasfault', m.faults.length > 0);
    }
  }

  return {
    el,
    attach() { since = 0; buf = []; dirty = true; faultN = -1; dropped = 0; },
    slow() { pull(); render(); cpu(); },
  };
}
