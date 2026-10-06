# Live examination monitoring

The **Monitor** assessment tab opens after launch and is the default for active
examinations. It remains open when time expires rather than unexpectedly changing
tabs. Existing overview, results, questions and activity remain separate.

## What the administrator sees

- All / disconnected / active / waiting / submitted / time-expired counts act as filters.
- Name and candidate-number search combines with the selected status.
- Disconnected candidates appear first, then waiting candidates, then active and completed candidates.
- Saved-answer counts include only non-empty responses persisted by the server.
- Last contact includes heartbeats, starting an attempt and acknowledged answer writes.
- Expand a candidate row for start, last save, submission and observed connection-restoration counts.
- Failed or overdue monitoring updates retain the last snapshot and visibly identify it as stale.

The administrator polls a compact monitoring endpoint every five seconds without
overlapping requests. Hidden tabs suspend polling and refresh on return. Response
counts are aggregated in SQLite, not by transferring full answers to the dashboard.
No candidate answer text, answer keys, credential hashes or email addresses are in
the monitoring response. Existing administrator permissions apply.

## Presence is telemetry, not examination state

Individual-start examinations show Window remaining for the sitting and personal time remaining on active candidate rows. Last start time closes admission only: existing active candidates remain active or disconnected until their own deadline. Candidates who never began are shown as time expired after admission closes. Shared-start examinations retain their common timer.

Authenticated candidate examination pages send a server-timestamped heartbeat
every fifteen seconds, including the instruction screen. Writes are coalesced to
at most one per candidate per five seconds. Candidates cannot choose their ID,
sitting, timestamps or connection counts in the heartbeat payload. Account-backed
and legacy examinations use the existing admission and session boundaries.

An active attempt with no server contact for **45 seconds** is shown as disconnected.
This is inferred telemetry; it does not change the attempt, pause time or remove
answers. A waiting candidate remains waiting, with a connected/not-started hint
when appropriate. A candidate who never started before the examination ended is
shown as time expired with a did-not-start hint. Submitted/expired attempts never
become active merely because a heartbeat arrives.

Returning heartbeats after a qualifying contact gap increment a persisted count
and record `candidate_connection_restored` with the last contact time and observed
gap. This records an observation, not an exact Wi-Fi outage duration. Browser
background throttling, leaving the examination page, device sleep, network failure
and Host interruption can all cause gaps. These are not evidence of misconduct.
No invasive monitoring or focus telemetry is included in this milestone.

Schema v11 adds `candidate_presence` without rewriting existing attempts or answers.
Presence and restoration counts survive a Host restart. Restarting does not grant
additional time. Monitoring works entirely on the local network; no external service
or internet connectivity is required.

## Verify with a practice examination

1. Admit two dummy candidates and launch a short examination. Confirm Monitor opens.
2. Open the examination on separate devices; one stays on instructions, one begins.
3. Confirm Waiting/connected and Active are distinct. Save an answer and check progress.
4. Disconnect the active device for at least 45 seconds. The next dashboard update
   should show Disconnected without changing its saved count or deadline.
5. Reconnect, keep the examination page open and confirm Active returns. Expand the
   row to inspect the restoration count. Verify saved work remains available.
6. Submit one attempt; let the other expire. Confirm terminal statuses and search/filters.
7. Interrupt dashboard access and confirm stale data is labelled rather than presented
   as current. Restore access and confirm updates resume without clearing filters.

Automated tests cover statuses, saved/blank answers, authorization, CSRF, expired
attempts, restart persistence, migration and filtering. Physical-device and visual
browser verification are still required; this milestone is not a capacity claim.

Announcements, time extensions, pause/resume and individual force-submission are
available in this monitoring screen. See [live examination controls](EXAM-CONTROLS.md)
for the exact timer, admission, pending-save and confirmation rules.
