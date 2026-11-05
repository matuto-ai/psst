# Diagnostics and Settings

This source change adds broker diagnostics and an authenticated **Settings** page.
It does not publish an image, change a running deployment, renew an authorization,
or establish the cause of any past live incident.

## Structured diagnostics

The normal entrypoint writes one human-readable line per event to stderr. No viewer or `jq` is needed for `docker logs`. Lines include UTC time, severity, a stable `PSST_*` event code, an English explanation and allowlisted operational fields. HTTP operations carry the same `request_id` returned in `X-Request-ID` and API errors, plus a normalized route and method. Store records inherit this request context, including asynchronous polls. Version and per-process `run_id` appear at broker startup or startup failure; bounded source locations appear in text only at debug level.

Set `PSST_LOG_FORMAT=json` for existing structured-log collectors, or `PSST_LOG_FORMAT=text` for the default. This deployment setting requires restart and does not change the Settings log-level preference. JSON retains timestamp, level, event, message, version, run_id, correlation, diagnostic stacks and all safe transaction flags at every enabled level. Invalid format values fail startup.

For example, a storage failure now explains the cause and remedy instead of requiring a numeric-code lookup:

```text
ERROR PSST_STORAGE_TRANSACTION_FAILED: Storage transaction failed. SQLite cannot find a writable temporary directory. Mount a writable /tmp (tmpfs) in the container; keep /data unchanged. Rolled back; nothing was saved.
```

The actual line also contains its timestamp, request ID, route, SQLite name/code and rollback/outcome fields. Advice is generated from recognized codes, never arbitrary exception text.

Select the minimum level in Settings, the private configuration's
`settings.log_level`, or `PSST_LOG_LEVEL`:

- `debug`: message acceptance, claim/renew/complete/cancel, expected expiry, heartbeat/presence, authentication, request boundaries and confirmed rollbacks. Successful authentication is logged once per HTTP request, not on each internal long-poll recheck. Empty poll and maintenance transactions no longer emit a generic commit line; lifecycle records still require confirmed commit.
- `info` (default): broker lifecycle, connections/disconnections, authorization
  requests/decisions, configuration changes and operational recovery.
- `warning`: rejected requests, conflicts, failed administrator login,
  unavailable readiness and explicit proxy-transport configuration.
- `error`: startup/shutdown, storage, rollback, credential reload and maintenance
  failures. Known SQLite and OS errors retain a safe cause and code; unexpected
  failures retain only a generic cause and bounded relevant source locations.

The threshold includes every higher level. At `error`, ordinary connection and
Settings-change events are filtered out. Debug can be verbose; enable it for a
bounded diagnostic interval and restore the desired level afterward. Container
or service-manager log retention/rotation remains operator-owned; this change
adds no second log file, public log endpoint or telemetry destination.

### Privacy and outcome rules

Metadata is allowlisted. Logs exclude message bodies, names/projects, credentials,
verifiers, enrollment proofs, cookies, arbitrary headers, raw URLs/query strings,
SQL, private filesystem paths and arbitrary exception messages. UUIDs identify
messages, sessions, approval requests and HTTP requests; treat even this
operational metadata as private. Do not post unreviewed logs publicly.

Exception diagnostics use recognized error properties, not a dump plus regex
redaction. At most six source locations from known broker modules are included,
without absolute paths, function names or the exception's first line. Unknown
exception details may therefore require a synthetic reproduction to investigate.
API responses/HTML never receive these private diagnostics or stacks.

The sink is best effort. Sink/formatting failures cannot roll back a successful
operation or turn durable acceptance into a failure. Lifecycle success records
are emitted only after confirmed commit; an uncertain post-commit exception does
not emit a false success record. A missing log is not proof that an operation did
not happen. Reconcile using the original idempotency key/receipt.

Repeated credential/maintenance failures are emitted initially and summarized
at most once per minute per operation, followed by a recovery event. Background
storage transaction/rollback failures are similarly bounded, while each HTTP
failure retains its request correlation. Counters/maps are bounded. Only recovery of the owning authentication or sweep operation clears its
background failure summary. An unrelated successful transaction is not evidence
of recovery.

### Useful codes and causes

| Code or family | Meaning and next step |
| --- | --- |
| `PSST_HTTP_REQUEST_FAILED` | Inspect public `code`, `effect`, `retryable`, status and request ID. A 503 alone does not establish a storage root cause. |
| `PSST_STORAGE_TRANSACTION_FAILED` | Inspect `phase` (begin, statement, before_commit, commit, after_commit), commit/rollback flags and safe `error.reason`. Retain the original idempotency key. |
| `PSST_STORAGE_ROLLBACK_FAILED` | An active writer could not roll back and is poisoned. Preserve diagnostics, resolve the underlying storage failure and restart safely. |
| `PSST_STORAGE_UNAVAILABLE` | `reason` distinguishes closed/poisoned store, low free space, database/WAL size limit, unsupported filesystem or a failed disk inspection. |
| `PSST_STORAGE_ROLLBACK_CONFIRMED` | Debug: a pre-commit operation was rolled back, explicitly or automatically by SQLite. |
| `PSST_AUTH_RELOAD_FAILED`, `PSST_AUTH_MAINTENANCE_FAILED` | Check the private credential/pairing configuration and its ownership/mode. Access remains fail-closed. |
| `PSST_MAINTENANCE_FAILED` | Expiration/cleanup failed; a credential reload failure does not prevent the separate safe sweep attempt. |
| `PSST_READINESS_CHANGED` | Readiness changed because of credentials, storage or shutdown. Liveness is not readiness. |
| `PSST_STARTUP_FAILED`, `PSST_SHUTDOWN_FAILED` | Inspect phase and safe cause. Correct private configuration/storage/TLS without publishing secrets. |
| `PSST_APPROVAL_*`, `PSST_ENROLLMENT_*`, `PSST_ADMIN_*` | Authorization and administrator lifecycle, without identities/secrets from the request body. |
| `PSST_CLIENT_*`, `PSST_MESSAGE_*`, `PSST_MESSAGES_EXPIRED` | Transport lifecycle only. Delivered still means durable recipient inbox receipt, never model processing. |
| `PSST_SETTINGS_UPDATED` | Validated preferences were durably saved. The log threshold may filter this info event. |

SQLite extended code **6410**, `SQLITE_IOERR_GETTEMPPATH`, is reported as `sqlite_temp_directory_unavailable`, with a fixed hint to mount writable `/tmp` while preserving `/data`. It is not collapsed into generic I/O failure. See the [read-only container correction](docker-release.md#writable-temporary-storage-is-required); free space in `/data` alone does not establish usable temporary storage.

Recognized SQLite causes also include `sqlite_disk_full` (base code 13), `sqlite_busy`
(5), `sqlite_locked` (6), `sqlite_read_only` (8), `sqlite_io_failure` (10),
`sqlite_corrupt` (11), `sqlite_cannot_open` (14), and `sqlite_constraint` (19).
`sqlite_code` retains the numeric SQLite code, including an extended code when
provided. OS causes include `permission_denied`, `file_missing`, `disk_full`,
`io_failure`, `read_only_filesystem`, `address_in_use` and `connection_reset`.
An unrecognized error reports `unexpected_error`, not its possibly private text.

## Settings

Open **Settings** from the administration navigation. This page uses the existing
administrator login, same-origin POST, CSRF, secure cookies, CSP and private
`no-store` HTML. No separate API credential or permission expansion is created.
A successful Save persists the validated preferences in the broker's SQLite
database. Invalid/locked/unknown fields reject the entire save.

| Setting | Default | Bounds | Application |
| --- | --- | --- | --- |
| Log level | info | debug, info, warning, error | Subsequent events immediately |
| Installation authorization | 90 days | 1–3650 days | Future approval grants only |
| Pending approval request | 24 hours | 1–24 hours | New requests only |
| Administrator session | 8 hours | 1–168 hours | Next successful login |
| Default message lifetime | 86400 seconds | Configured message TTL min/max; v1 bounds 60–604800 | New sends/resends without explicit TTL |

Shortening a clock does not rewrite any existing expiry. Existing grants,
pending requests, messages, cookies and connector receipts retain their original
deadline; grants are not automatically extended or reissued. Administrator
sessions still require fresh login on broker restart. Pre-login session lifetime
remains ten minutes. Revocation remains effective independently of expiry.

Transport heartbeat/lease/claim clocks and destructive retention controls are
not editable here. Keep lease at least three heartbeat intervals and use the
existing deployment-level protocol controls when needed. Message/receipt retention,
registration/send retry windows, default-off session cleanup, and revoked-entry
visibility/tombstones keep their existing policies. Settings does not delete data.

### Precedence and startup

The effective order is **environment > private configuration > saved Settings >
built-in default**. Each field shows its source, units, bounds and application
time. Fields managed externally are disabled; forged form writes cannot override
them. Removing an external override reveals the saved preference, or its default
if never saved. Deployment configuration changes require a normal restart.

Environment variables are `PSST_LOG_LEVEL`, `PSST_AUTHORIZATION_DAYS`,
`PSST_PENDING_REQUEST_HOURS`, `PSST_ADMIN_SESSION_HOURS` and
`PSST_DEFAULT_MESSAGE_TTL_SECONDS`. Values must be valid; an explicitly empty
value fails startup. Compose passes these through only when set instead of
forcing a default that would lock the UI. The standard password and public-origin
variables retain their existing behavior.

Private JSON configuration can contain:

```json
{
  "settings": {
    "log_level": "info",
    "authorization_days": 365,
    "pending_request_hours": 24,
    "admin_session_hours": 8,
    "default_message_ttl_seconds": 86400
  }
}
```

This is a fragment, not a complete broker configuration. The existing
`limits.default_ttl_seconds` is an externally managed alias for
`settings.default_message_ttl_seconds`; conflicting file values fail startup.
An environment override takes priority. The effective startup TTL is checked
against configured min/max before storage is opened. Persisted invalid values
fail closed instead of silently changing policy.

### Persistence and compatibility

Two additive tables retain settings and per-send default-TTL normalization; the
existing schema version and wire protocol remain unchanged. The default recorded
when a send/resend is accepted is used for an exact omitted-TTL replay, even after
a Settings change or restart. Explicit TTLs keep their original normalization and
conflict rules. The per-send metadata is removed with its retained send record.

At first upgrade, legacy send records are seeded with the startup configured
default, matching the old binary's replay normalization at that point. Historical
pre-upgrade configuration changes cannot be reconstructed. Do not change the
old default simultaneously with upgrading if pending legacy operations need
reconciliation. Existing expiry timestamps are never recalculated.

Use the existing consistent SQLite backup procedure before upgrade. Additive
schema-5 tables do not themselves trigger a new pre-migration backup on an
already schema-5 database. Do not downgrade a live database to a binary that
ignores these settings/replay rules; restore a verified compatible snapshot
under the existing recovery procedure. No release or deployment is implied.

## SQLite automatic rollback correction

A focused temporary-database test limits SQLite's maximum page count until an
INSERT raises `SQLITE_FULL`. SQLite automatically ends that transaction. The old
code then ran a redundant ROLLBACK, whose "no transaction is active" failure
poisoned the store until restart. The corrected code checks transaction state:

- Before any commit attempt, an automatically ended transaction is a confirmed
  rollback; return `not_applied` without poisoning a usable store.
- A failed BEGIN is reported with its phase and no false durable success.
- If an active transaction needs rollback and rollback fails, poison the writer.
- An inactive transaction after a commit attempt does not prove rollback. Keep
  `unknown` when commit outcome cannot be established, including post-commit faults.

This confirms a real isolated defect, not the cause of the reported live 503.
Preserve request ID, first failure, phase, SQLite/OS cause, rollback/poison flags
and readiness transition before restarting a degraded broker. Healthy liveness
or a successful restart alone does not identify the original failure.

## Validation boundary

Focused unit tests use temporary SQLite databases, fake clocks, injected sinks,
in-memory HTTP/admin requests and real SQLite failure conditions. They cover
redaction, sink failure, correlation, levels, repeated failures/recovery,
transaction uncertainty, Settings security/persistence/bounds, future-only clocks
and omitted-TTL replay. The focused container storage check in `test/container-storage.mjs` additionally covers startup failure with no writable temporary directory and successful send/retry/claim/completion/receipt with the `/tmp` mount under a read-only root filesystem. The release workflow gates publication on both cases. These checks do not certify a running production mount layout, HTTP/proxy/browser/native-connector behavior or the cause of the older 0.7.1 outage.
