# Timing and roster admission

## Administrator controls

Create or edit a draft assessment and choose **Shared start** or **Individual start** under Timing.

- Shared start retains the existing behaviour: launching starts one deadline for everyone. Late starters receive only the remaining time.
- Individual start gives each candidate the configured duration when they click Begin examination. Configure Open from and Last start time in your local time. Publishing prepares the exam; it does not start anyone's personal timer.
- An optional Finish by deadline caps all individual attempts. The form warns when this shortens a late starter's time.

No new attempt may begin at or after Last start time. Candidates already taking the examination continue to their personal deadlines. Refreshing, reconnecting, switching devices or restarting the Host never resets a persisted attempt. The server, not browser timestamps, decides eligibility and deadlines. Authored timing and the question paper are immutable once published; audited [live controls](EXAM-CONTROLS.md) can adjust execution deadlines without rewriting that snapshot.

The sitting remains active until the latest possible personal deadline (Last start time plus duration, capped by Finish by). This is the execution horizon, not the last admission time. Ending the examination manually still submits all active attempts immediately. One active sitting per Host remains the current limit.

## Connected roster

A linked assessment automatically receives newly approved roster members before opening. Membership approval, direct enrolment and claimed personal invitations use the same transactional admission path. Pending requests are not admitted. Existing rejected assessment registrations are not silently reversed. Capacity, unique candidate numbers and canonical account ownership still apply.

**Allow new candidates after opening** defaults to off. Enable it in the draft or change it on the published assessment's Overview or Monitor tab. Enabling admits eligible members previously held back, then admits later approvals while the start window is open. Shared-start late entrants get the remaining time; individual-start late entrants get the duration, capped by Finish by.

Closing late admission stops new enrolments; it does not remove existing candidates, stop ongoing attempts or change anyone's timer. After Last start time or completion, new admission cannot be enabled. Archived rosters do not admit new members. Removing group membership does not erase existing assessment enrolment, answers or results. Public per-assessment registration links still close at publication; this setting controls linked-roster admission, not reopening those links.

Roster additions and admission-setting changes are logged. Host startup reconciles eligible linked members idempotently. Approval transactions and startup reconciliation respect the assessment candidate limit; excess members remain roster members without exam admission. The assessment roster section explains excluded member counts.

## Reruns and older data

Existing assessments without timing settings remain shared-start with late admission disabled. No database rewrite is required. Reruns are new editable assessments: individual availability dates are copied for review, not guessed or shifted automatically. Edit past dates before publishing; the server rejects an already-closed start window. Previous attempts and results are unchanged.

## Practice checks

1. Create an individual-start exam with a short duration and two approved candidates. Publish it with a future opening and confirm neither candidate can begin early.
2. Begin on the two accounts at different times. Confirm separate deadlines, then refresh and reconnect without gaining time.
3. Let Last start time pass. Confirm ongoing attempts continue, while a candidate who never began cannot start.
4. Add a new roster member before opening. Confirm the exam appears in their account. After opening, confirm admission is blocked unless enabled by the administrator.
5. Enable late admission, confirm held-back members appear, then close it. Confirm existing enrolments and timers remain unchanged.
6. Repeat with Finish by, and confirm late starters see a shortened-time warning and stop at the cap.
7. Restart the Host mid-attempt and confirm saved answers and deadlines remain intact.

Automated coverage includes validation, independent deadlines, closed admission with ongoing attempts, hard caps, replay, database reopen, roster reconciliation, capacity, rejected registrations and HTTP permission/CSRF/origin boundaries. Physical-device and browser visual checks remain necessary; these tests do not establish a 200-device capacity claim.
