# 0005. Twelve numbered promises, and a promise's status changes in the same commit as its code

- **Status:** accepted
- **Date:** 2026-08-18 (numbering fixed), 2026-08-19 (the ledger test)
- **Deciders:** David, session koenig
- **Tenet invoked:** real data before green tests

## Context

The Core Purpose note holds twelve promises in four acts. Their numbering changed twice
on 2026-08-18, so older notes disagree with newer ones; the decoder is at the top of
Crystal `Lanes/Mise-Fix-List`. Separately, features had been marked done while the
document said otherwise, and a document and a suite that disagree are two lies.

## Options considered

- **A checklist in the note, maintained by hand.** Drifts within a week; already had.
- **A test that parses the note's `**Status:**` lines and fails the build when the
  document and the suite disagree**, with three legal states and a named owner on every
  gap.

## Decision

Numbering is fixed at P1 numbers, P2 decided, P3 knows-you, P4 store, P5 budget, P6
pantry, P7 time, P8 plates, P9 good-cook, P10 eat-anywhere, P11 review, P12 bank. Never
renumber. `tests/promises.test.js` is the gate; a promise may not be marked proven by a
test that only reads source text; every gap prints a `todo` with an owner; the status
line changes in the SAME commit as the code.

## Consequences

The ledger is the gate register, and it prints on every run (11 proven, 1 partial on
2026-09-21).

**What gets worse:** the Core Purpose note is now load-bearing for the build, so a stray
edit in Obsidian can fail the suite; and a promise's wording cannot be tidied without a
commit in the repo.
