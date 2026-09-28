# MUDU build roadmap

This tracks the complete agreed MVP while distinguishing the first development slice from release-ready capabilities.

## Implemented development foundation

- [x] Isolated repository, React/TypeScript build, formatting, shared engine boundaries.
- [x] Local administrator setup and candidate authentication.
- [x] Assessment creation, roster CSV import, question configuration, frozen sitting snapshot.
- [x] Candidate instructions, navigation, server deadline, autosave, submission confirmation.
- [x] Persisted question randomization, idempotent writes, answer revisions, device-session revocation.
- [x] Objective grading, provisional short answers, candidate progress, recent audit events, results CSV.
- [x] Restart and abrupt process-termination tests, HTTP lifecycle/security tests, outbox retry tests.

## 1. Validate and complete the first slice

### Candidate account milestone

- [x] One persistent canonical account across examination registrations.
- [x] Organization-scoped candidate-number verification; email or verified-number sign-in.
- [x] Candidate dashboard with pending, upcoming, active, and completed examinations.
- [x] Persistent links, approval/rejection, roster restrictions, close/reopen, deadlines, and link rotation.
- [x] Automatic assignment from reused verified roster entries.
- [x] Schema v2 migration and backup with preservation tests for existing attempts.
- [x] Fail-closed offline-replica boundary: no second signup or primary-password authentication.
- [ ] Cloud deployment and prepared offline admission for those same canonical identities.
- [ ] Verified email, password recovery, organization administration, and reusable class groups.

### Verification still required

- [ ] Browser walkthrough on desktop and supported mobile browsers; visual and keyboard QA.
- [ ] Browser-driven lost-acknowledgment, reconnect, submission, refresh, and multiple-tab scenarios.
- [ ] Accessibility checks: focus flow, screen readers, touch targets, contrast, error announcement.
- [ ] Fix observed issues before expanding the product surface.
- [ ] Set up CI for type checking, formatting, tests, build, secret and dependency scanning.
- [ ] Verify supported runtime/SQLite security patches and document baseline hardware.

## 2. Authoring and management

- [ ] Editable persisted drafts, archive/duplicate workflows, published version history.
- [ ] Organization accounts, invitations, MFA/recovery, role and course assignments.
- [ ] Reusable courses, candidate records, rosters, credential issuance/reset.
- [ ] Question bank, topics/tags/difficulty, search, versions, private image assets.
- [ ] Rich-text constraints and safe rendering.
- [ ] Readiness validation, scheduled admission, accommodations, revisiting policy, multiple sittings.
- [ ] AI document extraction and generation jobs, schema validation, review/edit/approve workflow, usage limits.

## 3. Online deployment

- [ ] PostgreSQL persistence adapter and shared engine conformance suite.
- [ ] Organization isolation enforced by API/storage boundaries.
- [ ] Durable workers, expiry/reconciliation, private storage, email and invitation delivery.
- [ ] Staging/production environments, secrets management, migrations, rollback, cloud backups.
- [ ] Online admission, concurrency tests, browser resilience, session recovery.
- [ ] Monitoring, alerting, abuse prevention, rate limits, incident procedure.

## 4. Production local Host

- [ ] Trusted HTTPS and offline DNS proof on real Android/iOS/laptop browsers.
- [ ] Signed, encrypted, versioned packages bound to an authorized Host.
- [ ] Windows service/launcher/installer, firewall workflow, updates outside active sittings.
- [ ] Local administrator authorization and invigilator-approved recovery.
- [ ] Guided preflight: assets, roster, disk, database, certificate, clock, backups, connectivity.
- [ ] Connection practice and diagnostics based on actual participating devices.
- [ ] Database/backup encryption, protected keys, recovery and clock-anomaly policies.
- [ ] Consistent backup snapshots, separate-device export, verified restoration.

## 5. Monitoring and grading

- [ ] Presence heartbeats, disconnected state, reconnection history, persisted announcements.
- [ ] Focus events with context and no automatic misconduct determination.
- [ ] Audited pause/resume, individual/global extra time, individual force-submit.
- [ ] Defined question correction/exclusion and regrading behavior.
- [ ] Manual marking interface, rubrics, concurrency control, grading revisions.
- [ ] Result publication, defined analytics denominators, distribution and question-level performance.

## 6. Synchronization

- [ ] Durable outgoing queue, stable records, authenticated resumable batches.
- [ ] Transactional cloud application, duplicate detection, acknowledgments, backoff.
- [ ] Reconcile responses, attempts, grades, assets, and events before marking synchronized.
- [ ] Host/sitting authority conflict quarantine; no silent last-write-wins merge.
- [ ] Cloud result access, retention, controlled deletion, audit export.

## 7. Qualification and release

- [ ] Security threat model review and independent assessment.
- [ ] Load ladder: 10, 25, 50, 100, 150, 200 simulated candidates.
- [ ] Physical Wi-Fi/device testing, roaming, simultaneous submissions, restart/reconnect bursts.
- [ ] Disk-full, power interruption, damaged database, certificate, clock, and partial-sync drills.
- [ ] Published supported capacity tied to measured hardware, software, and network configuration.
- [ ] Operational guides, lecturer onboarding, candidate instructions, invigilator recovery procedures.
- [ ] Privacy/retention decisions, support diagnostic redaction, production incident runbooks.
- [ ] Volunteer practice exam, low-stakes pilot, then controlled high-stakes release.

## Release gate

The MVP is complete only when the same assessment can be authored, delivered online and on a prepared disconnected LAN, recovered, graded, exported, and synchronized with verified security boundaries and documented operating limits. Working screens or passing unit tests alone do not satisfy this gate.
