# 0003. Shopping locks the ingredients, never the plan

- **Status:** accepted (supersedes the July "locked week", which predates this log)
- **Date:** 2026-08-18
- **Deciders:** David
- **Tenet invoked:** take the choices away, but never the food

## Context

The July build froze a week once its list was bought: GENERATE and RE-ROLL refused to
run and every edit asked first. The reasoning was consistency between what was bought and
what was cooked. In use it made the plan brittle: a change of appetite or a guest on a
Wednesday met a wall, and the bought perishables were the thing that actually needed
protecting, not the arrangement of dinners.

## Options considered

- **Keep the lock.** Consistent by construction; every midweek change is a fight.
- **No protection at all.** Flexible; bought perishables can die unplanned.
- **Lock the ingredients, store the plan as a fallback, keep the plan changeable so long
  as every bought perishable is used before it dies.** The coverage banner replaces the
  lock as the guard.

## Decision

The locked week is abolished. Shopping locks the INGREDIENTS and stores the plan as a
fallback; SWITCH and re-plans work after shopping; the coverage check warns when a bought
perishable would go unused.

## Consequences

The week bends around real life. RESTORE FALLBACK exists for the case where a re-plan
went wrong.

**What gets worse:** consistency between list and plan is now a guard, not a guarantee;
a re-plan can strand a bought ingredient if the coverage banner is ignored.
