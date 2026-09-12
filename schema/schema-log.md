# Schema log

> **rev 8 · 2026-09-12** · verified against: `006-register.sql` and
> `007-takes-bucket.sql`, both written and read in full this session, and the
> developer's own confirmation that each ran against dev. Rev 7's verification of
> `005-outcomes.sql`, and rev 6's of `000-baseline.sql`, `001-sequences.sql`,
> `002-slots-soft-delete.sql`, `003-recordings.sql` and `004-struggles.sql`, stand
> unchanged and were not re-done. Rev 8 adds the 006 and 007 rows, written by
> Contractor 07, which is the chat that applied them.
>
> **rev 7 · 2026-09-07** · rev 7 added the 005 row, which rev 6 predates. **The
> 005 entry was written by Contractor 06, which is not the chat that applied it**
> — see the note under *Applied*
> **Status: current**

Two Supabase projects, same structure, separate data (`route.md` §9).

| | Project ref | Role |
|---|---|---|
| **LIVE** | `vinebdanjgggbcfxrvqd` | Real use. A beta user depends on it |
| **DEV** | `iqbsmayprkagczvirxsr` (`vocab-dev`) | Where things break |

Created 2026-09-03 by Contractor 01. All three clients can point at either — see
`config.js` (website, extension) and `Sync.java` (Android).

> **The two projects are no longer identical, on purpose.** Since 2026-09-06 dev
> carries tables that live does not — eight of them as of 005 — plus four extra
> columns on `slots` as of 006, **and as of 007 a storage bucket and four storage
> policies that live has no equivalent of at all.** See *Checking for drift* below
> before reading a fingerprint comparison as a fault — and note that from 007
> onward a fingerprint comparison no longer sees everything.

---

## Start here: the three files, and what each is for

This doc is the entry point. Two files sit beside it and are useless without an
explanation, so here it is. All three live in **`Documents\vocab-collector\website\schema\`**
and are pushed to GitHub with the site; all three are **also in project knowledge**,
because a chat cannot see the website folder and cannot run what it cannot read.
That is the same arrangement `START-HERE.md` §2 records for `build.py` and
`extract.js`.

| File | What it is | When you touch it |
|---|---|---|
| **`schema-log.md`** (this) | The record. Which change reached which project, and the rules | Before proposing any schema change, and after applying one |
| **`fingerprint.sql`** | A read-only query. Prints the structure of whichever project you run it in | To check the two projects still match. Run in both, download both, compare |
| **`000-baseline.sql`** | The recipe that built dev, read out of live's own catalogue on 2026-09-03 | To build another database, or rebuild dev from scratch. Never edited |

The numbered changes — `001-`, `002-`, `003-` and whatever follows — live in the
same folder and are applied in order on top of the baseline. Rebuilding dev from
scratch means running the baseline and then every numbered file in sequence.

Neither `.sql` file is run day to day. `fingerprint.sql` is the one you will
actually reach for; `000-baseline.sql` is there so dev can be recreated without
asking anyone what used to be in it.

**Nothing here is secret.** The files contain table definitions and a read-only
query. The anon API keys sit in `config.js` and `Sync.java`, not here, and those
are public by design — row-level security is what protects rows.

---

## The rules

Four, and short on purpose.

**1. Every schema change is a numbered file in `schema/`.**
Never typed straight into the dashboard. If it was typed into the dashboard it
does not exist, and the other project will never receive it.

**2. A file is never edited once applied anywhere.**
Wrong change? Write the next number to correct it. Editing an applied file makes
the two projects silently disagree while this log claims they match.

**3. Dev first, then live — and live only after dev has been used.**
Not "applied to dev", *used*. Open the app against dev, save a word, open the
reader, edit something. The point of dev is to spend the mistake there.

**4. Both date columns filled, or the row is not done.**
An empty LIVE column is the drift. That is the whole mechanism.

**A corollary to rule 2, learned on 2026-09-06.** A numbered file must not claim
its own install state in its header. `001-sequences.sql` was written saying "NOT
YET APPLIED", which stopped being true the moment it was run — and rule 2 forbids
going back to correct it. The three files now point here instead. **This table is
the only place install state lives.**

**A second corollary, learned on 2026-09-12.** Rule 1 says a change is a numbered
file, and it means *a file that reached the repository*. `006-register.sql` was
written, run against dev, and believed committed for most of a session — it was
sitting untracked in `website\schema\` the whole time. It was in the database and
in nobody's history. A change is not filed until `git ls-files schema` prints it.

---

## Applied

| # | What it does | Dev | Live |
|---|---|---|---|
| 000 | Baseline — six tables, columns, keys, checks, indexes, `set_updated_at()` and its five triggers, RLS on all six with one `own_*` policy each | 2026-09-03 | n/a — this file *describes* live; it was never applied to it |
| 001 | `activities`, `sequences`, `slots`, `progress`. The surface: a lesson or course, the activities placed in it, and where a learner has reached. `slots.id` is a permanent name and `slots.position` is the order, kept apart deliberately | 2026-09-06 | — |
| 002 | `slots.deleted_at`, plus a partial index on the live ones. Removing an activity from a lesson must not destroy the record that it was there | 2026-09-06 | — |
| 003 | `recordings`, `clips`. The walkthrough automation: a take made of clips, each clip holding a media reference with in/out points and its own timed actions | 2026-09-06 | — |
| 004 | `struggles`. Where a learner came unstuck, anchored to a slot id. `slot_id` is `on delete restrict` — the generalised lesson from 002: a reference to a slot must not be allowed to lose its meaning quietly, so a hard delete becomes an error rather than silent loss | 2026-09-06 | — |
| 005 | `attempts`, plus `slots.condition` and `slots.gate`. What happened when a learner reached a slot, and the two authored fields that read it back. **`pending` is a first-class status**, because a test is marked by a person later, so an attempt may sit unsettled for days. No unique constraint on (user, slot) — a second attempt is the retry case, and the current one is simply the most recent. `condition` decides who sees a slot at all, `gate` what must be true before they pass it; both are jsonb, both point at a **slot id and never a position**, and both are null by default, so a lesson using neither is exactly what it is today. `slot_id` is `on delete restrict`, following 002 and 004 without variation | 2026-09-07 | — |
| 006 | `slots.parent_slot_id` (uuid, FK to `slots(id)`, indexed) and `slots.register` (text, no check). Whether a slot is its own step or hangs off one, and whether it draws as the stage or as something handed to you. **The two are separate columns and neither derives from the other** — a worksheet after an activity ends has its own number *and* feels handed to you. **On `slots`, not `activities`**, because the same activity is a step in one lesson and a handout in another; on `activities` one lesson's choice would leak into every other lesson using it. **`on delete set null`, breaking with 002 and 004's `restrict`** — and the break is the point: a removed step should leave its handouts visible as loose steps, which a teacher can see and fix, rather than erroring or vanishing. Both nullable, so every pre-006 slot behaves exactly as before and the client falls back to deriving both | 2026-09-12 | — |
| 007 | Storage bucket `takes`, private, plus four policies on `storage.objects` (select / insert / update / delete) scoped to `bucket_id = 'takes'` and to the user's own first path folder. **The project's first use of Supabase Storage.** Camera and microphone captured during a take, one file per clip, path `<user_id>/<recording_id>/<clip_id>.webm` — the user id leads because the policies read that first folder, so changing the path shape silently stops own-rows-only meaning anything. `clips.media`, which 003 deliberately left open, is now `{ seconds, path, mime }`. **Not public**: a signed URL is minted at play time and expires in an hour, because a public bucket puts a teacher's classroom on the open internet behind a guessable path | 2026-09-12 | — |

*(One row per change from here. Dates, not ticks — knowing **when** live diverged
is worth more than knowing that it did.)*

**Who wrote the 005 row.** Contractor 05 wrote `005-outcomes.sql` and did not add
an entry here; Contractor 06 wrote this one on 2026-09-07 from the file itself,
which it read in full. **The Dev date is the developer's, confirmed 2026-09-07**:
he ran the file against dev once, and has built and saved a lesson through
`surface.html` since.

**A thing that came up while confirming it, worth writing down.** The run happened
while `surface.html` was being opened locally, and the site has since moved to
GitHub Pages — which raised the reasonable question of whether the change needed
running again. It does not. **The SQL is applied to the Supabase project, not to
the page that talks to it**, so where the client is served from has no bearing on
it. The only thing that would undo 005 in dev is rebuilding dev from the baseline,
in which case every numbered file is replayed in order anyway (see *Start here*).

**Who wrote the 006 and 007 rows.** Contractor 07, which is also the chat that
wrote both files. Both Dev dates are the developer's, confirmed 2026-09-12 — he
ran each in the SQL editor and reported the result, and both have been *used*
rather than merely applied, which is what rule 3 asks for: handouts were authored
and drawn through 006, and takes were recorded, uploaded, played back and deleted
through 007, all against dev.

**006 and 007 are the first changes made for `studio/index.html` rather than for
`surface.html`.** That page is not scaffolding — it is on the live website at
`/vocabco/studio/`, reading dev. Which means the usual sentence below is now only
half true.

**None of 001 to 007 belongs in live yet.** 001 to 005 support `surface.html`,
which is scaffolding (`route.md` §4) and is not deployed. 006 and 007 support the
studio, which *is* deployed but points at dev and has no user but the developer.
Applying any of it to live would be harmless but pointless until something there
uses it. **When that changes it will change for 006 and 007 first**, and 007 is
not a `.sql` file's worth of work on the live side — it creates a bucket, and
buckets hold files somebody pays for.

---

## Checking for drift

`fingerprint.sql` prints the structure of whichever project you run it in, as a
plain list of lines. Run it in both, download both results, compare.

**Identical no longer means no drift, and different no longer means drift.** Dev
holds eight tables live does not — `activities`, `sequences`, `slots`, `progress`,
`recordings`, `clips` from 001 and 003, `struggles` from 004, and `attempts` from
005 — with their indexes, triggers and policies. 005 adds two columns, `condition`
and `gate`, to `slots`, and 006 adds two more, `parent_slot_id` and `register`, so
the differences are no longer all whole tables and a comparison that only counts
tables will miss them. All of that will show as a difference, correctly. What to
check is that **the six baseline tables still match** and that the extra lines
account for exactly the changes in the Applied table above and nothing else.

**As of 007 the fingerprint no longer sees everything, and this is new.** A
storage bucket is not a table and a storage policy is not a column. Dev and live
now differ by a whole storage layer that `fingerprint.sql` reports as nothing at
all — the two could come back byte-identical while one of them can store files
and the other cannot. Until the query is extended to read `storage.buckets` and
the policies on `storage.objects`, **007 is checkable only by reading this log**.
That is exactly the failure the two-date-column mechanism exists to prevent, and
007 is the first change to slip underneath it.

This is the ordinary state of a project that develops in dev first, and it will
stay this way until the surface work reaches live. It is worth saying out loud
because an early revision of this file said the two matched exactly, and a reader
comparing against that sentence would reasonably conclude something had gone
wrong.

Worth doing before applying anything, so a surprise is found before it is buried
under a new change rather than after.

**The results panel caps at 100 rows and the output is ~135.** Download the
results rather than reading them on screen, or the tail is silently cut — which
is exactly what happened the first time this was run, on 2026-09-03. Dev's output
is now longer again, so this matters more than it did.

**Last run: 2026-09-03. 135 rows each side, identical.** Not re-run since 001 to
007 were applied, so the last comparison predates all eight new tables, all four
new `slots` columns, and the storage layer it could not have seen anyway.

---

## What this does not cover

Honest limits, so nobody assumes more than is here.

- **Data.** Structure only. The two projects hold different rows, deliberately.
- **Accounts.** Users live inside a project. A live account does not exist in dev,
  and the same person signing into both gets two different user IDs. Since row
  IDs are `SHA-256(user_id + "|" + ext_id)`, copying rows between projects is a
  rewrite of every primary key, not an export and import.
- **Dashboard settings outside the database** — Auth providers, email templates,
  Realtime replication, rate limits. Change any of those in live and they must be
  changed in dev by hand. `fingerprint.sql` will not notice. **Storage used to be
  on this list as a thing nobody touched; since 007 it is a thing this project
  depends on**, and it is still invisible to the drift check.
- **Files.** Storage has no foreign keys, so nothing cascades into it. Deleting a
  take from the studio's corner removes its objects deliberately; deleting a
  recording or a sequence by any other route leaves the files behind forever.
  There is no trigger and no sweep. A row count will never reveal this.
- **Legacy API keys.** Both projects use them, and Supabase retires them at the
  end of 2026. Migrating is a separate task with a real deadline.
- **Sharing.** Every table in both projects, old and new, carries one policy of
  the same shape: you can read and write your own rows and nobody else's. A
  teacher's lesson is therefore unreadable by a learner. Nothing in 001 to 007
  changes that, and `intent.md` §13 needs it changed eventually. It is a design
  task, not a column. **005 is where this bites hardest so far**: `attempts`
  carries a `pending` status for work a person marks later, and under own-rows-only
  a teacher cannot read the attempt they are supposed to mark. The status is
  correct and the marking case does not work yet — `route.md` §12. **007 extends
  the same wall to files**: the bucket policies are own-folder-only, so a
  recorded lesson is unwatchable by anyone but the teacher who recorded it.

---

## Corrections this file supersedes

The baseline was read from the live catalogue, not from the docs, and three doc
claims turned out to be wrong. Recorded here because the baseline is now the
evidence:

- **`sources` has RLS ON**, policy `own_sources`, identical in shape to the other
  five. `backend-current-state.md` §5 and §11 say it is off. They are wrong.
- **`items.source_id` exists** — uuid, nullable, FK to `sources(id)` ON DELETE SET
  NULL, indexed as `items_user_source`. `docs-index.md` calls its absence "the one
  real structural gap". `highlights.source_id` and `sources.folder_id` exist too.
- **`sources.kind` allows four values** — `text`, `video`, `highlight`, `page`.
  `backend-current-state.md` §3 describes only the first two.

And three things no doc mentions at all: five `set_updated_at()` BEFORE UPDATE
triggers (so `updated_at` is maintained by the database, not by client code);
unique `(user_id, ext_id)` indexes on items, highlights, collections and sources
(a second, independent guard on row identity alongside the deterministic UUID);
and `user_id` defaulting to `auth.uid()` on every table.

**`sources.kind` is also the standing warning about check constraints**, and it is
why `activities.kind` and `sequences.kind` in 001, `struggles.kind` in 004,
`attempts.status` in 005 and `slots.register` in 006 all carry none — 005 cites
this paragraph by name and 006 follows it. A permitted value that never holds a
row outlives the idea it came from, and under rule 2 every new activity type would
otherwise be its own numbered change applied to two databases. Add the constraint
once the set of kinds has stopped moving.
