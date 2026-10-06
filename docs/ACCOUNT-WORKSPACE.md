# One MUDU account and your workspace

Create a MUDU account, confirm its email, and sign in. The Host automatically creates a private working workspace bound to that provider identity. Signing in again on the same Host reuses it. It does not create a second account or merge another person's records.

On a fresh Host, the first online administrator to sign in on the computer also becomes its Host operator. This enables local delivery without a separate Host account form. An existing Host operator is never replaced by another online sign-in. Remote HTTPS sign-ins do not claim a Host. Existing local operators can still connect their original workspace through **Connect account** with their existing Host password.

The sidebar shows the account connection separately from the current sign-in method. Assessment, roster and question-bank screens show their actual save/synchronization status. An account connection is not a guarantee that every record has uploaded. Cloud storage activation remains necessary; completed examination upload is explicit. Another computer retrieves supported synchronized records, not unsynchronized files from the first computer.

## Offline access on a trusted computer

From the workspace, choose **Enable offline access** while signed in online. Confirm your MUDU password and choose a device password of at least 12 characters. This authorizes the same administrator identity to unlock its existing workspace on this Host; it does not create another account or change the online password. The device verifier is salted and hashed locally, never synchronized. Only enable this on a trusted computer.

At sign-in choose **Use offline access on this computer**, then enter your MUDU email and device password. Switching an already signed-in workspace offline does not require this unlock step. Automatic connection resumes using the existing online session; only a device unlock without provider credentials requires an online sign-in. Existing local records remain available; connected local examinations must be prepared while online before disconnected delivery. Other administrators' records and Host network controls remain private.

To change or disable device access, open **Settings ? Manage offline access** while connected online. Confirm the online password again. Changing or disabling access revokes existing device sessions for that administrator on this Host and retains saved records. Disabling does not delete the account, remove the workspace, or affect another computer. A forgotten device password can be replaced after online sign-in.

An online password reset revokes this Host's account sessions, including device sessions. It does not automatically replace the device password. A disconnected computer cannot immediately learn that a cloud password or account changed. Manage offline access on each trusted Host; the setting is not central device revocation. This access mechanism is independent of the invigilator-controlled candidate admission passes.

See [Settings, Profile and automatic connection](ACCOUNT-SETTINGS.md) for in-place switching, outage fallback, session renewal and permanent email verification.

## Upgrade and verification

SQLite schema 19 adds device access and device session tables; schema 20 adds connection state and account preferences. Existing accounts, credentials, workspace ownership, answers and examination records are preserved, with the normal pre-upgrade snapshot. Do not downgrade after migrating.

Regression tests cover automatic Host/workspace creation, repeated sign-in, separate owners, current-password confirmation, CSRF protection, hashed device credentials, provider outage sign-in, unchanged records, password rotation and device-session revocation. These do not replace live Supabase email/sign-in checks or physical classroom qualification.
