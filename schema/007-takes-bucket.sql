-- 007-takes-bucket.sql — somewhere to put the footage.
--
-- WHY
--
-- Until now a take recorded what the teacher DID and nothing of what they said.
-- Capturing camera and microphone needs a file per clip, and files are not rows,
-- so this is the project's first use of Supabase Storage.
--
-- Per CLIP, not per recording. §6: a take resumed tomorrow appends a clip, and
-- that clip is its own file. Nothing stitches yesterday and today together on
-- disk — only playback lays them end to end, and only while playing.
--
-- The path is `<user_id>/<recording_id>/<clip_id>.webm`. The user id leads
-- because the policies below read it: own files only, which is the same rule
-- every table in this project already follows (route.md §12).
--
-- clips.media becomes { seconds, path, mime }. 003-recordings.sql left the shape
-- open on purpose; this is the first thing written into it.
--
-- NOT public. A signed URL is minted when a take is played and expires in an
-- hour. A public bucket would put a teacher's classroom on the open internet
-- behind nothing but a guessable path.
--
-- Contractor 07, 2026-09-09. Applied to dev only.

begin;

insert into storage.buckets (id, name, public)
values ('takes', 'takes', false)
on conflict (id) do nothing;

-- Four policies rather than one `for all`, because storage.objects is a shared
-- table across every bucket — each one has to name this bucket itself.
--
-- `storage.foldername(name)` splits the path; element 1 is the first folder,
-- which is the user id. So "you may touch files under your own id, and nothing
-- else in this bucket".

create policy takes_read on storage.objects
  for select using (
    bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy takes_insert on storage.objects
  for insert with check (
    bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy takes_update on storage.objects
  for update using (
    bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy takes_delete on storage.objects
  for delete using (
    bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;

-- NOT DONE HERE, and worth knowing:
--
-- Nothing deletes these files. Removing a recording row cascades its clips but
-- leaves the objects in the bucket, because storage has no foreign keys. A take
-- deleted today is a file paid for forever. That needs either a trigger or a
-- sweep, and neither is written.
