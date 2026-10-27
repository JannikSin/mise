-- Mise 2.0, allergen exceptions (P8 plates, P3 knows-you; David's ruling
-- 2026-10-27). A person may clear named terms from one allergy chip for
-- themselves (app/lib/targets.js ALLERGEN_EXCEPTIONS: tree nuts, except pine
-- nuts and pesto). The new targets key `allergenExceptions` rides on the plate
-- card, so a housemate's phone screens with the same exceptions, and it is a
-- plate SAFETY key whose direction is reversed: an exception ADDED loosens, so
-- a writer who is not the owner (the admin included) may only remove one.

-- The plate card: exactly app/lib/plate-fields.js PLATE_FIELDS (checked by
-- tests/plate-allowlist.test.js against the LAST definition), otherwise as B2.
create or replace function private.plate_of(t jsonb) returns jsonb language sql immutable set search_path = '' as $$
select coalesce(jsonb_object_agg(e.key, case
    when e.key = 'macros' and jsonb_typeof(e.value) = 'object' then e.value - 'waterLiters'
    when e.key = 'currencies' and jsonb_typeof(e.value) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(c) = 'object' then (
          select coalesce(jsonb_object_agg(ck, cv), '{}'::jsonb) from jsonb_each(c) x(ck, cv)
           where ck in ('id', 'unit', 'perWeek', 'expires', 'venue', 'toGo', 'preferredSlot', 'estCalories', 'estProtein'))
        else c end order by ord), '[]'::jsonb)
      from jsonb_array_elements(e.value) with ordinality a(c, ord))
    when e.key = 'mealSlots' and jsonb_typeof(e.value) = 'array' then (
      select coalesce(jsonb_agg(case when jsonb_typeof(s) = 'object' then s - 'note' - 'notes' else s end
        order by ord), '[]'::jsonb)
      from jsonb_array_elements(e.value) with ordinality a(s, ord))
    else e.value end), '{}'::jsonb)
from jsonb_each(case when jsonb_typeof(t) = 'object' then t else '{}'::jsonb end) e
where e.key in (
  -- PLATE_FIELDS
  'diet', 'allergens', 'allergensFreeText', 'allergenExceptions', 'avoidIngredients',
  'avoidRecipes', 'dislikeIngredients', 'cuisinePrefs', 'fixedSlots', 'skipSlots',
  'mealSlots', 'slotAvoid', 'breakfastStyle', 'snackStyle', 'snackPortable',
  'dinnerAnchor', 'phase', 'weeklyBudgetUsd', 'macros', 'currencies'
  -- end PLATE_FIELDS
) $$;

-- True when `nxt` is less strict than `prev` on any plate safety key: every
-- rule of fix1 (a diet less strict, a list item missing, a slotAvoid item
-- missing, the free text losing its old words), plus an allergenExceptions
-- term in `nxt` that `prev` did not have under the same chip. Absent counts
-- as empty; a non-array value under a chip counts as empty.
create or replace function private.safety_loosened(prev jsonb, nxt jsonb) returns boolean language sql immutable set search_path = '' as $$
with rank(d, r) as (values ('omnivore', 0), ('pescatarian', 1), ('vegetarian', 2), ('vegan', 3)),
arr(k) as (values ('allergens'), ('avoidIngredients'), ('avoidRecipes'), ('dislikeIngredients'))
select
  -- diet
  (coalesce(prev->>'diet', 'omnivore') is distinct from coalesce(nxt->>'diet', 'omnivore')
   and coalesce((select r from rank where d = coalesce(nxt->>'diet', 'omnivore')), -1)
     < coalesce((select r from rank where d = coalesce(prev->>'diet', 'omnivore')), 99))
  -- the list keys: every old item still there
  or exists (select 1 from arr, jsonb_array_elements(case when jsonb_typeof(prev->arr.k) = 'array' then prev->arr.k else '[]'::jsonb end) e
     where not (case when jsonb_typeof(nxt->arr.k) = 'array' then nxt->arr.k else '[]'::jsonb end) @> jsonb_build_array(e))
  -- slotAvoid: per slot
  or exists (select 1 from jsonb_each(case when jsonb_typeof(prev->'slotAvoid') = 'object' then prev->'slotAvoid' else '{}'::jsonb end) s(slot, items),
       jsonb_array_elements(case when jsonb_typeof(s.items) = 'array' then s.items else '[]'::jsonb end) e
     where not (case when jsonb_typeof(nxt->'slotAvoid'->s.slot) = 'array' then nxt->'slotAvoid'->s.slot else '[]'::jsonb end) @> jsonb_build_array(e))
  -- free text: the old words stay
  or (coalesce(prev->>'allergensFreeText', '') <> ''
      and position(prev->>'allergensFreeText' in coalesce(nxt->>'allergensFreeText', '')) = 0)
  -- allergenExceptions: per chip, no new term (reversed: only the owner clears)
  or exists (select 1 from jsonb_each(case when jsonb_typeof(nxt->'allergenExceptions') = 'object' then nxt->'allergenExceptions' else '{}'::jsonb end) x(chip, items),
       jsonb_array_elements(case when jsonb_typeof(x.items) = 'array' then x.items else '[]'::jsonb end) e
     where not (case when jsonb_typeof(prev->'allergenExceptions'->x.chip) = 'array' then prev->'allergenExceptions'->x.chip else '[]'::jsonb end) @> jsonb_build_array(e))
$$;
