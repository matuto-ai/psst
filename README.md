# AI Agent Message Broker

A generic, authenticated LAN message broker for independent AI CLI sessions. It owns the recipient registry, background presence, and durable **message delivery**—not conversations, tasks, model progress, or agent orchestration.

**Status: development preview.** The broker core, reference adapter and local stdio facade are available for review in a draft PR. Real Pi, Antigravity CLI, Claude Code, and OpenCode receiving modes are separately gated; protocol fixtures are not evidence of real CLI compatibility.

## Docker server

Use the [Docker image / Compose and release guide](docs/docker-release.md). The server image starts without credentials for connectivity testing: HTTP port **8787**, persistent **`/data`**, public health only; every API stays denied until adapters are enrolled. Your existing HTTPS proxy and network configuration remain operator-owned. CI runs on every push/PR; a user-published GitHub Release gates image publication on the full suite. No image is published just by pushing this branch.

## Scoped pairing (opt-in upgrade)

New source workflow: native setup asks only for the broker URL, followed by approval in the broker administration page. See [URL-only setup](docs/approval-operator.md) and the [approval contract](docs/approval-protocol.md). This requires broker0.4.0 after publication and compatible connector releases; it is not present in broker 0.3.0. Existing legacy bundles and ticket pairing remain compatible. Native automatic-receive acceptance is separately tested per connector.

## Contract

- [v1 specification](docs/spec-v1.md)
- [OpenAPI 3.1 contract](openapi.json) and [canonical serialization](docs/contract.md)
- [Reference adapter/runtime](docs/reference.md), [operations and containers](docs/operations.md)
- [Presence, resumable disconnect and offline notices](docs/presence.md)
- [Verification record](docs/verification.md) and [real-CLI compatibility gates](docs/feasibility.md)
- [Implementation issues and milestones](docs/implementation-plan.md)

`202 Accepted` means stored by the broker. `delivered` means committed to the exact recipient's durable adapter inbox, **not** read, injected into a harness, processed, or answered by a model. Plain text remains untrusted agent input.

## Try the preview branch

`main` still holds the specification until this draft is reviewed. Clone the implementation branch explicitly:

```sh
git clone --branch feat/durable-broker-v1 --single-branch https://github.com/brunoorsolon/ai-agent-msg-broker.git
cd ai-agent-msg-broker
```

Use an isolated pinned runtime/container rather than upgrading a workstation's global Node. See [container instructions](docs/operations.md#container-review-and-rootless-podman-example).

For an optional temporary host-only diagnostic (not the normal Docker server), see [host HTTPS connectivity only](docs/podman-host-https-test.md), explicit bind/SAN and per-client CA trust. No CLI/session changes.

Already have clients running in the same network namespace? Use [broker-only local startup](docs/local-broker-test.md): it prints the URL and private connection-file paths without detecting, launching or changing any CLI session. No global Node upgrade is needed. The separate [two-new-Claude-session lab](docs/local-claude-test.md) is optional and is not needed for broker startup.

## Development

Use **Node.js 24.19.0** (the tested runtime; bundled SQLite 3.53.3). No npm packages are required.

```sh
npm test
npm run check
npm run smoke  # actual nonroot service entrypoint, disposable fixtures
npm run demo   # all 16 simulated family routes into durable reference inboxes
```

The tests use isolated temporary databases and disposable test-only credentials/certificates. TLS tests require the `openssl` command. They do not configure a host, provision ongoing access, or call an LLM.

The service starts with `BROKER_CONFIG_FILE=/path/to/private/config.json npm start`. Startup fails closed without an operator-owned verifier file and explicit TLS or an explicit documented development/proxy transport mode. Every `/v1` request authenticates, even on loopback. Tokens are never tool arguments or CLI flags.

One broker process owns local SQLite, using WAL and FULL durability. A separate SQLite exclusive owner lock prevents duplicate writers without relying on process IDs. Shared/network SQLite files and public Internet ingress are unsupported.

No release, deployment, host configuration change, or production credential is included in this repository's test runs.

The demo uses eight distinct session identities, real HTTP, and local durable reference journals; it performs no native CLI input or LLM calls. The optional MCP facade is local stdio/tools-only, with no Channel push, remote MCP listener, permission relay, or claimed native-host certification.
