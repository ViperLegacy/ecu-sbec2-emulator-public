import { h, fill, setText } from './dom.js';
import { liveMapInputs } from './maps.js';
import { TUNING_TABLES, tuningValue } from './calibration.js';
import { hex2 } from './format.js';

const ROWS_PER_BAND = 6;

export function createTuningPanel(app) {
  const calibration = app.calibration;
  let id = '80B1';
  let row = 3;
  let column = 2;
  let band = 0;
  let mode = 'draft';
  let markedCell = null;
  let live = null;
  const tablePicker = h('select', { 'aria-label': 'Calibration table' },
    Object.entries(TUNING_TABLES).map(([key, spec]) => h('option', { value: key }, `$${key} · ${spec.label}`)));
  const bandPicker = h('select', { 'aria-label': 'RPM band' });
  const modes = ['stock', 'draft', 'delta'].map(key => h('button', { type: 'button', on: { click: () => {
    mode = key;
    render();
  } } }, key[0].toUpperCase() + key.slice(1)));
  const grid = h('table.tune-grid', { 'aria-label': 'Calibration cells' });
  const selected = h('p.tune-position.mono');
  const summary = h('dl.tune-values', { 'aria-live': 'polite' });
  const raw = h('input#tuning-raw.mono', { type: 'number', min: 0, max: 255, step: 1, required: true });
  const rawPreview = h('output.tune-converted.mono', { for: 'tuning-raw' });
  const restore = h('button', { type: 'button', on: { click: () => stage(calibration.tables.get(id).values[row][column]) } }, 'Revert cell');
  const apply = h('button.primary', { type: 'button', on: { click: () => {
    calibration.apply(app.m);
    app.refreshStatus();
    render();
    app.flash('Draft applied to the emulated PCM');
  } } }, 'Apply to emulator');
  const activity = h('span.hint', { 'aria-live': 'polite' });
  const checksum = h('span.hint');
  const liveValue = h('span.mono');
  const scale = h('span.hint');
  const jump = h('button', { type: 'button', on: { click: () => {
    if (!live) return;
    row = live.ri;
    column = live.ci;
    band = Math.floor(row / ROWS_PER_BAND);
    render();
    grid.querySelector('[aria-pressed="true"]').focus();
  } } }, 'Go to operating cell');
  const editor = h('form.tune-editor',
    h('h3', 'Selected cell'), selected, summary,
    h('label', { for: 'tuning-raw' }, 'Draft raw count'),
    h('div.tune-input', raw, rawPreview),
    h('div.tune-actions', h('button', { type: 'submit' }, 'Stage edit'), restore));
  const el = h('section.panel.p-tuning',
    h('h2', 'Tuning'),
    h('div.tune-toolbar', tablePicker, bandPicker, h('div.module-tabs', { role: 'group', 'aria-label': 'Comparison' }, modes), scale),
    h('div.tune-layout',
      h('div.tune-table',
        h('div.tune-axis.hint', 'MAP counts →', h('span', 'Converted value / raw count')),
        grid,
        h('div.tune-live', jump, liveValue)),
      editor),
    h('div.tune-footer', apply, activity, checksum));

  function stage(value) {
    calibration.setDraft(id, row, column, value);
    mode = 'draft';
    render();
    raw.focus();
  }
  editor.addEventListener('submit', event => {
    event.preventDefault();
    if (raw.reportValidity()) stage(raw.valueAsNumber);
  });
  raw.addEventListener('input', previewInput);
  tablePicker.addEventListener('change', () => {
    id = tablePicker.value;
    band = 0;
    row = 3;
    column = 2;
    render();
  });
  bandPicker.addEventListener('change', () => {
    band = Number(bandPicker.value);
    row = band * ROWS_PER_BAND;
    render();
  });

  function previewInput() {
    setText(rawPreview, raw.validity.valid ? tuningValue(id, raw.valueAsNumber, { fullUnit: true }) : '—');
  }

  function updateOperatingPoint() {
    const table = calibration.table(id, 'applied');
    live = liveMapInputs(table, app.DATA, address => app.m.peek(address));
    if (markedCell) markedCell.classList.remove('tune-operating');
    markedCell = live ? grid.querySelector(`[data-row="${live.ri}"][data-column="${live.ci}"]`) : null;
    if (markedCell) markedCell.classList.add('tune-operating');
    jump.disabled = !live;
    setText(liveValue, live ? `Applied lookup ${tuningValue(id, live.value, { fullUnit: true })} · raw ${live.value} · MAP ${live.B}` : 'Operating point unavailable');
  }

  function render() {
    const stock = calibration.tables.get(id);
    const draft = calibration.table(id, 'draft');
    const applied = calibration.table(id, 'applied');
    const first = band * ROWS_PER_BAND;
    fill(bandPicker, Array.from({ length: Math.ceil(stock.rows / ROWS_PER_BAND) }, (_, index) => {
      const start = index * ROWS_PER_BAND;
      const end = Math.min(start + ROWS_PER_BAND - 1, stock.rows - 1);
      return h('option', { value: index }, `${stock.y_axis.eng[start]}–${stock.y_axis.eng[end]} rpm`);
    }));
    bandPicker.value = String(band);
    modes.forEach((button, index) => button.setAttribute('aria-pressed', String(['stock', 'draft', 'delta'][index] === mode)));
    setText(scale, id === '80B1' ? `° BTDC · ${TUNING_TABLES[id].scale}` : TUNING_TABLES[id].scale);
    fill(grid,
      h('thead', h('tr', h('th', { scope: 'col' }, 'RPM'), stock.x_axis.breakpoints.map(value => h('th', { scope: 'col' }, value)))),
      h('tbody', stock.values.slice(first, first + ROWS_PER_BAND).map((values, offset) => {
        const r = first + offset;
        return h('tr', h('th', { scope: 'row' }, stock.y_axis.eng[r]), values.map((value, c) => {
          const delta = draft.values[r][c] - value;
          const shown = mode === 'stock' ? value : mode === 'delta' ? delta : draft.values[r][c];
          const rawText = mode === 'delta' && shown > 0 ? '+' + shown : String(shown);
          const converted = tuningValue(id, shown, { delta: mode === 'delta' });
          const button = h('button.tune-cell', {
            type: 'button', 'data-row': r, 'data-column': c, 'aria-pressed': String(r === row && c === column),
            'aria-label': `${stock.y_axis.eng[r]} rpm, MAP ${stock.x_axis.breakpoints[c]}, ${converted}, raw ${rawText}`,
            on: { click: () => {
              row = r;
              column = c;
              render();
              grid.querySelector('[aria-pressed="true"]').focus();
            } },
          }, h('strong', converted), h('small', rawText));
          button.classList.toggle('tune-changed', delta !== 0 && mode !== 'stock');
          button.style.setProperty('--cell-strength', `${8 + Math.round(Math.abs(shown) / 9)}%`);
          return h('td', button);
        }));
      })));
    setText(selected, `${stock.y_axis.eng[row]} rpm · MAP ${stock.x_axis.breakpoints[column]}`);
    fill(summary, [['Stock', stock], ['Draft', draft], ['Applied', applied]].map(([label, table]) => {
      const value = table.values[row][column];
      return h('div', h('dt', label),
        h('dd.mono', tuningValue(id, value, { fullUnit: true }), h('small.hint', `raw ${value} · $${hex2(value)}`)));
    }));
    raw.value = String(draft.values[row][column]);
    previewInput();
    restore.disabled = draft.values[row][column] === stock.values[row][column];
    apply.disabled = !calibration.pending();
    setText(activity, `${calibration.draft.size} draft cells · ${calibration.applied.size} applied`);
    const { sum, expected } = calibration.checksum();
    setText(checksum, sum === expected ? `Checksum matches $${hex2(expected)}` :
      `Applied image checksum $${hex2(sum)} · firmware expects $${hex2(expected)}`);
    checksum.classList.toggle('tune-changed', sum !== expected);
    updateOperatingPoint();
  }

  render();
  return { el, slow() { if (!el.hidden) updateOperatingPoint(); } };
}
