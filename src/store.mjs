// Library and history as plain files: papers/<id>/{paper.pdf, paper.txt, meta.json, messages.json, highlights.json}.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from './pdf.mjs';
import { fetchTex } from './tex.mjs';

export const HOME = process.env.SIDENOTE_HOME || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'sidenote')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'sidenote'));
const PAPERS = path.join(HOME, 'papers');
fs.mkdirSync(PAPERS, { recursive: true });

export const paperDir = (id) => path.join(PAPERS, id);

const read = (id, file, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(paperDir(id), file), 'utf8')); } catch { return fallback; }
};
const write = (id, file, value) => { // write-then-rename, so a crash never leaves half a file
  const f = path.join(paperDir(id), file);
  fs.writeFileSync(f + '.tmp', JSON.stringify(value, null, 1));
  fs.renameSync(f + '.tmp', f);
};
const now = () => new Date().toISOString();

const ARXIV = /^(?:arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$/i;
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i;

/** Add a paper from a local PDF, an arXiv id or a PDF URL; returns its meta. Re-adding is a no-op. */
export async function importPaper(src) {
  let bytes, id, url;
  const arxiv = src.match(ARXIV) || src.match(ARXIV_URL);
  if (arxiv) {
    id = arxiv[1] + (arxiv[2] || '');
    url = `https://arxiv.org/pdf/${id}`;
  } else if (/^https?:\/\//.test(src)) {
    url = src;
  } else {
    bytes = fs.readFileSync(path.resolve(src.replace(/^~(?=[\\/])/, os.homedir())));
  }
  if (id && getPaper(id)) return getPaper(id);
  const tex = id && fetchTex(id).catch(() => null); // in parallel with the PDF; best-effort
  if (url) {
    const res = await fetch(url, { headers: { 'user-agent': 'sidenote' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  id ||= createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  if (getPaper(id)) return getPaper(id);

  const { pages, title, text } = await extract(bytes);
  const dir = paperDir(id);
  fs.mkdirSync(path.join(dir, 'regions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'paper.pdf'), bytes);
  fs.writeFileSync(path.join(dir, 'paper.txt'), text);
  if (tex) { // usually done by now; if arXiv is slow, don't hold up the add: it lands in the background
    const t = await Promise.race([tex, new Promise((r) => setTimeout(r, 3000, 'late').unref())]);
    if (t === 'late') tex.then((t2) => getPaper(id) && writeTex(id, t2)); else writeTex(id, t);
  }
  write(id, 'meta.json', { id, title: title || id, source: src, pages, added_at: now(), opened_at: null,
    page: 1, page_frac: 0, scale: null, session_id: null });
  return getPaper(id);
}

const writeTex = (id, tex) => {
  if (!tex) return false;
  const f = path.join(paperDir(id), 'paper.tex');
  fs.writeFileSync(f + '.tmp', tex);
  fs.renameSync(f + '.tmp', f);
  return true;
};
export const hasTex = (id) => fs.existsSync(path.join(paperDir(id), 'paper.tex'));

const tried = new Set();
/** Papers added before paper.tex existed: fetch it in the background, once per run; it's there next session. */
export function addTexLater(id) {
  if (tried.has(id) || !ARXIV.test(id) || hasTex(id)) return;
  tried.add(id);
  fetchTex(id).then((t) => getPaper(id) && writeTex(id, t)).catch(() => {});
}

export const getPaper = (id) => (/^[\w.-]+$/.test(id) ? read(id, 'meta.json', null) : null);
const update = (id, patch) => { const p = getPaper(id); write(id, 'meta.json', { ...p, ...patch }); };

export const listPapers = () => fs.readdirSync(PAPERS).map(getPaper).filter(Boolean)
  .map((p) => ({ ...p, questions: messages(p.id).filter((m) => m.role === 'user').length }))
  .sort((a, b) => (b.opened_at || b.added_at).localeCompare(a.opened_at || a.added_at));

/** Resolve a CLI argument to a paper: exact id, then a unique title/id substring. */
export function findPaper(q) {
  const exact = getPaper(q) || getPaper(q.match(ARXIV)?.[1] || '');
  if (exact) return exact;
  const hits = listPapers().filter((p) => (p.id + ' ' + p.title).toLowerCase().includes(q.toLowerCase()));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `"${q}" matches ${hits.length} papers: ${hits.map((p) => p.id).join(', ')}`
    : `no paper matches "${q}"`);
}

export const removePaper = (id) => fs.rmSync(paperDir(id), { recursive: true, force: true });
export const touchPaper = (id) => update(id, { opened_at: now() });
export const saveState = (id, { page, frac, scale }) => update(id, {
  page: Math.max(1, page | 0), page_frac: Math.min(1, Math.max(0, Number(frac) || 0)), scale: String(scale || '') || null });
export const setSession = (id, sessionId) => update(id, { session_id: sessionId });

export const messages = (id) => read(id, 'messages.json', []);
export function addMessage(paperId, role, content, extra = {}) {
  const all = messages(paperId);
  const m = { id: all.length + 1, role, content, quote: extra.quote ?? null, page: extra.page ?? null,
    region: extra.region ?? null, tools: extra.tools?.length ? extra.tools : undefined, created_at: now() };
  write(paperId, 'messages.json', [...all, m]);
  return m;
}

/** Start over: the current chat moves to chats/<time>/ (kept, not deleted) and the Claude session is dropped. */
export function newChat(id) {
  const dir = paperDir(id);
  const files = ['messages.json', 'highlights.json'].filter((f) => fs.existsSync(path.join(dir, f)));
  if (files.length) {
    const to = path.join(dir, 'chats', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(to, { recursive: true });
    for (const f of files) fs.renameSync(path.join(dir, f), path.join(to, f));
  }
  setSession(id, null);
}
export const highlights = (id) => read(id, 'highlights.json', []);
export function addHighlight(paperId, messageId, page, rects) {
  const all = highlights(paperId);
  const h = { id: all.length + 1, message_id: messageId, page, rects, created_at: now() };
  write(paperId, 'highlights.json', [...all, h]);
  return h;
}
