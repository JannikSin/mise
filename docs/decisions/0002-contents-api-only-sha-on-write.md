# 0002. Read and write data only through the GitHub Contents API, with the file SHA on every write

- **Status:** accepted
- **Date:** 2026-07-06 (recorded 2026-09-21 from CLAUDE.md Part 2, rule 2)
- **Deciders:** the July stack council
- **Tenet invoked:** none

## Context

The data repo can be read three ways: the Contents API, raw.githubusercontent.com, or a
Pages URL. The last two sit behind caches measured in minutes. Stale food data is wrong
food data: a shopping list built from a pantry five minutes old buys what is already on
the shelf.

## Options considered

- **raw.githubusercontent or Pages reads.** No token needed for reads, but cached, and
  writes still need the API.
- **Contents API for everything, SHA carried on every write, and on a 409 re-fetch,
  merge field by field, retry.** One path, no cache, an extra round trip per write.

## Decision

Contents API only. Writes carry the SHA; a 409 re-reads and merges field-wise. In
2026-09 the same chokepoint (`contentsUrl()` in `app/lib/github.js`) gained the data
branch, decided by origin, which is why the sandbox could be added without a second
data path (decision 0008).

## Consequences

One reader, one writer, one place to thread a branch or a token through.

**What gets worse:** every save is a commit, so write frequency is a real cost: the
tailoring loop's one-write-per-table tripped GitHub's throttle on 2026-09-07, and the
Worker now carries a read-only token for the cron and a separate write token for invites.
