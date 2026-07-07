# Mise Worker

The app's only server-side piece: camera-pantry scanning and live remedies,
both proxied to the Anthropic API so the key never touches the browser.

## Contract

Both endpoints: `POST`, JSON, CORS-locked to the app origins, and require the
header `x-mise-auth: <fine-grained PAT>` — the Worker authorizes by checking
the token can see the **private** `mise-data` repo (same credential the app
already stores; revoke it once, both die).

- `POST /scan` `{ image: "<base64>", mediaType: "image/jpeg" }` →
  `{ items: [{ name, kind: "staple"|"perishable", qty }] }` (≤60 items,
  sanitized). The app classifies store sections itself (`sectionOf`).
- `POST /remedy` `{ text: "how I feel" }` →
  `{ protocol: { teas[], foods[], avoid[], notes[] } }` — same shape the
  offline rules engine renders.

Errors: `401` bad/missing PAT · `503` `ANTHROPIC_API_KEY` not set yet ·
`413` photo too big · `502` upstream.

## Deploy

```
cd worker
npx wrangler deploy
```

Secrets live ONLY in Worker env: set `ANTHROPIC_API_KEY` in the Cloudflare
dashboard (Workers & Pages → mise-worker → Settings → Variables → Add →
type Secret) or via `npx wrangler secret put ANTHROPIC_API_KEY`.
