# Architecture and first-slice policies

## Boundaries

- `packages/exam-core`: runtime-independent assessment validation, answer validation, grading, question allocation, and types. No database or UI imports.
- `packages/contracts`: administrator API response contracts.
- `apps/host`: the current combined development service: SQLite persistence, primary identity module, examination transactions, HTTP API, and static hosting. The identity module is not an independent per-Host account system.
- `apps/web`: administrator and candidate React interfaces; candidate outbox separates unsent work from acknowledged answers.
- `tests`: engine, HTTP integration, persistence, crash recovery, and outbox tests.

The cloud adapter is not implemented. The shared engine is the reuse boundary; the SQLite store is explicitly Host-specific. Later PostgreSQL work must pass the same behavioral scenarios before being considered equivalent.

## Authority and snapshots

An assessment is authored once and copied into an immutable sitting snapshot at launch. A sitting has one common deadline and one local execution authority. Candidate attempts retain their original order, deadline, answers, and submission state across reconnection. The first slice supports one active sitting per Host and one sitting per assessment. Repeated launch requests return the original sitting.

Questions and keys are server-owned. Candidate response objects are constructed from an allowlist and never include answer keys, roster credentials, or pass thresholds. Candidates receive questions only after starting; closed attempts expose confirmation rather than a question paper or score.

## Save protocol

Each answer has a question ID, value, expected revision, and random operation ID. Within one SQLite transaction, the Host validates eligibility, current status, deadline, answer shape, and revision; commits the answer, operation receipt, and audit event; then responds. A duplicate operation returns its original receipt. Reusing an ID with different content or updating an old revision fails with 409.

The browser stores pending work in IndexedDB. An in-flight operation cannot be replaced by subsequent typing; the newer value waits for its predecessor's acknowledgment and next revision. If an acknowledgment is lost, the same operation is retried. Server persistence is the only basis for “saved.” Browser storage can fail or be cleared; it is not an authoritative backup.

## Timing and closure

- The clock starts at administrator launch, not individual candidate start.
- Late admissions receive the common remaining time.
- Disconnecting, refreshing, or replacing a device never grants more time.
- Deadline checks occur on server operations; reconciliation also runs periodically and on startup.
- Late new answers are rejected. A retry of a previously committed operation can return its original receipt after closure.
- Submission is idempotent and final. Ending a sitting submits all active attempts using already-committed answers and records the administrative intervention.
- No pause, time extension, clock-anomaly policy, schedule, or individual accommodation is implemented yet.

## Identity and threat assumptions

Local administration has one account and no recovery or MFA yet. The first setup requires a loopback connection and no existing administrator. Persistent candidate accounts own password verifiers and stable UUIDs. Organization memberships own candidate numbers, and registrations authorize an account for an assessment. The current UI exposes one default organization. Verified candidate numbers are unique within that organization; unverified claims cannot reserve a number against the legitimate owner. Every first-time claim requires an explicit identity check before approval. Email verification is not implemented and email alone is not proof of institutional identity.

Passwords retain exact whitespace; account signup requires a passphrase/password of 15–128 characters. Session tokens are random, stored as hashes, and expire after 12 hours. Cookies use HttpOnly and SameSite=Strict; Secure is added for HTTPS. Mutation requests validate both origin and session CSRF token. Account login revokes earlier account sessions. Each exam request resolves registration for the signed-in account; assessment selection is request-scoped and cannot switch another tab's mutable global session.

Legacy invitation credentials remain supported only for existing or explicitly selected one-off assessments. Successful legacy login revokes previous sessions for that invitation. Invigilator-approved replacement is a roadmap item. Browser profiles, not individual tabs, carry cookie sessions. The [identity design](IDENTITY.md) describes canonical account ownership and the remaining offline admission work.

The app trusts the Host operating system, system clock, and privileged machine owner. This implementation does not provide encrypted databases, hardware trust, forensic tamper-proofing, or protection from an administrator with direct filesystem control. Request rates are bounded in-process; distributed abuse controls belong to cloud work.

## Persistence and release limitations

SQLite uses foreign keys, WAL, FULL synchronous mode, parameter binding, transactional writes, and a schema version. This first adapter uses a single synchronous connection. Queries and password hashing need realistic load measurement before capacity is published.

Schema v2 migration is additive and creates a consistent backup before upgrading a v1 database file. Databases newer than the supported schema are rejected. Scheduled operational backups, encrypted packages, long-term retention, secure deletion, audit export, Host updates, installer signing, and disaster recovery remain unimplemented.

## Interface principles

Flat surfaces, thin borders, system fonts, one accent color, no shadows, no externally required assets, and no nonfunctional navigation to future features. Actual stored state drives dashboard counts. Manual-review results remain provisional. No cloud availability or synchronization is implied by this local-only build.
