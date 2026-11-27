// New chat: the button archives the old chat, clears highlights, starts a fresh Claude session; `sidenote new` too.
//   node tests/new-chat.mjs [path/to/binary] [path/to/a.pdf]   (needs `claude` signed in; ~2 minutes)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const bin = path.resolve(process.argv[2] || `dist/sidenote-${process.platform}-${process.arch}`);
const pdf = process.argv[3] || path.join(os.homedir(), '.local/share/sidenote/papers/2609.00006/paper.pdf');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-new-'));
const env = { ...process.env, SIDENOTE_HOME: home };
const log = (s) => console.log(`· ${s}`);

const server = spawn(bin, ['serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) resolve(m[0]); });
  server.on('exit', () => reject(new Error('server exited')));
});
const base = url.split('/?')[0], token = url.split('t=')[1];
const api = (p, o = {}) => fetch(base + p, { ...o, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }).then((r) => r.json());

let browser;
try {
  const paper = await api('/api/papers', { method: 'POST', body: JSON.stringify({ src: pdf }) });
  const dir = path.join(home, 'papers', paper.id);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/p/${paper.id}?t=${token}`);
  const answered = (n) => page.waitForFunction((k) => document.querySelectorAll('.msg.assistant:not(#mlive)').length === k
    && !document.querySelector('#mlive'), n, { timeout: 180_000 });

  log('first chat: overview, then a question with a highlight');
  await answered(1);
  await page.evaluate(() => {
    const span = document.querySelector('.page[data-page-number="1"] .textLayer span');
    const r = document.createRange(); r.selectNodeContents(span);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.fill('#q', 'Remember the codeword QUINCE. Reply OK.');
  await page.press('#q', 'Enter');
  await answered(2);
  const firstSession = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).session_id;
  const hadHighlight = (await api(`/api/papers/${paper.id}`)).highlights.length;

  log('New chat: old chat archived, view cleared, fresh overview, new session');
  await page.click('#new-chat');
  await page.waitForFunction(() => document.querySelectorAll('.msg').length <= 2, null, { timeout: 10_000 });
  assert.equal(await page.locator('.hl:not(.pending)').count(), 0, 'highlights cleared from the page');
  await answered(1);
  const archived = fs.readdirSync(path.join(dir, 'chats'));
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'chats', archived[0], 'messages.json'), 'utf8')).length, 4);
  if (hadHighlight) assert.ok(fs.existsSync(path.join(dir, 'chats', archived[0], 'highlights.json')));
  const now = await api(`/api/papers/${paper.id}`);
  assert.equal(now.messages.length, 2);
  assert.equal(now.highlights.length, 0);
  assert.notEqual(now.paper.session_id, firstSession);

  await page.fill('#q', 'What codeword did I give you? If none, say NONE.');
  await page.press('#q', 'Enter');
  await answered(2);
  assert.doesNotMatch(await page.locator('.msg.assistant').last().textContent(), /QUINCE/, 'new chat must not remember the old one');

  log('`sidenote new` with the reader running clears the open tab too');
  execFileSync(bin, ['new', paper.id], { env });
  await page.waitForFunction(() => !document.querySelector('.msg'), null, { timeout: 10_000 });
  assert.equal(fs.readdirSync(path.join(dir, 'chats')).length, 2);

  log('`sidenote new` without a reader');
  server.kill(); await new Promise((r) => server.on('exit', r));
  fs.writeFileSync(path.join(dir, 'messages.json'), '[]');
  execFileSync(bin, ['new', paper.id], { env });
  assert.equal(fs.readdirSync(path.join(dir, 'chats')).length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).session_id, null);
  console.log('\nnew-chat checks passed');
} finally {
  await browser?.close();
  server.kill();
}
