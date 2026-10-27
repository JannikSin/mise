-- Mise 2.0 db fix loop 3, item 3 (Engineer E3): write_doc is the only door
-- into public.docs for a signed-in client.
--
-- Before: authenticated held insert (path, data) and update (data) on docs, and
-- docs_before ran the path and name checks before RLS WITH CHECK. A direct
-- insert into a house the caller is not in answered P0422 for a hidden word,
-- 42501 for a plain one and mise_bad_path for an unknown house slug: an oracle
-- for which names are hidden from a house and which house slugs exist.
--
-- Now:
--   1. docs_before refuses a signed-in caller who may not write the path with
--      P0403, before anything else looks at the row;
--   2. authenticated loses direct insert and update on docs (select stays);
--   3. write_doc runs as its owner (security definer), so it still writes;
--      its own can_write check, run before any write, is the rule, and the
--      trigger checks it again. The docs_insert and docs_update policies stay
--      as a second lock should a grant ever come back.
-- A direct update also skipped the rev check (Engineer E7, last write wins);
-- with the update grant gone that door is shut too.

create or replace function private.docs_before() returns trigger language plpgsql security definer set search_path = '' as $$
declare s record; aud uuid[]; ref jsonb; gpath text;
begin
  -- fix loop 3 E3: a signed-in caller who may not write this path is refused
  -- here, first, with the writer's uniform P0403, before doc_scope, the
  -- targets rules or the name guard can say anything about the path or the
  -- data (else mise_bad_path, P0422 and 42501 are an oracle across houses).
  -- Session-less writes (the migration, svc) are exempt, as below.
  if auth.uid() is not null
     and not private.can_write(case when tg_op = 'INSERT' then private.canonical_path(new.path) else old.path end) then
    raise exception 'mise_forbidden' using errcode = 'P0403';
  end if;
  if tg_op = 'INSERT' then
    new.path := private.canonical_path(new.path);
    s := private.doc_scope(new.path);
    new.kind := s.kind; new.profile_id := s.profile_id; new.household_id := s.household_id; new.rev := 1;
  else
    new.path := old.path; new.doc_id := old.doc_id; new.kind := old.kind;
    new.profile_id := old.profile_id; new.household_id := old.household_id;
    new.legacy_sha := old.legacy_sha; new.rev := old.rev + 1;
  end if;
  -- ENG L2-2, F2, F7: a signed-in writer who is not the owner (the admin
  -- included) may not drop a targets key, nor loosen a plate safety key, on
  -- an update or on an insert (compared with the person's canonical row, or
  -- their other targets row). Session-less writes (the migration, svc) are
  -- exempt.
  if new.kind = 'targets' and auth.uid() is not null and new.profile_id is distinct from private.my_profile() then
    if tg_op = 'UPDATE' then ref := old.data;
    else
      select d.data into ref from public.docs d
       where d.profile_id = new.profile_id and d.kind = 'targets'
       order by (d.path like '%profile/targets.json') desc limit 1;
    end if;
    if jsonb_typeof(ref) = 'object' and (
         exists (select 1 from jsonb_object_keys(ref) k where not (new.data ? k))
         or private.safety_loosened(ref, new.data)) then
      raise exception 'mise_forbidden' using errcode = 'P0403';
    end if;
  end if;
  gpath := private.guard_path(new.path);
  aud := private.audience(new.kind, new.profile_id, new.household_id);
  if (aud is not null and private.guard_hit(new.data, aud, gpath))
     or (new.kind = 'global' and private.guard_hit(new.data, null, gpath)) then
    raise exception 'mise_name_guard' using errcode = 'P0422';
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

alter function public.write_doc(text, jsonb, bigint) security definer;

revoke insert, update on public.docs from authenticated;
revoke insert (path, data), update (data) on public.docs from authenticated;
