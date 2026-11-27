// The e-print reader, offline: tars built in memory, hostile archives, and fetch failures.
//   node tests/tex.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { fetchTex, texFromSource, untar } from '../src/tex.mjs';

function tar(files) { // [name, content] -> a ustar archive
  const blocks = [];
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(data.length.toString(8).padStart(11, '0'), 124);
    h.write('0', 156);
    h.write('ustar\x0000', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const MAIN = '\\documentclass{article}\n\\begin{document}\n$\\mathrm{softmax}(QK^T)$\n\\input{intro}\n\\end{document}\n';

// A multi-file source: main first, other .tex after, everything else skipped.
const src = tar([['sec/intro.tex', 'Intro text.\n'], ['fig.tex', '% \\documentclass in a comment\nfigure\n'],
  ['main.tex', MAIN], ['main.bbl', 'BBL'], ['x.sty', 'STY'], ['fig.png', '\x89PNG']]);
let out = texFromSource(zlib.gzipSync(src));
assert.ok(out.startsWith('%%%% file: main.tex\n\\documentclass'), out);
assert.match(out, /%%%% file: sec\/intro\.tex\nIntro text\./);
assert.match(out, /%%%% file: fig\.tex/);
assert.doesNotMatch(out, /BBL|STY|PNG/);
assert.equal(texFromSource(src), out); // not gzipped

// A single gzipped .tex, a PDF-only submission, and bodies that are neither.
assert.equal(texFromSource(zlib.gzipSync(MAIN), '1234.5678.tex'), `%%%% file: 1234.5678.tex\n${MAIN}`);
assert.equal(texFromSource(zlib.gzipSync('%PDF-1.5 ...')), null);
assert.equal(texFromSource(Buffer.from('%PDF-1.5 ...')), null);
assert.equal(texFromSource(Buffer.from('<html>not found</html>')), null);
assert.equal(texFromSource(Buffer.from([0, 1, 2, 3, 255])), null);
assert.throws(() => texFromSource(Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3]))); // corrupt gzip: callers catch

// Hostile names are only labels (nothing is ever written under them), without newlines to fake a file marker.
out = texFromSource(tar([['../../../etc/evil.tex', MAIN], ['/abs/x.tex', 'a'], ['a\n%%%% file: b.tex', 'b']]));
assert.match(out, /^%%%% file: \.\.\/\.\.\/\.\.\/etc\/evil\.tex\n/);
assert.match(out, /%%%% file: \/abs\/x\.tex\n/);
assert.match(out, /%%%% file: a %%%% file: b\.tex\nb/);

// Oversized: at most 5 MB of tex in all, main file kept; a single huge file is dropped.
const big = 'x'.repeat(2e6);
out = texFromSource(tar([['a.tex', big], ['main.tex', MAIN], ['b.tex', big], ['c.tex', big], ['d.tex', 'small']]));
assert.ok(out.length <= 5e6 && out.startsWith('%%%% file: main.tex') && out.includes('file: d.tex'), out.length);
assert.equal(texFromSource(tar([['main.tex', MAIN + 'x'.repeat(6e6)]])), null);

// Truncated or garbled tar: the files before the damage, no throw.
const two = tar([['main.tex', MAIN], ['b.tex', 'y'.repeat(3000)]]);
assert.deepEqual(untar(two.subarray(0, 2000)).map((f) => f.name), ['main.tex']);
assert.deepEqual(untar(two.subarray(0, 1100)).map((f) => f.name), ['main.tex']);
assert.deepEqual(untar(two.subarray(0, 300)).map((f) => f.name), []);
const bad = Buffer.from(two); bad.write('zzzzzzzzzzz', 124); // size field not octal
assert.deepEqual(untar(bad), []);

// A gzip bomb stops at the cap instead of filling memory.
assert.throws(() => texFromSource(zlib.gzipSync(Buffer.alloc(201e6))), RangeError);

// fetchTex over HTTP: success, 404, unreachable host, and a server that never answers.
const server = http.createServer((req, res) => {
  if (req.url === '/e-print/ok') return res.end(zlib.gzipSync(src));
  if (req.url === '/e-print/hang') return;
  if (req.url === '/e-print/pdf') { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF-1.5'); }
  res.statusCode = 404; res.end();
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
assert.match(await fetchTex('ok', { base }), /^%%%% file: main\.tex/);
assert.equal(await fetchTex('missing', { base }), null);
assert.equal(await fetchTex('pdf', { base }), null);
await assert.rejects(fetchTex('x', { base: 'http://127.0.0.1:1' }));
const t0 = Date.now();
await assert.rejects(fetchTex('hang', { base, timeout: 300 }));
assert.ok(Date.now() - t0 < 2000);
server.closeAllConnections(); server.close();
console.log('tex ok');
