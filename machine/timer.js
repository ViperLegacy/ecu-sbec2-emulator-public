// 68HC11 main timer: TCNT, TIC1-3, TOC1-5, TCTL1/2, CFORC, OC1M/OC1D, TMSK/TFLG 1+2, RTI, TOF, PACTL/PACNT.
// Event-driven: compares, overflow and RTI are scheduled at the exact E cycle; TCNT is computed from cpu cycles.
// Register offsets are relative to $1000.

const OC_PIN = [-1, 6, 5, 4, 3]; // OC1 drives through OC1M; OC2->PA6, OC3->PA5, OC4->PA4, OC5->PA3
const PR_DIV = [1, 4, 8, 16];

export class Timer {
  constructor(m) { this.m = m; this.reset(0); }

  reset(cycle) {
    this.resetCycle = cycle;
    this.t0 = cycle;            // cycle at which tick 0 started
    this.div = 1;               // TMSK2 PR = 00 after reset
    this.toc = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];
    this.tic = [0, 0, 0];
    this.tflg1 = 0; this.tmsk1 = 0; this.tflg2 = 0; this.tmsk2 = 0;
    this.tctl1 = 0; this.tctl2 = 0; this.oc1m = 0; this.oc1d = 0;
    this.pactl = 0; this.pacnt = 0;
    this.paOut = 0;             // driven levels of PA3..PA7 (bit n = PAn)
    this.paIn = 0;              // input pin levels PA0..PA2, PA7
    this.porta = 0;             // last value written to PORTA
    this.cmp = new Array(5).fill(Infinity);
    this.tofAt = Infinity; this.rtiAt = Infinity;
    this.next = Infinity;
    this._schedAll(cycle);
  }

  tick(c) { return Math.floor((c - this.t0) / this.div); }
  tcnt(c) { return this.tick(c) & 0xFFFF; }

  _cmpCycle(i, now) {
    const t = this.tick(now);
    let k = t - (t & 0xFFFF) + this.toc[i];
    if (k <= t) k += 65536;
    return this.t0 + k * this.div;
  }
  _schedCmp(i, now) { this.cmp[i] = this._cmpCycle(i, now); }
  _schedAll(now) {
    for (let i = 0; i < 5; i++) this._schedCmp(i, now);
    const t = this.tick(now);
    this.tofAt = this.t0 + (Math.floor(t / 65536) + 1) * 65536 * this.div;
    const per = 8192 << (this.pactl & 3);
    const n = Math.floor((now - this.resetCycle) / per) + 1;
    this.rtiAt = this.resetCycle + n * per;
    this._next();
  }
  _next() {
    let n = this.tofAt < this.rtiAt ? this.tofAt : this.rtiAt;
    for (let i = 0; i < 5; i++) if (this.cmp[i] < n) n = this.cmp[i];
    this.next = n;
  }

  /** Process every internal event due at `at` (the scheduler calls this with at = this.next). */
  service(at) {
    for (let i = 0; i < 5; i++) {
      if (this.cmp[i] === at) {
        this.tflg1 |= 0x80 >> i;          // OC1F..OC4F = b7..b4, I4/O5F = b3
        this._ocAction(i, at, false);
        this.cmp[i] = at + 65536 * this.div;
      }
    }
    if (this.tofAt === at) { this.tflg2 |= 0x80; this.tofAt = at + 65536 * this.div; }
    if (this.rtiAt === at) { this.tflg2 |= 0x40; this.rtiAt = at + (8192 << (this.pactl & 3)); }
    this._next();
  }

  _setPin(bit, level, cycle) {
    const mask = 1 << bit, old = this.paOut & mask;
    const nv = level ? mask : 0;
    if (old === nv) return;
    this.paOut = (this.paOut & ~mask) | nv;
    this.m._onPortAPin(bit, !!level, cycle);
  }

  _ocAction(i, cycle) {
    if (i === 0) {
      for (let b = 3; b <= 7; b++) {
        if (this.oc1m & (1 << b)) this._setPin(b, this.oc1d & (1 << b), cycle);
      }
      return;
    }
    if (i === 4 && (this.pactl & 0x04)) return; // PA3 is IC4, not OC5
    const mode = (this.tctl1 >> (2 * (4 - i))) & 3;
    const bit = OC_PIN[i], cur = this.paOut & (1 << bit);
    if (mode === 1) this._setPin(bit, !cur, cycle);
    else if (mode === 2) this._setPin(bit, 0, cycle);
    else if (mode === 3) this._setPin(bit, 1, cycle);
  }

  /** Edge on an input pin (0 = PA0/IC3, 1 = PA1/IC2, 2 = PA2/IC1, 7 = PA7/PAI) at exact E cycle. */
  inputEdge(pin, level, cycle) {
    const mask = 1 << pin;
    const old = !!(this.paIn & mask);
    level = !!level;
    if (old === level) return;
    this.paIn = level ? (this.paIn | mask) : (this.paIn & ~mask);
    if (pin <= 2) {
      const ic = 2 - pin;                          // 0 = IC1, 1 = IC2, 2 = IC3
      const cfg = (this.tctl2 >> [4, 2, 0][ic]) & 3;
      if ((level && (cfg & 1)) || (!level && (cfg & 2))) {
        this.tic[ic] = this.tcnt(cycle);
        this.tflg1 |= 4 >> ic;                      // IC1F b2, IC2F b1, IC3F b0
      }
    } else if (pin === 7 && (this.pactl & 0x40)) {   // pulse accumulator (event mode only; not used by firmware)
      const pedge = !!(this.pactl & 0x10);
      if (!(this.pactl & 0x20) && level === pedge) {
        this.pacnt = (this.pacnt + 1) & 0xFF;
        this.tflg2 |= 0x10;
        if (this.pacnt === 0) this.tflg2 |= 0x20;
      }
    }
  }

  readPortA() {
    let v = this.paIn & 0x07;
    v |= this.paOut & 0x78;
    if (this.pactl & 0x80) v |= this.paOut & 0x80; else v |= this.paIn & 0x80;
    return v;
  }

  read(off, c) {
    switch (off) {
      case 0x00: return this.readPortA();
      case 0x0B: return 0;
      case 0x0C: return this.oc1m;
      case 0x0D: return this.oc1d;
      case 0x0E: return this.tcnt(c) >> 8;
      case 0x0F: return this.tcnt(c) & 0xFF;
      case 0x10: case 0x12: case 0x14: return this.tic[(off - 0x10) >> 1] >> 8;
      case 0x11: case 0x13: case 0x15: return this.tic[(off - 0x11) >> 1] & 0xFF;
      case 0x20: return this.tctl1;
      case 0x21: return this.tctl2;
      case 0x22: return this.tmsk1;
      case 0x23: return this.tflg1;
      case 0x24: return this.tmsk2;
      case 0x25: return this.tflg2;
      case 0x26: return this.pactl;
      case 0x27: return this.pacnt;
      default:
        if (off >= 0x16 && off <= 0x1F) {
          const i = (off - 0x16) >> 1;
          return (off & 1) ? (this.toc[i] & 0xFF) : (this.toc[i] >> 8);
        }
        return 0;
    }
  }

  write(off, v, c) {
    switch (off) {
      case 0x00: {
        this.porta = v;
        for (let b = 3; b <= 6; b++) {           // a port write reaches a pin only when no OC function owns it
          const i = 7 - b;                       // PA6->OC2(1) ... PA3->OC5(4)
          const mode = (this.tctl1 >> (2 * (4 - i))) & 3;
          if (mode === 0 && !(this.oc1m & (1 << b))) this._setPin(b, v & (1 << b), c);
        }
        if (this.pactl & 0x80) this._setPin(7, v & 0x80, c);
        return;
      }
      case 0x0B:                                  // CFORC: force the compare actions, no flag
        for (let i = 0; i < 5; i++) if (v & (0x80 >> i)) this._ocAction(i, c);
        return;
      case 0x0C: this.oc1m = v & 0xF8; return;
      case 0x0D: this.oc1d = v & 0xF8; return;
      case 0x0E: case 0x0F: return;               // TCNT is read-only outside test mode
      case 0x20: this.tctl1 = v; return;
      case 0x21: this.tctl2 = v; return;
      case 0x22: this.tmsk1 = v; return;
      case 0x23: this.tflg1 &= ~v & 0xFF; return;
      case 0x24: {
        let pr = this.tmsk2 & 3;
        if (c - this.resetCycle < 64) pr = v & 3; // PR1:0 are time-protected (first 64 E cycles)
        const newDiv = PR_DIV[pr];
        if (newDiv !== this.div) {
          const t = this.tick(c);
          this.t0 = c - t * newDiv;
          this.div = newDiv;
          this.tmsk2 = (v & 0xF0) | pr;
          this._schedAll(c); this.m.reschedule();
          return;
        }
        this.tmsk2 = (v & 0xF0) | pr;
        return;
      }
      case 0x25: this.tflg2 &= ~v & 0xF0; return;
      case 0x26: {
        const rtrOld = this.pactl & 3;
        this.pactl = v & 0xF7;
        if ((v & 3) !== rtrOld) { this._schedAll(c); this.m.reschedule(); }
        return;
      }
      case 0x27: this.pacnt = v; return;
      default:
        if (off >= 0x16 && off <= 0x1F) {
          const i = (off - 0x16) >> 1;
          this.toc[i] = (off & 1) ? ((this.toc[i] & 0xFF00) | v) : ((v << 8) | (this.toc[i] & 0xFF));
          this._schedCmp(i, c); this._next(); this.m.reschedule();
        }
    }
  }
}
