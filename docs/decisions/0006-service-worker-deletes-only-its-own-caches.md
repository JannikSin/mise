# 0006. The service worker deletes only `mise-` prefixed caches

- **Status:** accepted
- **Date:** 2026-08-18
- **Deciders:** session droplet, after the measurement
- **Tenet invoked:** none

## Context

Every PWA David owns lives under one origin, janniksin.github.io, and Cache Storage is
scoped per origin. Mise's activate step deleted every cache that was not its own version,
so Tally, Finesse, Bonmot, Grandstand and aimap lost their shells on every Mise deploy,
for 22 days, and Mise was the last app still doing it.

## Options considered

- **Delete everything not ours.** Simple, and wrong on a shared origin.
- **Delete only caches whose name starts with `mise-`.** One filter; each app owns its
  prefix.
- **Move Mise to its own origin.** Right for the sandbox later (decision 0008), too
  heavy for a cache filter.

## Decision

The filter stays. Every sibling app carries the same rule for its own prefix.

## Consequences

Deploys of one app no longer strand the others.

**What gets worse:** a renamed cache prefix would orphan old caches forever; the prefix
is now a contract.
