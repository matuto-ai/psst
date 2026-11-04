# Operations and reproducible checks

This is a reviewable broker-core/reference runtime, not an installed service. No host networking, firewall rule, real credential, CLI installation, or deployment is created by these examples. Real CLI final-hop support and two-host LAN/Fedora deployment conformance have separate gates in [feasibility.md](feasibility.md).

For the conventional server image, start with [Docker / Compose and release](docker-release.md). The remaining sections cover configuration, direct TLS and optional Podman deployment variants.

## Runtime choice and pin

- Tested runtime: **Node.js 24.19.0**, using the bundled `node:sqlite` SQLite **3.53.3**.
- No third-party runtime dependencies, npm install scripts, ORM, web framework, or SQLite native addon are required. The repository uses ECMAScript modules, native HTTP(S), crypto, SQLite and `node:test`.
- A single synchronous SQLite writer serializes short transactions and recipient sequence allocation. Long polls yield between bounded storage checks; they do not hold transactions while waiting for a model or human.
- The exact [Node 24.19.0 SQLite documentation](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html) marks this API **Stability 1.2: release candidate**. Pin the runtime and rerun the full suite before upgrading; availability without a warning is not a stability guarantee.

Check the actual binary, not merely a package manager's configured version:

```sh
node --version
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); console.log(db.prepare('SELECT sqlite_version() AS sqlite').get()); db.close()"
npm run check
npm test
node scripts/container-smoke.mjs
```

No global Node upgrade is needed: an isolated, reviewed container/runtime is preferred if the host uses another version. `npm run check` is a JavaScript syntax check, **not a TypeScript type-check**. The smoke script starts the actual entrypoint as nonroot using isolated disposable test credentials, checks minimal readiness/auth, and removes its fixture directory. It is not a real LAN or CLI integration test.

## Private operator configuration

Set `BROKER_CONFIG_FILE` to a private JSON file. Do not put tokens in CLI arguments, command history, prompts, URLs, logs, or committed config. Configuration supports:

| Field | Meaning |
| --- | --- |
| `database` | Absolute local database path on dedicated persistent storage |
| `credential_file` | Private regular file containing enrolled verifier records |
| `host`, `port` | Explicit bind; default loopback and 8787 |
| `insecure_development` | Explicit plaintext development exception; loopback only; authentication remains mandatory |
| `proxy_loopback` | Explicit same-host TLS-proxy upstream exception; loopback only; authentication remains mandatory |
| `proxy_transport` | Explicit isolated same-host container upstream for an external HTTPS proxy; permits container-interface HTTP, never disables API auth or trusts forwarded identity |
| `tls.certFile`, `tls.keyFile` | Existing TLS certificate chain and key files for direct HTTPS |
| `limits` | Finite storage, rate, lease and protocol policy overrides; unknown keys fail startup |

Start with one of `deploy/config.*.example.json`; replace paths in a **private copy**, never in the repository. The `0.0.0.0` listener in the direct-TLS container template is inside its isolated network namespace; host publication must still select one explicit LAN interface. The development and `proxy_loopback` templates bind loopback. The container proxy template explicitly binds its container interface; keep that plaintext backend on an isolated trusted same-host proxy path. Never publish it directly to the LAN/Internet. Transport modes are mutually exclusive and must be booleans.

The shipped empty verifier file `{ "credentials": [] }` is valid and denies every API request. It allows liveness200 but readiness503 until active credentials exist; it creates no identity or secret. Removing all credentials also revokes existing leases/polls. A populated broker verifier file has this shape (the placeholder below intentionally fails validation):

```json
{
  "credentials": [
    {
      "credential_id": "unique-rotation-entry",
      "token_sha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256",
      "principal_id": "enrolled-owner",
      "adapter_id": "enrolled-installation",
      "client_types": ["pi"],
      "scopes": ["explicit-shared-scope"],
      "revoked": false
    }
  ]
}
```

Provision real credentials separately under operator control. A token must contain high-entropy random material (at least 32 random bytes encoded base64url); the API accepts 43–256 base64url characters. Each adapter gets its own token secret file; the broker gets only its SHA-256 verifier. A verifier is suitable here because the token is high entropy, **not** a user-chosen password. The operator may supply an RFC 3339 `expires_at`. This repository does not provision a credential for ongoing access.

Private directories should be mode `0700`; verifier/token/key files `0600`, owned by the process user (root-owned verifier files are also permitted). The verifier reader rejects symlinks, nonregular files, excessive bytes, broad permissions and unexpected ownership. Mount the private configuration directory read-only rather than a single file if atomic verifier replacement must be visible through a container bind mount. Keep that directory dedicated to the broker, not the whole home directory. The reference client prefers a token file; an environment fallback, where explicitly supported by an adapter, has process-environment exposure risks and must never become a model tool argument.

For rotation, add a new `credential_id`/verifier with the **same principal, adapter, types and scopes**, allow only a short operator-chosen overlap, update the adapter's secret file, then revoke/remove the old entry. Keep one known-good entry while rotating. Removing/revoking/expiring an entry is rechecked for new operations and long polls; affected leases must reconnect. Scope/type/ownership changes are authorization changes, not mutable display metadata. Invalid auth configuration makes readiness fail rather than silently retaining a usable stale credential set.

## TLS and network placement

Use an operator-provided certificate for the actual broker hostname, with clients trusting its issuing CA. Direct TLS requires TLS 1.2 or newer. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized:false`, or `curl -k` as a workaround. Private CA clients may use a read-only CA file through `NODE_EXTRA_CA_CERTS`; certificate trust and hostname checks both remain enabled.

An existing host TLS proxy can terminate HTTPS and forward to `127.0.0.1:8787` using the proxy-loopback config **on that same host/network namespace**. The proxy must preserve Authorization and allow a 30-second long-poll response plus margin. It must not rewrite every caller into a shared credential. Do not publish the backend separately. A container's loopback is not the host's loopback. The explicit `proxy_transport` mode permits ordinary Docker networking on a dedicated trusted same-host container/proxy path; the [server image guide](docker-release.md) documents its boundary. No forwarded header grants identity, client address or HTTPS authority. A remote proxy-to-backend hop needs verified TLS too.

Agent transport does not use CORS/browser sessions or OAuth. The separate admin UI supports explicit browser approval; it does not make a browser an agent transport. There is no public tunnel, automatic DNS/firewall/router change, or inbound adapter callback. Each adapter has a configured reachable broker HTTPS URL. `localhost` inside one agent container is not the host or another container. SQLite files stay on broker-local disk; messages cross the network through HTTPS only.

## Container review and rootless Podman example

`Containerfile` has a full official Node test stage (including the `openssl` test command) and a slim nonroot runtime stage. Both pin Node 24.19.0 and official immutable image digests resolved in the recorded CI run; the build also checks SQLite 3.53.3. Review the selected architecture and rerun the full suite before deliberately updating those pins. No registry image is pushed by CI.

```sh
podman build --target test -f Containerfile -t localhost/ai-agent-msg-broker-test:reviewed .
podman build --target runtime -f Containerfile -t localhost/ai-agent-msg-broker:reviewed .
```

The task's cloud executor had neither Podman nor Docker, so these commands were **not locally run**. The GitHub workflow passed Docker build/test and a nonroot entrypoint smoke, plus an actual **rootless Podman 4.9.3 on Ubuntu 24.04** private-volume/restart smoke. See [exact-commit evidence](verification.md#rootless-podman-ci). The Podman job uses the runner's existing unprivileged setup, never sudo, installation, host-security changes, published ports or real credentials. Fedora SELinux/Quadlet and two-host LAN behavior remain unverified.

After independent review/provisioning, an operator can adapt:

```sh
# PRIVATE_DIR contains reviewed config.json, credentials.json, server.crt and server.key.
# STATE_DIR is an existing dedicated, private local directory owned by this operator.
# LAN_BIND_ADDRESS must be an explicit selected host LAN address, never a wildcard.
podman run --name ai-agent-msg-broker --rm \
  --userns=keep-id --user "$(id -u):$(id -g)" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --volume "${STATE_DIR:?Set private state directory}:/data:Z" \
  --volume "${PRIVATE_DIR:?Set private configuration directory}:/run/broker:ro,Z" \
  --publish "${LAN_BIND_ADDRESS:?Choose explicit LAN bind address}:8787:8787" \
  localhost/ai-agent-msg-broker:reviewed
```

The direct-TLS config must be named `config.json` in the mounted private directory. `:Z` labels only those dedicated directories for Fedora SELinux; never apply it to an entire home directory. The process runs as the operator-mapped nonroot UID, all capabilities dropped, read-only root filesystem, private state writable. This is a template, not a command this implementation executes. Follow the current [Podman run reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html) for the selected installed version.

For direct container-to-container clients on a legacy rootless bridge, retain a
unique, locally administered broker MAC together with its fixed private IP in the
container configuration. Podman4.9.3/Netavark1.4.0 can recreate a new random MAC
while live clients retain the old ARP entry. Use the supported `--mac-address`
option for that private broker endpoint; never change a host NIC MAC or flush
neighbors to mask a failed test. The [recovery acceptance record](issue11-acceptance.md#legacy-rootless-bridge-endpoint-regression)
retains the unmodified failure and the exact topology-specific mitigation. A LAN
client of the published host endpoint follows a different path; this is not a
new requirement to change the host's network configuration.

`deploy/broker.container.example` is a deliberately inactive [Quadlet template](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html). Replace UID/GID, paths and the LAN publish placeholder; review the image and TLS/config mounts before placing a private copy in the rootless user Quadlet directory. Installing/enabling it, selecting autostart/linger, adjusting firewall rules and deploying are separate operator actions. Graceful SIGTERM stops new accepts/claims, terminates long polls, finishes bounded transactions and closes the store.

## Storage, retention, and recovery

Only one broker instance may own a database. A separate SQLite ownership lock releases after process death; a second writer is rejected rather than running a split broker. The database uses WAL, `synchronous=FULL`, foreign keys, bound SQL parameters, schema `user_version`, and local disk. NFS/SMB/CIFS filesystems detected by the runtime are rejected; other shared/unsupported filesystems are still unsupported even if detection cannot recognize them. Do not use shared storage as clustering.

Default disk safety rejects new durable work with less than 64 MiB free or a broker database/WAL/ownership footprint at its 1 GiB budget. Pending mail has per-recipient count/byte caps; request/send/poll limits are finite. Readiness fails when safe durable work is unavailable. The default total disk budget is a backstop, not capacity planning: reserve host/storage headroom outside the volume too. Do not delete pending messages or inbox items to clear pressure.

Retention sweeps are bounded. Terminal receipts/send dedupe remain until both the configured terminal-retention deadline and message TTL plus supported retry window have elapsed. Identity tombstones prevent address reuse. Payloads and local inboxes contain untrusted private text: protect the volume and use host disk encryption where required. Backups can retain data longer than live deletion; set a separate private backup expiration policy. No debug body logging is enabled.

Use the SQLite backup API rather than copying a live `.sqlite` file while ignoring WAL:

```sh
node scripts/backup.mjs /path/to/local/broker.sqlite /path/to/private-backups/new-snapshot.sqlite
```

The destination directory must already be private (`0700`) and operator-owned; the destination must not exist. The script opens the source read-only, creates a `0600` snapshot using the official [SQLite backup API](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html#sqlitebackupsourceDb-path-options), checks integrity, and does not start a second broker or invalidate leases. Existing snapshots are never overwritten. Snapshot attempts may take longer while another connection is writing; coordinate an operational maintenance window if needed.

For restore, stop the broker and all replacement writers, preserve the existing directory for rollback, verify the snapshot in a separate private local directory, and start the same reviewed runtime against that new path. Do not combine a restored database with stale `-wal`/`-shm` files from another database. The ownership sidecar is coordination, not mailbox data; a fresh sidecar belongs to the new restored path. Startup expires all old live leases and requeues unconfirmed claims without erasing uncertainty. Adapters must reconnect with their durable identity/journal before resuming. A broker snapshot does **not** back up adapter-local inbox/deduplication journals; back those up separately with their own SQLite-safe procedure and exact-session lifetime checks.

Schema version 1 is the initial migration; version 2 adds per-claim prior-uncertainty tracking so a definitive negative ACK resolves only its own attempt. Version 3 adds pairing, version 4 approval/admin state, and version 5 session-retention/registration control. The current entrypoint preserves a private pre-migration snapshot before changing older databases. A higher unknown schema fails startup; there is no automatic downgrade. Before a future migration, create and restore-test a snapshot and rerun recovery tests. The [integrated recovery check](issue11-acceptance.md#real-upgrade-and-independent-restore) runs an actual immutable old entrypoint, upgrades its database and independently restores its online snapshot with four local journals. It does not replace a production recovery drill on the chosen disk and container topology.

For coordinated restore, quiesce new work and retain matching broker and adapter-journal recovery points. Restore into new private directories and preserve originals for rollback. Do not reset identities, erase unknown operations or transfer a journal to a different native conversation to force reconnect. A snapshot predating a later attachment can disagree with the current adapter connection identity; that mismatch requires reconciliation, not silently stealing an attachment. Keep unknown final-hop effects unknown until a supported native receipt or operator recovery resolves them.

Protocol overrides may narrow the wire limits, not enlarge them. Retention must remain at least seven days, registration retry records at least 24 hours, and the lease at least three heartbeat intervals. Database directories must be private (0700) and operator-owned. Scope/type reductions in the verifier file fence affected leases and remove former-scope discovery/send access; a reload never silently grants an existing session new scopes.

Docker and Podman have matching `.dockerignore`/`.containerignore` rules. Keep real config, verifiers, tokens, TLS keys, databases and backups outside the checkout/build context regardless; ignore rules are a second layer, not a secret-management system. Exact-code Docker and bounded Ubuntu rootless Podman CI passed; see [recorded CI evidence](verification.md#recorded-ci-evidence) for commit/run links.
