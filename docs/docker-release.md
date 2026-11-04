# Docker image and release

The normal server package is a **Linux/amd64** image, with Node 24.19.0 and SQLite 3.53.3 inside it. No host Node installation, client launcher, generated certificate or generated credential is needed to start it.

## 0.7.0 source candidate

This branch prepares source and aligned version metadata only. It does **not**
publish a tag, GitHub Release or image, and does not deploy a broker. Do not pull
the version below until its release workflow has actually succeeded. Review the
[upgrade and compatibility notes](../CHANGELOG.md#070-upgrade-notes)
before updating an existing installation.

The 0.7.0 candidate includes the administration favicon, configurable finite
authorization lifetime and bounded revoked-list visibility with durable
revocation records. It preserves existing grants and receipts without automatic
renewal. See [authorization settings and distinct clocks](approval-operator.md#configure-authorization-lifetime).

The registration-v2 support and optional disconnected-session retention from
0.6.0 remain unchanged. Cleanup remains **disabled by default** and legacy registration stays
available unless the operator explicitly enables the persistent v2 floor. Updating
the image does not activate either setting. Keep existing authorization and volumes;
no re-enrollment is required merely to upgrade the broker.

For upgrades from pre-0.6.0, database schema advances to **5**. Existing 0.6.0
databases stay at schema 5 with additive revocation timestamp columns. Verify a
private backup before upgrading; startup
also creates an integrity-checked private snapshot before migrating existing storage.
Do not open the upgraded database with an older binary. See the
[retention rollout, migration and restore constraints](presence.md#optional-ephemeral-session-retention-registration-v2).
Enable retention only after all native connectors have been updated and their
recovery tested, with a separate operator decision. CI does not prove installation
or native-agent acceptance in the operator's environment.

## Pull and run

**The image is not published by a source-code push.** Use these commands after GitHub Release `v0.7.0` has completed its Release image workflow successfully. Versioned image: `ghcr.io/matuto-ai/psst:0.7.0`.

```sh
docker pull ghcr.io/matuto-ai/psst:0.7.0
docker run -d --name ai-agent-msg-broker --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8787:8787 \
  -v ai-agent-msg-broker-data:/data \
  ghcr.io/matuto-ai/psst:0.7.0
curl --fail --show-error --max-time 5 http://127.0.0.1:8787/healthz
```

Expected: `{"status":"ok"}`. The container listens on **HTTP port 8787**; the Docker mapping above exposes that upstream only on host loopback. `/data` is persistent broker-local SQLite storage and must not be shared with a second broker. `docker stop ai-agent-msg-broker` stops it; `docker rm ai-agent-msg-broker` removes the stopped container **without deleting the named data volume**.

The shipped configuration deliberately has **no enrolled credentials**: `/healthz` returns 200, `/readyz` returns 503, and every `/v1` API request returns 401. This is a usable connectivity bootstrap, not a messaging authorization bypass. The image healthcheck checks liveness, not readiness, so this initial state does not make it unhealthy. No clients are automatically registered.

After the operator's existing HTTPS proxy is connected, `https://YOUR_BROKER_HOST/healthz` should return the same body using ordinary verified certificate trust. Proxy, DNS, certificates, firewall and network selection are operator-owned; this repository does not configure them. The backend is plaintext and **must stay on an isolated trusted same-host proxy path, not be exposed directly to the LAN or Internet**. Container-network peers able to reach it are part of that trust boundary. Do not use host networking, privileged mode or disabled certificate verification to make it work.

Docker publishes on all host interfaces if the host IP is omitted. Keep a deliberate binding or private proxy network; the example uses loopback. Use a supported Docker version (28+ for the documented localhost-publishing isolation fix). See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).

### Compose alternative

The repository's `compose.yaml` provides the same image, private host-port default and persistent named volume:

```sh
docker compose up -d
docker compose logs --tail 30 broker
```

For approval-enabled installations, `PSST_AUTHORIZATION_DAYS` selects 1–3650 whole
days (default 90) for new grants only. Existing grants are not extended. See
[approval configuration](approval-operator.md#configure-authorization-lifetime).

Configurable environment values: `BROKER_IMAGE` (versioned image or digest), `BROKER_BIND_IP` (default `127.0.0.1`), `BROKER_PORT` (default `8787`, **host-side** port). For example `BROKER_PORT=8788 docker compose up -d` maps host8788 to container8787. Changing a host binding is an explicit operator network decision. `docker compose down` retains data; do **not** add `-v` unless deliberately deleting the broker database.

### Broker configuration later

The built-in `/run/broker/config.json` is [`deploy/config.proxy-container.example.json`](../deploy/config.proxy-container.example.json): database `/data/broker.sqlite`, credentials `/run/broker/credentials.json`, listen `0.0.0.0:8787`, explicit `proxy_transport: true`. The wildcard is **inside the container**, allowing normal Docker port forwarding. This flag explicitly asserts that an external trusted proxy terminates HTTPS; it does not trust forwarded identity/address headers or exempt API authentication. Raw host startup still requires TLS or an explicit plaintext mode.

To enroll adapters later, mount a dedicated private directory containing `config.json` and `credentials.json` at `/run/broker:ro`; follow [credential and configuration requirements](operations.md#private-operator-configuration). The runtime UID/GID is **1000:1000**; files must be readable by that process and meet the private-file checks. Do not mount a whole home directory or put token secrets in the image, Compose file or command line. `BROKER_CONFIG_FILE` can select another mounted config path. The shipped HTTP healthcheck calls `/healthz`. With a custom direct-TLS config it performs bounded TCP listener liveness only—not a certificate trust, API readiness or end-to-end TLS check; real clients still verify TLS normally.

## Publish a release — operator action

1. Review and merge the release preparation PR. Select that exact reviewed commit for the release.
2. Keep `package.json` version and release tag aligned: current version `0.7.0` requires tag **`v0.7.0`**. For another version, update `package.json`, test and commit it first.
3. In GitHub, publish the release at the reviewed commit. Publishing, not merely saving a draft or pushing a tag, triggers **Release image**.
4. The workflow runs syntax checks and the focused unit suite against the immutable release event commit. Only after success does it build and push the Linux/amd64 image using the repository's short-lived `GITHUB_TOKEN` with `packages: write`. No registry secret setup is required for this workflow.
5. Stable releases publish `:VERSION` and `:latest`; prereleases publish only `:VERSION`. The run summary records pull command and image digest. Prefer a version/digest for deployment. Published version tags should not be reused for different source.

GHCR's first package may initially be private even for a public repository. The operator must choose package visibility/access if anonymous `docker pull` is wanted; the workflow does not silently change it. See [GitHub Container registry authentication and visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

**CI** runs on every push and pull request and never publishes. **Release image** runs on `release: published`; its manual action is a **unit-verification-only dry run** with no registry login, package write or push. No workflow creates a release/tag or deploys a server. The manual action becomes selectable once its workflow exists on the default branch. Release behavior follows [GitHub's release event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

The workflows are a small adaptation of the operator-supplied [Forge Desk release](https://github.com/brunoorsolon/forge-desk/blob/main/.github/workflows/release.yml) and [CI](https://github.com/brunoorsolon/forge-desk/blob/main/.github/workflows/ci.yml), not a copy of its application/matrix pipeline. Registry publication requires a published release and a successful gated workflow.

## Build before a release exists

```sh
docker build --target runtime -f Containerfile -t broker-runtime:local .
# Use broker-runtime:local in the docker run command above.
```

CI does not build or launch containers. The release workflow builds the runtime image after unit verification; connectivity, proxy configuration, persistence across a real process restart and native behavior are not certified by those tests. Verify the chosen deployment separately.

## Enroll native clients after the connectivity check

Once HTTPS health succeeds from each client sandbox, use the normal
[native URL-only setup and approval flow](approval-operator.md). Install a
compatible native connector, explicitly open its setup, and enter the broker's
HTTPS URL. In the broker's **Approvals** page, an administrator matches the request
ID and client type and explicitly approves or denies that installation. The
connector saves its private authorization locally for later sessions; no manual
credential file or bundle transfer is part of this normal flow. Merely installing
a connector or knowing the URL never creates messaging authorization.

The [offline initial-enrollment guide](enrollment.md) remains an **optional,
advanced legacy path**, not a prerequisite for native URL-only setup. It stages
separate credentials/bundles for deliberately selected legacy integrations;
creating and activating them still requires an explicit operator decision. Keep
existing working authorization and persistent client state when upgrading.

## Names and existing installations

Psst was formerly AI Agent Message Broker. Existing package, container, volume
and environment names are intentionally retained. Before changing an image path,
Compose project or installation directory, follow the [inventory, continuity and
rollback plan](branding-migration.md). A name change is not a database migration.

