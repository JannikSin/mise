# Tables + Brigades (shared meals), Design v1

Date: 2026-07-21. Status: David approved direction; council-reviewed
(5 advisors + 5 peer reviews); Tribunal plan gate pending. Naming locked by
David: functional now, fancy later.

## North star

Consistency through flexibility. Mise is the layer that makes real life
(family dinners, a roommate's cooking, restaurants) still land on each
person's targets. There is always an excuse to skip the plan; features that
absorb real events into the plan remove the excuse. Tables and Brigades are
the social half of that thesis (the OUT toggle and day-aware weeks were the
solo half).

## Concepts

- **House**: a physical kitchen. Owns the pantry and the shared shopping
  reality. USER-FACING RENAME ONLY (S1): the storage field stays
  `household` and the path stays `households/<h>/...` — zero data
  migration, old devices unaffected; every label, hint, and doc says
  "house". A real storage rename waits until something forces it.
- **Table** (S2): ONE shared meal. `{date, slot, houseId, recipeId, name,
  seats}` where seats = `[{profileId, servings}]`. Lives in
  `households/<h>/events.json`. Everyone at the table eats the same recipe;
  servings per seat come from each profile's targets. The invite list IS
  the group — no group object.
- **Brigade** (S3, this doc designs it, builds after S2 settles): a STANDING
  Table arrangement — two+ profiles link their week plans for a period
  (`{id, name, houseId, memberIds, slots, from, until?}` in the same
  events.json). Linked slots (default: dinner, configurable) carry the SAME
  recipes for every member; portions differ per member; each member's
  remaining slots/snacks are personal and close their own macro gaps.
  "A continuous table."

## Architecture (the load-bearing decisions)

1. **One source of truth, derived pins.** Tables and Brigades live ONLY in
   the house's `events.json`. No fan-out writes into other profiles' plan
   files, ever (the Laurie lesson). Each profile's app, at plan load and at
   GENERATE, derives VIRTUAL pinned entries from events addressed to it:
   same shape as a pinned plan entry, marked `table: <eventId>`, never
   persisted into the plan file itself. Cancel/edit = one file edit,
   propagates to everyone on their next sync tick.
2. **Generator integration is the existing pin machinery.** A derived table
   entry enters generateWeek exactly like a pinned entry: never cleared,
   seeds the day, and the existing floor/top-up/trim passes plan the REST of
   that member's day around it. Day-aware rules apply unchanged.
3. **Portions per seat**: at table creation the app computes each seat's
   servings from that profile's calorie target for that slot
   (target-share heuristic: slot's typical share of their day, reusing
   slotMacroEstimate's machinery), rounded to 0.5. Editable per seat.
4. **Shopping**: the HOST house's list gains the table's TOTAL servings
   (sum of seats) via a derived plan contribution; every NON-host member's
   derivation SKIPS the table entry (they are a guest: real macros, nothing
   to buy) — the OUT-placeholder pattern with exact numbers. A brigade
   inside one house is the simple case: one house list, summed portions.
5. **Visible adjustment**: any day containing a table/brigade entry shows a
   line on Today and Plan: "adjusted around <name>" — the trust requirement
   the Outsider flagged. Deviation is handled the same way as any other day:
   re-roll replans live days; a guest who skipped the table just re-rolls.
6. **In-repo only (S2/S3).** All participants are profiles in this data
   repo. Cross-install invites are S4, gated on the B1 auth migration, its
   own council.

## Schema (documented in SCHEMAS.md on build, same commit)

`households/<h>/events.json`:
```jsonc
{
  "tables": [
    { "id": "t1", "name": "Family dinner", "date": "2026-07-24",
      "slot": "dinner", "recipeId": "doner-style-kebab-bowl",
      "seats": [ { "profileId": "david", "servings": 1.5 },
                 { "profileId": "mom", "servings": 1 } ] }
  ],
  "brigades": [
    { "id": "b1", "name": "Apartment dinners", "memberIds": ["david", "laurie"],
      "slots": ["dinner"], "from": "2026-07-27", "until": "2026-08-03" }
  ]
}
```
Merging: both arrays id-keyed (existing merge machinery). File is per-house,
raw path (not profile-scoped), same access pattern as the household pantry.

## Build phases

- **S1 (small): house rename.** UI copy + docs: household → house
  everywhere user-visible (SYS labels/hints, EVERYONE-tab wording).
  Storage untouched. Ship first.
- **S2 (main): Tables.** events.json read/write in store, table CRUD UI
  (Plan tab section: "Tables this week" + create form: date, slot, recipe,
  house, seat picker with suggested portions), derived-pin layer in plan
  load + generateWeek call sites, host/guest shopping split, adjusted-day
  notes, tests (derivation, shopping split, merge), reviewer pass,
  live-verify with two profiles.
- **S3: Brigades.** Generation-time linking: the brigade's designated
  cook-week (whose GENERATE runs first, or a "generate for brigade" action)
  writes the linked slots' recipe picks as brigade entries in events.json;
  every member's generator derives them as pins and personalizes the rest.
  Portions per member per slot from targets. Build after S2 proves derived
  pins in daily use.
- **S4 (gated, not designed here): cross-install.**

## Risks the council/peers flagged, answered

- Portion-scaling vs pantry math: host list sums seat servings through the
  EXISTING deriveShoppingList servings path (entry.servings already means
  "portions this person eats"); no new arithmetic, one new summation.
- Edit-after-generate conflicts: events.json is authoritative; derived pins
  recompute at every load; a mid-week table edit shows up on every device's
  next tick. No cross-profile writes exist to conflict.
- Migration risk: S1 avoids data migration entirely by renaming only the
  surface.
- Old-device behavior: devices running pre-S2 code simply don't see tables
  (their plans never contain them); they lose nothing. Document as the
  standard refresh-devices-after-deploy caveat.
