-- Mise 2.0, db fix loop 2, item 2 (Red Team verify 2, N2 and condition C2).
-- A replacement only; the earlier files are unchanged.
--
-- svc.guest_view's `names` took any seated slug from any house: a house-w
-- member could seat a family-house member at a guest's table in house-w's
-- events.json, and the guest page (and the invite status page, which the
-- minter sees) then showed that person's roster name, while roster() as the
-- same member showed nothing of them. Now `names` holds only people the HOST
-- house can already see: its members, and guests it holds a live grant for.
-- Everything else in the function is as before.
create or replace function svc.guest_view(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$
with g as (
  select p.id, p.slug, p.roster, h.id as house_id, h.slug as house from public.profiles p
    join public.guest_grants gg on gg.guest_profile = p.id and gg.until >= current_date
    join public.households h on h.id = gg.host_household
   where p.slug = p_slug and p.kind = 'guest'
   order by gg.until desc, h.slug limit 1),
t as (
  select coalesce((select d.data->'tables' from public.docs d, g where d.path = 'households/' || g.house || '/events.json'
                    and jsonb_typeof(d.data->'tables') = 'array'), '[]'::jsonb) as tables),
seated as (
  select distinct s->>'id' as slug from t, g,
    jsonb_array_elements(t.tables) tb,
    jsonb_array_elements(case when jsonb_typeof(tb->'seats') = 'array' then tb->'seats' else '[]'::jsonb end) s
   where exists (select 1 from jsonb_array_elements(case when jsonb_typeof(tb->'seats') = 'array' then tb->'seats' else '[]'::jsonb end) me
                  where me->>'id' = g.slug))
select jsonb_build_object(
  'profile_id', g.id,
  'name', g.roster->>'name',
  'has_login', exists (select 1 from public.guest_logins l where l.profile_id = g.id),
  'host_house', g.house,
  'tables', t.tables,
  'names', coalesce((select jsonb_object_agg(p.slug, p.roster->>'name') from public.profiles p
                      where p.slug in (select slug from seated) and p.kind <> 'probe' and p.roster ? 'name'
                        and (g.house_id = any (private.houses_of(p.id))
                             or exists (select 1 from public.guest_grants x
                                         where x.guest_profile = p.id and x.host_household = g.house_id and x.until >= current_date))), '{}'::jsonb))
from g, t $$;
