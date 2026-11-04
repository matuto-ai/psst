# Native Pi-to-Pi safety coverage

`integration/native-pi-matrix.test.mjs` adds actual native-input evidence to the
[issue #11 acceptance ledger](issue11-acceptance.md). It is a **Pi-to-Pi subset**,
not completion of a compatibility cell or the full 16-route safety matrix.

## Pinned execution boundary

- Official Pi **1.4.0** runs as two separate CLI processes in Linux PTYs.
- The production connector is packed from
  [`5f070a992e43502c7647759fa93b3eb926ffef5b`](https://github.com/matuto-ai/pi-psst-connector/tree/5f070a992e43502c7647759fa93b3eb926ffef5b),
  rather than taken from an unverified npm release.
- The broker under test uses real SQLite storage and verified loopback TLS.
  Installation approval and credentials belong only to the disposable fixture.
- Pi's official local faux provider supplies deterministic tool requests and
  records actual provider input. It is not a vendor-authenticated model run.
- Sessions share the approved installation but have distinct native histories,
  broker identities and durable inboxes. This is not container or two-host proof.

No synthetic host API, direct connector tool invocation, journal edit, terminal
injection by the connector, or fabricated native receipt substitutes for delivery.
The test controller types deliberate human actions. Its observer records native
state and controls only its own local provider response.

## Required observations

Five messages exercise these cases:

1. A sends to B and B sends to A through actual model-requested `broker_send`.
   Each send has one correlated native tool result. Each recipient has one native
   history entry, a durable native receipt, and actual provider input carrying
   the message ID, body and sender's untrusted-agent source label.
2. A message arrives while A's local provider is actively waiting. Transport
   delivery becomes durable pending mail, but no native message or extra model
   call appears and the running provider is not aborted. Releasing that ordinary
   provider turn allows one automatic delivery.
3. An unfinished human draft remains unchanged while another delivered message
   stays pending. Clearing the draft through the actual TUI allows one delivery.
4. A human Escape abort pauses automatic injection. Mail stays pending across
   actual `/model faux-2`; selecting a model does not resume the aborted task or
   call the provider. Explicit human continuation then delivers the mail to the
   newly selected provider model, preserving native session and broker identity.

Final checks re-read every native history/inbox for duplicate delivery, confirm
installation reuse, and reap every owned process and process group before
discarding fixture data. Send acceptance, native receipt and provider-context
observation remain separate assertions.

## Reproduction and retained evidence

Use Node **24.19.0**, Python 3, OpenSSL, npm and tar. Install the pinned Pi host
and connector dependencies with lifecycle scripts ignored in isolated fixture
directories, then run:

```sh
PI_TEST_INSTALL=/absolute/path/to/pi-host \
PSST_NATIVE_PI_SOURCE=/absolute/path/to/pinned-pi-connector \
PSST_NATIVE_MATRIX_EVIDENCE=/absolute/path/to/native-pi-matrix.json \
  node --test integration/native-pi-matrix.test.mjs
```

The `native-pi-matrix` workflow job is required by the fail-closed aggregate and
runs independently from the existing lifecycle/presence lane. Missing inputs
fail rather than skip. Each changed candidate requires its own exact-head CI.

The JSON report retains fixture labels, stage outcomes, package integrity and
cleanup verification. It does not publish credentials, host paths, raw terminal
output, conversation content or native identifiers. Partial evidence remains
`completed:false` unless every scenario and owned-process cleanup succeeds.

## Remaining original acceptance

This test does not prove the precise crash window between native history
acceptance and committing its local receipt. There is no supported deterministic
observation barrier there; the fixture does not modify production code to create
one. Existing process-crash, offline-recovery, permission and zero-token heartbeat
tests retain their own separate scope.

The complete four-family native safety matrix, including all cross-family routes
and final-hop crash-window evidence, still remains open. Claude's isolated native
probes, OpenCode's actual provider-input proof and Antigravity's native permission
gate cannot be replaced by this Pi result. Actual enforcing-SELinux Fedora with
user-systemd/Quadlet and two distinct physical LAN hosts remain separate required
environments. No release, deployment or issue closure follows from this test.
