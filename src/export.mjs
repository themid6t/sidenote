// One paper's conversation (and optionally its archived chats) as a Markdown note, e.g. for Obsidian.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';

/** A file name that is safe on every OS: letters and digits (any script), dashes between. */
export function slug(title, fallback) {
  const s = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    .replace(/-+$/, '');
  return !s ? fallback : /^(con|prn|aux|nul|com\d|lpt\d)$/.test(s) ? `${s}-paper` : s;
}

const yaml = (v) => JSON.stringify(String(v)); // a JSON string is a valid YAML double-quoted scalar
const stamp = (iso) => iso.slice(0, 16).replace('T', ' ');

/**
 * The Markdown for paper `id`. With `files` ({ dir, rel }), region images are copied into `dir`
 * and linked as `rel/<name>`; without it they become "[region on p. N]".
 */
export function exportMarkdown(id, { all = false, files = null } = {}) {
  const p = store.getPaper(id);
  const dir = store.paperDir(id);
  const arxiv = /^\d{4}\.\d{4,5}(v\d+)?$/.test(p.id);
  const out = ['---', `title: ${yaml(p.title)}`,
    ...(arxiv ? [`source: ${yaml(`arXiv:${p.id}`)}`, `url: ${yaml(`https://arxiv.org/abs/${p.id}`)}`] : [`source: ${yaml(p.source)}`]),
    `pages: ${p.pages}`, `exported: ${new Date().toISOString().slice(0, 10)}`, '---', '', `# ${p.title}`, ''];
  const head = out.length;

  const chat = (messages, highlights) => {
    for (const m of messages) {
      if (m.role !== 'user') { out.push('### Claude', '', m.content.trim(), ''); continue; }
      out.push('### You', '');
      if (m.quote) out.push(...m.quote.split('\n').map((l) => `> ${l}`), ...(m.page ? [`> (p. ${m.page})`] : []), '');
      if (m.region) {
        const png = path.join(dir, 'regions', path.basename(m.region)); // stored absolute; the library may have moved
        const what = `region on p. ${m.page}`;
        if (!files) out.push(`[${what}]`, '');
        else if (!fs.existsSync(png)) out.push(`[${what}: image missing]`, '');
        else {
          fs.mkdirSync(files.dir, { recursive: true });
          fs.copyFileSync(png, path.join(files.dir, path.basename(png)));
          out.push(`![${what}](${encodeURI(`${files.rel}/${path.basename(png)}`)})`, '');
        }
      }
      out.push(m.content.trim(), '');
    }
    const ids = new Set(messages.map((m) => m.id));
    const loose = highlights.filter((h) => !ids.has(h.message_id));
    if (loose.length) out.push('### Other highlights', '', ...loose.map((h) => `- p. ${h.page}`), '');
  };
  const json = (d, f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return []; } };

  if (all) {
    const chats = path.join(dir, 'chats');
    for (const name of (fs.existsSync(chats) ? fs.readdirSync(chats).sort() : [])) {
      const msgs = json(path.join(chats, name), 'messages.json');
      if (!msgs.length) continue;
      out.push(`## Chat from ${stamp(msgs[0].created_at)}`, '');
      chat(msgs, json(path.join(chats, name), 'highlights.json'));
    }
  }
  const current = store.messages(id);
  if (all && current.length) out.push(`## Chat from ${stamp(current[0].created_at)}`, '');
  chat(current, store.highlights(id));
  if (out.length === head) out.push('_No questions yet._', '');
  return out.join('\n');
}
