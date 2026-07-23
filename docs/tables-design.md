# Tables + Brigades (shared meals), Design v2 (post-Tribunal)

Date: 2026-07-21. Status: David approved direction; council-reviewed
(5 advisors + 5 peer reviews); Tribunal plan gate ran — Red Team BLOCKED v1
on the diet-screen bypass, all findings folded in below (see "Tribunal
amendments"). Naming locked by David: functional now, fancy later.

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
- **Table** (S2): ONE shared meal. `{id, name, date, slot, recipeId, seats}`
  where seats = `[{id: profileId, servings, status?}]` (id-keyed for merge). Lives in
  `households/<h>/events.json`. Everyone at the table eats the same recipe;
  servings per seat come from each profile's targets. The invite list IS
  the group — no group object.
- **Brigade** (S3, this doc designs it, builds after S2 settles): a STANDING
  Table arrangement — two+ profiles link their week plans for a period
  (`{id, name, memberIds, slots, from, until?}` in the house's own
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
3. **Portions per seat**: default 1 serving, editable per seat at creation
   (Ledger cut the suggestion heuristic from v1; if ever added it is
   pool-avg slot calories / recipe calories, never slotMacroEstimate's
   restaurant undershoot).
4. **Shopping**: the COOK (shopper rule in the Engineer section) gets a
   shopping pseudo-entry for the table's summed servings; every other
   seat's derivation buys nothing (their entry is est-macro only). A
   brigade inside one house is the simple case: one cook, summed portions.
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
      "seats": [ { "id": "david", "servings": 1.5 },
                 { "id": "mom", "servings": 1, "status": "skipped" } ] }
    // seat id = profileId (id-keyed so concurrent seat edits merge);
    // status absent = in; the table's house = the file's own path
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
- **S2 (main): Tables.** events.json read/write (raw path), table CRUD UI
  (since 2026-07-23 a standalone bottom-bar "Table" tab, `#/tables`,
  `app/views/tables.js`; Plan keeps only the read-only "adjusted around"
  day-grid note. Create form: name, date, slot, recipe,
  seat picker with default-1 editable servings + inline diet warnings),
  derived-pin memo + viewPlan seam + strip-before-persist, cook/guest
  shopping split, adjusted-day notes, tests (derivation, screening,
  shopping split, merge, strip), reviewer pass, live-verify two profiles.
- **S3: Brigades.** Generation-time linking: the brigade's designated
  cook-week (whose GENERATE runs first, or a "generate for brigade" action)
  writes the linked slots' recipe picks as brigade entries in events.json;
  every member's generator derives them as pins and personalizes the rest.
  Portions per member per slot from targets. Build after S2 proves derived
  pins in daily use.
- **S4 (gated, not designed here): cross-install.**

## Tribunal amendments (binding on the S2 build)

1. **Diet/avoid screening, both ends (Red Team BLOCK; Lawyer must-fix).**
   A shared helper (extracted from mergeRecipePool, not duplicated: the
   `containsAvoided` predicate + `dietOf`/DIET_ADMITS check) screens the
   table's recipe against EVERY seat's `diet` and `avoidIngredients`:
   (a) at creation, the seat picker marks conflicting profiles inline
   ("contains shallot, Mom avoids this") — a hard warning, not a silent
   block, family may knowingly override a preference; (b) at DERIVATION,
   re-checked every load (recipes and avoid lists change): a conflicting
   seat derives a visible "conflicts with your diet list" banner entry that
   contributes NO pin and NO macros, never a silent pin. A table must never
   be a backdoor around a screen every other path enforces.
2. **Validation at the events.json trust boundary (Red Team HIGH).**
   Derivation validates each table individually: known slot, parseable
   date, recipeId resolves in the reader's pool-or-bank, servings finite
   and clamped to [0.5, 10], seats an array. Invalid tables are skipped
   one-by-one; the whole derive step is wrapped so any failure degrades to
   "no tables today", never a broken Plan/Today for the house. At most ONE
   derived pin per profile per date+slot (first valid wins).
3. **Seats are id-keyed for merge (Red Team MEDIUM).** Each seat carries
   `id: <profileId>` so the existing keyed-array merge handles concurrent
   seat edits; without it seats merge atomically and drop one side.
4. **Collision precedence (Red Team MEDIUM).** A profile's OWN entry at
   that date+slot (pinned or OUT placeholder) WINS; the derived table entry
   is skipped for that person and the day note says so. Pinning your own
   meal is how a guest declines, which doubles as the deviation story.
5. **Guest edit path (Red Team MEDIUM).** Editing YOUR OWN seat (servings,
   or a skipped status) writes to your seat object in the house's
   events.json — allowed and defined (id-keyed, merge-safe). Everything
   else about a table is read-only outside the create/edit UI. Derived
   entries are NEVER persisted into any plan file (strip before every
   updatePlan/write — the leak the Engineer gate checks).
6. **Retention (Red Team LOW; Lawyer must-fix).** Derivation ignores tables
   dated more than 14 days past; any table CRUD write prunes them from the
   file. Policy documented in SCHEMAS.md with the schema.
7. **Per-seat status (Historian; Red Team pass-2 closure).** Seats carry
   `status?: "in" | "skipped"` (absent = in), the PARTSTAT lesson: skipping
   is explicit schema state, not inferred absence. A seat with
   `status: "skipped"` derives NOTHING — no pin, no macros, same as a diet
   conflict — and the cook's shopping pseudo-entry sums NON-skipped seats
   only. Declining actually declines, everywhere. A table edit that
   changes recipe/date/slot keeps seats and servings (servings are a
   function of person+slot, not of the recipe) — decided here so it is not
   discovered as a bug later.
8. **Cuts (Ledger).** No seat-portion heuristic in v1: seat servings
   default to 1, editable; build the target-share suggestion only if live
   use shows bad defaults left unedited. Brigade (S3) schema in this doc is
   ILLUSTRATIVE ONLY, to be redesigned against lived S2 experience.
9. **Privacy copy (Red Team note).** Seat servings render as plain numbers;
   the UI never says "computed from <name>'s calorie target". Servings are
   a planning estimate, not a scale reading (Historian) — copy reflects
   that. S4 precondition (Lawyer): a real invite/pending state before any
   cross-install participant; recorded for the B1 design.

## Engineer gate: the build seam (binding)

- **Pure plan, derived view.** Persisted `plan` state NEVER contains table
  entries. main.js derives `tableEntries` as a MEMO over (plan, events,
  profiles, recipes) — not inside the load effect — and computes
  `viewPlan = { ...plan, entries: [...plan.entries, ...tableEntries] }`.
  Views, dayTotals, and generateWeek consume viewPlan; every virtual entry
  is `pinned: true` (that's what makes the whole weekbuilder pin machinery
  apply) and `table: <eventId>`. ONE strip point: before any persist of a
  generator result, `entries.filter(e => !e.table)`. Existing edit handlers
  stay untouched, they only ever see the pure plan.
- **Every seat's virtual entry is est-based** (freeText name + mandatory
  `estCalories`/`estProtein` = recipe macros × seat servings, computed at
  derivation FROM THE BANK, never the filtered pool): a guest's filtered
  pool may not contain the recipe and an unknown recipeId counts a silent
  0 kcal, snack-stacking a fictional hole. dayTotals extends its est branch
  to `e.table` entries. No virtual entry carries a recipeId.
- **The shopper rule.** Lists are per-profile; "the host house's list" does
  not exist as an object. Deterministic rule: the FIRST seat (array order)
  whose profile's house equals the table's house is the COOK; only their
  list derivation adds the shopping pseudo-entry
  `{ recipeId, date, servings: sum of all seats }` (buffer-precedent, at
  the deriveShoppingList call sites via one helper; carrying `date` makes
  the existing fromDate filter drop past tables). Everyone else derives
  nothing to buy. This kills the EVERYONE-tab double-count.
- **Tables live where the house lives**: `households/<h>/events.json`, raw
  path; no `houseId` field, the path is the authority. Derivation reads
  events for EVERY distinct house in profiles.json (a tiny in-repo set), so
  a guest seated at another house's table sees it. Loaded in an
  onSyncChange-subscribed effect like the plan.
- No seat-servings heuristic in v1 (Ledger cut stands): default 1,
  editable. If added later: pool-avg slot calories / recipe calories, NOT
  slotMacroEstimate (its 0.85 undershoot is for unknown restaurant food).

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
