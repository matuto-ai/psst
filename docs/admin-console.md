# Broker administration: separate pages, exact identities

The existing administrator login now opens a navigable console. Authentication,
password verification, cookie attributes, login throttling, origin/CSRF checks,
expiry, restart invalidation and installation revocation are unchanged. No
additional configuration, client-side JavaScript, framework or service is needed.
The pages retain `Cache-Control: no-store` and the restrictive CSP.

- **Clients & sessions** (`/admin/sessions`) is the broker session registry.
- **Messages** (`/admin/messages`) is transport metadata, not a conversation feed.
- **Approvals** (`/admin/approvals`) retains installation approve/deny/revoke.
  `/admin` remains a compatibility alias so saved approval links still work.

## Installation authorization is not session presence

An installation is the adapter identity associated with authorization. Several
independent native sessions may share it. A session is identified by its stable
`client_id`, not its display name. The registry keeps duplicate names as separate
rows and shows name, client type, optional model/project labels and explicit
transport state. Expand **Session identifiers** for selectable, read-only full
client/session and installation IDs; use the normal keyboard copy command.

Compare **Client / session ID** with the `client_id` in the connector's status
output (Pi's broker-status tool, or the equivalent connector status view). Do not
compare it with an enrollment request, an installation ID or a credential ID.
For approval, compare **Enrollment request ID** with the connector's pending
setup request. Installation IDs let you group sessions without merging them.

`connected` means `!closed && lease_until > observation_time`. It is a recent
transport lease, **not** a process-liveness probe, model activity, responsiveness
or task progress. `disconnected` retains a resumable identity; `closed` is
terminal. Every row includes last heartbeat, lease expiry (or no active lease),
and server observation time. Refresh observes current state without renewing,
closing, re-enrolling or otherwise altering a session. Restart clears leases;
an abrupt disappearance may retain presence until the negotiated lease expires.

Optional metadata is explicitly allowlisted. Credential IDs, verifier hashes,
enrollment possession keys, connection/instance identifiers, raw capabilities,
cookies and private metadata fields are not projected into registry pages.
Recognizable absolute/local file paths in optional labels are hidden. Labels are
escaped untrusted strings; identity and authorization never depend on a name.
This heuristic is not content classification or a general secret detector: do
not put secrets in names/model/project labels.

## Bounded registry and message browsing

Both read lists default to **10** rows, support explicit limits 1–100 and cap
serialized row metadata at 64 KiB. The interface offers 10/25/50/100 rows. Queries
use bounded SQL result sets and indexes, not an all-history application load.
Unknown or duplicate parameters, malformed IDs, invalid bounds and altered
cursors return a recoverable error page. No results/content load on that error.

Sessions are ordered by ascending exact client ID. Filters are exact `client_id`,
`installation_id`, `client_type`, and `state` (`connected`, `disconnected`, `closed`).
Each page evaluates presence at its displayed server observation time. Registry
and metadata changes are live between pages; new lower-sorted IDs or sessions
whose presence changes may require returning to the first page. A page is not a
frozen process census. Use browser Back for the previous page, **Back to first
page** for a fresh search, or **Refresh** to observe current state.

Messages are ordered by accepted timestamp descending, then message ID descending.
A durable monotonic history high-water mark from the shared message-history
storage excludes later inserts, even after purge/row-ID reuse. Cursors are signed,
bound to the exact filters and limit, expire after 15 minutes, and are invalid
following broker restart. Purged records may disappear during pagination. Delivery
status is current on each read; status-filter matches may change between pages,
so refresh the first page to see newly matching records. The console does not
claim a historical snapshot of changing delivery states.

Message filters are exact `sender_id`, `recipient_id`, `status`, and inclusive
`accepted_after`/`accepted_before` UTC timestamps. Use `YYYY-MM-DDTHH:MM:SSZ`
(optional milliseconds). Same-named participants remain distinguished by client
IDs. Names/types come only from current safe registry metadata, not message text.
The list contains identifiers, timestamps, delivery state, attempt count and
uncertainty. **No text, snippet, generated summary or envelope is loaded by the
list query.**

Open **View message** to request `/admin/messages/{message_id}` explicitly. Only
that record's original content is loaded and rendered as escaped plain text,
never active HTML. This is authenticated administrator visibility into broker
storage, not a sender-scoped `/v1` API or an anonymous message inspector. The page
is read-only: it adds no resend, cancel, close-session or credential action.

A missing/purged ID returns 404. A retained receipt with an unavailable body
explicitly says content is no longer retained; nothing is reconstructed. This
console does not extend the broker's retention or turn it into an archive.
`accepted` means durable broker storage. `delivered` means durable recipient inbox
receipt, not that a model read, processed, answered or completed anything.
Uncertainty is displayed explicitly and must not be treated as non-delivery.

## Verification and local visual fixtures

Run `npm test` and `npm run check` on pinned Node 24.19.0. The admin tests exercise
actual HTTP handlers/cookies/forms as well as bounded data projections, duplicate
names, multiple installations, expiry/closed/restart presence, filters and
pagination, secret/path exclusion, escaping, missing/retained-content states and
unauthenticated deep links. Existing approval/TLS tests remain applicable.

For **synthetic static visual fixtures only**, run:

```sh
node scripts/admin-ui-preview.mjs /tmp/psst-admin-visual-fixtures
```

It creates standalone HTML under `dist/` and local static-preview metadata. It
uses a disposable test database, destroys it before exiting, does not connect to
an operator's broker and leaves no authenticated session. Do not treat clicking
snapshot links/forms as a live integration test. In a managed QA environment use
the supported `sites-preview start` route and built-in browser; never publish
these fixtures as a service. Static snapshots are separate evidence from the
HTTP integration tests and from native connector acceptance.
