# Verification

## Current unit-test policy

Run with Node.js **24.19.0**, whose bundled SQLite is **3.53.3**. No npm dependencies are needed.

```sh
npm run check
npm test
```

`npm test` runs `node --test test/*.test.mjs`. The required `Verify / verify` job runs the same suite, JavaScript syntax checks and syntax checks for the retained operator shell scripts. Its timeout is three minutes. There are no cross-repository checkouts, package/native-host downloads, browser dependencies or Docker/Podman test jobs.

## What belongs in this suite

- Protocol serialization, input validation, bounded payloads and authorization rules.
- Broker store state transitions, idempotency, scopes, leases, presence notices, quotas, retention and rollback/unknown-outcome handling.
- Temporary SQLite and private filesystem fixtures for store, backup, enrollment and inbox behavior. Fake clocks exercise expiry without wall-clock waits.
- Admin projection, escaping, pagination, session/CSRF/origin/password rules and response headers through direct handler calls with in-memory request/response doubles.
- Reference inbox, scheduler, tool and runtime behavior through injected clients/transports, plus the local stdio handler over in-memory streams.
- Release-plan and deployment-configuration invariants that can be checked without building or launching anything.

Keep tests focused on the component's responsibility. Tests may use a real temporary database because SQL transactions, rollback and persistence are the storage component's behavior; they must not compose a live broker with native connectors to exercise that behavior. Do not remove a useful local test merely because its name contains “native”, “transport” or “acceptance”.

## Removed machinery

The cleanup for [issue #51](https://github.com/matuto-ai/psst/issues/51) removes live HTTP/TLS and subprocess end-to-end tests, four-connector matrices, real Pi/PTY probes, Docker/Podman topologies, browser checks, historical upgrade orchestration and their dedicated scripts/fixtures. Mixed files retain their focused unit cases. Admin handler security/presentation tests now use in-memory requests instead of a listening server.

The Containerfile retains the production runtime only. Release publication still requires a user-published release with matching version and reviewed source, runs unit verification, then builds and pushes the image. It no longer launches smoke-test containers. This cleanup does not publish a release or deploy anything.

## Evidence limits and history

Passing unit tests proves only the asserted local behavior. It does not certify live TLS transport, native agent input, installation, browser interaction, container networking, host recovery or deployment readiness. Those operations need purpose-specific verification when actually requested, not an ever-growing mandatory acceptance matrix.

Previous reports remain historical evidence for their exact commits. Their removed harnesses can be inspected in the [pre-cleanup source](https://github.com/matuto-ai/psst/tree/2d766b72edd9ed34f21cb93893a737aea0721f21). The [#11 acceptance record](issue11-acceptance.md) is historical context, not a statement that the current unit suite exercises its scenarios. This cleanup does not close #11 or claim its remaining environment-dependent acceptance.
