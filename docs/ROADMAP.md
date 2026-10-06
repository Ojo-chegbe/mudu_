# MUDU build roadmap

This tracks the complete agreed MVP while distinguishing the first development slice from release-ready capabilities.

## Implemented development foundation

- [x] Account Settings and Profile, scoped display preferences, one-time offline onboarding, in-place connection switching and trusted Host outage fallback. See [behavior and boundaries](ACCOUNT-SETTINGS.md).

- [x] Windows x64 Host with an embedded WebView2 interface, offline runtime prerequisite, bundled Node runtime, per-user installer, tray lifecycle, native downloads and explicit data-preserving updates. See [installation and release gates](HOST-INSTALLATION.md). Signing and broad Windows installation/network qualification remain pending.

- [x] Prepared local runs and scoped offline candidate passes. See [local preparation](LOCAL-PREPARATION.md).
- [x] PostgreSQL online attempts, authoritative timing, autosave, monitoring, announcements, administrative controls, essay grading, results, explicit device recovery and reruns. See [activation and qualification](ONLINE-DELIVERY.md). This is implemented code, not a live deployment or a capacity certification.

- [x] Supabase administrator signup/sign-in, confirmed provider identity and explicit existing-workspace connection.
- [x] Automatic account-bound workspace and fresh Host setup, distinct account/save status, and optional device offline access for the same administrator. See [account and workspace behavior](ACCOUNT-WORKSPACE.md).
- [x] Server-side administrator workspace isolation for assessments, rosters, question-bank resources, directories, results and notifications.
- [x] Private cloud question projects/questions, local-first saves, cross-Host retrieval, revision conflicts and recovery copies. See [activation and boundaries](CLOUD-QUESTION-BANK.md).
- [x] Private cloud rosters, identity-scoped joining, approvals/invitations, cross-Host transfer, revision conflicts and offline-exam isolation. See [activation and boundaries](CLOUD-ROSTERS.md).
- [x] Private cloud assessment authoring, durable creation drafts, cross-Host papers/settings, conflict recovery and delivery-authority boundaries. See [activation and boundaries](CLOUD-ASSESSMENT-AUTHORING.md).
- [x] Pinned local runs, Host-bound sealed manifests, private candidate access downloads, scoped offline sessions and audited recovery. See [activation and boundaries](LOCAL-PREPARATION.md).
- [ ] Full Supabase examination execution; see [setup and boundaries](SUPABASE.md).

- [x] Isolated repository, React/TypeScript build, formatting, shared engine boundaries.
- [x] Local administrator setup and candidate authentication.
- [x] Assessment creation, roster CSV import, question configuration, frozen sitting snapshot.
- [x] Candidate instructions, navigation, server deadline, autosave, submission confirmation.
- [x] Persisted question randomization, idempotent writes, answer revisions, device-session revocation.
- [x] Objective grading, provisional short answers, candidate progress, recent audit events, results CSV.
- [x] Restart and abrupt process-termination tests, HTTP lifecycle/security tests, outbox retry tests.

## 1. Validate and complete the first slice

### Candidate account milestone

- [x] Connected candidate signup/sign-in, confirmed provider identities and explicit local-account linking without password-verifier transfer; see [boundaries](CLOUD-CANDIDATES.md).
- [x] One persistent canonical account across examination registrations.
- [x] Organization-scoped candidate-number verification; email or verified-number sign-in.
- [x] Candidate dashboard with pending, upcoming, active, and completed examinations.
- [x] Persistent links, approval/rejection, roster restrictions, close/reopen, deadlines, and link rotation.
- [x] Automatic assignment from reused verified roster entries.
- [x] Schema v2 migration and backup with preservation tests for existing attempts.
- [x] Fail-closed offline-replica boundary: no second signup or primary-password authentication.
- [x] Prepared offline admission for connected canonical identities, without password transport or second accounts.
- [ ] Cloud deployment and real-device qualification of offline admission.
- [x] Connected candidate and administrator password recovery with restricted grants, session revocation and preserved records. [Email-template activation and live delivery checks](PASSWORD-RECOVERY.md) remain required.
- [ ] Native local email verification, organization administration, and reusable class groups.

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
- [x] Shared/individual timing, availability windows, optional finish-by cap, connected roster updates and administrator-controlled late admission.
- [ ] Expanded readiness validation, accommodations, revisiting policy, multiple sittings.
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

- [x] Presence heartbeats, disconnected state, observed reconnection history, saved-answer progress, status filters and candidate search. See [live monitoring](MONITORING.md).
- [x] Persisted exam-wide announcements, reconnect delivery and candidate acknowledgements.
- [ ] Focus events with context and no automatic misconduct determination.
- [x] Audited pause/resume, individual/global extra time, individual force-submit. See [live controls](EXAM-CONTROLS.md).
- [ ] Defined question correction/exclusion and regrading behavior.
- [ ] Manual marking interface, rubrics, concurrency control, grading revisions.
- [ ] Result publication, defined analytics denominators, distribution and question-level performance.

## 6. Synchronization

Completed-examination records now have a tested private PostgreSQL adapter and
resumable local queue. This is not the full cloud examination or management-data
adapter. The real project's migration and live network testing are still required.
See [cloud synchronization setup and boundaries](CLOUD-SYNC.md).

- [x] Completed-exam snapshot queue, chunk resume, checksums, idempotent receipts and bounded retry.
- [x] Transactional owner-scoped PostgreSQL publication, RLS/grants and authority/revision conflict quarantine.
- [x] Private cloud result browsing and exam-named CSV export; synchronized copies stay read-only.

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
