// PDF text, title and page count with pdf.js, so users need no poppler.
// Loaded only when adding a paper: pdf.js's Node build warns about canvas polyfills it doesn't need here.
async function load() {
  const log = console.log, warn = console.warn;
  const quiet = (f) => (...a) => (String(a[0]).startsWith('Warning:') ? undefined : f(...a));
  console.log = quiet(log); console.warn = quiet(warn);
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Run the worker in-process; the import also gets it bundled into the binary.
    globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return { pdfjs, restore: () => { console.log = log; console.warn = warn; } };
  } catch (e) { console.log = log; console.warn = warn; throw e; }
}

/** {pages, title, text}: text has "──── page N ────" markers Claude can cite. */
export async function extract(bytes) {
  const { pdfjs, restore } = await load();
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    const meta = await doc.getMetadata().catch(() => ({}));
    const out = [];
    let bigText = '';
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      let s = '';
      for (const it of items) s += (it.str ?? '') + (it.hasEOL ? '\n' : '');
      if (n === 1) { // the title is the biggest text on page 1 (the first line may be a notice or a header)
        const upright = items.filter((it) => it.str?.trim() && !it.transform[1] && !it.transform[2]); // not arXiv's side stamp
        const big = Math.max(0, ...upright.map((it) => it.transform[3]));
        // The first block of lines set in the biggest text, top down, stopping at a gap (a scan's body text can be
        // the same size as its title). Whole lines, so small-caps titles keep their smaller letters.
        const ys = [...new Set(upright.filter((it) => it.transform[3] > big * 0.95).map((it) => Math.round(it.transform[5])))]
          .sort((a, b) => b - a);
        const block = [ys[0]];
        for (const y of ys.slice(1)) { if (block.at(-1) - y > big * 2) break; block.push(y); }
        const lines = new Set(block);
        bigText = items.filter((it) => !it.transform[1] && !it.transform[2] && lines.has(Math.round(it.transform[5])))
          .map((it) => it.str + (it.hasEOL ? ' ' : '')).join('').replace(/\s+/g, ' ').trim();
      }
      if (s.trim()) out.push(`──── page ${n} ────\n${s.trim()}`);
      page.cleanup();
    }
    const text = out.join('\n\n');
    const title = String(meta.info?.Title || '').trim()
      || (bigText.length > 8 && bigText.length < 300 ? bigText : '')
      || text.split('\n').map((l) => l.trim()).find((l) => l.length > 8 && !l.startsWith('────'))?.slice(0, 160)
      || '';
    const pages = doc.numPages;
    await task.destroy();
    return { pages, title, text };
  } finally { restore(); }
}
