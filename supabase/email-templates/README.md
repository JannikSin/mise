# Supabase email templates and redirect allowlist (Mise 2.0, plan section 7 step 6)

Paste these into each project (live `mise` and `mise-sandbox`) under
Authentication > Emails. Both bodies link to the app with the token HASH, never
`{{ .ConfirmationURL }}`: the app's SET PASSWORD screen spends the token only when the
person taps the button, so a mail scanner that opens the link spends nothing.

| Template | File | Subject |
|---|---|---|
| Invite user | `invite.html` | You are invited to a Mise kitchen |
| Reset password | `recovery.html` | Reset your Mise password |

Both build `{{ .SiteURL }}#/set-password?token_hash={{ .TokenHash }}&type=invite` (or
`&type=recovery`). `tests/email-templates.test.js` checks that the app reads exactly that link.

## URL configuration (Authentication > URL Configuration), EXACT values

Site URL and the Redirect URLs allowlist hold one exact URL per project, with no wildcard,
no other path and no localhost entry:

| Project | Site URL | Redirect URLs (the whole list) |
|---|---|---|
| `mise` (live) | `https://janniksin.github.io/mise/` | `https://janniksin.github.io/mise/` |
| `mise-sandbox` | `https://mise-next.pages.dev/` | `https://mise-next.pages.dev/` |

The Site URL ends in `/`, so the email link becomes `https://janniksin.github.io/mise/#/set-password?...`.
The app's reset request sends `redirectTo` as the page it was opened on, without `index.html`,
which is the same URL. A wildcard such as `https://janniksin.github.io/**` is never added: that
origin hosts several apps, and any of them could then receive a sign-in link.
