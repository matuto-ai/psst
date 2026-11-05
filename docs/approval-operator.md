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

Requests expire after 24 hours; approved credentials expire 90 days after approval
by default, configurable as described below.
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


## Configure authorization lifetime

For the normal image/Compose workflow, set `PSST_AUTHORIZATION_DAYS` in the
deployment environment or Compose `.env` file, for example
`PSST_AUTHORIZATION_DAYS=730`, then recreate the broker normally. Compose forwards
it to the same `src/main.mjs` entrypoint used by the image. When running the image
directly, pass the same environment variable. Use an image built from a release
containing this change; the existing 0.6.0 image does not support it. This source
change does not publish an image or deploy anything.

The supported values are decimal whole numbers **1–3650 days inclusive**, with
no spaces, sign, leading zero, fraction, or `unlimited` value. One year is 365
days; 730 is two years. A day is exactly 86,400,000 milliseconds, independent of
DST or calendar-year length. The default remains 90 days when unset; Compose
also uses 90 for an empty variable. Direct invocation rejects an explicitly
empty value. Invalid values fail startup with a named setting/bounds message,
before the database is opened, even when the admin UI is disabled.

The setting applies **at approval time to new approvals only**. The broker stores
the finite expiry in the grant and returns it in the unchanged receipt format.
It is not computed from the pending request's creation time. Restarting, replaying
the request, repeating approve, or changing this setting never renews an existing
grant. No unlimited or far-future sentinel representation is supported.

### Existing installations and distinct clocks

Existing grants and private connector receipts keep their original finite expiry,
credential ID, installation ID and session identities. They continue to work
until their recorded expiry, unless explicitly revoked first. There is no
automatic extension, receipt rewrite, key rotation, per-session enrollment or
in-place renewal. If a replacement is needed, explicitly start setup in the
connector, approve that new request, verify it works and select it using the
connector's normal workflow; revoke the old installation explicitly afterward.
A replacement is a new installation identity, not a migration of existing sessions.

- A pending request has **24 hours** to receive explicit approval and has no API
  authority. Its deadline remains in protocol status for connector polling, but
  is no longer displayed as an authorization expiry in the administration list.
- An approved installation has the actual finite **authorization expiry** shown.
  Revoked/expired installations show their historical expiry as **inactive**,
  even when the original date is in the future. Never-granted requests display
  **No authorization granted**. The separate **Requested** creation time remains.
- Administrator login duration, transport heartbeat/leases, message/session
  retention and the 30-day revoked visibility policy remain unchanged.

At the exact authorization expiry, both the broker and the shared helper reject
the grant. All four shared-helper client types consume the same finite
`expires_at` value; no receipt-format or connector configuration change is needed.
Local receipt validity is not proof that a grant has not been revoked: the broker
enforces revocation immediately on authenticated API access.

## Settings page

Authorization lifetime can also be set in the authenticated Settings page when
not locked by the deployment environment/private configuration. Pending requests
default to 24 hours and can be shortened to 1–24 hours for future requests.
See [Settings](logging-settings.md) for precedence, future-only effects and the
distinct administrator/message clocks. Existing grants/requests are unchanged.
