# Reusable rosters

Administrators manage named groups at `/rosters`. Candidates join through `/join/roster/:token`, using their existing MUDU accounts. Group membership is independent of identity verification and individual assessment enrolment.

## Admission rules

- Importing a name and ID establishes expected eligibility only; it does not create an account, verify identity, or approve membership.
- Every joining request needs administrator approval. Candidate numbers are assigned uniquely within the workspace; there is no separate identity-verification step. Direct enrolment of an existing account creates approved membership and notifies that account.
- An optional expected list restricts who may request membership. A closed or archived group accepts no new requests. Existing membership remains visible.
- Removal changes future group eligibility only. It never deletes accounts or earlier assessment enrolments/results.

## Connected assessments

The assessment creation UI defaults to choosing one roster. The server reads its approved, verified members—not the client-supplied candidate array—and requires the reviewed roster revision. It persists a name/version reference and copies eligible members into the assessment in the same transaction as creation.

Roster assessments do not use per-assessment registration links. Existing legacy assessment registration remains supported. Newly approved members are admitted automatically before opening. After opening, the administrator's late-admission policy controls new enrolments while the start window remains open. Existing enrolments and results remain independent of later membership removal. The original roster revision remains an authoring/audit reference, not a frozen eligibility list. See [timing and admission](TIMING-AND-ADMISSION.md) for deadlines, capacity and recovery rules.

## Editing and recovery

The expected-list editor supports manual entry and CSV preview with explicit append/replace choices. Normalized duplicate IDs, malformed input, and lists over 500 are rejected. Saving uses optimistic revision checks. Draft edits are backed up in the current browser tab, cleared on sign-out, and can be discarded explicitly. Storage failures are visible.

Roster membership requests and decisions feed the notification centre. Assessment assignment uses the existing account registration records and notifications. No email or SMS is implied.

## Limits and deployment

Private administrator workspaces support one roster per assessment, at most 500
approved members, and at most 2,000 membership records per roster. Connected
workspaces can now share rosters, requests, approvals and personal invitations
through private cloud storage; see [setup and boundaries](CLOUD-ROSTERS.md).
Canonical membership mutations are disabled on offline identity replicas.
Multi-roster merging and prepared offline identity distribution remain separate work.
