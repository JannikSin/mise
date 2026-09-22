# 0007. The model that reads family food data runs in the house

- **Status:** accepted, NOT YET IMPLEMENTED (a standing violation since 2026-07-20)
- **Date:** 2026-07-20
- **Deciders:** council
- **Tenet invoked:** none

## Context

The Worker's scan, tailor, dinner and remedy routes send recipes, plates and profiles
to a model. Those payloads carry a roommate's allergy flag and a family's health targets.
The council ruled that this data should not leave the house. `worker/src/provider.js`
supports a `LOCAL_BASE_URL` that is tried first and falls back to the cloud, and the Mac
Studio runs gpt-oss-120b for free. No wrangler config sets the variable, because the
Worker at Cloudflare's edge cannot reach the Studio without a Cloudflare Tunnel.

## Options considered

- **Keep the paid Anthropic key.** Works today; the data leaves the house.
- **Local model behind a Cloudflare Tunnel, cloud as fallback.** The council's choice;
  blocked on the tunnel runbook (Crystal `AI/Weekend-Mise-Local`).
- **Strip the payloads instead.** Loses the point of tailoring, which is the person.

## Decision

Local first, cloud fallback, once the tunnel exists. Until then the violation is recorded
here rather than in a fix list, because it is a council ruling not yet honoured, not a bug.

## Consequences

When implemented: free inference and the data stays home.

**What gets worse:** a sleeping Mac makes every AI feature slower by one failed attempt
(the fallback path is tested), and the tunnel is one more piece of infrastructure to keep
alive.
