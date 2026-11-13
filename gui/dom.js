// Tiny DOM helpers (browser only).

/** h('div.cls#id', {attr: v, on: {click: fn}}, ...children) */
export function h(spec, attrs = {}, ...children) {
  const m = String(spec).match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) for (const p of m[2].match(/[.#][\w-]+/g)) { if (p[0] === '.') el.classList.add(p.slice(1)); else el.id = p.slice(1); }
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, children);
  return el;
}
function add(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) add(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Confidence / evidence tag chip. */
export function tag(text, cls = '') { return h('span.tag' + (cls ? '.' + cls : ''), { text, title: text }); }

/** Set text only when it changed (cheap repeated updates). */
export function setText(el, s) { s = String(s); if (el.textContent !== s) el.textContent = s; }
export function setClass(el, cls, on) { if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); }

/** Canvas sized for the device pixel ratio; returns 2-D context scaled to CSS pixels. */
export function fitCanvas(cv, cssW, cssH) {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const w = Math.max(1, Math.round(cssW * dpr)), hh = Math.max(1, Math.round(cssH * dpr));
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; cv.style.height = cssH + 'px'; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** CSS custom property value from :root (for canvas colours that follow the theme). */
export function cssVar(name, fallback = '#888') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Trigger a file download of bytes / text. */
export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask the user for a file; resolves to Uint8Array (with a .fileName property). */
export function pickFile(accept = '') {
  return new Promise((resolve, reject) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return reject(new Error('no file'));
      const bytes = new Uint8Array(await f.arrayBuffer());
      bytes.fileName = f.name;
      resolve(bytes);
    });
    document.body.appendChild(inp); inp.click();
  });
}

/** localStorage wrapped in try/catch (private mode, blocked storage, previews). */
export const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } },
  getBytes(k) { const s = this.get(k); if (!s) return null; try { return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16)); } catch { return null; } },
  setBytes(k, b) { return this.set(k, Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')); },
};

/** Replace an element's children; arrays are flattened and null/false skipped (unlike replaceChildren). */
export function fill(el, ...children) { el.replaceChildren(); add(el, children); return el; }
