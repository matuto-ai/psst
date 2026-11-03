# Psst branding and technical-name continuity

Psst is the public name of **AI Agent Message Broker**. Its purpose remains an
authenticated recipient registry and durable opaque-message delivery, not task or
conversation orchestration. `delivered` means durable adapter-inbox storage, not
model processing, a reply or human approval.

This inventory describes source configuration, not registry availability. The
historical image reference below is retained for existing installations; this
change neither pulls nor republishes it. Current candidate images may be used
only after their operator-published release workflow succeeds. No new alias,
registry redirect or deprecation deadline is introduced.

## Reference inventory

| Surface | Current source or historical reference | Classification and action |
| --- | --- | --- |
| Public README/docs name, package description, OCI title | Psst | Display-only; use Psst and explain the former name. |
| Private package identifier | `ai-agent-msg-broker`, `private: true` in package.json | Retained compatibility identifier, not a newly published npm package. |
| Repository and OCI source label | `https://github.com/matuto-ai/psst` | Current source location already adopted; no repository move in this change. |
| Historical repository/image namespace | `brunoorsolon/ai-agent-msg-broker` | Historical references and version/digest pins remain meaningful; do not depend on an HTTP redirect for a registry pull. |
| Current image namespace | `ghcr.io/matuto-ai/psst` | Existing release-plan target; package version is a source candidate until publication succeeds. |
| Historical image | `ghcr.io/brunoorsolon/ai-agent-msg-broker:0.1.0` | Preserve published artifacts and operator pins; do not retag, overwrite or delete. Availability is not newly verified by this document. |
| Release and verification workflows | `.github/workflows/release.yml`, `verify.yaml`; `scripts/release-plan.mjs` | Retained. User-published Release gates image publication; image path derives from the selected repository. A future repository move therefore needs explicit registry planning. |
| Compose service and volume key | `broker`, `broker-data` | Retained. Actual volume name is Compose-project-dependent; preserve the project and mounted volume, not just the YAML key. |
| Docker examples | container `ai-agent-msg-broker`, volume `ai-agent-msg-broker-data` | Retained examples. These are not necessarily the same volume as a Compose installation. |
| Runtime data/configuration paths | `/data/broker.sqlite`, `/run/broker/config.json`, `/run/broker/credentials.json` | Retained. Preserve mounts, ownership and private-file permissions. |
| Existing configuration variables | `BROKER_CONFIG_FILE`, `BROKER_IMAGE`, `BROKER_BIND_IP`, `BROKER_PORT` | Retained without aliases or changed precedence. Host-port choice is independent of branding. |
| Admin and test variables | `PSST_ADMIN_PASSWORD`, `PSST_PUBLIC_ORIGIN`, `PSST_MATRIX_SOURCES`; lab output `BROKER_URL` | Retained; no secret, URL or CI-interface migration. |
| Local build/test image names | `localhost/ai-agent-msg-broker:reviewed`, `localhost/ai-agent-msg-broker-test:reviewed` | Retained development identifiers; not a claim about published images. |
| Connector references | `integration/connector-matrix.test.mjs`, `cooperative-transport` in `.github/workflows/verify.yaml`, vendored SDK pins in connector repositories | Independently versioned. Retain immutable source pins and installed package/config names until that connector's tested migration explicitly replaces them. |
| Protocol and identity | `/v1` routes, client types, session UUIDs, ownership/epochs, envelopes, adapter journals | Not branding. No change, regeneration, mailbox move or credential re-enrollment. |

The current matrix retains the reviewed `matuto-ai/pi-broker-connector`,
`matuto-ai/claude-code-broker-connector`, `matuto-ai/opencode-broker-connector`
and `matuto-ai/antigravity-broker-connector` checkout references and immutable
commit pins. These are source configuration entries, not a claim that repository
redirects or newly named packages were verified here. A connector reference refresh
must verify its destination and packaged behavior together, not just replace text.

The inventory is intentionally not a global search-and-replace specification.
Historical release tests, archived probes and immutable source references may
retain the old name. Connector-specific installation/configuration migrations
belong in their repositories; a broker display change does not authorize them.

## Existing v0.1.0 instructions

The old pull/run syntax is retained, not redirected to a new image. For an
existing installation, keep its known-good version or digest and exact existing
mounts/configuration; do not run a second broker against the same database.
The following is the historical fresh-install example, **not** an upgrade command
and not confirmation that the registry currently serves the tag:

```sh
docker pull ghcr.io/brunoorsolon/ai-agent-msg-broker:0.1.0
docker run -d --name ai-agent-msg-broker --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8787:8787 \
  -v ai-agent-msg-broker-data:/data \
  ghcr.io/brunoorsolon/ai-agent-msg-broker:0.1.0
```

Keep the original version's authentication and HTTPS/proxy setup instructions.
Do not assume newer admin, enrollment or retention features exist in v0.1.0.
For an existing digest-pinned installation, use that exact recorded digest;
a display-name edit supplies neither a replacement digest nor an upgrade.

## Staged migration and operator verification

1. **Display-only stage (this change).** Update prose, package description and OCI
   title. Keep all compatibility-sensitive identifiers in the inventory. No
   deployment, repository move, artifact deletion or new image publication.
2. **Record before any technical migration.** Record the running image digest,
   release version, exact Compose project name, actual volume/bind paths,
   configuration mounts, endpoint/port and connector versions/pins. Keep secrets
   private. Verify a private, consistent backup and its restore procedure with
   the matching old binary. Stop clients/writers for the maintenance window.
3. **Verify a proposed target separately.** Check its successfully published
   release, immutable digest, supported schema upgrade and connector contract.
   If an image/package/repository rename is proposed, document both old and new
   identifiers and an explicit support/deprecation window before changing any
   consumer. No future alias is promised here. Preserve old release artifacts;
   test clean installation and upgrade with fixture data in CI before rollout.
4. **Retain the actual installation.** Change only the approved image reference
   while preserving the recorded configuration and actual data mount. Keep the
   existing Compose project (`-p`/`COMPOSE_PROJECT_NAME` if used). Renaming the
   checkout directory can change Compose's default project name and silently
   select a new empty volume. Do not rename a project/volume as a branding step.
   Do not replace an existing Compose volume with the differently named Docker
   example volume. Do not use `docker compose down -v` or delete adapter journals.
5. **Verify before resuming normal use.** Inspect the actual image and mounts;
   confirm health/readiness with the expected enrollment state, authenticated
   discovery, unchanged session ownership/identities, retained messages/receipts
   and exact connector resume behavior. Test TLS/proxy trust and the chosen host
   port independently. A healthy empty broker is not proof of data continuity.

## Rollback boundaries

A display-only change requires no data conversion. For an image change that did
not modify the on-disk schema, stop the new process and restore the recorded
image/config/mount selection only if that version supports the stored state.
Never run two broker versions against one writable volume.

A version upgrade is a separate operation: **never open an upgraded database
with an older binary**. The current schema-5 migration cannot be undone by merely
changing the image name. Restore the matching pre-upgrade backup offline using
the documented [operations procedure](operations.md) and
[retention/restore restrictions](presence.md#optional-ephemeral-session-retention-registration-v2).
An older backup rolls back epochs, receipts and idempotency: keep clients stopped
and follow the documented fresh-identity/journal recovery procedure rather than
replaying old pending operations. This is disaster recovery, not a branding
requirement or transparent rollback. Do not delete the current volume or journals
to make a failed migration appear successful.

## Verification boundaries

Focused branding tests assert display labels, retained package/config/storage
identifiers, historical release-plan support and the documentation's continuity
and rollback constraints. Existing container/Compose, persistence, migration,
backup and connector-matrix CI remain required. Source tests do not prove that a
historical registry tag is reachable or that an operator's deployment upgraded.
No new aliases are shipped, so no alias-installation success is claimed.
