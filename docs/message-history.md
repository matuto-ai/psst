# Owned outgoing history

`GET /v1/messages` requires authentication and `X-Client-ID` for the exact owned
sender session. A live lease is not required for reads. Sessions sharing an
installation credential remain separate; retained communication scope is checked
on every page. Unauthorized and missing message IDs both return `message_not_found`.

The omitted `limit` is exactly **10**; explicit limits are integers 1–100. JSON is
capped at **32768 bytes**. `messages` contains only identifiers, timestamps,
transport state, attempts, reason and uncertainty—never content, snippets or
summaries. Each item adds `sender_id` to the existing receipt representation.

Exact filters: `recipient_id`, `status`, `accepted_after` (inclusive),
`accepted_before` (exclusive). Dates use canonical UTC milliseconds, e.g.
`2026-11-01T12:00:00.000Z`. Preserve filters with `next_cursor` on continuation;
`limit` may change. Ordering is `(accepted_at DESC, message_id DESC)`.

The first page establishes an insertion high-water mark; subsequent inserts,
even at identical timestamps, cannot enter that walk. A cursor is tied to the
sender, filter and current credential scopes, and survives broker restart unless
restart recovery changes message states. Expiry is evaluated from the deadline even before bounded cleanup persists it.
A status-filtered cursor has an expiry boundary and returns `history_changed` if
clock-driven expiry can change membership. Receipt states are live: unfiltered pages remain usable while delivery proceeds.
For a status-filtered walk, transitions into or out of that status invalidate the
cursor with **409 `history_changed`** instead of silently changing membership;
restart without the cursor to refresh. Retention deletion does not force a reset:
`retention_changed: true` explicitly warns that purged records may be absent.
The persistent insertion sequence cannot be reused after purge or restart.
This is deliberately not an indefinite historical snapshot of transport states.
A page examines at most 1000 indexed sender rows. Sparse filters may yield an
empty page with a continuation. Continue until `next_cursor` is null.

`GET /v1/messages/{message_id}` stays receipt-only and retains sender/recipient
read compatibility. Explicit **`GET /v1/messages/{message_id}/content`** is
sender-owned and returns `{sender_id, ...receipt, envelope}` with the exact
original envelope and current transport status. It never reconstructs text.

Bodies and metadata currently share message retention: at least seven days after
terminal state, and no purge before expiry plus the negotiated send-retry window.
Expiry stops transport, not access to retained content. Purged IDs return 404;
if metadata exists without its body, content retrieval returns 410
`content_unavailable`. Durable restart does not discard retained history.

Reference `BrokerClient.sentHistory(filters)` / `.messageContent(id)` and facade
`broker_sent_history` / `broker_message_content` follow the same bounds. Reading
content is an explicit separate call. `delivered` means durable adapter inbox
receipt, never model input, reading, a reply or task completion.
