-- Mise 2.0, db fix loop 2, item 1 (Red Team verify 2, N1 and condition C1).
-- New functions and replacements only; the earlier files are unchanged.
--
-- The JS gates stripped every character outside a to z from a TERM without
-- folding it, so "Wójcik", "Łukasz", "Mary Ann" and "O'Brien" never matched
-- their own text. Now a term is folded exactly as the text is
-- (tools/name-guard.mjs termWords): the callers split a name into words, and
-- the database folds every guard term on the way in and refuses any that is
-- not one plain word of 2 to 40 letters a to z. The fold also maps eszett to
-- "ss" and the letters ae, oe, thorn and eth, the same in both twins.

-- Fold: NFKD, drop combining marks and zero-width characters, map lookalikes
-- (tools/name-guard.mjs LOOKALIKES), the letters that become two, lowercase.
create or replace function private.guard_fold(s text) returns text language sql immutable set search_path = '' as $$
select lower(regexp_replace(regexp_replace(regexp_replace(regexp_replace(translate(
  regexp_replace(normalize(coalesce(s, ''), nfkd), '[\u0300-\u036f\u200b-\u200d\u2060\ufeff\u00ad]', '', 'g'),
  'авеіјкмнорстухѕԁӏүһԛԝАВЕІЈКМНОРСТУХЅҮҺӀαβγεηικνορτυχωΑΒΕΖΗΙΚΜΝΟΡΤΥΧıłŁøØđĐðÐ',
  'abeijkmhopctyxsdlyhqwabeijkmhopctyxsyhlabyenikvoptuxwabezhikmnoptyxilloodddd'),
  '[ßẞ]', 'ss', 'g'), '[æÆ]', 'ae', 'g'), '[œŒ]', 'oe', 'g'), '[þÞ]', 'th', 'g')) $$;

-- A guard term is one folded word, a to z only (no digit, no hyphen).
alter table private.guard_terms drop constraint guard_terms_term_check;
alter table private.guard_terms add constraint guard_terms_term_check check (term ~ '^[a-z]{2,40}$');

create function private.guard_terms_before() returns trigger language plpgsql set search_path = '' as $$
begin
  new.term := private.guard_fold(new.term);
  if new.term !~ '^[a-z]{2,40}$' then
    raise exception 'mise_guard_term: a guard term must fold to one word of 2 to 40 letters a to z' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function private.guard_terms_before() from public;

create trigger guard_terms_before before insert or update on private.guard_terms
  for each row execute function private.guard_terms_before();
