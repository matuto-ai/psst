# Current connector test provenance

`current-transport` qualifies source-built packages, not whatever an npm `latest`
tag happens to point to. A source candidate can legitimately be newer than the
published release. Matching `0.6.0` labels alone cannot prove matching code.

## Automatic current-source gate

For each Psst push, pull request or reusable verification run:

1. `resolve-current-cohort` checks out the exact broker CI commit and resolves
   each connector's `main` once. It records the four full Git SHAs and the
   resolution interval in one cohort. A missing or ambiguous ref fails the job.
2. `current-transport` checks out those immutable SHAs. No job independently
   chooses a later moving branch head. A main update during the run belongs to a
   subsequent run; it does not change the cohort being qualified.
3. Before starting transport tests, each checkout must have the expected HEAD
   and an unchanged tracked tree. `npm pack --ignore-scripts` builds that source.
   The tarball's name/version must match its source manifest, and its SHA-512
   integrity and SHA-1 digest must match the actual archive bytes.
4. Every tarball member must be a regular, tracked file whose bytes match that
   exact Git commit. Duplicate/unsafe paths, untracked packaged code, stale
   same-version code and changed source fail. Only this verified extracted
   package is passed to the production connector drivers. The native Claude MCP
   initialization must additionally report that package's version.
5. The existing real TLS/broker/journal matrix runs against those artifacts.
   CI retains `current-cohort-evidence` with the resolved commits, Git trees,
   package versions, archive integrities and per-file hashes. Partial progress
   remains visible on failure. The workflow conclusion, including teardown, is
   the final test result; `transport_assertions_passed` in the artifact identifies
   only completion of the transport assertions.

The required aggregate `verify` depends on this gate and fails when it fails or
is skipped. Tests also deliberately present stale checkouts, altered tracked
source, untracked packaged code, wrong package versions/names, changed archives
and an old archive with an unchanged version. These must be rejected, rather
than merely printed in a report.

The actual-host `native-presence` lane consumes the same resolved Pi commit and
verified source-built artifact. Its official Pi runtime remains deliberately
pinned; the connector under test no longer uses an obsolete fixed source pin.
Its retained evidence includes the source cohort and packaged-file hashes too.

## Connector-only changes

Connector Verify workflows also call `.github/workflows/connector-cohort.yaml`
from an immutable reviewed Psst workflow commit. No inputs or secrets are needed.
The reusable workflow obtains the caller repository and exact CI SHA from GitHub,
accepts only the four connector repositories and ordinary `push`/`pull_request`
events, and substitutes that candidate for just its own main. A pull request is
therefore tested as its exact checkout, never silently replaced by the released
package or main. The other three connectors and the broker are resolved once
from current main, then checked out only by their recorded full SHAs.

The caller must make this job a dependency of its required aggregate verification
check. A failed or skipped cohort cannot be hidden by a green local-only test job.
All execution uses disposable hosted runners, `contents: read`, no inherited
secrets, no persistent checkout credentials and no `pull_request_target` event.
It does not dispatch another repository's workflows or require a new credential.

The new broker gate must be merged before connector callers can run it against
broker main. Until then those dependent jobs are blocked, not successful. Pinning
the reusable YAML does not pin an old broker or connector product: every run
still freezes a fresh source cohort. A changed reusable workflow interface can
require an explicit caller update; incompatibility fails rather than silently
falling back to an older package. This follows GitHub's
[caller-context and reusable-workflow rules](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations).

## Independent compatibility evidence

The old `cooperative-transport` and upgrade fixtures intentionally retain their
immutable historical inputs. `candidate-transport` is a separately declared
`pinned-candidate` snapshot with exact PR dependency SHAs; it is not current-main
qualification. It receives the same artifact checks, but its evidence is saved
separately and cannot be substituted for the current cohort.

Dependency lockfiles, host versions and protocol versions are separate contracts.
This gate does not silently replace them with registry `latest`, update runtime
permissions, publish a package or install anything in a user's native session.
The matrix still uses synthetic native/model boundaries. Its success does not
establish authenticated model acceptance or the version loaded by the owner.

## Local reproduction

Use clean Git checkouts, the supported Node/npm runtime, and the locked Pi and
OpenCode dependencies. Set `GITHUB_SHA` to the exact broker checkout commit and
run `node scripts/connector-provenance.mjs resolve /tmp/current-cohort.json`.
Check out each connector at the recorded SHA, then run the existing matrix with
`PSST_CURRENT_COHORT` containing that JSON and `PSST_CURRENT_MATRIX_SOURCES`
mapping the four connector types to those checkouts. Set
`PSST_COHORT_EVIDENCE` to an external file if retaining the report. Archive-only
directories without Git provenance cannot claim this gate's qualification.
