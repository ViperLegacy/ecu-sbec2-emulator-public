// DISASSEMBLY / CPU panel: a listing that follows the PC live, the CPU registers and flags (changes highlighted),
// what the current instruction reads or writes and whether its branch is taken, the memory behind X / Y / SP, a stack
// scan for return addresses (call chain), an optional trace of the last instructions, and breakpoints.
// The listing is decoded from live memory (flash and RAM edits show at once). Code outside the analysis code map
// (the SCI 20 worker at 0492, a foreign image) is decoded on the fly from the PC.

import { h, setText, setClass } from './dom.js';
import { fmtMs, parseHexAddr } from './format.js';
import { DATA } from '../rom/viper_rom.js';
import { Listing, Symbols, operandInfo, branchTaken, nextAddr, backSync, h2, h4 } from './disasm.js';
import { disassemble } from '../hc11/cpu.js';

const BEFORE = 12, AFTER = 30, TRACE_N = 64;
const FLAGS = ['S', 'X', 'H', 'I', 'N', 'Z', 'V', 'C'];
const FLAG_TITLE = { S: 'STOP disable', X: 'XIRQ mask', H: 'half carry', I: 'interrupt mask', N: 'negative', Z: 'zero', V: 'overflow', C: 'carry' };

export function createDisasmPanel(app) {
  const M = () => app.m;
  let listing = null, sym = null, flashSeen = -1, builtFor = null;
  let follow = true, view = null, selected = null, dirty = true, lastKey = '';
  const bps = new Set();               // user breakpoints
  const installed = new Map();         // addr -> remover (user breakpoints and the temporary run-to target)
  let temp = null, manual = false, skip = null;
  let trace = null;                    // { ring: Uint16Array, n, restore }
  let prev = null;                     // register snapshot of the last render
  let showChg = false;

  // ---- breakpoints ---------------------------------------------------------------------------------
  function onBp(m) {
    const pc = m.cpu.pc;
    if (skip && skip.pc === pc && skip.cycles === m.cpu.cycles) { skip = null; return undefined; }
    if (temp !== null && pc === temp) return 'stop';
    if (!bps.has(pc)) return undefined;
    if (manual) return 'stop';
    if (app.paused) return undefined;  // single-stepping walks over breakpoints
    skip = { pc, cycles: m.cpu.cycles };
    app.togglePause(true);
    follow = true; dirty = true;
    app.flash(`breakpoint $${h4(pc)}${sym?.name(pc) ? ' ' + sym.name(pc) : ''}: paused`);
    return 'stop';
  }
  function syncBps() {
    const m = M(), want = new Set(bps);
    if (temp !== null) want.add(temp);
    for (const [a, off] of installed) if (!want.has(a)) { off(); installed.delete(a); }
    for (const a of want) if (!installed.has(a)) installed.set(a, m.addBreakpoint(a, onBp));
    renderBps();
  }
  function toggleBp(a) { if (bps.has(a)) bps.delete(a); else bps.add(a); syncBps(); dirty = true; }

  /** Run until `target` (or a user breakpoint); emulated-time cap. Returns true when the target was reached. */
  function runTo(target, maxMs = 3000) {
    const m = M();
    app.togglePause(true);
    temp = target; manual = true; skip = { pc: m.cpu.pc, cycles: m.cpu.cycles };
    syncBps();
    try { m.run(maxMs); } finally { temp = null; manual = false; skip = null; syncBps(); }
    follow = true; dirty = true;
    app.refreshStatus();
    return m.cpu.pc === target;
  }
  function stepInto() { app.togglePause(true); app.step('insn'); follow = true; dirty = true; render(true); }
  function stepOver() {
    const m = M(), d = disassemble((a) => m.peek(a), m.cpu.pc);
    const { next, isCall } = nextAddr(d);
    if (!isCall) return stepInto();
    if (!runTo(next)) app.flash(`step over: $${h4(next)} not reached in 3 s of PCM time (stopped at $${h4(m.cpu.pc)})`, 'bad');
    render(true);
  }
  function runToSelected() {
    if (selected === null) { app.flash('select a row first (click it)', 'bad'); return; }
    if (!runTo(selected)) app.flash(`$${h4(selected)} not reached in 3 s of PCM time (stopped at $${h4(M().cpu.pc)})`, 'bad');
    render(true);
  }

  // ---- trace ---------------------------------------------------------------------------------------
  function setTrace(on) {
    if (trace) { trace.restore(); trace = null; }
    if (!on) { dirty = true; return; }
    const cpu = M().cpu, orig = cpu.step;
    const ring = new Uint16Array(TRACE_N);
    const t = { ring, n: 0, restore: () => { cpu.step = orig; } };
    cpu.step = function () { if (!this.waiting && !this.stopped) ring[t.n++ % TRACE_N] = this.pc; return orig.call(this); };
    trace = t; dirty = true;
  }

  // ---- DOM -----------------------------------------------------------------------------------------
  const followCb = h('input', { type: 'checkbox', checked: true });
  followCb.addEventListener('change', () => { follow = followCb.checked; if (follow) view = null; dirty = true; render(true); });
  const traceCb = h('input', { type: 'checkbox' });
  traceCb.addEventListener('change', () => setTrace(traceCb.checked));
  const gotoIn = h('input', { type: 'text', placeholder: 'addr / name', spellcheck: false, style: { width: '110px' } });
  const go = () => {
    const v = gotoIn.value.trim();
    if (!v) return;
    let a = null;
    for (const [addr, name] of sym.code) if (name.toLowerCase() === v.toLowerCase()) { a = addr; break; }
    if (a === null) { try { a = parseHexAddr(v); } catch (e) { app.flash(e.message, 'bad'); return; } }
    goto(a);
  };
  gotoIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  function goto(a) { follow = false; followCb.checked = false; view = a & 0xFFFF; selected = view; dirty = true; render(true); }

  const list = h('div.dlist', { tabindex: 0 });
  list.addEventListener('wheel', (e) => { e.preventDefault(); scroll(Math.sign(e.deltaY) * 3); }, { passive: false });
  list.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { goto(parseInt(g.dataset.go, 16)); return; }
    const row = e.target.closest('.dl');
    if (!row) return;
    const a = parseInt(row.dataset.addr, 16);
    if (e.target.closest('.dg')) toggleBp(a);
    else { selected = a; dirty = true; render(true); }
  });
  list.addEventListener('dblclick', (e) => { const row = e.target.closest('.dl'); if (row) { selected = parseInt(row.dataset.addr, 16); runToSelected(); } });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); scroll(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); scroll(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); scroll(20); } else if (e.key === 'PageUp') { e.preventDefault(); scroll(-20); }
    else if (e.key === 'F9' && selected !== null) { e.preventDefault(); toggleBp(selected); }
  });
  function scroll(n) {
    const m = M();
    let a = view ?? m.cpu.pc;
    follow = false; followCb.checked = false;
    const i = listing.rowAt[a];
    if (i >= 0) a = listing.rows[Math.max(0, Math.min(listing.rows.length - 1, i + n))].addr;
    else if (n > 0) { for (let k = 0; k < n; k++) a = (a + disassemble((x) => m.peek(x), a).length) & 0xFFFF; }
    else { const b = backSync((x) => m.peek(x), a, -n); if (b.length) a = b[0]; }
    view = a; dirty = true; render(true);
  }

  const reg = {};
  const rv = (k, label, title = '') => h('div.rr', { title }, h('span.rk', label), (reg[k] = h('span.rv.mono', '-')), (reg[k + 'n'] = h('span.rn', '')));
  const flagEls = FLAGS.map((f) => h('span.flag', { title: FLAG_TITLE[f] }, f));
  const stateEl = h('span.mono'), cycEl = h('span.mono');
  const regBox = h('div.box.dreg', h('h3', 'Registers'),
    rv('a', 'A'), rv('b', 'B'), rv('d', 'D'), rv('x', 'X'), rv('y', 'Y'), rv('sp', 'SP'), rv('pc', 'PC'),
    h('div.rr', h('span.rk', 'CCR'), (reg.ccr = h('span.rv.mono', '-')), h('span.flags', flagEls)),
    h('div.rr', h('span.rk', 'state'), stateEl), h('div.rr', h('span.rk', 'cycles'), cycEl));
  const curBox = h('div.box.dcur', h('h3', 'Current instruction'), (reg.cur = h('div.mono.dcurtext')), (reg.curInfo = h('div.dinfo')));
  const ptrBox = h('div.box.dptr', h('h3', 'Pointers'), (reg.ptr = h('div')));
  const stkBox = h('div.box.dstk', h('h3', 'Stack ', h('span.hint', 'return addresses found after a JSR / BSR')), (reg.calls = h('div.dcalls')), (reg.stk = h('div.dstkbytes.mono')));
  const trcBox = h('div.box.dtrc', { hidden: true }, h('h3', `Trace (last ${TRACE_N} instructions, newest last)`), (reg.trc = h('div.mono.dtrclist')));
  const bpList = h('span.dbps');
  const srcEl = h('span.hint');

  const el = h('section.panel.p-disasm',
    h('h2', 'DISASSEMBLY / CPU'),
    h('div.scirow.wrap',
      h('label.chk', followCb, ' follow PC'),
      gotoIn, h('button.sm', { on: { click: go } }, 'Go'), h('button.sm', { title: 'show the PC again', on: { click: () => { follow = true; followCb.checked = true; view = null; dirty = true; render(true); } } }, 'PC'),
      h('span.sep'),
      h('button.sm', { title: 'execute one instruction (pauses)', on: { click: stepInto } }, 'Step'),
      h('button.sm', { title: 'run a JSR / BSR to its return (pauses)', on: { click: stepOver } }, 'Step over'),
      h('button.sm', { title: 'run until the selected row (or double-click a row)', on: { click: runToSelected } }, 'Run to selected'),
      h('button.sm', { title: 'pause / run the emulation (Space)', on: { click: () => { app.togglePause(); render(true); } } }, 'Run / Pause'),
      h('span.sep'),
      h('label.chk', { title: 'record the last instructions executed (costs some speed)' }, traceCb, ' trace'),
      srcEl),
    h('div.scirow.wrap', h('span.hint', 'breakpoints (click the gutter, or F9 on the selected row):'), bpList,
      h('button.sm', { on: { click: () => { bps.clear(); syncBps(); dirty = true; } } }, 'clear all'),
      h('span.hint', ' A breakpoint pauses the emulation when the PC reaches it. One inside the idle wait loop turns the idle skip off while set (slower).')),
    h('div.dcols', list, h('div.dside', regBox, curBox, ptrBox, stkBox, trcBox)));

  function renderBps() {
    bpList.replaceChildren(...(bps.size ? [...bps].sort((a, b) => a - b).map((a) => h('span.bpchip',
      h('span.go', { on: { click: () => goto(a) }, title: sym?.name(a) ?? '' }, '$' + h4(a)),
      h('button.sm.x', { title: 'remove', on: { click: () => toggleBp(a) } }, 'x'))) : [h('span.hint', 'none')]));
  }

  // ---- rendering -----------------------------------------------------------------------------------
  function ensureListing() {
    const m = M();
    if (listing && builtFor === m && flashSeen === m.flash.writes) return;
    sym = new Symbols(DATA, { generic: app.generic });
    listing = new Listing((a) => m.peek(a), app.generic ? null : DATA.codemap, sym);
    builtFor = m; flashSeen = m.flash.writes; dirty = true;
    setText(srcEl, app.generic ? 'foreign image: linear sweep, no names' : `${listing.rows.length} rows from the analysis code map`);
  }

  const goSpan = (a, text) => h('span.go', { 'data-go': h4(a), title: `go to $${h4(a)}` }, text);
  function comment(d, isPc, m) {
    const parts = [];
    if (d.kind === 'code') {
      const o = operandInfo(d, m.cpu);
      if (!isPc && o.ea !== null && !/,(X|Y)/.test(d.text)) { const n = sym.name(o.ea); if (n) parts.push(n); }
      if (o.target !== null && !/,(X|Y)/.test(d.text)) { const n = sym.label(o.target); parts.push(goSpan(o.target, n ? `-> ${n}` : `-> $${h4(o.target)}`)); }
      if (isPc) {
        if (o.ea !== null) {
          const v = o.size === 2 ? m.peek16(o.ea) : m.peek(o.ea);
          parts.push(`[$${h4(o.ea)}]=${o.size === 2 ? h4(v) : h2(v)}${sym.name(o.ea) ? ' ' + sym.name(o.ea) : ''}`);
        }
        const bt = branchTaken(d, m.cpu, (a) => m.peek(a));
        if (bt !== null && o.mnem !== 'BRA' && o.mnem !== 'BSR') parts.push(h('b', { class: bt ? 'ok' : 'dim' }, bt ? 'taken' : 'not taken'));
      }
    } else if (d.target !== null) { const n = sym.label(d.target); parts.push(goSpan(d.target, n ? `-> ${n}` : `-> $${h4(d.target)}`)); }
    const out = [];
    parts.forEach((p, i) => { if (i) out.push('  '); out.push(p); });
    return out;
  }

  function renderList(m) {
    const pc = m.cpu.pc;
    const at = follow || view === null ? pc : view;
    const w = listing.window(at, BEFORE, AFTER);
    const hot = new Set();
    if (trace) for (let k = 0; k < Math.min(trace.n, TRACE_N); k++) hot.add(trace.ring[k]);
    const nodes = [];
    for (const d of w.rows) {
      const lab = sym.label(d.addr);
      if (lab) nodes.push(h('div.dlab', { title: sym.routine.get(d.addr)?.role ?? '' }, lab + ':'));
      const isPc = d.addr === pc;
      const cls = 'div.dl' + (isPc ? '.pc' : '') + (bps.has(d.addr) ? '.bp' : '') + (d.addr === selected ? '.sel' : '') +
        (d.kind === 'data' ? '.data' : '') + (hot.has(d.addr) && !isPc ? '.hot' : '');
      nodes.push(h(cls, { 'data-addr': h4(d.addr) },
        h('span.dg', { title: 'toggle breakpoint' }, isPc ? '>' : ''),
        h('span.da', h4(d.addr)),
        h('span.db', d.bytes.slice(0, 5).map(h2).join(' ') + (d.bytes.length > 5 ? '..' : '')),
        h('span.dt', d.text.replace('  ; illegal', '')),
        h('span.dc', comment(d, isPc, m))));
    }
    if (w.dynamic) nodes.unshift(h('div.dnote', `$${h4(at)} is outside the code map: decoded on the fly from here`));
    list.replaceChildren(...nodes);
  }

  function regCell(k, v, digits, extra = '') {
    setText(reg[k], digits === 2 ? h2(v) : h4(v));
    setText(reg[k + 'n'], extra);
    setClass(reg[k].parentNode, 'chg', showChg && prev !== null && prev[k] !== v);
  }

  function renderRegs(m) {
    const c = m.cpu, d = (c.a << 8) | c.b;
    showChg = app.paused;                    // while running everything changes on every refresh: highlight only when stepping
    const cur = { a: c.a, b: c.b, d, x: c.x, y: c.y, sp: c.sp, pc: c.pc, ccr: c.ccr };
    const nm = (a) => { const n = sym.name(a); return n ? n : sym.region(a); };
    regCell('a', c.a, 2, `${c.a} ${((c.a << 24) >> 24) < 0 ? '(' + ((c.a << 24) >> 24) + ')' : ''}`);
    regCell('b', c.b, 2, `${c.b} ${((c.b << 24) >> 24) < 0 ? '(' + ((c.b << 24) >> 24) + ')' : ''}`);
    regCell('d', d, 4, String(d));
    regCell('x', c.x, 4, nm(c.x)); regCell('y', c.y, 4, nm(c.y));
    regCell('sp', c.sp, 4, `${0x1FF - c.sp} bytes used`);
    regCell('pc', c.pc, 4, sym.name(c.pc) ?? containing(c.pc) ?? '');
    setText(reg.ccr, h2(c.ccr));
    setClass(reg.ccr.parentNode, 'chg', showChg && prev !== null && prev.ccr !== c.ccr);
    FLAGS.forEach((f, i) => { setClass(flagEls[i], 'on', !!(c.ccr & (0x80 >> i))); setClass(flagEls[i], 'chg', showChg && prev !== null && !!((prev.ccr ^ c.ccr) & (0x80 >> i))); });
    setText(stateEl, c.stopped ? 'STOP' : c.waiting ? 'WAI' : app.paused ? 'paused' : 'running');
    setText(cycEl, `${c.cycles}  (${fmtMs(m.ms)})`);
    prev = cur;

    // current instruction
    const di = disassemble((a) => m.peek(a), c.pc);
    setText(reg.cur, `$${h4(c.pc)}  ${di.bytes.map(h2).join(' ')}  ${di.text}`);
    const o = operandInfo(di, c), info = [];
    if (o.ea !== null) {
      const v = o.size === 2 ? m.peek16(o.ea) : m.peek(o.ea);
      info.push(h('div', `operand $${h4(o.ea)} (${sym.region(o.ea)}${sym.name(o.ea) ? ', ' + sym.name(o.ea) : ''}) = $${o.size === 2 ? h4(v) : h2(v)}${o.mask !== null ? `, mask $${h2(o.mask)}` : ''}`));
    }
    if (o.imm !== null) info.push(h('div', `immediate $${o.size === 2 ? h4(o.imm) : h2(o.imm)}`));
    const bt = branchTaken(di, c, (a) => m.peek(a));
    if (o.target !== null) {
      const r = sym.routine.get(o.target);
      info.push(h('div', `${bt === null ? 'goes to' : bt ? 'branch TAKEN to' : 'not taken; target'} `, goSpan(o.target, `$${h4(o.target)} ${sym.label(o.target) ?? ''}`), r ? h('div.hint', r.role) : null));
    }
    if (o.mnem === 'RTS') { const r = m.peek16((c.sp + 1) & 0xFFFF); info.push(h('div', 'returns to ', goSpan(r, `$${h4(r)} ${containing(r) ?? ''}`))); }
    if (o.mnem === 'RTI') { const r = m.peek16((c.sp + 8) & 0xFFFF); info.push(h('div', 'returns from the interrupt to ', goSpan(r, `$${h4(r)} ${containing(r) ?? ''}`))); }
    reg.curInfo.replaceChildren(...info);

    // pointers
    const ptr = (label, a) => {
      const bytes = []; for (let i = 0; i < 8; i++) bytes.push(h2(m.peek((a + i) & 0xFFFF)));
      return h('div.dp', h('span.rk', label), h('span.mono', a >= 0x8000 ? goSpan(a, '$' + h4(a)) : '$' + h4(a)), h('span.hint', ` ${sym.region(a)}${sym.name(a) && sym.name(a) !== sym.region(a) ? ' ' + sym.name(a) : ''}`), h('div.mono.dpb', bytes.join(' ')));
    };
    reg.ptr.replaceChildren(ptr('X', c.x), ptr('Y', c.y), ptr('SP+1', (c.sp + 1) & 0xFFFF));

    // stack: bytes SP+1 .. and return addresses (a word right after a JSR / BSR in the listing)
    const top = Math.min(0x1FF, c.sp + 32), calls = [], cells = [];
    for (let a = c.sp + 1; a <= top; a++) cells.push(h('span', { title: `$${h4(a)}` }, h2(m.peek(a))));
    for (let a = c.sp + 1; a < top; a++) {
      const w = m.peek16(a);
      if (w < 0x8000 || w > 0xFFFF) continue;
      const i = listing.rowAt[(w - 1) & 0xFFFF];
      if (i < 0) continue;
      const r = listing.rows[i];
      if (r.kind !== 'code' || r.addr + r.len !== w) continue;
      const mn = disassemble((x) => m.peek(x), r.addr).text.split(' ')[0];
      if (mn !== 'JSR' && mn !== 'BSR') continue;
      calls.push(h('div', h('span.hint', `SP+${a - c.sp} `), goSpan(w, `$${h4(w)}`), ` in ${containing(w) ?? '?'}`));
      a++;
    }
    reg.calls.replaceChildren(...(calls.length ? calls : [h('div.hint', 'no return address on the stack')]));
    reg.stk.replaceChildren(...cells);

    // trace
    trcBox.hidden = !trace;
    if (trace) {
      const n = Math.min(trace.n, TRACE_N), rows = [];
      for (let k = trace.n - n; k < trace.n; k++) {
        const a = trace.ring[k % TRACE_N];
        rows.push(h('div', goSpan(a, h4(a)), '  ', disassemble((x) => m.peek(x), a).text));
      }
      reg.trc.replaceChildren(...rows);
    }
  }

  // nearest routine / sub_ / VEC_ label at or before a (the function an address belongs to)
  let entries = null;
  function containing(a) {
    if (!entries) {
      entries = [...sym.code.entries()].filter(([, n]) => !/^(loc|dat|tbl)_/.test(n)).sort((x, y) => x[0] - y[0]);
    }
    let lo = 0, hi = entries.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (entries[mid][0] <= a) { best = entries[mid]; lo = mid + 1; } else hi = mid - 1; }
    if (!best) return null;
    return best[0] === a ? best[1] : `${best[1]}+$${(a - best[0]).toString(16).toUpperCase()}`;
  }

  function render(force = false) {
    const m = M();
    ensureListing();
    const key = `${m.cpu.pc}:${m.cpu.cycles}:${view}:${follow}:${selected}:${bps.size}`;
    if (!force && !dirty && key === lastKey) return;
    lastKey = key; dirty = false;
    renderList(m);
    renderRegs(m);
  }

  return {
    el,
    attach(m) {
      installed.clear();                       // a rebuilt machine has no breakpoints yet
      prev = null; listing = null; entries = null; builtFor = null; skip = null;
      if (trace) { trace = null; setTrace(true); }
      ensureListing();
      syncBps();
    },
    slow() { if (!el.hidden) render(); },
    /** for tests and the console: the panel's view state */
    debug: () => ({ follow, view, selected, bps: [...bps], trace: !!trace }),
  };
}
