# Psst

**Psst** is the public name of the former **AI Agent Message Broker**. The private
package identifier `ai-agent-msg-broker` and existing storage/configuration names
remain for compatibility. Branding does not create new sessions or move data.
See the [technical-name inventory and migration/rollback plan](docs/branding-migration.md).

A generic, authenticated LAN message broker for independent AI CLI sessions. It owns the recipient registry, background presence, and durable **message delivery**—not conversations, tasks, model progress, or agent orchestration.

**Status: pre-1.0 development.** The broker implementation, reference adapter and local stdio facade are on `main`. Version 0.7.3 is a source candidate until its release workflow succeeds. Native Pi, Antigravity CLI, Claude Code and OpenCode installation and receiving behavior must be validated separately; protocol fixtures and CI are not evidence of acceptance in a user environment.

## Docker server

Use the [Docker image / Compose and release guide](docs/docker-release.md). The server image starts without credentials for connectivity testing: HTTP port **8787**, persistent **`/data`**, public health only; every API stays denied until adapters are enrolled. Your existing HTTPS proxy and network configuration remain operator-owned. CI runs on every push/PR; a user-published GitHub Release gates image publication on syntax, focused unit tests and read-only container storage checks. No image is published just by pushing this branch.

## Native setup

Native setup asks only for the broker URL, followed by approval in the broker administration page. See [URL-only setup](docs/approval-operator.md) and the [approval contract](docs/approval-protocol.md). This flow is available since broker 0.4.0 and requires a compatible connector; it is not present in broker 0.3.0. Existing legacy bundles and ticket pairing remain compatible. Native automatic-receive acceptance is separate from the unit suite.

## 0.7.3 source candidate

This patch provides writable temporary storage for read-only container deployments and checks real SQLite temporary-file storage at startup. Logs are human-readable by default, explain SQLite 6410 with a remedy, and omit repetitive internal polling/commit noise. Collectors can retain JSON with `PSST_LOG_FORMAT=json`. Image publication also requires the read-only container storage checks to pass.

There are no schema or protocol changes from 0.7.2; existing grants, identities, expiry timestamps and retention policies remain unchanged. The cause of the older 0.7.1 outage remains unproven. See [diagnostics and Settings](docs/logging-settings.md) and [0.7.3 changes and compatibility](CHANGELOG.md#073-upgrade-notes). Source preparation does not publish a release/image or activate a deployment.

## Optional session retention

Version 0.6.0 adds registration-v2 support and schema-5 migration. Cleanup stays
disabled by default; enabling the persistent v2 floor and disconnected-session
retention requires a separate operator decision after connector recovery has been
validated. Preserve existing data and authorization when upgrading. See the
[rollout and backup requirements](docs/presence.md#optional-ephemeral-session-retention-registration-v2).

## Contract

- [v1 specification](docs/spec-v1.md)
- [OpenAPI 3.1 contract](openapi.json) and [canonical serialization](docs/contract.md)
- [Reference adapter/runtime](docs/reference.md), [operations and containers](docs/operations.md)
- [Presence, resumable disconnect and offline notices](docs/presence.md)
- [Verification record](docs/verification.md) and [real-CLI compatibility gates](docs/feasibility.md)
- [Implementation issues and milestones](docs/implementation-plan.md)

`202 Accepted` means stored by the broker. `delivered` means committed to the exact recipient's durable adapter inbox, **not** read, injected into a harness, processed, or answered by a model. Plain text remains untrusted agent input.

## Build from source

Clone the current repository for development. For an installation, prefer a successfully published versioned image from the release guide:

```sh
git clone https://github.com/matuto-ai/psst.git
cd psst
```

Use an isolated pinned runtime/container rather than upgrading a workstation's global Node. See [container instructions](docs/operations.md#container-review-and-rootless-podman-example).

For an optional temporary host-only diagnostic (not the normal Docker server), see [host HTTPS connectivity only](docs/podman-host-https-test.md), explicit bind/SAN and per-client CA trust. No CLI/session changes.

Already have clients running in the same network namespace? Use [broker-only local startup](docs/local-broker-test.md): it prints the URL and private connection-file paths without detecting, launching or changing any CLI session. No global Node upgrade is needed. The separate [two-new-Claude-session lab](docs/local-claude-test.md) is optional and is not needed for broker startup.

## Development

Use **Node.js 24.19.0** (the tested runtime; bundled SQLite 3.53.3). No npm packages are required.

```sh
npm test
npm run check
```

The unit tests use isolated temporary SQLite/filesystem fixtures, fake clocks, in-memory streams and injected transports. They do not start broker servers, launch child processes, install native hosts, run browsers or containers, or call an LLM. No npm dependencies or `openssl` are required. See [the test policy](docs/verification.md).

The service starts with `BROKER_CONFIG_FILE=/path/to/private/config.json npm start`. Startup fails closed without an operator-owned verifier file and explicit TLS or an explicit documented development/proxy transport mode. Every `/v1` request authenticates, even on loopback. Tokens are never tool arguments or CLI flags.

One broker process owns local SQLite, using WAL and FULL durability. A separate SQLite exclusive owner lock prevents duplicate writers without relying on process IDs. Shared/network SQLite files and public Internet ingress are unsupported.

No release, deployment, host configuration change, or production credential is included in this repository's test runs.

The optional MCP facade is local stdio/tools-only, with no Channel push, remote MCP listener, permission relay, or claimed native-host certification.


## Diagnostics and Settings

The source includes English structured stderr diagnostics with safe error codes
and request correlation, plus authenticated **Settings** for log level and
distinct future expiration durations. See [operator guidance](docs/logging-settings.md)
for privacy, precedence, bounds, replay compatibility and recovery. This source
change is not a new image release or a deployment.
