# URL-only approval enrollment (implementation contract)

Explicit native setup accepts only the HTTPS broker origin. Normal startup reads
an existing selected credential; it never creates or rotates an enrollment. It
may resume GET-only polling of a durable prior explicit pending request, unless
locally cancelled. Persist its nonsecret origin/request pointer before beginning.

## Client wire

POST `/v1/enrollment-requests` uses `Authorization: Enrollment <candidate>`;
candidate is 32 random bytes base64url, generated and saved privately before any
network effect. Body: `{request_id: UUID, client_type, label: string <=80}`.
GET `/v1/enrollment-requests/:request_id` uses the same possession header.
UUID/type/label/key are immutable. Identical POST is replay; conflict is409.
A pending key has no access to messaging or discovery.

Response: `{request_id,state,request_expires_at,credential?}`. States:
`pending -> approved | denied | expired`; `approved -> revoked | expired`.
Pending requests expire after 24h. Approved authorization defaults to 90 days,
configurable through PSST_AUTHORIZATION_DAYS (integer 1–3650 days). A day is
86,400,000 milliseconds; expiry is calculated at approval time and persisted.
Credential is the existing `{credential_id,adapter_id,client_type,scopes,
expires_at,protocol_version:'1'}` receipt. No secret is returned. Status possession
is checked even for terminal requests. Unknown IDs/proofs reveal no request data.
Approval never revokes an old credential automatically; revocation is explicit.

## Shared helper

`reference/approval.mjs`: `beginApproval({brokerUrl,directory,clientType,label?,
replaceRequestId?})`, `pollApproval({brokerUrl,directory,clientType})`,
`readApprovalState({brokerUrl,directory,clientType})`.
Read is local-only and returns null when absent. Poll never creates state and
throws `approval_setup_required` when absent. Begin is explicit setup only.
Return `{state,requestId,requestExpiresAt,connectionFile?,credentialId?,expiresAt?}`.
Approved bundle and enrollment receipt use the existing strict reader contract.
Per-origin/type attempts live below the supplied native persistent installation
directory. The helper never changes the adapter's active selection. Replacement
requires the exact previous request ID; retry resumes its existing successor.
Poll no faster than2s. Cancellation stops host polling, not durable request state.
Generation guards and selection CAS remain adapter-owned. Keep the old selected
connection until replacement approval, valid attachment and atomic selection.

## Broker/operator

`PSST_ADMIN_PASSWORD` enables the built-in administration UI; no policy file or
manual grant command is required. `PSST_PUBLIC_ORIGIN` optionally fixes its HTTPS
origin behind a proxy; forwarded headers are never trusted. No weak default.
GET `/admin` renders a form. POST `/admin/login` takes password and csrf fields;
POST `/admin/logout` and `/admin/requests/:id/{approve,deny,revoke}` require a
session, csrf and same Origin. Cookie: Secure, HttpOnly, SameSite=Strict.
No HTTP Basic. Untrusted labels are escaped, not authorization claims.
Existing config.database remains the sole state database. Schema4 requires an
automatic private SQLite backup before migration. Existing legacy credentials,
sessions, pending mail and pairing protocol remain compatible. Downgrade requires
restoring the snapshot and loses writes after it; never silently reset state.

Terminal status replay remains available for30days; after removal no messaging
authority is restored and explicit setup is needed. Admin sessions expire after8h
and restart requires login again. Helper errors expose sanitized code/effect/
retryable only; transport, ownership-busy and429/503 can retry the same request.

Retryable helper errors include `retryAfterMs` (1000–300000ms). Honor this delay;
429 defaults to60seconds,503 to5seconds, transport/ownership contention to2seconds.
Retry-After is parsed from the HTTPS response and the bounded cooldown is saved
privately across processes. An active explicit setup may retry its initial POST
with the SAME UUID/key; normal startup still performs GET only. If the first POST
never reached the broker, require explicit continuation instead of creating a
request automatically. Unknown outcomes never generate replacement identities.



## Finite lifetime compatibility

The wire and receipt formats remain unchanged: `credential.expires_at` is always
a finite ISO timestamp. There is no unlimited value or missing-expiry variant.
`request_expires_at` is the pending authorization boundary, not a grant expiry.
The normal image/Compose entrypoint validates `PSST_AUTHORIZATION_DAYS` before
opening storage; see [operator settings](approval-operator.md#configure-authorization-lifetime).

Only new approvals use the configured duration. Existing grants, receipts,
request replay, repeated approval and restarts keep the exact original expiry
and identities. The shared helper's receipt reader and local status use that
expiry for pi, claude-code, opencode and antigravity-cli without a format change;
the broker separately enforces revocation. At `now >= expires_at`, a receipt is
expired and cannot authorize API access. Pending requests likewise cannot be
approved at or after their separate 24-hour deadline. No automatic replacement,
renewal or periodic per-session setup is introduced.
