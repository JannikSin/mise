# Repair mise-worker's Kroger secrets (found corrupted 2026-08-30, session
# monolith: every /kroger/* call died inside the Worker with "btoa() can only
# operate on characters in the Latin1 range" while minting the Kroger token,
# which means the deployed KROGER_CLIENT_ID/SECRET hold a non-Latin1
# character — a mangled paste. BUILD's self-pricing has never worked through
# the Worker because of it.)
#
# Parses client_id/client_secret from the Kroger registration PDF (same
# source as tools/kroger_price.py), re-uploads both via wrangler, then
# verifies with ONE live search (1 rate unit). Values never echo.
#
# Run:  powershell -File C:\Users\DATar\Projects\mise\tools\fix-worker-kroger.ps1

$ErrorActionPreference = "Stop"

$creds = python -c @'
import re, pdfplumber
t = ''.join((p.extract_text() or '') + '\n' for p in pdfplumber.open(r'C:\Users\DATar\Downloads\App Registration Details _ Kroger Developers.pdf').pages)
cid = csec = None
for l in (x.strip() for x in t.splitlines()):
    m = re.match(r'^client_id\s+(\S+)$', l, re.I)
    cid = m.group(1) if m else cid
    m = re.match(r'^client_secret\s+(\S+)$', l, re.I)
    csec = m.group(1) if m else csec
print(cid); print(csec)
'@
if (-not $creds -or $creds.Count -lt 2 -or $creds[0] -eq "None") { throw "could not parse creds from the Kroger PDF" }
$cid = $creds[0]; $csec = $creds[1]
# the whole bug was a non-ASCII byte in a secret: refuse to upload another one
if ($cid -notmatch '^[\x21-\x7e]+$' -or $csec -notmatch '^[\x21-\x7e]+$') { throw "parsed creds contain non-ASCII characters; aborting" }

Set-Location C:\Users\DATar\Projects\mise\worker
# pipe as plain ASCII; wrangler trims the trailing newline
$OutputEncoding = [System.Text.Encoding]::ASCII
$cid | npx wrangler secret put KROGER_CLIENT_ID --config wrangler.toml
if (-not $?) { throw "wrangler put KROGER_CLIENT_ID failed" }
$csec | npx wrangler secret put KROGER_CLIENT_SECRET --config wrangler.toml
if (-not $?) { throw "wrangler put KROGER_CLIENT_SECRET failed" }
Write-Host "secrets re-uploaded. Verifying with one live search (1 rate unit)..."

$fill = "protocol=https`nhost=github.com`n`n" | git credential fill
$pat = (($fill | Select-String "^password=").Line) -replace "^password=", ""
if (-not $pat) { throw "no GitHub credential available for the verify call; open the app and tap BUILD instead" }
$r = Invoke-RestMethod -Method Post -Uri "https://mise-worker.janniksin.workers.dev/kroger/search" `
  -Headers @{ "x-mise-auth" = $pat; "origin" = "https://janniksin.github.io" } `
  -ContentType "application/json" -Body '{"term":"bananas","locationId":"02100824","limit":3}'
Write-Host ("VERIFIED: worker returned " + $r.products.Count + " products for 'bananas' at Pay Less. BUILD pricing works now.")
