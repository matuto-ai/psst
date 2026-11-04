# Issue #29 acceptance evidence

**Historical record:** this describes the exact pre-cleanup commits and runs below. The integration/native/container harnesses and mandatory gates were removed in issue #51. See [current unit verification](verification.md). Past evidence is not a claim about the current suite.

This record maps the original [presence/discovery issue](https://github.com/matuto-ai/psst/issues/29)
to implementation and executable checks. It does not turn this issue into the
broader native compatibility or deployment matrix in #11. The broker describes
transport observations, never model activity, responsiveness or authority.

The broker implementation predates this regression. The candidate adds the actual
reported Pi lifecycle flow, checks the four current connector tool results, fills
the remaining cheap notice cases, and reconciles the documentation. A candidate
still requires independent review and its own complete CI before merge; historical
green runs do not certify later edits.

## Lifecycle, discovery and resumable delivery

| Original criterion | Implementation and evidence |
| --- | --- |
| Reproduce two native owners, exit both, open/resume, immediate and post-lease discovery, ACK and receipt | `integration/native-pi-presence.test.mjs` runs official Pi 1.4.0 CLI processes in PTYs against real TLS/SQLite. Its sanitized artifact records list filters, last renewal, lease expiry, observation/server time and independently observed process liveness. It checks both the immediate post-exit state and the original stopped owner after a full negotiated interval. |
| Normal exit, disposal/reload, abrupt death, new/resumed conversations and shared installation | The actual-native test exercises `/quit`, SIGTERM, `/reload`, SIGKILL, `--session` and `/new`, with two simultaneous owners using one approved installation. SIGKILL leaves a valid lease briefly connected until expiry, without a graceful event or further renewal. The observed grace period is not an identity defect or a live-process probe. |
| Distinguish resumable disconnect from terminal close | `src/store.mjs` implements epoch-fenced `disconnect` without deleting identity/mail and a separate irreversible `closeSession`. `test/presence.test.mjs` checks retry, replacement fencing and terminal escalation. `docs/presence.md`, `docs/reference.md` and `openapi.json` document feature negotiation and old-broker fallback. |
| Explicit state and useful freshness in discovery, native output and admin | `presenceSnapshot` supplies connected/state/heartbeat/lease/observation fields. `src/store.mjs`, `src/admin-data.mjs` and `src/admin-pages.mjs` preserve them. `test/admin-pages.test.mjs` checks admin projection; actual Chromium runs verify the page. `integration/current-connector-matrix.test.mjs` checks each production Pi/Claude/OpenCode/Antigravity tool's serialized output, with synthetic host contexts kept explicit. |
| Active filters exclude expired/closed rows including pagination; historical rows stay truthful | Broker presence tests and `test/admin-sort.test.mjs` cover connected/disconnected/closed selection and keyset boundaries. The actual-native test traverses one-row active pages after graceful/abrupt exit. Each current connector's next-generation active output excludes prior disconnected lifetimes. Historical rows remain, without implying liveness. |
| Prompt graceful disconnect; bounded abrupt expiry; no orphan renewal | The real Pi processes are independently confirmed dead, graceful leases end promptly and the abruptly killed owner expires from its last confirmed heartbeat. The original exited owner's heartbeat remains unchanged beyond the full interval. Owned process groups are reaped before storage removal. The four-package test separately checks prompt modeled shutdown without terminal close. |
| Preserve offline buffering and honest send/receipt status; reject closed recipients | Actual-native offline sends return `recipient_connected_at_acceptance:false` and remain `queued` until resume. The current four-package tool ACKs retain the connected-at-acceptance field. Existing registry/message tests retain closed-recipient rejection and distinguish acceptance, durable delivery and native receipt. |
| Preserve pending messages, receipts, inbox and legitimate resume identity | Actual-native resume preserves one already-delivered but locally pending item and separately queued offline mail; each receives one exact native-history receipt. Installation approval/selection is unchanged. No blanket deletion, credential regeneration or unrelated session close occurs. |
| Focused broker tests plus actual native regression | Fake-clock/HTTP/reference-process tests remain separate from the real official CLI/PTY test. Both are required CI jobs; neither is a substitute for the other. Missing native fixture inputs fail rather than skip. |
| API/operator/connector docs and compatibility limits | `openapi.json`, `docs/presence.md`, `docs/reference.md`, `docs/native-pi-presence.md` and the pinned connector documents describe the transition, offline notice transport and receipt semantics. No deployed configuration or ongoing account access changes. |

The real process test negotiates **2-second heartbeats / 6-second leases**. The
original criterion asks for the negotiated interval; it does not require a
180-second wall-clock run. Production defaults remain 60/180. The local provider
allows native history/context observation without real account credentials.
Authenticated vendor-model behavior and the full four-host native matrix remain
separate work, not hidden prerequisites for these transport criteria.

## Prolonged-offline notices

The chosen grace is **600 seconds since the last confirmed heartbeat**, not 600
seconds after disconnection. It is an absolute duration under non-default
heartbeat intervals. The lease must also be expired. No existing deployment is
reconfigured by this code or these tests.

| Original criterion | Implementation and evidence |
| --- | --- |
| Notify only authorized affected senders while delivery is pending, never because an answer is missing | `src/presence.mjs` checks sender ownership/current scopes and queued/claimed unexpired mail. Presence tests exclude delivered/terminal/no-pending cases. The acceptance tests exercise multiple senders to the same recipient, isolated event IDs, scopes and independent ACKs. |
| Compact body-free metadata with bounded count/bytes and continuation | Events contain recipient/message IDs, state, uncertainty and freshness, with ten-message samples, 100-row/page limits and a 64KiB byte budget. Existing tests cover sample/count pagination and body exclusion. `test/presence-acceptance.test.mjs` creates genuine full samples that hit byte truncation and follows continuation without omission or duplication. |
| Stable per-sender/recipient episode identity, dedupe/coalescing and bounded retention | Persistent unique episode keys and ACK tombstones prevent repeat alerts during the same absence, including later queued mail. The 10,000-row cap is explicit; current-episode tombstones survive until reconnect/terminal close. Tests cover repeated sweeps/ACK, later sends, capacity and lost responses. No arbitrary new retention TTL is needed. |
| Survive restart, end an episode on verified reconnect and suppress obsolete notices | Existing tests cover event/ACK persistence and reconnect/new absence. Acceptance tests add restart before the threshold and already-created-event suppression after cancellation or expiry of the last pending message. |
| Truthful queued/claimed/completed/uncertain races and no automatic message action | Event samples re-read current transport state and preserve `delivery_uncertain`; they do not claim non-receipt. Tests cover claim expiry/completion and queued/claimed cancellation/TTL expiry. Notice reads/ACKs do not resend, cancel, drop or close messages or sessions. |
| Small compatible authenticated transport, offline sender and honest notice ACK | Existing authenticated HTTP polling and idempotent ACK use the sender's owned identity, without requiring a live sender lease. HTTP/MCP tests cover an offline sender, ownership, scopes and read/ACK. Connector journals and native presentation/read boundaries are documented below. An event ACK is not message delivery, model reading or a reply. |
| Cheap threshold/failure matrix, separate from native end-to-end acceptance | `test/presence.test.mjs`, `test/presence-acceptance.test.mjs` and `test/mcp-stdio.test.mjs` cover just-before/at/after threshold, no pending, already delivered/no answer, sweeps, multiple senders, unauthorized access, restart, reconnect, offline sender, count/byte bounds and claim/completion/expiry/cancel races. These are inexpensive fake-clock/HTTP tests, not a claimed authenticated-model notice matrix. |

## Connector evidence and boundaries

The current-package matrix pins these exact already-merged revisions:

- Pi: [`b87e298`](https://github.com/matuto-ai/pi-psst-connector/tree/b87e29851a21be4342f8f4585fc16b1003f6c763).
  `src/presence-notices.mjs` persists before presentation, checks safe native
  boundaries and reconciles exact native history before ACK. Its
  `test/presence-real-broker.test.mjs` covers restart/lost ACK, obsolete episodes,
  partial cancellation and shutdown. Official-host tests separately exercise
  durable transport-notice entries using a local provider.
- Claude: [`c356ba0`](https://github.com/matuto-ai/claude-psst-connector/tree/c356ba09b8e11d516dbdf7a8e4f04ea6ed5841ae).
  `src/presence-notices.mjs` and `test/presence-notices.test.mjs` cover a durable
  separate journal, explicit read/ACK, uncertain ACK recovery, bounded polling,
  capacity and shutdown. The monitor's wakeup does not itself acknowledge events.
- OpenCode: [`3eb99d9`](https://github.com/matuto-ai/opencode-psst-connector/tree/3eb99d967c34f94b4954bb5efe13f2a07e21986b).
  `src/presence-notices.mjs` and `test/presence-notices.test.mjs` cover durable event
  identity, safe native context admission/reconciliation and separate ACK.
- Antigravity: [`9e6eb03`](https://github.com/matuto-ai/antigravity-psst-connector/tree/9e6eb0315b28b27c73406fbbc1bfe5dac477fe9c).
  `src/presence-notices.mjs`, `test/presence-notices.test.mjs` and
  `test/presence-native.test.mjs` retain bounded metadata and require explicit
  native read/ACK after a body-free waiter notice.

These source/test references establish implemented contracts and their respective
test boundaries. They do not combine separate probes into a claim that all four
authenticated native hosts consumed a prolonged-offline event end to end. The
original notice criteria explicitly keep that later native acceptance separate
from the cheap transport/failure matrix.
