# The Release Train: a live Mise and a sandbox Mise, merged on Sunday morning

> Status: PLAN, revision 3.1, 2026-09-07 late evening (session armstrong). Revision 1 went
> through a Parallax round and a five-seat Tribunal plan gate (two BLOCKs). Revision 2
> closed every loop-1 finding; Red Team passed it with five pre-conditions (RT-N1..N5) and
> the Engineer blocked narrowly on ENG-N1. Revision 3 closed those; the Engineer's third
> and final loop PASSED WITH CONCERNS and named ten build corrections (ENG-L3-1..10),
> folded in here. This revision goes to the Loyalist. Nothing in this document is built yet.

## Why (David, 2026-09-07, his words)

"I want to be able to use the app this week on the meals that I bought stuff for, and I
don't want any issue of 'no, I updated something and it messed up all of the recipes.' I
want it to function completely without such an issue, but still make changes on a cloned
copy and merge that at the end of the week. Like I almost have two apps: one is work in
progress and one is the functioning one. I can check the sandbox app on my phone, and if I
realize it messed things up, I wouldn't merge it. Like Apple does: they test on a sandbox
and then selectively push the updates they know integrate well. Release days: 6 AM on
Sunday is when anything on the sandbox gets merged into the release. The other apps can
be similar, not smaller, but they are not as dependent on a working week schedule."

Tonight was the proof: seven shell versions shipped to the live app in one evening while
he was cooking from it, one buried his Plan tab under a card, one re-planned his dinners,
and a data write raced his phone. GitHub then throttled writes on his token.

## The job, stated once

Two things, and they are different: (a) the week he bought for is never disturbed by
work in progress, for him or for his roommate; (b) a change can be seen and used on his
real phone, against the real shape of his kitchen, before it counts. A "second app" is
one way to get both; the plan below gets both with the least new machinery.

## The shape

Two branches of the code, two origins, one data repo with two branches, one release window.

| | LIVE | SANDBOX |
|---|---|---|
| Code branch | `main` | `next` |
| Host | GitHub Pages, `https://janniksin.github.io/mise/` | Cloudflare Pages project `mise-next`, production branch `next`, stable origin `https://mise-next.pages.dev/` |
| Data | `JannikSin/mise-data`, branch `main` | `JannikSin/mise-data`, branch `sandbox`, re-seeded from `main` |
| Phone | the Mise icon he has | a second icon named **Mise NEXT**, different colour, installed once from the sandbox origin |
| Who writes the code branch | the Sunday release, or a named hotfix | every weekday session |

**Why a second origin and not a second path.** Every PWA David owns lives under
`janniksin.github.io`, ONE origin. localStorage, IndexedDB and Cache Storage are scoped
per origin, so a sandbox at `/mise-next/` would share `mise.pat`, `mise.dataRepo`, the
`mise` IndexedDB and, worst, the service worker's eviction rule (`sw.js` deletes every
cache starting with `mise-` that is not its own version): the two builds would evict each
other's shells on every load. A different origin makes the browser isolate them for free.
The app is written with relative paths throughout and runs unchanged from the root of the
new origin. (Confirmed by Red Team and Engineer against `sw.js`.)

**The sandbox origin must be stable (RT 4, ENG 1).** A Pages deploy with `--branch` set to
anything but the project's production branch is a *preview* served at a per-deploy hash
origin: a new origin on every deploy, the token and the whole cache gone each time, and a
stale preview left live at every old URL. The project is created with production branch
`next` and every deploy targets `next`, so the origin is `mise-next.pages.dev` and nothing
else. The deploy script asserts the deployed URL string equals the allowlisted origin
before it prints "install from here".

**The deploy ships an allowlist, never the working tree (RT 1, ENG 1, LAW 1). This was a
BLOCK.** `wrangler pages deploy .` does not read `.gitignore`; its whole exclude list is
`_worker.js`, `_redirects`, `_headers`, `_routes.json`, `functions`, `.DS_Store`,
`node_modules`, `.git`, `.wrangler` (read out of the installed wrangler 4.125.0). The
working tree holds 242 ignored files, among them `seed-data/` with real health targets and
a profile tree for David's mother, the planning docs with his stats, and the standard home
of `.dev.vars`. So `tools/sandbox-deploy.ps1`:
1. stages `git archive next` into a scratch directory, so only tracked files can exist;
2. copies out of that ONLY the shell set `sw.js` already enumerates (`index.html`,
   `manifest.webmanifest`, `sw.js`, `suggest.js`, `suggest.css`, `app/`, `vendor/`,
   `icons/`) into the deploy directory. This copy-allowlist is the ONLY fence on the
   Pages path: `.assetsignore` is read by the Workers static-assets path, not by
   `wrangler pages deploy` (ENG-N2), so the plan does not count it there;
3. asserts, over the full refuse list (`.env*`, `.dev.vars*`, `*.pem`, `*.key`,
   `seed-data/`, `claude-config/`, `spike/`, `HANDOFF_CONTEXT.md`, `MISE_BLUEPRINT.md`),
   that none exists in the deploy directory, and after deploy that each returns 404 on
   the served origin (an assertion, not a spot-check);
4. rewrites, in the deploy copy only: `short_name` and the Apple web-app title to
   `Mise NEXT`, `theme_color` to a visibly different colour, the meta value
   `mise-data-branch` from `main` to `sandbox`, and OVERWRITES IN PLACE the three icon
   files (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`) with a badged set
   committed OUTSIDE the shipped tree at `tools/icons-next/` (ENG-L3-NEW-2: inside
   `icons/` they would ship to both origins and fail the containment test), so paths,
   SHELL and the allowlist are untouched and the phone shows a different icon, not just
   a different status-bar colour (RT-10, ENG-N4). `icons/` is cache-first, so the badged set must be right on
   the first deploy or a `CACHE_VERSION` bump dislodges it;
5. creates the project once with `wrangler pages project create mise-next
   --production-branch next` (there is no `--force` flag, ENG-L3-3) and deploys with
   `--project-name mise-next --branch next` on EVERY call: wrangler 4.125.0 silently
   delegates `pages deploy` to a Workers deploy when it detects a coding agent and the
   account has no Pages project, and `--branch` is in its unsupported-args list, which is
   the opt-out (ENG-N3). If the create step is delegated anyway, David creates the project
   in the dashboard once. The script's header says so, because the flags are load-bearing;
6. verifies the served `sw.js` version and that the deployment URL equals the allowlisted
   origin before it prints "install from here".
A test asserts CONTAINMENT, not equality (ENG-N7): every SHELL entry resolves to a file
the allowlist ships, and every file the allowlist ships is in SHELL or on the named
exception list (`sw.js`, and `index.html` for `./`).
The root `deploy` script in `package.json` (`wrangler deploy` against `wrangler.jsonc`'s
`assets: { directory: "." }`, an assets-only Worker with no `main`) would publish the
working tree to a public `workers.dev` origin in two words. It is REMOVED on BOTH
branches tonight, `main` under the hotfix rule (ENG-L3-NEW-7: leaving it on the live
branch for a week keeps the hazard live where David works), and `.assetsignore` is
committed at the REPO ROOT, the only place a Workers assets config reads it
(`worker/wrangler.toml` has no assets block, ENG-L3-2).

**Why a branch of the same data repo, not a second repo (Parallax).** A second private
repo needs the fine-grained token re-scoped by hand, a step only David can do; a `sandbox`
BRANCH of `mise-data` is inside the token's existing scope. The seed is a force-push of
`main` onto `sandbox`, run on release morning and on demand.

**The branch is threaded through BOTH writers, and the sandbox fails closed (RT 2, ENG 3,
ENG 5). This was a BLOCK.** The app is not the only thing that writes the data repo: the
Worker's `/annotate-save` writes recipe files through a hard-coded `DATA_REPO` constant
with no branch, so a Half-Blood-Prince scan done in the sandbox would land in the live
cookbook. Therefore:
- App: `contentsUrl()` in `app/lib/github.js` is the single chokepoint; it appends
  `?ref=<branch>` only when a branch is set, and `writeFile` adds `branch` to the PUT
  body. `readFile`, `listDir`, the 409 re-read in `pushFile`, and every `store.js` reader
  route through it, so one change covers them. A boot-time probe
  (`GET /repos/{o}/{r}/branches/{b}`) distinguishes "branch missing" from "empty
  kitchen" and red-banners it, the way `checkDataRepo` already distinguishes `norepo`.
- Worker: an `x-mise-branch` header, allowlisted to `main` and `sandbox` exactly as
  `x-mise-repo` is allowlisted, threaded into `ghReadJson`, `ghWriteJson`,
  `ghReadWithSha`, and added to `Access-Control-Allow-Headers`. Until that Worker change
  is deployed, the sandbox client disables the annotate-save button with an honest label
  ("sandbox can scan but not save to the cookbook yet"). The Worker CORS entry for the
  sandbox origin ships in the same Worker deploy, as step one, or every AI call from the
  sandbox 403s.
- Fail closed, decided by ORIGIN, not by the presence of a tag (ENG-N1, RT-N2). `index.html`
  on `next` carries a committed `<meta name="mise-data-branch" content="main">`; the sandbox
  deploy rewrites the VALUE to `sandbox` (a greppable, idempotent value swap, never an
  injection, so the CSP hash on the import map is never touched). `github.js` resolves the
  branch by ORIGIN FIRST (ENG-L3-1: the meta is committed, so "meta if present" would
  always win and a dev server would resolve `main`): `https://janniksin.github.io` is
  `main`; `https://mise-next.pages.dev` REQUIRES the meta to read `sandbox` and refuses
  writes if it does not; any other origin, `127.0.0.1:8378` included, has NO branch and
  every write is refused with a red banner "unknown data branch for this origin" (reads
  still work, so the read-only dry run the week table asks for is exactly what a local
  session gets). The meta is the sandbox's value and a cross-check, never the decider. Tests pin
  both sides: the committed `index.html` carries the meta; an unknown origin with no
  meta refuses a write; the live origin with meta `main` builds a URL with no `ref` and a
  PUT body with no `branch` (byte-identical to today, ENG-N8); meta `sandbox` builds both.
  There is no `mise.dataBranch` setting at all (ENG-L3-8): the branch is a function of
  origin and the committed meta, SYS shows it read-only ("data: JannikSin/mise-data @
  sandbox"), and there is no `setDataBranch`, no branch-switch wipe ceremony and no
  `warn`-on-difference row, because nothing could ever call them. The only wipe is the
  re-seed heal below. `applyDataRepo` keeps its `wipeToken` behaviour as is (ENG-L3-4).
- The Worker binds branch to origin too (RT-N2, ENG-N5). It already validates `Origin`
  first; it derives the branch from it (`mise-next.pages.dev` is `sandbox`,
  `janniksin.github.io` and `127.0.0.1:8378` are `main`) and REJECTS a request whose
  `x-mise-branch` header disagrees, never coerces. The resolved repo (`x-mise-repo`) and
  the resolved branch travel together through one parameter into `ghReadJson`,
  `ghWriteJson` and `ghReadWithSha`, which today interpolate a module constant and see
  neither; that is fixed in the same change, and the client-side annotate-save guard is
  removed ONLY in the commit that ships that threading (ENG-L3-5: no comment-only escape).
  `127.0.0.1:8378` maps to NO branch on the Worker too, so a local session cannot write the
  live cookbook through `/annotate-save`; the derivation is request-scoped so the hourly
  `scheduled()` cron, which carries no `Origin`, is untouched (ENG-L3-NEW-9). So the
  fail-closed guarantee is structural on both ends, not one meta tag's promise.
- The IndexedDB cache is keyed by path only; it holds the files of exactly one (origin,
  repo, branch) tuple, and the only enforcement is a wipe on change. `setDataBranch`
  carries the same docstring and SYS runs the same ceremony `applyDataRepo` runs today
  (clear active profile, delete the `mise` database, reload; the token stays, it is valid
  across branches). The ceremony is factored out of the view into a tested function.
- Queued writes are stamped with the branch they were made under, in ALL THREE places the
  sync layer rebuilds a record from a fixed key list (`write()`, `cacheRemote()`,
  `afterPushRecord()`'s non-raced path), or the stamp evaporates after the first push and
  the guard refuses every write forever (RT-N3). A record with NO stamp (every write
  queued on a phone before this ships) is a read-time heal: treated as the current branch
  and stamped on the way past, never refused (ENG-L3-NEW-1, pinned by a test that seeds an
  unstamped record and flushes it). `flush` refuses only a record stamped with a DIFFERENT
  branch, and SYS shows such a record with a DISCARD button rather than an invisible
  permanent conflict. A round-trip test (write, push, revalidate) pins the stamp.
- The re-seed heal (below) refuses to delete the database while `pending > 0` unless the
  count is confirmed in the dialog (RT-N1): the September 6 failure was an evening of taps
  that never left the phone, and a silent `deleteDatabase` is that failure with a new
  trigger.
- `writeErrorMessage` gains a branch case (RT-N5): a 404 on a PUT under a branch setting
  says "the `sandbox` branch is gone, re-seed it", never "check your token's access".
- SYS shows "data: JannikSin/mise-data @ sandbox" and marks the branch row `warn`
  whenever it differs from the install's compiled default, in both directions; the
  sandbox additionally shows a persistent header strip on every screen: `SANDBOX ·
  mise-data @ sandbox · re-seeded Sundays` (RT 10, HIST 2).

**Re-seed semantics (ENG 7, LAW 2, RT 6).** `tools/seed-sandbox-data.ps1` hard-codes the
destination ref `sandbox`, throws if it is anything else, requires an explicit confirm
flag, pushes with `--force-with-lease`, and writes `sandbox-seed.json`
(`{ seededAt, fromCommit }`) as its last act. On boot with a branch set, the app compares
`seededAt` to `localStorage["mise.sandboxSeed"]`; on mismatch it deletes its IndexedDB,
stamps the new value, reloads, and says so in one line ("sandbox re-seeded from live;
local sandbox changes cleared"). Discarding unflushed sandbox writes is the correct
outcome; merging them onto a fresh seed is the failure. Every few re-seeds the script
re-pushes the branch as an orphan so the private repo does not accumulate months of
household snapshots in `sandbox` history. The re-seed never runs on a CI runner and no
data-repo token is ever stored as an Actions secret (see release).

**Migrations are read-time heals, and the code must actually tolerate unknown fields
(ENG 4). This was a BLOCK.** The house style (`normalizePantry`, `healItem`,
`normalizePlan`, `dedupeSettled`) repairs old shapes on read. But `normalizePlan` rebuilds
the plan from an explicit allowlist of top-level keys and DROPS anything else on the next
write, which it already did once to receipt totals. So before the first release:
`normalizePlan`, `normalizePantry` and `normalizeShoppingList` carry unknown top-level
keys through, pinned by tests (an unknown future field survives a round-trip; today that
test fails). Rules: a schema change is a new optional field plus a read-time heal; a
rename keeps writing the old field for as long as any shipped shell reads it (the
`TARGETS_PATH` / `LEGACY_TARGETS_PATH` mirror is the house precedent); a true rename or
deletion (HIST 4) is a one-off script run by David outside the train, announced as a hold
week, never riding a Sunday. Of the queued builds, `checkedAt`, table `pinned`, kitchen
zones and a pack-sizes file all fit; recipe `components` fits only as long as
`ingredients` keeps being written.

**A bought week is data the train never touches.** The release changes code only. No
release step writes `plans/`, `shopping.json`, or a household file.

**What the sandbox cannot validate (ENG-N8).** The live build runs the no-branch path
(no `ref`, no `branch`) and the sandbox runs the branch path; the difference is a
deploy-time value swap. The one new code path on `main` is therefore the one the week's
use cannot exercise, which is why the tests above pin both sides byte-for-byte.

**Write frequency is its own fix, on the same train (HIST 6, ENG-L3-NEW-10).** The
throttle tonight came from commit frequency: one Contents-API PUT per save, and a tailoring
loop that writes `events.json` once per table. The sandbox adds traffic on a second branch
under the same token, so week one is the peak-risk week. The tailoring coalescing (one
`events.json` write per run) is small and is the ONE feature-side change that goes to
`main` this week under the hotfix rule, because the un-coalesced live app plus sandbox
traffic is what tripped the throttle tonight; autosave debouncing rides `next`.

## The week

| When | What | Where |
|---|---|---|
| Mon to Sat | Sessions branch off `next`, merge into `next` after the repo gates (tests, lint, typecheck, and a READ-ONLY dry run against fixtures or the `sandbox` branch, never a write, LED 3), deploy the sandbox once per session, post the URL and what changed | `next`, sandbox |
| Mon to Sat | David uses the live app for the week he bought for. He opens **Mise NEXT** when he wants to see a change, against a copy of his real data. The roommate's install never sees `next` | live, sandbox |
| Saturday evening | The Crystal digest lists what is on `next` and not on `main`, runs the full gate suite once more against the seeded `sandbox` data as a pre-flight (HIST 1), and asks David for his yes | Crystal |
| Sunday morning | The release runs (below), then David generates the new week on the live app, runs the ENOUGH pass, builds, buys | `main`, live |

## The release, exactly

`tools/release.ps1`, run from the laptop by the Sunday session (or by David) as the first
act of Sunday morning. Week one is by hand and watched. Only after one clean manual run
does the merge step get considered for GitHub Actions (with `GITHUB_TOKEN` only, an
explicit Pages build request because a token push does not trigger the Pages build, cron
in UTC, and the knowledge that GitHub's cron can be late by many minutes and is disabled
after 60 idle days, HIST 5, ENG 8). The re-seed and the sandbox deploy stay on the laptop
in every version: a data-repo token with write access cannot be scoped to one branch, and
`next` is the branch every weekday session writes, so a secret on the runner would sit
behind the least-reviewed branch (RT 6, LED 1, LAW 3, ENG 8).

Steps, each of which fails loud and stops:
1. **Opt-in, bound to a commit (RT 7, RT-N4, ENG-N6).** The release needs David's yes
   recorded off the branch AND pinned to what he saw: an ANNOTATED tag `ship/YYYY-MM-DD`
   on the exact `next` commit the Saturday digest quoted back to him, whose message
   records that commit and his words. The release fast-forwards `main` to the TAGGED
   commit, and refuses if `origin/next` has moved past it: code he never saw on his phone
   does not ship. No tag, no release, and a ntfy saying so. The session that took his yes
   pushes the tag, so an agent asserts consent; the digest therefore quotes the commit
   range and the yes and the range are the same object. `.release-hold`, pushed to `next`,
   is an additional kill switch; a file written locally counts for nothing.
2. **Provenance, stated honestly.** Every commit in `main..next` has author and committer
   equal to David's git identity. Sessions commit as David, so this is a typo and
   misconfiguration guard, not a security control; the security control is step 1.
3. **Gates on `next`** in a throwaway worktree: `npm ci`, lint, typecheck, tests.
4. **Shell gate (ENG 6).** If any shell file changed between `main` and `next`, `sw.js`'s
   `CACHE_VERSION` on `next` must be higher than on `main`. The pre-commit hook is not
   versioned and not trusted; this gate is. `suggest.js` and `suggest.css` join the hook's
   touch list, and `tests/sw.test.js` grows to pin `vendor/`, `icons/` and the root shell
   entries, because a listed file that does not exist makes `cache.addAll` reject the
   whole install and strands every phone on the old shell while the HTML looks deployed.
5. **Fast-forward to the TAGGED commit** (`ship/<date>^{commit}`), the same ref step 1
   checked (ENG-L3-NEW-5); the server rejects anything that is not a fast-forward. No
   merge commit, no tag-bump commit, ever, on `main` (a commit made outside the hook ships
   an unbumped shell). If a harmless commit landed on `next` after his yes, David re-tags
   (the digest can be re-run in a minute); Sunday never ships what he did not tag.
6. **Tag** `release/YYYY-MM-DD`, recording the shipped `CACHE_VERSION` in the tag message.
7. **Pages build and live verify.** Request the Pages build, wait for it, then fetch the
   live `sw.js` with a cache-buster and require the new version string. Fail loud.
8. **Re-seed** `sandbox` from `main` (the script above), then **notify** David what
   shipped.

**Hotfix rule (ENG 2).** A change may go to `main` midweek only when a live bug blocks the
week he bought for. It branches off `main`, merges to `main`, and then **`main` is merged
into `next`** (never cherry-picked; a cherry-pick makes `main` stop being an ancestor of
`next` and breaks every future fast-forward). The one expected conflict is
`CACHE_VERSION`: take the higher number. David is told before it ships, not after.

**Rollback (ENG 2, RT 9).** `tools/release.ps1 --rollback` (a) prints the tag it returns
to, (b) refuses if `main` holds any commit that is not an ancestor of that tag (a hotfix
would be lost), (c) resets `main` to the tag with `--force-with-lease` (the ONLY sanctioned
force-push in this repo; CLAUDE.md gains that exception in the same commit as the script),
(d) reverts the released range on `next` so the next Sunday does not re-ship the bug, and
(e) bumps `CACHE_VERSION` past the highest number ever shipped (read from the tags), as
a commit on `next` that the next fast-forward carries, never a direct commit on `main`
(ENG-L3-NEW-6); note a rollback to a tag restores the same bytes under the old version,
so the reused-key hazard exists only on the forward path after the rollback. Because heals are
additive and unknown fields survive, an older shell never strands data.

**Worker allowlists (RT 5).** Exactly one literal, `https://mise-next.pages.dev`, is added
to `ALLOWED_ORIGINS`; never a suffix or pattern test (`*.pages.dev` is a public suffix).
`tests/worker-lib.test.js` gains a negative case for a neighbouring `pages.dev` origin.
`ALLOWED_RETURN_ORIGINS` (Kroger OAuth) is left alone unless the sandbox needs cart push.

## People and disclosure (LAW 2, 4, 5; RT 11)

- The roommate is told, once, in one sentence: the shared kitchen data, his allergy flag
  included, now has a second working copy for testing changes before they go live; only
  the same token holders can read it, and it gets copied more often.
- Cloudflare's edge logs request metadata for any Pages origin, as any CDN does. That is
  not a tracker in the sense of the app's CSP rule (nothing runs in the page), and Web
  Analytics stays off; it is written here so the distinction is known.
- This document is committed to the public repo; it names no one but David.

## Options the Parallax round named and where they went

| Option | Verdict |
|---|---|
| Sandbox data on a `sandbox` branch of `mise-data`, not a second repo | Adopted (removes the token step) |
| Sunday merge on GitHub Actions | Deferred: manual and watched first; Actions only for the merge step, never for the re-seed |
| Freeze the bought week's data files against any release step | Adopted as a rule (release touches code only) |
| LAN sandbox from the laptop as a bridge | Dropped: its origin is not in the Worker allowlist, so it is a half-app (ENG 10) |
| David's live install pointed at sandbox data via the existing SYS setting | Subsumed: that setting is how the sandbox install is configured |
| Feature flags instead of a sandbox | Rejected: a broken shell still reaches every phone, and David asked to see builds |
| Env-namespaced single codebase | Rejected: a bug in the switch points live at sandbox data; a second origin isolates without code |
| Ask the roommate to stay off the app during edit windows | Unnecessary once `next` exists |
| Manual "ship it" per session | Subsumed by the Sunday window plus the hotfix rule |
| Build nothing this week, only the pipeline | The pipeline is built FIRST; features ride it only after it has run once |

## What has to exist, in order

1. `next` branch from `main`. Branch protection on `main` is wired only after the first
   manual release has succeeded, so it cannot 403 the very push it exists to allow.
2. On `next`, before the first sandbox deploy (ENG 10): unknown-key passthrough in the
   three normalizers with tests; the data branch in `github.js` (origin first, committed
   meta as the sandbox value, unknown origin refuses writes, `ref` on `contentsUrl`,
   `branch` in the PUT body, branch-exists probe, `writeErrorMessage` branch case) with
   the read-only SYS row; the branch stamp in all three record sites, the unstamped-record
   heal, and the round-trip test; the re-seed heal that refuses over pending writes; the
   annotate-save guard; `suggest.*` in the hook's touch list; `tests/sw.test.js` extended;
   the badged icon set at `tools/icons-next/`. On `main` tonight under the hotfix rule:
   remove the root `deploy` script, commit `.assetsignore`, and the tailoring-loop
   coalescing (then `main` merges into `next`).
3. Worker: branch derived from `Origin`, `x-mise-branch` validated against it (reject on
   disagreement), repo and branch threaded together into the three `gh*` helpers, the
   sandbox origin in `ALLOWED_ORIGINS`, the negative CORS test, one deploy. Then remove the
   client guard.
4. `tools/sandbox-deploy.ps1` (archive, allowlist, refuse list, rename, deploy, verify) and
   the `.assetsignore`; Cloudflare Pages project `mise-next` with production branch `next`.
5. `tools/seed-sandbox-data.ps1` and the `sandbox` branch, seeded.
6. `tools/release.ps1` as specified, including `--rollback`; CLAUDE.md gains the train and
   the force-push exception in the same commit.
7. Phone: install **Mise NEXT** from the stable sandbox origin, paste the same token, SYS
   shows `@ sandbox`. One-time. The roommate gets his one sentence.

## Other apps

Anvil, Bonmot, Grandstand, Tally and Finesse get the same two-branch shape when they next
have a risky change, with a sandbox on Cloudflare Pages under their own names and the
same archive-and-allowlist deploy. They have no bought week to protect, so their release
day is "when the sandbox looks right", not Sunday.

## This week's train (what rides on `next` before Sunday 2026-09-13)

| Day | Build |
|---|---|
| Mon (tonight) | Items 1 to 6 above; sandbox live and checked in the laptop's Chrome; David installs Mise NEXT when he likes |
| Tue | Write coalescing (tailoring loop to one write, autosave debounce); quantity accountant: pack sizes for condiments and dry goods, several rows of one food sum, near-names audited |
| Wed | CHANGE DISH and SWAP WITH on a shared table, protein rotation seeded from pinned nights, the tailoring clobber of a concurrent brigade edit |
| Thu | USE WHAT'S LEFT as one pre-planned slot per week; snacks as bakes (a tray covers days, the list buys one tray) |
| Fri | Order-screenshot import (Instacart, Kroger, Costco) prototyped on the local vision lane, then wired |
| Sat | Kitchen map as tappable 2D zones (if David says yes); sandbox acceptance on his phone; the Saturday digest's pre-flight and his yes |
| Sun | Release by the script, watched. Then David: GENERATE, the ENOUGH pass, BUILD, buy |
