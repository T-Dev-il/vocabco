/* practice/compile.js — build stamp: compile · 2026-10-12 (Contractor 17, RL).

   The compiler, first rough version. Saved profiles come in, in whatever shape
   the reader saved them; one practice item per profile comes out, always the
   same shape, so every game reads the same thing:

     { id, lang, item, head, article, pos, meaning, here, more,
       key:{label, form} | null, cefr, examples:[{text, marked, pieces, tr}],
       sentence, sentence_tr, textId, when }

   GAMES says what each game needs. A game says which items fit it and why the
   others do not; a new game is one more entry here plus its page. The batch the
   learner picked goes to the game as a deck in this browser
   (localStorage "vc.practice.deck"), so nothing is pasted. */
(function(){
"use strict";

function normalize(r){
  var p = r.profile || {}, lang = p.lang || r.lang || "de";
  var raw = String(p.item || r.item || "").trim();
  var noun = /^noun$/i.test(p.pos || "");
  var g = String(p.gender || "").toLowerCase().trim();
  var article = lang === "de" && noun && /^(der|die|das)$/.test(g) ? g : "";
  var bare = article ? raw.replace(/^(der|die|das)\s+/i, "") : raw;
  var key = p.key_form ? {label: p.key_label || "", form: p.key_form}
          : (p.plural && p.plural !== "no plural") ? {label: "Plural", form: p.plural}
          : p.participle ? {label: "Perfekt", form: p.participle}
          : ((p.forms || [])[0] && p.forms[0].form) ? {label: p.forms[0].label || "", form: p.forms[0].form} : null;
  var examples = (p.examples || []).filter(function(e){ return e && e.text; }).map(function(e){
    var marked = String(e.text), text = marked.replace(/\*\*/g, "");
    var pieces = (e.pieces && e.pieces.length) ? e.pieces
               : (marked.match(/\*\*(.+?)\*\*/g) || []).map(function(x){ return x.slice(2, -2); });
    return {text: text, marked: marked, pieces: pieces, tr: e.tr || ""};
  });
  return {
    id: r.note_id || r.id, lang: lang, item: bare, head: article ? article + " " + bare : bare,
    article: article, pos: p.pos || "",
    meaning: p.short || p.meaning || "", here: p.here || p.gloss || "", more: p.more || p.note || "",
    key: key, cefr: p.cefr || "", examples: examples,
    sentence: p.sentence || (r.about && r.about.sentence) || "", sentence_tr: p.sentence_tr || "",
    textId: r.text_id || r.textId || "", when: r.created_at ? Date.parse(r.created_at) : (r.when || 0)
  };
}

var GAMES = [
  { id: "flashcards", name: "Flashcards", url: "flashcards.html",
    about: "The word on one side, its meaning and an example on the other. Either direction.",
    needs: "a meaning",
    fits: function(x){ return !!(x.head && x.meaning); } },
  { id: "articles", name: "der, die, das", url: "articles.html",
    about: "Beat the clock: pick the article for each noun. Your old gender game, fed with your own nouns.",
    needs: "a German noun with its article",
    fits: function(x){ return x.lang === "de" && !!x.article; } },
  { id: "list", name: "Recall list", url: "list.html",
    about: "Your list game: see the meaning, recall the word, then check it in the examples.",
    needs: "a meaning",
    fits: function(x){ return !!(x.head && x.meaning); },
    /* the list game's own row shape (word, targets, examples) */
    rows: function(items){ return items.map(function(x){
      return { cue: x.meaning, targets: [x.head],
        examples: x.examples.map(function(e){ return e.text + (e.tr ? "  —  " + e.tr : ""); }) }; }); } }
];

function fitsOf(items){
  return GAMES.map(function(g){
    var ok = items.filter(g.fits);
    return {game: g, items: ok, count: ok.length, total: items.length};
  });
}
function sendDeck(game, items, title){
  var deck = {game: game.id, title: title || "My words", made: Date.now(), items: items};
  if (game.rows) deck.rows = game.rows(items);
  try{ localStorage.setItem("vc.practice.deck", JSON.stringify(deck)); return true; }
  catch(e){ return false; }
}
function readDeck(gameId){
  try{
    var d = JSON.parse(localStorage.getItem("vc.practice.deck") || "null");
    return d && d.game === gameId ? d : null;
  }catch(e){ return null; }
}

window.Practice = {normalize: normalize, GAMES: GAMES, fitsOf: fitsOf, sendDeck: sendDeck, readDeck: readDeck};
})();
