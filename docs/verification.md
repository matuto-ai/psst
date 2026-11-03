# Verification evidence

This record distinguishes executable broker/reference evidence from real-harness and deployment gates. All tests use isolated temporary data and disposable test-only credentials/certificates; they do not provision ongoing access.

## Evidence snapshot: 2026-11-03

This snapshot supersedes the old checkpoint as a navigation guide, not as a claim
that its tests ran at newer revisions. It records already-completed CI; preparing
this documentation did not rerun native hosts or deploy anything. The linked
commits fix each observation in time. A later change needs its own verification.

### Broker and packaging

Psst commit [`c579161cefcece5363c70c719ff73eafbe10c216`](https://github.com/matuto-ai/psst/commit/c579161cefcece5363c70c719ff73eafbe10c216)
passed [Verify run 41687208386](https://github.com/matuto-ai/psst/actions/runs/41687208386).
Its `local-tests` log reports **288 passed, zero failures/skips**, on Node
24.19.0 with the SQLite 3.53.3 gate. All four prerequisite jobs and the aggregate
`verify` job succeeded:

| Job | Exercised boundary |
| --- | --- |
| `local-tests` | Syntax, pinned runtime and full broker/reference tests, including presence/lifecycle and retention fixtures. |
| `container` | Docker build/tests, nonroot entrypoint, no-credential bootstrap, published port/persistent volume, Compose, Chromium admin behavior and approval/migration fixtures. |
| `rootless-podman` | Private bind mounts/restart, copied isolated runtime, broker-only bootstrap, separate-container host HTTPS and recreated approval-data volume. |
| `cooperative-transport` | Four actual packed connectors against TLS/admin approval, with 16 directed routes before and after recreation. |

The [workflow at that commit](https://github.com/matuto-ai/psst/blob/c579161cefcece5363c70c719ff73eafbe10c216/.github/workflows/verify.yaml)
defines these checks. The separate-container HTTPS result covers the tested
host-interface/rootless route, not Fedora Quadlet/SELinux, every Podman networking
mode, the user's network or a two-host LAN.

Presence/resumable-disconnect and pending-delivery event support was merged in
[PR #33](https://github.com/matuto-ai/psst/pull/33). Fake-clock, authenticated HTTP
and reference-child-process tests support that backend result. The later
[issue #29 acceptance record](presence-acceptance.md) adds actual Pi lifecycle,
current native-tool output and complete cheap notice coverage; see
[presence.md](presence.md) for the current contract. Resumable disconnect preserves
identity/mail while terminal close remains a different operation.

The required `native-presence` lane adds an [actual Pi process lifecycle
regression](native-pi-presence.md): two official CLI owners in PTYs, native
reload/new/exact-session resume, graceful exit and SIGKILL, real-time negotiated
lease expiry, pending local inbox recovery and offline queued mail. The local
provider is controlled; the recorded native process evidence is separate from
authenticated vendor-model or cross-host acceptance. Each candidate requires its
own CI result; earlier runs above did not execute this new lane.

The current workflow runs the existing Compose/Chromium and rootless-Podman
approval/migration checks in independent required `browser-compose` and
`browser-podman` jobs. Each performs the same complete pinned Playwright install,
including its system/font dependencies, builds the same current and immutable
legacy runtime images locally, and retains its browser evidence. This overlaps
cold browser setup with the unchanged container/runtime suites instead of putting
both on one critical path. No test or dependency is omitted, and the aggregate
`verify` requires both new jobs as well as every existing suite. Measure the full
workflow from creation to completion against the 150-second target and 165-second
ceiling; a fast individual test does not establish that budget.

### Packaged connector matrix

[PR #24](https://github.com/matuto-ai/psst/pull/24) introduced
`integration/connector-matrix.test.mjs`. The cited broker workflow keeps
these immutable pins:

| Connector | Revision in the cooperative matrix |
| --- | --- |
| Pi | `f3d3bfc5cd17c10697d52e892f88c06a22ee2b16` |
| Antigravity | `f3e0da54134bc03bd81f3c06c5ccc385d484b95e` |
| Claude | `e04de626a0d01dc6345eb750364e719dd59cc319` |
| OpenCode | `55b297525e6f931ab5c6ac377d1d8ccab8155bfb` |

Two identities per family exercise all 16 routes, repeated after process
recreation with persisted installation authorization and fresh native lifetimes.
These **32 route checks** use real packages, TLS and broker storage, but synthetic
native contexts and test-driven cooperative ACKs. They do not certify the latest
four connector revisions together, same-native-session pending-inbox recovery,
automatic final-hop input or authenticated model behavior.

### Current packaged cohort with synthetic native boundaries

The separate `current-transport` job now runs
[`integration/current-connector-matrix.test.mjs`](../integration/current-connector-matrix.test.mjs)
against the broker revision under test. The historical cooperative job above is
retained unchanged as a backwards-compatibility check. This newer job pins:

| Connector | Current-cohort revision |
| --- | --- |
| Pi | `b87e29851a21be4342f8f4585fc16b1003f6c763` |
| Claude | `c356ba09b8e11d516dbdf7a8e4f04ea6ed5841ae` |
| Antigravity | `9e6eb0315b28b27c73406fbbc1bfe5dac477fe9c` |
| OpenCode | `3eb99d967c34f94b4954bb5efe13f2a07e21986b` |

The test packs each checkout under its current npm name, uses its real approval
helper against the real TLS/admin service, and starts two isolated modeled native
owners per family. Transport, native connector tools and durable inboxes are
production package code. Native host events, conversations, history/API storage
and model responses are test fixtures:

- Pi invokes the real extension and automatic delivery code, with a synthetic
  append-backed custom-message history. No diagnostic manual mode is enabled.
- OpenCode invokes its current `setupNativePlugin` and selected-session presence,
  with synthetic 2.2.5 context/storage and exact persisted synthetic-queue receipts.
  No receive/ACK fallback is installed.
- Claude runs actual hook, MCP and monitor subprocesses. A real body-free monitor
  notice triggers a simulated native-model receive call; the test then explicitly
  acknowledges the exact read item. Monitor stdout is not model acceptance.
- Antigravity uses actual native binding/tool guards and the package's native
  waiter. After its body-free notice, a simulated model reads and explicitly
  acknowledges the exact item. A waiter return is not native CLI/model acceptance.

Assertions cover **43 deliveries**: all 16 directed routes twice, four pending
inbox restarts under the same modeled native owner, four broker-snapshot restores
with pending local inboxes, and a concurrent three-party cycle. They check exact message/sender/recipient/provenance/content, absence from
every unrelated inbox, one automatic Pi/OpenCode native capture per message,
consumed local state, family-specific native-receipt versus explicit-read
semantics, original installation credential
reuse and no repeated enrollment. Every family's production native-tool result
retains explicit presence and heartbeat/lease/observation timestamps; the next
round's active result excludes the prior disconnected lifetimes. Modeled native
shutdown promptly ends presence without closing identities. During pending-restart
checks, broker delivery completes while the modeled native boundary is held; restart preserves the exact
inbox identity/envelope and does not release that boundary. Claude restarts only
its MCP/monitor children so no owner PID or lifetime is forged. The second route
round intentionally uses fresh native lifetimes, not a claimed native resume.

Run locally after installing only the locked fixture dependencies (Pi uses
`npm ci --ignore-scripts --legacy-peer-deps`; OpenCode uses
`npm ci --ignore-scripts --omit=dev`):

```sh
PSST_CURRENT_MATRIX_SOURCES='{"pi":"/checkouts/pi","claude-code":"/checkouts/claude","antigravity-cli":"/checkouts/antigravity","opencode":"/checkouts/opencode"}' \
  node --test integration/current-connector-matrix.test.mjs
```

Use the repository's pinned Node 24.19.0 runtime. These source checkouts are inputs
to `npm pack`; this is not evidence that the new npm names have been published or
installed by a native package manager. The job has no authenticated models or
official CLI processes and does not fill any native compatibility-matrix cell.
Actual busy/draft/permission/abort/model-switch behavior, real-native crash
windows and user-environment acceptance remain open under #11 and the connector
trackers. Native operation replay and uncertain-final-hop fault injection are not
new assertions in this cohort test; the separate broker/connector suites retain
their own idempotency and ambiguity coverage. In particular, a consumed Claude
native permit must not be replaced to manufacture a successful replay.
Exact-head CI is required for each candidate; the historical CI links
above must not be read as execution evidence for this newer job.

### Connector qualification

These independent post-merge runs passed at the listed revisions. They use
different fixtures and cannot be combined into a claim that the full directed
native matrix passed.

| Connector revision | CI evidence | Scope and explicit limit |
| --- | --- | --- |
| [Pi `9dd2f549da4a3eec43c1c2288a952ce1378458c8`](https://github.com/matuto-ai/pi-psst-connector/tree/9dd2f549da4a3eec43c1c2288a952ce1378458c8) | [41672214404](https://github.com/matuto-ai/pi-psst-connector/actions/runs/41672214404) | Official Pi 1.4.0 loader/tool/history probes; actual PTY URL-only setup, TLS/admin approval and container recreation. The host-card probe covers persisted offline-event rendering/model-context conversion and exact event ACK using a fixture event/client. No authenticated-model acceptance. |
| [Antigravity `2a14f88058c2077a4a315ed9c22098adbea5e82c`](https://github.com/matuto-ai/antigravity-psst-connector/tree/2a14f88058c2077a4a315ed9c22098adbea5e82c) | [41687147202](https://github.com/matuto-ai/antigravity-psst-connector/actions/runs/41687147202) | Official CLI 1.4.7 build 5900205422411776 validates/installs the plugin. Network-isolated actual-plugin root/compact/new/presence probes pass with a loopback fake provider. Readable presence output and explicit ACK reach that provider flow; unattended wakeup/authenticated-model acceptance remain unverified. |
| [Claude `b25b4013afd45041c390616e55a5cb07c9ebb62d`](https://github.com/matuto-ai/claude-psst-connector/tree/b25b4013afd45041c390616e55a5cb07c9ebb62d) | [41669361781](https://github.com/matuto-ai/claude-psst-connector/actions/runs/41669361781) | Official Claude 2.1.310 hook-to-MCP qualification preserves native permission denial. Same-process clear/compact checks use one host/MCP process and a loopback provider. The result explicitly reports `monitor_delivery_tested:false` and `authenticated_model:false`. |
| [OpenCode `36110bdeb15ca15e52106d6d0af9fc71beee3ab6`](https://github.com/matuto-ai/opencode-psst-connector/tree/36110bdeb15ca15e52106d6d0af9fc71beee3ab6) | [41687130474](https://github.com/matuto-ai/opencode-psst-connector/actions/runs/41687130474) | Official 2.2.5 libraries/loader/CodeMode and synthetic API/context fixtures; real Docker recreation. The integration stage reports **25 passed, 3 skipped**: the optional official CLI automatic-admission, native setup and plugin-manager installation tests did not run. Native TUI/authenticated-model notice acceptance remains unverified. |

The corresponding executable sources are
[Pi host-card](https://github.com/matuto-ai/pi-psst-connector/blob/9dd2f549da4a3eec43c1c2288a952ce1378458c8/test/native-card-host.probe.mjs),
[Antigravity actual-plugin runner](https://github.com/matuto-ai/antigravity-psst-connector/blob/2a14f88058c2077a4a315ed9c22098adbea5e82c/scripts/native-contract-proof/run-actual.sh),
[Claude native lifecycle](https://github.com/matuto-ai/claude-psst-connector/blob/b25b4013afd45041c390616e55a5cb07c9ebb62d/integration/native-lifecycle-probe.mjs)
and [OpenCode verification workflow](https://github.com/matuto-ai/opencode-psst-connector/blob/36110bdeb15ca15e52106d6d0af9fc71beee3ab6/.github/workflows/verify.yaml).
Pi, Antigravity and Claude CI use broker integration fixture
`f32ddc79ec7b812062ed3f6de7b9a0c12a7128f3`; additional approval fixtures and
OpenCode's vendored fixtures have their own pins. None of these runs proves a
composed test of every current head against broker `c579161c`.

### Remaining integrated acceptance

[Issue #11](https://github.com/matuto-ai/psst/issues/11) remains open for the
complete directed native routes and safety/recovery evidence, concurrent
three-party exchange, offline/model-switch/restart flows, Fedora
SELinux/Quadlet/autostart and two-host LAN. See
[the unchanged uncertified native matrix](feasibility.md#directed-real-harness-matrix).
The bounded lifecycle/discovery/offline-notice criteria in
[issue #29](https://github.com/matuto-ai/psst/issues/29) are mapped separately in
[its acceptance record](presence-acceptance.md); do not confuse them with the
broader #11 gates. No release, deployment, real credential
or host-configuration change is implied by this evidence record.

The sections below retain the original October checkpoint and its immutable
historical evidence. Their counts, native limitations and local-tool availability
describe that checkpoint, not every later connector version.

## Local checkpoint — 2026-10-23

Runtime queried from the actual binary: Node.js **24.19.0**, bundled SQLite **3.53.3**.

| Check | Result |
| --- | --- |
| `npm test` | **117 tests passed**, no skips/failures at this checkpoint |
| `npm run check` | Passed; JavaScript syntax checks, not a TypeScript type-check |
| `npm run smoke` | Passed; actual service entrypoint, nonroot, readiness/auth, graceful shutdown |
| `npm run demo` | Included in aggregate; all 16 simulated family routes across eight distinct reference-session identities |
| Local container build/run | Not run: neither Docker nor Podman was available |
| CI container build/run | **Passed** at code checkpoint `e015a6f5d7cc32d0c0a90bd633fab8d94195417a`; linked evidence below |
| Rootless Podman 4.9.3 on Ubuntu 24.04 CI | **Passed** at `afbda8424ec82f468a6b34f929b36c9a8f060680`; keep-id, private bind volumes, no network and restart smoke |
| Fedora Quadlet/SELinux and two-host LAN | Not run; templates and manual gates only |
| Real Pi/Antigravity CLI/Claude Code/OpenCode final hop | Not certified; [isolated Pi 1.4 probe](probes/pi-1.4/README.md) records narrower actual-Pi observations only |

The exact command output for a later commit supersedes the checkpoint count above.

## Covered boundaries

- Strict request/response fixtures, canonical immutable-envelope serialization/digest, bounded Unicode/UTF-8 fields, and safe error references.
- Exact owned identities, duplicate names/types/models, metadata CAS/snapshots, reconnect idempotency, lease expiry and old-epoch fencing.
- Per-token type/scope restrictions, operator policy shrink, token rotation/revocation during a long poll, no unauthenticated `/v1` exception, no CORS/browser authority.
- Trusted TLS succeeds; untrusted certificates and hostname mismatches fail for both the service and reference client.
- Atomic acceptance before receipts, concurrent recipient sequence allocation, replay precedence over mutable metadata/recipient/quota/rate checks, FIFO claims and duplicate completion.
- Before/after-commit faults, conservative unknown effects, failed-rollback writer poisoning, exact TTL beyond a cleanup batch, uncertain prior claims, quotas/rate/storage pressure, bounded retention.
- Actual broker **SIGKILL/restart** preserves WAL messages/send dedupe while invalidating old leases/claims; schema v1→v2 migration and online SQLite backup/restore preserve durable records.
- Reference inbox commits before ACK, survives crashes, deduplicates immutable envelopes, enforces count/byte/ledger/disk limits and process-exclusive ownership. Uncertain local commits never send a negative ACK.
- Independent heartbeat transport across 12 simulated minutes of busy/approval/input/draft/abort/unknown local harness conditions makes no model calls.
- Local injection intent/receipt separation, fail-closed arbitration, ambiguity pause, escaped model-visible agent provenance, and non-consuming cooperative peek.
- Minimal local stdio MCP handshake/tools, bounded frames/concurrency/output, redacted failures, no channels, permission relay, HTTP listener or model sampling.
- Absolute client deadlines, Retry-After and persisted keys; stale registration responses are reconciled against current owned state rather than treated as fresh leases or clocks.
- Stop during initial attachment, reconnect or lifecycle preflight drains bounded in-flight transitions, prevents late loops, and closes the final known epoch. Concurrent shutdown waits for the same close; unknown remote effects still fall back to lease expiry.

## Independent review

The implementation received a separate read-only security/protocol review. Identified defects were fixed with regression tests before the corresponding checkpoint was described as passing. This is not a third-party security certification. Source review and native/deployment acceptance gates remain distinct.

`delivered` always means durable adapter-inbox receipt, never native harness acceptance, model processing, conversation completion, or human authorization. See [feasibility.md](feasibility.md) for the deliberately uncertified real-harness matrix.

## Recorded CI evidence

Code checkpoint `e015a6f5d7cc32d0c0a90bd633fab8d94195417a` passed both [push run 39972853462](https://github.com/brunoorsolon/ai-agent-msg-broker/actions/runs/39972853462) and [PR run 39972854253](https://github.com/brunoorsolon/ai-agent-msg-broker/actions/runs/39972854253). Job logs confirm 109/109 core tests, 109/109 in the Docker build test stage, six nonroot HTTP tests with `--network none`, a slim nonroot runtime build, and the actual entrypoint smoke with a read-only root filesystem and disposable tmpfs data. No image was pushed to a registry.

The Containerfile pins the two official image digests resolved in that run. Both Docker and Podman ignore files exclude private build-context material. The subsequent packaging-only changes received their own exact-commit CI; this historical record does not change the shared adapter API/code checkpoint. Native CLI certification, Fedora Quadlet/SELinux and two-host LAN gates remain distinct.

### Rootless Podman CI

Checkpoint `afbda8424ec82f468a6b34f929b36c9a8f060680` passed [push run 39975019482](https://github.com/brunoorsolon/ai-agent-msg-broker/actions/runs/39975019482) and [PR run 39975028574](https://github.com/brunoorsolon/ai-agent-msg-broker/actions/runs/39975028574), including all core, Docker and rootless-Podman jobs. The existing Ubuntu 24.04 runner (`20261012.334.1`) supplied Podman **4.9.3**; the job required a nonroot host UID and rootless mode rather than installing software or changing host security.

The digest-pinned runtime built under rootless Podman. `scripts/podman-smoke.mjs` verified `--userns=keep-id`, private host-owned writable data, read-only configuration and root filesystem, dropped capabilities and `no-new-privileges`, with `--network=none` and no published ports. Its actual broker process survived a SIGKILL/restart with durable send replay, invalidated old epochs, redelivery and the delivered-completion API; SIGTERM exited cleanly. Tokens and state were disposable fixture files and removed afterwards. Logs confirm both before/after-restart probes and the final smoke succeeded. No registry image or production credential was created.

This establishes the bounded **Ubuntu rootless container** scenario only. It does not establish Fedora SELinux relabeling (`:Z`), Quadlet/systemd installation/autostart, the user's filesystem/runtime, separate agent-container networking, real TLS/LAN ingress, or two-host connectivity. Those remain operator/native acceptance gates.

## Archived Pi runtime probe

The [Pi 1.4 probe](probes/pi-1.4/README.md) preserves an actual official Pi runtime run with the pinned historical broker `e015a6f5d7cc32d0c0a90bd633fab8d94195417a`, a deterministic local provider, injected Terminal and synthetic managed Antigravity child. It observed held-tool/human-Enter ordering before native follow-up, provider-visible untrusted provenance, heartbeat independence, and old-session shutdown. The Pi item deliberately remains pending because the native void API is not an acceptance receipt. This separate manually run probe is **not part of `npm test`**, a production Pi adapter, a physical PTY test, or a four-CLI compatibility certification. Its source manifest refuses different named bytes; use its exact snapshots rather than silently running against a later shared-runtime revision.

## Integrated packaging and recovery candidate

The [original issue #11 acceptance ledger](issue11-acceptance.md) documents the real
prior-entrypoint upgrade/restore check, eight-container directed TLS topology and
remaining original native/Fedora/two-host dependencies. Historical run links above
are not execution evidence for these new checks; verify the current PR head.
