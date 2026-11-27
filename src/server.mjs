// Local web reader: 127.0.0.1 only, random token, answers streamed over SSE.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';
import { getSession, closeAll, OVERVIEW } from './session.mjs';
import { VERSION, newerVersion } from './update.mjs';

import assets from './assets.gen.mjs';

const STATE = path.join(store.HOME, 'server.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ftl': 'text/plain; charset=utf-8' };
const mime = (p) => MIME[path.extname(p)] || 'application/octet-stream';
const decoded = new Map(); // asset -> {body, etag}, worked out once

/** A running server's {port, token, pid}, if it answers. */
export async function runningServer() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${s.port}/api/health`, {
      headers: { authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(1000) });
    return r.ok ? s : null;
  } catch { return null; }
}

export function startServer({ port = 4747 } = {}) {
  // The same token across restarts, so an open tab reconnects by itself. Private file, like an SSH key.
  const tokenFile = path.join(store.HOME, 'token');
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
  if (!/^[0-9a-f]{48}$/.test(token || '')) {
    token = randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  }
  const same = (a) => a && a.length === token.length && timingSafeEqual(Buffer.from(a), Buffer.from(token));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const actual = server.address().port;
      // DNS-rebinding and cross-site guards: only our own host and origin.
      if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host)) return send(res, 421, 'bad host');
      if (req.method !== 'GET' && req.headers.origin
        && ![`http://127.0.0.1:${actual}`, `http://localhost:${actual}`].includes(req.headers.origin)) return send(res, 403, 'bad origin');

      if (url.searchParams.has('t') && same(url.searchParams.get('t'))) {
        url.searchParams.delete('t');
        res.writeHead(302, { location: url.pathname + url.search,
          'set-cookie': `pr=${token}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end();
      }
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)pr=([0-9a-f]+)/)?.[1];
      const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!same(cookie) && !same(bearer)) return send(res, 401, 'Open the reader with `sidenote open` (the link carries a token).');

      return await route(req, res, url);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: e.message });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e) => (e.code === 'EADDRINUSE' && port !== 0
      ? server.listen(0, '127.0.0.1') : reject(e)));
    server.on('listening', () => {
      const info = { port: server.address().port, token, pid: process.pid };
      fs.writeFileSync(STATE, JSON.stringify(info), { mode: 0o600 });
      const cleanup = () => { try { if (JSON.parse(fs.readFileSync(STATE, 'utf8')).pid === process.pid) fs.rmSync(STATE); } catch {} };
      process.on('exit', () => { closeAll(); cleanup(); }); // no claude process outlives the server
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
      resolve({ ...info, server });
    });
    server.listen(port, '127.0.0.1');
  });
}

function send(res, status, body) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8' });
  res.end(json ? JSON.stringify(body) : body);
}

async function readJson(req, limit = 20 << 20) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': mime(file), 'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

async function route(req, res, url) {
  const p = url.pathname;
  const key = p === '/' || /^\/p\/[\w.-]+$/.test(p) ? '/app/index.html' : decodeURIComponent(p);
  if (assets[key]) {
    // Built into the binary, so they only change with it: an ETag lets the browser reuse its cached, compiled copy.
    if (!decoded.has(key)) decoded.set(key, { body: Buffer.from(assets[key], 'base64'), etag: `"${createHash('sha1').update(assets[key]).digest('base64url')}"` });
    const { body, etag } = decoded.get(key);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
    res.writeHead(200, { 'content-type': mime(key), 'cache-control': 'no-cache', etag });
    return res.end(body);
  }
  if (p === '/api/health') return send(res, 200, { ok: true });
  if (p === '/api/update') return newerVersion().then((latest) => send(res, 200, { version: VERSION, latest }));
  if (p === '/api/papers' && req.method === 'GET') return send(res, 200, store.listPapers());
  if (p === '/api/papers' && req.method === 'POST') {
    const { src } = await readJson(req);
    return send(res, 200, await store.importPaper(String(src || '').trim()));
  }

  const rm = p.match(/^\/api\/papers\/([\w.-]+)\/regions\/(\d+\.png)$/);
  if (rm && store.getPaper(rm[1])) return serveFile(res, path.join(store.paperDir(rm[1]), 'regions', rm[2]));

  const m = p.match(/^\/api\/papers\/([\w.-]+)(\/[a-z]+)?$/);
  const paper = m && store.getPaper(m[1]);
  if (!paper) return send(res, 404, { error: 'no such paper' });
  const sub = m[2] || '';

  if (sub === '' && req.method === 'GET') {
    store.touchPaper(paper.id);
    return send(res, 200, { paper, messages: store.messages(paper.id), highlights: store.highlights(paper.id), overview: OVERVIEW,
      session: getSession(paper.id).snapshot() });
  }
  if (sub === '/pdf') return serveFile(res, path.join(store.paperDir(paper.id), 'paper.pdf'));
  if (sub === '/state' && req.method === 'POST') {
    store.saveState(paper.id, await readJson(req));
    return send(res, 200, { ok: true });
  }
  if (sub === '/ask' && req.method === 'POST') {
    const b = await readJson(req);
    const question = String(b.question || '').trim();
    if (!question) return send(res, 400, { error: 'empty question' });
    const session = getSession(paper.id);
    if (session.busy) return send(res, 409, { error: 'already answering a question about this paper' });
    const regionPng = typeof b.region === 'string' && b.region.startsWith('data:image/png;base64,')
      ? Buffer.from(b.region.slice(22), 'base64') : null;
    const rects = Array.isArray(b.rects) ? b.rects.slice(0, 400).map((r) => r.slice(0, 4).map(Number)) : null;
    // Runs on the live session; watchers follow it on /events, so a closed tab doesn't lose the answer.
    session.ask({ question, quote: b.quote ? String(b.quote).slice(0, 20000) : null,
      page: Number(b.page) || null, rects, regionPng }).catch(() => {});
    return send(res, 202, { ok: true });
  }
  if (sub === '/events' && req.method === 'GET') {
    const session = getSession(paper.id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = (ev) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    emit({ type: 'snapshot', ...session.snapshot() });
    session.on('event', emit);
    try { session.warm(); } catch {} // a reader is open: get Claude Code started
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => { clearInterval(beat); session.off('event', emit); });
    return;
  }
  if (sub === '/permission' && req.method === 'POST') {
    const b = await readJson(req);
    const ok = getSession(paper.id).answer(String(b.id || ''), b.allow === true);
    return send(res, ok ? 200 : 404, ok ? { ok } : { error: 'that request was already answered' });
  }
  if (sub === '/new' && req.method === 'POST') {
    const session = getSession(paper.id);
    if (session.busy) return send(res, 409, { error: 'wait for the current answer, or stop it first' });
    session.close(true);
    store.newChat(paper.id);
    session.emitEvent({ type: 'reset' });
    return send(res, 200, { ok: true });
  }
  if (sub === '/stop' && req.method === 'POST') {
    return send(res, 200, { ok: getSession(paper.id).interrupt() });
  }
  return send(res, 404, { error: 'not found' });
}
