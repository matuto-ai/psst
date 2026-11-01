# Message lifecycle and technical recovery

The broker is only a messenger: text is opaque. Identical text in two **explicit
intents** creates two IDs; there is no semantic deduplication. `202` is durable
broker acceptance, and `delivered` is durable adapter inbox receipt, never model
input, reading, replying or task completion.

## Internal operation identity

Clients generate and persist technical keys **before** transmitting. The same
operation must retain its key and canonical request through connection loss,
concurrency, crash and restart. Changed requests under that key conflict.
The advertised `send_retry_seconds` defaults to 86400. The reference client stores
an absolute local retry deadline; after it expires it reports
`retry_window_elapsed` and does not silently allocate a new key.

While the broker retains acceptance, retries return that original acceptance,
not the current receipt. HTTP `Idempotency-Replayed: true` distinguishes a replay
from a newly accepted intent; the reference client exposes `acceptance_replayed`.
Use the receipt/history API to obtain **current** state.

New internally generated wire keys have format `op_<unix-ms>_<random-entropy>`.
The timestamp is persisted before HTTP and adjusted to observed broker time.
For an unknown timestamped key, the broker rejects age at/after the negotiated
retry window with 410 `retry_window_elapsed`, even after message/operation purge.
Malformed keys and timestamps more than five minutes in the future are rejected.
An already retained acceptance can still be replayed beyond this bound: it never
creates another delivery. A client must not replace an expired key automatically.

There are **no permanent send tombstones or lifetime-operation quotas**. Broker
operation records are collected with normal message retention. Existing v1
arbitrary keys remain compatible but only have their documented bounded recovery
guarantee; after those records have been purged the broker cannot infer that an
arbitrary string names an old operation. Updated clients generate timestamped
keys and enforce their persisted retry deadline.

The reference Inbox keeps at most `maxOutgoingCount` active/recent operations and
collects completed/rejected records after their retry deadline (including bounded
cleanup before new admission). Unknown operations are never collected. A wholly
known-not-applied first operation can be recorded as a durable terminal rejection,
recorded for accurate reconciliation; replay returns the same rejection. A later
rejection after an earlier unknown attempt does **not** prove the original was
rejected. Attempts are marked durably before HTTP, including crashes.
`BrokerClient.recoverOutgoing({limit:10})` replays at most 10 internally persisted
operations, strips keys from results, and preserves unknown/retry-expired outcomes.
Adapters invoke it after re-establishing the exact owned session.

Native facades accept internal host context as a second argument:
`broker_send(args, {operationId: stableNativeToolCallId, operationStartedAt: originalHostUnixMs})`, likewise `broker_resend`.
`invokeTool` accepts this as its fourth argument. The host ID is namespaced to the session and durably mapped to a random technical
key, **not** a model argument. `operationStartedAt` is the original persisted native
call timestamp, not a freshly generated retry timestamp. It lets the client reject
an expired re-presented call even after the completed mapping was collected. A
host without that timestamp only has the documented bounded mapping guarantee;
it must not re-present arbitrary old tool-call IDs as new intents after retention. Two
host call IDs remain independent even with identical text. An unknown earlier
operation remains recorded but never blocks a distinct explicit new intent,
including a send to another recipient. The broker does not infer whether a model
intended a new call as a semantic retry; arbitrary new calls can create duplicates. The host must preserve
a call ID for technical replay; do not derive it from text. The generic facade
without host context still generates/persists a key and retries HTTP internally,
and never guesses that a later call is the same intent. Hosts use
`recoverOutgoing` to reconcile prior records without replacing their keys; recovery
failure must not globally freeze unrelated explicit new operations.
Recovery selects at most `limit` (default 10, maximum 100) unexpired unresolved
operations directly through an indexed deadline query, earliest deadline first.
Expired unknown operations remain unchanged in the durable ledger and are never
retried or silently renewed. If any exist, the returned results array adds one
compact `{error: {code: "retry_window_elapsed", effect: "unknown", ...}, count: N}`
summary, so its maximum length is `limit + 1`. That summary is not a delivery
receipt or proof of failure; reconcile the retained original operation.

`send_key` was removed from model-facing schemas and results; low-level
`prepareSend/sendPrepared` remain internal integration APIs.

## Explicit resend

`POST /v1/messages/{message_id}/resend`, authenticated with the sender's current
`X-Client-ID`, `X-Lease-Epoch`, and internally persisted `Idempotency-Key`, accepts
`{ttl_seconds?}`. All retained owned source states are eligible, including queued,
claimed and delivered: the caller explicitly requests another delivery and must
understand it can duplicate earlier receipt. Original content and recipient are
copied exactly, but sender metadata is the current snapshot. The new message gets
a new ID, normal recipient sequence, fresh TTL (broker default if omitted), and
`resent_from_message_id` receipt/acceptance metadata. The original is unchanged;
lineage is not injected into the immutable envelope, preserving old receivers.

Normal destination validity, receive capability, scope, quota and rate checks
apply. Closed recipients reject; disconnected resumable recipients still accept
queued mail. Missing/inaccessible source returns 404; missing retained content
returns 410 `content_unavailable`. A known resend replay does not need the source
body again. The new delivery has its own independent receipt and retention.

## Cancellation and races

`POST /v1/messages/{message_id}/cancel` with `{}` is sender-owned and lease-fenced.
No idempotency key is needed: the message ID identifies an atomic, repeatable
transition. Only queued/claimed messages can become the new terminal state
`cancelled` with reason `sender_cancelled` and `cancelled_at` audit timestamp.
Expiry observed first wins; delivered/expired/failed remain unchanged.

Response: the current receipt plus `cancel_result` (`cancelled`,
`already_delivered`, `already_terminal`), `further_delivery_stopped: true`, and
`delivery_may_have_occurred`. Claimed mail or an earlier unconfirmed attempt keeps
`delivery_uncertain: true`. A valid late completion of the outstanding claim can
truthfully change cancelled to delivered; a not-stored result resolves only that
attempt and stays cancelled. Renewing a cancelled claim is rejected. After claim
or lease expiry/restart, no late completion is assumed: uncertainty remains.
Repeated cancellation reconciles current state after response loss.

Cancellation never undoes inbox content, native input, processing or a completed
operation. It never closes the recipient session or deletes the receipt. Older
clients must tolerate/upgrade for the new terminal `cancelled` state; envelope
schema and completion outcomes are unchanged. Migrations are additive and preserve
pending mail, operation identities and history. Do not downgrade a database to a
build unaware of cancellation and durable operation outcomes.

General delivery-status push notifications are **not added** here: bounded status
reads and history provide a smaller authenticated contract. The distinct pending
recipient prolonged-offline transport notice is tracked in #29.
