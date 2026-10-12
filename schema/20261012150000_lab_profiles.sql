-- 20261012150000_lab_profiles.sql — Contractor 17 (RL), 2026-10-12.
--
-- EXPERIMENTAL. Big T's call, 2026-10-12: "a table that serves us just for the
-- sake of experimentation; we're not committing to anything". It lets saved
-- profiles leave the browser so practice can read them, while Socrates and Big T
-- decide where profiles really belong. It touches no existing table, so it can
-- be dropped in one line:  drop table public.lab_profiles;
--
-- One row per saved profile. note_id is the browser's own id for it (the
-- vc.readerlab.notes list in Sample reader 1); term_id is the saved item's id
-- when the profile came from Add++. profile is the whole snapshot, as the reader
-- builds it (profileSnapshot), including each example's pieces for blanking.
--
-- Apply to DEV only.

create table public.lab_profiles (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  note_id     text        not null,
  term_id     text,
  text_id     text,
  lang        text,
  item        text        not null,
  profile     jsonb       not null,
  about       jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (id),
  foreign key (user_id) references auth.users(id) on delete cascade
);

create unique index lab_profiles_user_note on public.lab_profiles using btree (user_id, note_id);

create trigger trg_lab_profiles_updated before update on public.lab_profiles
  for each row execute function public.set_updated_at();

alter table public.lab_profiles enable row level security;

create policy own_lab_profiles on public.lab_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
