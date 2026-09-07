-- 005-outcomes.sql
-- What happened when a learner reached a slot, and the two authored fields that
-- read it back.
--
-- Written 2026-09-07 by Contractor 05. Applies on top of 001, 002, 003 and 004.
-- Install state: schema-log.md. Never edited once applied -- a correction is 006-.
--
-- WHY THIS IS NEEDED BEFORE BRANCHING. intent.md rev 10 s12 says a lesson can
-- branch: wrong answer routes to remediation, right answer carries on. Nothing
-- today can express "right answer". `struggles` records wrong answers only, and
-- `progress` records a place, not a history. So no-struggle-recorded is
-- indistinguishable from never-got-there, and a condition that tests for success
-- has nothing to read. This table is that missing fact.
--
-- PENDING IS FIRST CLASS, not a later addition. The developer's case is a test:
-- the learner answers, and nobody knows the outcome until a human marks it. So an
-- attempt is created open, and may sit unresolved for days. A design that treats
-- an outcome as arriving at the same moment as the answer cannot represent that
-- at all, and would have to be replaced rather than extended.
--
-- THE SHAPE IS DELIBERATELY LOOSE. `status` is the only thing the lesson reads.
-- Everything else -- a score, a grade, a mark out of ten, a marker's comment, the
-- answer itself -- goes in `detail` as jsonb, on the same reasoning as
-- activities.content and struggles.detail. What an activity should report is not
-- known yet and will not be known until several exist. Narrowing this into columns
-- now would fix a guess into the schema.
--
-- NOT AN EVENT, unlike struggles. An attempt changes: it opens, and later it
-- settles. So it carries updated_at and the trigger, and 004's reasoning for
-- having neither does not apply here.
--
-- NO UNIQUE CONSTRAINT ON (user, slot), deliberately. A learner may attempt the
-- same slot more than once -- that is the retry case. The current attempt is the
-- most recent one; the older rows are the history a teacher wants.
--
-- ON DELETE RESTRICT on slot_id. 002's lesson, generalised by 004 and followed
-- here without variation: a reference to a slot must not be allowed to quietly
-- lose its meaning. Removing an activity from a lesson is deleted_at on the slot
-- and is unaffected.

begin;

-- ---------------------------------------------------------------------------
-- attempts
-- ---------------------------------------------------------------------------

create table public.attempts (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  sequence_id uuid        not null,
  slot_id     uuid        not null,
  status      text        not null default 'open'::text,
  detail      jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id),
  foreign key (sequence_id) references public.sequences(id) on delete cascade,
  foreign key (slot_id)     references public.slots(id)     on delete restrict,
  foreign key (user_id)     references auth.users(id)       on delete cascade
);

-- `status` carries no check constraint, for the same reason struggles.kind does
-- not (schema-log.md): the vocabulary is not settled, and a constraint written
-- now would have to be dropped and rewritten by the first activity that needs a
-- value nobody thought of. The four values written today are:
--
--   open      the learner has started and not finished
--   pending   the learner has finished and nobody has judged it yet
--   passed    settled, and it counts as success
--   failed    settled, and it does not
--
-- Only `passed` and `failed` are terminal. A gate that blocks on `passed` will
-- hold a learner at a `pending` attempt indefinitely, which is why the editor
-- refuses to set a blocking gate on an activity that can return pending.

create index attempts_slot     on public.attempts using btree (slot_id);
create index attempts_sequence on public.attempts using btree (user_id, sequence_id);

-- "the current state of this learner at this slot" -- the query every gate makes
create index attempts_latest on public.attempts
  using btree (user_id, slot_id, created_at desc);

create trigger attempts_set_updated_at
  before update on public.attempts
  for each row execute function public.set_updated_at();

alter table public.attempts enable row level security;

-- Own rows only, like everything else. Which means a teacher cannot read a
-- learner's attempts, so the marking case in the header above does not work yet.
-- route.md s12. This table does not solve sharing and does not pretend to.
create policy own_attempts on public.attempts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- the two authored fields
-- ---------------------------------------------------------------------------

-- Both nullable and absent by default, so a lesson that uses neither is exactly
-- what it is today. This is the whole reason a filter was chosen over a graph:
-- everyone still walks one ordered list, and a condition decides who sees what.
--
-- condition -- who sees this slot at all. Null means everyone.
--   {"show_if": {"slot": "<uuid>", "is": "failed"}}
--
-- gate -- what has to be true before the learner may pass this slot. Null means
-- nothing; reaching it is enough.
--   {"satisfied_when": "passed", "blocks": true}
--
-- Both point at a slot id and never at a position, so the teacher may reorder the
-- lesson freely without changing what any condition means. That is the rule
-- constraint-index.md rev 6 records, applied to a new pair of fields.
--
-- Kept as jsonb rather than columns for the same reason as detail above: the
-- vocabulary of conditions is not settled. intent.md s12 rules out one whole
-- class of them -- a gate the system inferred rather than a teacher authored --
-- and nothing here enforces that, because it is a rule about who writes the
-- value, not about its shape.

alter table public.slots add column condition jsonb;
alter table public.slots add column gate      jsonb;

commit;
