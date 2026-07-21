# Day-Aware Weeks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generator, shopping list, planner, and batch-prep guidance aware of today's date so past days are never rewritten, never shopped, and never given stale "do it Sunday" instructions.

**Architecture:** `generateWeek` gains an optional `today` (local YYYY-MM-DD). Past-day entries are set aside before generation and merged back after every pass, the floor/top-up/trim passes derive their date list from `plan.entries`, so keeping past entries out of the working plan is what keeps those passes off past days. Weekly targets and buffer portions scale to live-date count. `deriveShoppingList` gains `fromDate`. Views get a `todayIso` prop for dimming/lockout and the three batch-block states.

**Tech Stack:** Zero-build ES modules, Preact+htm (vendored), JSDoc + tsc --checkJs, node --test.

## Global Constraints

- No new dependencies. No schema changes (docs/SCHEMAS.md untouched).
- Absent `today`/`fromDate` = exact current behavior (existing tests must pass unmodified).
- Pure/deterministic generator: no `new Date()` inside lib functions, today is passed in.
- Views never call fetch; data via store.js. Mobile-first, big touch targets.
- Spec: docs/day-aware-weeks-design.md.

---

### Task 1: prepSundayOf helper

**Files:**
- Modify: `app/lib/plan.js` (near `datesOfWeek`)
- Test: `tests/plan.test.js`

**Interfaces:**
- Produces: `prepSundayOf(weekId: string): string`, local ISO date of the day before the week's Monday.

- [ ] Test: `prepSundayOf("2026-W30")` === `"2026-07-19"`; `prepSundayOf("2026-W01")` crosses the year (`"2025-12-28"`).
- [ ] Implement:

```js
export function prepSundayOf(weekId) {
  const monday = datesOfWeek(weekId)[0];
  if (!monday) return "";
  const d = parseLocalIso(monday);
  d.setDate(d.getDate() - 1);
  return localIsoDate(d);
}
```

- [ ] `node --test tests/plan.test.js` green. Commit.

### Task 2: deriveShoppingList fromDate

**Files:**
- Modify: `app/lib/shopping.js:70-91`
- Test: `tests/shopping.test.js`

**Interfaces:**
- Produces: `deriveShoppingList(plan, recipesById, pantry, previous, fromDate?)`, entries with `entry.date < fromDate` skipped; buffer unaffected; absent fromDate = today's behavior.

- [ ] Test: plan with Mon+Wed entries, `fromDate` = Tue → only Wed's ingredients; absent fromDate → both.
- [ ] Implement: in the `toShop` loop, `if (fromDate && entry.date && entry.date < fromDate) continue;` (buffer pseudo-entry has no date, passes through).
- [ ] Tests green. Commit.

### Task 3: generateWeek today param

**Files:**
- Modify: `app/lib/weekbuilder.js:836-1110`
- Test: `tests/weekbuilder.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `generateWeek({ ..., today? })`. Absent = full week (existing behavior).

Changes inside `generateWeek`:

```js
const dates = datesOfWeek(weekId);
const liveDates = today ? dates.filter((d) => d >= today) : dates;
const liveSet = new Set(liveDates);
// step 1 split:
const pastEntries = plan.entries.filter((e) => !liveSet.has(e.date));
const pinnedEntries = plan.entries.filter((e) => liveSet.has(e.date) && e.pinned)...
```

- Working plan holds only live entries; passes and report untouched otherwise (they derive dates from entries / take `dates` arg → pass `liveDates`).
- `dailyDozenWeekly`: `Number(v) * liveDates.length`.
- Fill loop: `dates.forEach((date, i) => { if (!liveSet.has(date)) return; ... })`, office-day index `i` stays weekday-true.
- Buffer: `portions: liveDates.length`, skip buffer pick entirely when `liveDates.length === 0`.
- `macroShortfalls(next, byId, liveDates, ...)`, `calorieOverDays` over `liveDates`, `foodGroupGapsReport(..., liveDates, ...)`.
- Final: `next = { ...next, entries: [...pastEntries, ...next.entries] }` after the report is computed (report reflects live days only).

- [ ] Tests (fixed weekId + fixed `today` mid-week, e.g. week dates[2]):
  - past entries preserved verbatim (same ids/servings), including unpinned ones;
  - no generated entry lands on a past date;
  - report mentions no past date;
  - `buffer.portions === liveDates.length`;
  - `today` on Monday or absent → identical output to current behavior (regression);
  - `today` after the week → plan unchanged, empty report fills.
- [ ] Tests green (existing weekbuilder tests unmodified). Commit.

### Task 4: main.js wiring

**Files:**
- Modify: `app/main.js` (handleGenerateWeek ~752, handleBuildList ~521, handleToggleOut ~714, view props)

- [ ] Pass `today: localIsoDate(new Date())` to `generateWeek`.
- [ ] Pass `localIsoDate(new Date())` as `fromDate` to all three `deriveShoppingList` call sites (harmless for future weeks: no dates filtered).
- [ ] Load next week's plan for the Today view batch block: effect keyed on `[weekId, hasToken]` reading `plans/${shiftWeek(weekId, 1)}.json` (same pattern as recentRecipeIds effect), normalized via `normalizePlan`, passed to TodayView as `nextPlan`.
- [ ] Pass `todayIso` prop to PlannerView.
- [ ] Typecheck green. Commit (with Task 5/6 if views land together).

### Task 5: PlannerView past-day lockout

**Files:**
- Modify: `app/views/planner.js`, `app/styles.css`

- [ ] `todayIso` prop. Per-day column: `const past = date < todayIso;`
- [ ] Past columns: class `past` (dimmed via CSS `opacity` + desaturation), "EATEN" tag in the day header when the day has entries, no drag targets (guard in drop callback: `if (drop.date < todayIso) return;`), no ✕ / pin / OUT buttons rendered.
- [ ] Generate button subtext mid-week: "plans Wed–Sun · pinned entries are kept" (first live weekday–Sun), unchanged when the full week is live.
- [ ] Playwright/manual check via fixtures. Commit.

### Task 6: Batch-block states + recipe label

**Files:**
- Modify: `app/views/today.js:44-75,230-250`, `app/views/recipe.js:100`, `app/main.js` (nextPlan prop), `app/styles.css` if needed

Batch block state machine (shown week W, `monday = weekDates[0]`, `sunday = weekDates[6]`, `prep = prepSundayOf(plan.week)`):

1. `today <= prep` (future week, incl. its prep Sunday): header "Sunday batch", auto-open when `today === prep`.
2. `today >= monday && today < sunday` (week underway Mon–Sat): header "Catch-up batch, tonight or next chance", same components, never auto-open.
3. `today === sunday` (Sunday, current week shown): components computed from `nextPlan` entries; header "Sunday batch, next week", auto-open; empty nextPlan → "No plan for next week yet, generate it on the Plan tab."
4. `today > sunday` (past week shown): block hidden.

- [ ] Implement state machine; `weekdayAssembly` filtered to `date >= today` when week underway.
- [ ] recipe.js label "Sunday batch" → "Batch prep".
- [ ] Playwright walkthrough of states (mock date via fixture weeks: view future week, current week, flip weeks on the nav). Commit.

### Task 7: Verification pipeline

- [ ] Full `node --test` run green; `tsc` (jsconfig checkJs) green; lint/format hooks green.
- [ ] Reviewer subagents: code-reviewer + ui-reviewer (views touched). No security-relevant surface (no token/data-access changes) → security-reviewer skipped, stated here.
- [ ] Playwright MCP: load app with fixtures, exercise mid-week generate, past-day lockout, list build, batch states. Screenshots.
- [ ] Final commit; update docs/day-aware-weeks-design.md status line if anything shifted.
