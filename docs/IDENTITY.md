# One account across online and local delivery

## Product invariant

A candidate creates one MUDU account. Online and local sittings refer to the same canonical account ID and registrations. A Host must never request a separate permanent account, password, or registration for an already approved examination.

## Implemented in this milestone

- `accounts`: stable UUID, email, name, protected password verifier, creation time.
- `memberships`: account-to-organization relationship, claimed candidate number, identity verification state. The initial UI uses one organization; this schema does not pretend multi-organization administration is complete.
- `registrations`: one account-to-assessment relationship, approval state, and authorized engine candidate/roster record. An engine candidate record represents enrollment, not another user account.
- `registration_settings`: persistent random link, policy, capacity, closing time, and open/closed state.
- Account sessions are independent of an examination. Every exam API request resolves its own approved registration; another account's assessment URL cannot confer access.
- Sign-in is by email and password. Assigned candidate numbers identify enrolment, not account ownership. A guessed number never claims a roster or supplies authorization.
- Repeat registration is idempotent. Closing/rotating a link leaves approved registrations and attempts intact. Launched exams reject new registrations and roster review changes.
- Existing candidates selected in a new assessment roster are assigned automatically. Reusable groups support joining requests and assigned assessments; roster reuse does not create a second account.

## Authority in the development application

Local-password candidate accounts remain canonical to their original deployment.
Connected candidate signup/sign-in now uses Supabase Auth with explicit provider-UUID
bindings. Existing local candidates can connect while preserving their local ID and
enrolments. Another connected installation recognizes the provider identity and
receives connected roster membership through the cloud adapter. Explicit
[local preparation](LOCAL-PREPARATION.md) adds a pinned local run and scoped offline
admission without copying passwords. See [connected candidate identities](CLOUD-CANDIDATES.md)
and [cloud rosters](CLOUD-ROSTERS.md).

The primary identity authority is represented by `MUDU_IDENTITY_MODE=primary`. An offline Host uses selected canonical identities and registrations, not another issuer. The `replica` configuration refuses primary-password authentication, signup, and registration changes. Prepared candidate access files now supply scoped admission in replica mode; the Host does not invent another account as a fallback.

## Offline admission transport

1. Prepare the approved sitting and registrations while connected to the primary service.
2. Bind a versioned identity/eligibility snapshot to the intended Host and sitting using authenticated, encrypted packaging.
3. Provide a restricted admission proof referencing the canonical account and registration IDs. Do not transfer reusable primary-password verifiers to lecturers' computers.
4. Verify issuer, Host/sitting scope, expiration, roster eligibility, and replay/session policy without a network call during the exam.
5. Provide an invigilator-controlled recovery path for a lost device/pass, keeping the same attempt and deadline.
6. Synchronize responses, results, and audit records against the original account and registration IDs.

Host-bound admission files, expiry and recovery are implemented and still need real-device validation. An admission pass is authorization for an existing identity, not another account or permanent password. Offline delivery does not verify the cloud password. The local delivery experience uses an address, not a QR code. Read [activation, security and HTTP limitations](LOCAL-PREPARATION.md).

## Migration behavior

Schema v1 records retain their IDs and legacy credentials. The migration does not merge candidates by typed number, issue duplicate accounts, or overwrite attempts. New account registrations are separate from legacy assessments. A consistent `.before-v2` snapshot is taken before an existing v1 database is upgraded.

## Outstanding identity features

Connected accounts have [password recovery](PASSWORD-RECOVERY.md). Local-only recovery, multi-organization onboarding, institution-specific sign-in routes, membership correction and appeal workflows, optional passkeys, production cloud deployment, and real-device offline admission qualification remain explicit backlog items. Connected email confirmation is provided by Supabase; native local signup does not verify email ownership. This milestone is not production identity qualification.
