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
- `POST /notify-test` `{}` →
  `{ pinged, topicSet, cronReady, preview[] }` — sends one live ntfy ping and
  returns today's would-fire notification schedule (the SYS test button).
  Reads the data repo with the PRESENTED PAT; needs no Anthropic key.

## Notification cron

An hourly cron (`[triggers]` in wrangler.toml) posts ntfy pushes: morning
check-in (7), cook reminders at meal hours (11/15/17, only for weeks whose
`plan.shoppedAt` receipt confirmation exists and meals not yet `cookedAt`),
Saturday store nag (10) with a Sunday fallback (12), Sunday batch (10), and
an evening catch-up (20) naming whatever the daily log is missing. Pure
logic in `buildNotifications` (lib.js), all times America/Chicago. The cron
no-ops silently until BOTH secrets exist:

```
npx wrangler secret put NTFY_TOPIC        # unguessable topic, subscribe in the ntfy app
npx wrangler secret put MISE_DATA_TOKEN   # fine-grained PAT, mise-data, contents READ-ONLY
```

The topic name IS the auth on ntfy.sh: generate it (`openssl rand -hex 24`
or any long random string), treat it like a password (never paste it into
chats/screenshots), and rotate it if it ever leaks. Bodies deliberately
carry meal names and missing-log LABELS only, never health values. If
secrecy-by-topic ever feels thin, self-hosted ntfy or an ntfy Pro
access-controlled topic adds real auth without code changes.

MISE_DATA_TOKEN is the one stored repo credential (the AI endpoints still
use only the caller's presented PAT); make it read-only and revoke it to
kill the cron.

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
