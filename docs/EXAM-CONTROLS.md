# Live examination controls

The Monitor tab provides Announcement, Extra time and Pause/Resume. Expand an ongoing candidate row to add time only for that candidate or submit their saved answers. Reasons are required for every timing or submission intervention, and are shown in Activity. Force submission has an explicit, irreversible confirmation.

## Announcements

Messages are plain text, at most 1,000 characters. They are stored locally, not transient broadcasts. Admitted candidates receive them through their normal examination-state updates (approximately every ten seconds while connected); reconnecting candidates receive missed messages. Got it acknowledges a message for that candidate on the server. All announcements remain accessible in a compact history. This acknowledgement is not proof that a person read or understood the message. No internet, browser push notification service, email or SMS is required.

## Extra time

- Select between 1 and 240 extra minutes per action, with quick choices of 5/10/15/30 minutes.
- Candidate-only extensions apply to ongoing attempts, including disconnected ones. They do not change other candidates' deadlines or reopen admission. For individual exams, the finish-by cap still applies; exceeding it requires a global extension first.
- Shared-start global extensions move the shared admission/deadline later and extend ongoing attempts by that amount.
- Individual-start global extensions increase ongoing deadlines and the duration granted to future starters. They move the finish-by cap if present, but do not move Last start time.
- Submitted and expired attempts never reopen. Candidate-specific time cannot be granted before an attempt begins.

The sitting execution horizon may extend for one candidate without granting more time or reopening admission for anyone else. Candidate timers always use their own persisted attempt deadline.

## Pause and resume

Pause is available after opening, while the sitting is still active. On the server it immediately blocks new starts, new answer writes and voluntary submission. Already-committed answer operations may still return their original receipts. Candidates retain saved answers and any local pending saves, see a pause banner, and cannot change answers once their page receives the paused state. An offline device cannot learn about a pause until reconnecting; the server nevertheless rejects new writes during the pause.

Authoritative time freezes at the pause timestamp. Expiry reconciliation does not expire paused attempts, even across a Host restart or long interruption. Resuming adds the elapsed paused duration to ongoing attempt deadlines, the execution horizon and admission window, including any finish-by deadline. This deliberately means a fixed finish time moves later after a pause; the confirmation explains that policy. Closed attempts remain closed. Administrative announcements, extensions, force submission and ending the examination remain available during a pause.

Pending answer operations rejected only because of a pause retain their stable operation IDs and retry after resume. Other authorization, revision and closure errors are not blindly retried. Pause does not promise preservation of unacknowledged device data after browser storage is cleared or the device is lost.

## Safety and persistence

Mutation endpoints require the existing administrator session, loopback administration, trusted origin and CSRF token. Commands carry a control revision and stable operation ID. Concurrent stale changes fail visibly; lost-response retries return the original receipt without repeating extensions or announcements. Each action and reason is logged with its actor. Candidate acknowledgements are scoped to the authorized sitting and candidate; body-supplied candidate IDs cannot override that scope.

Schema v12 adds control state, command receipts, announcements and per-candidate acknowledgements without rewriting answers or attempts. Question snapshots remain unchanged: live timing adjustments are a separate execution overlay. All controls work on the local Host without internet. Existing OS clock trust assumptions still apply; clock-anomaly handling and large-room load qualification remain separate work.

## Practice walkthrough

1. Begin with two candidates at different times in an individual-start exam.
2. Send an announcement. Disconnect one candidate, send another, reconnect, and confirm both messages remain available. Acknowledge one and refresh.
3. Give one candidate five minutes. Verify only their deadline changes. Give everyone ten minutes; verify ongoing deadlines and a later starter's duration.
4. Pause with pending answers, wait, and refresh/restart the Host. Confirm the timer stays frozen and answer inputs/start/submission are locked.
5. Resume. Verify paused time is restored and pending saves retry. Check the start and finish deadlines.
6. Force-submit one candidate, confirming the saved-answer count first. Verify their terminal receipt and Activity reason; the other candidate continues.
7. End the exam while paused or after extra time. Confirm no new starts or changes are accepted.

Automated tests cover these server boundaries, restart persistence, HTTP permissions/CSRF/origin, replay, stale revisions, terminal-state preservation and migrations. Browser visual/keyboard checks and physical-device testing remain required.
