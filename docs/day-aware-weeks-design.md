# Day-Aware Weeks, Design

Date: 2026-07-21. Approved by David in session (catch-up batch option chosen).

## Problem

The app knows today's date (Today view) but that knowledge is not enacted:

1. GENERATE MY WEEK / RE-ROLL builds all 7 days, Mon–Sun, even when the week
   is underway. A Wednesday re-roll rewrites Monday and Tuesday, days already
   eaten.
2. The shopping list shops for meals already eaten.
3. Sunday batch-prep guidance renders after its Sunday has passed, so starting
   a week on Tuesday reads as "do this last Sunday", which is confusing.
4. Existing quirk: the prep Sunday for a Mon–Sun week is the day BEFORE that
   week's Monday. On Sunday the Today view auto-opens the batch block of the
   week that ends that day, the wrong week. You batch for NEXT week.

## Terms

- **today**: local YYYY-MM-DD (`localIsoDate(new Date())`).
- **past day**: a date in the shown week strictly before today. Today itself
  is always live (an evening re-roll still replans tonight's dinner; pin it
  if it is already cooked).
- **live dates**: the week's dates that are not past.
- **prep Sunday of week W**: the day before W's Monday
  (`datesOfWeek(W)[0]` minus 1 day).

## Behavior

### Generator (`app/lib/weekbuilder.js`)

`generateWeek` gains `today` (optional string; absent = current behavior,
full week, keeps tests and future-week generation unchanged).

- Entries on past dates survive untouched, exactly like pinned entries. They
  are not cleared, not re-filled, and do not seed committee coverage or the
  week food pool (the scaled targets below already account for them being
  gone).
- The fill loop, food-group floor pass, macro top-up, calorie trim, and the
  report only operate on live dates. No "protein short Monday" warnings for
  a Monday that already happened.
- Weekly Daily Dozen targets scale by live-date count (was ×7).
- Buffer portions = live-date count (was 7).
- Office-lunch hard-pin still targets Tue/Wed/Thu, but only the live ones.

### Shopping list (`app/lib/shopping.js`)

`deriveShoppingList` gains `fromDate` (optional string). Entries dated before
`fromDate` are skipped. Callers pass today only when the plan's week is the
current week; future weeks derive in full. Buffer shops its (already scaled)
portions.

### Planner view (`app/views/planner.js`)

Past-day columns: dimmed, "EATEN" tag, read-only, no drag target, no ✕, no
pin, no OUT toggle. Generate button subtext names the live span when mid-week
("plans Wed–Sun"). Only the current week ever has past days; future weeks
render unchanged.

### Today view batch block (`app/views/today.js`)

Three states, decided by today vs the shown week's prep Sunday:

1. **Prep Sunday ahead or today** (future week, or it IS that Sunday):
   current behavior, "Sunday batch", auto-open on the Sunday itself.
2. **Week underway** (Mon–Sat of the shown week): header becomes
   "Catch-up batch, tonight or next chance", same component list, not
   auto-opened.
3. **Sunday, viewing the current week**: the block shows NEXT week's plan
   components ("Sunday batch, next week"), because that is the week being
   batched for. Next week's plan is loaded read-only for this; if it has no
   entries yet, the block says so and points at Plan.

### Recipe view (`app/views/recipe.js`)

Field label "Sunday batch" → "Batch prep". Timeless; no day claim.

## Data

No schema changes. Plan files, entries, buffer unchanged. Past-day survival
is generator behavior, not a new flag.

## Phase-next (explicitly not built now)

Recording actuals for past days: David wants to eventually log rough real
intake (protein/calories) for past days, because weekly totals matter, a
light Monday can be compensated later in the week and vice versa. Landing
zone when built: per-day fields on `fitness/daily.json` days[] (alongside the
existing `buffer` counter), and a weekly-balance mode where remaining-day
floors flex against (weekly target − consumed so far). The live-dates
plumbing added here is the hook that makes that possible; nothing else is
pre-built for it.

## Not doing

- Per-slot eaten/skipped tracking.
- Editing or back-filling past days.
- Any timezone handling beyond the existing local-date convention.

## Tests

- `weekbuilder.test.js`: with `today` mid-week, past entries preserved
  verbatim, no fills on past dates, report silent on past dates, buffer
  portions = live count, absent `today` = unchanged full-week behavior.
- `shopping.test.js`: `fromDate` skips earlier entries; absent = unchanged.
- `dates.test.js` or `plan.test.js`: prep-Sunday helper.
- Views verified via Playwright walkthrough (planner past-day lockout, batch
  block states).
