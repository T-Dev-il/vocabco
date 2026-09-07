-- 001-sequences.sql
-- The surface: activities, sequences (lessons and courses), the slots that
-- place one inside the other, and a learner's position.
--
-- Written 2026-09-06. Install state is recorded in schema-log.md, not here.
--
-- Rule, from schema-log.md: this file is never edited after it has been
-- applied anywhere. A correction arrives as 002-. Dev first, and live only
-- after dev has actually been used.
--
-- Deliberately incomplete. Struggle records, feedback and lesson versions are
-- not here; all three are additive later and all three point at slot ids.
-- Everything below follows the shapes already in 000-baseline.sql -- the same
-- id/user_id/ext_id columns, the same master_id + divorced pair, the same
-- one-member check, the same RLS policy per table. Where it differs from the
-- baseline, a comment says why.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- activities  (a question set, an embedded video, a text, a game)
--
-- kind carries NO check constraint, on purpose, and this is a departure from
-- collections.kind and sources.kind. Adding an activity type is the whole
-- point of the experimentation phase, and under the schema rules a check
-- constraint means every new type is its own numbered migration applied to
-- two databases. Add the constraint once the set has stopped moving.
-- sources.kind is the warning: it permits 'page' and 'highlight' and neither
-- has ever held a row.
--
-- content is jsonb because the shape differs per kind and will change often.
-- It is potentially large -- never select it in a list query. That is what
-- FIX-004 and FIX-006 were about.
-- ─────────────────────────────────────────────────────────────────────────

create table public.activities (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  name        text        not null default 'Untitled'::text,
  kind        text        not null,
  content     jsonb       not null default '{}'::jsonb,
  master_id   uuid,
  divorced    boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  trash_batch text,
  ext_id      text,
  primary key (id),
  foreign key (master_id) references public.activities(id) on delete cascade,
  foreign key (user_id)   references auth.users(id)        on delete cascade
);

-- the same three indexes items carries, for the same three queries
create        index activities_masters_live on public.activities using btree (user_id)
                where master_id is null and deleted_at is null;
create unique index activities_user_extid   on public.activities using btree (user_id, ext_id);
create        index activities_user_master  on public.activities using btree (user_id, master_id);

-- ─────────────────────────────────────────────────────────────────────────
-- sequences  (a lesson, or a course whose members are lessons)
--
-- There is no top level. A sequence holds activities, or other sequences, or
-- both. A course is a sequence of lessons; whatever is not currently inside
-- something else is the top.
--
-- kind is a label for the screen, not a rule -- no check, same reasoning as
-- activities.kind. Expected values today: 'lesson', 'course'.
--
-- folder_id points at the EXISTING collections table, where kind='folder'.
-- sources.folder_id already does exactly this. Folders organise; a course is
-- a thing a learner takes. They are not the same and both exist.
-- ─────────────────────────────────────────────────────────────────────────

create table public.sequences (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  name        text        not null default 'Untitled'::text,
  kind        text        not null default 'lesson'::text,
  folder_id   uuid,
  master_id   uuid,
  divorced    boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  trash_batch text,
  ext_id      text,
  primary key (id),
  foreign key (folder_id) references public.collections(id) on delete set null,
  foreign key (master_id) references public.sequences(id)   on delete cascade,
  foreign key (user_id)   references auth.users(id)         on delete cascade
);

create        index sequences_masters_live on public.sequences using btree (user_id)
                where master_id is null and deleted_at is null;
create unique index sequences_user_extid   on public.sequences using btree (user_id, ext_id);
create        index sequences_user_master  on public.sequences using btree (user_id, master_id);
create        index sequences_user_folder  on public.sequences using btree (user_id, folder_id);

-- ─────────────────────────────────────────────────────────────────────────
-- slots  (one placement of one member at one point in one sequence)
--
-- THE POINT OF THIS TABLE. A slot's id is permanent and is never rewritten.
-- Struggle records, feedback and recorded walkthrough actions all point at a
-- slot id. position is a separate column and may be rewritten freely, so
-- dragging a tile changes where things sit and changes nothing about what
-- anything points at.
--
-- No separate "tag" column: the primary key already is one.
--
-- one_member_kind copies collection_items exactly -- a slot holds an activity
-- or a child sequence, never both, never neither.
--
-- Deliberately NO unique index on (sequence_id, activity_id). Unlike a list,
-- a lesson may legitimately use the same activity twice -- a warm-up and a
-- review. collection_items forbids this; slots must not.
--
-- A sequence containing itself is not prevented here. collections has the
-- same gap and guards it in app.js instead; match that.
--
-- Has updated_at and a trigger, unlike collection_items, because position is
-- edited in place and knowing when is worth having.
-- ─────────────────────────────────────────────────────────────────────────

create table public.slots (
  id                uuid        not null default gen_random_uuid(),
  user_id           uuid        not null default auth.uid(),
  sequence_id       uuid        not null,
  activity_id       uuid,
  child_sequence_id uuid,
  position          integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  foreign key (sequence_id)       references public.sequences(id)  on delete cascade,
  foreign key (activity_id)       references public.activities(id) on delete cascade,
  foreign key (child_sequence_id) references public.sequences(id)  on delete cascade,
  foreign key (user_id)           references auth.users(id)        on delete cascade,
  -- exactly one of the two, never both, never neither
  constraint one_member_kind check (
    ((activity_id is not null) and (child_sequence_id is null)) or
    ((activity_id is null) and (child_sequence_id is not null))
  )
);

create index slots_sequence on public.slots using btree (sequence_id, position);
create index slots_activity on public.slots using btree (activity_id);
create index slots_child    on public.slots using btree (child_sequence_id);

-- ─────────────────────────────────────────────────────────────────────────
-- progress  (where one person has reached in one sequence)
--
-- slot_id, not a number. That is the same decision as everything above: the
-- teacher can insert, delete and reorder, and the learner still resumes in
-- the right place. null means started but not yet past the first slot.
--
-- on delete set null: if the teacher removes the slot a learner was sitting
-- on, the progress row survives and the app decides where to put them. It
-- must not silently point at whatever moved into that position.
-- ─────────────────────────────────────────────────────────────────────────

create table public.progress (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  sequence_id uuid        not null,
  slot_id     uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id),
  foreign key (sequence_id) references public.sequences(id) on delete cascade,
  foreign key (slot_id)     references public.slots(id)     on delete set null,
  foreign key (user_id)     references auth.users(id)       on delete cascade
);

create unique index progress_user_sequence on public.progress using btree (user_id, sequence_id);

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at triggers, using the function the baseline already created
-- ─────────────────────────────────────────────────────────────────────────

create trigger trg_activities_updated before update on public.activities
  for each row execute function public.set_updated_at();
create trigger trg_sequences_updated  before update on public.sequences
  for each row execute function public.set_updated_at();
create trigger trg_slots_updated      before update on public.slots
  for each row execute function public.set_updated_at();
create trigger trg_progress_updated   before update on public.progress
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- row level security -- one ALL policy per table, same shape as all six
-- existing tables: you can only see and write your own rows.
--
-- READ THIS: it means a learner cannot see a teacher's lesson. Sharing is
-- not possible under these policies and is not a small addition -- it needs
-- its own design and its own numbered change. Everything above works for one
-- account working alone, which is what the experimentation phase needs.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.activities enable row level security;
alter table public.sequences  enable row level security;
alter table public.slots      enable row level security;
alter table public.progress   enable row level security;

create policy own_activities on public.activities
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_sequences  on public.sequences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_slots      on public.slots
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_progress   on public.progress
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;
