/* sample-reader-1/sr1-card.js — build stamp: sr1-card · 2026-10-12 (Contractor 17, RL).

   The word card from Card Machine 8, drawn as one more panel look ("card") for
   the profile in Sample reader 1. It reads the same profile snapshot the other
   looks read (profileSnapshot in sample-reader-1.html), so nothing about saving
   changes. What it adds to the snapshot comes from the "card" call: three
   meaning layers, the key form, the item's level and the page sentence's
   translation. Profiles saved before that call existed still draw, from the
   older fields.

   Settled on the card (claude/contractor-16-handoff.md §5, and Big T's notes on
   Card Machine 8, 2026-10-12):
     - flat, plain with bands; graphite when the reader is dark
     - page form above the headword with a plus/minus circle; the whole strip
       above the headword peeks the Full sentence panel on hover
     - the peek shows only "Full sentence" and the key words; no grab handle
     - the panel rises from behind, always from above; beside the card, or the
       card moves down, only when there is no room above
     - key words already bold and coloured; the rest merges in left to right
     - meaning: short, here, more, stepped by tap with dots top right
     - examples one at a time, centred, translation the same size, up-down cursor
*/
(function(){
"use strict";
var L = {};   // filled from window.LAB at each render

var CSS = [
".cm{position:relative;--ink:#1D1F1C;--bg:#fff;--band:hsla(210,62%,45%,.05);--line:hsla(210,12%,30%,.16);--hov:hsla(210,62%,40%,.08);",
"  --acct:hsl(210,62%,40%);--accbg:hsla(210,62%,48%,.12);--hwc:hsl(215,45%,38%);--sk:rgba(30,40,50,.07);",
"  --T:.42s;--ease:cubic-bezier(.2,.75,.2,1);--serif:'Source Serif 4',Georgia,serif;--sans:'Inter',system-ui,-apple-system,sans-serif;",
"  color:var(--ink);font:13px/1.45 var(--sans);text-align:left}",
".cm.cm-dark{--ink:#EEEAE2;--bg:radial-gradient(120% 90% at 30% 0%,#45464A,#222326 70%);--band:rgba(255,255,255,.045);--line:rgba(216,195,160,.22);",
"  --hov:rgba(255,255,255,.08);--acct:#D8C3A0;--accbg:rgba(216,195,160,.14);--hwc:#D8C3A0;--sk:rgba(255,255,255,.07)}",
".cm button{font:inherit;color:inherit;cursor:pointer}",
".cm-card{position:relative;z-index:2;border-radius:24px;background:var(--bg);overflow-x:hidden;overflow-y:auto;max-height:var(--pfmax,70vh);overscroll-behavior:contain;",
"  box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 28px -12px rgba(0,0,0,.28);transform:translateY(var(--push,0px));transition:transform var(--T) var(--ease)}",
".cm-dark .cm-card{box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 1px 2px rgba(0,0,0,.3),0 10px 28px -12px rgba(0,0,0,.6)}",
".cm-s{position:relative;padding:12px 18px}",
".cm-s.band{background:var(--band)}",
".cm-h{padding-top:10px}",
/* the strip above the headword: hover peeks, click opens */
".cm-top{display:flex;align-items:center;gap:7px;min-height:22px;margin:0 -18px 2px;padding:2px 18px 2px 62px;cursor:pointer}",
".cm-onp{font:italic 12px var(--serif);opacity:.55;transition:opacity .2s}",
".cm-top:hover .cm-onp,.cm-ps .cm-onp{opacity:.95}",
".cm-pl{width:15px;height:15px;border-radius:50%;box-shadow:inset 0 0 0 1px currentColor;display:inline-grid;place-items:center;font:500 12px/1 var(--sans);opacity:.6}",
".cm-top:hover .cm-pl{opacity:.9}",
".cm-hrow{display:flex;align-items:center;gap:10px}",
".cm-hwrap{display:flex;flex-direction:column;min-width:0}",
".cm-hline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
".cm .cm-hw{border:0;background:none;padding:0;text-align:left;font:600 34px/1.08 var(--serif);letter-spacing:-.012em;color:inherit;transition:color .35s,box-shadow .3s;overflow-wrap:anywhere}",
".cm-hw .car{display:inline-block;font:400 14px var(--sans);opacity:.3;margin-left:7px;vertical-align:.25em;transition:transform var(--T) var(--ease),opacity .3s}",
".cm-hw.on{color:var(--hwc)}.cm-hw.on .car{transform:rotate(90deg);opacity:.9}",
".cm-dark .cm-hw.on{color:inherit;box-shadow:inset 0 -2px 0 color-mix(in srgb,currentColor 50%,transparent)}",
".cm-lv{font:600 10.5px/1 var(--sans);letter-spacing:.04em;padding:4px 6px;border-radius:6px;background:var(--accbg);color:var(--acct);align-self:center}",
".cm-dark .cm-lv{background:none;box-shadow:inset 0 0 0 .75px var(--acct)}",
".cm-kl{font-size:12.5px;margin-top:3px;opacity:.75}.cm-kl small{font-size:10.5px;opacity:.6;margin-right:4px}",
".cm .cm-play{flex:none;width:34px;height:34px;border-radius:50%;border:0;background:none;box-shadow:inset 0 0 0 1.25px currentColor;display:grid;place-items:center;opacity:.75;transition:transform .2s var(--ease)}",
".cm-play:hover{transform:scale(1.08)}.cm-play svg{width:10px;height:10px;margin-left:2px}",
".cm-play.sm{width:24px;height:24px}.cm-play.sm svg{width:8px;height:8px}",
".cm-fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows var(--T) var(--ease)}",
".cm-fold>div{overflow:hidden;min-height:0}",
".cm-fold>div>*{opacity:0;transform:translateY(-6px);transition:opacity calc(var(--T)*.7) ease,transform var(--T) var(--ease)}",
".cm-fold.open{grid-template-rows:1fr}.cm-fold.open>div>*{opacity:1;transform:none;transition-delay:calc(var(--T)*.22)}",
".cm-det{padding-top:10px;font-size:12.5px;display:grid;gap:8px}",
".cm-facts{display:flex;flex-wrap:wrap;gap:6px 20px}",
".cm-facts small,.cm-tag{display:block;font:600 10px/1.3 var(--sans);letter-spacing:.07em;text-transform:uppercase;opacity:.5}",
".cm-ipa{opacity:.5;font-size:12px}",
".cm-m{padding-right:44px}",
".cm-l1{font:19px/1.3 var(--serif);cursor:pointer}",
".cm-l2>div>div{padding-top:3px;font-size:13.5px;opacity:.72}",
".cm-l3>div>div{padding-top:8px;font-size:13.5px;line-height:1.5}",
".cm-dots{position:absolute;top:16px;right:18px;display:flex;gap:5px}",
".cm .cm-dots button{border:0;padding:0;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.2;transition:opacity .3s,transform .3s}",
".cm-dots button.on{opacity:.7}.cm-dots button:hover{transform:scale(1.4)}",
".cm-ex{padding-top:16px;padding-bottom:10px}",
".cm-exrow{position:relative}",
".cm-sentbox{min-height:3.4em;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 30px;cursor:ns-resize}",
".cm-sent{font:15.5px/1.45 var(--serif)}",
".cm-sent b{font-weight:600;color:var(--acct)}",
".cm .pf-blank{color:transparent!important;background:var(--accbg);border-radius:3px;cursor:pointer}",
".cm .pf-blank.show{color:var(--acct)!important;background:none;font-weight:600}",
".cm-extr>div>div{font:15.5px/1.45 var(--serif);opacity:.68;padding:3px 30px 0;text-align:center}",
".cm .cm-side{position:absolute;top:50%;margin-top:-14px;width:28px;height:28px;border:0;border-radius:50%;background:none;font-size:16px;line-height:1;opacity:.55;transition:background .25s,opacity .25s}",
".cm-side:hover{opacity:1;background:var(--hov)}.cm-side.l{left:-6px}.cm-side.r{right:-6px}",
".cm-cnt{text-align:center;font-size:11.5px;opacity:.55;margin-top:8px;font-variant-numeric:tabular-nums}",
".cm-foot{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:8px 18px 12px;font-size:11px;opacity:.75;border-top:1px solid var(--line)}",
".cm .cm-foot button{border:0;background:none;padding:0;text-decoration:underline;text-underline-offset:2px;opacity:.85}",
".cm-foot label{display:flex;gap:4px;align-items:center;cursor:pointer}",
".cm-foot .warn{color:#a2453a}.cm-dark .cm-foot .warn{color:#e3a093}",
".cm-foot .sp{flex:1}",
".cm-alts{width:100%;display:grid;gap:4px;padding-top:4px}",
".cm .cm-alts button{text-decoration:none;text-align:left;padding:4px 8px;border-radius:8px;background:var(--hov)}",
".cm-fail{font-size:12px;opacity:.85}.cm .cm-fail button{border:0;background:none;padding:0;text-decoration:underline}",
/* loading: blur, then sharpen */
".cm-ld{filter:blur(5px);opacity:.35;user-select:none}",
".cm-in{animation:cmin .7s var(--ease) both}",
"@keyframes cmin{from{filter:blur(5px);opacity:.35}to{filter:none;opacity:1}}",
/* the Full sentence panel, behind the card */
".cm-xp{position:absolute;left:0;top:0;width:100%;z-index:1;border-radius:24px;background:var(--bg);color:var(--ink);pointer-events:none;",
"  box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 22px -12px rgba(0,0,0,.28);transition:transform var(--T) var(--ease)}",
".cm-xp.nt,.cm-card.nt{transition:none}",
".cm-xp .in{padding:14px 18px 14px}",
".cm-pshead{display:flex;align-items:center;gap:8px;min-height:24px}",
".cm-pshead .keys{font:italic 13px var(--serif);opacity:.8;transition:opacity .25s}",
".cm-ps .cm-pshead .keys{opacity:0}",
".cm-pshead .sp{flex:1}",
".cm-pss{font:15px/1.6 var(--serif);padding-top:6px}",
".cm-pss .k{font-weight:600;color:var(--acct)}",
".cm-pss .w{display:inline-block;white-space:pre;opacity:0}",
".cm-pss .w.on{opacity:1}",
".cm-pstr{font:15px/1.6 var(--serif);padding-top:6px;opacity:0;transition:opacity .6s ease}",
".cm-pstr.on{opacity:.7}",
"@media (prefers-reduced-motion:reduce){.cm *{transition-duration:.01ms!important;animation-duration:.01ms!important}}"
].join("\n");

var FONTS = false;
function setup(){
  if (FONTS) return; FONTS = true;
  var l = document.createElement("link"); l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap";
  document.head.appendChild(l);
  var s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s);
}

var PLAY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 0l9 5-9 5z" fill="currentColor"/></svg>';
var POOL = "aeiounrstlcdmphgbvy";
function gib(n){ var s = ""; for (var i = 0; i < n; i++) s += (i && i % 6 === 0) ? " " : POOL[Math.random() * POOL.length | 0]; return s; }
function ph(n, cls){ return '<span class="cm-ld ' + (cls || "") + '">' + gib(n) + "</span>"; }

/* What the card shows, from a snapshot. Older profiles fall back to their own fields. */
function headword(v){
  var it = v.item || "";
  if ((v.lang || "de") === "de" && /^noun$/i.test(v.pos || "") && v.gender && !/^(der|die|das)\s/i.test(it)) return v.gender + " " + it;
  return it;
}
function keyForm(v){
  if (v.key_form) return {label:v.key_label || "", form:v.key_form};
  if (v.plural && v.plural !== "no plural") return {label:"Plural", form:v.plural};
  if (v.participle) return {label:"Perfekt", form:v.participle};
  var f = (v.forms || [])[0]; if (f && f.form) return {label:f.label || "", form:f.form};
  return null;
}
function layers(v){
  return [v.short || v.meaning || "", v.here || v.gloss || "", v.more || v.note || ""].filter(function(x){ return x; });
}
function factsOf(v){
  var f = [];
  if (v.gender) f.push(["Gender", v.gender]);
  if (v.plural) f.push(["Plural", v.plural]);
  if (v.participle) f.push(["Perfekt", v.participle]);
  if (v.splits) f.push(["Splits", v.splits]);
  (v.forms || []).forEach(function(x){ if (x && x.form) f.push([x.label || "Form", x.form]); });
  if (v.countable) f.push(["Countable", v.countable]);
  return f;
}
function sentenceOf(live, note){ return (live && live.about && live.about.sentence) || (note && note.about && note.about.sentence) || ""; }

/* The page sentence as words, with the item's pieces found in order. */
function sentenceWords(sentence, pieces){
  var spans = [], from = 0;
  (pieces || []).forEach(function(pc){
    pc = String(pc || "").trim(); if (!pc) return;
    var f = L.findInSentence(sentence, pc, from); if (f){ spans.push(f); from = f[1]; }
  });
  var out = [], at = 0;
  function plain(t){ t.split(/(?<=\s)/).forEach(function(w){ if (w) out.push({k:false, t:w}); }); }
  spans.forEach(function(sp){ plain(sentence.slice(at, sp[0])); out.push({k:true, t:sentence.slice(sp[0], sp[1])}); at = sp[1]; });
  plain(sentence.slice(at));
  return out;
}

/* ── drawing ─────────────────────────────────────────────────────────── */
function build(box, v, states, live, note){
  var S = box._cm, ok = function(g){ return states[g] === "done"; };
  var dark = L.readerIsDark();
  var pieces = (v.pieces && v.pieces.length) ? v.pieces : [v.item || ""];
  var onp = L.esc(pieces.join(" … "));
  var sent = sentenceOf(live, note);
  var ws = sentenceWords(sent, pieces);
  var cardDone = ok("card"), gramDone = ok("grammar");

  var lv = cardDone && v.cefr ? '<span class="cm-lv">' + L.esc(v.cefr) + "</span>"
         : (states.card === "waiting" ? '<span class="cm-lv cm-ld">B1</span>' : "");
  var kf = keyForm(v);
  var kl = (cardDone || gramDone) && kf ? '<div class="cm-kl" data-g="card"><small>' + L.esc(kf.label) + "</small>" + L.esc(kf.form) + "</div>"
         : (states.card === "waiting" ? '<div class="cm-kl">' + ph(14) + "</div>" : "");
  var head = ok("item") ? L.esc(headword(v)) : ph(Math.max(4, (v.item || "word").length));
  var facts = factsOf(v);
  var det = '<div class="cm-det">'
    + (facts.length ? '<div class="cm-facts">' + facts.map(function(p){ return "<span><small>" + L.esc(p[0]) + "</small>" + L.esc(p[1]) + "</span>"; }).join("") + "</div>" : "")
    + (v.note && v.note !== v.more ? "<div>" + L.esc(v.note) + "</div>" : "")
    + (v.ipa ? '<div class="cm-ipa">' + L.esc(v.ipa) + "</div>" : "")
    + (!facts.length && !v.note && !v.ipa ? '<div style="opacity:.5">Nothing more on this word yet.</div>' : "") + "</div>";

  var LY = layers(v), meanReady = ok("item");
  S.l = Math.min(S.l, Math.max(1, LY.length));
  var dots = LY.length > 1 ? '<span class="cm-dots">' + LY.map(function(_, i){ return '<button data-cm="step" data-i="' + (i + 1) + '" class="' + (i < S.l ? "on" : "") + '" aria-label="Meaning, layer ' + (i + 1) + '"></button>'; }).join("") + "</span>" : "";
  var mean = meanReady
    ? dots + '<div class="cm-l1" data-cm="l1" data-g="item">' + L.esc(LY[0] || "") + "</div>"
      + '<div class="cm-fold cm-l2' + (S.l >= 2 ? " open" : "") + '"><div><div>' + L.esc(LY[1] || "") + "</div></div></div>"
      + '<div class="cm-fold cm-l3' + (S.l >= 3 ? " open" : "") + '"><div><div>' + L.esc(LY[2] || "") + "</div></div></div>"
    : '<div class="cm-l1">' + ph(16) + "</div>";

  var ex;
  if (states.ex === "failed") ex = '<div class="cm-fail">Examples didn’t load. <button data-cm="retry">Try again</button></div>';
  else if (!ok("ex") || !(v.examples || []).length) ex = '<div class="cm-sentbox"><span class="cm-sent">' + ph(30) + "</span></div><div class=\"cm-cnt\">&nbsp;</div>";
  else {
    var es = v.examples; S.ex = S.ex % es.length; var e = es[S.ex];
    ex = '<div class="cm-exrow"><button class="cm-side l" data-cm="prev" aria-label="Previous example">‹</button><button class="cm-side r" data-cm="next" aria-label="Next example">›</button>'
      + '<div class="cm-sentbox" data-cm="tapsent"><span class="cm-sent" data-g="ex">' + L.pfExampleHTML(e, live, S.ex, v) + "</span></div></div>"
      + '<div class="cm-fold cm-extr' + (S.extr ? " open" : "") + '"><div><div>' + L.esc(e.tr || "") + "</div></div></div>"
      + '<div class="cm-cnt">' + (S.ex + 1) + " of " + es.length + "</div>";
  }
  var fail1 = states.item === "failed" ? '<div class="cm-fail">The word didn’t load. <button data-cm="retry1">Try again</button></div>' : "";

  var n = live ? (live.noteId && L.noteById(live.noteId)) : note;
  var marked = n ? n.marked : !(live && live.markOff);
  var foot = '<div class="cm-foot">'
    + "<span>" + (n ? "saved" : live && !live.removed ? "saves when ready" : "not saved") + "</span>"
    + (live && live.alts && live.alts.length ? '<button data-cm="alts">other options (' + live.alts.length + ")</button>" : "")
    + ((v.companions || []).length && live ? (v.companions || []).map(function(c){ return '<button data-comp="' + L.esc(c) + '">add “' + L.esc(c) + '”</button>'; }).join("") : "")
    + '<label><input type="checkbox" data-cm="mark"' + (marked ? " checked" : "") + (live && live.removed ? " disabled" : "") + "> mark in text</label>"
    + ((v.examples || []).length ? '<button data-cm="blank">' + (L.pfBlanking() ? "show the word" : "hide the word") + "</button>" : "")
    + (n ? '<button class="warn" data-cm="remove">Remove</button>' : "")
    + '<span class="sp"></span><button data-cm="close">Close</button>'
    + (live && live.altsOpen ? '<div class="cm-alts">' + live.alts.map(function(x, i){
        return '<button data-alt="' + i + '"><b>' + L.esc(x.item) + "</b>" + (x.meaning ? " — " + L.esc(x.meaning) : "") + "</button>"; }).join("") + "</div>" : "")
    + "</div>";

  var trOn = !!v.sentence_tr;
  var xp = '<div class="cm-xp" aria-hidden="' + (S.ps ? "false" : "true") + '"><div class="in">'
    + '<div class="cm-pshead"><span class="cm-tag">Full sentence</span><span class="keys">' + onp + '</span><span class="sp"></span>'
    + '<button class="cm-play sm" data-cm="saypage" aria-label="Play the sentence">' + PLAY + "</button></div>"
    + '<div class="cm-pss">' + ws.map(function(w){ return '<span class="w' + (w.k ? " k on" : "") + '">' + L.esc(w.t) + "</span>"; }).join("") + "</div>"
    + '<div class="cm-pstr">' + (trOn ? L.esc(v.sentence_tr) : (states.card === "waiting" ? ph(40) : "")) + "</div>"
    + "</div></div>";

  return '<div class="cm' + (dark ? " cm-dark" : "") + (S.ps ? " cm-ps" : "") + '">' + xp
    + '<div class="cm-card">'
    + '<div class="cm-s cm-h band">' + fail1
    + '<div class="cm-top" data-cm="ps" title="Full sentence"><span class="cm-onp">' + onp + '</span><span class="cm-pl" aria-hidden="true">' + (S.ps ? "−" : "+") + "</span></div>"
    + '<div class="cm-hrow"><button class="cm-play" data-cm="say" aria-label="Play pronunciation">' + PLAY + "</button>"
    + '<div class="cm-hwrap"><div class="cm-hline"><button class="cm-hw' + (S.word ? " on" : "") + '" data-cm="word" data-g="item">' + head + '<span class="car">›</span></button>' + lv + "</div>" + kl + "</div></div>"
    + '<div class="cm-fold' + (S.word ? " open" : "") + '" data-f="word"><div>' + det + "</div></div>"
    + "</div>"
    + '<div class="cm-s cm-m">' + mean + "</div>"
    + '<div class="cm-s cm-ex band">' + ex + "</div>"
    + foot + "</div></div>";
}

/* ── the Full sentence panel: rises from behind, comes forward once clear ── */
function dur(){ return 420; }
function mode(box, H){
  var r = box.getBoundingClientRect();
  if (r.top > H + 16) return "above";
  if (window.innerWidth - r.right >= 320) return "side-r";
  if (r.left >= 320) return "side-l";
  return "push";
}
function place(box, state, instant){
  var root = box.querySelector(".cm"), xp = box.querySelector(".cm-xp"), card = box.querySelector(".cm-card");
  if (!xp) return;
  var H = xp.offsetHeight, head = xp.querySelector(".cm-pshead");
  var pk = head ? head.offsetTop + head.offsetHeight + 8 : 40;
  if (instant){ xp.classList.add("nt"); card.classList.add("nt"); }
  xp.style.pointerEvents = state === "hidden" ? "none" : "";
  clearTimeout(xp._z); xp.style.zIndex = 1;
  if (state === "open") xp._z = setTimeout(function(){ if (box._cm && box._cm.ps) xp.style.zIndex = 3; }, instant ? 0 : dur());
  var m = box._cm.mode = state === "hidden" ? (box._cm.mode || "above") : mode(box, H);
  card.style.setProperty("--push", "0px");
  if (m.indexOf("side") === 0){
    var right = m === "side-r", W = Math.min(300, box.offsetWidth - 24);
    xp.style.width = W + "px"; xp.style.top = "10px"; xp.style.left = right ? (box.offsetWidth - W - 10) + "px" : "10px";
    var d = state === "open" ? W + 22 : state === "peek" ? 44 : 0;
    xp.style.transform = "translateX(" + (right ? d : -d) + "px)" + (state === "hidden" ? " scale(.97)" : "");
  } else {
    xp.style.width = ""; xp.style.left = ""; xp.style.top = "0px";
    var dd = state === "open" ? H + 10 : state === "peek" ? pk : 0;
    if (m === "push"){ card.style.setProperty("--push", dd + "px"); xp.style.transform = state === "hidden" ? "scale(.97)" : "none"; }
    else xp.style.transform = "translateY(" + (-dd) + "px)" + (state === "hidden" ? " scale(.97)" : "");
  }
  if (instant){ void xp.offsetWidth; xp.classList.remove("nt"); card.classList.remove("nt"); }
  root.classList.toggle("cm-ps", state === "open");
  var pl = box.querySelector(".cm-pl"); if (pl) pl.textContent = state === "open" ? "−" : "+";
}
function wordsIn(box, on){
  var ws = Array.prototype.slice.call(box.querySelectorAll(".cm-pss .w:not(.k)"));
  var tr = box.querySelector(".cm-pstr");
  if (!on){ ws.forEach(function(w){ w.getAnimations && w.getAnimations().forEach(function(a){ a.cancel(); }); w.classList.remove("on"); }); if (tr) tr.classList.remove("on"); return; }
  var last = 0;
  ws.forEach(function(w, j){
    w.classList.add("on");
    if (w.animate) w.animate([{opacity:0, transform:"translateX(-3px)"}, {opacity:1, transform:"none"}],
      {duration:170, delay:120 + j * 14, easing:"cubic-bezier(.2,.75,.2,1)", fill:"backwards"});
    last = 120 + j * 14 + 170;
  });
  if (tr) setTimeout(function(){ if (box._cm && box._cm.ps) tr.classList.add("on"); }, last + 80);
}
function openPS(box){ var S = box._cm; if (S.ps) return; S.ps = true; S.peek = false; place(box, "open"); wordsIn(box, true); }
function closePS(box){ var S = box._cm; if (!S.ps) return; S.ps = false; wordsIn(box, false); place(box, "hidden"); }

/* ── wiring ─────────────────────────────────────────────────────────── */
function wire(box, v, live, note){
  var S = box._cm, root = box.querySelector(".cm");
  root.onclick = function(e){
    var al = e.target.closest("[data-alt]"); if (al){ L.pickAlt(+al.dataset.alt); return; }
    var cp = e.target.closest("[data-comp]"); if (cp){ L.addCompanion(cp.dataset.comp); return; }
    var bl = e.target.closest(".pf-blank"); if (bl){ e.stopPropagation(); bl.classList.toggle("show"); return; }
    if (!S.ps && e.target.closest(".cm-xp")){ openPS(box); return; }
    var b = e.target.closest("[data-cm]"); if (!b) return;
    var a = b.dataset.cm, es = v.examples || [];
    if (a === "ps") return S.ps ? closePS(box) : openPS(box);
    if (a === "say"){ if (!v.item) return; if ((v.lang || "de") !== "en") L.speakDE(v.item); else L.speakLines(L.audioLines(v), "en", b); return; }
    if (a === "saypage"){ var s = sentenceOf(live, note); if (s){ if ((v.lang || "de") !== "en") L.speakDE(s); else L.speakLines([s], "en", b); } return; }
    if (a === "word"){ S.word = !S.word; b.classList.toggle("on", S.word); box.querySelector('[data-f="word"]').classList.toggle("open", S.word); return; }
    if (a === "l1"){ S.l = S.l % Math.max(1, layers(v).length) + 1; return steps(box); }
    if (a === "step"){ S.l = +b.dataset.i; return steps(box); }
    if (a === "next" || a === "prev") return stepEx(box, v, live, a === "next" ? 1 : -1);
    if (a === "tapsent"){ if (String(getSelection()).trim()) return; S.extr = !S.extr; var f = box.querySelector(".cm-extr"); if (f) f.classList.toggle("open", S.extr); return; }
    if (a === "alts"){ if (live){ live.altsOpen = !live.altsOpen; L.paintProfile(); } return; }
    if (a === "retry1"){ if (live) L.runStage1(live); return; }
    if (a === "retry"){ if (live) L.runStage2(live); return; }
    if (a === "blank"){ L.saveL("pfblank", !L.pfBlanking()); redraw(box); return; }
    if (a === "close"){ box.className = ""; box.dataset.pfkey = ""; if (live && L.isLive(live)) L.dropLive(); L.labPaint(); return; }
    if (a === "remove"){
      var n = live ? (live.noteId && L.noteById(live.noteId)) : note; if (!n) return;
      L.removeNote(n.id);
      if (window.LabProfiles) LabProfiles.remove(sb, n.id);
      L.say("Profile removed: " + (v.item || n.term)); L.labPaint(); L.paintNotesCount();
      if (live){ live.noteId = null; live.saved = false; live.removed = true; redraw(box); }
      else { box.className = ""; box.dataset.pfkey = ""; }
    }
  };
  var mk = root.querySelector('[data-cm="mark"]');
  if (mk) mk.onchange = function(){
    var n = live ? (live.noteId && L.noteById(live.noteId)) : note;
    if (live) live.markOff = !mk.checked;
    if (n){ n.marked = mk.checked; L.saveNotes(); L.labPaint(); if (n.marked) L.reportMark(n); }
  };
  /* hover over the strip, or the peeking panel, shows the peek */
  var zone = function(el){ return !!(el && el.closest && el.closest(".cm-top,.cm-xp")); };
  root.onpointerover = function(e){
    if (e.pointerType === "touch" || S.ps || !zone(e.target)) return;
    clearTimeout(S.pt); if (!S.peek){ S.peek = true; place(box, "peek"); }
  };
  root.onpointerout = function(e){
    if (!S.peek || !zone(e.target) || zone(e.relatedTarget)) return;
    clearTimeout(S.pt); S.pt = setTimeout(function(){ S.peek = false; if (!S.ps) place(box, "hidden"); }, 160);
  };
  /* scroll: over the strip opens and folds, over the meaning steps, over the examples steps */
  root.onwheel = function(e){
    var sec = e.target.closest(".cm-top,.cm-xp") ? "ps" : e.target.closest(".cm-ex") ? "ex" : e.target.closest(".cm-m") ? "m" : null;
    if (!sec) return;
    e.preventDefault();
    var now = Date.now(); if (now - (S.wl || 0) < 380) return;
    S.wa = (S.ws === sec ? (S.wa || 0) : 0) + e.deltaY; S.ws = sec; if (Math.abs(S.wa) < 30) return;
    S.wl = now; var d = Math.sign(S.wa); S.wa = 0;
    if (sec === "ps") return d > 0 ? openPS(box) : closePS(box);
    if (sec === "ex") return stepEx(box, v, live, d);
    S.l = Math.max(1, Math.min(layers(v).length || 1, S.l + d)); steps(box);
  };
  var sx = null;
  root.onpointerdown = function(e){ if (e.pointerType !== "mouse" && e.target.closest(".cm-sentbox")) sx = e.clientX; };
  root.onpointerup = function(e){ if (sx == null) return; var dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) stepEx(box, v, live, dx < 0 ? 1 : -1); };
}
function steps(box){
  var S = box._cm;
  box.querySelectorAll(".cm-dots button").forEach(function(b){ b.classList.toggle("on", +b.dataset.i <= S.l); });
  var l2 = box.querySelector(".cm-l2"), l3 = box.querySelector(".cm-l3");
  if (l2) l2.classList.toggle("open", S.l >= 2); if (l3) l3.classList.toggle("open", S.l >= 3);
}
function stepEx(box, v, live, d){
  var S = box._cm, es = v.examples || []; if (es.length < 2 || S.swap) return;
  var el = box.querySelector(".cm-sent"); if (!el || !el.animate){ S.ex = (S.ex + d + es.length) % es.length; redraw(box); return; }
  S.swap = true; S.extr = false; var f = box.querySelector(".cm-extr"); if (f) f.classList.remove("open");
  el.animate([{transform:"none", opacity:1}, {transform:"translateX(" + (-d * 26) + "px)", opacity:0}], {duration:200, easing:"cubic-bezier(.4,0,1,1)", fill:"forwards"}).onfinish = function(){
    S.ex = (S.ex + d + es.length) % es.length;
    var e = es[S.ex];
    el.innerHTML = L.pfExampleHTML(e, live, S.ex, v);
    var t = box.querySelector(".cm-extr > div > div"); if (t) t.textContent = e.tr || "";
    var c = box.querySelector(".cm-cnt"); if (c) c.textContent = (S.ex + 1) + " of " + es.length;
    el.getAnimations().forEach(function(a){ a.cancel(); });
    el.animate([{transform:"translateX(" + (d * 26) + "px)", opacity:0}, {transform:"none", opacity:1}], {duration:240, easing:"cubic-bezier(.2,.75,.2,1)"}).onfinish = function(){ S.swap = false; };
  };
}
function redraw(box){ var a = box._cmArgs; if (a) render.apply(null, a); }

/* Build if needed, then bring every slot up to date. Same arguments as pfRender. */
function render(box, key, v, states, live, note, anchor, instant){
  L = window.LAB || L;
  setup();
  box._cmArgs = [box, key, v, states, live, note, anchor, true];
  var fresh = box.dataset.pfkey !== key || box.dataset.pflook !== "card";
  if (fresh){
    box.className = "on pf"; box.dataset.pinned = "";
    box.dataset.pfkey = key; box.dataset.pflook = "card";
    box._cm = {l:1, ex:0, extr:false, word:false, ps:false, peek:false, shown:{}};
    L.pfPlace(box, anchor);
  }
  var S = box._cm, scroll = box.querySelector(".cm-card") ? box.querySelector(".cm-card").scrollTop : 0;
  box.innerHTML = build(box, v, states, live, note);
  var cd = box.querySelector(".cm-card"); cd.scrollTop = scroll;
  /* a slot that has just arrived sharpens in */
  ["item","grammar","card","ex"].forEach(function(g){
    if (states[g] === "done" && S.shown[g] !== "done" && !instant)
      box.querySelectorAll('[data-g="' + g + '"]').forEach(function(el){ el.classList.add("cm-in"); });
    S.shown[g] = states[g];
  });
  place(box, S.ps ? "open" : S.peek ? "peek" : "hidden", true);
  if (S.ps) box.querySelectorAll(".cm-pss .w").forEach(function(w){ w.classList.add("on"); });
  if (S.ps && v.sentence_tr) box.querySelector(".cm-pstr").classList.add("on");
  wire(box, v, live, note);
}

window.cardRender = render;
})();
