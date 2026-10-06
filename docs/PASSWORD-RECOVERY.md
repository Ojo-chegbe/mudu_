# Connected account password recovery

Candidates and administrators select **Forgot your password?**, enter their connected account email, open the email, choose and confirm a new password, then return to connected sign-in. The flow keeps existing identities, registrations, papers, attempts and answers. It does not create, connect or merge accounts.

## Supabase activation

1. In Supabase Authentication → Email Templates → Reset Password, replace the template with `supabase/templates/recovery.html`. Its link uses `{{ .RedirectTo }}#token_hash={{ .TokenHash }}`. Do not use the default `ConfirmationURL`: MUDU verifies recovery proofs on the server, without exposing provider sessions to the browser.
2. Allow the exact application recovery URLs in Authentication → URL Configuration. For local development allow `http://127.0.0.1:5173/account/recovery?role=admin` and `http://127.0.0.1:5173/account/recovery?role=candidate`; built Host uses port 4310. Add both roles at your production HTTPS origin. Configure the public service origin correctly. No user-supplied redirect is accepted.
3. Configure production SMTP, recovery-token expiry, and password policy. Enable password-change notification emails. Confirm delivery for a real administrator and candidate on the deployed service, including opening the email on another browser/device.

No live Supabase settings are changed by this code. No SQL migration is required in Supabase. The Host migrates SQLite to schema 18 with its normal pre-upgrade backup.

## Boundaries and recovery behavior

- The response does not disclose whether an email exists. Requests are throttled by network address and normalized email. No local database account lookup gates email delivery.
- The email proof is in the URL fragment, removed from browser history when the page loads, and never placed in browser storage. The proof is consumed only when the user submits their new password, so merely opening the link does not consume it. Refreshing before this step requires reopening the email link.
- Supabase verifies the proof specifically as `recovery`. A normal application sign-in session cannot authorize a password reset.
- The verified grant is a separate HttpOnly/SameSite cookie scoped to recovery endpoints, with CSRF protection and a maximum ten-minute lifetime. Provider credentials are encrypted in SQLite with purpose-separated authentication. Grants survive Host restart and have no examination/workspace privileges.
- Submitting a verified reset revokes this Host's sessions for both explicit provider bindings before the provider mutation, so a crash cannot restore old local sessions. Separate local password verifiers stay unchanged. Completion clears encrypted recovery credentials and retains a short-lived receipt so a lost response can be safely retried. Concurrent changes are claimed atomically. A process interruption or uncertain provider response does not silently replay a change: try the new password or request a new link.
- Provider password changes invalidate other provider refresh sessions; MUDU also requests global provider sign-out. Other Hosts may still accept already-issued access tokens until expiry. Already prepared offline admission files remain governed by their existing run/recovery controls.
- Local-only accounts do not have verified email ownership. Email recovery cannot authorize replacing their passwords. Connected users can recover their cloud password and use connected sign-in; separate local Host passwords remain unchanged. Recovery is unavailable on the offline candidate listener or replica.

## Verification

Run `npm run check` and `npm run build`. Regression tests exercise neutral responses, throttling, redirect allowlisting, recovery-only proof verification, CSRF/cookie isolation, encrypted grants, expiry, replay, concurrent completion, provider rejection, interrupted changes, session revocation and preservation of records.

The provider API and email-template approach follow [Supabase's email-template documentation](https://supabase.com/docs/guides/auth/auth-email-templates) and [password authentication guide](https://supabase.com/docs/guides/auth/passwords). Live email delivery and project configuration require an actual deployed service check.
