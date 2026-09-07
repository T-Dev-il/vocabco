-- 003-recordings.sql
-- The walkthrough automation: a recording of a lesson, made of clips, each clip
-- carrying its own timed actions.
--
-- Written 2026-09-06. Applies on top of 001 and 002. Install state: schema-log.md.
--
-- Rule, from schema-log.md: never edited after it has been applied anywhere. A
-- correction arrives as 004-. Dev first.
--
-- ── the shape, and why ───────────────────────────────────────────────────
--
-- route.md §3: the automation is a LIST OF TIMED ACTIONS, editable from the very
-- first version, because post-hoc patching, the two-minute re-record and the
-- handout all depend on it. Building it baked and converting later is the
-- expensive path.
--
-- A recording is therefore an ordered list of clips rather than one lump. That is
-- what lets two minutes be squeezed into the middle without re-recording.
--
-- AN ACTION'S TIME IS MEASURED FROM THE START OF ITS OWN CLIP. Not from the start
-- of the recording. This is the same decision as slots.position versus slots.id,
-- with time as the axis: if actions were timed from the start of the whole thing,
-- inserting a clip in the middle would silently move every action after it.
--
-- NO MEDIA IS STORED HERE. A clip holds a reference -- provider, id, and the in
-- and out points of the stretch to play -- so a snip is a few numbers rather than
-- a copy. FIX-004 is why: this project has already been taken off the air once by
-- data volume, and that was text.
--
-- Snipping five minutes out to reuse elsewhere is the linked-copy mechanism that
-- items, activities and sequences already use: a new recording with master_id
-- pointing at the original. No extra table.
--
-- clips.actions is jsonb and deliberately unconstrained. What an action IS is the
-- thing this whole exercise is meant to find out.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- recordings  (one walkthrough of one lesson)
--
-- A lesson may have several -- versions, or different teachers. sequence_id says
-- which lesson it walks through. A snip taken for reuse is a new recording whose
-- master_id points at the one it came from.
-- ─────────────────────────────────────────────────────────────────────────

create table public.recordings (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  sequence_id uuid        not null,
  name        text        not null default 'Untitled'::text,
  master_id   uuid,
  divorced    boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  trash_batch text,
  ext_id      text,
  primary key (id),
  foreign key (sequence_id) references public.sequences(id)  on delete cascade,
  foreign key (master_id)   references public.recordings(id) on delete cascade,
  foreign key (user_id)     references auth.users(id)        on delete cascade
);

create        index recordings_sequence     on public.recordings using btree (user_id, sequence_id);
create unique index recordings_user_extid   on public.recordings using btree (user_id, ext_id);
create        index recordings_user_master  on public.recordings using btree (user_id, master_id);

-- ─────────────────────────────────────────────────────────────────────────
-- clips  (one stretch of media, with the actions that fire during it)
--
-- id is permanent and never rewritten; position is rewritten freely. Same
-- decision as slots, for the same reason.
--
-- media: { provider, ref, in_s, out_s } -- where it lives, what identifies it,
-- and which stretch to play. Nothing is copied or re-encoded.
--
-- actions: [ { t, kind, ... } ] with t in seconds FROM THE START OF THIS CLIP.
--
-- Removed rather than deleted, as slots are after 002.
-- ─────────────────────────────────────────────────────────────────────────

create table public.clips (
  id           uuid        not null default gen_random_uuid(),
  user_id      uuid        not null default auth.uid(),
  recording_id uuid        not null,
  position     integer     not null default 0,
  media        jsonb       not null default '{}'::jsonb,
  actions      jsonb       not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (id),
  foreign key (recording_id) references public.recordings(id) on delete cascade,
  foreign key (user_id)      references auth.users(id)        on delete cascade
);

create index clips_recording_live on public.clips using btree (recording_id, position)
  where deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at triggers, using the function the baseline created
-- ─────────────────────────────────────────────────────────────────────────

create trigger trg_recordings_updated before update on public.recordings
  for each row execute function public.set_updated_at();
create trigger trg_clips_updated      before update on public.clips
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- row level security -- same shape as every other table: your own rows only.
-- A learner still cannot see a teacher's recording. Sharing remains unbuilt
-- and needs its own design.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.recordings enable row level security;
alter table public.clips      enable row level security;

create policy own_recordings on public.recordings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_clips      on public.clips
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;
