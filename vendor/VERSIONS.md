# Vendored libraries — version manifest

Vendored files are NEVER edited in place. To upgrade: get David's approval,
bump the pinned devDependency in package.json, re-copy from node_modules,
update this manifest. The devDependency copies of preact/htm exist ONLY as
(a) the copy source for these files and (b) types for `tsc --checkJs`.
They must always match the versions below.

| File | Package | Version | Source in package |
|---|---|---|---|
| preact/preact.module.js | preact | 10.29.4 | dist/preact.module.js |
| preact/hooks.module.js | preact | 10.29.4 | hooks/dist/hooks.module.js |
| htm/htm.module.js | htm | 3.1.1 | dist/htm.module.js |
| htm/preact.module.js | htm | 3.1.1 | preact/index.module.js |

Note: hooks.module.js contains a bare `import ... from "preact"` — the app's
index.html must serve an import map resolving "preact", "preact/hooks" and
"htm" to these files.


## Fonts (vendor/fonts/)

Variable woff2, latin subset, fetched 2026-07-06 from Google Fonts (css2 API).
Both licensed under the SIL Open Font License 1.1.

| File | Family | Axis | License |
|---|---|---|---|
| fonts/archivo-var.woff2 | Archivo | wght 100-900 (variable) | OFL 1.1 |
| fonts/jetbrains-mono-var.woff2 | JetBrains Mono | wght 100-800 (variable) | OFL 1.1 |
