// app.js — renders both the sidebar (?view=sidebar) and the full tab.
'use strict';

const IS_SIDEBAR = new URLSearchParams(location.search).get('view') === 'sidebar';
const $root = document.getElementById('root');

let S = null;           // full data snapshot
let ui = {
  // single source of truth for the main area:
  //   'activity' | 'library' | 'reader'  (top tabs)
  //   'session' | 'allterms' | 'list:<id>'  (left-nav destinations)
  view: 'session',
  navCollapsed: false,
  search: '',
  sort: 'newest',
  selected: new Set(),  // selected term ids (checkboxes / clicked chips)
  actFilter: 'all',
  actSort: 'recent',
  actSelected: null,
  libSort: 'name',
  libFolder: null,     // currently-open folder in Library (null = root)
  libSelected: new Set(),   // selected tiles in library "type:id"
  libTileSize: 120,         // tile min width in px
  // reader
  readerTextId: null,
  readerEditing: true,
  readerFull: false,
  readerBarCollapsed: false,
  readerSel: new Set(),
  hlHidden: {},        // { yellow:true } = that color hidden in reader text
  itemMode: 'terms',   // 'terms' | 'highlights' — toggle in session/all views
  hlColorFilter: new Set(),  // active color filters; empty = show all
  sbSel: new Set(),    // selected items in the sidebar
};

// ── boot ──────────────────────────────────────────────────────────────
async function boot() {
  S = await VocabStore.getAll();
  await purgeInvalidMarks();
  // deep link: app.html#text=<id> opens that text in the reader
  const m = (location.hash || '').match(/text=([^&]+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (S.texts[id]) { ui.view = 'reader'; ui.readerTextId = id; ui.readerEditing = false; }
    try { history.replaceState(null, '', location.pathname); } catch {}
  }
  render();
}
// one-time cleanup of marks with out-of-range positions (from earlier bugs)
async function purgeInvalidMarks() {
  let changed = false;
  for (const t of Object.values(S.texts || {})) {
    if (!t.marks || !t.marks.length) continue;
    const body = t.body || '';
    const before = t.marks.length;
    t.marks = t.marks.filter(m =>
      Number.isFinite(m.start) && Number.isFinite(m.end) &&
      m.start >= 0 && m.end <= body.length && m.end > m.start
    );
    if (t.marks.length !== before) changed = true;
  }
  if (changed) { await VocabStore.set({ texts: S.texts }); S = await VocabStore.getAll(); }
}
let _selfWriteToken = 0;
let _lastSeenToken = 0;
// Mark that the app itself is about to write; onChanged will skip re-render for it.
function markSelfWrite() { _selfWriteToken = Date.now() + Math.random(); window.__vocabWriteToken = _selfWriteToken; }

chrome.storage.onChanged.addListener(async (changes) => {
  // If only the engagement counter changed, never re-render (it would reset scroll).
  const keys = Object.keys(changes);
  if (keys.length === 1 && keys[0] === 'texts') {
    // check whether anything other than engagedMs/lastActiveAt changed
    const before = changes.texts.oldValue || {};
    const after = changes.texts.newValue || {};
    if (!structurallyChangedTexts(before, after)) {
      S.texts = after; // keep state fresh without re-rendering
      return;
    }
  }
  S = await VocabStore.getAll();
  // don't yank the reader's scroll while actively reading
  if (ui.view === 'reader' && !ui.readerEditing) { refreshLeftNav(); return; }
  render();
});

// returns true if texts differ in any field beyond engagedMs/lastActiveAt
function structurallyChangedTexts(before, after) {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of ids) {
    const a = before[id], b = after[id];
    if (!a || !b) return true; // added/removed a text
    // compare everything except the engagement fields
    const stripA = { ...a, engagedMs:0, lastActiveAt:0 };
    const stripB = { ...b, engagedMs:0, lastActiveAt:0 };
    if (JSON.stringify(stripA) !== JSON.stringify(stripB)) return true;
  }
  return false;
}

// After a save while reading, rebuild the entire left nav from current state — so every
// count, list, folder, and rename stays correct with nothing to enumerate — while leaving
// the reading pane (and its scroll) completely untouched, since the pane is a separate
// sibling element. This is why the reader can skip the expensive full render() yet never
// show a stale nav.
function refreshLeftNav() {
  const nav = $root.querySelector('nav.lnav');
  if (!nav) return;
  const tree = nav.querySelector('#lib-tree');
  const treeScroll = tree ? tree.scrollTop : null;   // keep the library tree's own scroll
  const tmp = document.createElement('div');
  tmp.innerHTML = renderLeftNav();
  const fresh = tmp.firstElementChild;
  if (!fresh) return;
  nav.replaceWith(fresh);
  wireLeftNav();
  if (treeScroll != null) { const t = $root.querySelector('#lib-tree'); if (t) t.scrollTop = treeScroll; }
}
window.addEventListener('message', (e) => {
  if (e.data && e.data.vocab === 'refresh') boot();
});

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Tell any open web pages to remove the on-page paint for these highlight ids.
function broadcastRemovePaint(ids) {
  try { chrome.runtime.sendMessage({ action: 'broadcastRemovePaint', ids }, () => void chrome.runtime.lastError); } catch {}
}
// Focus only when we're the top document; autofocus is blocked in the sidebar iframe.
function safeFocus(el) { try { if (!IS_SIDEBAR && el) el.focus(); } catch {} }

// ── helpers ───────────────────────────────────────────────────────────
// All items = masters and standalones only (copies live inside their lists).
function allTermsArr() { return Object.values(S.terms).filter(t => !t.deletedAt && !t.masterId); }
function sessionTerms() { return S.session.termIds.map(id => S.terms[id]).filter(t => t && !t.deletedAt && !t.masterId); }
function allHighlightsArr() { return Object.values(S.highlights || {}).filter(h => !h.deletedAt && !h.masterId); }
function sessionHighlights() { return (S.session.highlightIds||[]).map(id => S.highlights[id]).filter(h => h && !h.deletedAt && !h.masterId); }
function hlLists(h) { return Array.isArray(h.listIds) ? h.listIds : []; }
// list views show the copies (or legacy members) whose listIds include the list
function highlightListTerms(listId) { return Object.values(S.highlights||{}).filter(h => !h.deletedAt && hlLists(h).includes(listId)); }
function termLists(t) { return Array.isArray(t.listIds) ? t.listIds : (t.listId ? [t.listId] : []); }
function listTerms(listId) { return Object.values(S.terms).filter(t => !t.deletedAt && termLists(t).includes(listId)); }
function listById(id) { const l = S.lists[id]; return (l && !l.deletedAt) ? l : null; }
// trash accessor
function trashedItems() {
  const out = [];
  const push = (kind, obj) => out.push({ kind, obj });
  // a copy that was trashed together with its master is represented by the master row
  const masterBatchTrashed = (obj, coll) => obj.masterId && obj.trashBatch && coll[obj.masterId] && coll[obj.masterId].deletedAt && coll[obj.masterId].trashBatch === obj.trashBatch;
  for (const t of Object.values(S.terms)) if (t.deletedAt && !masterBatchTrashed(t, S.terms)) push('term', t);
  for (const h of Object.values(S.highlights||{})) if (h.deletedAt && !masterBatchTrashed(h, S.highlights||{})) push('highlight', h);
  for (const l of Object.values(S.lists)) if (l.deletedAt) push('list', l);
  for (const l of Object.values(S.highlightLists||{})) if (l.deletedAt) push('highlightList', l);
  for (const f of Object.values(S.folders)) if (f.deletedAt) push('folder', f);
  for (const x of Object.values(S.texts)) if (x.deletedAt) push('text', x);
  return out.sort((a,b)=>b.obj.deletedAt - a.obj.deletedAt);
}

// Update row + toolbar selection state in place — avoids a full re-render
// (which was slow and re-sorted the list, making rows jump on each click).
function refreshRowSelectionDOM() {
  const hasSel = ui.selected.size > 0;
  document.querySelectorAll('[data-term],[data-hl]').forEach(tr => {
    const id = tr.dataset.term || tr.dataset.hl;
    const on = ui.selected.has(id);
    tr.classList.toggle('sel', on);
    const cb = tr.querySelector('.cb'); if (cb) cb.classList.toggle('on', on);
  });
  document.querySelectorAll('.sel-only').forEach(el => el.classList.toggle('hidden', !hasSel));
}

// ══════════════════════════════════════════════════════════════════════
//  Row multi-select — one controller for both the items and highlights
//  tables. Gestures:
//    plain click         → select only that row
//    ctrl / cmd click    → toggle that row, keep the rest
//    shift click         → range from the anchor to this row
//    shift + drag        → marquee box (replaces the selection)
//    ctrl + shift + drag → marquee box (adds to the selection)
//    plain drag on a row → drag-to-list (handled by the row's dragstart)
//  A plain click or Escape that would wipe a selection of 7+ asks first.
//  Selection never mutates on dragstart — that was the old intermittent bug.
// ══════════════════════════════════════════════════════════════════════
let _selGesture = null;   // the in-progress mouse gesture
let _marqueeEl = null;    // the visible rubber-band box
let _selGlobalsWired = false;

const DESELECT_GUARD = 7; // ask before clearing a selection this size or larger

function ensureSelGlobals() {
  if (_selGlobalsWired) return;
  _selGlobalsWired = true;

  window.addEventListener('mousemove', (e) => {
    const g = _selGesture; if (!g) return;
    if (!g.moved) {
      if (Math.abs(e.clientX - g.x0) < 5 && Math.abs(e.clientY - g.y0) < 5) return;
      g.moved = true;
      if (g.shift) {                       // a shift-drag becomes a marquee
        document.body.classList.add('marquee-active');
        _marqueeEl = document.createElement('div');
        _marqueeEl.className = 'marquee';
        document.body.appendChild(_marqueeEl);
      }
    }
    if (g.shift && _marqueeEl) {
      const x = Math.min(e.clientX, g.x0), y = Math.min(e.clientY, g.y0);
      const w = Math.abs(e.clientX - g.x0), h = Math.abs(e.clientY - g.y0);
      _marqueeEl.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
      const box = { left: x, top: y, right: x + w, bottom: y + h };
      const sel = g.opt.sel;
      sel.clear();
      if (g.snapshot) for (const id of g.snapshot) sel.add(id);   // ctrl+shift keeps prior picks
      for (const row of g.container.querySelectorAll(g.rowSel)) {
        const r = row.getBoundingClientRect();
        const hit = !(r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom);
        if (hit) sel.add(row.dataset[g.opt.idAttr]);
      }
      refreshRowSelectionDOM();
    }
  });

  const endGesture = (e) => {
    const g = _selGesture; if (!g) return;
    _selGesture = null;
    if (_marqueeEl) { _marqueeEl.remove(); _marqueeEl = null; document.body.classList.remove('marquee-active'); }
    if (g.shift) {
      if (!g.moved && g.id) g.rangeTo(g.id, g.ctrl);   // shift-click (no drag) = range
      return;
    }
    if (!g.moved && g.id) { g.ctrl ? g.toggleOne(g.id) : g.selectOnly(g.id, e); }
    else if (!g.moved && !g.id && !g.ctrl) g.clearAll(e);   // click on empty space = deselect
  };
  window.addEventListener('mouseup', endGesture);
  window.addEventListener('dragend', () => {
    _selGesture = null;
    if (_marqueeEl) { _marqueeEl.remove(); _marqueeEl = null; document.body.classList.remove('marquee-active'); }
  });

  // click outside the confirm popup dismisses it (keeps the selection)
  window.addEventListener('mousedown', (e) => {
    if (confirmPop && !e.target.closest('.confirm-pop')) closeConfirm();
  }, true);
}

function wireMultiSelect(container, opt) {
  // opt: { idAttr, sel, getAnchor, setAnchor, isInteractive }
  ensureSelGlobals();
  const rowSel = '[data-' + opt.idAttr + ']';
  const idOf = el => el && el.dataset[opt.idAttr];
  const order = () => [...container.querySelectorAll(rowSel)].map(idOf);

  const selectOnly = (id, ev) => {
    const sel = opt.sel;
    // clicking the only selected item again deselects it
    if (sel.size === 1 && sel.has(id)) { sel.clear(); opt.setAnchor(null); refreshRowSelectionDOM(); return; }
    if (sel.size >= DESELECT_GUARD) {
      showListDeselectConfirm(ev, sel.size, () => { sel.clear(); sel.add(id); opt.setAnchor(id); refreshRowSelectionDOM(); });
      return;
    }
    sel.clear(); sel.add(id); opt.setAnchor(id); refreshRowSelectionDOM();
  };
  // click on empty space below the rows clears the selection (asks if 7+)
  const clearAll = (ev) => {
    const sel = opt.sel;
    if (!sel.size) return;
    if (sel.size >= DESELECT_GUARD) {
      showListDeselectConfirm(ev, sel.size, () => { sel.clear(); opt.setAnchor(null); refreshRowSelectionDOM(); });
      return;
    }
    sel.clear(); opt.setAnchor(null); refreshRowSelectionDOM();
  };
  const toggleOne = (id) => {
    const sel = opt.sel;
    sel.has(id) ? sel.delete(id) : sel.add(id);
    opt.setAnchor(id); refreshRowSelectionDOM();
  };
  const rangeTo = (id, additive) => {
    const sel = opt.sel, ord = order();
    const anchor = opt.getAnchor();
    const b = ord.indexOf(id);
    if (b < 0) return;
    const a = anchor && ord.indexOf(anchor) >= 0 ? ord.indexOf(anchor) : b;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (!additive) sel.clear();
    for (let i = lo; i <= hi; i++) sel.add(ord[i]);
    refreshRowSelectionDOM();
  };

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (opt.isInteractive && opt.isInteractive(e.target)) return;   // let sub-controls run
    const rowEl = e.target.closest(rowSel);
    const shift = e.shiftKey, ctrl = e.ctrlKey || e.metaKey;
    _selGesture = {
      opt, container, rowSel, id: idOf(rowEl), shift, ctrl,
      x0: e.clientX, y0: e.clientY, moved: false,
      snapshot: (shift && ctrl) ? new Set(opt.sel) : null,
      selectOnly, toggleOne, rangeTo, clearAll
    };
    if (shift) e.preventDefault();   // stop native text-selection; marquee/range take over
  });
}

// Deselect confirmation for the list views (mirrors the reader's popup).
function showListDeselectConfirm(e, count, onProceed) {
  closeConfirm();
  const pop = document.createElement('div');
  pop.className = 'confirm-pop';
  const cx = (e && typeof e.clientX === 'number' && e.clientX) ? e.clientX : (window.innerWidth / 2 - 100);
  const cy = (e && typeof e.clientY === 'number' && e.clientY) ? e.clientY : 90;
  pop.style.left = Math.max(8, Math.min(cx, window.innerWidth - 210)) + 'px';
  pop.style.top = (cy + 8) + 'px';
  pop.innerHTML = `
    <div class="confirm-txt">Deselect ${count} items?</div>
    <div class="confirm-btns">
      <button class="cf-btn" id="cf-desel">Deselect</button>
      <button class="cf-btn green" id="cf-keep">Keep selection</button>
    </div>`;
  document.body.appendChild(pop);
  document.getElementById('cf-desel').onclick = () => { closeConfirm(); onProceed(); };
  document.getElementById('cf-keep').onclick = () => closeConfirm();
  confirmPop = pop;
}

function listPath(listId) {
  const l = S.lists[listId]; if (!l) return '';
  if (l.folderId && S.folders[l.folderId]) return S.folders[l.folderId].name + ' / ' + l.name;
  return l.name;
}
function timeGroup(ts) {
  const days = (Date.now() - ts) / 86400000;
  if (days < 1 && new Date(ts).toDateString() === new Date().toDateString()) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 3) return 'Last 3 days';
  if (days < 7) return 'Last week';
  if (days < 14) return 'Last 2 weeks';
  if (days < 21) return 'Last 3 weeks';
  if (days < 31) return 'Last month';
  if (days < 62) return 'Last 2 months';
  if (days < 93) return 'Last 3 months';
  if (days < 186) return 'Last 6 months';
  return 'Last year+';
}
function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  const d = Math.floor(s/86400);
  if (d === 1) return 'yesterday';
  if (d < 7) return d + ' days ago';
  return new Date(ts).toLocaleDateString();
}
function sortTerms(arr) {
  const a = arr.slice();
  if (ui.sort === 'newest') a.sort((x,y) => y.createdAt - x.createdAt);
  else if (ui.sort === 'oldest') a.sort((x,y) => x.createdAt - y.createdAt);
  else if (ui.sort === 'az') a.sort((x,y) => x.term.localeCompare(y.term));
  return a;
}
function matchesSearch(t) {
  if (!ui.search) return true;
  const q = ui.search.toLowerCase();
  return t.term.toLowerCase().includes(q) || (t.context||'').toLowerCase().includes(q);
}

// ════════════════════════════════════════════════════════════════════
//  RENDER ROUTER
// ════════════════════════════════════════════════════════════════════
function render() {
  if (typeof nameTipEl !== 'undefined' && nameTipEl) { nameTipEl.remove(); nameTipEl = null; }
  if (ui.view !== 'reader' && typeof stopYtSync === 'function') stopYtSync();
  // preserve the reading pane's scroll position across re-renders
  const prevScroll = (() => { const el = document.querySelector('.reader-scroll'); return el ? el.scrollTop : null; })();
  if (IS_SIDEBAR) renderSidebar();
  else renderFull();
  if (prevScroll != null) {
    const el = document.querySelector('.reader-scroll');
    if (el) el.scrollTop = prevScroll;
  }
}

// ════════════════════════════════════════════════════════════════════
//  SIDEBAR
// ════════════════════════════════════════════════════════════════════
function renderSidebar() {
  const mode = ui.itemMode === 'highlights' ? 'highlights' : 'terms';
  const items = mode === 'highlights' ? sessionHighlights() : sessionTerms();
  const total = items.length;

  // prune selections that no longer exist
  for (const id of [...ui.sbSel]) if (!S.terms[id] && !S.highlights[id]) ui.sbSel.delete(id);
  const selCount = ui.sbSel.size;

  // group by time
  const groups = [];
  let lastG = null;
  for (const t of items) {
    const g = timeGroup(t.createdAt);
    if (g !== lastG) { groups.push({ label: g, items: [] }); lastG = g; }
    groups[groups.length-1].items.push(t);
  }

  $root.innerHTML = `
    <div class="app is-sidebar">
      <div class="hdr hdr-clickable" id="sb-header" title="Open full view">
        <div class="logo">V</div>
        <div class="brand">Vocab Collector</div>
      </div>
      <div class="sb-mode">
        <button class="mode-btn ${mode==='terms'?'on':''}" data-sbmode="terms">Items</button>
        <button class="mode-btn ${mode==='highlights'?'on':''}" data-sbmode="highlights">Highlights</button>
      </div>
      <div class="sb-toolbar">
        <button class="ib-label" id="sb-save">${icon('save')} Save+</button>
        <button class="ib" id="sb-clear" title="Clear session">${icon('trash')}</button>
        <button class="ib" id="sb-addto" title="Add to a list">${icon('list')}</button>
        <button class="ib" id="sb-export" title="Copy as TSV">${icon('export')}</button>
        <button class="ib" id="sb-capture" title="Capture this page as a text">${icon('doc')}</button>
        <div style="flex:1"></div>
        <button class="ib ${(S.settings.web&&S.settings.web.barEnabled===false)?'':'ib-on'}" id="sb-tooltiptoggle" title="Tooltip on hover when selecting text on pages">${icon('cursorPopup')}</button>
      </div>
      <div class="sb-counts"><span class="sb-total">${selCount ? `<b>${selCount}</b> selected` : `Total: <b>${total}</b>`}</span></div>
      <div class="sb-scroll" id="sb-scroll">
        ${total === 0 ? `<div class="empty" style="padding:40px 20px">
            <div class="empty-p">${mode==='highlights'
              ? 'Select text on any page and pick a highlight color from the popup bar.'
              : 'Select text on any page and press <span class="kbd">Alt+Shift+S</span>, or use the popup bar → <em>+ Add</em>'}</div>
          </div>` :
        groups.map(g => `
          <div class="time-lbl">${esc(g.label)}</div>
          ${g.items.map(t => mode==='highlights' ? `
            <div class="sb-item ${ui.sbSel.has(t.id)?'selected':''}" data-id="${t.id}">
              <span class="sb-hl-dot hl-ln-${t.color}"></span>
              <span class="sb-term">${esc(clipText(t.text,40))}</span>
              <button class="sb-x" data-x="${t.id}">×</button>
            </div>` : `
            <div class="sb-item ${ui.sbSel.has(t.id)?'selected':''}" data-id="${t.id}">
              <span class="sb-term">${esc(t.term)}</span>
              <span class="sb-ctx">${esc(t.context)}</span>
              <button class="sb-x" data-x="${t.id}">×</button>
            </div>
          `).join('')}
        `).join('')}
      </div>
      <div class="sb-foot">
        <div class="sb-foot-row">
          <label class="sb-onpage" title="Paint your highlights in color on the web page itself"><input type="checkbox" id="sb-onpage" ${(S.settings.web&&S.settings.web.showOnPage===false)?'':'checked'}> Paint highlights on pages</label>
          <button class="sb-manualadd" id="sb-manualadd" title="Add an item or highlight manually">${icon('compose')} Add</button>
        </div>
        <button class="open-full" id="sb-openfull">${icon('ext')} Open full view</button>
      </div>
    </div>`;

  $root.querySelectorAll('[data-sbmode]').forEach(b => b.onclick = () => { ui.itemMode = b.dataset.sbmode; ui.sbSel.clear(); renderSidebar(); });

  $root.querySelectorAll('.sb-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.sb-x')) return;
      const id = el.dataset.id;
      if (ui.sbSel.has(id)) ui.sbSel.delete(id); else ui.sbSel.add(id);
      renderSidebar();
    });
  });
  $root.querySelectorAll('[data-x]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      ui.sbSel.delete(btn.dataset.x);
      if (mode==='highlights') { await VocabStore.removeHighlights([btn.dataset.x]); broadcastRemovePaint([btn.dataset.x]); }
      else await VocabStore.removeTerms([btn.dataset.x]);
    });
  });

  const targetIds = () => ui.sbSel.size ? [...ui.sbSel] : items.map(t=>t.id);

  document.getElementById('sb-save').onclick = () => {
    if (mode==='highlights') openAddHighlightsToListModal(targetIds());
    else saveSessionAsList(targetIds());
  };
  document.getElementById('sb-clear').onclick = () => {
    if (mode==='highlights') {
      const ids = ui.sbSel.size ? [...ui.sbSel] : items.map(t=>t.id);
      confirmRemoveHighlights(ids, null);
    } else if (ui.sbSel.size) { confirmRemoveSelectedSidebar([...ui.sbSel]); }
    else confirmClearSession();
  };
  document.getElementById('sb-addto').onclick = () => {
    if (mode==='highlights') openAddHighlightsToListModal(targetIds());
    else openAddToListModal(targetIds());
  };
  document.getElementById('sb-export').onclick = () => {
    if (mode==='highlights') exportHighlightsTSV(targetIds().map(id=>S.highlights[id]).filter(Boolean));
    else exportTermsTSV(targetIds().map(id=>S.terms[id]).filter(Boolean));
  };
  document.getElementById('sb-openfull').onclick = () => window.parent.postMessage({ vocab: 'openFullApp' }, '*');
  const sbHeader = document.getElementById('sb-header');
  if (sbHeader) sbHeader.onclick = () => window.parent.postMessage({ vocab: 'openFullApp' }, '*');
  const onpage = document.getElementById('sb-onpage');
  if (onpage) onpage.onchange = async () => {
    S.settings.web = S.settings.web || {};
    S.settings.web.showOnPage = onpage.checked;
    await VocabStore.set({ settings: S.settings });
  };
  const tipToggle = document.getElementById('sb-tooltiptoggle');
  if (tipToggle) tipToggle.onclick = async () => {
    S.settings.web = S.settings.web || {};
    const cur = S.settings.web.barEnabled !== false;
    S.settings.web.barEnabled = !cur;
    await VocabStore.set({ settings: S.settings });
    renderSidebar();
  };
  const manualAdd = document.getElementById('sb-manualadd');
  if (manualAdd) manualAdd.onclick = () => openManualAddModal();
  const capBtn = document.getElementById('sb-capture');
  if (capBtn) capBtn.onclick = () => window.parent.postMessage({ vocab: 'capturePage' }, '*');
}
function clipText(s, n) { return s.length > n ? s.slice(0,n)+'…' : s; }

function confirmRemoveSelectedSidebar(ids) {
  const m = showModal(`
    <h3>Remove ${ids.length} item${ids.length>1?'s':''}?</h3>
    <p>This removes them from everywhere, including All terms.</p>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Remove</button></div>`);
  m.querySelector('#m-ok').onclick = async () => { ids.forEach(id=>ui.sbSel.delete(id)); await VocabStore.removeTerms(ids); closeModal(); };
  m.querySelector('#m-cancel').onclick = closeModal;
}

// ════════════════════════════════════════════════════════════════════
//  FULL APP
// ════════════════════════════════════════════════════════════════════
function renderFull() {
  const isTab = (v) => ui.view === v;
  const hideChrome = ui.view === 'reader' && ui.readerBarCollapsed;
  $root.innerHTML = `
    <div class="app">
      ${hideChrome ? '' : `<div class="hdr">
        <button class="hdr-menu" id="hdr-menu" title="Menu">${icon('menu')}</button>
        <div class="logo" id="home-logo" title="Back to current session">V</div>
        <div class="brand" id="home-brand" title="Back to current session">Vocab Collector</div>
        <div class="tabs">
          <button class="tab ${ui.view==='allterms'?'on':''}" data-tab="allterms">All items</button>
          <button class="tab ${isTab('activity')?'on':''}" data-tab="activity">Activity</button>
          <button class="tab ${isTab('library')?'on':''}" data-tab="library">Library</button>
          <button class="tab ${isTab('reader')?'on':''}" data-tab="reader">Reader</button>
        </div>
      </div>`}
      <div class="body" id="body"></div>
    </div>`;

  if (!hideChrome) {
    const hm = document.getElementById('hdr-menu');
    if (hm) hm.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();      // don't let the global handler close it first
      if (ctxMenu && ctxMenu.dataset.m === 'app') { closeCtxMenu(); return; }   // click again = close
      const r = hm.getBoundingClientRect();
      openAppMenu(r.left, r.bottom + 5);
    };
    const goHome = () => { ui.view = 'session'; ui.selected.clear(); render(); };
    document.getElementById('home-logo').onclick = goHome;
    document.getElementById('home-brand').onclick = goHome;
    document.getElementById('home-logo').style.cursor = 'pointer';
    document.getElementById('home-brand').style.cursor = 'pointer';
    $root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { ui.view = b.dataset.tab; ui.selected.clear(); render(); });
  }

  const body = document.getElementById('body');

  // Reader = its own layout (may hide chrome when full)
  if (ui.view === 'reader') { renderReader(body); return; }
  removeFsOverlay(); stopSpeak(); closeAllReaderNotes(); destroyVideoLayer(); removeFollowBtn();
  // discard empty untitled scratch texts left behind by the reader
  let removedEmpty = false;
  for (const t of Object.values(S.texts)) {
    if (!(t.body||'').trim() && (!t.marks || !t.marks.length)) { delete S.texts[t.id]; removedEmpty = true; }
  }
  if (removedEmpty) VocabStore.set({ texts: S.texts });

  // Everything else has the left nav + content pane
  body.innerHTML = `
    ${renderLeftNav()}
    <div class="cpane" id="cpane"></div>
    ${ui.navCollapsed ? `<button class="lnav-reopen" id="reopen">${icon('chevR')}</button>` : ''}
  `;
  wireLeftNav();

  const cpane = document.getElementById('cpane');
  if (ui.view === 'library') renderLibrary(cpane);
  else if (ui.view === 'activity') renderActivityFeed(cpane);
  else if (ui.view === 'trash') renderTrash(cpane);
  else renderTermView(cpane);  // session | allterms | list:<id>
}

// ── left nav ──────────────────────────────────────────────────────────
function renderLeftNav() {
  if (ui.navCollapsed) return `<nav class="lnav collapsed"></nav>`;

  // recursive tree builder
  function renderFolderNode(f, depth) {
    const open = f._open !== false;
    const childFolders = Object.values(S.folders).filter(x => (x.parentId||null) === f.id && !x.deletedAt);
    const childLists = Object.values(S.lists).filter(l => (l.folderId||null) === f.id && !l.deletedAt);
    const childTexts = Object.values(S.texts).filter(t => (t.folderId||null) === f.id && (t.body||'').trim() && !t.deletedAt);
    const childHlLists = Object.values(S.highlightLists||{}).filter(l => (l.folderId||null) === f.id && !l.deletedAt);
    return `
      <div class="tree-folder ${open?'open':''}" data-folder="${f.id}" style="padding-left:${8+depth*12}px">
        <span class="fa">${icon('chevR')}</span>
        ${icon('folder')}
        <span class="tf-name">${esc(f.name)}</span>
      </div>
      <div class="tree-kids" style="${open?'':'display:none'}">
        ${childFolders.map(cf => renderFolderNode(cf, depth+1)).join('')}
        ${childLists.map(l => treeListHtml(l, depth+1)).join('')}
        ${childHlLists.map(l => treeHlListHtml(l, depth+1)).join('')}
        ${childTexts.map(t => treeTextHtml(t, depth+1)).join('')}
      </div>`;
  }

  const rootFolders = Object.values(S.folders).filter(f => !f.parentId && !f.deletedAt);
  const looseLists = Object.values(S.lists).filter(l => !l.folderId && !l.deletedAt);
  const looseTexts = Object.values(S.texts).filter(t => !t.folderId && (t.body||'').trim() && !t.deletedAt);
  const looseHlLists = Object.values(S.highlightLists||{}).filter(l => !l.folderId && !l.deletedAt);

  return `
    <nav class="lnav">
      <div class="nav-fixed ${ui.view==='allterms'?'on':''}" data-go="allterms">
        ${icon('stack')}<span class="nf-name">All items</span><span class="nf-count">${allTermsArr().length}</span>
      </div>
      <div class="nav-fixed ${ui.view==='session'?'on':''}" data-go="session">
        ${icon('session')}<span class="nf-name">Current session</span><span class="nf-count">${sessionTerms().length}</span>
      </div>
      <div class="lib-label">Library</div>
      <div class="lib-tree" id="lib-tree">
        ${rootFolders.map(f => renderFolderNode(f, 0)).join('')}
        ${looseLists.map(l => treeListHtml(l, 0)).join('')}
        ${looseHlLists.map(l => treeHlListHtml(l, 0)).join('')}
        ${looseTexts.map(t => treeTextHtml(t, 0)).join('')}
      </div>
      <div class="lnav-foot">
        <button class="add-btn add-btn-main" id="new-menu">${icon('plus')} New…</button>
      </div>
      <div class="nav-fixed ${ui.view==='trash'?'on':''}" data-go="trash">
        ${icon('trash')}<span class="nf-name">Trash</span><span class="nf-count">${trashedItems().length||''}</span>
      </div>
      <button class="collapse-tab" id="collapse">${icon('chevL')}</button>
    </nav>`;
}
function treeHlListHtml(l, depth=0) {
  const on = ui.view === 'hllist:' + l.id;
  return `<div class="tree-list tree-hllist ${on?'on':''}" data-hllist="${l.id}" style="padding-left:${8+depth*12}px">
    ${icon('highlight')}<span class="tl-name">${esc(l.name)}</span><span class="tl-count">${highlightListTerms(l.id).length}</span>
  </div>`;
}
function treeTextHtml(t, depth=0) {
  return `<div class="tree-list tree-text" data-text="${t.id}" style="padding-left:${8+depth*12}px">
    ${icon(t.videoId ? 'play' : 'doc')}<span class="tl-name">${esc(t.name)}</span>
  </div>`;
}
function treeListHtml(l, depth=0) {
  const on = ui.view === 'list:' + l.id;
  return `<div class="tree-list ${on?'on':''}" data-list="${l.id}" style="padding-left:${8+depth*12}px">
    ${icon('list')}<span class="tl-name">${esc(l.name)}</span><span class="tl-count">${listTerms(l.id).length}</span>
  </div>`;
}

function wireLeftNav() {
  const col = document.getElementById('collapse');
  if (col) col.onclick = () => { ui.navCollapsed = true; render(); };
  const re = document.getElementById('reopen');
  if (re) re.onclick = () => { ui.navCollapsed = false; render(); };

  $root.querySelectorAll('[data-go]').forEach(el => el.onclick = () => {
    const go = el.dataset.go;
    if (go === 'session') { ui.view='session'; }
    if (go === 'allterms') { ui.view='allterms'; }
    if (go === 'trash') { ui.view='trash'; }
    ui.selected.clear(); render();
  });
  $root.querySelectorAll('[data-list]').forEach(el => {
    el.onclick = () => { ui.view='list:'+el.dataset.list; ui.selected.clear(); render(); };
    el.oncontextmenu = (e) => { e.preventDefault(); openItemMenu(e, 'list', el.dataset.list); };
    el.setAttribute('draggable','true');
    el.addEventListener('dragstart', (e) => { dragData = { kind:'libitem', type:'list', id:el.dataset.list, items:[{type:'list',id:el.dataset.list}] }; e.dataTransfer.effectAllowed='copyMove'; e.dataTransfer.setData('text/plain', el.dataset.list); });
    setupListDrop(el, el.dataset.list);
  });
  $root.querySelectorAll('[data-text]').forEach(el => {
    el.onclick = () => { ui.view='reader'; ui.readerTextId=el.dataset.text; ui.readerEditing=false; render(); };
    el.oncontextmenu = (e) => { e.preventDefault(); openItemMenu(e, 'text', el.dataset.text); };
    el.setAttribute('draggable','true');
    el.addEventListener('dragstart', (e) => { dragData = { kind:'libitem', type:'text', id:el.dataset.text, items:[{type:'text',id:el.dataset.text}] }; e.dataTransfer.effectAllowed='copyMove'; e.dataTransfer.setData('text/plain', el.dataset.text); });
  });
  $root.querySelectorAll('[data-hllist]').forEach(el => {
    el.onclick = () => { ui.view='hllist:'+el.dataset.hllist; ui.selected.clear(); render(); };
    el.oncontextmenu = (e) => { e.preventDefault(); openHlListMenu(e, el.dataset.hllist); };
    setupHlListDrop(el, el.dataset.hllist);
  });
  $root.querySelectorAll('[data-folder]').forEach(el => {
    el.onclick = (e) => {
      const f = S.folders[el.dataset.folder];
      f._open = f._open === false ? true : false;
      VocabStore.set({ folders: S.folders });
      render();
    };
    el.oncontextmenu = (e) => { e.preventDefault(); openItemMenu(e, 'folder', el.dataset.folder); };
    el.setAttribute('draggable','true');
    el.addEventListener('dragstart', (e) => { e.stopPropagation(); dragData = { kind:'libitem', type:'folder', id:el.dataset.folder, items:[{type:'folder',id:el.dataset.folder}] }; e.dataTransfer.effectAllowed='copyMove'; e.dataTransfer.setData('text/plain', el.dataset.folder); });
    setupFolderDrop(el, el.dataset.folder);
  });

  const nm = document.getElementById('new-menu');
  if (nm) nm.onclick = (e) => { const r = nm.getBoundingClientRect(); openLibraryCreateMenu({ clientX: r.left, clientY: r.top - 8, preventDefault(){} }, null); };
}

// ── term view (session / list / allterms) ────────────────────────────
function renderTermView(cpane) {
  const isSession = ui.view === 'session';
  const isAll = ui.view === 'allterms';
  const listId = ui.view.startsWith('list:') ? ui.view.slice(5) : null;
  const isHlList = ui.view.startsWith('hllist:');

  // Highlight lists always show highlights; session/all-items follow the toggle.
  if (isHlList) { renderHighlightView(cpane, { hlListId: ui.view.slice(7) }); return; }
  if ((isSession || isAll) && ui.itemMode === 'highlights') {
    renderHighlightView(cpane, { isSession, isAll });
    return;
  }

  let terms;
  let title, count;
  if (isSession) { terms = sessionTerms(); title = 'Current session'; }
  else if (isAll) { terms = allTermsArr(); title = 'All items'; }
  else { terms = listTerms(listId); title = listById(listId) ? listById(listId).name : 'List'; }

  terms = sortTerms(terms.filter(matchesSearch));
  count = terms.length;
  const hasSel = ui.selected.size > 0;

  // top bar buttons differ by view
  let actions = '';
  if (isSession) {
    actions = `
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="act-remove">${icon('trash')} Remove</button>
      <div class="bar-sep sel-only ${hasSel?'':'hidden'}"></div>
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="act-addto">${icon('list')} Add to…</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="act-export">${icon('export')} Export</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="act-clear">Clear</button>`;
  } else if (isAll) {
    actions = `
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="act-addto">${icon('list')} Add to…</button>
      <div class="bar-sep sel-only ${hasSel?'':'hidden'}"></div>
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="act-remove">${icon('trash')} Remove</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="act-export">${icon('export')} Export</button>`;
  } else {
    actions = `
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="act-addto">${icon('list')} Move to…</button>
      <div class="bar-sep sel-only ${hasSel?'':'hidden'}"></div>
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="act-remove">${icon('trash')} Remove</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="act-export">${icon('export')} Export</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="act-rename">${icon('edit')} Rename</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="act-dellist">${icon('trash')} Delete list</button>`;
  }

  const showListCol = isAll;
  cpane.innerHTML = `
    <div class="cpane-top">
      <div class="cpane-title">${esc(title)} <span class="ct-count">${count}</span></div>
      ${actions}
    </div>
    <div class="sub-row">
      <div class="search-box"><span>${icon('search')}</span><input id="search" placeholder="Search…" value="${esc(ui.search)}"></div>
      ${(isSession||isAll) ? `<div class="mode-toggle">
        <button class="mode-btn on" data-mode="terms">Items</button>
        <button class="mode-btn" data-mode="highlights">Highlights</button>
      </div>` : ''}
      <span class="sub-lbl">Sort</span>
      <button class="spill ${ui.sort==='newest'?'on':''}" data-sort="newest">Newest</button>
      <button class="spill ${ui.sort==='oldest'?'on':''}" data-sort="oldest">Oldest</button>
      <button class="spill ${ui.sort==='az'?'on':''}" data-sort="az">A–Z</button>
    </div>
    <div class="tbl-wrap">
      ${count === 0 ? emptyTermsHtml(isSession) : `
      <table class="vtbl">
        <thead><tr>
          <th class="col-cb"></th>
          <th style="width:${showListCol?'26%':'34%'}">Term</th>
          <th style="width:${showListCol?'44%':'auto'}">Context</th>
          ${showListCol?'<th>List</th>':''}
        </tr></thead>
        <tbody>
          ${terms.map(t => `
            <tr data-term="${t.id}" class="${ui.selected.has(t.id)?'sel':''}" draggable="true">
              <td class="col-cb"><span class="cb ${ui.selected.has(t.id)?'on':''}"></span></td>
              <td><span class="chip">${esc(t.term)}</span></td>
              <td class="ctx-cell" title="${esc(t.context)}">${esc(t.context)}</td>
              ${showListCol?`<td class="list-cell">${termLists(t).length?termLists(t).map(lid=>S.lists[lid]?esc(listPath(lid)):'').filter(Boolean).join(', '):'—'}</td>`:''}
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;

  // wire
  const search = document.getElementById('search');
  search.oninput = () => { ui.search = search.value; const pos=search.selectionStart; renderTermView(cpane); const s2=document.getElementById('search'); s2.focus(); s2.setSelectionRange(pos,pos); };
  $root.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { ui.sort = b.dataset.sort; render(); });
  $root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { ui.itemMode = b.dataset.mode; ui.selected.clear(); render(); });

  const _termWrap = $root.querySelector('.tbl-wrap');
  if (_termWrap) wireMultiSelect(_termWrap, {
    idAttr: 'term', sel: ui.selected,
    getAnchor: () => ui.lastClickedTerm,
    setAnchor: (v) => { ui.lastClickedTerm = v; },
    isInteractive: () => false
  });
  $root.querySelectorAll('[data-term]').forEach(tr => setupTermDrag(tr));

  const byId = id => document.getElementById(id);
  if (byId('act-export')) byId('act-export').onclick = () => {
    const chosen = ui.selected.size ? terms.filter(t => ui.selected.has(t.id)) : terms;
    exportTermsTSV(chosen);
  };
  if (byId('act-remove')) byId('act-remove').onclick = () => confirmRemoveTerms([...ui.selected], isAll || isSession, listId);
  if (byId('act-addto')) byId('act-addto').onclick = () => openAddToListModal([...ui.selected], { move: !isSession && !isAll });
  if (byId('act-clear')) byId('act-clear').onclick = confirmClearSession;
  if (byId('act-rename')) byId('act-rename').onclick = () => openRenameListModal(listId);
  if (byId('act-dellist')) byId('act-dellist').onclick = () => confirmDeleteList(listId);
}

function emptyTermsHtml(isSession) {
  return `<div class="empty">
    <div class="empty-h">Nothing here yet</div>
    <div class="empty-p">${isSession
      ? 'Capture words while browsing: select text and press <span class="kbd">Alt+Shift+S</span>, or right-click → <em>Add to Vocab</em>.'
      : 'Drag terms here from the session or All items, or add them with the “Add to…” button.'}</div>
  </div>`;
}

// ── highlights view (session / all items / highlight list) ────────────
function renderHighlightView(cpane, { isSession, isAll, hlListId } = {}) {
  let hls, title;
  if (hlListId) { hls = highlightListTerms(hlListId); const l = S.highlightLists[hlListId]; title = l ? l.name : 'Highlights'; }
  else if (isSession) { hls = sessionHighlights(); title = 'Current session'; }
  else { hls = allHighlightsArr(); title = 'All items'; }

  // color filter (multi-select; empty = all) + search
  if (ui.hlColorFilter.size) hls = hls.filter(h => ui.hlColorFilter.has(h.color));
  if (ui.search) { const q = ui.search.toLowerCase(); hls = hls.filter(h => h.text.toLowerCase().includes(q) || (h.note||'').toLowerCase().includes(q)); }
  // sort
  hls = hls.slice();
  if (ui.sort === 'newest') hls.sort((a,b)=>b.createdAt-a.createdAt);
  else if (ui.sort === 'oldest') hls.sort((a,b)=>a.createdAt-b.createdAt);
  else if (ui.sort === 'az') hls.sort((a,b)=>a.text.localeCompare(b.text));

  const count = hls.length;
  const hasSel = ui.selected.size > 0;
  const showToggle = isSession || isAll;

  let actions = '';
  if (hlListId) {
    actions = `
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="hl-remove">${icon('trash')} Remove</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="hl-export">${icon('export')} Export</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="hl-rename">${icon('edit')} Rename</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="hl-dellist">${icon('trash')} Delete list</button>`;
  } else {
    actions = `
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="hl-addto">${icon('list')} Add to…</button>
      <div class="bar-sep sel-only ${hasSel?'':'hidden'}"></div>
      <button class="bar-btn sel-only ${hasSel?'':'hidden'}" id="hl-remove">${icon('trash')} Remove</button>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="hl-export">${icon('export')} Export</button>`;
  }

  cpane.innerHTML = `
    <div class="cpane-top">
      <div class="cpane-title">${esc(title)} <span class="ct-count">${count}</span></div>
      ${actions}
    </div>
    <div class="sub-row">
      <div class="search-box"><span>${icon('search')}</span><input id="search" placeholder="Search highlights…" value="${esc(ui.search)}"></div>
      ${showToggle ? `<div class="mode-toggle">
        <button class="mode-btn" data-mode="terms">Items</button>
        <button class="mode-btn on" data-mode="highlights">Highlights</button>
      </div>` : ''}
      <span class="sub-lbl">Color</span>
      ${HL_COLORS.map(c => `<button class="hl-filter hl-filter-dot ${ui.hlColorFilter.has(c)?'on':''}" data-cf="${c}" title="${c}"><span class="hl-line hl-ln-${c}"></span></button>`).join('')}
      <div class="bar-sep"></div>
      <span class="sub-lbl">Sort</span>
      <button class="spill ${ui.sort==='newest'?'on':''}" data-sort="newest">Newest</button>
      <button class="spill ${ui.sort==='oldest'?'on':''}" data-sort="oldest">Oldest</button>
    </div>
    <div class="tbl-wrap">
      ${count===0 ? `<div class="empty"><div class="empty-h">No highlights${ui.hlColorFilter.size?' in that color':''}</div><div class="empty-p">Highlight text in the reader to collect it here. Each highlight can carry a note.</div></div>` : `
      <table class="vtbl">
        <thead><tr>
          <th class="col-cb"></th>
          <th style="width:42%">Highlight</th>
          <th>Note</th>
        </tr></thead>
        <tbody>
          ${hls.map(h => `
            <tr data-hl="${h.id}" class="${ui.selected.has(h.id)?'sel':''}" draggable="true">
              <td class="col-cb"><span class="cb ${ui.selected.has(h.id)?'on':''}"></span></td>
              <td><span class="chip hl-chip hl-${h.color}">${esc(h.text)}</span></td>
              <td class="ctx-cell hl-note-cell" data-noteedit="${h.id}" title="Click to edit note">${noteIsEmpty(h.note)?'<span style="color:var(--text3)">+ note</span>':esc(stripHtml(h.note))}</td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;

  const search = document.getElementById('search');
  search.oninput = () => { ui.search = search.value; const p=search.selectionStart; renderHighlightView(cpane,{isSession,isAll,hlListId}); const s=document.getElementById('search'); s.focus(); s.setSelectionRange(p,p); };
  $root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { ui.itemMode = b.dataset.mode; ui.selected.clear(); render(); });
  $root.querySelectorAll('[data-cf]').forEach(b => b.onclick = () => {
    const c = b.dataset.cf;
    if (ui.hlColorFilter.has(c)) ui.hlColorFilter.delete(c); else ui.hlColorFilter.add(c);
    render();
  });
  $root.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { ui.sort = b.dataset.sort; render(); });

  const _hlWrap = $root.querySelector('.tbl-wrap');
  if (_hlWrap) wireMultiSelect(_hlWrap, {
    idAttr: 'hl', sel: ui.selected,
    getAnchor: () => ui.lastClickedHl,
    setAnchor: (v) => { ui.lastClickedHl = v; },
    isInteractive: (t) => !!t.closest('[data-noteedit]')   // note cell handles its own click
  });
  $root.querySelectorAll('[data-hl]').forEach(tr => {
    tr.addEventListener('dragstart', (e) => {
      if (e.shiftKey) { e.preventDefault(); return; }        // shift = marquee, not a list-drag
      _selGesture = null;                                     // the native drag takes over
      const id = tr.dataset.hl;
      const ids = ui.selected.has(id) ? [...ui.selected] : [id];   // never mutate ui.selected
      dragData = { kind:'highlights', ids };
      e.dataTransfer.effectAllowed='copyMove'; e.dataTransfer.setData('text/plain', ids.join(','));
    });
  });
  $root.querySelectorAll('[data-noteedit]').forEach(td => td.onclick = (e) => { e.stopPropagation(); openHighlightNoteModal(td.dataset.noteedit); });

  const byId = id => document.getElementById(id);
  if (byId('hl-export')) byId('hl-export').onclick = () => {
    const chosen = ui.selected.size ? hls.filter(h => ui.selected.has(h.id)) : hls;
    exportHighlightsTSV(chosen);
  };
  if (byId('hl-addto')) byId('hl-addto').onclick = () => openAddHighlightsToListModal([...ui.selected]);
  if (byId('hl-remove')) byId('hl-remove').onclick = () => confirmRemoveHighlights([...ui.selected], hlListId);
  if (byId('hl-rename')) byId('hl-rename').onclick = () => openRenameHlListModal(hlListId);
  if (byId('hl-dellist')) byId('hl-dellist').onclick = () => confirmDeleteHlList(hlListId);
}

function stripHtml(html) { const d=document.createElement('div'); d.innerHTML=html||''; return (d.textContent||'').trim(); }

function openHighlightNoteModal(hlId) {
  const h = S.highlights[hlId]; if (!h) return;
  const m = showModal(`
    <h3>Note</h3>
    <div style="font-size:12px;color:var(--text2);font-style:italic;padding:6px 0;border-bottom:0.5px solid var(--border)">“${esc(h.text)}”</div>
    <textarea id="m-note" rows="5" style="border:0.5px solid var(--border2);border-radius:8px;padding:9px 11px;font:inherit;font-size:13px;resize:vertical;outline:none" placeholder="Write a note…">${esc(stripHtml(h.note))}</textarea>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Save</button></div>`);
  const ta = m.querySelector('#m-note'); safeFocus(ta);
  m.querySelector('#m-ok').onclick = async () => {
    await VocabStore.editHighlight(hlId, { note: ta.value.trim() });
    closeModal();
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

function exportHighlightsTSV(hls) {
  if (!hls.length) return;
  const tsv = 'Highlight\tNote\n' + hls.map(h => [h.text, stripHtml(h.note)].map(s=>String(s).replace(/[\t\n]/g,' ')).join('\t')).join('\n');
  copyText(tsv).then(ok => toastInApp(ok ? `Copied ${hls.length} highlights` : 'Copy failed'));
}

// ── activity feed ─────────────────────────────────────────────────────
function renderTrash(cpane) {
  const all = trashedItems();
  const kindLabel = { term:'Item', highlight:'Highlight', list:'List', highlightList:'Highlight list', folder:'Folder', text:'Text' };
  const kindIcon = { term:'stack', highlight:'highlight', list:'list', highlightList:'highlight', folder:'folder', text:'doc' };
  const nameOf = (it) => it.kind==='term' ? it.obj.term : (it.kind==='highlight' ? it.obj.text : it.obj.name);

  // group batched deletions (a container + its contents) into one row
  const containerKinds = new Set(['list','highlightList','folder']);
  const rows = [];
  const seenBatch = new Set();
  for (const it of all) {
    const batch = it.obj.trashBatch;
    if (batch && containerKinds.has(it.kind) && !seenBatch.has(batch)) {
      seenBatch.add(batch);
      const members = all.filter(x => x.obj.trashBatch === batch && x !== it);
      rows.push({ ...it, batchCount: members.length });
    } else if (!batch) {
      rows.push(it);
    } else if (batch && !containerKinds.has(it.kind)) {
      // member of a batch — only show standalone if its container isn't in trash
      const hasContainer = all.some(x => x.obj.trashBatch === batch && containerKinds.has(x.kind));
      if (!hasContainer && !seenBatch.has(batch)) { seenBatch.add(batch); rows.push(it); }
    }
  }

  cpane.innerHTML = `
    <div class="cpane-top">
      <div class="cpane-title">Trash <span class="ct-count">${all.length}</span></div>
      ${all.length ? `<button class="bar-btn danger" id="trash-empty">${icon('trash')} Empty trash</button>` : ''}
    </div>
    <div class="sub-row"><div class="sub-note">Deleted items stay here until you empty the trash. Restore puts them back where they were.</div></div>
    <div class="tbl-wrap">
      ${rows.length===0 ? `<div class="empty"><div class="empty-h">Trash is empty</div><div class="empty-p">Deleted items will appear here with an option to restore.</div></div>` : `
      <table class="vtbl">
        <thead><tr><th style="width:90px">Type</th><th>Name</th><th style="width:160px"></th></tr></thead>
        <tbody>
          ${rows.map(it => `
            <tr data-tr="${it.kind}:${it.obj.id}">
              <td><span class="trash-kind">${icon(kindIcon[it.kind])} ${kindLabel[it.kind]}</span></td>
              <td>${esc(clip(nameOf(it)||'(untitled)', 80))}${it.batchCount ? ` <span class="trash-batch">+${it.batchCount} inside</span>` : ''}</td>
              <td class="trash-actions">
                <button class="mini-btn" data-restore="${it.kind}:${it.obj.id}">Restore</button>
                <button class="mini-btn danger" data-forever="${it.kind}:${it.obj.id}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;

  const ee = document.getElementById('trash-empty');
  if (ee) ee.onclick = () => {
    const m = showModal(`<h3>Empty trash?</h3><p>This permanently deletes everything in the trash. This can't be undone.</p>
      <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Empty trash</button></div>`);
    m.querySelector('#m-ok').onclick = async () => { await VocabStore.emptyTrash(); closeModal(); };
    m.querySelector('#m-cancel').onclick = closeModal;
  };
  $root.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.restore.split(':');
    await VocabStore.restoreItems(kind, [id]);
  });
  $root.querySelectorAll('[data-forever]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.forever.split(':');
    await VocabStore.purgeItems(kind, [id]);
  });
}

function clip(s, n=40) { s = String(s||''); return s.length > n ? s.slice(0, n) + '…' : s; }

function renderActivityFeed(cpane) {
  // Build feed from texts (by lastActiveAt) + lists (by updatedAt), filtered
  let items = [];
  if (ui.actFilter === 'all' || ui.actFilter === 'texts') {
    for (const t of Object.values(S.texts)) {
      if (t.deletedAt) continue;
      if (!(t.body||'').trim()) continue;
      if ((t.engagedMs||0) >= 60000 || (t.marks&&t.marks.length)) {
        items.push({ kind:'text', refId:t.id, name:t.name, at:t.lastActiveAt||t.updatedAt||t.createdAt,
          sub: textActivitySub(t) });
      }
    }
  }
  if (ui.actFilter === 'all' || ui.actFilter === 'lists') {
    for (const l of Object.values(S.lists)) {
      if (l.deletedAt) continue;
      items.push({ kind:'list', refId:l.id, name:l.name, at:l.updatedAt||l.createdAt,
        sub: `${listTerms(l.id).length} terms` + (l.folderId&&S.folders[l.folderId]?' · '+S.folders[l.folderId].name:'') });
    }
  }
  if (ui.actFilter === 'all' || ui.actFilter === 'highlights') {
    for (const l of Object.values(S.highlightLists||{})) {
      if (l.deletedAt) continue;
      items.push({ kind:'hllist', refId:l.id, name:l.name, at:l.updatedAt||l.createdAt,
        sub: `${highlightListTerms(l.id).length} highlights` + (l.folderId&&S.folders[l.folderId]?' · '+S.folders[l.folderId].name:'') });
    }
  }
  items.sort((a,b) => ui.actSort==='oldest' ? a.at-b.at : b.at-a.at);

  cpane.innerHTML = `
    <div class="sub-row">
      <span class="sub-lbl">Show</span>
      <button class="spill ${ui.actFilter==='all'?'on':''}" data-af="all">All</button>
      <button class="spill ${ui.actFilter==='lists'?'on':''}" data-af="lists">Lists</button>
      <button class="spill ${ui.actFilter==='highlights'?'on':''}" data-af="highlights">Highlights</button>
      <button class="spill ${ui.actFilter==='texts'?'on':''}" data-af="texts">Texts</button>
      <div style="flex:1"></div>
      <span class="sub-lbl">Sort</span>
      <button class="spill ${ui.actSort==='recent'?'on':''}" data-as="recent">Recent</button>
      <button class="spill ${ui.actSort==='oldest'?'on':''}" data-as="oldest">Oldest</button>
    </div>
    <div class="feed">
      ${items.length===0 ? `<div class="empty"><div class="empty-h">No activity yet</div><div class="empty-p">Your recent lists and reading sessions will show up here.</div></div>`
      : items.map(it => `
        <div class="act-card" data-act="${it.kind}:${it.refId}">
          <div class="act-ic">${icon(it.kind==='text'?'doc':(it.kind==='hllist'?'highlight':'list'))}</div>
          <div class="act-main">
            <div class="act-title">${esc(it.name)}</div>
            <div class="act-sub">${esc(it.sub)}</div>
          </div>
          <div class="act-time">${relTime(it.at)}</div>
        </div>`).join('')}
    </div>`;

  $root.querySelectorAll('[data-af]').forEach(b => b.onclick = () => { ui.actFilter=b.dataset.af; render(); });
  $root.querySelectorAll('[data-as]').forEach(b => b.onclick = () => { ui.actSort=b.dataset.as; render(); });
  $root.querySelectorAll('[data-act]').forEach(c => {
    const key = c.dataset.act;
    if (ui.actSelected === key) c.classList.add('act-selected');
    c.onclick = (e) => {
      if (ui.actSelected === key) ui.actSelected = null;
      else ui.actSelected = key;
      renderActivityFeed(cpane);
    };
    c.ondblclick = () => {
      const [kind, id] = key.split(':');
      ui.actSelected = null;
      if (kind === 'text') { ui.view='reader'; ui.readerTextId=id; ui.readerEditing=false; render(); }
      else if (kind === 'hllist') { ui.view='hllist:'+id; render(); }
      else { ui.view='list:'+id; render(); }
    };
  });
}
function textActivitySub(t) {
  const mins = Math.round((t.engagedMs||0)/60000);
  const saved = (t.marks||[]).filter(m=>m.type==='saved').length;
  const hls = (t.marks||[]).filter(m=>m.type==='hl').length;
  const parts = [];
  if (mins) parts.push('read ' + mins + ' min');
  if (saved) parts.push(saved + ' saved');
  if (hls) parts.push(hls + ' highlight' + (hls>1?'s':''));
  return parts.join(' · ') || 'opened';
}

// ── library tiles ─────────────────────────────────────────────────────
function renderLibrary(cpane) {
  const curFolder = ui.libFolder && S.folders[ui.libFolder] ? ui.libFolder : null;
  if (ui.libFolder && !S.folders[ui.libFolder]) ui.libFolder = null;

  // items belonging to the current folder level
  let tiles = [];
  for (const f of Object.values(S.folders)) if ((f.parentId||null) === curFolder && !f.deletedAt) tiles.push({ type:'folder', id:f.id, name:f.name, at:f.createdAt });
  for (const l of Object.values(S.lists)) if ((l.folderId||null) === curFolder && !l.deletedAt) tiles.push({ type:'list', id:l.id, name:l.name, at:l.updatedAt||l.createdAt });
  for (const l of Object.values(S.highlightLists||{})) if ((l.folderId||null) === curFolder && !l.deletedAt) tiles.push({ type:'hllist', id:l.id, name:l.name, at:l.updatedAt||l.createdAt });
  for (const t of Object.values(S.texts)) if ((t.folderId||null) === curFolder && (t.body||'').trim() && !t.deletedAt) tiles.push({ type:'text', id:t.id, name:t.name, at:t.updatedAt||t.createdAt });

  if (ui.libSort === 'name') tiles.sort((a,b)=>a.name.localeCompare(b.name));
  else tiles.sort((a,b)=>(b.at||0)-(a.at||0));
  // folders always first within the chosen sort
  tiles.sort((a,b)=> (a.type==='folder'?0:1) - (b.type==='folder'?0:1));

  if (ui.search) tiles = tiles.filter(t => t.name.toLowerCase().includes(ui.search.toLowerCase()));

  // breadcrumb path
  const crumbs = [];
  let f = curFolder;
  while (f && S.folders[f]) { crumbs.unshift(S.folders[f]); f = S.folders[f].parentId || null; }

  cpane.innerHTML = `
    <div class="cpane-top">
      <div class="cpane-title">
        <span class="crumb" data-crumb="root">Library</span>
        ${crumbs.map(c => `<span class="crumb-sep">›</span><span class="crumb" data-crumb="${c.id}">${esc(c.name)}</span>`).join('')}
      </div>
      <div class="search-box compact"><span>${icon('search')}</span><input id="lib-search" placeholder="Search…" value="${esc(ui.search)}"></div>
      <div class="bar-sep"></div>
      <button class="bar-btn" id="lib-newmenu">${icon('plus')} New…</button>
      <div class="bar-sep"></div>
      <span class="rc-lbl">Size</span>
      <input type="range" class="width-slider" id="tile-size" min="90" max="200" step="10" value="${ui.libTileSize}" style="width:64px">
      <div class="bar-sep"></div>
      <button class="spill ${ui.libSort==='name'?'on':''}" data-ls="name">Name</button>
      <button class="spill ${ui.libSort==='recent'?'on':''}" data-ls="recent">Recent</button>
    </div>
    <div class="lib-grid" id="lib-grid" style="grid-template-columns:repeat(auto-fill,minmax(${ui.libTileSize}px,1fr))">
      ${tiles.length===0?`<div class="empty" style="grid-column:1/-1"><div class="empty-h">${curFolder?'This folder is empty':'Library is empty'}</div><div class="empty-p">Create a list or folder, drag items here, or save a text from the reader.</div></div>`
      : tiles.map(t => {
        const meta = t.type==='folder' ? folderMeta(t.id) : (t.type==='list'? listTerms(t.id).length+' terms' : (t.type==='hllist'? highlightListTerms(t.id).length+' highlights' : 'text'));
        const ic = t.type==='folder'?'folderFill':(t.type==='list'?'list':(t.type==='hllist'?'highlight':'doc'));
        const color = t.type==='list'?'color:#8bbf73':(t.type==='hllist'?'color:#d8a23a':(t.type==='text'?'color:#a7b8c8':''));
        const icSize = Math.round(ui.libTileSize * 0.34);
        return `<div class="tile" data-tile="${t.type}:${t.id}" draggable="true" data-fullname="${esc(t.name)}">
          <button class="tile-menu" data-menu="${t.type}:${t.id}">⋯</button>
          <div class="tile-ic" style="${color};width:${icSize}px;height:${icSize}px">${icon(ic)}</div>
          <div class="tile-name">${esc(t.name)}</div>
          <div class="tile-meta">${esc(meta)}</div>
        </div>`;
      }).join('')}
    </div>`;

  const ls = document.getElementById('lib-search');
  ls.oninput = () => { ui.search = ls.value; const p=ls.selectionStart; renderLibrary(cpane); const s=document.getElementById('lib-search'); s.focus(); s.setSelectionRange(p,p); };
  // click empty area of the grid clears selection
  const grid = document.getElementById('lib-grid');
  if (grid) {
    grid.addEventListener('click', (e) => { if (e.target === grid && ui.libSelected.size) { ui.libSelected.clear(); renderLibrary(cpane); } });
    grid.addEventListener('contextmenu', (e) => {
      if (e.target.closest('[data-tile]')) return; // tiles have their own menu
      e.preventDefault();
      openLibraryCreateMenu(e, curFolder);
    });
  }
  $root.querySelectorAll('[data-ls]').forEach(b => b.onclick = () => { ui.libSort=b.dataset.ls; render(); });
  const tsize = document.getElementById('tile-size');
  if (tsize) {
    tsize.oninput = () => { const g=document.getElementById('lib-grid'); if(g){ g.style.gridTemplateColumns=`repeat(auto-fill,minmax(${tsize.value}px,1fr))`; } };
    tsize.onchange = () => { ui.libTileSize = parseInt(tsize.value,10); renderLibrary(cpane); };
  }
  // full-name tooltip on hover (for truncated names)
  $root.querySelectorAll('.tile').forEach(el => {
    const nameEl = el.querySelector('.tile-name');
    el.addEventListener('mouseenter', () => {
      if (!nameEl) return;
      if (nameEl.scrollHeight <= nameEl.clientHeight + 1) return; // not truncated
      showNameTip(el, el.dataset.fullname);
    });
    el.addEventListener('mouseleave', hideNameTip);
  });
  $root.querySelectorAll('[data-crumb]').forEach(c => c.onclick = () => { ui.libFolder = c.dataset.crumb==='root'?null:c.dataset.crumb; ui.search=''; render(); });
  document.getElementById('lib-newmenu').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openLibraryCreateMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault(){} }, curFolder); };

  $root.querySelectorAll('[data-tile]').forEach(el => {
    const key = el.dataset.tile;
    const [type, id] = key.split(':');
    el.onclick = (e) => {
      hideNameTip();
      if (e.target.closest('.tile-menu')) return;
      if (e.ctrlKey || e.metaKey) {
        if (ui.libSelected.has(key)) ui.libSelected.delete(key); else ui.libSelected.add(key);
      } else {
        if (ui.libSelected.size===1 && ui.libSelected.has(key)) ui.libSelected.clear();
        else { ui.libSelected.clear(); ui.libSelected.add(key); }
      }
      renderLibrary(cpane);
    };
    el.ondblclick = (e) => {
      hideNameTip();
      if (e.target.closest('.tile-menu')) return;
      ui.libSelected.clear();
      if (type==='folder') { ui.libFolder = id; ui.search=''; render(); }
      else if (type==='list') { ui.view='list:'+id; render(); }
      else if (type==='hllist') { ui.view='hllist:'+id; render(); }
      else if (type==='text') { ui.view='reader'; ui.readerTextId=id; ui.readerEditing=false; render(); }
    };
    if (ui.libSelected.has(key)) el.classList.add('tile-selected');
    if (type==='folder') setupFolderDrop(el, id);
    else setupTileDrop(el, type, id);
    setupTileDrag(el, type, id);
  });
  $root.querySelectorAll('[data-menu]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); const [type,id]=btn.dataset.menu.split(':'); openItemMenu(e, type, id); };
  });
}
// floating tooltip showing a tile's full name when truncated
let nameTipEl = null;
function showNameTip(tileEl, fullName) {
  hideNameTip();
  nameTipEl = document.createElement('div');
  nameTipEl.className = 'name-tip';
  nameTipEl.textContent = fullName;
  document.body.appendChild(nameTipEl);
  const r = tileEl.getBoundingClientRect();
  nameTipEl.style.left = Math.max(8, Math.min(r.left + r.width/2 - nameTipEl.offsetWidth/2, window.innerWidth - nameTipEl.offsetWidth - 8)) + 'px';
  nameTipEl.style.top = (r.bottom + 6) + 'px';
}
function hideNameTip() { if (nameTipEl) { nameTipEl.remove(); nameTipEl = null; } }

function folderMeta(fid) {
  const nf = Object.values(S.folders).filter(f=>f.parentId===fid).length;
  const nl = Object.values(S.lists).filter(l=>l.folderId===fid).length;
  const nt = Object.values(S.texts).filter(t=>t.folderId===fid).length;
  const parts=[];
  if(nf)parts.push(nf+' folder'+(nf>1?'s':''));
  if(nl)parts.push(nl+' list'+(nl>1?'s':''));
  if(nt)parts.push(nt+' text'+(nt>1?'s':''));
  return parts.join(' · ') || 'empty';
}

// ── item context menu (3-dots in library, right-click in tree) ────────
let ctxMenu = null;
function closeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
document.addEventListener('mousedown', e => { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu(); });
document.addEventListener('scroll', closeCtxMenu, true);

function openManualAddModal() {
  // step 1: choose item or highlight
  const m = showModal(`
    <h3>Add manually</h3>
    <p>What would you like to add?</p>
    <div class="modal-btns" style="justify-content:stretch;gap:8px">
      <button class="btn" id="ma-item" style="flex:1;padding:14px 10px;flex-direction:column;gap:7px">${icon('stack')} Item</button>
      <button class="btn" id="ma-hl" style="flex:1;padding:14px 10px;flex-direction:column;gap:7px">${icon('highlight')} Highlight</button>
    </div>`);
  m.querySelector('#ma-item').onclick = () => { closeModal(); manualAddForm('item'); };
  m.querySelector('#ma-hl').onclick = () => { closeModal(); manualAddForm('highlight'); };
}

function manualAddForm(kind) {
  const isHl = kind === 'highlight';
  const lists = isHl ? Object.values(S.highlightLists||{}).filter(l=>!l.deletedAt) : Object.values(S.lists||{}).filter(l=>!l.deletedAt);
  const listLabel = isHl ? 'highlight list' : 'list';
  const m = showModal(`
    <h3>New ${isHl?'highlight':'item'}</h3>
    <input id="ma-text" placeholder="${isHl?'Highlighted text':'Word or phrase'}">
    <textarea id="ma-note" rows="2" placeholder="${isHl?'Note (optional)':'Context (optional)'}" style="border:0.5px solid var(--border2);border-radius:8px;padding:8px 11px;font:inherit;font-size:13px;resize:vertical;outline:none"></textarea>
    ${isHl ? `<div class="ma-colors" id="ma-colors">${HL_COLORS.map((c,i)=>`<button class="hl-line hl-ln-${c} ${i===0?'on':''}" data-c="${c}"></button>`).join('')}</div>` : ''}
    <select id="ma-list" class="lang-sel" style="max-width:none">
      <option value="">No ${listLabel}</option>
      ${lists.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
    </select>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Add</button></div>`);
  const txt = m.querySelector('#ma-text'); safeFocus(txt);
  let color = 'yellow';
  if (isHl) m.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; m.querySelectorAll('[data-c]').forEach(x=>x.classList.toggle('on', x===b)); });
  const go = async () => {
    const text = txt.value.trim(); if (!text) { safeFocus(txt); return; }
    const extra = m.querySelector('#ma-note').value.trim();
    const listId = m.querySelector('#ma-list').value || null;
    if (isHl) {
      const res = await VocabStore.addHighlight({ text, color, note: extra, sourceUrl:'', sourceTitle:'Manual' });
      if (listId && res.id) await VocabStore.assignHighlightsToList([res.id], listId, {});
    } else {
      const res = await VocabStore.addTerm({ term: text, context: extra, sourceUrl:'', sourceTitle:'Manual' });
      if (listId && res.id) await VocabStore.assignTermsToList([res.id], listId, {});
    }
    closeModal();
  };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  txt.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
}

function openLibraryCreateMenu(e, folderId) {
  closeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.innerHTML = `
    <button class="ctx-item" data-k="list">${icon('list')} New list</button>
    <button class="ctx-item" data-k="hllist">${icon('highlight')} New highlight list</button>
    <button class="ctx-item" data-k="text">${icon('doc')} New text</button>
    <button class="ctx-item" data-k="video">${icon('play')} New YouTube text</button>
    <button class="ctx-item" data-k="folder">${icon('folder')} New folder</button>`;
  document.body.appendChild(ctxMenu);
  const mh = ctxMenu.offsetHeight || 200;
  let top = e.clientY;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, e.clientY - mh);
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth-180)+'px';
  ctxMenu.style.top = top + 'px';
  ctxMenu.querySelector('[data-k=list]').onclick = () => { closeCtxMenu(); openNewListModal(folderId); };
  ctxMenu.querySelector('[data-k=hllist]').onclick = () => { closeCtxMenu(); openNewHighlightListModal(folderId); };
  ctxMenu.querySelector('[data-k=text]').onclick = () => { closeCtxMenu(); createNewText(folderId); };
  ctxMenu.querySelector('[data-k=video]').onclick = () => { closeCtxMenu(); openNewVideoModal(folderId); };
  ctxMenu.querySelector('[data-k=folder]').onclick = () => { closeCtxMenu(); openNewFolderModal(folderId); };
}

// App menu (hamburger, top-left). Sign-out lives here now instead of a floating button.
function openAppMenu(x, y) {
  closeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.dataset.m = 'app';
  ctxMenu.innerHTML = `<button class="ctx-item" data-k="signout">${icon('ext')} Sign out</button>`;
  document.body.appendChild(ctxMenu);
  ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - 180)) + 'px';
  ctxMenu.style.top = y + 'px';
  ctxMenu.querySelector('[data-k=signout]').onclick = async () => {
    closeCtxMenu();
    if (typeof window.appSignOut === 'function') await window.appSignOut();
  };
}

function openItemMenu(e, type, id) {
  closeCtxMenu();
  const label = type==='folder'?'folder':type==='list'?'list':'text';
  let items = [];
  items.push({ k:'rename', t:'Rename' });
  items.push({ k:'duplicate', t:'Make a copy' });
  if (type==='list' || type==='hllist' || type==='text') items.push({ k:'combine', t:'Combine with…' });
  if (type==='folder') items.push({ k:'open', t:'Open' });
  items.push({ k:'delete', t:'Delete', danger:true });

  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.innerHTML = items.map(it => `<button class="ctx-item ${it.danger?'danger':''}" data-k="${it.k}">${it.t}</button>`).join('');
  document.body.appendChild(ctxMenu);
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - (items.length*34 + 12));
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';

  ctxMenu.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    const k = b.dataset.k; closeCtxMenu();
    if (k==='rename') itemRename(type, id);
    else if (k==='duplicate') itemDuplicate(type, id);
    else if (k==='combine') {
      if (type==='text') openTextCombinePicker(id);
      else openCombineModal(id, type==='hllist'?'hllist':'list');
    }
    else if (k==='open') { ui.libFolder = id; ui.search=''; render(); }
    else if (k==='delete') { if (type==='hllist') confirmDeleteHlList(id); else itemDelete(type, id); }
  });
}

function itemName(type, id) {
  if (type==='folder') return S.folders[id]?.name;
  if (type==='list') return S.lists[id]?.name;
  if (type==='hllist') return (S.highlightLists||{})[id]?.name;
  return S.texts[id]?.name;
}

function itemRename(type, id) {
  const cur = itemName(type, id) || '';
  const m = showModal(`
    <h3>Rename ${type}</h3>
    <input id="m-input" value="${esc(cur)}">
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Rename</button></div>`);
  const inp = m.querySelector('#m-input'); safeFocus(inp); inp.select();
  const go = async () => {
    const v = inp.value.trim(); if (!v) return;
    if (type==='folder') S.folders[id].name = v;
    else if (type==='list') { S.lists[id].name = v; S.lists[id].updatedAt = Date.now(); }
    else if (type==='hllist') { S.highlightLists[id].name = v; S.highlightLists[id].updatedAt = Date.now(); }
    else { S.texts[id].name = v; S.texts[id].updatedAt = Date.now(); }
    await VocabStore.set({ folders:S.folders, lists:S.lists, highlightLists:S.highlightLists, texts:S.texts });
    closeModal();
  };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
}

async function itemDuplicate(type, id) {
  if (type==='list') {
    const src = S.lists[id]; const nid = VocabStore.uid('l_');
    S.lists[nid] = { ...src, id:nid, name: src.name+' (copy)', createdAt:Date.now(), updatedAt:Date.now() };
    delete S.lists[nid].deletedAt; delete S.lists[nid].trashBatch;
    // create fresh copies of each member in the new list
    for (const member of listTerms(id)) {
      const cid = VocabStore.uid('t_');
      S.terms[cid] = {
        ...JSON.parse(JSON.stringify(member)),
        id: cid,
        masterId: member.masterId || member.id, // link to the same master
        divorced: member.divorced || false,
        listIds: [nid],
        createdAt: Date.now()
      };
      delete S.terms[cid].deletedAt; delete S.terms[cid].trashBatch;
    }
    await VocabStore.set({ lists:S.lists, terms:S.terms });
  } else if (type==='hllist') {
    const src = S.highlightLists[id]; const nid = VocabStore.uid('hl_');
    S.highlightLists[nid] = { ...src, id:nid, name: src.name+' (copy)', createdAt:Date.now(), updatedAt:Date.now() };
    delete S.highlightLists[nid].deletedAt; delete S.highlightLists[nid].trashBatch;
    for (const member of highlightListTerms(id)) {
      const cid = VocabStore.uid('h_');
      S.highlights[cid] = {
        ...JSON.parse(JSON.stringify(member)),
        id: cid,
        masterId: member.masterId || member.id,
        divorced: member.divorced || false,
        listIds: [nid],
        createdAt: Date.now()
      };
      delete S.highlights[cid].deletedAt; delete S.highlights[cid].trashBatch;
    }
    await VocabStore.set({ highlightLists:S.highlightLists, highlights:S.highlights });
  } else if (type==='text') {
    const src = S.texts[id]; const nid = VocabStore.uid('x_');
    S.texts[nid] = { ...src, id:nid, name: src.name+' (copy)', marks:JSON.parse(JSON.stringify(src.marks||[])), createdAt:Date.now(), updatedAt:Date.now() };
    delete S.texts[nid].deletedAt;
    await VocabStore.set({ texts:S.texts });
  } else if (type==='folder') {
    const src = S.folders[id]; const nid = VocabStore.uid('f_');
    S.folders[nid] = { ...src, id:nid, name: src.name+' (copy)', createdAt:Date.now() };
    delete S.folders[nid].deletedAt;
    await VocabStore.set({ folders:S.folders });
  }
}

function itemDelete(type, id) {
  confirmDeleteLibItems([type+':'+id]);
}

// Delete one or more library items (folders/lists/hllists/texts) → moves to Trash.
function confirmDeleteLibItems(keys) {
  if (!keys.length) return;
  const parsed = keys.map(k => { const [type,id]=k.split(':'); return {type,id}; }).filter(x => {
    if (x.type==='folder') return !!S.folders[x.id];
    if (x.type==='list') return !!S.lists[x.id];
    if (x.type==='hllist') return !!(S.highlightLists||{})[x.id];
    return !!S.texts[x.id];
  });
  if (!parsed.length) return;

  // Only folders need the "also trash contents" choice (they hold lists/texts).
  // Lists/highlight lists ALWAYS take their copies to trash (copies belong only to them).
  const hasFolder = parsed.some(p => p.type==='folder');
  let title, body;
  if (parsed.length === 1) {
    const it = parsed[0];
    const nm = itemName(it.type, it.id);
    title = `Move “${esc(nm)}” to trash?`;
    body = it.type==='folder' ? 'The folder goes to trash. Choose whether to also trash the lists and texts inside it.'
         : it.type==='list' ? 'The list and its items move to trash together. The originals in All items aren’t affected.'
         : it.type==='hllist' ? 'The highlight list and its items move to trash together. The originals in All items aren’t affected.'
         : 'This text goes to trash. You can restore it anytime.';
  } else {
    title = `Move ${parsed.length} items to trash?`;
    body = 'They move to trash and can be restored. Lists take their own items with them.';
  }

  const m = showModal(`
    <h3>${title}</h3>
    <p>${body}</p>
    ${hasFolder ? `<label class="trash-opt"><input type="checkbox" id="trash-contents"> Also move the lists/texts inside folders to trash</label>` : ''}
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Move to trash</button></div>`);
  m.querySelector('#m-ok').onclick = async () => {
    const alsoContents = m.querySelector('#trash-contents')?.checked;
    const now = Date.now();
    for (const it of parsed) {
      const batch = 'b_' + now + '_' + it.id;
      if (it.type==='folder') {
        if (alsoContents) {
          for (const l of Object.values(S.lists)) if (l.folderId===it.id) { l.deletedAt = now; l.trashBatch = batch; for (const t of listTerms(l.id)) { t.deletedAt = now; t.trashBatch = batch; } }
          for (const l of Object.values(S.highlightLists||{})) if (l.folderId===it.id) { l.deletedAt = now; l.trashBatch = batch; for (const h of highlightListTerms(l.id)) { h.deletedAt = now; h.trashBatch = batch; } }
          for (const t of Object.values(S.texts)) if (t.folderId===it.id) { t.deletedAt = now; t.trashBatch = batch; }
        } else {
          const parent = S.folders[it.id]?.parentId || null;
          for (const f of Object.values(S.folders)) if (f.parentId===it.id) f.parentId = parent;
          for (const l of Object.values(S.lists)) if (l.folderId===it.id) l.folderId = parent;
          for (const l of Object.values(S.highlightLists||{})) if (l.folderId===it.id) l.folderId = parent;
          for (const t of Object.values(S.texts)) if (t.folderId===it.id) t.folderId = parent;
        }
        S.folders[it.id].deletedAt = now; S.folders[it.id].trashBatch = batch;
      } else if (it.type==='list') {
        for (const t of listTerms(it.id)) { t.deletedAt = now; t.trashBatch = batch; }
        S.lists[it.id].deletedAt = now; S.lists[it.id].trashBatch = batch;
      } else if (it.type==='hllist') {
        for (const h of highlightListTerms(it.id)) { h.deletedAt = now; h.trashBatch = batch; }
        S.highlightLists[it.id].deletedAt = now; S.highlightLists[it.id].trashBatch = batch;
      } else {
        S.texts[it.id].deletedAt = now;
      }
    }
    ui.libSelected.clear();
    await VocabStore.set({ folders:S.folders, lists:S.lists, highlightLists:S.highlightLists, texts:S.texts, terms:S.terms, highlights:S.highlights });
    closeModal();
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

// Combine two lists. Offers: add source's items INTO the target, or make a NEW
// list from both. Works for term-lists (kind 'list') and highlight-lists ('hllist').
function openCombineDialog(srcId, targetId, kind = 'list') {
  const isHl = kind === 'hllist';
  const coll = isHl ? S.highlightLists : S.lists;
  const src = coll[srcId], target = coll[targetId];
  if (!src || !target) return;
  const membersOf = isHl ? (id => highlightListTerms(id)) : (id => listTerms(id));

  const m = showModal(`
    <h3>Combine lists</h3>
    <p>“${esc(src.name)}” and “${esc(target.name)}” — what would you like to do?</p>
    <div class="combine-opts">
      <button class="combine-opt" id="opt-into">
        <div class="combine-opt-t">Add into “${esc(target.name)}”</div>
        <div class="combine-opt-d">Copies items from “${esc(src.name)}” into “${esc(target.name)}”. Both lists are kept.</div>
      </button>
      <button class="combine-opt" id="opt-new">
        <div class="combine-opt-t">Combine into a new list</div>
        <div class="combine-opt-d">Creates a new list with items from both. The originals are kept.</div>
      </button>
    </div>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button></div>`);

  // copy a member into a destination list as a fresh linked copy
  const copyInto = (member, destId) => {
    const cid = VocabStore.uid(isHl ? 'h_' : 't_');
    const dest = isHl ? S.highlights : S.terms;
    dest[cid] = {
      ...JSON.parse(JSON.stringify(member)),
      id: cid,
      masterId: member.masterId || member.id,
      divorced: member.divorced || false,
      listIds: [destId],
      createdAt: Date.now()
    };
    delete dest[cid].deletedAt; delete dest[cid].trashBatch;
  };

  m.querySelector('#opt-into').onclick = async () => {
    for (const member of membersOf(srcId)) copyInto(member, targetId);
    target.updatedAt = Date.now();
    await VocabStore.set(isHl ? { highlights:S.highlights, highlightLists:S.highlightLists } : { terms:S.terms, lists:S.lists });
    closeModal(); toastInApp(`Added into ${target.name}`);
  };
  m.querySelector('#opt-new').onclick = async () => {
    closeModal();
    const m2 = showModal(`
      <h3>Name the new ${isHl?'highlight ':''}list</h3>
      <input id="m2-input" placeholder="New list name" value="${esc(src.name + ' + ' + target.name)}">
      <div class="modal-btns"><button class="btn" id="m2-cancel">Cancel</button><button class="btn green" id="m2-ok">Create</button></div>`);
    const inp = m2.querySelector('#m2-input'); safeFocus(inp); inp.select();
    const go = async () => {
      const name = inp.value.trim() || 'Combined list';
      const nid = isHl ? await VocabStore.createHighlightList(name) : await VocabStore.createList(name);
      // refresh state to include the new list
      S = await VocabStore.getAll();
      for (const member of [...membersOf(srcId), ...membersOf(targetId)]) copyInto(member, nid);
      await VocabStore.set(isHl ? { highlights:S.highlights } : { terms:S.terms });
      closeModal(); toastInApp(`Created ${name}`);
    };
    m2.querySelector('#m2-ok').onclick = go;
    m2.querySelector('#m2-cancel').onclick = closeModal;
    inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

// Combine two texts: append source's body to the target with a divider.
function openTextCombineDialog(srcId, targetId) {
  const src = S.texts[srcId], target = S.texts[targetId];
  if (!src || !target) return;
  const m = showModal(`
    <h3>Combine texts</h3>
    <p>Add “${esc(src.name)}” to the end of “${esc(target.name)}”?</p>
    <div class="combine-opts">
      <button class="combine-opt" id="opt-append">
        <div class="combine-opt-t">Append to “${esc(target.name)}”</div>
        <div class="combine-opt-d">Adds the text of “${esc(src.name)}” at the bottom, with a divider. Both texts are kept.</div>
      </button>
      <button class="combine-opt" id="opt-newtext">
        <div class="combine-opt-t">Combine into a new text</div>
        <div class="combine-opt-d">Creates a new text with both, separated by a divider. Originals are kept.</div>
      </button>
    </div>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button></div>`);

  const DIV = '\n\n──────────\n\n';
  m.querySelector('#opt-append').onclick = async () => {
    const base = (target.body||'').replace(/\s+$/,'');
    const addition = (base ? DIV : '') + `${src.name}\n\n` + (src.body||'');
    const offset = base.length + addition.length - (src.body||'').length;
    const srcMarks = (src.marks||[]).map(mk => ({ ...mk, start: mk.start+offset, end: mk.end+offset }));
    target.body = base + addition;
    target.marks = [...(target.marks||[]), ...srcMarks];
    target.updatedAt = Date.now(); target.lastActiveAt = Date.now();
    await VocabStore.set({ texts: S.texts });
    S = await VocabStore.getAll();
    closeModal(); toastInApp(`Added to ${target.name}`); render();
  };
  m.querySelector('#opt-newtext').onclick = async () => {
    closeModal();
    const m2 = showModal(`
      <h3>Name the new text</h3>
      <input id="m2-input" value="${esc(src.name + ' + ' + target.name)}">
      <div class="modal-btns"><button class="btn" id="m2-cancel">Cancel</button><button class="btn green" id="m2-ok">Create</button></div>`);
    const inp = m2.querySelector('#m2-input'); safeFocus(inp); inp.select();
    const go = async () => {
      const name = inp.value.trim() || 'Combined text';
      const tBody = (target.body||'');
      const body = tBody + (tBody?DIV:'') + `${src.name}\n\n` + (src.body||'');
      const srcOffset = body.length - (src.body||'').length;
      const tMarks = (target.marks||[]).map(mk=>({...mk}));
      const sMarks = (src.marks||[]).map(mk=>({...mk, start:mk.start+srcOffset, end:mk.end+srcOffset}));
      const res = await VocabStore.createText({ name, body });
      S = await VocabStore.getAll();
      if (res.id && S.texts[res.id]) { S.texts[res.id].marks = [...tMarks, ...sMarks]; await VocabStore.set({ texts: S.texts }); }
      closeModal(); toastInApp(`Created ${name}`); render();
    };
    m2.querySelector('#m2-ok').onclick = go;
    m2.querySelector('#m2-cancel').onclick = closeModal;
    inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

// right-click a text "Combine with…" → pick another text, then the append dialog
function openTextCombinePicker(textId) {
  const others = Object.values(S.texts).filter(t => t.id !== textId && !t.deletedAt && (t.body||'').trim());
  if (!others.length) { toastInApp('No other texts to combine with'); return; }
  const src = S.texts[textId];
  const m = showModal(`
    <h3>Combine “${esc(src.name)}” with…</h3>
    <p>Pick the text to combine with.</p>
    <div class="modal-list" id="m-list">
      ${others.map(t => `<div class="modal-list-item" data-t="${t.id}">${icon('doc')} ${esc(t.name)}</div>`).join('')}
    </div>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button></div>`);
  m.querySelectorAll('[data-t]').forEach(it => it.onclick = () => openTextCombineDialog(textId, it.dataset.t));
  m.querySelector('#m-cancel').onclick = closeModal;
}

// right-click "Combine with…" → pick the other list, then show the combine dialog
function openCombineModal(listId, kind = 'list') {
  const isHl = kind === 'hllist';
  const coll = isHl ? S.highlightLists : S.lists;
  const others = Object.values(coll).filter(l => l.id !== listId && !l.deletedAt);
  if (!others.length) { toastInApp('No other lists to combine with'); return; }
  const src = coll[listId];
  const m = showModal(`
    <h3>Combine “${esc(src.name)}” with…</h3>
    <p>Pick the list to combine with.</p>
    <div class="modal-list" id="m-list">
      ${others.map(l => `<div class="modal-list-item" data-l="${l.id}">${icon(isHl?'highlight':'list')} ${esc(l.name)} <span style="color:var(--text3);font-size:11px">${(isHl?highlightListTerms(l.id):listTerms(l.id)).length}</span></div>`).join('')}
    </div>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button></div>`);
  m.querySelectorAll('[data-l]').forEach(it => it.onclick = () => {
    // src = the list you right-clicked; target = the one you picked
    openCombineDialog(listId, it.dataset.l, kind);
  });
  m.querySelector('#m-cancel').onclick = closeModal;
}

// (reader, modals, drag-drop defined below)

// ════════════════════════════════════════════════════════════════════
//  ACTIONS (modals, save, export, etc.)
// ════════════════════════════════════════════════════════════════════
let modalEl = null;
function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
function showModal(html) {
  closeModal();
  modalEl = document.createElement('div');
  modalEl.className = 'modal-bg';
  modalEl.innerHTML = `<div class="modal">${html}</div>`;
  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
  document.body.appendChild(modalEl);
  return modalEl;
}

function openNewListModal(folderId = null) {
  const m = showModal(`
    <h3>New list</h3>
    <input id="m-input" placeholder="e.g. Spanish idioms">
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Create</button></div>`);
  const inp = m.querySelector('#m-input'); safeFocus(inp);
  const go = async () => { const v = inp.value.trim(); if (v) { const id = await VocabStore.createList(v, folderId); ui.view='list:'+id; } closeModal(); };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
}

function openNewFolderModal(parentId = null) {
  const m = showModal(`
    <h3>New folder</h3>
    <input id="m-input" placeholder="e.g. Spanish">
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Create</button></div>`);
  const inp = m.querySelector('#m-input'); safeFocus(inp);
  const go = async () => { const v = inp.value.trim(); if (v) { const id = VocabStore.uid('f_'); S.folders[id] = { id, name:v, parentId: parentId||null, createdAt:Date.now(), _open:true }; await VocabStore.set({ folders: S.folders }); } closeModal(); };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
}

// create a new empty text and open it in the reader (edit mode)
// ── YouTube synced reader ──────────────────────────────────────────
function parseYouTubeId(url) {
  if (!url) return '';
  const s = url.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let m;
  if ((m = s.match(/[?&]v=([\w-]{11})/))) return m[1];
  if ((m = s.match(/youtu\.be\/([\w-]{11})/))) return m[1];
  if ((m = s.match(/\/embed\/([\w-]{11})/))) return m[1];
  if ((m = s.match(/\/shorts\/([\w-]{11})/))) return m[1];
  if ((m = s.match(/([\w-]{11})/))) return m[1];
  return '';
}
function parseTranscript(raw) {
  const lines = raw.replace(/\r/g,'').split('\n').map(l => l.trim()).filter(Boolean);
  const tsRe = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
  const inlineRe = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/;
  const segs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let mInline = line.match(inlineRe);
    if (tsRe.test(line) && i+1 < lines.length && !tsRe.test(lines[i+1])) {
      segs.push({ start: tsToSeconds(line), text: lines[i+1] }); i++;
    } else if (mInline) {
      segs.push({ start: tsToSeconds(mInline[1]), text: mInline[2] });
    } else if (segs.length) {
      segs[segs.length-1].text += ' ' + line;
    } else {
      segs.push({ start: 0, text: line });
    }
  }
  let body = '';
  for (const s of segs) { s.text = s.text.replace(/\s+/g,' ').trim(); s.offset = body.length; body += s.text + ' '; }
  body = body.trim();
  return { segments: segs.map(s => ({ start: s.start, offset: s.offset, len: s.text.length })), body };
}
function tsToSeconds(ts) {
  const p = ts.split(':').map(Number);
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  if (p.length === 2) return p[0]*60 + p[1];
  return p[0] || 0;
}
function secondsToTs(sec) {
  sec = Math.floor(sec||0);
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return (h?h+':':'') + (h? String(m).padStart(2,'0'):m) + ':' + String(s).padStart(2,'0');
}
function openNewVideoModal(folderId = null) {
  const m = showModal(`
    <h3>New YouTube text</h3>
    <p style="font-size:12px;color:var(--text3);line-height:1.5">Paste a YouTube link, then paste its transcript. On YouTube, open “…more” → “Show transcript”, then copy the lines (with timestamps).</p>
    <input id="yt-url" placeholder="YouTube URL or video ID">
    <input id="yt-name" placeholder="Title (optional)">
    <textarea id="yt-tr" rows="7" placeholder="Paste the transcript here…" style="border:0.5px solid var(--border2);border-radius:8px;padding:9px 11px;font:inherit;font-size:12px;resize:vertical;outline:none;line-height:1.5"></textarea>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Create</button></div>`);
  const url = m.querySelector('#yt-url'); safeFocus(url);
  const go = async () => {
    const vid = parseYouTubeId(url.value);
    if (!vid) { url.focus(); url.style.borderColor = '#c0392b'; toastInApp('Enter a valid YouTube link'); return; }
    const raw = m.querySelector('#yt-tr').value.trim();
    const name = m.querySelector('#yt-name').value.trim() || 'YouTube video';
    let segments = [], body = '';
    if (raw) { const p = parseTranscript(raw); segments = p.segments; body = p.body; }
    const res = await VocabStore.createVideoText({ name, body, videoId: vid, segments, sourceUrl: 'https://youtu.be/'+vid });
    if (folderId && res.id && S.texts[res.id]) { S.texts[res.id].folderId = folderId; await VocabStore.set({ texts: S.texts }); }
    S = await VocabStore.getAll();
    closeModal();
    if (res.id) { ui.view='reader'; ui.readerTextId=res.id; ui.readerEditing=false; render(); }
  };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
}

async function createNewText(folderId = null) {
  const id = VocabStore.uid('x_');
  S.texts[id] = { id, name:'Untitled', body:'', marks:[], folderId: folderId||null, createdAt:Date.now(), updatedAt:Date.now(), lastActiveAt:Date.now(), engagedMs:0 };
  await VocabStore.set({ texts: S.texts });
  ui.view = 'reader'; ui.readerTextId = id; ui.readerEditing = true;
  render();
}

function openNewHighlightListModal(folderId = null) {
  const m = showModal(`
    <h3>New highlight list</h3>
    <input id="m-input" placeholder="e.g. Key phrases">
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Create</button></div>`);
  const inp = m.querySelector('#m-input'); safeFocus(inp);
  const go = async () => { const v = inp.value.trim(); if (v) { const id = await VocabStore.createHighlightList(v, folderId); if (S.highlightLists[id]) S.highlightLists[id].folderId = folderId||null; await VocabStore.set({highlightLists:S.highlightLists}); ui.view='hllist:'+id; } closeModal(); render(); };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
}

function openRenameListModal(listId) {
  const l = S.lists[listId]; if (!l) return;
  const m = showModal(`
    <h3>Rename list</h3>
    <input id="m-input" value="${esc(l.name)}">
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Rename</button></div>`);
  const inp = m.querySelector('#m-input'); safeFocus(inp); inp.select();
  const go = async () => { const v = inp.value.trim(); if (v) { l.name=v; l.updatedAt=Date.now(); await VocabStore.set({ lists: S.lists }); } closeModal(); };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
}

function openAddToListModal(termIds, { move = false } = {}) {
  if (!termIds.length) return;
  const lists = Object.values(S.lists).filter(l => !l.deletedAt);
  const m = showModal(`
    <h3>${move?'Move':'Add'} ${termIds.length} term${termIds.length>1?'s':''} to…</h3>
    <input id="m-search" placeholder="Search or type a new list name…">
    <div class="modal-list" id="m-list">
      ${lists.map(l => `<div class="modal-list-item" data-l="${l.id}">${icon('list')} ${esc(l.name)}</div>`).join('')}
    </div>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-new">+ New list</button></div>`);
  const search = m.querySelector('#m-search'); safeFocus(search);
  const listEl = m.querySelector('#m-list');
  const filter = () => {
    const q = search.value.toLowerCase();
    listEl.querySelectorAll('.modal-list-item').forEach(it => {
      const l = S.lists[it.dataset.l];
      it.style.display = l.name.toLowerCase().includes(q) ? '' : 'none';
    });
  };
  search.oninput = filter;
  listEl.querySelectorAll('[data-l]').forEach(it => it.onclick = async () => {
    // From session or All terms → copy into the list (keep original).
    // From within a list (move=true) → reassign (move).
    await VocabStore.assignTermsToList(termIds, it.dataset.l, { move });
    ui.selected.clear(); closeModal();
  });
  m.querySelector('#m-new').onclick = async () => {
    const typed = search.value.trim();
    if (typed) {
      const id = await VocabStore.createList(typed);
      await VocabStore.assignTermsToList(termIds, id, {});
      ui.selected.clear(); closeModal();
    } else {
      // no name typed → ask for one
      closeModal();
      const m2 = showModal(`
        <h3>Name the new list</h3>
        <input id="m2-input" placeholder="List name">
        <div class="modal-btns"><button class="btn" id="m2-cancel">Cancel</button><button class="btn green" id="m2-ok">Create &amp; add</button></div>`);
      const inp = m2.querySelector('#m2-input'); safeFocus(inp);
      const go = async () => { const v = inp.value.trim() || 'Untitled list'; const id = await VocabStore.createList(v); await VocabStore.assignTermsToList(termIds, id, {}); ui.selected.clear(); closeModal(); };
      m2.querySelector('#m2-ok').onclick = go;
      m2.querySelector('#m2-cancel').onclick = closeModal;
      inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
    }
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

function confirmClearSession() {
  const m = showModal(`
    <h3>Clear session?</h3>
    <p>This empties the current session list. Your saved terms stay safe in All terms.</p>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Clear</button></div>`);
  m.querySelector('#m-ok').onclick = async () => { await VocabStore.clearSession(); closeModal(); };
  m.querySelector('#m-cancel').onclick = closeModal;
}

function confirmRemoveTerms(ids, permanent, listId) {
  if (!ids.length) return;
  const m = showModal(`
    <h3>Remove ${ids.length} term${ids.length>1?'s':''}?</h3>
    <p>${permanent ? 'This moves them to the trash. You can restore them anytime.' : 'This removes them from this list. They stay in All items.'}</p>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Remove</button></div>`);
  m.querySelector('#m-ok').onclick = async () => {
    if (permanent) await VocabStore.removeTerms(ids);
    else await VocabStore.removeFromList(ids, listId);
    ui.selected.clear(); closeModal();
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

// ── highlight list operations ──
function confirmRemoveHighlights(ids, hlListId) {
  if (!ids.length) return;
  const inList = !!hlListId;
  const m = showModal(`
    <h3>Remove ${ids.length} highlight${ids.length>1?'s':''}?</h3>
    <p>${inList ? 'This removes them from this list. They stay in All items → Highlights.' : 'This permanently deletes them, including any notes.'}</p>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Remove</button></div>`);
  m.querySelector('#m-ok').onclick = async () => {
    if (inList) await VocabStore.removeHighlightsFromList(ids, hlListId);
    else {
      await VocabStore.removeHighlights(ids);
      broadcastRemovePaint(ids);
      const idset = new Set(ids);
      let changed = false;
      for (const tx of Object.values(S.texts)) {
        if (!tx.marks) continue;
        const before = tx.marks.length;
        tx.marks = tx.marks.filter(m => !(m.type==='hl' && idset.has(m.highlightId)));
        if (tx.marks.length !== before) changed = true;
      }
      if (changed) { await VocabStore.set({ texts: S.texts }); S = await VocabStore.getAll(); }
    }
    ui.selected.clear(); closeModal();
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

function openAddHighlightsToListModal(hlIds) {
  if (!hlIds.length) return;
  const lists = Object.values(S.highlightLists || {}).filter(l => !l.deletedAt);
  const m = showModal(`
    <h3>Add ${hlIds.length} highlight${hlIds.length>1?'s':''} to…</h3>
    <input id="m-search" placeholder="Search or type a new highlight list…">
    <div class="modal-list" id="m-list">
      ${lists.map(l => `<div class="modal-list-item" data-l="${l.id}">${icon('highlight')} ${esc(l.name)}</div>`).join('') || '<div style="font-size:12px;color:var(--text3);padding:8px">No highlight lists yet — type a name below.</div>'}
    </div>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-new">+ New list</button></div>`);
  const search = m.querySelector('#m-search'); safeFocus(search);
  const listEl = m.querySelector('#m-list');
  search.oninput = () => { const q=search.value.toLowerCase(); listEl.querySelectorAll('.modal-list-item').forEach(it=>{ const l=S.highlightLists[it.dataset.l]; it.style.display=l.name.toLowerCase().includes(q)?'':'none'; }); };
  listEl.querySelectorAll('[data-l]').forEach(it => it.onclick = async () => {
    await VocabStore.assignHighlightsToList(hlIds, it.dataset.l, {});
    ui.selected.clear(); closeModal();
  });
  m.querySelector('#m-new').onclick = async () => {
    const typed = search.value.trim();
    if (typed) {
      const id = await VocabStore.createHighlightList(typed);
      await VocabStore.assignHighlightsToList(hlIds, id, {});
      ui.selected.clear(); closeModal();
    } else {
      closeModal();
      const m2 = showModal(`
        <h3>Name the new highlight list</h3>
        <input id="m2-input" placeholder="Highlight list name">
        <div class="modal-btns"><button class="btn" id="m2-cancel">Cancel</button><button class="btn green" id="m2-ok">Create &amp; add</button></div>`);
      const inp = m2.querySelector('#m2-input'); safeFocus(inp);
      const go = async () => { const v = inp.value.trim() || 'Highlights'; const id = await VocabStore.createHighlightList(v); await VocabStore.assignHighlightsToList(hlIds, id, {}); ui.selected.clear(); closeModal(); };
      m2.querySelector('#m2-ok').onclick = go;
      m2.querySelector('#m2-cancel').onclick = closeModal;
      inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
    }
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

function openRenameHlListModal(listId) {
  const l = S.highlightLists[listId]; if (!l) return;
  const m = showModal(`
    <h3>Rename highlight list</h3>
    <input id="m-input" value="${esc(l.name)}">
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Rename</button></div>`);
  const inp = m.querySelector('#m-input'); safeFocus(inp); inp.select();
  const go = async () => { const v=inp.value.trim(); if(v){ l.name=v; l.updatedAt=Date.now(); await VocabStore.set({highlightLists:S.highlightLists}); } closeModal(); };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  inp.onkeydown = e => { if(e.key==='Enter')go(); if(e.key==='Escape')closeModal(); };
}

function confirmDeleteHlList(listId) {
  const l = S.highlightLists[listId]; if (!l) return;
  const m = showModal(`
    <h3>Move “${esc(l.name)}” to trash?</h3>
    <p>The highlight list and its items move to trash together. You can restore them anytime. (The originals in All items aren’t affected.)</p>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Move to trash</button></div>`);
  m.querySelector('#m-ok').onclick = async () => {
    const now = Date.now(); const batch = 'b_' + now + '_' + listId;
    for (const h of highlightListTerms(listId)) { h.deletedAt = now; h.trashBatch = batch; }
    S.highlightLists[listId].deletedAt = now; S.highlightLists[listId].trashBatch = batch;
    await VocabStore.set({ highlightLists: S.highlightLists, highlights: S.highlights });
    ui.view='session'; closeModal();
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

function confirmDeleteList(listId) {
  const l = S.lists[listId]; if (!l) return;
  const m = showModal(`
    <h3>Move “${esc(l.name)}” to trash?</h3>
    <p>The list and its items move to trash together. You can restore them anytime. (The originals in All items aren’t affected.)</p>
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Move to trash</button></div>`);
  m.querySelector('#m-ok').onclick = async () => {
    const now = Date.now(); const batch = 'b_' + now + '_' + listId;
    // trash the list's copies (its members) with it
    for (const t of listTerms(listId)) { t.deletedAt = now; t.trashBatch = batch; }
    S.lists[listId].deletedAt = now; S.lists[listId].trashBatch = batch;
    await VocabStore.set({ lists: S.lists, terms: S.terms });
    ui.view='session'; closeModal();
  };
  m.querySelector('#m-cancel').onclick = closeModal;
}

async function saveSessionAsList(ids) {
  ids = ids && ids.length ? ids : sessionTerms().map(t=>t.id);
  if (!ids.length) return;
  const m = showModal(`
    <h3>Save session as a list</h3>
    <input id="m-input" placeholder="List name">
    <div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button><button class="btn green" id="m-ok">Save</button></div>`);
  const inp = m.querySelector('#m-input'); safeFocus(inp);
  const go = async () => {
    const v = inp.value.trim(); if (!v) return;
    const id = await VocabStore.createList(v);
    await VocabStore.assignTermsToList(ids, id, {}); // membership; session stays intact
    closeModal();
  };
  m.querySelector('#m-ok').onclick = go;
  m.querySelector('#m-cancel').onclick = closeModal;
  inp.onkeydown = e => { if (e.key==='Enter') go(); if (e.key==='Escape') closeModal(); };
}

function exportTermsTSV(terms) {
  if (!terms.length) return;
  const tsv = 'Term\tContext\n' + terms.map(t => [t.term, t.context||''].map(s=>String(s).replace(/[\t\n]/g,' ')).join('\t')).join('\n');
  copyText(tsv).then(ok => toastInApp(ok ? ('Copied ' + terms.length + ' rows — paste into a sheet') : 'Copy failed'));
}

// Clipboard write that also works inside the sidebar iframe (where the
// async Clipboard API is blocked by permissions policy).
function copyText(text) {
  return new Promise((resolve) => {
    // Try the modern API first (works in the full tab)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => fallback());
    } else { fallback(); }
    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        resolve(ok);
      } catch { resolve(false); }
    }
  });
}

let appToast = null;
function toastInApp(msg) {
  if (!appToast) { appToast = document.createElement('div'); appToast.className='drag-badge'; appToast.style.cssText='position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#2a2f27;color:#edffdf;padding:9px 16px;border-radius:9px;font-size:13px;z-index:9999;transition:opacity .2s'; document.body.appendChild(appToast); }
  appToast.textContent = msg; appToast.style.opacity='1';
  clearTimeout(appToast._t); appToast._t = setTimeout(()=>appToast.style.opacity='0', 2000);
}

// ════════════════════════════════════════════════════════════════════
//  DRAG & DROP
// ════════════════════════════════════════════════════════════════════
let dragData = null;

function setupTermDrag(tr) {
  tr.addEventListener('dragstart', (e) => {
    if (e.shiftKey) { e.preventDefault(); return; }   // shift = marquee, not a list-drag
    _selGesture = null;                                // the native drag takes over
    const id = tr.dataset.term;
    // drag the whole selection if this row is part of it, else just this row —
    // but NEVER mutate ui.selected here (an accidental micro-drag used to wipe it)
    let ids = ui.selected.has(id) ? [...ui.selected] : [id];
    const fromListId = ui.view.startsWith('list:') ? ui.view.slice(5) : null;
    dragData = { kind:'terms', ids, fromListId };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', ids.join(','));
  });
}

function setupListDrop(el, listId) {
  el.addEventListener('dragover', e => { if (dragData&&dragData.kind==='terms'){ e.preventDefault(); el.classList.add('drop-target'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async e => {
    e.preventDefault(); el.classList.remove('drop-target');
    if (!dragData || dragData.kind!=='terms') return;
    const move = dragData.fromListId && !(e.ctrlKey || e.metaKey);
    await VocabStore.assignTermsToList(dragData.ids, listId, { move });
    ui.selected.clear(); dragData=null;
    toastInApp('Added to list');
  });
}

function setupHlListDrop(el, listId) {
  el.addEventListener('dragover', e => { if (dragData&&dragData.kind==='highlights'){ e.preventDefault(); el.classList.add('drop-target'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async e => {
    e.preventDefault(); el.classList.remove('drop-target');
    if (!dragData || dragData.kind!=='highlights') return;
    await VocabStore.assignHighlightsToList(dragData.ids, listId, {});
    ui.selected.clear(); dragData=null;
    toastInApp('Added to highlight list');
  });
}

function openHlListMenu(e, listId) {
  closeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.innerHTML = `
    <button class="ctx-item" data-k="rename">Rename</button>
    <button class="ctx-item" data-k="combine">Combine with…</button>
    <button class="ctx-item danger" data-k="delete">Delete</button>`;
  document.body.appendChild(ctxMenu);
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth-180)+'px';
  ctxMenu.style.top = Math.min(e.clientY, window.innerHeight-120)+'px';
  ctxMenu.querySelector('[data-k=rename]').onclick = () => { closeCtxMenu(); openRenameHlListModal(listId); };
  ctxMenu.querySelector('[data-k=combine]').onclick = () => { closeCtxMenu(); openCombineModal(listId, 'hllist'); };
  ctxMenu.querySelector('[data-k=delete]').onclick = () => { closeCtxMenu(); confirmDeleteHlList(listId); };
}

function setupFolderDrop(el, folderId) {
  el.addEventListener('dragover', e => { if (dragData&&dragData.kind==='libitem'){ e.preventDefault(); el.classList.add('drop-target'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async e => {
    e.preventDefault(); el.classList.remove('drop-target');
    if (!dragData || dragData.kind!=='libitem') return;
    const copy = e.ctrlKey || e.metaKey;
    const items = dragData.items && dragData.items.length ? dragData.items : [{type:dragData.type, id:dragData.id}];

    for (const it of items) {
      if (it.type==='list' && S.lists[it.id]) {
        if (copy) { const nid=VocabStore.uid('l_'); S.lists[nid]={...S.lists[it.id], id:nid, folderId, createdAt:Date.now(), updatedAt:Date.now()};
          for (const t of allTermsArr()){const ls=termLists(t); if(ls.includes(it.id)){t.listIds=[...ls,nid];delete t.listId;}} }
        else S.lists[it.id].folderId = folderId;
      } else if (it.type==='text' && S.texts[it.id]) {
        if (copy) { const nid=VocabStore.uid('x_'); S.texts[nid]={...S.texts[it.id], id:nid, folderId, marks:JSON.parse(JSON.stringify(S.texts[it.id].marks||[])), createdAt:Date.now()}; }
        else S.texts[it.id].folderId = folderId;
      } else if (it.type==='folder' && S.folders[it.id]) {
        if (it.id !== folderId && !isDescendantFolder(folderId, it.id)) {
          if (copy) { const nid=VocabStore.uid('f_'); S.folders[nid]={...S.folders[it.id], id:nid, parentId:folderId, createdAt:Date.now()}; }
          else S.folders[it.id].parentId = folderId;
        } else { toastInApp("Can't move a folder into itself"); }
      }
    }
    await VocabStore.set({ lists:S.lists, texts:S.texts, folders:S.folders, terms:S.terms });
    ui.libSelected.clear();
    dragData=null;
  });
}
// is `maybeChild` inside the subtree of `ancestorId`?
function isDescendantFolder(maybeChild, ancestorId) {
  let f = maybeChild;
  while (f && S.folders[f]) { if (S.folders[f].parentId === ancestorId) return true; f = S.folders[f].parentId; }
  return false;
}

function setupTileDrag(el, type, id) {
  el.addEventListener('dragstart', e => {
    const key = type+':'+id;
    let items;
    if (ui.libSelected.has(key) && ui.libSelected.size > 1) items = [...ui.libSelected].map(k => { const [t,i]=k.split(':'); return {type:t,id:i}; });
    else { items = [{type,id}]; ui.libSelected.clear(); ui.libSelected.add(key); }
    dragData = { kind:'libitem', type, id, items };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', id);
  });
}

// list/hllist/text tiles accept a same-type tile dropped on them (combine / append)
function setupTileDrop(el, type, id) {
  const accepts = (d) => d && d.kind==='libitem' && d.type===type && d.id!==id && (type==='list'||type==='hllist'||type==='text');
  el.addEventListener('dragover', e => { if (accepts(dragData)) { e.preventDefault(); el.classList.add('drop-target'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async e => {
    if (!accepts(dragData)) return;
    e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-target');
    const srcId = dragData.id; dragData = null;
    if (type==='list') openCombineDialog(srcId, id, 'list');
    else if (type==='hllist') openCombineDialog(srcId, id, 'hllist');
    else if (type==='text') openTextCombineDialog(srcId, id);
  });
}

// ════════════════════════════════════════════════════════════════════
//  READER  (Batch 4)
// ════════════════════════════════════════════════════════════════════
let ttEl = null;
let _ttRect = null, _ttTerm = '', _ttSavedId = null, _ttHlId = null;   // anchor + term + saved/highlight ids, so the tooltip can re-open after an action
let readerEngageTimer = null;
let confirmPop = null;
function closeConfirm(){ if(confirmPop){confirmPop.remove();confirmPop=null;} }

const SIZES = [14,16,18,20,23,26,30,36];
const SIZE_LABELS = ['XS','S','M','L','XL','2XL','3XL','4XL'];

function ensureReaderText() {
  if (!ui.readerTextId || !S.texts[ui.readerTextId]) {
    const id = VocabStore.uid('x_');
    S.texts[id] = { id, name:'Untitled', body:'', marks:[], folderId:null, createdAt:Date.now(), updatedAt:Date.now(), lastActiveAt:Date.now(), engagedMs:0 };
    ui.readerTextId = id;
    ui.readerEditing = true;
    VocabStore.set({ texts: S.texts });
  }
  return S.texts[ui.readerTextId];
}

function renderReader(body) {
  followWords = []; // invalidate cached word spans on every render
  removeFsOverlay(); // no more overlay approach
  const text = ensureReaderText();
  const st = S.settings.reader;
  const fontPx = SIZES[st.size] || 18;
  const widthPct = st.width || 60;   // % of available pane width (40–100)
  const barHidden = ui.readerBarCollapsed;

  // toolbar (hidden in full screen, but a restore tab remains)
  const toolbar = `
    <div class="rc" id="rc">
      <div class="rc-left">
        <span class="rc-lbl">Size</span>
        <div class="rc-grp">
          <button class="rc-btn" id="sz-down">A−</button>
          <button class="rc-btn sz-lbl on">${SIZE_LABELS[st.size]||'M'}</button>
          <button class="rc-btn" id="sz-up">A+</button>
        </div>
        <div class="rc-sep"></div>
        <span class="rc-lbl">Width</span>
        <input type="range" class="width-slider" id="r-width" min="40" max="100" step="10" value="${widthPct}" list="width-snaps">
        <datalist id="width-snaps"><option value="40"></option><option value="60"></option><option value="80"></option><option value="100"></option></datalist>
        <div class="rc-sep"></div>
        <span class="rc-lbl">Theme</span>
        <div class="rc-grp theme-fan">
          <button class="rc-btn ${st.theme==='white'?'on':''}" data-th="white">White</button>
          <button class="rc-btn ${st.theme==='paper'?'on':''}" data-th="paper">Paper</button>
          <button class="rc-btn ${st.theme==='sepia'?'on':''}" data-th="sepia">Sepia</button>
          <button class="rc-btn ${st.theme==='slate'?'on':''}" data-th="slate">Slate</button>
          <button class="rc-btn ${st.theme==='dark'?'on':''}" data-th="dark">Dark</button>
        </div>
        <div class="rc-sep"></div>
        <span class="rc-lbl">Mark</span>
        <div class="hl-toolbar-ctl" id="hl-ctl" title="Highlight selection (D) — scroll to change color">
          <div class="hl-apply-group">
            <button class="hl-apply" id="hl-apply" title="Highlight selection (D)"><span class="hl-pen hl-pen-${st.lastColor||'yellow'}" id="hl-cur">${icon('highlight')}</span></button>
            <button class="hl-arrow" id="hl-arrow" title="Choose color">${icon('chevD')}</button>
          </div>
          <div class="hl-vis">
            ${HL_COLORS.map(c => `<button class="hl-line hl-ln-${c} ${(ui.hlHidden&&ui.hlHidden[c])?'off':''}" data-vis="${c}" title="Show/hide ${c}"></button>`).join('')}
          </div>
        </div>
        <div class="rc-sep"></div>
        <div id="mode-panel"></div>
      </div>
      <div class="rc-right">
        <input id="r-name" value="${esc(text.name)}" class="r-name-input" placeholder="Untitled">
        ${ui.readerEditing ? `<button class="btn green r-saveread" id="r-saveread">${icon('play')} Save &amp; Read</button>` : `<button class="bar-btn" id="r-edit">${icon('edit')} Edit</button>`}
        <div class="bar-sep"></div>
        <button class="bar-btn" id="r-prompts" title="Prompt templates (press 1–9 on a selection)">${icon('listPlus')} Prompts</button>
        <div class="bar-sep"></div>
        <button class="bar-btn" id="r-keys" title="Keyboard shortcuts">⌨ Keys</button>
        <div class="bar-sep"></div>
        <button class="bar-btn" id="r-trans" title="Translation language">🌐 Translate</button>
        <div class="bar-sep"></div>
        <button class="bar-btn" id="r-newtext" title="Start a new text">${icon('plus')} New text</button>
        <div class="bar-sep"></div>
        <button class="ib-label" id="r-collapse" title="Full screen reading">${icon('chevU')} Full screen</button>
      </div>
      ${text.videoId
        ? `<button class="bar-collapse-chev flank-l" data-collapse title="Collapse toolbar">${icon('chevU')}</button><button class="bar-collapse-chev flank-r" data-collapse title="Collapse toolbar">${icon('chevU')}</button>`
        : `<button class="bar-collapse-chev center" data-collapse title="Collapse toolbar">${icon('chevU')}</button>`}
    </div>`;

  body.innerHTML = `
    ${renderLeftNav()}
    <div class="reader-wrap theme-${st.theme} ${barHidden?'bar-collapsed':''}" id="reader-wrap">
      ${barHidden ? `<div class="rc-hotzone" id="rc-hotzone"></div><button class="bar-peek-chev" id="bar-peek" title="Settings — hover to peek, click to restore">${icon('chevD')}</button>` : ''}
      ${toolbar}
      ${barHidden ? `<button class="bar-restore-tr" id="bar-restore" title="Show toolbar (Esc)">${icon('chevD')}</button>${speaking ? `<button class="play-float" id="r-playfloat">${icon(paused?'play':'pause')} ${paused?'Resume':'Pause'}</button>` : ''}` : ''}
      <div class="reader-scroll">
        <div class="reader-page" style="font-size:${fontPx}px; max-width:${widthPct}%">
          ${ui.readerEditing
            ? `<textarea class="reader-textarea" id="r-textarea" placeholder="Paste or type text here to read…">${esc(text.body)}</textarea>`
            : `<div class="reader-render" id="r-render">${readerRenderHtml(text)}</div>`}
        </div>
      </div>
    </div>
    ${ui.navCollapsed ? `<button class="lnav-reopen" id="reopen">${icon('chevR')}</button>` : ''}`;

  wireLeftNav();
  document.querySelectorAll('[data-collapse]').forEach(b => b.onclick = () => { ui.readerBarCollapsed = true; render(); });
  { const brst = document.getElementById('bar-restore'); if (brst) brst.onclick = () => { ui.readerBarCollapsed = false; render(); }; }
  { const bpk = document.getElementById('bar-peek'); if (bpk) bpk.onclick = () => { ui.readerBarCollapsed = false; render(); }; }
  { const pflt = document.getElementById('r-playfloat'); if (pflt) pflt.onclick = toggleSpeak; }

  {
    document.getElementById('sz-down').onclick = () => { const r=S.settings.reader; r.size=Math.max(0,r.size-1); VocabStore.set({settings:S.settings}); applyReaderSize(); };
    document.getElementById('sz-up').onclick = () => { const r=S.settings.reader; r.size=Math.min(SIZES.length-1,r.size+1); VocabStore.set({settings:S.settings}); applyReaderSize(); };
    const ws = document.getElementById('r-width');
    ws.oninput = () => { const pg=document.querySelector('.reader-page'); if(pg) pg.style.maxWidth = ws.value+'%'; };
    ws.onchange = () => { S.settings.reader.width = parseInt(ws.value,10); VocabStore.set({settings:S.settings}); };
    $root.querySelectorAll('[data-th]').forEach(b=>b.onclick=()=>{ S.settings.reader.theme=b.dataset.th; VocabStore.set({settings:S.settings}); applyReaderTheme(); });
    // highlight apply button: apply current color to current selection
    const hlApply = document.getElementById('hl-apply');
    if (hlApply) hlApply.onclick = () => {
      const sel = window.getSelection();
      const term = (sel && !sel.isCollapsed) ? sel.toString().trim() : '';
      if (term) addReaderHighlight(term, st.lastColor||'yellow');
      else toastInApp('Select text first, then highlight');
    };
    // arrow opens a small color dropdown
    const hlArrow = document.getElementById('hl-arrow');
    if (hlArrow) hlArrow.onclick = (e) => { e.stopPropagation(); openColorDropdown(hlArrow); };
    // scroll over the control cycles the default color and re-tints the pen
    const hlCtl = document.getElementById('hl-ctl');
    if (hlCtl) hlCtl.addEventListener('wheel', (e) => {
      e.preventDefault();
      let i = HL_COLORS.indexOf(st.lastColor||'yellow');
      i = (i + (e.deltaY>0?1:-1) + HL_COLORS.length) % HL_COLORS.length;
      st.lastColor = HL_COLORS[i]; VocabStore.set({settings:S.settings});
      const cur = document.getElementById('hl-cur'); if (cur) cur.className = 'hl-pen hl-pen-'+HL_COLORS[i];
    }, { passive:false });
    // thin-line visibility toggles
    $root.querySelectorAll('[data-vis]').forEach(b => b.onclick = () => {
      const c = b.dataset.vis;
      ui.hlHidden = ui.hlHidden || {};
      ui.hlHidden[c] = !ui.hlHidden[c];
      render();
    });
    document.getElementById('r-collapse').onclick = () => { ui.readerBarCollapsed=true; ui.navCollapsed=true; render(); };
    const pbtn = document.getElementById('r-prompts'); if (pbtn) pbtn.onclick = openPromptsModal;
    const kbtn = document.getElementById('r-keys'); if (kbtn) kbtn.onclick = openHotkeysModal;
    const trbtn = document.getElementById('r-trans'); if (trbtn) trbtn.onclick = openTransModal;
    const ntb = document.getElementById('r-newtext'); if (ntb) ntb.onclick = () => createNewText();
    const editBtn = document.getElementById('r-edit');
    if (editBtn) editBtn.onclick = () => { stopSpeak(); ui.readerEditing=true; render(); };
    const saveReadBtn = document.getElementById('r-saveread');
    if (saveReadBtn) saveReadBtn.onclick = () => { saveReaderBody(); ui.readerEditing=false; render(); };
    const nameInp = document.getElementById('r-name');
    nameInp.onblur = () => { text.name = nameInp.value.trim()||'Untitled'; text.updatedAt=Date.now(); VocabStore.set({texts:S.texts}); };
    nameInp.onkeydown = (e) => { if (e.key==='Enter') nameInp.blur(); };
  }

  if (ui.readerEditing && !barHidden) {
    const ta = document.getElementById('r-textarea');
    ta.oninput = () => { text.body = ta.value; };
    ta.onblur = saveReaderBody;
    hideVideoLayer();
  } else if (!ui.readerEditing) {
    wireReaderContent(text);
    if (text.videoId) showVideoLayer(text); else destroyVideoLayer();
  }
  renderModePanel();
  { const sc = document.querySelector('.reader-scroll');
    if (sc) { const onUserScroll = () => breakFollow(); sc.addEventListener('wheel', onUserScroll, { passive: true }); sc.addEventListener('touchmove', onUserScroll, { passive: true }); } }
  trackEngagement();
}

function removeFsOverlay() { const o = document.getElementById('reader-fs'); if (o) o.remove(); }

// Change reader font size without a full re-render (avoids lag + video reposition).
function applyReaderSize() {
  const st = S.settings.reader;
  const pg = document.querySelector('.reader-page');
  if (pg) pg.style.fontSize = (SIZES[st.size] || 18) + 'px';
  const lbl = document.querySelector('.sz-lbl');
  if (lbl) lbl.textContent = SIZE_LABELS[st.size] || 'M';
  positionVideoDock();
}

// Change reader background/theme without a full re-render.
function applyReaderTheme() {
  const st = S.settings.reader;
  const wrap = document.getElementById('reader-wrap');
  if (wrap) { wrap.classList.remove('theme-white','theme-paper','theme-sepia','theme-slate','theme-dark'); wrap.classList.add('theme-' + st.theme); }
  document.querySelectorAll('[data-th]').forEach(b => b.classList.toggle('on', b.dataset.th === st.theme));
}

// ── reader modes: YouTube vs Read-aloud ──────────────────────────────
// Follow/Play are shared controls whose STATE is per-mode. Tabs show only for
// video texts; video texts default to YouTube mode.
function readerModeFor(text) {
  if (!text || !text.videoId) return 'readaloud';
  return ui.readerMode === 'readaloud' ? 'readaloud' : 'youtube';
}
function ytIsPlaying() { try { return !!(ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 1); } catch { return false; } }
function setReaderMode(mode) {
  ui.readerMode = mode;
  if (mode === 'readaloud') { try { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch {} }
  else { stopSpeak(); }
  renderModePanel();
}
function modeTogglePlay() {
  const text = S.texts[ui.readerTextId];
  if (readerModeFor(text) === 'youtube') {
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    if (ytIsPlaying()) { try { ytPlayer.pauseVideo(); } catch {} } else { try { ytPlayer.playVideo(); } catch {} }
    setTimeout(renderModePanel, 150);
  } else {
    toggleSpeak();
    setTimeout(renderModePanel, 60);
  }
}
function modePlayFrom(charIdx) {
  const text = S.texts[ui.readerTextId];
  if (readerModeFor(text) === 'youtube') {
    const seg = segmentAtChar(text, charIdx);
    if (seg && ytPlayer && ytPlayer.seekTo) { ytPlayer.seekTo(seg.start, true); ytPlayer.playVideo(); setTimeout(renderModePanel, 150); }
  } else {
    startSpeakFrom(charIdx);
  }
}
function modeFollowOn(mode) {
  return mode === 'youtube' ? (ui.readerVideoFollow !== false) : (S.settings.reader.readFollow !== false);
}
function modeHighlightOn(mode) {
  return mode === 'youtube' ? (ui.readerVideoHighlight !== false) : (S.settings.reader.readHighlight !== false);
}
function renderModePanel() {
  const host = document.getElementById('mode-panel');
  if (!host) return;
  const text = S.texts[ui.readerTextId];
  const hasVid = !!(text && text.videoId);
  const mode = readerModeFor(text);
  const followOn = modeFollowOn(mode);
  const hlOn = modeHighlightOn(mode);
  const playing = mode === 'youtube' ? ytIsPlaying() : (speaking && !paused);
  const playLabel = mode === 'youtube' ? (playing ? 'Pause' : 'Play video') : (playing ? 'Pause' : 'Read aloud');
  host.className = 'mode-panel ' + (hasVid ? mode : 'readaloud') + (hasVid ? '' : ' no-tabs');
  host.innerHTML = `
    ${hasVid ? `<div class="mode-tabs">
      <button class="mode-tab yt ${mode==='youtube'?'on':''}" data-mode="youtube">${icon('play')} YouTube</button>
      <button class="mode-tab ra ${mode==='readaloud'?'on':''}" data-mode="readaloud">${icon('play')} Read aloud</button>
    </div>` : ''}
    <div class="mode-body">
      <button class="mode-play" id="mode-play">${icon(playing?'pause':'play')} ${playLabel}</button>
      <button class="mode-follow ${followOn?'on':''}" id="mode-follow" title="Text scrolls to follow along">${icon('play')} Follow</button>
      <button class="mode-follow ${hlOn?'on':''}" id="mode-hl" title="Highlight words while ${mode==='youtube'?'playing':'reading'}">${icon('highlight')} Highlight</button>
      ${mode==='readaloud' ? `<span class="mode-voice"><span class="rc-lbl">Voice</span><select class="lang-sel" id="mode-voice" style="max-width:150px">${voiceOptionsHtml()}</select></span>` : ''}
    </div>`;
  host.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setReaderMode(b.dataset.mode));
  const mp = document.getElementById('mode-play'); if (mp) mp.onclick = modeTogglePlay;
  const mf = document.getElementById('mode-follow');
  if (mf) mf.onclick = () => {
    let nowOn;
    if (mode === 'youtube') { ui.readerVideoFollow = (ui.readerVideoFollow === false); nowOn = ui.readerVideoFollow !== false; }
    else { S.settings.reader.readFollow = (S.settings.reader.readFollow === false); nowOn = S.settings.reader.readFollow !== false; VocabStore.set({settings:S.settings}); }
    if (nowOn && typeof hideFollowBtn === 'function') hideFollowBtn();
    renderModePanel();
  };
  const mh = document.getElementById('mode-hl');
  if (mh) mh.onclick = () => {
    let nowOff;
    if (mode === 'youtube') { ui.readerVideoHighlight = (ui.readerVideoHighlight === false); nowOff = ui.readerVideoHighlight === false; }
    else { S.settings.reader.readHighlight = (S.settings.reader.readHighlight === false); nowOff = S.settings.reader.readHighlight === false; VocabStore.set({settings:S.settings}); }
    if (nowOff && typeof clearFollow === 'function') clearFollow();
    renderModePanel();
  };
  const mv = document.getElementById('mode-voice'); if (mv) mv.onchange = (e) => { S.settings.reader.voiceURI = e.target.value; VocabStore.set({settings:S.settings}); };
}

// ── follow: break on manual scroll; recenter via a floating corner button ──
function followGlyph() {
  return `<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><line x1="2.5" y1="10" x2="12" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 6 L13 10 L9 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="15.5" y1="4.5" x2="15.5" y2="15.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}
function ensureFollowBtn() {
  let b = document.getElementById('follow-recenter');
  if (b) return b;
  b = document.createElement('button');
  b.id = 'follow-recenter';
  b.className = 'follow-recenter';
  b.title = 'Resume follow';
  b.innerHTML = `<span class="fr-ico">${followGlyph()}</span><span class="fr-label">Follow</span>`;
  b.onclick = reactivateFollow;
  document.body.appendChild(b);
  return b;
}
function showFollowBtn() { ensureFollowBtn().classList.add('show'); }
function hideFollowBtn() {
  const b = document.getElementById('follow-recenter');
  if (!b) return;
  b.classList.add('dissolve');
  setTimeout(() => { if (b) b.classList.remove('show', 'dissolve'); }, 320);
}
function removeFollowBtn() { const b = document.getElementById('follow-recenter'); if (b) b.remove(); }
function flyToCorner() {
  const ghost = document.createElement('div');
  ghost.className = 'follow-fly';
  ghost.innerHTML = followGlyph();
  ghost.style.left = (window.innerWidth / 2 - 12) + 'px';
  ghost.style.top = (window.innerHeight / 2 - 12) + 'px';
  document.body.appendChild(ghost);
  requestAnimationFrame(() => {
    const tx = (window.innerWidth - 46) - (window.innerWidth / 2);
    const ty = (window.innerHeight - 46) - (window.innerHeight / 2);
    ghost.style.transform = `translate(${tx}px, ${ty}px) scale(.45)`;
    ghost.style.opacity = '0';
  });
  setTimeout(() => ghost.remove(), 560);
}
function breakFollow() {
  const text = S.texts[ui.readerTextId];
  if (!text) return;
  const mode = readerModeFor(text);
  if (!modeFollowOn(mode)) return; // follow already off
  if (mode === 'youtube') ui.readerVideoFollow = false;
  else { S.settings.reader.readFollow = false; VocabStore.set({ settings: S.settings }); }
  renderModePanel();
  flyToCorner();
  showFollowBtn();
}
function reactivateFollow() {
  const text = S.texts[ui.readerTextId];
  const mode = readerModeFor(text);
  if (mode === 'youtube') ui.readerVideoFollow = true;
  else { S.settings.reader.readFollow = true; VocabStore.set({ settings: S.settings }); }
  renderModePanel();
  hideFollowBtn();
}

function saveReaderBody() {
  const ta = document.getElementById('r-textarea');
  if (ta && S.texts[ui.readerTextId]) S.texts[ui.readerTextId].body = ta.value;
  if (S.texts[ui.readerTextId]) { S.texts[ui.readerTextId].updatedAt = Date.now(); S.texts[ui.readerTextId].lastActiveAt = Date.now(); }
  VocabStore.set({ texts: S.texts });
}

// ── render the read-only text with marks + per-word spans for TTS highlight ──
// Marks may nest (a saved word inside a saved sentence) or partially overlap.
// Build a properly nested forest: a mark that fits inside another becomes its child,
// and a partial overlap is clipped into pieces so nothing is ever dropped — the old
// renderer silently skipped any mark overlapping a previous one.
function nestMarks(marks) {
  // start asc, longer first, and for identical spans the highlight wraps the saved
  // chip — so highlighting a chip paints the whole chip rather than a band inside it
  const rank = m => (m.type === 'hl' ? 0 : 1);
  const sorted = marks.slice().sort((a, b) => a.start - b.start || b.end - a.end || rank(a) - rank(b));
  const roots = [];
  const stack = [];   // currently open (containing) nodes, outermost first
  for (const m of sorted) {
    let s = m.start;
    const e = m.end;
    while (s < e) {
      while (stack.length && stack[stack.length - 1].end <= s) stack.pop();
      const top = stack[stack.length - 1];
      if (!top || e <= top.end) {
        // fits entirely: a root, or a child of the mark containing it
        const node = { mark: m, start: s, end: e, children: [], last: true };
        (top ? top.children : roots).push(node);
        stack.push(node);
        s = e;
      } else {
        // extends past its container → emit the part that fits, continue after it
        top.children.push({ mark: m, start: s, end: top.end, children: [], last: false });
        s = top.end;
        stack.pop();
      }
    }
  }
  return roots;
}

function renderMarkNode(body, node) {
  const m = node.mark;
  const inner = renderMarkChildren(body, node.children, node.start, node.end);
  if (m.type === 'hl') {
    const color = m.color || 'yellow';
    const hidden = (ui.hlHidden && ui.hlHidden[color]) ? ' hl-off' : '';
    const hattr = m.highlightId ? ` data-rhl="${m.highlightId}"` : '';
    const hl = m.highlightId ? S.highlights[m.highlightId] : null;
    const hasNote = hl && !noteIsEmpty(hl.note);
    let out = `<mark class="hl hl-${color}${hidden}"${hattr}>${inner}</mark>`;
    // the note marker belongs on the final piece only
    if (m.highlightId && !hidden && node.last) {
      out += `<span class="note-marker ${hasNote?'has-note':'empty-note'}" data-note="${m.highlightId}" title="${hasNote?'Note':'Add note'}">${icon('note')}</span>`;
    }
    return out;
  }
  const selCls = (m.termId && ui.readerSel.has(m.termId)) ? ' sel' : '';
  const tattr = m.termId ? ` data-rterm="${m.termId}"` : '';
  return `<mark class="saved${selCls}"${tattr}>${inner}</mark>`;
}

function renderMarkChildren(body, children, from, to) {
  let html = '', cur = from;
  for (const c of children) {
    if (c.start > cur) html += wrapWords(body, cur, c.start);
    html += renderMarkNode(body, c);
    cur = c.end;
  }
  if (cur < to) html += wrapWords(body, cur, to);
  return html;
}

function readerRenderHtml(text) {
  const body = text.body || '';
  if (!body.trim()) return '<span style="color:var(--text3)">(empty — switch to Edit to add text)</span>';
  const marks = (text.marks||[]).filter(m =>
    Number.isFinite(m.start) && Number.isFinite(m.end) &&
    m.start >= 0 && m.end <= body.length && m.end > m.start
  );
  return renderMarkChildren(body, nestMarks(marks), 0, body.length);
}

// Wrap each word in a span carrying its character start index (for TTS boundary mapping)
function wrapWords(body, start, end) {
  const seg = body.slice(start, end);
  let out = '';
  const re = /(\s+)|([^\s]+)/g;
  let mm;
  while ((mm = re.exec(seg)) !== null) {
    if (mm[1]) { out += esc(mm[1]); }
    else {
      const wStart = start + mm.index;
      out += `<span class="w" data-c="${wStart}">${esc(mm[2])}</span>`;
    }
  }
  return out;
}

// Map a DOM selection to character offsets in the text body. We anchor on the
// word spans (data-c) which carry exact original-body offsets, then measure the
// precise start/end within those spans. This avoids term.length / whitespace drift.
function selectionCharRange(container, range, term) {
  try {
    const startInfo = charOffsetOfPoint(range.startContainer, range.startOffset);
    const endInfo = charOffsetOfPoint(range.endContainer, range.endOffset);
    if (startInfo == null || endInfo == null) return null;
    let start = startInfo, end = endInfo;
    if (end < start) { const t = start; start = end; end = t; }
    if (end <= start) return null;
    return { start, end };
  } catch { return null; }
}

// Given a DOM point (node, offset) inside the reader render, return the
// corresponding character index in the original text body.
function charOffsetOfPoint(node, offset) {
  // find the enclosing word span
  let el = (node.nodeType === 3) ? node.parentElement : node;
  let wSpan = el && el.closest ? el.closest('.w') : null;
  if (wSpan) {
    const base = parseInt(wSpan.dataset.c, 10);
    if (isNaN(base)) return null;
    // offset within the word span's text content
    let within = 0;
    if (node.nodeType === 3) {
      // sum text length of any preceding siblings inside the same span, + offset
      within = textLengthBefore(wSpan, node) + offset;
    }
    return base + within;
  }
  // point is between words (whitespace) — find the next word span and use its base
  let probe = (node.nodeType === 3) ? node.parentElement : node;
  // walk the DOM forward to the next .w
  const walker = document.createTreeWalker(document.getElementById('r-render'), NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => n.classList && n.classList.contains('w') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
  });
  // position the walker near our node, then take the next word
  let best = null;
  while (walker.nextNode()) {
    const w = walker.currentNode;
    if (node.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING) { best = w; break; }
  }
  if (best) { const b = parseInt(best.dataset.c,10); return isNaN(b)?null:b; }
  return null;
}

// total text length of nodes before `stopNode` within `root`
function textLengthBefore(root, stopNode) {
  let len = 0, done = false;
  (function walk(n) {
    if (done) return;
    if (n === stopNode) { done = true; return; }
    if (n.nodeType === 3) { len += n.textContent.length; return; }
    for (const c of n.childNodes) { walk(c); if (done) return; }
  })(root);
  return len;
}

// ── YouTube player: persistent layer that reader re-renders never touch ──
// The panel lives on <body>, not inside the reader DOM that gets wiped on every
// render. Moving an iframe reloads it, so we NEVER move it — we just reposition
// the fixed panel over the reading column. That's what keeps playback alive when
// the sidebar/top bar/font/etc. re-render the reader.
let ytSyncTimer = null;
let ytPlayer = null;
let _vfWasOn = true;

function loadYtApi(cb) {
  if (window.YT && window.YT.Player) { cb(); return; }
  (window._ytApiCbs = window._ytApiCbs || []).push(cb);
  if (window._ytApiLoading) return;
  window._ytApiLoading = true;
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    if (typeof prev === 'function') { try { prev(); } catch {} }
    (window._ytApiCbs || []).forEach(f => { try { f(); } catch {} });
    window._ytApiCbs = [];
  };
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

// Build the persistent panel once (on <body>); wire its chrome once.
function getVideoLayer() {
  let p = document.getElementById('yt-panel');
  if (p && p.parentNode === document.body) return p;
  if (p && p.parentNode) p.parentNode.removeChild(p); // clean up any stray inline copy
  p = document.createElement('div');
  p.id = 'yt-panel';
  p.className = 'yt-theater yt-docked';
  p.style.setProperty('--yt-op', '1');
  p.innerHTML = `
    <div class="yt-stage" id="yt-stage">
      <div class="yt-screen" id="yt-player-wrap"><div id="yt-player"></div></div>
      <div class="yt-op" title="Video opacity"><input type="range" id="yt-op" min="20" max="100" value="100"></div>
      <button class="yt-dot" id="yt-dock" title="Dock to top / pop out">
        <svg class="yt-dot-ico" viewBox="0 0 20 14" width="14" height="10" aria-hidden="true"><rect x="1" y="1" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4.5" y="4" width="11" height="6" rx="1.3" fill="currentColor"/></svg>
        <span class="yt-dot-txt">Theater</span>
      </button>
      <div class="yt-resize" id="yt-resize" title="Drag up or down to resize"><span></span></div>
    </div>`;
  document.body.appendChild(p);
  setupVideoChrome(p);
  if (!window._ytResizeBound) {
    window._ytResizeBound = true;
    window.addEventListener('resize', () => { if (ui.view === 'reader' && document.getElementById('yt-panel')) positionVideoDock(); });
  }
  return p;
}

// Called from renderReader when the current text has a video.
function showVideoLayer(text) {
  const panel = getVideoLayer();
  panel.style.display = '';
  if (panel.dataset.vid !== text.videoId) {
    panel.dataset.vid = text.videoId;
    setupVideoPlayer(text); // (re)build the iframe only when the video actually changes
  }
  wireReaderSeek(text);     // re-bind dbl-click seek onto the freshly rendered transcript
  positionVideoDock();
}
function hideVideoLayer() { const p = document.getElementById('yt-panel'); if (p) p.style.display = 'none'; }
function destroyVideoLayer() {
  stopYtSync();
  const p = document.getElementById('yt-panel'); if (p) p.remove();
  ytPlayer = null;
  const rp = document.querySelector('.reader-page'); if (rp) rp.style.paddingTop = '';
}

// Position the fixed panel over the reading column (docked) or free (floating).
function positionVideoDock() {
  const panel = document.getElementById('yt-panel'); if (!panel) return;
  const st = ui.ytUI || (ui.ytUI = { mode: 'docked', w: 33, fw: 380, op: 100, x: null, y: null });
  panel.style.setProperty('--yt-op', st.op / 100);
  panel.style.opacity = String(st.op / 100);
  const rp = document.querySelector('.reader-page');
  if (st.mode === 'floating') {
    panel.classList.add('yt-floating'); panel.classList.remove('yt-docked');
    panel.style.position = 'fixed'; panel.style.margin = '0'; panel.style.width = st.fw + 'px';
    panel.style.left = (st.x != null ? st.x : Math.max(8, window.innerWidth - st.fw - 28)) + 'px';
    panel.style.top  = (st.y != null ? st.y : 90) + 'px';
    if (rp) rp.style.paddingTop = '';
    return;
  }
  const scroll = document.querySelector('.reader-scroll');
  if (!scroll) return;
  const r = scroll.getBoundingClientRect();
  const w = Math.max(180, r.width * st.w / 100);
  panel.classList.add('yt-docked'); panel.classList.remove('yt-floating');
  panel.style.position = 'fixed'; panel.style.margin = '0';
  panel.style.width = w + 'px';
  panel.style.left = (r.left + (r.width - w) / 2) + 'px';
  panel.style.top  = (r.top + 8) + 'px';
  if (rp) rp.style.paddingTop = (panel.offsetHeight + 16) + 'px'; // reserve space so text starts below
}

function setupVideoPlayer(text) {
  if (!document.getElementById('yt-player')) return;
  ytPlayer = null;
  loadYtApi(() => {
    if (!document.getElementById('yt-player')) return;
    try {
      ytPlayer = new YT.Player('yt-player', {
        videoId: text.videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
        events: { onReady: () => startYtSync(text) }
      });
    } catch (err) { console.warn('[vocab] YT.Player failed', err); }
  });
}

function wireReaderSeek(text) {
  const render_ = document.getElementById('r-render');
  if (render_ && !render_._ytSeekWired) {
    render_._ytSeekWired = true;
    render_.addEventListener('dblclick', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain double-click = normal word selection
      const w = e.target.closest('.w'); if (!w) return;
      const charIdx = parseInt(w.dataset.c, 10); if (isNaN(charIdx)) return;
      e.preventDefault();
      modePlayFrom(charIdx);
    });
  }
}

function segmentAtChar(text, charIdx) {
  const segs = text.segments || []; let best = null;
  for (const s of segs) { if (s.offset <= charIdx) best = s; else break; }
  return best;
}

// Follow = drive read-aloud's highlightFollow() from the video's clock.
function startYtSync(text) {
  stopYtSync();
  if (ui.readerVideoFollow === undefined) ui.readerVideoFollow = true;
  const segs = text.segments || [];
  ytSyncTimer = setInterval(() => {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    const doHl = ui.readerVideoHighlight !== false;
    const doFollow = ui.readerVideoFollow !== false;
    if (!doHl && !doFollow) { if (_vfWasOn) { clearFollow(); _vfWasOn = false; } return; }
    _vfWasOn = true;
    if (!segs.length) return;
    let t; try { t = ytPlayer.getCurrentTime(); } catch { return; }
    let i = -1;
    for (let k = 0; k < segs.length; k++) { if (segs[k].start <= t + 0.15) i = k; else break; }
    if (i < 0) return;
    const s = segs[i], next = segs[i + 1];
    const span = next ? Math.max(0.001, next.start - s.start) : 2.5;
    const p = Math.max(0, Math.min(1, (t - s.start) / span));
    const absChar = s.offset + Math.floor(p * (s.len || 0));
    highlightFollow(absChar, doHl, doFollow);
  }, 220);
}
function stopYtSync() { if (ytSyncTimer) { clearInterval(ytSyncTimer); ytSyncTimer = null; } }

// ── theater panel controls: dock/float, bottom-edge resize, drag-to-move, opacity ──
let _ytDrag = null, _ytRez = null, _ytDocBound = false;
function bindYtDocListeners() {
  if (_ytDocBound) return; _ytDocBound = true;
  document.addEventListener('mousemove', (e) => {
    const st = ui.ytUI; if (!st) return;
    if (_ytDrag) {
      const d = _ytDrag;
      st.x = Math.max(0, Math.min(d.ox + (e.clientX - d.sx), window.innerWidth - d.panel.offsetWidth));
      st.y = Math.max(0, Math.min(d.oy + (e.clientY - d.sy), window.innerHeight - 60));
      d.panel.style.left = st.x + 'px'; d.panel.style.top = st.y + 'px';
    } else if (_ytRez) {
      const z = _ytRez;
      const newW = z.sw + (e.clientY - z.sy) * (16 / 9); // drag DOWN = bigger
      if (st.mode === 'floating') { st.fw = Math.max(220, Math.min(newW, window.innerWidth - 40)); }
      else { const cw = (document.querySelector('.reader-scroll') || {}).offsetWidth || window.innerWidth; st.w = Math.max(18, Math.min(74, (newW / cw) * 100)); }
      positionVideoDock();
    }
  });
  document.addEventListener('mouseup', () => {
    const p = (_ytDrag && _ytDrag.panel) || (_ytRez && _ytRez.panel);
    if (p) { p.classList.remove('yt-drag-active'); p.classList.remove('yt-resize-active'); }
    _ytDrag = null; _ytRez = null;
  });
}
function applyYtState(panel) { positionVideoDock(); }
function setupVideoChrome(panel) {
  const st = ui.ytUI || (ui.ytUI = { mode: 'docked', w: 33, fw: 380, op: 100, x: null, y: null });
  bindYtDocListeners();
  const stage = document.getElementById('yt-stage');
  const op = document.getElementById('yt-op');
  if (op) {
    op.value = st.op;
    const applyOp = () => { st.op = +op.value; panel.style.setProperty('--yt-op', st.op / 100); panel.style.opacity = String(st.op / 100); };
    op.oninput = applyOp; applyOp();
  }
  const dot = document.getElementById('yt-dock');
  if (dot) dot.onclick = (e) => {
    e.stopPropagation();
    st.mode = (st.mode === 'docked') ? 'floating' : 'docked';
    if (st.mode === 'docked') { st.x = st.y = null; }
    positionVideoDock();
  };
  if (stage) stage.addEventListener('mousedown', (e) => {
    if (e.target.closest('.yt-dot, .yt-resize, .yt-op, input, button')) return;
    const r = panel.getBoundingClientRect();
    if (st.mode !== 'floating') { st.mode = 'floating'; st.fw = r.width; positionVideoDock(); }
    _ytDrag = { panel, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    panel.classList.add('yt-drag-active');
    e.preventDefault();
  });
  const rez = document.getElementById('yt-resize');
  if (rez) rez.addEventListener('mousedown', (e) => {
    _ytRez = { panel, sy: e.clientY, sw: panel.getBoundingClientRect().width };
    panel.classList.add('yt-resize-active');
    e.preventDefault(); e.stopPropagation();
  });
}

function wireReaderContent(text) {
  const render_ = document.getElementById('r-render');
  if (!render_) return;

  render_.addEventListener('mouseup', (e) => {
    // A click on a chip has no text selection; its own handler opens the tooltip, so
    // don't let this one close it 10ms later.
    const onChip = !!(e.target.closest && e.target.closest('[data-rterm]'));
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { if (!onChip) hideTT(); return; }
      // NOTE: a selection touching a saved item is allowed — you can select around or
      // across saved words and save/highlight the larger span (they nest).
      const term = sel.toString().trim();
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      ui.lastSelRange = selectionCharRange(render_, range, term); // {start,end} or null
      showTT(rect, term);   // savedId omitted → derived from the selection's range
    }, 10);
  });

  // double-click a word → jump reading position ONLY while actively reading (not paused/stopped)
  render_.addEventListener('dblclick', (e) => {
    if (!speaking || paused) return;
    const w = e.target.closest('.w');
    if (!w) return;
    const charIdx = parseInt(w.dataset.c, 10);
    if (!isNaN(charIdx)) startSpeakFrom(charIdx);
  });

  // right-click a word (when NOT reading) → "Read from here"
  render_.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-rterm]')) return; // chip has its own menu
    const w = e.target.closest('.w');
    if (!w) return;
    const charIdx = parseInt(w.dataset.c, 10);
    if (isNaN(charIdx)) return;
    e.preventDefault();
    openWordMenu(e, charIdx);
  });

  // saved-chip selection + drag
  render_.querySelectorAll('[data-rterm]').forEach(mk => {
    mk.addEventListener('click', (e) => {
      e.stopPropagation();
      const tid = mk.dataset.rterm;
      if (e.ctrlKey || e.metaKey) {
        if (ui.readerSel.has(tid)) ui.readerSel.delete(tid); else ui.readerSel.add(tid);
        render();
        return;
      }
      if (ui.readerSel.size >= 4 && !ui.readerSel.has(tid)) { showDeselectConfirm(e, tid); return; }
      ui.readerSel.clear(); ui.readerSel.add(tid);
      // Clicking a chip IS selecting it: point the tooltip's actions at this item's
      // span, then re-render and re-anchor the tooltip to the fresh chip element.
      selectSavedChip(tid);
    });
    mk.setAttribute('draggable','true');
    mk.addEventListener('dragstart', (ev) => {
      const tid = mk.dataset.rterm;
      // never mutate the selection on dragstart (an accidental nudge used to wipe it)
      const ids = ui.readerSel.has(tid) ? [...ui.readerSel] : [tid];
      dragData = { kind:'terms', ids, fromListId:null };
      ev.dataTransfer.effectAllowed='copyMove';
      ev.dataTransfer.setData('text/plain', ids.join(','));
    });
    // right-click selected chips → save to list
    mk.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      let ids = ui.readerSel.has(mk.dataset.rterm) ? [...ui.readerSel] : [mk.dataset.rterm];
      if (!ui.readerSel.has(mk.dataset.rterm)) { ui.readerSel.clear(); ui.readerSel.add(mk.dataset.rterm); render(); }
      openAddToListModal(ids);
    });
  });

  // click empty space deselects (confirm if 4+)
  render_.addEventListener('click', (e) => {
    if (e.target.closest('[data-rterm]')) return;
    if (e.target.closest('[data-rhl]')) return;
    if (e.target.closest('[data-note]')) return;
    if (ui.readerSel.size === 0) return;
    if (ui.readerSel.size >= 4) { showDeselectConfirm(e, null); return; }
    ui.readerSel.clear(); render();
  });

  // note markers: click → open note; hover → preview
  render_.querySelectorAll('[data-note]').forEach(nm => {
    nm.addEventListener('click', (e) => { e.stopPropagation(); openNote(nm.dataset.note, e); });
    nm.addEventListener('mouseenter', (e) => showNotePreview(nm.dataset.note, nm));
    nm.addEventListener('mouseleave', hideNotePreview);
  });
}

// ── Feature C: sticky notes on highlights ──
let openNotes = {}; // id -> element (allow several open at once)
function closeAllReaderNotes() { for (const id in openNotes) { try { openNotes[id].remove(); } catch {} } openNotes = {}; }

function openNote(hlId, ev) {
  const hl = S.highlights[hlId];
  if (!hl) return;
  hideNotePreview();
  if (openNotes[hlId]) { openNotes[hlId].remove(); delete openNotes[hlId]; return; } // toggle

  const note = document.createElement('div');
  note.className = 'sticky-note sticky-' + (hl.noteColor || 'yellow');
  note.innerHTML = `
    <div class="sticky-head">
      <div class="sticky-tools">
        <button class="sticky-fmt" data-rt="bold" title="Bold"><b>B</b></button>
        <button class="sticky-fmt" data-rt="italic" title="Italic"><i>I</i></button>
        <button class="sticky-fmt" data-rt="insertUnorderedList" title="Bulleted list">${icon('bullets')}</button>
        <button class="sticky-fmt" data-rt="insertOrderedList" title="Numbered list">${icon('numbers')}</button>
        <span class="sticky-tool-sep"></span>
        ${['yellow','pink','blue','green'].map(c => `<button class="sticky-dot sticky-dot-${c}" data-nc="${c}" title="${c}"></button>`).join('')}
      </div>
      <button class="sticky-close" title="Close">${icon('x')}</button>
    </div>
    <div class="sticky-quote" title="Jump to this highlight in the text">“${esc(hl.text)}”</div>
    <div class="sticky-text" contenteditable="true" data-placeholder="Write a note…">${hl.note||''}</div>`;
  document.body.appendChild(note);

  // position near the click, kept on screen
  const x = Math.min((ev?.clientX||200), window.innerWidth - 250);
  const y = Math.min((ev?.clientY||200) + 12, window.innerHeight - 200);
  note.style.left = Math.max(8,x) + 'px';
  note.style.top = Math.max(8,y) + 'px';
  openNotes[hlId] = note;

  const ta = note.querySelector('.sticky-text');
  safeFocus(ta);
  let saveTimer = null;
  const save = async () => { await VocabStore.editHighlight(hlId, { note: ta.innerHTML }); };
  ta.oninput = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };
  ta.onblur = save;

  // rich text formatting buttons + active-state highlighting
  const fmtBtns = note.querySelectorAll('.sticky-fmt');
  const refreshFmtState = () => {
    fmtBtns.forEach(b => {
      let active = false;
      try { active = document.queryCommandState(b.dataset.rt); } catch {}
      b.classList.toggle('fmt-active', !!active);
    });
  };
  fmtBtns.forEach(b => b.onmousedown = (e) => {
    e.preventDefault(); // keep focus in the editor
    document.execCommand(b.dataset.rt, false, null);
    ta.focus();
    refreshFmtState();
  });
  ta.addEventListener('keyup', refreshFmtState);
  ta.addEventListener('mouseup', refreshFmtState);

  // clicking the quote scrolls the reader to this highlight and flashes it
  const quote = note.querySelector('.sticky-quote');
  quote.onclick = () => scrollToHighlight(hlId);

  note.querySelector('.sticky-close').onclick = async () => {
    await save();
    note.remove(); delete openNotes[hlId];
    S = await VocabStore.getAll(); render();
  };
  note.querySelectorAll('[data-nc]').forEach(b => b.onclick = async () => {
    const c = b.dataset.nc;
    note.className = 'sticky-note sticky-' + c;
    await VocabStore.updateHighlight(hlId, { noteColor: c });
  });

  makeDraggable(note, note.querySelector('.sticky-head'));

  // Esc closes this note (when focus is inside it)
  note.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      await save();
      note.remove(); delete openNotes[hlId];
      S = await VocabStore.getAll(); render();
    }
  });
}

// scroll the reader to a highlight and flash it
function scrollToHighlight(hlId) {
  const mk = document.querySelector(`mark[data-rhl="${hlId}"]`);
  if (!mk) { toastInApp('That highlight isn’t in the current text'); return; }
  mk.scrollIntoView({ block:'center', behavior:'smooth' });
  mk.classList.add('hl-flash');
  setTimeout(() => mk.classList.remove('hl-flash'), 1400);
}

function makeDraggable(el, handle) {
  let sx, sy, ox, oy, dragging = false;
  handle.style.cursor = 'grab';
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true; handle.style.cursor = 'grabbing';
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.style.left = Math.max(0, Math.min(ox + (e.clientX-sx), window.innerWidth - el.offsetWidth)) + 'px';
    el.style.top = Math.max(0, Math.min(oy + (e.clientY-sy), window.innerHeight - 40)) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; handle.style.cursor = 'grab'; });
}

let notePreviewEl = null;
function noteIsEmpty(html) {
  if (!html) return true;
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  return !(tmp.textContent || '').trim();
}
function showNotePreview(hlId, anchor) {
  const hl = S.highlights[hlId];
  if (!hl || noteIsEmpty(hl.note)) return;
  if (openNotes[hlId]) return;
  hideNotePreview();
  notePreviewEl = document.createElement('div');
  notePreviewEl.className = 'note-preview';
  notePreviewEl.innerHTML = hl.note;
  document.body.appendChild(notePreviewEl);
  const r = anchor.getBoundingClientRect();
  notePreviewEl.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
  notePreviewEl.style.top = (r.bottom + 6) + 'px';
}
function hideNotePreview() { if (notePreviewEl) { notePreviewEl.remove(); notePreviewEl = null; } }

function showDeselectConfirm(e, addTid) {
  closeConfirm();
  const pop = document.createElement('div');
  pop.className='confirm-pop';
  pop.style.left = Math.min(e.clientX, window.innerWidth-210)+'px';
  pop.style.top = (e.clientY+8)+'px';
  pop.innerHTML = `
    <div class="confirm-txt">Deselect ${ui.readerSel.size} items?</div>
    <div class="confirm-btns">
      <button class="cf-btn" id="cf-deselect">Deselect all</button>
      <button class="cf-btn green" id="cf-add">${addTid?'Add to selection':'Keep selection'}</button>
    </div>`;
  document.body.appendChild(pop);
  document.getElementById('cf-deselect').onclick = () => { ui.readerSel.clear(); closeConfirm(); render(); };
  document.getElementById('cf-add').onclick = () => { if (addTid) ui.readerSel.add(addTid); closeConfirm(); render(); };
  confirmPop = pop;
}

// ── selection tooltip (faded, full on hover) ──
const HL_COLORS = ['yellow','pink','blue'];
// The selection tooltip stays open after an action so you can keep working on the
// same selection. Buttons don't change their label — they just stay pressed (green)
// while the selection is saved / highlighted, and clicking again undoes it.
function showTT(rect, term, savedId, hlId) {
  hideTT();
  const cur = S.settings.reader.lastColor || 'yellow';
  if (savedId === undefined) savedId = savedTermIdForRange(ui.lastSelRange);
  if (hlId === undefined) hlId = highlightIdForRange(ui.lastSelRange);
  _ttRect = rect; _ttTerm = term; _ttSavedId = savedId || null; _ttHlId = hlId || null;
  ttEl = document.createElement('div');
  ttEl.className='sel-tt';
  ttEl.innerHTML = `
    <button class="tt-add ${_ttSavedId ? 'on' : ''}" title="${_ttSavedId ? 'Saved — click to undo' : 'Save this item'}">${icon('plus')} Add</button>
    <button class="tt-tr" title="Translate">${icon('translate')}</button>
    <div class="tt-hl-wrap" title="Highlight — scroll to change color">
      <button class="tt-hl ${_ttHlId ? 'on' : ''}" id="tt-hl" title="${_ttHlId ? 'Highlighted — click to remove' : 'Highlight'}"><span class="hl-pen" id="tt-pen">${icon('highlight')}</span></button>
      <div class="tt-colors" id="tt-colors">
        ${HL_COLORS.map(c => `<button class="hl-line hl-ln-${c} ${c===cur?'on':''}" data-color="${c}" title="${c}"></button>`).join('')}
      </div>
    </div>`;
  ttEl.style.left = Math.max(8, Math.min(rect.left, window.innerWidth-200))+'px';
  ttEl.style.top = Math.max(8, rect.top - 46)+'px';
  document.body.appendChild(ttEl);

  // Add ⇄ undo
  const addBtn = ttEl.querySelector('.tt-add');
  addBtn.onclick = async () => {
    addBtn.disabled = true;
    if (_ttSavedId) { await unsaveReaderTerm(_ttSavedId); reopenTT(null, _ttHlId); }
    else { const id = await addReaderTerm(term, 'saved'); reopenTT(id, _ttHlId); }
  };
  ttEl.querySelector('.tt-tr').onclick = () => { showInlineTranslation(term, ttEl.getBoundingClientRect()); hideTT(); };

  // highlighter → apply current color, or remove it if already highlighted
  const hlBtn = ttEl.querySelector('#tt-hl');
  hlBtn.onclick = async () => {
    hlBtn.disabled = true;
    const id = await toggleReaderHighlight(term, S.settings.reader.lastColor||'yellow');
    reopenTT(_ttSavedId, id);
  };
  // click a color → set default AND apply in the same action (always applies, never removes)
  ttEl.querySelectorAll('[data-color]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const c = b.dataset.color;
    S.settings.reader.lastColor = c; VocabStore.set({settings:S.settings});
    const id = await addReaderHighlight(term, c);
    reopenTT(_ttSavedId, id);
  });
  // vertical scroll over the highlighter cycles color; release applies on click,
  // but to honor "same action", scrolling sets the pen color live and a click highlights.
  const wrap = ttEl.querySelector('.tt-hl-wrap');
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    let i = HL_COLORS.indexOf(S.settings.reader.lastColor||'yellow');
    i = (i + (e.deltaY>0?1:-1) + HL_COLORS.length) % HL_COLORS.length;
    const c = HL_COLORS[i];
    S.settings.reader.lastColor = c; VocabStore.set({settings:S.settings});
    ttEl.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b.dataset.color===c));
  }, { passive:false });
}
// Re-open the tooltip after an action, re-anchored to the mark if there is one
// (saving adds padding, which shifts the text slightly).
function reopenTT(termId, hlId) {
  const el = termId ? document.querySelector(`[data-rterm="${termId}"]`) : null;
  const r = el ? el.getBoundingClientRect() : _ttRect;
  if (!r || !_ttTerm) { hideTT(); return; }
  showTT(r, _ttTerm, termId || null, hlId === undefined ? undefined : (hlId || null));
}
// Clicking a saved chip selects it and opens the tooltip on it, with the tooltip's
// actions (highlight/translate/undo) pointed at exactly that item's span.
function selectSavedChip(tid) {
  const text = S.texts[ui.readerTextId];
  const m = text && (text.marks||[]).find(x => x.type==='saved' && x.termId === tid);
  if (!m) { render(); return; }
  ui.lastSelRange = { start: m.start, end: m.end };
  const term = (text.body || '').slice(m.start, m.end).replace(/\s+/g,' ').trim();
  render();                                     // re-render so the chip shows as selected
  const el = document.querySelector(`[data-rterm="${tid}"]`);
  if (el) showTT(el.getBoundingClientRect(), term, tid);
}
function hideTT(){ if(ttEl){ttEl.remove();ttEl=null;} }

// dropdown to choose the default highlight color (from the toolbar arrow)
function openColorDropdown(anchorEl) {
  closeCtxMenu();
  const st = S.settings.reader;
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu hl-dropdown';
  ctxMenu.innerHTML = HL_COLORS.map(c =>
    `<button class="hl-drop-item ${c===(st.lastColor||'yellow')?'on':''}" data-c="${c}"><span class="hl-line hl-ln-${c}"></span> ${c.charAt(0).toUpperCase()+c.slice(1)}</button>`
  ).join('');
  document.body.appendChild(ctxMenu);
  const r = anchorEl.getBoundingClientRect();
  ctxMenu.style.left = Math.min(r.left, window.innerWidth-150) + 'px';
  ctxMenu.style.top = (r.bottom + 4) + 'px';
  ctxMenu.querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
    st.lastColor = b.dataset.c; VocabStore.set({settings:S.settings});
    closeCtxMenu();
    const cur = document.getElementById('hl-cur'); if (cur) cur.className = 'hl-pen hl-pen-'+b.dataset.c;
    // if there's an active selection, apply right away
    const sel = window.getSelection();
    const term = (sel && !sel.isCollapsed) ? sel.toString().trim() : '';
    if (term) addReaderHighlight(term, b.dataset.c);
  });
}

// right-click a word when not reading → small "Read from here" menu
function openWordMenu(e, charIdx) {
  closeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  const _m = readerModeFor(S.texts[ui.readerTextId]);
  const _lbl = _m === 'youtube' ? 'Play from here' : 'Read from here';
  ctxMenu.innerHTML = `<button class="ctx-item" data-k="readhere">${icon('play')} ${_lbl}</button>`;
  document.body.appendChild(ctxMenu);
  const _r = ctxMenu.getBoundingClientRect();
  let _left = e.clientX - _r.width / 2;
  let _top = e.clientY - _r.height / 2;
  _left = Math.max(6, Math.min(_left, window.innerWidth - _r.width - 6));
  _top = Math.max(6, Math.min(_top, window.innerHeight - _r.height - 6));
  ctxMenu.style.left = _left + 'px';
  ctxMenu.style.top = _top + 'px';
  ctxMenu.querySelector('[data-k=readhere]').onclick = () => { closeCtxMenu(); modePlayFrom(charIdx); };
}
document.addEventListener('mousedown', e => {
  if (ttEl && !ttEl.contains(e.target)) hideTT();
  if (confirmPop && !confirmPop.contains(e.target)) closeConfirm();
  const tp = document.getElementById('xlate-panel');
  if (tp && !tp.contains(e.target)) tp.remove();
});

// ── inline translation panel (no popup window) ──
// The sentence containing the selection — but only if the selection stays within
// ONE sentence (from the previous . ! ? to the next). Returns null otherwise.
function sentenceRangeFor(body, start, end) {
  if (!body || start == null || end == null) return null;
  const inner = body.slice(start, Math.max(start, end - 1));
  if (/[.!?]/.test(inner)) return null; // selection spans more than one sentence
  const CAP = 110; // soft per-side cap (~220 total) for punctuation-free transcripts
  let s = 0, foundStart = false;
  for (let i = start - 1; i >= 0 && start - i <= CAP; i--) { if ('.!?'.includes(body[i])) { s = i + 1; foundStart = true; break; } }
  if (!foundStart) {
    // no sentence-ending punctuation within the cap — stop there, but back up
    // to the nearest space so we never cut off in the middle of a word
    s = Math.max(0, start - CAP);
    const sp = body.indexOf(' ', s);
    if (sp !== -1 && sp < start) s = sp + 1;
  }
  let e = body.length, foundEnd = false;
  for (let i = end; i < body.length && i - end <= CAP; i++) { if ('.!?'.includes(body[i])) { e = i + 1; foundEnd = true; break; } }
  if (!foundEnd) {
    e = Math.min(body.length, end + CAP);
    const sp = body.lastIndexOf(' ', e);
    if (sp !== -1 && sp > end) e = sp;
  }
  while (s < e && /\s/.test(body[s])) s++;
  return { start: s, end: e, text: body.slice(s, e).replace(/\s+/g, ' ').trim() };
}
function sentenceFor(body, start, end) { const r = sentenceRangeFor(body, start, end); return r ? r.text : null; }

async function translateInto(targetId, q, withDict) {
  const el = document.getElementById(targetId); if (!el) return;
  const target = S.settings.reader.transTarget || 'en';
  const source = (S.settings.reader.lang && S.settings.reader.lang !== 'auto') ? S.settings.reader.lang : 'auto';
  try {
    const dt = withDict ? 'dt=t&dt=bd' : 'dt=t';
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&${dt}&q=${encodeURIComponent(q)}`);
    const data = await r.json();
    const translated = (data[0]||[]).map(seg => seg[0]).join('');
    let alts = '';
    if (withDict && Array.isArray(data[1])) {
      alts = data[1].map(entry => { const pos = entry[0]||''; const words = (entry[1]||[]).slice(0,5).join(', '); return words ? `<div class="xlate-alt">${pos?`<span class="xlate-pos">${esc(pos)}</span>`:''}<span>${esc(words)}</span></div>` : ''; }).join('');
    }
    el.innerHTML = withDict ? `<div class="xlate-main">${esc(translated || '(no translation)')}</div>${alts}` : esc(translated || '(no translation)');
  } catch (err) {
    el.innerHTML = `<span style="color:var(--text3)">Translation failed</span>`;
  }
}

async function addSentenceTranslation() {
  const panel = document.getElementById('xlate-panel'); if (!panel || panel.dataset.sentenceShown) return;
  const text = S.texts[ui.readerTextId]; const body = (text && text.body) || '';
  const ss = parseInt(panel.dataset.sentStart, 10), se = parseInt(panel.dataset.sentEnd, 10);
  if (isNaN(ss) || isNaN(se)) return;
  const sentText = body.slice(ss, se).replace(/\s+/g, ' ').trim();
  if (!sentText) return;
  // build sentence HTML with the selected word in bold
  const ws = parseInt(panel.dataset.selStart, 10), we = parseInt(panel.dataset.selEnd, 10);
  const rawSent = body.slice(ss, se);
  let sentHtml;
  if (!isNaN(ws) && !isNaN(we) && ws >= ss && we <= se && we > ws) {
    const rs = ws - ss, re = we - ss;
    sentHtml = esc(rawSent.slice(0, rs)) + '<b>' + esc(rawSent.slice(rs, re)) + '</b>' + esc(rawSent.slice(re));
  } else {
    sentHtml = esc(sentText);
  }
  panel.dataset.sentenceShown = '1';
  const sbtn = document.getElementById('xlate-sent-btn'); if (sbtn) sbtn.remove();
  const host = document.getElementById('xlate-sentence');
  if (!host) return;
  host.innerHTML = `
    <div class="xlate-head">
      <div class="xlate-sent-label">Sentence</div>
      <div class="xlate-acts">
        <button class="xlate-act" data-sact="add-sent" title="Save sentence">${icon('plus')}</button>
        <button class="xlate-act" data-sact="hl-sent" title="Highlight sentence">${icon('highlight')}</button>
      </div>
    </div>
    <div class="xlate-sent-src">${sentHtml}</div>
    <div class="xlate-sent-tr" id="xlate-sent-tr">Translating…</div>`;
  const sentRange = { start: ss, end: se };
  host.querySelector('[data-sact=add-sent]').onclick = () => { addReaderTerm(sentText, 'saved', sentRange); toastInApp('Saved sentence'); };
  host.querySelector('[data-sact=hl-sent]').onclick = (e) => openXlateColors(e.currentTarget, (color) => addReaderHighlight(sentText, color, sentRange));
  positionXlatePanel(panel);
  await translateInto('xlate-sent-tr', sentText, false);
  positionXlatePanel(panel);
}

const XLATE_SIZES = [ {w:300,f:13}, {w:340,f:15}, {w:380,f:18}, {w:430,f:22}, {w:480,f:28}, {w:540,f:34} ];
const XLATE_SIZE_LABELS = ['S','M','L','XL','2XL','3XL'];
// Place the panel below the selection if there's room, else above; clamp on-screen.
// A max-height + scroll is the safety net so it can never leak off the viewport.
function positionXlatePanel(panel) {
  const a = panel._anchorRect || { left: 100, top: 100, bottom: 120 };
  const M = 10, GAP = 8;
  const vw = window.innerWidth, vh = window.innerHeight;
  panel.style.maxHeight = (vh - 2 * M) + 'px';
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const belowSpace = vh - a.bottom - M - GAP;
  const aboveSpace = a.top - M - GAP;
  let top;
  if (ph <= belowSpace || belowSpace >= aboveSpace) top = a.bottom + GAP; // prefer below
  else top = a.top - ph - GAP;                                            // flip above
  top = Math.max(M, Math.min(top, vh - ph - M));
  const left = Math.max(M, Math.min(a.left, vw - pw - M));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

async function showInlineTranslation(term, anchorRect) {
  const existing = document.getElementById('xlate-panel'); if (existing) existing.remove();
  const text = S.texts[ui.readerTextId]; const body = (text && text.body) || '';
  const sr = findSelectionRange(body, term);
  const sentRange = sr ? sentenceRangeFor(body, sr.start, sr.end) : null;
  const norm = s => (s||'').replace(/\s+/g,' ').trim();
  const canSentence = !!(sentRange && norm(sentRange.text) !== norm(term));
  const panel = document.createElement('div');
  panel.id = 'xlate-panel';
  panel.className = 'xlate-panel';
  panel.dataset.term = term;
  if (sr) { panel.dataset.selStart = sr.start; panel.dataset.selEnd = sr.end; }
  if (sentRange) { panel.dataset.sentStart = sentRange.start; panel.dataset.sentEnd = sentRange.end; }
  panel.innerHTML = `
    <div class="xlate-head">
      <div class="xlate-term">${esc(term)}</div>
      <div class="xlate-acts">
        <button class="xlate-act" data-act="add-word" title="Save word">${icon('plus')}</button>
        <button class="xlate-act" data-act="hl-word" title="Highlight word">${icon('highlight')}</button>
      </div>
    </div>
    <div class="xlate-body" id="xlate-body">Translating…</div>
    <div class="xlate-sentence" id="xlate-sentence"></div>
    <div class="xlate-foot">
      <button class="xlate-ai" id="xlate-ai">✨ Ask AI</button>
      ${canSentence ? `<button class="xlate-sent-btn" id="xlate-sent-btn" title="Translate the whole sentence (press t again)">Full sentence (t)</button>` : ''}
    </div>`;
  const sz = XLATE_SIZES[Math.max(0, Math.min(XLATE_SIZES.length - 1, S.settings.reader.transSize == null ? 1 : S.settings.reader.transSize))];
  panel.style.width = sz.w + 'px';
  panel.style.fontSize = sz.f + 'px';
  panel._anchorRect = anchorRect;
  document.body.appendChild(panel);
  positionXlatePanel(panel);
  const wordRange = sr ? { start: sr.start, end: sr.end } : null;
  panel.querySelector('[data-act=add-word]').onclick = () => { addReaderTerm(term, 'saved', wordRange); toastInApp('Saved'); };
  panel.querySelector('[data-act=hl-word]').onclick = (e) => openXlateColors(e.currentTarget, (color) => addReaderHighlight(term, color, wordRange));
  document.getElementById('xlate-ai').onclick = () => openAskAI(term, panel);
  const sbtn = document.getElementById('xlate-sent-btn'); if (sbtn) sbtn.onclick = () => addSentenceTranslation();
  await translateInto('xlate-body', term, true);
  positionXlatePanel(panel);
  if (canSentence && S.settings.reader.transSentence) addSentenceTranslation();
}

// small 3-color popover (click to open, click a color to apply)
function openXlateColors(anchorBtn, onPick) {
  const old = document.getElementById('xlate-colors'); if (old) old.remove();
  const pop = document.createElement('div');
  pop.id = 'xlate-colors'; pop.className = 'xlate-colors';
  pop.innerHTML = HL_COLORS.map(c => `<button class="xc-swatch hl-ln-${c}" data-c="${c}" title="${c}"></button>`).join('');
  document.body.appendChild(pop);
  const r = anchorBtn.getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(r.left - 4, window.innerWidth - pop.offsetWidth - 6)) + 'px';
  pop.style.top = (r.bottom + 5) + 'px';
  pop.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { onPick(b.dataset.c); pop.remove(); });
  setTimeout(() => {
    const close = (e) => { if (!pop.contains(e.target) && e.target !== anchorBtn) { pop.remove(); document.removeEventListener('mousedown', close, true); } };
    document.addEventListener('mousedown', close, true);
  }, 0);
}

// Ask AI: the user's prompts + a neutral "Copy with context"
function openAskAI(term, panel) {
  const old = document.getElementById('xlate-ai-menu'); if (old) old.remove();
  const body = (S.texts[ui.readerTextId] || {}).body || '';
  const ss = parseInt(panel.dataset.selStart, 10), se = parseInt(panel.dataset.selEnd, 10);
  const idx = !isNaN(ss) ? ss : body.indexOf(term);
  const len = (!isNaN(se) && !isNaN(ss)) ? (se - ss) : term.length;
  const ctx = idx >= 0 ? makeContext(body, idx, len, 200) : term;
  const prompts = (S.prompts || []).slice(0, 3);
  const menu = document.createElement('div');
  menu.id = 'xlate-ai-menu'; menu.className = 'xlate-ai-menu';
  menu.innerHTML = `${prompts.map((p,i) => `<button class="ai-opt" data-p="${i}">${icon('listPlus')} ${esc(p.label)}</button>`).join('')}
    <button class="ai-opt" data-copy="1">${icon('plus')} Copy with context</button>`;
  document.body.appendChild(menu);
  const btn = document.getElementById('xlate-ai');
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)) + 'px';
  menu.style.top = Math.max(6, r.top - menu.offsetHeight - 6) + 'px';
  menu.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    const p = prompts[parseInt(b.dataset.p, 10)];
    copyText(buildPromptMessage(p.body, term, ctx)).then(ok => toastInApp(ok ? `Copied “${p.label}” prompt` : 'Copy failed'));
    menu.remove();
  });
  const cp = menu.querySelector('[data-copy]');
  if (cp) cp.onclick = () => { copyText(`${term}\n\nContext: ${ctx}`).then(ok => toastInApp(ok ? 'Copied with context' : 'Copy failed')); menu.remove(); };
  setTimeout(() => {
    const close = (e) => { if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('mousedown', close, true); } };
    document.addEventListener('mousedown', close, true);
  }, 0);
}

async function addReaderTerm(term, type, range) {
  const text = S.texts[ui.readerTextId];
  const tid = ui.readerTextId;
  const body = text.body || '';
  const sr = range || findSelectionRange(body, term);
  const idx = sr ? sr.start : -1;
  const end = sr ? sr.end : -1;
  const ctx = idx>=0 ? makeContext(body, idx, end-idx, 75) : '';
  if (idx >= 0) {
    text.marks = text.marks || [];
    text.marks.push({ type:'saved', start: idx, end, termId: null });
    text.updatedAt = Date.now(); text.lastActiveAt = Date.now();
    render();                                   // instant visual feedback
    await VocabStore.set({ texts: S.texts });   // persist mark first (survives the term refresh)
  }
  try {
    const res = await VocabStore.addTerm({ term, context: ctx, sourceUrl:'', sourceTitle: text.name });
    // A duplicate (same word already in the session) returns the EXISTING id, so the
    // mark still links to a real item instead of dangling unclickable. Older store
    // builds returned no id at all, so look it up ourselves as a fallback.
    let linkId = res && res.id;
    if (!linkId && res && res.reason === 'duplicate') {
      linkId = ((S.session && S.session.termIds) || [])
        .find(x => S.terms[x] && S.terms[x].term === term && !S.terms[x].deletedAt) || null;
    }
    if (idx >= 0 && linkId) {
      const t2 = S.texts[tid];
      const m = t2 && (t2.marks||[]).find(x => x.type==='saved' && x.start===idx && x.end===end && !x.termId);
      // The mark renders without a data-rterm until it has a termId, which left the
      // just-saved item unclickable. Re-render as soon as the id lands so its click
      // handler is wired straight away (render() preserves the reading scroll).
      if (m) { m.termId = linkId; render(); await VocabStore.set({ texts: S.texts }); }
      return linkId;
    }
  } catch (e) { console.warn('[vocab] save term failed', e); }
  return null;
}

// Remove a saved item from the reader (the "Unsave" action in the selection tooltip).
async function unsaveReaderTerm(termId) {
  const text = S.texts[ui.readerTextId];
  if (text) {
    text.marks = (text.marks||[]).filter(m => !(m.type==='saved' && m.termId===termId));
    text.updatedAt = Date.now(); text.lastActiveAt = Date.now();
  }
  ui.readerSel.delete(termId);
  render();                                    // instant: the chip goes back to plain text
  try {
    await VocabStore.set({ texts: S.texts });
    await VocabStore.removeTerms([termId]);    // to trash, same as removing from a list
  } catch (e) { console.warn('[vocab] unsave failed', e); }
}

// The saved term whose mark exactly matches a {start,end} range, if any.
function savedTermIdForRange(range) {
  if (!range) return null;
  const text = S.texts[ui.readerTextId];
  if (!text) return null;
  const m = (text.marks||[]).find(x => x.type==='saved' && x.termId && x.start===range.start && x.end===range.end);
  return m ? m.termId : null;
}

async function addReaderHighlight(term, color, range) {
  color = color || 'yellow';
  const text = S.texts[ui.readerTextId];
  const tid = ui.readerTextId;
  const body = text.body || '';
  const sr = range || findSelectionRange(body, term);
  if (!sr) return;
  const idx = sr.start;
  const end = sr.end;
  text.marks = text.marks || [];

  // existing exact-span highlight → just recolor (instant, then persist)
  const existing = text.marks.find(m => m.type==='hl' && m.start===idx && m.end===end);
  if (existing) {
    existing.color = color;
    text.updatedAt = Date.now(); text.lastActiveAt = Date.now();
    render();
    try {
      if (existing.highlightId && S.highlights[existing.highlightId]) await VocabStore.updateHighlight(existing.highlightId, { color });
      await VocabStore.set({ texts: S.texts });
    } catch (e) { console.warn('[vocab] highlight recolor failed', e); }
    return existing.highlightId || null;
  }

  // clear overlapping highlights + add the new one — optimistically
  const overlapping = text.marks.filter(m => m.type==='hl' && m.start < end && m.end > idx);
  const removeIds = overlapping.map(m => m.highlightId).filter(Boolean);
  text.marks = text.marks.filter(m => !(m.type==='hl' && m.start < end && m.end > idx));
  text.marks.push({ type:'hl', start: idx, end, color, highlightId: null });
  text.updatedAt = Date.now(); text.lastActiveAt = Date.now();
  render();                                     // instant visual
  try {
    if (removeIds.length) await VocabStore.removeHighlights(removeIds);
    await VocabStore.set({ texts: S.texts });   // persist mark first (survives the highlight refresh)
    const res = await VocabStore.addHighlight({ text: term, color, note:'', sourceUrl:'', sourceTitle: text.name });
    if (res && res.id) {
      const t2 = S.texts[tid];
      const m = t2 && (t2.marks||[]).find(x => x.type==='hl' && x.start===idx && x.end===end && !x.highlightId);
      // same as saved terms: no data-rhl until the id exists, so re-render to wire it up
      if (m) { m.highlightId = res.id; render(); await VocabStore.set({ texts: S.texts }); }
      return res.id;
    }
  } catch (e) { console.warn('[vocab] highlight failed', e); }
  return null;
}

// The highlight whose mark exactly matches a {start,end} range, if any.
function highlightIdForRange(range) {
  if (!range) return null;
  const text = S.texts[ui.readerTextId];
  if (!text) return null;
  const m = (text.marks||[]).find(x => x.type==='hl' && x.highlightId && x.start===range.start && x.end===range.end);
  return m ? m.highlightId : null;
}

// Remove a highlight from the reader (the un-highlight half of the toggle).
async function removeReaderHighlight(hlId) {
  const text = S.texts[ui.readerTextId];
  if (text) {
    text.marks = (text.marks||[]).filter(m => !(m.type==='hl' && m.highlightId===hlId));
    text.updatedAt = Date.now(); text.lastActiveAt = Date.now();
  }
  render();
  try {
    await VocabStore.set({ texts: S.texts });
    await VocabStore.removeHighlights([hlId]);
  } catch (e) { console.warn('[vocab] un-highlight failed', e); }
}

// Same key both ways: highlight the selection, or remove the highlight if it's
// already highlighted with this exact span.
async function toggleReaderHighlight(term, color) {
  const hid = highlightIdForRange(ui.lastSelRange);
  if (hid) { await removeReaderHighlight(hid); return null; }
  return await addReaderHighlight(term, color);
}

// Same key both ways: save the selection, or undo the save if it's already saved.
async function toggleReaderSave(term) {
  const id = savedTermIdForRange(ui.lastSelRange);
  if (id) { await unsaveReaderTerm(id); return null; }
  return await addReaderTerm(term, 'saved');
}

// Return the precise {start,end} of the current selection in the body, using the
// captured DOM range, which maps word spans to exact body offsets.
function findSelectionRange(body, term) {
  const r = ui.lastSelRange;
  // The DOM anchor is authoritative. The old code cross-checked it against the
  // selection's text and bailed on a mismatch — but a selection crossing a saved chip
  // comes back with line breaks injected around it (chips are inline-block), so that
  // check failed and saving/highlighting across a chip silently did nothing.
  if (r && r.start >= 0 && r.end <= body.length && r.end > r.start) return { start: r.start, end: r.end };
  const norm = (term || '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  const idx = body.indexOf(term);
  if (idx >= 0) return { start: idx, end: idx + term.length };
  // whitespace-tolerant search, so injected line breaks can't defeat the fallback
  const rx = new RegExp(norm.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const mm = body.match(rx);
  return mm ? { start: mm.index, end: mm.index + mm[0].length } : null;
}
function findSelectionIndex(body, term) {
  const r = findSelectionRange(body, term);
  return r ? r.start : -1;
}
function makeContext(body, idx, len, chars) {
  const s=Math.max(0,idx-chars), e=Math.min(body.length, idx+len+chars);
  let ctx=body.slice(s,e).replace(/\s+/g,' ').trim();
  if(s>0)ctx='…'+ctx; if(e<body.length)ctx+='…'; return ctx;
}

// ── Feature A: clipboard prompt templates ──
// Build the filled message for a given prompt + the current reader selection.
function buildPromptMessage(promptBody, term, contextText) {
  return `The following text — "${term}" — was selected by me, and here is some of the surrounding context around it:\n\n"${contextText}"\n\n${promptBody}`;
}

// Trigger prompt N (1-based) on the current selection in the reader.
function triggerPrompt(index) {
  const prompts = S.prompts || [];
  const p = prompts[index];
  if (!p) { toastInApp('No prompt set for that key'); return; }
  const sel = window.getSelection();
  const term = (sel && !sel.isCollapsed) ? sel.toString().trim() : '';
  if (!term) { toastInApp('Select text first'); return; }
  const text = S.texts[ui.readerTextId];
  const body = (text && text.body) || '';
  const sr = findSelectionRange(body, term);
  const idx = sr ? sr.start : body.indexOf(term);
  const len = sr ? (sr.end - sr.start) : term.length;
  const ctx = idx >= 0 ? makeContext(body, idx, len, 200) : term;
  const msg = buildPromptMessage(p.body, term, ctx);
  copyText(msg).then(ok => toastInApp(ok ? `Copied “${p.label}” prompt — paste into your chat` : 'Copy failed'));
}

// ── prompt manager modal ──
function openPromptsModal() {
  const prompts = S.prompts || [];
  const m = showModal(`
    <h3>Prompt templates</h3>
    <p>Select text in the reader, then press number keys <span class="kbd">1</span>–<span class="kbd">9</span> to copy a filled prompt to your clipboard.</p>
    <div class="modal-list" id="prompt-list" style="max-height:300px">
      ${prompts.map((p,i) => `
        <div class="prompt-row" data-i="${i}">
          <span class="prompt-key">${i+1}</span>
          <input class="prompt-label" data-i="${i}" value="${esc(p.label)}" placeholder="Label">
          <button class="prompt-del" data-del="${i}" title="Delete">${icon('trash')}</button>
          <textarea class="prompt-body" data-i="${i}" placeholder="Prompt text…" rows="2">${esc(p.body)}</textarea>
        </div>`).join('')}
    </div>
    <div class="modal-btns"><button class="btn" id="m-cancel">Close</button><button class="btn green" id="m-add">+ Add prompt</button></div>`);

  const save = async () => {
    const rows = m.querySelectorAll('.prompt-row');
    const next = [];
    rows.forEach((row,i) => {
      const label = row.querySelector('.prompt-label').value.trim() || ('Prompt '+(i+1));
      const body = row.querySelector('.prompt-body').value.trim();
      next.push({ id: prompts[i]?.id || VocabStore.uid('p_'), label, body });
    });
    S.prompts = next;
    await VocabStore.set({ prompts: next });
  };
  m.querySelectorAll('.prompt-label, .prompt-body').forEach(el => el.onblur = save);
  m.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await save();
    S.prompts.splice(parseInt(b.dataset.del,10),1);
    await VocabStore.set({ prompts: S.prompts });
    closeModal(); openPromptsModal();
  });
  m.querySelector('#m-add').onclick = async () => {
    await save();
    S.prompts.push({ id: VocabStore.uid('p_'), label: 'New prompt', body: '' });
    await VocabStore.set({ prompts: S.prompts });
    closeModal(); openPromptsModal();
  };
  m.querySelector('#m-cancel').onclick = async () => { await save(); closeModal(); };
}

function trackEngagement() {
  clearInterval(readerEngageTimer);
  readerEngageTimer = setInterval(() => {
    if (document.hidden) return;
    if (ui.view!=='reader') return;
    if (ui.readerTextId && S.texts[ui.readerTextId]) {
      S.texts[ui.readerTextId].engagedMs = (S.texts[ui.readerTextId].engagedMs||0) + 1000;
      S.texts[ui.readerTextId].lastActiveAt = Date.now();
      if ((S.texts[ui.readerTextId].engagedMs % 5000) === 0) VocabStore.set({ texts: S.texts });
    }
  }, 1000);
}

// ════════════════════════════════════════════════════════════════════
//  SPEECH (TTS) with voice picker + smooth follow highlight
// ════════════════════════════════════════════════════════════════════
let speaking = false, paused = false, utterance = null;
let voicesCache = [];
let speakCharOffset = 0; // where in body the current utterance started

function loadVoices() {
  const all = speechSynthesis.getVoices() || [];
  // Remote voices (Google's network voices, marked localService=false) generally
  // don't play inside extension pages, so only keep local ones.
  voicesCache = all.filter(v => v.localService !== false);
  if (!voicesCache.length) voicesCache = all; // fallback if the flag is unreliable
}
loadVoices();
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => { loadVoices(); const sel=document.getElementById('r-voice')||document.getElementById('mode-voice'); if(sel){ sel.innerHTML=voiceOptionsHtml(); } };
  // Chrome sometimes needs a few polls before voices populate
  let tries = 0;
  const poll = setInterval(() => {
    loadVoices(); tries++;
    if (voicesCache.length) { const sel=document.getElementById('r-voice')||document.getElementById('mode-voice'); if(sel) sel.innerHTML=voiceOptionsHtml(); }
    if (voicesCache.length || tries > 20) clearInterval(poll);
  }, 250);
}

function langPrefix() {
  const l = S.settings.reader.lang;
  return (l && l!=='auto') ? l.slice(0,2) : null;
}

function voiceOptionsHtml() {
  if (!voicesCache.length) loadVoices();
  const pref = langPrefix();
  // sort: matching-language first, Google voices first within that
  const sorted = voicesCache.slice().sort((a,b) => {
    const am = pref && a.lang.toLowerCase().startsWith(pref) ? 0 : 1;
    const bm = pref && b.lang.toLowerCase().startsWith(pref) ? 0 : 1;
    if (am!==bm) return am-bm;
    const ag = /google/i.test(a.name)?0:1, bg=/google/i.test(b.name)?0:1;
    if (ag!==bg) return ag-bg;
    return a.name.localeCompare(b.name);
  });
  const chosen = S.settings.reader.voiceURI;
  if (!sorted.length) return `<option value="">(default voice)</option>`;
  return sorted.map(v => `<option value="${esc(v.voiceURI)}" ${chosen===v.voiceURI?'selected':''}>${esc(v.name)} — ${esc(v.lang)}</option>`).join('');
}

function pickVoice() {
  const chosen = S.settings.reader.voiceURI;
  if (chosen) { const v = voicesCache.find(v=>v.voiceURI===chosen); if (v) return v; }
  // default: best match for language, preferring Google
  const pref = langPrefix();
  if (pref) {
    const matches = voicesCache.filter(v=>v.lang.toLowerCase().startsWith(pref));
    const g = matches.find(v=>/google/i.test(v.name));
    if (g) return g; if (matches[0]) return matches[0];
  }
  return voicesCache.find(v=>/google/i.test(v.name)) || voicesCache[0] || null;
}

function toggleSpeak() {
  const text = S.texts[ui.readerTextId];
  if (!text || !text.body.trim()) return;
  if (speaking && !paused) {
    // pause
    try { speechSynthesis.pause(); } catch {}
    paused = true; render();
  } else if (speaking && paused) {
    // resume
    try { speechSynthesis.resume(); } catch {}
    paused = false; render();
  } else {
    startSpeakFrom(0);
  }
}

function startSpeakFrom(charIdx) {
  const text = S.texts[ui.readerTextId];
  if (!text || !text.body.trim()) return;
  if (ui.readerEditing) { saveReaderBody(); ui.readerEditing=false; render(); }
  const body = text.body;
  speakCharOffset = Math.max(0, Math.min(charIdx, Math.max(0, body.length-1)));
  while (speakCharOffset>0 && !/\s/.test(body[speakCharOffset-1])) speakCharOffset--;
  const chunk = body.slice(speakCharOffset);
  if (!chunk.trim()) return;

  // hard stop anything in progress
  try { speechSynthesis.cancel(); } catch {}

  // build utterance now; speak after a short beat (Chrome cancel/speak quirk)
  const u = new SpeechSynthesisUtterance(chunk);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  else if (langPrefix()) { u.lang = S.settings.reader.lang; }
  u.rate = 0.95;
  u.onstart = () => { speaking = true; paused = false; updateSpeakButton(); };
  u.onboundary = (ev) => {
    if (ev.charIndex == null) return;
    const doHl = S.settings.reader.readHighlight !== false;
    const doFollow = S.settings.reader.readFollow !== false;
    if (doHl || doFollow) highlightFollow(speakCharOffset + ev.charIndex, doHl, doFollow);
  };
  u.onend = () => { speaking=false; paused=false; clearFollow(); updateSpeakButton(); };
  u.onerror = (e) => { console.warn('TTS error', e && e.error); speaking=false; paused=false; clearFollow(); updateSpeakButton(); };
  utterance = u;

  speaking = true; paused = false;   // optimistic; onstart confirms
  updateSpeakButton();
  setTimeout(() => { try { speechSynthesis.speak(u); } catch (err) { console.warn('speak failed', err); speaking=false; updateSpeakButton(); } }, 70);
}

// update just the play/pause button label without a full re-render (keeps word spans intact)
function updateSpeakButton() {
  const btn = document.getElementById('r-speak');
  if (btn) btn.innerHTML = `${icon(speaking&&!paused?'pause':'play')} ${speaking&&!paused?'Pause':'Read aloud'}`;
  const pf = document.getElementById('r-playfloat');
  if (pf) pf.innerHTML = `${icon(paused?'play':'pause')} ${paused?'Resume':'Pause'}`;
  if (typeof renderModePanel === 'function') renderModePanel();
}

// Chrome occasionally drops onend; keep our state in sync with the engine.
setInterval(() => {
  if (speaking && !paused && typeof speechSynthesis !== 'undefined' && !speechSynthesis.speaking && !speechSynthesis.pending) {
    speaking = false; paused = false; clearFollow(); updateSpeakButton();
  }
}, 500);

function stopSpeak() {
  try { speechSynthesis.cancel(); } catch {}
  speaking = false; paused = false; clearFollow();
}

// ── reader hotkeys (full tab only; safe to use normal key listeners here) ──
// ── remappable reader hotkeys ──
const HOTKEY_ACTIONS = [
  { id:'play',        label:'Play / pause',              def:' ' },
  { id:'skipPrev',    label:'Previous snippet (video)',  def:',' },
  { id:'skipNext',    label:'Next snippet (video)',      def:'.' },
  { id:'playFromSel', label:'Play from selection (video)', def:'' },
  { id:'followToggle',label:'Toggle follow',             def:'g' },
  { id:'saveTerm',    label:'Save selection',            def:'s' },
  { id:'highlight',  label:'Highlight selection',      def:'d' },
  { id:'translate',  label:'Translate selection',      def:'t' },
  { id:'sizeUp',     label:'Bigger text',              def:'+' },
  { id:'sizeDown',   label:'Smaller text',             def:'-' },
  { id:'fullscreen', label:'Full screen',              def:'f' },
];
function hotkey(id) { const o = (S.settings && S.settings.hotkeys) || {}; const a = HOTKEY_ACTIONS.find(x=>x.id===id); return o[id] != null ? o[id] : (a ? a.def : ''); }
function hotkeyMap() { const m = {}; for (const a of HOTKEY_ACTIONS) { const k = hotkey(a.id); if (k) m[(''+k).toLowerCase()] = a.id; } return m; }
function keyDisplay(k) { if (k === ' ') return 'Space'; if (!k) return '—'; return (''+k).length === 1 ? (''+k).toUpperCase() : k; }

// jump the video between transcript snippets
function skipSegment(dir) {
  const text = S.texts[ui.readerTextId];
  if (!text || !text.videoId || !ytPlayer || !ytPlayer.getCurrentTime) return;
  const segs = text.segments || []; if (!segs.length) return;
  let t; try { t = ytPlayer.getCurrentTime(); } catch { return; }
  let i = 0;
  for (let k = 0; k < segs.length; k++) { if (segs[k].start <= t + 0.25) i = k; else break; }
  let target = dir < 0 ? ((t - segs[i].start > 0.8) ? i : i - 1) : i + 1;
  target = Math.max(0, Math.min(segs.length - 1, target));
  try { ytPlayer.seekTo(segs[target].start, true); ytPlayer.playVideo(); } catch {}
  setTimeout(renderModePanel, 120);
}

function runHotkey(action, selText) {
  switch (action) {
    case 'play': modeTogglePlay(); break;
    case 'fullscreen': { const c = !(ui.readerBarCollapsed && ui.navCollapsed); ui.readerBarCollapsed = c; ui.navCollapsed = c; render(); } break;
    case 'skipPrev': skipSegment(-1); break;
    case 'skipNext': skipSegment(1); break;
    case 'followToggle': {
      const text = S.texts[ui.readerTextId]; const mode = readerModeFor(text);
      if (mode === 'youtube') ui.readerVideoFollow = (ui.readerVideoFollow === false);
      else { S.settings.reader.readFollow = (S.settings.reader.readFollow === false); VocabStore.set({ settings: S.settings }); }
      if (modeFollowOn(mode) && typeof hideFollowBtn === 'function') hideFollowBtn();
      renderModePanel();
    } break;
    case 'playFromSel': {
      const sel = window.getSelection();
      if (sel && sel.anchorNode) {
        const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        const w = el && el.closest ? el.closest('.w') : null;
        if (w) { const c = parseInt(w.dataset.c, 10); if (!isNaN(c)) modePlayFrom(c); }
      }
    } break;
    case 'translate': {
      const term = selText();
      if (!term) break;
      const panel = document.getElementById('xlate-panel');
      if (panel && panel.dataset.term === term) {
        if (!panel.dataset.sentenceShown) addSentenceTranslation(); // 2nd t → full sentence
      } else {
        const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
        showInlineTranslation(term, rect);
      }
    } break;
    // After a save/highlight the reader re-renders, which clears the text selection —
    // so fall back to whatever the open tooltip is pointed at, letting the same key undo.
    case 'saveTerm': { const term = selText() || (ttEl ? _ttTerm : ''); if (term) { toggleReaderSave(term).then(id => reopenTT(id, undefined)); } } break;
    case 'highlight': { const term = selText() || (ttEl ? _ttTerm : ''); if (term) { toggleReaderHighlight(term, S.settings.reader.lastColor || 'yellow').then(id => reopenTT(_ttSavedId, id)); } } break;
    case 'sizeUp': S.settings.reader.size = Math.min(SIZES.length - 1, S.settings.reader.size + 1); VocabStore.set({ settings: S.settings }); applyReaderSize(); break;
    case 'sizeDown': S.settings.reader.size = Math.max(0, S.settings.reader.size - 1); VocabStore.set({ settings: S.settings }); applyReaderSize(); break;
  }
}

function renderHotkeysList() {
  const list = document.getElementById('hk-list'); if (!list) return;
  list.innerHTML = HOTKEY_ACTIONS.map(a => `<div class="hk-row"><span class="hk-label">${a.label}</span><button class="hk-key" data-hk="${a.id}">${keyDisplay(hotkey(a.id))}</button></div>`).join('');
  list.querySelectorAll('[data-hk]').forEach(btn => btn.onclick = () => {
    list.querySelectorAll('.hk-key').forEach(b => b.classList.remove('listening'));
    btn.textContent = 'press…'; btn.classList.add('listening');
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      document.removeEventListener('keydown', onKey, true);
      if (e.key === 'Escape' || (e.key >= '1' && e.key <= '9')) { renderHotkeysList(); return; } // cancel / reserved
      const k = e.key === ' ' ? ' ' : e.key.toLowerCase();
      const id = btn.dataset.hk;
      S.settings.hotkeys = S.settings.hotkeys || {};
      for (const a of HOTKEY_ACTIONS) { if (a.id !== id && hotkey(a.id) === k) S.settings.hotkeys[a.id] = ''; } // free conflict
      S.settings.hotkeys[id] = k;
      VocabStore.set({ settings: S.settings });
      renderHotkeysList();
    };
    document.addEventListener('keydown', onKey, true);
  });
}
// ── translation settings ──
const TRANS_LANGS = [
  ['en','English'],['de','German'],['es','Spanish'],['fr','French'],['it','Italian'],
  ['pt','Portuguese'],['nl','Dutch'],['ru','Russian'],['zh-CN','Chinese'],['ja','Japanese'],
  ['ko','Korean'],['ar','Arabic'],['he','Hebrew'],['tr','Turkish'],['pl','Polish'],['sv','Swedish'],['uk','Ukrainian']
];
function openTransModal() {
  const st = S.settings.reader;
  const target = st.transTarget || 'en';
  const source = st.lang || 'auto';
  const opt = (code, name, sel) => `<option value="${code}" ${sel===code?'selected':''}>${name}</option>`;
  showModal(`<div class="modal-title">Translation</div>
    <div class="trs-row"><span>Translate into</span><select id="trs-target">${TRANS_LANGS.map(l=>opt(l[0],l[1],target)).join('')}</select></div>
    <div class="trs-row"><span>Source language</span><select id="trs-source"><option value="auto" ${source==='auto'?'selected':''}>Auto-detect</option>${TRANS_LANGS.map(l=>opt(l[0],l[1],source)).join('')}</select></div>
    <div class="trs-row"><span>Text size</span><span class="trs-size"><button class="rc-btn" id="trs-sz-down">A−</button><span id="trs-sz-lbl">${XLATE_SIZE_LABELS[st.transSize==null?1:st.transSize]}</span><button class="rc-btn" id="trs-sz-up">A+</button></span></div>
    <div class="trs-row"><span>Also translate the full sentence</span><button class="rc-btn ${st.transSentence?'on':''}" id="trs-sent">${st.transSentence?'On':'Off'}</button></div>
    <div class="hk-note">Powered by Google Translate. Single words also show dictionary alternatives (parts of speech &amp; other meanings).</div>
    <div class="modal-actions"><button class="btn green" id="trs-done">Done</button></div>`);
  document.getElementById('trs-target').onchange = (e) => { S.settings.reader.transTarget = e.target.value; VocabStore.set({ settings: S.settings }); };
  document.getElementById('trs-source').onchange = (e) => { S.settings.reader.lang = e.target.value; VocabStore.set({ settings: S.settings }); };
  const applyTransSize = () => {
    const s = Math.max(0, Math.min(XLATE_SIZES.length - 1, S.settings.reader.transSize == null ? 1 : S.settings.reader.transSize));
    S.settings.reader.transSize = s;
    const lbl = document.getElementById('trs-sz-lbl'); if (lbl) lbl.textContent = XLATE_SIZE_LABELS[s];
    VocabStore.set({ settings: S.settings });
    const p = document.getElementById('xlate-panel');
    if (p) { p.style.width = XLATE_SIZES[s].w+'px'; p.style.fontSize = XLATE_SIZES[s].f+'px'; positionXlatePanel(p); }
  };
  document.getElementById('trs-sz-down').onclick = () => { S.settings.reader.transSize = Math.max(0, (S.settings.reader.transSize == null ? 1 : S.settings.reader.transSize) - 1); applyTransSize(); };
  document.getElementById('trs-sz-up').onclick = () => { S.settings.reader.transSize = Math.min(XLATE_SIZES.length - 1, (S.settings.reader.transSize == null ? 1 : S.settings.reader.transSize) + 1); applyTransSize(); };
  const stog = document.getElementById('trs-sent');
  if (stog) stog.onclick = () => { S.settings.reader.transSentence = !S.settings.reader.transSentence; stog.classList.toggle('on', !!S.settings.reader.transSentence); stog.textContent = S.settings.reader.transSentence ? 'On' : 'Off'; VocabStore.set({ settings: S.settings }); };
  document.getElementById('trs-done').onclick = closeModal;
}

function openHotkeysModal() {
  showModal(`<div class="modal-title">Keyboard shortcuts</div>
    <div class="hk-list" id="hk-list"></div>
    <div class="hk-note">Click a key, then press the new one. <b>Esc</b> and <b>1–9</b> (prompts) are reserved. Assigning a key that's already used frees it from its old action.</div>
    <div class="modal-actions"><button class="btn" id="hk-reset">Reset defaults</button><button class="btn green" id="hk-done">Done</button></div>`);
  renderHotkeysList();
  document.getElementById('hk-reset').onclick = () => { S.settings.hotkeys = {}; VocabStore.set({ settings: S.settings }); renderHotkeysList(); };
  document.getElementById('hk-done').onclick = closeModal;
}

document.addEventListener('keydown', (e) => {
  if (IS_SIDEBAR) return;

  // Ctrl/Cmd+D → duplicate the current list/text (or selected library tile)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    const tag = (e.target.tagName||'').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (ui.view === 'library' && ui.libSelected.size === 1) {
      const [type,id] = [...ui.libSelected][0].split(':');
      e.preventDefault(); itemDuplicate(type, id); return;
    }
    if (ui.view.startsWith('list:')) { e.preventDefault(); itemDuplicate('list', ui.view.slice(5)); return; }
    if (ui.view === 'reader' && ui.readerTextId) { e.preventDefault(); itemDuplicate('text', ui.readerTextId); return; }
  }

  // Library: Delete/Backspace removes selected tiles (with confirmation)
  if (ui.view === 'library' && (e.key === 'Delete' || e.key === 'Backspace')) {
    const tag = (e.target.tagName||'').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (ui.libSelected.size) { e.preventDefault(); confirmDeleteLibItems([...ui.libSelected]); }
    return;
  }

  // List views: Escape clears the row selection (asks first if 7+ are selected)
  if (e.key === 'Escape' && ui.selected.size &&
      (ui.view === 'session' || ui.view === 'allterms' ||
       ui.view.startsWith('list:') || ui.view.startsWith('hllist:'))) {
    const tag = (e.target.tagName||'').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (ui.selected.size >= DESELECT_GUARD) {
      showListDeselectConfirm(null, ui.selected.size, () => { ui.selected.clear(); refreshRowSelectionDOM(); });
    } else { ui.selected.clear(); refreshRowSelectionDOM(); }
    return;
  }

  if (ui.view !== 'reader') return;
  // don't hijack typing in inputs/textareas
  const tag = (e.target.tagName||'').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

  // helper: act on the current text selection within the reader render
  const selText = () => { const s = window.getSelection(); return (s && !s.isCollapsed) ? s.toString().trim() : ''; };

  if (e.key === 'Escape') {
    if (ui.readerBarCollapsed || ui.navCollapsed) { ui.readerBarCollapsed=false; ui.navCollapsed=false; render(); }
    return;
  }
  if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // number keys: trigger prompt template on current selection (reserved)
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) { e.preventDefault(); triggerPrompt(parseInt(e.key,10) - 1); }
    return;
  }
  const map = hotkeyMap();
  let key = e.key === ' ' ? ' ' : e.key.toLowerCase();
  if (e.key === '=' && !map['='] && map['+']) key = '+'; // '=' doubles for '+'
  const action = map[key];
  if (action) { e.preventDefault(); runHotkey(action, selText); }
});

// ── smooth 3-word follow highlight with fade on each side ──
let followWords = [];
function highlightFollow(absChar, doHighlight = true, doScroll = true) {
  const container = document.getElementById('r-render');
  if (!container) return;
  if (!followWords.length || followWords._dirty) {
    followWords = Array.from(container.querySelectorAll('.w')).map(el => ({ el, c: parseInt(el.dataset.c,10) }));
  }
  // find the word whose char range contains absChar (closest not exceeding)
  let idx = 0;
  for (let i=0;i<followWords.length;i++){ if (followWords[i].c <= absChar) idx=i; else break; }
  clearFollow();
  if (doHighlight) {
    // center word idx, with falloff ±2
    for (let d=-2; d<=2; d++) {
      const w = followWords[idx+d];
      if (!w) continue;
      const cls = d===0 ? 'rd-center' : (Math.abs(d)===1 ? 'rd-near' : 'rd-far');
      w.el.classList.add('rd', cls);
    }
  }
  if (doScroll) {
    const c = followWords[idx];
    if (c) { const r = c.el.getBoundingClientRect(); const sc = document.querySelector('.reader-scroll'); if (sc) { const scR = sc.getBoundingClientRect(); if (r.top < scR.top+60 || r.bottom > scR.bottom-60) c.el.scrollIntoView({block:'center', behavior:'smooth'}); } }
  }
}
function clearFollow() {
  document.querySelectorAll('.w.rd').forEach(el => el.classList.remove('rd','rd-center','rd-near','rd-far'));
}



boot();
