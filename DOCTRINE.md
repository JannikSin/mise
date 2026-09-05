# Mise: the doctrine

> [!warning] **This is a v1 doctrine, and the standard moved on 2026-08-29.**
> Everything below is true and came out of this app's own history, so none of it is wasted. But the
> six-article shape was invented rather than researched, and the research (Amazon tenets, Nygard's
> Architecture Decision Records, design-doc non-goals) says these are **three documents, not one**.
> **What changes:** the prohibitions become *invariants* with a test named against each, the
> "settled" list becomes numbered decision records that can be marked *superseded* instead of
> silently going stale, the failure table becomes an incidents file, and the doctrine itself is
> capped at one page. **Awaiting David's review and go.** Standard: Crystal `System/App-Doctrine.md`.

**What this file is.** The governing principles of this app: what it is for, what
it will never do, which decisions are already settled, and how to tell a good
change from a bad one. `CLAUDE.md` says how to work here. Crystal
`Lanes/Mise-Core-Purpose.md` says what Mise promises, in twelve numbered promises
that the test suite enforces. **This says what is true regardless of the code**,
and it outranks `CLAUDE.md` where they disagree. It does not outrank the Core
Purpose, which remains the authority on the promises themselves.

Written 2026-08-28 (session **trinity**) under the standard David set that day:
*"we need that for every app now."* The shape is Crystal `System/App-Doctrine.md`.

**A session may not quietly overrule an article here.** Name the article, say why
its reason no longer holds, get David's named yes. An article whose reason has
genuinely expired gets struck, not worked around.

---

## Article 0. The job

**Mise ensures you hit your calorie and protein numbers, stay inside a dollar
budget, and waste as little food, money and time as possible, by creating your
week's meal plan out of food you genuinely enjoy eating and can cook.**

That sentence is copied verbatim from the Core Purpose and may not drift here.
The meal plan is the operative clause: **every saving Mise delivers, it delivers
by making that one plan the best plan possible.**

Underneath it sits the product thesis in David's own words: **take the choices
away.** Mise is not a kitchen tool that offers options. A screen that hands him a
decision he did not want to make has failed even when every number on it is right.

**The chain is one link deep and it is enforced:** every feature traces to a
numbered promise, every promise carries a done test, and
`tests/promises.test.js` fails the build when the document and the suite
disagree. **A change that serves no promise does not get built.** It goes to
Crystal `Lanes/Mise-Later.md`. David will keep having ideas out loud; saying an
idea is not commissioning it.

---

## Article 1. Who it is for, and the one behaviour it is built around

**No user is named in the design.** Mise is a general model that happens to work
perfectly for its first profile, not a personal tool others might borrow. It is
for people cooking for themselves for the first time, and it must fit any
household size, budget, target set and diet. **A feature that only works because
of a fact about David is a bug**, and the two-repo split exists so that this is
structurally true and not merely intended.

**The behaviour it must respect:** he does not confirm things in advance.
**0 of 228** cooked confirmations were ever recorded across eight plan files,
because `recipe.js` gated the button behind starting a stopwatch BEFORE cooking,
with no retroactive path. The same person produced **47** retroactive one-tap
ticks in Crystal over the same period. This is not a discoverability problem and
a nicer button does not fix it. **Every confirmation surface in Mise must be
one tap and valid after the fact.**

---

## Article 2. What Mise will never do

1. **Never put personal data in the public repo.** `mise` is code, `mise-data` is
   data and private. The app verifies the data repo's privacy at startup and
   shows a red banner if it is public. This is the one rule whose violation
   cannot be undone by a later commit.
2. **Never read data through Pages or raw.githubusercontent.** GitHub Contents
   API only, always with the file SHA on writes, and on a 409 re-fetch, merge
   field-wise, retry. The other routes serve stale caches and stale food data is
   wrong food data.
3. **Never ship a feature dark.** Anything behind a gate gets a date and an owner
   in the same commit. `app/lib/synth.js` was 804 tested lines gated on
   `assembly === "plated"`, a tag no recipe carried, inert from the day it
   merged. Running it for the first time found three bugs no test could catch,
   including a normalisation error dividing every solved plate by the serving
   count. **An engine that has never executed on real data has not been tested,
   however green its unit tests are.**
4. **Never call painting "working".** A screenshot proves paint, not that a user
   can act. The receipt ticks toggled state correctly for weeks while drawing an
   invisible tick on an unfilled box, so every tap looked like a no-op. Press the
   thing.
5. **Never ship a full-screen overlay without an escape that always renders.**
   The tour stranded the entire app because its END button lived inside a card
   that only rendered once a step's target was measured.
   `tests/overlays.test.js` enforces this. An overlay whose only exit is behind a
   conditional is a trap.
6. **Never add a tracker, an analytic, or a third-party script.** Strict CSP, and
   no new dependency without a stated justification David approves.
7. **Never freeze an estimate at plan time and present it later as current.** A
   live week credited a stale 550 kcal / 48 g per swipe because placeholders kept
   their plan-time estimate and nothing refreshed them.
8. **Never fix his data behind the scenes.** Ship the button so a stranger could
   do it from the UI. Backstage edits make the app look like it works when it
   does not.

---

## Article 3. Settled. Do not re-litigate

- **The locked week is abolished** (David, 2026-08-18). Shopping locks the
  **ingredients** and stores the plan as a fallback; **the plan itself stays
  changeable**, so long as every bought perishable is used before it dies. Do not
  reintroduce a frozen week in the name of consistency.
- **Protein is 190 g and carbohydrate 510 g**, ratified 2026-08-26 after the
  protein-architecture council. **210 g and the 185 g floor are retired tokens**
  and must not reappear anywhere in either repo. An automation running on a
  number below the plan's own floor is how this was found.
- **Promise numbering is P1 numbers, P2 decided, P3 knows-you, P4 store,
  P5 budget, P6 pantry, P7 time, P8 plates, P9 good-cook, P10 eat-anywhere,
  P11 review, P12 bank.** Numbering changed twice on 2026-08-18; the decoder for
  older notes is at the top of Crystal `Lanes/Mise-Fix-List.md`. Do not renumber.
- **A promise's status line changes in the SAME commit as the code.** Three legal
  states, machine-parsed. A promise may not be marked proven by a test that only
  reads source text; it has to exercise the behaviour. A source-scan assertion is
  a spelling check, not a behaviour check.
- **The service worker deletes only `mise-` prefixed caches.** Mise evicted
  Tally, Finesse, Bonmot, Grandstand and aimap's shells on every deploy for 22
  days, and was the last app still doing it. Fixed 2026-08-18. The filter stays.
- **Counted produce reconciles as PIECES vs BUNDLES before any cart push**, and
  pickup produce biases small quantities bought often. A banana line became three
  bundles when one covered the need, and pickup shoppers select ripe, so a week
  of bananas arrives all-yellow.
- **Ship batched.** Several pushes in quick succession each bump the service
  worker shell and make it churn on a phone.

---

## Article 4. How to tell a good change from a bad one

In order. A change failing any of these is not ready, whatever the suite says.

1. **Which promise number does it serve?** If the answer is none, it is a
   `Mise-Later` item, not a change.
2. **Does it take a choice away, or add one?** Article 0.
3. **Would it still work for a household that is not his?** Article 1.
4. **Did you press it in the running app on a phone-sized surface?** Not a
   screenshot, not a DOM dump. "I watched it work" is the standard; "code looks
   right" is not verification.
5. **Did you push, and then verify the live host?** Pages serves `origin/main`.
   Until you push, nothing you built exists for David or his family. **"Not
   pushed yet" is not a status line, it is unfinished work.**
6. **If it produces words for him to read, is the short version on top?** His
   reading is the scarce resource across this whole setup, not compute.

---

## Article 5. The failure modes this app is armed against

Only incidents that actually happened.

| Failure | What happened | The armour |
|---|---|---|
| A feature merged dark | `synth.js`, 804 lines, inert until 2026-08-19 | No feature ships dark: date and owner in the same commit |
| Paint mistaken for function | receipt ticks, invisible tick, weeks | Press the thing; Article 4 test 4 |
| Overlay with no escape | the tour stranded the whole app | `tests/overlays.test.js` |
| A stale estimate presented as live | 550 kcal / 48 g per swipe | Re-derive, never freeze |
| Sibling cache eviction | 5 apps, 22 days | `mise-` prefix filter in `sw.js` |
| A document and a suite disagreeing | promise ledger drift | `tests/promises.test.js` fails the build |
| A number nobody propagated | 210 g protein live in 5 places 5 days after 190 was wired | Status line and code in the same commit |

---

## Article 6. Kill conditions

**PROPOSED, not adopted. Needs David's named yes.**

Mise is the most-built app in the portfolio and therefore the one most able to
keep being worked on past the point of being used. Review **2026-12-18**, with
the fall term. Mise has failed at Article 0, and the honest response is to shrink
it rather than extend it, if by then:

- **fewer than 8 of the last 12 weeks had a generated plan he actually shopped
  from**, meaning the plan is not the operative clause any more; or
- the **cooked-confirmation rate is still effectively zero** after the retroactive
  one-tap path exists, meaning Act III is a promise the app cannot keep; or
- **any promise has sat 🔴 NOT BUILT for a full semester**, meaning the ledger has
  become paperwork rather than a gate.

---

## The one open item this doctrine will not paper over

**Mise still runs on the paid Anthropic key.** `provider.js` supports
`LOCAL_BASE_URL` but no wrangler config sets it, so **family health and dietary
data still leaves the house**, against the 2026-07-20 council. The blocker is the
Cloudflare Tunnel. Runbook: Crystal `AI/Weekend-Mise-Local.md`. This is recorded
here rather than in a fix list because it is a standing violation of a council
ruling, not a bug.

---

*Companion documents: `CLAUDE.md` (how to work here), Crystal
`Lanes/Mise-Core-Purpose.md` (the twelve promises, canonical),
`docs/OPERATORS_MANUAL.md` (architecture and procedure), Crystal
`System/App-Doctrine.md` (this shape, for the other apps).*
