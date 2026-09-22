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
- **A frozen week.** Consistency between list and plan is a guard, not a lock (decision 0003).
- **Being David's app.** It is a general model that happens to fit its first household;
  a feature that needs a fact about him is a bug.
- **Nutrition science.** Targets and philosophies come from outside (the councils, the
  audited bank); Mise applies them, it does not argue them.

## Tenets, in order, unless you know better ones

1. **Take the choices away.** A screen that hands you a decision you did not want has
   failed, even when every number on it is right. This costs flexibility on purpose.
2. **The bought week is never disturbed.** Work in progress waits for Sunday or rides the
   sandbox; a fix that cannot wait is a named hotfix. This costs immediacy.
3. **One tap, after the fact.** Nothing asks to be started first; every confirmation is
   valid days later. This costs precision (a stopwatch would know more, and is never pressed).
4. **Real data before green tests.** An engine that has never run on the kitchen's own
   data is untested, however green the suite. This costs speed.
5. **A stranger could do it from the screen.** Never fix his data backstage; ship the
   button. This costs the quick edit.
6. **His reading is the scarce resource.** The short version on top, always. This costs
   completeness.

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
