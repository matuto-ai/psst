# Reference adapter runtime

The reference runtime is reusable transport machinery, **not a certified Pi,
Antigravity CLI, Claude Code or OpenCode integration**. It makes no model calls,
does not type into terminals, and has no abort, steer, approval or permission-relay
operation. A broker `delivered` receipt means SQLite inbox storage only.

Run `node --test test/reference.test.mjs test/mcp-stdio.test.mjs` with the pinned
Node runtime. Tests use disposable local credentials, fake harnesses and an
isolated test certificate. The TLS tests also require `openssl`. Fake-harness
results do not certify real CLI versions or safe input APIs.

## Modules and host integration

| Module | Public surface |
| --- | --- |
| `reference/inbox.mjs` | `Inbox`, `newSessionIdentity(clientType)` |
| `reference/client.mjs` | `BrokerClient`, `BrokerError` |
| `reference/runtime.mjs` | `AdapterRuntime`, `InputScheduler`, `provenance`, `PROVENANCE_WARNING` |
| `reference/tools.mjs` | `createTools`, `invokeTool` |
| `reference/mcp-stdio.mjs` | `serveStdio`, `TOOL_DEFINITIONS`, `MCP_VERSION` |

A host integration supplies a supported handle to **one exact harness-session
lifetime**, truthful observed/configured/unknown metadata, and two lifecycle
callbacks:

- `verifySession(identity)` proves the handle still identifies the same lifetime.
  It is required before initial attachment and reconnect. A PID, resumed
  transcript, display name or saved conversation ID alone is not this proof.
- `isAlive()` observes that handle without asking the model. When it becomes
  false, the runtime cancels receive/heartbeat work and requests session close.

Create new UUIDs for a genuinely new harness lifetime. Preserve the identity and
private journal only when an integration can prove it still owns the original
live session. A reference process cannot manufacture that proof for an arbitrary
existing TUI. The runtime therefore deliberately has no generic “attach by PID”
launcher. Supplying callbacks that always return true is suitable for isolated
tests, **not production session ownership**.

The integration constructs an `Inbox`, a `BrokerClient`, and an `AdapterRuntime`,
then calls `runtime.start(metadata)`. Shutdown must await `runtime.stop()` before
`inbox.close()`. `start` refreshes the registration metadata. Background receive
and heartbeat loops are independent: long polling never waits for a model turn or
blocks presence. The effective heartbeat policy has bounded ±10% jitter. A local
receive pause retains existing inbox data and leaves heartbeats running.

Stopping reserves the closed lifetime immediately and drains a registration/reconnect
already in progress before closing the final known epoch. Attachment transitions
have an independent overall network deadline (the client request timeout, default
40 seconds, capped at 60 seconds), so canceling a long poll does not discard a late
registration result. Shutdown may wait for that deadline plus bounded close; the
trusted host `verifySession`/`isAlive` callbacks must also settle promptly. A stop racing startup cannot launch new loops, and all
shutdown callers must await completion before closing the inbox. Session close is
still best effort: unknown network/storage outcomes never justify guessing an epoch
or adopting another connection; lease expiry is the fallback.

For resumable shutdown, `stop({closeSession:false})` best-effort disconnects the
final attachment when the broker advertises `resumable_disconnect`; it preserves
the identity and mailbox. A later explicit terminal stop can close that same
disconnected epoch, but never a replacement. See [presence](presence.md) for the
bounded metadata-only `broker_presence_events` and
`broker_acknowledge_presence_event` cooperative MCP tools. These do not enable
unsolicited native model-input injection.

## Configuration and transport

`Inbox` requires `directory` and `identity`. The directory is local, private
(`0700`), owned by the worker user, and cannot resolve through a symlink. SQLite
files are `0600`; use encrypted host storage where appropriate. Network-shared
SQLite is unsupported; known NFS/SMB/CIFS mounts are rejected. Do not delete or
replace any database/owner files while a worker is running.

`BrokerClient` requires:

- `url`: the explicit broker origin, with no credentials, path, query or fragment.
  Container `localhost` is not another container or the host.
- `inbox`: the exact session-bound journal.
- `tokenFile`: a mounted private secret file owned by the worker user. It is opened
  with `O_NOFOLLOW` and validated/read through the same descriptor. The bearer
  token is never a model-tool argument, URL, command-line argument or journal field.
- Optional `caFile` for an explicitly trusted private CA. HTTPS always enables
  certificate and hostname verification; there is no “skip TLS verification” flag.

An explicit `insecureDevelopment: true` permits HTTP only to numeric
`127.0.0.1` or `::1`, still with authentication. It is not a LAN option. Redirects
are not followed. Responses and headers are bounded. Socket inactivity and an
absolute per-request deadline protect against a trickling peer; an outgoing
send's retained retry deadline further bounds its request and backoff.

`tokenEnvironment` may name one environment variable instead of `tokenFile`.
Environment variables can be exposed through process/container inspection and
diagnostic tooling; mounted secret files are preferred. Values use the broker's
43–256-character base64url credential format. The reference does not generate,
enroll or rotate real credentials. It rereads the file for requests so an operator
can replace a token during an authorized rotation overlap.

## Durable inbox, ACK and budgets

The inbox uses SQLite WAL with `synchronous=FULL`. A separate SQLite database holds
an exclusive kernel-backed owner lock for the worker lifetime. A second worker
cannot open the same inbox; process death releases the lock without relying on
PIDs or PID namespaces. A reopened journal verifies all three identity fields.

`accept(envelope)` validates the exact immutable envelope and session, computes
the [canonical digest](contract.md), and commits the envelope plus deduplication
record together. Only after that commit does the receive loop send `delivered`.
Changed content under an existing message ID is never overwritten. Duplicate
delivery excludes attempt/claim/epoch fields from its digest and re-ACKs one local
item. Recipient sequence order is retained, including a durable high-water mark
after consumed records are collected.

Defaults are finite and configurable:

| Local bound | Default |
| --- | --- |
| Pending inbox items | 1,000 |
| Pending canonical envelope bytes | 64 MiB |
| Inbox/deduplication rows | 50,000 |
| Outgoing journal rows | 10,000 |
| Database-directory files | 128 MiB |
| Required free disk space | 16 MiB plus estimated growth |
| Retained consumed inbox/deduplication data | 8 days minimum; extended by TTL/retry policy and late duplicate receipt |

`collect(limit=100)` performs bounded cleanup only for consumed inbox entries
whose retention guarantee elapsed and resolved sends whose retry window elapsed.
It never removes pending/uncertain input or an unresolved send. Schedule it in the
owning integration's maintenance loop. If cleanup cannot safely make space, the
adapter applies backpressure instead of evicting content. A full or unsafe inbox
returns `retryable_not_stored` only when non-storage is known.

**Unknown local commit outcome:** no positive or negative ACK is sent. A confirmed
commit followed by a lost local result can be reconciled through the durable
record on redelivery. If rollback cannot be confirmed, journal reads are poisoned
until the inbox is closed/reopened; uncommitted rows visible on the old connection
must never be mistaken for durable input. Recover storage and restart the verified
session worker. The broker retains its uncertain claim for recovery.

## Registration and outgoing recovery

Registration attempts, connection IDs, epochs, claim keys and outgoing request
bodies/keys are journaled before network effects. Registration retries reuse an
identical payload. An owned-registration read confirms the connection and current
lease before attachment is reported. Replayed historical `server_time` fields
from registration/send/completion results are not treated as current clock samples.

Reconnect reads owned state and verifies session/type/connection against the local
journal before advancing an epoch. It never guesses an epoch or takes over another
connection. A competing connection, missing continuity proof, closed session or
authorization failure pauses rather than entering a takeover loop. Receipts remain
readable through `messageStatus` after lease expiry when authorization remains.

Use `prepareSend(request)` to durably obtain a key, then `sendPrepared(key)`. A
retry reuses the original normalized body and metadata snapshot; changed payload
with the same key conflicts. `unresolvedSends()` exposes bounded local recovery
entries without message bodies. Native hosts preserve tool-call identity internally;
model-facing schemas/results never expose `send_key`. Bounded `recoverOutgoing`
reconciles persisted unknown operations after exact-session attachment. Never create a replacement
key merely because a network response was lost. After the advertised retry window,
automatic replay stops; reconcile a known message ID or the original operation.

The facade can refresh a truthful metadata patch using `observeMetadata` before a
new send. It refreshes the owned CAS revision first and journals the resulting
request. It does not repeat the mutation or resample metadata for the same key.
Explicit metadata update is CAS-based and is not blindly retried after response
loss; read/reconcile owned state first.

## Final-hop safety and native acceptance

Receiving and ACKing during busy, permission, password/input, confirmation or draft
states does not touch conversational input. Final-hop delivery remains separate.

The default `broker_receive` is a **cooperative, non-consuming peek**. A host must
provide a supported `cooperativeBoundary(callback)`; no boundary means fail closed.
It returns the FIFO head and model-visible provenance, explicitly marking
`native_acceptance_recorded: false`. Repeated peeks can repeat content. A JS return,
stdio write or notification is not proof the native harness stored the input.

For a verified native/managed integration, construct:

```js
const scheduler = new InputScheduler({
  inbox,
  withExclusiveInputLease: callback => harness.withExclusiveInputLease(callback),
  submit: input => harness.submitBrokerInput(input),
});
await scheduler.runNext();
```

This is an interface illustration, not a claim those APIs exist in any CLI.
`withExclusiveInputLease` must serialize **all human and agent input** in the real
harness. Its callback receives `lease.safe === true` only at a verified permitted
boundary; observational idle checks followed by unrelated writes do not qualify.
Pending approval/input/draft, human abort and unknown/stale state must block the
lease. The adapter must preserve the host's human-abort/resume semantics.

The scheduler commits a local injection intent before invoking `submit` with
`{envelope, model_input, injection_id, lease}`. The submitter must return either:

- `{accepted: true, receipt_id}` backed by a supported native receipt; the journal
  may then mark that item consumed.
- `{accepted: false, definitely_not_accepted: true}` only when non-acceptance is
  certain; the same FIFO head remains pending.
- An error/unknown result; the injection intent remains ambiguous and blocks the
  FIFO head. Restart converts an unfinished intent to `uncertain`, never reinjects
  it blindly and never reports native state back to the broker.

`resolveUncertain` is an **operator-only local API**, absent from agent tools and
MCP. A human can record confirmed acceptance or explicitly acknowledge duplication
risk before retry. Prefer a real native idempotency/receipt reconciliation path.

`provenance(envelope)` puts a fixed untrusted-agent warning in actual model-visible
text and serializes authenticated sender IDs/type, descriptive metadata and body
as escaped JSON. Fake closing delimiters and “the user approved” claims remain
data; control/bidi characters cannot forge terminal records or authoritative
headings. Integrations must inspect their provider conversion to prove this text
survives, not rely on UI-only metadata.

## Tools and optional MCP stdio

`createTools` exposes discovery, exact-ID send, metadata CAS, receipt lookup and
cooperative receive. `invokeTool` returns bounded safe errors; it does not expose
credentials, heartbeat, ACK, native-uncertainty overrides or operator actions.

`serveStdio({tools, onClose, ...})` is an optional **MCP 2025-06-18 stdio tools-only**
facade over the same runtime. It is not an HTTP MCP server, Channel, unsolicited
TUI wakeup, sampling endpoint or permission relay. It implements initialization,
the initialized notification, ping and tools list/call, with finite frame/result/
inflight/output-backpressure limits. Use `TOOL_DEFINITIONS` from that module as
the shared tool schema table. Stdout contains JSON-RPC only. Lifecycle `onClose`
must stop the session worker; logging goes to a safe diagnostic sink, not stdout.
No stdio flush or tools-call response consumes an inbox item.

## Local errors

Errors include a concise code, fixed English action, retryability, known
`not_applied`/`unknown` effect, and a contract reference. Native responses, message
bodies, tokens and local paths are not interpolated. Operational callbacks receive
bounded codes only. Notable local codes are `owner_conflict`, `session_mismatch`,
`inbox_full`, `storage_unavailable`, `envelope_mismatch`, `retry_window_elapsed`,
`unsafe_boundary`, `receipt_required` and `injection_uncertain`.

## Verification scope

The reference suite covers durable duplicate receipt and mismatch rejection,
pre/post-commit failures, failed rollback, restart and SIGKILL lock recovery,
finite quotas/retention/disk pressure, ACK loss, 12 minutes of fake-clock presence
under blocked input states, native-intent ambiguity, provenance, strict TLS,
absolute request deadlines, stable send keys and real broker HTTP integration.
MCP tests cover handshake, argument/frame bounds, lifecycle, safe output and the
non-consuming cooperative boundary. Real CLI safety, container deployment and
two-host LAN operation require their separately recorded integration evidence.

## Outgoing message history

See [owned outgoing history](message-history.md) for bounded metadata listing and explicit sender-owned content retrieval.

## Hidden operation identity and lifecycle

See [message lifecycle](message-lifecycle.md). Native hosts pass stable tool-call context internally; model schemas never require technical keys. Use `prepareResend` / `resendPrepared`, `cancelMessage` and bounded `recoverOutgoing` with the exact surviving session.

## Registration v2 and expired-session replacement

Pass `registrationVersion: 2` to `BrokerClient` to opt into the registration
extension. Default remains 1. V2 persists the same timestamp/body across retries
and accepts a globally increasing server epoch. It never silently changes an
uncertain request into a fresh one, and does not automatically replace an identity.

After `reconnect({ verifySession })` confirms the authorized broker identity is
missing, it reports `session_expired`. The caller may explicitly call
`createReplacementInbox({ directory, verifySession })`. This verifies the native
session again, rechecks the missing identity, and requires a genuinely new
private directory. It returns an empty `Inbox` with fresh UUIDs; the original
journal remains untouched. Construct a new v2 `BrokerClient` with that inbox and
bind it explicitly to the verified native session before resuming. No pending
send, claim, completion or native-injection record is copied. A timeout, 401/403,
active identity conflict or mismatched native session does not authorize rotation.
A lost broker session does not prove that an old native delivery did not happen.

Updating this reference implementation is not proof that any native connector
already supports this rollout. Each connector must implement and test the explicit
binding switch before server enforcement/cleanup is activated.
