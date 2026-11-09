// cadence-cleanup · 2026-11-09a — Contractor 22.
//
// "Clean up" in Cadence (timed-text brief §3, the quick route). The captions of
// the open text go to Gemini in parts, from the learner's own browser with their
// own key (the one the Reader Lab keeps). Each answer is turned back into timed
// words by cadence-clean.js, and the parts join into one document in the brief's
// shape (origin.route: youtube_ai_cleanup). Parts not cleaned yet stay as captions,
// so the page can be read while the rest is still being cleaned.
//
// Nothing is written to the account. The answers are kept in this browser
// (localStorage "cadence-clean:<text id>"), so a cleaned text opens again cleaned.
//
//   CadenceCleanup.plan(capDoc, words)        → [[fromLine, toLine], …] parts of whole caption lines
//   CadenceCleanup.load(id) / save(id, rec) / forget(id)
//   CadenceCleanup.build(capDoc, rec)         → { doc, done, total, firstUndoneLine, stats }
//   CadenceCleanup.run(capDoc, rec, opts)     → cleans the parts not done yet, one after another
//   CadenceCleanup.notesFor(doc, wordId)      → the AI notes on a word, for the tooltip
//   CadenceCleanup.key() / setKey(k)          → the Gemini key (shared with the Reader Lab)
//
// Needs CadenceClean (cadence-clean.js). Runs in the browser and in node (tests).
(function (root) {
  'use strict';
  const CC = root.CadenceClean || (typeof require === 'function' ? require('./cadence-clean.js') : null);

  const VERSION = 'cadence-cleanup · 2026-11-09a';
  const MODELS = [
    ['gemini-3.5-flash', 'Gemini 3.5 Flash', 'the one judged best on bench 1', [1.50, 9.00]],
    ['gemini-3.6-flash', 'Gemini 3.6 Flash', 'newer, half the price this year', [0.75, 3.75]],
    ['gemini-3.8-flash', 'Gemini 3.8 Flash', 'newest, often busy', [0.75, 3.75]],
    ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 'cheap, breaks rules more', [0.25, 1.50]]
  ];
  // Measured on bench 1: tokens per 10 minutes of speech, sent and returned.
  const TOKENS_IN_10 = 5800, TOK_OUT_10 = 3800;

  // Prompt v3 (claude/c22-bench2/prompt-v3.txt), with the language filled in.
  const PROMPT = `You clean up automatic YouTube captions for language learners. The learner reads the text while hearing the audio, so the text must stay what was actually said.

Language: {{language}}. The video: "{{title}}".
Who speaks: {{speakers}}

The captions below come from speech recognition. They have no reliable punctuation, sentence breaks or speakers, and some words are misheard.

Do this:
1. Split into sentences and punctuate them properly.
2. Mark who speaks each sentence with the speaker labels above ("S1", "S2", …). Questions and short reactions ("Mhm", "Ja") often belong to the other person. If you can't tell who speaks a sentence, give your best guess and add a "speaker_unclear" note.
3. Fix words the captions misheard: the speaker said one thing, the captions wrote another (a wrong word that sounds alike, a word split in two). Put the correct word in the text and add a "caption_fix" note with what the captions had.
4. Keep everything the speaker really said, as they said it: fillers (äh, ähm, mhm), repeats ("sehr sehr sehr"), restarts, broken grammar, dialect. Do NOT correct the speaker. When a speaker said something in a non-standard or wrong way, keep it and add a "meant" note with the standard way to say it.
5. When you are not sure whether the captions misheard or the speaker really said it that way, keep the caption words and add a "meant" note. Keeping is the safe choice.
6. When you can't make out what was said (the caption words make no sense and you can't tell the right words), keep the caption words and add an "unclear" note.
7. Don't add, drop, reorder or summarise words, except in a caption fix. Keep the word order exactly. Restarts and repeated words stay in the text.
8. Names: change a name only when you are sure who or what is meant: its spelling appears in the title or elsewhere in this text, or it is a well-known public person, place or organisation that clearly fits (e.g. a famous politician). Mark every changed name with a "name_fix" note. If you are not sure, keep the caption's spelling and add an "unclear" note saying it may be a misheard name. Never invent a name.
9. Sound tags in square brackets ([gelächter], [applaus], [musik]) stay exactly where they are, as they are.
10. Notes are only for real changes and real doubts. No notes for punctuation, capital letters or hyphens. In a caption_fix or name_fix, "was" must be the caption's exact words.

Return JSON only:
{
  "sentences": [ { "speaker": "S1", "text": "..." } ],
  "notes": [
    { "kind": "caption_fix", "span": "the corrected words exactly as in your text", "was": "the caption's words", "why": "short reason" },
    { "kind": "name_fix", "span": "the name exactly as in your text", "was": "the caption's words", "why": "who this is" },
    { "kind": "meant", "span": "words exactly as in your text", "meant": "the standard way to say it", "why": "short reason" },
    { "kind": "unclear", "span": "words exactly as in your text", "why": "short reason" },
    { "kind": "speaker_unclear", "span": "the whole sentence exactly as in your text", "why": "short reason" }
  ]
}
Every "span" must be copied exactly from one of your sentences. Write "why" in English, in a few words.

{{context}}Captions to clean:
"""
{{text}}
"""`;

  // ── the caption document, flattened ─────────────────────────────────────
  // Lines in reading order, each with its words (which carry caption times).
  function lineList(doc) {
    const out = [];
    for (const b of doc.blocks || []) for (const lid of b.lines || []) {
      const l = doc.lines[lid]; if (l && Array.isArray(l.words) && l.words.length) out.push({ lid, line: l });
    }
    return out;
  }

  // Parts of whole caption lines, about `target` words each, cut after a line
  // that ends a sentence (or at 1.5 × target, when the captions have no ends).
  function plan(doc, target) {
    target = target || 600;
    const L = lineList(doc), parts = [];
    let from = 0, n = 0;
    for (let i = 0; i < L.length; i++) {
      n += L[i].line.words.length;
      const last = L[i].line.words[L[i].line.words.length - 1].text;
      if ((n >= target && /[.?!…]["“”»]?$/.test(last)) || n >= target * 1.5) { parts.push([from, i + 1]); from = i + 1; n = 0; }
    }
    if (from < L.length) {
      if (parts.length && n < target * 0.3) parts[parts.length - 1][1] = L.length;
      else parts.push([from, L.length]);
    }
    return parts;
  }

  // ── what this browser remembers ─────────────────────────────────────────
  const KEY = id => 'cadence-clean:' + id;
  function load(id) { try { const v = localStorage.getItem(KEY(id)); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function save(id, rec) {
    try { localStorage.setItem(KEY(id), JSON.stringify(rec)); return true; }
    catch (e) { return false; } // full: the run goes on, only this browser's copy is incomplete
  }
  function forget(id) { try { localStorage.removeItem(KEY(id)); } catch (e) {} }

  // The Gemini key: the same slot the Reader Lab uses (it stores JSON).
  const LAB = 'vc.readerlab.';
  function labGet(k, d) { try { const v = localStorage.getItem(LAB + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function labSet(k, v) { try { localStorage.setItem(LAB + k, JSON.stringify(v)); } catch (e) {} }
  const key = () => labGet('aikey', '') || '';
  const setKey = k => labSet('aikey', String(k || '').trim());

  function newRecord(capDoc, o) {
    return { v: 1, build: VERSION, model: o.model, prompt: 'v3', speakers: o.speakers || '', target: o.target || 600,
      title: o.title || '', language: o.language || capDoc.language || '', parts: plan(capDoc, o.target || 600).map(([a, b]) => ({ from: a, to: b })),
      created_at: new Date().toISOString() };
  }

  // ── an answer → JSON ───────────────────────────────────────────────────
  function parseAnswer(text) {
    let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('no JSON in the answer');
    const j = JSON.parse(t.slice(a, b + 1));
    if (!Array.isArray(j.sentences)) throw new Error('the answer has no sentences');
    j.notes = Array.isArray(j.notes) ? j.notes : [];
    return j;
  }

  // "S1 = Maja Göpel (the host), S2 = Hendrik Wüst" → { S1: 'Maja Göpel', S2: 'Hendrik Wüst' }
  function speakerNames(line) {
    const out = {};
    String(line || '').replace(/\b(S\d+)\s*[=:]\s*([^,;(]+?)\s*(?=\(|,|;|$)/g, (m, s, n) => { out[s] = n.trim(); return m; });
    return out;
  }

  // ── build the document a reader shows ───────────────────────────────────
  function build(capDoc, rec) {
    const L = lineList(capDoc);
    const doc = { id: capDoc.id, language: rec.language || capDoc.language || '', media: capDoc.media,
      origin: { route: 'youtube_ai_cleanup', by: 'learner', model: rec.model, created_at: rec.created_at },
      speakers: speakerNames(rec.speakers), blocks: [], lines: {}, notes: [] };
    const stats = { parts: rec.parts.length, done: 0, failed: 0, fixes: 0, unnoted: 0, dropped: 0, added: 0, notes: 0 };
    let firstUndoneLine = null, nn = 0, lastSpeaker = null, block = null;
    const at = rec.created_at;
    const note = (kind, words, extra) => {
      const n = Object.assign({ id: 'n' + (++nn), kind, words, status: 'open', by: 'ai', history: [{ at, by: 'ai', did: 'raised' }] }, extra || {});
      doc.notes.push(n);
    };

    rec.parts.forEach((p, i) => {
      let parsed = null;
      if (p.raw) { try { parsed = parseAnswer(p.raw); } catch (e) { p.err = p.err || ('Could not read the answer: ' + e.message); } }
      if (!parsed) {
        // not cleaned (yet): the caption lines, as they were, one paragraph per caption paragraph
        if (p.err) stats.failed++;
        lastSpeaker = null; block = null;
        let cur = null;
        for (let k = p.from; k < p.to; k++) {
          const { lid, line } = L[k];
          if (firstUndoneLine == null) firstUndoneLine = lid;
          doc.lines[lid] = line;
          const capBlock = (capDoc.blocks || []).find(b => b.lines.includes(lid));
          if (!cur || cur.src !== capBlock) { cur = { src: capBlock, b: { type: 'paragraph', lines: [], raw: true } }; doc.blocks.push(cur.b); }
          cur.b.lines.push(lid);
        }
        return;
      }
      stats.done++;
      const capWords = [];
      for (let k = p.from; k < p.to; k++) capWords.push(...L[k].line.words);
      const r = CC.reattach(capWords, parsed, { idPrefix: 'c' + i + '-' });
      stats.fixes += r.stats.fixes; stats.unnoted += r.stats.unnoted; stats.dropped += r.stats.dropped; stats.added += r.stats.added;
      for (const l of r.lines) {
        const line = { words: l.words };
        if (l.speaker) line.speaker = l.speaker;
        if (l.start != null) { line.start = l.start; line.end = l.end; }
        doc.lines[l.id] = line;
        // a new paragraph at each change of speaker
        if (!block || l.speaker !== lastSpeaker) { block = { type: 'paragraph', lines: [] }; doc.blocks.push(block); lastSpeaker = l.speaker; }
        block.lines.push(l.id);
      }
      for (const n of r.notes) {
        if (!n.placed) continue;
        const extra = {};
        if (n.was != null) extra.was = n.was;
        if (n.meant != null) extra.text = n.meant;
        if (n.why) extra.why = n.why;
        if (n.lines) { extra.lines = n.lines; note(n.kind, [], extra); } else note(n.kind, n.words, extra);
        stats.notes++;
      }
      // changes the model made without saying so: shown too, so nothing changes silently
      for (const c of r.changes) {
        if (c.noted || c.kind === 'spacing') continue;
        if (c.kind === 'dropped') { if (c.after) note('dropped', [c.after], { was: c.was }); continue; }
        note(c.kind === 'added' ? 'added' : 'changed', c.ids, { was: c.was });
      }
    });
    return { doc, done: stats.done, total: rec.parts.length, firstUndoneLine, stats };
  }

  // the AI notes on one word, for the tooltip and the marks
  function notesFor(doc, wid) {
    if (!doc || !doc.notes) return [];
    const lid = Object.keys(doc.lines).find(k => doc.lines[k].words.some(w => w.id === wid));
    return doc.notes.filter(n => (n.words || []).includes(wid) || (lid && (n.lines || []).includes(lid)));
  }

  // ── asking Gemini, from the browser ─────────────────────────────────────
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  // How to switch thinking off differs by model; the first shape a model accepts is remembered.
  const SHAPES = [{ thinkingConfig: { thinkingBudget: 0 } }, { thinkingConfig: { thinkingLevel: 'low' } }, {}];
  const shapeFor = {};
  async function ask(prompt, model, k, signal) {
    const auth = labGet('aiauth', 'header');
    for (let s = shapeFor[model] || 0, tries = 0; s < SHAPES.length; ) {
      let url = BASE + encodeURIComponent(model) + ':generateContent';
      const headers = { 'Content-Type': 'application/json' };
      if (auth === 'query') url += '?key=' + encodeURIComponent(k);
      else if (auth === 'bearer') headers.Authorization = 'Bearer ' + k;
      else headers['x-goog-api-key'] = k;
      const t0 = Date.now();
      const res = await fetch(url, { method: 'POST', headers, signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
          generationConfig: Object.assign({ temperature: 0.2, responseMimeType: 'application/json' }, SHAPES[s]) }) });
      let j = null; try { j = await res.json(); } catch (e) {}
      if (res.ok) {
        shapeFor[model] = s;
        const text = ((j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
          .filter(p => !p.thought).map(p => p.text || '').join('');
        return { text, usage: (j && j.usageMetadata) || null, ms: Date.now() - t0 };
      }
      const msg = (j && j.error && j.error.message) || ('HTTP ' + res.status);
      if (res.status === 400 && /thinking/i.test(msg) && s < SHAPES.length - 1) { s++; continue; }
      if ((res.status === 429 || res.status === 503) && tries < 2) { tries++; await sleep(tries * 4000, signal); continue; }
      const e = new Error(res.status === 429 ? 'Too many requests for this key right now (429). Wait a minute and press Clean up again.'
        : res.status === 503 ? 'Gemini is busy (503). Try again in a while, or pick another model.'
        : /api key|API_KEY|UNAUTHENTICATED|PERMISSION/i.test(msg) ? 'Google refused the key: ' + msg
        : msg);
      e.status = res.status; e.fatal = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
      throw e;
    }
    throw new Error('The model refused every way of asking.');
  }
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Stopped', 'AbortError')); }, { once: true });
  });

  function langName(code) {
    if (!code) return 'the language of the captions (probably German)';
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (e) { return code; }
  }

  function promptFor(capDoc, rec, i) {
    const L = lineList(capDoc), p = rec.parts[i];
    const text = L.slice(p.from, p.to).map(x => x.line.words.map(w => w.text).join(' ')).join(' ');
    let ctx = '';
    const prev = rec.parts[i - 1];
    if (prev && prev.raw) {
      try {
        const s = parseAnswer(prev.raw).sentences.slice(-2);
        if (s.length) ctx += 'The part before, already cleaned (context only, do not return it):\n' + s.map(x => `${x.speaker}: ${x.text}`).join('\n') + '\n\n';
      } catch (e) {}
    }
    const next = [];
    for (let k = p.to; k < L.length && next.length < 12; k++) for (const w of L[k].line.words) { if (next.length < 12) next.push(w.text); }
    if (next.length) ctx += `The captions go on with (context only, do not clean): "${next.join(' ')} …"\n\n`;
    return PROMPT.replaceAll('{{language}}', langName(rec.language)).replaceAll('{{title}}', rec.title || '')
      .replaceAll('{{speakers}}', rec.speakers || 'S1 = the first voice, S2 = the second, and so on.')
      .replaceAll('{{context}}', ctx).replaceAll('{{text}}', text);
  }

  // Clean the parts that aren't done, in order, starting at opts.startPart.
  // opts: { key, signal, startPart, onPart(i, rec), onError(i, err, rec) }
  async function run(capDoc, rec, opts) {
    const order = [];
    const start = Math.max(0, Math.min(rec.parts.length - 1, opts.startPart || 0));
    for (let i = start; i < rec.parts.length; i++) order.push(i);
    for (let i = 0; i < start; i++) order.push(i);
    for (const i of order) {
      const p = rec.parts[i];
      if (p.raw && !p.err) continue;
      if (opts.signal && opts.signal.aborted) return;
      try {
        const out = await ask(promptFor(capDoc, rec, i), rec.model, opts.key, opts.signal);
        parseAnswer(out.text); // throws if unreadable: kept as an error, tried again next time
        p.raw = out.text; p.usage = out.usage; p.ms = out.ms; p.at = new Date().toISOString(); delete p.err;
        if (opts.onPart) opts.onPart(i, rec);
      } catch (e) {
        if (e.name === 'AbortError') return;
        p.err = e.message || String(e);
        if (opts.onError) opts.onError(i, e, rec);
        if (e.fatal || e.status === 429 || e.status === 503) return; // asking again now won't help
      }
    }
  }

  // Rough cost of cleaning a text, from its length, at paid prices (the free tier costs nothing).
  function estimate(capDoc, model) {
    const L = lineList(capDoc);
    let first = null, last = null, words = 0;
    for (const { line } of L) for (const w of line.words) { words++; if (typeof w.start === 'number') { if (first == null) first = w.start; last = w.end; } }
    const minutes = first != null ? (last - first) / 60000 : words / 160;
    const m = MODELS.find(x => x[0] === model);
    const cents = m ? (minutes / 10) * (TOKENS_IN_10 * m[3][0] + TOK_OUT_10 * m[3][1]) / 1e6 * 100 : null;
    return { minutes, words, cents };
  }

  const api = { VERSION, MODELS, PROMPT, plan, load, save, forget, key, setKey, newRecord, build, notesFor, run, estimate, parseAnswer, speakerNames, promptFor, lineList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CadenceCleanup = api;
})(typeof window !== 'undefined' ? window : globalThis);
