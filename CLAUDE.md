# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A data liberation sync engine: it extracts a user's Gmail data via OAuth2 into Supabase (Postgres), stays current in real time via Gmail Pub/Sub push notifications (no polling), and exposes that data over a REST API under `/api/v1`. Deployed as Vercel serverless functions.

The full functional/API spec lives in `CONTRACT.md` — read it before implementing any endpoint, the data model, or the sync logic; it is the source of truth for request/response shapes and error codes, not this file. `BUILD_SEQUENCE.md` lists the atomic build order and each unit's verification criterion.

## Stack

Node 20, TypeScript (strict mode), Express, `googleapis`, `@supabase/supabase-js`, Jest + `supertest`, deployed via Vercel.

## Commands

No `build`, `lint`, or working `test` script exists yet in `package.json` (the placeholder `test` script just exits with an error) — add real ones as the corresponding tooling is wired up. Until then, run tools directly:

```bash
npx tsc --noEmit          # typecheck (no build script defined yet)
npx jest                  # run the full test suite
npx jest path/to/file.test.ts        # run a single test file
npx jest -t "test name"              # run tests matching a name
npx vercel dev             # run the app locally against the Vercel Functions runtime
npx vercel --prod          # deploy to production
```

`ts-jest` is the Jest transform for TypeScript; `supertest` is available for HTTP endpoint testing.

**Peer dependency note:** `typescript` is pinned to `^6.0.3` even though 7.x is npm's `latest` — `ts-jest` (currently up to 29.4.12) only supports `typescript >=4.3 <7`. Don't bump `typescript` to 7.x until a `ts-jest` release supports it, or the install will fail on a peer conflict.

## The two-session architecture

This repo is built across two sessions with disjoint ownership:

- **Server logic session** — works on `main`, owns `src/` and `api/`: Express route handlers, Google OAuth code-exchange + token encryption, Gmail API integration (initial sync, `users.watch()`, `users.history.list` processing, sending, label updates), JWT issuance/verification, and a data-access layer defined as an interface backed by a **mocked/in-memory implementation**.
- **Schema session** — works on the `schema` branch, owns `migrations/` and `types/`: the real Supabase SQL migrations for `users`/`messages`, wiring them into the data-access interface the server logic session defined (replacing the mock).

**Sequencing rule:** the schema session cannot be merged until the server logic session's tests pass (`npm test` exits 0) on `main`. Don't start reviewing or merging schema-branch work against a red or unverified `main`.

When implementing data access, always code against the interface/abstraction — never assume a concrete Supabase implementation is wired up unless the schema session has actually merged.

## Never-do rules

- Never use `any` as a TypeScript type.
- Never poll the Gmail API for new messages — use Pub/Sub push webhooks.
- Never store OAuth tokens in plaintext.
- Never make Gmail API calls without going through the `googleapis` OAuth2 client — it handles token refresh automatically; hand-rolled token handling will drift and silently break refresh.
- Never write to `src/db/` from the schema session — that's server-logic-session-owned code; the schema session's job is `migrations/` and `types/`.
- Never merge the schema session before `npm test` exits 0.
- Never hardcode credentials.

## Coding conventions

- All errors use the `CONTRACT.md` error envelope shape (`{ error: { code, message } }`), status code carries the category. Every auth-failure code is typed and must map to a specific recoverable client action (redirect to login vs. re-run OAuth) — never let an auth failure fall through to a raw/untyped 500. Reuse the exact `code` strings from `CONTRACT.md` Section 7 rather than inventing new ones.
- Cursor-based pagination on all list endpoints.
- `/api/v1` is the base path on all client-facing endpoints.
- JWT Bearer token authentication is required on every endpoint except the OAuth callback.
- The Pub/Sub webhook endpoint lives at `/webhook/gmail`, not under `/api/v1`.

## Real-time sync model — no polling, ever

New mail arrives exclusively through the Gmail Pub/Sub push webhook, never through a polling loop. The flow, detailed in `CONTRACT.md` Section 5:

- **Initial sync** (inside the OAuth callback): fetch the 50 most recent messages via `users.messages.list` + `users.messages.get`, insert as `direction: "inbound"`, then call `users.watch()` and persist the returned `historyId`/`expiration` on the user row (`lastHistoryId`, `watchExpiration`).
- **Ongoing sync**: each Pub/Sub push carries `{ emailAddress, historyId }`. The handler resolves the user, calls `users.history.list(startHistoryId = lastHistoryId)`, inserts newly-added messages, applies `UNREAD` label add/remove as local `isRead` flips, and advances `lastHistoryId`.
- **Watch renewal**: Gmail requires `users.watch()` to be re-issued at least every 7 days (`watchExpiration`); the contract leaves the exact scheduling mechanism (e.g. Vercel Cron) as an implementation detail.
- **Read-state sync is bidirectional**: app→Gmail via the mark-as-read endpoint (`users.messages.modify`), Gmail→app via the Pub/Sub history processing above.
- An `emailAddress` in a push notification that matches no known user must be **acked with 200** (no-op), not 404 — otherwise Pub/Sub retries indefinitely.

## Data model

`users` and `messages` table shapes, including which fields are internally generated vs. sourced from Gmail API responses (and how, e.g. `isRead` is derived from `NOT ("UNREAD" IN labelIds)`), are fully specified in `CONTRACT.md` Section 4. Token fields (`googleAccessToken`, `googleRefreshToken`) must be encrypted at rest (e.g. AES-256-GCM) — never persisted in plaintext.

## Repo layout

- `src/` — application source (`cron/`, `db/`, `middleware/`, `providers/`, `send/`, `sync/`, `types/`, `webhook/`); currently empty scaffolding.
- `api/` — Vercel Functions entry points (`cron/`, `v1/`, `webhook/`); currently empty scaffolding.
- `tests/` — `integration/` and `unit/`; currently empty scaffolding.
- `tsconfig.json` compiles `src/**/*` and `api/**/*` only (`rootDir: ./src`, `outDir: ./dist`), target ES2020/CommonJS, `strict: true`.
