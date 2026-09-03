// config.js — which Supabase project the app talks to.
//
// SHARED FILE. Edit it in website\ only, then copy to extension\ alongside
// app.js / app.css / store-supabase.js / icons.js. A second edited copy is a
// copy that falls behind.
//
// Two projects, same structure, separate data (route.md §9). Live is what the
// beta user uses; dev is where things break. Nothing here is secret — anon keys
// are public by design, and row-level security is what actually protects rows.
//
// This file holds the table and the switch UI. It deliberately does NOT decide
// which environment is current, because the three clients remember that in three
// different places: the website in localStorage, the extension in
// chrome.storage.local, Android in SharedPreferences. Each asks its own store and
// then looks the answer up here.
//
// Loaded by index.html (website), app.html (sidebar) and background.js
// (service worker, via importScripts). The service worker has no DOM, so every
// function that touches the page checks for one first.

const VOCAB_ENVS = {
  live: {
    name: 'live',
    label: 'LIVE',
    url:  "https://vinebdanjgggbcfxrvqd.supabase.co",
    anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZpbmViZGFuamdnZ2JjZnhydnFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NjAxNDcsImV4cCI6MjA5ODEzNjE0N30.Pca73qGNWBu3euKFnQiIXzOIbGCj_18_yzbP-Fh8d3Q"
  },
  dev: {
    name: 'dev',
    label: 'DEV',
    url:  "https://iqbsmayprkagczvirxsr.supabase.co",
    anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxYnNtYXlwcmthZ2N6dmlyeHNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MzA2NTIsImV4cCI6MjEwNDAwNjY1Mn0.AbFlqNhUGnZoSZ7O4qEJ9Jqa7UvK1Zkv7Kdp4J1vXM4"
  }
};

// Anything unrecognised or missing resolves to live. Failing towards the working
// database is the right direction: a broken config should not quietly point a
// real user at a half-built one.
const VOCAB_DEFAULT_ENV = 'live';

function vocabEnv(name) {
  return VOCAB_ENVS[name] || VOCAB_ENVS[VOCAB_DEFAULT_ENV];
}

// ─────────────────────────────────────────────────────────────────────────
// The picker
//
// A plain DOM panel rather than confirm(). Chrome blocks modal dialogs inside
// cross-origin iframes, and the sidebar is exactly that — a confirm() there
// would silently never appear.
// ─────────────────────────────────────────────────────────────────────────

function vocabEnvPicker(current, onPick) {
  if (typeof document === 'undefined' || document.getElementById('vocab-env-picker')) return;
  const other = current === 'dev' ? 'live' : 'dev';

  const wrap = document.createElement('div');
  wrap.id = 'vocab-env-picker';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(20,22,18,.55);' +
    'display:grid;place-items:center;font:13px Inter,system-ui,sans-serif';

  const card = document.createElement('div');
  card.style.cssText = 'background:#fff;color:#21261f;border-radius:12px;padding:20px 18px;' +
    'width:min(300px,88vw);box-shadow:0 10px 40px rgba(0,0,0,.35);line-height:1.5';
  card.innerHTML =
    '<div style="font-weight:600;margin-bottom:6px">Which database?</div>' +
    '<div style="color:#585e53;margin-bottom:14px">You are on <b>' + vocabEnv(current).label + '</b>. ' +
    'Switching signs you out — the two databases have separate accounts, and none of your ' +
    'words move between them.</div>';

  const mk = (text, primary) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'width:100%;padding:9px;margin-top:7px;border-radius:7px;font-size:13px;cursor:pointer;' +
      (primary ? 'border:1px solid #4f7a37;background:#6f9b54;color:#fff'
               : 'border:1px solid #dcd7ca;background:#FBFAF6;color:#585e53');
    return b;
  };

  const go = mk('Switch to ' + vocabEnv(other).label, true);
  go.onclick = () => { wrap.remove(); onPick(other); };
  const cancel = mk('Stay on ' + vocabEnv(current).label, false);
  cancel.onclick = () => wrap.remove();

  card.appendChild(go);
  card.appendChild(cancel);
  wrap.appendChild(card);
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  document.body.appendChild(wrap);
}

// ─────────────────────────────────────────────────────────────────────────
// The dev badge
//
// Shown only on dev, and always. Forgetting which database you are in is the
// failure this whole arrangement exists to prevent, so it must be visible
// without being asked for. Bottom-left, so it never fights the app's header.
// ─────────────────────────────────────────────────────────────────────────

function vocabEnvBanner(current, onPick) {
  if (typeof document === 'undefined') return;
  if (current !== 'dev') return;                       // live gets no badge — live is normal
  if (document.getElementById('vocab-env-badge')) return;

  const b = document.createElement('button');
  b.id = 'vocab-env-badge';
  b.textContent = 'DEV DATABASE';
  b.title = 'You are not on the live database. Click to switch back.';
  b.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483646;' +
    'background:#c2410c;color:#fff;border:none;border-radius:6px;padding:5px 9px;' +
    'font:600 10.5px/1 Inter,system-ui,sans-serif;letter-spacing:.06em;cursor:pointer;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.28)';
  b.onclick = () => vocabEnvPicker(current, onPick);
  document.body.appendChild(b);
}

// ─────────────────────────────────────────────────────────────────────────
// The gesture
//
// Five clicks on an element opens the picker. Attached to the heading of the
// sign-in screen, which means switching is only reachable while signed out —
// deliberate, because switching signs you out anyway.
//
// Same idea as the reader lab's triple-tap on the build badge: findable when
// you know, invisible when you don't.
// ─────────────────────────────────────────────────────────────────────────

// The sidebar has no reachable sign-out, so its sign-in heading may never be on
// screen — which left the switch unreachable there. This is the way in that does
// not depend on being signed out: a transparent 16px corner, bottom-right, away
// from the dev badge. Five clicks opens the picker. Nothing to see, nothing to
// hit by accident.
function vocabEnvHotspot(current, onPick) {
  if (typeof document === 'undefined' || document.getElementById('vocab-env-hotspot')) return;
  const h = document.createElement('div');
  h.id = 'vocab-env-hotspot';
  h.style.cssText = 'position:fixed;right:0;bottom:0;width:16px;height:16px;' +
    'z-index:2147483645;background:transparent';
  document.body.appendChild(h);
  vocabEnvGesture(h, current, onPick);
}

function vocabEnvGesture(el, current, onPick) {
  if (typeof document === 'undefined' || !el) return;
  let n = 0, t = null;
  el.style.cursor = 'default';
  el.addEventListener('click', () => {
    clearTimeout(t);
    t = setTimeout(() => { n = 0; }, 2500);          // pause and the count resets
    if (++n < 5) return;
    n = 0; clearTimeout(t);
    vocabEnvPicker(current, onPick);
  });
}
