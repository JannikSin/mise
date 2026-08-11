# Per-person plates v2.2: the transform, the serve step, and the table roles

Date: 2026-08-10. Status: **PLAN ONLY, nothing built.** Version history: v1
(Opus 5) was torn down on David's order ("not built with the correct
mission"). v2 was rebuilt through a five-seat council with anonymous
cross-review and a chairman verdict. v2 went through a Tribunal plan gate:
Red Team BLOCK (3 holes), Engineer 7 blockers; v2.1 closed all of them. The
re-review found the v2.1 frozen-pot model conflated two contracts (money vs
plating) and v2.2 splits them; every re-review finding is folded in, and
the closing Loyalist pass (verdict: PASS WITH CONCERNS, all concerns folded
in: §3 gates only the engine, the §7.1 denominator is pre-buy, the kill
review extends on short evidence, the head gains the tailoring control
David asked for, and two overrules moved to §14 for his decision) is the
final state of this plan. The corrections are marked inline.

**The one-breath truth model (v2.2):** the FROZEN POT is the contract for
money and buying. PLATES are always the per-seat solved amounts, derived
from durable stored inputs, never a redistribution of the pot. A missing
seat's food is a named remainder, never spread across the table. Prior history: the 2026-08-10 morning council BLOCKED
transforms, its same-day Tribunal blocked the replacement plan, v74-v76
shipped the bug fixes, David reaffirmed the transform direction three
times. Do not relitigate WHETHER; this spec is HOW.

**Read this whole file before writing code.** It is written for a fresh
session with none of the conversation that produced it. Every invariant in
§8 exists because something was verified to break without it.

**Privacy note (Tribunal, Lawyer):** this file lives in the PUBLIC repo, so
it names no family member but David, carries no real targets, and names no
medical procedure. Seats are called A (gain phase, the builder, David),
B (loss phase, carries an avoid list), C (recomp), D (unconfigured). Real
numbers live in the private data repo (`profiles/<id>/fitness/targets.json`).
Two pre-existing public-repo leaks are listed in §15 as day-one cleanup.

---

## 0. The mission, in David's words

> "You take that recipe, and then you multiply it by your profile, which gives
> it what it should change. And then you do that for each person that's in the
> table. And then after all that happens, you combine, and you kinda
> synthesize what can be done together, what can be done separate, or what has
> to be done separate. You multiply everything FIRST, and then you add it
> after."

> "There should be, after you say finished cooking, a setting-the-table or
> plating instruction. It lists out plainly and clearly what each person gets."

> "I don't want the recipe to say this has 9.75 servings because David needs
> three and dad needs 2.75. What are you trying to do, make me fat? I'm eating
> ONE serving. Mine."

> "There should be a head of every table. The head tailors it. The head is
> also in charge of assigning cooking assignments."

### 0.1 The identity this document is built around

David's design IS a matrix multiplication, and the spec says so plainly
because it is the organizing idea of everything below:

```
plate_p = T_p · r          // each seat: a diagonal transform times the recipe
pot     = Σ_p (T_p · r)    // the pot: the SUM of transformed plates
```

`r` is the recipe as a vector of per-serving ingredient quantities grouped
into roles. `T_p` is seat p's diagonal transform over role-space. The pot is
the sum of the plates, never the other way around. "Multiply everything
FIRST, then add it after" is distributivity, stated by a person who cooks:
you may NOT compute a family pot and then carve it by appetite, because a
scalar carve preserves the recipe's macro composition and the entire point
is that seat B's composition and seat A's composition differ.

---

## 1. What is already true (do not rebuild these)

Verified in code and live data on 2026-08-10. Re-verify before trusting.

1. **Recipes are already ratios.** Every recipe stores `servings` as a pure
   denominator. Dividing quantities by `servings` yields the per-serving
   vector `r`. Nothing to migrate.
2. **Serving COUNTS are already gone from every screen** (v75).
3. **Per-seat appetite already ships, and it is calories-only.**
   `seatServingsFor` (`app/lib/tables.js`) computes each seat's servings
   from day calories and slot weight, rounded to quarters and clamped to
   `[SERVINGS_MIN 0.5, BRIGADE_SERVINGS_MAX 3]`. **It contains no protein
   term.** This is the single most important fact in this file: any plan
   whose step 1 "surfaces existing plate data" ships plates correct on the
   axis nobody complained about and silent on the axis the engine exists
   for. That is what v1 did, and it is the mechanical reason David's
   "engineered to never ship" complaint was correct.
4. **The AI tailor exists** (`worker/src/lib.js` `TAILOR_TOOL`, auto-runs
   v76, once per table gated by a `tried` map) and its numbers feed the day
   meters and Today lines (`app/lib/tables.js` ~359-369). It is retired
   whole by this plan, at the drip start, not at deploy 2 (§11.6): retiring
   it earlier would blank live meters while the engine is still a no-op.
5. **The shared pot is already shopped from the bank recipe** (`potFromBank`,
   v74).
6. **Every recipe is already diet/allergen screened** via `recipeConflicts`
   (v74), with one open hole this plan must close at deploy 1: the
   `optional: true` skip (§8.2).
7. **`mergeFieldWise` keys array elements on string `id` or `date`**
   (`app/lib/merge.js:128`, `keyOf`). Everything in §8.1 follows.
8. **There is no creator/owner field on tables.** `TableEvent` carries
   none; brigade tables are materialized deterministically by whichever
   device gets there first, BY DESIGN, so two offline devices produce
   byte-identical objects and the merge is a no-op. §9 must not break that
   contract (Tribunal Engineer B5: v2's "first-writer headId" would have).
9. **`cookedAt` does not exist for tables** (Engineer B6). `CookView` gets
   `entryId: undefined` for table meals, renders DONE with no persistence,
   and `stripTableEntries` removes table entries from every plan write. The
   serve step's COOKED gate therefore needs new plumbing: `cookedAt` on
   `TableEvent`, a `setTableCooked` writer, SCHEMAS.md entry, cook-route
   carrying the table id. Priced into deploy 1 (§13).
10. **Batch recipes deliberately over-cook.** `cookPlan` mode `"full"`
    (`app/lib/portions.js` ~112-123) shows the whole batch when the table
    total is under the yield, because the plan schedules the leftovers. The
    synthesized pot must not silently defeat this (§7.5).

---

## 2. The core decision: deterministic, not AI

David's "multiply by your profile" is a deterministic function. Build the
transform as pure closed-form arithmetic:

| | AI tailor (today) | Transform (this spec) |
|---|---|---|
| same input, same output | no | yes |
| works offline | no | yes |
| cost per table | one API call (unchanged until the drip starts, then zero) | zero |
| testable | not really | fully |
| two phones agree | only by luck | when their inputs agree; §10 states exactly when that holds and what happens when it does not |

**There is no AI fallback, and no AI prose survives either** (Tribunal
Ledger): keeping "prose cook notes" on `TAILOR_TOOL` keeps the whole Worker
call and its spend. The deterministic prep-note line (§7.5) carries the
same information. The ONLY fallback, at every rung of §4.7, is uniform
scaling by `s_p`, which is today's behavior. The fallback path may never
send `diet` or `avoidIngredients` anywhere.

**Determinism claim, stated honestly (Red Team R1):** the transform is a
pure function, but its INPUTS (bank recipe, assembly tag, each seat's
targets) live in per-device stale-while-revalidate caches
(`app/lib/store.js` `read()` returns whatever the device holds and
revalidates in the background, returning early offline or when dirty). Two
devices agree only when their inputs agree. §10 therefore (a) fingerprints
the frozen pot with its input revisions, (b) makes the frozen pot the
single source for money and buying once it exists, and (c) bounds the
pre-freeze window honestly: live derivation there is guidance, it can
differ across devices, and money stays anchored to today's path until a
pot exists.

---

## 3. The GO/NO-GO that gates the ENGINE (one evening, zero code)

**Do this before any ENGINE code, schema, or data entry. It does NOT gate
deploy 1**: the serve step needs no engine, no macro table, no solve, and
it is the thing David asked for in plain words; making it wait on an
engine-feasibility evening would be v1's disease in one line (Loyalist).
Evening 0 and sessions 1-3 can run in either order or the same week.

1. **Write the pass thresholds down first**, in this file, before computing
   anything. Suggested bars, David confirms or edits: shared tables must
   carry **≥ 40%** of seat B's weekly calories; and the paper ceiling below
   must show the clamped solve moving seat B's plate **≥ +10 g protein per
   1000 kcal over the recipe's native density on the median dish** (the
   baseline is the recipe's own density; a feasible solve hits the target
   density by construction, so the measurable question is how far the
   clamps let it travel from the recipe's native density: Engineer L1).
2. **The share query.** From `households/<h>/events.json` plus seat B's
   plan files: what fraction of her weekly calories arrive at SHARED
   tables? The engine only touches shared meals.
3. **The ceiling on paper.** Her five most-cooked shared dinners. Bucket
   only the top-3 calorie contributors of each. Run the §4 solve by hand
   under her loss-phase clamps against her real stored targets.
4. **The clamp-bind census** (Engineer H4): for the four real seats across
   those dishes, how often does the `seatServingsFor` clamp (0.5 floor,
   3.0 cap) bind? The 0.5 floor biases the smallest eater UPWARD ~45% on
   calorie-dense dishes before the transform runs; the census sizes how
   often the transform starts in a hole. Pre-register the acceptable rate.
5. **Verdict.** Any bar misses: the engine dies here, one evening spent,
   and the serve step still ships as an honestly labeled portioning aid.
   All clear: GO, and these numbers become the fidelity baseline (§12).

### 3.1 RESULTS, run 2026-08-10 evening on the real cloned data

- **Share query: 41.0% — PASSES** the 40% bar (18 overlapping days,
  shared-table kcal vs her own-plan kcal).
- **Paper ceiling: FAILS.** Median achievable movement 6.2 g/1000 kcal
  against the +10 bar, on her five most-cooked shared dinners. The
  decisive fact: those dinners now sit at NATIVE densities of 68-86
  g/1000 kcal against her target of 71: the v73 fixes (density-aware
  picking + per-person portion sizing) already closed the gap the engine
  was conceived for. On low-carb dishes the solve physically cannot move
  density down (no carbs to grow) and clamps in place.
- **Clamp census: 1 of 20 binds** (seat A's dinner appetite 3.13 vs the
  3.0 cap on salmon-spinach). Minor.
- **OVERRIDDEN by David the same night, in his words: "build the
  engine."** The gate's finding stands on the record (the engine's value
  on her CURRENT dinners is small); the build proceeds on his authority,
  with his added invariant now load-bearing everywhere: **A SHOPPED WEEK
  IS FROZEN** (rung 0f — no tag, solve, or pot may touch a bought week;
  the upcoming week cooks exactly as planned from the bought
  ingredients; the drip begins ~4 weeks out, no earlier than
  2026-09-07).

### 3.2 Build state as of 2026-08-10 (late night)

SHIPPED, all inert (zero tags exist, so every path is uniform = today):
deploy 2a complete (`app/lib/synth.js`: relative solve, rung ladder incl.
0f, clamps + absolute caps, MACRO/PLATE_GRAMS/PLATE_ADDABLE, part
keywords, `seatServingsRaw` + stored `seats[].rawServings`); deploy 2b
CORE (frozen pot: freeze/parse/validate, `setTablePot`, both freeze
triggers wired at claim + COOKED, sameForEveryone drops the pot,
regeneration carry, `readMeta` sha fingerprints, house-wide `targetsById`
state, shopping-list `potRows` branch through ident canonicalization).
20 engine tests, 567 total.

BUILT 2026-08-10, evening session 2 (all pre-drip consumers): §11.1
money shares from the frozen pot's perSeat rows (pay-for-what-you-eat
exactly, servings-proportional fallback, note in the money tile), §11.2
`groupScale` Daily Dozen credits (quartized to the RENDERED amount),
§11.5 recipe view rendering the synthesized pot in solved mode, §11.4
rung-3 top-ups (solve-side emission under both caps, pot `topUps` array,
priced into the buy, billed to the eating seat, spoken on the serve
step), serve-step solved plate lines (grams nearest 25 / cup quarters /
veg words / flavor silent, §7.3), the weekly tailored/uniform instrument
line on Tables (derived live, never from pots), the §10/R6 claim-time
missing-plan warning (configured seats only — profile has a `phase` —
fires on the table card pre-claim and on the serve step pre-freeze), and
§9 `headId` (human-tap-only writer, cook→profiles-order fallback chain,
TAKE THIS TABLE, REDO PLATES gated on the head).

Tribunal final gate (same evening, five reviewers): Red Team's veto
items all closed in-session — perSeat conservation check in parsePot
(shares must sum to the row qty), billing restricted to seats AT the
table, sanitized-away rows flag `estimate`, topUps bounded (max 8 rows,
500 g each from the solve, 2000 g parse ceiling) and EXCLUDED from
billing (gram rows price at whole packages; they floor at 0 and flag
estimate, still reaching the buy), the R6 warning gated on the engine.
Engineer/Realist fixes: resolveHead ignores skip status per §9 verbatim,
groupScale restricted to wholeGrains (flax/nuts resolve to flavor and
never move), render-time consumers honor rung 0f through a sync
shopped-weeks mirror unless a valid pot proves the buy was solved, the
frozen pot outranks a live re-solve on the recipe page, pot perSeat is
normalized to the stored qty, the pot input fingerprint survives
parsePot, a lost pot (merge race) bills fallback WITH the estimate flag,
serve veg lines fold to one, aside seats on solved tables speak solved
amounts.

REMAINING BEFORE THE FIRST TAG IS EVER WRITTEN (hard rule; the drip may
not start without these): David's one-hour classification session, and
the explicit-override escape hatch for a bought week (David specified
it; deliberately deferred until someone actually needs to change a
bought week — the freeze itself is live as rung 0f).

DEFERRED WITH THE DRIP (known gaps, none fire at zero tags):
- §12's full instrument (hit/clamped/degenerate shares, median density
  miss over pinned tagged ids, persisted to instrument.json, home in the
  SYS view). Tonight ships only the tailored/uniform count line on
  Tables, David-gated. The kill review must not run on the line alone.
- §9's remaining head controls (change that meal's cook, adjust a seat's
  servings from the head card). Only REDO PLATES gating shipped.
- §11.1's named remainder: a DEPARTED seat's perSeat share is dropped
  and flags `estimate`, not billed to a named person. Billing an absent
  person without their tap needs David's ruling.
- Target-staleness detection at claim time: parsePot now returns the
  input fingerprint, but nothing compares a frozen target sha against
  the current one yet. A stale-but-synced cache freezes silently.
- Merge race residual: release-claim racing COOKED can erase pot and
  buyerId whole (field-wise merge sees deletions win). The bill then
  falls back servings-proportional WITH the estimate flag; the payer can
  flip to the cook. Real fix needs merge-level semantics.

---

## 4. The transform: a 2x2 solve in RELATIVE form

### 4.1 Why a scalar cannot work

A seat has two targets at a slot: calories and protein. A scalar traces a
ray through macro space; the target lies on that ray only when target
density equals recipe density. Two targets need two knobs. That is the
mathematical content of "multiply by your profile."

### 4.2 Ingredient roles: FOUR values

New optional field `ingredients[].part`:

```
protein | carbfat | veg | flavor
```

(v1 had five; `starch` and `fat` were fused into one knob at every point in
the math, so the split was an authoring decision with zero consequence.)

Absent = derived by keyword (`inferPart`, ~90 entries). A food not in the
keyword table resolves to `flavor`, which never moves.

**The fat rule.** Oils, butter, cooking fats are filed `flavor` even though
they are calorically carbfat, UNLESS the recipe marks the row
`atPlating: true` (a drizzle, a pat on top). "Give her a quarter of the
cooking oil" is not an instruction a human can follow; the cook eyeballs
it, credited intake diverges from real intake, and the app reports success:
the family's demonstrated failure mode. A fat added at plating is
portionable and may carry `part: "carbfat"` + `atPlating: true`.

**The unservable-quantum rule** (Red Team R10, generalizing the fat rule):
any plating line that rounds below its smallest servable display unit
(under 1/4 cup for household measures, under 25 g for scale measures)
renders as words ("a spoonful of rice") or is dropped, and **credited
macros are computed from the DISPLAYED amount, never the computed float**.
Credit what you render. The plate is an instruction; crediting food the
instruction cannot convey is how credited and real intake diverge silently.

### 4.3 The solve, relative form

The multipliers are relative and apply to PER-SERVING quantities:

```
q[i][p] = r[i] * s_p * m(part(i))     // r[i] = per-serving qty of row i

m(protein) = α_p        m(carbfat) = β_p
m(veg)     = 1          m(flavor)  = 1      // both ride appetite only

Solve for α_p, β_p:
α·C_pro + β·C_cf = C*/σ_p − (C_veg + C_fla)
α·P_pro + β·P_cf = P*/σ_p − (P_veg + P_fla)
```

`C_x, P_x` are the recipe's PER-SERVING calories/protein in bucket x after
§4.4 normalization; `C*, P*` are the seat's slot targets.

- **Two servings numbers, deliberately** (Engineer H4/H5): the TARGET side
  divides by **σ_p, the raw unrounded ratio** `seatServingsFor` computes
  before rounding/clamping, so the solve is not asked to close a gap that
  is pure quantization. The PLATE side (`q[i][p]`) rides **s_p, the stored
  rounded value**, so the neutral case stays bit-identical to today.
  **σ_p's source, pinned (re-review N6/N3/N4, else this drifts):**
  - `seatServingsFor` gains an accessor exposing the raw ratio (a
    signature change; `weekbuilder.js` and `main.js` call sites priced
    into deploy 2a).
  - At materialization, `σ_p` is stored on the seat as
    `seats[].rawServings`, written in the SAME write as `servings`, so the
    two can never drift apart across weeks, phase changes, or target
    edits: they are stale together or fresh together, and the residual
    between them stays pure quantization.
  - **Manual override rule:** if `seats[].servings` was hand-edited (it no
    longer equals `round(clamp(rawServings))`, or `rawServings` is
    absent, as on all legacy tables), then **σ_p := s_p**: the human's
    number IS the target. Hand-edits go through `clampServings` with a
    [0.5, 10] range, far past `seatServingsFor`'s [0.5, 3]; without this
    rule a hand-set seat gets a plate scaled by 10 against a target solved
    for 1.5.
  - Table seats use FULL targets, never the week generator's
    `PROACTIVE_SHARE`-scaled (0.85) portion targets. Two conventions
    exist in the repo; this is the one tables use.
  - **Rung 0d** (§4.7): σ_p not finite or ≤ 0 → uniform for that seat. A
    READABLE targets file with no macros or no meal slots returns a flat
    servings of 1 today with σ_p never computed; without this rung,
    `C*/σ_p` is 0/0 → NaN into the pot.
  - **Residual surfacing** (Red Team R10): emit `hit` achieved-vs-target
    whenever `|s_p/σ_p − 1| > 0.10`, independent of whether a clamp
    bound. The 0.5-servings floor can put the smallest eater ~45% over
    target with both multipliers slack; that must print, not hide.
- **`P*` per slot is defined here because it exists nowhere in the
  codebase:** `P* = targets.protein × (slot calorie weight share)`, the
  same split calories already use. Target density is therefore uniform
  across slots; the solve still does real work because RECIPE density
  varies by dish.
- Vegetables are pinned to appetite deliberately. A free veg knob lets a
  loss-phase solve pile four times the greens onto a plate to absorb a
  calorie deficit. Arithmetically valid, gastronomically insane.

**The solve's two required tests** (Engineer H5, replacing v2's conflated
one):

1. Uniform-mode inertness: `synthMode === "uniform"` implies the POT, the
   shopping list output, and the ledger shares equal today's `cookPlan`
   path exactly, asserted on rounded values (re-review N7: a per-plate
   bit-identity test has no referent, no per-plate path exists today, and
   float association order makes bit-identity flake; assert at the
   artifacts that matter).
2. Solve identity: given exact targets `C* = σ_p·ΣC, P* = σ_p·ΣP`, the
   solve returns exactly (1, 1).

### 4.4 THE MOST IMPORTANT RULE: normalize against the audited total

Bucket the recipe's per-serving macros by `part` using the `MACRO` table,
then rescale so the buckets sum to the audited `nutrition` blob:

```
kC = (nutrition.calories/servings) / Σ raw_C
kP = (nutrition.protein/servings)  / Σ raw_P
C[part] = raw_C[part] * kC ;  P[part] = raw_P[part] * kP
```

- The `MACRO` table only has to get **ratios between foods** right. A
  table 15% high across the board produces identical output. **Required
  test: multiply the whole table by 1.15, assert bit-identical output.**
- At uniform mode, a seat's macros are exactly `recipe.nutrition × s_p`.
- Apportion, never recompute; a Greger-audited blob is never overwritten;
  error scales with the CHANGE, not the meal.
- **Zero-denominator guard** (Engineer B3): `Σ raw_C <= 0` or
  `Σ raw_P <= 0` (all-oil dish, no convertible rows) is rung 0b of §4.7:
  uniform, no macro output. Without it kC/kP go to Infinity and NaN
  propagates into the pot, the list, and the ledger.

### 4.5 Clamps, floors, and the ceiling

Clamps on **α and β**:

| `phase` | α (protein) | β (carbfat) |
|---|---|---|
| gain | [0.80, 2.00] | [0.60, 1.60] |
| loss / cut | [0.80, 1.75] | [0.30, 1.20] |
| recomp / maintain | [0.75, 1.50] | [0.60, 1.40] |

**The composite bound, stated because v2 did not multiply its own bounds
together (Red Team R3a):** the plate quantity is `r[i]·s_p·α`, and s_p
ranges [0.5, 3.0], so clamping α alone leaves a composite protein range of
0.15x to 6.0x per-serving. The absolute checks below are therefore the
real ceiling, and they are NOT optional:

- **`plateProteinCapG`**: maximum grams of PROTEIN, the macro, on one
  plate, computed from the §4.4 apportionment (needs no gram weights:
  Engineer L2). **Absent-default: 100 g**, so the cap is never silently
  off (Red Team R3b). The composite honesty note: a hand-edited seat can
  carry servings up to 10 (`clampServings`), so the composite relative
  range is up to 20x, not 6x; the absolute cap is the real ceiling and
  must never be "optimized away" as redundant with the clamps.
- **`plateCaloriesCap`** (kcal): same shape, absent-default 2500. Red
  Team noted the protein cap alone leaves calories uncapped for a
  10-serving hand-edit times β 1.6.
- **`plateCaloriesFloor`, `plateProteinFloor`** (NEW NAMES: Red Team R2
  and Engineer B4 both caught that v2 reused `caloriesFloor` /
  `proteinFloor`, which are EXISTING DAY-LEVEL fields the week generator
  enforces; read as plate floors they fire on every plate ever and aim
  the top-up machinery at the loss-phase seat). Absent-default: **no
  floor check** (rung 3 skipped). Checked on the plate, only when
  `synthMode === "solved"`.
- **All four new fields live in `targets.json` under `macros`**, beside
  the day-level floors, documented in SCHEMAS.md same commit (Red Team:
  v2.1 said "profile fields" without pinning the object).
- **Order of operations** (Red Team R3c): solve → clamp → floors/top-up →
  **re-check both caps after any top-up**. A top-up that would breach a
  cap is not emitted.

### 4.6 Degeneracy is the MAJORITY path today

Measured: **64 of 107 recipes have at least one bucket with zero
gram-convertible rows** (det exactly 0 until gram weights land), and **15
are structurally single-bucket**. Uniform is the normal state of most of
the bank, forever, for any recipe never tagged. The engine's value
concentrates in the ~25 dishes the family actually rotates.

Degeneracy test (Engineer M2 supplied the number v2 omitted): degenerate
iff `|det| < 0.05 · ‖(C_pro, C_cf)‖ · ‖(P_pro, P_cf)‖`. Pin the 15
structurally single-bucket recipe ids in a test by hand. Pin the
live-tagged subset in the weekly instrument the same way (Historian).

### 4.7 Failure ladder, every rung visible, never silent

0. `assembly !== "plated"` → α = β = 1, `synthMode: "uniform"`. **This
   rung is the rollout mechanism** (Engineer B2: v2 never wired the mixed
   default to the multipliers, so its no-op claim was unimplemented).
   (The field is named `synthMode` everywhere: `cookPlan` already returns
   its own `mode` in the same render path, and one word carrying two
   enums is a 3am bug: re-review N7/N8.)
0b. `Σ raw_C <= 0 || Σ raw_P <= 0` → uniform, no macro output (§4.4).
0c. Any seat the rendering device KNOWS to be occasion-held → suppression
   per §8.8. (v2.1's "unreadable occasion state → uniform" was
   unimplementable: a null occasions read is the NORMAL state for a
   profile that never created one, so the rung would have either fired on
   nearly every table or been coded as null-means-empty, restoring the
   fail-open. §8.8 now states the real mechanism and the residual.)
0d. σ_p not finite or ≤ 0 → uniform for that seat (§4.3).
1. Degenerate or ill-conditioned solve (§4.6): uniform, note: "this dish
   is one thing nutritionally; only the amount changes."
2. A clamp binds: clamp, recompute achieved macros **from the clamped
   multipliers**, emit `hit: {calories, protein}` achieved-vs-target.
   Never report the target as achieved.
3. `synthMode === "solved"` and the plate is below a PRESENT
   `plateCaloriesFloor` or `plateProteinFloor`: do not bend clamps. Emit
   a top-up from `PLATE_ADDABLE` if one closes the gap without breaching
   either cap, else surface the gap. Refuse loudly either way.
4. A seat's `targets.json` unreadable: uniform for that seat only, AND the
   condition is surfaced at the two moments it matters: at buy-claim
   ("buying without seat B's plan, not synced": Red Team R6) and on the
   head's card. The table must never fail to build because a phone has
   not synced.
5. `recipe.nutrition.calories <= 0`: uniform, no macro output.

**The ladder's own failure is silence:** if a data bug drops every recipe
to uniform, the app looks perfect and the engine is dead, and the sole
reviewer cannot tell those states apart. One system line, weekly, in
`app/views/system.js` (Engineer M6 named the home v2 omitted):
`this week: 14 tailored, 7 uniform`. Tailored falling two weeks running
stops the drip.

### 4.8 The transform may NEVER

- Add, remove or substitute an ingredient. `pot.rows.length ===
  recipe.ingredients.length` and `pot.rows[i].food ===
  recipe.ingredients[i].food` for every i. **Test it.**
- Change a `food` or a `unit`.
- Scale a `flavor` row by anything but `s_p`.
- See `diet`, `allergens`, `avoidIngredients` or `avoidRecipes`. Those
  screens run upstream (§8.2 extends them; the SCREEN is where allergens
  belong, never the transform). A transform that can see an allergen is a
  transform that can be argued into serving one.
- Touch a table carrying `sameForEveryone: true`.
- Read the clock, a random source, or unsorted key order.
- Call any model. Uniform is the only fallback.

---

## 5. Synthesis: separability belongs to the COMPONENT

### 5.1 `assembly`, one word per recipe

```jsonc
"assembly": "plated"   // plated | mixed        absent = "mixed"
```

- **`plated`**: components stay discrete on the finished plate.
  Composition free.
- **`mixed`**: one homogeneous mass. Composition locked (rung 0); only the
  amount changes. You cannot change the macro composition of a bowl of
  chili by portioning it.

**Absent = mixed = rung 0 = byte-identical to today. This is the ROLLOUT
MECHANISM:** the engine deploys as a production no-op, and each recipe's
tag is a per-recipe feature flag. **Scope of the rollback lever, stated
precisely (Red Team R11, confirmed stronger on re-review):** deleting a
tag affects tables generated AFTER the deletion; `recordEntries` is
idempotent by table id, so recorded money can never move at all. The
emergency stops for tonight: the head's REDO PLATES (defined in §10: it
re-freezes the pot from current inputs, a real writer, only shown once a
pot exists: re-review N10 killed the v2.1 version, which was a no-op
button rendering identically to success), or `sameForEveryone` (whose
writer now also drops any frozen pot, re-review N9, else a solved pot
keeps driving the buy under a flag that promises no per-person plates).

**Tags are hand-set, never inferred.** The classification question, for a
non-developer: **"Could you give one person double the chicken and less
rice out of this pan, without cooking twice?"** Yes = plated. No = mixed.

Process: David CLASSIFIES all 107 in one sitting, producing an ordered
queue; **part labels are read in the same sitting for the
plated-classified set only** (Ledger: labels on mixed recipes are dead
data under rung 0, ~75% of the 1004 rows can never matter). Tags are
WRITTEN into the bank as recipes come up in rotation, ~5/week, solvable
first, each confirmed once at the stove the first time it is cooked
("could you actually serve these separately?"). ~80 recipes stay `mixed`
forever, correctly.

### 5.2 Decision rule, per ingredient

`Q[i] = Σ_p q[i][p]`, always.

| Condition | Emit |
|---|---|
| `assembly === "mixed"` | pot only; plating is ONE mass line per person |
| all `q[i][p]` equal | pot only, no plating line |
| `part === "flavor"` (incl. in-pan fats) | pot only; rides at each eater's mass share |
| `plated` and portionable | pot **and** a plating line per seat |

No split-cook branch, deliberately. Under `mixed`, changing composition
needs two pots, not worth it for four people: emit a compromise note.

### 5.3 Rounding: round the POT once, then distribute

1. Compute every `q[i][p]` at full float precision.
2. `Q[i] = scaleQty(Σ raw, unit, 1)`: round once, on the pot.
3. Distribute back proportionally; round plate lines for display only
   (grams to nearest 25, household measures to quarters, §4.2's
   unservable-quantum rule applies).
4. Displayed plate lines may not sum exactly to `Q[i]`. Correct. **The pot
   is the truth; the plates are guidance.**

### 5.4 Integrity checks, honestly labeled (Red Team R4 demoted v2's headline)

v2 called conservation "the invariant" three times. Red Team demonstrated
the assert as v2 wrote it is a tautology: distributing `Q[i]`
proportionally makes the plate sum equal `Q[i]` by construction, so the
check could never fail on a wrong plate, label, weight, or tag. The same
argument three council seats used to kill the drift test. What actually
guards this design, each with teeth:

1. **Identity invariant** (§4.8): row count and food names equal the bank
   recipe's, asserted on every pot. Catches structural corruption.
2. **Float tripwire:** `|Σ_p q[i][p] − Q[i]|` within
   `max(1% of Q, 0.5)` for countable units, `max(1%, 0.01)` otherwise,
   on raw floats before display rounding (Engineer M3 supplied the
   per-unit form). Catches NaN and unit mishandling, nothing more, and is
   labeled a tripwire, not a safety property.
3. **Frozen-pot comparison:** at cook-start, the cook device compares its
   derived pot to the frozen pot (§10). Divergence renders an
   informational line ("bought for 4, cooking for 3") and NEVER refuses
   tailoring (Engineer B7: a seat skip between buy and cook is normal).
   **Plates are NOT redistributed from the frozen pot** (re-review N1,
   the loop-1 BLOCK: distributing a four-person pot across three present
   seats plates every remaining person, including the loss seat, ~33%
   over their solved amount and announces it as an update; the document's
   own opening complaint as specified behavior). Each present seat is
   served its own `q[i][p]`; a departed seat's contribution prints as a
   named remainder via §5.5's machinery: "seat D's portion, about a
   quarter of the pan, goes in the fridge."
4. **The §6.2 data tests** (scale invariance, category bands, sensitivity,
   bucket balance).

**On any structural failure (1 fails, or NaN): refuse the TAILORING, never
the DINNER.** Degrade to `sameForEveryone` + bank recipe + one visible
line ("plates could not be checked tonight, everyone the same"), log it,
keep the recipe, the serve step, and the shopping context on screen. Loud,
visible, not an outage.

### 5.5 Allergens are upstream, and the conflicted seat still buys in

A seat whose avoid list conflicts with the recipe fails `recipeConflicts`
UPSTREAM: no pin, no plate, a visible conflict banner. The synthesis never
omits an allergen, which removes the most dangerous operation from the
design. **But the conflicted seat still counts toward the pot** so the
family's buy is right.

**Serve-step consequences (Red Team R9, corrected loop 2):** the
conflicted seat STAYS IN the denominator (their food is in the pan; a
smaller denominator over-plates everyone else) but their share renders as
a named remainder line, never a plate instruction: `SEAT B: set aside a plain portion, about a quarter of the pan (see
note)`. Never silently absorbed; a family that eats what is in the pan
will otherwise park the surplus next to the loss-phase seat. Mass-share
"conservation by construction" is only claimed when every seat has a
printed line. **And the money follows the food** (re-review R9): the
conflicted seat's remainder is costed at its mass share in §11.1; plating
lines alone would bill that seat zero and spread their food's cost across
the table, a real recurring transfer landing on the seat the engine
exists to serve. The named-remainder machinery is also what §5.4.3 uses
for a seat that skips after the buy.

---

## 6. The data plan

| Table | Size | Author |
|---|---|---|
| `MACRO` per 100 g | ~118 foods x 2-4 | **AI-drafted** (§4.4 normalization cancels proportional error), guarded by §6.2 |
| `PLATE_GRAMS` | **~25 entries**, plated dishes only | **HAND-ENTERED.** Normalization does NOT protect gram weights: a wrong weight changes the physical pot, plate, list, and money. Lives in `app/lib/synth.js`, NOT in `FOOD_UNITS`, whose own header says "never nutrition-grade" (Engineer M7: v2 left these homeless) |
| `PLATE_ADDABLE` | ~15 foods | AI-drafted, David skims |
| `assembly` tags | 107 classified, ~25 written | David, §5.1 |
| `part` labels | plated set only, ~250 rows | keyword-derived, human-read at classification (§5.1) |

Each `MACRO` entry states RAW or COOKED, matching how the bank writes the
food (~30% on protein density; the documented failure axis of every
consumer nutrition database, per the Historian's external survey).

### 6.2 The tests (v1's drift test stays dead)

1. **Scale invariance:** whole MACRO table × 1.15, bit-identical output.
2. **Category bands** (~20 lines): meat 15-35 g protein/100 g, cooked
   grain 2-5, oil 0, cooked legume 5-10. Catches hallucinations.
3. **Per-food sensitivity:** perturb ±20%, rank by α/β movement,
   hand-check the head of the list (top-3 calorie contributors per plated
   recipe, ~30 numbers).
4. **Bucket balance:** no single food supplies >90% or <5% of its bucket
   in a plated recipe without a named exception.

---

## 7. The serve step (deploy 1, ships alone, ships first)

### 7.1 Data source on day one: pot mass share, NOT the AI tailor

v1 shipped the serve step from the v76 AI plate lines: model-authored
allergen prose promoted to the mandatory last screen at the stove, the
premise the first Tribunal blocked, relocated. Day one renders **mass
share of the STORED seat servings**, applied to tonight's cook plan
quantities. **The denominator is every seat whose food is in the pot:
every seat not skipped BEFORE the buy** (loop-2 Red Team B1, precision
added at Loyalist review: "non-skipped" alone would let a post-buy skip
shrink the denominator and regrow the other shares, which is B1 again;
a post-buy skip changes rendering only, per §5.4.3). Eligibility (§5.5)
governs only how a seat's share is RENDERED: a plate instruction for
eligible seats, a named remainder line for conflicted, post-buy-skipped,
or occasion-held seats. Plates plus remainder lines partition the pot
exactly once. The stored seats are durable in `events.json` and change only
when a human changes a seat, which gives deploy 1 its stability rule with
ZERO new storage (re-review N2 caught that v2.1 leaned on the frozen pot
for stability, which does not exist until deploy 2b and never exists for
unclaimed tables: the serve step would have shipped with exactly the
reload instability the model was built to kill). No macro table, no model
output, honest portioning aid. When the engine lands, the same screen
renders the transform's plates, zero layout change.

### 7.2 It is not a section, it is the last step

Serving is the final step of Cook Mode and its button is the COOKED
button. You cannot mark a meal cooked without passing the screen that says
who gets what. **New plumbing this requires, priced in (Engineer B6):**
`cookedAt` on `TableEvent` + `setTableCooked` writer + SCHEMAS.md entry +
cook-route table id. This also creates the adoption signal §12 needs.

### 7.3 Copy and format

```
SERVE
Amounts for tonight's table.

DAVID
300 g chicken
2 cups rice

ANN                          <- placeholder names; real seats render
150 g chicken                   real first names from profiles.json,
3/4 cup rice                    which lives in the PRIVATE repo
extra spinach on top

BEN
250 g chicken
1 1/2 cups rice

CAL
a normal plate
set this seat up ->

SET ASIDE
BEN's portion, about a quarter
of the pan, goes in the fridge
```

(The SET ASIDE block replaces a seat's plate block, same position in the
fixed order, whenever that seat's share is not a plate instruction:
conflicted seat, post-buy skip, occasion-held seat. It is the rendered
form of every named remainder. Loop-2 Red Team: a remainder that exists
in prose but not in the copy spec does not exist.)

- **No calories or protein on this screen.** Macros at the counter are
  noise and invite negotiation.
- Protein in grams (nearest 25), starch in household measures (quarters),
  vegetables as adjectives. §4.2's unservable-quantum rule applies.
- Name in caps, bare noun phrases, no verbs. Four seats, one screen, no
  scroll, one big COOKED tap.
- **Fixed seat order: `profiles.json` order, id tiebreak** (Engineer M1:
  v2 said "fixed order" while the seats array order is rebuilt by the
  merge and is NOT stable; name the sort or there is no fixed order).
- Header "Amounts for tonight's table," never a headcount.
- Unconfigured seats shown ("a normal plate" + setup link).
- **Amount stability, stated honestly (Red Team R8 killed v2's
  "freeze at cook-start"; re-review N1 killed v2.1's
  redistribute-the-frozen-pot):** plates derive from DURABLE STORED
  INPUTS (`seats[].servings` + `rawServings` + bank + targets), so a
  reload reproduces the same amounts on the same data. A seat change
  changes only THAT seat's line: the departed seat's amounts move to a
  named remainder line ("seat D's portion goes in the fridge"), and
  no other seat's numbers ever change at the stove. Nothing is ever
  redistributed.

### 7.4 One source, two projections

| Where | Audience | Shows |
|---|---|---|
| Serve step, in Cook Mode | the cook, at the stove | all plates |
| Today | you, on your phone | your one line |
| The stacked list on the table card | nobody | delete it |

Plus one **private projection** (Lawyer): each configured seat can see
their own achieved numbers in their own profile view. The serve screen
never shows a macro; a person's numbers render only to that person.
Without this, the only backstop against a systematic miss is David's
attention.

### 7.5 The per-table recipe: the numbers change, the words never

The recipe view for a table shows tonight's pot quantities: arithmetic,
not AI, rounded to what a human buys and cuts. Same name, same steps, same
words forever. A conflict is a deterministic prep note under the
ingredients (`keep one end of the pan onion-free (seat B)`), built from
the conflict reasons `recipeConflicts` already returns, never model prose.
**Batch-friendly exception (Engineer B1a):** when `synthMode ===
"uniform"`, the view renders exactly what `cookPlan` renders today,
including the deliberate full-batch behavior for batch recipes below
yield. The synthesized pot replaces the ingredient column only when
`synthMode === "solved"`.

---

## 8. INVARIANTS

### 8.1 Generated rows carry NO merge keys, enforced against `keyOf` itself

No generated ingredient row, plating row or step may merge element-wise.
The write-path assert **imports the real predicate** (`keyOf` /
`keyedMap` from `merge.js`) rather than hand-copying "no id, no date"
(Red Team R12: a copied field list rots the day `keyOf` learns a third
key form; the imported predicate cannot). Demonstrated harms this
prevents: two phones' regenerations union-merging (an avoided ingredient
landing on the avoiding seat's table, from a merge, no error), and
date-keyed plating rows collapsing.

Required test: two concurrent generations of one table through
`mergeFieldWise`; result equals exactly one side.

### 8.2 The `optional: true` bypass is closed at BOTH ends

`recipeConflicts` skips `optional` rows. v2 closed generation only; Red
Team R5 walked an optional garnish matching a seat's avoid list straight
past the screen and onto an un-skippable serve line, and noted the AI
tailor's retirement removes today's only semantic backstop. Deploy 1
therefore closes **seating** too:

- Table seating screens optional rows as a soft tier: a match does not
  unseat, but the seat's serve line gains a deterministic note
  (`no red onion for seat B`) built from the matched row, and the prep
  note (§7.5) names it.
- The synonym map for allergen families (onion family: onion, shallot,
  scallion, leek, chive, ramp) lands **in the soft tier and note
  generation ONLY** at deploy 1. It does NOT land in the hard
  `recipeConflicts` screen (Red Team re-review R5: that predicate has
  eight call sites including the week generator's pool filters and
  `brigadePool`'s intersection screen; widening it silently shrinks every
  pool in the app and can seat a house with no dinners). Promoting the
  synonyms into the hard screen is a separate, later change with a
  pool-size test on the real bank.

### 8.3 Every generated artifact is screened at GENERATION time

Screen every generated artifact against every seated profile before it is
stored or rendered, optional rows included. Fail closed: on conflict, fall
back to bank recipe + `sameForEveryone`, and say why.

### 8.4 Macros: two legal sources

1. The audited per-serving blob, scaled and apportioned per §4.4.
2. Achieved macros recomputed from the clamped multipliers (§4.7 rung 2),
   with the §4.2 credit-what-you-render correction.

A plate emits NO macro number only when `synthMode !== "solved"` with an
unweighed pot, or when a non-flavor ingredient lacks a MACRO entry. Then
render a dash and "not estimated." Never compute macros beyond the role
table; never call a nutrition API.

### 8.5 Integrity checks per §5.4

Refuse the tailoring, never the dinner.

### 8.6 The pot is what gets shopped

Quantity semantics feed seven consumers: shopping list, pantry depletion,
price estimation, cost-split ledger, receipt reconciliation, brigade
materialization, week generator. §11 names the effect on each.

### 8.7 No cross-profile writes; reads are house-wide by design

A table lives ONLY in `households/<h>/events.json`; profiles derive from
it. No code writes another person's plan file. **Reads are intentionally
house-wide** (Lawyer, Engineer L5): deriving plates requires every seated
profile's targets on the rendering device; the household is the trust
boundary, accepted and stated. What is computed is bounded by what is
RENDERED: §7.4's projection rules are the privacy mechanism.

### 8.8 Occasion days suppress everything here, and the suppression is mechanized

On any occasion-held day, tailoring is suppressed for the held SEAT
regardless of `offTables` (Red Team R7ii: `offTables: false` deliberately
keeps the person seated, and a seated-but-medically-held seat must still
get uniform, no transform, no macro display). Existing occasion
instructions are authoritative, never regenerated. v2's "fail safe, both
directions" was asserted, v2.1's mechanization was unbuildable (re-review
N6: passing occasions into `materializeBrigade` makes the materialized
table a function of per-device cache state, breaking the byte-identity
contract §1.8/§9 depend on; and v2.1's unseat-inside-materialization only
ran on whichever device created the table first, the least-informed-device
failure relocated into the highest-consequence path). The buildable
mechanism, two layers plus an honest residual:

- **Every device is an enforcement point** (amended at build time with the
  code reviewer: the app already loads EVERY profile's occasions into each
  device's cache, so restricting the sweep to the owner's device would
  throw away coverage the data already pays for; a prep seat is protected
  as soon as ANY device opens). The unseat sweep re-runs at app open and
  on sync, over cached occasions, covering tables materialized after the
  occasion was created. **The sweep is ONLY the seat-patch block**
  (`tablesToLeave` + `patchSeat` + `writeHouseEvents`, idempotent:
  already-skipped seats are filtered). It must NEVER call
  `writeOccasion`/`applyOccasion` (loop-2 Red Team C1: that path drops and
  regenerates every plan entry on the occasion's dates). The stored
  `profileId` inside an occasions file is IGNORED; the file's directory is
  the authority (an auto-write loop must not honor a spoofable field:
  security review M1). Accepted trade, stated: a device holding a
  STALE-CACHED deleted occasion re-skips the seat until it syncs the
  deletion; the window is one sync, and the manual un-skip on the table
  card remains the human override in the meantime.
- **Derive-time belt:** `deriveTables` (which every device runs at every
  render, and which is ALLOWED to be device-dependent, unlike the
  materializer) checks cached occasion data and suppresses tailoring for
  any seat it knows to be held: rung 0c.
- **The residual, stated:** a device that has never cached the occasion
  cannot suppress on it. A null occasions read is the normal state for
  most profiles and is treated as no-knowledge, not as an error. The
  owner-device sweep is what bounds this window.
- A pot frozen BEFORE an occasion lands the same day renders a visible
  over-buy note; the frozen pot is not rewritten.

### 8.9 Prefer a visible refusal to a plausible output

The only reviewer is a non-developer who reviews by using the app; a
mathematically unwinnable scoreboard once ran for weeks unnoticed. Refuse
loudly, at the smallest blast radius that is still loud. A safeguard whose
success and failure render identically is itself a violation (this is why
§7.3's unobservable freeze died).

---

## 9. Head of the table

David's concept. Mechanics rebuilt twice: v2 on the council's finding that
no creator field exists, v2.1 on the Engineer's finding (B5) that stamping
a device id at materialization would break `materializeBrigade`'s
byte-identity contract, which exists so two offline devices produce
identical tables and merge as a no-op.

- **`headId` is written ONLY by a human tap** ("take this table"), never
  at materialization. Materialized tables stay byte-identical across
  devices.
- **Resolution rule: `headId` if live, else the table's `cookId` if set,
  else the first SEATED profile in `profiles.json` order (id tiebreak),
  ignoring skip status.** Re-review N4 corrected v2.1's `cookOf` chain:
  `cookOf` falls back to the seats-array order, which the merge rebuilds
  and which §7.3 already refuses to trust for display; it also filters
  skipped seats, so tapping "skip mine" would move the head. Brigade
  tables always carry `cookId`, so the deterministic-everywhere claim
  holds there; hand-made tables resolve by the same stable sort the serve
  step uses. Visible failover free: a `headId` pointing at a departed
  profile resolves past it and the card says "this table is unclaimed,
  you can take it."
- The head's device owns generation. The head's card shows the three
  controls nobody else's shows: tap a name to change that meal's cook,
  REDO PLATES, and **adjust a seat's servings** (the existing hand-edit
  path, which is what §4.3's manual-override rule exists for). The
  Loyalist caught that "the head tailors it" was David's explicit ask and
  v2.2 depended on a hand-edit no surface offered; this is that surface.
  Everyone else: absent, not greyed.
- No staleness rule. No presence data exists; a heartbeat is the write
  path §8.7 forbids. Transfer is manual, one tap, by any seated adult.
- UI says "**<name>'s table**." The words "Head of the Table" appear
  nowhere; the concept lives in the schema.

---

## 10. Storage: store nothing, freeze the pot WITH ITS INPUTS

Derive-don't-store, matching the app's discipline. **The frozen pot is
the contract for MONEY AND BUYING, and nothing else** (loop-1 re-review:
v2.1 made it the single source for plating too, and redistributing a
bought-for-four pot across three present seats overfeeds everyone left;
plates are always the per-seat solved amounts from §4.3, derived from
durable stored inputs per §7.3).

- **Plates are derived at render** from table (`seats[].servings` +
  `rawServings`) + targets + bank. Deriving needs every seated profile's
  targets in synchronous state: deploy 2a adds a `targetsById` map loaded
  with profiles and cached in IndexedDB (Engineer H1; today cross-profile
  targets exist only inside ad-hoc awaits). The serve step is an
  intentional navigation and waits for that load; until it resolves a
  seat is rung 4 (uniform), and the wait is why first paint never differs
  from second.
- **Pre-freeze derivation, scoped honestly** (loop-2 C4): before any
  freeze, an unclaimed uncooked solved table's live-derived rows DO reach
  the shopping list (`deriveTables` computes when no pot is present), so
  "display-only" is overstated for that window; quantities can differ
  across devices there, bounded, while money stays anchored (§11.1's
  no-pot fallback bills by today's path with the estimate flag).
- **The freeze-or-not test reads the RAW stored field** (loop-2 C5): a
  pot dropped at derive time for malformed JSON or failed identity is
  still present on the stored object, and `setTableCooked`'s "freeze only
  if no valid pot" check must parse-and-validate the raw field so a
  broken pot gets repaired rather than preserved.
- **Cook-triggered freezes surface the missing-targets warning too**, on
  the serve step itself, not only at claim time (loop-2 C6 note).
- **The pot freezes only when `synthMode === "solved"`** (re-review N1
  Engineer: v2.1 froze uniform pots too, and §10 "pot is the single
  source for shopping" then contradicted §11.3 "uniform mode: existing
  path untouched" for the identical zero-tag table; freezing solved-only
  makes deploy 2b provably inert AND is less code). An unclaimed-or-
  uniform table has no `t.pot` and runs today's paths.
- **Two freeze triggers, first one fires** (re-review N2: buy-claim alone
  is optional and normal pantry dinners never claim): `setTableBuyer`
  (Engineer L3; the signature gains bank+targets context, stated because
  today it is pure over events) and `setTableCooked` (§7.2's new writer).
  Clearing a claim drops the pot only if `cookedAt` is also absent.
  `sameForEveryone` drops it (re-review N9). REDO PLATES re-freezes it
  from current inputs (re-review N10), same writer family.
- **Frozen shape**, SCHEMAS.md same commit (Engineer H3):

```jsonc
"pot": "<JSON string>"   // serialized: mergeFieldWise treats a string
                         // atomically, last writer wins whole, no
                         // field-wise interleave of two freezes
// parsed shape:
{ "synthV": 1,                        // algorithm version (SYNTH_V in synth.js), render-as-is
                                      // both directions, never recompute
  "inputs": {
    "recipeRev": "<content hash of ingredients+servings+assembly>",
    "targets": { "<profileId>": "<github-blob-sha | 'dirty' | 'missing'>" } },
    // blob sha, NOT the store's rev counter: rev is a device-local write
    // counter and two devices holding identical bytes carry different
    // revs, reporting skew that does not exist (re-review N5). A dirty
    // (locally-edited, unflushed) record stamps 'dirty' and surfaces
    // "unsynced edits" at claim. Requires read() to expose {data, sha,
    // dirty}: a small store.js addition priced into deploy 2a, and the
    // same addition R6 needs.
  "synthMode": "solved",
  "rows": [{ "food": "...", "unit": "...", "qty": 1.5 }] }
```

- **Validation on read** (Engineer H3): parse inside try/catch (a
  malformed string must drop THE POT with a visible line, never take down
  the whole `deriveTables` memo: smallest loud radius, §8.9); check
  finite qty, string food/unit, AND full §4.8 identity
  (`rows[i].food === bank.ingredients[i].food` for every i, not
  length-only: a permuted pot passes a length check); no merge keys
  (§8.1); a pot with neither `buyerId` nor `cookedAt` present on the
  table is an orphan and is dropped (re-review N5: concurrent unclaim +
  REDO merges into exactly that state).
- **Once frozen, the pot is the single source for the shopping list**
  (buyer's `cookExtras`: `deriveTables` reads `t.pot` when present,
  computes only when absent, and pot rows still route through the `ident`
  canonicalization every other list line gets, or pantry subtraction
  stops matching: re-review N13) **and the ledger** (§11.1). The serve
  step reads it only for the §5.4.3 informational comparison.
- **A freeze with missing targets is marked and announced** at claim time.
  "Missing" distinguishes two states by `profiles.json` (which IS
  synced): a seat with no configured fitness profile is a normal plate
  and never warned about; a CONFIGURED seat whose targets read null on
  this device warns "buying without seat B's plan (not synced here)"
  (Red Team R6: without the distinction the warning either cries wolf on
  every unconfigured seat or is tuned to silence).
- **`materializeBrigade`'s regeneration branch carries `pot`, `cookedAt`,
  and `sameForEveryone` forward, GATED on `existing.recipeId ===
  meal.id`, the same gate `servings` already uses** (re-review N3 +
  loop-2 C3: unconditional carry would stamp a cooked flag and a stale
  pot onto a swapped dish; the pot self-heals via identity validation,
  `cookedAt` does not and it is §12's adoption signal). `rawServings`
  carries and recomputes **under the same gate as `servings`** (loop-2
  C2: carrying one while recomputing the other trips §4.3's hand-edit
  detector and silently degrades the seat to σ_p := s_p). Test required.
- **Mixed app versions** (re-review N12): old builds ignore unknown
  fields (`validTable` passes them through, writers spread `...t`), so
  the new fields are safe to older phones; old builds keep writing the
  retired `tailor` blob until they update, which is harmless and expires
  with §11.6.
- Nothing else about the synthesis is ever written, with ONE named
  exception: the weekly instrument aggregates (§12) persist to
  `households/<h>/instrument.json`, aggregate counts only, capped at 26
  weeks, purgeable (Lawyer; Engineer M6 asked where they live).

Cross-device truth model, in one breath: **plates are derived, per-seat,
from durable stored inputs; the frozen pot is the contract for money and
buying; live pre-freeze derivation of the pot is a preview.**

---

## 11. What the engine deploy BREAKS and fixes, all behind rung 0

Engineer B1 falsified v2's "deploy 2 is a no-op" claim three ways; the
rule that restores it: **every consumer below, AND the §10 freeze itself
(re-review N1 Engineer), keys on `synthMode` and takes the pre-engine
code path verbatim when uniform.** With zero tags, synthMode is always
uniform (rung 0), no pot is ever frozen, so the deploy is provably inert.
**The inertness test asserts at the pot and its two consumers** (shopping
list output and ledger shares) against today's `cookPlan` output on
rounded values (re-review N7: v2.1's per-plate "bit-identical to
scaleQty" test had no referent, since no per-plate path exists today, and
float-order differences make bit-identity flake at half-ULP boundaries;
assert where the property has meaning).

1. **Money ledger.** When solved: cost each seat's plating lines through
   `itemCost` (flavor rows at mass share; unpriceable rows floor 0 with
   the `estimate` flag, matching `money.js` today: Engineer M5), **plus
   the conflicted or departed seat's named remainder at its mass share**
   (§5.5), shares **derived from the frozen pot**; `recordEntries` is
   idempotent by table id so recorded entries never move. When uniform:
   today's servings-proportional path, unchanged. A table that reaches
   ledger recording with no frozen pot (solved but never claimed nor
   cooked-confirmed: rare but reachable) bills by today's path with the
   `estimate` flag.
2. **Daily Dozen credits.** Derived table entries carry
   `groupScale: Record<group, multiplier>` (all 1 at uniform) and
   `dayGroupTotal` multiplies by it (Engineer M4 traced the real call
   path v2 hand-waved).
3. **The pot reaches the shopping list.** Buyer's `cookExtras` carries the
   frozen pot rows, absolute, NOT multiplied by `perServing`, routed
   through `ident` canonicalization (§10). Uniform mode: no
   `potIngredients`, existing path untouched.
4. **Plate top-ups get bought**, only in solved mode (Engineer B1c: v2's
   unscoped floors would have emitted top-ups at zero tags), capped by
   both caps (§4.5), excluded from the float tripwire, included in the
   buy, flagged in the list.
5. **The recipe view renders the synthesized pot only in solved mode**
   (§7.5; uniform = `cookPlan` verbatim including batch behavior). The
   new field is `synthMode` because this view already holds `cookPlan`'s
   own `mode` enum (re-review N8).
6. **The AI tailor retires whole at DRIP START, not at the engine deploy**
   (Engineer B1b: its numbers feed live day meters and Today lines at
   zero tags; retiring it inside the "no-op" deploy would visibly blank
   them). At drip start: the Worker call is removed entirely, numbers AND
   prose (Ledger), meters read solved output where available and bank ×
   servings otherwise.

---

## 12. Instrument and kill criterion

The morning council attached a metric, the measurement came back at
+0.03, and v1 dropped the metric rather than the plan. That is the
structural tell David reacted to. Reinstated in the only form the data
supports (there is NO intake record in the app; the in-app check-in was
deliberately retired 2026-08-09; a computed-plate metric alone is a
tautology):

- **Engine fidelity, owned by David, automatic.** From the clamped
  multipliers: share of seats {hit within 5% | clamped | degenerate} plus
  median protein-density miss, over the live-tagged subset (pinned ids),
  with `synthMode` DERIVED live per table at instrument time, never read
  from frozen pots (Red Team N2: pots exist only on solved tables, a
  pot-based census measures a biased subset). Weekly one-line render in
  `app/views/system.js`, whose props must be threaded (plan, tables,
  bank, targetsById: Engineer N14, priced into 2b); aggregates persist to
  `households/<h>/instrument.json` (§10), because `pruneTables` deletes
  tables at exactly the soak length and the adoption gate would otherwise
  evaluate after its own evidence expired (re-review N11): **the gate
  reads the persisted weekly aggregates, and the soak is sized to the
  14-day retention window.** **Aggregate counts only, never per-seat, on
  any shared surface** (Lawyer: "2 of 4 clamped" is identifiable in a
  household of four; per-seat detail is David-only, off shared UI).
- Pre-launch: the **validation run** as `tools/validate-synth.mjs`,
  reading local `seed-data` plus a local private-data checkout (Engineer
  M8), all 107 x 4 seats, three counts printed; only the aggregate counts
  go in the commit message, never targets. Clamped more than a small
  minority = the clamps or normalization are wrong. Re-run on every clamp
  change.
- **Adoption, automatic:** `cookedAt` on tables (exists after §7.2's
  plumbing; v2's "is the serve step opened" had no data source, Engineer
  M6).
- **The verdict, owned by seat B.** One question, weekly, her profile
  only: "Did your plates feel right this week?", persistent leave-me-alone
  answer, stored in her own profile file, purgeable (Lawyer). She never
  finds a score of how she ate.
- **Outcome, outside the app:** her weight trend over six weeks, and David
  asking her once whether she is full.

**Kill criterion, with teeth: written into Crystal (Mise lane file) on
deploy-1 day. Puller: David. Date: 2026-11-15.** Criterion: seat B's
six-week weight trend, `cookedAt` adoption on tailored tables, engine
fidelity against §3's pre-registered ceiling. Any failing: transform off
by default (tags stay in data), app keeps pot line + serve step.
**Evidence rule (Loyalist): the drip finishes ~mid-October, so on
2026-11-15 the six-week trend may only have ~4 weeks of tailored eating
behind it. Insufficient evidence means EXTEND to the date that completes
six weeks, never kill: an ambiguous criterion at a kill gate must not
resolve as kill.**

---

## 13. Build order: two deploys and a drip (deploy 2 split honestly)

Replaces v1's nine serial eat-gated steps (could not finish) and the
teardown's parallel tracks (a scheduling fiction for one builder at
1h/weekday). Ledger re-priced v2's "one evening" honestly: the engine is
6-8 sessions, split on the fault line the design itself provides.

| When | What | Gate |
|---|---|---|
| **Evening 0 (any time before session 4, NOT blocking deploy 1)** | §3 GO/NO-GO on paper: thresholds written first, share query, ceiling, clamp-bind census | kills or confirms the ENGINE before any engine code |
| **Sessions 1-3** | **Deploy 1: the serve step** from stored-seat mass share (§7.1), `cookedAt` plumbing incl. its `materializeBrigade` carry-forward (§7.2, §10), the §8.2 seating closure + soft-tier synonym map, the §8.8 owner-device occasion sweep trigger, Today one line, stacked list deleted. Real scope, priced (v2's "Tue-Wed" ignored §1.9) | ship, then stop |
| **Deploy-1 day, 15 min** | Kill criterion into Crystal (§12); §15 public-repo scrub decisions to David | |
| **~2 weeks** | **The soak. Nothing lands.** Watch `cookedAt` on cooked tables; low adoption = the problem is the screen, no engine lands on top of it | adoption |
| **Sessions 4-9, two commits, both inert** | **Deploy 2a:** `synth.js` (solve §4.3, rung ladder, clamps/caps, PLATE_GRAMS, MACRO), the `seatServingsFor` raw accessor + `seats[].rawServings`, the `store.js` read change exposing `{data, sha, dirty}`, the `keyOf` export + §8.1 assert, all §6.2 + §4.3 tests, validation run. **Deploy 2b (days later):** the six §11 consumer fixes + frozen-pot machinery incl. carry-forward test (§10) + `targetsById` state map + SystemView prop threading + `instrument.json` + SCHEMAS.md. Both no-ops by rung 0 and solved-only freezing; inertness asserted at pot/list/ledger (§11); validation counts in the 2a commit message. Fix `docs/merge-invariant.test.js.txt` header to point at §8.1 (it cites v1's §7.1) | validation counts |
| **One hour, same week** | David classifies all 107 (assembly + plated-set part labels), ordered queue | |
| **Then, ~5/week** | **The drip:** tags written as dishes come up, solvable first, stove-confirmed once each. First tag also retires the AI tailor (§11.6). ~25 total | per-recipe flag, reversible forward |
| **2026-11-15** | Kill review fires | David pulls or extends |

**Out of scope, cut by council: cook rotation.** Zero correctness content,
real money exposure, moves the same subsystem deploy 2b moves. The
tap-a-name affordance ships with §9; default stays per-day. Revisit
~November as its own change, with these notes so it is not re-derived
wrong: per-slot index off a fixed constant array, never user-ordered
`brigade.slots` (two devices would disagree); gate any switch to weeks
with no `shoppedAt` (`buyerId` survives regeneration, `cookId` does not);
if fairness is the argument, balance cook-minutes (`totalTime` x
`SLOT_WEIGHT`), not meal counts.

---

## 14. Still open, David's decisions

- **§3 thresholds**: confirm/edit the two bars and the clamp-bind rate
  BEFORE evening 0's arithmetic.
- **The head's on-screen label** (Loyalist flagged this as an unflagged
  overrule): David said "Head of the Table"; the panel shipped the
  concept in the schema but banned the words from the UI ("<name>'s
  table") on taste grounds. The function is his ask; the label is his
  call. Say the word and it renders.
- **The NO-GO branch, accepted in advance or not** (Loyalist): if evening
  0 kills the engine, the serve step's mass-share carve becomes the
  permanent answer to "what does each person get," and a scalar carve of
  a shared pot is exactly the operation §0.1 exists to reject. Decide now
  whether that fallback is acceptable as an end state or whether a NO-GO
  reopens the architecture question instead of closing it.
- **Skip billing** (loop-2 C6): today a post-buy skip costs the cook
  (skipped seats are excluded from the ledger). Under §11.1 the skipped
  seat's named remainder is costed at mass share on SOLVED tables, so
  "skip mine" starts costing money on the ~25 tagged dishes and not the
  other ~80. Fairer, but a behavior change David should sign off on, and
  it could be extended to uniform tables for consistency.
- **§12 weekly question wording**, and whether it starts at deploy 2b or
  first tag.
- **Off-plan days** (unchanged from v1): show slot guidance, count
  nothing, streak breaks unless recorded; earned cheat day tabled.
- **Editable diet rules** (unchanged from v1): gluten-free is a different
  AXIS than vegan/vegetarian/pescatarian; needs its own field or "vegan +
  gluten-free" is unrepresentable.

## 15. Public-repo hygiene, pre-existing, surfaced by the Tribunal's Lawyer

RESOLVED 2026-08-10 evening, on David's order: git history was rewritten
with git-filter-repo. Every historical version of this document was
dropped from history (v1 carried a full personal health profile), the
dated medical-prep occasion id and its example block were genericized in
all blobs, and commit messages tying a procedure, a date, or hand-set
macro numbers to a family member were reworded. HEAD was sanitized in the
same pass (schema example, code comments, test fixtures) with all 531
tests green. A pre-rewrite mirror backup exists locally. Residual: GitHub
can retain unreachable old commits server-side until support is asked to
purge them; no forks exist. Practical profile ids (mom, dad, laurie) stay
by David's explicit ruling; the scrub targeted health data, not names.

---

## 16. The AI end-state, and what this build does NOW to be ready (David, 2026-08-10 evening)

David's stated end-state: the app runs with heavy integrated AI, served by
a local model on his 256 GB Mac Studio (80 GB-class open models, running
24/7), handling vision (receipts, fridge scans) AND meal curation/tables,
and the finished product never needs a Claude Code session again. This
build does not include that model; it must slot in cleanly when ready.

### 16.1 Two layers, and why the deterministic core survives his question

David asked whether determinism is the wrong call when he wants "the best
solution, which is like a heuristic problem." The answer is a split, not a
choice:

- **The arithmetic layer stays deterministic because it already IS the
  best-solution finder.** For two targets (calories, protein) the
  closed-form solve is the EXACT optimum, not an approximation a heuristic
  could beat. More targets later (satiety, fiber, fat caps) generalize to
  a small weighted least-squares with the same clamps: still milliseconds,
  still offline, still identical on every phone. A sampled model doing
  this arithmetic would be slower, occasionally wrong, and different per
  device, which is the v76 tailor's exact failure mode.
- **The judgment layer is where the AI lives, and it decides WHAT to
  optimize, never does the arithmetic:** choosing the week's dishes,
  proposing targets and weights, proposing `assembly`/`part` tags for
  David to confirm, natural-language requests ("make this week lighter"),
  and all vision. Everything it proposes flows through the deterministic
  screens and clamps before touching data. This is already the app's
  pattern (/dinnerweek proposes, code enforces) and it is precisely what
  makes a LOCAL model safe to swap in: a weaker model cannot break what
  the code floor enforces downstream.

§2's "no AI fallback" is unchanged and compatible: the model sits UPSTREAM
of the solve as a proposer, never downstream as a fallback for it.

### 16.2 The integration contract, built now

1. **One AI gateway.** BUILT 2026-08-10: `worker/src/provider.js`
   `callModel()` is the single seam every Worker model call routes
   through. Internally the contract stays Anthropic Messages shape end to
   end (requests from lib.js builders, responses as content blocks, so no
   downstream parser ever branches on provider); the gateway carries two
   adapters: native Anthropic (default, byte-identical to the old path)
   and an OpenAI-compatible chat-completions adapter (the contract
   Ollama, llama.cpp server, and LM Studio speak) that translates both
   directions at this one seam. Provider is env config: `AI_PROVIDER`,
   `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`. Swapping in the Mac Studio is
   a config change, zero code.
2. **The Mac reaches the Worker via a Cloudflare Tunnel** to the local
   inference server. The Worker keeps owning auth, rate limits, and
   response clamping; only its upstream URL changes. Phones never talk to
   the Mac directly.
3. **Vision goes through the same gateway** as image content parts.
   Local swap requires a vision-capable model (Qwen-VL class); until it
   is ready, the hosted provider stays, same contract.
4. **Every AI output stays a schema-validated PROPOSAL** (tool-call JSON,
   screened, clamped). No streaming dependency; single-shot tool calls
   only, since local servers vary on streaming.
5. **Autonomy roadmap (the "never comes back to Claude Code" list),
   post-engine:** editable diet rules (§14, already required), in-app
   recipe authoring/editing, tag editing on the head's card, AI-proposed
   recipes gated by the Greger-audit prompt + allergen screens, blank
   occasions (already shipped). Each removes one class of "needs a
   session."

### 16.3 Supabase: deferred, with reasons and a revisit trigger

Moving storage to Supabase (Postgres + realtime + auth) mid-plan is the
exact migration-as-procrastination echo the Historian flagged, and it
does not buy what it appears to: offline-first still requires a local
cache and a conflict policy even with realtime sync; the pain Supabase
would reduce (field-wise merge hazards) is ALREADY being reduced by this
plan's derive-don't-store model and single frozen artifact. What it would
cost: rewriting `store.js`, the merge layer, the two-repo privacy split,
and the PAT model, weeks of work for four users mid-semester. Ruling:
**defer; keep all GitHub-API specifics behind `store.js` (they already
are) so the door stays open; revisit as its own council** after the
engine ships, or sooner if the household count grows or realtime
multi-device editing becomes a felt pain rather than a theoretical one.

---
