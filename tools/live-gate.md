# Mise 2.0 live gate (db fix loop 3, item 5)

The one gate before the live run. The PGlite stand-in proves the policies and
the writer, but it is a superuser database with fake roles. This gate proves on
a real Supabase stack what the stand-in cannot. Never the live project: run it
on the local Docker stack or on the sandbox project, then tear it down.

## What it proves

| Check | Why the stand-in cannot prove it |
|---|---|
| auth.users trigger links a confirmed account | Supabase limits what `postgres` may change in `auth`; the trigger is believed allowed but unverified |
| a failing link_pending aborts the account | the account must not exist half-made when the link fails |
| seed present (svc answers the secret key) | the `svc` schema must be in the exposed schemas, with usage for `service_role` |
| svc refused to the publishable key | ... and nobody else |
| svc refused to a signed-in user | ... and nobody else |
| write_doc create and update (rev 1, rev 2) | the writer through PostgREST, as the phones will call it |
| P0409 a stale rev | the code must reach the client as `error.code` (PostgREST answers HTTP 400) |
| P0409 a create over a row | same |
| P0403 another house | same |
| P0403 a house that does not exist | the same answer as another house (fix loop 3, E3) |
| P0422 a hidden word | same |
| direct insert into docs refused | the revoked grant on the real platform (fix loop 3, E3) |
| plate_for a housemate | the plate reaches a housemate |
| plate_for null for another house | and nobody outside the house |
| global execute revoke: a later function is not anon's | `alter default privileges` must hold against Supabase's own generous defaults |
| global execute revoke: a later function is not authenticated's | same |
| write_doc not executable by the publishable key | anon can call no client function |

## Steps

1. A fresh stack. Local: `supabase start`, then `supabase db reset` (it applies
   `supabase/migrations/` in name order). Sandbox: paste each file of
   `supabase/migrations/` into the SQL Editor in name order, on an EMPTY
   sandbox (before the sandbox migration, or after a reset).
2. Paste `tools/live-gate-seed.sql` (made-up people `gate-a1`, `gate-a2`,
   `gate-b1`, `gate-abort` in two made-up houses, a hidden word, a constraint
   that makes `gate-abort`'s link fail, and a function made after the
   migrations).
3. In the terminal, with the two keys for THIS run only (never committed, never
   in a file):

   ```
   MISE_GATE_SECRET_KEY=<secret or service_role key> MISE_GATE_PUBLISHABLE_KEY=<publishable or anon key> node tools/live-gate.mjs --url <http://127.0.0.1:54321 or https://<ref>.supabase.co>
   ```

   It refuses without `--url` (there is no default) and without both keys. It
   prints one line per check and `gate passed: 17 checks`, or `GATE FAILED`.
   Optional: `--invite-email <an address you read>` sends one real invite
   (built-in mail allows two an hour); check by hand that the account is
   unconfirmed and linked to no profile until the link is used.
4. Paste `tools/live-gate-teardown.sql`, pass or fail.

## If a check fails

Stop: the live run waits. The line says which check and the HTTP status and
code it got. `svc` checks: the exposed schemas setting (API settings, add
`svc`). The trigger checks: whether `postgres` may create triggers on
`auth.users` on this platform version. The execute revoke checks: run
`alter default privileges in schema public revoke execute on functions from anon, authenticated;`
again as the role that will create functions, then re-run the gate.

## How it talks

Plain HTTP, the same requests supabase-js sends: `POST /rest/v1/rpc/<fn>`
(the `Content-Profile: svc` header for svc), `POST /rest/v1/docs`,
`/auth/v1/admin/users` and `/auth/v1/token?grant_type=password`. So it needs
no package. Never the live project.

`tests/live-gate.test.js` runs this same script against the PGlite stand-in
through a small fake of PostgREST and Auth, with one broken stack per check,
so the checks are known to pass on a right stack and fail on a wrong one.
