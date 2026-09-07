# Schema log

> **rev 6 · 2026-09-06** · verified against: `000-baseline.sql`, `001-sequences.sql`,
> `002-slots-soft-delete.sql`, `003-recordings.sql`, `004-struggles.sql`, all read this
> session; all four were applied to dev by the developer on 2026-09-06 and used
> through `surface.html`
> **Status: current**

Two Supabase projects, same structure, separate data (`route.md` §9).

| | Project ref | Role |
|---|---|---|
| **LIVE** | `vinebdanjgggbcfxrvqd` | Real use. A beta user depends on it |
| **DEV** | `iqbsmayprkagczvirxsr` (`vocab-dev`) | Where things break |

Created 2026-09-03 by Contractor 01. All three clients can point at either — see
`config.js` (website, extension) and `Sync.java` (Android).

> **The two projects are no longer identical, on purpose.** Since 2026-09-06 dev
> carries six tables that live does not. See *Checking for drift* below before
> reading a fingerprint comparison as a fault.

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

---

## Applied

| # | What it does | Dev | Live |
|---|---|---|---|
| 000 | Baseline — six tables, columns, keys, checks, indexes, `set_updated_at()` and its five triggers, RLS on all six with one `own_*` policy each | 2026-09-03 | n/a — this file *describes* live; it was never applied to it |
| 001 | `activities`, `sequences`, `slots`, `progress`. The surface: a lesson or course, the activities placed in it, and where a learner has reached. `slots.id` is a permanent name and `slots.position` is the order, kept apart deliberately | 2026-09-06 | — |
| 002 | `slots.deleted_at`, plus a partial index on the live ones. Removing an activity from a lesson must not destroy the record that it was there | 2026-09-06 | — |
| 003 | `recordings`, `clips`. The walkthrough automation: a take made of clips, each clip holding a media reference with in/out points and its own timed actions | 2026-09-06 | — |
| 004 | `struggles`. Where a learner came unstuck, anchored to a slot id. `slot_id` is `on delete restrict` — the generalised lesson from 002: a reference to a slot must not be allowed to lose its meaning quietly, so a hard delete becomes an error rather than silent loss | 2026-09-06 | — |

*(One row per change from here. Dates, not ticks — knowing **when** live diverged
is worth more than knowing that it did.)*

**None of 001 to 004 belongs in live yet.** They support `surface.html`, which is
scaffolding (`route.md` §4) and is not deployed. Nothing in the website, the
extension or the Android app reads any of these six tables. Applying them to live
would be harmless but pointless until something there uses them.

---

## Checking for drift

`fingerprint.sql` prints the structure of whichever project you run it in, as a
plain list of lines. Run it in both, download both results, compare.

**Identical no longer means no drift, and different no longer means drift.** As of
2026-09-06 dev holds six tables live does not — `activities`, `sequences`,
`slots`, `progress`, `recordings`, `clips` — with their indexes, triggers and
policies, and a seventh, `struggles`, from 004. A comparison will show all of that as a difference, correctly. What to
check is that **the six baseline tables still match** and that the extra lines
account for exactly the changes in the Applied table above and nothing else.

This is the ordinary state of a project that develops in dev first, and it will
stay this way until the surface work reaches live. It is worth saying out loud
because the previous revision of this file said the two matched exactly, and a
reader comparing against that sentence would reasonably conclude something had
gone wrong.

Worth doing before applying anything, so a surprise is found before it is buried
under a new change rather than after.

**The results panel caps at 100 rows and the output is ~135.** Download the
results rather than reading them on screen, or the tail is silently cut — which
is exactly what happened the first time this was run, on 2026-09-03. Dev's output
is now longer again, so this matters more than it did.

**Last run: 2026-09-03. 135 rows each side, identical.** Not re-run since 001 to
004 were applied, so the last comparison predates all seven new tables.

---

## What this does not cover

Honest limits, so nobody assumes more than is here.

- **Data.** Structure only. The two projects hold different rows, deliberately.
- **Accounts.** Users live inside a project. A live account does not exist in dev,
  and the same person signing into both gets two different user IDs. Since row
  IDs are `SHA-256(user_id + "|" + ext_id)`, copying rows between projects is a
  rewrite of every primary key, not an export and import.
- **Dashboard settings outside the database** — Auth providers, email templates,
  Realtime replication, storage, rate limits. Change any of those in live and
  they must be changed in dev by hand. `fingerprint.sql` will not notice.
- **Legacy API keys.** Both projects use them, and Supabase retires them at the
  end of 2026. Migrating is a separate task with a real deadline.
- **Sharing.** Every table in both projects, old and new, carries one policy of
  the same shape: you can read and write your own rows and nobody else's. A
  teacher's lesson is therefore unreadable by a learner. Nothing in 001 to 003
  changes that, and `intent.md` §13 needs it changed eventually. It is a design
  task, not a column.

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
why `activities.kind` and `sequences.kind` in 001 carry none. A permitted value
that never holds a row outlives the idea it came from, and under rule 2 every new
activity type would otherwise be its own numbered change applied to two
databases. Add the constraint once the set of kinds has stopped moving.
