<#
.SYNOPSIS
  The Sunday release: fast-forward the LIVE branch (main) to the commit David's yes
  tagged, verify the live host, re-seed the sandbox data branch. Or roll it back.
  docs/RELEASE_TRAIN.md, "The release, exactly" and "Rollback".

.DESCRIPTION
  Every step fails loud and stops. Nothing here writes a data file except the re-seed
  of the SANDBOX branch, which is a copy of live by design.

  FORWARD (default):
   1. Consent, bound to a commit: an ANNOTATED tag ship/YYYY-MM-DD must exist on
      origin. Its commit is what ships. If origin/next has moved past it, refuse:
      code David never saw on his phone does not ship. A .release-hold file in the
      tagged tree is a kill switch.
   2. Provenance: every commit in origin/main..ship is authored and committed by the
      repo's git identity (a typo guard, not a security control; step 1 is that).
   3. Gates in the WORKING TREE, which must sit at the tagged commit with no dirty
      shell file: lint, typecheck, tests. (The live-bank tests read seed-data/,
      which is gitignored, so a throwaway archive cannot run them.)
   4. Shell gate: if any shell file differs between main and the tag, the tag's
      CACHE_VERSION must be higher than main's. The pre-commit hook is not
      versioned and not trusted; this gate is.
   5. Fast-forward: push the tagged commit to refs/heads/main. Never a merge commit,
      never a force. The server rejects anything that is not a fast-forward.
   6. Tag release/YYYY-MM-DD (annotated, records the shipped CACHE_VERSION), push it.
   7. Request the Pages build, wait for it to build the tagged commit, then fetch the
      live sw.js with a cache-buster and require the new version string, and the
      live index.html and require the data-branch meta to read main.
   8. Re-seed the sandbox data branch from live (tools/seed-sandbox-data.ps1 -Confirm).

  ROLLBACK (-Rollback -To release/YYYY-MM-DD):
   a. prints the tag it returns to;
   b. refuses if main holds any commit that is not an ancestor of that tag (a hotfix
      would be lost);
   c. resets main to the tag with --force-with-lease, the ONLY sanctioned force-push
      in this repo (CLAUDE.md);
   d. reverts the rolled-back range on next so the next Sunday does not re-ship it;
   e. bumps CACHE_VERSION on next past the highest number ever shipped (read from the
      release/ tags and sw.js), as a commit on next that the next fast-forward carries.

.PARAMETER Confirm
  Required for anything that pushes. Without it the script runs every check and prints
  what it would do.

.PARAMETER Tag
  The ship tag to release. Default: ship/<today>.

.PARAMETER SkipGates
  Skip lint/typecheck/tests (they were run seconds ago by hand, say). Everything else
  still runs.

.PARAMETER SkipSeed
  Do not re-seed the sandbox data branch after the release.

.PARAMETER Rollback
  Roll main back to the release tag named by -To.
#>
param(
  [switch]$Confirm,
  [string]$Tag = "",
  [switch]$SkipGates,
  [switch]$SkipSeed,
  [switch]$Rollback,
  [string]$To = ""
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$Live     = "main"
$Sandbox  = "next"
$LiveUrl  = "https://janniksin.github.io/mise"
$GhRepo   = "JannikSin/mise"
$Shell    = @("index.html", "manifest.webmanifest", "sw.js", "suggest.js", "suggest.css", "app", "vendor", "icons")
$today    = (Get-Date).ToString("yyyy-MM-dd")

function Fail([string]$msg) { Write-Host "RELEASE STOPPED: $msg" -ForegroundColor Red; exit 1 }
function Sha([string]$ref) {
  $s = (git rev-parse --verify --quiet "$ref^{commit}")
  if ($LASTEXITCODE -ne 0 -or -not $s) { Fail "cannot resolve $ref" }
  return $s.Trim()
}
function SwVersion([string]$ref) {
  $sw = (git show "${ref}:sw.js") -join "`n"
  $mt = [regex]::Match($sw, 'const CACHE_VERSION = "mise-shell-v(\d+)"')
  if (-not $mt.Success) { Fail "no CACHE_VERSION marker in ${ref}:sw.js" }
  return [int]$mt.Groups[1].Value
}
function HighestShippedVersion() {
  $max = 0
  foreach ($t in (git tag --list "release/*")) {
    $msg = (git tag -l --format='%(contents)' $t) -join "`n"
    $mt = [regex]::Match($msg, 'mise-shell-v(\d+)')
    if ($mt.Success -and [int]$mt.Groups[1].Value -gt $max) { $max = [int]$mt.Groups[1].Value }
  }
  return $max
}

git fetch -q origin "+refs/heads/${Live}:refs/remotes/origin/${Live}" "+refs/heads/${Sandbox}:refs/remotes/origin/${Sandbox}"
git fetch -q origin --tags
$mainSha = Sha "origin/$Live"
$nextSha = Sha "origin/$Sandbox"

# ---------------------------------------------------------------- ROLLBACK
if ($Rollback) {
  if (-not $To) { Fail "-Rollback needs -To release/YYYY-MM-DD" }
  if ($To -notmatch '^release/\d{4}-\d{2}-\d{2}$') { Fail "-To must name a release/ tag" }
  if ((git cat-file -t $To) -ne "tag") { Fail "$To is not an annotated tag on this clone (fetch tags?)" }
  $toSha = Sha $To
  Write-Host "(a) rollback target: $To = $toSha (shell v$(SwVersion $toSha))"
  Write-Host "    main is at        $mainSha (shell v$(SwVersion $mainSha))"
  if ($toSha -eq $mainSha) { Fail "main already sits at $To; nothing to roll back" }
  # (b) every commit on main must be an ancestor of the tag, or a hotfix would be lost
  $lost = git rev-list "${toSha}..${mainSha}"
  $lostNotOnNext = @()
  foreach ($c in $lost) {
    git merge-base --is-ancestor $c $nextSha
    if ($LASTEXITCODE -ne 0) { $lostNotOnNext += $c }
  }
  if ($lostNotOnNext.Count -gt 0) {
    Fail "main holds commits that are not on next and would be lost by the rollback (a hotfix?): $($lostNotOnNext -join ', ')"
  }
  git merge-base --is-ancestor $toSha $mainSha
  if ($LASTEXITCODE -ne 0) { Fail "$To is not an ancestor of main; refusing a rollback across unrelated history" }
  $highest = [Math]::Max((HighestShippedVersion), (SwVersion $nextSha))
  $bumpTo = $highest + 1
  Write-Host "(c) would force-with-lease main: $mainSha -> $toSha"
  Write-Host "(d) would revert $($lost.Count) commit(s) on next: $To..main"
  Write-Host "(e) would bump CACHE_VERSION on next to v$bumpTo (highest ever shipped or on next: v$highest)"
  if (-not $Confirm) { Write-Host "DRY RUN. Re-run with -Confirm."; exit 0 }

  git push "--force-with-lease=refs/heads/${Live}:${mainSha}" origin "${toSha}:refs/heads/${Live}"
  if ($LASTEXITCODE -ne 0) { Fail "force-with-lease push of main failed" }
  Write-Host "(c) main <- $toSha"

  # (d)+(e) on next, in a throwaway worktree so the working tree is never touched
  $wt = Join-Path ([System.IO.Path]::GetTempPath()) ("mise-rollback-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  git worktree add -q $wt $nextSha
  try {
    Push-Location $wt
    git checkout -q -B $Sandbox $nextSha
    git revert --no-edit "${toSha}..${mainSha}"
    if ($LASTEXITCODE -ne 0) { Fail "revert on next hit a conflict in $wt; resolve it there, commit, push next, and bump CACHE_VERSION to v$bumpTo by hand" }
    $swPath = Join-Path $wt "sw.js"
    $sw = [System.IO.File]::ReadAllText($swPath)
    $sw = [regex]::Replace($sw, 'const CACHE_VERSION = "mise-shell-v\d+"', "const CACHE_VERSION = `"mise-shell-v$bumpTo`"")
    [System.IO.File]::WriteAllText($swPath, $sw, (New-Object System.Text.UTF8Encoding($false)))
    git add sw.js
    git commit -q -m "Rollback of $To..$($mainSha.Substring(0,7)): CACHE_VERSION to v$bumpTo, past the highest ever shipped (release train, rollback step e)"
    git push origin "${Sandbox}:refs/heads/${Sandbox}"
    if ($LASTEXITCODE -ne 0) { Fail "push of next failed after the revert; the worktree is at $wt" }
    Write-Host "(d)(e) next <- reverted range + CACHE_VERSION v$bumpTo"
  } finally {
    Pop-Location
    git worktree remove --force $wt
  }
  git branch -f $Sandbox origin/$Sandbox
  Write-Host "ROLLED BACK. Request the Pages build and verify the live sw.js reads v$(SwVersion $toSha):"
  Write-Host "  gh api repos/$GhRepo/pages/builds -X POST"
  exit 0
}

# ---------------------------------------------------------------- FORWARD
if (-not $Tag) { $Tag = "ship/$today" }
if ($Tag -notmatch '^ship/\d{4}-\d{2}-\d{2}$') { Fail "the ship tag must be ship/YYYY-MM-DD, got $Tag" }
$date = $Tag.Substring(5)

# 1. consent: an annotated tag on ORIGIN, at the tip of origin/next
$remoteTag = (git ls-remote --tags origin "refs/tags/$Tag") -split "\s+"
if (-not $remoteTag -or -not $remoteTag[0]) { Fail "no $Tag on origin. No tag, no release: the yes is recorded as a pushed annotated tag" }
if ((git cat-file -t $Tag) -ne "tag") { Fail "$Tag is a lightweight tag; the yes is an ANNOTATED tag whose message records the commit and David's words" }
$shipSha = Sha $Tag
if ($shipSha -ne $nextSha) {
  Fail "origin/next ($($nextSha.Substring(0,7))) has moved past $Tag ($($shipSha.Substring(0,7))). Code he never saw does not ship: re-tag or stop"
}
git merge-base --is-ancestor $mainSha $shipSha
if ($LASTEXITCODE -ne 0) { Fail "main is not an ancestor of $Tag; a fast-forward is impossible (a cherry-pick or a commit straight on main?)" }
$hold = git ls-tree --name-only $shipSha -- .release-hold
if ($hold) { Fail ".release-hold is committed on the tagged tree; the kill switch is set" }
if ($shipSha -eq $mainSha) { Fail "main already sits at $Tag; nothing to release" }
$tagMsg = (git tag -l --format='%(contents)' $Tag) -join "`n"
Write-Host "1. $Tag = $shipSha (tip of origin/next)"
Write-Host "   tag message: $($tagMsg.Trim() -replace "`n", ' / ')"

# 2. provenance
$ident = "$(git config user.name)|$(git config user.email)"
$bad = git log --format='%h %an|%ae %cn|%ce' "${mainSha}..${shipSha}" | Where-Object { $_ -notmatch [regex]::Escape($ident) -or ($_ -split ' ')[1] -ne ($_ -split ' ')[2] }
if ($bad) { Fail "commits not authored+committed by $ident :`n$($bad -join "`n")" }
$count = (git rev-list --count "${mainSha}..${shipSha}")
Write-Host "2. $count commit(s) main..$Tag, all by $ident"

# 3. gates in the working tree at the tagged commit
if (-not $SkipGates) {
  $head = (git rev-parse HEAD).Trim()
  if ($head -ne $shipSha) { Fail "working tree is at $($head.Substring(0,7)), $Tag is $($shipSha.Substring(0,7)); check out next and pull first" }
  $dirty = git status --porcelain -- $Shell
  if ($dirty) { Fail "uncommitted shell changes in the working tree:`n$dirty" }
  Write-Host "3. gates: lint, check, test (working tree @ $($shipSha.Substring(0,7)))"
  npm run lint --silent
  if ($LASTEXITCODE -ne 0) { Fail "lint failed" }
  npm run check --silent
  if ($LASTEXITCODE -ne 0) { Fail "typecheck failed" }
  $testOut = npm test --silent 2>&1 | Out-String
  if ($testOut -notmatch "fail 0") { Fail "tests failed:`n$($testOut.Substring([Math]::Max(0, $testOut.Length - 1500)))" }
  Write-Host "   gates green"
} else { Write-Host "3. gates SKIPPED by flag" }

# 4. shell gate
$vMain = SwVersion $mainSha
$vShip = SwVersion $shipSha
$shellChanged = git diff --name-only $mainSha $shipSha -- $Shell
if ($shellChanged -and $vShip -le $vMain) {
  Fail "shell files changed but CACHE_VERSION did not move (main v$vMain, $Tag v$vShip):`n$($shellChanged -join "`n")"
}
Write-Host "4. shell: v$vMain -> v$vShip ($(@($shellChanged).Count) shell file(s) changed)"

if (-not $Confirm) {
  Write-Host ""
  Write-Host "DRY RUN. Would: push $($shipSha.Substring(0,7)) -> origin/$Live (fast-forward), tag release/$date, build Pages, verify $LiveUrl serves v$vShip$(if (-not $SkipSeed) { ', re-seed sandbox from live' })."
  Write-Host "Re-run with -Confirm."
  exit 0
}

# 5. fast-forward, never a merge, never a force
git push origin "${shipSha}:refs/heads/${Live}"
if ($LASTEXITCODE -ne 0) { Fail "push to $Live was rejected (not a fast-forward?)" }
git fetch -q origin "+refs/heads/${Live}:refs/remotes/origin/${Live}"
git branch -f $Live "origin/$Live"
Write-Host "5. origin/$Live <- $shipSha"

# 6. release tag
$relTag = "release/$date"
if (git tag --list $relTag) { $relTag = "release/$date-$((Get-Date).ToString('HHmm'))" }
git tag -a $relTag $shipSha -m "Release ${date}: $Tag ($($shipSha.Substring(0,7))) fast-forwarded to $Live. Shipped CACHE_VERSION mise-shell-v$vShip (live was v$vMain)."
git push -q origin "refs/tags/$relTag"
if ($LASTEXITCODE -ne 0) { Fail "could not push $relTag" }
Write-Host "6. tagged $relTag"

# 7. Pages build + live verify
gh api "repos/$GhRepo/pages/builds" -X POST --silent
$deadline = (Get-Date).AddMinutes(6)
$built = $false
do {
  Start-Sleep -Seconds 15
  $b = gh api "repos/$GhRepo/pages/builds/latest" --jq '[.status, .commit] | @tsv'
  $parts = $b -split "`t"
  Write-Host "   pages: $($parts[0]) @ $($parts[1].Substring(0,7))"
  if ($parts[0] -eq "built" -and $parts[1] -eq $shipSha) { $built = $true }
  if ($parts[0] -eq "errored") { Fail "Pages build errored" }
} while (-not $built -and (Get-Date) -lt $deadline)
if (-not $built) { Fail "Pages did not report a build of $($shipSha.Substring(0,7)) within 6 minutes; check gh api repos/$GhRepo/pages/builds/latest" }
$live = $false
for ($i = 0; $i -lt 12 -and -not $live; $i++) {
  Start-Sleep -Seconds 10
  $t = Get-Random
  $sw = (Invoke-WebRequest -UseBasicParsing "$LiveUrl/sw.js?cb=$t").Content
  if ($sw -match "mise-shell-v$vShip`"") { $live = $true }
}
if (-not $live) { Fail "$LiveUrl/sw.js still does not serve v$vShip after the build reported done" }
$idx = (Invoke-WebRequest -UseBasicParsing "$LiveUrl/?cb=$(Get-Random)").Content
if ($idx -notmatch 'name="mise-data-branch" content="main"') { Fail "live index.html does not carry the data-branch meta reading main" }
Write-Host "7. LIVE: $LiveUrl serves shell v$vShip, data branch main"

# 8. re-seed the sandbox data branch from live
if (-not $SkipSeed) {
  & (Join-Path $PSScriptRoot "seed-sandbox-data.ps1") -Confirm
  if ($LASTEXITCODE -ne 0) { Fail "sandbox re-seed failed (the release itself is live)" }
  Write-Host "8. sandbox data re-seeded from live"
} else { Write-Host "8. re-seed SKIPPED by flag" }

Write-Host ""
Write-Host "RELEASED ${relTag}: $Live @ $($shipSha.Substring(0,7)), shell v$vMain -> v$vShip, $count commit(s)."
Write-Host "On the phone: fully close and reopen Mise; SYS must show v$vShip."
