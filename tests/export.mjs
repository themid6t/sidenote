// `sidenote export` on a made-up library: hostile titles, regions (one missing), archived chats, stdout.
//   node tests/export.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-export-'));
const home = path.join(tmp, 'home');
const bin = path.resolve('bin/sidenote.mjs');
const run = (cwd, ...args) => execFileSync(process.execPath, [bin, 'export', ...args],
  { cwd, env: { ...process.env, SIDENOTE_HOME: home }, encoding: 'utf8' });
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function paper(id, title, msgs, { chats = {}, highlights = [] } = {}) {
  const dir = path.join(home, 'papers', id);
  fs.mkdirSync(path.join(dir, 'regions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, title, source: `/tmp/${id}.pdf`, pages: 3 }));
  if (msgs) fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(msgs));
  fs.writeFileSync(path.join(dir, 'highlights.json'), JSON.stringify(highlights));
  for (const [name, m] of Object.entries(chats)) {
    fs.mkdirSync(path.join(dir, 'chats', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chats', name, 'messages.json'), JSON.stringify(m));
  }
  return dir;
}
const msg = (id, role, content, extra = {}) => ({ id, role, content, quote: null, page: null, region: null,
  created_at: `2026-01-0${id}T10:00:00.000Z`, ...extra });
const frontMatter = (md) => {
  const [, fm] = md.match(/^---\n([\s\S]*?)\n---\n/);
  return Object.fromEntries(fm.split('\n').map((l) => { const [, k, v] = l.match(/^(\w+): (.*)$/); return [k, k === 'exported' ? v : JSON.parse(v)]; }));
};

const title = 'Colons: "quotes" / back\\slash *?<>| — Über Café 東京';
const dir = paper('hostile', title, [
  msg(1, 'user', 'what is this?', { quote: 'line one\nline two', page: 2 }),
  msg(2, 'assistant', 'An answer\n\n---\n\nwith a rule.', { tools: [{ name: 'Read', summary: 'SECRET-TOOL-LOG' }] }),
  msg(3, 'user', 'and this figure?', { page: 3, region: '/elsewhere/regions/111.png' }),
  msg(4, 'assistant', 'A figure.'),
  msg(5, 'user', 'and this one?', { page: 1, region: '/elsewhere/regions/222.png' }), // its PNG is gone
  msg(6, 'assistant', 'Missing.'),
], { chats: { '2026-01-01T00-00-00-000Z': [msg(1, 'user', 'OLD QUESTION'), msg(2, 'assistant', 'OLD ANSWER')] },
  highlights: [{ id: 1, message_id: 1, page: 2, rects: [] }, { id: 2, message_id: 99, page: 3, rects: [] }] });
fs.writeFileSync(path.join(dir, 'regions', '111.png'), PNG);
paper('empty', 'CON', null);

// Default file name: a slug safe on Windows, in the current directory; images next to it.
const cwd = path.join(tmp, 'cwd'); fs.mkdirSync(cwd);
run(cwd, 'hostile');
const slug = 'colons-quotes-back-slash-über-café-東京';
const md = fs.readFileSync(path.join(cwd, `${slug}.md`), 'utf8');
assert.deepEqual(frontMatter(md), { title, source: '/tmp/hostile.pdf', pages: 3, exported: new Date().toISOString().slice(0, 10) });
assert.match(md, /> line one\n> line two\n> \(p\. 2\)\n\nwhat is this\?/);
assert.match(md, /An answer\n\n---\n\nwith a rule\./);
const link = md.match(/!\[region on p\. 3\]\((.+?)\)/)[1];
assert.ok(fs.existsSync(path.join(cwd, decodeURI(link))), link);
assert.match(md, /\[region on p\. 1: image missing\]/);
assert.match(md, /### Other highlights\n\n- p\. 3\n/);
assert.doesNotMatch(md, /SECRET-TOOL-LOG|OLD QUESTION|## Chat from/);

// Overwrite, a path in another directory, --all.
const other = path.join(tmp, 'other dir'); fs.mkdirSync(other);
fs.writeFileSync(path.join(other, 'notes.md'), 'stale');
run(cwd, 'hostile', path.join(other, 'notes.md'), '--all');
const all = fs.readFileSync(path.join(other, 'notes.md'), 'utf8');
assert.match(all, /## Chat from 2026-01-01 10:00\n\n### You\n\nOLD QUESTION[\s\S]*## Chat from 2026-01-01 10:00\n\n### You\n\n> line one/);
assert.ok(fs.existsSync(path.join(other, 'notes-files', '111.png')));
assert.match(all, /\]\(notes-files\/111\.png\)/);

// stdout: no files written, placeholders instead of images.
const before = fs.readdirSync(cwd).length;
const out = run(cwd, 'hostile', '-');
assert.equal(fs.readdirSync(cwd).length, before);
assert.match(out, /\[region on p\. 3\]/);
assert.doesNotMatch(out, /!\[/);

// No messages at all, and a title that is a reserved Windows name.
run(cwd, 'empty');
assert.match(fs.readFileSync(path.join(cwd, 'con-paper.md'), 'utf8'), /# CON\n\n_No questions yet\._/);
run(cwd, 'empty', '-', '--all').endsWith('_No questions yet._\n') || assert.fail('empty --all');
fs.rmSync(tmp, { recursive: true });
console.log('export ok');
