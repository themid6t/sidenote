// Quick check: the pane divider resizes both panes, the PDF refits, and the width is remembered.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-resize-'));
const shots = process.env.SHOTS || home;
const server = spawn(path.resolve(process.argv[2] || 'dist/sidenote-linux-x64'), ['serve', '--port', '0'], { env: { ...process.env, SIDENOTE_HOME: home } });
const url = await new Promise((r) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\S+\?t=\w+/); if (m) r(m[0]); }));
const base = url.split('/?')[0], token = url.split('t=')[1];
let browser;
try {
  const p = await (await fetch(`${base}/api/papers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"src":"2609.00006"}' })).json();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(`${base}/p/${p.id}?t=${token}`);
  await page.waitForSelector('.page[data-page-number="1"] canvas');
  const w = (s) => page.locator(s).evaluate((e) => Math.round(e.getBoundingClientRect().width));
  const page1 = () => page.locator('.page[data-page-number="1"]').evaluate((e) => Math.round(e.getBoundingClientRect().width));
  const [side0, pdf0] = [await w('#side'), await page1()];
  const s = await page.locator('#splitter').boundingBox();
  await page.mouse.move(s.x + 3, s.y + 300); await page.mouse.down();
  await page.mouse.move(500, s.y + 300, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const [side1, pdf1] = [await w('#side'), await page1()];
  console.log({ side0, side1, pdf0, pdf1 });
  assert.ok(side1 > side0 + 300, 'chat pane grew'); assert.ok(pdf1 < pdf0 - 200, 'pdf refit to the narrower pane');
  await page.screenshot({ path: path.join(shots, 'resized.png') });
  await page.reload(); await page.waitForSelector('#side');
  assert.ok(Math.abs((await w('#side')) - side1) <= 2, 'width remembered');
  await page.locator('#splitter').focus();
  console.log('focused:', await page.evaluate(() => document.activeElement?.id), 'before:', await w('#side'));
  await page.keyboard.press('ArrowRight');
  console.log('after:', await w('#side'));
  assert.ok((await w('#side')) < side1, 'keyboard resize');
  await page.locator('#splitter').dblclick();

  // Reading position survives resizing: park mid-page 10, wiggle the divider, check we're still there.
  await page.waitForSelector('.page[data-page-number="10"]', { state: 'attached' });
  const where = () => page.evaluate(() => {
    const c = document.querySelector('#viewerContainer');
    for (const d of document.querySelectorAll('.page')) {
      if (d.offsetTop + d.clientHeight > c.scrollTop) return { page: +d.dataset.pageNumber, frac: (c.scrollTop - d.offsetTop) / d.clientHeight };
    }
  });
  await page.evaluate(() => {
    const c = document.querySelector('#viewerContainer'), d = document.querySelector('.page[data-page-number="10"]');
    c.scrollTop = d.offsetTop + 0.4 * d.clientHeight;
  });
  await page.waitForTimeout(500);
  const start = await where();
  const sp = await page.locator('#splitter').boundingBox();
  await page.mouse.move(sp.x + 3, sp.y + 300); await page.mouse.down();
  for (const x of [700, 400, 900, 300, 1000, 600, 1100, 500]) await page.mouse.move(x, sp.y + 300, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const end = await where();
  console.log('position', start, '→', end);
  assert.equal(end.page, start.page, 'still on the same page after resizing');
  assert.ok(Math.abs(end.frac - start.frac) < 0.03, 'same spot on the page');
  for (const b of ['#zoom-in', '#zoom-in', '#zoom-out', '#zoom-fit']) { await page.click(b); await page.waitForTimeout(150); }
  const zoomed = await where();
  console.log('after zooming', zoomed);
  assert.equal(zoomed.page, start.page, 'zoom keeps the page');
  assert.ok(Math.abs(zoomed.frac - start.frac) < 0.03, 'zoom keeps the spot');
  console.log('after reset:', await w('#side'), '· all resize checks passed');
} finally { await browser?.close(); server.kill(); }
