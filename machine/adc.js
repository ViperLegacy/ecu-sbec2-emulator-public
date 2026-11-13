// 68HC11 A/D converter: ADCTL ($1030), ADR1-ADR4 ($1031-$1034).
// A write to ADCTL starts a sequence of four conversions, 32 E cycles each; CCF (bit 7) sets 128 E cycles after the
// write. MULT=1 converts four channels of the group (CD:CC), MULT=0 converts one channel four times. SCAN=1 keeps
// converting. Results are evaluated lazily from the cycle of the register access. Channel values come from
// machine.inputs.adc(ch) sampled when each conversion completes (approximated: at the start of the sequence).

export class ADC {
  constructor(m) { this.m = m; this.reset(); }
  reset() {
    this.adctl = 0; this.start = -Infinity; this.chans = [0, 0, 0, 0];
    this.pend = [0, 0, 0, 0]; this.adr = [0, 0, 0, 0]; this.done = 4; this.conversions = 0;
  }
  _sample() { for (let k = 0; k < 4; k++) this.pend[k] = this.m.inputs.adc(this.chans[k]) & 0xFF; }
  _update(c) {
    if (c < this.start) return;
    const el = c - this.start;
    if (this.adctl & 0x20 && el >= 128) {            // SCAN: continuous
      for (let k = 0; k < 4; k++) this.adr[k] = this.pend[k];
      const n = Math.floor(el / 128);
      this.start += n * 128;
      this._sample();
      this.done = 0;
      return this._update(c);
    }
    while (this.done < 4 && el >= 32 * (this.done + 1)) { this.adr[this.done] = this.pend[this.done]; this.done++; }
  }
  write(v, c) {
    this.adctl = v & 0x3F;
    this.start = c;
    const ch = v & 0x0F;
    if (v & 0x10) { const base = ch & 0x0C; this.chans = [base, base + 1, base + 2, base + 3]; }
    else this.chans = [ch, ch, ch, ch];
    this.done = 0; this.conversions++;
    this._sample();
  }
  read(off, c) {
    this._update(c);
    if (off === 0x30) return this.adctl | (c - this.start >= 128 ? 0x80 : 0);
    return this.adr[off - 0x31];
  }
}
