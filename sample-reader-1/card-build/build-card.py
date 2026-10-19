"""sample-reader-1/card-build/build-card.py — Contractor 17 (RL), 2026-10-12.
Builds sample-reader-1/sr1-card.js from Card Machine 8 (card-machine-8.html, beside this file).
Run from anywhere:  python build-card.py
The lab page's line numbers are used to cut it, so if Card Machine is republished, check the
section markers (═══) still sit on the same lines, or update the numbers below.

The card's own CSS and JS are taken as they are and wrapped in a shadow root,
so the reader's styles and the card's cannot touch each other. Only the seams
are changed: where the item comes from, how loading is driven (by the real
calls, not by timers), the page colour (read from the reader), and a few fixes
Big T asked for on 2026-10-12."""
import re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'card-machine-8.html'), encoding='utf8').read().split('\n')
L = lambda a, b: '\n'.join(src[a-1:b])          # 1-based, inclusive

css = L(48, 283)
js_parts = [L(341, 346), L(417, 445), L(446, 514), L(515, 540), L(541, 606), L(607, 639), L(640, 824)]
js = '\n'.join(js_parts)

def rep(s, a, b, n=1):
    c = s.count(a)
    assert c == n, f"expected {n} of {a[:90]!r}, found {c}"
    return s.replace(a, b)

# ── CSS seams ────────────────────────────────────────────────────────────
css = rep(css, '.wheel .s.ex .sentbox,.wheel .s.ex .cnt{cursor:var(--excur)}',
  '.wheel .s.ex .cnt{cursor:var(--excur)}\n'
  '.s.ex .sent.tap{cursor:pointer;border-radius:8px;padding:2px 6px;margin:-2px -6px;transition:background .2s}\n'
  '.react .s.ex .sent.tap:hover{background:var(--hov)}')
css = rep(css, '.onp.on .opl{transform:rotate(45deg)}', '')
# no line under the page form and its circle when the sentence is open (Big T, 2026-10-19)
css = rep(css, '.onp.on{opacity:.95;box-shadow:inset 0 -1.5px 0 var(--acct)}', '.onp.on{opacity:.95}')
# the open headword: a soft line under the word only, never under the chevron (Big T, 2026-10-19)
css = rep(css, '.ho-caretline .hw.on{box-shadow:inset 0 -2px 0 color-mix(in srgb,currentColor 50%,transparent)}',
  '.ho-caretline .hw.on [data-slot="z"]{box-shadow:inset 0 -1px 0 color-mix(in srgb,currentColor 32%,transparent)}')
css = rep(css, '.ho-underline .hw.on{box-shadow:inset 0 -2px 0 var(--hwc)}',
  '.ho-underline .hw.on [data-slot="z"]{box-shadow:inset 0 -1px 0 color-mix(in srgb,var(--hwc) 55%,transparent)}')
css += r'''
/* ── in the reader (Contractor 17) ── */
:host{all:initial;display:block;--serif:'Source Serif 4',Georgia,serif;--sans:'Inter',system-ui,-apple-system,sans-serif;
  --garamond:'Cormorant Garamond',Georgia,serif;--hand:'Architects Daughter','Comic Sans MS',cursive;--ease:cubic-bezier(.2,.75,.2,1);
  font:13px/1.45 var(--sans);-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid #5B8DEF;outline-offset:2px}
.mach{position:relative!important;left:auto!important;top:auto!important}
.card{max-height:var(--pfmax,80vh);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
.lv:empty{display:none}
/* the strip above the headword: hover peeks the Full sentence, click opens it */
.ptop{display:flex;width:max-content;max-width:calc(100% - 60px);align-items:center;margin:0 0 0 44px;padding:3px 12px 3px 0;min-height:24px;cursor:pointer}
.ptop .onp{margin:0}
.hit{position:absolute;left:44px;width:190px;top:-22px;height:24px;z-index:4;cursor:pointer}
.mach.ps-open .hit{pointer-events:none}
.pkeys{font:italic 13px var(--bf);opacity:.8;margin-left:8px;transition:opacity .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.xp.on .pkeys{opacity:0}
.pshead .tag{flex:none}
.pshead .sp{flex:1}
/* minimise and close, top right; always there, quiet until hovered */
.wt{position:absolute;top:7px;right:10px;z-index:3;display:flex;gap:2px}
.wt button{width:24px;height:24px;border:0;border-radius:50%;background:none;display:grid;place-items:center;opacity:.32;transition:opacity .2s,background .2s}
.card:hover .wt button{opacity:.6}
.wt button:hover{opacity:1!important;background:var(--hov)}
.wt svg{width:11px;height:11px}
.mach.mini .s:not(.h),.mach.mini .ptop,.mach.mini .fold,.mach.mini .xp,.mach.mini .hit,.mach.mini .foot{display:none!important}
.mach.mini .s.h{padding-bottom:10px}
/* the lab's controls, folded away at the foot */
.foot{font-size:11.5px;border-top:1px solid var(--cline)}
.foot .ft{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:7px 18px;opacity:.55;text-align:left}
.foot .ft:hover{opacity:.9}
.foot .ft .sp{flex:1}
.foot .fb{display:none;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:0 18px 12px}
.foot.open .fb{display:flex}
.foot .fb button{border:0;background:none;padding:0;text-decoration:underline;text-underline-offset:2px;opacity:.8}
.foot .fb label{display:flex;gap:4px;align-items:center;cursor:pointer}
.foot .fb .warn{color:#B4513F}
.foot .fb .meta{opacity:.55;width:100%}
.foot .alts{display:grid;gap:4px;width:100%}
.foot .alts button{text-decoration:none;text-align:left;padding:4px 8px;border-radius:8px;background:var(--hov)}
.fail{font-size:12px;opacity:.85;padding:6px 0}.fail button{border:0;background:none;padding:0;text-decoration:underline}
.prov{opacity:.62}
.prov-n{display:block;font:500 10px var(--sans);letter-spacing:.04em;opacity:.45;margin-top:2px;text-transform:uppercase}
/* a quiet scrollbar, only while the pointer is on the card */
.card{scrollbar-width:thin;scrollbar-color:transparent transparent;transition:scrollbar-color .3s}
.card:hover{scrollbar-color:color-mix(in srgb,currentColor 22%,transparent) transparent}
.card::-webkit-scrollbar{width:6px}.card::-webkit-scrollbar-track{background:transparent}
.card::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}
.card:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 22%,transparent)}
/* the item hidden in an example (the lab's "hide the word") */
.pf-blank{color:transparent!important;background:var(--accbg);border-radius:3px;cursor:pointer}
.pf-blank.show{color:var(--acct)!important;background:none;font-weight:600}
.ans .err{color:#B4513F}
'''

# ── JS seams ─────────────────────────────────────────────────────────────
# the page colour comes from the reader
js = rep(js, "const page=getComputedStyle(stage).getPropertyValue(S.surf==='sheet'?'--sheet':'--paper').trim();",
            "const page=READER.css;")
# the window, not a lab stage, is what the panel must stay inside
js = rep(js, "const sr=stage.getBoundingClientRect(), mr=mach.getBoundingClientRect(), card=$('.card',mach);",
            "const sr={left:0,top:0,right:innerWidth,bottom:innerHeight}, mr=mach.getBoundingClientRect(), card=$('.card',mach);")
# the peek shows the label and the key words only
js = rep(js, "function peekDist(xp){ const pss=$('#pss',xp); if(!pss) return 30;",
            "function peekDist(xp){ const h=$('.pshead',xp); if(h) return Math.round(h.offsetTop+h.offsetHeight+8); const pss=$('#pss',xp); if(!pss) return 30;")
js = rep(js, '''<div class="pshead"><span class="tag">Full sentence</span>''',
            '''<div class="pshead"><span class="tag">Full sentence</span><span class="pkeys">${onpText(x)}</span><span class="sp"></span>''')
# the strip above the headword, full width, holds the page form
js = rep(js, '''const head=`<div class="hrow"><button class="play" data-act="say" aria-label="Play pronunciation">${I.play}</button>
      <div class="hwrap">${S.onp==='above'?onp:''}<div class="hline">''',
'''const head=`${S.onp==='above'?`<div class="ptop" data-act="ps" title="Full sentence">${onp}</div>`:''}<div class="hrow"><button class="play" data-act="say" aria-label="Play pronunciation">${I.play}</button>
      <div class="hwrap"><div class="hline">''')
# level and key form arrive with the card call (slot b), the headword and short meaning first
js = rep(js, '''`<span class="lv" data-slot="a">${x.level}</span>`''', '''`<span class="lv" data-slot="b">${x.level}</span>`''')
js = rep(js, '''<span data-slot="a"><small>${k}</small>${v}</span>''', '''<span data-slot="b"><small>${k}</small>${v}</span>''')
js = rep(js, '''<span class="l1" data-act="l1" data-slot="a">${M[0]}</span>''',
            '''<span class="l1${x.prov?' prov':''}" data-act="l1" data-slot="a">${M[0]}</span>${x.prov?'<span class="prov-n">quick translation · the AI is on it</span>':''}''')
js = rep(js, '''<div class="pstr" id="pstr">${x.ptr}</div>''', '''<div class="pstr" id="pstr" data-slot="t">${x.ptr}</div>''') if '<div class="pstr" id="pstr">${x.ptr}</div>' in js else js
# no grab handle; minimise and close at the top right; the lab's controls at the foot; a hit strip above
js = rep(js, '''`<div class="card">${S.tabs==='off'&&!banner?'<div class="grab" data-grab><i></i></div>':''}''',
            '''`<div class="card"><div class="wt">${WT}</div>''')
js = rep(js, '''${secs.map(([k,c],i)=>`<div class="s ${k}${bandOn(i)?' band':''}">${c}</div>`).join('')}</div>`;''',
            '''${secs.map(([k,c],i)=>`<div class="s ${k}${bandOn(i)?' band':''}">${c}</div>`).join('')}${FOOT()}</div><div class="hit" data-act="ps" title="Full sentence"></div>`;''')
# after a rebuild, keep the panel where it was
js = rep(js, "mach.querySelectorAll('.fold').forEach(f=>f.style.transition='none'); upd(); placeXP('hidden',true);",
            "mach.querySelectorAll('.fold').forEach(f=>f.style.transition='none'); upd(); placeXP(U.ps?'open':U.peek?'peek':'hidden',true);")
js = rep(js, "const xpEl=$('#xp'); if(xpEl) new ResizeObserver(()=>{ if(U.ps) placeXP('open'); }).observe($('.card',mach));",
            "const xpEl=$('#xp'); if(RO) RO.disconnect(); if(xpEl){ RO=new ResizeObserver(()=>{ if(U.ps) placeXP('open'); }); RO.observe($('.card',mach)); }")
# plus becomes minus when open; the panel knows it is open
js = rep(js, "$('.onp',mach)?.classList.toggle('on',U.ps); $('#psp')?.classList.toggle('lit',U.ps);",
            "$('.onp',mach)?.classList.toggle('on',U.ps); const op=$('.opl',mach); if(op) op.textContent=U.ps?'−':'+'; $('#xp')?.classList.toggle('on',U.ps); mach.classList.toggle('ps-open',U.ps);")
# opening the sentence never waits on loading
js = rep(js, "if(U.ps||psBusy||U.loading) return; psBusy=true;", "if(U.ps||psBusy) return; psBusy=true;")
# speech goes through the reader's voices
js = rep(js, "function say(text,lang){ if(!('speechSynthesis' in window)) return; const u=new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g,'')); u.lang=lang; speechSynthesis.cancel(); speechSynthesis.speak(u); }",
            "function say(text,lang){ const t=String(text||'').replace(/<[^>]+>/g,''); if(!t) return; if(/^de/.test(lang)) LB.speakDE(t); else LB.speakLines([t],'en',null); }")
js = rep(js, "if(a==='sayex') return say(x.examples[U.ex][0],x.voice);", "if(a==='sayex') return say(x.examples[U.ex][0],x.voice);\n  if(LABACT(a,b,e)) return;")
# Ask goes to the AI for real
js = rep(js, '''    return answer(`${x.qa[U.q][1]}<small>Sample answer. In the reader this goes to the AI with the sentence.</small>`); }''',
            '''    return askReal(x.qa[U.q]); }''')
js = rep(js, '''  answer(`You asked: “${v.replace(/</g,'&lt;')}”<small>In the reader this goes to the AI with the word, its sentence and the page. The lab only shows where the answer lands.</small>`); });''',
            '''  askReal(v); });''')
js = rep(js, "if(a==='tapsent'&&String(getSelection()).trim()) return;", "if(a==='tapsent'&&String(getSelection()).trim()) return;\n  if(a==='tapsent'&&e.target.closest('.pf-blank')){ e.target.closest('.pf-blank').classList.toggle('show'); return; }\n  /* one click: the translation, a moment later so a double click can win; two: the audio */\n  if(a==='tapsent'&&S.tapS!=='none'&&S.tapS!=='play'){ clearTimeout(tapT); tapT=setTimeout(()=>{ U.extr=!U.extr; upd(); },230); return; }")
# the wheel: the strip and the hit zone count as the sentence's zone
js = rep(js, "const sec=e.target.closest('.onp,.s.ps,.xp')?'ps'", "const sec=e.target.closest('.onp,.ptop,.hit,.s.ps,.xp')?'ps'")
js = rep(js, "let peekT=0; const peekZone=el=>!!(el&&el.closest&&el.closest('.onp,#xp'));",
            "let peekT=0; const peekZone=el=>!!(el&&el.closest&&el.closest('.onp,.ptop,.hit,#xp'));")
# every listener is attached to the mach of the current box
js = js.replace("mach.addEventListener(", "ON(")
assert "mach.addEventListener" not in js
# no dragging in the reader
js = rep(js, '''(function(){ let st=null;
  ON('pointerdown',e=>{ if(!e.target.closest('[data-grab]')) return; st={x:e.clientX,y:e.clientY,l:mach.offsetLeft,t:mach.offsetTop}; e.target.setPointerCapture(e.pointerId); e.preventDefault(); });
  ON('pointermove',e=>{ if(!st) return; mach.style.left=Math.max(-200,Math.min(stage.clientWidth-80,st.l+e.clientX-st.x))+'px'; mach.style.top=Math.max(0,Math.min(stage.clientHeight-60,st.t+e.clientY-st.y))+'px'; });
  ON('pointerup',()=>st=null); })();''', '')
# a hidden panel is invisible, so it never shows through a glass card
js = rep(js, "card.style.setProperty('--push','0px'); xp.style.opacity=1;", "card.style.setProperty('--push','0px'); xp.style.opacity=state==='hidden'?0:1;")
# on glass the card is see-through, so a peeking panel shows only the part that sticks out
js = rep(js, "  if(instant){ void xp.offsetWidth; xp.classList.remove('nt'); card.classList.remove('nt'); }\n}",
  "  xp.style.clipPath = S.style==='glass'&&state==='peek' ? (mode==='side-r'?`inset(0 0 0 ${xp.offsetWidth-44}px)`:mode==='side-l'?`inset(0 ${xp.offsetWidth-44}px 0 0)`:mode==='above'?`inset(0 0 ${Math.max(0,H-pk)}px 0)`:'none') : 'none';\n  if(instant){ void xp.offsetWidth; xp.classList.remove('nt'); card.classList.remove('nt'); }\n}")
# toast is a lab thing
js = rep(js, "return toast(U.added[k]?'Sentence added to your library (lab only)':'Removed'); }", "return; }")
# the swipe handler uses a capture listener
js = rep(js, "ON('click',e=>{ if(moved){ moved=false; e.stopImmediatePropagation(); } },true); })();",
            "ON('click',e=>{ if(moved){ moved=false; e.stopImmediatePropagation(); } },true); })();")

head = open(os.path.join(HERE, 'card-head.js'), encoding='utf8').read()
tail = open(os.path.join(HERE, 'card-tail.js'), encoding='utf8').read()
out = head.replace('/*CSS*/', css.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')) + '\n' + js + '\n' + tail
open(os.path.join(HERE, '..', 'sr1-card.js'), 'w', encoding='utf8').write(out)
print('built', len(out))
