-- Mise 2.0 worker fix loop 1, item 10 (Engineer F9). OWNER: worker lane, written
-- here because the db lane had finished its loop; the db lane may fold it into
-- its own file (the PGlite test is tests/db-ai-take.test.js).
--
-- One call per AI request instead of one per weight slot (annotate was 8
-- round trips). The day is passed by the Worker as David's date in
-- America/Chicago, so the allowance resets at midnight Chicago, as the
-- Worker's message says; a day more than one away from the server's UTC date
-- is refused, so a caller cannot reach back to an old row or forward to a
-- fresh one. The person's row is taken first: a person over their own
-- allowance never spends the global row. A refused call still counts.
-- Returns 'ok', 'user' (over the person's allowance) or 'global'.
create function svc.ai_take(p_sub uuid, p_n int, p_day date, p_user_cap int, p_global_cap int)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  mine int;
  total int;
  global_row constant uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
begin
  if p_sub is null or p_sub = global_row then raise exception 'bad user' using errcode = '22023'; end if;
  if p_n is null or p_n < 1 or p_n > 10 then raise exception 'bad weight' using errcode = '22023'; end if;
  if p_day is null or abs(p_day - current_date) > 1 then raise exception 'bad day' using errcode = '22023'; end if;
  if p_user_cap is null or p_user_cap < 1 or p_global_cap is null or p_global_cap < 1 then
    raise exception 'bad cap' using errcode = '22023';
  end if;
  insert into public.ai_usage (user_id, day, calls) values (p_sub, p_day, p_n)
    on conflict (user_id, day) do update set calls = public.ai_usage.calls + p_n
    returning calls into mine;
  if mine > p_user_cap then return 'user'; end if;
  insert into public.ai_usage (user_id, day, calls) values (global_row, p_day, p_n)
    on conflict (user_id, day) do update set calls = public.ai_usage.calls + p_n
    returning calls into total;
  if total > p_global_cap then return 'global'; end if;
  return 'ok';
end $$;

revoke execute on function svc.ai_take(uuid, int, date, int, int) from public, anon, authenticated;
grant execute on function svc.ai_take(uuid, int, date, int, int) to service_role;
