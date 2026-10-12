/* practice/lab-profiles.js — build stamp: lab-profiles · 2026-10-12 (Contractor 17, RL).

   Saved profiles, out of the browser and into the experimental table
   lab_profiles (schema/20261012150000_lab_profiles.sql, dev only).

   Sample reader 1 writes here as a profile saves, changes or is removed, and
   sends every profile it holds once per visit, so older ones arrive too.
   My words (practice/words.html) reads from here.

   If the table is not there yet, it says so once in the console and stops
   trying: the reader works exactly as before. */
(function(){
"use strict";
var off = false;
function quiet(e){
  if (off) return;
  var m = (e && (e.message || e.details)) || String(e);
  if (/lab_profiles|relation|does not exist|schema cache/i.test(m)){ off = true;
    console.warn("[lab-profiles] the table is not there yet, so profiles stay in this browser only. " + m); }
  else console.warn("[lab-profiles] " + m);
}
function row(n){
  var p = n.profile || {};
  return { note_id: n.id, term_id: n.termId || null, text_id: n.textId || null, lang: p.lang || "de",
    item: p.item || n.term || "", profile: p, about: n.about || null, deleted_at: null };
}
var LabProfiles = {
  save: async function(sb, n){
    if (off || !sb || !n || !n.profile) return;
    var r = await sb.from("lab_profiles").upsert(row(n), {onConflict: "user_id,note_id"});
    if (r.error) quiet(r.error);
  },
  remove: async function(sb, noteId){
    if (off || !sb || !noteId) return;
    var r = await sb.from("lab_profiles").update({deleted_at: new Date().toISOString()}).eq("note_id", noteId);
    if (r.error) quiet(r.error);
  },
  syncAll: async function(sb, notes){
    if (off || !sb) return 0;
    var rows = (notes || []).filter(function(n){ return n && n.profile; }).map(row);
    for (var i = 0; i < rows.length; i += 100){
      var r = await sb.from("lab_profiles").upsert(rows.slice(i, i + 100), {onConflict: "user_id,note_id"});
      if (r.error){ quiet(r.error); return 0; }
    }
    return rows.length;
  },
  list: async function(sb){
    var out = [], from = 0;
    for (;;){
      var r = await sb.from("lab_profiles").select("*").is("deleted_at", null)
        .order("created_at", {ascending: false}).range(from, from + 999);
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < 1000) return out;
      from += 1000;
    }
  }
};
window.LabProfiles = LabProfiles;
})();
