# Administrator accounts and private workspaces

## Configure

In the project-root `.env`, set `MUDU_SUPABASE_URL` and
`MUDU_SUPABASE_PUBLISHABLE_KEY` using the project's HTTPS URL and publishable key.
The legacy `anon` key is also supported. Never use a secret/service-role key or
a `VITE_` prefix. Restart `npm run dev` or `npm start` after changing configuration.

In Supabase Authentication, enable email/password signup and email confirmation.
Configure the Site URL and allowed redirect URLs for the application address used
by administrators. For local development, use `http://127.0.0.1:5173`; built Host
access uses `http://127.0.0.1:4310`. The confirmation email returns to that address;
users then sign in normally. Configure production SMTP before wider signup;
provider email quotas and restrictions still apply. Connected accounts have
[password recovery](PASSWORD-RECOVERY.md), with a required recovery email template and redirect configuration.

`npm run check:supabase` performs a read-only connectivity/settings check without
printing credentials or creating users. This does not replace testing delivery of
the confirmation email and a real user sign-in.

## Use

Prepared local delivery now has a separate activation migration and workflow. See
[Local preparation](LOCAL-PREPARATION.md). A ready run remains independent of
Supabase and internet; cloud examination execution is not implemented by that feature.

- Create an administrator account, confirm its email, then sign in. Each account
  receives a separate workspace. Candidate accounts are unchanged.
- To keep an existing workspace, choose **Use this computer's local Host account**,
  sign in with the existing Host password, then choose **Connect account**. Choose
  **Create an account** to register directly in the dialog, or **I already have an
  account** to sign in. Supply the current Host password to authorize connecting.
  New registrations requiring email confirmation leave the local session and
  workspace unchanged. Confirm the email, return to the dialog and sign in to
  finish connecting. No separate empty workspace is created by this flow.
- Connection preserves the original administrator ID and records. Accounts are
  never merged merely because their emails match. A cloud account already owning
  another populated workspace cannot absorb the local workspace. An empty cloud
  workspace may be replaced by the explicitly selected local one.
- The existing local Host password continues to work without internet. Cloud
  sign-in and cloud-authenticated administrator requests require Supabase access.
  The offline candidate listener never depends on Supabase authentication.
- Only the original local Host operator can change the computer's network delivery
  settings. New administrators cannot operate or stop another user's local network.

## Security and migration

The server verifies provider identities, confirmed email and refresh tokens through
Supabase Auth. Browser-provided roles and owner IDs cannot select a workspace.
Assessment access is checked before detail, editing, rerun, grading, results export,
monitoring and live-control operations. Rosters, question-bank resources, candidate
directories and notifications are scoped to the authenticated administrator.
Unauthorized resource IDs return not found. One candidate may participate in
assessments from different administrators without making another candidate account.

Provider access/refresh tokens never reach the browser. The server stores an
AES-256-GCM encrypted token bundle bound to the application's session identifier.
Protect the runtime `cloud-session.key` alongside the database using OS permissions
and disk protection. The database as a whole is not encrypted. Losing this key
invalidates cloud sessions; it does not delete exam records. Provider outages deny
cloud-authenticated operations temporarily without discarding otherwise valid sessions.
Cookies remain HttpOnly/SameSite; deployed HTTPS also sets Secure. Origin checks,
CSRF protection and authentication throttles remain enabled.

Schema 13 preserves legacy passwords, sessions, attempts and responses. Assessment
ownership is recovered from creation audit/receipt data, then linked roster ownership,
then the original local Host administrator. Records without attributable ownership
and without an original Host administrator are not exposed to newly created accounts.
Migration makes an automatic pre-upgrade database copy. Administrator drafts are
cleared when switching between recorded workspace identities in a tab.

## Current boundary

Supabase Auth is integrated, and completed examination records can now be explicitly
synchronized to private PostgreSQL storage after the one-time cloud migration.
See [cloud setup and synchronization](CLOUD-SYNC.md). The question bank now has a
separate private cloud adapter with local-first saves, cross-Host transfer and
explicit conflict recovery; see [activation and boundaries](CLOUD-QUESTION-BANK.md).
Connecting an account enables automatic question-bank synchronization when its
cloud migration is installed. Completed examinations are uploaded only when selected
in Cloud sync. The
examination engine and assessment authoring still use SQLite. Rosters now have a
private cloud adapter with local-first persistence; see [activation](CLOUD-ROSTERS.md).
Candidates can
now use connected sign-in, with explicit linking for existing local accounts; see
[candidate identities and remaining boundaries](CLOUD-CANDIDATES.md). Local candidate
records cache those identities. Connected roster membership follows them across
Hosts. Assessment papers/settings now follow the administrator through the
[authoring adapter](CLOUD-ASSESSMENT-AUTHORING.md). [Explicit local preparation](LOCAL-PREPARATION.md)
pins a separate local run and approved candidate admission on the selected Host.
Individual source-assessment registrations still do not automatically follow Hosts;
connected rosters supply portable membership.
Completed-exam cloud records remain read-only snapshots, not running exams.

Remaining work: the full cloud execution/management adapter, production HTTPS
deployment and real-device qualification of prepared local delivery.
Do not launch this development
service as a production multi-tenant assessment service until those boundaries have
been implemented and tested.

## Assessment authoring activation

Run `supabase/migrations/202610050004_assessment_authoring.sql` once in SQL Editor,
then restart the application. Connected workspaces gain cloud-saved creation drafts
and papers/settings. See [cloud assessment authoring](CLOUD-ASSESSMENT-AUTHORING.md)
for save states, conflict recovery and the distinction between authoring and delivery.
