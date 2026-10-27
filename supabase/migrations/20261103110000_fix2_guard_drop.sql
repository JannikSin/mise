-- Mise 2.0, db fix loop 2, item 4 (Red Team verify 2, N3). A replacement
-- only. Invisible characters outside the dropped set still split a name in
-- both twins: LRM and RLM (they arrive with copy-pasted text), the other bidi
-- controls, invisible operators, the Mongolian vowel separator, variation
-- selectors, tag characters and the combining blocks beyond U+0300-036F. The
-- fold now drops all of them; tools/name-guard.mjs DROP is the same set, and
-- tests/_guard-corpus.js runs each through both.
create or replace function private.guard_fold(s text) returns text language sql immutable set search_path = '' as $$
select lower(regexp_replace(regexp_replace(regexp_replace(regexp_replace(translate(
  regexp_replace(normalize(coalesce(s, ''), nfkd), '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u180e\ufe00-\ufe0f\ufeff\u00ad\U000e0000-\U000e007f\U000e0100-\U000e01ef]', '', 'g'),
  'авеіјкмнорстухѕԁӏүһԛԝАВЕІЈКМНОРСТУХЅҮҺӀαβγεηικνορτυχωΑΒΕΖΗΙΚΜΝΟΡΤΥΧıłŁøØđĐðÐ',
  'abeijkmhopctyxsdlyhqwabeijkmhopctyxsyhlabyenikvoptuxwabezhikmnoptyxilloodddd'),
  '[ßẞ]', 'ss', 'g'), '[æÆ]', 'ae', 'g'), '[œŒ]', 'oe', 'g'), '[þÞ]', 'th', 'g')) $$;
