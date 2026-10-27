-- Mise 2.0, db fix loop 1, item 9: the svc functions the Worker calls that
-- B2 lacked, and public.whoami() for the app. The contract is the [NEEDED]
-- blocks of worker/src/svc.js (worker lane, merge c0123d1 on v2-supabase) and
-- app/lib/session-boot.js; the signatures below match them exactly.
-- svc.* are service_role only (the Worker's secret key). Every function takes
-- the caller from the verified session (p_sub) or the stored invite, never a
-- profile or house from the request body (Red Team F8, Worker side).

-- The Worker's who-is-asking: { slug, admin, houses } or null.
create function svc.whoami(p_sub uuid) returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'slug', p.slug,
  'admin', exists (select 1 from public.admins a where a.user_id = p_sub),
  'houses', coalesce((select jsonb_agg(h.slug order by h.slug) from public.memberships m
                        join public.households h on h.id = m.household_id where m.profile_id = p.id), '[]'::jsonb))
from public.profiles p where p.user_id = p_sub $$;

-- The app's who-is-asking (session-boot): { slug, admin, home } for the
-- signed-in account, or null when the account has no profile (a confirmed
-- revoke).
create function public.whoami() returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'slug', p.slug,
  'admin', exists (select 1 from public.admins a where a.user_id = p.user_id),
  'home', h.slug)
from public.profiles p left join public.households h on h.id = p.home_household
where p.user_id = auth.uid() $$;

-- The hourly cron's inputs: the root profile, its home house, that week's
-- root plan, the house's events, and (when asked) the root shopping list.
create function svc.cron_inputs(p_week text, p_with_shopping boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
with r as (
  select p.slug, h.slug as house from private.settings s
    join public.profiles p on p.slug = s.value
    left join public.households h on h.id = p.home_household
   where s.key = 'root_profile')
select jsonb_build_object(
  'profile', r.slug,
  'house', r.house,
  'plan', (select d.data from public.docs d where p_week ~ '^[0-9]{4}-W[0-9]{2}$' and d.path = 'plans/' || p_week || '.json'),
  'events', (select d.data from public.docs d where d.path = 'households/' || r.house || '/events.json'),
  'shopping', case when p_with_shopping then (select d.data from public.docs d where d.path = 'shopping.json') end)
from r $$;

-- A guest invite for p_host_house: 'ok' when the caller is the admin, or an
-- entitled member of that house; 'forbidden' otherwise (a guest, a probe, an
-- unknown house, an expiry not in the future, a code already used).
create function svc.mint_invite(p_sub uuid, p_code_hash text, p_host_house text, p_expires_at timestamptz) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare me record; hid uuid; n int;
begin
  select p.id, p.kind, p.entitled into me from public.profiles p where p.user_id = p_sub;
  select h.id into hid from public.households h where h.slug = p_host_house;
  if me.id is null or hid is null or me.kind <> 'member' or p_expires_at is null or p_expires_at <= now()
     or coalesce(p_code_hash, '') = '' then
    return 'forbidden';
  end if;
  if not (exists (select 1 from public.admins a where a.user_id = p_sub)
          or (me.entitled and exists (select 1 from public.memberships m where m.profile_id = me.id and m.household_id = hid))) then
    return 'forbidden';
  end if;
  insert into public.invites (code_hash, host_household, created_by, expires_at)
    values (p_code_hash, hid, me.id, p_expires_at) on conflict do nothing;
  get diagnostics n = row_count;
  return case when n = 1 then 'ok' else 'forbidden' end;
end $$;

-- One invite: { host_house, expires_at, used_at, claimed (slug), status_until } or null.
create function svc.invite_get(p_code_hash text) returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'host_house', h.slug,
  'expires_at', i.expires_at,
  'used_at', i.used_at,
  'claimed', c.slug,
  'status_until', i.status_until)
from public.invites i
  join public.households h on h.id = i.host_household
  left join public.profiles c on c.id = i.claimed_profile
where i.code_hash = p_code_hash $$;

-- A guest's name login: true when written, false (nothing written) when the
-- name is taken, the guest already has one, or the profile is not a guest.
create function svc.guest_login_add(p_profile uuid, p_name_key text, p_salt text, p_hash text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  insert into public.guest_logins (profile_id, name_key, salt, hash)
    select p.id, p_name_key, p_salt, p_hash from public.profiles p where p.id = p_profile and p.kind = 'guest'
    on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- { slug, salt, hash } for a name login, or null.
create function svc.guest_login_row(p_name_key text) returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object('slug', p.slug, 'salt', l.salt, 'hash', l.hash)
from public.guest_logins l join public.profiles p on p.id = l.profile_id
where l.name_key = p_name_key $$;

-- A guest with a LIVE grant: { profile_id, name, has_login, host_house,
-- tables (the host house's events.json "tables"), names }. `names` is
-- { slug: roster name } for the people seated at the tables the guest sits
-- at (narrower than every seat in the house: the guest page names only the
-- guest's own co-diners). Null for an unknown slug, a non-guest, or a grant
-- that has lapsed.
create function svc.guest_view(p_slug text) returns jsonb language sql stable security definer set search_path = '' as $$
with g as (
  select p.id, p.slug, p.roster, h.slug as house from public.profiles p
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
                      where p.slug in (select slug from seated) and p.kind <> 'probe' and p.roster ? 'name'), '{}'::jsonb))
from g, t $$;

revoke execute on all functions in schema svc from public, anon, authenticated;
grant execute on function svc.whoami(uuid), svc.cron_inputs(text, boolean), svc.mint_invite(uuid, text, text, timestamptz),
  svc.invite_get(text), svc.guest_login_add(uuid, text, text, text), svc.guest_login_row(text), svc.guest_view(text)
  to service_role;
revoke execute on function public.whoami() from public, anon;
grant execute on function public.whoami() to authenticated;
