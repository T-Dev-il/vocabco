# Schema log

> **rev 3 · 2026-09-03** · verified against: `fingerprint.sql` output from both
> Supabase projects, diffed line by line — 135 rows each, no differences
> **Status: current**

Two Supabase projects, same structure, separate data (`route.md` §9).

| | Project ref | Role |
|---|---|---|
| **LIVE** | `vinebdanjgggbcfxrvqd` | Real use. A beta user depends on it |
| **DEV** | `iqbsmayprkagczvirxsr` (`vocab-dev`) | Where things break |

Created 2026-09-03 by Contractor 01. All three clients can point at either — see
`config.js` (website, extension) and `Sync.java` (Android).

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

---

## Applied

| # | What it does | Dev | Live |
|---|---|---|---|
| 000 | Baseline — six tables, columns, keys, checks, indexes, `set_updated_at()` and its five triggers, RLS on all six with one `own_*` policy each | 2026-09-03 | n/a — this file *describes* live; it was never applied to it |

*(One row per change from here. Dates, not ticks — knowing **when** live diverged
is worth more than knowing that it did.)*

---

## Checking for drift

`fingerprint.sql` prints the structure of whichever project you run it in, as a
plain list of lines. Run it in both, download both results, compare. Identical
means no drift.

Worth doing before applying anything, so a surprise is found before it is buried
under a new change rather than after.

**The results panel caps at 100 rows and the output is ~135.** Download the
results rather than reading them on screen, or the tail is silently cut — which
is exactly what happened the first time this was run, on 2026-09-03.

**Last run: 2026-09-03. 135 rows each side, identical.**

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
