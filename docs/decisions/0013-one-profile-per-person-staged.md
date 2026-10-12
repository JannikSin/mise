# 0013. One profile per person, in three stages, each app writing only its own section

- **Status:** accepted
- **Date:** 2026-10-12
- **Deciders:** David (chose option A); session tweener
- **Tenet invoked:** 7 (fitted to the person)

## Context

Mise and Anvil each hold part of one person's goal: Mise the targets and the food, Anvil the
training. Body weight already sits in one shared file. Targets are edited by hand in two
mirrored files (`profile/targets.json`, `fitness/targets.json`), and the pair has diverged
twice. A Mise user who never trains must not be asked training questions.

## Options considered

- **A. One profile per person, staged: base, food, training.** One source of truth; each app
  edits its own section from its own Settings.
- **B. Separate profiles per app, kept in sync.** Each app stays independent; every shared
  field becomes a sync problem, which is the failure already seen twice.
- **C. Mise owns the whole profile and Anvil reads it.** Simple ownership; training settings
  would be edited inside the food app.

## Decision

Option A. **Base** (name, body numbers, the goal and its date, the weekly schedule) is filled
in by everyone, in whichever app they start in. **Food** (targets, diet, allergies, kitchen,
store, budget, make-ahead needs) is Mise's. **Training** (strength goals, gym days, session
length, routine, supplements, reminders) is Anvil's and is never required of a Mise user.
Targets are set from Mise's Settings; hand edits of the mirrored targets pair end.

## Consequences

The mirrored-targets divergence cannot recur once the profile is the only writer. Both apps
need a profile reader and a Settings section, which is redo work (Core Purpose P3 gap). What
gets worse: the private data repo gains a file both apps depend on, so a schema change there
is a change to two apps at once.
