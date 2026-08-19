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
- `POST /annotate` `{ url }` OR `{ image, mediaType }`, plus
  `{ objective, diners: [<diner shape>], context: { plan[], pantry[], macros } }` →
  `{ result, transcription, extracted, path, refusalTokens[], saveEligible }`
  or `{ hardStop: { reasons[] } }` — the HBP Recipe Scan (P2). Two model
  calls (transcribe, then annotate; rate-limit weight 2) behind deterministic
  fail-closed validators: refusal-class token scan, per-diner allergen
  pre-scan, temperature floors with label declarations (the model never
  introduces a temperature value), an unlabelled-figure sweep, score
  arithmetic recomputation, and step-count preservation. URL fetches sit
  behind an SSRF fence (https-only, manual redirects re-checked per hop,
  3 MB streamed cap, truthful UA) and are extracted (JSON-LD Recipe first)
  before any model sees them; the model's `sourceQuote` must be contained in
  that same extracted buffer. When a page carries no JSON-LD Recipe the
  extraction falls back to the whole stripped page (capped 50 KB), so on that
  path quote containment and the refusal token scan read page furniture too:
  containment is a weaker guarantee there, and the token scan can fire on
  sidebar prose (the fail-safe direction). A validator reject means an error
  state and no recipe, one INFORMED retry carrying the validator's reasons
  (H2). One structured console line per run is the ledger (H1): metadata
  only, never source text.
  **Retention:** the extracted transcription is retained only inside the
  saved recipe in the private `mise-data` repo, personal use; nothing is
  stored per scan.
- `POST /annotate-save` `{ result, transcription, extracted, path, sourceUrl, pantryStaples[] }` →
  `{ recipe }` — server-side revalidate-then-write (D3): re-runs the same
  validators, maps to the canonical recipe shape
  (`tags: ["hbp-annotated", "contains:<allergen>"]`, `hbp` block, required
  `mealType`), and writes `recipes/hbp-<slug>-<date>.json` with the
  presented PAT (read-sha / write / one 409 retry). Photo-path, refusal,
  abandon and tier-2 results are refused: they render but never save in v1.
  Needs no Anthropic key. The client re-passes the scan's buffers; the
  revalidation here guards shape and safety, not a hostile client (the PAT
  holder can already write the repo directly).
- `POST /notify-test` `{}` →
  `{ pinged, topicSet, cronReady, preview[] }` — sends one live ntfy ping and
  returns today's would-fire notification schedule (the SYS test button).
  Reads the data repo with the PRESENTED PAT; needs no Anthropic key.
- `POST /kroger/locations` `{ term: "<5-digit zip>" }` → `{ locations[] }`;
  `POST /kroger/search` `{ term, locationId, limit? }` → `{ products[] }`;
  `POST /kroger/byId` `{ upcs[], locationId }` → `{ products[], failed[] }` —
  the Kroger price oracle (fix list Tier 3). Client id/secret live ONLY in
  Worker secrets (`KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET`, 503 until
  set); token cached per isolate; no Anthropic key involved. The app pins
  ingredient→UPC once (confirm-once) and refreshes weekly by UPC — these
  endpoints are never called in a loop (Products quota 10k/day).

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
