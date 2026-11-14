// SCI SCAN TOOL panel: hex console on the diagnostic channel (R8/T8 = 0), command list from sci_commands.json with
// reply format and danger flags (unsafe commands disabled unless the "unsafe" switch is on), echo + reply display
// and decoding (part number, codes with names, status word, 14 nn with RAM name, 22 words, 15 reads).

import { h, fill, tag, setText } from './dom.js';
import { stageWorkerRequests, verifyWorkerRequests, programByteRequests, exampleEdit, workerHeader, FLASH_WORKER_T0 } from '../machine/flash_worker.js';
import { hex2, hexBytes, parseHexBytes } from './format.js';
import { buildSciIndex, decodeReply, findUnsafe, nextParserStates, PARSER_IDLE, PARSER_UNKNOWN, STREAM_CMDS, CAR_VECTORS } from './sci_decode.js';

const MAX_HISTORY = 200;     // finished transactions kept
const MAX_BYTES = 4096;      // reply bytes kept per transaction (streams run forever)

export function createSciPanel(app) {
  const index = buildSciIndex(app.DATA);
  const M = () => app.m;
  let unsafe = false;
  let cur = null;                // current transaction
  const queue = [];              // pending {req, display, expect}
  const history = [];
  // Possible PCM parser states after everything already queued (high-speed mode, owed argument bytes). The gate
  // checks a new request from all of them, so a short request ("14") or a high-speed session ("12 ... FE") cannot
  // turn the next request's bytes into an unsafe command.
  let parser = [PARSER_IDLE];
  let off = null;

  const input = h('input.hex.sciin', { type: 'text', placeholder: 'hex bytes, e.g. 16 80', spellcheck: false });
  const unsafeCb = h('input', { type: 'checkbox' });
  const cmdSel = h('select.cmdsel');
  const selSel = h('select.selsel');
  const info = h('div.cmdinfo');
  const out = h('div.console');
  const live = h('div.livestream', h('span.hint', 'no stream'));
  const sel14 = h('select', { title: '14 nn selector (D9D6 table)' },
    Array.from(index.sel14.values()).map((s) => h('option', { value: s.sel }, `${s.sel}  ${s.kind === 'function' ? 'fn ' + s.source_addr : '$' + s.source_addr}  ${s.meaning.slice(0, 40)}`)));

  function fillCmds() {
    fill(cmdSel, h('option', { value: '' }, 'command...'),
      index.cmds.map((c) => h('option', { value: c.hex, disabled: c.unsafe && !unsafe }, `${c.hex}  ${c.name}${c.unsafe ? '  [UNSAFE]' : ''}`)));
  }
  function showCmd(c) {
    if (!c) { fill(info, ); fill(selSel, ); selSel.style.display = 'none'; return; }
    fill(info, 
      h('div', h('b', `${c.hex} ${c.name}`), ` request ${c.request.join(' ')}`, c.unsafe ? tag('UNSAFE', 'c-lo') : null),
      h('div.hint', 'reply: ' + c.reply),
      c.gates && c.gates !== 'none' ? h('div.hint', 'gates: ' + c.gates) : null,
      c.danger ? h('div.danger', 'DANGER: ' + c.danger) : null,
      c.groundTruth ? h('div.hint', 'car: ' + c.groundTruth) : null);
    if (c.selectors.length && c.args >= 1) {
      selSel.style.display = '';
      fill(selSel, h('option', { value: '' }, 'selector...'),
        c.selectors.map((s) => h('option', { value: s.sel }, `${s.sel}  ${s.source_addr ? '$' + s.source_addr + ' ' : ''}${String(s.meaning).slice(0, 50)}`)));
    } else { selSel.style.display = 'none'; fill(selSel, ); }
  }
  cmdSel.addEventListener('change', () => {
    const c = index.byCmd.get(parseInt(cmdSel.value, 16));
    showCmd(c);
    if (c) input.value = c.request.map((t) => (/^[0-9A-F]{2}$/i.test(t) ? t.toUpperCase() : '')).join(' ').trim() + (c.args ? ' ' : '');
  });
  selSel.addEventListener('change', () => { if (selSel.value) input.value = `${cmdSel.value} ${selSel.value}`; });
  unsafeCb.addEventListener('change', () => { unsafe = unsafeCb.checked; fillCmds(); });

  function send(req, { display = null, expect = null, decodeReq = null, expectLabel = null } = {}) {
    if (!req.length) return;
    // The PCM takes the byte after a complete command (its argument bytes included) as a new command, so a typed
    // "10 13 01" would run 13 01: check every command position, not just the first byte.
    const c = findUnsafe(index, req, parser);
    if (c && !unsafe) { app.flash(`${c.hex} ${c.name} is UNSAFE here (the PCM may be in high-speed mode or still owed argument bytes): enable the unsafe switch first`, 'bad'); return; }
    // an unsafe command (monitor mode 1B, 1D F4 40, ...) leaves the parser in a state the gate does not model
    parser = c ? PARSER_UNKNOWN : nextParserStates(index, parser, req);
    queue.push({ req, display: display || hexBytes(req), expect, expectLabel, decodeReq: decodeReq || req });
    if (!cur || cur.done) next();
  }
  function next() {
    const q = queue.shift();
    if (!q) return;
    if (cur && !cur.done) finish(cur);
    const tr = { ...q, bytes: [], t0: M().ms, last: M().ms, done: false, stream: STREAM_CMDS.has(q.req[0]) };
    tr.el = h('div.tr', h('div.req', `-> ${tr.display}`), (tr.rx = h('div.rx', '<- ')), (tr.dec = h('div.dec')));
    out.appendChild(tr.el);
    while (out.children.length > 60) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
    cur = tr; history.push(tr);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    M().sciSend(q.req);
  }
  function render(tr) {
    const n = tr.decodeReq.length;
    const bytes = tr.bytes;
    const echo = tr.decodeReq[0] === 0x17 && tr.req.length > 1 ? '' : hexBytes(bytes.slice(0, n));
    const rest = tr.decodeReq[0] === 0x17 && tr.req.length > 1 ? hexBytes(bytes) : hexBytes(bytes.slice(n));
    fill(tr.rx, '<- ', h('span.echo', echo), echo && rest ? ' | ' : '', h('span.reply', rest.length > 300 ? '...' + rest.slice(-300) : rest));
    const d = decodeReply(index, tr.decodeReq, tr.decodeReq[0] === 0x17 && tr.req.length > 1 ? [0x17, ...bytes.filter((b) => b !== 0x17)] : bytes,
      { romByte: (a) => M().romByte(a) });
    const lines = [h('b', d.title), ...d.lines.map((l) => h('div', l))];
    if (tr.expect && tr.done) {
      const ok = tr.expect.length === bytes.length && tr.expect.every((b, i) => b === bytes[i]);
      lines.push(h('div', { class: ok ? 'ok' : 'bad' }, tr.expectLabel ? (ok ? 'as expected' : `expected ${hexBytes(tr.expect)}`) : ok ? `MATCHES car: ${hexBytes(tr.expect)}` : `car expects ${hexBytes(tr.expect)}`));
    }
    fill(tr.dec, ...lines);
    if (tr.stream) {
      const v = d.value || {};
      fill(live, h('div.big', v.latest === null || v.latest === undefined ? '-' : (tr.req[0] === 0x22 ? `$${v.latest.toString(16).toUpperCase().padStart(4, '0')}` : `$${hex2(v.latest)}`)),
        h('div', `${tr.display}  ${d.lines[0] || ''}`), h('div.hint', d.lines[1] || ''));
    }
    return d;
  }
  function finish(tr) { tr.done = true; render(tr); out.scrollTop = out.scrollHeight; }

  function attach(m) {
    if (off) off();
    cur = null; queue.length = 0; parser = [PARSER_IDLE];
    off = m.onDiagTx((byte, e) => {
      if (!cur || cur.done) {
        cur = { req: [], decodeReq: [], display: '(unsolicited)', bytes: [], t0: e.ms, last: e.ms, done: false, stream: false };
        cur.el = h('div.tr', h('div.req', '(unsolicited bytes)'), (cur.rx = h('div.rx')), (cur.dec = h('div.dec')));
        out.appendChild(cur.el);
        while (out.children.length > 60) out.firstChild.remove();
      }
      cur.bytes.push(byte); cur.last = e.ms; cur.dirty = true;
      // keep the echo + the latest bytes of an endless stream (decoders use the tail: latest sample / word)
      if (cur.bytes.length > MAX_BYTES) {
        const n = cur.decodeReq.length, drop = cur.bytes.length - MAX_BYTES;
        cur.bytes.splice(n, drop + ((drop & 1) && cur.req[0] === 0x22 ? 1 : 0));
        cur.dropped = (cur.dropped || 0) + drop;
      }
    });
  }

  // Flash-write worker example (machine/flash_worker.js, ../FLASH_WRITE_WORKER.txt): stage the 39-byte worker with
  // 1E, read it back with 15, then per byte stage target + data, commit with 20 and read the cell back.
  function flashExample() {
    if (!unsafe) { app.flash('the flash-write example sends 1E and 20: enable the unsafe switch first', 'bad'); return; }
    if (M().generic) { app.flash('the example is for the 04763555 firmware', 'bad'); return; }
    let patches;
    try { patches = exampleEdit((a) => M().romByte(a)); } catch (e) { app.flash(e.message, 'bad'); return; }
    const { L, sum } = workerHeader();
    const a4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
    for (const r of stageWorkerRequests()) send(r, { expect: [...r, 0xE5], expectLabel: 'expected' });
    const want = [L, sum, ...FLASH_WORKER_T0];
    verifyWorkerRequests().forEach((r, i) => send(r, { expect: [...r, want[i]], expectLabel: 'expected' }));
    for (const p of patches) {
      const reqs = programByteRequests(p.addr, p.data);
      reqs.slice(0, 3).forEach((r) => send(r, { expect: [...r, 0xE5], expectLabel: 'expected' }));
      send(reqs[3], { expect: [...reqs[3], 0xE4], expectLabel: 'expected', display: `${hexBytes(reqs[3])}   run worker: $${a4(p.addr)} ${hex2(p.old)} -> ${hex2(p.data)} (${p.label})` });
      send(reqs[4], { expect: [...reqs[4], p.data], expectLabel: 'expected', display: `${hexBytes(reqs[4])}   read back $${a4(p.addr)}` });
    }
    app.flash(`flash-write example queued: ${patches.map((p) => `$${a4(p.addr)} ${hex2(p.old)}->${hex2(p.data)}`).join(', ')}. Key off afterwards: no code 02`);
  }

  const quick = (label, bytes, title = '', opts = {}) => h('button.sm', { title, on: { click: () => send(bytes, opts) } }, label);
  const el = h('section.panel.p-sci',
    h('h2', 'SCI SCAN TOOL ', h('span.hint', 'diagnostic channel (T8/R8 = 0); the tester sends the next byte after the PCM echo')),
    h('div.scirow', input, h('button', { on: { click: () => { try { send(parseHexBytes(input.value)); } catch (e) { app.flash(e.message, 'bad'); } } } }, 'Send'),
      h('label.chk.unsafe', { title: 'enable commands that actuate outputs or write memory (13, 18, 19, 1B-1F, 20, 21, 23)' }, unsafeCb, ' unsafe')),
    h('div.scirow', cmdSel, selSel), info,
    h('div.scirow.wrap',
      quick('16 80 part no.', [0x16, 0x80], 'identification; car: 16 80 04 76 35 55 9A', { expect: CAR_VECTORS[0].expect }),
      quick('10 codes', [0x10], 'stored codes; car (no codes): 10 FE 0E', { expect: CAR_VECTORS[1].expect }),
      quick('11 status', [0x11], 'pending codes word; car: 11 00 00', { expect: CAR_VECTORS[2].expect }),
      quick('15 20 02', [0x15, 0x20, 0x02], 'unmapped read; car: 15 20 02 02', { expect: CAR_VECTORS[3].expect }),
      [1, 2, 3, 4].map((n) => quick(`22 0${n}`, [0x22, n], ['', 'rpm16 $6E', 'PW $89', 'target idle $E7', 'PW $8B'][n])),
      h('button.sm', { title: 'clear codes: 25 consecutive 17 requests (engine stopped)', on: { click: () => send(new Array(25).fill(0x17), { display: '17 x25', decodeReq: [0x17] }) } }, '17 x25 clear'),
      h('button.sm', { title: 'run the four car vectors in sequence and compare', on: { click: () => CAR_VECTORS.forEach((v) => send(v.req, { expect: v.expect })) } }, 'car self-check')),
    h('div.scirow', h('span', '14 live read '), sel14, h('button.sm', { on: { click: () => send([0x14, parseInt(sel14.value, 16)]) } }, 'start'),
      h('button.sm', { title: 'send 00 (no-op) to end the stream', on: { click: () => send([0x00]) } }, 'stop (00)'),
      h('button.sm', { on: { click: () => fill(out, ) } }, 'clear console'),
      h('button.sm', { title: 'EMULATOR ONLY. Programs one VE cell ($DB -> $DA, both map copies) and a checksum byte through the command-20 RAM worker: 1E staging, 15 verify, 20 commit, 15 read-back. Needs the unsafe switch. See FLASH_WRITE_WORKER.txt', on: { click: flashExample } }, 'flash-write example')),
    live, out);
  fillCmds(); showCmd(null);

  return {
    el,
    attach,
    slow() {
      const m = M();
      if (cur && !cur.done) {
        const echoed = cur.bytes.length >= cur.decodeReq.length;
        const quiet = m.ms - cur.last;
        if (cur.dirty || cur.stream) { cur.dirty = false; render(cur); out.scrollTop = out.scrollHeight; }
        if (!cur.stream && !m.sci.testerBusy() && ((echoed && quiet > 150) || m.ms - cur.t0 > 4000)) { finish(cur); next(); }
        else if (cur.stream && queue.length) { finish(cur); next(); }
      } else if (queue.length) next();
    },
  };
}
