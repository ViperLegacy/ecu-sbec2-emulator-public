// 68HC11 internal EEPROM B600-B7FF with PPROG ($103B) and BPROT ($1035) semantics (brief 6.6).
// PPROG: ODD EVEN - BYTE ROW ERASE EELAT EPGM. With EELAT=1 a write to the array latches address+data. The
// program/erase is applied when EPGM goes 1 -> 0 (the firmware leaves EPGM on for one main-loop pass).
// Program ANDs the data into the byte; erase sets FF (byte, 16-byte row, or bulk). PPROG reads back as written.
// BPROT bits 0-3 protect B600-B61F, B620-B65F, B660-B6DF, B6E0-B7FF; protected bytes never change.

const BLOCKS = [[0x000, 0x020], [0x020, 0x060], [0x060, 0x0E0], [0x0E0, 0x200]];

export class Eeprom {
  constructor(m, bytes) {
    this.m = m;
    this.data = new Uint8Array(512);
    if (bytes) this.data.set(bytes.subarray ? bytes.subarray(0, 512) : bytes);
    this.listeners = [];
    this.reset(0);
  }
  reset(cycle) {
    this.pprog = 0; this.bprot = 0x1F; this.resetCycle = cycle;
    this.latchAddr = -1; this.latchData = 0xFF; this.writes = 0; this.blocked = 0;
  }
  protectedOff(off) {
    for (let b = 0; b < 4; b++) if ((this.bprot & (1 << b)) && off >= BLOCKS[b][0] && off < BLOCKS[b][1]) return true;
    return false;
  }
  writeBprot(v, c) {
    // bits can always be set; clearing is only possible in the first 64 E cycles after reset
    this.bprot = (c - this.resetCycle < 64) ? (v & 0x1F) : ((this.bprot | v) & 0x1F);
  }
  read(off) { return this.data[off]; }
  /** CPU write into B600-B7FF. */
  write(off, v, c) {
    if ((this.pprog & 0x02) && !(this.pprog & 0x01)) { this.latchAddr = off; this.latchData = v; return true; }
    return false;   // plain write: no effect on the array
  }
  writePprog(v, c) {
    const old = this.pprog;
    this.pprog = v;
    if ((old & 0x01) && !(v & 0x01)) this._apply(old, c);
    if (!(v & 0x02)) this.latchAddr = -1;
  }
  _apply(mode, c) {
    if (this.latchAddr < 0) return;
    let offs;
    if (mode & 0x04) {
      if (mode & 0x10) offs = [this.latchAddr];
      else if (mode & 0x08) { const r = this.latchAddr & ~0x0F; offs = Array.from({ length: 16 }, (_, i) => r + i); }
      else offs = Array.from({ length: 512 }, (_, i) => i);
    } else offs = [this.latchAddr];
    const kind = (mode & 0x04) ? ((mode & 0x10) ? 'erase-byte' : (mode & 0x08) ? 'erase-row' : 'erase-bulk') : 'program';
    let changed = 0, blocked = 0;
    for (const o of offs) {
      if (this.protectedOff(o)) { blocked++; continue; }
      const before = this.data[o];
      const after = (mode & 0x04) ? 0xFF : (before & this.latchData);
      if (after !== before) { this.data[o] = after; changed++; }
    }
    this.writes++; if (blocked) this.blocked++;
    const addr = 0xB600 + this.latchAddr;
    const ev = { kind, addr, data: this.latchData, changed, blocked, value: this.data[this.latchAddr] };
    this.m.log('eeprom', ev);
    this.m._onEepromChange(ev);
    for (const fn of this.listeners) { try { fn(ev, this.data); } catch (e) { /* listener errors must not stop the machine */ } }
  }
}
