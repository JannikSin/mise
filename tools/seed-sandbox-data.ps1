<#
.SYNOPSIS
  Re-seed the SANDBOX data branch of the private data repo from its main branch.
  docs/RELEASE_TRAIN.md, "Re-seed semantics".

.DESCRIPTION
  The sandbox app (mise-next.pages.dev) reads and writes branch `sandbox` of
  JannikSin/mise-data. This overwrites that branch with a copy of `main` and
  stamps sandbox-seed.json so every sandbox install clears its local cache on
  next load (never silently over unsaved writes; the app asks).

  GUARDS (Tribunal plan gate, 2026-09-07): the destination ref is hard-coded
  and asserted, the push is --force-with-lease, and -Confirm is required. This
  is the one step in the train that destroys data (sandbox data, by design),
  and a transposed refspec is how the LIVE kitchen would be destroyed instead.
  It runs on the laptop only; never on a CI runner with a stored token.

.PARAMETER Confirm
  Required. Without it the script prints what it would do and exits.
#>
param(
  [switch]$Confirm,
  [string]$DataRepo = "C:\Users\DATar\Projects\mise-data"
)
$ErrorActionPreference = "Stop"
$Dest = "sandbox"
if ($Dest -ne "sandbox") { throw "destination ref is not sandbox: refusing" }
Set-Location $DataRepo
git fetch -q origin
$mainSha = (git rev-parse origin/main).Trim()
Write-Host "mise-data main = $mainSha"
if (-not $Confirm) {
  Write-Host "DRY RUN. Would force-push origin/main -> origin/$Dest and stamp sandbox-seed.json. Re-run with -Confirm."
  exit 0
}
# a throwaway worktree so the live clone's checkout is never touched
$wt = Join-Path ([System.IO.Path]::GetTempPath()) ("mise-data-seed-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
git worktree add -q --detach $wt $mainSha
try {
  Push-Location $wt
  $stamp = @{ seededAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); fromCommit = $mainSha } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $wt "sandbox-seed.json"), $stamp + "`n", (New-Object System.Text.UTF8Encoding($false)))
  git add sandbox-seed.json
  git -c user.name="mise release train" -c user.email="mise-train@local" commit -q -m "sandbox re-seeded from main $($mainSha.Substring(0,7))"
  $seedSha = (git rev-parse HEAD).Trim()
  if ($Dest -ne "sandbox") { throw "destination ref changed: refusing" }
  git push --force-with-lease "origin" "${seedSha}:refs/heads/$Dest"
  if ($LASTEXITCODE -ne 0) { throw "push failed" }
  Write-Host "origin/$Dest <- $seedSha (main $($mainSha.Substring(0,7)) + seed stamp)"
  Write-Host $stamp
} finally {
  Pop-Location
  git worktree remove --force $wt
}
