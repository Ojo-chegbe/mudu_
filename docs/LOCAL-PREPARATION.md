# Prepare cloud assessments for local delivery

This development milestone brings an authored assessment and its approved candidate
identities onto the Host. Preparation needs connectivity; a ready run does not.
It does not implement cloud examination execution or qualify a 200-device network.

## Activate once

Apply the existing question-bank, roster and authoring migrations first. Then run
`supabase/migrations/202610060001_local_preparation.sql` in the Supabase SQL Editor.
Keep the existing server-only Supabase configuration; no service-role key is needed.
Restart the Host. SQLite automatically upgrades to schema 17 without replacing
existing accounts, assessments, responses or passwords.

## Administrator workflow

1. Sign in to the connected workspace on the Host. Load the assessment and roster.
   Every approved candidate must have an explicit connected identity. A native-only
   candidate is not silently omitted or matched by a guessed number/email.
2. Open the original assessment and choose **Prepare local run**. Choose an access
   expiry after the planned last start, between one hour and 30 days ahead.
3. Wait for **Your local run is ready**. A pending preparation is retained locally;
   retry is safe after an outage, restart or lost cloud reply. Do not disconnect
   before the run is ready and candidates have their files.
4. Ask candidates to sign in to their connected account and **Save access file**.
   The files requested count means a download was requested—not proof a device
   has retained a readable file. Check at least one actual candidate device.
5. Choose **Open local run**, then **Connect students**. The existing Local delivery
   screen displays the router address. Students join that Wi-Fi and open the address.
   No QR code is used.
6. Start/publish the local run. Students choose their private `.mudu-access` file
   and take the examination in their normal browser.
7. Use monitoring, announcements, pause/resume, extra time and force submission as
   usual. Grade and export the completed run. Completed results use the existing
   Cloud sync workflow when connectivity returns.

Preparation creates a distinct execution record pinned to the source paper revision
and current approved candidates. It does not silently transfer an active sitting
between computers. Later paper edits, roster additions and membership changes do not
modify that prepared run. Cancel an unstarted preparation and prepare another to
change its paper/admission. The original assessment remains available for authoring.
Prepared runs do not upload back as new cloud authoring documents.

## Offline administration and candidate recovery

The original Host's connected local password still works offline. A valid existing
administrator session also has narrowly scoped authority to launch, monitor, control,
mark and export its own prepared run from the Host computer without contacting
Supabase. It does not authorize offline cloud management, another workspace, remote
administration, editing the pinned paper or creating a rerun. Sessions still expire;
before disconnecting, ensure the original workspace is explicitly connected and its
local Host password is available. A new cloud-only account has no invented offline
password or second Host account.

**Replace candidate access** selects an admitted candidate and requires a recorded
reason. Replacement revokes the previous file and candidate sessions, keeping the
same registration, attempt, answer order, saved responses and official deadline.
The replacement is downloaded by the invigilator and handed privately to that
candidate. Replaying the same recovery operation returns the same receipt.
Replacement files are currently local recovery files; the original cloud download
is not updated and cannot override the replacement. Re-downloading that old cloud
file does not restore access. A future cloud rotation/revocation protocol is separate.

Access expiry blocks unused/new access. An already active attempt can reconnect
through its actual deadline, including extra time and a pause; expiry does not create
a new attempt. Cancelling preparation invalidates access without deleting records.
Terminal preparation state is queued to the cloud after local execution finishes.

## Security boundaries

- Candidate accounts are mapped by confirmed provider UUID and explicit local
  binding. Password verifiers and provider tokens are never placed in the package.
- The private manifest is AES-256-GCM sealed with a purpose-separated key derived
  from the persistent Host key. Authentication includes the Host ID. Keep
  `cloud-session.key` and the original Host data folder; they are required to verify
  or recover the sealed package. The database as a whole is not encrypted.
- Cloud preparation checks owner, source digest/revision, identity/email binding,
  expiry, field bounds and one open reservation per source. Direct table access is
  revoked. Candidates can retrieve only their own admission proof, never the
  sealed paper, answer keys or another candidate's credentials.
- Local storage keeps admission credential hashes; the sealed private manifest and
  encrypted recovery receipt contain the recoverable originals. Possessing an
  access file authorizes its candidate: treat it as private, not a harmless document.
- Local sessions are HttpOnly, origin/CSRF checked, revocable and scoped to one run.
  They cannot change account details, join groups or inspect other examinations.
- The existing HTTP router mode is not encrypted transport. Someone able to inspect
  or manipulate the LAN can steal traffic, including scoped admission credentials.
  Use a trusted private examination network. Packaging encryption does not make
  HTTP secure, prevent file sharing or establish the person holding the device.
- Active/paused local examinations defer preparation and cloud progress. Browser
  execution and ticket checks require no internet or browser cryptography API.

Bounds: 500 admissions per package, 4 MiB sealed package, 100 preparations and 32 MiB
sealed-package storage per owner. These protect free-tier storage, not measured
candidate capacity. Retention/cleanup policies and production storage budgets remain
to be designed before wider deployment.

## Verification

Automated tests cover PostgreSQL permissions/CAS/reservation/private downloads,
hashed admission, missing bindings, wrong keys/tampering, lost receipts, restart,
CSRF, one-run scope, offline launch/control, device revocation and paused recovery.
Run `npm run check` and `npm run build`.

Still required: apply the migration to the real project, test real confirmed accounts
across two Hosts, perform browser/keyboard/mobile QA, and run phones/laptops on a
router with its internet disconnected. A clean automated suite is not a claim of
production readiness. Operational backup work remains deferred as requested.
