// Stress: scroll, then immediately resize (no settle time), many times; record how far the view drifts.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium } from 'playwright';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-jump-'));
const server = spawn(path.resolve(process.argv[2] || 'dist/sidenote-linux-x64'), ['serve', '--port', '0'], { env: { ...process.env, SIDENOTE_HOME: home } });
const url = await new Promise((r) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\S+\?t=\w+/); if (m) r(m[0]); }));
const base = url.split('/?')[0], token = url.split('t=')[1];
let browser;
try {
  const p = await (await fetch(`${base}/api/papers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"src":"2609.00006"}' })).json();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(`${base}/p/${p.id}?t=${token}`);
  await page.waitForSelector('.page[data-page-number="30"]', { state: 'attached' });
  await page.waitForTimeout(800);
  const where = () => page.evaluate(() => {
    const c = document.querySelector('#viewerContainer');
    for (const d of document.querySelectorAll('.page')) if (d.offsetTop + d.clientHeight > c.scrollTop)
      return +(+d.dataset.pageNumber + (c.scrollTop - d.offsetTop) / d.clientHeight).toFixed(3);
  });
  const drifts = [];
  for (let k = 0; k < 12; k++) {
    // scroll somewhere with the wheel, then resize at once
    await page.mouse.move(300, 400);
    await page.mouse.wheel(0, 700 + k * 137);
    // let the wheel's smooth scroll finish, so only the resize can move the view
    await page.waitForFunction(() => new Promise((r) => { const c = document.querySelector('#viewerContainer'); const a = c.scrollTop; setTimeout(() => r(c.scrollTop === a), 150); }));
    const before = await where();
    const sp = await page.locator('#splitter').boundingBox();
    await page.mouse.move(sp.x + 3, 400); await page.mouse.down();
    await page.mouse.move(k % 2 ? 450 : 1150, 400, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await where();
    drifts.push(+(after - before).toFixed(3));
  }
  console.log('drift in pages per resize:', drifts.join(' '));
  // Pinch / ctrl+scroll: the point of the paper under the cursor stays under the cursor.
  const under = (cx, cy) => page.evaluate(([cx, cy]) => {
    const c = document.querySelector('#viewerContainer'), r = c.getBoundingClientRect();
    const x = c.scrollLeft + cx - r.left, y = c.scrollTop + cy - r.top;
    for (const d of document.querySelectorAll('.page')) if (d.offsetTop + d.clientHeight > y)
      return { page: +d.dataset.pageNumber, fx: +((x - d.offsetLeft) / d.clientWidth).toFixed(3), fy: +((y - d.offsetTop) / d.clientHeight).toFixed(3) };
  }, [cx, cy]);
  const scale = () => page.evaluate(() => getComputedStyle(document.querySelector('#viewer')).getPropertyValue('--scale-factor'));
  for (const [cx, cy, dy] of [[250, 300, -40], [300, 600, -25], [200, 500, 60], [350, 350, -80]]) {
    await page.mouse.move(cx, cy);
    const b = await under(cx, cy), s0 = await scale();
    await page.keyboard.down('Control');
    for (let k = 0; k < 6; k++) await page.mouse.wheel(0, dy);
    await page.keyboard.up('Control');
    await page.waitForTimeout(300);
    const a = await under(cx, cy), s1 = await scale();
    // Sideways the point can only stay put while the page is wider than the pane (narrower pages are centred).
    const wide = await page.evaluate(() => { const c = document.querySelector('#viewerContainer'); return c.scrollWidth > c.clientWidth; });
    const off = Math.max(wide ? Math.abs(a.fx - b.fx) : 0, Math.abs(a.fy - b.fy));
    console.log(`  fx ${b.fx}→${a.fx} fy ${b.fy}→${a.fy} wide=${wide}`);
    console.log(`pinch at ${cx},${cy}: scale ${(+s0).toFixed(2)}→${(+s1).toFixed(2)}, page ${b.page}→${a.page}, point moved ${off}`);
    if (a.page !== b.page || off > 0.01 || s0 === s1) process.exitCode = 1;
  }
  await page.keyboard.press('Control+0');
  console.log(process.exitCode ? 'FAILED' : 'zoom checks passed');
  console.log('worst:', Math.max(...drifts.map(Math.abs)));
} finally { await browser?.close(); server.kill(); }
