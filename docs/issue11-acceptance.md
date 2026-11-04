# Packaging, recovery and compatibility acceptance

This ledger maps the original [issue #11](https://github.com/matuto-ai/psst/issues/11)
requirements to the integrated implementation. It reuses #45's current packed
cohort and #46's native Pi lifecycle coverage. It does not release or deploy.

## Original acceptance

| Original requirement | Implementation and retained check | Remaining dependency |
| --- | --- | --- |
| Nonroot/rootless package, explicit bindings, persistent private data, read-only secrets and graceful shutdown | Digest-pinned Containerfile, Compose, direct-TLS config, inactive Quadlet template; Docker and Ubuntu rootless Podman jobs | Actual Fedora SELinux/user-systemd/Quadlet execution |
| Enrollment/revoke/rotate, limits, health/readiness, redacted diagnostics, backup/restore and migrations | Operations/enrollment/approval guides, SQLite-safe backup API, security/retention/process tests and real prior-entrypoint upgrade below | No user deployment is implied |
| Pending mail, epochs, dedupe/receipts, local pending content and uncertainty survive recovery | Actual old schema2 process → current schema5; independent online snapshot restore; four type-family local journals; current four-package broker snapshot recovery | Native final-hop crash windows remain scoped per connector |
| Separate containers with no shared PID/filesystem dependency or inbound callback | Eight distinct reference adapter containers plus TLS broker, private internal network, separate journals/credentials, no published ports | Two distinct physical LAN hosts |
| Directed routes, concurrent exchange, offline recipient, model switch and restart | All 16 container reference routes, four offline routes, three concurrent routes, model metadata switch, broker SIGKILL and adapter recreation; 43 current-package deliveries | Full 16-route pinned native-host safety matrix and actual host model switching |
| Non-interruption, human prompts, source labels in actual model input, zero-token heartbeat and crash windows | Official Pi lifecycle and connector-specific official-host evidence; generic safety tests remain required | Integrated native evidence cannot be inferred from reference or synthetic-host tests |
| Truthful partial broker release before the four-harness milestone | Native matrix cells remain uncertified until complete evidence exists | Keep #11 open for original native/external gates |
| Delivered means durable destination inbox acceptance | Operations/delivery contract and explicit pending/no-native-receipt assertions | No reading, answering or completion claim |

Paid or vendor-authenticated model accounts are **not an added universal gate**.
A real pinned host using a controlled local provider can prove its observed
native input/lifecycle behavior. Retain that boundary and the actual acceptance
cases. A synthetic host API is not an official-host run. Publication, a vendor
account run and user deployment are separate observations, not new prerequisites.

## Real upgrade and independent restore

`integration/upgrade-recovery.test.mjs` starts the actual prior entrypoint at
`bd2dd445de4bf3105f20caafb471f280bf981b63`, not a hand-built schema imitation.
That configuration creates schema2. Five identities and 20 messages establish,
for each type family, consumed, native-uncertain, delivered-but-pending, claimed
and queued states. Native receipts here are explicitly synthetic test receipts.

The supported SQLite backup API snapshots the live broker and local journals,
including committed WAL data. After SIGKILL, the current entrypoint upgrades the
original. A separate run restores untouched snapshots into new private directories
and upgrades those independently. Both paths verify:

- Old epochs are fenced; the same five identities reconnect.
- Pending payloads, send IDs/sequences, receipts and retry keys survive.
- Four inboxes retain exact envelopes, consumed receipts and pending items.
- Interrupted native injection becomes `uncertain`, never automatically retried.
- A lost send response remains unknown until exact-key reconciliation.
- A later negative ACK cannot erase an earlier unconfirmed transport attempt.
- The automatic pre-migration snapshot retains the actual original schema.
- Backup files stay unchanged; no stale WAL or owner sidecars are copied.

With pinned Node 24.19.0 and the exact clean prior checkout:

```sh
PSST_PREVIOUS_BROKER_SOURCE=/checkouts/prior-broker \
  node --test integration/upgrade-recovery.test.mjs
```

The required local-tests job checks out that immutable revision. Separately, the
current packed cohort snapshots its live TLS broker with four actual connector
packages holding delivered-but-native-pending inbox rows. It restores immediately
at that recovery point and lets each connector reconcile its own fenced epoch,
without editing any journal or identity. Held synthetic native boundaries remain
held until explicitly released.

## Isolated same-host containers

```sh
docker build --target runtime -f Containerfile -t localhost/psst-topology:reviewed .
node scripts/container-topology.mjs docker localhost/psst-topology:reviewed
# Or build/run the same source using an existing rootless Podman installation.
```

The harness creates uniquely named disposable containers, an internal network and
private temporary data. It never changes a router, firewall, host security setting,
account or production configuration. Every agent has its own credential mount,
journal and PID namespace and opens no listener. Messages travel only over
verified authenticated HTTPS. Root filesystems and secret mounts are read-only,
capabilities are dropped and no ports are published.

All 12 cross-family and four distinct-session same-family routes assert exact
sender, recipient, body and untrusted-agent provenance. Delivered items remain
pending with no fabricated native receipt. The test removes/recreates recipients,
queues four offline messages, kills/restarts the broker, verifies persistent
identities/journals/dedupe, and runs three concurrent routes. Docker kills and
restarts the actual broker container. Podman kills the actual production broker
child and verifies a new PID from a test-only supervisor that retains the container
network namespace. Recipient containers are independently recreated on both engines.

**Observed hosted Podman limitation:** surviving peers intermittently lost DNS
or fresh TLS connectivity under concurrent container provisioning/removal, including
both container restart and process-only restart scenarios. Recreated peers could
connect. Correct static DNS/IP did not resolve every case, so namespace replacement
alone is not an established root cause. The fixture serializes rootless container
lifecycle operations, supplies container-local host mappings for the unchanged
private broker IP, and verifies fresh name resolution/TLS before and after
recovery and recipient recreation; actual message exchange remains concurrent. No host routing,
DNS or security setting is changed. Two independent runs per engine are required.
The Podman check proves process/storage recovery only, not full container-runtime
network recovery. Model metadata
changes preserve identity in this reference topology. The separate actual Pi
probe verifies native model selection with identity continuity, source labels
in provider input, and an idle heartbeat renewal with zero provider calls. Containers are
removed before their bind-mounted data is discarded.

The two isolated-topology jobs are required by the fail-closed aggregate. Summaries
explicitly report nativeHostCertification=false and twoPhysicalHosts=false. The
local probe test validates its control protocol and TLS, not container isolation.
Actual container evidence comes from the engine runs.

A bounded [full rootless container-restart probe](https://github.com/matuto-ai/psst/actions/runs/41746670465)
used serial lifecycle operations, an explicitly reserved unchanged IP and the
fresh surviving-peer check **before** recipient recreation. Name resolution still
returned the correct address, but the new TLS request timed out. This is retained
failed evidence, not a passing native/package requirement. The passing required
Podman lane remains process/storage recovery; full runtime/network recovery needs
an independently qualified engine/host setup. The exact failing source is retained
at commit `8a7bbc994b1a39077cc6ab1cc144bd6cbeb1b9c2`.

## Explicit unmerged candidate cohort

A separate required `candidate-transport` lane reruns the same 43-delivery package
transport, pending-journal, snapshot and recovery suite against these immutable PR
heads. The existing merged-main and legacy cohorts stay unchanged.

| Candidate dependency | Exact revision |
| --- | --- |
| [Pi #28](https://github.com/matuto-ai/pi-psst-connector/pull/28) | `95170f56e025b17bff49b6d4d3bbb9897b9256b3` |
| [Claude #28](https://github.com/matuto-ai/claude-psst-connector/pull/28) | `6a8d2f215913f8250a114a9802411eea2595a0e0` |
| [Antigravity #24](https://github.com/matuto-ai/antigravity-psst-connector/pull/24) | `3bf54ee24703bb38ac1764184e17d50615c67c23` |
| [OpenCode #20](https://github.com/matuto-ai/opencode-psst-connector/pull/20) | `c14bc10db807e3ba0b3d6594d5b1c3b8c118f31f` |

These are source candidates, not released or approved packages. In particular,
Antigravity's actual automatic-arrival gate is still blocked by its native
permission prompt. This synthetic-boundary compatibility lane neither interacts
with that prompt nor substitutes for its required real-host permission and runtime
evidence. Each source PR retains its own gates; a passing transport lane does not
certify automatic native delivery, permit a release or close the original issues.

## Exact remaining external dependencies

No connected computer or saved execution environment was available during this
candidate's preparation. The cloud executor has neither Docker nor Podman;
hosted CI runs those checks. Remaining original environment-dependent checks:

1. **Fedora:** an existing rootless Podman setup with SELinux enforcing and a
   functioning user systemd session. Validate the inactive Quadlet template in a
   dedicated disposable directory: `:Z` labels, keep-id ownership, read-only
   mounts, TLS, graceful stop and restart. Installing/enabling a service,
   autostart/linger or changing security settings needs separate authorization.
2. **Two-host LAN:** two distinct already configured hosts, an explicitly selected
   private bind address, trusted CA/hostname and authorized test credentials.
   Exercise bidirectional transport, offline mail, restart and backup recovery.
   No shared PID state/SQLite storage, inbound agent listener, public tunnel,
   Internet ingress, router change or disabled TLS verification is needed.
3. **Integrated native matrix:** two sessions per pinned native family and chosen
   automatic modes, retained source-labeled model input, human/busy/permission/
   abort safety, zero-token heartbeat, model switch, offline/restart and ambiguous
   final-hop recovery. Reuse individual official-host results, but do not infer
   full directed native coverage from labels or synthetic receipts.

Do not close #11 or certify the four-harness milestone while its original gates
remain unverified. The package, recovery and same-host topology candidate remains
independently reviewable; merging it is not deployment.
