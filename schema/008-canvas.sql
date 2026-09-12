-- 008-canvas.sql — the canvas: boards, and what is loose on them.
--
-- WHY
--
-- studio-design-proposal.md §5. The canvas is the teacher's messy space: free
-- layout, notes among the cards, tabs across the top because today's group is
-- not the same thing as a shelf of scraps. Nothing on it is committed, which is
-- what makes it safe to be messy on.
--
-- The schema has nowhere to put any of that. A lesson is `sequences` + `slots`;
-- a board is neither.
--
-- WHY NOT slots, which already place a thing at a point
--
-- Three reasons, and the first is the one that decides it:
--
--   1. `used in 2 lessons` has to be real rather than decorative (§7), and the
--      door counts it straight off `slots`. A card sitting on a board is not a
--      use. Storing canvas placements as slots would inflate that count with
--      things the teacher has explicitly not committed to, and the one number
--      the design leans on stops being true.
--   2. A slot has a position, a register and a parent — an ordered list with a
--      trunk. A board has x and y and no order at all. The columns would sit
--      null on every canvas row and the meaning of the table would blur.
--   3. A sticky note is not an activity and has no activity_id. `slots` forbids
--      that outright: one_member_kind requires an activity or a child sequence.
--
-- So: two small tables, and `slots` keeps meaning exactly what it means today.
-- Carrying across (§5) then reads as what it is — a row is written to `slots`
-- at the moment something stops being loose, and the canvas row stays where it
-- is, because putting something in a lesson does not take it off your desk.
--
-- Follows the shapes already in 000-baseline.sql and 001-sequences.sql: the
-- same id/user_id columns, the same one-member check, the same deleted_at, the
-- same one ALL policy per table. Where it differs, a comment says why.
--
-- Contractor 08, 2026-09-12. Dev first, and live only after dev has been used.
--
-- Rule, from schema-log.md: this file is never edited after it has been applied
-- anywhere. A correction arrives as 009-.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- boards  (one canvas tab)
--
-- `Thursday, 4pm group`. `B1 evening`. `Scraps`. §12 leaves open whether tabs
-- belong to groups, to dates, or to neither, so this decides nothing: a board
-- is a name and an order, and the teacher can mean by it whatever they like.
-- If it later turns out they belong to something, that arrives as a nullable
-- column pointing at it.
--
-- No master_id / divorced pair, unlike activities and sequences. Those carry it
-- because intent.md §8 wants linked copies of the things a lesson is made of. A
-- board is furniture, not material — nobody links a copy of a desk.
--
-- No ext_id either: nothing syncs a board in from another client. The canvas is
-- a page on the website and there is one of it.
-- ─────────────────────────────────────────────────────────────────────────

create table public.boards (
  id         uuid        not null default gen_random_uuid(),
  user_id    uuid        not null default auth.uid(),
  name       text        not null default 'Canvas'::text,
  position   integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (id),
  foreign key (user_id) references auth.users(id) on delete cascade
);

create index boards_user_live on public.boards using btree (user_id, position)
  where deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────────
-- board_items  (one thing lying on one board)
--
-- Either a card — an activity the teacher owns — or a note. Never both, never
-- neither. one_item_kind copies collection_items and slots exactly.
--
-- A note is text and nothing else. It has no name, no kind and no content
-- shape, because the whole point of §5 is that a half-formed thought about a
-- structure that failed last week costs nothing sitting there. The moment a
-- note needs a shape it has stopped being a note and wants to be an activity.
--
-- x, y, w in pixels, and the page owns what they mean. The mockup's cards are
-- ~132px and its notes ~146px; h is deliberately absent, because a note grows
-- with its text and a card is as tall as a card.
--
-- z because free layout means things overlap, and bring-to-front needs
-- somewhere to live. Highest wins. The page renumbers freely; nothing points at
-- a z.
--
-- NO unique index on (board_id, activity_id), and for the same reason slots has
-- none on (sequence_id, activity_id): the same reader may legitimately sit on
-- the board twice while the teacher works out where it goes.
--
-- activity_id cascades, matching slots.activity_id. Activities are soft-deleted
-- in practice, so this fires rarely; when it does, the card should go rather
-- than hang pointing at nothing.
-- ─────────────────────────────────────────────────────────────────────────

create table public.board_items (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  board_id    uuid        not null,
  activity_id uuid,
  note        text,
  x           integer     not null default 0,
  y           integer     not null default 0,
  w           integer     not null default 132,
  z           integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id),
  foreign key (board_id)    references public.boards(id)     on delete cascade,
  foreign key (activity_id) references public.activities(id) on delete cascade,
  foreign key (user_id)     references auth.users(id)        on delete cascade,
  -- exactly one of the two, never both, never neither
  constraint one_item_kind check (
    ((activity_id is not null) and (note is null)) or
    ((activity_id is null) and (note is not null))
  )
);

-- The common query is "everything on this board". There is no second one.
create index board_items_board    on public.board_items using btree (board_id, z);
create index board_items_activity on public.board_items using btree (activity_id);

-- ─────────────────────────────────────────────────────────────────────────
-- No deleted_at on board_items, and this is a departure worth naming.
--
-- Everything else in this project soft-deletes, because something points at it:
-- attempts and recorded actions point at slot ids, so a removed slot has to
-- keep existing to be explained. Nothing points at a board item. Taking a card
-- off the desk is the gesture, not a record, and a canvas that quietly kept
-- every scrap ever swept off it would be the opposite of the thing §5 asks for.
--
-- Removing a card never touches the activity. The activity is in the library
-- and stays there — which is the half of this that has to be visible on screen,
-- or a teacher will not dare tidy.
-- ─────────────────────────────────────────────────────────────────────────

create trigger trg_boards_updated      before update on public.boards
  for each row execute function public.set_updated_at();
create trigger trg_board_items_updated before update on public.board_items
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- row level security — one ALL policy per table, the same shape as all ten
-- tables that already exist. Own rows only (route.md §12).
-- ─────────────────────────────────────────────────────────────────────────

alter table public.boards      enable row level security;
alter table public.board_items enable row level security;

create policy own_boards on public.boards
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_board_items on public.board_items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;
