-- 000-baseline.sql
-- The live schema as it stood on 2026-09-03, read from the live project's
-- catalogue (pg_class, pg_attribute, pg_constraint, pg_indexes, pg_policies,
-- pg_trigger). Not written from the docs -- several doc claims were wrong.
--
-- Purpose: run this once in a fresh Supabase project to produce a structure
-- identical to live. It creates no data and no users.
--
-- Rule: this file is never edited after it has been applied. Later changes
-- arrive as 001-, 002- and so on, and are recorded in schema-log.md.
--
-- Deliberately faithful, not improved. Anything here that looks wrong is
-- wrong in live too and should be fixed as its own numbered change, applied
-- to dev first.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- shared trigger function
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- collections  (lists, highlight-lists and folders)
-- created first: sources and collection_items point at it, and it points at
-- itself via parent_id
-- ─────────────────────────────────────────────────────────────────────────

create table public.collections (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  name        text        not null default 'Untitled'::text,
  kind        text        not null
                check (kind = any (array['list'::text, 'highlight_list'::text, 'folder'::text])),
  parent_id   uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  trash_batch text,
  ext_id      text,
  primary key (id),
  foreign key (parent_id) references public.collections(id) on delete set null,
  foreign key (user_id)   references auth.users(id)         on delete cascade
);

create unique index collections_user_extid on public.collections using btree (user_id, ext_id);
create        index collections_user_kind  on public.collections using btree (user_id, kind);

-- ─────────────────────────────────────────────────────────────────────────
-- sources  (texts and video-texts)
-- ─────────────────────────────────────────────────────────────────────────

create table public.sources (
  id             uuid        not null default gen_random_uuid(),
  user_id        uuid        not null default auth.uid(),
  kind           text        not null default 'text'::text
                   check (kind = any (array['text'::text, 'video'::text, 'highlight'::text, 'page'::text])),
  title          text        not null default ''::text,
  url            text        not null default ''::text,
  body           text        not null default ''::text,
  video_id       text,
  segments       jsonb,
  marks          jsonb       default '[]'::jsonb,
  folder_id      uuid,
  engaged_ms     bigint      not null default 0,
  last_active_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  trash_batch    text,
  ext_id         text,
  primary key (id),
  foreign key (folder_id) references public.collections(id) on delete set null,
  foreign key (user_id)   references auth.users(id)         on delete cascade
);

create        index sources_user       on public.sources using btree (user_id);
create unique index sources_user_extid on public.sources using btree (user_id, ext_id);

-- ─────────────────────────────────────────────────────────────────────────
-- items  (vocabulary masters and their linked copies)
-- ─────────────────────────────────────────────────────────────────────────

create table public.items (
  id            uuid        not null default gen_random_uuid(),
  user_id       uuid        not null default auth.uid(),
  surface       text        not null,
  translation   text,
  context       text        not null default ''::text,
  note          text        not null default ''::text,
  item_type     text
                  check (item_type = any (array['word'::text, 'phrase'::text, 'idiom'::text, 'disjoint'::text, 'sentence'::text])),
  is_disjoint   boolean     not null default false,
  language_pair text,
  source_id     uuid,
  source_url    text        not null default ''::text,
  source_title  text        not null default ''::text,
  tags          text[]      not null default '{}'::text[],
  master_id     uuid,
  divorced      boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  trash_batch   text,
  ext_id        text,
  primary key (id),
  foreign key (master_id) references public.items(id)   on delete cascade,
  foreign key (source_id) references public.sources(id) on delete set null,
  foreign key (user_id)   references auth.users(id)     on delete cascade
);

-- partial index: the common query is "my live masters", not "all my rows"
create        index items_masters_live on public.items using btree (user_id)
                where master_id is null and deleted_at is null;
create unique index items_user_extid   on public.items using btree (user_id, ext_id);
create        index items_user_master  on public.items using btree (user_id, master_id);
create        index items_user_source  on public.items using btree (user_id, source_id);

-- ─────────────────────────────────────────────────────────────────────────
-- highlights
-- ─────────────────────────────────────────────────────────────────────────

create table public.highlights (
  id           uuid        not null default gen_random_uuid(),
  user_id      uuid        not null default auth.uid(),
  text         text        not null,
  color        text        not null default 'yellow'::text
                 check (color = any (array['yellow'::text, 'pink'::text, 'blue'::text])),
  note         text        not null default ''::text,
  source_id    uuid,
  source_url   text        not null default ''::text,
  source_title text        not null default ''::text,
  master_id    uuid,
  divorced     boolean     not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  trash_batch  text,
  ext_id       text,
  primary key (id),
  foreign key (master_id) references public.highlights(id) on delete cascade,
  foreign key (source_id) references public.sources(id)    on delete set null,
  foreign key (user_id)   references auth.users(id)        on delete cascade
);

create unique index highlights_user_extid  on public.highlights using btree (user_id, ext_id);
create        index highlights_user_master on public.highlights using btree (user_id, master_id);

-- ─────────────────────────────────────────────────────────────────────────
-- collection_items  (membership: one collection to one item OR one highlight)
-- ─────────────────────────────────────────────────────────────────────────

create table public.collection_items (
  id            uuid        not null default gen_random_uuid(),
  user_id       uuid        not null default auth.uid(),
  collection_id uuid        not null,
  item_id       uuid,
  highlight_id  uuid,
  created_at    timestamptz not null default now(),
  primary key (id),
  foreign key (collection_id) references public.collections(id) on delete cascade,
  foreign key (item_id)       references public.items(id)       on delete cascade,
  foreign key (highlight_id)  references public.highlights(id)  on delete cascade,
  foreign key (user_id)       references auth.users(id)         on delete cascade,
  -- exactly one of the two, never both, never neither
  constraint one_member_kind check (
    ((item_id is not null) and (highlight_id is null)) or
    ((item_id is null) and (highlight_id is not null))
  )
);

create index collection_items_coll on public.collection_items using btree (collection_id);
create index collection_items_hl   on public.collection_items using btree (highlight_id);
create index collection_items_item on public.collection_items using btree (item_id);

-- partial unique: the same item cannot be added to the same list twice
create unique index collection_items_item_uniq on public.collection_items using btree (collection_id, item_id)
       where item_id is not null;
create unique index collection_items_hl_uniq   on public.collection_items using btree (collection_id, highlight_id)
       where highlight_id is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- settings  (one row per user: { reader, web, prompts, session })
-- ─────────────────────────────────────────────────────────────────────────

create table public.settings (
  user_id    uuid        not null default auth.uid(),
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id),
  foreign key (user_id) references auth.users(id) on delete cascade
);

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- collection_items has no updated_at and so has no trigger -- this matches live
-- ─────────────────────────────────────────────────────────────────────────

create trigger trg_collections_updated before update on public.collections
  for each row execute function public.set_updated_at();
create trigger trg_sources_updated     before update on public.sources
  for each row execute function public.set_updated_at();
create trigger trg_items_updated       before update on public.items
  for each row execute function public.set_updated_at();
create trigger trg_highlights_updated  before update on public.highlights
  for each row execute function public.set_updated_at();
create trigger trg_settings_updated    before update on public.settings
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- row level security
-- One ALL policy per table, on the public role, in both directions:
-- USING governs which rows are readable, WITH CHECK which may be written.
-- This is what stops one signed-in account from touching another's rows.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.collections      enable row level security;
alter table public.sources          enable row level security;
alter table public.items            enable row level security;
alter table public.highlights       enable row level security;
alter table public.collection_items enable row level security;
alter table public.settings         enable row level security;

create policy own_collections      on public.collections
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_sources          on public.sources
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_items            on public.items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_highlights       on public.highlights
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_collection_items on public.collection_items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_settings         on public.settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;
