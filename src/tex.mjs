// The arXiv LaTeX source, so Claude can read exact equations: /e-print/<id> is a gzipped tar, a single gzipped
// .tex, or the PDF itself when there is no source. Only .tex text is kept, in memory; nothing from the archive is
// written to disk under its own name.
import zlib from 'node:zlib';

const MAX_DOWNLOAD = 60e6;  // arXiv caps submissions at 50 MB
const MAX_TAR = 200e6;      // gunzipped; ponytail: whole tar in memory, stream it if this ever bites
const MAX_TEX = 5e6;        // total .tex kept

/** Files of a ustar archive as [{name, data}] (regular files only); stops at the end or at a bad header. */
export function untar(buf) {
  const files = [];
  for (let at = 0; at + 512 <= buf.length;) {
    const h = buf.subarray(at, at + 512);
    if (h.subarray(257, 262).toString() !== 'ustar') break; // the end (zero blocks), or not a tar
    const str = (a, b) => h.subarray(a, b).toString('latin1').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) break;
    const prefix = str(345, 500);
    const type = str(156, 157);
    const start = at + 512;
    if (start + size > buf.length) break; // truncated
    if (type === '0' || type === '') files.push({ name: (prefix ? prefix + '/' : '') + str(0, 100), data: buf.subarray(start, start + size) });
    at = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

const has = (s, cmd) => new RegExp(`^[^%\\n]*\\\\${cmd}`, 'm').test(s); // not commented out

/** The .tex of an e-print body (gzipped or not) as one string, main file first; null if there is none. */
export function texFromSource(body, name = 'paper.tex') {
  let buf = Buffer.from(body);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_TAR });
  if (buf.subarray(0, 5).toString() === '%PDF-') return null;
  let files = buf.subarray(257, 262).toString() === 'ustar' ? untar(buf).filter((f) => /\.tex$/i.test(f.name))
    : [{ name, data: buf }];
  files = files.filter((f) => f.data.length <= MAX_TEX)
    .map((f) => ({ name: f.name.replace(/[\r\n]/g, ' '), text: f.data.toString('utf8') }))
    .filter((f) => !f.text.includes('\0')); // a single file that is not text
  // The main file: \documentclass and \begin{document}, else just \documentclass.
  let main = files.findIndex((f) => has(f.text, 'documentclass') && has(f.text, 'begin\\{document\\}'));
  if (main < 0) main = files.findIndex((f) => has(f.text, 'documentclass'));
  if (main < 0) return null;
  files.unshift(...files.splice(main, 1));
  let out = '';
  for (const f of files) {
    const part = `%%%% file: ${f.name}\n${f.text}${f.text.endsWith('\n') ? '' : '\n'}`;
    if (out.length + part.length > MAX_TEX) continue;
    out += part;
  }
  return out || null;
}

/** Fetch and flatten the source of an arXiv id; null when there is none. Throws on network errors. */
export async function fetchTex(id, { base = 'https://arxiv.org', timeout = 300_000 } = {}) { // runs in the background: big sources (40 MB+) need time on slow links
  const res = await fetch(`${base}/e-print/${id}`, { headers: { 'user-agent': 'sidenote' }, redirect: 'follow',
    signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return null;
  // A PDF-only submission is served as the PDF itself: don't download it again.
  if (/pdf/i.test(res.headers.get('content-type')) || Number(res.headers.get('content-length')) > MAX_DOWNLOAD) {
    res.body?.cancel(); return null;
  }
  const body = Buffer.from(await res.arrayBuffer());
  return body.length > MAX_DOWNLOAD ? null : texFromSource(body, `${id}.tex`);
}
