import { tableByAddr } from './maps.js';

// $800C sits between the revision byte and the next ID field in the 04763555 image.
// Keep $8005 fixed because the firmware uses it as both an ID byte and the checksum target.
const CHECKSUM_ADJUSTMENT = 0x800C;

export const TUNING_TABLES = {
  '80B1': { label: 'Base spark', copies: [0x80B1], scale: '0.5° per count (inferred)' },
  '83B3': { label: 'Fuel multiplier', copies: [0x83B3, 0x844F], scale: '1 + raw / 256' },
};

export function tuningValue(id, raw, { delta = false, fullUnit = false } = {}) {
  const sign = delta && raw > 0 ? '+' : '';
  if (id === '80B1') return sign + (raw / 2).toFixed(1) + (fullUnit ? '° BTDC' : '°');
  return sign + ((delta ? 0 : 1) + raw / 256).toFixed(3) + '×';
}

/** Draft values live separately from the image the emulated CPU is executing. */
export class Calibration {
  constructor(data, image) {
    this.image = image.slice();
    this.tables = new Map(Object.keys(TUNING_TABLES).map(id => [id, tableByAddr(data, id)]));
    this.draft = new Map();
    this.applied = new Map();
  }

  setDraft(id, row, column, raw) {
    const table = this.tables.get(id);
    if (!table || !Number.isInteger(row) || !Number.isInteger(column) || table.values[row]?.[column] === undefined) {
      throw new RangeError('Unknown calibration cell');
    }
    if (!Number.isInteger(raw) || raw < 0 || raw > 255) throw new RangeError('Enter a whole raw count from 0 to 255');
    const offset = row * table.cols + column;
    const key = id + ':' + offset;
    if (raw === table.values[row][column]) this.draft.delete(key);
    else this.draft.set(key, raw);
  }

  pending() {
    return this.draft.size !== this.applied.size ||
      [...this.draft].some(([key, value]) => this.applied.get(key) !== value);
  }

  table(id, mode) {
    const stock = this.tables.get(id);
    const edits = mode === 'draft' ? this.draft : this.applied;
    return {
      ...stock,
      values: stock.values.map((row, r) => row.map((value, c) => edits.get(id + ':' + (r * stock.cols + c)) ?? value)),
    };
  }

  /** Update the tuning tables and checksum adjustment in the local emulator image. */
  apply(machine) {
    for (const [id, { copies }] of Object.entries(TUNING_TABLES)) {
      const values = Uint8Array.from(this.table(id, 'draft').values.flat());
      for (const address of copies) {
        const start = address + 3;
        this.image.set(values, start - 0x8000);
        machine.rom.set(values, start - 0x8000);
        machine.mem.set(values, start);
      }
    }
    const { sum, expected } = this.checksum();
    const offset = CHECKSUM_ADJUSTMENT - 0x8000;
    const adjustment = (this.image[offset] + expected - sum) & 0xFF;
    this.image[offset] = adjustment;
    machine.rom[offset] = adjustment;
    machine.mem[CHECKSUM_ADJUSTMENT] = adjustment;
    this.applied = new Map(this.draft);
  }

  checksum() {
    let sum = 0;
    for (let i = 0; i < this.image.length; i++) {
      if (i < 0x3600 || i >= 0x3800) sum = (sum + this.image[i]) & 255;
    }
    return { sum, expected: this.image[5] };
  }
}
