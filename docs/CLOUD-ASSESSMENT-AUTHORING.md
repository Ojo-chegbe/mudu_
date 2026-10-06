# Cloud-backed assessment authoring

Connected administrators keep private unfinished creation drafts, question papers,
timing/access settings and roster selections across Hosts. The existing wizard and
editor remain the interface. Cloud examination execution remains separate. Explicit
[local preparation](LOCAL-PREPARATION.md) now pins a paper/admission snapshot on a Host.

## One-time activation

1. Keep the existing server-side Supabase configuration in `.env`.
2. Run `supabase/migrations/202610050004_assessment_authoring.sql` once in the
   project's SQL Editor. No service-role key is needed.
3. Restart MUDU and sign in to the connected administrator workspace.
4. Drafts save automatically after changes; **Save draft** saves immediately.
   **Saved here** and **Saved to cloud** mean different things.
5. Sign in to the same account on another connected installation. Use
   **Continue drafting**, or open a created assessment to edit its paper.

Roster selections require cloud rosters on the receiving Host. Missing roster
references are retained; refresh rosters before creating the assessment. Bank
selections are private copies of the chosen questions, not mutable source links.

## Persistence and conflict handling

- Account-based wizard drafts commit to SQLite before cloud synchronization. The
  tab retains its recovery draft too. Closing a tab or signing out does not remove
  workspace drafts already acknowledged by the server.
- Incomplete question text and blank titles can be saved. Invalid/out-of-range
  settings are not accepted as saved. Individual access-key drafts remain tab-only;
  candidate credentials are never uploaded.
- Each cloud document uses compare-and-swap revisions and idempotent writes.
  Lost acknowledgements do not create duplicate assessments or revisions.
- New wizard creations use their stable request UUID as the assessment UUID.
  Creation replaces that draft's document. Discarded drafts use tombstones to
  prevent silent resurrection on another device.
- Concurrent changes retain both copies. **Review changes** loads the latest cloud
  document after keeping a private downloadable local recovery copy. Unsaved tab
  changes must be kept/downloaded or explicitly discarded before that operation.
- A download cannot overwrite a local edit made while it was loading. A newer edit
  during an upload remains pending after the captured earlier copy is acknowledged.
- Created assessment edits still use **Save changes**; unsaved editor changes stay
  in that tab. Cloud imports invalidate stale edit versions, not the displayed form.
- Started assessments cannot be replaced by cloud authoring. Active and paused
  local examinations defer all authoring cloud calls and imports until they finish.

## Authoring is not delivery preparation

Documents contain authoring settings and the original execution Host identity.
They do not contain password verifiers, attempt sessions, responses, marks or
results. Candidate names/numbers in a wizard are not proof of identity or admission.

Another Host can edit the paper but cannot launch it as a second exam server.
Both the launch API and UI enforce that boundary. Use **Prepare local run** to create
a distinct pinned run with scoped admission on this Host, or run an existing
assessment on its original Host. The source's execution authority is never silently
reassigned.
Question IDs may be regenerated during an authoring import before launch; live
attempt references are never changed.

Existing registrations are not removed by imports. Individual assessment
registrations do not yet follow candidates between Hosts. Cloud rosters remain the
portable group-membership mechanism; online delivery is a separate milestone.

## Security and bounds

Supabase RLS permits owner-only reads; direct writes are revoked. Write RPCs derive
the owner from `auth.uid()`, require confirmed email, lock the owner and document,
bound payloads, enforce revisions and retain immutable execution-Host identity
after creation. Host imports validate documents and raw-payload digests before
mutation. HTTP routes require administrator authentication, origin checks and CSRF.
Provider tokens remain encrypted server-side, never returned to the browser.

The cloud protocol supports 1,000 documents and 32 MiB per workspace, at most 1 MiB
per document. HTTP requests stay bounded to 1 MiB; wizard content is bounded below
that. Local wizard storage is capped at 500 IDs including discard tombstones.
These are storage safeguards, not examination-capacity or production claims.

SQLite upgrades to schema 16 with the existing migration snapshot behavior.
Checkpoints and recovery files remain durable across restarts. Operational
backup/restore work remains deferred as requested.

## Verification

PostgreSQL tests exercise real RLS, grants, confirmed writes, private reads,
optimistic revisions, idempotence, payload bounds and immutable delivery authority.
Two-Host service/HTTP tests cover recovery, privacy, discard propagation, paper
editing, authentication, CSRF, checksums, concurrent edits and active-exam isolation.

Live Supabase, browser, accessibility and real-device testing remain required.
After activation, verify two independent installations: resume a draft, save an
edited paper, disconnect cloud connectivity, and create conflicting edits before
loading the latest cloud copy.

Next: prepared assessment/admission packages for completely offline local delivery.
Full cloud examination execution follows separately.
