# Compatibility evidence and release gates

## What this record establishes

The broker owns authenticated transport, registry state and durable message delivery.
Broker `delivered` stops at the exact recipient's durable adapter inbox. Native
history persistence, model-visible input, an explicit read ACK and successful work
are separate observations.

This record reconciles evidence available on **2026-11-03** for
[issue #11](https://github.com/matuto-ai/psst/issues/11). It includes newer connector
qualification without treating isolated fixtures as the complete native matrix.
Exact revisions, CI runs and limits are in the
[verification snapshot](verification.md#evidence-snapshot-2026-11-03).

The executable contract is documented in [contract.md](contract.md#real-harness-release-gates).
The safety requirements remain in [spec-v1.md](spec-v1.md#9-adapter-contract-safe-conversational-delivery).
Deployment boundaries are in [operations.md](operations.md).

## Native host evidence

These are separate connector runs, not a single test of all current connectors
together. A successful official CLI fixture establishes only the exercised path,
version and local provider conditions.

| Host | Retained evidence | Remaining acceptance |
| --- | --- | --- |
| Pi **1.4.0** | Official loader and tool-call probes; resumed-history rendering/persistence and model-context conversion; URL-only PTY setup with real TLS/admin approval; container recreation and isolated SDK sessions. Using a fixture event/client and append-backed send stand-in, the current host-card probe persists a distinct offline notice, observes it in converted model context and ACKs its exact event once. | Complete idle/busy/draft/permission/abort/crash-window behavior and authenticated-model acceptance across the directed matrix. A persisted custom entry is not evidence that a model read or acted on it. |
| Antigravity CLI **1.4.7**, build **5900205422411776** | Pinned official validator/install/list; actual production plugin with root, compact and new-conversation checks in network-isolated containers. A loopback fake provider observes readable offline-event tool output and an explicit event ACK while queued mail remains unchanged. | Unattended native waiter wakeup and authenticated-model/user-launcher acceptance, including the complete human-input and failure matrix. The controlled provider sequence does not prove unsolicited wakeup. |
| Claude Code **2.1.310** | Official hook-to-MCP input qualification preserves native permission denial. Actual same-process `/clear` creates a new lifetime/mailbox and `/compact` preserves them, using one host/MCP process and a loopback provider. | The native lifecycle probe explicitly excludes monitor delivery and authenticated-model acceptance. Automatic monitor idle/busy/restart and prolonged-offline notice consumption still need their own evidence. |
| OpenCode **2.2.5** libraries/plugin API | Official loader/CodeMode integration, packed root plugin and real container recreation; fixture-based synthetic admission/context proof and durable offline-notice recovery. | The cited CI run skips three optional official CLI cases: packed native-plugin automatic admission, URL-only native setup, and native plugin-manager installation. Interactive TUI/authenticated-model notice acceptance is not established by the library/API fixtures. |

The [verification snapshot](verification.md#connector-qualification) links each
source revision and CI run. The older [Pi 1.4 probe](probes/pi-1.4/README.md)
remains a historical archive: its Antigravity child was synthetic and its void
native API left the item pending. That result does not describe every later Pi
connector path.

Production connector acceptance requires the selected automatic native mechanism.
Cooperative receive/ACK remains useful diagnostic evidence, not a silent
production fallback when automatic readiness is blocked. Never type into a TUI,
abort a human turn or bypass permissions to make delivery appear successful.

## Transport matrices already exercised

### Reference adapters

`npm run demo` covers all 16 type-family routes over real HTTP into eight durable
reference inboxes. Native CLI input and LLM calls are absent.

### Packaged connectors

[PR #24](https://github.com/matuto-ai/psst/pull/24) added the actual npm-packed
four-connector matrix against a trusted-TLS broker and form-authenticated admin
approval. Two independent identities per connector cover 12 cross-family and
four same-family routes, then repeat them after process recreation: **32 route
checks**. The original installation credentials persist; the second round uses
fresh native lifetimes.

Host events/contexts are synthetic and the test invokes cooperative ACKs. This
does not prove same-native-session pending-inbox recovery or automatic native
input. The current broker CI still pins that older connector cohort; its pass
does not establish compatibility of all newer connector heads together. See the
[exact matrix pins](verification.md#packaged-connector-matrix).

## Directed real-harness matrix

All entries remain **not certified** for the complete issue #11 acceptance set.
Diagonal cells require distinct same-family sessions. Neither reference routes,
packaged cooperative routes nor isolated one-host probes fill these cells.

| Sender → receiver | Pi | Antigravity CLI | Claude Code | OpenCode |
| --- | --- | --- | --- | --- |
| Pi | Not certified | Not certified | Not certified | Not certified |
| Antigravity CLI | Not certified | Not certified | Not certified | Not certified |
| Claude Code | Not certified | Not certified | Not certified | Not certified |
| OpenCode | Not certified | Not certified | Not certified | Not certified |

Each completed cell needs both pinned CLI versions, connector revisions, the
actual mode and exact-session topology, plus retained evidence for source labels
in model input, non-interruption, human-prompt preservation, zero-token heartbeat
and native acceptance/crash windows. Include concurrent three-party exchange,
offline recipients, model switches and restart. Record uncertain effects rather
than automatically replaying an ambiguous native submission.

## Environment evidence boundary

- **Broker/runtime:** the current cited CI passes pinned Node 24.19.0 / SQLite
  3.53.3 tests, Docker/nonroot packaging, browser/admin fixtures and rootless
  Podman jobs. These are runner results, not a new local or user-host run.
- **Same-host container transport:** CI exercises a separate rootless container
  reaching host HTTPS with CA/SAN/auth checks on the tested route, plus
  container-removal/recreation persistence fixtures. This is narrower than
  universal rootless networking or a four-native-host topology.
- **Still unverified:** Fedora SELinux `:Z`, Quadlet/systemd/autostart, other
  Podman network modes, the user's proxy/sandbox topology, and two-host LAN
  acceptance. A container network test does not replace the two-host scenario.
- **Authenticated user environment:** the cited isolated fixtures use disposable
  data and local providers where needed. They do not certify the user's installed
  CLIs, login, real model response or production setup.

Keep [#11](https://github.com/matuto-ai/psst/issues/11) open for the integrated
packaging/recovery/native gates and [#29](https://github.com/matuto-ai/psst/issues/29)
open for remaining lifecycle/offline-notice acceptance. The connector trackers
remain [Pi #12](https://github.com/matuto-ai/pi-psst-connector/issues/12),
[Antigravity #8](https://github.com/matuto-ai/antigravity-psst-connector/issues/8),
[Claude #11](https://github.com/matuto-ai/claude-psst-connector/issues/11) and
[OpenCode #8](https://github.com/matuto-ai/opencode-psst-connector/issues/8).
Source merges, green fixture CI and published artifacts are distinct from those
remaining acceptance gates.

