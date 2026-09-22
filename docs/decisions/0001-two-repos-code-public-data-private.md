# 0001. Keep the code in a public repo and every byte of data in a private one

- **Status:** accepted
- **Date:** 2026-07-06 (recorded 2026-09-21 from CLAUDE.md Part 2 and the July blueprint)
- **Deciders:** David, the July stack council
- **Tenet invoked:** the app must work for a household that is not his

## Context

Mise is a static PWA on GitHub Pages, which is public by nature. It holds health targets,
allergy flags, a roommate's profile and a family's plans. A single repo would put that in
the open the first time a data file was committed, and a private Pages site is not an
option (a private repo kills Pages).

## Options considered

- **One repo, data in ignored files.** One `git add .` away from publishing health data.
- **One private repo with a paid Pages plan.** A recurring cost for a personal app, and
  the roommate's install would need an account.
- **Two repos: `mise` (public, code only) and `mise-data` (private, JSON only), the app
  reading data through the GitHub Contents API with a fine-grained token.** Structural
  separation; costs a token paste on every device.

## Decision

Two repos. The app verifies at startup that the data repo is private and shows a red
banner if it is not. Seed content and planning documents with personal facts stay
gitignored on the laptop.

## Consequences

Publishing personal data becomes a two-repo mistake instead of a one-command one, and
"a feature that only works because of a fact about David" has nowhere to hide its fact.

**What gets worse:** every device needs the token pasted into SYS (the iPad taps of
2026-09-06 never saved for exactly this reason), and every tool that reads data needs
its own credential; the invite link was built to replace the paste.
