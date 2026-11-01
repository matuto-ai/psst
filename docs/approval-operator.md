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
