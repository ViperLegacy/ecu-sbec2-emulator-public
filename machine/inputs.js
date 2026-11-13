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
  map:      { resource: 'AN0 (ADR1 of ADCTL=$10)', fn: 'MAP sensor', ram: '$76/$C6', confidence: 'channel high; kPa ~ 8 + 0.38 x counts (EXTERNAL 1992 manual sensor table, medium)', units: 'counts' },
  battery:  { resource: 'AN1 (ADR2 of ADCTL=$10)', fn: 'battery voltage', ram: '$80', confidence: 'channel high; V = counts/16 (16.0-16.2 counts/V, medium-high)', units: 'V' },
  o2_1:     { resource: 'AN2 (ADR3 of ADCTL=$10)', fn: 'O2 sensor, left bank (odd cylinders); rich >= 0.47 V', ram: '$79', confidence: 'high', units: 'V' },
  tps:      { resource: 'AN3 (ADR4 of ADCTL=$10)', fn: 'throttle position', ram: '$7F/$77', confidence: 'high', units: 'counts' },
  coolant:  { resource: 'AN4 (ADR1 of ADCTL=$14), range by $0440.4', fn: 'coolant temperature', ram: '$7E/$7B', confidence: 'high; degC = x-128 matches the 1992 manual thermistor curve within 3 C', units: 'degC' },
  an4alt:   { resource: 'AN4 while $0440.7 = 1', fn: 'second thermistor switched in parallel by $0440.7 (-> BCCA -> $88, sent on CCD only)', ram: '$014B/$88', confidence: 'medium (which sensor: unknown)', units: 'degC' },
  air:      { resource: 'AN5 (ADR2 of ADCTL=$14), range by $0440.5', fn: 'intake air temperature', ram: '$7D/$78', confidence: 'channel high; real sensor curve unverified (firmware uses the coolant tables)', units: 'degC' },
  an6:      { resource: 'AN6 (ADR3 of ADCTL=$14)', fn: 'never read by the firmware', ram: '-', confidence: 'high', units: 'counts' },
  o2_2:     { resource: 'AN7 (ADR4 of ADCTL=$14)', fn: 'O2 sensor, right bank (even cylinders)', ram: '$7A', confidence: 'high', units: 'V' },
  key:      { resource: '$0400 read bit6 (0 = key ON)', fn: 'ignition sense', confidence: 'medium-high' },
  relayFeed:{ resource: '$0400 read bit4 (1 = powered)', fn: 'ASD relay output sense: follows the ASD command $FD.4 after a pull-in delay (the firmware waits up to 10 ms for it at 9ABC). Unticked = feed missing (code 2C with the engine turning)', confidence: 'high (code path); pull-in time GUESS' },
  spiBusy:  { resource: '$0400 read bit3 (0 = ready)', fn: 'SPI smart-device handshake stuck busy (first byte of every frame times out, code 44)', confidence: 'high' },
  spiBusyUs: { resource: '$0400 read bit3 after each $0402.3 strobe', fn: 'per-byte busy time of the smart device; the firmware polls up to $40 / $0B times (about 6 us each)', confidence: 'code path high; real time unknown (GUESS 20 us)' },
  spiStallAfter: { resource: '$0400 read bit3', fn: 'fault: the smart device stays busy after byte N of a frame (mid-frame time-out)', confidence: 'model only' },
  o2Open:   { resource: 'AN2 / AN7 with test bias $0440.3', fn: 'O2 sensor open circuit: reads inside $14..$22 with the bias off and >= $4D with $0440.3 = 1 (codes 41 left / 20 right after about 3.5 min warm)', confidence: 'thresholds high (image); electrical behaviour inferred from them' },
  xirq:     { resource: 'XIRQ pin', fn: 'non-maskable interrupt; the firmware unmasks X at 9481 and restarts through 9400. What drives the pin is unknown', confidence: 'low' },
  in0400b5: { resource: '$0400 read bit5', fn: 'unknown, only reported by SCI 1A 04', confidence: 'low' },
  in0400b7: { resource: '$0400 read bit7', fn: 'unknown (injector output state?), must be 0 for the injector test', confidence: 'low' },
  in0401hi: { resource: '$0401 read bits 7-4', fn: 'unknown (INFERRED ASIC injector channel status), 0 = OK', confidence: 'low' },
  injectorStatusOk: { resource: '$0405 read bit2 (1 = OK)', fn: 'injector driver status latch (table F613 DTCs)', confidence: 'medium-low' },
  smartReply: { resource: 'SPI MISO during the 61/62 frame -> $048B-$048E', fn: '$048C -> $85 switch byte (b7: A/C request, 0 = requested); $048E driver faults b2/b4/b7 -> codes 19 (AIS) / 22 (skip-shift) / 5C (fan)', confidence: 'high (mapping), medium-high (A/C bit), low (other switch bits)' },
  ccdRxMessage: { resource: 'SPI MISO during the 93/80 CCD frame -> $048A-$048C', fn: 'received CCD message; ID low nibble 1 unlocks fuel ($F5.6/$F5.7)', confidence: 'low (meaning), high (code path)' },
  o2Mode:   { resource: 'AN2 / AN7 model', fn: 'switching = follows the firmware fuel trim per bank (GUESS plant); fixed = slider value', confidence: 'model only' },
  fdFeedbackMode: { resource: 'SPI MISO while $FD is shifted ($0440.2 low) -> $015C', fn: 'output-driver feedback (codes 0A/10/12/5D). XOR mask = one stuck output: bit0 code 10 (A/C clutch), bit1 5D (high fan), bit4 0A (ASD), bit5 12 (purge)', confidence: 'low' },
  vss:      { resource: 'TIC2 / PA1 falling edge', fn: 'vehicle speed sensor', confidence: 'high; 8000 pulses/mile from the firmware constant 115,200,000 (A4E7); the signal reaches the PCM through the ICM' },
  crank:    { resource: 'TIC1 / PA2 rising edge', fn: 'crank position (20 edges / 720 deg)', confidence: 'high' },
  cam:      { resource: 'IRQ pin falling edge (OPTION.IRQE=1)', fn: 'cam / sync (1995 sprocket: single, double, single slot)', confidence: 'high (role and pulse counts); polarity and phase unmeasured' },
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
    // O2 model. 'switching' (default): each sensor reads rich or lean from the firmware's own fuel trim for its bank
    // (short-term $A5/$A6 + adaptive $A3/$A4 against o2BiasCounts), after o2DelayMs, so closed loop limit-cycles as on
    // an engine. This is a GUESS plant, not the car: it only closes the loop the firmware expects. 'fixed': the
    // sensors hold o2_1V / o2_2V (a held value makes the trims saturate and the no-switch watchdog fire, codes 03/04).
    this.o2Mode = 'switching';
    this.o2BiasCounts = 0;       // trim (1/256 fuel) at which the mixture is stoichiometric; + = engine lean at neutral
    this.o2DelayMs = 150;        // transport + sensor delay
    this.o2RichV = 0.8; this.o2LeanV = 0.1;
    this._o2 = [{ want: false, level: false, t: 0 }, { want: false, level: false, t: 0 }];
    this.raw = new Array(8).fill(null);   // raw-count overrides per channel (null = use the engineering value)
    this.an4AltRaw = null;       // raw override of the AN4-alt reading
    // discrete
    this.key = true;             // $0400.6 = 0 when ON
    this.relayFeed = true;       // $0400.4 healthy. false = the feed never comes up
    // 'follow' (default): $0400.4 is 1 only while the ASD relay is commanded ($FD.4 = 0), asdPullInMs after the
    // command (GUESS). 'level': the old static level (always 1 while relayFeed is true).
    this.relayFeedMode = 'follow';
    this.asdPullInMs = 3;
    this.spiBusy = false;        // $0400.3 stuck busy
    this.spiBusyUs = 20;         // busy after each strobed byte (GUESS; under the 11-poll limit of about 66 us)
    this.spiStallAfter = null;   // fault: stay busy after the Nth strobed byte of a frame (1 = after the first)
    this.o2Open = [false, false];            // open-circuit sensor per bank (0 = AN2 left, 1 = AN7 right)
    this.o2OpenCounts = 0x1B;                // open, bias off: inside the firmware window $14..$22
    this.o2OpenBiasedCounts = 0x60;          // open, $0440.3 = 1: above the pass limit $4D
    this.xirq = false;                       // XIRQ pin asserted (see ViperMachine.pulseXirq)
    this.in0400b5 = false; this.in0400b7 = false; this.in0400low = 0;
    this.in0401hi = 0; this.in0401low = 0;
    this.injectorStatusOk = true;          // $0405.2
    this.injectorStatusMode = 'level';     // 'level' | 'latched' (latched: sampled when $04 is written to $0405)
    // bytes clocked into $048B..$048E. $048C bit7 = 0 means A/C requested (9F41): default to not requested, or the
    // clutch engages and the low fan runs after every start
    this.smartReply = [0, 0x80, 0, 0];
    this.smartChecksumOk = true;
    // CCD message the smart device hands back during the E9F6 frame (3 bytes + sum). The firmware needs one with
    // ID low nibble = 1 (EAC1-EACA -> $F5.6), or ~2 s after key-on it sets $F5.5 and every running pulse width is 0
    // (theft/CCD fuel inhibit, B612 = $4C). GUESS: ID $21, data 00 00. null = no message (shows the inhibit).
    this.ccdRxMessage = [0x21, 0x00, 0x00];
    this.fdFeedbackMode = 'shift';         // 'shift' (previous byte, default) | 'echo' | 'value'
    this.fdFeedbackValue = 0;
    this.fdFeedbackXor = 0;                // 'shift' mode: bits that read back inverted (a stuck output)
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
    if ((ch === 2 && this.o2Open[0]) || (ch === 7 && this.o2Open[1])) return clamp8((this.m.asic.latch & 0x08) ? this.o2OpenBiasedCounts : this.o2OpenCounts);
    switch (ch) {
      case 0: return clamp8(this.mapCounts);
      case 1: return clamp8(this.batteryV * 16);
      case 2: return clamp8(this._o2Volts(0, this.o2_1V) * 255 / 5);
      case 3: return clamp8(this.tpsCounts);
      case 4: return this.coolantCounts();
      case 5: return this.airCounts();
      case 6: return clamp8(this.an6Counts);
      case 7: return clamp8(this._o2Volts(1, this.o2_2V) * 255 / 5);
    }
    return 0;  // AN8+ (not bonded)
  }

  /** Sensor voltage for bank 0 (AN2, left) / 1 (AN7, right). */
  _o2Volts(bank, fixedV) {
    if (this.o2Mode !== 'switching') return fixedV;
    const m = this.m, ram = m.ram, s8 = (v) => (v & 0x80 ? v - 256 : v);
    const trim = s8(ram[0xA5 + bank]) + s8(ram[0xA3 + bank]);
    const st = this._o2[bank], now = m.cpu.cycles;
    const want = trim > this.o2BiasCounts;
    if (want !== st.want) { st.want = want; st.t = now; }
    if (st.level !== st.want && now - st.t >= this.o2DelayMs * m.eClock / 1000) st.level = st.want;
    return st.level ? this.o2RichV : this.o2LeanV;
  }

  snapshot() {
    const o = {};
    for (const k of Object.keys(this)) if (k !== 'm' && k[0] !== '_') o[k] = Array.isArray(this[k]) ? this[k].slice() : this[k];
    o.adcCounts = Array.from({ length: 8 }, (_, ch) => this.adc(ch));
    return o;
  }
}
