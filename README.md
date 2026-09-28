# MUDU

Create assessments. Deliver them anywhere.

This repository contains a **development examination application with persistent candidate accounts and registrations**, not the complete MVP or a production-qualified service. One canonical account is reused across examinations. The current single-process application hosts the primary identity service beside the examination engine. Cloud deployment, multi-organization management, prepared offline admission, AI generation, secure LAN commissioning, installation, backups, and synchronization remain on the [roadmap](docs/ROADMAP.md). See the [one-account identity model](docs/IDENTITY.md).

## Run locally

Requires Node.js 24.13 or newer within the 24.x release line and npm. Use the supplied lockfile for reproducible installation.

```powershell
npm.cmd ci
npm.cmd run dev
```

Open **http://127.0.0.1:5173**. This runs the API on port 4310 and the development web app on 5173. Keep this terminal running; Ctrl+C stops both processes. Use the exact IP-based URL above, rather than substituting localhost, because origin validation is explicit.

To serve the built application from the Host itself:

```powershell
npm.cmd run build
npm.cmd start
```

Open **http://127.0.0.1:4310**. Do not run both workflows simultaneously on the same ports.

### Local AI key

Put your operator key in the project-root `.env` file (use `.env.example` as a blank template):

```dotenv
MUDU_GOOGLE_AI_KEY=your-google-api-key
```

Restart MUDU after changing it. `npm run dev`, `npm run dev:host` and `npm start` load this file
automatically for the Host; an existing terminal variable overrides the file. The key must never
use a `VITE_` prefix. `.env` is ignored by Git, but keep it out of shared folders and deployment
archives too. Lecturers and candidates do not enter their own keys.

## Try the complete flow

1. Create the local administrator account. Use a password of at least 12 characters. Password reset is not implemented yet.
2. Create an assessment. Set the title, course label, duration, pass percentage, and randomization.
3. Add single-choice, multiple-select, or short-answer questions. Short answers remain provisional because the manual marking interface is not implemented yet.
4. Keep **MUDU account** as the candidate access method. Choose lecturer approval or a restricted roster. Optionally set a closing time and candidate limit. Roster CSV headers are `candidate_id,name`; passwords are not needed. Previously verified candidates can be selected and assigned automatically.
5. Create the assessment, then copy its persistent registration link from the overview. Closing registration, starting the exam, and ending the exam are separate actions. Starting the exam closes registration automatically.
6. In a separate browser profile/private window, open the registration link. Create one MUDU account with a name, email, candidate number, and password/passphrase of at least 15 characters. Later registrations reuse this account. Signup from an open link requests registration automatically; returning users sign in and click Register.
7. Review requests in the administrator overview. Explicitly verify a first-time candidate number before approving it. An unverified typed number is not sufficient for admission or candidate-number sign-in. Email ownership verification is not implemented; the lecturer must verify identity independently.
8. Candidates initially sign in with email and password. Once their number is verified, they can use that number and the same password. **My examinations** shows upcoming, pending, active, and completed assessments.
9. Start the examination when candidates are ready. **The common deadline starts immediately for everyone. Late arrivals get only the time remaining.** Candidates open their approved assessment from the dashboard; no per-exam secret is required.
10. Begin, answer, revisit questions, and submit. Only a server acknowledgment is displayed as saved. Review progress, grades, recent events, and CSV export as administrator.

Existing one-off-key assessments remain compatible. Their `/exam?code=...` links and `/exam/legacy` entry page still work. New one-off assessments can be created explicitly, with the original private key export process. No existing attempt is automatically reassigned based on a matching candidate number.

No demo accounts, default passwords, sample examinations, or fake dashboard results are created automatically.

## Implemented

- Flat responsive React interface without shadows or externally hosted assets/fonts.
- One local administrator account, hashed credentials, session cookies, origin/CSRF checks, role enforcement, and bounded request bodies.
- Persistent candidate accounts, organization-scoped identity verification, and a multi-examination dashboard.
- Registration links, approval/rejection, roster restrictions, automatic closing time, candidate limits, close/reopen, and link rotation.
- Verified roster reuse automatically assigns future assessments to the same account. Closing or replacing a registration link preserves existing registrations.
- Assessment creation, roster CSV import, server validation, and frozen sitting snapshots.
- Three question types; exact-match multiple-select grading; short answers flagged for manual review.
- Persisted question/option randomization, common server deadline, and one attempt per candidate per sitting.
- Transactional SQLite answer saving with idempotent operation receipts and optimistic revisions.
- Browser pending-answer outbox, safe retry, and recovery of acknowledged work across sign-ins/restarts.
- Device sign-in revokes previous candidate sessions. Multiple tabs in one profile share the same browser session; revisions protect against stale writes.
- Submission, automatic expiry, administrator end action, results, audit events, and CSV export with formula-cell protection.

## Data and access boundaries

On Windows, runtime data defaults to `%LOCALAPPDATA%\MUDU\Host\mudu.sqlite`, **outside this OneDrive workspace**. Other platforms use a local application data directory beneath the home directory. `MUDU_DATA_DIR` can override the location. Keep it on an internal disk, outside cloud-synchronized or network folders.

The database is not encrypted at rest in this milestone. OS account/disk protection is necessary; managed encryption and key handling remain future work. Do not use real student data for development.

The administrator service binds to `127.0.0.1` by default. Administrator operations and setup remain restricted to loopback. For router-based HTTP delivery, open **Local delivery** in the workspace, choose the examination network and start delivery. This launches a separate candidate listener on the selected private IPv4 address, port 4311; no certificate or internet is required. Sharing links update automatically. HTTP is unencrypted and requires explicit acknowledgement. See [local delivery and physical testing](docs/local-delivery.md). The supplied startup commands load the root `.env` file; process environment variables take priority.

| Variable                         | Purpose                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MUDU_DATA_DIR`                  | Local directory for the SQLite database                                                                                                       |
| `MUDU_PORT`                      | Host port; default 4310                                                                                                                       |
| `MUDU_BIND`                      | Listen address; default 127.0.0.1                                                                                                             |
| `MUDU_ORIGIN`                    | Exact public origin for Host and request validation                                                                                           |
| `MUDU_WEB_ORIGIN`                | Explicit extra origin for local development; dev script sets port 5173                                                                        |
| `MUDU_TLS_CERT` / `MUDU_TLS_KEY` | Existing trusted TLS certificate/key files                                                                                                    |
| `MUDU_IDENTITY_MODE`             | `primary` (default) owns canonical accounts; `replica` disables account-password authentication, account creation, and registration mutations |

`replica` is a fail-closed development boundary, not completed offline account admission. Signed admission passes and their transfer to prepared Hosts are not implemented yet. Do not run independent primary services per lecturer and present them as one synchronized identity system. Production uses one identity authority and prepared Host representations of those same account IDs.

Schema v2 adds accounts and registrations. On the first upgrade of an existing v1 file, the application writes a consistent `mudu.sqlite.before-v2` backup before migration. Existing keys, sessions, assessments, responses, and attempts are preserved; backups contain sensitive records and need the same protection as the database.

TLS support remains a configuration hook for secured deployments, **not a completed secure LAN commissioning solution**. The in-app local delivery flow deliberately uses HTTP on a controlled network. Windows firewall permission, supported phones, router isolation and classroom capacity still require physical validation. Do not bypass HTTPS certificate warnings or treat HTTP as encrypted.

## Verification

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd run format:check
```

Tests cover grading, validation, CSV behavior, authentication/authorization, answer-key redaction, CSRF/origin protection, retries, stale revisions, expiry, device revocation, pending-answer recovery, database reopen, and abrupt process termination. Account tests cover one identity across multiple examinations, unverified-number impersonation, duplicate registration, limits, closure, link rotation, account isolation, replica restrictions, and v1 data preservation.

The native `node:sqlite` API is experimental in the installed Node 24 runtime. It is isolated in the Host adapter. Runtime/SQLite patch selection and load qualification are release gates; the current build is not a claim of support for 200 candidates. The crash test proves process-restart behavior, not physical disk failure or all power-loss scenarios.

Browser visual/mobile testing has **not** been completed: no browser was connected during initial implementation. Automated API and queue tests do not replace it.

See [architecture and policies](docs/ARCHITECTURE.md) and [implementation roadmap](docs/ROADMAP.md).
