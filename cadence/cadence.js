// cadence · 2026-11-09d
//
// Cadence, the plain reader: a page of text that a highlight follows while the sound plays.
// Reads documents in the timed-text shape (cadence-shape.js). Three parts, each on its
// own so the next layers (tooltip, chips, theater) can sit on top without reaching in:
//
//   TTPage    draws a document: every word its own <span data-w="id">. Works with
//             no times at all.
//   TTClock   where "now" comes from: YouTube, an <audio>/<video>, or a simulated
//             playhead for testing. All give milliseconds and a playing flag.
//   TTFollow  joins them: highlights the word sounding now and keeps it in view.
//
// What makes follow robust, compared with the reader in app.js:
//   - Word times are looked up (binary search), never guessed per tick.
//   - The DOM is touched only when the word or the sounding lines change.
//   - The clock is smoothed between the player's coarse reports, and never jitters
//     backwards; a real jump (seek) is taken at once.
//   - Scrolling is our own animation, so our scroll and the reader's scroll can't
//     be confused. Follow pauses only on a real gesture (wheel, touch drag, scroll
//     keys, the scrollbar), and "Back to the text" brings it back.
//   - Nothing positional is cached, so resizing or a new text size can't break it.

(function (root) {
  'use strict';
  const TT = root.TimedText;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── TTPage ─────────────────────────────────────────────────────────────────
  function TTPage(container) {
    let doc = null;
    const byId = new Map(), lineEls = new Map();

    function lineHtml(lid, l) {
      const words = l.words.map(w => {
        const t = (typeof w.start === 'number' && typeof w.end === 'number') ? '' : ' tt-untimed';
        return `<span class="tt-w${t}" data-w="${esc(w.id)}">${esc(w.text)}</span>`;
      }).join(' ');
      return `<span class="tt-line" data-l="${esc(lid)}">${words}</span>`;
    }

    function render(d) {
      doc = d; byId.clear(); lineEls.clear();
      const out = [];
      for (const b of d.blocks || []) {
        const lines = (b.lines || []).filter(lid => d.lines[lid]);
        if (b.type === 'image') {
          out.push(`<figure class="tt-fig"><img src="${esc(b.src || '')}" alt="${esc(b.alt || '')}" loading="lazy"></figure>`);
        } else if (b.type === 'heading') {
          out.push(`<h2 class="tt-h">${lines.map(l => lineHtml(l, d.lines[l])).join(' ')}</h2>`);
        } else if (b.type === 'dialogue') {
          out.push(`<div class="tt-dlg">${lines.map(l => {
            const sp = d.lines[l].speaker;
            return `<div class="tt-turn">${sp ? `<span class="tt-sp">${esc(sp)}</span>` : ''}<span class="tt-say">${lineHtml(l, d.lines[l])}</span></div>`;
          }).join('')}</div>`);
        } else {
          out.push(`<p class="tt-p">${lines.map(l => lineHtml(l, d.lines[l])).join(' ')}</p>`);
        }
      }
      container.innerHTML = out.join('');
      container.querySelectorAll('.tt-w').forEach(el => byId.set(el.dataset.w, el));
      container.querySelectorAll('.tt-line').forEach(el => lineEls.set(el.dataset.l, el));
    }

    return {
      render,
      get doc() { return doc; },
      word: id => byId.get(id) || null,
      line: id => lineEls.get(id) || null,
      wordAt: target => { const el = target && target.closest && target.closest('.tt-w'); return el ? el.dataset.w : null; },
      container
    };
  }

  // ── TTClock ────────────────────────────────────────────────────────────────
  // Every clock: time() ms · playing() · play() · pause() · toggle() · seek(ms)
  //              rate() · setRate(r) · duration() ms or 0 · kind

  // A simulated playhead: for testing follow with no media at all.
  function simClock(durationMs) {
    let base = 0, at = 0, playing = false, r = 1;
    const now = () => performance.now();
    const time = () => Math.min(durationMs || Infinity, playing ? base + (now() - at) * r : base);
    return {
      kind: 'sim',
      time,
      playing: () => { if (playing && durationMs && time() >= durationMs) { base = durationMs; playing = false; } return playing; },
      play() { if (!playing) { if (durationMs && base >= durationMs) base = 0; at = now(); playing = true; } },
      pause() { if (playing) { base = time(); playing = false; } },
      toggle() { this.playing() ? this.pause() : this.play(); },
      seek(ms) { base = Math.max(0, ms); at = now(); },
      rate: () => r,
      setRate(x) { base = time(); at = now(); r = x; },
      duration: () => durationMs || 0
    };
  }

  // Smoothing shared by real players. They report time in coarse steps (YouTube
  // every ~100–250 ms, and late). Between reports we run our own clock at the play
  // rate; on each report we nudge toward it, or snap if it jumped (a seek).
  function smoother(readRaw, isPlaying, getRate) {
    let anchor = 0, anchorAt = 0, lastRaw = NaN, out = 0, changedAt = 0;
    return function time() {
      const raw = readRaw();
      if (!isFinite(raw)) return out;
      const t = performance.now();
      if (!isPlaying()) { anchor = raw; anchorAt = t; lastRaw = raw; out = raw; changedAt = t; return out; }
      const pred = anchor + (t - anchorAt) * getRate();
      if (raw !== lastRaw) {
        lastRaw = raw; changedAt = t;
        if (Math.abs(raw - pred) > 350) { anchor = raw; anchorAt = t; out = raw; return out; } // a jump
        anchor = pred + (raw - pred) * 0.35; anchorAt = t;
      }
      let v = anchor + (t - anchorAt) * getRate();
      // the player stopped reporting (an ad, a stall): don't run on past it for long
      if (t - changedAt > 1000) v = Math.min(v, lastRaw + 1000 * getRate());
      // never step backwards by a little (that is what makes highlights flicker)
      out = (v < out && out - v < 350) ? out : v;
      return out;
    };
  }

  // YouTube IFrame player (already created, onReady fired).
  // Ad guard: during an ad the player says "playing" and its clock is the ad's.
  // We call it an ad when the player reports a different video id, or a length
  // clearly shorter than where this text's words end. During an ad the clock
  // holds at the last good time and says it isn't playing, so nothing follows.
  // opts: { videoId, textEnd (ms, the last timed word's end) }
  function youtubeClock(player, opts) {
    const want = opts && opts.videoId, textEnd = (opts && opts.textEnd) || 0;
    const st = () => { try { return player.getPlayerState(); } catch (e) { return -1; } };
    function adNow() {
      try {
        const d = player.getVideoData && player.getVideoData();
        if (want && d && d.video_id && d.video_id !== want) return true;
      } catch (e) {}
      try {
        const len = (player.getDuration() || 0) * 1000;
        // a text whose words run past the media's end can't be this media
        if (len > 0 && textEnd > 30000 && len + 5000 < textEnd * 0.9) return true;
      } catch (e) {}
      return false;
    }
    // What an ad looks like, measured on Big T's computer (9 Nov, pre-roll):
    // the state is -1 ("not started") while the time runs from 0, with this
    // video's id and length. So: time moving while the player is not in
    // "playing" is an ad. Two forward steps are needed, so a single jump (a seek
    // while paused) isn't one. Also kept: "playing" but frozen for 1.5 s.
    let mvRaw = NaN, mvSteps = 0, mvLast = 0, adUntil = 0;
    let frozenRaw = NaN, frozenSince = 0;
    function adByMotion() {
      const t = performance.now(), s = st();
      let raw; try { raw = player.getCurrentTime() * 1000; } catch (e) { return false; }
      if (s === 1) {
        mvSteps = 0;
        if (raw !== frozenRaw) { frozenRaw = raw; frozenSince = t; }
        mvRaw = raw; mvLast = t;
        return t - frozenSince > 1500;            // playing, but the time stands still
      }
      frozenRaw = raw; frozenSince = t;
      if (raw !== mvRaw) {
        // a step at about real speed (not a seek, which jumps further than time passed)
        const real = isFinite(mvRaw) && raw > mvRaw && raw - mvRaw <= (t - mvLast) * 1.6 + 120;
        mvSteps = real && t - mvLast < 1500 ? mvSteps + 1 : (real ? 1 : 0);
        mvLast = t; mvRaw = raw;
        if (mvSteps >= 2) adUntil = t + 1500;
      }
      return t < adUntil;
    }
    // checked on every read: the player answers from its own cached state, so it
    // is cheap, and a cached answer would let the ad's clock slip through
    let held = 0;
    const checkAd = () => adNow() || adByMotion();
    const realPlaying = () => st() === 1; // 1 = playing (3 = buffering counts as paused)
    const playing = () => realPlaying() && !checkAd();
    const rate = () => { try { return player.getPlaybackRate() || 1; } catch (e) { return 1; } };
    const smooth = smoother(() => { try { return player.getCurrentTime() * 1000; } catch (e) { return NaN; } }, playing, rate);
    // during an ad, and before the video has started (-1), the player's time is
    // not this video's: hold the last good time
    const time = () => { if (checkAd() || st() === -1) return held; held = smooth(); return held; };
    return {
      kind: 'youtube', time, playing,
      adPlaying: () => checkAd(),
      // for ?diag: what the player itself reports right now
      probe() {
        const r = { state: st(), frozen: false, ad: false };
        try { r.raw = Math.round(player.getCurrentTime() * 1000); } catch (e) {}
        try { r.dur = Math.round((player.getDuration() || 0) * 1000); } catch (e) {}
        try { const d = player.getVideoData() || {}; r.id = d.video_id; r.title = d.title; r.author = d.author; } catch (e) {}
        try { r.url = player.getVideoUrl(); } catch (e) {}
        r.idOrLength = adNow(); r.frozen = st() === 1 && performance.now() - frozenSince > 1500;
        return r;
      },
      play() { try { player.playVideo(); } catch (e) {} },
      pause() { try { player.pauseVideo(); } catch (e) {} },
      toggle() { realPlaying() ? this.pause() : this.play(); },
      seek(ms) { try { player.seekTo(Math.max(0, ms) / 1000, true); } catch (e) {} },
      rate, setRate(x) { try { player.setPlaybackRate(x); } catch (e) {} },
      duration: () => { if (checkAd()) return 0; try { return (player.getDuration() || 0) * 1000; } catch (e) { return 0; } }
    };
  }

  // An <audio> or <video> element (audiobooks, uploads, a creator's own file).
  function mediaClock(el) {
    const playing = () => !el.paused && !el.ended && el.readyState > 2;
    const time = smoother(() => el.currentTime * 1000, playing, () => el.playbackRate || 1);
    return {
      kind: 'media', time, playing,
      play() { const p = el.play(); if (p && p.catch) p.catch(() => {}); },
      pause() { el.pause(); },
      toggle() { el.paused ? this.play() : this.pause(); },
      seek(ms) { el.currentTime = Math.max(0, ms) / 1000; },
      rate: () => el.playbackRate || 1, setRate(x) { el.playbackRate = x; },
      duration: () => (isFinite(el.duration) ? el.duration * 1000 : 0)
    };
  }

  // ── TTFollow ───────────────────────────────────────────────────────────────
  // opts: { page, index, clock, scroller, highlight: true, follow: true,
  //         band: [top, bottom] (fractions of the visible text kept as the comfort zone),
  //         topInset() → px of the scroller covered from the top (a docked video) }
  // on(f) hears state changes; onFrame(f) hears every update with index.at(now)
  // and the time, so other views (subtitles) share this one loop.
  function TTFollow(opts) {
    const { page, scroller } = opts;
    let index = opts.index, clock = opts.clock;
    let highlight = opts.highlight !== false;
    let followWanted = opts.follow !== false; // the reader's setting
    let followPaused = false;                 // paused by a gesture, until "Back to the text"
    let held = false;                         // a tooltip or selection is open: don't scroll under it
    const band = opts.band || [0.22, 0.62];
    const topInset = typeof opts.topInset === 'function' ? opts.topInset : () => 0;
    const frames = [];
    let curWord = null, curLines = new Set(), lastRowTop = null, lastT = -1;
    let timer = 0, raf = 0, alive = true, tween = null;
    const listeners = [];

    // ── highlight ─────────────────────────────────────────────────────────
    // The spoken word, with a soft fall-off on two words each side (as app.js's
    // rd-center / rd-near / rd-far), within its own line only.
    let lit = [];
    function setWord(id) {
      if (id === curWord) return false;
      for (const [el, c] of lit) el.classList.remove(c);
      lit = [];
      curWord = id;
      const el = id && highlight && page.word(id);
      if (el) {
        lit.push([el, 'tt-now']);
        let a = el.previousElementSibling, b = el.nextElementSibling;
        if (a) { lit.push([a, 'tt-near']); a = a.previousElementSibling; if (a) lit.push([a, 'tt-far']); }
        if (b) { lit.push([b, 'tt-near']); b = b.nextElementSibling; if (b) lit.push([b, 'tt-far']); }
        for (const [e, c] of lit) e.classList.add(c);
      }
      return true;
    }
    function setLines(ids) {
      const next = new Set(highlight ? ids : []);
      for (const id of curLines) if (!next.has(id)) { const el = page.line(id); if (el) el.classList.remove('tt-sounding'); }
      for (const id of next) if (!curLines.has(id)) { const el = page.line(id); if (el) el.classList.add('tt-sounding'); }
      curLines = next;
    }

    // ── scrolling ─────────────────────────────────────────────────────────
    function rel(el) { // element's top/bottom relative to the visible text (below any inset)
      const a = el.getBoundingClientRect(), s = scroller.getBoundingClientRect();
      const inset = Math.max(0, Math.min(s.height * 0.7, topInset() || 0));
      return { top: a.top - s.top - inset, bottom: a.bottom - s.top - inset, h: s.height - inset };
    }
    function scrollTo(y, ms) {
      cancelTween();
      const from = scroller.scrollTop;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const to = Math.max(0, Math.min(max, y));
      if (Math.abs(to - from) < 2) return;
      // far away (a big seek): go there at once; sliding past pages of text helps no one
      if (Math.abs(to - from) > scroller.clientHeight * 2.5) { scroller.scrollTop = to; return; }
      const t0 = performance.now(), dur = ms || 420;
      const ease = x => 1 - Math.pow(1 - x, 3);
      tween = { id: 0 };
      const step = () => {
        if (!tween) return;
        const p = Math.min(1, (performance.now() - t0) / dur);
        scroller.scrollTop = from + (to - from) * ease(p);
        if (p < 1) tween.id = requestAnimationFrame(step); else tween = null;
      };
      tween.id = requestAnimationFrame(step);
    }
    function cancelTween() { if (tween) { cancelAnimationFrame(tween.id); tween = null; } }

    // Keep the sounding word inside the comfort band; place it a third of the way
    // down when it leaves. Checked when the word changes row, not every frame.
    function keepInView(el, jumped) {
      if (!el || !followWanted || followPaused || held || userScrolling()) return;
      const r = rel(el);
      if (r.top >= r.h * band[0] && r.bottom <= r.h * band[1]) return;
      scrollTo(scroller.scrollTop + r.top - r.h * 0.33, jumped ? 260 : 520);
    }

    // ── gestures that mean "I'm scrolling myself" ─────────────────────────
    // Robustness (9 Nov): a trackpad keeps sending wheel events for a while after
    // the fingers stop (momentum), and a light brush sends a few pixels. Neither
    // should break follow. So:
    // - the wheel must add up to a real scroll (24 px within 0.3 s);
    // - when follow resumes while a wheel stream is still running, the rest of
    //   that stream is momentum and is ignored, until a 0.2 s gap ends it (or 2.5 s).
    // A new scroll after a gap counts straight away.
    let wheelSum = 0, wheelAt = -1e9, momentum = false, momentumFrom = 0;
    // Scrolling yourself doesn't break follow while the sounding word is still on
    // screen (Big T, 9 Nov): you can look a little up or down. Follow breaks once
    // the word has left the visible text completely. While you're scrolling,
    // follow doesn't pull the page back (it would fight your hand).
    let userAt = -1e9;
    const userScrolling = () => performance.now() - userAt < 900;
    function wordForView() {
      if (curWord) return page.word(curWord);
      if (!index || !clock) return null;
      const r = index.at(clock.time()), id = r.word || r.next;
      return id ? page.word(id) : null;
    }
    function checkOut() {
      if (!followWanted || followPaused) return;
      const el = wordForView();
      if (!el) return;
      const r = rel(el);
      if (r.bottom < 0 || r.top > r.h) { followPaused = true; emit(); }
    }
    function userScrolled() {
      if (!followWanted || followPaused) return;
      cancelTween();
      userAt = performance.now();
      checkOut();
    }
    scroller.addEventListener('scroll', () => { if (userScrolling()) checkOut(); }, { passive: true });
    function markResumed() {
      const now = performance.now();
      momentum = now - wheelAt < 250; momentumFrom = now; wheelSum = 0;
      userAt = -1e9; // our own scroll back to the word must not count as yours
    }
    const onWheel = e => {
      const now = performance.now(), gap = now - wheelAt;
      wheelAt = now;
      if (momentum) {
        if (gap < 200 && now - momentumFrom < 2500) return; // still the old stream
        momentum = false;
      }
      if (gap > 300) wheelSum = 0;
      wheelSum += Math.abs(e.deltaY || 0) * (e.deltaMode ? 16 : 1);
      if (wheelSum >= 24) userScrolled();
    };
    let touchY = null;
    const onTouchStart = e => { touchY = e.touches[0] ? e.touches[0].clientY : null; };
    const onTouchMove = e => { if (touchY != null && e.touches[0] && Math.abs(e.touches[0].clientY - touchY) > 8) userScrolled(); };
    const onKey = e => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) userScrolled();
    };
    const onPointerDown = e => { // the scrollbar itself
      if (e.target === scroller && e.offsetX > scroller.clientWidth) userScrolled();
    };
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    scroller.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);

    // ── the loop ──────────────────────────────────────────────────────────
    // When the sound starts again after a real stop (a pause, an ad, the end of a
    // seek), follow picks up again: scrolling away while nothing plays shouldn't
    // leave follow broken once it plays. A hiccup under 0.7 s doesn't count.
    let wasPlaying = false, stoppedAt = 0;
    function watchPlay() {
      const p = !!(clock && clock.playing()), now = performance.now();
      if (p && !wasPlaying && followPaused && followWanted && now - stoppedAt > 700) {
        followPaused = false; markResumed(); recenter(); emit();
      }
      if (!p && wasPlaying) stoppedAt = now;
      wasPlaying = p;
    }
    function tick() {
      raf = 0; timer = 0;
      if (!alive) return;
      watchPlay();
      update(false);
      // a frame at a time while playing; four times a second while paused, to catch
      // a seek made in the player's own controls
      if (clock && clock.playing()) raf = requestAnimationFrame(tick);
      else timer = setTimeout(tick, 250);
    }
    function update(force) {
      if (!clock || !index) return;
      const t = clock.time();
      const jumped = Math.abs(t - lastT) > 1500;
      lastT = t;
      const r = index.at(t);
      for (const f of frames) { try { f(r, t); } catch (e) { console.error(e); } }
      const changed = setWord(r.word);
      setLines(r.lines);
      if ((changed || force) && r.word) {
        const el = page.word(r.word);
        if (el) {
          const top = el.offsetTop;
          if (force || jumped || top !== lastRowTop) { lastRowTop = top; keepInView(el, jumped || force); }
        }
      }
      if (changed) emit();
    }
    function kick() { // re-run now (after play/pause/seek from our own controls)
      if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer);
      raf = requestAnimationFrame(tick);
    }

    function state() {
      return { word: curWord, highlight, follow: followWanted, paused: followPaused, where: whereIsWord() };
    }
    function whereIsWord() { // is the sounding word above, below, or in view?
      const el = curWord && page.word(curWord);
      if (!el) return null;
      const r = rel(el);
      return r.bottom < 0 ? 'above' : r.top > r.h ? 'below' : 'in';
    }
    function emit() { const s = state(); listeners.forEach(f => { try { f(s); } catch (e) { console.error(e); } }); }

    tick();

    return {
      state,
      onFrame(f) { frames.push(f); return () => { const i = frames.indexOf(f); if (i >= 0) frames.splice(i, 1); }; },
      get clock() { return clock; }, get index() { return index; },
      on(f) { listeners.push(f); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; },
      setHighlight(v) {
        highlight = !!v;
        for (const [el, c] of lit) el.classList.remove(c); lit = [];
        for (const id of curLines) { const el = page.line(id); if (el) el.classList.remove('tt-sounding'); }
        curWord = null; curLines = new Set();
        update(false);
        emit();
      },
      setFollow(v) { followWanted = !!v; followPaused = false; if (v) { markResumed(); recenter(); } emit(); },
      resume() { followPaused = false; held = false; markResumed(); recenter(); emit(); },
      // hold(true) while the reader is busy with a selection; hold(false) catches up
      hold(v) { v = !!v; if (v === held) return; held = v; if (!v) { lastRowTop = null; update(true); } },
      recenter,
      setClock(c) { clock = c; lastT = -1; kick(); },
      setIndex(ix) { index = ix; for (const [el, c] of lit) el.classList.remove(c); lit = []; curWord = null; curLines = new Set(); lastRowTop = null; kick(); },
      kick,
      // after a size or layout change: keep the sounding word where it belongs
      relayout() { lastRowTop = null; if (curWord) keepInView(page.word(curWord), true); },
      destroy() {
        alive = false; cancelTween();
        if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer);
        scroller.removeEventListener('wheel', onWheel);
        scroller.removeEventListener('touchstart', onTouchStart);
        scroller.removeEventListener('touchmove', onTouchMove);
        scroller.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKey);
        curWord = '__'; setWord(null); setLines([]);
      }
    };

    function recenter() {
      const id = curWord || (index && clock ? (index.at(clock.time()).word || index.at(clock.time()).next) : null);
      const el = id && page.word(id);
      if (!el) return;
      const r = rel(el);
      scrollTo(scroller.scrollTop + r.top - r.h * 0.33, 380);
      lastRowTop = el.offsetTop;
    }
  }

  root.TTPage = TTPage;
  root.TTClock = { sim: simClock, youtube: youtubeClock, media: mediaClock };
  root.TTFollow = TTFollow;
})(window);
