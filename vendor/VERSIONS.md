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
| supabase-js/supabase.esm.js | @supabase/supabase-js | 2.117.3 | dist/umd/supabase.js plus two export lines |

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


## supabase-js (Mise 2.0, worker fix loop 1, item 14)

NOT a devDependency (no new dependency): copied from the npm tarball
`https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-2.117.3.tgz`,
integrity `sha512-K+f8PimXDunPWQ63CKRXaF5pbVPJxmfw5ryAnh0s9S9PkwcuqBjiSpIaqpF7KLDljeYwXIL85ST8QxaO0+XuvA==`.
`dist/umd/supabase.js` is self-contained (an IIFE, no imports); the file here is
that bundle byte for byte, its sha256 in the header, with two `export` lines
appended so it loads as one ES module. MIT, `supabase-js/LICENSE`.
`supabase.esm.d.ts` types only the surface Mise calls. An upgrade repeats the
same steps with David's yes; `tests/vendor-supabase.test.js` re-hashes it.
