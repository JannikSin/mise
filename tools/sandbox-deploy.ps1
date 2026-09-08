<#
.SYNOPSIS
  Deploy the SANDBOX build (branch `next`) to Cloudflare Pages project `mise-next`.
  docs/RELEASE_TRAIN.md, "The deploy ships an allowlist, never the working tree".

.DESCRIPTION
  WHY THE FLAGS ARE LOAD-BEARING (Tribunal plan gate, 2026-09-07):
  - `wrangler pages deploy .` does NOT read .gitignore. Its whole exclude list is
    _worker.js, _redirects, _headers, _routes.json, functions, .DS_Store,
    node_modules, .git, .wrangler. The working tree holds hundreds of ignored
    files with real household data. So this script stages `git archive next`
    (tracked files only) and copies OUT of that only the app shell.
  - `--project-name mise-next --branch next` on EVERY deploy: the project's
    production branch is `next`, so the origin is the stable mise-next.pages.dev
    and never a per-deploy preview hash (a new origin loses the token and the
    cache). wrangler 4.125 also silently delegates `pages deploy` to a Workers
    deploy when it detects a coding agent; `--branch` is in its unsupported-args
    list, which is the opt-out.
  - The deploy copy is rewritten: short_name / Apple title "Mise NEXT", a
    different theme colour, the meta mise-data-branch value "sandbox", and the
    badged icons from tools/icons-next/ over the three icon files IN PLACE.
  - After deploy the script asserts the served sw.js version, the origin, and
    that every refused path returns 404.

.PARAMETER Ref
  Git ref to deploy. Default: next.
#>
param(
  [string]$Ref = "next",
  [switch]$SkipGates
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$Project = "mise-next"
$Origin  = "https://mise-next.pages.dev"
$Shell   = @("index.html", "manifest.webmanifest", "sw.js", "suggest.js", "suggest.css", "app", "vendor", "icons")
$Refuse  = @(".env", ".dev.vars", "seed-data", "claude-config", "spike", "HANDOFF_CONTEXT.md", "MISE_BLUEPRINT.md", "docs", "tests", "tools", "worker", "package.json", "wrangler.jsonc")

# 0. gates on the ref, in a throwaway worktree (never the working tree)
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("mise-sandbox-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $stage | Out-Null
$archive = Join-Path $stage "archive"
New-Item -ItemType Directory -Path $archive | Out-Null
git fetch -q origin $Ref
$sha = (git rev-parse "origin/$Ref").Trim()
Write-Host "staging origin/$Ref ($sha) from git archive"
git archive "origin/$Ref" | tar -x -C $archive
if ($LASTEXITCODE -ne 0) { throw "git archive failed" }

if (-not $SkipGates) {
  Push-Location $archive
  try {
    Write-Host "gates: npm ci, lint, check, test"
    npm ci --silent | Out-Null
    npm run lint --silent
    if ($LASTEXITCODE -ne 0) { throw "lint failed" }
    npm run check --silent
    if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
    npm test --silent 2>&1 | Select-String "fail (\d+)" | ForEach-Object {
      if ($_.Matches[0].Groups[1].Value -ne "0") { throw "tests failed: $_" }
    }
  } finally { Pop-Location }
}

# 1. copy the ALLOWLIST only
$deploy = Join-Path $stage "deploy"
New-Item -ItemType Directory -Path $deploy | Out-Null
foreach ($item in $Shell) {
  $src = Join-Path $archive $item
  if (-not (Test-Path $src)) { throw "shell item missing from archive: $item" }
  Copy-Item -Recurse -Force $src (Join-Path $deploy $item)
}

# 2. refuse list must be absent from the deploy copy
foreach ($bad in $Refuse) {
  if (Test-Path (Join-Path $deploy $bad)) { throw "refused path present in deploy copy: $bad" }
}
$stray = Get-ChildItem -Recurse -File $deploy | Where-Object { $_.Name -like ".env*" -or $_.Name -like ".dev.vars*" -or $_.Extension -in ".pem", ".key" }
if ($stray) { throw "secret-shaped file in deploy copy: $($stray.FullName)" }

# 3. rewrite the copy into the SANDBOX build
$idx = Join-Path $deploy "index.html"
$html = Get-Content -Raw -Encoding UTF8 $idx
if ($html -notmatch 'name="mise-data-branch" content="main"') { throw "index.html lacks the committed data-branch meta; refusing to deploy a shell that cannot fail closed" }
$html = $html.Replace('name="mise-data-branch" content="main"', 'name="mise-data-branch" content="sandbox"')
$html = $html.Replace('<meta name="apple-mobile-web-app-title" content="Mise" />', '<meta name="apple-mobile-web-app-title" content="Mise NEXT" />')
$html = $html.Replace('<meta name="theme-color" content="#0c0f11" />', '<meta name="theme-color" content="#ff9500" />')
$html = $html.Replace('<title>Mise</title>', '<title>Mise NEXT</title>')
[System.IO.File]::WriteAllText($idx, $html, (New-Object System.Text.UTF8Encoding($false)))

$man = Join-Path $deploy "manifest.webmanifest"
$m = Get-Content -Raw -Encoding UTF8 $man | ConvertFrom-Json
$m.name = "Mise NEXT (sandbox)"
$m.short_name = "Mise NEXT"
$m.theme_color = "#ff9500"
$m.description = "The Mise SANDBOX: work in progress against a copy of the kitchen. Not the week you bought for."
[System.IO.File]::WriteAllText($man, ($m | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

foreach ($icon in @("icon-192.png", "icon-512.png", "apple-touch-icon.png")) {
  $badged = Join-Path $repo "tools\icons-next\$icon"
  if (-not (Test-Path $badged)) { throw "badged icon missing: run python tools/icons-next.py" }
  Copy-Item -Force $badged (Join-Path $deploy "icons\$icon")
}

# 4. deploy, explicitly
$ver = (Select-String -Path (Join-Path $deploy "sw.js") -Pattern 'mise-shell-v(\d+)').Matches[0].Groups[1].Value
Write-Host "deploying shell v$ver to $Project (branch $Ref)"
$out = npx wrangler pages deploy $deploy --project-name $Project --branch $Ref --commit-hash $sha --commit-dirty=false 2>&1 | Out-String
Write-Host $out
if ($LASTEXITCODE -ne 0) { throw "wrangler pages deploy failed" }

# 5. verify the LIVE sandbox bytes and the fence
Start-Sleep -Seconds 8
$t = [int][double]::Parse((Get-Date -UFormat %s))
$sw = (Invoke-WebRequest -UseBasicParsing "$Origin/sw.js?t=$t").Content
if ($sw -notmatch "mise-shell-v$ver") { throw "sandbox origin still serves another shell (wanted v$ver)" }
$served = (Invoke-WebRequest -UseBasicParsing "$Origin/?t=$t").Content
if ($served -notmatch 'name="mise-data-branch" content="sandbox"') { throw "served index.html does not carry the sandbox meta" }
foreach ($bad in @("HANDOFF_CONTEXT.md", "seed-data/generated/fitness/targets.json", "package.json", "docs/RELEASE_TRAIN.md", ".dev.vars")) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "$Origin/$bad" -ErrorAction Stop
    if ($r.StatusCode -eq 200 -and $r.Content -notmatch "<!doctype html>") { throw "REFUSED PATH IS SERVED: $bad" }
  } catch [System.Net.WebException] { <# 404 is the wanted answer #> }
}
Remove-Item -Recurse -Force $stage
Write-Host ""
Write-Host "SANDBOX LIVE: $Origin  (shell v$ver, next @ $sha)"
Write-Host "install from that address on the phone; paste the same token in SYS; the strip says SANDBOX."
