# E2E harness for Playwright-MCP sessions

Dev-only. `harness-prelude.js` is NOT a module — it's raw statements (ASCII
only) meant to be concatenated with a scenario body and executed by the
Playwright MCP `browser_run_code` tool, which sandboxes to plain V8 (no
Buffer/URL/require).

Compose a runnable file (scenario must also be ASCII-only — PowerShell
mangles multibyte text):

```powershell
$p = Get-Content tests\e2e\harness-prelude.js -Raw
$s = Get-Content <scenario.js> -Raw   # raw statements using the helpers
$code = "async (page) => {`nconst events = [];`ntry {`n" + $p + "`n" + $s +
  "`n} catch (e) { events.push('FATAL: ' + e.message); try { await cleanupMock(); } catch {} }`nreturn events;`n}"
Set-Content -Encoding Ascii <out.js> -Value $code -NoNewline
```

Then `browser_run_code` with `{ filename: "<out.js>" }`. Requires
`python -m http.server 8378 --directory <repo> --bind 127.0.0.1` running.

Helpers in scope: `events` (push findings), `freshBoot()` (wipe + token +
recipes loaded), `go(hash, ms?)`, `repoFiles` (Map of files the app PUT),
`enc/dec8`, `cleanupMock()`. Call `await cleanupMock()` at scenario end.
