-- 006-register.sql — step or handout, authored rather than guessed.
--
-- WHY
--
-- studio-design-proposal.md §4 says two things about a slot that the schema has
-- no room for:
--
--   structure — is this its own step, or is it attached to one?
--   register  — does it draw as the stage, or as a cream card meaning
--               *handed to you*?
--
-- They are deliberately separate. A worksheet after an activity ends has its own
-- number AND feels handed to you. So the two cannot be one column, and register
-- cannot be derived from structure.
--
-- Until now studio.html derived both from `condition`: a slot shown on another
-- slot's outcome hung off it and drew cream. That was a stopgap for a read-only
-- page. The moment the quick rack can add something, the teacher is asked "step
-- or handout" at the point of adding, and the answer needs somewhere to go.
--
-- Both nullable, so every existing slot keeps behaving exactly as it does today
-- and the derivation in studio.html stays as the fallback.
--
-- NOTE ON PLACEMENT, not on activities. The same activity is a step in one
-- lesson and a handout in another. This belongs on the placement, which is what
-- slots is. Putting it on activities would make one lesson's choice leak into
-- every other lesson that used it.
--
-- Contractor 07, 2026-09-09. Applied to dev only.

begin;

-- null means "work it out the old way" — see attachedTo() in studio.html.
-- A value here is the teacher's own answer and wins over any derivation.
alter table public.slots add column parent_slot_id uuid;
alter table public.slots add column register       text;

alter table public.slots
  add constraint slots_parent_fk
  foreign key (parent_slot_id) references public.slots(id) on delete set null;

-- on delete set null, not cascade. Deleting a step must not silently take its
-- handouts with it — they become loose steps and stay visible, which is the
-- failure a teacher can see and fix. Cascade is the failure they cannot.

create index slots_parent on public.slots using btree (parent_slot_id);

-- No check constraint on register, for the same reason attempts.status carries
-- none (005-outcomes.sql): the vocabulary is not settled. The two values written
-- today are 'stage' and 'handout'.

commit;
