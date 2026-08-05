# Accounts, API keys & usage metering

Implementation of [issue #70](https://github.com/minerval-ai/minerval/issues/70):
one identity for users and contributors, dashboard-managed API keys, and a
per-token meter under every LLM call. #70 deliberately stopped short of
payments; [issue #309](https://github.com/minerval-ai/minerval/issues/309)
attached Stripe at the seam #70 left — purchased usage credits via Stripe
Checkout, enabled purely by configuration (see
[Billing & credits](#billing--credits-stripe)).

## One identity

A *user* (API consumer) and a *contributor* (graph editor) are the same
account: one row in `contributors`. The auth subject is
`contributors.external_id`, in the form `<provider>:<subject>`
(e.g. `github:12345`). Consumer concerns (keys, usage, credits) and
contributor concerns (reputation, kudos, good-faith standing — issue #71,
see [reputation.md](reputation.md)) hang off the same row.

```
 human ──► web sign-in (Auth.js: GitHub/Google OAuth)
              │  provision: POST /users/provision  (service key)
              ▼
        contributors row  (external_id = "github:12345")
              │                         │
        api_keys (hashed)          reputation / kudos (#71)
              │
        llm_usage rows  (per LLM call: agent, model, tokens, cost)
```

## Sign-in (web)

The Next.js app owns the human session via **Auth.js (next-auth v5)** with
OAuth providers only — we never store credentials, satisfying #70's "prefer a
hosted provider" constraint while keeping the API provider-agnostic. Enable
providers by setting env pairs (`AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET`,
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`); see `web/.env.example`.
Swapping to Clerk/WorkOS later would replace only `web/auth.ts` and `/signin` —
the API contract (`externalId` + `/users/provision`) is unchanged.

For local development a username-only "dev login" is available (never in
production builds); with no keys configured the API likewise runs a dev bypass
acting as the `dev:local` account, so the whole dashboard works with zero
setup.

## How a request authenticates (API)

Order of resolution in `src/server/plugins/auth.ts`:

1. **DB-backed key** (`x-api-key: epk_…`) — minted from the dashboard, stored
   as a SHA-256 hash, resolved to its owning user. `scope='service'` keys are
   first-party (the web BFF) and may additionally send
   `x-acting-user: <externalId>` to act on behalf of a signed-in user.
2. **Env key** (`API_KEYS` entries) — operator bootstrap keys, service-trusted.
   This is how the web frontend authenticates today.
3. **OAuth access token** (`Authorization: Bearer eoat_…`) — issued by the
   OAuth 2.1 flow for hosted MCP clients (see [mcp.md](mcp.md)); resolves to
   the consenting user, never service-trusted, and only accepted on `/mcp`
   (audience-bound to the surface the consent page describes).
4. **Dev bypass** — only when no keys are configured **and** not production.
   Production with no keys fails closed.

Trust levels, enforced by route guards:

| guard | meaning | example routes |
|---|---|---|
| `authenticate` | any valid key | writes (`POST /sources`, `POST /claims/propose`, …) |
| `requireUser` | a resolved account | `GET /users/me`, `GET /usage`, `GET /api-keys` |
| `requireSession` | service caller acting for a signed-in user (the dashboard) | `POST/DELETE /api-keys` — a leaked consumer key can never mint or revoke keys |
| `requireService` | first-party only | `POST /users/provision`, `GET /usage/system` |

Reads (`GET /claims…`, search, trees, jobs) remain open and free.

## The per-token meter

Every Anthropic call flows through `src/llm/client.ts`, which writes one
`llm_usage` row per call: agent, model, input/output/cache tokens, and a
derived `cost_micro_usd` (integer micro-USD, priced at insert time by
`src/llm/pricing.ts` so history keeps the rates in effect when spent).

Attribution rides in an `AsyncLocalStorage` context
(`src/llm/usage-context.ts`):

- **Routes** stamp the requesting user/key onto the job (`jobs.user_id`,
  `jobs.api_key_id`).
- **Workers** restore that into the context before running agents
  (`src/workers/url-extraction.ts`).
- **Agents** tag themselves (`withAgent("extractor", …)`) at their entry
  points, so any call site is attributed correctly.

**Attribution boundary:** user-initiated agentic work (extraction, matching
from `POST /sources` / `POST /claims/propose`) is billed to the requester.
Governance work — Steward assessment sweeps, Curator reconciliation, audits,
contribution review — is *system* usage (`user_id IS NULL`): the graph's
upkeep belongs to everyone, and good-faith contribution stays free (#71).

Usage is queryable per user/key/day/agent (`GET /usage`) and in aggregate for
ops (`GET /usage/system`, service-only).

## Free tier & quotas

- Non-agentic reads: free, unmetered, generous.
- Agentic endpoints carry the `requireAgenticQuota` guard:
  - a per-caller rate limit (`AGENTIC_RATE_LIMIT_PER_HOUR`, default 30/h,
    in-memory) as a runaway backstop, and
  - a monthly free-tier grant (`FREE_TIER_MONTHLY_USD`, default $5 of metered
    usage), then purchased credits (when billing is enabled). Both
    exhausted → `402 QUOTA_EXCEEDED` with the entitlement in the body and a
    pointer to the account page's buy-credits flow.

## Billing & credits (Stripe)

`src/services/billing-service.ts` defines the `BillingProvider` interface with
two implementations, selected by configuration exactly as #70 planned — no
call-site changes:

- **`FreeTierBillingProvider`** — active while `STRIPE_SECRET_KEY` is unset or
  a placeholder: monthly free grant only, purchases unavailable.
- **`StripeBillingProvider`** (#309) — active when the key looks real
  (`sk_…`): the same free grant first, then purchased credits.

**Credits are prepaid dollars, spent at metered usage rates** — derived model
cost times `USAGE_MARKUP_MULTIPLIER` (default 4), applied once at the metering
insert so the grant, credit burn, and dashboard all see the same billed
dollars. Raw provider cost is recoverable by dividing a usage row by the
multiplier in effect when it was written; changing the multiplier only affects
new rows. User-facing copy says "in proportion to the model work involved" and
deliberately does not name the rate. Grants live in
`credits_ledger` (micro-USD; positive = purchase/promo, negative = refund/
adjustment). Spend is *not* double-booked: `llm_usage.cost_micro_usd` already
prices every call, so `src/services/credit-service.ts` derives

```
balance = SUM(credits_ledger) − Σ_months max(0, month_usage − free_grant)
```

— the "credit accounting is a SUM" shape the seam was built for. The same
one-operation overshoot slack as the free tier applies at the credit floor.

**Purchase flow** (`src/routes/billing.ts`):

1. `POST /billing/checkout` (dashboard-session trust, like key minting)
   creates a Stripe Checkout Session for $5–$500 (configurable) and returns
   the Stripe-hosted payment URL; the buyer pays on Stripe's page.
2. Stripe calls `POST /billing/webhook` (signature-verified against
   `STRIPE_WEBHOOK_SECRET` over the raw body; no API key — Stripe is
   authenticated by the signature). A paid `checkout.session.completed` /
   `async_payment_succeeded` inserts a ledger grant, idempotently — the
   checkout-session id is unique, so Stripe's retries and duplicate success
   events credit exactly once.
3. `GET /billing/ledger` powers the dashboard's credit history; the balance
   rides on the entitlement in `/users/me` and `/usage`
   (`credit_balance_micro_usd`, `credits_enabled`).

Invoices/receipts stay on Stripe-hosted surfaces (enable receipt emails in the
Stripe dashboard). Refunds issued in the Stripe dashboard are *not* yet synced
automatically — record a negative `credits_ledger` row by hand (reason
`refund`) until a `charge.refunded` handler lands.

**Turning payments on** (per deployment):

1. Populate `episteme/stripe-secret-key` with the live (or test) secret key.
2. In the Stripe dashboard, add a webhook endpoint for
   `https://<api-host>/billing/webhook` subscribed to
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`;
   populate `episteme/stripe-webhook-secret` with its signing secret.
3. Force a new ECS deployment. A placeholder/missing key keeps everything in
   free-tier mode — the swap is pure configuration.

## Dashboard

`/account` on the web app: profile, free-tier meter, credit balance +
buy-credits flow and credit history (when billing is enabled), key management
(create/name/revoke — plaintext shown exactly once), usage by day / agent /
key, and contributor standing. `/signin` lists whichever providers are
configured.

## Operational notes

- Migration `0006_accounts_keys_usage` adds `api_keys`, `llm_usage`, the
  `contributors.email/avatar_url` columns and `jobs` attribution columns.
  Applied automatically at boot in production (like all migrations).
- Production keys live in Secrets Manager: `episteme/api-keys` (wired into
  ECS as `API_KEYS` by the CDK stacks; populate with
  `aws secretsmanager put-secret-value --secret-id episteme/api-keys
  --secret-string "<key>"` and force a new service deployment). The API fails
  closed in production without it.
- The web frontend needs: `MINERVAL_API_KEY` (the same value as an
  `episteme/api-keys` entry — the secret name is still the pre-rebrand one),
  `AUTH_SECRET`, and OAuth provider secrets in Vercel. The old
  `EPISTEME_API_KEY` name is still read as a fallback.
- Metering never fails a call: `meterLlmUsage` catches and logs. The
  in-memory budget tracker (process circuit breaker) is unchanged and
  independent.
