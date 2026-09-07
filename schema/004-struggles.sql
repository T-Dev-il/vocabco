-- 004-struggles.sql
-- A struggle, recorded against the point in the lesson where it happened.
-- The last unticked item on route.md §3's list of six.
--
-- Written 2026-09-06. Applies on top of 001, 002 and 003.
-- Install state: schema-log.md. Never edited once applied — a correction is 005-.
--
-- WHAT IT IS FOR. intent.md §13: a teacher reads where a cohort struggled and
-- goes back in to fix that spot. §18: feedback aggregates across a cohort and
-- shares this position-tracking. Neither can be built until struggles exist.
--
-- slot_id, NOT a position. Same decision as progress, for the same reason: the
-- teacher edits the lesson between cohorts, and a number would silently start
-- describing a different activity.
--
-- ON DELETE RESTRICT, deliberately, and this is the one interesting line here.
-- 001 gave progress.slot_id `on delete set null`, which destroyed the fact it
-- existed to keep, and 002 exists because of that. The lesson generalises: a
-- reference to a slot must not be allowed to quietly lose its meaning. RESTRICT
-- refuses to hard-delete a slot that struggles point at, so the mistake becomes
-- an error message rather than silent data loss. Removing an activity from a
-- lesson is `deleted_at` and is unaffected — which is exactly the case the
-- developer asked for: a teacher can still see that people struggled at
-- something since taken out.
--
-- Rows are events. No updated_at, no trigger, no deleted_at: an event is not
-- edited and is not withdrawn.
--
-- `kind` carries no check constraint, for the reason recorded in schema-log.md.
-- Today the only value written is 'wrong_answer'.

begin;

create table public.struggles (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  sequence_id uuid        not null,
  slot_id     uuid        not null,
  kind        text        not null default 'wrong_answer'::text,
  detail      jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (id),
  foreign key (sequence_id) references public.sequences(id) on delete cascade,
  foreign key (slot_id)     references public.slots(id)     on delete restrict,
  foreign key (user_id)     references auth.users(id)       on delete cascade
);

-- "how often was this spot struggled at" is the query the teacher's screen makes
create index struggles_slot     on public.struggles using btree (slot_id);
create index struggles_sequence on public.struggles using btree (user_id, sequence_id);

alter table public.struggles enable row level security;

-- Same shape as every other table: your own rows only. Which means a teacher
-- cannot yet read a learner's struggles — the whole point of the feature. See
-- route.md §12; this table does not solve sharing and does not pretend to.
create policy own_struggles on public.struggles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;
