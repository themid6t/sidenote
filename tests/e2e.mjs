// End-to-end: the real binary, a real browser, real Claude answers.
//   node tests/e2e.mjs [path/to/binary]     (needs `claude` signed in; ~2 minutes)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const bin = path.resolve(process.argv[2] || `dist/sidenote-${process.platform}-${process.arch}`);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-e2e-'));
const shots = process.env.SHOTS || home;
const env = { ...process.env, SIDENOTE_HOME: home };
const log = (s) => console.log(`· ${s}`);

const server = spawn(bin, ['serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) resolve(m[0]); });
  server.on('exit', () => reject(new Error('server exited')));
});
const base = url.split('/?')[0], token = url.split('t=')[1];
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = (p, o = {}) => fetch(base + p, { ...o, headers: auth }).then((r) => r.json());

// Answers can need a permission card now (a full Claude Code session); allow any that show up while waiting.
const settle = async (pg, fn, arg) => {
  const t0 = Date.now();
  for (;;) {
    if (await pg.evaluate(fn, arg)) return;
    const card = pg.locator('.perm .allow').first();
    if (await card.count()) { log('  (allowed a permission card)'); await card.click().catch(() => {}); }
    if (Date.now() - t0 > 180_000) throw new Error('answer timed out');
    await pg.waitForTimeout(500);
  }
};

let browser;
try {
  browser = await chromium.launch();
  log('add a paper through the API');
  const paper = await api('/api/papers', { method: 'POST', body: JSON.stringify({ src: '2609.00006' }) });
  assert.equal(paper.pages, 83);

  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${base}/p/${paper.id}?t=${token}`);
  await page.waitForSelector('.page[data-page-number="1"] .textLayer span');

  log('overview streams in on first open');
  await page.waitForSelector('.msg.assistant .body.typing', { timeout: 60_000 });
  await settle(page, () => document.querySelector('.msg.assistant')?.id === 'm2');
  assert.ok((await page.textContent('.msg.assistant .body')).length > 200);
  await page.screenshot({ path: path.join(shots, '1-overview.png') });

  log('drag-select three lines of the abstract');
  const spans = page.locator('.page[data-page-number="1"] .textLayer span');
  const first = spans.filter({ hasText: /^An agent is a model plus a harness/ }).first();
  const last = spans.filter({ hasText: /^This paper gives the young/ }).first();
  const a = await first.boundingBox(), b = await last.boundingBox();
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + (b.x + b.width - a.x) * i / 10, a.y + (b.y - a.y) * i / 10 + b.height / 2);
  await page.mouse.up();
  await page.waitForSelector('#quote:not([hidden])');
  const quote = await page.textContent('#quote-text');
  assert.match(quote, /^An agent is a model plus a harness/);
  assert.match(quote, /engineering, named as a discipline/);
  assert.ok(await page.locator('.page[data-page-number="1"] .hl.pending').count() >= 3, 'pending highlight drawn per line');
  await page.screenshot({ path: path.join(shots, '2-selection.png') });

  log('ask about the selection');
  await page.fill('#q', 'In one sentence: what is a harness here?');
  await page.press('#q', 'Enter');
  await settle(page, () => document.querySelectorAll('.msg.assistant[id^="m"]:not(#mlive)').length === 2);
  const stored = await api(`/api/papers/${paper.id}`);
  const pid1 = stored.session.pid;
  assert.ok(pid1, 'a live Claude Code process');
  const asked = stored.messages.find((m) => m.content.startsWith('In one sentence'));
  assert.equal(asked.page, 1);
  assert.match(asked.quote, /An agent is a model plus a harness/);
  assert.equal(stored.highlights.length, 1);
  await page.screenshot({ path: path.join(shots, '3-answer.png') });

  log('region capture on page 5 (Table 1)');
  await page.evaluate(() => document.querySelector('.page[data-page-number="5"]').scrollIntoView());
  await page.waitForSelector('.page[data-page-number="5"] canvas');
  await page.waitForTimeout(500);
  await page.click('#region-btn');
  const p5 = await page.locator('.page[data-page-number="5"]').boundingBox();
  await page.mouse.move(p5.x + p5.width * 0.1, p5.y + p5.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(p5.x + p5.width * 0.9, p5.y + p5.height * 0.45, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector('#quote:not([hidden])');
  assert.match(await page.textContent('#quote-text'), /^Region on page 5/);
  await page.fill('#q', 'Which subsystem has Aider as its minimal form? One line.');
  await page.press('#q', 'Enter');
  await settle(page, () => document.querySelectorAll('.msg.assistant[id^="m"]:not(#mlive)').length === 3);
  const regionAnswer = await page.locator('.msg.assistant').last().textContent();
  assert.equal((await api(`/api/papers/${paper.id}`)).session.pid, pid1, 'same process answered both questions');
  assert.match(regionAnswer, /orchestration/i, 'answer should come from the captured table');
  const withRegion = (await api(`/api/papers/${paper.id}`)).messages.find((m) => m.region);
  assert.ok(withRegion && fs.existsSync(withRegion.region), 'region image saved');
  await page.screenshot({ path: path.join(shots, '4-region.png') });

  log('reopen: history, highlights and position are restored');
  await page.waitForTimeout(800); // state save is debounced
  await page.close();
  const again = await ctx.newPage();
  await again.goto(`${base}/p/${paper.id}`);
  await again.waitForSelector('.msg.assistant');
  assert.equal(await again.locator('.msg').count(), 6);
  await again.waitForFunction(() => Number(document.querySelector('#pageno').textContent.split('/')[0]) >= 4, null, { timeout: 10_000 });
  await again.evaluate(() => document.querySelector('.page[data-page-number="1"]').scrollIntoView());
  await again.waitForSelector('.page[data-page-number="1"] .hl:not(.pending)');
  await again.screenshot({ path: path.join(shots, '5-reopened.png') });

  log('E explains a selection');
  const before = await again.locator('.msg').count();
  const span = again.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: /^The audit yields 13/ }).first();
  await span.scrollIntoViewIfNeeded();
  const sb = await span.boundingBox();
  await again.mouse.move(sb.x + 1, sb.y + sb.height / 2);
  await again.mouse.down();
  await again.mouse.move(sb.x + sb.width - 1, sb.y + sb.height / 2, { steps: 5 });
  await again.mouse.up();
  await again.waitForSelector('#quote:not([hidden])');
  await again.keyboard.press('e');
  await settle(again, (n) => document.querySelectorAll('.msg').length >= n + 2 && !document.querySelector('.typing'), before);
  const explained = (await api(`/api/papers/${paper.id}`)).messages.at(-2);
  assert.match(explained.content, /^Explain this/);
  assert.match(explained.quote, /The audit yields 13/);

  log('terminal ask joins the same conversation');
  const out = await new Promise((resolve) => {
    let s = '';
    const p = spawn(bin, ['ask', 'harness', 'What did I highlight first? Five words max.'], { env });
    p.stdout.on('data', (d) => { s += d; });
    p.on('close', () => resolve(s));
  });
  assert.match(out, /agent|harness|model/i);
  assert.equal((await api(`/api/papers/${paper.id}`)).messages.length, 10);

  log('permission prompts: Allow runs the command, Deny blocks it (and a reload keeps the prompt)');
  const paperDir = path.join(home, 'papers', paper.id);
  const tag = crypto.randomUUID().slice(0, 8);
  const askUI = async (q) => { await again.fill('#q', q); await again.press('#q', 'Enter'); };
  await askUI(`Use the Bash tool to run exactly: touch sidenote-allow-${tag}.txt  (then reply "done")`);
  await again.waitForSelector('.perm', { timeout: 120_000 });
  assert.match(await again.textContent('.perm pre'), new RegExp(`touch sidenote-allow-${tag}`));
  await again.screenshot({ path: path.join(shots, '6-permission.png') });
  await again.click('.perm .allow');
  await again.waitForFunction(() => !document.querySelector('#mlive') && !document.querySelector('.typing'), null, { timeout: 120_000 });
  assert.ok(fs.existsSync(path.join(paperDir, `sidenote-allow-${tag}.txt`)), 'allowed command ran');

  await askUI(`Use the Bash tool to run exactly: touch sidenote-deny-${tag}.txt  (if it is not allowed, reply "skipped")`);
  await again.waitForSelector('.perm', { timeout: 120_000 });
  await again.reload();
  await again.waitForSelector('.perm', { timeout: 15_000 }); // still there after reload
  await again.click('.perm .deny');
  await again.waitForFunction(() => !document.querySelector('#mlive') && !document.querySelector('.typing'), null, { timeout: 120_000 });
  assert.ok(!fs.existsSync(path.join(paperDir, `sidenote-deny-${tag}.txt`)), 'denied command did not run');

  const askCli = (q) => new Promise((resolve) => {
    let s = '';
    const p = spawn(bin, ['ask', paper.id, q], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { s += d; });
    p.on('close', () => resolve(s));
  });

  log('stopping the reader leaves no Claude process behind');
  const live = (await api(`/api/papers/${paper.id}`)).session.pid;
  assert.ok(live);
  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  const alive = () => { try { process.kill(live, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(), 'claude process gone within 5 s');

  log('without a reader, a lost Claude session is rebuilt from the saved history');
  const metaFile = path.join(paperDir, 'meta.json');
  const lost = crypto.randomUUID();
  fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), session_id: lost }));
  const recalled = await askCli('What was the very first passage I highlighted? Quote its first five words.');
  assert.match(recalled, /An agent is a model/i, 'history should be restored into the new session');
  assert.notEqual(JSON.parse(fs.readFileSync(metaFile, 'utf8')).session_id, lost);

  console.log(`\nall checks passed · screenshots in ${shots}`);
} finally {
  await browser?.close();
  server.kill();
}
