# One account across online and local delivery

## Product invariant

A candidate creates one MUDU account. Online and local sittings refer to the same canonical account ID and registrations. A Host must never request a separate permanent account, password, or registration for an already approved examination.

## Implemented in this milestone

- `accounts`: stable UUID, email, name, protected password verifier, creation time.
- `memberships`: account-to-organization relationship, claimed candidate number, identity verification state. The initial UI uses one organization; this schema does not pretend multi-organization administration is complete.
- `registrations`: one account-to-assessment relationship, approval state, and authorized engine candidate/roster record. An engine candidate record represents enrollment, not another user account.
- `registration_settings`: persistent random link, policy, capacity, closing time, and open/closed state.
- Account sessions are independent of an examination. Every exam API request resolves its own approved registration; another account's assessment URL cannot confer access.
- Sign-in is by email until institutional identity is verified, then email or verified candidate number. A guessed number never claims a roster or supplies authorization.
- Repeat registration is idempotent. Closing/rotating a link leaves approved registrations and attempts intact. Launched exams reject new registrations and roster review changes.
- Verified identities selected in a new assessment roster are assigned automatically. Course/class groups remain future work; roster reuse does not create a second account.

## Authority in the development application

The current application is one development deployment that co-locates the primary identity service and local examination engine. Candidate accounts created there are canonical for that deployment. It does not currently synchronize identity across multiple installations, and is not a deployed cloud account system.

The primary identity authority is represented by `MUDU_IDENTITY_MODE=primary`. A future offline Host is a replica of selected canonical identities and registrations, not another issuer. The `replica` configuration currently refuses primary-password authentication, signup, and registration changes. It intentionally does not invent local accounts as a fallback. Replica-mode account admission is not usable until the transport below is implemented.

## Remaining offline admission transport

1. Prepare the approved sitting and registrations while connected to the primary service.
2. Bind a versioned identity/eligibility snapshot to the intended Host and sitting using authenticated, encrypted packaging.
3. Provide a restricted admission proof referencing the canonical account and registration IDs. Do not transfer reusable primary-password verifiers to lecturers' computers.
4. Verify issuer, Host/sitting scope, expiration, roster eligibility, and replay/session policy without a network call during the exam.
5. Provide an invigilator-controlled recovery path for a lost device/pass, keeping the same attempt and deadline.
6. Synchronize responses, results, and audit records against the original account and registration IDs.

QR/cached passes, certificate trust, secure browser storage, and offline expiry need real-device validation. An admission pass is authorization for an existing identity, not another account or permanent password. UI must not promise identical offline password verification before this mechanism is validated.

## Migration behavior

Schema v1 records retain their IDs and legacy credentials. The migration does not merge candidates by typed number, issue duplicate accounts, or overwrite attempts. New account registrations are separate from legacy assessments. A consistent `.before-v2` snapshot is taken before an existing v1 database is upgraded.

## Outstanding identity features

Verified email/recovery, multi-organization onboarding, institution-specific sign-in routes, membership correction and appeal workflows, class groups, optional passkeys, cloud identity deployment, and prepared offline admission remain explicit backlog items. This milestone is not production identity qualification.
