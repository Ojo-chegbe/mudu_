# Cloud-backed rosters

Administrators use the existing roster pages. Connected workspaces automatically
share their roster settings, expected lists, membership requests, decisions and
personal invitations through private Supabase storage. Candidate membership follows
the confirmed provider identity, not a name match or a reusable password copy.

## One-time operator activation

1. Keep the existing server-side Supabase URL and publishable key in `.env`.
2. In the project's SQL editor, run
   `supabase/migrations/202610050003_rosters.sql` **once**. No service-role key is needed.
3. Restart the application. Sign in using the connected administrator account.
4. Open **Rosters**. **Saved to cloud** confirms the current local roster copy was
   acknowledged; pending, setup, unavailable, connection and conflict states are distinct.

This migration is independent of the question-bank migration. It is a project setup
step, not something lecturers or candidates do for each assessment.

## Existing accounts and addresses

Existing native members must explicitly connect their candidate accounts before
their roster can be shared. Until then, that roster stays local with a visible
connection notice; members are not omitted, unapproved, or converted by email.
Candidates sign in on the original Host, then choose **Connect account** on
**My examinations**. Existing local passwords and enrolments remain intact.

New cloud memberships are keyed by Supabase user UUID. Another Host caches those
identities without reusable password verifiers. If its database already has an
unconnected native account with the same email, import is quarantined until that
candidate explicitly connects; no automatic account merge occurs.

Joining-link tokens persist across Hosts. An application using the same Supabase
project can resolve them even without a prior local copy. A loopback address is
still only reachable on that computer. Internet sharing requires a deployed public
HTTPS application address. Roster and personal invitation links prefer the configured
public application address over a temporary router address when available. Otherwise
the existing local-delivery address and reachability warning remain in use.

Candidates use connected sign-in for cloud joining. Public links expose only the
group name, joining state and restrictions; authenticated candidates receive only
their own membership. Student numbers on restricted lists identify a request, not
account ownership or automatic admission. Approval assigns the number uniquely;
existing assigned numbers cannot be replaced by a candidate's joining request.
Organisers can assign a student's number through explicit enrolment.

Personal invitations are bound to the confirmed email of their intended recipient.
Accepting them creates approved membership. Lost responses can be retried using a
private claim receipt without duplicate enrolment or a fresh attempt. Reusing an
accepted invitation never reverses a later membership removal.

## Reliability and conflict behavior

- Saves commit locally first. The local roster and durable per-roster checkpoints
  are the retry source; cloud outages do not delete them.
- Every cloud mutation, including candidate joining and invitation acceptance,
  advances that roster's revision. Stale owner uploads cannot erase newer requests.
- Each roster synchronizes independently. A blocked roster does not block the
  remainder of the workspace.
- Concurrent local/cloud changes stop at an explicit conflict, without last-write-wins.
  **Review changes → Use latest cloud copy** retains the current saved local document
  as a private downloadable recovery copy. It does not combine incompatible approvals.
- Edits made during downloading cannot be overwritten. A newer edit during upload
  remains pending after the earlier upload is acknowledged.
- Automatic imports invalidate stale local edit/review revisions. Background UI refresh
  does not replace an unsaved roster form. Manual request refresh checks the cloud.
- Authorised imports update draft assessment admission using the existing rules, but
  never delete registrations, attempts, responses or results on membership removal.
- Active or paused local examinations defer roster cloud traffic and imports entirely.
  Native roster operations still work locally. Cloud changes resume afterward;
  late cloud membership is not secretly admitted during an offline examination.
- Confirmed candidate group decisions feed the existing notification centre, including
  on a Host without the administrator's full roster copy. Notifications remain local
  to the current deployment; cross-device read-state synchronization is not implemented.

## Security and bounds

Owner-scoped RLS and grants protect roster tables. Direct client writes and private
helper-function execution are revoked. Write/join RPCs derive identity from the
authenticated provider, confirm email, use owner-scoped transactional locks, and
validate payload bounds. Candidate responses cannot expose other members or invitations.
Origin, CSRF, application authentication throttles and server-only encrypted provider
tokens remain in force. Direct RPC joining also has an authenticated request throttle.

The adapter supports 100 rosters and 16 MiB of roster payload per workspace, up to
2 MiB per roster, 500 expected entries, 500 approved places plus invitations, and
2,000 membership records per roster. Candidate joining is bounded to 2,000 groups.
These are storage/protocol bounds, not an examination-capacity claim. Cloud number
reservations persist after membership removal to prevent reassignment to another identity.

Native candidate-number rules are still global within a Host's initial `default`
organization. An incompatible existing number is quarantined rather than silently
rewritten. Institution-scoped identity namespaces need separate qualification.

## Verification

Automated checks exercise actual PostgreSQL RLS/grants, revision conflicts, public
metadata privacy, confirmed identity admission, unique number reservation, invitation
retry receipts, closure/archive behavior and rollback. Two-Host service/HTTP tests
cover owner isolation, joining, approvals, invitations, candidate notification/privacy,
lost acknowledgments, offline edits, concurrent changes, identity collisions, checksums
and the zero-cloud-request active-exam boundary.

After activation, test with two independent data directories/computers using the same
Supabase project: create a roster on A, view it on B, join as a confirmed candidate,
approve on A, and confirm membership on B. Also try a personal invitation, temporary
cloud disconnection and concurrent edits. Real project/email/browser/device testing
is still required; this is not production security or network-capacity certification.

Cloud-backed assessment drafts are now implemented; see [authoring](CLOUD-ASSESSMENT-AUTHORING.md).
Actual cloud examination execution and prepared offline admission/packages remain
separate milestones. Sharing a roster does
not copy the assessments already stored only on another Host.
