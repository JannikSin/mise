-- Mise 2.0 db fix loop 3, item 5: the live gate's seed (read tools/live-gate.md).
-- Paste into the SQL Editor (or psql) of the local stack or the SANDBOX, after
-- supabase/migrations/ and before `node tools/live-gate.mjs`. Never the live
-- project. Made-up people only; tools/live-gate-teardown.sql removes all of it.
begin;
insert into public.households (slug) values ('gate-house-a'), ('gate-house-b');
insert into public.profiles (slug, kind, home_household, roster, sort_order)
  select v.slug, 'member', h.id, jsonb_build_object('name', v.name), v.ord
    from (values ('gate-a1', 'gate-house-a', 'Gate A1', 901), ('gate-a2', 'gate-house-a', 'Gate A2', 902),
                 ('gate-b1', 'gate-house-b', 'Gate B1', 903), ('gate-abort', 'gate-house-a', 'Gate Abort', 904)) v(slug, house, name, ord)
    join public.households h on h.slug = v.house;
insert into public.memberships select p.id, p.home_household from public.profiles p where p.slug like 'gate-%';
insert into private.pending_links select p.slug || '@example.invalid', p.id from public.profiles p where p.slug like 'gate-%';
-- a word hidden from gate-house-a: a gate-house-a file that carries it is refused (P0422)
insert into private.guard_terms select 'gatehidden', id from public.households where slug = 'gate-house-a';
-- link_pending must fail for gate-abort, so its account must not be created
alter table public.profiles add constraint gate_abort check (slug <> 'gate-abort' or user_id is null);
-- made AFTER the migrations, by the same role: the default privileges must
-- keep it from anon and authenticated
create function public.gate_probe() returns integer language sql as $$ select 1 $$;
commit;
