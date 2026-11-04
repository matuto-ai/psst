# Presence, resumable disconnect and pending-delivery notices

Presence describes broker transport leases, **not** whether a model is idle,
working, reading or expected to answer. Every discovery/session result includes
`connected`, `presence_state`, `last_heartbeat_at`, `lease_expires_at` and
`observed_at`. `connected=true` means a non-closed session has a currently valid
lease at that observation. It is not an instantaneous process probe.

`GET /v1/clients` still defaults to active leases. `connected=false` explicitly
includes historical/disconnected/closed authorized rows; it does not delete or
merge identities. A new native conversation gets its own identity. Resuming the
same verified conversation can reuse its persisted identity and mailbox.

## Graceful shutdown without destroying resume

New brokers advertise `policy.resumable_disconnect=true`.
`POST /v1/sessions/{client_id}/disconnect` takes `{}`, the authenticated owner,
`X-Client-ID` and `X-Lease-Epoch`. It ends only that attachment's lease, preserving
its identity, queued mail, history and resumability. Retrying the same epoch is
safe; an old epoch cannot disconnect a replacement. A subsequent heartbeat must
reconnect normally rather than reviving the ended attachment. Outstanding claims
become eligible for normal fenced retry with their uncertainty retained.

The reference runtime's `stop({closeSession:false})` drains startup, heartbeat,
receive and reconnect work before best-effort disconnect of the final known
epoch, with the disconnect request bounded by five seconds. Old brokers without the feature flag and failed
network shutdown still fall back to lease expiry. `stop()` / explicit session
`close` remain terminal; do not use terminal close merely to stop a resumable
process. A later terminal stop may close the same explicitly disconnected epoch;
that authority is fenced out by a replacement attachment. Only disconnecting a
live lease establishes this authority; an ordinary already-expired lease does
not gain it by calling disconnect. A killed process cannot promise
graceful notification and ages out.

Default heartbeat/lease remain **60/180 seconds**. No deployed configuration is
changed by this feature.

## Prolonged-offline notices

`limits.offline_notice_seconds` defaults to **600 seconds** (integer 1–604800).
The grace is measured from the **last confirmed heartbeat**, not another 600
seconds after lease expiry. Both conditions must hold: the recipient's lease is
no longer live, and that grace has elapsed. A longer configured lease remains
valid even if it exceeds the notice grace. The grace is an absolute duration in
seconds, not a missed-heartbeat counter: non-default heartbeat intervals do not
rescale it. Lease expiry and the configured duration must both be satisfied.

The broker creates one durable `recipient_offline` event per affected sender,
recipient and absence episode **only while queued/claimed delivery remains**.
An absence episode is identified internally by recipient registration epoch and
last heartbeat. A verified reconnect/heartbeat ends it; a subsequent absence can
produce a new event. Already-delivered messages with no reply never qualify.
There is no content interpretation or response-time policy.

- `GET /v1/presence-events?limit=10&cursor=...` uses the authenticated sender's
  `X-Client-ID`. A live sender lease is not required, so an offline sender can
  retrieve retained pending notices on return. Defaults: 10 events; maximum 100;
  at most 100 examined event rows and 64 KiB per page. Follow a non-null cursor even
  if the current page is empty. Start a later poll without a cursor so suppressed
  rows can become visible if scope/retained-message conditions change.
- Each event contains a stable `event_id`, recipient ID, freshness timestamps,
  up to 10 pending message IDs with transport state/uncertainty, and
  `has_more_messages`. It contains **no body, credentials or semantic summary**.
  Further messages in the same episode join the live metadata sample before ACK;
  they do not create repeated alerts after ACK.
- `POST /v1/presence-events/{event_id}/ack` takes `{}` and the same sender ownership
  and scope authorization. Repeated ACK is safe. Persist/deduplicate the event ID
  locally before presenting it repeatedly, then ACK; an ACK is only notice
  consumption, not message delivery or proof the model read/reacted to anything.
- Retrieval rechecks current lease/episode and pending message states. Reconnect,
  completion, expiry, cancellation or absence of authorized pending mail suppress
  obsolete alerts. An outstanding/unconfirmed claim can still have reached a
  durable inbox: `delivery_uncertain` is retained and no definitive non-delivery
  claim is made. No automatic resend, cancel, drop or session close occurs.

Events and per-episode ACK tombstones survive broker restart. Current-episode
suppression records remain until reconnect/terminal close; this prevents a late
send during the same absence from generating spam. Storage has a hard 10000-row
cap. `capacity_limited=true` explicitly reports saturation; new alerts may be
deferred, but accepted mail is unchanged. Reconnect cleanup frees rows. Creation
and cleanup are batched (up to 100 session observations/events per sweep), so very
large registries have a bounded scan delay beyond the threshold, not a realtime
notification guarantee. Existing broker disk/authorization limits still apply.

The reference client/facade exposes `presenceEvents` / `broker_presence_events`
and `acknowledgePresenceEvent` / `broker_acknowledge_presence_event`, including
bounded MCP stdio tool definitions for cooperative polling and ACK. Current
connectors also consume this existing authenticated transport:

- [Pi](https://github.com/matuto-ai/pi-psst-connector/blob/b87e29851a21be4342f8f4585fc16b1003f6c763/src/presence-notices.mjs)
  persists event identity before a separate transport-notice entry, admits it only
  at a safe idle boundary, reconciles exact durable native history, then ACKs.
- [OpenCode](https://github.com/matuto-ai/opencode-psst-connector/blob/3eb99d967c34f94b4954bb5efe13f2a07e21986b/src/presence-notices.mjs)
  uses its separate durable notice journal and native context-admission evidence.
- [Claude](https://github.com/matuto-ai/claude-psst-connector/blob/c356ba09b8e11d516dbdf7a8e4f04ea6ed5841ae/src/presence-notices.mjs)
  and [Antigravity](https://github.com/matuto-ai/antigravity-psst-connector/blob/9e6eb0315b28b27c73406fbbc1bfe5dac477fe9c/src/presence-notices.mjs)
  retain notice metadata separately and require an explicit native read/ACK.
  Their wakeup text is body-free and is not itself an ACK or a model response.

Local notice persistence, native admission and event ACK remain distinct from
message delivery, model reading, interpretation or reply. Uncertain native
handoffs are reconciled, never blindly reinjected. None of these notice paths
resends/cancels mail, closes sessions or changes credentials.

## Verification boundaries

`test/presence.test.mjs` and `test/presence-acceptance.test.mjs` are focused fake-clock storage tests. They cover lease/grace thresholds, ownership/scopes, independent affected senders, polling/ACK, local reopen/reconnect, uncertain claims, cancellation/expiry and bounded pagination. Runtime stop behavior uses injected clients. No live broker, native host or process-lifecycle test runs in CI.

The [earlier acceptance record](presence-acceptance.md) is historical evidence for its recorded commits. Current unit success is not real native-process, TLS or deployment acceptance. See [the test policy](verification.md).

## Optional ephemeral-session retention (registration v2)

Session cleanup is **disabled by default**. The operator may opt into
`limits.session_retention_seconds: 172800` (48 hours), but only with explicit
`require_registration_v2: true`. This persists a registration-version floor in the
database: removing that setting or disabling cleanup later does **not** allow
legacy registration again. Do not enable this until all four connectors support
registration v2 and their native-session recovery has been tested. Deployment and
activation are separate operator decisions; upgrading the package alone does not
activate cleanup.

Registration v2 uses the existing message protocol with two registration fields:
`registration_version: 2` and immutable `requested_at` (UTC epoch milliseconds).
The request must be younger than `registration_retry_seconds` and no more than
five minutes ahead of the broker. Retrying uses the exact original request, not a
new timestamp/key. Retention must exceed that retry window plus five minutes.
The broker allocates monotonically increasing epochs from one persistent counter;
clients accept an epoch greater than their previous one. Existing v1 clients keep
the exact `previous_epoch + 1` behavior until enforcement; a v2 session cannot be
downgraded. Legacy rows are never cleanup candidates until a verified v2 reconnect.

The absence timer begins at explicit disconnect or lease expiry. Restart preserves
an existing absence and starts absence for leases invalidated by restart. Migration
gives preexisting offline rows a fresh grace period rather than purging them on
upgrade. A successful reconnect resets the timer. Explicitly closed sessions keep
their existing terminal semantics and are outside this disconnected-session policy.

At expiry, the periodic sweep retires at most one eligible session per tick.
Legacy request bodies are streamed rather than loaded together; new v2 sends keep
only request digests for idempotency. SQLite work within that transaction remains
proportional to the selected session’s retained rows, not a strict per-message
budget. The default database budget is 1 GiB and is operator-configurable.
A transaction removes the session from discovery/admin lists,
registration records and incoming claims, without keeping a permanent identity
hash. Incoming deliveries still pending become failed with `recipient_expired`;
uncertainty about earlier transport is preserved. Incoming message bodies and
stored send-request bodies are removed (only request digests remain for retries).
Peer receipts and send-idempotency records remain for their existing finite
retention periods. Accepted outgoing deliveries to surviving recipients are not
cancelled merely because the sender expired: their payload and claim copies remain
until the normal delivery/TTL and retention cleanup. Thus 48 hours is a **session
absence policy**, not a promise to erase every shared receipt/copy at that instant.
A UUID referenced by these bounded peer records cannot be registered again; the
returning connector should choose a fresh random identity, never adopt a collision.

### Rollout and recovery

1. Install the broker with cleanup still disabled.
2. Update the shared SDK and Pi, Claude, OpenCode and Antigravity connectors to use
   v2, verify all four together, and ensure recovered native sessions use a new
   identity/journal after confirmed expiry. Do not transfer/replay old pending work.
3. Obtain operator confirmation before enabling the persistent v2 floor and cleanup.
4. On rollback, disable cleanup if needed, but retain the new broker/SDK support for
   the persisted protocol floor; do not downgrade the database format.

The counter is durable across normal restart and initializes at least as high as
all existing epochs. Restoring an **older backup** rolls back epochs, receipts and
idempotency just as in the existing protocol. It is not safe transparent failover:
restore offline with clients stopped, then establish fresh client identities and
journals; never replay old pending operations. No credentials or enrollment grants
are created or changed by this feature. Local connector journals and backups have
their own retention; server cleanup does not erase them.

Production startup uses `await BrokerStore.open(...)`: it holds the existing
single-writer owner lock and creates an integrity-checked, fsynced private snapshot
**before** schema-5 migration or lease/claim rewriting. Schema 1–3 snapshots keep
the existing `before-approval-*` location; schema 4 uses `before-retention-*`.
A failed snapshot/finalization aborts startup without performing migration. The
synchronous `new BrokerStore(...)` remains available for disposable tests/embedded
callers but does not provide this automatic snapshot; such callers must arrange
and verify their own backup before opening existing production storage. Preserve
these snapshots under the operator's backup policy; server session cleanup does
not delete them or make an old backup safe for transparent live restoration.
