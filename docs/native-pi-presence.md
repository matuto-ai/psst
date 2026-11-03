# Actual Pi lifecycle and presence regression

This regression addresses the reported native-process flow in [issue #29](https://github.com/matuto-ai/psst/issues/29).
It runs official **Pi 1.4.0 CLI processes in PTYs**, the packed production
[Pi connector at `b87e298`](https://github.com/matuto-ai/pi-psst-connector/tree/b87e29851a21be4342f8f4585fc16b1003f6c763),
and the broker revision being tested over verified loopback TLS. One disposable
installation receives real fixture admin approval. A local faux provider runs
inside the official host. No user account, installed plugin, broker, credentials,
permissions or deployment is changed.

## Observations required by the executable test

1. Two simultaneous official native processes share installation authorization,
   but retain distinct native conversations, broker identities and durable inboxes.
   Both receive a message in actual persisted Pi history and local-provider context.
2. Actual `/reload` emits the native shutdown/start lifecycle and reconnects the
   same conversation and broker identity at a newer lease epoch.
3. An actual unfinished TUI draft remains unchanged and holds a delivered local
   inbox item pending. `SIGTERM` ends that native process gracefully. The second
   process exits through actual `/quit`. Both processes are confirmed dead, both
   transport rows become disconnected promptly, and neither identity is closed.
4. Heartbeats stop. Discovery with `connected:false` retains the historical rows
   with explicit state and freshness. Active discovery, including one-row
   pagination, excludes them. A newly opened conversation gets a new identity.
5. Sending to the absent original conversation returns
   `recipient_connected_at_acceptance:false`; its broker receipt stays `queued`.
   Reopening its exact saved native session through the supported `--session`
   option reuses the original identity and preserves the already delivered local
   item. Both that item and queued mail acquire exact durable native receipts and
   one corresponding Pi history entry each.
6. After a confirmed native heartbeat, `SIGKILL` terminates another actual host.
   It emits no graceful shutdown event. Its still-valid lease remains connected
   briefly despite confirmed process death, then expires without further renewal.
   Active pages exclude it after expiry; historical discovery still retains it.
7. A same-conversation restart after that crash receives offline queued mail.
   Actual `/new` in the live restarted process produces a different conversation
   and broker identity, and disconnects the old one without terminally closing it.
8. All transitions reuse the same approved installation. Every owned native
   process and process group is stopped and reaped before fixture storage removal,
   including when an assertion fails.

The observer extension supplies the local provider and records actual host events,
editor observations and provider context. It does not synthesize lifecycle events,
modify the production connector, write inbox state or clear a draft. Test-controlled
lifecycle commands are distinct from peer delivery: the connector never injects
terminal keys to deliver a message.

## Clock and evidence boundary

The fixture negotiates a **2-second heartbeat and 6-second lease**, using the
real wall clock throughout. Expiry is measured from the last confirmed broker
renewal, never from test duration or a conversation about it. No fake clock or
sleep-based inference of process liveness substitutes for the actual process
exit. The unchanged production defaults remain 60 seconds and 180 seconds.
This test does not claim to have waited out the default 180-second policy.

Each observation retains server/observation time, last heartbeat, lease expiry,
explicit presence state and independently checked process liveness. The sanitized
JSON uses fixture labels, not native/client/message IDs, host paths, credentials or
message content. Send acceptance, queued/delivered broker receipt and local/native
receipt are recorded separately. Partial observations are saved as they occur;
`completed:false` is not a pass. Raw terminal/provider capture is private disposable
diagnostic data and is not an uploaded artifact.

The required parallel `native-presence` CI job has a three-minute limit. The
existing aggregate `verify` requires it to succeed alongside every existing job.
Missing official-host or source inputs fail the test rather than silently skipping.
CI retains only `native-presence.json`, including partial evidence on failure.

Local reproduction after installing the pinned official host and the connector's
locked test dependencies:

```sh
PI_TEST_INSTALL=/absolute/path/to/pi-host \
PSST_NATIVE_PI_SOURCE=/absolute/path/to/pi-connector \
PSST_NATIVE_PRESENCE_EVIDENCE=/absolute/path/to/native-presence.json \
  node --test integration/native-pi-presence.test.mjs
```

Use Node 24.19.0 and the exact connector revision above. Linux PTYs, Python 3,
OpenSSL, npm and tar are required. The package is packed locally, not installed
from a newly published npm release. Dependency installation uses ignored lifecycle
scripts and never reads user model credentials.

## What this does not establish

This establishes the exercised **actual Pi process lifecycle**, including native
history/provider-boundary observations with a controlled local provider. It does
not establish authenticated vendor-model behavior, the owner's launcher or
historical package-upgrade behavior, interactive `/resume` picker UX, all native
human-permission cases, or other hosts' lifecycle behavior.

It does not replace the separate prolonged-offline-event consumer tests or prove
their entire cross-host notification matrix. No model response is needed to infer
transport presence. Issue #29 remains open until its remaining original lifecycle,
discovery/admin/native-output and transport-notice criteria are reconciled against
their own evidence. This test does not fill the complete native compatibility
matrix or the deployment gates in [issue #11](https://github.com/matuto-ai/psst/issues/11).
