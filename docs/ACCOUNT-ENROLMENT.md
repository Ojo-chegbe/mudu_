# Account, enrolment and application identifiers

Candidates sign in with email and their existing password. A new public signup does not accept
a self-assigned institutional number. The account UUID is permanent; the current membership
record has an opaque ACCOUNT-prefixed internal reference until an organiser assigns a number.
These internal references are not candidate login credentials.

## Roster workflow

- Existing account: search by name/email/legacy number, select the exact account, optionally
  assign a student number, then Add to roster. Membership becomes approved immediately and
  appears in My groups with an in-app notification. No verification checkbox is required.
- New candidate: enter name/email and optional student number. The place is Invitation pending.
  Share the personal link; the app does not send email. The invited email and possession of the
  link are required to accept it. Acceptance enrols the account automatically, without a second
  approval request. Unused invitations can be cancelled to release their number reservation.
- A general joining link still creates a membership request. Approval is a membership decision,
  not a separate identity-verification workflow. Optional eligibility rules are not enrolment.

Student numbers are assigned/reserved within the current organisation/workspace, not globally.
Existing schema `verified` status is retained internally to mean an assigned, unique number;
it does not certify a real-world identity. Legacy pending number claims remain unassigned until
an organiser selects an account. Conflicting claims cannot both become assigned. Past exam
snapshots and results are not renumbered when an organiser assigns an account a number.

## Application references

Every assessment registration receives APP-000001, APP-000002, etc. References are unique
within the assessment; the same number may appear in another assessment. Allocation is part of
the database insertion transaction and has a unique constraint. Reopening or repeating the same
registration does not allocate another reference. References are displayed on the candidate's
assessment cards and in administrator registration review, and are not accepted for login.

## Migration and deployment boundary

Schema 7 backs up existing databases to `mudu.sqlite.before-v7`, adds invitation and reference
tables, and backfills references without replacing accounts, password hashes, memberships or
results. Existing users must sign in with their email, not their old candidate number.

This build still has one organisation per Host (`default`). Multi-institution cloud account
management and prepared offline admission/synchronisation are not implemented by this change.
Two IP addresses served by the same Host share accounts; different Host databases do not.
Changing IP can require a fresh email/password login because browser cookies are host-scoped.
