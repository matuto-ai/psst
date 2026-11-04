# Start only the broker; keep your existing clients

This optional operator procedure is not part of automated testing. Its existing local image name can be built with `podman build --target runtime -f Containerfile -t localhost/ai-agent-msg-broker-test:reviewed .`; the name is only a local compatibility alias, not a test image stage.

For clients in separate Podman sandboxes, use [host HTTPS connectivity first](podman-host-https-test.md) instead. This page is only for clients sharing the host network namespace.

This command starts **only the broker**. It does not find or launch Claude, clone
connectors, create projects, inspect plugins, or restart/attach existing sessions.
Your already running clients remain under your control.

## Start

From the `feat/durable-broker-v1` broker checkout, inspect local changes and update
without overwriting them:

```sh
git status --short
git pull --ff-only
bash scripts/start-local-broker.sh
```

Use an ordinary nonroot Linux account with existing rootless Podman and the local
image `localhost/ai-agent-msg-broker-test:reviewed`. No rebuild or global Node
upgrade is needed. `--image EXISTING_LOCAL_IMAGE` selects another already-local
reviewed image. The script prints progress immediately and names failed stages;
runtime preparation is bounded to 180 seconds. It never pulls an image or installs
a package. It needs standard `timeout`, `sha256sum`, `stat` and `mktemp` utilities.

It copies/hash-checks isolated Node 24.19.0 / SQLite 3.53.3 from that image into a
new private `~/broker-local.XXXXXXXX` directory, then opens an authenticated HTTP
listener on **127.0.0.1 and a free port**. This is the explicit loopback development
exception, not a LAN/TLS deployment. No firewall or host security change is made.

Keep that terminal open. Expected output includes:

```text
BROKER_URL=http://127.0.0.1:<selected-port>
CLIENT-A connection file: <private-directory>/state/client-a.connection.json
CLIENT-A token file: <private-directory>/state/client-a.token
CLIENT-B connection file: <private-directory>/state/client-b.connection.json
CLIENT-B token file: <private-directory>/state/client-b.token
```

No token value is printed. Two distinct credentials, limited to a shared
`local-test` scope, expire after **two hours**; the broker automatically stops
then. Credential files are mode `0600`, their parent is `0700`, and the broker
verifier file stores only hashes. They permit the four supported client types
(`pi`, `antigravity-cli`, `claude-code`, `opencode`). **No client session is
registered for you.**

## Information for each existing connector

Give each connector its own connection file/token-file path through that
connector's supported **local configuration mechanism**. These JSON files are
connection descriptions, **not a claim about your installed plugin's config
schema**, environment variables, reload support, or ability to attach a session.
Do not paste token contents into chat, prompts, model tools or issue reports.

The concrete broker transport contract is:

| Connection field | Meaning |
| --- | --- |
| `broker_url` | Printed HTTP origin, without `/v1` suffix. |
| `protocol_version` | String `"1"`. |
| `token_file` | Absolute local file containing that client's bearer credential. |
| `authorization_header`, `authorization_scheme` | Every `/v1` request sends `Authorization: Bearer <token read locally>`. |
| `insecure_development` | `true` only for this explicit numeric-loopback HTTP lab. |
| `expires_at` | Credential deadline; the lab does not silently renew it. |
| `allowed_client_types`, `scope` | Credential authorization constraints, not session identities. |
| `reference_client_options` | Actual shared `BrokerClient` transport keys: `url`, `tokenFile`, `insecureDevelopment`; the connector still supplies its own durable `inbox`. |

The installed connector must implement the [v1 protocol](spec-v1.md) /
[OpenAPI contract](../openapi.json): authenticated registration of its actual
session identity, background heartbeat, discovery/send/status and durable-inbox
claim/ACK. A generic HTTP URL is not itself an MCP server; this broker has no
remote MCP endpoint. The optional reference MCP facade is a separate adapter.

`127.0.0.1` is reachable only from the **same network namespace**. Token-file paths
must be readable by the client process under its existing permissions. If either
condition is false, do not expose the listener, loosen permissions or copy secrets
into a conversation to make it work. A different network deployment needs its
own TLS/auth configuration; this command deliberately does not do that.

Once your connectors register, their own discovery tool should show two distinct
client UUIDs. Send a unique text marker A → B, inspect B's actual receive result,
and reply B → A. `delivered` means the recipient's **durable adapter inbox**, not
model reading or automatic injection. Installed plugins' native receiving and
approval behavior remains a separate integration check.

## Stop and cleanup

Press **Ctrl+C in the broker terminal** and wait for `Local broker stopped.` This
stops the broker only; it does not close your existing CLI sessions. No service or
autostart was installed. Private broker state/token files remain for inspection.
After the broker has stopped and clients no longer need these files, inspect and
remove only the printed disposable directory:

```sh
lab='/exact/printed/broker-local.XXXXXXXX'
test -f "$lab/state/LOCAL-BROKER.json" && ls -ld -- "$lab"
# After checking the exact path and stopping use of this lab:
test -f "$lab/state/LOCAL-BROKER.json" && rm -r -- "$lab"
```

A failed preparation may leave only its own partial private directory; inspect it
before removal. Never delete an existing client inbox or unrelated checkout.

## Why the earlier Claude launcher could be silent

The old optional new-session script evaluated `claude_binary=$(command -v claude)`
under `set -e` **before its first progress message**. An isolated reproduction with
working prerequisite stubs and no `claude` executable exited 1 with empty stdout
and stderr. The startup diagnostic reports the broker-only
command instead. This reproduces a concrete failure path; it does not claim to
have inspected the user's computer or proved every possible cause there.
