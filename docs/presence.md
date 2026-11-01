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
valid even if it exceeds the notice grace.

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
bounded MCP stdio tool definitions for cooperative polling and ACK. This PR does
not silently enable native Pi model-input injection or guarantee automatic native
notification presentation. Native consumers must integrate safe event-ID dedup,
ACK and lifecycle behavior before claiming that acceptance criterion complete.

## Verification boundaries

`test/presence.test.mjs` uses cheap fake-clock storage tests and actual HTTP for
lease/grace thresholds, ownership/scopes, repeated polling/ACK, restart/reconnect,
uncertain claims, terminal/expired mail, pagination/sample/capacity bounds and
lost-response recovery. A separate actual **reference adapter child process**
proves graceful exit disconnects without closing its resumable identity. This is
not evidence of Pi host lifecycle or model-visible notice integration; those
remain explicit cross-connector acceptance checks. No VM or deployment needed.
