# 0016. The 2026-10-12 audit: what is kept, parked and cut

- **Status:** accepted
- **Date:** 2026-10-12
- **Deciders:** David; audit by sessions tweener and wallfacer (independent, then compared)
- **Tenet invoked:** 1 (choices removed) and decision 0012

## Context

A 78-part audit graded every feature on evidence of use: 31 keep, 38 park, 10 cut. The app
had written no data since 2026-10-04, one cooked confirmation and one shopped mark existed in
all its history, and the foods actually eaten were outside the bank.

## Options considered

- **Keep everything and fix adoption.** Nothing lost; the unused surface stays unused.
- **Cut to the bare meal loop.** Smallest app; loses features David names as wanted.
- **David rules each contested part.** Slower; every call has an owner.

## Decision

**Kept:** the automatic Kroger cart load, invites (working end to end first), chat on the
paddington model, dining-hall trays, receipt scanning, use-what's-left, and profiles.
**Parked**, each with a return date in Crystal `Lanes/Mise-Later`: menu scan, remedies,
occasions. **Cut:** the July test folders, the empty W51 plan, `fitness/workouts.json` and
`fitness/activities.json`. Each cut and each park is its own commit. P12's second nutrition
philosophy is fixed in code (`philosophy.js` wired as a profile data bundle), not parked.

## Consequences

The redo works on a smaller surface. What gets worse: parked features keep their code until
their return date, so the shell does not shrink right away.
