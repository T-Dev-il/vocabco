# Schema log

> **rev 1 · 2026-09-03** · Contractor 01
> **Status: current.** This file is the record of what has been applied where.

Two Supabase projects, same structure, separate data (`route.md` §9).

| | Project ref | Role |
|---|---|---|
| **LIVE** | `vinebdanjgggbcfxrvqd` | Real use. A beta user depends on it |
| **DEV** | `iqbsmayprkagczvirxsr` (`vocab-dev`) | Where things break |

---

## The rules

There are four, and they are short on purpose.

**1. Every schema change is a numbered file in `schema/`.**
Never a change typed straight into the dashboard. If it was typed into the
dashboard, it does not exist, and the other project will never receive it.

**2. A file is never edited once it has been applied anywhere.**
Wrong change? Write the next number to correct it. Editing an applied file makes
the two projects silently disagree while the log claims they match.

**3. Dev first, then live — and live only after dev has been used.**
Not "applied to dev", *used*. Open the app against dev, save a word, open the
reader, edit something. The point of dev is to spend the mistake there.

**4. Both columns get ticked in the table below, or the row is not done.**
An empty LIVE column is the drift. That is the whole mechanism.

---

## Applied

| # | What it does | Dev | Live |
|---|---|---|---|
| 000 | Baseline — the structure as it stood on 2026-09-03: six tables, their columns, keys, checks, indexes, `set_updated_at()` and its five triggers, RLS on all six tables with one `own_*` policy each | | *already there — this file describes live, it was not applied to it* |

*(Add a row per change. Dates, not ticks — knowing **when** live diverged is worth more than knowing **that** it did.)*

---

## Checking for drift

`fingerprint.sql` prints the structure of whichever project you run it in as a
plain list of lines. Run it in both, save both results, compare them. Identical
means no drift. A difference is a change that reached one project and not the
other.

Worth doing before applying anything, so a surprise is found before it is buried
under a new change rather than after.

**Note the results panel caps at 100 rows.** The baseline produces about 135
lines, so download the results rather than reading them on screen, or the tail
gets silently cut — which is what happened the first time this was run.

---

## What this does not cover

Honest limits, so nobody assumes more than is here.

- **Data.** Only structure. The two projects hold different rows, deliberately.
- **Accounts.** Users live inside a project. An account in live does not exist in
  dev, and the same person signing into both gets two different user IDs.
- **Dashboard settings outside the database** — Auth providers, email templates,
  storage buckets, rate limits. If any of those are ever changed in live, they
  must be changed in dev by hand, and there is no automatic check for it.
- **The `sources` RLS discrepancy is resolved:** RLS *is* on for `sources`, with
  policy `own_sources`. `backend-current-state.md` §5 and §11 say otherwise and
  are wrong. The baseline reflects the database, not the doc.
