# Reusable rosters

Administrators manage named groups at `/rosters`. Candidates join through `/join/roster/:token`, using their existing MUDU accounts. Group membership is independent of identity verification and individual assessment enrolment.

## Admission rules

- Importing a name and ID establishes expected eligibility only; it does not create an account, verify identity, or approve membership.
- Every joining request needs administrator approval. A previously unverified candidate number additionally requires an explicit institutional identity check. Verified number ownership remains unique.
- An optional expected list restricts who may request membership. A closed or archived group accepts no new requests. Existing membership remains visible.
- Removal changes future group eligibility only. It never deletes accounts or earlier assessment enrolments/results.

## Assessment snapshots

The assessment creation UI defaults to choosing one roster. The server reads its approved, verified members—not the client-supplied candidate array—and requires the reviewed roster revision. It persists a name/version reference and copies eligible members into the assessment in the same transaction as creation.

Roster assessments do not use per-assessment registration links. Existing legacy assessment registration remains supported. Before an examination starts, administrators can review and add newly approved roster members explicitly. A revision check prevents including unseen concurrent membership changes. Once a sitting exists, additions are prohibited.

## Editing and recovery

The expected-list editor supports manual entry and CSV preview with explicit append/replace choices. Normalized duplicate IDs, malformed input, and lists over 500 are rejected. Saving uses optimistic revision checks. Draft edits are backed up in the current browser tab, cleared on sign-out, and can be discarded explicitly. Storage failures are visible.

Roster membership requests and decisions feed the notification centre. Assessment assignment uses the existing account registration records and notifications. No email or SMS is implied.

## Limits and deployment

This implementation supports the current single-administrator workspace, one roster per assessment, at most 500 approved members, and at most 2,000 membership requests per roster. Canonical membership mutations are disabled on offline identity replicas. Multi-roster merging, external invitations, and offline identity distribution are not implemented here.
