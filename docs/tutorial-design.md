# Guided Tour (Tutorial), Design v2 (post-council)

Date: 2026-07-21. Status: council-reviewed, staged plan below awaits David's go. Not yet built.

## Problem

Mise has accumulated real capability (generate/re-roll, pin, eating-out, lock,
buffer tally, batch prep, pantry subtraction, just-bought, profiles) and none
of it is discoverable. Nothing explains the buttons. A new profile (Mom) or
future-David-after-a-month has to rediscover the system by poking it.

## Council verdict (5 advisors, 5 anonymous peer reviews, chairman synthesis)

**Where the council agrees**
- The coach-mark overlay (dim backdrop, cutout on the real element, NEXT/BACK/SKIP) is the right mechanism versus screenshots or a sandbox: selectors either resolve against live markup or they visibly do not, nothing goes quietly stale the way a screenshot does.
- But not as one 22-step marathon. Unanimous: nobody finishes 22 taps, least of all Mom with one hand and something on the stove. Split into per-tab mini-tours (3 to 6 steps), each triggered on first visit to that tab.
- The static "what everything does" list rendered from the same step data is not the fallback, it is the first deliverable. It ships in an hour and captures half the value at zero risk.
- A selector-resolution test is mandatory, not optional: mount each view, assert every step's querySelector returns non-null. Without it, selector-keyed steps are a silent-breakage machine (rename one CSS class in an unrelated refactor and the tour dies with no signal).
- The single real iOS risk is scroll-locking under a fixed overlay (body overflow:hidden, then Safari restoring scroll position wrong on unlock). Spike that on the physical iPhone before writing overlay step one.
- Auto-offer once per install, not per profile.

**Where the council clashed**
- Build the overlay now versus defer: the Executor wants data file + static list shipped immediately and the overlay deferred until real-device testing; the Expansionist wants full v1. Resolved by staging (below).
- The Expansionist wanted TOUR_STEPS generalized into a hint/command-palette platform; everyone else called it scope creep. Concession kept because it is free: TOUR_STEPS is a plain exported array, importable elsewhere. Nothing else built for it.
- The First Principles advisor challenged the premise: several "steps" are really naming problems. A button that needs a tour card may just need a better label. Phase 1 includes a label sweep before any overlay exists.

**Blind spots only the peer-review round caught**
- No measurement: without it every argument about step count is guesswork. Fix is trivial and local: a localStorage counter recording the last step reached per tour, so a later session can see where people actually bail.
- Interruption: a PWA gets backgrounded mid-tour (call, force-quit). Per-tab mini-tours mostly dissolve this; remaining rule is resume-at-step from the same localStorage record.
- Maintenance ownership: who updates steps when views change? Answer: the selector test IS the enforcement; a view change that breaks a step breaks CI.

## Staged plan v2

**Phase 1, ship first (low risk, ~1 session):**
1. `app/lib/tour.js`: exported `TOUR_STEPS` array `{ tab, selector, title, text, gate? }`, grouped by tab. Content covers every button and capability (the full inventory from v1's step list).
2. SYS gains a "what everything does" section rendered from `TOUR_STEPS`, grouped by tab. This is the manual; it cannot drift from the tour because it IS the tour data.
3. Label sweep: any control whose tour text is just a decoded name (e.g. what "P+" means) gets the fix applied to the control itself instead of a tour card.
4. Test: for each view, mount with fixture data and assert every step selector resolves.

**Phase 2, per-tab mini-tours (after a real-iPhone scroll-lock spike):**
1. `app/views/tour.js` overlay: cutout via getBoundingClientRect, recompute on resize/scroll, card never covers target, 44px buttons, auto-skip on missing element after mount.
2. Trigger: first visit to each tab offers that tab's 3-6 step mini-tour (dismiss = never again for that tab). Replay-per-tab rows in SYS.
3. `localStorage["mise:tour"]`: per-tab state `{ done, lastStep }` for resume and bail-point measurement.
4. Overlay steps only for genuinely spatial things (drop zones, pin, OUT, lock, buffer tile, batch block); everything else lives in the Phase 1 list only.

## Constraints (unchanged)

Zero new dependencies; vendored Preact + htm; strict CSP; mobile-first; tour
is read-only (points at buttons, never presses them); works offline; no
schema changes, no data-repo writes.
