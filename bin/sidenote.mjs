#!/usr/bin/env node
// sidenote: read papers side by side with Claude. Needs only Claude Code (`claude` on PATH).
import { execFileSync, spawn } from 'node:child_process';
import * as store from '../src/store.mjs';
import readline from 'node:readline';
import { getSession } from '../src/session.mjs';
import { runningServer, startServer } from '../src/server.mjs';

const VERSION = process.env.SIDENOTE_VERSION || 'dev';
const HELP = `sidenote ${VERSION}: read papers side by side with Claude

  sidenote <pdf | arXiv id | url>      add the paper and open it in the reader
  sidenote open <paper>                open a paper from your library
  sidenote ls                          list your library
  sidenote ask <paper> <question…>     ask in the terminal (same conversation as the reader)
  sidenote history <paper>             print the conversation
  sidenote new <paper>                 start a fresh chat (the old one is archived)
  sidenote rm <paper>                  delete a paper and its history
  sidenote serve [--port N]            run the reader without opening a browser

<paper> is an id, an arXiv id, or any unique part of the title.
In the reader: select text and ask, ctrl+E explains the selection,
R then drag captures a region (figures, tables). Data lives in:
  ${store.HOME}`;

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function needClaude() {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'ignore' }); }
  catch { fail('Claude Code is required: install it from https://claude.com/claude-code, then run `claude` once to sign in.'); }
}

function fail(msg) { console.error(`sidenote: ${msg}`); process.exit(1); }

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(process.env.BROWSER || cmd, process.env.BROWSER ? [url] : args, { stdio: 'ignore', detached: true })
    .on('error', () => console.log(`Open this link in your browser: ${url}`)).unref();
}

async function serveAndOpen(paperId, { open = true, port } = {}) {
  const live = await runningServer();
  const target = (s) => `http://127.0.0.1:${s.port}${paperId ? `/p/${encodeURIComponent(paperId)}` : '/'}?t=${s.token}`;
  if (live) {
    openBrowser(target(live));
    console.log(dim(`opened in the running reader (port ${live.port})`));
    return;
  }
  const s = await startServer({ port });
  if (open) openBrowser(target(s));
  console.log(`${bold('Reader')} at ${target(s)}\n${dim('ctrl+c to stop')}`);
}

async function addPaper(src) {
  process.stdout.write(dim('adding… '));
  const p = await store.importPaper(src);
  console.log(`${bold(p.title)} ${dim(`(${p.id}, ${p.pages} pages)`)}`);
  return p;
}

/** Print one session event in the terminal; permission prompts become y/n questions. */
function renderer(answer) {
  let midLine = false;
  const note = (s) => { process.stderr.write(`${midLine ? '\n' : ''}${dim(s)}\n`); midLine = false; };
  return async (ev) => {
    if (ev.type === 'delta') { process.stdout.write(ev.text); midLine = !ev.text.endsWith('\n'); }
    else if (ev.type === 'tool') note(`${ev.tool.sub ? '  ↳ ' : '· '}${ev.tool.name} ${ev.tool.summary}`);
    else if (ev.type === 'permission') {
      const { id, tool, input, description } = ev.permission;
      note(`Claude wants to use ${tool}${description ? ` (${description})` : ''}:`);
      process.stderr.write(`${JSON.stringify(input, null, 2)}\n`);
      if (!process.stdin.isTTY) { note('denied: no terminal to ask in'); return answer(id, false); }
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const yes = await new Promise((r) => rl.question('Allow? [y/N] ', (a) => { rl.close(); r(/^y(es)?$/i.test(a.trim())); }));
      answer(id, yes);
    } else if (ev.type === 'error') note(`error: ${ev.text}`);
  };
}

/** Ask in the terminal: through the running reader's live session if there is one, else a session of our own. */
async function ask(p, question) {
  const live = await runningServer();
  if (!live) {
    const s = getSession(p.id);
    s.on('event', renderer((id, allow) => s.answer(id, allow)));
    try { await s.ask({ question, page: p.page }); } catch { process.exitCode = 1; } finally { s.close(); process.stdout.write('\n'); }
    return;
  }
  const base = `http://127.0.0.1:${live.port}/api/papers/${encodeURIComponent(p.id)}`;
  const headers = { authorization: `Bearer ${live.token}`, 'content-type': 'application/json' };
  const post = (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const res = await fetch(`${base}/events`, { headers });
  const render = renderer((id, allow) => post('/permission', { id, allow }));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', mine = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) fail('the reader stopped');
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!line.startsWith('data: ')) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'snapshot') {
        if (ev.busy) fail('the reader is answering another question about this paper; try again in a moment');
        const r = await post('/ask', { question, page: p.page });
        if (!r.ok) fail((await r.json()).error);
        continue;
      }
      if (ev.type === 'user') { mine = true; continue; }
      if (!mine) continue;
      await render(ev);
      if (ev.type === 'done' || ev.type === 'error') { process.stdout.write('\n'); reader.cancel(); return; }
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help':
      console.log(HELP); break;
    case '-v': case '--version':
      console.log(VERSION); break;
    case 'ls': {
      const papers = store.listPapers();
      if (!papers.length) console.log('No papers yet. Try: sidenote 1706.03762');
      for (const p of papers) {
        console.log(`${bold(p.id.padEnd(14))} ${p.title.slice(0, 70)}`);
        console.log(dim(`${''.padEnd(14)} p.${p.page}/${p.pages} · ${p.questions} question${p.questions === 1 ? '' : 's'}`
          + ` · ${(p.opened_at || p.added_at).slice(0, 10)}`));
      }
      break;
    }
    case 'open': {
      needClaude();
      if (!rest[0]) { await serveAndOpen(null); break; }
      let p;
      try { p = store.findPaper(rest.join(' ')); } catch { p = await addPaper(rest[0]); }
      await serveAndOpen(p.id);
      break;
    }
    case 'serve': {
      needClaude();
      const i = rest.indexOf('--port');
      await serveAndOpen(null, { open: false, port: i >= 0 ? Number(rest[i + 1]) : undefined });
      break;
    }
    case 'ask': {
      needClaude();
      if (rest.length < 2) fail('usage: sidenote ask <paper> <question…>');
      await ask(store.findPaper(rest[0]), rest.slice(1).join(' '));
      break;
    }
    case 'history': {
      const p = store.findPaper(rest.join(' '));
      for (const m of store.messages(p.id)) {
        if (m.role === 'user') {
          console.log(`\n${bold('You')} ${dim(m.created_at.slice(0, 16).replace('T', ' ') + (m.page ? ` · p.${m.page}` : ''))}`);
          if (m.quote) console.log(dim(m.quote.split('\n').map((l) => `> ${l}`).join('\n')));
          console.log(m.content);
        } else console.log(`\n${bold('Claude')}\n${m.content}`);
      }
      break;
    }
    case 'new': {
      const p = store.findPaper(rest.join(' '));
      const live = await runningServer();
      if (live) {
        const r = await fetch(`http://127.0.0.1:${live.port}/api/papers/${encodeURIComponent(p.id)}/new`,
          { method: 'POST', headers: { authorization: `Bearer ${live.token}` } });
        if (!r.ok) fail((await r.json()).error);
      } else store.newChat(p.id);
      console.log(`new chat for ${p.id} (${p.title}); the old one is in ${store.paperDir(p.id)}/chats/`);
      break;
    }
    case 'rm': {
      const p = store.findPaper(rest.join(' '));
      store.removePaper(p.id);
      console.log(`removed ${p.id} (${p.title})`);
      break;
    }
    default: {
      // `sidenote <pdf|id|url>` or `sidenote <part of a title>`
      needClaude();
      const arg = [cmd, ...rest].join(' ');
      let p;
      try { p = store.findPaper(arg); } catch { p = await addPaper(cmd); }
      await serveAndOpen(p.id);
    }
  }
} catch (e) {
  fail(e.message);
}
