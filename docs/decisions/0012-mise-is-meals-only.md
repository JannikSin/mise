# 0012. Mise is meals only; Anvil owns training, supplements and the daily routine

- **Status:** accepted
- **Date:** 2026-10-12
- **Deciders:** David (session tweener)
- **Tenet invoked:** none

## Context

The 2026-10-12 audit found Mise carrying work that is not food: supplement and water ticks
on the shared daily row, and two workout files (`fitness/workouts.json`,
`fitness/activities.json`) that Anvil replaced. The Crystal brief, Mise and Anvil can all
offer the same routine ticks, so one row has several places to be ticked. David's ruling:
Mise is meals only, and Anvil owns the supplements and the daily routine.

## Options considered

- **Keep the routine ticks in Mise.** No migration; two apps keep competing for one habit,
  and Mise's job sentence stays diluted.
- **Move every routine tick to Anvil; Mise keeps meals only.** One tick surface; the writer
  of the `supplements` field migrates, and Mise loses a daily open.

## Decision

Mise plans, buys and cooks meals. Supplements, water, the morning and evening routine and
every training record belong to Anvil. The shared `fitness/daily.json` row stays, written by
shallow field patch; Mise stops writing its routine fields once Anvil's routine card ships.
The two workout files are cut (decision 0016).

## Consequences

Mise's screens get smaller and its job sentence is the whole app. Anvil gains a routine card
and the reminders that go with it (Anvil decisions 0003 and 0004). What gets worse: Mise
loses its daily reason to be opened, so the cook-night reminders carry more weight.
