# Architecture and first-slice policies

## Boundaries

- `packages/exam-core`: runtime-independent assessment validation, answer validation, grading, question allocation, and types. No database or UI imports.
- `packages/contracts`: administrator API response contracts.
- `apps/host`: the current combined development service: SQLite persistence, primary identity module, examination transactions, HTTP API, and static hosting. The identity module is not an independent per-Host account system.
- `apps/web`: administrator and candidate React interfaces; candidate outbox separates unsent work from acknowledged answers.
- `tests`: engine, HTTP integration, persistence, crash recovery, and outbox tests.

Private completed-exam storage, question projects/questions, rosters and assessment authoring have PostgreSQL adapters. [Cloud assessment authoring](CLOUD-ASSESSMENT-AUTHORING.md) transfers private creation drafts and papers/settings, not running sessions or candidate password verifiers. [Local preparation](LOCAL-PREPARATION.md) creates separate pinned local runs. [Online execution](ONLINE-DELIVERY.md) persists attempts and examination state in PostgreSQL, uses database time, and invokes the existing examination engine through disposable in-memory projections. Both adapters have behavioural regression tests; live deployment, visual checks and capacity qualification remain separate release gates.

## Authority and snapshots

An assessment is authored once and copied into an immutable sitting snapshot at publication/launch. Shared-start sittings have one common deadline; individual-start sittings have an admission window and persisted per-candidate deadlines. Each run has one execution authority: local SQLite for local delivery or PostgreSQL for online delivery. Candidate attempts retain their original order, deadline, answers, and submission state across reconnection. The local adapter supports one active sitting per Host and one sitting per assessment; independent online examinations do not share that Host restriction. Repeated launch requests return the original sitting. Linked rosters can admit later approved members according to the separately controlled admission policy without changing the frozen question paper or existing attempts.

Questions and keys are server-owned. Candidate response objects are constructed from an allowlist and never include answer keys, roster credentials, or pass thresholds. Candidates receive questions only after starting; closed attempts expose confirmation rather than a question paper or score.

## Save protocol

Each answer has a question ID, value, expected revision, and random operation ID. Within one authoritative database transaction, the server validates eligibility, current status, deadline, answer shape, and revision; commits the answer, operation receipt, and audit event; then responds. Local transactions use SQLite; online transactions use PostgreSQL with a disposable shared-rule projection. A duplicate operation returns its original receipt. Reusing an ID with different content or updating an old revision fails with 409.

The browser stores pending work in IndexedDB. An in-flight operation cannot be replaced by subsequent typing; the newer value waits for its predecessor's acknowledgment and next revision. If an acknowledgment is lost, the same operation is retried. Server persistence is the only basis for “saved.” Browser storage can fail or be cleared; it is not an authoritative backup.

## Timing and closure

- Shared-start clocks begin at administrator launch; late starters receive the common remaining time.
- Individual-start clocks begin at the candidate's first successful Begin request, within the configured admission window. Closing that window does not end active attempts; an optional finish-by deadline caps their duration.
- Disconnecting, refreshing, or replacing a device never grants more time.
- Deadline checks occur on server operations; reconciliation also runs periodically and on startup.
- Late new answers are rejected. A retry of a previously committed operation can return its original receipt after closure.
- Submission is idempotent and final. Ending a sitting submits all active attempts using already-committed answers and records the administrative intervention.
- Audited pause/resume, individual/global time extensions and candidate force submission use a persisted execution overlay, not question-snapshot edits. Pause freezes authoritative time and blocks new starts, writes and voluntary submission; resume restores the elapsed paused duration. Clock-anomaly policy and preconfigured individual accommodations remain unimplemented. See [live controls](EXAM-CONTROLS.md) and [timing and admission](TIMING-AND-ADMISSION.md).

## Identity and threat assumptions

Local administration retains one offline Host account; initial Host setup is loopback-only. Supabase-authenticated administrators each own a separate server-enforced workspace. Provider tokens are verified server-side and encrypted locally; connecting the original Host workspace requires explicit cloud credentials and the existing Host password. Cloud administrator emails require confirmation and have [password recovery](PASSWORD-RECOVERY.md); MFA UX remains unimplemented. See [administrator accounts](SUPABASE.md) for setup and deployment boundaries.

Native candidate accounts retain their password verifiers and stable UUIDs on their original Host. Connected candidates use confirmed Supabase identities; existing accounts require explicit linking, never automatic email-based merging. [Cloud rosters](CLOUD-ROSTERS.md) synchronize connected memberships, joining links and approvals across Hosts without copying password verifiers. Candidate numbers are assigned through enrolment rather than reserved by public signup claims. Assessment registrations authorize admission; roster membership and expected eligibility lists are distinct. The current UI exposes one default organization. [Prepared offline admission](LOCAL-PREPARATION.md) uses scoped access files for connected identities, not a second account or a transported password verifier.

Passwords retain exact whitespace; account signup requires a passphrase/password of 8–128 characters. Session tokens are random, stored as hashes, and expire after 12 hours. Cookies use HttpOnly and SameSite=Strict; Secure is added for HTTPS. Mutation requests validate both origin and session CSRF token. Account login revokes earlier account sessions. Each exam request resolves registration for the signed-in account; assessment selection is request-scoped and cannot switch another tab's mutable global session.

Legacy invitation credentials remain supported only for existing or explicitly selected one-off assessments. Successful legacy login revokes previous sessions for that invitation. Prepared-run pass replacement is separately permissioned and audited; legacy replacement remains a roadmap item. Browser profiles, not individual tabs, carry cookie sessions. See [identity design](IDENTITY.md) and [local preparation](LOCAL-PREPARATION.md).

The app trusts the Host operating system, system clock, and privileged machine owner. This implementation does not provide encrypted databases, hardware trust, forensic tamper-proofing, or protection from an administrator with direct filesystem control. Request rates are bounded in-process; distributed abuse controls belong to cloud work.

## Persistence and release limitations

SQLite uses foreign keys, WAL, FULL synchronous mode, parameter binding, transactional writes, and a schema version. This first adapter uses a single synchronous connection. Queries and password hashing need realistic load measurement before capacity is published.

Schema v2 migration is additive and creates a consistent backup before upgrading a v1 database file; the current local schema is v17. Databases newer than the supported schema are rejected. Local preparation manifests are sealed with a Host-bound key, but the execution database itself is not encrypted. Scheduled operational backups, long-term retention, secure deletion, audit export, Host updates, installer signing, and disaster recovery remain unimplemented.

## Interface principles

Flat surfaces, thin borders, system fonts, one accent color, no shadows, no externally required assets, and no nonfunctional navigation to future features. Actual stored state drives dashboard counts. Manual-review results remain provisional. Online delivery appears only when its server configuration is present; local delivery remains independent of that configuration and connectivity during examination execution.
