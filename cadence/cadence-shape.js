// cadence-shape · 2026-11-09a (note kinds: name_fix, changed, added, dropped for the AI cleanup)
//
// One shape for every text that plays along with sound (claude/timed-text-brief.md rev 3, §2).
// This file has no DOM and no network: it builds, checks and searches documents.
// It runs in the browser (window.TimedText) and in Node (require) for the tests.
//
// The rules it keeps (brief §1):
//   - The text is the truth; times attach to it. Nothing here rewrites a word's text.
//   - A word may have no time. Such words are rendered but never followed.
//   - Lines may overlap. at(ms) reports every active line, and one primary word.
//   - Times are milliseconds from the start of the media. Each time says who made it.
//   - The main text is what was said; everything else is a note on word or line ids.
//   - Every document records its origin; every note keeps an append-only history.
//     Nothing here scores, ranks or blocks on them (rule 11).

(function (root) {
  'use strict';

  const BY = ['hand', 'aligner', 'captions', 'tts', 'estimated'];
  // Starting lists from brief rev 3 §2. Unknown values are reported, never refused.
  const ROUTES = ['own_transcript', 'aligner', 'youtube_captions', 'youtube_ai_cleanup', 'learner_upload', 'tts', 'ebook_audiobook'];
  const ORIGIN_BY = ['creator', 'teacher', 'learner'];
  const NOTE_KINDS = ['caption_fix', 'unclear', 'speaker_unclear', 'meant', 'name_fix', 'changed', 'added', 'dropped'];
  const NOTE_STATUS = ['open', 'accepted', 'rejected'];

  // origin for a new document. route and by come from the caller; time is now.
  function makeOrigin(o, route) {
    const out = { route: (o && o.route) || route, created_at: (o && o.created_at) || new Date().toISOString() };
    if (o && o.by) out.by = o.by;
    if (o && o.model) out.model = o.model;
    return out;
  }

  // ── small helpers ──────────────────────────────────────────────────────────
  const isNum = v => typeof v === 'number' && isFinite(v);
  const timed = w => isNum(w.start) && isNum(w.end) && w.end > w.start;

  // Split a string into words with their character positions. A word is a run of
  // non-space characters, punctuation included ("auf." is one word), as in §2.
  function tokenize(s, base) {
    const out = [], re = /\S+/g;
    let m;
    while ((m = re.exec(s))) out.push({ text: m[0], from: (base || 0) + m.index, to: (base || 0) + m.index + m[0].length });
    return out;
  }

  // Paragraphs from a plain body. Blank lines separate paragraphs. A body with no
  // blank line at all but with single line breaks (how many cleaned transcripts are
  // written) uses each line break instead.
  function paragraphs(body) {
    const spans = [];
    const sep = /\n[ \t]*\n/.test(body) ? /\n[ \t]*\n+/g : /\n+/g;
    let last = 0, m;
    while ((m = sep.exec(body))) { spans.push([last, m.index]); last = m.index + m[0].length; }
    spans.push([last, body.length]);
    return spans.filter(([a, b]) => body.slice(a, b).trim());
  }

  // How long a word takes to say, relative to its neighbours, when all we know is
  // the time of the whole line. Letters count; every word also costs a little, so
  // "a" isn't given nothing; trailing punctuation adds a small pause.
  function weight(text) {
    const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    const pause = /[.!?…]$/.test(text) ? 2.5 : /[,;:]$/.test(text) ? 1.2 : 0;
    return 1.6 + letters + pause;
  }

  // Share a line's time across its words by weight. Used only when nothing better
  // exists (captions). The result is marked by whoever made the line's time.
  function spread(words, start, end, by) {
    const total = words.reduce((s, w) => s + weight(w.text), 0) || 1;
    let t = start;
    words.forEach((w, i) => {
      const d = (end - start) * weight(w.text) / total;
      w.start = Math.round(t);
      w.end = i === words.length - 1 ? Math.round(end) : Math.round(t + d);
      if (w.end <= w.start) w.end = w.start + 1;
      w.by = by;
      t += d;
    });
  }

  // ── builders ───────────────────────────────────────────────────────────────

  // A text nobody has synced: a valid document, read as a plain page (rule 2).
  function fromPlain({ id, language, body, media, origin } = {}) {
    body = String(body || '');
    const doc = { id: id || 'doc_plain', language: language || '', media: media || null,
      origin: makeOrigin(origin, 'learner_upload'), blocks: [], lines: {}, notes: [] };
    let ln = 0, wn = 0;
    for (const [a, b] of paragraphs(body)) {
      const lid = 'l' + (++ln);
      doc.lines[lid] = { words: tokenize(body.slice(a, b), a).map(t => ({ id: 'w' + (++wn), text: t.text })) };
      doc.blocks.push({ type: 'paragraph', lines: [lid] });
    }
    return doc;
  }

  // Today's YouTube texts: `body` plus `segments` [{start (seconds), offset, len}],
  // as app.js's parseTranscript() and the sources table store them. Each caption
  // becomes a line (split where a paragraph break falls inside it); its words share
  // the caption's time by weight, marked `captions`. Words before the first caption
  // keep no time. A caption ends where the next begins; the last one gets an
  // estimate from its length.
  function fromCaptions({ id, language, videoId, body, segments, origin } = {}) {
    body = String(body || '');
    const segs = (Array.isArray(segments) ? segments : [])
      .filter(s => s && isNum(+s.start) && isNum(+s.offset))
      .map(s => ({ start: Math.round(+s.start * 1000), offset: +s.offset, len: isNum(+s.len) ? +s.len : 0 }))
      .sort((a, b) => a.offset - b.offset || a.start - b.start);
    const media = videoId ? { provider: 'youtube', ref: videoId } : null;
    if (!segs.length) return fromPlain({ id, language, body, media, origin: makeOrigin(origin, videoId ? 'youtube_captions' : 'learner_upload') });

    // end of each caption
    segs.forEach((s, i) => {
      // captions carry no end of their own: one ends where the next begins
      const n = segs[i + 1];
      s.end = (n && n.start > s.start) ? n.start : s.start + Math.min(8000, Math.max(1500, (s.len || 20) * 65));
    });
    const segAt = pos => { // last caption whose offset <= pos
      let lo = 0, hi = segs.length - 1, r = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].offset <= pos) { r = mid; lo = mid + 1; } else hi = mid - 1; }
      return r;
    };

    const doc = { id: id || 'doc_captions', language: language || '', media,
      origin: makeOrigin(origin, 'youtube_captions'), blocks: [], lines: {}, notes: [] };
    let ln = 0, wn = 0;
    for (const [a, b] of paragraphs(body)) {
      const block = { type: 'paragraph', lines: [] };
      let cur = null, curSeg = -2;
      for (const t of tokenize(body.slice(a, b), a)) {
        const si = segAt(t.from);
        if (si !== curSeg) {
          if (cur) finish(cur, curSeg);
          cur = { lid: 'l' + (++ln), words: [] };
          curSeg = si;
        }
        cur.words.push({ id: 'w' + (++wn), text: t.text, _from: t.from });
      }
      if (cur) finish(cur, curSeg);
      if (block.lines.length) doc.blocks.push(block);

      function finish(c, si) {
        const line = { words: c.words };
        if (si >= 0) {
          const s = segs[si];
          // A caption split across a paragraph break: each part gets its share.
          const all = tokenize(body.slice(s.offset, segs[si + 1] ? segs[si + 1].offset : body.length), s.offset);
          const tw = all.reduce((x, w) => x + weight(w.text), 0) || 1;
          const firstFrom = c.words[0]._from;
          let before = 0;
          for (const w of all) { if (w.from >= firstFrom) break; before += weight(w.text); }
          const mine = c.words.reduce((x, w) => x + weight(w.text), 0);
          const st = s.start + (s.end - s.start) * before / tw;
          const en = s.start + (s.end - s.start) * (before + mine) / tw;
          line.start = Math.round(st); line.end = Math.max(Math.round(en), line.start + 1);
          spread(c.words, line.start, line.end, 'captions');
        }
        c.words.forEach(w => { delete w._from; });
        doc.lines[c.lid] = line;
        block.lines.push(c.lid);
      }
    }
    return doc;
  }

  // ── checking ───────────────────────────────────────────────────────────────
  // Returns a list of plain-language problems; an empty list means usable.
  // Problems never stop rendering; they say what the follower will ignore.
  function validate(doc) {
    const out = [];
    if (!doc || typeof doc !== 'object') return ['not a document'];
    if (!Array.isArray(doc.blocks)) out.push('blocks is missing');
    if (!doc.lines || typeof doc.lines !== 'object') { out.push('lines is missing'); return out; }
    const seenW = new Set(), used = new Set();
    for (const b of doc.blocks || []) for (const lid of b.lines || []) {
      if (!doc.lines[lid]) out.push(`block refers to missing line ${lid}`);
      if (used.has(lid)) out.push(`line ${lid} is in two blocks`);
      used.add(lid);
    }
    for (const [lid, l] of Object.entries(doc.lines)) {
      if (!Array.isArray(l.words)) { out.push(`line ${lid} has no words`); continue; }
      if (isNum(l.start) !== isNum(l.end)) out.push(`line ${lid} has only one of start/end`);
      if (isNum(l.start) && l.end <= l.start) out.push(`line ${lid} ends before it starts`);
      let prev = -Infinity;
      for (const w of l.words) {
        if (!w.id) out.push(`a word in ${lid} has no id`);
        else if (seenW.has(w.id)) out.push(`word id ${w.id} is used twice`);
        seenW.add(w.id);
        if (typeof w.text !== 'string' || !w.text) out.push(`word ${w.id} has no text`);
        if (isNum(w.start) || isNum(w.end)) {
          if (!timed(w)) out.push(`word ${w.id} has a broken time`);
          else {
            if (w.start < prev) out.push(`word ${w.id} starts before the word before it`);
            prev = w.start;
            if (w.by && !BY.includes(w.by)) out.push(`word ${w.id}: unknown maker "${w.by}"`);
          }
        }
      }
    }
    // origin (rule 11): expected, but a missing one doesn't stop reading
    if (!doc.origin) out.push('no origin recorded');
    else {
      if (!doc.origin.route) out.push('origin has no route');
      else if (!ROUTES.includes(doc.origin.route)) out.push(`origin: unknown route "${doc.origin.route}"`);
      if (doc.origin.by && !ORIGIN_BY.includes(doc.origin.by)) out.push(`origin: unknown maker "${doc.origin.by}"`);
    }
    // notes point at words or lines that exist
    if (doc.notes != null && !Array.isArray(doc.notes)) out.push('notes is not a list');
    const seenN = new Set();
    for (const n of Array.isArray(doc.notes) ? doc.notes : []) {
      const nid = n && n.id;
      if (!nid) { out.push('a note has no id'); continue; }
      if (seenN.has(nid)) out.push(`note id ${nid} is used twice`);
      seenN.add(nid);
      if (!NOTE_KINDS.includes(n.kind)) out.push(`note ${nid}: unknown kind "${n.kind}"`);
      if (!NOTE_STATUS.includes(n.status)) out.push(`note ${nid}: unknown status "${n.status}"`);
      const ws = Array.isArray(n.words) ? n.words : [], ls = Array.isArray(n.lines) ? n.lines : [];
      if (!ws.length && !ls.length) out.push(`note ${nid} points at nothing`);
      for (const w of ws) if (!seenW.has(w)) out.push(`note ${nid} points at missing word ${w}`);
      for (const l of ls) if (!doc.lines[l]) out.push(`note ${nid} points at missing line ${l}`);
      if (n.kind === 'caption_fix' && typeof n.was !== 'string') out.push(`note ${nid}: caption fix without the old word`);
      if (!Array.isArray(n.history) || !n.history.length) out.push(`note ${nid} has no history`);
      else for (const h of n.history) if (!h || !h.at || !h.by || !h.did) { out.push(`note ${nid}: a history entry is missing at/by/did`); break; }
    }
    return out;
  }

  // ── notes ──────────────────────────────────────────────────────────────────
  // The only way to change a note's status: it appends to the history, never
  // rewrites it. did: 'raised' | 'accepted' | 'rejected' | anything else said
  // in words ('listened', 'time adjusted'); only the first three set the status.
  function noteAct(doc, noteId, { by, did, at } = {}) {
    const n = (doc.notes || []).find(x => x.id === noteId);
    if (!n || !by || !did) return null;
    (n.history = n.history || []).push({ at: at || new Date().toISOString(), by, did });
    if (did === 'accepted' || did === 'rejected') n.status = did;
    else if (did === 'raised') n.status = 'open';
    return n;
  }
  // Notes touching a word (by word id, or its line), for drawing later.
  function notesFor(doc, wordId, lineId) {
    return (doc.notes || []).filter(n => (n.words || []).includes(wordId) || (lineId && (n.lines || []).includes(lineId)));
  }

  // ── searching ──────────────────────────────────────────────────────────────
  // buildIndex(doc) → { at(ms), words, lines, wordInfo(id), lineOf(id), duration }
  //
  // at(ms) returns { word, line, lines, next, prev }:
  //   word  – the primary word now: the latest-started word still sounding. In a
  //           short gap between words (≤ HOLD ms) the previous word stays, so the
  //           highlight doesn't flicker on every breath. null in a long silence.
  //   line  – the primary word's line (or, in silence, null)
  //   lines – every line sounding now (overlapping speakers)
  //   next  – the next word to start (for "about to begin" and seeking)
  //   prev  – the last word that started
  // Every lookup is a binary search; nothing scans the whole text per frame.
  const HOLD = 900;

  function buildIndex(doc, opts) {
    const hold = (opts && isNum(opts.hold)) ? opts.hold : HOLD;
    const words = [];      // timed words, sorted by start
    const lines = [];      // timed lines, sorted by start
    const info = new Map(); // word id → { id, line, start, end, order }
    const lineOf = new Map();
    let order = 0;
    for (const b of doc.blocks || []) for (const lid of b.lines || []) {
      const l = doc.lines[lid]; if (!l || !Array.isArray(l.words)) continue;
      let ls = Infinity, le = -Infinity;
      for (const w of l.words) {
        lineOf.set(w.id, lid);
        const rec = { id: w.id, line: lid, order: order++, start: null, end: null };
        if (timed(w)) { rec.start = w.start; rec.end = w.end; words.push(rec); ls = Math.min(ls, w.start); le = Math.max(le, w.end); }
        info.set(w.id, rec);
      }
      const s = isNum(l.start) ? l.start : ls, e = isNum(l.end) ? l.end : le;
      if (isNum(s) && isNum(e) && e > s) lines.push({ id: lid, start: s, end: e });
    }
    const byStart = (a, b) => a.start - b.start || a.order - b.order;
    words.sort(byStart);
    lines.sort((a, b) => a.start - b.start);
    // running maximum of ends, so we know how far back an overlap can reach
    const wMax = new Float64Array(words.length), lMax = new Float64Array(lines.length);
    words.forEach((w, i) => { wMax[i] = Math.max(i ? wMax[i - 1] : -Infinity, w.end); });
    lines.forEach((l, i) => { lMax[i] = Math.max(i ? lMax[i - 1] : -Infinity, l.end); });

    const lastStartedAt = (arr, t) => { // index of last item with start <= t, or -1
      let lo = 0, hi = arr.length - 1, r = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].start <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; }
      return r;
    };

    function at(t) {
      const res = { word: null, line: null, lines: [], next: null, prev: null };
      if (!isNum(t) || !words.length) return res;
      const i = lastStartedAt(words, t);
      res.next = words[i + 1] ? words[i + 1].id : null;
      res.prev = i >= 0 ? words[i].id : null;
      // the latest-started word still sounding
      for (let k = i; k >= 0 && wMax[k] > t; k--) {
        if (words[k].end > t) { res.word = words[k].id; break; }
      }
      // a short gap: hold the last word until the next one starts
      if (!res.word && i >= 0 && t - words[i].end <= hold) {
        const nx = words[i + 1];
        if (!nx || nx.start > t) res.word = words[i].id;
      }
      const j = lastStartedAt(lines, t);
      for (let k = j; k >= 0 && lMax[k] > t; k--) if (lines[k].end > t) res.lines.push(lines[k].id);
      res.lines.reverse();
      res.line = res.word ? info.get(res.word).line : null;
      return res;
    }

    return {
      at,
      words, lines,
      wordInfo: id => info.get(id) || null,
      lineOf: id => lineOf.get(id) || null,
      timedCount: words.length,
      duration: words.length ? wMax[words.length - 1] : 0,
      // the start of the line before/after the one sounding at t (for ← / →)
      lineStartNear(t, dir) {
        const j = lastStartedAt(lines, t);
        if (dir < 0) {
          if (j < 0) return null;
          // within the first 0.8 s of a line, step back to the one before
          return (t - lines[j].start > 800 || j === 0) ? lines[j].start : lines[j - 1].start;
        }
        return lines[j + 1] ? lines[j + 1].start : null;
      }
    };
  }

  // Plain text of a line, as written.
  function lineText(doc, lid) {
    const l = doc.lines[lid];
    return l ? l.words.map(w => w.text).join(' ') : '';
  }

  const api = { fromPlain, fromCaptions, validate, buildIndex, lineText, tokenize, noteAct, notesFor,
    BY, ROUTES, ORIGIN_BY, NOTE_KINDS, NOTE_STATUS, HOLD };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimedText = api;
})(typeof window !== 'undefined' ? window : globalThis);
