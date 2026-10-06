# Cloud-backed question bank

This development milestone synchronizes private question projects and questions
between Hosts signed in to the same confirmed Supabase administrator identity.
It does not yet synchronize rosters, assessment drafts, candidate identities or
active examination state, and it is not a production cloud examination service.

## Activate

1. Run `supabase/migrations/202610050002_question_bank.sql` once in the existing
   project's SQL Editor. Do not rerun the completed-exam migration.
2. Restart the Host. No additional environment keys are needed.
3. Sign in to the connected cloud account and open **Question bank**.
4. Create or edit a project/question and wait for **Saved to cloud**.
5. Run the same application on another computer, with the same Supabase project
   configuration. Sign in to that cloud account and open **Question bank**.

The cloud bank is enabled by configuring this adapter and applying its migration.
Existing local projects are uploaded automatically when the cloud bank is empty.
Connecting an account permits its background question-bank synchronization;
existing questions can upload without opening the question-bank page first.
Completed examinations still require explicit selection in Cloud sync. Cloud
records remain private.

## Save and recovery behavior

- Question editing still commits locally first. Local SQLite is the durable
  outgoing source; acknowledging a cloud receipt records a durable checkpoint.
- Background updates run approximately every 15 seconds while the Host is open.
  The service is disabled on candidate-only listeners and offline identity replicas.
- Reads retrieve a newer cloud copy when local work is clean. A fresh computer
  downloads projects and questions without making a second administrator identity.
- Project/question IDs, approvals, AI origin metadata, archiving and deletion
  tombstones are preserved. Existing assessment question papers are not altered.
- A lost upload acknowledgement can be confirmed by the next matching cloud digest;
  repeating the same upload never creates a duplicate revision.
- Simultaneous local/cloud changes are quarantined, not silently overwritten.
  **Keep both copies** imports the cloud bank and adds differing local questions
  to recovered projects. **Use cloud version** imports the cloud bank. Both choices
  retain a downloadable local recovery snapshot before making changes.
- Ordinary cloud updates refresh lists without reloading editor drafts. Stale
  question/project revisions reject saves rather than overwrite newer data.
- Account expiry shows a sign-in action; provider/storage failures keep local work
  intact. Missing database setup is distinct from successful cloud storage.
- Cloud-authenticated requests still require live provider verification. During a
  full internet/provider outage, use the connected workspace's native local Host
  login for offline authoring; the service never silently trusts an expired cloud
  identity. Candidate local examination delivery does not depend on these checks.
- Cloud activity is deferred while any local examination is active or paused.

## Security and operating boundary

The adapter uses a server-held, verified user token and the publishable key. No
service-role key, provider token or owner-selector supplied by the browser is used.
All three PostgreSQL tables enforce owner-scoped SELECT through RLS. Direct writes
are revoked. The transactional write RPC derives ownership from `auth.uid()`, uses
an empty search path, validates input, takes a per-owner advisory lock and requires
the expected cloud revision before publishing any changes.

The current protocol synchronizes an entire bank in one bounded transaction:
maximum 500 projects, 10,000 questions and 8 MiB of serialized data. It deliberately
uses bank-wide conflict detection rather than an untested per-question automatic
merge. Capacity and PostgreSQL allocation must be measured before advertising
production limits. Normalized cloud question/project tables permit future indexed
queries and incremental synchronization; the current browsing API uses local SQL.

Checkpoints and recovery snapshots live in the existing SQLite audit log, avoiding
an unnecessary local schema migration. Local revisions/history and deleted records
are retained so references from existing authoring/generation records remain valid.
The local database is not encrypted by this feature; protect its directory and
recovery exports. Lifecycle/retention and incremental history compaction remain
release work.

Tests cover two-device transfer, cross-account isolation, moves/deletions, stale
edit rejection, checksum failures, local-ID collision rollback, lost receipts,
offline edits, concurrent edits/recovery, authenticated HTTP/CSRF boundaries and
real PostgreSQL execution with anonymous denial and RLS. Live activation and
two-machine browser tests are still required against the configured project.
