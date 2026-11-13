// Crank / cam / vehicle-speed stimulus (brief sec. 5). Edges are scheduled in E cycles and delivered to the timer
// (TIC1 = PA2 rising, TIC2 = PA1 falling) and to the IRQ pin (falling) at the exact cycle.
//
// Wheel model (GUESS, editable): 20 TIC1 rising edges per 720 deg. Generator edge 2s is the "cylinder edge" that
// starts firmware slot s, edge 2s+1 is that slot's "intermediate edge" (this holds once the firmware has synced on
// the candidate cam pattern). Cam pulses are placed in "the second half of slot s" = between edge 2s+1 and 2s+2.

export const CAM_PATTERNS = {
  // brief sec. 5 candidate (derived from the sync rules, NOT measured)
  candidate: [{ slot: 4, frac: 0.5 }, { slot: 7, frac: 1 / 3 }, { slot: 7, frac: 2 / 3 }, { slot: 9, frac: 0.5 }],
  // quick test: one IRQ per cycle; the 6-edge rule (slot 2) syncs without further cam evidence
  quick: [{ slot: 9, frac: 0.5 }],
  none: [],
};

export function evenEdgeAngles() { return Array.from({ length: 20 }, (_, i) => i * 36); }

export class Stimulus {
  constructor(m) {
    this.m = m;
    this.edgeAngles = evenEdgeAngles();
    this.crankHighDeg = 10;        // PA2 high time after each rising edge (GUESS)
    this.camLowDeg = 3;            // IRQ pin low time (GUESS)
    this.camPattern = CAM_PATTERNS.candidate.map((p) => ({ ...p }));
    this.vssPulsesPerMile = 8000;  // INFERRED
    this.vssLowFrac = 0.5;
    this.minVssLowUs = 200;        // F24A samples PA1 ~100 E cycles after the edge: keep it low longer than that
    this.angle = 0;                // crank angle in the 720-deg cycle at lastCycle
    this.lastCycle = 0;
    this.rate = 0;                 // deg per E cycle used for the pending event
    this.rpmTarget = 0;
    this.ramp = null;              // {from, to, start, end} in cycles
    this.events = [];
    this.evIdx = 0;
    this.crankNext = Infinity;
    this.mph = 0;
    this.vssNext = Infinity; this.vssLow = false;
    this.next = Infinity;
    this.counts = { crankEdges: 0, camPulses: 0, vssPulses: 0, cycles720: 0 };
    this.lastEdgeIdx = -1;         // generator index (0..19) of the last TIC1 rising edge
    this._build();
  }

  // ---- configuration ----------------------------------------------------------------------------------
  setEdgeAngles(arr) {
    if (!Array.isArray(arr) || arr.length !== 20) throw new Error('need 20 edge angles (deg in 0..720)');
    this.edgeAngles = arr.map((a) => ((a % 720) + 720) % 720).sort((a, b) => a - b);
    this._rebuild();
  }
  setCamPattern(p) {
    this.camPattern = (typeof p === 'string' ? CAM_PATTERNS[p] : p).map((x) => ({ slot: x.slot, frac: x.frac ?? 0.5 }));
    this._rebuild();
  }
  _camAngle(p) {
    const a1 = this.edgeAngles[(2 * p.slot + 1) % 20];
    let a2 = this.edgeAngles[(2 * p.slot + 2) % 20];
    if (a2 <= a1) a2 += 720;
    return (a1 + p.frac * (a2 - a1)) % 720;
  }
  _build() {
    const ev = [];
    const n = this.edgeAngles.length;
    this.edgeAngles.forEach((a, i) => {
      // the high time never reaches the next rising edge (else that edge would be lost on custom, close spacings)
      let gap = this.edgeAngles[(i + 1) % n] - a;
      if (gap <= 0) gap += 720;
      const high = Math.min(this.crankHighDeg, gap / 2);
      ev.push({ angle: a, kind: 'crankRise', idx: i });
      ev.push({ angle: (a + high) % 720, kind: 'crankFall', idx: i });
    });
    this.camPattern.forEach((p, i) => {
      const a = this._camAngle(p);
      ev.push({ angle: a, kind: 'camFall', idx: i });
      ev.push({ angle: (a + this.camLowDeg) % 720, kind: 'camRise', idx: i });
    });
    ev.sort((x, y) => x.angle - y.angle || (x.kind < y.kind ? -1 : 1));
    this.events = ev;
  }
  _rebuild() {
    const now = this.m.cpu.cycles;
    this._advanceTo(now);
    this._build();
    this.evIdx = this.events.findIndex((e) => e.angle > this.angle);
    if (this.evIdx < 0) this.evIdx = 0;
    this._schedCrank(now);
  }

  // ---- rpm ----------------------------------------------------------------------------------------------
  rpmAt(c) {
    const r = this.ramp;
    if (!r) return this.rpmTarget;
    if (c >= r.end) return r.to;
    if (c <= r.start) return r.from;
    return r.from + (r.to - r.from) * (c - r.start) / (r.end - r.start);
  }
  /** Set the crank speed (rpm). opts.rampMs ramps linearly from the present speed. 0 = engine stopped (no edges). */
  setRpm(rpm, opts = {}) {
    const now = this.m.cpu.cycles;
    this._advanceTo(now);
    const from = this.rpmAt(now);
    if (opts.rampMs > 0) this.ramp = { from, to: rpm, start: now, end: now + Math.round(opts.rampMs * this.m.eClock / 1000) };
    else this.ramp = null;
    this.rpmTarget = rpm;
    this._schedCrank(now);
  }
  get rpm() { return this.rpmAt(this.m.cpu.cycles); }
  /** Crank angle (deg, 0..720) now, and the generator's own slot (0..9) by angle. */
  get crankAngle() { return this._angleAt(this.m.cpu.cycles); }
  _angleAt(c) { return (this.angle + this._degBetween(this.lastCycle, c)) % 720; }
  _advanceTo(c) {
    if (c > this.lastCycle) { this.angle = this._angleAt(c); this.lastCycle = c; }
  }
  /** Crank degrees turned between cycles c0 <= c1: the integral of 6*rpm(t) over the (linear) ramp. */
  _degBetween(c0, c1) {
    if (!(c1 > c0)) return 0;
    const k = 6 / this.m.eClock, r = this.ramp;
    if (!r || c0 >= r.end) return k * this.rpmAt(c0) * (c1 - c0);
    const e = Math.min(c1, r.end);
    let deg = k * (this.rpmAt(c0) + this.rpmAt(e)) / 2 * (e - c0);
    if (c1 > e) deg += k * r.to * (c1 - e);
    return deg;
  }
  /** E cycles needed from `now` to turn `d` degrees under the present ramp (Infinity if the crank stops first). */
  _cyclesFor(now, d) {
    const D = d * this.m.eClock / 6;               // rpm * cycles needed
    const r = this.ramp;
    if (D <= 0) return (this.rpmAt(now) > 0 || (r && now < r.end && r.to > 0)) ? 0 : Infinity;
    let r0 = this.rpmAt(now), t = 0, rest = D;
    if (r && now < r.end) {
      const span = r.end - now, slope = (r.to - r.from) / (r.end - r.start);
      const area = (r0 + r.to) / 2 * span;
      if (area >= rest) {
        const s = Math.sqrt(Math.max(0, r0 * r0 + 2 * slope * rest));
        return (r0 + s) > 0 ? 2 * rest / (r0 + s) : Infinity;   // root of slope/2 x^2 + r0 x = rest (stable form)
      }
      t = span; rest -= area; r0 = r.to;
    }
    return r0 >= 1 ? t + rest / r0 : Infinity;
  }
  _schedCrank(now) {
    const rpm = this.rpmAt(now);
    this.rate = rpm * 6 / this.m.eClock;          // instantaneous deg per E cycle (informational)
    if (!this.events.length) { this.crankNext = Infinity; this._next(); this.m.reschedule(); return; }
    const e = this.events[this.evIdx];
    let d = e.angle - this.angle;
    if (d < 0) d += 720;
    const n = this._cyclesFor(now, d);
    this.crankNext = Number.isFinite(n) ? now + Math.max(1, Math.round(n)) : Infinity;
    this._next(); this.m.reschedule();
  }

  // ---- vehicle speed ---------------------------------------------------------------------------------------
  /** Vehicle speed in mph -> falling edges on TIC2/PA1 at pulsesPerMile (INFERRED 8000). 0 = no pulses. */
  setSpeedMph(mph) {
    const now = this.m.cpu.cycles;
    const wasStopped = !(this.mph > 0);
    this.mph = mph;
    if (!(mph > 0)) { this.vssNext = Infinity; if (this.vssLow) { this.vssLow = false; this.m.timer.inputEdge(1, 1, now); } }
    else if (wasStopped) this.vssNext = now + 1;
    this._next(); this.m.reschedule();
  }
  _vssPeriod() { return this.m.eClock * 3600 / (this.mph * this.vssPulsesPerMile); }

  _next() { this.next = this.crankNext < this.vssNext ? this.crankNext : this.vssNext; }

  service(at) {
    const m = this.m;
    if (this.crankNext === at) {
      this._advanceTo(at);
      {
        const e = this.events[this.evIdx];
        this.angle = e.angle; this.lastCycle = at;
        switch (e.kind) {
          case 'crankRise': m.timer.inputEdge(2, 1, at); this.counts.crankEdges++; this.lastEdgeIdx = e.idx; if (e.idx === 0) this.counts.cycles720++; break;
          case 'crankFall': m.timer.inputEdge(2, 0, at); break;
          case 'camFall': m.setIrqPin(false, at); this.counts.camPulses++; break;
          case 'camRise': m.setIrqPin(true, at); break;
        }
        this.evIdx = (this.evIdx + 1) % this.events.length;
      }
      this._schedCrank(at);   // an event at the same angle fires one cycle later
    }
    if (this.vssNext === at) {
      const per = this._vssPeriod();
      if (!this.vssLow) {
        m.timer.inputEdge(1, 0, at); this.vssLow = true; this.counts.vssPulses++;
        const low = Math.max(per * this.vssLowFrac, this.minVssLowUs * m.eClock / 1e6);
        this.vssNext = at + Math.max(1, Math.round(low));
      } else {
        m.timer.inputEdge(1, 1, at); this.vssLow = false;
        const low = Math.max(per * this.vssLowFrac, this.minVssLowUs * m.eClock / 1e6);
        this.vssNext = at + Math.max(1, Math.round(per - low));
      }
    }
    this._next();
  }

  snapshot() {
    const a = this.crankAngle;
    return {
      rpm: this.rpm, rpmTarget: this.rpmTarget, ramping: !!this.ramp && this.m.cpu.cycles < this.ramp.end,
      crankAngle: a, generatorSlot: Math.floor(((a - this.edgeAngles[0] + 720) % 720) / 72),
      edgeAngles: this.edgeAngles.slice(), camPattern: this.camPattern.map((p) => ({ ...p })),
      mph: this.mph, vssPulsesPerMile: this.vssPulsesPerMile, counts: { ...this.counts },
    };
  }
}
