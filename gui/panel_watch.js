// RAM WATCH panel: the watch:true entries of ram_symbols.json (address, name, raw, scaled value with its INFERRED
// unit, confidence), free address entries, and a hexdump of internal RAM 0000-01FF with change highlighting.

import { h, setText, setClass, store } from './dom.js';
import { hex2, hex4, scaleWatch, parseHexAddr, confClass } from './format.js';
import { faultName, buildSciIndex } from './sci_decode.js';
import { createWorkspaces } from './workspaces.js';

const LS_CUSTOM = 'viper04763555.customWatch';

export function createWatchPanel(app) {
  const M = () => app.m;
  const index = buildSciIndex(app.DATA);
  const fname = (c) => faultName(index, c);
  const syms = app.DATA.ram_symbols.ram;
  const watch = syms.filter((r) => r.watch);
  let custom = [];
  try { custom = JSON.parse(store.get(LS_CUSTOM) || '[]').filter((c) => Number.isFinite(c.addr)); } catch { custom = []; }

  const read = (r) => {
    const a = typeof r.addr === 'number' ? r.addr : parseInt(r.addr, 16);
    if (r.size > 2) return Array.from({ length: r.size }, (_, i) => M().peek(a + i));
    return r.size === 2 ? M().peek16(a) : M().peek(a);
  };

  const rows = [];
  const mkRow = (r, removable) => {
    const cells = { raw: h('td.mono'), sc: h('td.mono.r'), unit: h('td.u'), tg: h('td.t') };
    const sym = typeof r.addr === 'number' ? syms.find((s) => parseInt(s.addr, 16) === r.addr) : null;
    const name = r.name || (sym ? sym.name : '(free)');
    const conf = r.confidence || (sym ? sym.confidence : '');
    const tr = h('tr', { title: (r.scale || sym?.scale || '') + (r.evidence ? '\n' + r.evidence : '') },
      h('td.mono', '$' + (typeof r.addr === 'number' ? hex4(r.addr) : r.addr)), h('td.nm', name), cells.raw, cells.sc, cells.unit, cells.tg,
      h('td', h('span.tag.' + confClass(conf), conf || '-')),
      h('td', removable ? h('button.x', { title: 'remove', on: { click: () => { custom = custom.filter((c) => c !== r); saveCustom(); build(); } } }, 'x') : ''));
    const entry = { r: { ...r, name, addr: typeof r.addr === 'number' ? hex4(r.addr) : r.addr, size: r.size }, tr, cells, prev: null, chgAt: 0 };
    rows.push(entry);
    return tr;
  };
  const tbody = h('tbody');
  function build() {
    rows.length = 0;
    tbody.replaceChildren(...custom.map((c) => mkRow(c, true)), ...watch.map((w) => mkRow(w, false)));
  }
  const saveCustom = () => store.set(LS_CUSTOM, JSON.stringify(custom));
  const addrIn = h('input.hex', { type: 'text', placeholder: 'addr e.g. 0151', style: { width: '90px' }, spellcheck: false });
  const sizeSel = h('select', h('option', { value: 1 }, '8-bit'), h('option', { value: 2 }, '16-bit'));
  const addBtn = h('button.sm', { on: { click: () => {
    try {
      const a = parseHexAddr(addrIn.value);
      custom.unshift({ addr: a, size: Number(sizeSel.value) }); saveCustom(); build(); addrIn.value = '';
    } catch (e) { app.flash(e.message, 'bad'); }
  } } }, 'add watch');
  addrIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
  const filter = h('input', { type: 'search', placeholder: 'filter name/addr', style: { width: '140px' } });
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const e of rows) e.tr.style.display = !q || e.r.name.toLowerCase().includes(q) || e.r.addr.toLowerCase().includes(q) ? '' : 'none';
  });

  // hexdump
  const hexCells = [];
  const dump = h('div.hexdump');
  for (let row = 0; row < 32; row++) {
    const line = h('div.hl', h('span.ha', hex4(row * 16) + ' '));
    for (let c = 0; c < 16; c++) {
      const a = row * 16 + c;
      const s = h('span.hb', { title: '' }, '--');
      const sym = syms.find((x) => { const xa = parseInt(x.addr, 16); return a >= xa && a < xa + (x.size || 1); });
      if (sym) s.title = `$${hex4(a)} ${sym.name}`;
      else s.title = `$${hex4(a)}`;
      if (a <= 0x43) s.classList.add('ka');
      hexCells.push({ s, prev: -1, chgAt: 0 });
      line.appendChild(s);
      if (c === 7) line.appendChild(document.createTextNode(' '));
    }
    dump.appendChild(line);
  }
  const dumpPages = [Array.from(dump.children).slice(0, 16), Array.from(dump.children).slice(16)];
  const dumpPage = h('select', { 'aria-label': 'Hex dump range' },
    h('option', { value: 0 }, '0000–00FF'), h('option', { value: 1 }, '0100–01FF'));
  const showPage = () => dumpPages.forEach((lines, index) => {
    lines.forEach(line => { line.hidden = index !== Number(dumpPage.value); });
  });
  dumpPage.addEventListener('change', showPage);
  showPage();
  const watchView = h('div',
    h('div.scirow', addrIn, sizeSel, addBtn, filter),
    h('div.watchwrap', h('table.watch', h('thead', h('tr', ['addr', 'name', 'raw', 'value', 'unit', 'scale tag', 'conf', ''].map((t) => h('th', t)))), tbody)));
  const dumpView = h('div',
    h('div.scirow', dumpPage, h('span.hint', 'Yellow marks recent changes · underline marks keep-alive RAM')), dump);
  const el = h('section.panel.p-watch',
    h('h2', 'RAM WATCH ', h('span.hint', 'scales INFERRED unless tagged; values read with peek() (no side effects)')),
    createWorkspaces('RAM views', [['watch', 'Watch symbols', watchView], ['hex', 'Hex dump', dumpView]]).el);
  build();

  return {
    el,
    slow(now) {
      for (const e of rows) {
        if (e.tr.style.display === 'none') continue;
        const v = read(e.r);
        const key = Array.isArray(v) ? v.join(',') : v;
        if (e.prev !== null && key !== e.prev) e.chgAt = now;
        e.prev = key;
        const s = scaleWatch(e.r, v, fname);
        setText(e.cells.raw, s.raw); setText(e.cells.sc, s.scaled); setText(e.cells.unit, s.unit); setText(e.cells.tg, s.tag);
        setClass(e.tr, 'chg', now - e.chgAt < 1000);
      }
      if (!dumpView.hidden) {
        const mem = M().mem;
        for (let a = 0; a < 512; a++) {
          const c = hexCells[a], v = mem[a];
          if (v !== c.prev) { if (c.prev >= 0) c.chgAt = now; c.prev = v; c.s.textContent = hex2(v); }
          setClass(c.s, 'chg', now - c.chgAt < 1000);
        }
      }
    },
    attach() { for (const c of hexCells) c.prev = -1; for (const e of rows) e.prev = null; },
  };
}
