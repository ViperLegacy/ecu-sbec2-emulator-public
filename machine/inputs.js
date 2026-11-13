// Inputs of the PCM model: analog channels (engineering-unit setters + raw-count overrides) and discrete inputs.
// Every input is named by MCU resource; functions are inferred (see INPUT_INFO for the confidence tags).
// ADC: 8-bit, 5 V = 255 counts (ASSUMED). Units below are inferred, never measured on the Viper.

/** Exact port of the firmware curve interpolator EE4B (table at `addr` in CPU space, input A 0..255). */
export function evalCurveEE4B(read, addr, A) {
  let n = read(addr), x = addr + 1;
  A &= 0xFF;
  if (A <= read(x)) return read(x + 1);
  for (;;) {
    n--;
    if (n === 0) return read(x + 1);
    if (A < read(x + 4)) {
      const d = (A - read(x)) & 0xFF;
      let y = (d * read(x + 2)) & 0xFFFF;
      const lo = d * read(x + 3);
      const hi = ((lo >> 8) + ((lo & 0x80) ? 1 : 0)) & 0xFF;
      y = (y + hi) & 0xFFFF;
      return ((y & 0xFF) + read(x + 1)) & 0xFF;
    }
    x += 4;
  }
}

/** Firmware ratio of the two AN4 readings (BC68-BC8C): A = plain, B = with $0440.7 = 1. null when skipped. */
export function an4AltRatio(A, B) {
  const P = (A * B) & 0xFFFF;
  const diff = (A - B) & 0xFF;
  if (!(A > B)) return null;                         // subb / bls: skipped
  const X = (diff + (((P >> 8) + ((P >> 7) & 1)) & 0xFF)) & 0xFFFF;
  if (X === 0) return null;
  const q = Math.floor(P / X);
  return q > 255 ? null : q;                         // tsta / bne: quotient must fit a byte
}

export const INPUT_INFO = {
  map:      { resource: 'AN0 (ADR1 of ADCTL=$10)', fn: 'MAP sensor', ram: '$76/$C6', confidence: 'channel high; kPa scale unknown', units: 'counts' },
  battery:  { resource: 'AN1 (ADR2 of ADCTL=$10)', fn: 'battery voltage', ram: '$80', confidence: 'medium-high; V = counts/16 INFERRED', units: 'V' },
  o2_1:     { resource: 'AN2 (ADR3 of ADCTL=$10)', fn: 'O2 sensor 1 (INFERRED odd-cylinder bank)', ram: '$79', confidence: 'high', units: 'V' },
  tps:      { resource: 'AN3 (ADR4 of ADCTL=$10)', fn: 'throttle position', ram: '$7F/$77', confidence: 'high', units: 'counts' },
  coolant:  { resource: 'AN4 (ADR1 of ADCTL=$14), range by $0440.4', fn: 'coolant temperature', ram: '$7E/$7B', confidence: 'channel medium-high, degC = x-128 INFERRED', units: 'degC' },
  an4alt:   { resource: 'AN4 while $0440.7 = 1', fn: 'second AN4 measurement (ratio -> BCCA -> $88)', ram: '$014B/$88', confidence: 'low', units: 'degC' },
  air:      { resource: 'AN5 (ADR2 of ADCTL=$14), range by $0440.5', fn: 'intake air temperature', ram: '$7D/$78', confidence: 'medium-high', units: 'degC' },
  an6:      { resource: 'AN6 (ADR3 of ADCTL=$14)', fn: 'never read by the firmware', ram: '-', confidence: 'high', units: 'counts' },
  o2_2:     { resource: 'AN7 (ADR4 of ADCTL=$14)', fn: 'O2 sensor 2 (INFERRED even-cylinder bank)', ram: '$7A', confidence: 'medium-high', units: 'V' },
  key:      { resource: '$0400 read bit6 (0 = key ON)', fn: 'ignition sense', confidence: 'medium-high' },
  relayFeed:{ resource: '$0400 read bit4 (1 = powered)', fn: 'ASD / relay feed sense (code 2C)', confidence: 'medium' },
  spiBusy:  { resource: '$0400 read bit3 (0 = ready)', fn: 'SPI smart-device handshake', confidence: 'high' },
  in0400b5: { resource: '$0400 read bit5', fn: 'unknown, only reported by SCI 1A 04', confidence: 'low' },
  in0400b7: { resource: '$0400 read bit7', fn: 'unknown, must be 0 for the injector test', confidence: 'low' },
  in0401hi: { resource: '$0401 read bits 7-4', fn: 'unknown (INFERRED ASIC injector channel status), 0 = OK', confidence: 'low' },
  injectorStatusOk: { resource: '$0405 read bit2 (1 = OK)', fn: 'injector driver status latch (table F613 DTCs)', confidence: 'medium-low' },
  smartReply: { resource: 'SPI MISO during the 61/62 frame -> $048B-$048E', fn: '$048C b7/b6 -> $85 switch inputs; $048E b2/b4/b7 -> codes 19/22/5C', confidence: 'medium (frame), low (meaning)' },
  ccdRxMessage: { resource: 'SPI MISO during the 93/80 CCD frame -> $048A-$048C', fn: 'received CCD message; ID low nibble 1 unlocks fuel ($F5.6/$F5.7)', confidence: 'low (meaning), high (code path)' },
  fdFeedbackMode: { resource: 'SPI MISO while $FD is shifted ($0440.2 low) -> $015C', fn: 'output-driver feedback (codes 0A/10/12/5D)', confidence: 'low' },
  vss:      { resource: 'TIC2 / PA1 falling edge', fn: 'vehicle speed sensor', confidence: 'high (channel); 8000 pulses/mile INFERRED' },
  crank:    { resource: 'TIC1 / PA2 rising edge', fn: 'crank position (20 edges / 720 deg)', confidence: 'high' },
  cam:      { resource: 'IRQ pin falling edge (OPTION.IRQE=1)', fn: 'cam / sync', confidence: 'medium' },
};

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

export class Inputs {
  constructor(m) {
    this.m = m;
    // analog engineering values (defaults = brief sec. 11 start-up recipe)
    this.mapCounts = 0xE8;       // AN0, counts (kPa unknown). GUESS: sea level engine off
    this.batteryV = 14.0;        // AN1, V*16 INFERRED -> E0
    this.o2_1V = 0.2;            // AN2
    this.tpsCounts = 0x30;       // AN3 GUESS closed throttle
    this.coolantC = 20;          // AN4 via inverse B800/B81B
    this.airC = 20;              // AN5 via inverse B800/B81B
    this.an4AltC = 20;           // AN4-alt via inverse BCCA ratio
    this.an6Counts = 0;          // AN6 (unused)
    this.o2_2V = 0.2;            // AN7
    this.raw = new Array(8).fill(null);   // raw-count overrides per channel (null = use the engineering value)
    this.an4AltRaw = null;       // raw override of the AN4-alt reading
    // discrete
    this.key = true;             // $0400.6 = 0 when ON
    this.relayFeed = true;       // $0400.4
    this.spiBusy = false;        // $0400.3
    this.in0400b5 = false; this.in0400b7 = false; this.in0400low = 0;
    this.in0401hi = 0; this.in0401low = 0;
    this.injectorStatusOk = true;          // $0405.2
    this.injectorStatusMode = 'level';     // 'level' | 'latched' (latched: sampled when $04 is written to $0405)
    this.smartReply = [0, 0, 0, 0];        // bytes clocked into $048B..$048E
    this.smartChecksumOk = true;
    // CCD message the smart device hands back during the E9F6 frame (3 bytes + sum). The firmware needs one with
    // ID low nibble = 1 (EAC1-EACA -> $F5.6), or ~2 s after key-on it sets $F5.5 and every running pulse width is 0
    // (theft/CCD fuel inhibit, B612 = $4C). GUESS: ID $21, data 00 00. null = no message (shows the inhibit).
    this.ccdRxMessage = [0x21, 0x00, 0x00];
    this.fdFeedbackMode = 'shift';         // 'shift' (previous byte, default) | 'echo' | 'value'
    this.fdFeedbackValue = 0;
    this.batteryConnected = true;          // keep-alive RAM 0000-0043 kept over a power cycle
    this._cache = new Map();
  }

  // ---- engineering-unit setters --------------------------------------------------------------------
  set(name, value) { this[name] = value; return this; }
  setRaw(ch, counts) { this.raw[ch] = counts === null || counts === undefined ? null : clamp8(counts); return this; }
  setVolts(ch, v) { return this.setRaw(ch, v * 255 / 5); }
  /** Smart-device switch-input bits ($048C b7/b6) and status bits ($048E). */
  setSmartBit(byteIndex, bit, on) {
    const r = this.smartReply; r[byteIndex] = on ? (r[byteIndex] | (1 << bit)) : (r[byteIndex] & ~(1 << bit)); return this;
  }

  // ---- thermistor model (brief 4.1): invert the curve selected by the live latch bit --------------
  tempToCounts(table, degC) {
    const target = clamp8(degC + 128);
    const key = table * 1000 + target;
    let best = this._cache.get(key);
    if (best !== undefined) return best;
    const rd = (a) => this.m.romByte(a);
    let bestErr = 1e9; best = 0x80;
    for (let x = 0x1A; x <= 0xFD; x++) {      // stay inside the valid raw range 1A..FD (codes outside)
      const e = Math.abs(evalCurveEE4B(rd, table, x) - target);
      if (e < bestErr) { bestErr = e; best = x; }
    }
    this._cache.set(key, best);
    return best;
  }
  coolantCounts() { return this.tempToCounts((this.m.asic.latch & 0x10) ? 0xB800 : 0xB81B, this.coolantC); }
  airCounts() { return this.tempToCounts((this.m.asic.latch & 0x20) ? 0xB800 : 0xB81B, this.airC); }
  /**
   * AN4 with $0440.7 = 1: the count B whose ratio, computed exactly as the firmware does (95B2-95D7 / BC68-BC95:
   * P = A*B, q = P / (A - B + round(P/256)), q < 256), maps through curve BCCA to an4AltC. A = the plain AN4
   * reading, which the firmware takes with $0440.4 = 0 (9BF3-9C07), i.e. the coolant count in the B81B range.
   */
  an4AltCounts() {
    if (this.an4AltRaw !== null) return clamp8(this.an4AltRaw);
    const A = this.raw[4] !== null ? this.raw[4] : this.tempToCounts(0xB81B, this.coolantC);
    const key = `alt${A}:${clamp8(this.an4AltC + 128)}`;
    const hit = this._cache.get(key);
    if (hit !== undefined) return hit;
    const rd = (a) => this.m.romByte(a);
    const target = clamp8(this.an4AltC + 128);
    let best = A >> 1, bestErr = 1e9;
    for (let B = 0; B < A; B++) {
      const q = an4AltRatio(A, B);
      if (q === null) continue;
      const e = Math.abs(evalCurveEE4B(rd, 0xBCCA, q) - target);
      if (e < bestErr) { bestErr = e; best = B; }
    }
    this._cache.set(key, best);
    return best;
  }

  /** Value the ADC converts on channel ch (0..7) right now. */
  adc(ch) {
    if (ch === 4 && (this.m.asic.latch & 0x80)) return this.an4AltCounts();
    const r = this.raw[ch];
    if (r !== null) return r;
    switch (ch) {
      case 0: return clamp8(this.mapCounts);
      case 1: return clamp8(this.batteryV * 16);
      case 2: return clamp8(this.o2_1V * 255 / 5);
      case 3: return clamp8(this.tpsCounts);
      case 4: return this.coolantCounts();
      case 5: return this.airCounts();
      case 6: return clamp8(this.an6Counts);
      case 7: return clamp8(this.o2_2V * 255 / 5);
    }
    return 0;  // AN8+ (not bonded)
  }

  snapshot() {
    const o = {};
    for (const k of Object.keys(this)) if (k !== 'm' && k[0] !== '_') o[k] = Array.isArray(this[k]) ? this[k].slice() : this[k];
    o.adcCounts = Array.from({ length: 8 }, (_, ch) => this.adc(ch));
    return o;
  }
}
