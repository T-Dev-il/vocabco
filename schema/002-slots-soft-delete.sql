-- 002-slots-soft-delete.sql
-- Removing an activity from a lesson must not destroy the record that it was
-- ever there.
--
-- Written 2026-09-06. Applies on top of 001. Install state: schema-log.md.
--
-- Rule, from schema-log.md: this file is never edited after it has been applied
-- anywhere. A correction arrives as 003-. Dev first.
--
-- WHY. 001 gave progress.slot_id a foreign key with `on delete set null`. So
-- deleting a slot blanked every learner's place in it. Found by testing on
-- 2026-09-07: delete the activity a learner is sitting on, press Resume, and the
-- lesson silently starts over -- because nothing was left to say otherwise. The
-- app could not tell "your step was removed" from "you never began".
--
-- The same rule would have destroyed struggle records and feedback, which point
-- at slots for exactly the same reason. Those tables do not exist yet, so this
-- is being fixed before anything is written that could be lost.
--
-- The fix is not a different foreign-key rule. It is to stop deleting the row.
-- A removed slot keeps its id, its position and what it pointed at, so the app
-- can say what was removed and what came after it. Every other table here
-- already works this way -- deleted_at plus trash_batch, never a hard delete.
--
-- No column is dropped and no data is touched. 001 stays as it is.

begin;

alter table public.slots add column deleted_at timestamptz;

-- The common query is "the live slots of this sequence, in order".
create index slots_sequence_live on public.slots using btree (sequence_id, position)
  where deleted_at is null;

commit;
