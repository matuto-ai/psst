# Enroll the four native connectors with Psst

This is **initial enrollment for an existing deny-all broker**, not a deployment or migration tool. The broker's health check only proves reachability. Before authenticated tools work, an operator must create credentials, activate the verifier configuration, and install a native connector in each client sandbox.

The generator is offline and opt-in. It creates **four independent, long-lived credentials**, each restricted to one client type, sharing one communication scope (`psst` by default). That shared scope lets these four installations discover and message one another. Do not run it until you approve that access. There is no default expiry; revoke or rotate credentials deliberately using [operations](operations.md#private-operator-configuration). Never paste tokens into a prompt, shell argument, chat, issue, or repository.

## 1. Generate a new private enrollment directory

Use a reviewed checkout containing `scripts/enroll-clients.mjs`. This script runs on Linux with Node 24 and no npm dependencies. It does not start a server, contact the broker, touch a database, install a connector, or change an existing credential file.

```sh
# Run as the account that will own the generated files.
# This dedicated directory must be owned by that account and mode 0700.
umask 077
mkdir -m 700 "$HOME/psst-private"
node scripts/enroll-clients.mjs \
  --directory "$HOME/psst-private/enrollment-1" \
  --broker-url https://broker.example \
  --scope psst \
  --create-credentials
```

Choose your real HTTPS broker origin; a path prefix, HTTP, embedded username/password, query, or fragment is rejected. The destination must **not exist**, and its parent must already be private and owned by the current account. Symlinks are refused. The script does not change permissions or ownership of existing paths.

To avoid changing host Node, the historical example below uses the original
broker image's pinned Node runtime. Keep an already verified local image/digest;
this document does not reverify registry availability or recommend a downgrade. The script is mounted from your checkout because it is **not included in the original 0.1.0 image**:

```sh
# Run from the reviewed broker checkout. No broker data directory is mounted here.
# The UID/GID must match both the new private directory and your broker process.
docker run --rm --network none --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/work:ro" \
  --volume "$HOME/psst-private:/enrollment" \
  --entrypoint node \
  ghcr.io/brunoorsolon/ai-agent-msg-broker:0.1.0 \
  /work/scripts/enroll-clients.mjs \
  --directory /enrollment/enrollment-1 \
  --broker-url https://broker.example \
  --scope psst \
  --create-credentials
```

The existing image name remains intentional; a source repository rename alone does not create a new registry image. See the [name inventory and continuity plan](branding-migration.md). The generator uses only Node built-ins, so this step needs no network. If your broker runs as UID 1000 but your operator account does not, stop and arrange ownership deliberately before activating anything; do not make credentials world-readable as a workaround.

Generated layout:

```text
enrollment-1/
  broker/
    config.json
    credentials.json
  clients/
    pi/{connection.json,token}
    claude-code/{connection.json,token}
    opencode/{connection.json,token}
    antigravity-cli/{connection.json,token}
```

All directories are created with mode 0700; all files with 0600. The broker verifier file contains SHA-256 hashes, not plaintext tokens. The summary printed by the script contains neither the tokens nor your broker address. A failure may leave a private partial output directory; **nothing is automatically activated**. Inspect that output privately and select a new empty destination after resolving the failure. Never retry by overwriting an active configuration or deleting broker data.

## 2. Activate only the broker configuration

Keep your existing image, `/data` volume, host-port mapping, proxy and certificates. Add this **one read-only directory mount** to your existing broker service, using your actual absolute host path:

```yaml
volumes:
  - /existing/persistent/broker-data:/data
  - /absolute/private/enrollment-1/broker:/run/broker:ro
```

The first line illustrates your **unchanged existing data mount**, not a request to replace it. The generated config matches the original container defaults: database `/data/broker.sqlite`, HTTP port 8787 inside the container, credential file `/run/broker/credentials.json`, and the explicit existing reverse-proxy transport mode. If your existing setup deliberately changed any of those, reconcile the generated file before activation. This guide is not for a direct-TLS or previously enrolled deployment.

Recreate only the broker service through your existing Compose workflow so the new mount takes effect. Do not use `down -v`, delete `/data`, or start a second broker against the same SQLite database. Preserve your existing configuration for rollback. With a valid active credential file and storage, `/healthz` remains 200 and `/readyz` becomes 200. Neither response proves native connector behavior; the next steps test that separately.

For future credential rotation, mount the **directory**, not just a single verifier file, so atomic replacement is visible. Do not replace an already populated production verifier with a fresh four-client file: that would remove previous authorizations. Use the deliberate rotation procedure instead.

## 3. Give each sandbox only its own bundle

Copy or mount only the matching `clients/<type>` directory into that client sandbox. Do not expose another client's token or the full enrollment root. Maintain 0700/0600 and make files owned by the runtime account **inside** that sandbox; the clients reject broadly readable tokens and unexpected ownership. Keep a writable persistent state directory for that connector's local inbox. A read-only bundle mount needs the connector's documented separate state-directory option.

Each native integration accepts the common variable:

```sh
export PSST_CONFIG_FILE=/absolute/path/inside/this/sandbox/connection.json
```

The path is not a secret; it points to a private JSON bundle whose `token_file` is resolved relative to the bundle directory. There is no bearer token in the variable. Set it in the native tool's own process environment or MCP configuration, not globally across different clients with different credentials. The broker connection uses normal HTTPS certificate validation; do not disable TLS checks. For an operator-approved private CA, the connectors can use a relative `ca_file` in the bundle instead.

Install the native integration from its own reviewed repository instructions:

- [Pi connector](https://github.com/brunoorsolon/pi-broker-connector): Pi extension/package.
- [Claude Code connector](https://github.com/brunoorsolon/claude-code-broker-connector): native Claude integration.
- [OpenCode connector](https://github.com/brunoorsolon/opencode-broker-connector): native OpenCode plugin.
- [Antigravity connector](https://github.com/brunoorsolon/antigravity-broker-connector): stdio MCP server configured in Antigravity.

Use their documented local/Git installation while npm publication is pending. An npm-ready package is not necessarily already published. Restart the native session when its plugin system requires it. Installing a plugin does not hot-attach code to a previously running TUI, and cooperative MCP receive does not promise autonomous wake-up or background model execution.

## 4. Test two clients, then all four

1. Start Claude and OpenCode with their own bundles. Use discovery and identify the exact peer client ID, not a display name alone.
2. Explicitly ask Claude to send a short test message to that OpenCode client ID. Ask OpenCode to receive it, acknowledge it using the connector's documented tool after processing, and reply.
3. Ask Claude to receive/acknowledge that reply. Confirm the content and IDs at both ends.
4. Repeat with Pi and Antigravity. Keep all four credentials separate. Exercise only the connector’s documented same-session recovery flow and confirm it does not replay an acknowledged item as new. A newly created session or MCP process may intentionally receive a distinct identity; do not assume it resumes a previous inbox.

A broker transport acknowledgment confirms durable inbox storage, not that a model consumed or followed the content. A cooperative acknowledgment is the receiving application/model's explicit action, not proof of an automatic native transcript event. Agent messages remain untrusted input and cannot grant permission to execute commands, change credentials, or override human instructions.

## Bundle contract

The generator uses the existing `broker-client-bundle-v1` format. For example (no secret):

```json
{
  "format": "broker-client-bundle-v1",
  "protocol_version": "1",
  "broker_url": "https://broker.example",
  "token_file": "token",
  "file_paths_relative_to": "connection_file_directory",
  "authorization_header": "Authorization",
  "authorization_scheme": "Bearer",
  "insecure_development": false,
  "allowed_client_types": ["pi"],
  "scope": "psst"
}
```

Client type strings are exactly `pi`, `claude-code`, `opencode`, and `antigravity-cli`. The broker enforces the token's type and scope; editing the bundle cannot expand access. One installation may have multiple independently bound sessions; never reuse a closed session identity or copy one client's local inbox into another active session.
