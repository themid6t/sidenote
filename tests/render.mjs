// Answer rendering in a real browser, with a scripted stand-in `claude`: page citations become links, math renders, nothing injects.
//   node scripts/build.mjs && node tests/render.mjs [path/to/binary]   (default: run from source)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-render-'));
const fake = path.resolve('tests/fake-claude.mjs');
if (process.platform === 'win32') fs.writeFileSync(path.join(tmp, 'claude.cmd'), `@node "${fake}" %*\r\n`);
else fs.writeFileSync(path.join(tmp, 'claude'), `#!/bin/sh\nexec node "${fake}" "$@"\n`, { mode: 0o755 });

// Streamed in three chunks that cut through the math, so half-written math is on screen for a while.
const answer = [
  'p. 2 starts this sentence. It ends with p. 6.\n\n'
  + 'See "scaled attention four" (p. 4), pp. 4–5, pp. 5-6, §3 p. 4 and (§3.2.2, p. 3). Not p. 999.\n\n'
  + 'Code: `p. 2` and `$x$`\n\n```\np. 3 in a block $y$\n```\n\n'
  + '- list $a^2$\n- item\n\n| a | b |\n|---|---|\n| $\\beta$ | p. 2 |\n\n'
  + 'Inline $\\sqrt{d',
  '_k}$ and\n\n$$\\text{soft',
  'max}(QK^T/\\sqrt{d_k})V$$\n\n'
  + 'Bad: $x^{$ and $\\nosuchcmd{x}$. Costs $5 and $10; escaped \\$20 and \\$30.\n\n'
  + 'XSS: $\\href{javascript:alert(1)}{x}$ $\\htmlClass{evil}{y}$ $\\url{javascript:alert(2)}$ '
  + '$<img src=x onerror="window.pwned=2">$ <img src=x onerror="window.pwned=1"> [l](javascript:window.pwned=3)\n\n'
  // The quote on its own line, the page on the next: the passage above the citation still flashes.
  + '"scaled attention four"\n\nPage 4\n',
];
const env = { ...process.env, SIDENOTE_HOME: path.join(tmp, 'home'), PATH: `${tmp}${path.delimiter}${process.env.PATH}`,
  FAKE_ANSWER: JSON.stringify(answer) };

// A six-page PDF; page N says "scaled attention <N in words>".
const words = ['one', 'two', 'three', 'four', 'five', 'six'];
const objs = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${words.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}]/Count 6>>`,
  '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
words.forEach((w, i) => {
  const s = `BT /F1 24 Tf 72 700 Td (Marker scaled attention ${w}) Tj ET`;
  objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${5 + 2 * i} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`,
    `<</Length ${s.length}>>stream\n${s}\nendstream`);
});
let pdf = '%PDF-1.4\n';
const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(tmp, 'six.pdf'), pdf);

const cmd = process.argv[2] ? [path.resolve(process.argv[2])] : [process.execPath, path.resolve('bin/sidenote.mjs')];
const server = spawn(cmd[0], [...cmd.slice(1), 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) resolve(m[0]); });
    server.on('exit', () => reject(new Error('server exited')));
  });
  const [base, token] = url.split('/?t=');
  const paper = await fetch(`${base}/api/papers`, { method: 'POST', body: JSON.stringify({ src: path.join(tmp, 'six.pdf') }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }).then((r) => r.json());
  assert.equal(paper.pages, 6, JSON.stringify(paper));

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(`${base}/p/${paper.id}?t=${token}`);
  await page.waitForSelector('.page[data-page-number="1"] .textLayer span');

  // Mid-stream (the overview is asked on first open): half-written math shows as text, the rest renders.
  await page.waitForFunction(() => document.querySelector('#mlive .body')?.textContent.includes('soft'));
  const midway = await page.evaluate(() => {
    const b = document.querySelector('#mlive .body');
    return { katex: b.querySelectorAll('.katex').length, raw: b.textContent.includes('$$\\text{soft') };
  });
  assert.ok(midway.katex >= 3 && midway.raw, JSON.stringify(midway));

  await page.waitForSelector('#m2.msg.assistant');
  const r = await page.evaluate(() => {
    const b = document.querySelector('#m2 .body');
    const text = b.textContent;
    return {
      cites: [...b.querySelectorAll('a.cite')].map((a) => `${a.textContent}>${a.dataset.page}`),
      codeCites: b.querySelectorAll(':is(code, pre) a').length,
      codeMath: b.querySelectorAll(':is(code, pre) .katex').length,
      codeText: [...b.querySelectorAll('code')].map((c) => c.textContent),
      katex: b.querySelectorAll('.katex').length,
      display: b.querySelectorAll('.katex-display').length,
      inList: b.querySelectorAll('li .katex').length,
      inTable: b.querySelectorAll('td .katex').length,
      sqrt: !!b.querySelector('.katex .sqrt'),
      errors: b.querySelectorAll('.katex-error').length,
      untrusted: ['\\href', '\\htmlClass', '\\url', '\\nosuchcmd'].every((c) => text.includes(c)),
      mathml: b.querySelectorAll('.katex-mathml math').length,
      prices: text.includes('Costs $5 and $10'),
      escaped: text.includes('escaped $20 and $30'),
      fontLoaded: document.fonts.check('16px KaTeX_Main'),
      imgs: b.querySelectorAll('img').length,
      onerror: b.querySelectorAll('[onerror]').length,
      js: b.querySelectorAll('[href^="javascript"], [href*="javascript:"]').length,
      evil: document.querySelectorAll('.evil').length,
      pwned: window.pwned,
    };
  });
  console.log(r);
  assert.deepEqual(r.cites, ['p. 2>2', 'p. 6>6', 'p. 4>4', 'pp. 4–5>4', 'pp. 5-6>5', 'p. 4>4', 'p. 3>3', 'p. 2>2', 'Page 4>4']);
  assert.equal(r.codeCites, 0);
  assert.equal(r.codeMath, 0);
  assert.deepEqual(r.codeText, ['p. 2', '$x$', 'p. 3 in a block $y$\n']);
  assert.equal(r.display, 1);
  assert.ok(r.inList === 1 && r.inTable === 1 && r.sqrt);
  // Untrusted (\href, \htmlClass, \url) and unknown commands render as red text; unparsable TeX shows as an error span.
  assert.equal(r.katex, 9);
  assert.equal(r.errors, 1);
  assert.ok(r.untrusted && r.mathml === 9);
  assert.ok(r.prices && r.escaped && r.fontLoaded);
  assert.equal(r.imgs + r.onerror + r.js + r.evil, 0);
  assert.equal(r.pwned, undefined);

  const at = () => page.evaluate(() => Number(document.querySelector('#pageno').textContent.split(' /')[0]));
  const until = (n) => page.waitForFunction((n) => document.querySelector('#pageno').textContent.startsWith(`${n} /`), n);
  assert.equal(await at(), 1);
  // "scaled attention four" is on page 4: that passage flashes.
  await page.click('#m2 a.cite:text-is("p. 4") >> nth=0');
  await until(4);
  await page.waitForSelector('.page[data-page-number="4"] .cite-flash');
  // Page 5 lacks the quote: the page itself flashes.
  await page.click('#m2 a.cite:text-is("pp. 5-6")');
  await until(5);
  await page.waitForSelector('.page[data-page-number="5"].flash-page');
  await page.goBack(); await until(4);
  await page.goBack(); await until(1);
  await page.goForward(); await until(4);
  await page.waitForFunction(() => !document.querySelector('.cite-flash')); // the earlier flash has faded
  await page.click('#m2 a.cite:text-is("Page 4")');
  await page.waitForSelector('.page[data-page-number="4"] .cite-flash');
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'render.png') });
  assert.deepEqual(errors, []);
  console.log('render ok');
} finally {
  await browser?.close();
  server.kill();
}
