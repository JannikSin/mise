-- Mise 2.0 db fix loop 3, item 5: remove everything the live gate made
-- (read tools/live-gate.md). Paste after `node tools/live-gate.mjs`, pass or fail.
begin;
delete from public.admins where user_id in (select id from auth.users where email like 'gate-%@example.invalid');
delete from public.docs where path like 'households/gate-house-%' or path like 'profiles/gate-%';
delete from public.plates where profile_id in (select id from public.profiles where slug like 'gate-%');
delete from private.pending_links where email like 'gate-%@example.invalid';
delete from private.guard_terms where hidden_from in (select id from public.households where slug like 'gate-house-%');
delete from public.profiles where slug like 'gate-%';
delete from public.households where slug like 'gate-house-%';
delete from auth.users where email like 'gate-%@example.invalid';
alter table public.profiles drop constraint if exists gate_abort;
drop function if exists public.gate_probe();
commit;
