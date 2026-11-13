// INPUTS panel: analog channels (engineering units + raw counts), discrete $0400/$0401/$0405 inputs, SPI replies,
// side-channel injection, crank/cam/VSS stimulus, machine options. Labels = MCU resource + inferred function +
// confidence (machine/inputs.js INPUT_INFO, brief sec. 4). No connector pin numbers.

import { INPUT_INFO } from '../machine/inputs.js';
import { CAM_PATTERNS, evenEdgeAngles } from '../machine/stimulus.js';
import { h, tag, setText } from './dom.js';
import { hex2, hexBytes, parseHexBytes, confClass } from './format.js';
import { camCountsToPattern, patternToCounts, edgeAnglesFromSpacing } from './gui_scenarios.js';
import { createWorkspaces } from './workspaces.js';

const evid = (t) => {
  const u = t.toUpperCase();
  return tag(t, u.startsWith('INFERRED') ? 't-inf' : u.startsWith('GUESS') ? 't-guess' : u.startsWith('ASSUMED') ? 't-ass' : 't-shown');
};
const conf = (c) => tag(c, confClass(c));

export function createInputsPanel(app) {
  const syncs = [];      // functions that copy model -> controls
  const lives = [];      // functions that refresh live readouts
  const M = () => app.m;

  /** slider + number field bound to get/set. */
  function numCtl({ min, max, step = 1, get, set, width = 70, decimals = null }) {
    const sl = h('input', { type: 'range', min, max, step });
    const nb = h('input.num', { type: 'number', min, max, step, style: { width: width + 'px' } });
    const fmt = (v) => (decimals === null ? String(v) : Number(v).toFixed(decimals));
    const apply = (v) => { v = Number(v); if (!Number.isFinite(v)) return; set(Math.max(min, Math.min(max, v))); sync(); };
    sl.addEventListener('input', () => apply(sl.value));
    nb.addEventListener('change', () => apply(nb.value));
    const sync = () => { const v = get(); sl.value = v; if (document.activeElement !== nb) nb.value = fmt(v); };
    syncs.push(sync);
    return h('span.numctl', sl, nb);
  }
  function check(label, get, set, title = '') {
    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => set(cb.checked));
    syncs.push(() => { cb.checked = !!get(); });
    return h('label.chk', { title }, cb, ' ', label);
  }
  function hexField(get, set, { width = 90, title = '' } = {}) {
    const f = h('input.hex', { type: 'text', title, style: { width: width + 'px' }, spellcheck: false });
    f.addEventListener('change', () => { try { set(parseHexBytes(f.value)); f.classList.remove('bad'); } catch { f.classList.add('bad'); } });
    syncs.push(() => { if (document.activeElement !== f) f.value = get(); });
    return f;
  }

  // ---------------------------------------------------------------------------------------------------
  // analog channels
  const analog = [
    { ch: 0, key: 'map', title: 'MAP', unit: 'counts', min: 0, max: 255, get: () => M().inputs.mapCounts, set: (v) => { M().inputs.mapCounts = v; },
      tags: ['INFERRED kPa scale unknown'], hint: 'valid 02..FC (codes 24/25); KOEO must be >= 66; GUESS sea level E0-F0',
      fw: () => `$76=${hex2(M().peek(0x76))} $C6=${hex2(M().peek(0xC6))} baro $08=${hex2(M().peek(0x08))}`, volts: true },
    { ch: 1, key: 'battery', title: 'Battery', unit: 'V', min: 6, max: 18, step: 0.05, decimals: 2, get: () => M().inputs.batteryV, set: (v) => { M().inputs.batteryV = v; },
      tags: ['INFERRED counts = V*16'], hint: '14.0 V = E0; drivers need >= C3 (12.2 V)', fw: () => `$80=${hex2(M().peek(0x80))} (${(M().peek(0x80) / 16).toFixed(2)} V)` },
    { ch: 3, key: 'tps', title: 'Throttle (TPS)', unit: 'counts', min: 0, max: 255, get: () => M().inputs.tpsCounts, set: (v) => { M().inputs.tpsCounts = v; },
      tags: ['GUESS closed ~30'], hint: 'valid 08..EF (codes 1A/1B); WOT flag when $77 > $03+7D', volts: true,
      fw: () => `$7F=${hex2(M().peek(0x7F))} $77=${hex2(M().peek(0x77))} min $03=${hex2(M().peek(0x03))} $81=${hex2(M().peek(0x81))}` },
    { ch: 4, key: 'coolant', title: 'Coolant', unit: 'degC', min: -40, max: 130, get: () => M().inputs.coolantC, set: (v) => { M().inputs.coolantC = v; },
      tags: ['INFERRED degC = x-128', 'GUESS count = inverse of the curve chosen by live $0440.4'], hint: 'B800 (bit4=1) ~-55..83 C, B81B (bit4=0) ~13..127 C; valid raw 1A..FD',
      fw: () => `$7E=${hex2(M().peek(0x7E))} $7B=${hex2(M().peek(0x7B))} (${M().peek(0x7B) - 128} C) range $0440.4=${(M().asic.latch >> 4) & 1}` },
    { ch: 5, key: 'air', title: 'Intake air', unit: 'degC', min: -40, max: 130, get: () => M().inputs.airC, set: (v) => { M().inputs.airC = v; },
      tags: ['INFERRED degC = x-128'], hint: 'as coolant, range by $0440.5; codes 39/3A outside 1A..FD',
      fw: () => `$7D=${hex2(M().peek(0x7D))} $78=${hex2(M().peek(0x78))} (${M().peek(0x78) - 128} C) range $0440.5=${(M().asic.latch >> 5) & 1}` },
    { ch: 2, key: 'o2_1', title: 'O2 sensor 1', unit: 'V', min: 0, max: 1.2, step: 0.01, decimals: 2, get: () => M().inputs.o2_1V, set: (v) => { M().inputs.o2_1V = v; },
      tags: ['INFERRED odd-cylinder bank'], hint: 'switch point 17h/18h (0.45 V); shorted if > 3E', fw: () => `$79=${hex2(M().peek(0x79))}` },
    { ch: 7, key: 'o2_2', title: 'O2 sensor 2', unit: 'V', min: 0, max: 1.2, step: 0.01, decimals: 2, get: () => M().inputs.o2_2V, set: (v) => { M().inputs.o2_2V = v; },
      tags: ['INFERRED even-cylinder bank'], hint: 'read on odd slots', fw: () => `$7A=${hex2(M().peek(0x7A))}` },
    { ch: 4, alt: true, key: 'an4alt', title: 'AN4-alt', unit: 'degC', min: -40, max: 130, get: () => M().inputs.an4AltC, set: (v) => { M().inputs.an4AltC = v; },
      tags: ['GUESS ratio model'], hint: 'used while $0440.7 = 1 (once per 128 passes); ratio of $0149/$014B -> BCCA -> $88',
      fw: () => `$0149=${hex2(M().peek(0x149))} $014B=${hex2(M().peek(0x14B))} $88=${hex2(M().peek(0x88))}` },
    { ch: 6, key: 'an6', title: 'AN6', unit: 'counts', min: 0, max: 255, get: () => M().inputs.an6Counts, set: (v) => { M().inputs.an6Counts = v; },
      tags: [], hint: 'never read by the firmware', fw: () => '' },
  ];

  function analogRow(a) {
    const info = INPUT_INFO[a.key];
    const ov = h('input', { type: 'checkbox', title: 'override with a raw ADC count' });
    const ovNum = h('input.num.hex', { type: 'text', style: { width: '36px' }, title: 'raw count (hex)' });
    const rawGet = () => (a.alt ? M().inputs.an4AltRaw : M().inputs.raw[a.ch]);
    const rawSet = (v) => { if (a.alt) M().inputs.an4AltRaw = v; else M().inputs.setRaw(a.ch, v); };
    const applyOv = () => {
      if (!ov.checked) { rawSet(null); ovNum.classList.remove('bad'); return; }
      const v = parseInt(ovNum.value, 16);
      if (!(v >= 0 && v <= 255)) { ovNum.classList.add('bad'); return; }
      ovNum.classList.remove('bad'); rawSet(v);
    };
    ov.addEventListener('change', () => { if (ov.checked && !ovNum.value) ovNum.value = hex2(M().inputs.adc(a.ch)); applyOv(); });
    ovNum.addEventListener('change', () => { ov.checked = true; applyOv(); });
    syncs.push(() => { const r = rawGet(); ov.checked = r !== null && r !== undefined; if (ov.checked && document.activeElement !== ovNum) ovNum.value = hex2(r); });
    const live = h('span.live'), fw = h('div.fw');
    lives.push(() => {
      const m = M();
      let c;
      if (a.alt) c = m.inputs.an4AltCounts();
      else if (a.ch === 4 && (m.asic.latch & 0x80)) c = m.inputs.raw[4] ?? m.inputs.coolantCounts();
      else c = m.inputs.adc(a.ch);
      setText(live, `ADC ${hex2(c)} (${c}) ${(c * 5 / 255).toFixed(2)} V`);
      setText(fw, a.fw());
    });
    return h('div.arow',
      h('div.ahead', h('b', a.title), h('span.res', info.resource), conf(info.confidence), a.tags.map(evid)),
      h('div.actl', numCtl({ min: a.min, max: a.max, step: a.step || 1, get: a.get, set: a.set, decimals: a.decimals ?? null }), h('span.unit', a.unit),
        live, h('label.ov', { title: 'raw count override' }, ov, 'raw', ovNum)),
      h('div.hint', `${info.fn}. ${a.hint}`), fw);
  }

  // ---------------------------------------------------------------------------------------------------
  // stimulus
  let rpmSet = 800, rampMs = 1000;
  const stimLive = h('div.fw');
  lives.push(() => {
    const s = M().stimulus.snapshot();
    setText(stimLive, `stimulus ${s.rpm.toFixed(0)} rpm${s.ramping ? ' (ramping)' : ''}  angle ${s.crankAngle.toFixed(0)} deg  gen slot ${s.generatorSlot}  edges ${s.counts.crankEdges}  cam ${s.counts.camPulses}  720s ${s.counts.cycles720}  VSS ${s.counts.vssPulses}`);
  });
  const crankStart = () => {
    const m = M();
    m.stimulus.setRpm(250);
    const t0 = m.ms;
    app.seq.active = { sc: { label: 'start' }, t0, i: 0, steps: [{ at: 1500, label: `ramp to ${rpmSet} rpm`, run: (mm) => mm.stimulus.setRpm(rpmSet, { rampMs }) }] };
  };
  const rampNum = h('input.num', { type: 'number', min: 0, max: 20000, step: 100, value: rampMs, style: { width: '64px' } });
  rampNum.addEventListener('change', () => { rampMs = Math.max(0, Number(rampNum.value) || 0); });
  const camSel = Array.from({ length: 10 }, (_, s) => {
    const sel = h('select.cam', { title: `IRQ falling edges in the second half of slot ${s}` }, [0, 1, 2, 3].map((n) => h('option', { value: n }, String(n))));
    sel.addEventListener('change', () => { M().stimulus.setCamPattern(camCountsToPattern(camSel.map((x) => Number(x.value)))); });
    return sel;
  });
  syncs.push(() => { const c = patternToCounts(M().stimulus.camPattern); camSel.forEach((s, i) => { s.value = c[i]; }); });
  const interNum = h('input.num', { type: 'number', min: 1, max: 71, step: 1, value: 36, style: { width: '50px' }, title: 'degrees from each cylinder edge to its intermediate edge (36 = even)' });
  interNum.addEventListener('change', () => { M().stimulus.setEdgeAngles(edgeAnglesFromSpacing(Number(interNum.value) || 36)); syncs.forEach((f) => f()); });
  const anglesTxt = h('input.hex', { type: 'text', style: { width: '100%' }, spellcheck: false, title: '20 TIC1 rising-edge angles, 0..720 deg' });
  anglesTxt.addEventListener('change', () => {
    try {
      const a = anglesTxt.value.split(/[\s,]+/).filter(Boolean).map(Number);
      if (a.length !== 20 || a.some((x) => !Number.isFinite(x))) throw new Error('need 20 numbers');
      M().stimulus.setEdgeAngles(a); anglesTxt.classList.remove('bad');
    } catch (e) { anglesTxt.classList.add('bad'); app.flash(e.message, 'bad'); }
  });
  syncs.push(() => { if (document.activeElement !== anglesTxt) anglesTxt.value = M().stimulus.edgeAngles.map((x) => +x.toFixed(1)).join(' '); });
  const pwField = (label, key, title) => {
    const f = h('input.num', { type: 'number', min: 1, max: 60, step: 1, style: { width: '46px' }, title });
    f.addEventListener('change', () => { const s = M().stimulus; s[key] = Math.max(1, Number(f.value) || 1); s.setEdgeAngles(s.edgeAngles); s.setCamPattern(s.camPattern); });
    syncs.push(() => { f.value = M().stimulus[key]; });
    return h('span', label, f);
  };

  const stim = h('div.sub',
    h('h3', 'Crank / cam / speed stimulus ', conf(INPUT_INFO.crank.confidence)),
    h('div.ahead', h('b', 'Engine speed'), h('span.res', `${INPUT_INFO.crank.resource}, 20 edges / 720 deg`), evid('GUESS wheel shape')),
    h('div.actl', numCtl({ min: 0, max: 7500, step: 10, width: 64, get: () => rpmSet, set: (v) => { rpmSet = v; } }), h('span.unit', 'rpm'), ' ramp', rampNum, 'ms'),
    h('div.btns',
      h('button', { on: { click: () => M().stimulus.setRpm(rpmSet, { rampMs }) } }, 'Run to setpoint'),
      h('button', { on: { click: () => M().stimulus.setRpm(250) } }, 'Crank 250'),
      h('button', { title: 'crank 250 rpm 1.5 s, then ramp to the setpoint', on: { click: crankStart } }, 'Crank + start'),
      h('button', { on: { click: () => M().stimulus.setRpm(0) } }, 'Stop')),
    stimLive,
    h('div.ahead', h('b', 'Cam / sync IRQ pattern'), h('span.res', INPUT_INFO.cam.resource), conf(INPUT_INFO.cam.confidence), evid('GUESS: candidate derived from sync rules, NOT measured')),
    h('div.camgrid', camSel.map((s, i) => h('label', h('span', 'slot ' + i), s))),
    h('div.btns', ['candidate', 'quick', 'none'].map((p) => h('button', { on: { click: () => { M().stimulus.setCamPattern(p); syncs.forEach((f) => f()); } } }, p)),
      h('span.hint', 'pulses in the second half of slot s (between edge 2s+1 and 2s+2)')),
    h('div.ahead', h('b', 'Crank edge spacing'), evid('GUESS')),
    h('div.actl', 'intermediate edge +', interNum, 'deg', h('button', { on: { click: () => { interNum.value = 36; M().stimulus.setEdgeAngles(evenEdgeAngles()); syncs.forEach((f) => f()); } } }, 'even 36'),
      pwField(' PA2 high', 'crankHighDeg', 'crank pulse high width, deg (GUESS)'), pwField(' IRQ low', 'camLowDeg', 'cam pulse low width, deg (GUESS)')),
    anglesTxt,
    h('div.ahead', h('b', 'Vehicle speed'), h('span.res', INPUT_INFO.vss.resource), conf('high (channel)'), evid('INFERRED 8000 pulses/mile')),
    h('div.actl', numCtl({ min: 0, max: 200, step: 1, width: 56, get: () => M().stimulus.mph, set: (v) => M().stimulus.setSpeedMph(v) }), h('span.unit', 'mph'),
      ' pulses/mile', (() => {
        const f = h('input.num', { type: 'number', min: 100, max: 100000, step: 100, style: { width: '64px' } });
        f.addEventListener('change', () => { M().stimulus.vssPulsesPerMile = Math.max(100, Number(f.value) || 8000); const s = M().stimulus; if (s.mph > 0) s.setSpeedMph(s.mph); });
        syncs.push(() => { f.value = M().stimulus.vssPulsesPerMile; });
        return f;
      })(), h('span.fw', { id: 'vssfw' })));
  lives.push(() => setText(stim.querySelector('#vssfw'), ` $84=${hex2(M().peek(0x84))} $82=${hex2(M().peek(0x82))}${hex2(M().peek(0x83))}`));

  // ---------------------------------------------------------------------------------------------------
  // discrete inputs
  const I = () => M().inputs;
  const disc = (key, label, get, set, extra = []) => {
    const info = INPUT_INFO[key] || {};
    return h('div.drow', check(label, get, set, info.fn || ''), h('span.res', info.resource || ''), info.confidence ? conf(info.confidence) : null, extra);
  };
  const nib = h('input.num', { type: 'number', min: 0, max: 15, style: { width: '42px' } });
  nib.addEventListener('change', () => { I().in0401hi = Math.max(0, Math.min(15, Number(nib.value) || 0)); });
  syncs.push(() => { nib.value = I().in0401hi; });
  const injMode = h('select', h('option', { value: 'level' }, 'level'), h('option', { value: 'latched' }, 'latched on $04 write'));
  injMode.addEventListener('change', () => { I().injectorStatusMode = injMode.value; });
  syncs.push(() => { injMode.value = I().injectorStatusMode; });

  const smartBits = [[1, 7, '$048C b7 -> $85'], [1, 6, '$048C b6 -> $85'], [3, 2, '$048E b2 (code 19)'], [3, 4, '$048E b4 (code 22)'], [3, 7, '$048E b7 (code 5C)']];
  const fdMode = h('select', ['shift', 'echo', 'value'].map((v) => h('option', { value: v }, v)));
  fdMode.addEventListener('change', () => { I().fdFeedbackMode = fdMode.value; });
  syncs.push(() => { fdMode.value = I().fdFeedbackMode; });

  const sideTxt = h('input.hex', { type: 'text', style: { width: '80px' }, value: '05', spellcheck: false });
  const sideSend = (bytes) => { M().sideChannelSend(bytes); app.flash(`side channel (R8=1) <- ${hexBytes(bytes)}`); };
  const sideBtn = (label, byte, title) => h('button.sm', { title, on: { click: () => sideSend([byte]) } }, label);

  const eclk = h('select', { title: 'E clock (ASSUMED 2 MHz). Changing it rebuilds the machine (EEPROM, keep-alive RAM and inputs kept).' },
    [[2_000_000, '2.000 MHz (assumed)'], [1_843_200, '1.8432 MHz'], [2_097_152, '2.0972 MHz'], [1_000_000, '1.000 MHz'], [4_000_000, '4.000 MHz']].map(([v, l]) => h('option', { value: v }, l)));
  eclk.addEventListener('change', () => { app.opts.eClock = Number(eclk.value); app.rebuild(); });
  syncs.push(() => { eclk.value = String(M().eClock); });

  const discrete = h('div.sub',
    h('h3', 'Discrete inputs ($0400 / $0401 / $0405 reads)'),
    disc('key', 'Key ON', () => I().key, (v) => { I().key = v; }, [h('span.hint', 'off -> F024 power-down (~5 s), on again -> jmp 944E')]),
    h('div.drow', check('Battery connected', () => I().batteryConnected, (v) => { I().batteryConnected = v; }, 'keep-alive RAM 0000-0043 survives "Power cycle"'),
      h('span.res', 'keep-alive RAM 0000-0043 at power cycle'), conf('high')),
    disc('relayFeed', 'ASD / relay feed', () => I().relayFeed, (v) => { I().relayFeed = v; }, [h('span.hint', 'drop it -> code 2C')]),
    disc('spiBusy', 'SPI busy (handshake = 1)', () => I().spiBusy, (v) => { I().spiBusy = v; }, [h('span.hint', 'forces time-outs, code 44')]),
    disc('in0400b5', '$0400.5', () => I().in0400b5, (v) => { I().in0400b5 = v; }),
    disc('in0400b7', '$0400.7', () => I().in0400b7, (v) => { I().in0400b7 = v; }),
    h('div.drow', h('span', '$0401 hi nibble ', nib), h('span.res', INPUT_INFO.in0401hi.resource), conf(INPUT_INFO.in0401hi.confidence)),
    disc('injectorStatusOk', 'Injector status OK', () => I().injectorStatusOk, (v) => { I().injectorStatusOk = v; }, [injMode]));
  const bus = h('div.sub',
    h('h3', 'SPI smart device / output driver replies'),
    h('div.drow', h('span', 'smart reply $048B..$048E '), hexField(() => hexBytes(I().smartReply), (b) => { if (b.length !== 4) throw new Error('4 bytes'); I().smartReply = b; }),
      h('span.res', INPUT_INFO.smartReply.resource), conf(INPUT_INFO.smartReply.confidence)),
    h('div.drow.wrap', smartBits.map(([bi, bit, label]) => check(label, () => (I().smartReply[bi] >> bit) & 1, (v) => { I().setSmartBit(bi, bit, v); syncs.forEach((f) => f()); }))),
    h('div.drow', check('6th byte = sum (frame accepted)', () => I().smartChecksumOk, (v) => { I().smartChecksumOk = v; })),
    h('div.drow', check('CCD message', () => I().ccdRxMessage !== null, (v) => { I().ccdRxMessage = v ? [0x21, 0, 0] : null; syncs.forEach((f) => f()); }, 'off -> $F5.5 fuel inhibit ~2 s after key-on'),
      hexField(() => (I().ccdRxMessage ? hexBytes(I().ccdRxMessage) : ''), (b) => { if (b.length !== 3) throw new Error('3 bytes'); I().ccdRxMessage = b; }, { width: 70 }),
      h('span.res', INPUT_INFO.ccdRxMessage.resource), evid('GUESS 21 00 00'), conf('low')),
    h('div.drow', h('span', '$FD feedback '), fdMode, hexField(() => hex2(I().fdFeedbackValue), (b) => { I().fdFeedbackValue = b[0] ?? 0; }, { width: 32 }),
      h('span.res', INPUT_INFO.fdFeedbackMode.resource), conf('low')),
    h('h3', 'Side-channel status injection (SCI R8 = 1)'),
    h('div.drow', sideTxt, h('button.sm', { on: { click: () => { try { sideSend(parseHexBytes(sideTxt.value)); } catch (e) { app.flash(e.message, 'bad'); } } } }, 'Send'),
      h('span.res', 'bit2 = 1 -> OR into $0115, else $0116'), conf('medium')),
    h('div.drow.wrap',
      sideBtn('$0115 b0 (code 15)', 0x05, 'injector #1 status (INFERRED)'), sideBtn('$0115 b1 (code 45)', 0x06, 'injector #5 status (INFERRED)'),
      [3, 4, 5, 6, 7].map((b) => sideBtn(`$0115 b${b}`, 0x04 | (1 << b), 'coil / cylinder-pair fault -> $EF disable mask (INFERRED)')),
      sideBtn('$0116 b6 (48)', 0x40, 'code 48'), sideBtn('$0116 b7 (49)', 0x80, 'code 49')));
  const options = h('div.sub',
    h('h3', 'Machine options'),
    h('div.drow', h('span', 'E clock '), eclk, evid('ASSUMED 2 MHz')),
    h('div.drow', check('COP watchdog', () => M().copEnabled, (v) => M().setCopEnabled(v), 'CONFIG.NOCOP unknown; off by default'), evid('GUESS: off'),
      check('idle-loop fast-forward', () => M().idleSkip, (v) => { M().idleSkip = v; }, 'skip whole 9E0E wait iterations (exact)')));

  const el = h('section.panel.p-inputs',
    h('h2', 'INPUTS ', h('span.hint', 'MCU resource / inferred function / confidence - no connector pins (unknown)')),
    createWorkspaces('Input groups', [
      ['analog', 'Engine sensors', h('div.sub', h('p.hint', '8-bit ADC · 5 V reference assumed'), h('div.analog-inputs', analog.slice(0, 5).map(analogRow)))],
      ['aux', 'Auxiliary ADC', h('div.sub', h('div.analog-inputs', analog.slice(5).map(analogRow)))],
      ['stimulus', 'Stimulus', stim],
      ['discrete', 'Discrete', discrete],
      ['bus', 'Bus signals', bus],
      ['options', 'Machine', options],
    ]).el);

  const syncAll = () => syncs.forEach((f) => f());
  return {
    el,
    attach() { syncAll(); },
    inputsChanged() { syncAll(); },
    slow() { lives.forEach((f) => f()); if (!el.contains(document.activeElement)) syncAll(); },
  };
}
