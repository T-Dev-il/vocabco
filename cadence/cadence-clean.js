// cadence-clean · 2026-11-09a — Contractor 21.
//
// The quick route's step 4 (timed-text brief §3): an AI cleaned the caption text
// (punctuation, sentences, speakers, fixed mishearings, notes). Plain code puts
// the caption times back on. Rule 1: the text is the truth, times attach to it.
//
//   CadenceClean.reattach(captionWords, cleaned, opts) → { lines, notes, changes, stats }
//     captionWords  [{ id, text, start, end }] in spoken order (one chunk is fine)
//     cleaned       { sentences: [{ speaker, text }], notes: [{ kind, span, was, meant, why }] }
//     opts          { idPrefix: 'c0-', lineStart: 1 }
//
// How: the cleaned words are lined up against the caption words with an edit
// distance (same word = free; a similar word = cheap; added or dropped = 1).
// Between two words that stayed the same, the cleaned words share the time of
// the caption words they replaced, by length. A same word keeps its caption time
// (by: "captions"); every other word is by: "estimated". Words added where the
// captions had nothing get no time (rule 2: a word may have no time).
//
// It also reports what changed, so a person (or a bench) can judge the model:
//   changes  [{ was, now, kind: 'fix' | 'spacing' | 'dropped' | 'added', noted }]
//   dropped changes carry `after`: the id of the cleaned word they sat behind
//   'spacing' = only spaces/hyphens moved (Abgeordneten Haus → Abgeordnetenhaus)
//   noted     = a note of the model covers it; unnoted changes deserve a look
//
//   CadenceClean.toDoc(parts, meta) → a document in the brief's §2 shape
//
// Runs in the browser (window.CadenceClean) and in node (module.exports).
(function (root) {
  'use strict';

  // compare words without case and punctuation: "Waren?" = "waren"
  const norm = s => (s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '');
  const tokens = s => (s || '').split(/\s+/).filter(Boolean);

  // how alike two words are, 0..1 (shared letter pairs, Dice)
  function alike(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    if (a.length < 2 || b.length < 2) return a[0] === b[0] ? 0.4 : 0;
    const pairs = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); } return m; };
    const A = pairs(a), B = pairs(b); let both = 0;
    for (const [p, n] of A) both += Math.min(n, B.get(p) || 0);
    return (2 * both) / (a.length - 1 + b.length - 1);
  }

  // edit-distance alignment: ops = [{ c: captionIndex | -1, w: cleanedIndex | -1, same }]
  function align(cap, cln) {
    const n = cap.length, m = cln.length, W = m + 1;
    const D = new Float64Array((n + 1) * W), B = new Uint8Array((n + 1) * W); // 1 diag, 2 up (drop), 3 left (add)
    for (let i = 1; i <= n; i++) { D[i * W] = i; B[i * W] = 2; }
    for (let j = 1; j <= m; j++) { D[j] = j; B[j] = 3; }
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const a = cap[i - 1], b = cln[j - 1];
        const sub = a === b ? 0 : 1.6 - alike(a, b); // a different word costs more than add+drop unless alike
        let best = D[(i - 1) * W + j - 1] + sub, how = 1;
        const up = D[(i - 1) * W + j] + 1; if (up < best) { best = up; how = 2; }
        const left = D[i * W + j - 1] + 1; if (left < best) { best = left; how = 3; }
        D[i * W + j] = best; B[i * W + j] = how;
      }
    }
    const ops = [];
    for (let i = n, j = m; i > 0 || j > 0;) {
      const how = B[i * W + j];
      if (how === 1) { ops.push({ c: i - 1, w: j - 1, same: cap[i - 1] === cln[j - 1] }); i--; j--; }
      else if (how === 2) { ops.push({ c: i - 1, w: -1, same: false }); i--; }
      else { ops.push({ c: -1, w: j - 1, same: false }); j--; }
    }
    return ops.reverse();
  }

  function reattach(captionWords, cleaned, opts) {
    opts = opts || {};
    const pre = opts.idPrefix || '', lineStart = opts.lineStart || 1;
    const sentences = (cleaned && cleaned.sentences) || [];

    // the cleaned words, each knowing its sentence and its place in the sentence's text
    const cw = [];
    sentences.forEach((s, si) => {
      let at = 0;
      for (const t of tokens(s.text)) {
        const k = s.text.indexOf(t, at); at = k + t.length;
        cw.push({ text: t, si, from: k, to: k + t.length });
      }
    });
    const capN = captionWords.map(w => norm(w.text)), clnN = cw.map(w => norm(w.text));
    const ops = align(capN, clnN);

    // runs of non-same ops between same words
    const times = cw.map(() => null), changes = [];
    const flush = run => {
      if (!run.length) return;
      const caps = run.filter(o => o.c >= 0).map(o => captionWords[o.c]);
      const wds = run.filter(o => o.w >= 0).map(o => o.w);
      const was = caps.map(w => w.text).join(' '), now = wds.map(i => cw[i].text).join(' ');
      if (caps.length && wds.length) {
        const s0 = caps[0].start, e0 = caps[caps.length - 1].end;
        const timed = caps.every(w => w.start != null && w.end != null);
        const weight = wds.map(i => Math.max(1, norm(cw[i].text).length || 1)), total = weight.reduce((a, b) => a + b, 0);
        let t = s0;
        wds.forEach((i, k) => {
          const d = timed ? (e0 - s0) * weight[k] / total : 0;
          times[i] = timed ? { start: Math.round(t), end: Math.round(t + d), by: 'estimated' } : null;
          t += d;
        });
        const spacing = caps.map(w => norm(w.text)).join('') === wds.map(i => clnN[i]).join('');
        changes.push({ was, now, kind: spacing ? 'spacing' : 'fix', words: wds });
      } else if (caps.length) changes.push({ was, now: '', kind: 'dropped', words: [], after: lastW });
      else changes.push({ was: '', now, kind: 'added', words: wds });
    };
    let run = [], lastW = -1; // lastW: the cleaned word before the current run (where a drop sits)
    for (const o of ops) {
      if (o.same) {
        flush(run); run.forEach(r => { if (r.w > lastW) lastW = r.w; }); run = [];
        lastW = o.w;
        const c = captionWords[o.c];
        times[o.w] = c.start != null ? { start: c.start, end: c.end, by: 'captions' } : null;
      } else run.push(o);
    }
    flush(run);

    // lines: one per sentence
    let wn = 0;
    const ids = cw.map(() => pre + 'w' + (++wn));
    const lines = sentences.map((s, si) => {
      const words = [];
      cw.forEach((w, i) => {
        if (w.si !== si) return;
        const t = times[i];
        words.push(Object.assign({ id: ids[i], text: w.text }, t ? { start: t.start, end: t.end, by: t.by } : {}));
      });
      const timed = words.filter(w => w.start != null);
      return Object.assign({ id: pre + 'l' + (lineStart + si), speaker: s.speaker || null, words },
        timed.length ? { start: timed[0].start, end: timed[timed.length - 1].end } : {});
    });

    // notes onto word ids: the span is looked for in the sentences (first match)
    const notes = [];
    for (const n of (cleaned && cleaned.notes) || []) {
      const span = (n.span || '').trim();
      let si = -1, k = -1;
      for (let i = 0; i < sentences.length && si < 0; i++) { const j = sentences[i].text.indexOf(span); if (span && j >= 0) { si = i; k = j; } }
      if (si < 0) { // a looser look: the span's words, ignoring punctuation and case
        const ns = norm(span);
        for (let i = 0; i < sentences.length && si < 0; i++) {
          const ws = cw.map((w, x) => [w, x]).filter(([w]) => w.si === i);
          for (let a = 0; a < ws.length && si < 0; a++) {
            let acc = '';
            for (let b = a; b < ws.length && acc.length < ns.length; b++) {
              acc += norm(ws[b][0].text);
              if (acc === ns) { si = i; k = ws[a][0].from; }
            }
          }
        }
      }
      const out = { kind: n.kind, span, why: n.why || '' };
      if (n.was != null) out.was = n.was;
      if (n.meant != null) out.meant = n.meant;
      if (si < 0) { out.placed = false; out.words = []; notes.push(out); continue; }
      const end = k + span.length;
      out.words = cw.map((w, i) => [w, i]).filter(([w]) => w.si === si && w.to > k && w.from < Math.max(end, k + 1)).map(([, i]) => ids[i]);
      if (n.kind === 'speaker_unclear') out.lines = [lines[si].id];
      out.placed = true;
      notes.push(out);
    }

    // which changes a note covers
    const noted = new Set(notes.flatMap(n => n.words));
    for (const ch of changes) {
      ch.noted = ch.words.some(i => noted.has(ids[i])) ||
        notes.some(n => n.was && norm(n.was).includes(norm(ch.was)) && norm(ch.was).length > 0);
      ch.ids = ch.words.map(i => ids[i]); delete ch.words;
      if (ch.after !== undefined) ch.after = ch.after >= 0 ? ids[ch.after] : null; // a drop: after this word (null = at the start)
    }

    const kept = times.filter(t => t && t.by === 'captions').length;
    const stats = {
      captionWords: captionWords.length, words: cw.length, kept,
      estimated: times.filter(t => t && t.by === 'estimated').length,
      untimed: times.filter(t => !t).length,
      fixes: changes.filter(c => c.kind === 'fix').length,
      spacing: changes.filter(c => c.kind === 'spacing').length,
      dropped: changes.filter(c => c.kind === 'dropped').reduce((a, c) => a + tokens(c.was).length, 0),
      added: changes.filter(c => c.kind === 'added').reduce((a, c) => a + tokens(c.now).length, 0),
      unnoted: changes.filter(c => !c.noted && c.kind !== 'spacing').length,
      notesUnplaced: notes.filter(n => !n.placed).length
    };
    return { lines, notes, changes, stats };
  }

  // Parts (one per chunk, in order) → a document in the brief's §2 shape.
  // A paragraph per speaker turn; notes carry their history from the start (rule 11).
  function toDoc(parts, meta) {
    meta = meta || {};
    const at = meta.at || new Date().toISOString();
    const doc = {
      id: meta.id || 'doc_clean', language: meta.language || '',
      media: meta.media || null,
      origin: { route: 'youtube_ai_cleanup', by: meta.by || 'creator', model: meta.model || '', created_at: at },
      blocks: [], lines: {}, notes: []
    };
    let last = null, nn = 0;
    for (const p of parts) {
      for (const l of p.lines) {
        doc.lines[l.id] = { speaker: l.speaker, start: l.start, end: l.end, words: l.words };
        if (last && last.speaker === l.speaker) last.block.lines.push(l.id);
        else { const block = { type: 'paragraph', lines: [l.id] }; doc.blocks.push(block); last = { speaker: l.speaker, block }; }
      }
      for (const n of p.notes) {
        if (!n.placed) continue;
        const note = { id: 'n' + (++nn), kind: n.kind, status: 'open', history: [{ at, by: 'ai', did: 'raised' }] };
        if (n.lines) note.lines = n.lines; else note.words = n.words;
        if (n.was != null) note.was = n.was;
        if (n.meant != null) note.text = n.meant;
        if (n.why) note.why = n.why;
        doc.notes.push(note);
      }
    }
    return doc;
  }

  const api = { reattach, toDoc, align, norm, alike };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CadenceClean = api;
})(typeof window !== 'undefined' ? window : globalThis);
