# Mise: GitHub-PAT to Supabase Migration Design

Status: DESIGN ONLY, no code changed. Written 2026-07-17.
Tribunal reviewed 2026-07-17: verdict BLOCKED-until-fixed. Core schema and RLS approved; three security items and eight engineering gaps must be resolved before public cutover. See section 12 (Tribunal Amendments) at the end. The build agents MUST implement section 12; it overrides anything above it that conflicts.
Scope: replace the private `mise-data` GitHub repo + PAT with Supabase (auth, Postgres, RLS), keep the app a zero-build static PWA on GitHub Pages, keep the Cloudflare Worker for the two Anthropic endpoints.

Grounding: this design was written after reading `app/lib/store.js`, `app/lib/github.js`, `app/lib/sync.js`, `app/main.js`, `app/views/profile-gate.js`, `app/lib/worker.js`, `worker/src/index.js`, `worker/src/lib.js`, `sw.js`, `index.html`, `docs/SCHEMAS.md`, and the seed-data fixtures for both profiles.

---

## 0. Current-state inventory (what actually has to move)

Per-profile data today is a set of small JSON files in `mise-data` (David at repo root, Mom under `profiles/mom/`), all shapes documented in `docs/SCHEMAS.md`:

| File | Shape (top level) | Notes |
|---|---|---|
| `profiles.json` | `{ profiles: [{id, name, emoji, phase}] }` | root, never scoped; becomes obsolete (replaced by accounts) |
| `recipes/<id>.json` | one recipe per file | SHARED bank, root only; phases-filtered per profile |
| `profiles/<id>/recipes/<id>.json` | same recipe shape | per-profile overrides; Mom has 29 real loss-adjusted variants plus 29 byte-identical shadow duplicates of bank recipes (backward-compat only, see SCHEMAS.md) |
| `plans/<week>.json` | `{ week, locked?, entries: [{id, date, slot, recipeId\|freeText, servings, pinned?}] }` | entry `id` is the merge key |
| `shopping.json` | `{ generatedFrom?, items: [{id, food, qty, unit, section, checked, manual, fromRecipes?}] }` | derived + check state; combined household tab reads every profile's copy |
| `pantry.json` | `{ staples: [...], perishables: [...] }` | |
| `fitness/targets.json` | macros, phase, phaseSince, avoidIngredients?, mealSlots?, tracks?, dailyDozen, sleepHoursTarget, pushupsPerDay?, priorityStack, nonNegotiables, supplementPlan | this IS the profile's "targets" object |
| `fitness/workouts.json` | `{ schedule?, templates, sessions: [{id, date, ...}] }` | session `id` is the merge key |
| `fitness/daily.json` | `{ days: [{date, weight?, waist?, sleepHours?, pushups?, water?, supplements?, calories?, protein?, dozen?}] }` | the daily check-in / meal log |
| `fitness/activities.json` | reserved, no UI reads or writes it | NOT migrated to a table (YAGNI); revisit when the feature exists |
| `meta.json` | schemaVersion, lastWrite | dropped; Postgres `updated_at` replaces it |

Data-flow facts that shape the design:

- `store.js` is offline-first: IndexedDB cache, dirty-write queue, flush on reconnect. `sync.js` treats the GitHub `sha` as an OPAQUE string token: write with last known sha, `ConflictError` on mismatch, re-fetch, `mergeFieldWise`, retry (max 3). Nothing in `store.js`/`sync.js` knows it is GitHub. This is the single most important fact: the Supabase swap is an IO-adapter swap, not a store rewrite.
- Profile scoping is one function (`scoped()` in store.js) plus `{raw:true}` escapes for two cross-profile features: the shared recipe bank and the combined household shopping list (read every profile's `shopping.json`, write ticks through).
- The Worker authenticates by checking the presented PAT can see the private repo; the app sends the PAT in `x-mise-auth`.
- The app is gated by `localStorage mise.activeProfile`; anyone with the PAT can open any profile. There is no real auth today.

Questionnaire answers (sex, age, height, weight, activity, goal) are computed into targets by `targetsFromQuestionnaire` and then DISCARDED; they are not persisted anywhere today. The new `profiles` table gives them a home; for David and Mom they are backfilled manually or left null.

---

## 1. Supabase schema

One Supabase project (free tier). Accounts live in Supabase-managed `auth.users` (email + password). Everything below is in the `public` schema. All `user_id` columns are `uuid not null references auth.users(id) on delete cascade default auth.uid()`.

Design rule: each former JSON file becomes ONE row holding the same document in a `data jsonb` column, plus a `rev bigint` optimistic-concurrency counter that plays the role the GitHub sha plays today. This deliberately mirrors the file model so `store.js`, `sync.js`, and `merge.js` survive unchanged. Normalizing entries/sessions/items into per-row tables is explicitly deferred; the id-keyed field-wise merge already gives entry-level conflict safety.

```sql
-- extension for case-insensitive usernames
create extension if not exists citext;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'home'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  username citext not null unique,
  emoji text not null default '',
  -- questionnaire answers, now persisted (nullable: David/Mom predate this)
  sex text check (sex in ('m','f')),
  age int check (age between 10 and 100),
  height_in int check (height_in between 36 and 95),   -- total inches
  weight_lb numeric check (weight_lb between 60 and 500),
  activity int check (activity between 1 and 5),
  goal text check (goal in ('loss','maintain','gain')),
  -- live app state
  phase text not null default 'recomp' check (phase in ('gain','loss','recomp','cut')),
  targets jsonb not null default '{}'::jsonb,  -- the whole fitness/targets.json document
  training_enabled boolean not null default true, -- NEW explicit flag; today this is implied
                                                  -- by targets.tracks containing "pushups".
                                                  -- true for David, false for Mom.
  household_id uuid references public.households(id),
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);
create unique index profiles_username_lower on public.profiles (lower(username::text));

-- shared recipe bank: readable by every signed-in user, writable by nobody
-- through the API (service-role only, i.e. David's maintenance scripts)
create table public.recipes (
  id text primary key,          -- kebab-case slug, unchanged
  data jsonb not null,          -- full recipe document incl. phases/tags
  updated_at timestamptz not null default now()
);

-- per-profile recipe overrides (Mom's 29 loss-adjusted variants)
create table public.profile_recipes (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  id text not null,
  data jsonb not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table public.week_plans (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  week text not null,           -- '2026-W28'
  data jsonb not null,          -- { week, locked?, entries: [...] }
  rev bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, week)
);

create table public.shopping_lists (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  data jsonb not null,          -- { generatedFrom?, items: [...] }
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table public.pantries (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  data jsonb not null,          -- { staples, perishables }
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table public.workouts (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  data jsonb not null,          -- { schedule?, templates, sessions }
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- daily check-ins: the "meal log" (calories, protein, weight, water, dozen...)
create table public.daily_logs (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  data jsonb not null,          -- { days: [...] }
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);
-- ponytail: one jsonb doc per user mirrors fitness/daily.json exactly, so the
-- adapter stays trivial. Split into per-date rows when the doc gets heavy
-- (years out) or when two-device same-day check-ins start colliding.
```

The `rev` bump and conflict detection happen in one RPC so the check-and-set is atomic (the client cannot be trusted to do read-modify-write):

```sql
-- One writer function used by the app for every doc table.
-- expected_rev = null means "create if absent" (mirrors sha-less create).
-- Returns the new rev; raises 'mise_conflict' when expected_rev is stale,
-- which the adapter converts to ConflictError (same contract as GitHub 409).
create or replace function public.write_doc(
  p_table text, p_key text, p_data jsonb, p_expected_rev bigint
) returns bigint
language plpgsql security invoker as $$ ... $$;
```

(Implementation detail for the executing agent: a `case p_table` dispatch over the six doc tables with `insert ... on conflict do update ... where <table>.rev = p_expected_rev`, checking `found`. `security invoker` so RLS still applies. Reject unknown table names.)

`updated_at` maintained by a single `moddatetime` trigger per table (Supabase ships the extension).

## 2. Row-level security

RLS is ENABLED on every public table, including `households`. Supabase's default is deny, so a table with RLS on and no policy is inert; every grant below is explicit.

```sql
alter table public.profiles       enable row level security;
alter table public.recipes        enable row level security;
alter table public.profile_recipes enable row level security;
alter table public.week_plans     enable row level security;
alter table public.shopping_lists enable row level security;
alter table public.pantries       enable row level security;
alter table public.workouts       enable row level security;
alter table public.daily_logs     enable row level security;
alter table public.households     enable row level security;

-- own-rows-only, all four commands, for every per-profile table:
create policy own_rows on public.week_plans
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- (identical policy on profile_recipes, pantries, workouts, daily_logs)

-- profiles: read/update own row; insert own row at signup; no delete
create policy own_profile_select on public.profiles for select to authenticated using (id = auth.uid());
create policy own_profile_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy own_profile_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- recipe bank: read-only to any signed-in user; no write policies exist,
-- so anon-key clients can never insert/update/delete. Bank maintenance
-- happens with the service-role key from David's scripts only.
create policy bank_read on public.recipes for select to authenticated using (true);

-- household exception (the ONE deliberate cross-user grant):
-- the combined EVERYONE shopping tab needs to read the other household
-- member's list and write ticks through. security definer helper avoids
-- recursive RLS on profiles:
create or replace function public.my_household() returns uuid
language sql security definer stable set search_path = public as
$$ select household_id from profiles where id = auth.uid() $$;

create policy household_shopping on public.shopping_lists
  for all to authenticated
  using (user_id = auth.uid()
         or user_id in (select id from public.profiles
                        where household_id is not distinct from null = false
                          and household_id = public.my_household()))
  with check (user_id = auth.uid()
         or user_id in (select id from public.profiles
                        where household_id = public.my_household()));

-- household member directory (names/emoji for the EVERYONE tab header):
create policy household_profiles_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or household_id = public.my_household());
create policy household_read on public.households
  for select to authenticated using (id = public.my_household());
```

Notes for the implementer:

- `my_household()` returns null for householdless users; `x = null` is never true in SQL, so a user with no household sees only their own rows. Keep that property; do not "fix" it with coalesce.
- The `household_profiles_read` policy supersedes `own_profile_select` (policies are OR-ed). It exposes name, emoji, phase, and also targets/questionnaire columns to household members. David and Mom already see each other's everything today, so this is acceptable for v1; if it ever isn't, split profiles into a base table and a private detail table.
- The tribunal test: create a third account in NO household and verify it can read zero rows of David's data in every table, then put it in a second household and re-verify.
- Never ship a policy `to public` or `using (true)` except `bank_read` (which is `to authenticated`).

## 3. Auth flows

### Library, zero-build

`@supabase/supabase-js` v2 (latest 2.110.7) works as a plain browser ESM import with no build step. Verified specifics:

- Working import URL: `https://esm.sh/@supabase/supabase-js@2.110.7` (pin the exact version). `import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.7"` is the community-verified pattern.
- The officially documented jsDelivr URL `https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm` is currently BROKEN for v2 at runtime ("Cannot read properties of null (reading 'AuthClient')") because jsDelivr's ESM rewrite mishandles submodules that `export default null` (supabase discussion #41118). Do not use it.
- Mise convention decision: this repo forbids third-party CDN references (strict CSP, vendored deps). So the recommended route is to VENDOR the bundle exactly like Preact: download the fully-bundled ESM output once (`npx esbuild node_modules/@supabase/supabase-js/dist/module/index.js --bundle --format=esm --outfile=vendor/supabase/supabase.module.js`, a one-time step for the migrating agent, not a runtime build), record the version in `vendor/VERSIONS.md`, and map it in the import map as `"supabase": "./vendor/supabase/supabase.module.js"`. CSP `script-src` stays `'self'`; only `connect-src` gains `https://<project-ref>.supabase.co`. If David prefers the CDN anyway, esm.sh is the URL and `script-src` must add `https://esm.sh`.

Client setup (`app/lib/supabase.js`, new):

```js
import { createClient } from "supabase";
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
```

The anon key is public by design (RLS is the security boundary) and lives in code; this removes the whole PAT-entry ceremony, token age warnings, and the repo-privacy red banner.

### Signup

Fields: first name, last name, username, email, password, confirm password (client-side match check), then the EXISTING questionnaire (sex, age, height, weight, activity, goal) on the same flow.

1. `supabase.auth.signUp({ email, password, options: { data: { first_name, last_name, username } } })`.
2. Insert the `profiles` row (id = user.id, names, username, questionnaire columns, `targets` = `targetsFromQuestionnaire(...)` output, `phase` from it, `training_enabled` from goal). A unique-violation on username surfaces as "username taken".
3. Signed in, straight into the app.

Project auth settings: DISABLE "Confirm email" (Dashboard > Auth > Providers > Email). This is a two-member family app onboarded in person; skipping confirmation means step 2 always runs with a live session and there is no unconfirmed-limbo state. If confirmation is ever turned on, step 2 must move to a "complete your profile" screen shown on first authenticated boot when the profiles row is missing.

### Login (username OR email)

Supabase auth only accepts email. Resolution: if the input contains `@`, use it directly; otherwise call a `security definer` RPC:

```sql
create or replace function public.email_for_username(u text) returns text
language sql security definer stable set search_path = public as
$$ select au.email from auth.users au join profiles p on p.id = au.id
   where lower(p.username::text) = lower(u) $$;
grant execute on function public.email_for_username(text) to anon;
```

then `signInWithPassword({ email, password })`. Known cost: this RPC lets an unauthenticated caller map usernames to emails (see Risks). Supabase's built-in auth rate limiting applies to the sign-in itself; the RPC is additionally protected only by obscurity of usernames. Accepted for a family app; the alternative (email-only login) deletes the risk and one RPC if David will accept it.

### Password reset

Built-in flow, no custom email infrastructure (Supabase's default SMTP allows a handful of emails per hour, plenty for two users):

1. Login screen "forgot password" asks for email, calls `supabase.auth.resetPasswordForEmail(email, { redirectTo: "https://janniksin.github.io/mise/" })`. The redirect URL must be added to Auth > URL Configuration > Redirect URLs.
2. The emailed link lands on the app with recovery tokens in the URL fragment. `detectSessionInUrl` consumes them and fires `onAuthStateChange` with event `PASSWORD_RECOVERY`; the app shows a "set new password" form and calls `supabase.auth.updateUser({ password })`.
3. HASH ROUTER CAUTION: Mise routes via `location.hash` (`#/plan`). Supabase also delivers tokens in the hash. The router (`app/lib/router.js`) must leave hashes it does not recognize untouched until supabase-js has parsed them (register `onAuthStateChange` before `initRouter`, and have the router treat `#access_token=`/`#error=` prefixes as "not a route"). Test the recovery link on iPhone standalone PWA specifically; if the standalone app does not receive the link (opens in Safari instead), that Safari tab still completes the reset fine because the deployed app runs there too.

### Session handling in the static PWA

supabase-js persists the session (JWT + refresh token) in localStorage and auto-refreshes. Boot logic in `main.js`: `await supabase.auth.getSession()`; session present renders `App`, absent renders the auth gate. `onAuthStateChange` handles `SIGNED_OUT` (render gate) and `PASSWORD_RECOVERY`. The `mise.activeProfile` localStorage key and the profile chooser die: the account IS the profile, and `scoped()` in store.js is deleted since RLS now does the scoping server-side. "Switch profile" in System becomes "sign out". The Anthropic Worker gets `(await supabase.auth.getSession()).data.session.access_token` instead of the PAT.

## 4. Migrating David and Mom

One Node one-off script, run by David locally (never committed with real data; lives as `scripts/migrate-to-supabase.mjs` in the app repo, reads secrets from env): uses the service-role key (bypasses RLS) plus a local clone of `mise-data`.

Accounts: pre-create both with `supabase.auth.admin.createUser({ email, password: <temp>, email_confirm: true, user_metadata: {...} })`, hand David and Mom their temp passwords in person, and have the app's System account panel offer "change password" (`auth.updateUser`). Show a persistent "change your temporary password" hint until they do (soft-forced reset; hard forcing adds state for zero real benefit in a family of two). Alternative if no temp passwords should ever exist: `admin.generateLink({ type: 'recovery' })` per user and send them the links; both paths reuse the same set-new-password screen, so this is a one-line choice at run time.

Data moves, per user:

1. `profiles` row: id = auth user id; names/usernames chosen at run time (e.g. `david`, `mom`); `targets` = that profile's `fitness/targets.json`; `phase` from targets; `training_enabled`: David true, Mom false; questionnaire columns backfilled from known values or left null; both `household_id` = the one created `households` row.
2. `week_plans`: every `plans/*.json` (David root, Mom `profiles/mom/plans/`) upserted with `week` from filename.
3. `shopping_lists`, `pantries`, `workouts`, `daily_logs`: the corresponding file verbatim into `data`.
4. `recipes` bank: every root `recipes/<id>.json`.
5. `profile_recipes` for Mom: for each file in `profiles/mom/recipes/`, DIFF against the bank copy first. 29 of her 58 files are byte-identical shadow duplicates kept only for pre-bank app compatibility (documented in SCHEMAS.md); every device runs post-migration code after cutover, so import ONLY the files whose content differs from the bank. Log the skipped list for David to eyeball.
6. `fitness/activities.json` and `meta.json`: not migrated (no consumer).

Verification step in the same script: sign in as each user with the anon key + temp password and assert row counts per table match file counts, and that David's client cannot select Mom's `daily_logs` (RLS smoke test). Print a summary table.

Rollback story: `mise-data` is untouched by the migration (read-only source). Keep it for 30 days after cutover, then archive the repo and revoke the PAT.

## 5. Cloudflare Worker changes

`worker/src/index.js` keeps its whole request pipeline (CORS allowlist, rate limiting, size caps, both endpoints, response validation). Only `isAuthorized` changes: instead of proving the caller holds a PAT that reads the private repo, the caller sends their Supabase access token in the same `x-mise-auth` header, and the Worker verifies it against Supabase:

```js
// env additions (wrangler.toml [vars]): SUPABASE_URL, SUPABASE_ANON_KEY
async function isAuthorized(token) {
  if (!token) return false;
  const key = await tokenKey(token);
  const cached = authCache.get(key);
  if (cached && cached > Date.now()) return true;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  authCache.set(key, Date.now() + AUTH_TTL_MS);
  return true;
}
```

This is a network check like today's GitHub call, cached the same way (keep AUTH_TTL_MS at 10 min or shorten to 5 so a signed-out token dies faster; access tokens expire in 1 hour anyway). Local JWT verification against the project's JWKS (`/auth/v1/.well-known/jwks.json`) is the zero-network upgrade path if the auth call ever becomes a latency problem; not needed for v1. `ANTHROPIC_API_KEY` stays a Worker secret, unchanged. `app/lib/worker.js` changes one line of token sourcing. Note the rate limiter now keys on a token that rotates hourly, which resets counters more often; the fixed window is loose enough that this does not matter for two users.

## 6. Offline story

What exists today: full offline reads from IndexedDB, offline write QUEUE with flush-on-reconnect, and sha-based merge on conflict. The service worker only caches the app shell; data freshness is entirely `store.js`.

v1 decision: KEEP the existing queue architecture, because `sync.js` is transport-agnostic. Its `SyncIO` interface treats `sha` as an opaque string; the Supabase adapter returns `String(rev)` in the sha slot and throws `ConflictError` when `write_doc` reports a stale rev. `store.js`, `sync.js`, `merge.js`, and IndexedDB survive as-is. This preserves the CLAUDE.md rule 3 flagship: ticking the shopping list in a store with no signal still works and syncs later.

What degrades, stated plainly:

- Reads while offline: unchanged (cache-first, background revalidate when online).
- Writes while offline: unchanged (queued, flushed on reconnect, merged on conflict).
- AUTH while offline: new degradation. If the access token expires while offline, supabase-js cannot refresh it, so background revalidation and flush fail with 401s until connectivity returns; the flush loop already treats auth failure as "stop, keep everything queued", so no data is lost. The app must NOT sign the user out on a failed offline refresh: gate on "a session object exists", not "session is currently valid". A multi-day fully-offline stretch therefore works exactly as well as today, minus nothing.
- First run on a new device requires being online to sign in (same as today, which required online PAT entry).

Explicit non-goals for v1: no Supabase Realtime, no per-item normalization, no CRDTs. The doc-plus-rev-merge model is the same consistency model shipping today.

## 7. Cost

Verified current Supabase free-tier numbers (July 2026): 500 MB database, 50,000 monthly active users, 1 GB file storage, 5 GB egress, 500k edge function invocations, max 2 active projects, and free projects are PAUSED after 7 days with no API requests (data kept, manual restore in dashboard).

- Mise reality: 2 users, total data today is a few MB of JSON. Database and MAU limits are three to five orders of magnitude away. Egress from daily app use is KBs per day.
- The one live risk is the inactivity pause: the app is used daily, but a three-week family vacation with the app unopened pauses the project and the PWA then boots to cached data with failing syncs until David restores it in the dashboard. Acceptable for v1; if it ever bites, the fixes are (a) any weekly cron pinging PostgREST, or (b) Pro at $25/month, which also removes pausing and adds backups.
- Paid tier triggers, concretely: project pause tolerance (above), wanting daily backups (free tier has none; the old system got versioning for free from git, see Risks), or >500 MB (not plausible with JSON documents of this size).
- Cloudflare Worker and GitHub Pages costs: unchanged, $0.

## 8. Ordered implementation steps

Phase 0 blocks everything; A, B, C are then parallelizable by three agents with one integration point (the adapter's module interface, defined in A1, is frozen first).

Phase 0. Project setup (single agent or David + agent, ~an hour)
1. Create Supabase project; record `SUPABASE_URL`, anon key, service-role key (service key goes only into David's local env, never the repo).
2. Run one `schema.sql` (tables, indexes, triggers, `write_doc`, RPCs, all RLS from sections 1 and 2). Commit `schema.sql` under `supabase/` in the app repo as the source of truth; update `docs/SCHEMAS.md` to describe tables instead of files (same commit rule as today).
3. Auth settings: disable email confirmation, set Site URL `https://janniksin.github.io/mise/`, add redirect URL, leave built-in SMTP.
4. Run the Supabase database linter and fix anything it flags on the policies.

Phase A. Data layer (agent 1)
1. Vendor supabase-js (section 3), add to import map in `index.html`, add `https://<ref>.supabase.co` to CSP `connect-src`, remove `https://api.github.com` from it at cutover. New `app/lib/supabase.js` (client + constants).
2. New `app/lib/supa-data.js` implementing exactly the `github.js` surface consumed by `store.js`: `readFile(path)`, `writeFile(path, data, sha)`, `listDir(dir)`, mapping paths to tables: `plans/<week>.json` to `week_plans`, `shopping.json` to `shopping_lists`, `pantry.json` to `pantries`, `fitness/targets.json` to `profiles.targets`, `fitness/workouts.json` to `workouts`, `fitness/daily.json` to `daily_logs`, `recipes/<id>` to bank or `profile_recipes`, `profiles/<id>/shopping.json` (household raw path) to the other member's `shopping_lists` row. `sha` slot carries `String(rev)`; stale rev raises `ConflictError`. `listDir("recipes")` selects `id, rev` (or `updated_at`) as the change token.
3. `store.js`: swap `io` to the new adapter; DELETE `scoped()`/`activeProfile()` (RLS scopes now); keep raw-path support only for the household shopping read/write-through; `readProfiles()` becomes "select household member profiles".
4. Port `github.js`'s `checkDataRepo` role: a `checkBackend()` returning session validity for System's status panel; delete PAT storage, token age warning, and the repo-public red banner (no repo to leak). `node --test` suite for the adapter path mapping and conflict contract.

Phase B. Auth UI + app shell (agent 2)
1. `app/views/profile-gate.js` becomes `app/views/auth-gate.js`: login form (username-or-email + password), signup (names, username, email, password x2, then the existing questionnaire markup moved intact), forgot-password, set-new-password (recovery). Keep the questionnaire-to-targets code path exactly as is.
2. `app/main.js`: boot on `getSession()` instead of `mise.activeProfile`; `onAuthStateChange` wiring (SIGNED_OUT, PASSWORD_RECOVERY) registered before `initRouter`; router treats `#access_token`/`#error` hashes as non-routes.
3. `app/views/system.js`: replace the token panel with account panel (signed-in email, change password, sign out); keep sync status UI.
4. `sw.js`: add `vendor/supabase/supabase.module.js` and `app/lib/supabase.js`/`supa-data.js` to SHELL, remove `github.js`, bump `CACHE_VERSION`.

Phase C. Worker + migration + cutover (agent 3)
1. `worker/src/index.js`: `isAuthorized` swap (section 5); `wrangler.toml` vars; deploy; curl-test 401 without token, 200 with a real session token.
2. `app/lib/worker.js`: send the Supabase access token.
3. `scripts/migrate-to-supabase.mjs` (section 4) + run it with David; verify counts and the cross-user RLS smoke test.
4. Cutover: deploy app; on each device sign in once; confirm data appears; watch one full day of use. Then delete `app/lib/github.js`, archive `mise-data` after 30 days, revoke the PAT (this also kills old-app access instantly, see Risks).
5. Docs: rewrite `docs/SCHEMAS.md` data-layout section, update `docs/OPERATORS_MANUAL.md` (new secrets, new restore procedure), changelog.

Suggested tribunal run: after Phase 0 (schema + policies on paper) and again after C4 with a live third test account.

## 9. Risks (what the tribunal should attack)

1. Household shopping policy is the one deliberate cross-user door. Attack: does `my_household()` (security definer) leak anything beyond household_id? Can a user UPDATE another member's `shopping_lists.data` to something destructive (yes, by design, ticks write through; the blast radius is one regenerable shopping list)? Verify a householdless third account sees nothing. Verify the `with check` clause stops INSERTING a row for another user.
2. Forgotten RLS is the classic Supabase catastrophe. Every table must show `rowsecurity = true` in `pg_tables`; any future table added without RLS is publicly readable through PostgREST with just the anon key, which now ships in the public app repo. Make the linter check part of the schema-change checklist in SCHEMAS.md.
3. `email_for_username` RPC gives unauthenticated callers a username-to-email oracle. Two known usernames exist and they are guessable ("david", "mom"). Decide consciously: accept (family app), or drop username login. Do not ship it half-thought.
4. Old app code with a live PAT keeps working against `mise-data` after cutover: a device that never refreshed (stale SW) will happily write to the ABANDONED repo and those writes silently diverge. Mitigation is C4's PAT revocation plus SW cache-version bump; sequence it before telling anyone "migration done". This is the exact class of bug SCHEMAS.md's week-lock caveat documents.
5. Doc-level rev merge: `write_doc` dispatches on a client-supplied table name string; a bug or malicious client can only reach the six whitelisted tables AS ITSELF under RLS, but the reviewer should verify the whitelist and that `security invoker` is set (definer here would bypass RLS entirely and be a full data leak).
6. Recovery-link tokens vs hash router: a routing regression can eat the recovery hash and strand password resets. Playwright-test the full email flow, and test on the iPhone standalone PWA.
7. Loss of git history as an implicit backup. Today every write is a commit; time-travel undo of a botched generate-week was free. Free-tier Supabase has NO backups. Mitigation options: nightly `pg_dump` via GitHub Action into a private repo (cheap, ironic, effective) or accept the risk; decide explicitly, it should not vanish silently.
8. Free-tier pause after 7 idle days (section 7): the failure mode is quiet (sync errors on a working-looking app). System's status panel should distinguish "backend paused/unreachable" from "offline".
9. Migration duplicates: importing Mom's 29 shadow-duplicate recipes as `profile_recipes` would pin her to stale copies whenever the bank copy improves. The diff-and-skip step is load-bearing, not an optimization.
10. supabase-js version drift: vendored bundle pins 2.110.7; auth endpoint or token format changes arrive only when deliberately re-vendoring. That is a feature (no CDN surprise breakage) but document the re-vendor procedure in `vendor/VERSIONS.md`.

---

## 12. Tribunal Amendments (2026-07-17) — BINDING on the build

Nine independent reviewers audited this plan. Verdict: BLOCKED-until-fixed. The schema and RLS core are approved. Red Team issued a hard block on one financial hole. Items are ordered by gate: the BLOCKERS before any public signup exists; the LEGAL GATE before public signup opens; the ENGINEERING gaps before the matching phase is called done.

### 12.1 BLOCKERS (Red Team hard block + Ledger critical) — close before a third account can exist

**B1. The Anthropic proxy must authorize entitled users, not any authenticated user.**
Root problem: this design (a) disables email confirmation and (b) changes the Worker `isAuthorized` to accept any token `/auth/v1/user` validates. Combined, any stranger signs up with a throwaway email, gets a live token instantly, and calls `/scan` and `/remedy` on David's `ANTHROPIC_API_KEY` as a free Claude endpoint. No exploit needed. Required fixes, all of them:
- Worker verifies the Supabase JWT AND checks the uid against an entitlement (allowlist table, custom claim, or household membership) via the service-role key. "Authenticated" is not "entitled."
- Re-enable email confirmation before login (also gates the legal age/consent items).
- Per-user daily quota on the paid endpoints keyed on the JWT `sub` claim, not the raw token (tokens rotate hourly, so token-keyed limits reset every refresh).
- Global daily request ceiling in the Worker as a backstop.
- Hard monthly spend limit in the Anthropic console.

**B2. Keep public signups gated until launch is real.** Ship the whole migration but leave signup admin-only (Supabase toggle) until B1, the legal gate, and a real launch decision are done. Deletes the abuse surface for free, one toggle to flip later.

**B3. Email-only login. Delete the username-to-email RPC.** `email_for_username` granted to `anon` is an email-harvest oracle at public scale. Keep `username` as a display field only. Removes an RPC, the citext dependency, and the oracle.

**B4. Household membership needs an invite, not self-service.** `own_profile_update` lets a user set their own `household_id` to any value. If a household UUID leaks, an attacker joins and reads co-members' health data. Fix: forbid client writes to `household_id` (column privilege or BEFORE UPDATE trigger), move joins to an invite-token RPC. Until then, set David and Mom's household server-side in the migration script and ship households admin-only.

### 12.2 LEGAL GATE (Lawyer) — before public signup opens

- **L1.** Privacy policy + ToS static page, linked from signup, agree checkbox. Names Supabase (state a US region) and Anthropic as subprocessors; states photos are proxied not stored.
- **L2.** Account deletion + data export. Reverse the doc's "profiles: no delete." `auth.users` cascade exists; add a Delete-account control in System plus a JSON export.
- **L3.** "Not medical advice" persistent disclaimer on the remedy view and in ToS; Worker remedy prompt refuses dosing/diagnosis.
- **L4.** Age floor: schema check from `age between 10 and 100` to `>= 13` (16+ safer for a body-metrics app). State it in ToS and signup. COPPA otherwise.
- **L5.** Label photo-scan and remedy as AI-powered. Folds into L1 copy.

L1-L4 are the minimum viable legal gate.

### 12.3 ENGINEERING gaps (Engineer + Historian) — fix per phase

- **E1 (Phase A).** `store.js` calls the adapter in FOUR places: `store.js:11` named imports, plus `revalidate` (`:157`) and `revalidateCollection` (`:208, :219`) call `readFile`/`listDir` directly, bypassing `io`. `supa-data.js` must export `listDir`, `readFile`, `writeFile` by name; the swap is the import-source line.
- **E2 (Phase A freeze).** Freeze the ENTIRE post-migration `store.js` export surface and the new `readProfiles` return shape in A1. `main.js:10` imports `activeProfile`/`scoped()` which A3 deletes; B cannot boot until that seam is pinned.
- **E3 (Phase B).** Household raw-path id resolution: `readProfiles` returns `{id: <uuid>}`; `supa-data` routes `profiles/<uuid>/shopping.json` to `shopping_lists WHERE user_id=<uuid>`. `main.js:125`'s hardcoded `activeProfile()==="david"` recipe branch becomes bank-vs-`profile_recipes`.
- **E4 (Phase C cutover).** Revoke the PAT immediately after every physical device confirms the upgraded app loaded and signed in. Do NOT bundle it with the 30-day archive step: the PAT is the only thing stopping a stale client writing directly to the abandoned repo. Deploy Worker (C1) and app (C4) together or have the Worker dual-accept, so the old app does not 401 mid-cutover.
- **E5 (Phase A).** Pin the offline session predicate: read the persisted localStorage session key or the initial `onAuthStateChange` event. Do not rely on `getSession()` truthiness.
- **E6 (Phase B).** Recovery form supersedes the router via a top-level `authMode` state checked before `route.view`. `parseRoute` maps `#access_token=...` to home safely (`router.js:38`); clear the hash after consuming it.
- **E7 (migration script).** Diff-and-skip the 29 shadow duplicates by deep-equal on parsed JSON, not bytes. Make the script re-runnable (upsert everything, tolerate "user exists").
- **E8 (nits).** `isAuthorized` (section 5) must take `env`. `recipes` has no `rev` column: `listDir("recipes")` selects `id, updated_at`; `profile_recipes` keeps `rev`.

### 12.4 Accept as-written (Historian confirmed aligned)

- Add "table OR view" to the future-table RLS checklist (views run owner-privilege unless `security_invoker=true` on PG15+).
- Backups: adopt a nightly/weekly `pg_dump` GitHub Action into a private repo. Solves BOTH risk 7 (lost git-history backup) and the 7-day free-tier pause. One free workflow.
- `write_doc` stays `security invoker` with STATIC case dispatch (literal `case p_table`, bound params, no concatenated identifiers). Specify the `profiles.targets` writer path the six-table dispatch omits. Keep `search_path = public` on both definer functions.

### 12.5 Verdict

BLOCKED-until-fixed. Not a redesign: the data-isolation architecture is approved and aligns with field experience on every checked pattern. Ship order: close 12.1 blockers, build against 12.3, open the 12.2 legal gate only when flipping public signup on.
