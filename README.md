> Live: https://sbec2-emulator.viperecu.com/  
> Published from the private ViperLegacy/ecu repo (ecu/sbec2/viper/emulator, a073a02) by `tools/publish_public.mjs`; do not edit here. Paths like `../data/...` or `../findings/...` below refer to that repo.

# Viper 04763555 PCM emulator

A JavaScript emulator of the 1995 Dodge Viper RT/10 SBEC2 PCM (68HC11, part 04763555). It runs the
real flash image (`../dumps/VIPER_04763555_8000-FFFF.bin`, SHA-256 `c6f88240...`) instruction by
instruction, with the board around it modelled from `../data/EMULATOR_BRIEF.md`, and a browser GUI
with inputs and outputs.

**No PCM connector pin is known.** The 1995 Viper harness is not the 1997 JTEC harness. Every input
and output is named by MCU resource (AN3, TIC1/PA2, `$0400.4`, SPI `$FD` bit5, OC3/PA5 ...), plus an
inferred function and the brief's confidence tag (high/medium/low, INFERRED, GUESS, ASSUMED).

Pure ES modules, no npm dependencies. It runs in Node >= 18 and in a browser served over http.

## Run

From `ecu/sbec2/viper`:

```
node emulator/serve.mjs                 # then open http://localhost:8732/
node emulator/serve.mjs --port 9000     # or PORT / HOST environment variables (loopback by default)
```

Headless (from `ecu/sbec2/viper/emulator`):

```
node run_headless.mjs --scenario koeo --ms 3000
node run_headless.mjs --scenario crank --rpm 250 --ms 2000
node run_headless.mjs --scenario idle --rpm 800 --ms 5000 --sci "16 80" --sci "10"
node run_headless.mjs --scenario run --rpm 3000 --map 80 --mph 50 --ms 2000 --events 20 --types inj,spark
node run_headless.mjs --scenario revlimit --json
node run_headless.mjs --sci "14 05" --count 10          # stream: 10 reply bytes after the echo
```

Scenarios are `koeo`, `crank`, `idle`, `run`, `revlimit` and `keyoff`. Other options are listed in
the header of `run_headless.mjs`: `--coolant`, `--air`, `--battery`, `--tps`, `--cam`, `--watch`,
`--cop`, `--no-ccd` and `--json`.

Tests (from `ecu/sbec2/viper/emulator`):

```
for f in tests/*.mjs tests/review/*.mjs; do node $f; done
```

| Suite | Result (2026-11-12) |
|---|---|
| cpu.test.mjs | 657 passed |
| cpu_crosscheck.test.mjs | 2190 passed |
| viper_smoke.test.mjs | PASS |
| machine.test.mjs | 97 passed |
| gui_smoke.test.mjs | 56 passed |
| gui_review.test.mjs | 15 passed |
| review/*.mjs | 266 passed in 10 files (`util.mjs` holds helpers only) |

## Architecture

```
hc11/cpu.js          68HC11 core: every opcode, cycle counts, interrupts, WAI/STOP, illegal trap
machine/
  viper_machine.js   memory map, bus, event scheduler, run()/runCycles(), idle skip, log, faults
  timer.js           TCNT, TIC1-3, TOC1-5, CFORC, flags, PA pins
  adc.js sci.js spi.js   ADC; 9-bit SCI with diagnostic (R8/T8=0) and side channel (=1); SPI peers
  asic.js            external I/O ASIC 0400-040F; latch 0440
  eeprom.js          B600-B7FF with PPROG/BPROT
  inputs.js          engineering setters -> ADC counts and port bits; INPUT_INFO labels
  outputs.js         injectors (10 slots, 4 paths), spark frames, lamps/relays; FC/FD/latch bit tables
  stimulus.js        crank (20 TIC1 edges per 720 deg) and cam (IRQ) generator, rpm ramps, VSS
  scenarios.js       key-on, crank, start, key-off helpers
rom/make_rom.mjs     builds rom/viper_rom.js (image + EEPROM + data/*.json as one module, no fetch)
gui/                 app.js (loop and toolbar) + workspaces for scope, inputs, outputs, SCI, RAM, maps, tuning, and log
serve.mjs            static http server for the GUI
```

`new ViperMachine()` loads the bundled image and EEPROM, then resets to vector FFFE -> 944E.
`m.run(ms)` advances emulated time. Peripherals and stimulus edges land on exact E cycles.
The 9E0E 11 ms wait loop is skipped forward by whole iterations, with identical results (tested).
`m.sciRequest([..])` behaves like a scan tool: it waits for each echo and returns echo plus reply.
The API reference is the header comment of `machine/viper_machine.js`.

The GUI runs the machine on the main thread. The sidebar switches workspaces while keeping scenario controls
and engine telemetry visible. Related views within a workspace have their own tabs.

- **Scope:** crank, cam, injector, spark and vehicle speed traces.
- **Inputs:** analog AN0-AN7, crank/cam/speed stimulus, discrete `$0400/$0401/$0405`, SPI
  smart-device replies, side-channel status, machine options.
- **Outputs:** 10 injectors with inferred cylinder, spark, engine state, AIS, tach, OC pins,
  `$FC/$FD/$0440` bits and fault codes.
- **SCI scan tool:** every command in `sci_commands.json`. Unsafe commands sit behind a switch.
- **RAM watch:** the brief sec. 9 list plus a hexdump.
- **Maps:** all 88 tables, as heat maps and curves with live operating points.
- **Tuning:** base spark at `$80B1` in degrees BTDC (inferred 0.5° per raw count) and fuel VE at
  `$83B3` as a multiplier (`1 + raw / 256`). Both show raw counts. Select a cell, stage an edit and
  use **Stock**, **Draft** or **Delta** to review it. **Apply to emulator** updates the running
  session, including the matching VE table at `$844F`. **Revert cell** stages the stock value.
  Applying a draft adjusts the emulator image's checksum at `$800C` and preserves the
  identification bytes, including the expected sum at `$8005`. Reloading the page starts
  a fresh calibration session.
- **Event log / CPU:** the log, CPU state and machine faults.

Toolbar: speed, step, reset, power cycle, key cycle, the six scenarios and EEPROM/keep-alive
save/load. `window.viperApp.m` is the machine in the browser console.

## Ground truth it reproduces

The car's answers, byte-exact (machine.test, review/sci_all, gui_review):

| Request | Reply |
|---|---|
| `16 80` | `16 80 04 76 35 55 9A` |
| `10` | `10 FE 0E` |
| `11` | `11 00 00` |
| `15 20 02` | `15 20 02 02` (unmapped bus returns the low address byte) |
| `15 hi lo` (flash) | the image byte, e.g. `15 80 05` -> `55` |

The firmware behaviour checked against brief sec. 11:

- MIL bulb check.
- AIS homing on a cold init.
- Crank sync on the generator slot from 40 starting phases.
- Cranking PW `$8D` on all slots, then the running chain above 600 rpm.
- rpm16 within 0.2 % of the stimulus over 0-7000 rpm.
- Rev-limit cut `$50.0`.
- DTCs set exactly at the image thresholds.
- The key-off power-down, with keep-alive RAM kept when the battery is connected.
- 60 s runs with no fault and SP back at 01FF on every pass.

## Modelled vs guessed

Everything listed here is shown in the GUI with its tag.

| Item | Status |
|---|---|
| E clock | 2 MHz, **ASSUMED** (one constant, `eClock`); every ms/rpm/baud figure depends on it |
| Units | MAP kPa, thermistor curves, battery divider (V*16), spark 0.5 deg/count, VSS pulses/mile, `$84`: **not measured** |
| Diagnostic line | how 62500-baud 9-bit frames become the car's 7812.5 8N1 line is unknown; the model passes bytes at the MCU's rate |
| Side-channel device | identity and replies unknown; default reply is "no faults" (GUI can inject status bits) |
| Crank / cam shapes | 20 even TIC1 edges per 720 deg and a **candidate** cam pattern chosen to satisfy the sync rules; real wheel unknown |
| Cylinder numbering | slot -> cylinder 5 8 7 2 1 10 9 4 3 6 is **INFERRED** (medium) |
| Physical outputs | `$FC` b4/b5, `$FD` b2/b6/b7, `$0440` b3, `$0400` b0/b5/b7: meaning unknown |
| COP | CONFIG.NOCOP unknown; COP model off by default (`cop: true` / GUI option) |
| CCD message | the 93/80 SPI reply is a **GUESS** `21 00 00`; with none, fuel is inhibited ~2 s after key-on (`ccdRxMessage = null`) |
| Power-on RAM | random fill = battery never connected (cold init); all-zero RAM passes the keep-alive sum and stays warm |
| Injector PW scale | 4 us ticks on every path is assumed; ASIC/SPI/SCI paths not verified |

Open items from the reviews:

- Frame time at max speed was not measured. The browser pane was hidden, which pauses
  requestAnimationFrame. Event-loop latency was about 19 ms median and 81 ms worst.
- The alias commands `$90-$A3` work in the machine and are refused by the unsafe gate when the
  aliased command is unsafe. The SCI panel's command list does not show them; type them as hex.
- Several of the original machine tests only check a flag or that nothing crashed. The
  `tests/review` suite adds value-level checks.

## Regenerating the ROM bundle

`rom/viper_rom.js` embeds the image, the EEPROM and `data/*.json`. Rebuild it after any change to
those files:

```
node emulator/rom/make_rom.mjs        # from ecu/sbec2/viper; refuses to write if the image SHA-256 differs
```
