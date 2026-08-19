# CLAUDE.md — Mise

> **READ FIRST, EVERY SESSION: `C:\Users\DATar\Sanity\Obsidian\Crystal\Lanes\Mise-Core-Purpose.md`.**
> It is the authority on what this app is for. It carries twelve numbered promises in four acts (Plan, Buy,
> Cook, Adapt) and a done test for each. Numbering changed TWICE on 2026-08-18; the decoder for older notes
> is at the top of `Crystal\Lanes\Mise-Fix-List.md`. Current: P1 numbers, P2 decided, P3 knows-you, P4 store,
> P5 budget, P6 pantry, P7 time, P8 plates, P9 good-cook, P10 eat-anywhere, P11 review, P12 bank.
> **The locked week is abolished (David, 2026-08-18): shopping locks the INGREDIENTS and stores the plan as
> a fallback; the plan itself stays changeable so long as every bought perishable is used before it dies.**
> **Every change must name the promise number it serves.** A change that serves no promise does not get
> built; it goes to `Crystal\Lanes\Mise-Later.md`. David will keep having ideas and saying them out loud.
> Saying an idea is not commissioning it. Park it and keep going.
> **No feature ships dark:** anything built behind a gate gets a date and an owner in the same commit.
> The standing example of the failure is `app/lib/synth.js`, 804 tested lines wired into main.js, gated on
> `assembly === "plated"`, a tag no recipe in the bank carries, inert since the day it merged.
> **THE PROMISE LEDGER (2026-08-19, session koenig).** Every promise in the Core Purpose carries a
> `**Status:**` line under its done test, and `tests/promises.test.js` parses that file and fails the build
> when the document and the suite disagree. Three legal states: `✅ PROVEN > "<test>"`,
> `🟡 PARTIAL > "<test>" · GAP > "<todo>"`, `🔴 NOT BUILT · GAP > "<todo>"`. Rules that bind you:
> a promise may not be marked proven by a test that only reads source text, it has to exercise the
> behaviour; every gap is a printed `todo` with a NAMED OWNER, which is the gate register; and
> **when a promise's status changes, the status line changes in the SAME commit as the code.**
> Today: 1 proven, 10 partial, 1 not built. The suite prints that score on every run.

> **Crystal notice:** if this session shipped real work, also append a line to `C:\Users\DATar\Sanity\Obsidian\Crystal\System\Changelog.md` and a narrative + hot-list entry to `C:\Users\DATar\Sanity\Obsidian\Crystal\Accomplishments\Log.md` before ending. Crystal is David's personal assistant and the daily brief it narrates back to him only reflects what gets written there. See Crystal's `System/Lessons-Learned.md` L13.

> **Pickup lessons (David's first real curbside order, 2026-08-19):** the flow itself works
> (park, name the spot, they bring it out). Two standing corrections: (1) counted produce
> quantities must reconcile as PIECES vs BUNDLES before any cart push — his banana line became
> THREE bundles when one covers the need (rule 3.7 applies to every quantity, not just weights);
> (2) pickup shoppers select RIPE produce — bananas arrive all-yellow, so a pickup order's
> produce should bias small quantities bought often, never a week of bananas at once.

Project rules for every Claude session working on Mise. Read HANDOFF_CONTEXT.md and MISE_BLUEPRINT.md before your first change. **docs/OPERATORS_MANUAL.md is the full operator's guide** — architecture, procedures, environment gotchas, working method, and the Phase 2–5 extension map. Read it before your first non-trivial task.

## Part 1 — Coding Principles (Karpathy-derived)

Adapted from forrestchang/andrej-karpathy-skills (MIT). These bias toward caution over speed; use judgment on trivial fixes.

### 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Test: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes
Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes orphaned; leave pre-existing dead code alone.
- Test: every changed line traces directly to the user's request.

### 4. Goal-Driven Execution
Define success criteria. Loop until verified.
- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- For multi-step tasks, state a plan: `[Step] → verify: [check]` per step.

## Part 2 — Mise Architecture Rules (non-negotiable)

1. **Two-repo split.** `mise` (public, GitHub Pages) contains code only — never personal data. `mise-data` (private) holds all JSON data. Verify data-repo privacy at app startup; red banner if public.
2. **Data access** only via GitHub Contents API with the fine-grained PAT (scoped to mise-data, contents-only). Never read data through Pages URLs or raw.githubusercontent (cache staleness). Always pass the file SHA on writes; on 409 conflict: re-fetch, merge field-wise, retry.
3. **Offline-first.** Every view works from the IndexedDB cache; writes queue offline and flush on reconnect. The shopping list must work in a store with no signal.
4. **Small per-domain data files** (`pantry.json`, `plans/2026-W28.json`, …) to minimize write-conflict surface. Schemas live in `docs/SCHEMAS.md` — any schema change requires updating that doc in the same commit.
5. **No new dependencies without stated justification** the user approves. Prefer zero-build or minimal tooling. No trackers, no analytics, no third-party scripts (strict CSP).
6. **Mobile-first** (iPhone PWA is the primary surface), installable, big touch targets.
7. **Secrets:** PAT and API keys live only in browser localStorage / Worker env. Never in code, never committed. Hooks block edits to secret paths.
8. **User-facing philosophy:** recipes tagged by purpose (recovery / pre-activity / long-satiety / sick-day / everyday); cheap, high-protein, fast; staples + rotating dinners; Sunday batch + 15-min weeknight assembly.

## Part 3 — Mandatory Verification Pipeline

Every non-trivial change, in order:
1. Hooks: format + lint + typecheck fire on edit (fix immediately, don't accumulate).
2. Tests for the changed behavior run green.
3. Reviewer subagents (`code-reviewer`, `security-reviewer`, `ui-reviewer` in `.claude/agents/`) critique in parallel — before commit, not after.
4. Open the running app, exercise the feature, and confirm it. "Code looks right" is not verification; "I watched it work" is.
5. Commit with a clear message. Never force-push. Never commit directly to data files with real user data during development — use fixtures.
6. **PUSH, then verify the LIVE host.** Pages serves `origin/main`. Until you push, nothing you built exists for David or his family, and "not pushed yet" is not a status line, it is unfinished work. After pushing, curl the live files and confirm the deploy actually landed.

### Rendering is not working (learned the hard way, 2026-07-25/26)

Three separate times in one week a change "verified" as rendering was in fact
unusable. Screenshots and DOM dumps prove PAINT. They do not prove a user can
ACT. The checks that would have caught each:

- **Can a user act?** Press the thing. A screenshot of a button proves nothing
  about whether it responds. The receipt ticks toggled state correctly for
  weeks while drawing an invisible tick on an unfilled box, so every tap looked
  like a no-op.
- **Full-screen overlays must always carry an escape.** `tests/overlays.test.js`
  enforces this: any `position: fixed; inset: 0` layer that takes pointer
  events must be registered with the control that ALWAYS renders on it. The
  tour stranded the whole app because its END button lived inside the card, and
  the card only rendered once a step's target was measured. An overlay whose
  only exit is behind a conditional is a trap.
- **"Renders, scrolls, nothing responds" means an overlay or a throw, not a
  cache.** Scrolling is the compositor's job and keeps working when the main
  thread is wedged or a transparent layer is eating taps. Check for a
  full-screen element and for a render-time exception BEFORE blaming the
  service worker.
- **A source-scan test is not a runtime test.** `tests/tour.test.js` asserts
  each tour selector's class appears somewhere in view source. It passes for a
  selector that never renders for a given user's data. Treat source-scan
  assertions as spelling checks, not behaviour checks.
- **Batch deploys.** Several pushes in quick succession each bump the service
  worker shell and make it churn on a phone. Ship a coherent set, once.

For architecture-level decisions (new phase, schema redesign, dependency addition): run `council this:` first and show David the verdict.

## Part 4 — Working With David

- Settle strategy before executing. Never start building until he explicitly says go.
- When he asks "A or B?", give a direct call with one-sentence reasoning, then nuance if needed.
- He's a non-developer with strong product instincts — explain in outcomes, not jargon.
- Ask one focused question at a time, not question dumps.
