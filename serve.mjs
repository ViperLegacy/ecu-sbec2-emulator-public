#!/usr/bin/env node
// Dependency-free static server for the 68HC11 emulator GUI. Serves this folder (emulator/).
//   node emulator/serve.mjs [--port 8732] [--host 127.0.0.1]      then open the printed URL
// Environment: PORT, HOST. Only GET/HEAD; no directory listings; paths outside the folder are refused.
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep, relative } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const port = Number(arg('--port', process.env.PORT || 8732));
const host = arg('--host', process.env.HOST || '127.0.0.1');

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.bin': 'application/octet-stream',
};

async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); return res.end('forbidden'); }
    let st;
    try { st = await stat(file); } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    if (st.isDirectory()) {
      // Build the redirect from the resolved file, not the request: a decoded path like "//example.com/.." would
      // otherwise become a protocol-relative Location pointing at another host.
      const rel = relative(root, file).split(sep).filter(Boolean).map(encodeURIComponent).join('/');
      res.writeHead(302, { Location: '/' + (rel ? rel + '/' : '') }); return res.end();
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(e && e.message));
  }
}

// Default: loopback only, on IPv4 and IPv6 so that "localhost" works whichever it resolves to.
const hosts = host === '127.0.0.1' ? ['127.0.0.1', '::1'] : [host];
let first = true;
for (const hh of hosts) {
  const srv = createServer(handler);
  srv.on('error', (e) => { if (hh === '::1') return; console.error(`cannot listen on ${hh}:${port}: ${e.message}`); process.exit(1); });
  srv.listen(port, hh, () => {
    if (!first) return;
    first = false;
    const shown = hh === '127.0.0.1' || hh === '0.0.0.0' ? 'localhost' : hh;
    console.log(`68HC11 emulator: http://${shown}:${port}/   (serving ${root})`);
  });
}
