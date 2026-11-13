// 68HC11 SCI in 9-bit mode plus the two logical channels of the Viper link (brief 6.2):
//   TX: polled; each frame takes 10/11 bit times at the BAUD rate (BAUD=$01 -> 32 E cycles/bit at any E clock).
//       T8 (SCCR1 bit 6) is captured when SCDR is written: T8=0 -> diagnostic reply, T8=1 -> side channel.
//   RX: bytes arrive with R8 = 0 (scan tool) or R8 = 1 (side-channel device). RDRF + RIE raise the SCI interrupt.
//   The scan tool model sends its next byte only after the PCM's echo of the previous one (or a timeout).

const SCP = [1, 3, 4, 13];
// Argument bytes per command 10..23 (receive engine table D491: 20 = one, 30 = two).
const ARGS = [0, 0, 0, 1, 1, 2, 1, 0, 1, 1, 1, 0, 2, 2, 2, 2, 2, 1, 1, 1];

export class SCI {
  constructor(m) {
    this.m = m;
    this.tester = { queue: [], awaiting: null, deadline: Infinity, echoTimeoutMs: 100, hs: false, pending: 0 };
    this.rxQueue = [];       // {byte, r8} waiting for the line
    this.reset();
  }
  reset(now = 0) {
    const inFlight = this.rxPending;
    this.baud = 0x04; this.sccr1 = 0; this.sccr2 = 0;
    this.r8 = 0; this.rxData = 0; this.rdrf = false; this.or = false; this.idle = false;
    this.txBuf = null;       // {byte, t8, pc}
    this.shift = null;       // {byte, t8, pc, end}
    this.rxLineFree = 0;     // cycle when the RX line is free for the next frame
    this.rxAt = Infinity;    // next delivery cycle
    this.rxPending = null;
    this.next = Infinity;
    this.tester.awaiting = null; this.tester.deadline = Infinity;
    this.tester.hs = false; this.tester.pending = 0;     // the PCM's parser starts idle
    // rxQueue and tester.queue survive a reset (the tester keeps talking), so restart delivery. A tester byte that
    // was on the wire is lost to the PCM; the tester still waits for its echo and times out as usual.
    this.rxLineFree = now;
    if (inFlight && inFlight.fromTester && this.m.eClock) {
      this.tester.awaiting = inFlight.byte;
      this.tester.deadline = now + Math.round(this.tester.echoTimeoutMs * this.m.eClock / 1000);
    }
    this._pump(now);
    this._testerPush(now);
    this._next();
  }
  bitCycles() { return 16 * SCP[(this.baud >> 4) & 3] * (1 << (this.baud & 7)); }
  frameCycles() { return this.bitCycles() * ((this.sccr1 & 0x10) ? 11 : 10); }

  _next() {
    let n = this.shift ? this.shift.end : Infinity;
    if (this.rxAt < n) n = this.rxAt;
    if (this.tester.deadline < n) n = this.tester.deadline;
    this.next = n;
  }
  _tdre() { return this.txBuf === null; }
  _tc() { return this.txBuf === null && this.shift === null; }

  /** Interrupt request (TIE/TCIE/RIE/ILIE). */
  irq() {
    const s2 = this.sccr2;
    if ((s2 & 0x20) && (this.rdrf || this.or)) return true;
    if ((s2 & 0x80) && this._tdre()) return true;
    if ((s2 & 0x40) && this._tc()) return true;
    if ((s2 & 0x10) && this.idle) return true;
    return false;
  }

  read(off, c) {
    switch (off) {
      case 0x2B: return this.baud;
      case 0x2C: return (this.sccr1 & 0x7F) | (this.r8 ? 0x80 : 0);
      case 0x2D: return this.sccr2;
      case 0x2E: return (this._tdre() ? 0x80 : 0) | (this._tc() ? 0x40 : 0) | (this.rdrf ? 0x20 : 0) |
        (this.idle ? 0x10 : 0) | (this.or ? 0x08 : 0);
      case 0x2F: this.rdrf = false; this.or = false; this.idle = false; return this.rxData;
    }
    return 0;
  }

  write(off, v, c) {
    switch (off) {
      case 0x2B: this.baud = v; return;
      case 0x2C: this.sccr1 = (this.sccr1 & 0x80) | (v & 0x7F); return;
      case 0x2D: this.sccr2 = v; return;
      case 0x2E: return;
      case 0x2F: {
        if (!(this.sccr2 & 0x08)) return;            // TE off
        const fr = { byte: v, t8: (this.sccr1 >> 6) & 1, pc: this.m.cpu.lastOpAddr, cycle: c };
        if (this.shift === null) { fr.end = c + this.frameCycles(); this.shift = fr; }
        else this.txBuf = fr;                         // (overwrites a full buffer, as the hardware would)
        this._next(); this.m.reschedule();
      }
    }
  }

  service(at) {
    if (this.shift && this.shift.end === at) {
      const fr = this.shift;
      this.shift = null;
      if (this.txBuf) { const b = this.txBuf; this.txBuf = null; b.end = at + this.frameCycles(); this.shift = b; }
      this.m._onSciTx(fr.byte, fr.t8, fr.pc, at, fr.cycle);
      if (fr.t8 === 0) this._testerSawTx(fr.byte, at);
    }
    if (this.rxAt === at) {
      const p = this.rxPending; this.rxPending = null; this.rxAt = Infinity;
      if (this.sccr2 & 0x04) {
        if (this.rdrf) this.or = true;
        else { this.rxData = p.byte; this.r8 = p.r8; this.rdrf = true; }
      }
      this.m._onSciRx(p.byte, p.r8, at, !!(this.sccr2 & 0x04));
      if (p.r8 === 0 && p.fromTester) {
        this.tester.awaiting = p.byte;
        this.tester.deadline = at + Math.round(this.tester.echoTimeoutMs * this.m.eClock / 1000);
      }
      this._pump(at);
    }
    if (this.tester.deadline === at) {           // no echo: give up waiting, send the next byte
      this.tester.awaiting = null; this.tester.deadline = Infinity;
      this.m.log('sciTimeout', { note: 'no echo from PCM' });
      this._testerPush(at);
    }
    this._next();
  }

  // The tester's response rule. Normal mode: the PCM echoes each byte, so wait for the echo. High-speed mode (after
  // 12 until FE): no echo; the TOC1 ISR answers each byte with exactly one byte (F2/F4/F6 themselves, FE -> [00FE],
  // any other n -> the byte at n), so any diagnostic byte is the answer.
  _testerSawTx(byte, at) {
    const t = this.tester;
    if (t.awaiting === null) return;
    const sent = t.awaiting;
    if (t.hs) { if (sent === 0xFE) t.hs = false; }
    else if (byte === sent) this._testerParsed(sent);
    else return;
    t.awaiting = null; t.deadline = Infinity;
    this._testerPush(at);
  }
  /** Follow the PCM's receive parser (D4A5) for an echoed byte so the tester knows when 12 starts high-speed mode. */
  _testerParsed(b) {
    const t = this.tester;
    if (t.pending > 0) { t.pending--; return; }
    if (b === 0x12) { t.hs = true; return; }
    t.pending = b >= 0x10 && b <= 0x23 ? ARGS[b - 0x10] : 0;
  }
  _testerPush(at) {
    const t = this.tester;
    if (t.awaiting !== null || this.rxQueue.some((q) => q.fromTester) || this.rxPending?.fromTester) return;
    if (t.queue.length) { this.rxQueue.push({ byte: t.queue.shift(), r8: 0, fromTester: true }); this._pump(at); }
  }
  _pump(now) {
    if (this.rxPending || !this.rxQueue.length) return;
    this.rxPending = this.rxQueue.shift();
    const start = Math.max(now, this.rxLineFree);
    this.rxAt = start + this.frameCycles();
    this.rxLineFree = this.rxAt;
  }

  /** Scan-tool bytes (R8 = 0), paced by the echo. */
  testerSend(bytes, now) {
    for (const b of bytes) this.tester.queue.push(b & 0xFF);
    this._testerPush(now);
    this._next(); this.m.reschedule();
  }
  /** Side-channel status bytes (R8 = 1), sent back to back. */
  sideSend(bytes, now) {
    for (const b of bytes) this.rxQueue.push({ byte: b & 0xFF, r8: 1, fromTester: false });
    this._pump(now);
    this._next(); this.m.reschedule();
  }
  testerBusy() {
    return this.tester.queue.length > 0 || this.tester.awaiting !== null || !!this.rxPending?.fromTester ||
      this.rxQueue.some((q) => q.fromTester);
  }
  testerClear() { this.tester.queue.length = 0; this.tester.awaiting = null; this.tester.deadline = Infinity; this._next(); }
}
