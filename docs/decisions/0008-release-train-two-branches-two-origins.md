# 0008. Two code branches, two origins, one data repo with two branches, one Sunday release

- **Status:** accepted
- **Date:** 2026-09-07 (Parallax round, three Tribunal loops, PASS WITH CONCERNS); first release run 2026-09-21
- **Deciders:** David ("like Apple does: they test on a sandbox"), Tribunal
- **Tenet invoked:** the bought week is never disturbed

## Context

On the evening of 2026-09-07 seven shell versions shipped to the live app while David
cooked from it; one buried the Plan tab, one re-planned his dinners, a write raced his
phone, and GitHub throttled the token. His words: "I almost have two apps: one is work in
progress and one is the functioning one." The full plan with every finding is
`docs/RELEASE_TRAIN.md`.

## Options considered

- **Feature flags in one build.** A broken shell still reaches every phone.
- **A sandbox at a second PATH on the same origin.** Shares localStorage, IndexedDB and
  the service worker's eviction rule with the live app; the two builds would evict each
  other.
- **A second data REPO for the sandbox.** Needs the token re-scoped by hand, a step only
  David can do.
- **`main` live on Pages, `next` on a Cloudflare Pages origin, the data on a `sandbox`
  branch of the same repo decided by ORIGIN, a Sunday fast-forward against a `ship/` tag
  David's yes produced.**

## Decision

The last. `main` is written only by `tools/release.ps1` or a named hotfix; the deploy
ships an allowlist, never the working tree; the branch is a function of origin, never a
setting; schema changes are read-time heals.

## Consequences

The week he bought for is untouchable by weekday work, and a change is seen on his phone
before it counts.

**What gets worse:** every change waits up to a week to reach the live app unless it is a
hotfix; two hosts, two icons and a re-seed are more machinery than one Pages site; and a
laptop-side deploy guard treats even the sanctioned release as a production deploy, so
the push is David's own command (2026-09-21).
