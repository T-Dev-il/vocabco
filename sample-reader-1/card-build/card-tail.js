
/* ════════ the reader's seams (Contractor 17) ════════ */
const NOISE = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .55  0 0 0 0 .5  0 0 0 0 .42  0 0 0 .18 0"/></filter><rect width="160" height="160" filter="url(#n)"/></svg>')}")`;
const WT = '<button data-act="mini" aria-label="Minimise the card" title="Minimise"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 6h7"/></svg></button>'
  + '<button data-act="close" aria-label="Close the card" title="Close (Esc)"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>';
const LANGCODE = {English:"EN", German:"DE", French:"FR", Spanish:"ES", Italian:"IT", Portuguese:"PT", Dutch:"NL", Polish:"PL",
  Czech:"CS", Swedish:"SV", Danish:"DA", Norwegian:"NO", Finnish:"FI", Greek:"EL", Turkish:"TR", Ukrainian:"UK", Russian:"RU",
  Romanian:"RO", Hungarian:"HU", Hebrew:"HE", Arabic:"AR", Persian:"FA", Hindi:"HI", Chinese:"ZH", Japanese:"JA", Korean:"KO",
  Vietnamese:"VI", Thai:"TH", Indonesian:"ID"};
const QUESTIONS = {
  de: [["Why this form here?"], ["Other meanings?"], ["Is it formal or casual?"], ["Similar words?"]],
  en: [["Why this form here?"], ["Other meanings?"], ["Is it formal or casual?"], ["Similar words?"]]};

function onpText(x){ return tokens(x).filter(t => t.k).map(t => t.t).join(" … "); }

/* what the card shows, from the reader's profile snapshot */
function headword(v){
  const it = v.item || "";
  if ((v.lang || "de") === "de" && /^noun$/i.test(v.pos || "") && v.gender && !/^(der|die|das)\s/i.test(it)) return v.gender + " " + it;
  return it;
}
function keyForm(v){
  if (v.key_form) return {label: v.key_label || "", form: v.key_form};
  if (v.plural && v.plural !== "no plural") return {label: "Plural", form: v.plural};
  if (v.participle) return {label: "Perfekt", form: v.participle};
  const f = (v.forms || [])[0]; if (f && f.form) return {label: f.label || "", form: f.form};
  return null;
}
function factsOf(v){
  const f = [];
  if (v.gender) f.push(["Gender", v.gender]);
  if (v.plural) f.push(["Plural", v.plural]);
  if (v.participle) f.push(["Perfekt", v.participle]);
  if (v.splits) f.push(["Splits", v.splits]);
  (v.forms || []).forEach(x => { if (x && x.form) f.push([x.label || "Form", x.form]); });
  if (v.countable) f.push(["Countable", v.countable]);
  if (v.register && v.register !== "neutral") f.push(["Register", v.register]);
  return f;
}
function sentenceOf(live, note, v){
  return (live && live.about && live.about.sentence) || (note && note.about && note.about.sentence) || v.sentence || "";
}
/* the sentence as HTML, with the item's pieces in <b>, found in order */
function markSentence(sentence, pieces){
  let h = "", at = 0, from = 0;
  (pieces || []).forEach(pc => {
    pc = String(pc || "").trim(); if (!pc) return;
    const f = LB.findInSentence ? LB.findInSentence(sentence, pc, from) : null;
    if (!f) return;
    h += esc(sentence.slice(at, f[0])) + "<b>" + esc(sentence.slice(f[0], f[1])) + "</b>"; at = from = f[1];
  });
  return h + esc(sentence.slice(at));
}
function toItem(v, live, note, states){
  const lang = v.lang || "de", learner = v.learnerLang || "English";
  const itemDone = states.item === "done";
  const term = (live && live.about && live.about.term) || (note && note.about && note.about.term) || v.item || "";
  const pieces = (v.pieces && v.pieces.length) ? v.pieces : [term];
  const sentence = sentenceOf(live, note, v);
  const kf = keyForm(v);
  const cardWait = states.card === "waiting";
  const more = v.more || (v.note && v.note !== v.here ? v.note : "") || "";
  const prov = !itemDone && !!QT.term;
  const l1 = itemDone ? (v.short || v.meaning || "") : (QT.term || "");
  const m = [esc(l1 || "a short meaning"),
             esc(v.here || v.gloss || (cardWait ? "what it means in this sentence, in one plain line" : "")),
             esc(more || (cardWait ? "a little more on how it is used, in two or three short sentences" : ""))];
  const ex = (v.examples || []).length
    ? v.examples.map((e, i) => [LB.pfExampleHTML ? LB.pfExampleHTML(e, live, i, v) : esc(String(e.text || "").replace(/\*\*/g, "")), esc(e.tr || "")])
    : [["Ein kurzer Beispielsatz wird gerade geschrieben.", ""]];
  return {
    item: esc(itemDone ? headword(v) : term), voice: lang === "en" ? "en-GB" : "de-DE",
    level: esc(v.cefr || (cardWait ? "B1" : "")), freq: 0,
    yours: LANGCODE[learner] || String(learner).slice(0, 2).toUpperCase(),
    key: kf ? [[esc(kf.label), esc(kf.form)]] : (cardWait ? [["Plural", "die Formen"]] : null),
    m: {yours: m, target: m},
    psent: markSentence(sentence, pieces), sentence: sentence,
    ptr: esc(v.sentence_tr || QT.sent || ""),
    facts: factsOf(v).map(p => [esc(p[0]), esc(p[1])]),
    note: v.note && v.note !== more ? esc(v.note) : "", ipa: esc(v.ipa || ""),
    examples: ex, qa: QUESTIONS[lang] || QUESTIONS.de, prov: prov, pic: null
  };
}
function readyOf(states, v){
  const itemDone = states.item === "done";
  const cardBack = states.card !== undefined ? states.card !== "waiting" : states.grammar !== "waiting";
  return { z: true, a: itemDone || !!QT.term, b: itemDone && cardBack, c: states.ex !== "waiting" && (v.examples || []).length > 0,
           t: !!(v.sentence_tr || QT.sent) || (itemDone && cardBack) };
}

/* loading, driven by the calls: a slot that is not back yet is blurred
   placeholder text of about the right length; it sharpens the moment it lands */
function applySlots(ready, anim){
  const mode = S.style === "hand" && S.lmode !== "shimmer" ? "write" : S.lmode;
  const cover = el => { el.dataset.src = el.innerHTML;
    if (mode === "shimmer") el.classList.add("ld");
    else if (mode === "blur"){ el.innerHTML = gib(el.dataset.src); el.classList.add("ldb"); }
    else el.classList.add("ldh"); };
  ["z", "a", "b", "c", "t"].forEach(sl => {
    const els = $$(`[data-slot="${sl}"]`, mach);
    const key = sl === "a" && CUR.prov ? "prov" : "real";
    if (!ready[sl]){ els.forEach(cover); return; }
    if (anim && ARR[sl] !== key){ els.forEach(cover); arrive(sl); }
    ARR[sl] = key;
  });
  U.loading = !ready.c;
}
function failBanners(states){
  const put = (sel, html) => { const s = $(sel, mach); if (s) s.insertAdjacentHTML("afterbegin", '<div class="fail">' + html + "</div>"); };
  if (states.item === "failed") put(".s.h", 'The word didn’t load. <button data-act="retry1">Try again</button>');
  else if (states.ex === "failed") put(".s.ex", 'The examples didn’t load. <button data-act="retry2">Try again</button>');
}

/* the lab's controls, folded into the foot */
function FOOT(){
  const live = LIVE, note = NOTE, v = SNAP || {};
  const n = live ? (live.noteId && LB.noteById(live.noteId)) : note;
  const marked = n ? n.marked : !(live && live.markOff);
  const state = n ? "saved" : live && !live.removed ? "saves when ready" : "not saved";
  const alts = live && live.alts && live.alts.length ? live.alts : [];
  return `<div class="foot${U.foot ? " open" : ""}"><button class="ft" data-act="foot"><span>${state}</span><span class="sp"></span><span>${U.foot ? "less" : "more"} ▾</span></button><div class="fb">`
    + (alts.length ? `<div class="alts">${alts.map((a, i) => `<button data-act="alt" data-i="${i}"><b>${esc(a.item)}</b>${a.meaning ? " — " + esc(a.meaning) : ""}</button>`).join("")}</div>` : "")
    + (live ? (v.companions || []).map(c => `<button data-act="comp" data-c="${esc(c)}">add “${esc(c)}”</button>`).join("") : "")
    + `<label><input type="checkbox" data-mark${marked ? " checked" : ""}${live && live.removed ? " disabled" : ""}> mark in text</label>`
    + ((v.examples || []).length ? `<button data-act="blank">${LB.pfBlanking && LB.pfBlanking() ? "show the word in examples" : "hide the word in examples"}</button>` : "")
    + (n ? '<button class="warn" data-act="remove">Remove</button>' : "")
    + `<span class="meta">${live ? esc(live.model || "") + (live.times && live.times.s1 ? " · first answer " + live.times.s1 + " ms" : "") : note ? esc(new Date(note.when).toLocaleDateString()) + " · " + esc(v.model || "") : ""}</span>`
    + "</div></div>";
}
function LABACT(a, b, e){
  if (a === "d-word" && U.mini){ U.mini = false; mach.classList.remove("mini"); return true; }
  if (a === "mini"){ U.mini = !U.mini; mach.classList.toggle("mini", U.mini); if (U.mini && U.ps){ U.ps = false; placeXP("hidden", true); upd(); } return true; }
  if (a === "close"){ closeCard(); return true; }
  if (a === "foot"){ U.foot = !U.foot; const f = $(".foot", mach); f.classList.toggle("open", U.foot); f.querySelector(".ft span:last-child").textContent = (U.foot ? "less" : "more") + " ▾"; return true; }
  if (a === "alt"){ LB.pickAlt(+b.dataset.i); return true; }
  if (a === "comp"){ LB.addCompanion(b.dataset.c); return true; }
  if (a === "blank"){ LB.saveL("pfblank", !LB.pfBlanking()); refresh(); return true; }
  if (a === "retry1"){ if (LIVE) LB.runStage1(LIVE); return true; }
  if (a === "retry2"){ if (LIVE) LB.runStage2(LIVE); return true; }
  if (a === "remove"){
    const n = LIVE ? (LIVE.noteId && LB.noteById(LIVE.noteId)) : NOTE; if (!n) return true;
    LB.removeNote(n.id); if (window.LabProfiles) LabProfiles.remove(typeof sb !== "undefined" ? sb : null, n.id);
    LB.say("Profile removed: " + (SNAP.item || n.term)); LB.labPaint(); LB.paintNotesCount();
    if (LIVE){ LIVE.noteId = null; LIVE.saved = false; LIVE.removed = true; refresh(); } else closeCard();
    return true;
  }
  return false;
}
ON("change", e => {
  if (!e.target.matches("[data-mark]")) return;
  const n = LIVE ? (LIVE.noteId && LB.noteById(LIVE.noteId)) : NOTE;
  if (LIVE) LIVE.markOff = !e.target.checked;
  if (n){ n.marked = e.target.checked; LB.saveNotes(); LB.labPaint(); if (n.marked) LB.reportMark(n); }
});
function closeCard(){
  if (!BOX) return;
  BOX.className = ""; BOX.dataset.pfkey = ""; BOX.dataset.pflook = ""; BOX.innerHTML = ""; BOX.style.width = "";
  if (LIVE && LB.isLive(LIVE)) LB.dropLive();
  LB.labPaint(); ARGS = null;
}
/* Ask, for real: the word, its sentence and the question go to the AI */
async function askReal(q){
  q = Array.isArray(q) ? q[0] : q;
  const a = $("#ans"); if (!a) return;
  a.innerHTML = '<span class="dots3"><i></i><i></i><i></i></span>';
  const v = SNAP || {}, lang = (v.lang || "de") === "en" ? "English" : "German", learner = v.learnerLang || "English";
  const p = "A learner of " + lang + " is reading this sentence: \"" + (CUR.sentence || "") + "\"\n"
    + "They are looking at \"" + (v.item || "") + "\" (" + (v.pos || "") + "), meaning here: \"" + (v.meaning || "") + "\".\n"
    + "Their question: " + q + "\n\n"
    + "Answer in " + learner + ", plainly, in at most three short sentences. Use " + lang + " examples only where they help. No headings, no lists.";
  const r = await LB.askAI(p, {});
  const box = $("#ans"); if (!box) return;
  if (r.err){ box.innerHTML = '<span class="err">' + esc(String(r.err).split("\n")[0]) + "</span>"; return; }
  U.ans = esc(String(r.text || "").trim()).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>"); box.innerHTML = U.ans;
}
/* the quick translation: Google's, in under a second, while the AI works */
async function quick(live){
  const run = live.run; if (QT.run === run) return; QT = {run: run};
  const v = SNAP || {}, lang = live.lang || v.lang || "de", learner = v.learnerLang || "English";
  const tl = (LANGCODE[learner] || "EN").toLowerCase();
  const term = live.about && live.about.term, sent = live.about && live.about.sentence;
  const g = async q => { try{ const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + lang + "&tl=" + tl + "&dt=t&q=" + encodeURIComponent(q));
    const j = await r.json(); return (j[0] || []).map(x => x[0]).join(""); }catch(e){ return ""; } };
  const res = await Promise.all([term ? g(term) : "", sent ? g(sent) : ""]);
  if (QT.run !== run) return;
  QT.term = res[0]; QT.sent = res[1]; refresh();
}
/* the reader's page colour: the card's look follows it, as in Card Machine */
function readPage(){
  let el = document.querySelector(".reader-fs.on, .reader-fs:not([hidden]) .reader-render, .reader-wrap") || document.body, c = "";
  while (el){ c = getComputedStyle(el).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) break; el = el.parentElement; }
  const m = (c || "rgb(255,255,255)").match(/\d+(\.\d+)?/g) || [255, 255, 255], rgb = m.slice(0, 3).map(Number);
  READER.rgb = rgb; READER.css = "rgb(" + rgb.join(",") + ")";
  READER.dark = (.299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2]) / 255 < .45;
  PAGERGB.reader = rgb; if (READER.dark) DARKCOLS.add("reader"); else DARKCOLS.delete("reader");
  S.col = "reader"; S.surf = "flat";
}
let SETUP = false;
function setupOnce(){
  if (SETUP) return; SETUP = true;
  const l = document.createElement("link"); l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Architects+Daughter&display=swap";
  document.head.appendChild(l);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && BOX && BOX.dataset.pflook === "card2" && BOX.classList.contains("on")) closeCard(); });
}
function mount(box){
  box.innerHTML = ""; box.style.width = S.width + "px";
  const host = document.createElement("div"); box.appendChild(host);
  R = host.attachShadow({mode: "open"});
  R.innerHTML = "<style>" + CSS + '</style><div class="stage" hidden></div><div class="mach" id="mach"></div>';
  host.style.setProperty("--noise", NOISE);
  stage = R.querySelector(".stage"); mach = R.getElementById("mach");
  HANDLERS.forEach(h => mach.addEventListener(h[0], h[1], h[2]));
  box._cmHost = host;
}
function refresh(){ if (ARGS){ SIG = ""; cardRender.apply(null, ARGS); } }

/* Same arguments as the reader's pfRender. */
function cardRender(box, key, v, states, live, note, anchor, instant){
  LB = window.LAB || LB;
  ARGS = [box, key, v, states, live, note, anchor, true];
  BOX = box; LIVE = live; NOTE = note; SNAP = v; STATES = states;
  setupOnce();
  const fresh = box.dataset.pfkey !== key || box.dataset.pflook !== "card2" || !box._cmHost || !box.contains(box._cmHost);
  if (fresh){
    const sameRun = live && QT.run === live.run;
    box.className = "on pf"; box.dataset.pinned = ""; box.dataset.pfkey = key; box.dataset.pflook = "card2";
    resetU(); U.foot = false; U.mini = false; ARR = {}; SIG = ""; if (!sameRun) QT = {};
    mount(box);
    LB.pfPlace(box, anchor);
  }
  if (live && !instant) quick(live);
  readPage();
  CUR = toItem(v, live, note, states);
  const sig = JSON.stringify([CUR, states, S, U.foot, LB.pfBlanking && LB.pfBlanking(), live && [live.noteId, live.removed, live.markOff, live.alts && live.alts.length], note && note.marked]);
  if (sig === SIG) return; SIG = sig;
  box.style.width = S.width + "px";
  render();
  mach.classList.toggle("mini", !!U.mini);
  failBanners(states);
  applySlots(readyOf(states, v), !instant);
  if (U.ps){ $$("#pss .w", mach).forEach(w => w.classList.remove("dim", "hide")); const t = $("#pstr", mach); if (t) t.classList.add("on"); }
}

/* the look: Big T's Card Machine settings, kept in this browser */
const LSK = "vc.readerlab.cardlook";
function loadLook(){ try{ const j = JSON.parse(localStorage.getItem(LSK) || "null"); if (j) Object.keys(DEF).forEach(k => { if (k in j) S[k] = j[k]; }); }catch(e){} }
function saveLook(){ try{ localStorage.setItem(LSK, JSON.stringify(S)); }catch(e){} }
loadLook();
window.cardLook = {
  get: () => Object.assign({}, S),
  set: patch => { Object.assign(S, patch); saveLook(); refresh(); },
  paste: raw => {
    const j = JSON.parse(String(raw).slice(String(raw).indexOf("{")));
    const src = j.current || j;
    Object.keys(DEF).forEach(k => { if (k !== "col" && k !== "surf" && k in src) S[k] = src[k]; });
    saveLook(); refresh(); return true;
  },
  reset: () => { Object.keys(DEF).forEach(k => S[k] = DEF[k]); saveLook(); refresh(); }
};
window.cardRender = cardRender;
})();
