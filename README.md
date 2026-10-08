# CommunityPass (MVP)

A mobile-first membership manager for Nigerian creators who run **paid WhatsApp communities**.

* Public signup pages
* Naira payments through Paystack hosted checkout
* Fixed-duration paid access (7 / 30 / 90 / 365 days)
* Renewal reminders
* A creator **task queue** for adding and removing people in WhatsApp
* Member self-service
* Full payment and messaging records

> **Status: MVP, not production-ready.** It builds, the automated tests pass, and the whole flow
> runs end to end in demo mode (also checked in a real browser and in Docker). Live Paystack,
> WhatsApp and Resend have **not** been exercised against real accounts. See
> [INTEGRATION_NOTES.md](INTEGRATION_NOTES.md) for unverified provider details and the approvals
> still needed.

## What it does and doesn't do

| Does | Deliberately does not |
|---|---|
| One-time payments, manual renewal; early renewal keeps remaining days | Auto-debit, wallets, card storage, automatic payouts |
| Activates **only** after server-side verification or a signed webhook | Trust browser redirects, query params or screenshots |
| Creates "add / remove / review" tasks; creator confirms each one | Add or remove people in WhatsApp (no unofficial APIs, bots or scraping) |
| Official WhatsApp Cloud API templates, only to opted-in members | Bulk or promotional messaging |
| Reminders 3d / 1d before expiry, on expiry, at grace end (Lagos sending hours) | Claim exactly-once delivery from providers that don't offer it |

## Architecture

```
communitypass/
├─ apps/web       Next.js 15 + Tailwind 4 (public pages, creator, member, admin UIs)
├─ apps/api       NestJS 11 REST API (auth, org-scoped endpoints, webhooks)
├─ apps/worker    BullMQ worker (delivery, reminders, expiry, reconciliation, digest)
├─ packages/core  Prisma schema + migrations + ALL domain logic + provider adapters
└─ packages/shared Zod schemas, membership/date math, formatting (used by web + server)
```

* **One fulfillment service** (`packages/core/src/services/fulfillment.ts`). Webhooks, the
  payment callback and reconciliation all call it. It:
  * locks the order row;
  * validates reference, kobo amount, currency, mode and subaccount against the order snapshot;
  * records the payment (unique provider transaction and reference);
  * locks the membership row;
  * applies `new_paid_until = max(current_paid_until, paid_at) + duration` exactly once (unique
    fulfillment record per payment and order);
  * updates access tasks and queues receipts, all in one transaction.
* **Database-enforced invariants** (see the migration):
  * payments are immutable (money and identity fields; no deletes);
  * fulfillment records and the audit log are append-only;
  * at most one open access task per type per membership;
  * plan durations are restricted to 7/30/90/365.
* **Tenant isolation:** the organization scope comes from the server-side session plus a
  verified staff membership. A client-supplied organization ID is never trusted.
* **Notifications** use a durable outbox:
  * Rows carry a unique dedupe key `org:membership:channel:type:paid_until`.
  * The worker claims due rows and re-checks state, consent, preferences, templates, sending
    window and daily cap right before sending, then records every attempt.
  * Ambiguous outcomes go to **Needs review**; nothing is blindly resent.

## Quick start (Docker, demo mode)

Requirements: Docker with Compose v2.24+.

```bash
cd communitypass
cp .env.example .env
#   edit .env: set POSTGRES_PASSWORD (anything for local). Leave APP_MODE=demo.
docker compose up -d --build
docker compose --profile demo run --rm seed      # isolated demo data (refuses unless APP_MODE=demo)
open http://localhost:3000
```

Demo accounts (password `demo-password-123`, demo only):

| Who | Login | Notes |
|---|---|---|
| Platform admin | `admin@communitypass.test` | Payment setup, integration health, failed jobs, reconciliation, audit, demo outbox |
| Creator A (owner) | `chioma@demo.communitypass.test` | Community `/c/fit-fam-lagos`: active, expiring, grace, expired and new-member scenarios |
| Creator A (staff) | `staff@demo.communitypass.test` | Staff role (no owner-only settings) |
| Creator B (owner) | `emeka@demo.communitypass.test` | Community `/c/lagos-tech-founders`; cannot see Creator A's data |
| Member (both creators) | `amaka@demo.communitypass.test` | Go to `/member/login`; demo mode shows a one-time sign-in link |

Try the flow:
1. Open `/c/fit-fam-lagos`, then Join, then the demo checkout, then "Simulate successful payment".
2. The callback page waits for server-side verification.
3. Sign in at `/member/login` to see access instructions.
4. Sign in as Chioma, open **Access tasks**, and click "I added them in WhatsApp".

## Local development (without Docker for the apps)

Requirements: Node 22, pnpm 10 (`corepack enable`), PostgreSQL 16, Redis 7.

```bash
cd communitypass
pnpm install
export DATABASE_URL=postgresql://communitypass:communitypass@localhost:5432/communitypass
export REDIS_URL=redis://localhost:6379 APP_MODE=demo WEB_BASE_URL=http://localhost:3000
pnpm build:packages            # shared + core (runs prisma generate)
pnpm db:migrate                # prisma migrate deploy
pnpm db:seed                   # demo data (APP_MODE=demo only)
pnpm dev:api                   # http://localhost:4000/api
pnpm dev:worker
pnpm dev:web                   # http://localhost:3000 (proxies /api to the API)
```

Create a new migration after editing `packages/core/prisma/schema.prisma` with
`pnpm db:migrate:dev --name <change>`. Hand-written SQL (triggers, partial indexes) lives at
the end of the initial migration.

## Tests

The tests run against a real PostgreSQL database (`communitypass_test` by default; override
with `TEST_DATABASE_URL`). The schema is migrated automatically.

```bash
createdb -O communitypass communitypass_test     # once
pnpm test               # shared unit + core integration + API HTTP tests
pnpm test:e2e-demo      # end-to-end demo lifecycle through the HTTP API + worker handlers
pnpm typecheck
```

Results at time of writing (2026-10-08): **62 tests passed, 0 failed.**
* `packages/shared`: 23 tests (date and duration math, grace boundaries, reminder planning,
  CSV injection, phone normalization).
* `packages/core`: 26 integration tests.
* `apps/api`: 12 HTTP tests.
* E2E demo: 1 test.

All packages typecheck and `next build` succeeds.

| Required test | Where |
|---|---|
| 1. Cross-tenant access denial | `apps/api/test/api.test.ts` "Cross-tenant access denial" |
| 2. Invalid webhook signatures | `packages/core/src/fulfillment.test.ts` and `apps/api/test/api.test.ts` (Paystack + Meta, over HTTP) |
| 3. Duplicate payment webhooks | `fulfillment.test.ts` "Duplicate webhooks" |
| 4. Webhook/callback race | `fulfillment.test.ts` "Webhook/callback race" (3 concurrent paths) |
| 5. Incorrect amount or currency | `fulfillment.test.ts` (amount, currency, non-integer kobo, subaccount, live/test mode) |
| 6. Concurrent early renewals | `fulfillment.test.ts` "Concurrent early renewals" |
| 7. Expired membership renewal | `fulfillment.test.ts` (renewal after removal → new grant task) |
| 8. Grace-period boundaries | `packages/shared/src/membership.test.ts` + `fulfillment.test.ts` (expiry evaluation at exact boundaries) |
| 9. Stale removal suppression after renewal | `fulfillment.test.ts` (pending removal cancelled; completion re-checks entitlement) |
| 10. Reminder deduplication | `packages/core/src/notifications.test.ts` |
| 11. Opt-out suppression of queued WhatsApp | `notifications.test.ts` (signed STOP webhook + consent re-check before send) |
| 12. Callback without verified success | `fulfillment.test.ts` + `api.test.ts` (spoofed query params) |
| 13. Month/year boundaries for fixed durations | `membership.test.ts` (31 Jan + 30d, Dec → Jan, leap year 365d) |
| E2E demo | `apps/api/test/e2e-demo.test.ts` |

Also tested:
* payments are immutable at the database level;
* invite links never appear in public responses and appear only for entitled members;
* magic links are single-use and hashed, with no enumeration;
* CSRF checks on token and origin;
* upload magic-byte validation;
* order snapshots survive plan edits;
* ambiguous sends are flagged rather than resent;
* bounded retries.

## Security notes

* **Sessions:** opaque random tokens in `HttpOnly`, `SameSite=Lax` cookies (`Secure` in
  production). Only SHA-256 hashes are stored. Staff sessions last 7 days, member sessions 14.
* **CSRF:** Origin check plus a double-submit token (`cp_csrf` cookie and `X-CSRF-Token`
  header) on every state-changing request. Webhooks use signatures instead.
* **Passwords:** argon2id (`@node-rs/argon2`, OWASP parameters).
* **Magic links:** 32 random bytes, SHA-256 at rest, 15-minute TTL, consumed atomically
  (single use). The token sits in the URL **fragment**, so it never reaches server or proxy
  logs.
* **Rate limiting:** `@nestjs/throttler` globally, with stricter limits on auth, magic-link and
  checkout routes.
* **Logs:** pino with redaction (cookies, tokens, signatures, bodies, invite links). Request
  logs record the path only.
* **Uploads:** PNG/JPEG/WebP, at most 2 MB, verified by magic bytes, random filenames, served
  with `nosniff`.
* **CSV exports** neutralise formula injection (`= + - @ TAB CR`).
* **Secrets:** environment variables only. Creators never handle Paystack keys.
* **Data minimisation:** no card data, NIN or ID documents are collected.
* **Audit log:** append-only, covering access, payment, configuration, export and consent
  changes.

## Deployment, backups, integrations

* VPS deployment, HTTPS, backups and restore: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
* Provider setup, unverified details and required approvals: [INTEGRATION_NOTES.md](INTEGRATION_NOTES.md)

## Known limitations / next steps

* Live provider integrations are untested against real accounts (see INTEGRATION_NOTES).
* Plan switching and proration are not implemented; switching is blocked while paid time
  remains.
* Refunds and disputes only open review tasks. Entitlement changes are manual.
* Settlement and payout data is not integrated.
* The backend Docker image ships dev dependencies, which makes it large (~1.7 GB uncompressed).
  Pruning it is a follow-up.
* Rate limits are in-memory per API instance. Use a Redis store before running more than one
  API instance.
* Legal pages are placeholders that need review.
