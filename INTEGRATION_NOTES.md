# Integration notes and unresolved external requirements

This file records how each external integration is wired, what was checked against provider
documentation, what is still **unverified**, and which approvals or credentials are required
before going live.

> **Documentation access during development (2026-10-08).** The build sandbox's network policy
> blocked direct access to `paystack.com`, `developers.facebook.com` and `resend.com`. Provider
> behaviour was checked through web search results that quote the official pages, plus
> third-party integration guides. Everything marked **VERIFY** below must be re-checked against
> the live official docs before launch.

---

## 1. Paystack (payments)

### What is implemented

| Concern | Implementation | Source status |
|---|---|---|
| Hosted checkout | `POST https://api.paystack.co/transaction/initialize` with server-controlled `email`, `amount` (integer kobo), `currency: NGN`, `reference`, `callback_url`, `metadata` → redirect to `authorization_url` | Confirmed (official docs, via search) |
| Split settlement | `subaccount: ACCT_…` (per-organization, admin-configured), `transaction_charge` (flat platform fee in kobo to the main account), `bearer: "subaccount" \| "account"` | `subaccount` + `transaction_charge` confirmed in official split-payments docs; `bearer` values confirmed by a third-party reference. **VERIFY** `bearer` values. |
| Verification | `GET /transaction/verify/:reference`; we check `status === "success"`, `reference`, integer `amount`, `currency`, `domain` (`live`/`test`), and `subaccount.subaccount_code` when present | **VERIFY** that `data.domain`, `data.subaccount.subaccount_code`, `data.fees` and `data.paid_at` are the current field names |
| Webhook signature | `x-paystack-signature` = hex HMAC-SHA512 of the **raw request body** keyed with the secret key; compared in constant time (`packages/core/src/adapters/payment.ts`) | Confirmed (official docs, via search). Sources disagree on whether a separate webhook secret exists. We use the secret key, as the official page states. |
| Webhook durability | Verified events go into `provider_events` (unique dedupe key) **before** we return 200, then a queue job or the sweeper processes them | Paystack retries non-200 responses (reported as every 3 min ×4 then hourly up to 72h in live). **VERIFY** |
| Events handled | `charge.success` (re-verified server-side, then fulfilled); `refund.pending/processing/processed/failed`; `charge.dispute.create/remind/resolve` | **VERIFY** refund and dispute payload field names. We read `data.transaction_reference` (falling back to `data.transaction.reference`) and `data.amount`. |
| Reconciliation | Worker re-verifies `PENDING` orders after 2 min, then every 5 min, and marks them `ABANDONED` after 24h unpaid | — |

**IP allow-listing** is not enforced; the signature is the authentication. Third-party guides
list Paystack's webhook IPs as `52.31.139.75`, `52.49.173.169` and `52.214.14.220`. **VERIFY**
these before adding a firewall rule in Caddy.

### Creator subscriptions (CommunityPass SaaS billing)

* Creators pay CommunityPass monthly: **Starter ₦5,000** (1 community, 100 active paid members,
  email only), **Growth ₦15,000** (3 communities, 500 members, WhatsApp reminders), **Pro ₦35,000**
  (unlimited). Every creator starts with a 14-day free trial, and no card is needed to start.
* The first payment is a hosted Paystack checkout restricted to `channels: ["card"]`, with **no
  subaccount**, so the money goes to the platform's own account. The card's reusable
  `authorization_code` is saved, and renewals use `POST /transaction/charge_authorization`.
  **VERIFY** the request and response fields of `charge_authorization` (`authorization_code`,
  `reusable`, `last4`, `exp_month`, `exp_year`, `brand`/`card_type`) and whether any Nigerian card
  types return `send_otp` or `pending` for recurring charges. Those cases are treated as not
  successful and retried.
* Renewals are charged at the end of the paid period, at most one attempt per period per daily
  retry slot (unique `renewalKey`). A charge whose outcome is unknown (timeout) is never repeated
  automatically; reconciliation verifies it by reference. Up to 4 attempts are made.
* If unpaid, creators get a 7-day grace period, then their pages stop taking member payments.
  Existing members keep the time they paid for. At the active-member limit, new members are
  blocked but current members can still renew.
* The authorization code is a provider token (not card data). It is stored server-side only
  and never returned by any API.

### Settlement model and fees

* One platform Paystack account. Each creator gets a Paystack **subaccount** that settles to
  their own bank account. In V1 a platform admin creates it in the Paystack dashboard or
  Subaccount API after checking the bank details, then records the `ACCT_…` code under
  **Admin → Organizations → Payment setup**.
* Creators never enter or see secret keys. The platform secret key lives only in
  `PAYSTACK_SECRET_KEY`.
* **Business model: creators keep 100% of member payments** (minus Paystack's own fee, borne by
  the subaccount). Keep `platformFeeBps = 0`; CommunityPass earns from the monthly subscription.
* The platform fee is explicit: `platformFeeBps` on the organization (default 0), sent as a flat
  `transaction_charge`. Who pays Paystack's processing fee is explicit too (`feeBearer`). Both
  are snapshotted on every order.
* Creator SaaS billing is recorded manually in `saas_billing_records`. It is never deducted
  from member payments.
* No automatic payouts, no wallets, no stored card data, no recurring charges.

### Approvals and credentials required (Paystack)

1. A Paystack business account for the **platform**, fully **activated for live payments**. This
   needs business verification and compliance documents (Nigerian registered business). **VERIFY**
   the current requirements with Paystack.
2. Confirmation from Paystack that the platform's use case is allowed: marketplace-style split
   payments to many creator subaccounts. **VERIFY** whether Paystack needs extra review or a
   contract for split payments / subaccounts at scale.
3. A KYC and onboarding process for each creator's settlement account. This is a policy
   decision: what the platform collects and who checks it.
4. Set the webhook URL in the Paystack dashboard to `https://<DOMAIN>/api/webhooks/paystack`,
   for both test and live.
5. Put `PAYSTACK_SECRET_KEY` in `.env`. `sk_test_…` gives test mode and `sk_live_…` gives live
   mode. The app refuses to fulfil a test-mode transaction when it runs with a live key, and the
   reverse.

---

## 2. WhatsApp Cloud API (official Meta API only)

### What is implemented

* **Sender:** one platform-owned WhatsApp Business number. Messages identify CommunityPass as
  acting for the named creator.
* **Sending:** `POST https://graph.facebook.com/{WHATSAPP_GRAPH_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages`
  with `type: "template"` only. No free-form messages, no bulk or broadcast features.
  **VERIFY** the current Graph API version; the default is `v23.0`.
* **Templates:** configured by a platform admin (purpose → name, language, category, status).
  Only `APPROVED` templates are used. A missing or unapproved template **suppresses** that
  message type and records the reason; it never falls back to free-form text.
* **Consent:** an explicit, unchecked opt-in at signup. Each consent stores the wording
  version, the full text, the timestamp, the scope (`membership_service`) and the source.
  Consent is re-checked **immediately before every send**.
* **Opt-out:** inbound `STOP`, `UNSUBSCRIBE`, `STOP ALL`, `OPT OUT`, `END`, `QUIT` and similar
  withdraw WhatsApp consent for every member record with that phone number (across all
  creators) and suppress queued WhatsApp messages. Paid memberships are **not** affected.
* **Webhooks** (`/api/webhooks/whatsapp`):
  * `GET` verification echoes `hub.challenge` only when `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`.
  * `POST` checks `X-Hub-Signature-256: sha256=<HMAC-SHA256(raw body, App Secret)>` in constant time.
  * Statuses `sent`, `delivered`, `read` and `failed` update the notification and only move
    forward, because webhooks can arrive out of order. `accepted` is the API's synchronous
    response, not a webhook.
  * Only routing and status data plus an opt-out flag are stored. Message bodies are not.
* **Rate limits and retries:**
  * The queue limiter is `WHATSAPP_SENDS_PER_SECOND`.
  * Throughput errors (`130429`, `131056`, `80007`, HTTP 429) retry with bounded exponential
    backoff (5 attempts).
  * Timeouts and unknown outcomes are flagged **Needs review** and are never resent
    automatically.
* **Disabled integration:** with `WHATSAPP_ENABLED=false`, WhatsApp notifications are
  suppressed with a recorded reason. Email still works.

### Template category and policy

Since 1 July 2025 Meta charges per delivered template message. Price depends on category
(`marketing`, `utility`, `authentication`) and the recipient's country. Utility templates must be
non-promotional and specific to a transaction or account. **All four CommunityPass templates are
designed as UTILITY**: they confirm a payment the user made, give access instructions for that
purchase, remind about expiry of that purchase, and notify expiry. Meta decides the final
category and may re-categorise or reject. **Do not assume approval.** Record whatever category
Meta assigns under Admin → Integration health.

Suggested template texts to submit. The variables match the order of `whatsappParams` in
`packages/core/src/messages.ts`.

| Purpose | Suggested name | Body |
|---|---|---|
| PAYMENT_CONFIRMATION | `cp_payment_confirmation` | `Hi {{1}}, we received your payment of {{2}} for {{3}} by {{4}}. Your membership is paid until {{5}} (Lagos time). This message is from CommunityPass on behalf of {{4}}. Reply STOP to stop these messages.` |
| ACCESS_INSTRUCTIONS | `cp_access_instructions` | `Hi {{1}}, welcome to {{2}}. Sign in to your member page to see how to join the WhatsApp group: {{4}}. {{3}} approves new members manually, so joining may take a little while. Reply STOP to stop these messages.` |
| RENEWAL_REMINDER | `cp_renewal_reminder` | `Hi {{1}}, your {{2}} membership ends on {{3}} (Lagos time). You can renew from your member page: {{4}}. Reply STOP to stop these messages.` |
| EXPIRY_NOTICE | `cp_expiry_notice` | `Hi {{1}}, your {{2}} membership expired on {{3}} (Lagos time). You can renew any time from your member page: {{4}}. Reply STOP to stop these messages.` |

The grace-period-ended notice reuses `EXPIRY_NOTICE`.

### Groups API: deliberately **not** integrated (capability-gated)

Meta's Groups API exists, but it is only open to businesses with an **Official Business
Account** and is limited to **8 participants per group** (official docs, June 2026, via search).
That makes it unsuitable for paid communities and unrelated to creators' existing groups. V1
group access is therefore fully manual:

* Creators approve join requests and remove members **in WhatsApp themselves**.
* Access status is labelled **"creator confirmed"** and is never shown as live sync.
* Invite links are private (shown only to signed-in, entitled members). They can be
  forwarded, so creators are told to turn on "Approve new members". Updating the link in
  CommunityPass does not reset it inside WhatsApp, and the UI says so.
* Any future Groups API work must sit behind an explicit capability flag per organization. It
  must use only documented endpoints, and fall back to the manual task queue whenever the
  capability is missing.

### Approvals and credentials required (WhatsApp)

1. A Meta Business portfolio for the platform with **business verification** completed.
2. A WhatsApp Business Account with a registered phone number dedicated to the Cloud API. A
   number used in the WhatsApp Business app needs migrating first. **VERIFY** current rules.
3. **Display name approval** for that number. **VERIFY** whether the name can reference
   "CommunityPass" with creator names only inside message text.
4. A **System User access token** with `whatsapp_business_messaging` and
   `whatsapp_business_management` permissions → `WHATSAPP_ACCESS_TOKEN`.
5. A Meta App with the WhatsApp product. The App Secret goes in `WHATSAPP_APP_SECRET`. Subscribe
   the webhook to the `messages` field. Callback URL is
   `https://<DOMAIN>/api/webhooks/whatsapp`, and the verify token is your `WHATSAPP_VERIFY_TOKEN`.
6. Approval of the four templates above.
7. Messaging-limit tier: new numbers start with a limited number of unique business-initiated
   recipients per 24h. **VERIFY** current tiers and plan the ramp-up.
8. A payment method on the WhatsApp Business Account (per-message billing).

---

## 3. Resend (email)

* `POST https://api.resend.com/emails` with `Authorization: Bearer RESEND_API_KEY`.
* An `Idempotency-Key` header carries the notification's dedupe key, so a retried send is not
  duplicated. **VERIFY** that Resend still supports this header and its key-length limits. If it
  doesn't, set `safeToRetry` to false for email in `ResendEmailAdapter` so ambiguous outcomes go
  to review.
* Used for magic links (never persisted or logged), receipts, access instructions, renewal and
  expiry notices, staff invites and the creator daily digest.
* Members control **email reminders**. Receipts are always sent because they are transactional.
  Missing WhatsApp consent is never treated as email marketing consent, and no marketing email
  exists in V1.

### Approvals and credentials required (Resend)

1. A Resend account and API key → `RESEND_API_KEY`.
2. **Domain verification:** add the SPF, DKIM (and optionally DMARC and return-path) DNS
   records Resend shows for your sending domain, then set `EMAIL_FROM` to an address on it,
   e.g. `CommunityPass <no-reply@mail.yourdomain.com>`.
3. `EMAIL_ENABLED=true`.

---

## 4. Demo mode (`APP_MODE=demo`)

* All adapters are deterministic mocks: no network calls, no real money, no real messages.
* Payments go through a clearly labelled **demo hosted checkout** page. They are stored with
  `provider = DEMO` and `isLive = false`, and are never shown as live verified transactions.
* Mock messages are written to `demo_outbox_messages` (Admin → Demo outbox) with sign-in tokens
  redacted.
* Deterministic failures for testing:
  * Phone ending `0999` or email starting `fail@` → permanent failure.
  * Phone ending `0998` or email starting `slow@` → ambiguous, flagged for review.
  * Phone ending `0997` or email starting `busy@` → rate-limited, then retried.
* Demo organizations (`isDemo`) can never take live payments, even if the platform later
  switches to live mode.
* Member sign-in in demo mode shows the one-time link on screen, because no email is sent.

---

## 5. Open product and legal items

* Privacy notice and membership terms are **placeholders** that need legal review, including
  against the Nigeria Data Protection Act 2023.
* Refund policy: refunds are processed in Paystack by the platform or creator. CommunityPass
  only records provider-confirmed refund status and opens a **review task**; it never removes
  paid time automatically.
* Plan switching and proration are not implemented. Switching plans is blocked while paid time
  remains.
* Settlement and payout reporting is not integrated. Dashboards say "collections", never
  "balance".
