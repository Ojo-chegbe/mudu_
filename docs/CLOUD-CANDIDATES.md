# Connected candidate identities

This is the identity foundation for [cloud-backed rosters](CLOUD-ROSTERS.md).
Connected roster membership can now follow the provider identity to another Host;
scoped offline admission is now available through [local preparation](LOCAL-PREPARATION.md).

## Use

With the existing Supabase URL and publishable key configured, `/exam` offers
connected candidate signup/sign-in. Confirm the signup email, then sign in.
Local Host addresses keep local sign-in as the default; choose **Use connected
sign-in** explicitly. Configuring administrator cloud sync does not change local
candidate authentication into an internet-dependent flow.
The browser receives only the application cookie and CSRF token, not provider tokens.
No additional Supabase SQL migration is required for this authentication slice.

For an existing candidate on this Host:

1. Choose **Use my existing account on this Host** and sign in normally.
2. On **My examinations**, select **Connect account**.
3. Supply the existing local password and sign in to a confirmed connected account
   using the same email. The dialog can also create that connected sign-in.
4. If confirmation is required, confirm the email and return to finish connecting.
   No local records or session are changed while confirmation is pending.

The old local password stays usable on the original Host without internet.
The connected password can be different; it authenticates the same linked candidate,
not a second enrolment. Connected accounts support [email password recovery](PASSWORD-RECOVERY.md); separate local-only passwords remain unchanged.

## Identity and security

- Supabase Auth's verified user UUID is the portable identity. Each Host stores an
  explicit one-to-one mapping to its local account UUID. Linking preserves local
  account IDs, assigned student numbers, approved memberships and assessment history.
- Signing into another connected installation creates an identity cache keyed by
  that provider UUID, with no local password verifier. Cloud rosters transfer eligible
  membership independently; assessment attempts are not copied by signing in.
- Existing local accounts are never adopted through email matching alone. Connecting
  requires the local session, CSRF, local password and confirmed cloud credentials.
- Account collisions and conflicting bindings fail without merging or overwriting.
- Provider access/refresh tokens are encrypted server-side with session-bound AES-GCM.
  Each cloud-authenticated operation verifies the provider identity and local binding.
  Revocation clears the session; temporary provider outages do not discard it.
- Cloud sign-in requires HTTPS outside loopback. Authentication throttles, same-origin
  checks, HttpOnly cookies and CSRF protections remain active.
- The LAN candidate listener and replica Hosts never call Supabase for admission.
  They reject cloud signup/sign-in. A cloud session cookie cannot make the LAN
  bootstrap appear signed in when that listener cannot validate it.

## Migration and validation

SQLite v15 adds only `candidate_provider_identities`; it does not rewrite accounts,
responses, memberships or password hashes. Existing databases get a pre-v15 snapshot.
Automated tests cover stable identities across Hosts, explicit linking, preserved
assignments, uniqueness/collision handling, revocation, provider outages, CSRF,
candidate-only permissions and LAN/replica boundaries.

Real email confirmation, sign-in across actual installations and browser/accessibility
walkthroughs still need testing against the configured project. No production security
or network-capacity claim follows from the automated tests.

## Next

Cloud rosters now provide private owner-scoped records, authenticated joining by
provider UUID, explicit approval, duplicate-resistant membership changes,
concurrent-edit handling and local identity alias resolution. Local-only members
remain enrolled locally until explicitly connected; they are never uploaded as if
they were authenticated portable identities.

Cloud-backed assessment authoring and scoped prepared offline admission are now
implemented development milestones. A new cloud-only candidate cannot use their
reusable cloud password on a disconnected Host; their private examination access
file authorizes the existing identity for one prepared run. Real-device validation
and full cloud execution remain separate work.
