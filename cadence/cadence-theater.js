// cadence-theater · 2026-11-09a
//
// The two ways to watch a video in Cadence, around one YouTube player that is
// never moved or rebuilt (moving an iframe reloads it):
//
//   Reader view   the video docked above the text (resize from its bottom edge,
//                 opacity on hover) or popped out to float anywhere.
//   Full screen   the video fills the screen with subtitles: off, original, or
//                 original + translation. Pause and hover a word to see it.
//
// The panel is position:fixed on <body> in every mode; only its box changes.
// Subtitles listen to TTFollow's loop (onFrame), so there is one clock and one
// lookup for both views. Look ported from app.css (.yt-theater, .yt-stage …).
//
// Parts: CadencePanel (the box and its modes), CadenceSubs (subtitle lines),
// CadenceTranslate (line and word translation, cached per text).

(function (root) {
  'use strict';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };

  // ── CadenceTranslate ───────────────────────────────────────────────────────
  // Google's free endpoint, as app.js uses. Lines go in batches joined by line
  // breaks; if the answer doesn't split back into the same number of lines, each
  // line is asked for on its own. Results are kept in memory and in this
  // browser, keyed by the line's own text, so a re-converted document still hits.
  function CadenceTranslate(opts) {
    const fetcher = (opts && opts.fetch) || ((u) => fetch(u));
    let target = (opts && opts.target) || 'en';
    const mem = new Map(); // key: target|source|text
    const pending = new Map();
    const lsKey = t => 'cadence-tr:' + t;
    function loadLs(t) {
      try { return JSON.parse(store(lsKey(t)) || '{}') || {}; } catch (e) { return {}; }
    }
    function saveLs(t, add) {
      const cur = loadLs(t);
      Object.assign(cur, add);
      const keys = Object.keys(cur);
      if (keys.length > 6000) keys.slice(0, keys.length - 6000).forEach(k => delete cur[k]);
      try { store(lsKey(t), JSON.stringify(cur)); } catch (e) { /* full: memory still has it */ }
    }
    let ls = loadLs(target);
    const url = (src, tgt, q, dict) =>
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(src || 'auto')}&tl=${encodeURIComponent(tgt)}&dt=t${dict ? '&dt=bd' : ''}&q=${encodeURIComponent(q)}`;
    async function ask(src, q, dict) {
      const r = await fetcher(url(src, target, q, dict));
      if (!r || !r.ok) throw new Error('translate ' + (r && r.status));
      return r.json();
    }
    const joined = data => (data && data[0] || []).map(seg => seg && seg[0] || '').join('');

    function cached(text) { return mem.get(target + '|' + text) ?? ls[text] ?? null; }

    // lines: [{ key, text }] → resolves { key: translation } (missing ones left out)
    async function lines(src, items) {
      const out = {}, todo = [];
      for (const it of items) { const c = cached(it.text); if (c != null) out[it.key] = c; else todo.push(it); }
      const fresh = {};
      for (let i = 0; i < todo.length;) {
        const batch = []; let len = 0;
        while (i < todo.length && (batch.length === 0 || len + todo[i].text.length < 1100) && batch.length < 30) { batch.push(todo[i]); len += todo[i].text.length + 1; i++; }
        const pk = target + '|' + batch.map(b => b.text).join('\n');
        let p = pending.get(pk);
        if (!p) {
          p = (async () => {
            const res = {};
            try {
              const parts = joined(await ask(src, batch.map(b => b.text.replace(/\n/g, ' ')).join('\n'))).split('\n');
              if (parts.length === batch.length) batch.forEach((b, k) => { res[b.text] = parts[k].trim(); });
              else for (const b of batch) { try { res[b.text] = joined(await ask(src, b.text)).trim(); } catch (e) {} }
            } catch (e) { console.warn('[cadence] translation failed', e.message || e); }
            return res;
          })();
          pending.set(pk, p);
          p.finally(() => pending.delete(pk));
        }
        const res = await p;
        for (const b of batch) if (res[b.text] != null) { out[b.key] = res[b.text]; mem.set(target + '|' + b.text, res[b.text]); fresh[b.text] = res[b.text]; }
      }
      if (Object.keys(fresh).length) saveLs(target, fresh);
      return out;
    }

    // one word or phrase, with dictionary alternatives
    const wordMem = new Map();
    async function word(src, text) {
      const k = target + '|' + text;
      if (wordMem.has(k)) return wordMem.get(k);
      const p = ask(src, text, true).then(data => ({
        text: joined(data).trim(),
        alts: Array.isArray(data && data[1]) ? data[1].map(e => ({ pos: e[0] || '', words: (e[1] || []).slice(0, 4) })).filter(e => e.words.length) : []
      })).catch(() => null);
      wordMem.set(k, p);
      const r = await p; if (!r) wordMem.delete(k);
      return r;
    }

    return {
      lines, word, cached,
      get target() { return target; },
      setTarget(t) { if (t && t !== target) { target = t; ls = loadLs(t); } }
    };
  }

  // ── CadenceSubs ────────────────────────────────────────────────────────────
  // Shows the lines sounding now. In a short silence the last line stays (so the
  // text doesn't blink between sentences); in a long one it fades.
  // mode: 'off' | 'original' | 'both'
  function CadenceSubs(el, o) {
    let doc = o.doc, follow = o.follow, tr = o.translate, mode = o.mode || 'both';
    let shown = [], curWord = null, lastEnd = 0, linger = 1500, frameOff = null;
    let endsFor = null, endsMap = null; // line id → end, built once per index
    const endOf = (id, t) => {
      if (endsFor !== follow.index) { endsFor = follow.index; endsMap = new Map(follow.index.lines.map(l => [l.id, l.end])); }
      return endsMap.get(id) ?? t;
    };
    const lineSpans = new Map();

    function lineHtml(lid) {
      const l = doc.lines[lid]; if (!l) return '';
      const words = l.words.map(w => `<span class="cd-sw" data-w="${esc(w.id)}">${esc(w.text)}</span>`).join(' ');
      const t = l.translation && l.translation[tr.target];
      const c = t != null ? t : tr.cached(l.words.map(w => w.text).join(' '));
      const sp = l.speaker ? `<span class="cd-sub-sp">${esc(l.speaker)}</span>` : '';
      return `<div class="cd-sub" data-l="${esc(lid)}"><div class="cd-sub-o">${sp}${words}</div>` +
        (mode === 'both' ? `<div class="cd-sub-t${c == null ? ' wait' : ''}">${c == null ? '…' : esc(c)}</div>` : '') + `</div>`;
    }
    // order: 'orig' (original on top) | 'trans'; blur: 'none' | 'trans' | 'orig' | 'both'
    function look(o) {
      if (o.order) el.dataset.order = o.order;
      if (o.blur) el.dataset.blur = o.blur;
    }
    function show(ids) {
      if (ids.length === shown.length && ids.every((x, i) => x === shown[i])) return;
      shown = ids.slice();
      el.innerHTML = ids.map(lineHtml).join('');
      lineSpans.clear();
      el.querySelectorAll('.cd-sw').forEach(s => { lineSpans.set(s.dataset.w, s); if (o.decorate) o.decorate(s); });
      const old = curWord; curWord = null; mark(old);
      if (mode === 'both') fillTranslations(ids);
    }
    function mark(id) {
      if (id === curWord) return;
      const a = curWord && lineSpans.get(curWord); if (a) a.classList.remove('now');
      curWord = id;
      const b = id && lineSpans.get(id); if (b) b.classList.add('now');
    }
    function fillTranslations(ids) {
      const need = ids.filter(lid => { const l = doc.lines[lid]; return l && !(l.translation && l.translation[tr.target] != null); });
      if (!need.length) return;
      tr.lines(doc.language, need.map(lid => ({ key: lid, text: TimedText.lineText(doc, lid) }))).then(res => {
        for (const lid of Object.keys(res)) {
          const node = el.querySelector(`.cd-sub[data-l="${CSS.escape(lid)}"] .cd-sub-t`);
          if (node) { node.textContent = res[lid]; node.classList.remove('wait'); }
        }
      });
    }
    // translate ahead of the playhead, so the next lines are ready when they come
    let aheadAt = -1;
    function prefetch(t) {
      if (mode !== 'both' || !follow.index) return;
      if (aheadAt >= 0 && Math.abs(t - aheadAt) < 20000) return;
      aheadAt = t;
      const ls = follow.index.lines.filter(l => l.end >= t - 2000).slice(0, 24).map(l => l.id)
        .filter(lid => { const l = doc.lines[lid]; return l && !(l.translation && l.translation[tr.target] != null); });
      if (ls.length) tr.lines(doc.language, ls.map(lid => ({ key: lid, text: TimedText.lineText(doc, lid) })));
    }
    function frame(r, t) {
      if (mode === 'off') { if (shown.length) { shown = []; el.innerHTML = ''; } return; }
      if (r.lines.length) {
        show(r.lines);
        lastEnd = Math.max(...r.lines.map(id => endOf(id, t)));
      } else if (shown.length && t - lastEnd > linger) show([]);
      else if (shown.length && t < lastEnd - 2000) show([]); // sought backwards into silence
      mark(r.word);
      prefetch(t);
    }
    frameOff = follow.onFrame(frame);
    look({ order: o.order || 'orig', blur: o.blur || 'none' });
    // a finger can't hover: a tap on a blurred line shows it until the line changes
    el.addEventListener('click', e => {
      const part = e.target.closest('.cd-sub-o, .cd-sub-t');
      if (part && !e.target.closest('.cd-sw') && el.dataset.blur !== 'none') part.classList.toggle('shown');
    });
    return {
      look,
      get order() { return el.dataset.order || 'orig'; }, get blur() { return el.dataset.blur || 'none'; },
      setMode(m) { mode = m; shown = []; el.innerHTML = ''; aheadAt = -1; el.dataset.mode = m; follow.kick(); },
      get mode() { return mode; },
      setDoc(d) { doc = d; shown = []; el.innerHTML = ''; aheadAt = -1; },
      refresh() { const ids = shown; shown = []; show(ids); aheadAt = -1; },
      wordEl: id => lineSpans.get(id) || null,
      destroy() { if (frameOff) frameOff(); el.innerHTML = ''; }
    };
  }

  // ── CadencePanel ───────────────────────────────────────────────────────────
  // opts: { scroller, page (the article, given top padding when docked),
  //         onMode(mode), onLayout() }
  function CadencePanel(opts) {
    const st = Object.assign({ mode: 'docked', w: 33, fw: 380, op: 100, x: null, y: null },
      (() => { try { return JSON.parse(store('cadence-video') || '{}'); } catch (e) { return {}; } })());
    if (st.mode === 'theater') st.mode = 'docked';
    let viewBefore = st.mode; // where "Back to reader" returns to
    const save = () => store('cadence-video', JSON.stringify({ w: st.w, fw: st.fw, op: st.op, mode: st.mode === 'theater' ? viewBefore : st.mode, x: st.x, y: st.y }));

    const p = document.createElement('div');
    p.className = 'cd-video cd-docked';
    p.innerHTML = `
      <div class="cd-stage">
        <div class="cd-screen"><div id="cd-yt"></div></div>
        <div class="cd-op" title="Video opacity"><input type="range" min="20" max="100" value="${st.op}"></div>
        <div class="cd-corner">
          <button class="cd-dot cd-full" title="Full screen with subtitles (F)"><span class="cd-dot-ico"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 5.5v-4h4M10.5 1.5h4v4M14.5 10.5v4h-4M5.5 14.5h-4v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="cd-dot-txt">Full screen</span></button>
          <button class="cd-dot cd-pop" title="Pop out / dock"><span class="cd-dot-ico"><svg viewBox="0 0 20 14" width="14" height="10" aria-hidden="true"><rect x="1" y="1" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4.5" y="4" width="11" height="6" rx="1.3" fill="currentColor"/></svg></span><span class="cd-dot-txt">Pop out</span></button>
        </div>
        <div class="cd-resize" title="Drag to resize"><span></span></div>
      </div>
      <div class="cd-subs" aria-live="off"></div>
      <div class="cd-tbar">
        <button class="cd-tb cd-toreader" title="Back to the text (Esc)">← Reader</button>
        <span class="cd-tb-sp"></span>
        <span class="cd-tb-lbl">Subtitles</span>
        <div class="cd-seg cd-submode">
          <button data-sub="off">Off</button><button data-sub="original">Original</button><button data-sub="both">Dual</button>
        </div>
        <select class="cd-tb cd-target" title="Translate into">
          ${[['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['zh-CN', 'Chinese'], ['ja', 'Japanese']]
            .map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}
        </select>
        <button class="cd-tb cd-tset" title="Subtitle settings" aria-haspopup="true">⚙</button>
        <button class="cd-tb cd-tkeys" title="Keyboard shortcuts">⌨</button>
        <button class="cd-tb cd-tplay" title="Play / pause">▶</button>
        <div class="cd-menu" hidden>
          <div class="cd-menu-h">On top</div>
          <div class="cd-seg cd-order"><button data-order="orig">Original</button><button data-order="trans">Translation</button></div>
          <div class="cd-menu-h">Blur until you hover</div>
          <div class="cd-seg cd-blur"><button data-blur="none">None</button><button data-blur="trans">Translation</button><button data-blur="orig">Original</button><button data-blur="both">Both</button></div>
        </div>
      </div>
      <div class="cd-card" hidden></div>`;
    document.body.appendChild(p);
    const $ = s => p.querySelector(s);
    const stage = $('.cd-stage'), opIn = $('.cd-op input');
    const listeners = [];

    // ── placing the box ───────────────────────────────────────────────────
    function place() {
      const sc = opts.scroller, r = sc.getBoundingClientRect();
      p.style.setProperty('--op', st.op / 100);
      p.classList.toggle('cd-docked', st.mode === 'docked');
      p.classList.toggle('cd-floating', st.mode === 'floating');
      p.classList.toggle('cd-theater', st.mode === 'theater');
      document.body.classList.toggle('cd-in-theater', st.mode === 'theater');
      $('.cd-pop .cd-dot-txt').textContent = st.mode === 'floating' ? 'Dock' : 'Pop out';
      if (st.mode === 'theater') {
        p.style.left = p.style.top = '0'; p.style.width = p.style.height = '';
        if (opts.page) opts.page.style.paddingTop = '';
      } else if (st.mode === 'floating') {
        const w = Math.max(220, Math.min(st.fw, innerWidth - 16));
        p.style.width = w + 'px'; p.style.height = '';
        const x = st.x != null ? st.x : innerWidth - w - 24, y = st.y != null ? st.y : 90;
        p.style.left = Math.max(0, Math.min(x, innerWidth - w)) + 'px';
        p.style.top = Math.max(0, Math.min(y, innerHeight - 60)) + 'px';
        if (opts.page) opts.page.style.paddingTop = '';
      } else {
        const minW = Math.min(r.width - 16, innerWidth < 700 ? r.width - 16 : 220);
        const w = Math.max(minW, Math.min(r.width - 16, r.width * st.w / 100));
        p.style.width = w + 'px'; p.style.height = '';
        p.style.left = (r.left + (r.width - w) / 2) + 'px';
        p.style.top = (r.top + 8) + 'px';
        if (opts.page) opts.page.style.paddingTop = (p.offsetHeight + 16) + 'px';
      }
      if (opts.onLayout) opts.onLayout();
    }
    // how much of the text area the docked video covers
    function topInset() {
      if (st.mode !== 'docked' || p.style.display === 'none') return 0;
      const r = opts.scroller.getBoundingClientRect(), b = p.getBoundingClientRect();
      return Math.max(0, b.bottom - r.top + 6);
    }

    // ── modes ─────────────────────────────────────────────────────────────
    const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
    function setMode(m) {
      if (m === st.mode) return;
      if (m === 'theater') {
        viewBefore = st.mode;
        st.mode = 'theater'; place();
        const req = p.requestFullscreen || p.webkitRequestFullscreen;
        if (req) { try { const r = req.call(p); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
      } else {
        st.mode = m; hideCard();
        if (fsEl() === p) { const ex = document.exitFullscreen || document.webkitExitFullscreen; try { const r = ex && ex.call(document); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
        place();
      }
      save();
      listeners.forEach(f => f(st.mode));
    }
    const onFs = () => { if (!fsEl() && st.mode === 'theater') setMode(viewBefore === 'theater' ? 'docked' : viewBefore); };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);

    $('.cd-pop').onclick = e => { e.stopPropagation(); if (st.mode === 'floating') { st.x = st.y = null; setMode('docked'); } else setMode('floating'); };
    $('.cd-full').onclick = e => { e.stopPropagation(); setMode('theater'); };
    $('.cd-toreader').onclick = () => setMode(viewBefore === 'theater' ? 'docked' : viewBefore);
    opIn.oninput = () => { st.op = +opIn.value; p.style.setProperty('--op', st.op / 100); save(); };

    // ── drag to move, drag the bottom edge to resize (pointer: mouse and touch)
    let drag = null;
    stage.addEventListener('pointerdown', e => {
      if (st.mode === 'theater' || e.button > 0) return;
      if (e.target.closest('.cd-dot, .cd-op, input, button')) return;
      const r = p.getBoundingClientRect();
      if (e.target.closest('.cd-resize')) drag = { kind: 'size', sy: e.clientY, sw: r.width };
      else {
        if (e.pointerType === 'touch' && st.mode === 'docked') return; // a finger on a docked video scrolls the page
        drag = { kind: 'move', sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, w: r.width };
      }
      stage.setPointerCapture(e.pointerId);
      p.classList.add('cd-grab');
      e.preventDefault();
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) return;
      if (drag.kind === 'size') {
        const nw = drag.sw + (e.clientY - drag.sy) * (16 / 9);
        if (st.mode === 'floating') st.fw = Math.max(220, Math.min(nw, innerWidth - 16));
        else { const cw = opts.scroller.getBoundingClientRect().width; st.w = Math.max(18, Math.min(100, nw / cw * 100)); }
        place();
      } else {
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
        if (!drag.moved) { drag.moved = true; if (st.mode !== 'floating') { st.fw = drag.w; st.mode = 'floating'; listeners.forEach(f => f(st.mode)); } }
        st.x = drag.ox + e.clientX - drag.sx; st.y = drag.oy + e.clientY - drag.sy;
        place();
      }
    });
    const endDrag = () => { if (drag) { drag = null; p.classList.remove('cd-grab'); save(); } };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    addEventListener('resize', () => place());
    // the toolbar can wrap or unwrap (fonts load, buttons change): re-place then too
    if (window.ResizeObserver) {
      let raf = 0;
      const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (p.style.display !== 'none' && st.mode === 'docked') place(); }); });
      ro.observe(opts.scroller);
      if (opts.scroller.previousElementSibling) ro.observe(opts.scroller.previousElementSibling);
    }
    // in full screen, show the bar when the pointer moves, hide it after a while
    let idle = 0;
    function wake() { p.classList.add('cd-awake'); clearTimeout(idle); idle = setTimeout(() => p.classList.remove('cd-awake'), 2600); }
    p.addEventListener('pointermove', () => { if (st.mode === 'theater') wake(); });
    p.addEventListener('pointerdown', () => { if (st.mode === 'theater') wake(); });

    // ── the word card (full screen, paused) ───────────────────────────────
    const card = $('.cd-card');
    function showCard(anchor, html) {
      card.innerHTML = html; card.hidden = false;
      const a = anchor.getBoundingClientRect(), pr = p.getBoundingClientRect();
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let x = a.left + a.width / 2 - cw / 2 - pr.left, y = a.top - ch - 12 - pr.top;
      x = Math.max(8, Math.min(x, pr.width - cw - 8)); if (y < 8) y = a.bottom + 12 - pr.top;
      card.style.left = x + 'px'; card.style.top = y + 'px';
    }
    function hideCard() { card.hidden = true; }

    place();
    return {
      el: p, stage, subsEl: $('.cd-subs'), screen: $('.cd-screen'),
      get mode() { return st.mode; },
      setMode, place, topInset, wake,
      onMode(f) { listeners.push(f); },
      show(v) { p.style.display = v ? '' : 'none'; if (!v && st.mode === 'theater') setMode('docked'); if (!v && opts.page) opts.page.style.paddingTop = ''; if (v) place(); },
      showCard, hideCard, get cardEl() { return card; },
      // a box that must show in full screen too (only the panel is visible there)
      host: () => (st.mode === 'theater' ? p : document.body),
      $
    };
  }

  root.CadencePanel = CadencePanel;
  root.CadenceSubs = CadenceSubs;
  root.CadenceTranslate = CadenceTranslate;
})(window);
