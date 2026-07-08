# Mise Operator's Manual

Written by Claude Fable 5 (July 2026), the model that built the Phase 1 backbone, for whichever model runs this machine next — Opus or whoever follows. Read this before touching anything. It covers what the machine is, how to operate it without breaking it, the working method that made the build succeed, and how the next four phases bolt on.

Companion documents: `CLAUDE.md` (the rules — binding), `MISE_BLUEPRINT.md` (the product vision and council verdict), `docs/BUILD_PLAN.md` (Phase 1 task ledger), `docs/SCHEMAS.md` (every data file's shape — keep it true), `worker/README.md` (Worker contract).

---

## 1. What this machine is

Mise is David's personal kitchen + fitness PWA. One user, one iPhone, zero budget, zero tolerance for data leaks. Everything follows from those four facts.

**The architecture in one paragraph:** a static, zero-build Preact app served from GitHub Pages (public repo `mise`, owner JannikSin) reads and writes all user data as small JSON files in a **private** repo (`mise-data`) through the GitHub Contents API, authenticated by a fine-grained PAT that lives only in the browser's localStorage. An IndexedDB layer caches every file and queues writes offline, so the whole app works in a store with no signal. A tiny Cloudflare Worker (`mise-worker.janniksin.workers.dev`) proxies two AI calls (fridge-photo scan, live remedies) using the same PAT as its auth credential. There is no server, no database, no build step, no dependency to rot.

**Load path:** `index.html` (strict CSP, inline import map pinned by sha256) → `app/main.js` (all state lives in the single `App` component; views get props + callbacks) → hash router (`#/plan`, `#/recipe/<id>`…) → views in `app/views/`, pure logic in `app/lib/`. `sw.js` precaches the shell: network-first for app code, cache-first for `vendor/` and `icons/`.

**Data path:** `app/lib/store.js` is the only door — `read`/`readCollection`/`write` → IndexedDB cache + offline write queue → `app/lib/github.js` (Contents API, always passes the file SHA; on 409 it re-fetches, merges field-wise via `app/lib/merge.js`, retries). Never read data any other way — Pages URLs and raw.githubusercontent serve stale caches.

**Domain logic** (all pure, all unit-tested): `plan.js` (week entries, `SLOT_KEYS`/`SLOT_META`, `dayTotals`, `recipesById`), `weekbuilder.js` (ingredient-overlap committee builder — protein shortfall is a red flag, David's #1 rule), `shopping.js` (plan → deduped list, `slug`, `sectionOf`), `fitness.js` (PRs, streaks, progression series), `remedies.js` (offline rules engine), `dates.js` (`localIsoDate`, `parseLocalIso`, `isoWeekId` — **the only place date strings are made or parsed; never hand-roll one**), `quiz.js`, `scan.js`, `drag.js` (pointer-events drag engine, INSTANT drag, locked by the Task 0 iPhone spike).

**Worker** (`worker/src/`): `lib.js` holds every pure piece (CORS allowlist, forced-tool Anthropic request builders, response validators, fixed-window rate limiter); `index.js` is the thin fetch handler (origin gate → PAT verified against the private repo with a 10-min token-hash cache → rate limit → size cap on actual bytes → Anthropic → validate → JSON out). `ANTHROPIC_API_KEY` is a Worker secret; endpoints return 503 until it's set.

## 2. The non-negotiables

These are in `CLAUDE.md`; the ones people break first:

1. **Two-repo split.** Code repo never contains personal data — not in fixtures, not in test output, not in a commit message. Development uses `fixtures/`, never real data files.
2. **Secrets exist in exactly two places:** browser localStorage (PAT) and Worker env (API key). A secret in a file in this repo is an incident, not a mistake.
3. **Schema changes update `docs/SCHEMAS.md` in the same commit.** The post-edit hook self-heals drift checks; the `schema-guard` agent runs pre-commit.
4. **No new dependencies.** The stack decision is LOCKED: vendored Preact + htm, JSDoc + tsc, no bundler ever. If you think you need a package, you need a justification David approves first.
5. **"Code looks right" is not verification.** You watch it work (Playwright E2E against the real app) or it isn't done.
6. **Never start building until David says go.** Settle strategy first, always.

## 3. Operating procedures

### 3.1 The dev loop

1. `.claude/hooks/post-edit.mjs` fires on every edit: Prettier, ESLint (flat config, hand-listed browser globals in `eslint.config.mjs` — add new globals there), `tsc -p jsconfig.json --checkJs` (strict + `noUncheckedIndexedAccess`), schema-drift check. Fix immediately; don't accumulate.
2. Tests: `node --test "tests/*.test.js"` — the glob is required; `node --test tests/` fails on this machine. Pure logic gets node:test coverage BEFORE implementation (red → green).
3. Review: small diff → one combined reviewer; new subsystem or anything token/data adjacent → full panel (`code-reviewer`, `security-reviewer`, `ui-reviewer` in `.claude/agents/`, run in parallel) — before commit, not after.
4. E2E: see 3.3.
5. Commit (see 3.5 for PowerShell traps), push, verify the Pages deploy (3.4).

### 3.2 Environment gotchas (Windows 11, this machine)

- **PowerShell 5.1**: no `&&` / `||` chaining; commit messages via single-quoted here-strings (`@'…'@`, closing `'@` at column 0). The working directory **persists across commands** — a failed `cd worker; …` chain strands every later command in `worker/`; always `Set-Location` back or use absolute paths.
- **Hook races on batched edits**: when several Edits to one file land in one message, the hook lints intermediate states — an "unused import" error from edit 1 that edit 3 resolves. Don't chase these; after the batch, run `npx eslint <files>` and `npx tsc -p jsconfig.json --noEmit` directly and trust only that. Also: eslint `--fix` can const-ify a `let` between your edits (`prefer-const`); if a variable must stay `let`, say why with an eslint-disable comment.
- **wrangler is non-interactive** here even when David runs it with `!`; prompts silently take the fallback. Anything needing interaction (subdomain registration, OAuth) goes through the Cloudflare dashboard.
- **Production deploys need David's explicit word** — the permission classifier blocks `wrangler deploy` and similar until he says deploy. Never try to extract wrangler's OAuth token to call the CF API directly; that's a credential-boundary violation and gets blocked.
- **Test fixtures that are images must be real images** — generate with System.Drawing, don't hand-type base64.

### 3.3 E2E harness (Playwright MCP)

- `tests/e2e/harness-prelude.js` mocks the GitHub Contents API in-page with real SHA semantics; pre-seed `repoFiles` (a Map of path → object) to stage any data state. **ASCII only** in harness files (it hand-rolls UTF-8 base64).
- Compose prelude + your scenario into `.playwright-mcp/<name>.js` with PowerShell (`Get-Content -Raw` both, concatenate, `Out-File -Encoding utf8`), then run via `mcp__playwright__browser_run_code_unsafe` with the filename.
- Local server: `Start-Process python -ArgumentList "-m","http.server","8378","--bind","127.0.0.1"` from repo root. **Stop it when done** (`Get-Process python | Stop-Process`). Port 8378 is in the Worker's CORS allowlist, so live-Worker tests also work locally.
- Verify by looking: screenshots, computed styles, element text — not by the absence of console errors.

### 3.4 Deploying the app

Push to `main` → GitHub Pages builds. Don't trust timing: nudge with `gh api repos/JannikSin/mise/pages/builds -X POST`, then poll `gh api repos/JannikSin/mise/pages/builds/latest` until its commit SHA equals your HEAD. Bump `CACHE_VERSION` in `sw.js` when vendor/icon files change (and as precache hygiene on any shipped batch); add every new app file to the `SHELL` list. If the inline import map ever changes, the CSP sha256 in `index.html` must be recomputed (the browser console prints the required hash).

### 3.5 Deploying the Worker

`cd worker; npx wrangler deploy` — but only David can authorize it (his `!` prompt or explicit "deploy"). Config in `worker/wrangler.toml` (account id committed, that's fine; secrets never). New env vars: secrets via dashboard or `wrangler secret put`; models via plain vars `SCAN_MODEL`/`REMEDY_MODEL`. After deploy, probe security from outside: no auth → 401, wrong origin → 403, OPTIONS → 204 with correct ACAO, unknown path → 404.

### 3.6 The weekly scheduled task

David runs a weekly Cowork scheduled task (claude.ai, GitHub connector authorized to both repos) that drafts next week's plan into `mise-data/plans/<week>.json`, adds 2–3 researched recipes, and flags low staples. The paste-ready prompt lives in `docs/WEEKLY_TASK_PROMPT.md`. If schemas change, update that prompt in the same commit — it encodes them.

## 4. The working method (what made this succeed)

David asked me to distill what makes Fable effective so the next model can run the machine the same way. It isn't intelligence; it's discipline applied in a specific order.

1. **Settle strategy before touching code.** Every task started as a proposal — options, one recommendation, one-sentence reasoning — and waited for "go". The costliest failures in any build are the ones where the model built the wrong thing fast. When David asks "A or B?", give the direct call first, nuance second.
2. **Define "done" as something observable.** Not "the code is written" but "the test that failed now passes, and I watched the feature work on the running app." Every task got a verify step before the work step. If you can't say what you'll observe when it works, you don't understand the task yet.
3. **Red before green.** Write the failing test first — it proves the test can fail, and it turns vague intent ("cap dinner repeats") into an executable spec. All pure logic in this repo has node:test coverage that was written failing.
4. **Proportional paranoia.** A one-line fix gets a direct lint+test check. A new subsystem, or anything touching tokens or user data, gets the full three-reviewer panel plus live security probes against the deployed endpoint. Review findings are work items, not commentary — fix before commit, every time. The reviewers caught real bugs every single round (rate limiting missing, spoofable content-length, data-loss on tab switch); assume yours will too.
5. **Chase errors to root cause; never pattern-match.** A hook error after a batched edit is usually stale — but you verify with a direct run, you don't assume. An E2E failure means the app is broken until proven otherwise (once it was the fixture: a hand-typed base64 PNG — and "verifying the error UI" became the actual test). The discipline is: no error is ignored, and no error is "fixed" without understanding why it happened.
6. **Grit is finishing the last 10%.** The difference between "works" and "shipped" here was always: sw.js SHELL updated, CACHE_VERSION bumped, SCHEMAS.md true, tests green, E2E watched, Pages build verified against HEAD, memory updated, server stopped. Make the checklist mechanical so completion doesn't depend on mood.
7. **Surgical diffs, simplicity first.** Touch only what the task requires. No abstractions for single-use code, no speculative flexibility. When something adjacent is broken, mention it — don't fix it silently. When 200 lines could be 50, rewrite before shipping, not "later".
8. **Trim the fat, keep the muscle.** Batch edits into single messages, read targeted line ranges instead of whole files, skip ceremony on trivial changes — but never skip security review, never skip tests, never skip watching it work. Efficiency is about cutting waste, not cutting verification.
9. **One canonical home for every fact.** Dates are made only in `dates.js`, slugs only in `shopping.js`, slot names only in `plan.js`, schemas only in `SCHEMAS.md`. When you find the same logic in two places, consolidate it the day you notice.
10. **Report faithfully.** Failures verbatim, skipped steps named, costs visible. David can handle bad news; he can't handle discovering it later.

## 5. Working with David

He's a non-developer with excellent product instincts — a college athlete building his own operating system for eating, training, and recovering. Explain in outcomes ("the list works with no signal in the store"), never jargon ("IndexedDB write queue"). Ask **one** focused question at a time. Give direct calls on A/B questions. His protein target is sacred: any generated week that misses it must scream (red flag), never whisper. He says "boil the ocean" when he wants completeness — that means: do the whole thing, no stubs, no "for later", tests and docs included.

## 6. Extension points (where branches and tabs plug in)

The backbone was shaped so every future phase is **additive** — new files, new tabs, new data domains; no rewrites.

- **New tab:** add to `TABS` in `main.js`, add a route view name, create `app/views/<name>.js`, pass props from `App`, add the file to `sw.js` SHELL, style with existing tokens in `styles.css` (dark console: `--signal` green on `#0c0f11`, JetBrains Mono numerals). The hash router needs no changes for simple views; parameterized routes follow the `#/recipe/<id>` pattern in `router.js`.
- **New data domain:** one small JSON file per domain (`health/`, `calendar.json`, `closet.json`…), schema documented in `SCHEMAS.md` first, read through `store.js` with cached-first + `onSyncChange` refresh (copy the pantry effect in `main.js`), written with `write()` — the queue, merge, and 409 handling come free. Small files = small conflict surface; keep it that way.
- **New Worker endpoint:** pure request-builder + validator in `worker/src/lib.js` (with node:test coverage), a route in `index.js` behind the existing auth/rate-limit/size gates, contract documented in `worker/README.md`. The client side goes through `post()` in `app/lib/worker.js` — auth, offline guard, and human error messages come free. CSP already allows the Worker origin.
- **The coupling point for intelligence is `fitness/targets.json`.** Quiz ranking, week builder, and planner meters all read targets. Phase 2's recovery score should **modulate targets** (recovery down → protein/sleep emphasis up), not reach into each feature.
- **Purpose tags** (`recovery / pre-activity / long-satiety / sick-day / everyday`) are the shared vocabulary between recipes, quiz, remedies, and the future recovery score. Extend the vocabulary in `SCHEMAS.md` before using a new tag.

## 7. Phase roadmap (2 → 5) and how each connects

The strict rule from the blueprint: **no phase starts until the previous one is in daily use for 2+ weeks.**

**Phase 2 — Apple Watch pipeline + recovery score.** Health Auto Export (or an iOS Shortcut fallback) pushes daily JSON (sleep stages, HRV, resting HR, weight) into `mise-data/health/YYYY-MM.json` (month files — same conflict-surface logic as plans). App side: a pure `app/lib/recovery.js` computes a 0–100 score from HRV vs 7-day baseline, resting-HR trend, and sleep debt — unit-tested against fixture months before any UI. Surfaces: a tile on Today, a strip on Train, and a `targets.json` modulation rule (documented in SCHEMAS.md) that the quiz and week builder inherit automatically. The manual sleep/supplement check-ins from Phase 1 keep working as the fallback input.

**Phase 3 — Calendar + tasks.** Google Calendar needs OAuth, and secrets live only in the Worker: add a `/calendar` Worker endpoint that holds the refresh token as a Worker secret and returns a sanitized event list (the app never sees Google credentials — same trust boundary as the Anthropic key). Planner gains a read-only events overlay per day (training sessions, matches → the week builder's pre-activity/recovery purposes get real anchors). Tasks are a plain `tasks.json` domain + a Today section; PURPL reminders are just tasks with a recurrence field.

**Phase 4 — Closet.** `closet.json` (items with color/formality/season tags) + an outfit view — pure new-tab work using the existing patterns; the camera-scan pattern from pantry (photo → itemize → approve) reuses `/scan` with a different tool schema (add `SCAN_MODE` to the request body rather than a new endpoint). Deal monitoring belongs in the weekly scheduled task (Cowork searches, writes `deals.json`), not in the app.

**Phase 5 — Career digest + live Claude.** The Worker already IS the live-Claude infrastructure — `/remedy` proved the pattern (forced tool schema, validated output, PAT auth). A general `/ask` endpoint is the same ~60 lines with a different system prompt. The career digest is another scheduled-task product: weekly research written to `digest.json`, rendered as a read-only view.

**Thinking further out** (the 30-steps-ahead view): every phase adds (a) a data file + schema, (b) at most one tab, (c) at most one Worker endpoint, (d) optionally one scheduled-task prompt. If a proposed feature doesn't decompose into those four pieces, it's fighting the architecture — redesign the feature, not the architecture. The things that must never change without a council run: the two-repo split, the PAT-only data path, offline-first, zero-build, and the small-files rule.

## 8. State of the build (July 2026)

Phase 1 complete and live at https://janniksin.github.io/mise/ — cookbook, quiz, drag-drop planner with ingredient-overlap week builder + protein red flags, pantry + camera scan, shopping list, remedies (rules + live), full fitness tracker, PWA offline shell. Worker deployed. 111 node tests green.

Outstanding, David-side: set `ANTHROPIC_API_KEY` in the Worker (console.anthropic.com key → CF dashboard → Workers & Pages → mise-worker → Settings → Variables → Secret) — scan and live remedies return 503 until then; schedule the weekly task (`docs/WEEKLY_TASK_PROMPT.md`); then the Task 14 verification week — two weeks of daily use before Phase 2 talk.
