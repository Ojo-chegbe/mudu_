# Online examination delivery

Online execution uses PostgreSQL as its durable authority. Local examinations continue to use the Host's SQLite database and do not require this connection. The LAN candidate listener does not receive the online service.

## Activation

1. Apply the existing Supabase authoring and roster migrations first, followed by `supabase/migrations/202610060002_online_execution.sql` in the project's SQL editor. This creates new execution tables, access policies, and the approved server-only `mudu_execution` permission role. It does not migrate or delete existing records.
2. In Supabase's database connection settings, obtain the **PostgreSQL session-pooler connection URI**, including the database password. Set `MUDU_DATABASE_URL` in the server's `.env`. The publishable API key is not a database password. Do not paste this URI into the frontend, commit it, or send it in chat.
3. Keep `MUDU_SUPABASE_URL` and `MUDU_SUPABASE_PUBLISHABLE_KEY` configured for confirmed account authentication. Run `npm run check:online`, then restart the server. The setup check is read-only and verifies the schema and server-only role. Database TLS certificate verification is mandatory for remote connections; optionally configure `MUDU_DATABASE_CA` with a trusted CA file. Do not disable certificate checking.
4. For remote candidates, deploy the Node application at a public HTTPS address. Configure `MUDU_ORIGIN`, `MUDU_TLS_CERT`, and `MUDU_TLS_KEY` for that deployment. The Supabase project address is **not** the candidate application address. A localhost link is only a development test link.
5. Sign in with a cloud-connected administrator account, save the source assessment to the cloud, and approve candidates whose accounts are cloud-connected. Open the assessment and choose **Publish online**. Confirm publication, then monitor the online examination. Shared timers start on publication; individual timers use the configured availability window and each candidate's start time.

Configuration and the SQL migration have not been applied automatically to the live Supabase project. A public deployment is also not provisioned by this implementation.

## Execution and permissions

- The backend verifies its session and Supabase identity before using the role. It sets that identity and the examination context **locally to one PostgreSQL transaction**, then rechecks the session before commit.
- The role cannot log in independently. The connection principal can assume it; protect that principal's credentials. This is a permission boundary, not a substitute for protecting the backend connection. Browser `anon` and `authenticated` roles have no execution-table access or access to these functions.
- No direct grants to question banks, rosters, authoring documents, or `auth.users` are added. Narrow security-definer functions check the owner's current source revision and, for late roster admission, read only the requesting candidate's approved membership and profile. They return neither private documents nor lists of people.
- Administrators operate only on their own online examinations. Candidates can access only their admission and attempt. Candidate writes exclude grading, shared timing controls, announcements, and admission changes.
- Each command loads a disposable, in-memory projection of the authorized PostgreSQL rows and calls the existing local examination engine. This projection never becomes the online database. Changed rows and events commit before acknowledgement.
- Question order, attempts, answer revisions, operation receipts, marks, presence, announcements, acknowledgements, and control receipts are persisted. Candidate responses omit correct-answer keys.
- Candidate commands take a shared examination lock and an exclusive candidate lock. Exam-wide interventions take an exclusive examination lock. This serializes conflicting actions without making every candidate's answer compete for a single answer snapshot.
- Deadlines use PostgreSQL time, not browser time. Pause, resume, extensions, expiry, grading, and forced submission use the same rules as local delivery. State and monitoring requests reconcile expiry; a continuously running expiry worker is not required for accepting/rejecting answers correctly.
- An explicit **Continue on this device** action claims a device lease. The former device can no longer write; saved answers, question order, and the deadline are preserved. The lease is derived from the server session, not a client-supplied identity.
- Publication freezes the question paper and initial admission list. A roster-backed examination can admit later approved members only when late admission is enabled and its start window is still open. Paused or closed examinations do not admit new members. Previously admitted candidates keep their access when late admission closes.
- Online manual marking is revision checked. CSV exports use the assessment title and escape spreadsheet formula prefixes. Audit events remain in PostgreSQL.
- An online rerun uses the original published paper, a fresh registration link and new question/attempt identities. It may reuse admitted candidates or a currently selected owned roster. No responses, timers, scores, or provider credentials are copied.

## Verification and remaining qualification

The regression tests cover PostgreSQL access boundaries, durable answers, idempotent receipts, device recovery, rollback on revoked authority, announcements, administrative controls, essay marking, private directories, and a real HTTP examination journey. They use embedded PostgreSQL for repeatability; they are not a live Supabase deployment test or a multi-process load test.

Before production, apply and smoke-test the migration on the actual Supabase project, test remote HTTPS access and server restart against that database, and qualify concurrent candidates with a real PostgreSQL pool. The disposable engine projection has per-request cost; no 200-candidate capacity guarantee is made. Test answer-save and submission spikes, database saturation, reconnection, intervention races, and browser accessibility. The visual browser check was not completed in this environment.

Local backup work remains deferred as requested. Running local delivery does not silently switch to online execution if connectivity returns.
