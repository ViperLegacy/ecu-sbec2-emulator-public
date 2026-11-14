> Live: https://sbec2-emulator.viperecu.com/  
> Published from the private ViperLegacy/ecu repo (ecu/sbec2/viper/emulator, 4fae062) by `tools/publish_public.mjs`; do not edit here. Paths like `../data/...` or `../findings/...` below refer to that repo.

# 68HC11 emulator (SBEC2 board model)

A JavaScript 68HC11 emulator with the board of a Chrysler SBEC2 engine controller around it. The bundled
image is the 1995 Dodge Viper RT/10 PCM, part 04763555, and all the annotations (RAM names, maps, fault
names, SCI decoding, engine readouts) belong to that firmware. You can load another flash dump; see
"Loading another dump" below. With the bundled image it runs the
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
node tools/coverage.mjs                              # firmware execution coverage (81 %); gaps explained in ../findings/COVERAGE_DIG.txt
node tools/flash_write_example.mjs                    # command-20 worker programs a VE cell + checksum byte (emulator only; --no-fix, --raise)
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

## Loading another dump

- **GUI:** Save / load -> "Flash dump ↑ file". The file must be 32768 bytes (what the CPU sees at 8000-FFFF) or
  65536 bytes (a 0000-FFFF map; the upper half is used), and its reset vector must point into 8000-FFFF. The image
  stays in the browser (local storage), is never uploaded, and the page reloads onto it. "Bundled image" goes back.
- **Headless:** `node run_headless.mjs --image some.bin [--eeprom ee.bin] --ms 2000 --sci "16 80"`.
- **API:** `new ViperMachine({ image: normaliseImage(bytes), imageName })`.

The EEPROM (B600-B7FF) defaults to the bytes at that address in the loaded image; load a 512-byte EEPROM file to
override it. What you get depends on the image (`machine.imageInfo`):

| Image | Treated as | What applies |
|---|---|---|
| identical to the bundled one | `04763555`, stock | everything |
| same code, different bytes only in 8000-93FF or B600-B7FF | `04763555`, other calibration | everything; the firmware uses the loaded tables, but the Maps panel still lists the bundled values |
| anything else | `generic` | CPU, timer, SCI, SPI, ADC, EEPROM, the I/O at 0400 and the raw views. Not the idle skip, pass counter, RAM names, engine readouts, maps, fault names, SCI decoding, scenarios or tuning |

The board model is the Viper SBEC2's. Other SBEC2 firmware expecting the same hardware gets furthest: the Jeep
2.5 L image 56029302 boots and answers `16 80` with its own part number; 56026948 runs but stays silent on SCI.

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
gui/                 app.js (loop and toolbar) + workspaces for scope, inputs, outputs, SCI, RAM, maps, tuning, disassembly and log
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
- **Disassembly:** the listing around the PC, following it live (routine names, labels, RAM and register
  names; code outside the analysis code map, such as the SCI 20 worker at `$0492`, is decoded on the fly).
  Beside it: registers and CCR flags (changes highlighted while paused), the current instruction's operand
  address and value and whether its branch is taken, the memory behind X / Y / SP, return addresses found on
  the stack, and an optional trace of the last 64 instructions. Click the gutter (or F9) for a breakpoint;
  **Step**, **Step over** and **Run to selected** (or double-click a row) pause the emulation.
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
| E clock | 2 MHz, measured indirectly on the car: one SCI 15 read took 33.1 ms = 3 main-loop passes (`eClock`) |
| Units | rpm, coolant degC, 4 us tick, O2 volts, speed (`$84` = mph x 2, 8000 pulses/mile): high. Spark 0.5 deg/count, battery counts/16: medium-high. MAP kPa: medium. Intake-air curve: unverified |
| Diagnostic line | the scan tool talks to the Ignition Control Module at 7812.5 8N1, which relays to the PCM's 62500-baud 9-bit SCI (1995 wiring diagrams). The model passes bytes at the MCU's rate; the tester-side rate after SCI 12 is unknown |
| Side-channel device | the Ignition Control Module: fires the 5 coils and injectors 1 and 5. Its frame timing is not modelled; default reply is "no faults" (GUI can inject status bits) |
| Crank / cam shapes | 20 TIC1 edges per 720 deg and the single / double / single cam pattern match the 1995 manual. Edge spacing (default even; `pairedEdgeAngles(18)` is a GUESS), polarity and phase to TDC: unmeasured |
| Cylinder numbering | slot -> cylinder 5 8 7 2 1 10 9 4 3 6: high (three independent derivations). Coil number to cylinder pair: inferred |
| Physical outputs | fans, A/C clutch, ASD, MIL, skip-shift, purge identified from their control laws (0 = ON except purge). `$FD` b2 (reverse lockout?), `$FC` b3, `$FD` b3, `$0400` b5/b7: still open |
| ASD feed / handshake | `$0400.4` follows the ASD command after `asdPullInMs` (3 ms **GUESS**); `$0400.3` is busy `spiBusyUs` (20 us **GUESS**) after each smart-device byte. The firmware waits for both |
| Flash writes | JEDEC unlock + one data store programs a byte, as the 1B monitor does; write time (5 ms) and part type are **GUESS** |
| Engine plant | none: rpm ignores the idle-air motor, and the default O2 plant is perfect, so adaptive cells only learn with a fuelling error (`inputs.o2BiasCounts`) |
| O2 sensors | default is a switching model driven by the firmware's own fuel trim (**GUESS** plant, `inputs.o2Mode`); `fixed` holds the slider value |
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
