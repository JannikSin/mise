# 0018. A simpler surface: the engine stays quiet, Table becomes People

- **Status:** accepted; amended by 0019 (2026-10-18): the cart button and the re-roll are back
- **Date:** 2026-10-16
- **Deciders:** David (his Mise notes, 2026-10-16 evening); built by session bagel
- **Tenet invoked:** 1 (choices removed), and "a short list used every week beats a long list that could be used"

## Context

David's notes after looking at the blind rebuild: "it didn't show me things that I didn't need
to see". The Plan tab opened on the engine's reports (shared meals set, assumptions, "this week
shares, no overlap found", the generation manifest), several of which an engine audit the same
night found false on a shared-kitchen week (the manifest counted none of the shared meals, the
leftover ledger and the Sunday prep block were blind to brigade pots). The List carried house
money and the Kroger cart machinery; the Table tab listed every meal of the week; Settings held
houses, repo switching and test buttons. He also set a new dinner cadence: Friday cooks for
Friday and Saturday, Sunday cooks two dinners (one for Sunday and Monday, one for Tuesday to
Thursday). That cadence is a setting (cook nights Sun and Fri, Sunday batch for Tue Wed Thu),
not a build.

## Decision

- **Plan** shows the week and its meals. The engine's reports fold under "how this week was
  built" at the bottom. A meal swipe reads as a meal ("Meal swipe", the tray picker when
  opened), never "eating out". Every meal today or earlier has ATE IT. No smoothie slot.
- **List** shows the store picker, the total, and the budget as "a person a week" with his share
  of the trip. One heading per aisle; staple rows carry a stock-up tag.
- **People** replaces Table: households and their people, add anyone to a dinner (the next seven),
  link a roommate, invite by link. The kitchen rule (who cooks, which nights, the Sunday batch)
  is edited there; SET MY WEEK on Plan is the one button that plans.
- **Settings** keeps profile, meals, budget, buy day, kitchen, sync, token, export; the rest
  folds under More.
- **Parked** (code, routes and tests stay; doors close; return dates in Crystal
  `Lanes/Mise-Later`): house money, the Kroger cart buttons, the re-roll, recipe browsing, the
  dinner chat, the tour, the Table tab's per-meal week.

This amends 0016, which kept the cart: its live prices still price the list after BUILD; only
the buttons are parked.

## Consequences

Fewer things to read and press. What gets worse: the engine's honesty lines are one tap away
instead of in view, so a short day shows only as SHORT on its row; house money stops being
recorded until it is unparked.
