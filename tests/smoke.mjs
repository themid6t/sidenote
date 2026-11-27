// Per-OS smoke test with a stand-in `claude`: the binary runs, imports a PDF, and drives claude.
//   node tests/smoke.mjs path/to/binary
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const bin = path.resolve(process.argv[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-smoke-'));
const fake = path.resolve('tests/fake-claude.mjs');
// A shim named `claude` on PATH; on Windows a .cmd, the way npm installs it.
if (process.platform === 'win32') fs.writeFileSync(path.join(tmp, 'claude.cmd'), `@node "${fake}" %*\r\n`);
else fs.writeFileSync(path.join(tmp, 'claude'), `#!/bin/sh\nexec node "${fake}" "$@"\n`, { mode: 0o755 });
const env = { ...process.env, SIDENOTE_HOME: path.join(tmp, 'home'), PATH: `${tmp}${path.delimiter}${process.env.PATH}` };
const run = (...args) => execFileSync(bin, args, { env, encoding: 'utf8', timeout: 60_000 });

// A one-page PDF with a line of text.
const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
  '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
  null, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
const stream = 'BT /F1 24 Tf 72 700 Td (Smoke Test Paper) Tj ET';
objs[3] = `<</Length ${stream.length}>>stream\n${stream}\nendstream`;
let pdf = '%PDF-1.4\n';
const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(tmp, 'smoke.pdf'), pdf);

console.log(run('--version').trim());
const server = spawn(bin, ['serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const url = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) resolve(m[0]); });
    server.on('exit', () => reject(new Error('server exited')));
  });
  const [base, token] = url.split('/?t=');
  const added = await fetch(`${base}/api/papers`, { method: 'POST', body: JSON.stringify({ src: path.join(tmp, 'smoke.pdf') }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }).then((r) => r.json());
  assert.equal(added.pages, 1, JSON.stringify(added));
  assert.match(run('ask', added.id, 'hello'), /FAKE ANSWER turn=1/);           // through the reader's live session
  assert.match(run('ask', added.id, 'again'), /FAKE ANSWER turn=2/);           // same claude process
  assert.match(run('history', added.id), /hello[\s\S]*FAKE ANSWER/);
  assert.match(run('export', added.id, '-'), /^---\ntitle: "Smoke Test Paper"[\s\S]*### You\n\nhello\n\n### Claude\n\nFAKE ANSWER/);
  const exp = await fetch(`${base}/api/papers/${added.id}/export`, { headers: { authorization: `Bearer ${token}` } });
  assert.match(exp.headers.get('content-disposition'), /filename="smoke-test-paper\.md"/);
  assert.match(await exp.text(), /FAKE ANSWER turn=2/);
  assert.equal((await fetch(`${base}/api/papers/${added.id}/export`)).status, 401);
} finally { server.kill(); }
console.log('smoke ok');
