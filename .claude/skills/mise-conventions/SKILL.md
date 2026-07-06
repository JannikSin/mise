---
name: mise-conventions
description: Use when writing or reviewing any Mise app code — naming, module patterns, data-access rules, forbidden moves, and the pre-commit checklist. Read before your first code change in a session.
---

# Mise Conventions

Companion to CLAUDE.md (rules) and docs/SCHEMAS.md (data). This file is the *how*.

## Stack invariants

- Zero-build: raw ES modules served as-is by GitHub Pages. No bundler, no transpile,
  no JSX. If a change requires a build step, the change is wrong.
- UI = vendored Preact + htm (`vendor/`, versions in `vendor/VERSIONS.md`). Import via
  bare specifiers (`preact`, `preact/hooks`, `htm`) — index.html's import map resolves
  them. Never import `./vendor/...` paths directly and never edit vendor files.
- Types = JSDoc + `tsc --checkJs` (jsconfig.json). Every exported function gets typed
  JSDoc. Shared shapes live in `app/types.js` as `@typedef`s mirroring SCHEMAS.md —
  change both together.

## Naming & layout

- Files: lowercase kebab-case (`shopping-list.js`). One component/concern per file.
- `app/views/` = route-level components; `app/components/` = shared pieces;
  `app/lib/` = non-UI logic (data client, cache, merge, derive). Views may import
  lib; lib never imports views.
- Components: PascalCase functions returning `html\`...\``. Hooks-based, no classes.
- Events/callbacks props: `onVerb` (`onSave`). Booleans read as predicates (`isOffline`).
- CSS: one `app/styles.css` design-system file + custom properties; component-specific
  styles colocated only if genuinely local. Console design direction: dark, tabular
  numerals, purposeful animation (see mockups/2-console.html).

## Data access pattern (the one true path)

UI → `app/lib/store.js` (IndexedDB cache + offline queue) → `app/lib/github.js`
(Contents API, PAT from localStorage, SHA on every write, 409 → re-fetch + field-wise
merge + retry). Views never call fetch directly. Reads render from cache first, then
revalidate. Writes: cache immediately, queue, flush on reconnect.

## Forbidden without David's explicit approval

- New dependencies (runtime OR dev). State the justification, wait for yes.
- Schema changes without updating docs/SCHEMAS.md in the same commit.
- Editing `vendor/` (hook-blocked), touching `.env*`/key material (hook-blocked).
- Reading data through Pages URLs or raw.githubusercontent.
- Third-party scripts, trackers, analytics, CDN references (strict CSP).
- Committing real user data to the app repo — fixtures only.
- Force-push; committing directly without the verification pipeline.

## Pre-commit checklist (CLAUDE.md Part 3, expanded)

1. Hooks green on every touched file (format/lint/typecheck fired on edit).
2. Tests for changed behavior pass (`node --test` once tests exist).
3. Reviewer subagents run in parallel and findings addressed:
   `code-reviewer` always; `security-reviewer` if the change touches tokens, data
   access, the Worker, or anything user-data adjacent; `ui-reviewer` if it touches
   views/styles/components; `schema-guard` if it touches data shapes.
4. Playwright: exercise the changed flow in the running app, screenshot it.
5. Commit message says what and why. Never force-push.
