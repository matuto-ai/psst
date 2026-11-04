# Native URL-only setup (new source workflow)

This replaces manual pairing-ticket transfer for new installations. The existing
0.3.0 release does not contain this new UI until a subsequent release is published.
No agent obtains messaging access merely by knowing the broker address.

## One-time server settings

Use the normal image/Compose package and retain the existing `/data` volume.
Set `PSST_ADMIN_PASSWORD` to your own strong administrator password (at least16
characters) in your deployment's environment. There is no default password.
Optionally set `PSST_PUBLIC_ORIGIN` to the public HTTPS origin, especially when a
reverse proxy does not preserve Host. Do not disable TLS verification. Existing
proxy/certificate/network configuration remains yours; no additional service is
installed by the broker. Compose forwards these two settings into the broker.

Start/recreate the broker normally. Open its HTTPS address: it redirects to the
administration login form. No HTTP Basic prompt, policy-file editing, JavaScript
paste, credential-generator command or client bundle transfer is needed.

If the administrator password is absent, existing legacy mode remains unchanged;
there is no anonymous authorization or automatically created administrator.

## Administration pages

The console has separate **Clients & sessions**, **Messages** and **Approvals**
pages. The session registry distinguishes installation authorization from live
transport leases; message lists show metadata only until an individual detail is
opened. See [admin console identities, filters and retention](admin-console.md).

## Approve once, reuse across sessions

1. Inside the installed native connector, explicitly open setup and enter only the
   broker's HTTPS URL. The connector shows a request ID and pending approval.
2. Log into the broker UI. Match the request ID/type with the connector, not merely
   its untrusted display name. Approve or deny that installation.
3. The connector obtains the decision and connects using its private saved key.
   Later sessions load that authorization automatically. A previously explicit
   pending request can resume GET-only after restart; ordinary startup never
   submits a new request or rotates the key.

Requests expire after24hours; approved credentials expire90days after approval.
Expired/denied setup needs an explicit new setup decision, never silent renewal.
The UI can revoke an installation. This stops its current and future API access,
including long polls. Replacement approval does not silently revoke an old
installation: revoke it explicitly after the replacement works. Other native
sessions are independent identities, even when they share installation access.

Each connector must use its documented persistent native configuration directory
and preserve that directory when recreating a sandbox. Sharing credentials does
not mean sharing a session ID, mailbox or delivery cursor. Native host acceptance
and model processing remain distinct from durable inbox delivery.

## Automatic upgrade and recovery

With administration enabled, the broker makes a private verified SQLite snapshot
in `before-approval-*/broker.sqlite` beside the existing database before its first
schema4 migration. It uses SQLite backup, not an unsafe copy of a live WAL file;
fsync completes before migration. Failure stops startup rather than resetting
state. Existing config/credential files, ticket credentials, identities, pending
mail and idempotency records are preserved. Subsequent restarts do not repeat the
migration backup. Retain it privately; it contains application state/verifiers.

The old binary cannot read schema4. Rollback requires stopping the broker and
restoring the pre-migration snapshot using the established recovery procedure;
restoration loses changes accepted after the snapshot. Never run two writers or
replace a database while the broker runs. This is recovery, not an ordinary setup
step. Administrator sessions expire after8hours and require fresh login after
broker restart. Password changes require normal restart, invalidating UI sessions.


## Revoked authorization retention

Revoked installations remain in **Approvals & access** for 30 days (exactly
2,592,000,000 milliseconds) from the first successful revocation. At that boundary
they are excluded from each normal list read, before pagination. Refreshing the
page is sufficient; no new enrollment, background job, or broker restart is
required. An already-open page is a snapshot until refreshed. Repeating revoke
does not restart the period. This is a fixed policy, with no operator setting in
this version, independent of the credential's original expiration date.

This is **visibility retention, not physical deletion**. The durable terminal
request remains in SQLite indefinitely: request ID, token verifier (not the raw
key), canonical original request/type/label, terminal state, original creation,
request deadline and credential expiry, historical grant/result identities, and
revocation timestamps. These records preserve exact replay responses, reject
changed request bodies and reused keys/IDs, and retain the historical identity
associated with the decision. They never provide active credentials. Database
backups retain the same metadata under the operator's backup policy.

Revoked rows are excluded from terminal garbage collection. There is no safe
automatic deletion boundary while old clients may poll/replay or reuse the key:
hiding a record must not forget the revocation or collision reservation. This
release conservatively retains the existing terminal record rather than
introducing a second archive format. The 10,000-request admission bound counts
non-revoked records and revoked records still inside their visibility window.
Archived revocations do not consume admission capacity, so historical revocations
cannot permanently prevent new setup. The separate 1,000-pending-request limit
is unchanged. Durable tombstones still consume disk space and backup capacity;
operators should monitor storage growth. Do not delete them to reclaim space:
there is no automatic tombstone purge or storage quota that forgets revocation. Denied and expired requests
keep their existing, separate cleanup rule: on new enrollment, delete records
more than 30 days past the later of request deadline and credential expiry.
Pending/approved requests, session identities and message retention are unchanged.

### Existing records and restart

The upgrade adds nullable `revoked_at` and `revocation_observed_at` columns in one
transaction. For an existing revoked row whose true revocation time is unknown,
`revoked_at` stays null. The first upgraded startup records the current broker
clock as `revocation_observed_at` and grants a full 30-day visibility grace period
from that observation. It is not presented as the historical revocation time.
The observation is persisted, so restarts and repeated revoke cannot extend it.
No historical record is purged, including already-old revoked installations.

A successful new revoke records its actual broker-clock timestamp. Broker clocks
must be maintained accurately; a backwards clock adjustment can delay visibility
expiry. Access remains denied regardless of visibility or clock adjustments.
The old broker's garbage collector includes revoked rows, so do not run an older
binary against an upgraded database: it can discard retained revocation evidence.
Use the established private backup/recovery process for rollback, and account for
decisions made after a backup before serving traffic. No production cleanup or
deployment is part of this change.
