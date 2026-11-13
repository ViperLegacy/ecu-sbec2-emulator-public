// Signal probe for the timing scope: records TIC1 (PA2) / TIC2 (PA1) edges and the IRQ pin as the stimulus drives
// them, plus injector pulses and spark frames from the machine log. DOM-free; attaches by wrapping the machine's
// timer.inputEdge and setIrqPin (no change to the machine code).

class Ring {
  constructor(n) { this.n = n; this.buf = new Array(n); this.len = 0; }
  push(x) { this.buf[this.len % this.n] = x; this.len++; }
  /** Items with item.c >= c0, oldest first. */
  since(c0) {
    const out = [];
    const first = Math.max(0, this.len - this.n);
    for (let i = this.len - 1; i >= first; i--) { const x = this.buf[i % this.n]; if (x.c < c0) break; out.push(x); }
    return out.reverse();
  }
  last() { return this.len ? this.buf[(this.len - 1) % this.n] : null; }
}

export class Probe {
  constructor(m, { cap = 8192 } = {}) {
    this.m = m;
    this.tic1 = new Ring(cap);   // {c, level}
    this.irq = new Ring(cap);    // {c, level}
    this.vss = new Ring(cap);    // {c, level}
    this.inj = new Ring(cap);    // {c, slot, ticks, path}
    this.spark = new Ring(cap);  // {c, raw, slot, fromMap}
    const t = m.timer;
    const origEdge = t.inputEdge;
    const origIrq = m.setIrqPin;
    this._origEdge = origEdge; this._origIrq = origIrq;
    const self = this;
    t.inputEdge = function (ch, level, at) {
      if (ch === 2) self.tic1.push({ c: at, level });
      else if (ch === 1) self.vss.push({ c: at, level });
      return origEdge.call(this, ch, level, at);
    };
    m.setIrqPin = function (level, cycle = this.cpu.cycles) {
      self.irq.push({ c: cycle, level: level ? 1 : 0 });
      return origIrq.call(this, level, cycle);
    };
    this._offs = [
      m.on('inj', (e) => { if (e.slot >= 0 && e.slot < 10) this.inj.push({ c: e.cycle, slot: e.slot, ticks: e.pwTicks, path: e.path }); }),
      m.on('spark', (e) => this.spark.push({ c: e.cycle, raw: e.raw, slot: e.slot, fromMap: e.fromMap })),
    ];
  }
  /** Everything recorded since cycle c0 (for the scope window). */
  window(c0) {
    const lvl = (ring) => { const xs = ring.since(c0); const prev = ring.buf[(ring.len - xs.length - 1) % ring.n]; return { edges: xs, initial: ring.len > xs.length && prev ? prev.level : null }; };
    return { tic1: lvl(this.tic1), irq: lvl(this.irq), vss: lvl(this.vss), inj: this.inj.since(c0 - 2_000_000), spark: this.spark.since(c0) };
  }
  detach() {
    this.m.timer.inputEdge = this._origEdge;
    this.m.setIrqPin = this._origIrq;
    for (const f of this._offs) f();
  }
}
