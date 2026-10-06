# Completed examination cloud records

## One-time platform setup

1. Open the supplied Supabase project and select **SQL Editor → New query**.
2. Run the complete contents of
   [`supabase/migrations/202610050001_exam_records.sql`](../supabase/migrations/202610050001_exam_records.sql).
   Apply it once to a fresh project; it is deliberately a transactional migration,
   not a destructive reset or a table-replacement script. Keep the migration in
   deployment history. Reapplying it will fail rather than overwrite existing tables.
3. Restart MUDU. Existing `.env` Auth URL/publishable-key settings are sufficient.
   Do not add a service-role key. The key cannot execute DDL; setup is an operator
   action, not something lecturers repeat.
4. Sign in using a confirmed cloud administrator account. For an existing Host,
   connect the original workspace first rather than creating a second empty one.

## Lecturer experience

**Cloud sync → On this computer** lists completed examinations. Select individual
rows or use **Select all**, then choose **Sync selected**. Queued, uploading and
unfinished jobs are excluded from selection. Larger selections are queued in
requests of up to 20; a failed request leaves the remaining rows selected for retry.
The queue reports Queued, Uploading, Waiting to retry,
Needs attention, or Synced. Refreshing the page does not discard queued records.
Background synchronization waits while another examination is running, including
paused examinations. A newly started examination stops further upload chunks at
the next checkpoint; no ongoing candidate request waits for cloud storage.

**Cloud records** shows only the signed-in administrator's confirmed records.
Open a record to see read-only results and export an exam-named CSV. The same cloud
administrator can access these records through another configured MUDU service.
Candidates do not have access to this interface or its database rows.

Complete manual marking on the original Host, then select the examination again
to synchronize an updated revision. Repeating synchronization of an unchanged
snapshot reuses its receipt. Pending manual scores are clearly retained as provisional.

Local Host access remains available offline. Queueing connected-workspace records
does not require a cloud credential, but actually uploading or reading cloud records
requires a live cloud administrator session. Jobs never store an unencrypted provider
token. Session expiry requires cloud sign-in again; it does not discard the queue.
The original Host operator can choose **Use offline Host access** and enter the
local Host password even during a provider outage. The sign-in bootstrap itself
does not require a fresh Supabase lookup; cloud-protected resource operations do.

## Data and authority

The versioned snapshot contains the authoritative question paper, candidate names
and exam identifiers, acknowledged responses and revisions, scores, and examination
audit events. It does not contain candidate passwords, administrator passwords,
account login sessions, registration-link secrets or provider tokens. Correct answers
are administrator-only data and remain behind owner-scoped database policies.

This is a private cloud record, not a new executable examination or an operational
database backup. Candidate accounts, reusable rosters/question projects, unpublished
assessments and active exam execution still live in the primary SQLite service.
Downloading a cloud record does not create accounts or restart an examination.

The snapshot is persisted before upload. 64 KiB chunks are independently acknowledged
and resumable for seven days. At finalization, PostgreSQL checks length, SHA-256,
document identity, execution Host, sitting and expected revision before atomically
publishing the record. A committed upload's receipt remains replayable; expired,
unfinished staging is cleaned up lazily when the same owner begins another upload.
The current limit is 16 MiB per examination, 500 candidates and 32 unfinished cloud
uploads per owner. Oversized examinations fail explicitly; they are never truncated.

Ownership comes from `auth.uid()`, not an input owner ID. RLS protects reads;
direct table writes are revoked. Write functions use an empty `search_path` and
explicit owner checks, following [Supabase's function guidance](https://supabase.com/docs/guides/database/functions)
and [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Different Host/sitting provenance or stale revisions produce a conflict. The local
queued copy and existing cloud record remain intact, and automatic retries stop.
There is intentionally no force-overwrite button. Operator reconciliation is not
implemented yet; export both copies and investigate before making any resolution.
These identifiers prevent accidental authority conflicts; they are not hardware
attestation or protection against a malicious owner of their own workspace.

## Verification and remaining boundaries

Automated tests execute this migration in embedded PostgreSQL and verify tenant
isolation, restricted grants, resumability, duplicate receipts, revision/Host
conflicts and checksum rejection. SQLite/HTTP tests cover restart recovery, lost
acknowledgments, immutable queued snapshots, provisional grades, local response
retention, no credentials in snapshots, CSRF, private results and CSV downloads.

These tests do not substitute for applying the migration to the real project and
testing a real cloud account over a disrupted internet connection. Browser visual
verification and production/PostgREST integration remain release checks.

Full cloud examination execution, management-data synchronization, candidate identity
distribution to prepared offline Hosts, encrypted exam packages,
production deployment and operational backups remain separate milestones. No change
in this slice switches an active local examination to a cloud dependency.
