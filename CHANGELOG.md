# Changelog

## 0.5.1 (source candidate; publish separately)

- Refine the administrator console into a compact, restrained interface with
  persisted Light / Dark / System appearance and accessible mobile controls.
- Update GET filters automatically: immediate selectors, debounced text, retained
  focus, applied URLs and history, stale-request cancellation and recoverable
  errors. Ordinary form submission remains available without JavaScript.
- Default session browsing to Connected and visible name ascending; provide
  explicit All and sortable name, type, transport and heartbeat columns. Keep
  exact identities and presence help available in expandable controls.
- Keep message metadata newest-first/default 10 and load content only by explicit
  detail. Preserve approval actions, authentication, cookies, origin and CSRF.
- Add actual Chromium interaction regressions and synthetic responsive screenshots
  to the existing CI job, including themes, request races and no-JS fallback.

This is an admin-only update from 0.5.0: no broker protocol, reference SDK or
schema change, and no connector upgrade or re-enrollment is required. Existing
configuration, database, credentials and private HTTPS proxy remain in place.
The source commit does not publish or deploy an image. The operator must publish
`v0.5.1` and wait for its successful Release image workflow before selecting
`ghcr.io/matuto-ai/psst:0.5.1`. Earlier 0.5.0 upgrade/verification boundaries below
still apply; this UI work does not complete native unsolicited event consumers.

## 0.5.0 (source candidate; publish separately)

- Split the administrator console into Clients & sessions, Messages and Approvals
  pages. Show readable client names/types, separate installation/session IDs,
  transport presence and freshness without exposing credentials. Message lists
  default to 10 metadata-only rows, newest first, with filters and pagination;
  original content is fetched only on the explicit message detail page.
- Add sender-owned outgoing history and explicit original-content retrieval, with
  bounded, filter-bound pagination and truthful clock-driven expiry status.
- Add explicit resend as a new message with lineage and distinct cancellation.
  Same-operation retries retain their identity; an unresolved older operation
  does not block a distinct new send. Claimed cancellations retain uncertainty,
  and a late valid completion can still report delivered.
- Add feature-negotiated, resumable graceful disconnect and timestamped lease
  presence. Add durable, bounded pending-delivery offline events with deduplication
  and acknowledgement; reconnect, cancellation, expiry and completion suppress
  obsolete events. No automatic resend or cancellation occurs.
- Forward private host shutdown cancellation through networked reference facade
  operations. Keep administrator authentication, cookie, CSRF and origin checks.

### Upgrade and compatibility

Upgrade the **broker before connectors** that use the new history, resend,
cancellation or presence APIs. Older connectors retain existing endpoints;
reference graceful disconnect is feature-gated and falls back to lease expiry
when unsupported. New endpoints require the upgraded broker: do not assume that
an older broker supports them, or reinterpret a missing endpoint as success.

Before upgrading, make and verify a private SQLite backup using the existing
[`scripts/backup.mjs`](docs/operations.md) tool, which includes WAL safely. Preserve
the existing Compose project, volumes, private configuration, credentials and
HTTPS proxy. Do not copy only a live SQLite file, delete volumes, or create a new
installation merely to upgrade. Test rollback against the verified pre-upgrade
backup; restoring it discards subsequent writes. Do not blindly open upgraded
storage with an older binary. There is no deployment or configuration change in
this source preparation.

The `0.5.0` image is a **future release artifact**, not a result of this commit.
Wait for an explicitly published `v0.5.0` release and its successful release-image
workflow before selecting `ghcr.io/matuto-ai/psst:0.5.0` in the existing deployment.
Source, package version, Compose example and release tag must stay aligned.

### Verification boundaries

Broker acceptance is not delivery; `delivered` is a durable adapter-inbox receipt,
not evidence of model input, reading, a reply or task completion. Connected means
a valid transport lease at the supplied observation time, not a live process or
model-availability probe. The new server/reference offline-event API does **not**
complete an unsolicited native notification consumer. Native event presentation,
deduplication/ACK and model-input acceptance remain connector-specific verification
work; do not describe automatic native notifications as delivered by this release.

See [message history](docs/message-history.md), [presence](docs/presence.md) and
[administrator console](docs/admin-console.md) for contracts and limitations.

## 0.4.0 (source preparation; publish separately)

- Add native URL-only enrollment requests with administrator approve/deny/revoke
  in the broker's built-in form-login UI. No ticket or credential file transfer.
- Configure administrator password through PSST_ADMIN_PASSWORD; optionally fix
  HTTPS origin with PSST_PUBLIC_ORIGIN. No default password or HTTP Basic.
- Persist candidate request/key before network effects; resume the same pending
  request through GET-only status, including after restart. Startup never creates
  requests. Approved installations retain independent native-session identities.
- Protect UI sessions with Secure/HttpOnly/SameSite cookies, CSRF/origin checks,
  login rate/KDF bounds and restart logout. Render untrusted labels safely.
- Automatically snapshot the existing SQLite database privately before schema4;
  preserve legacy credentials, ticket enrollment, pending mail and retry records.
  Downgrade requires restoring that snapshot and loses subsequent writes.
- Keep old authorization active during replacement; revoke explicitly after the
  replacement works. Pending expiry24h, approved expiry90days, no silent renewal.
- Add real TLS/form/helper integration and CI gates for actual Compose, rootless
  Podman, Chromium form interaction, recreation and prior-image migration.
  User-specific authenticated native hosts remain separate acceptance evidence.
- Release image after publication: ghcr.io/matuto-ai/psst:0.4.0. This source
  preparation does not publish an image, deploy a server or provision credentials.

## 0.3.0

- Add opt-in scoped pairing: bounded single-use operator tickets, unique client
  credentials, finite expiry and revocation, without an unauthenticated issuer.
- Add the private-file `pair`/`revoke` operator CLI and crash-safe native connection
  helper. Existing unmarked connection bundles and bearer clients remain supported.
- Bound enrollment uploads and HTTPS retries, revalidate authorization after upload,
  and retain retry identity across lost responses and process crashes.
- Test actual operator-to-HTTPS enrollment for all four client types, durable
  round trips, scope isolation, migration, expiry and active-poll revocation.

### Upgrade from 0.2.0

The first automatic-receive test with existing Pi/Claude connection bundles does
**not** require upgrading the broker or enabling pairing. Native wake-up belongs to
connector releases, not this server release; live native acceptance remains a
separate test, and native acceptance is not proof that the model read a message.

Release image (after publication): `ghcr.io/matuto-ai/psst:0.3.0` (Linux/amd64). Wait for the
release workflow to finish before pulling. Keep the existing Compose project,
volumes, private configuration mounts, TLS proxy and credentials: do not replace
an existing deployment with the stock connectivity-only Compose example.

Before upgrading, make and verify a private SQLite backup using the existing
[`scripts/backup.mjs`](docs/operations.md) tool (it includes WAL safely), and back up
private configuration, credentials and any pairing policy. Do not copy just a live
`.sqlite` file. In the existing Compose directory, if its image uses `BROKER_IMAGE`:

```sh
export BROKER_IMAGE=ghcr.io/matuto-ai/psst:0.3.0
docker compose pull broker
docker compose up -d --no-deps broker
curl --fail --show-error --max-time 5 https://YOUR_BROKER_HOST/readyz
```

Persist the new image selection in the existing deployment configuration so a
later invocation cannot silently revert it. If that Compose file hardcodes the
image, change only its image field instead; preserve all mounts and settings.
Never use `down -v`. No host Node upgrade or source checkout is needed to run the
image. The existing backend/proxy configuration remains operator-owned.

Pairing is **off unless explicitly enabled** with `enrollment_policy_file`; see
[the operator guide](docs/pairing-operator.md). This one-time enablement, a scoped
operator ticket and a private ticket-file handoff are still needed for new client
self-enrollment. Installing the image alone does not create credentials.

Enabling pairing migrates SQLite schema 2 to 3. Leaving it disabled preserves
schema 2. **Broker 0.2.0 rejects schema 3**: after migration, rollback requires a
verified pre-upgrade database backup plus consistent authorization/policy backups,
not merely switching the image tag. Restoring loses changes after the backup;
stale revocation state can restore access. Never run two brokers on one database.
Credentials expire and require explicit re-pairing; automatic renewal is not
implemented. See [the migration contract](docs/pairing-protocol.md).
