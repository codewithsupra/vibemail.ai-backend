# VibeMail Engine — Backend Contract

## 1. Overview

VibeMail Engine's backend is a Gmail-backed mail API: it authenticates a user against Google, performs an initial sync of their recent Gmail messages into Postgres (via Supabase), then stays current in real time via Gmail Pub/Sub push notifications (no polling), and exposes endpoints to list messages, send new ones, and mark messages as read — with read state kept in sync in both directions. Stack: Node.js, Express, TypeScript, PostgreSQL via Supabase, deployed live on Vercel.

**This is a two-session build. Read Section 3 before writing any code.**

## 2. Acceptance Criteria

The project is complete only when all of the following are true:

- [ ] Gmail OAuth completes end-to-end and encrypted access/refresh tokens persist in Supabase.
- [ ] First authentication triggers a sync of the 50 most recent Gmail messages into the `messages` table.
- [ ] New messages arrive through Gmail Pub/Sub push notifications — no polling loop exists anywhere in the codebase.
- [ ] An authenticated user can send a real message through the Gmail API via the send endpoint.
- [ ] Read state synchronizes in both directions: app→Gmail via the mark-as-read endpoint, Gmail→app via Pub/Sub history processing.
- [ ] All authentication failures return one of the typed, recoverable error codes in Section 7 — never a raw/untyped 500.
- [ ] The full test suite passes with zero skipped or pending tests.
- [ ] The backend is deployed and reachable live on Vercel.
- [ ] Git history for both sessions reads as a clean sequence of small, logically-scoped commits — not a single monolithic commit or unreviewable WIP noise.
- [ ] Session 1 was merged, green, before session 2's schema was reviewed or merged (Section 3 gate honored).

## 3. Sequencing Rule (two-session build)

**Session 1 — server logic (build first):**
- Express route handlers for all endpoints in Section 6, including the Pub/Sub webhook.
- Google OAuth code-exchange logic, token encryption.
- Gmail API integration: initial 50-message sync, `users.watch()` registration, `users.history.list` processing, sending, label updates.
- JWT issuance and per-request verification.
- A data-access layer defined as an interface/abstraction, backed by a **mocked/in-memory implementation** for this session (its method signatures are what session 2's real Supabase queries will implement against).
- Unit/integration tests covering all of the above, run against the mocked data-access layer, with **zero skipped or pending tests**.
- Commits land as a clean sequence of small, logically-scoped units (e.g. one commit per endpoint or feature step), not one giant commit.
- Merge this PR only once its tests are green.

**Gate:** Session 2 must not begin schema review or merge its migration until session 1's PR is merged and its tests are verified passing.

**Session 2 — schema (build second, after the gate):**
- The real Supabase SQL migration(s) implementing the `users` and `messages` tables from Section 4.
- Wire the migration's tables to the data-access layer interface defined in session 1 (replacing the mock implementation).
- Same commit-hygiene expectation as session 1.
- Open for review and merge only after the gate above is satisfied.

## 4. Data Model

### `users`

| Field | Type | Source |
|---|---|---|
| id | uuid (PK) | internal — generated on first OAuth callback |
| email | text | Google OAuth token info / Gmail profile |
| googleAccessToken | text (encrypted at rest, e.g. AES-256-GCM with a key from env/KMS) | OAuth token exchange response |
| googleRefreshToken | text (encrypted at rest, same scheme) | OAuth token exchange response |
| googleTokenExpiresAt | timestamptz | OAuth token exchange response — use `tokens.expiry_date` from `google-auth-library`'s `getToken()` result directly (it already computes the absolute time from `expires_in`; don't re-derive it) |
| lastHistoryId | text, nullable | Gmail `historyId` — seeded from the initial sync, advanced by each processed Pub/Sub notification; the resume point for `users.history.list` |
| watchExpiration | timestamptz, nullable | Gmail `users.watch()` response `expiration` — a string epoch-millis value (`Schema$WatchResponse.expiration: string \| null`), parse it before converting to a timestamp. Gmail requires the watch to be renewed at least every 7 days |
| createdAt | timestamptz | internal — row insert time |

### `messages`

| Field | Type | Source |
|---|---|---|
| id | text (PK) | Gmail `message.id` |
| userId | uuid (FK → users.id) | internal — owner of the mailbox |
| threadId | text | Gmail `message.threadId` |
| direction | enum(`inbound`, `sent`) | internal — `sent` for messages created via the send endpoint, `inbound` for synced/pushed mail |
| subject | text, nullable | Gmail `payload.headers[name=Subject].value` |
| fromAddress | text | Gmail `payload.headers[name=From].value` |
| toAddress | text | Gmail `payload.headers[name=To].value` |
| snippet | text, nullable | Gmail `message.snippet` |
| bodyText | text, nullable | Gmail `payload.parts[mimeType=text/plain].body.data` (base64url-decoded); MIME parts can nest recursively (e.g. `multipart/mixed` wrapping `multipart/alternative` on messages with attachments), so this requires a recursive walk of `payload.parts[].parts[]`, not a single flat lookup |
| bodyHtml | text, nullable | Gmail `payload.parts[mimeType=text/html].body.data` (base64url-decoded); same recursive-walk note as `bodyText` |
| labelIds | text[] | Gmail `message.labelIds` |
| isRead | boolean | derived: `NOT ("UNREAD" IN message.labelIds)`, kept current by both the mark-as-read endpoint and Pub/Sub history processing |
| internalDate | timestamptz | Gmail `message.internalDate` (epoch ms → timestamp) |
| sizeEstimate | integer | Gmail `message.sizeEstimate` |
| createdAt | timestamptz | internal — row insert time |
| updatedAt | timestamptz | internal — row update time |

`StoredMessage` (used in API responses below) is the `messages` row shape above, serialized as JSON (camelCase field names as written).

## 5. Real-Time Sync (Pub/Sub) and Read-State Synchronization

**Initial sync (on first authentication, part of the OAuth callback flow in Section 6a):**
1. Call `users.messages.list` (maxResults=50, no filter) to get the 50 most recent message ids.
2. For each id, call `users.messages.get` (format=full), parse, and insert into `messages` as `direction: "inbound"`.
3. Call `users.watch({ topicName, labelIds: ["INBOX"] })`. Store the returned `historyId` as `users.lastHistoryId` and `expiration` as `users.watchExpiration`.

*Assumption: this runs synchronously within the callback request for v1 simplicity (acceptable at 50 messages); revisit if latency becomes a problem.*

**Ongoing sync (no polling):** Google Cloud Pub/Sub is configured with a topic that Gmail's `watch()` publishes to, and a push subscription pointing at `POST /webhook/gmail` (Section 6e). Each push delivers `{ emailAddress, historyId }`. The handler:
1. Looks up the user by `emailAddress`.
2. Calls `users.history.list(startHistoryId = users.lastHistoryId)`. `history.list` is paginated (`maxResults` defaults to 100, max 500) — if the response includes a `nextPageToken`, keep calling with that token until it's absent before considering the batch fully processed; a single unpaginated call can silently miss changes on an active mailbox.
3. For each `messagesAdded` record: fetch and insert the new message as `direction: "inbound"` (this is how new mail arrives — no polling loop anywhere).
4. For each history record with `labelsRemoved` containing `UNREAD`: set that message's `isRead = true` locally (Gmail→app read sync).
5. For each history record with `labelsAdded` containing `UNREAD`: set that message's `isRead = false` locally.
6. Advance `users.lastHistoryId` to the final page's response `historyId` field (the mailbox's current history record ID) — not a value derived from individual history record IDs.

**Stale `startHistoryId` (full re-sync fallback):** a `startHistoryId` that Gmail no longer recognizes (expired or invalid) makes `users.history.list` return `HTTP 404`. Per Gmail's documented guidance, this is a signal to perform a full re-sync, not a transient failure to retry as-is: on a 404 from `history.list`, the webhook handler must re-run the initial-sync procedure above (re-fetch the most recent messages, re-issue `users.watch()`, and reseed `lastHistoryId`/`watchExpiration`) rather than surfacing `gmail_history_fetch_failed`. `lastHistoryId` is typically valid for at least a week but can expire sooner in rare cases, so this path is not just a theoretical edge case.

**Watch renewal:** `users.watchExpiration` must be checked and `users.watch()` re-issued before it lapses (Gmail's 7-day max). *Assumption: a scheduled job (e.g. Vercel Cron) handles renewal; exact scheduling mechanism is an implementation detail left to session 1, not part of this contract's typed surface.*

**Read-state sync, summarized:**
- App → Gmail: the mark-as-read endpoint (Section 6d) calls Gmail's `users.messages.modify` to remove `UNREAD`, then updates the local row.
- Gmail → App: the Pub/Sub webhook (step 4/5 above) updates the local row when the label changes elsewhere (another Gmail client, the web UI, etc.).

## 6. API Endpoint Contracts

### a) OAuth callback

`GET /api/v1/auth/google/callback`

**Auth:** none (this endpoint establishes auth).

**Request — query params:**

| Param | Type | Required |
|---|---|---|
| code | string | yes |
| state | string | yes (CSRF check against the value issued when the OAuth flow started) |

**Response 200:** sets an httpOnly, secure cookie named `vibemail_jwt` containing the backend-issued JWT (payload: `{ userId }`), performs the initial sync described in Section 5, then redirects to the app's post-login URL. No JSON body on success.

**Typed errors:**

| HTTP | code | Meaning |
|---|---|---|
| 400 | `missing_code` | `code` query param absent |
| 400 | `invalid_state` | `state` missing or does not match the value issued for this flow |
| 502 | `code_exchange_failed` | Google rejected the code or the token exchange request failed |
| 502 | `initial_sync_failed` | Token exchange succeeded but the 50-message sync or `users.watch()` registration failed |

### b) List messages

`GET /api/v1/messages`

**Auth:** JWT required (`vibemail_jwt` cookie or `Authorization: Bearer <jwt>`).

**Request — query params:**

| Param | Type | Required | Default |
|---|---|---|---|
| limit | integer | no | 20 (max 100) |
| cursor | string | no | — (opaque cursor from a previous response's `nextCursor`; omit for the first page) |
| label | string | no | — (e.g. `INBOX`, `SENT`; filters on `labelIds` containing this value) |
| isRead | boolean | no | — (filters on `isRead`) |

**Response 200:**
```json
{
  "messages": [ /* StoredMessage[] */ ],
  "nextCursor": null,
  "limit": 20
}
```

**Typed errors:**

| HTTP | code | Meaning |
|---|---|---|
| 401 | `unauthorized` | JWT missing, malformed, or invalid |
| 401 | `reauth_required` | Google refresh token invalid/revoked; user must redo OAuth |
| 502 | `gmail_api_error` | Underlying Gmail API call failed |
| 429 | `rate_limited` | Gmail API or internal rate limit exceeded |

### c) Send message

`POST /api/v1/messages/send`

**Auth:** JWT required.

**Request — body:**

| Field | Type | Required |
|---|---|---|
| to | string (email) | yes |
| subject | string | yes |
| bodyText | string | at least one of bodyText/bodyHtml required |
| bodyHtml | string | at least one of bodyText/bodyHtml required |

**Response 201:** the created `StoredMessage` (with `direction: "sent"`).

**Typed errors:**

| HTTP | code | Meaning |
|---|---|---|
| 401 | `unauthorized` | JWT missing, malformed, or invalid |
| 400 | `validation_error` | Missing/invalid `to`, `subject`, or neither `bodyText` nor `bodyHtml` provided |
| 401 | `reauth_required` | Google refresh token invalid/revoked |
| 502 | `gmail_send_failed` | Gmail API rejected or failed to send the message |
| 429 | `rate_limited` | Gmail API or internal rate limit exceeded |

### d) Mark as read

`PATCH /api/v1/messages/:id/read`

**Auth:** JWT required; the message must belong to the caller (`messages.userId` matches the JWT's `userId`).

**Request:** path param `id` (Gmail message id). No body.

**Response 200:** the updated `StoredMessage` (with `isRead: true`).

**Typed errors:**

| HTTP | code | Meaning |
|---|---|---|
| 401 | `unauthorized` | JWT missing, malformed, or invalid |
| 404 | `not_found` | Message does not exist, or exists but is not owned by the caller |
| 401 | `reauth_required` | Google refresh token invalid/revoked |
| 502 | `gmail_api_error` | Underlying Gmail API label-update call failed |

### e) Gmail Pub/Sub webhook

`POST /webhook/gmail`

Not one of the four user-facing endpoints, but required to satisfy the no-polling / real-time-sync acceptance criteria — included here so both sessions build against it. Lives outside `/api/v1` since it's a server-to-server Pub/Sub push target, not a client-facing endpoint.

**Auth:** Google Cloud Pub/Sub authenticated push — the request carries an OIDC bearer token in `Authorization`, verified against the configured service account. *Assumption: OIDC push auth is used rather than a shared-secret URL, per Google's recommended setup; adjust if a different Pub/Sub auth scheme is preferred.*

**Request — body** (Pub/Sub push envelope):
```json
{
  "message": {
    "data": "base64-encoded-json:{ emailAddress, historyId }",
    "messageId": "string",
    "publishTime": "string"
  },
  "subscription": "string"
}
```

**Response 200:** empty body — acknowledges the message so Pub/Sub does not redeliver. **Notes:**
- An `emailAddress` that matches no known user is acked with 200 (no-op) rather than returning 404, to avoid Pub/Sub retry storms on stale subscriptions.
- A `404` from `users.history.list` (expired/invalid `startHistoryId`, see Section 5's stale-`startHistoryId` fallback) is not surfaced as an error to Pub/Sub: the handler performs the full re-sync fallback and still acks 200 on success, so Pub/Sub doesn't redeliver a notification that was actually handled.

**Typed errors:**

| HTTP | code | Meaning |
|---|---|---|
| 401 | `invalid_pubsub_token` | OIDC token missing or failed verification |
| 400 | `malformed_notification` | `data` is not valid base64/JSON or missing `emailAddress`/`historyId` |
| 502 | `gmail_history_fetch_failed` | `users.history.list` call failed for a reason other than an expired `startHistoryId` (e.g. network/API error), or the Section 5 full re-sync fallback itself failed |

## 7. Shared Error Envelope

Every error response across all endpoints uses this shape, with HTTP status carrying the category:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "human-readable description"
  }
}
```

Every authentication-failure code below is **typed and recoverable**: each maps to a specific, defined client action (redirect to login, or re-run the OAuth flow) rather than a dead end.

**Consolidated `error.code` values:**

| code | HTTP | Used by | Recoverable action |
|---|---|---|---|
| `missing_code` | 400 | OAuth callback | Restart OAuth flow |
| `invalid_state` | 400 | OAuth callback | Restart OAuth flow |
| `code_exchange_failed` | 502 | OAuth callback | Retry OAuth flow |
| `initial_sync_failed` | 502 | OAuth callback | Retry sync (auth itself succeeded) |
| `unauthorized` | 401 | List, Send, Mark-as-read | Redirect to login |
| `reauth_required` | 401 | List, Send, Mark-as-read | Re-initiate Google OAuth (Section 6a) |
| `gmail_api_error` | 502 | List, Mark-as-read, Webhook (`gmail_history_fetch_failed`) | Retry request |
| `gmail_send_failed` | 502 | Send | Retry send |
| `rate_limited` | 429 | List, Send | Retry with backoff |
| `validation_error` | 400 | Send | Fix request payload |
| `not_found` | 404 | Mark-as-read | N/A — not an auth failure |
| `invalid_pubsub_token` | 401 | Webhook | Fix Pub/Sub push subscription config |
| `malformed_notification` | 400 | Webhook | N/A — indicates a Pub/Sub/Gmail-side issue |

## 8. Deployment

The Express app is deployed to Vercel (as Vercel Functions / Fluid Compute running the standard Node.js runtime — no code changes needed to run Express there). This gives a stable public HTTPS URL used as both:
- the Google OAuth redirect URI (`.../api/v1/auth/google/callback`), and
- the Gmail Pub/Sub push subscription endpoint (`.../webhook/gmail`).

Being "live on Vercel" per the acceptance criteria means: the app is deployed to a Vercel production deployment, environment variables (Google client id/secret, JWT secret, token-encryption key, Supabase connection string, Pub/Sub topic name) are configured in the Vercel project, and both URLs above are reachable and correctly registered with Google/Pub/Sub against that deployment's URL.
