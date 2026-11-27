import * as pdfjsLib from '/vendor/pdfjs/build/pdf.mjs';
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';

const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// No images, styles or forms in answers: a hostile PDF must not get Claude to leak data through a URL.
const md = (s) => DOMPurify.sanitize(marked.parse(s), { FORBID_TAGS: ['img', 'style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style', 'srcset'] });

const paperId = location.pathname.match(/^\/p\/([\w.-]+)$/)?.[1];
if (paperId) reader(decodeURIComponent(paperId)); else library();

// ───────────────────────────── Library ─────────────────────────────
async function library() {
  $('#library').hidden = false;
  document.title = 'sidenote';
  const papers = await api('/api/papers');
  $('#papers').innerHTML = papers.map((p) => `<li><a href="/p/${encodeURIComponent(p.id)}">
    <div class="t">${esc(p.title)}</div>
    <div class="m">${esc(p.id)} · page ${p.page} of ${p.pages} · ${p.questions} question${p.questions === 1 ? '' : 's'}
      · ${esc((p.opened_at || p.added_at).slice(0, 10))}</div></a></li>`).join('')
    || '<li class="muted">No papers yet. Add one above, e.g. <code>1706.03762</code>.</li>';
  $('#add').onsubmit = async (e) => {
    e.preventDefault();
    $('#add-status').textContent = 'Adding…';
    try {
      const p = await api('/api/papers', { method: 'POST', body: JSON.stringify({ src: $('#src').value }) });
      location.href = `/p/${encodeURIComponent(p.id)}`;
    } catch (err) { $('#add-status').textContent = err.message; }
  };
}

// ───────────────────────────── Reader ─────────────────────────────
async function reader(id) {
  $('#reader').hidden = false;
  // Resizable panes: drag the divider (or focus it and use ←/→); double-click resets; remembered per browser.
  // Set up before anything loads, so the layout doesn't jump and the divider works at once.
  const splitter = $('#splitter');
  const setSide = (px) => {
    const w = Math.round(Math.min(Math.max(px, 280), window.innerWidth - 260));
    document.documentElement.style.setProperty('--side-w', `${w}px`);
    splitter.setAttribute('aria-valuenow', String(w));
    return w;
  };
  const savedSide = Number(localStorage.getItem('sidenote.sideWidth'));
  if (savedSide) setSide(savedSide);
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging'); document.body.classList.add('resizing');
    const move = (ev) => setSide(window.innerWidth - ev.clientX);
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.classList.remove('dragging'); document.body.classList.remove('resizing');
      localStorage.setItem('sidenote.sideWidth', String($('#side').getBoundingClientRect().width));
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up, { once: true });
  });
  splitter.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: 40, ArrowRight: -40 }[e.key];
    if (!d) return;
    e.preventDefault();
    localStorage.setItem('sidenote.sideWidth', String(setSide($('#side').getBoundingClientRect().width + d)));
  });
  splitter.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--side-w');
    localStorage.removeItem('sidenote.sideWidth');
  });
  globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads the library from here
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
  // Start everything at once: the viewer code, the paper's info, and the PDF (worker + download + parse).
  const viewerCode = import('/vendor/pdfjs/web/pdf_viewer.mjs');
  const info = api(`/api/papers/${encodeURIComponent(id)}`);
  const loading = pdfjsLib.getDocument({
    url: `/api/papers/${encodeURIComponent(id)}/pdf`,
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', iccUrl: '/vendor/pdfjs/iccs/',
  }).promise;
  loading.catch(() => {}); // awaited below; this only stops an early failure being reported as unhandled
  const { EventBus, PDFViewer, PDFLinkService } = await viewerCode;
  performance.mark('sidenote:viewer-code');
  const data = await info;
  const { paper } = data;
  let highlights = data.highlights;
  document.title = paper.title;
  $('#title').textContent = paper.title;

  const container = $('#viewerContainer');
  const viewerEl = $('#viewer');
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, removePageBorders: false });
  linkService.setViewer(viewer);

  const doc = await loading;
  performance.mark('sidenote:doc');
  viewer.setDocument(doc);
  linkService.setDocument(doc);

  // Restore where you were.
  eventBus.on('pagesinit', () => {
    performance.mark('sidenote:pagesinit');
    viewer.currentScaleValue = paper.scale || 'page-width';
    // Right away, not next frame: otherwise pdf.js starts drawing page 1 first and throws that work away.
    const pv = viewer.getPageView(Math.min(paper.page, doc.numPages) - 1);
    if (pv) container.scrollTop = pv.div.offsetTop + paper.page_frac * pv.div.clientHeight;
  });
  const pageLabel = () => { $('#pageno').textContent = `${viewer.currentPageNumber} / ${doc.numPages}`; };
  eventBus.on('pagechanging', pageLabel);
  eventBus.on('pagesloaded', pageLabel);

  let saveTimer;
  const saveState = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const page = viewer.currentPageNumber;
      const div = viewer.getPageView(page - 1)?.div;
      if (!div) return;
      const frac = (container.scrollTop - div.offsetTop) / div.clientHeight;
      api(`/api/papers/${encodeURIComponent(id)}/state`, { method: 'POST',
        body: JSON.stringify({ page, frac, scale: viewer.currentScaleValue }) }).catch(() => {});
    }, 400);
  };
  container.addEventListener('scroll', saveState, { passive: true });
  eventBus.on('scalechanging', saveState);
  window.addEventListener('beforeunload', saveState);

  // Zoom
  // pdf.js works out "where you were" after it has already resized the pages, so its rescales can jump.
  // Instead: note the page point under an anchor (the cursor, or the top-left of the view), rescale,
  // then scroll so that same point of the paper is back under the anchor.
  const keepPlace = (rescale, clientX, clientY) => {
    const cr = container.getBoundingClientRect();
    const ax = (clientX ?? cr.left) - cr.left, ay = (clientY ?? cr.top) - cr.top;
    const x = container.scrollLeft + ax, y = container.scrollTop + ay;
    let at = null;
    for (let i = 0; i < doc.numPages; i++) {
      const div = viewer.getPageView(i)?.div;
      if (div && div.offsetTop + div.clientHeight > y) {
        at = { i, fx: (x - div.offsetLeft) / div.clientWidth, fy: (y - div.offsetTop) / div.clientHeight };
        break;
      }
    }
    rescale();
    const div = at && viewer.getPageView(at.i)?.div;
    if (!div) return;
    container.scrollTop = div.offsetTop + at.fy * div.clientHeight - ay;
    container.scrollLeft = div.offsetLeft + at.fx * div.clientWidth - ax;
  };
  const zoomBy = (factor, clientX, clientY) => keepPlace(() => {
    viewer.currentScale = Math.min(Math.max(viewer.currentScale * factor, 0.3), 5);
  }, clientX, clientY);
  // Pinch (touchpads send it as ctrl+wheel) and ctrl+scroll zoom the paper around the cursor, not the whole page.
  let pinch = 1, pinchAt = null, pinchFrame = 0;
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    pinch *= Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    pinchAt = [e.clientX, e.clientY];
    if (!pinchFrame) pinchFrame = requestAnimationFrame(() => {
      pinchFrame = 0;
      const f = pinch; pinch = 1;
      if (Math.abs(f - 1) > 0.001) zoomBy(f, ...pinchAt);
    });
  }, { passive: false });
  $('#zoom-in').onclick = () => zoomBy(1.15);
  $('#zoom-out').onclick = () => zoomBy(1 / 1.15);
  $('#zoom-fit').onclick = () => keepPlace(() => { viewer.currentScaleValue = 'page-width'; });
  // Keep "fit" zooms fitted when the pane changes size: at most once per frame while dragging the divider.
  let refit = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(refit);
    refit = requestAnimationFrame(() => {
      const v = viewer.currentScaleValue;
      if (viewer.pagesCount && ['page-width', 'page-fit', 'auto'].includes(v)) keepPlace(() => { viewer.currentScaleValue = v; });
    });
  }).observe(container);


  // ── Highlights: percent boxes in a layer on each page, redrawn whenever pdf.js re-renders the page.
  let pending = null; // {text, page, rects, region?}
  const layerOf = (pageNumber) => {
    const div = viewer.getPageView(pageNumber - 1)?.div;
    if (!div) return null;
    let layer = div.querySelector(':scope > .hl-layer');
    if (!layer) { layer = document.createElement('div'); layer.className = 'hl-layer'; div.append(layer); }
    return layer;
  };
  const drawPage = (pageNumber) => {
    const layer = layerOf(pageNumber);
    if (!layer) return;
    const items = highlights.filter((h) => h.page === pageNumber).map((h) => ({ ...h, cls: '' }));
    if (pending?.page === pageNumber) items.push({ rects: pending.rects, cls: 'pending', message_id: null });
    layer.innerHTML = items.flatMap((h) => h.rects.map(([x, y, w, hh]) => `<div class="hl ${h.cls}${h.rects.length === 1 && hh > 0.05 ? ' region' : ''}"
      data-msg="${h.message_id ?? ''}" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${hh * 100}%"></div>`)).join('');
  };
  eventBus.on('pagerendered', (e) => { performance.mark(`sidenote:rendered:${e.pageNumber}`); drawPage(e.pageNumber); });
  viewerEl.addEventListener('click', (e) => {
    const msg = e.target.closest?.('.hl')?.dataset.msg;
    if (msg) document.getElementById(`m${msg}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  const setPending = (p) => {
    const before = pending?.page;
    pending = p;
    if (before) drawPage(before);
    if (p) drawPage(p.page);
    $('#quote').hidden = !p;
    $('#quote-text').textContent = p ? (p.region ? `Region on page ${p.page}${p.text ? `: ${p.text}` : ''}` : p.text) : '';
    $('#ask-float').hidden = true;
  };
  $('#quote-x').onclick = () => setPending(null);

  // ── Text selection → pending quote.
  function readSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    // Join the PDF's hard line breaks into prose; keep blank-line paragraph breaks.
    const text = sel.toString().replace(/[ \t]*\n[ \t]*/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ').trim();
    const range = sel.getRangeAt(0);
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const pageDiv = start?.closest('.page');
    if (!text || !pageDiv || !viewerEl.contains(pageDiv)) return null;
    const pr = pageDiv.getBoundingClientRect();
    const rects = mergeRects([...range.getClientRects()]
      .filter((r) => r.width > 1 && r.height > 1 && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2)
      .map((r) => [(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height]));
    return { text, page: Number(pageDiv.dataset.pageNumber), rects, end: range.getBoundingClientRect() };
  }
  viewerEl.addEventListener('mouseup', () => setTimeout(() => {
    if (regionMode) return;
    const s = readSelection();
    if (!s) return;
    setPending({ text: s.text, page: s.page, rects: s.rects });
    const dr = $('#doc').getBoundingClientRect();
    const btn = $('#ask-float');
    btn.style.left = `${Math.min(s.end.right - dr.left, dr.width - 160)}px`;
    btn.style.top = `${s.end.bottom - dr.top + 6}px`;
    btn.hidden = false;
  }));
  $('#ask-float').onclick = () => { getSelection().removeAllRanges(); $('#ask-float').hidden = true; $('#q').focus(); };
  container.addEventListener('scroll', () => { $('#ask-float').hidden = true; }, { passive: true });

  // ── Region capture (R or the button): drag a box, crop the page canvas.
  let regionMode = false;
  const setRegionMode = (on) => {
    regionMode = on;
    viewerEl.classList.toggle('region-mode', on);
    $('#region-btn').setAttribute('aria-pressed', String(on));
  };
  $('#region-btn').onclick = () => setRegionMode(!regionMode);
  viewerEl.addEventListener('pointerdown', (e) => {
    if (!regionMode || e.button !== 0) return;
    const pageDiv = e.target.closest('.page');
    if (!pageDiv) return;
    e.preventDefault();
    const pr = pageDiv.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'drag-box';
    pageDiv.append(box);
    const x0 = e.clientX - pr.left, y0 = e.clientY - pr.top;
    const move = (ev) => {
      const x1 = Math.max(0, Math.min(pr.width, ev.clientX - pr.left)), y1 = Math.max(0, Math.min(pr.height, ev.clientY - pr.top));
      Object.assign(box.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`,
        width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const b = box.getBoundingClientRect();
      box.remove();
      setRegionMode(false);
      if (b.width < 8 || b.height < 8) return;
      const canvas = pageDiv.querySelector('canvas');
      if (!canvas) return; // the page hasn't been drawn yet
      const cr = canvas.getBoundingClientRect();
      const k = canvas.width / cr.width;
      const crop = document.createElement('canvas');
      crop.width = Math.round(b.width * k); crop.height = Math.round(b.height * k);
      crop.getContext('2d').drawImage(canvas, (b.left - cr.left) * k, (b.top - cr.top) * k, crop.width, crop.height, 0, 0, crop.width, crop.height);
      const rect = [(b.left - pr.left) / pr.width, (b.top - pr.top) / pr.height, b.width / pr.width, b.height / pr.height];
      const text = [...pageDiv.querySelectorAll('.textLayer span')].filter((s) => {
        const r = s.getBoundingClientRect();
        return r.left >= b.left - 2 && r.right <= b.right + 2 && r.top >= b.top - 2 && r.bottom <= b.bottom + 2;
      }).map((s) => s.textContent).join(' ').trim();
      setPending({ text, page: Number(pageDiv.dataset.pageNumber), rects: [rect], region: crop.toDataURL('image/png') });
      $('#q').focus();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // ── Chat
  const chat = $('#chat');
  const regionUrl = (m) => m.region && `/api/papers/${encodeURIComponent(id)}/regions/${encodeURIComponent(m.region.split(/[\\/]/).pop())}`;
  const toolItem = (t) => `<li data-tool="${esc(t.id || '')}" class="${t.error ? 'err' : ''}${t.sub ? ' sub' : ''}"><b>${esc(t.name)}</b> ${esc(t.summary || '')}</li>`;
  const activity = (tools, open) => (tools?.length
    ? `<details class="activity"${open ? ' open' : ''}><summary>${tools.length} step${tools.length === 1 ? '' : 's'}</summary><ul>${tools.map(toolItem).join('')}</ul></details>` : '');
  const renderMessage = (m) => {
    const el = document.createElement('div');
    el.className = `msg ${m.role}`;
    el.id = `m${m.id}`;
    if (m.role === 'user') {
      el.innerHTML = `<div class="meta">You${m.page ? ` · page ${m.page}` : ''}</div>`
        + (m.region ? `<img class="region" alt="Captured region" src="${regionUrl(m)}">` : '')
        + (m.quote ? `<blockquote data-page="${m.page}" data-msg="${m.id}" title="Show in the paper">${esc(m.quote)}</blockquote>` : '')
        + `<div class="q">${esc(m.content === data.overview ? 'Give me an overview of this paper.' : m.content)}</div>`;
    } else {
      el.innerHTML = `<div class="meta">Claude</div>${activity(m.tools)}<div class="body">${md(m.content)}</div>`;
    }
    chat.append(el);
    return el;
  };
  chat.addEventListener('click', (e) => {
    const q = e.target.closest('blockquote[data-page]');
    if (!q) return;
    const page = Number(q.dataset.page);
    viewer.scrollPageIntoView({ pageNumber: page });
    const h = highlights.find((x) => String(x.message_id) === q.dataset.msg);
    setTimeout(() => {
      const first = layerOf(page)?.querySelector(`.hl[data-msg="${q.dataset.msg}"]`);
      if (h && first) {
        first.scrollIntoView({ block: 'center' });
        layerOf(page).querySelectorAll(`.hl[data-msg="${q.dataset.msg}"]`).forEach((n) => {
          n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
        });
      }
    }, 150);
  });
  const renderHistory = (messages) => { chat.innerHTML = ''; messages.forEach(renderMessage); chat.scrollTop = chat.scrollHeight; };
  renderHistory(data.messages);

  // ── The live session: one event stream per paper, shared with other tabs and `sidenote ask`.
  const status = $('#status');
  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  let busy = false, live = null, frame = 0;
  const setBusy = (b) => {
    busy = b;
    $('#send').textContent = b ? 'Stop' : 'Ask';
    $('#send').classList.toggle('stop', b);
    if (!b) status.textContent = '';
  };
  const startLive = (text = '', tools = []) => {
    live?.el.remove();
    const el = renderMessage({ id: 'live', role: 'assistant', content: '' });
    el.querySelector('.body').classList.add('typing');
    live = { el, text, tools: [...tools] };
    drawLive();
  };
  const drawLive = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!live) return;
      const stick = nearBottom();
      const old = live.el.querySelector('.activity');
      const html = activity(live.tools, true);
      if (old) old.outerHTML = html; else if (html) live.el.querySelector('.meta').insertAdjacentHTML('afterend', html);
      live.el.querySelector('.body').innerHTML = md(live.text);
      if (stick) chat.scrollTop = chat.scrollHeight;
    });
  };
  const permissionCard = (perm) => {
    if (document.querySelector(`.perm[data-id="${CSS.escape(perm.id)}"]`)) return;
    const shown = perm.input?.command ?? JSON.stringify(perm.input, null, 2);
    const card = document.createElement('div');
    card.className = 'perm';
    card.dataset.id = perm.id;
    card.innerHTML = `<div class="perm-h">Claude wants to use <b>${esc(perm.tool)}</b></div>`
      + (perm.description ? `<div class="perm-d">${esc(perm.description)}</div>` : '')
      + `<pre>${esc(shown)}</pre><div class="perm-a"><button class="deny">Deny</button><button class="allow">Allow</button></div>`;
    card.querySelector('.allow').onclick = () => answer(perm.id, true);
    card.querySelector('.deny').onclick = () => answer(perm.id, false);
    (live?.el || chat).append(card);
    chat.scrollTop = chat.scrollHeight;
    card.querySelector('.allow').focus();
  };
  const answer = (pid, allow) => api(`/api/papers/${encodeURIComponent(id)}/permission`, {
    method: 'POST', body: JSON.stringify({ id: pid, allow }) }).catch(() => {});

  let connected = false;
  const events = new EventSource(`/api/papers/${encodeURIComponent(id)}/events`);
  events.onmessage = async (msg) => {
    const ev = JSON.parse(msg.data);
    switch (ev.type) {
      case 'snapshot':
        if (connected) renderHistory((await api(`/api/papers/${encodeURIComponent(id)}`)).messages); // caught up after a drop
        connected = true;
        live = null;
        setBusy(ev.busy);
        if (ev.turn) startLive(ev.turn.text, ev.turn.tools);
        ev.permissions.forEach(permissionCard);
        if (!ev.busy && !chat.children.length) ask(data.overview);
        break;
      case 'user':
        if (!document.getElementById(`m${ev.message.id}`)) renderMessage(ev.message);
        if (ev.highlight && !highlights.some((h) => h.id === ev.highlight.id)) { highlights.push(ev.highlight); drawPage(ev.highlight.page); }
        setBusy(true);
        startLive();
        chat.scrollTop = chat.scrollHeight;
        break;
      case 'reset':
        live = null;
        chat.innerHTML = '';
        document.querySelectorAll('.perm').forEach((c) => c.remove());
        highlights = [];
        for (let n = 1; n <= doc.numPages; n++) drawPage(n);
        setBusy(false);
        break;
      case 'status': status.textContent = ev.text; break;
      case 'delta': if (live) { live.text += ev.text; status.textContent = ''; drawLive(); } break;
      case 'tool': if (live) { live.tools.push(ev.tool); drawLive(); } break;
      case 'tool_done': {
        const t = live?.tools.find((x) => x.id === ev.id);
        if (t) { t.error = ev.error; drawLive(); }
        break;
      }
      case 'permission': permissionCard(ev.permission); break;
      case 'permission_resolved':
        document.querySelector(`.perm[data-id="${CSS.escape(ev.id)}"]`)?.remove();
        break;
      case 'done':
        cancelAnimationFrame(frame);
        live?.el.remove(); live = null;
        renderMessage(ev.message);
        chat.scrollTop = chat.scrollHeight;
        setBusy(false);
        break;
      case 'error':
        if (live) {
          cancelAnimationFrame(frame);
          live.el.classList.add('error');
          live.el.querySelector('.body').classList.remove('typing');
          live.el.querySelector('.body').textContent = ev.text;
          live.el.id = ''; live = null;
        }
        document.querySelectorAll('.perm').forEach((c) => c.remove());
        setBusy(false);
        break;
    }
  };
  events.onerror = () => { status.textContent = 'reconnecting…'; };

  async function ask(question) {
    if (busy || !question.trim()) return;
    const p = pending;
    setPending(null);
    getSelection().removeAllRanges();
    setBusy(true);
    status.textContent = 'sending…';
    try {
      await api(`/api/papers/${encodeURIComponent(id)}/ask`, { method: 'POST',
        body: JSON.stringify({ question, quote: p?.text || null, page: p?.page || viewer.currentPageNumber,
          rects: p?.rects || null, region: p?.region || null }) });
    } catch (err) {
      setBusy(false);
      status.textContent = err.message;
    }
  }
  $('#new-chat').onclick = async () => {
    if (busy || !chat.children.length) return;
    if (!confirm('Start a new chat? The current one is archived in the paper\'s folder, not deleted.')) return;
    try {
      await api(`/api/papers/${encodeURIComponent(id)}/new`, { method: 'POST' });
      ask(data.overview);
    } catch (err) { status.textContent = err.message; }
  };
  const stop = () => api(`/api/papers/${encodeURIComponent(id)}/stop`, { method: 'POST' }).catch(() => {});

  $('#composer').onsubmit = (e) => {
    e.preventDefault();
    if (busy) return stop();
    const q = $('#q').value; $('#q').value = ''; ask(q);
  };
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches?.('textarea, input');
    if ((e.ctrlKey || e.metaKey) && ['=', '+', '-', '0'].includes(e.key)) {
      e.preventDefault(); // zoom the paper, not the whole app
      if (e.key === '0') keepPlace(() => { viewer.currentScaleValue = 'page-width'; });
      else zoomBy(e.key === '-' ? 1 / 1.15 : 1.15);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      const s = !pending && readSelection();
      if (s) setPending({ text: s.text, page: s.page, rects: s.rects });
      if (pending) ask('Explain this: what it means and why it matters here.');
    } else if (e.key === 'Escape') {
      setPending(null); setRegionMode(false);
    } else if (!typing && e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
      setRegionMode(!regionMode);
    }
  });

}

/** Merge the many per-span rects of a selection into one box per line. */
function mergeRects(rects) {
  const lines = [];
  for (const r of rects.sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const l = lines.find((x) => Math.abs(x[1] - r[1]) < r[3] * 0.5 && r[0] <= x[0] + x[2] + 0.02);
    if (l) {
      const x0 = Math.min(l[0], r[0]), y0 = Math.min(l[1], r[1]);
      l[2] = Math.max(l[0] + l[2], r[0] + r[2]) - x0; l[3] = Math.max(l[1] + l[3], r[1] + r[3]) - y0;
      l[0] = x0; l[1] = y0;
    } else lines.push([...r]);
  }
  return lines.map((r) => r.map((v) => Math.round(v * 1e4) / 1e4));
}
