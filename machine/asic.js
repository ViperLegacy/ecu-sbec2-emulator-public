// External bus devices (brief 6.4 / 6.5):
//   0400-0406, 0408-040F  external I/O ASIC (reads and writes have different meanings)
//   0440                  write-only output latch (shadow RAM $FE)
//   0480-04FF             external RAM (0490-04AC also executes the RAM-resident flash routine)
// Everything else in 0407, 0410-043F, 0441-047F reads back the low address byte (multiplexed bus), writes ignored.

export const ASIC_INJ_SLOT = { 0x0408: 9, 0x040A: 8, 0x040C: 6, 0x040E: 3 };

export class Asic {
  constructor(m) { this.m = m; this.extRam = new Uint8Array(0x80); this.reset(); }
  reset() {
    this.w0400 = 0; this.ctrl = new Uint8Array(16); this.latch = 0; this.latchWrites = 0;
    this.pw = { 0x0408: 0, 0x040A: 0, 0x040C: 0, 0x040E: 0 };
    this.kicks = 0; this.lastKick = -Infinity; this.irqAcks = 0; this.rearms = 0;
    this.injLatch = true;    // $0405 bit2 latch (1 = OK)
  }

  read0400(c = this.m.cpu.cycles) {
    const m = this.m, i = m.inputs;
    const feed = i.relayFeed && (i.relayFeedMode !== 'follow' || m.outputs.asdFeed(c));
    const busy = i.spiBusy || m.spi.handshakeBusy(c);
    return (i.in0400b7 ? 0x80 : 0) | (i.key ? 0 : 0x40) | (i.in0400b5 ? 0x20 : 0) |
      (feed ? 0x10 : 0) | (busy ? 0x08 : 0) | (i.in0400low & 0x07);
  }

  read(a, c) {
    if (a >= 0x0480) return this.extRam[a - 0x0480];
    switch (a) {
      case 0x0400: return this.read0400(c);
      case 0x0401: return ((this.m.inputs.in0401hi & 0x0F) << 4) | (this.m.inputs.in0401low & 0x0F);
      case 0x0402: case 0x0403: case 0x0404: case 0x0406: return this.ctrl[a - 0x0400];
      case 0x0405: {
        const ok = this.m.inputs.injectorStatusMode === 'latched' ? this.injLatch : this.m.inputs.injectorStatusOk;
        return ok ? 0x04 : 0x00;
      }
    }
    if (a >= 0x0408 && a <= 0x040F) return this.ctrl[a - 0x0400];
    return a & 0xFF;
  }

  write(a, v, c) {
    if (a >= 0x0480) { this.extRam[a - 0x0480] = v; return; }
    const m = this.m;
    switch (a) {
      case 0x0400: {
        const old = this.w0400; this.w0400 = v;
        if ((old ^ v) & 0x02) { this.kicks++; this.lastKick = c; }
        return;
      }
      case 0x0402: {
        const old = this.ctrl[2]; this.ctrl[2] = v;
        if (!(old & 0x08) && (v & 0x08)) m.spi.strobe(c);
        return;
      }
      case 0x0403: case 0x0404: case 0x0406: this.ctrl[a - 0x0400] = v; return;
      case 0x0405:
        this.ctrl[5] = v;
        if (v & 0x01) this.irqAcks++;
        if (v & 0x04) { this.rearms++; this.injLatch = m.inputs.injectorStatusOk; }
        return;
      case 0x0440: {
        const old = this.latch; this.latch = v; this.latchWrites++;
        m.outputs.latchWrite(v, old, c);
        return;
      }
    }
    if (a >= 0x0408 && a <= 0x040F) {
      this.ctrl[a - 0x0400] = v;
      if (a & 1) {                                       // low byte completes the 16-bit word (std hi, lo)
        const base = a - 1;
        const word = (this.ctrl[base - 0x0400] << 8) | v;
        this.pw[base] = word;
        // reset-time initialisation (94F1-94FD stores D = $0008 into 0408-040E) is not an injector pulse
        const pc = m.cpu.lastOpAddr;
        if (!m.generic && pc >= 0x94F1 && pc <= 0x94FD) { m.log('asicInit', { reg: base, word }, c); return; }
        m.outputs.injector(ASIC_INJ_SLOT[base], word, 'asic', `ext $${base.toString(16).toUpperCase().padStart(4, '0')}`, c);
      }
    }
  }
}
