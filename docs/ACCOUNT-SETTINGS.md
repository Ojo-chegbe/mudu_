# Account settings and profile

Administrators open Settings and Profile from the workspace sidebar. Candidates with a canonical account open them from their portal. Scoped offline examination passes do not gain account-management privileges.

## Connection and offline access

Automatic connection uses the existing signed-in identity. On a trusted local Host with offline access enabled, a provider outage switches that same workspace offline. The Host probes again while the interface is visible and reconnects automatically. Browser connectivity events trigger a server check; a browser reporting internet access is not proof that the provider is available.

Use offline access switches the current workspace in place. It preserves the page, edits, session and account. Automatic connection resumes online work with the existing provider credentials. Explicit offline mode pauses cloud operations until the user resumes automatic connection. Rejected or revoked provider sessions require sign-in; they do not authorize fallback.

A device password is needed to unlock after signing out or after the local session expires, rather than whenever connectivity changes. An offline device unlock without stored provider credentials needs one online sign-in to resume cloud work. Automatic fallback applies to trusted local administrator workspaces, not a disconnected remote website or a candidate examination session.

The initial setup prompt disappears after offline access is configured. Manage offline access then lives in Settings. Disabling access does not restore the onboarding prompt. Changes require the online account password and revoke existing device sessions on this Host.

## Settings

Connection controls, device access, reading size, reduced motion and the unread notification badge are functional. Display preferences belong to the signed-in account on this Host. Hiding the badge does not hide examination announcements. Unsaved changes have save/discard controls and a page-exit warning.

Cloud configuration, examination delivery, Host network controls, question-generation availability, schedule time zone and language are explained with links to their authoritative screens. Only the Host operator receives Host network controls. Connection mode does not change an examination's delivery authority, clock or preparation requirements. Completed examination uploads remain explicit; reconnecting does not imply every record is synchronized.

Support diagnostics include application/schema versions and configuration flags. They omit identities, tokens, passwords, private paths and examination contents.

## Profile and security

Profile shows account name, email, role, permanent confirmed-email status and, for candidates, organiser-controlled candidate number and identity status. Supported name changes update the provider and local account while preserving renewed credentials. Offline profile editing is disabled without discarding unfinished edits. Email and organiser-controlled identity are read-only.

Connected accounts link to password recovery. Signing out preserves saved records. Signing out other sessions requires the account password, keeps the current session and affects sessions on this Host only.

Confirmed-email verification does not expire. Sessions still expire or can be revoked. An active trusted local administrator session renews quietly when fewer than six hours remain, retaining the same cookie and a twelve-hour inactivity window. An expired or revoked session is never revived. Remote and candidate sessions retain their existing expiry rules.

## Upgrade

SQLite schema 20 adds per-session connection state and per-account preferences. Migration takes a pre-upgrade snapshot, preserves accounts, credentials and records, and recognizes previously configured offline access. Do not downgrade after migration.
