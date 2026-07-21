# Guided Tour (Tutorial), Design v3

Date: 2026-07-21. Status: SHIPPED (commits c284c21 + e83d6d7). Council-reviewed,
reshaped by David's call (see Phase 1 below): ONE tour, offered once at a
profile's first login, replayable from SYS, nothing living on the individual
pages. Built, reviewer-fixed (2 code + 6 UI findings), live-verified in
Chrome. Outstanding: a run-through on David's physical iPhone (scroll
behavior under the overlay is intercepted touchmove, believed iOS-safe, but
the council's rule stands: watch it on the real phone).

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

## David's call (2026-07-21, supersedes the council's per-tab trigger)

A tour is a first-week thing, not a living UI feature. So: no per-page
triggers, no per-tab first-visit offers, no "?" buttons taking up space.
Exactly two entry points:

1. **First login of a new profile** on a device: one offer, take it or
   dismiss it, never asked again.
2. **A "replay tour" row in SYS** for whenever you want it back.

The council's mechanics survive (selector test, resume, bail-point counter,
iPhone scroll-lock spike, static list as free by-product); only the
trigger model changed.

## Phase 1 (drafted, awaiting go)

**One linear tour, ~16 steps, target under 2 minutes.** Walks every tab in
living order: Cook, Plan, List, Train, Home, SYS.

### Entry points

- After the profile gate resolves on a device where
  `localStorage["mise.tour.<profileId>"]` is unset: a small offer card over
  the Home view. "New here? 2-minute tour of every button." TAKE THE TOUR /
  SKIP. Either answer writes the key; the offer never repeats. New profile
  via onboarding counts as first login (survey first, then the offer, so
  the tour points at a real week, not an empty shell).
- SYS row "replay the tour", always available, reruns from step 1.

### State

`localStorage["mise.tour.<profileId>"] = { status: "skipped" | "done" | "bailed", lastStep: n }`.
Device-local like other UI state, no data-repo writes. `lastStep` doubles as
the bail-point measurement the council asked for: SYS shows it quietly under
the replay row ("last run reached step 9 of 16"), so we learn where real
users give up before arguing about step counts.
Interruption (backgrounded PWA, phone call): reopening the app with a tour
`status` unset-but-`lastStep`-present offers RESUME at that step, once.

### The 16 steps (v1 content, exact list)

Format per step: highlighted element, one title, one or two sentences max.

COOK (1) today's meal rows: tap one to open its recipe, portions already
scaled. (2) day pager arrows: flip ahead to pre-cook tomorrow. (3) buffer
card: the week's batch-prepped "still hungry" answer, tally portions here.
(4) batch-prep block: what to cook ahead and when, day-aware.
PLAN (5) GENERATE MY WEEK: one tap plans the whole week around your targets;
tap again to re-roll. Mid-week it only replans the days you haven't eaten.
(6) build report tile: what the week shares, what to watch. (7) drag tray:
drag any recipe into any slot; chips filter by meal. (8) PIN: locks an entry
so generate never replaces it. (9) 🍴 OUT: eating out; nothing shopped,
macros credited honestly. (10) past days: dimmed and marked eaten, the app
never rewrites history.
LIST (11) BUILD LIST: turns the week into a priced grocery list, minus what
your pantry already has. (12) JUST BOUGHT and P+: checked items flow into
the pantry; P+ says "I already own this". (13) trips: fresh vs pantry
split, store picker prices the trip.
TRAIN (14) today's workout + the interval timer.
HOME (15) morning check-in: weight, energy, the day's plan at a glance.
SYS (16) token, profiles, household, export, and this tour again, ends
pointing at the replay row it lives under.

Steps auto-skip when their element is absent (empty week, no token yet):
skip silently forward, never a floating card at (0,0).

### Mechanics (unchanged from v2)

- `app/lib/tour.js`: exported `TOUR_STEPS` `{ route, selector, title, text }`
  plain data, importable elsewhere.
- `app/views/tour.js`: overlay with backdrop + cutout via
  getBoundingClientRect, recompute on resize/scroll, scroll target into view
  first. Card placement picks whichever side of the target has room for a
  full card; a tall target with room on neither side pins the card to the
  bottom edge and clips the cutout so they never intersect. 44px NEXT /
  BACK / END TOUR (END parked far left, away from thumbs), progress count,
  focus follows the card each step (announces steps, traps Tab, Escape
  bails). Route changes via location.hash, measure after mount, auto-skip
  on missing element (forward skip off the end = done; backward skip off
  the front = bailed, never a fake "done").
- SYS also renders the static "what everything does" list from the same
  TOUR_STEPS data (free manual, cannot drift).
- Test: mount each view with fixtures, assert every selector resolves.
- Zero deps, strict CSP, offline-fine, read-only (points at buttons, never
  presses them).

### Build order

1. iPhone scroll-lock spike FIRST (the council's one hard risk): fixed
   backdrop + body scroll lock + unlock, on the real phone, before any step
   content exists.
2. TOUR_STEPS data + SYS static list + selector test.
3. Overlay + offer card + SYS replay row.
4. Playwright walkthrough + live iPhone run-through of all 16 steps.

## Phase 2 (parked, only if Phase 1 proves insufficient)

Label sweep for controls whose tour text is just a decoded name; contextual
one-line hints for genuinely confusing moments. Nothing else planned.

## Constraints (unchanged)

Zero new dependencies; vendored Preact + htm; strict CSP; mobile-first; tour
is read-only (points at buttons, never presses them); works offline; no
schema changes, no data-repo writes.
