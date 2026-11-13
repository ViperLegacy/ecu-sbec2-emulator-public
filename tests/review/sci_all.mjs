// Every non-dangerous SCI command of sci_commands.json against its documented reply format, plus 14 nn for every
// nn 01-36 compared with RAM at [D9D6+nn] (entry FF = no data byte), using a RAM snapshot taken when each byte left.
import { ViperMachine } from '../../machine/viper_machine.js';
import { makeChecker, hex, hx, eq } from './util.mjs';
const { check, done } = makeChecker('SCI command set');
const m = new ViperMachine();
m.run(3000);
const img = (a) => m.romByte(a);
// RAM snapshot at every diagnostic byte the PCM sends
const snaps = [];
m.on('diagTx', () => { snaps.push(m.mem.slice(0, 0x200)); });
function req(bytes, opts) { snaps.length = 0; const r = m.sciRequest(bytes, opts); return { r, snaps: snaps.slice() }; }

// 10 / 11
{
  let { r } = req([0x10]); check('10 -> 10 FE 0E (no codes)', eq(r, [0x10, 0xFE, 0x0E]), hex(r));
  m.poke(0x40, 0x1E); m.poke(0x3F, 0x24); m.run(30);
  ({ r } = req([0x10]));
  const sum = (0xFE + 0x10 + 0x1E + 0x24) & 0xFF;
  check('10 with codes 1E,24 -> 10 1E 24 FE sum (0040 first, stop at 00)', eq(r, [0x10, 0x1E, 0x24, 0xFE, sum]), hex(r));
  m.poke(0x40, 0); m.poke(0x3F, 0); m.run(30);
  const r11b = m.sciRequest([0x11]);
  check('11 -> 11 00 00', eq(r11b, [0x11, 0, 0]), hex(r11b));
}
// 16 nn
for (const [sel, want] of [[0x80, [0x04, 0x76, 0x35, 0x55, 0x9A]], [0x81, [0x4C, 0x18, 0xB4, 0xCD, 0x7C]], [0x82, [0xB1, 0x00, 0x00, 0x00, 0x49]]]) {
  const { r } = req([0x16, sel]);
  check(`16 ${hx(sel)} -> ${hex(want)} (documented)`, eq(r, [0x16, sel, ...want]), hex(r));
}
{ const { r } = req([0x16, 0x83], { timeoutMs: 500 }); check('16 83 (other selector): echo only', eq(r, [0x16, 0x83]), hex(r)); }
// 15 hi lo: RAM, unmapped, external gaps, flash, EEPROM
for (const a of [0x0005, 0x0076, 0x0200, 0x03FF, 0x0407, 0x0450, 0x0500, 0x2002, 0x7FFF, 0x8000, 0xB600, 0xB7FF, 0xC123, 0xFFFF]) {
  const { r, snaps: s } = req([0x15, a >> 8, a & 0xFF]);
  let want;
  if (a < 0x200) want = s.length ? s[s.length - 1][a] : m.mem[a];
  else if (a >= 0x8000) want = img(a);
  else want = a & 0xFF;
  check(`15 ${hx(a, 4)} -> ${hx(want)}`, r.length === 4 && r[3] === want, hex(r));
}
// 14 nn for every nn 01-36
for (let nn = 1; nn <= 0x36; nn++) {
  const xx = img(0xD9D6 + nn);
  const { r, snaps: s } = req([0x14, nn], { count: xx === 0xFF ? null : 5, timeoutMs: xx === 0xFF ? 300 : 1000, quietMs: 60 });
  if (xx === 0xFF) { check(`14 ${hx(nn)} (D9D6 entry FF): echo only`, eq(r, [0x14, nn]), hex(r)); continue; }
  const data = r.slice(2);
  const ok = r[0] === 0x14 && r[1] === nn && data.length === 3 && data.every((b, i) => {
    const k = i + 2; const now = s[k]?.[xx]; const before = s[k - 1]?.[xx];
    return b === now || b === before;
  });
  check(`14 ${hx(nn)} streams RAM $${hx(xx)}`, ok, `${hex(r)} RAM ${s.length > 2 ? hx(s[2][xx]) : '?'}`);
}
m.sciRequest([0x00]);
// 22 nn
for (const [sel, a] of [[1, 0x6E], [2, 0x89], [3, 0xE7], [4, 0x8B]]) {
  const { r, snaps: s } = req([0x22, sel], { count: 6, timeoutMs: 1000 });
  check(`22 ${hx(sel)} streams word $${hx(a)} high byte first`, r.length === 6 && r[0] === 0x22 && r[1] === sel && r[2] === s[2][a] && r[3] === s[3][a + 1],
    `${hex(r)} RAM ${hx(s[2]?.[a] ?? 0)}${hx(s[2]?.[a + 1] ?? 0)}`);
}
m.sciRequest([0x00]);
{ const { r } = req([0x22, 0x05], { timeoutMs: 400 }); check('22 05 (other selector): echo only', eq(r, [0x22, 0x05]), hex(r)); }
// 1A nn
for (const [sel, a, fn] of [[2, 0xFD, (v) => v], [3, 0xFC, (v) => v ^ 0x08]]) {
  const { r, snaps: s } = req([0x1A, sel], { count: 4, timeoutMs: 1000 });
  check(`1A ${hx(sel)} streams $${hx(a)}${sel === 3 ? ' ^ 08' : ''}`, r.length === 4 && r[0] === 0x1A && r[1] === sel && (r[2] === fn(s[2][a]) || r[2] === fn(s[1][a])), `${hex(r)} RAM ${hx(s[2]?.[a] ?? 0)}`);
}
{ const { r } = req([0x1A, 0x04], { count: 4, timeoutMs: 1000 }); check('1A 04 streams $0400 & 70 (key on, ASD off after the prime: relay feed = 00)', r.length === 4 && r[2] === 0x00, hex(r)); }
m.sciRequest([0x00]);
// unknown commands: echo then 00
for (const c of [0x01, 0x05, 0x09, 0x0B, 0x0F, 0x24, 0x7F, 0xA5]) {
  const { r } = req([c]); check(`unknown ${hx(c)} -> echo, 00`, eq(r, [c, 0x00]), hex(r));
}
{ const { r } = req([0x00]); check('00 -> echo only', eq(r, [0x00]), hex(r)); }
// 23 nn (engine stopped)
{ const { r } = req([0x23, 0x04]); check('23 04 -> F0 and $03 = [801E]', eq(r, [0x23, 0x04, 0xF0]) && m.mem[0x03] === img(0x801E), `${hex(r)} $03=${hx(m.mem[3])}`); }
{ const { r } = req([0x23, 0x09]); check('23 09 -> 01 unknown selector', eq(r, [0x23, 0x09, 0x01]), hex(r)); }
// 21 nn
{ const { r } = req([0x21, 0x01], { timeoutMs: 500 }); check('21 01 -> echo + 01/02/03', r.length >= 3 && r[0] === 0x21 && [1, 2, 3].includes(r[2]), hex(r)); m.sciRequest([0x21, 0x00]); }
// 18 nn (complement nibbles), engine stopped: E1 each pass
{ const { r } = req([0x18, 0xE1], { count: 6, timeoutMs: 2000 }); check('18 E1 -> E1 stream', r.length === 6 && r.slice(2).every((b) => b === 0xE1), hex(r)); m.sciRequest([0x00]); }
{ const { r } = req([0x18, 0x11], { timeoutMs: 500 }); check('18 11 (bad nibble check) -> 00', eq(r, [0x18, 0x11, 0x00]), hex(r)); }
// 12 high-speed mode
{
  const r = m.sciRequest([0x12], { timeoutMs: 500 });
  check('12 -> echo 12', r[0] === 0x12, hex(r));
  const f2 = m.sciRequest([0xF2], { timeoutMs: 200, quietMs: 20 });
  check('12 mode: F2 answered with F2', f2[0] === 0xF2, hex(f2));
  const a = m.sciRequest([0x05], { timeoutMs: 200, quietMs: 20 });
  check('12 mode: address 05 -> RAM $05', a.length === 1 && Math.abs(a[0] - m.mem[0x05]) <= 1, `${hex(a)} RAM ${hx(m.mem[5])}`);
  const f6 = m.sciRequest([0xF6], { timeoutMs: 200, quietMs: 20 });
  const b = m.sciRequest([0x0A], { timeoutMs: 200, quietMs: 20 });
  check('12 mode: F6 page, 0A -> RAM $010A', f6[0] === 0xF6 && b.length === 1 && b[0] === m.mem[0x10A], `${hex(f6)} ${hex(b)} RAM ${hx(m.mem[0x10A])}`);
  const e = m.sciRequest([0xFE], { timeoutMs: 300, quietMs: 40 });
  check('12 mode: FE exits, reply [00FE]', e.length >= 1 && e[0] === m.mem[0xFE], `${hex(e)} [00FE]=${hx(m.mem[0xFE])}`);
  m.run(200);
  const r2 = m.sciRequest([0x10]);
  check('after FE the normal command set works again', eq(r2, [0x10, 0xFE, 0x0E]), hex(r2));
}
check('no machine faults', m.faults.length === 0, JSON.stringify(m.faults.slice(0, 2)));
done();
