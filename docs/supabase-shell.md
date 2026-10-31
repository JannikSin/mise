# The Supabase shell (Mise 2.0)

The same app code boots either backend. Which one is decided by the SHELL (the served
`index.html`), never by a setting on the phone:

- **No meta** (every 1.9x shell, and `index.html` as committed): GitHub, exactly as 1.95.
  `app/lib/supabase-boot.js` and `vendor/supabase-js/` are never loaded.
- **`<meta name="mise-backend" content="supabase">`** in `<head>`: Supabase, on the project
  the origin owns (`app/lib/backend/config.js` `supabaseProject()`: the live origin gets the
  live project, `https://mise-next.pages.dev` the sandbox project).

## What a Supabase shell needs, before it is deployed

1. **The project config committed** in `app/lib/backend/config.js`: the real project URL and
   publishable key in place of the placeholders (both public by design). While a placeholder
   is there, the gate says "Sign-in is not set up on this version yet" and nothing is called.
2. **The meta**, added to the shell's `<head>`:
   `<meta name="mise-backend" content="supabase">`. The sandbox gets it first (plan step 12);
   the live shell on the switch morning.
3. **The CSP**: the shell's `connect-src` must add the project's origin,
   `https://<ref>.supabase.co`, or every sign-in request is blocked by the browser.
4. **The move freeze**, only on the switch morning's shell:
   `<meta name="mise-move" content="on">` (shows the admin's freeze control in Settings).
5. **Email templates and redirect allowlist** per project: `supabase/email-templates/README.md`.

## Boot order on a Supabase shell (`app/main.js`, render block)

1. `authGateWanted` decides from the hash and THIS project's stored session
   (`sb-<ref>-auth-token`): an invite or reset link opens SET PASSWORD, no session opens
   SIGN IN, a guest link stays on the guest flow.
2. `startSupabase()` (dynamic import) makes the one client (URL detection off: only the SET
   PASSWORD tap spends a token), hands the gate its auth client, and builds the session boot
   over the real store. SWITCH PROFILE stays hidden until whoami has answered.
3. With a stored session, `boot()` runs BEFORE the app renders: locked backend, whoami, the
   store's `onSessionChange`, the Supabase adapter, then the flush. A dead session or a removed
   account goes back to SIGN IN with a plain line (`gateAfterBoot`); no signal opens the cached
   app. A network slower than 4 s renders the cached app and still routes a late answer to the
   gate.
