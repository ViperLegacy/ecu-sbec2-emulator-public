// Loading another flash dump: normalisation, classification against the bundled image, generic-profile machine.
//   node emulator/tests/image_load.test.mjs
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ViperMachine, normaliseImage, classifyImage } from '../machine/viper_machine.js';
import { loadImage, loadEeprom } from '../rom/viper_rom.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '   ' + info : ''}`); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const stock = loadImage();
check('stock image classified stock / 04763555', classifyImage(stock).stock && classifyImage(stock).profile === '04763555');
const cal = stock.slice(); cal[0x00B4] ^= 0x01;                      // 80B4: inside the calibration block
check('calibration-only change: same code, not stock', !classifyImage(cal).stock && classifyImage(cal).sameCode);
const ee = stock.slice(); ee[0x3600] ^= 0xFF;                        // B600: EEPROM overlay
check('EEPROM-only change: same code', classifyImage(ee).sameCode);
const code = stock.slice(); code[0x2000] ^= 0x01;                    // A000: code
check('code change: generic', classifyImage(code).profile === 'generic');

check('normalise: 64 K map uses the upper half', (() => { const big = new Uint8Array(0x10000); big.set(stock, 0x8000); return normaliseImage(big).every((b, i) => b === stock[i]); })());
check('normalise: wrong size refused', throws(() => normaliseImage(new Uint8Array(1000))));
check('normalise: blank image (vector FFFF) refused', throws(() => normaliseImage(new Uint8Array(0x8000).fill(0xFF))));
check('normalise: vector below 8000 refused', throws(() => { const b = new Uint8Array(0x8000); b[0x7FFE] = 0x10; normaliseImage(b); }));

// a tiny foreign program: lds #$01FF ; ldaa #$5A ; staa $0010 ; inc $0011 ; bra *-3 (loop on the inc)
const tiny = new Uint8Array(0x8000).fill(0xFF);
tiny.set([0x8E, 0x01, 0xFF, 0x86, 0x5A, 0x97, 0x10, 0x7C, 0x00, 0x11, 0x20, 0xFB], 0);
tiny[0x7FFE] = 0x80; tiny[0x7FFF] = 0x00;
tiny[0x3600] = 0xA5;                                                  // its own "EEPROM" byte at B600
const g = new ViperMachine({ image: normaliseImage(tiny), imageName: 'tiny.bin', ramFill: 'zero' });
g.run(5);
check('generic machine: profile and name', g.generic && g.imageInfo.name === 'tiny.bin' && g.imageInfo.profile === 'generic');
check('generic machine: idle skip off', g.idleSkip === false);
check('generic machine: program ran', g.ram[0x10] === 0x5A && g.cpu.pc >= 0x8007 && g.cpu.pc <= 0x800A, `pc ${g.cpu.pc.toString(16)} $11=${g.ram[0x11]}`);
check('generic machine: EEPROM taken from the image', g.getEeprom()[0] === 0xA5 && g.peek(0xB600) === 0xA5);
check('generic machine: no faults', g.faults.length === 0, g.faults.map((f) => f.kind).join(','));

const v = new ViperMachine();
check('bundled machine unchanged: stock, idle skip on, bundled EEPROM', v.imageInfo.stock && v.idleSkip && v.getEeprom().every((b, i) => b === loadEeprom()[i]));
const vc = new ViperMachine({ image: cal, imageName: 'cal.bin' });
vc.run(1500);
check('same-code image keeps the 04763555 profile and answers 16 80', !vc.generic && vc.idleSkip && vc.sciRequest([0x16, 0x80]).slice(2, 6).join(',') === '4,118,53,85');

// optional: the Jeep 2.5 L SBEC2 image from the private research folder (not in the public copy)
const jeep = fileURLToPath(new URL('../../../research/AR1972-jeep_2.5L/56029302/ORIG.BIN', import.meta.url));
if (existsSync(jeep)) {
  const j = new ViperMachine({ image: normaliseImage(readFileSync(jeep)), imageName: '56029302' });
  j.run(2000);
  const r = j.sciRequest([0x16, 0x80], { timeoutMs: 500 });
  check('Jeep 56029302 boots and reports its part number', j.generic && r.slice(2, 6).map((b) => b.toString(16).padStart(2, '0')).join('') === '56029302', r.map((b) => b.toString(16)).join(' '));
} else console.log('  skip Jeep image (research folder not present)');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
