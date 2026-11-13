// 68HC11 SPI master (SPCR $1028, SPSR $1029, SPDR $102A) and the three SPI peers of brief 6.3:
//   - $FD output driver   : selected while latch $0440 bit2 is LOW at the SPDR write. 8-bit shift register.
//   - SPI smart device    : PD5 low, every byte followed by a $0402 bit3 strobe; handshake on $0400 read bit3.
//                           6-byte status frame 61 62 00 FC 00 sum, the slot-2 injector frame FE lo hi sum, or
//                           the CCD-message frame 93|80 d0 d1 d2 sum (E9F6) whose reply is a received CCD message.
//   - AIS stepper driver  : PD5 low, byte NOT strobed through $0402.3 (latch $0440 bit0 strobe), (~p<<4)|p.
// The received byte is available as soon as SPDR is written; SPIF sets 8 bit-times later. Writing SPDR while a
// transfer is in progress sets WCOL and is ignored.

const SPR_DIV = [2, 4, 16, 32];
const AIS_PHASES = [0x06, 0x05, 0x09, 0x0A];

export class SPI {
  constructor(m) { this.m = m; this.reset(); }
  reset() {
    this.spcr = 0x04; this.busyUntil = -Infinity; this.xferEnd = -Infinity; this.acked = true;
    this.wcol = false; this.spsrSaw = false; this.rx = 0;
    this.frame = null; this.prevFd = 0; this.frames = 0;
  }
  _spif(c) { return !this.acked && c >= this.xferEnd; }

  read(off, c) {
    if (off === 0x28) return this.spcr;
    if (off === 0x29) {
      const f = this._spif(c);
      this.spsrSaw = f || this.wcol;
      return (f ? 0x80 : 0) | (this.wcol ? 0x40 : 0);
    }
    // SPDR
    if (this.spsrSaw) { if (this._spif(c)) this.acked = true; this.wcol = false; this.spsrSaw = false; }
    return this.rx;
  }

  write(off, v, c) {
    if (off === 0x28) { this.spcr = v; return; }
    if (off === 0x29) return;
    // SPDR write
    if (this.spsrSaw) { if (this._spif(c)) this.acked = true; this.wcol = false; this.spsrSaw = false; }
    if (!(this.spcr & 0x40)) return;                 // SPE off
    if (c < this.busyUntil) { this.wcol = true; return; }
    const dur = 8 * SPR_DIV[this.spcr & 3];
    this.busyUntil = c + dur; this.xferEnd = c + dur; this.acked = false;
    this.frames++;
    const m = this.m;
    const latch = m.asic.latch;
    if (!(latch & 0x04)) {                            // $FD driver selected
      const mode = m.inputs.fdFeedbackMode;
      this.rx = mode === 'echo' ? v : mode === 'value' ? (m.inputs.fdFeedbackValue & 0xFF) : this.prevFd;
      this.prevFd = v;
      m.outputs.fdByte(v, c);
      return;
    }
    if (!(m.portd & 0x20)) {                          // PD5 low: smart device or AIS driver
      if (!this.frame) this.frame = { start: c, bytes: [] };
      this.frame.bytes.push({ v, strobed: false, cycle: c });
      this.rx = 0x00;
      return;
    }
    this.rx = 0xFF;                                  // nobody selected: MISO floats high (GUESS)
    m.log('spiUnselected', { byte: v });
  }

  /** $0402 bit3 rising edge: the smart device takes the byte just shifted and presents its reply. */
  strobe(c) {
    const f = this.frame;
    if (!f || !f.bytes.length) return;
    const b = f.bytes[f.bytes.length - 1];
    if (b.strobed) return;
    b.strobed = true;
    const idx = f.bytes.filter((x) => x.strobed).length - 1;
    const first = f.bytes.find((x) => x.strobed);
    if (first && first.v === 0x61) {
      const r = this.m.inputs.smartReply;
      if (idx >= 1 && idx <= 4) this.rx = r[idx - 1] & 0xFF;
      else if (idx === 5) this.rx = (this.m.inputs.smartChecksumOk ? (r[0] + r[1] + r[2] + r[3]) : (r[0] + r[1] + r[2] + r[3] + 1)) & 0xFF;
      else this.rx = 0;
    } else if (first && (first.v === 0x93 || first.v === 0x80)) {
      // CCD-bus message frame (E9F6): hdr, 3 data bytes, sum. The device returns a received CCD message.
      const msg = this.m.inputs.ccdRxMessage;
      if (!msg) this.rx = 0;
      else if (idx >= 1 && idx <= 3) this.rx = msg[idx - 1] & 0xFF;
      else if (idx === 4) this.rx = (msg[0] + msg[1] + msg[2]) & 0xFF;
      else this.rx = 0;
    } else this.rx = 0;
  }

  /** PD5 level change (PORTD write). */
  pd5(level, c) {
    if (!level) { if (!this.frame) this.frame = { start: c, bytes: [] }; return; }
    const f = this.frame; this.frame = null;
    if (!f) return;
    const m = this.m;
    const smart = f.bytes.filter((b) => b.strobed).map((b) => b.v);
    if (smart.length) m.outputs.smartFrame(smart, f.start, c);
    for (const b of f.bytes) if (!b.strobed) m.outputs.aisByte(b.v, b.cycle);
  }
}

export { AIS_PHASES };
