-- fingerprint.sql
-- Prints the structure of whichever project you run it in.
-- Read-only: creates, changes and deletes nothing.
-- Run in BOTH projects, download both results, compare. Any difference is drift.
-- About 135 lines on the current schema -- the results panel caps at 100, so
-- DOWNLOAD the results rather than reading them on screen.

select line from (
  select 1 as s, c.relname::text as a, ''::text as b, 0 as o,
         format('TABLE %s  rls=%s', c.relname, c.relrowsecurity)::text as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
  union all
  select 2, a.attrelid::regclass::text, a.attname::text, a.attnum,
         format('COLUMN %s.%s %s null=%s default=%s', a.attrelid::regclass::text, a.attname,
                format_type(a.atttypid, a.atttypmod), not a.attnotnull,
                coalesce(pg_get_expr(d.adbin, d.adrelid), '-'))::text
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped
  union all
  select 3, con.conrelid::regclass::text, con.conname::text, 0,
         format('CONSTRAINT %s ON %s: %s', con.conname, con.conrelid::regclass::text, pg_get_constraintdef(con.oid))::text
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname='public'
  union all
  select 4, tablename::text, indexname::text, 0, ('INDEX ' || indexdef)::text
    from pg_indexes where schemaname='public'
  union all
  select 5, tablename::text, policyname::text, 0,
         format('POLICY %s ON %s cmd=%s roles=%s using=(%s) check=(%s)', policyname, tablename, cmd,
                roles::text, coalesce(qual,'-'), coalesce(with_check,'-'))::text
    from pg_policies where schemaname='public'
  union all
  select 6, t.tgrelid::regclass::text, t.tgname::text, 0,
         format('TRIGGER %s ON %s: %s', t.tgname, t.tgrelid::regclass::text, pg_get_triggerdef(t.oid))::text
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
   where not t.tgisinternal and n.nspname='public'
) t order by s, a, o, b;
