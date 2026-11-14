// Flash-write worker example (machine/flash_worker.js): the command-20 worker programs calibration bytes below 9400
// with the firmware's own JEDEC sequence, and the key-off checksum stays good.
import { ViperMachine } from '../machine/viper_machine.js';
import { keyOnEngineOff, keyOff } from '../machine/scenarios.js';
import { runFlashWriteExample, exampleEdit, checksumPatch, programmable, workerHeader, FLASH_WORKER_T0 } from '../machine/flash_worker.js';
import { makeChecker, hex } from './review/util.mjs';

const { check, done } = makeChecker('flash-write worker example');
const codes = (m) => m.sciRequest([0x10], { timeoutMs: 1500 }).slice(1, -2);
const keyCycle = (m) => { keyOff(m, { ms: 8000 }); m.inputs.key = true; m.run(1500); return codes(m); };
const boot = () => { const m = new ViperMachine({ cop: true }); keyOnEngineOff(m, 1000); return m; };

{
  const { L, sum } = workerHeader();
  check('worker is 39 bytes, sum BD, ends in RTS, starts with CLR $00F1', L === 0x27 && sum === 0xBD && FLASH_WORKER_T0[0] === 0x7F && FLASH_WORKER_T0.at(-1) === 0x39);
  check('programmable(): only 1 -> 0 bits', programmable(0xDB, 0xDA) && !programmable(0xDB, 0xDC) && !programmable(0xE8, 0xEA));
}
{
  const m = boot();
  const patches = exampleEdit((a) => m.romByte(a));
  check('example edits both VE copies and one spare filler byte', patches.length === 3 && patches[0].addr === 0x83FF && patches[1].addr === 0x849B && patches[2].addr === 0x93F0 && patches[2].data === 0x01,
    patches.map((p) => `${p.addr.toString(16)}:${p.old.toString(16)}>${p.data.toString(16)}`).join(' '));
  const r = runFlashWriteExample(m, { patches });
  check('every request got the expected echo and reply', r.ok && r.steps.every((s) => s.ok), `${r.steps.length} requests`);
  check('both VE cells read DA, in memory and in the image', m.mem[0x83FF] === 0xDA && m.mem[0x849B] === 0xDA && m.rom[0x03FF] === 0xDA);
  check('the worker defused itself and nothing faulted', m.mem[0xF1] === 0 && m.faults.length === 0, m.faults.map((f) => f.kind).join(','));
  check('three flash programs, none anywhere else', m.flash.writes === 3);
  const c = keyCycle(m);
  check('key-off checksum passes: no code 02', !c.includes(0x02), hex(c));
}
{
  const m = boot();
  const patches = exampleEdit((a) => m.romByte(a)).slice(0, 2);
  runFlashWriteExample(m, { patches });
  const c = keyCycle(m);
  check('without the compensation the next key-off stores code 02', c.includes(0x02), hex(c));
  const fix = checksumPatch((a) => m.romByte(a), [{ addr: 0x800D, data: (m.romByte(0x800D) + 2) & 0xFF }]);   // pretend delta = +2 = what is missing
  check('checksumPatch falls back to a spare FF byte when 800C would need a bit set', fix.addr === 0x93F0, `${fix.addr.toString(16)} ${fix.data.toString(16)}`);
}
{
  const m = boot();
  const r = runFlashWriteExample(m, { patches: [{ addr: 0x83FF, old: 0xDB, data: 0xDC, label: 'raise' }] });
  check('a 0 -> 1 edit is not taken: the cell ends as old AND new', !r.ok && m.rom[0x03FF] === (0xDB & 0xDC), m.rom[0x03FF].toString(16));
  check('its poll runs to the bound and trips the COP when it is armed', m.faults.some((f) => f.kind === 'cop-timeout'));
}
done();
