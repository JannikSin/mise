# Mise: the doctrine

One page, by amendment only. What Mise is for, what it deliberately is not, how a tie is
broken, and what must never happen. The twelve promises live in Crystal
`Lanes/Mise-Core-Purpose` (the goals document, machine-checked by `tests/promises.test.js`).
Settled choices live in `docs/decisions/`, one file each with a status. What has gone wrong
lives in `docs/incidents.md`. How to work here is `CLAUDE.md`. Shape: Crystal
`System/App-Doctrine` (v2). Split from the v1 six-article form on 2026-09-21.

## The job

**Mise ensures you hit your calorie and protein numbers, stay inside a dollar budget, and
waste as little food, money and time as possible, by creating your week's meal plan out of
food you genuinely enjoy eating and can cook.** Every saving Mise delivers, it delivers by
making that one plan the best plan possible. A feature must be able to lose to this sentence.

## Non-goals

- **Browsing.** Mise is not a cookbook to leaf through or a menu of options to pick from.
- **Logging what you ate.** It confirms the plan after the fact in one tap; it never asks
  you to record a meal it did not plan.
- **Training, supplements and the daily routine.** Anvil owns them (decision 0012). Mise
  reads body weight from the shared profile and writes no routine row of its own.
- **Planning for people who are not coming.** A guest exists in the plan only once invited,
  and only as portions on a meal already planned (decision 0014).
- **Nutrition science.** Targets and philosophies come from outside (the councils, the
  audited bank, named sources); Mise applies them, it does not argue them.

## Tenets, in order, unless you know better ones

Amended 2026-10-12 on David's approval (decision 0015). The order breaks ties.

1. **Choices are removed, and what remains is verified.** Every plan, recipe and nutrition
   rule is checked against the person's targets, budget, kitchen and time, and traces to a
   named source, before it is shown. When a constraint cannot be met, the plan says so.
   This costs variety and the freedom to pick.
2. **Flavour from a few plain ingredients.** A recipe earns its place by tasting good with a
   short list of ordinary groceries. This costs elaborate dishes and specialty items.
3. **Buy whole, use completely.** The week is built on shared ingredients so that every
   package bought is finished before it spoils. This costs variety across the week.
4. **Cook once, eat several times.** Batch cooking is the default, and effort and time are
   spent as carefully as money. This costs freshness and day-to-day variety.
5. **Decided at the start of the week.** Planning and buying happen once; during the week
   the app serves recipes, and any change is one the person starts. This costs mid-week
   spontaneity.
6. **Priced and ready to buy.** A week is finished only when every item is priced at the
   person's store and loaded into the cart. This costs stores without a price feed.
7. **Fitted to the person.** A thorough profile, filled in once, drives every plan; depth of
   fit outranks fast onboarding. This costs setup time.

~~1. Take the choices away. 2. The bought week is never disturbed. 3. One tap, after the
fact. 4. Real data before green tests. 5. A stranger could do it from the screen. 6. His
reading is the scarce resource.~~ Superseded 2026-10-12 by the seven above (decision 0015).
Tenets 2 and 3 of the old set live on as invariants; 4 and 5 are in `CLAUDE.md`; 6 is a
house rule for sessions, not a property of the app.

## Invariants

Absolute, testable, each with its cause and the thing that enforces it.

| Invariant | Cause | Enforced by |
|---|---|---|
| No personal data in the public repo | decision 0001; a Pages site is public | `tests/data-repo-allowlist.test.js`; the startup privacy probe and red banner; gitignored planning set |
| Data moves only through the Contents API, SHA on every write, field-wise merge on 409 | stale caches are wrong food (0002) | `app/lib/github.js` is the one chokepoint; `tests/sync.test.js`, `tests/merge.test.js` |
| No feature ships dark: a gate carries a date and an owner in the same commit | `synth.js`, 804 lines inert (incidents) | `tests/promises.test.js` prints every gap with its owner |
| A promise's status line changes in the same commit as its code | 210 g live in five places (incidents) | `tests/promises.test.js` fails the build on disagreement |
| Every full-screen overlay has an escape that always renders | the tour stranded the app (incidents) | `tests/overlays.test.js` |
| No tracker, analytic or third-party script | the strict CSP; no dependency without David's stated yes | the CSP in `index.html`; `tests/manifest.test.js` |
| The service worker deletes only `mise-` caches | 22 days of sibling eviction (0006) | the filter in `sw.js`; no test yet |
| An estimate is never frozen at plan time and shown later as current | 550 kcal per swipe credited for a week (incidents) | re-derivation in `plan.js`; no test yet |
| `main` is written only by the release or a named hotfix, and the deploy ships an allowlist | seven shells in one evening (0008) | `tools/release.ps1` refuses without a `ship/` tag; `tools/sandbox-deploy.ps1` copies the shell set only |
| An invited guest adds portions to the batch already planned for that day; a guest never adds a separate meal and never appears uninvited | David's ruling, 2026-10-12 (decision 0014) | not yet; owed by the redo, gate register `P8 GAP` |
| One profile per person; each app writes only its own section (base, food, training) | two apps writing one number: 210 g against 190 g (decision 0013) | not yet; owed by the redo, gate register `P3 GAP` |
| Every confirmation is valid after the fact | the cooked tap sat behind a stopwatch (incidents) | the Plan-row tap; `tests/promises.test.js` P7 |
| A release changes code only; no release step writes a plan, a list or a household file | the bought week (0008) | `tools/release.ps1` touches no data path; the re-seed writes the `sandbox` branch only |

## Amending this doctrine

**The job, the non-goals and the invariants change only by amendment.** An amendment names
the clause, states the reason the clause exists, states why that reason no longer holds, and
carries **David's named yes**. A superseded clause is **struck through and kept**, with the
date and what replaced it. It is never deleted, because the next person to propose the same
change needs to find the argument that was already had.

**Tenets are open season, by design.** They end with *unless you know better ones*.
Proposing a better tenet is not a challenge to the doctrine, it is the doctrine working. A
tenet still needs David's yes to change, but it does not need an incident.

**Invariants retire only when their cause is gone**, never because they are inconvenient. If
the incident that created an invariant can no longer occur, say why, and strike it.

**A session may not work around a clause silently.** Doing so once means either the clause
was wrong or the work was wrong, and either way it gets said out loud.

**The kill conditions are not amendable by a session at all.** Only David changes those.

## Kill conditions (PROPOSED 2026-08-28, not adopted; David's named yes required)

Review **2026-12-18**, with the fall term. Mise has failed at the job, and the honest
response is to shrink it rather than extend it, if by then:

- fewer than **8 of the last 12 weeks** had a generated plan he actually shopped from; or
- the **cooked-confirmation rate is still effectively zero** after a one-tap retroactive
  path exists (measured 2026-09-21: 2 confirmations across 27 plan files; the Plan-row tap
  shipped that day, so the clock on this condition starts now); or
- **any promise has sat 🔴 NOT BUILT for a full semester.**

The first condition cannot yet be measured by the app's own data (`shoppedAt` appears in 2
plan files); until it can, it is judged from receipts.
