// store-supabase.js — a drop-in replacement for the extension's store.js that
// reads/writes Supabase instead of chrome.storage. It exposes the IDENTICAL
// VocabStore API and the IDENTICAL {terms, highlights, lists, highlightLists,
// folders, texts, ...} data shapes, so app.js runs completely unchanged.
//
// The only swapped pieces are the two lowest-level primitives:
//   getAll()/get()  → load the whole library from Supabase (cached in memory)
//   set()           → persist the changed slices back to Supabase
// Every higher-level method (addTerm, createList, assignTermsToList, …) is the
// extension's original code, untouched, because it only ever spoke to get/set.
//
// Call VocabStore.init(supabaseClient, userId) after sign-in, before app.js boots.

// ── minimal `chrome` stub so app.js's 3 extension calls are harmless ──────────
// app.js re-renders by reacting to chrome.storage.onChanged; our set() fires it.
(function () {
  // The store owns its own change dispatcher, exposed as window.__vocabOnChange for
  // subscribers (app.js) and window.__vocabFire for the store to emit. This is
  // deliberately independent of chrome.storage.onChanged: on a real extension page that
  // is a read-only host accessor we can't replace, so routing through it would strand
  // app.js on a bus nothing writes to (the "needs a refresh" bug). Our own hook works
  // identically on the website and in the sidebar.
  const listeners = [];
  window.__vocabOnChange = (fn) => { if (typeof fn === 'function') listeners.push(fn); };
  window.__vocabFire = (changes) => { for (const fn of listeners) { try { fn(changes); } catch (e) { console.error(e); } } };

  // Keep a minimal chrome stub for the website (no extension APIs there). In the
  // extension the real chrome already exists; we leave it untouched.
  window.chrome = window.chrome || {};
  window.chrome.storage = window.chrome.storage || {};
  if (!window.chrome.storage.onChanged) window.chrome.storage.onChanged = { addListener() {} };
  window.chrome.runtime = window.chrome.runtime || { sendMessage() {}, lastError: undefined };
})();

const VocabStore = (() => {
  const DEFAULTS = {
    terms: {}, highlights: {}, lists: {}, highlightLists: {}, folders: {}, texts: {},
    session: { startedAt: Date.now(), termIds: [], highlightIds: [] },
    activity: [],
    prompts: [
      { id: "p1", label: "Explain", body: "Explain the meaning and usage of the selected text. If it's an idiom or expression, explain its figurative sense and give an example." },
      { id: "p2", label: "Grammar", body: "Break down the grammar of the selected text: parts of speech, cases/conjugations, and why it's structured this way." },
      { id: "p3", label: "Translate + nuance", body: "Translate the selected text and explain any nuance, tone, or connotation that a literal translation would miss." }
    ],
    settings: { reader: { size: 2, theme: "white", lang: "auto", width: 60, readHighlight: true, lastColor: "yellow" }, web: { showOnPage: true, barEnabled: true } }
  };

  let SB = null, UID = null, MEM = null, _collExt = new Map();
  async function init(sb, uid) { SB = sb; UID = uid; MEM = null; }

  const clone = o => JSON.parse(JSON.stringify(o));
  const iso = ms => (ms && isFinite(+ms)) ? new Date(+ms).toISOString() : new Date().toISOString();
  const msOf = s => s ? Date.parse(s) : undefined;

  async function detUuid(key) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const b = new Uint8Array(buf).slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }
  const _idCache = new Map();
  async function rowId(extId) { if (!_idCache.has(extId)) _idCache.set(extId, await detUuid(UID + '|' + extId)); return _idCache.get(extId); }

  function fireChange(changes) {
    // Use our own dispatcher (set up in the chrome stub above); it's the same list app.js
    // registers on, and it works identically on the website and in the extension sidebar.
    if (window.__vocabFire) { window.__vocabFire(changes); return; }
    const ls = (window.chrome.storage.onChanged._listeners) || [];
    for (const fn of ls) { try { fn(changes); } catch (e) { console.error(e); } }
  }

  // ── LOAD: Supabase → snapshot ───────────────────────────────────────────────
  async function loadFromSupabase() {
    const _t0 = performance.now();
    const [it, hl, co, ci, se] = await Promise.all([
      SB.from('items').select('*').limit(100000),
      SB.from('highlights').select('*').limit(100000),
      SB.from('collections').select('*').limit(100000),
      SB.from('collection_items').select('*').limit(100000),
      SB.from('settings').select('data').maybeSingle()
    ]);
    console.log('[vocab] supabase fetch:', Math.round(performance.now() - _t0) + 'ms');
    const bad = [it, hl, co, ci].find(r => r.error);
    if (bad) throw new Error('load failed: ' + bad.error.message);

    const items = it.data || [], hls = hl.data || [], colls = co.data || [], cis = ci.data || [];
    const itemExt = new Map(), collExt = new Map(), hlExt = new Map();
    items.forEach(r => { if (r.ext_id) itemExt.set(r.id, r.ext_id); });
    colls.forEach(r => { if (r.ext_id) collExt.set(r.id, r.ext_id); });
    hls.forEach(r => { if (r.ext_id) hlExt.set(r.id, r.ext_id); });

    const itemLists = {}, hlLists = {};
    cis.forEach(m => {
      const l = collExt.get(m.collection_id); if (!l) return;
      if (m.item_id) { const e = itemExt.get(m.item_id); if (e) (itemLists[e] = itemLists[e] || []).push(l); }
      else if (m.highlight_id) { const e = hlExt.get(m.highlight_id); if (e) (hlLists[e] = hlLists[e] || []).push(l); }
    });

    const terms = {};
    items.forEach(r => {
      if (!r.ext_id) return;                      // skip rows with no extension id (legacy web-only)
      const id = r.ext_id;
      const t = {
        id, term: r.surface || '', context: r.context || '', note: r.note || '',
        translation: r.translation || '', sourceUrl: r.source_url || '', sourceTitle: r.source_title || '',
        createdAt: msOf(r.created_at) || Date.now(), listIds: itemLists[id] || []
      };
      if (r.master_id && itemExt.get(r.master_id)) { t.masterId = itemExt.get(r.master_id); t.divorced = !!r.divorced; }
      if (r.is_disjoint) t.isDisjoint = true;
      if (r.item_type) t.itemType = r.item_type;
      if (r.language_pair) t.languagePair = r.language_pair;
      if (Array.isArray(r.tags) && r.tags.length) t.tags = r.tags;
      if (r.deleted_at) t.deletedAt = msOf(r.deleted_at);
      if (r.trash_batch) t.trashBatch = r.trash_batch;
      terms[id] = t;
    });

    const highlights = {};
    hls.forEach(r => {
      if (!r.ext_id) return;
      const id = r.ext_id;
      const h = {
        id, text: r.text || '', color: r.color || 'yellow', note: r.note || '',
        sourceUrl: r.source_url || '', sourceTitle: r.source_title || '',
        createdAt: msOf(r.created_at) || Date.now(), listIds: hlLists[id] || []
      };
      if (r.master_id && hlExt.get(r.master_id)) { h.masterId = hlExt.get(r.master_id); h.divorced = !!r.divorced; }
      if (r.deleted_at) h.deletedAt = msOf(r.deleted_at);
      if (r.trash_batch) h.trashBatch = r.trash_batch;
      highlights[id] = h;
    });

    const lists = {}, highlightLists = {}, folders = {};
    colls.forEach(r => {
      if (!r.ext_id) return;
      const id = r.ext_id;
      const parent = r.parent_id ? collExt.get(r.parent_id) : null;
      const common = { id, name: r.name || '', createdAt: msOf(r.created_at) || Date.now(), updatedAt: msOf(r.updated_at) || Date.now() };
      if (r.deleted_at) common.deletedAt = msOf(r.deleted_at);
      if (r.kind === 'list') lists[id] = { ...common, folderId: parent || null };
      else if (r.kind === 'highlight_list') highlightLists[id] = { ...common, folderId: parent || null };
      else if (r.kind === 'folder') { folders[id] = { id, name: r.name || '', parentId: parent || null, createdAt: common.createdAt }; if (r.deleted_at) folders[id].deletedAt = msOf(r.deleted_at); }
    });

    _collExt = collExt;          // phase 2 (sources) needs this to resolve folder_id
    const texts = {};            // sources stream in via hydrateSources() after first paint

    const sdata = (se.data && se.data.data) || {};
    const savedSession = sdata.session;
    MEM = {
      terms, highlights, lists, highlightLists, folders, texts,
      // restore the session the user left off with; only fall back to a fresh one
      // if nothing was ever saved
      session: (savedSession && Array.isArray(savedSession.termIds))
        ? { startedAt: savedSession.startedAt || Date.now(),
            termIds: savedSession.termIds,
            highlightIds: Array.isArray(savedSession.highlightIds) ? savedSession.highlightIds : [] }
        : clone(DEFAULTS.session),
      activity: [],
      prompts: Array.isArray(sdata.prompts) ? sdata.prompts : clone(DEFAULTS.prompts),
      settings: {
        reader: { ...DEFAULTS.settings.reader, ...(sdata.reader || {}) },
        web: { ...DEFAULTS.settings.web, ...(sdata.web || {}) }
      }
    };
    console.log('[vocab] load total:', Math.round(performance.now() - _t0) + 'ms',
      '| items', items.length, 'highlights', hls.length, 'collections', colls.length);
    hydrateSources();   // pull sources (text/transcript bodies) in the background
  }

  // Phase 2: fetch sources with the proven select('*'), build texts, merge in, re-render.
  async function hydrateSources() {
    try {
      const _t = performance.now();
      const { data, error } = await SB.from('sources').select('*').limit(100000);
      if (error) { console.error('[vocab] sources load failed:', error.message); return; }
      if (!data || !MEM) return;
      const texts = {};
      for (const r of data) {
        if (!r.ext_id) continue;
        const id = r.ext_id;
        const x = {
          id, name: r.title || 'Untitled', body: r.body || '', marks: Array.isArray(r.marks) ? r.marks : [],
          folderId: r.folder_id ? (_collExt.get(r.folder_id) || null) : null,
          sourceUrl: r.url || '', sourceTitle: r.title || '',
          createdAt: msOf(r.created_at) || Date.now(), updatedAt: msOf(r.updated_at) || Date.now(),
          lastActiveAt: msOf(r.last_active_at) || Date.now(), engagedMs: r.engaged_ms || 0
        };
        if (r.video_id) { x.videoId = r.video_id; x.segments = Array.isArray(r.segments) ? r.segments : []; }
        if (r.deleted_at) x.deletedAt = msOf(r.deleted_at);
        texts[id] = x;
      }
      MEM.texts = texts;
      console.log('[vocab] sources hydrated:', Math.round(performance.now() - _t) + 'ms | sources', data.length);
      fireChange({ texts: { oldValue: {}, newValue: clone(MEM.texts) } });
    } catch (e) { console.error('[vocab] hydrate failed', e); }
  }

  let LOADING = null;
  async function ensure() { if (MEM) return; if (!LOADING) LOADING = loadFromSupabase().finally(() => { LOADING = null; }); await LOADING; }

  // ── swapped primitives ──────────────────────────────────────────────────────
  function get(keys = null) {
    return (async () => {
      await ensure();
      if (keys === null) return clone(MEM);
      if (typeof keys === 'string') return { [keys]: clone(MEM[keys]) };
      const o = {}; for (const k of keys) o[k] = clone(MEM[k]); return o;
    })();
  }
  function set(obj) {
    return (async () => {
      await ensure();
      const prev = {}; for (const k of Object.keys(obj)) prev[k] = MEM[k];
      await persist(obj, prev);
      _lastLocalWrite = Date.now();
      for (const k of Object.keys(obj)) MEM[k] = clone(obj[k]);
      const changes = {}; for (const k of Object.keys(obj)) changes[k] = { oldValue: prev[k], newValue: clone(obj[k]) };
      fireChange(changes);
      // Announce our own writes to any extension content script sharing this page (the
      // website runs one, on <all_urls>). It relays to the service worker, which tells
      // the sidebar to re-read — so reader saves appear in the sidebar live, without the
      // sidebar having to be focused. Guarded to data keys; ignored everywhere else.
      try {
        if (typeof window !== 'undefined' && window.postMessage) {
          window.postMessage({ __vocabLocalWrite: true, keys: Object.keys(obj) }, '*');
        }
      } catch {}
    })();
  }

  // Something changed elsewhere — the extension, or another tab. Drop the in-memory
  // copy, re-read, then fire the app's change listener so it re-renders. The key is
  // deliberately NOT 'texts': the app treats a lone 'texts' change as an engagement
  // tick and would skip the render (and overwrite S.texts with the empty payload).
  let _lastLocalWrite = 0;
  async function reload() {
    MEM = null;
    await ensure();
    fireChange({ __remote: { oldValue: null, newValue: Date.now() } });
  }
  const sinceLocalWrite = () => Date.now() - _lastLocalWrite;

  // ── PERSIST: snapshot → Supabase ────────────────────────────────────────────
  async function upsert(table, rows, conflict) {
    for (let i = 0; i < rows.length; i += 300) {
      const { error } = await SB.from(table).upsert(rows.slice(i, i + 300), { onConflict: conflict });
      if (error) throw new Error(table + ': ' + error.message);
    }
  }
  async function termToRow(t) {
    return {
      id: await rowId(t.id), ext_id: t.id, user_id: UID,
      surface: t.term || '', translation: t.translation || null, context: t.context || '', note: t.note || '',
      is_disjoint: !!t.isDisjoint, item_type: t.itemType || null, language_pair: t.languagePair || null,
      tags: Array.isArray(t.tags) ? t.tags : [], source_url: t.sourceUrl || '', source_title: t.sourceTitle || '',
      master_id: t.masterId ? await rowId(t.masterId) : null, divorced: !!t.divorced,
      created_at: iso(t.createdAt), updated_at: new Date().toISOString(),
      deleted_at: t.deletedAt ? iso(t.deletedAt) : null, trash_batch: t.trashBatch || null
    };
  }
  async function hlToRow(h) {
    return {
      id: await rowId(h.id), ext_id: h.id, user_id: UID, text: h.text || '',
      color: ['yellow', 'pink', 'blue'].includes(h.color) ? h.color : 'yellow', note: h.note || '',
      source_url: h.sourceUrl || '', source_title: h.sourceTitle || '',
      master_id: h.masterId ? await rowId(h.masterId) : null, divorced: !!h.divorced,
      created_at: iso(h.createdAt), updated_at: new Date().toISOString(),
      deleted_at: h.deletedAt ? iso(h.deletedAt) : null, trash_batch: h.trashBatch || null
    };
  }
  async function collToRow(kind, c) {
    const parentExt = kind === 'folder' ? c.parentId : c.folderId;
    return {
      id: await rowId(c.id), ext_id: c.id, user_id: UID, name: c.name || 'Untitled', kind,
      parent_id: parentExt ? await rowId(parentExt) : null,
      created_at: iso(c.createdAt), updated_at: iso(c.updatedAt || c.createdAt),
      deleted_at: c.deletedAt ? iso(c.deletedAt) : null
    };
  }
  async function srcToRow(x) {
    return {
      id: await rowId(x.id), ext_id: x.id, user_id: UID, kind: x.videoId ? 'video' : 'text',
      title: x.name || 'Untitled', url: x.sourceUrl || '', body: x.body || '',
      video_id: x.videoId || null, segments: x.segments || null, marks: x.marks || [],
      folder_id: x.folderId ? await rowId(x.folderId) : null, engaged_ms: x.engagedMs || 0,
      last_active_at: x.lastActiveAt ? iso(x.lastActiveAt) : null,
      created_at: iso(x.createdAt), updated_at: iso(x.updatedAt || x.createdAt),
      deleted_at: x.deletedAt ? iso(x.deletedAt) : null
    };
  }
  const changed = (a, b) => !a || JSON.stringify(a) !== JSON.stringify(b);

  async function persist(obj, prev) {
    if ('terms' in obj) {
      const next = obj.terms, was = prev.terms || {};
      const rows = []; for (const id in next) if (changed(was[id], next[id])) rows.push(await termToRow(next[id]));
      rows.sort((a, b) => (a.master_id ? 1 : 0) - (b.master_id ? 1 : 0));   // masters before copies
      if (rows.length) await upsert('items', rows, 'user_id,ext_id');
      for (const id in was) if (!next[id]) { const { error } = await SB.from('items').delete().eq('id', await rowId(id)); if (error) throw new Error('items del: ' + error.message); }
      await reconcileMembers('item_id', next, was);
    }
    if ('highlights' in obj) {
      const next = obj.highlights, was = prev.highlights || {};
      const rows = []; for (const id in next) if (changed(was[id], next[id])) rows.push(await hlToRow(next[id]));
      rows.sort((a, b) => (a.master_id ? 1 : 0) - (b.master_id ? 1 : 0));
      if (rows.length) await upsert('highlights', rows, 'user_id,ext_id');
      for (const id in was) if (!next[id]) { const { error } = await SB.from('highlights').delete().eq('id', await rowId(id)); if (error) throw new Error('hl del: ' + error.message); }
      await reconcileMembers('highlight_id', next, was);
    }
    if ('lists' in obj || 'highlightLists' in obj || 'folders' in obj) {
      const rows = [], dels = [];
      const lane = async (kind, next, was) => {
        for (const id in next) if (changed(was[id], next[id])) rows.push(await collToRow(kind, next[id]));
        for (const id in was) if (!next[id]) dels.push(id);
      };
      if ('folders' in obj) await lane('folder', obj.folders, prev.folders || {});
      if ('lists' in obj) await lane('list', obj.lists, prev.lists || {});
      if ('highlightLists' in obj) await lane('highlight_list', obj.highlightLists, prev.highlightLists || {});
      rows.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1)); // folders first (parents)
      if (rows.length) await upsert('collections', rows, 'user_id,ext_id');
      for (const id of dels) { const { error } = await SB.from('collections').delete().eq('id', await rowId(id)); if (error) throw new Error('coll del: ' + error.message); }
    }
    if ('texts' in obj) {
      const next = obj.texts, was = prev.texts || {};
      // Safety: ignore a stale empty-texts write (can happen in the brief window before
      // sources finish streaming in) so it can never mass-delete every source.
      if (Object.keys(next).length === 0 && Object.keys(was).length > 0) {
        // skip
      } else {
        const rows = []; for (const id in next) if (changed(was[id], next[id])) rows.push(await srcToRow(next[id]));
        if (rows.length) await upsert('sources', rows, 'user_id,ext_id');
        for (const id in was) if (!next[id]) { const { error } = await SB.from('sources').delete().eq('id', await rowId(id)); if (error) throw new Error('src del: ' + error.message); }
      }
    }
    if ('prompts' in obj || 'settings' in obj || 'session' in obj) {
      const s = obj.settings || MEM.settings || {};
      const data = {
        reader: s.reader, web: s.web,
        prompts: obj.prompts || MEM.prompts,
        // the current session is part of the saved state — without this it silently
        // reset to empty on every page load
        session: ('session' in obj) ? obj.session : MEM.session
      };
      const { error } = await SB.from('settings').upsert({ user_id: UID, data });
      if (error) throw new Error('settings: ' + error.message);
    }
  }

  // rebuild collection_items for any member whose listIds changed
  async function reconcileMembers(idCol, next, was) {
    for (const id in next) {
      const nl = (next[id].listIds || []).slice().sort();
      const pl = ((was[id] && was[id].listIds) || []).slice().sort();
      if (JSON.stringify(nl) === JSON.stringify(pl)) continue;
      const mUuid = await rowId(id);
      const { error: de } = await SB.from('collection_items').delete().eq(idCol, mUuid);
      if (de) throw new Error('ci del: ' + de.message);
      const live = (next[id].listIds || []);
      if (live.length) {
        const rows = []; for (const l of live) rows.push({ user_id: UID, collection_id: await rowId(l), [idCol]: mUuid });
        const { error: ie } = await SB.from('collection_items').insert(rows);
        if (ie) throw new Error('ci ins: ' + ie.message);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EVERYTHING BELOW is the extension's original store.js, verbatim — it only
  // ever calls getAll()/set()/uid(), which now route to Supabase.
  // ════════════════════════════════════════════════════════════════════════════

  async function getAll() {
    const d = await get(null);
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = (d[k] !== undefined) ? d[k] : JSON.parse(JSON.stringify(DEFAULTS[k]));
    return out;
  }
  function uid(prefix = "") { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  async function addTerm({ term, context, sourceUrl, sourceTitle }) {
    const d = await getAll();
    term = (term || "").trim();
    if (!term) return { ok: false, reason: "empty" };
    // Already in the session: don't create a second copy, but hand back the existing
    // id so callers (e.g. a reader mark) can still link to it rather than dangle.
    const dupeId = d.session.termIds.find(id => d.terms[id] && d.terms[id].term === term && !d.terms[id].deletedAt);
    if (dupeId) return { ok: false, reason: "duplicate", id: dupeId };
    const id = uid("t_");
    d.terms[id] = { id, term, context: context || "", sourceUrl: sourceUrl || "", sourceTitle: sourceTitle || "", createdAt: Date.now(), listIds: [] };
    d.session.termIds.unshift(id);
    await set({ terms: d.terms, session: d.session });
    return { ok: true, id };
  }
  async function removeTerms(ids, { permanent = false } = {}) {
    const d = await getAll();
    for (const id of ids) {
      if (!d.terms[id]) continue;
      const batch = 'mb_' + Date.now() + '_' + id;
      if (permanent) {
        delete d.terms[id];
        d.session.termIds = d.session.termIds.filter(x => x !== id);
        for (const c of Object.values(d.terms)) if (c.masterId === id) delete d.terms[c.id];
      } else {
        d.terms[id].deletedAt = Date.now();
        const hasCopies = Object.values(d.terms).some(c => c.masterId === id && !c.divorced && !c.deletedAt);
        if (hasCopies) {
          d.terms[id].trashBatch = batch;
          for (const c of Object.values(d.terms)) if (c.masterId === id && !c.divorced && !c.deletedAt) { c.deletedAt = Date.now(); c.trashBatch = batch; }
        }
      }
    }
    await set({ terms: d.terms, session: d.session });
  }
  async function addHighlight({ text, color, note, sourceUrl, sourceTitle }) {
    const d = await getAll();
    text = (text || "").trim();
    if (!text) return { ok: false, reason: "empty" };
    if (!d.session.highlightIds) d.session.highlightIds = [];
    const id = uid("h_");
    d.highlights[id] = { id, text, color: color || "yellow", note: note || "", sourceUrl: sourceUrl || "", sourceTitle: sourceTitle || "", createdAt: Date.now(), listIds: [] };
    d.session.highlightIds.unshift(id);
    await set({ highlights: d.highlights, session: d.session });
    return { ok: true, id };
  }
  async function updateHighlight(id, patch) {
    const d = await getAll();
    if (!d.highlights[id]) return;
    Object.assign(d.highlights[id], patch);
    await set({ highlights: d.highlights });
  }
  async function removeHighlights(ids, { permanent = false } = {}) {
    const d = await getAll();
    if (!d.session.highlightIds) d.session.highlightIds = [];
    for (const id of ids) {
      if (!d.highlights[id]) continue;
      const batch = 'mb_' + Date.now() + '_' + id;
      if (permanent) {
        delete d.highlights[id];
        d.session.highlightIds = d.session.highlightIds.filter(x => x !== id);
        for (const c of Object.values(d.highlights)) if (c.masterId === id) delete d.highlights[c.id];
      } else {
        d.highlights[id].deletedAt = Date.now();
        const hasCopies = Object.values(d.highlights).some(c => c.masterId === id && !c.divorced && !c.deletedAt);
        if (hasCopies) {
          d.highlights[id].trashBatch = batch;
          for (const c of Object.values(d.highlights)) if (c.masterId === id && !c.divorced && !c.deletedAt) { c.deletedAt = Date.now(); c.trashBatch = batch; }
        }
      }
    }
    await set({ highlights: d.highlights, session: d.session });
  }
  async function clearSession() {
    const d = await getAll();
    d.session = { startedAt: Date.now(), termIds: [], highlightIds: [] };
    await set({ session: d.session });
  }
  async function assignHighlightsToList(hlIds, listId, { move = false } = {}) {
    const d = await getAll();
    for (const hid of hlIds) {
      const h = d.highlights[hid];
      if (!h) continue;
      if (!Array.isArray(h.listIds)) h.listIds = [];
      if (move && h.masterId) { h.listIds = [listId]; }
      else if (h.masterId) { if (!h.listIds.includes(listId)) h.listIds.push(listId); }
      else {
        const exists = Object.values(d.highlights).some(x => x.masterId === hid && (x.listIds || []).includes(listId) && !x.deletedAt);
        if (!exists) { const cid = uid("h_"); d.highlights[cid] = { ...JSON.parse(JSON.stringify(h)), id: cid, masterId: hid, divorced: false, listIds: [listId], createdAt: Date.now() }; }
      }
    }
    if (d.highlightLists[listId]) d.highlightLists[listId].updatedAt = Date.now();
    await set({ highlights: d.highlights, highlightLists: d.highlightLists });
  }
  async function removeHighlightsFromList(hlIds, listId, { permanent = false } = {}) {
    const d = await getAll();
    for (const hid of hlIds) {
      const h = d.highlights[hid];
      if (!h) continue;
      if (h.masterId) {
        h.listIds = (h.listIds || []).filter(x => x !== listId);
        if (!h.listIds.length) { if (permanent) delete d.highlights[hid]; else h.deletedAt = Date.now(); }
      } else { h.listIds = (h.listIds || []).filter(x => x !== listId); }
    }
    await set({ highlights: d.highlights });
  }
  async function editHighlight(id, patch) {
    const d = await getAll();
    const h = d.highlights[id];
    if (!h) return;
    Object.assign(h, patch);
    if (h.masterId) { h.divorced = true; }
    else {
      for (const c of Object.values(d.highlights)) {
        if (c.masterId === id && !c.divorced && !c.deletedAt) {
          if ('text' in patch) c.text = patch.text;
          if ('note' in patch) c.note = patch.note;
          if ('color' in patch) c.color = patch.color;
        }
      }
    }
    await set({ highlights: d.highlights });
  }
  async function createHighlightList(name, folderId = null) {
    const d = await getAll();
    const id = uid("hl_"); const now = Date.now();
    d.highlightLists[id] = { id, name: name || "Highlights", folderId, createdAt: now, updatedAt: now };
    await set({ highlightLists: d.highlightLists });
    return id;
  }
  async function createList(name, folderId = null) {
    const d = await getAll();
    const id = uid("l_"); const now = Date.now();
    d.lists[id] = { id, name: name || "Untitled list", folderId, createdAt: now, updatedAt: now };
    await set({ lists: d.lists });
    await logActivity("list", id, "created", "");
    return id;
  }
  async function createText({ name, body, sourceUrl, sourceTitle } = {}) {
    const d = await getAll();
    const id = uid("x_"); const now = Date.now();
    d.texts[id] = { id, name: name || "Untitled", body: body || "", marks: [], folderId: null, sourceUrl: sourceUrl || "", sourceTitle: sourceTitle || "", createdAt: now, updatedAt: now, lastActiveAt: now, engagedMs: 0 };
    await set({ texts: d.texts });
    return { ok: true, id };
  }
  async function createVideoText({ name, body, videoId, segments, sourceUrl } = {}) {
    const d = await getAll();
    const id = uid("x_"); const now = Date.now();
    d.texts[id] = { id, name: name || "YouTube video", body: body || "", marks: [], videoId: videoId || "", segments: segments || [], folderId: null, sourceUrl: sourceUrl || "", sourceTitle: name || "", createdAt: now, updatedAt: now, lastActiveAt: now, engagedMs: 0 };
    await set({ texts: d.texts });
    return { ok: true, id };
  }
  async function assignTermsToList(termIds, listId, { move = false } = {}) {
    const d = await getAll();
    for (const tid of termIds) {
      const t = d.terms[tid];
      if (!t) continue;
      if (!Array.isArray(t.listIds)) t.listIds = (t.listId ? [t.listId] : []);
      delete t.listId;
      if (move && t.masterId) { t.listIds = [listId]; }
      else if (t.masterId) { if (!t.listIds.includes(listId)) t.listIds.push(listId); }
      else {
        const exists = Object.values(d.terms).some(x => x.masterId === tid && (x.listIds || []).includes(listId) && !x.deletedAt);
        if (!exists) { const cid = uid("t_"); d.terms[cid] = { ...JSON.parse(JSON.stringify(t)), id: cid, masterId: tid, divorced: false, listIds: [listId], createdAt: Date.now() }; }
      }
    }
    if (d.lists[listId]) d.lists[listId].updatedAt = Date.now();
    await set({ terms: d.terms, lists: d.lists });
    await logActivity("list", listId, "added", `${termIds.length} term(s)`);
  }
  async function removeFromList(termIds, listId, { permanent = false } = {}) {
    const d = await getAll();
    for (const tid of termIds) {
      const t = d.terms[tid];
      if (!t) continue;
      if (t.masterId) {
        t.listIds = (t.listIds || []).filter(x => x !== listId);
        if (!t.listIds.length) { if (permanent) delete d.terms[tid]; else t.deletedAt = Date.now(); }
      } else { t.listIds = (t.listIds || []).filter(x => x !== listId); }
    }
    await set({ terms: d.terms });
  }
  async function editTerm(id, patch) {
    const d = await getAll();
    const t = d.terms[id];
    if (!t) return;
    Object.assign(t, patch);
    if (t.masterId) { t.divorced = true; }
    else {
      for (const c of Object.values(d.terms)) {
        if (c.masterId === id && !c.divorced && !c.deletedAt) {
          if ('term' in patch) c.term = patch.term;
          if ('context' in patch) c.context = patch.context;
          if ('note' in patch) c.note = patch.note;
        }
      }
    }
    await set({ terms: d.terms });
  }
  async function logActivity(kind, refId, action, detail) {
    const d = await getAll();
    d.activity.unshift({ id: uid("a_"), kind, refId, action, detail, at: Date.now() });
    d.activity = d.activity.slice(0, 200);
    await set({ activity: d.activity });
  }
  const KIND_KEY = { term: 'terms', highlight: 'highlights', list: 'lists', highlightList: 'highlightLists', folder: 'folders', text: 'texts' };
  async function softDelete(kind, ids) {
    const d = await getAll();
    const key = KIND_KEY[kind]; if (!key) return;
    const now = Date.now();
    for (const id of ids) { if (d[key][id]) d[key][id].deletedAt = now; }
    await set({ [key]: d[key] });
  }
  async function restoreItems(kind, ids) {
    const d = await getAll();
    const key = KIND_KEY[kind]; if (!key) return;
    const batches = new Set();
    for (const id of ids) { const obj = d[key][id]; if (obj && obj.trashBatch) batches.add(obj.trashBatch); }
    for (const id of ids) { if (d[key][id]) { delete d[key][id].deletedAt; delete d[key][id].trashBatch; } }
    if (batches.size) {
      for (const k of Object.values(KIND_KEY)) for (const obj of Object.values(d[k])) if (obj.trashBatch && batches.has(obj.trashBatch)) { delete obj.deletedAt; delete obj.trashBatch; }
    }
    await set({ terms: d.terms, highlights: d.highlights, lists: d.lists, highlightLists: d.highlightLists, folders: d.folders, texts: d.texts });
  }
  async function purgeItems(kind, ids) {
    const d = await getAll();
    const key = KIND_KEY[kind]; if (!key) return;
    const batches = new Set();
    for (const id of ids) { const o = d[key][id]; if (o && o.trashBatch) batches.add(o.trashBatch); }
    const purgeOne = (k, id) => {
      const kk = KIND_KEY[k]; if (!kk || !d[kk][id]) return;
      delete d[kk][id];
      if (k === 'term') d.session.termIds = (d.session.termIds || []).filter(x => x !== id);
      if (k === 'highlight') d.session.highlightIds = (d.session.highlightIds || []).filter(x => x !== id);
      if (k === 'list') for (const t of Object.values(d.terms)) { if (Array.isArray(t.listIds)) t.listIds = t.listIds.filter(x => x !== id); }
      if (k === 'highlightList') for (const h of Object.values(d.highlights)) { if (Array.isArray(h.listIds)) h.listIds = h.listIds.filter(x => x !== id); }
    };
    for (const id of ids) purgeOne(kind, id);
    if (batches.size) {
      for (const [k, kk] of Object.entries(KIND_KEY)) for (const obj of Object.values(d[kk])) if (obj.trashBatch && batches.has(obj.trashBatch)) purgeOne(k, obj.id);
    }
    await set({ terms: d.terms, highlights: d.highlights, lists: d.lists, highlightLists: d.highlightLists, folders: d.folders, texts: d.texts, session: d.session });
  }
  async function emptyTrash() {
    const d = await getAll();
    for (const [kind, key] of Object.entries(KIND_KEY)) {
      const ids = Object.values(d[key]).filter(o => o.deletedAt).map(o => o.id);
      for (const id of ids) {
        delete d[key][id];
        if (kind === 'term') d.session.termIds = (d.session.termIds || []).filter(x => x !== id);
        if (kind === 'highlight') d.session.highlightIds = (d.session.highlightIds || []).filter(x => x !== id);
        if (kind === 'list') for (const t of Object.values(d.terms)) { if (Array.isArray(t.listIds)) t.listIds = t.listIds.filter(x => x !== id); }
        if (kind === 'highlightList') for (const h of Object.values(d.highlights)) { if (Array.isArray(h.listIds)) h.listIds = h.listIds.filter(x => x !== id); }
      }
    }
    await set({ terms: d.terms, highlights: d.highlights, lists: d.lists, highlightLists: d.highlightLists, folders: d.folders, texts: d.texts, session: d.session });
  }

  return {
    init, get, set, getAll, uid, reload, sinceLocalWrite,
    addTerm, removeTerms, clearSession,
    createList, assignTermsToList, removeFromList, logActivity, createText, createVideoText, editTerm,
    addHighlight, updateHighlight, removeHighlights,
    assignHighlightsToList, removeHighlightsFromList, createHighlightList, editHighlight,
    softDelete, restoreItems, purgeItems, emptyTrash
  };
})();

if (typeof module !== "undefined") module.exports = VocabStore;
