# Mise Worker

The app's only server-side piece: every AI feature (pantry/receipt/menu
scans, plate tailoring, dinner discussion, chat onboarding, live remedies),
proxied to the Anthropic API so the key never touches the browser.

## Contract

All endpoints: `POST`, JSON, CORS-locked to the app origins, and require the
header `x-mise-auth: <fine-grained PAT>` — the Worker authorizes by checking
the token can see the **private** `mise-data` repo (same credential the app
already stores; revoke it once, all die).

- `POST /scan` `{ image: "<base64>", mediaType: "image/jpeg" }` →
  `{ items: [{ name, kind: "staple"|"perishable", qty }] }` (≤60 items,
  sanitized). The app classifies store sections itself (`sectionOf`).
- `POST /receipt` `{ image, mediaType }` →
  `{ store, items: [{ name, price, size }] }` — the price-catalogue
  freshness loop.
- `POST /menu` `{ image, mediaType, diners: [{ id, name, goal, calories, protein, diet, avoid[] }] }` →
  `{ diners: [{ name, picks: [{ item, why, estCalories, estProtein }], skip[] }], notes[] }` —
  restaurant-menu report per diner, nothing persisted.
- `POST /tailor` `{ recipe: { name, servings, calories, protein, carbs, fat, ingredients[] }, seats: [<diner shape>] }` →
  `{ seats: { <profileId>: { plate[], estCalories, estProtein } }, cook[] }` —
  per-seat plating adjustments for one shared table dish; the app persists
  the result on the table (`setTableTailor`).
- `POST /dinner` `{ messages, people: [<diner shape + say>], candidates: [{ id, name, calories, protein, cuisine }] }` →
  `{ reply, decision }` — the household dinner discussion; `decision` is a
  bank pick or a fully validated special meal plus per-person plate notes.
- `POST /onboard` `{ messages, survey }` → `{ reply, profile }` — the chat
  onboarder (profile math stays in the app).
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
