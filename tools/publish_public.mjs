#!/usr/bin/env node
// Publish the emulator folder to the public GitHub repo that serves it on GitHub Pages.
//
//   node emulator/tools/publish_public.mjs [--dry-run] [--setup] [--repo owner/name] [--domain host] [-m "message"]
//
//   --setup    create the repo if it is missing (public) and enable Pages from main / with the custom domain.
//              Safe to repeat.
//   --dry-run  build the public tree in a temp folder and show the diff, but do not commit or push.
//
// The public tree is emulator/ as it is on disk (uncommitted edits included), minus local-only files, plus
// CNAME (custom domain), .nojekyll (serve gui/ etc. as is) and a README header. The site needs no build step:
// index.html loads gui/app.js and rom/viper_rom.js (flash image + data bundled) as ES modules.
// Requires git and an authenticated gh CLI with write access to the repo.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');                       // emulator/
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const repo = opt('--repo', 'ViperLegacy/ecu-sbec2-emulator-public');
const domain = opt('--domain', 'sbec2-emulator.viperecu.com');
const dry = flag('--dry-run');

// local-only paths (relative to emulator/, forward slashes)
const EXCLUDE = [/^node_modules(\/|$)/, /\.log$/, /^\.DS_Store$/, /(^|\/)Thumbs\.db$/];

const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
const tryRun = (cmd, args, o) => { try { return { ok: true, out: run(cmd, args, o) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const log = (s) => process.stdout.write(s + '\n');

function setup() {
  if (!tryRun('gh', ['repo', 'view', repo, '--json', 'name']).ok) {
    log(`creating public repo ${repo}`);
    run('gh', ['repo', 'create', repo, '--public', '--description', 'Browser emulator of the 1995 Dodge Viper SBEC2 PCM (68HC11, 04763555)',
      '--homepage', `https://${domain}`]);
  } else log(`repo ${repo} exists`);
}

function enablePages() {
  const cur = tryRun('gh', ['api', `repos/${repo}/pages`]);
  if (!cur.ok) {
    log('enabling GitHub Pages (main, /)');
    run('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/']);
  }
  log(`setting Pages custom domain ${domain}`);
  run('gh', ['api', '-X', 'PUT', `repos/${repo}/pages`, '-f', `cname=${domain}`, '-f', 'source[branch]=main', '-f', 'source[path]=/']);
  // HTTPS can only be enforced once GitHub has issued the certificate for the domain
  const https = tryRun('gh', ['api', '-X', 'PUT', `repos/${repo}/pages`, '-F', 'https_enforced=true']);
  log(https.ok ? 'HTTPS enforced' : 'HTTPS not enforced yet (certificate pending); rerun --setup later');
}

function copyTree(from, to, rel = '') {
  for (const ent of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (EXCLUDE.some((re) => re.test(r))) continue;
    if (ent.isDirectory()) { fs.mkdirSync(path.join(to, r), { recursive: true }); copyTree(from, to, r); }
    else if (ent.isFile()) fs.copyFileSync(path.join(from, r), path.join(to, r));
  }
}

function sourceInfo() {
  const g = (args) => tryRun('git', ['-C', src, ...args]);
  const head = g(['rev-parse', '--short', 'HEAD']);
  const dirty = g(['status', '--porcelain', '--', '.']);
  return head.ok ? `${head.out}${dirty.ok && dirty.out ? ' + uncommitted changes' : ''}` : 'unknown';
}

// ---- main ---------------------------------------------------------------------------------------------
if (flag('--setup') && !dry) setup();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbec2-pub-'));
const url = `https://github.com/${repo}.git`;
const clone = tryRun('git', ['clone', '--quiet', url, work]);
if (!clone.ok) {
  if (!dry) { console.error(`cannot clone ${url} (use --setup to create it):\n${clone.out}`); process.exit(1); }
  run('git', ['init', '--quiet', '-b', 'main', work]);
}
const isEmpty = !tryRun('git', ['-C', work, 'rev-parse', 'HEAD']).ok;
if (isEmpty) run('git', ['-C', work, 'checkout', '--quiet', '-B', 'main']);

// replace the tree (keep .git)
for (const ent of fs.readdirSync(work)) if (ent !== '.git') fs.rmSync(path.join(work, ent), { recursive: true, force: true });
copyTree(src, work);
fs.writeFileSync(path.join(work, 'CNAME'), domain + '\n');
fs.writeFileSync(path.join(work, '.nojekyll'), '');
const info = sourceInfo();
const readme = fs.readFileSync(path.join(src, 'README.md'), 'utf8');
fs.writeFileSync(path.join(work, 'README.md'),
  `> Live: https://${domain}/  \n> Published from the private ViperLegacy/ecu repo (ecu/sbec2/viper/emulator, ${info}) by ` +
  '`tools/publish_public.mjs`; do not edit here. Paths like `../data/...` or `../findings/...` below refer to that repo.\n\n' + readme);

run('git', ['-C', work, 'add', '-A']);
const stat = run('git', ['-C', work, 'status', '--short']);
if (!stat) {
  log('public tree already up to date: nothing to publish');
} else {
  log(stat.split('\n').length + ' changed paths:\n' + stat.split('\n').slice(0, 40).join('\n') + (stat.split('\n').length > 40 ? '\n...' : ''));
  if (dry) log(`dry run: tree left in ${work}`);
  else {
    const msg = opt('-m', `Publish emulator from ecu ${info}`);
    run('git', ['-C', work, 'commit', '--quiet', '-m', msg]);
    run('git', ['-C', work, 'push', '--quiet', '-u', 'origin', 'main']);
    log(`pushed to ${repo} main: ${run('git', ['-C', work, 'rev-parse', '--short', 'HEAD'])}`);
  }
}
if (flag('--setup') && !dry) enablePages();
if (!dry) fs.rmSync(work, { recursive: true, force: true });
log(`site: https://${domain}/`);
