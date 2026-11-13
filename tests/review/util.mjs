// Shared helpers for the adversarial review scripts (no framework).
export function makeChecker(title) {
  let passed = 0, failed = 0;
  console.log(`== ${title}`);
  const check = (name, cond, detail = '') => {
    if (cond) { passed++; console.log(`  ok   ${name}${detail ? '  -- ' + detail : ''}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? '  -- ' + detail : ''}`); }
    return !!cond;
  };
  const done = () => { console.log(`${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; };
  return { check, done };
}
export const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
export const hex = (a) => Array.from(a, (b) => hx(b)).join(' ');
export const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const rpm16 = (m) => (m.mem[0x6E] << 8) | m.mem[0x6F];
/** Track SP at the main-loop wait (9E0E), the deepest SP reached by any push, and the longest pass. */
export function trackMainLoop(m) {
  const st = { sps: new Map(), minSp: 0xFFFF, lastPassCycle: null, maxPassMs: 0, passTimes: [] };
  const off1 = m.addBreakpoint(0x9E0E, (mm) => { const sp = mm.cpu.sp; st.sps.set(sp, (st.sps.get(sp) || 0) + 1); });
  const origPass = m._onPass;
  m._onPass = function (c) {
    if (st.lastPassCycle !== null) st.maxPassMs = Math.max(st.maxPassMs, (c - st.lastPassCycle) * 1000 / m.eClock);
    st.lastPassCycle = c; return origPass.call(m, c);
  };
  const cpu = m.cpu, origPush = cpu.push8;
  cpu.push8 = function (v) { if (this.sp < st.minSp) st.minSp = this.sp; return origPush.call(this, v); };
  st.stop = () => { off1(); m._onPass = origPass; cpu.push8 = origPush; };
  return st;
}
