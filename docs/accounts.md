# Accounts, API keys, owls & usage metering

One identity for users and contributors (#70), dashboard-managed API keys, a
per-token meter under every LLM call — and the **owl**, the platform's unit
of account. One owl of spend covers one dollar of metered cost, one for
one; an owl SELLS for $4, and the platform's whole margin lives openly in
that purchase price (docs/allocation.md). Nothing has a fixed price:
quoted figures are caps and estimates that settle to metered cost.
Purchases go through Stripe Checkout in fixed packs with bulk discounts,
and accepted contributions EARN owls — one currency for spending and
recognition alike.

## One identity

A *user* (API consumer) and a *contributor* (graph editor) are the same
account: one row in `contributors`. The auth subject is
`contributors.external_id`, in the form `<provider>:<subject>`
(e.g. `github:12345`). Consumer concerns (keys, usage, credits) and
contributor concerns (reputation, owl awards, good-faith standing — issue
#71, see [reputation.md](reputation.md)) hang off the same row.

```
 human ──► web sign-in (Auth.js: GitHub/Google OAuth)
              │  provision: POST /users/provision  (service key)
              ▼
        contributors row  (external_id = "github:12345")
              │                │                │
        api_keys (hashed)   owl_ledger     reputation (#71)
              │             (the balance)
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
from `POST /sources` / `POST /claims/propose`) is attributed to the
requester. Governance work — Steward assessment sweeps, Curator
reconciliation, audits, contribution review — is *system* usage
(`user_id IS NULL`): the graph's upkeep belongs to everyone, and good-faith
contribution stays free (#71). The meter is **internal cost observability**;
what the user owes is the owl ledger, below.

Usage is queryable per user/key/day/agent (`GET /usage`) and in aggregate for
ops (`GET /usage/system`, service-only).

**Legacy balances (the credits→owls cutover).** Accounts created before the
owl ledger (migration 0028) held *credits*: a derived balance of purchases
minus metered usage billed at a markup. The cutover renamed that ledger in
place, which made two deliberate, accepted choices — recorded in migration
`0039_money_reconciliation.sql` and to be revisited before any production
run with material legacy balances: pre-cutover usage was **forgiven** (no
debit rows were backfilled), and surviving balances keep their **face value
in owls** (a revaluation, since an owl covers raw metered cost while a
credit covered marked-up cost). The write-off is bounded by the pre-launch
cohort's total prior usage.

## The owl: caps, free tier & quotas

Nothing has a fixed price: every operation is metered at cost-plus, and the
quoted figure is a **cap** — the most the run may cost, set near the
average so a button can carry one honest number. The cap is charged when
the work starts, and the unused fraction settles back to the balance when
the meter has the real cost (`meter_settlement` ledger rows); a run that
exceeds its cap is absorbed by the platform. The cap list lives in
`src/services/owl.ts` and rides on every entitlement and 402 body
(`caps_owls`), so the ceiling on everything is legible before anything is
spent (§15):

| operation | cap (default) | config |
|---|---|---|
| propose a claim (`POST /claims/propose`) | **up to 1 owl** | `CAP_CLAIM_PROPOSAL_OWLS` |
| order a claim assessment | **up to 1 owl** | `CAP_ASSESSMENT_OWLS` |
| submit a source (`POST /sources`) | up to 0.1 owl | `CAP_SOURCE_INGEST_OWLS` |
| extension page analysis | up to 0.1 owl | `CAP_EXTENSION_ANALYSIS_OWLS` |
| extension chat exchange | up to 0.1 owl | `CAP_EXTENSION_CHAT_OWLS` |
| MCP text tools (match/extract/assess) | up to 0.1 owl | `CAP_TEXT_ANALYSIS_OWLS` |

Open-ended operations (deep decomposition, grant mandates) are not capped
per run — they are funded with escrowed owl budgets and metered against
them (see below).

## Assessment orders — immediate paid work

`POST /claims/:id/order` (up to 1 owl) buys a Steward (re)assessment of a
claim. A paid order is a purchase, not a request: it fully funds the
action, and a fully funded action has nothing to wait for — the dispatcher
(`src/workers/order-pipeline.ts`) is checked first on every runner tick.
Semantics:

- **Cap-at-start, settle-at-finish.** The order is created uncharged; the
  cap is debited the moment the Steward run begins, and the metered cost
  settles against it at completion — the unused fraction returns. While
  `pending` the order cancels free (`DELETE /orders/:id`). A genuine run
  failure refunds automatically; a transient failure requeues the order
  with its charge intact (the retry never double-charges).
- **Money is cost-side only.** A purchase covers an action's cost on the
  ledger; it never enters any value estimate and never touches
  `claims.importance`: money buys scheduling, not epistemic standing.
- **Accepted claim proposals** create a proposal-funded order automatically
  (the claim_proposal charge rides along), so a paid proposal's claim runs
  as soon as its funded action dispatches (#284).
- The run is attributed to the ordering user (usage context userId +
  jobId=order id), so per-order cost is queryable from `llm_usage`.
- `GET /orders` (optionally `?claim_id=` for the claim page's poll),
  `GET /orders/:id`.

## Budget jobs — funded open-ended work

`POST /claims/:id/decompose` `{budget_owls}` funds DEEP DECOMPOSITION of a
claim's subtree. Open-ended work gets a budget, not a price:

- Funding escrows the owls immediately (`escrow_hold` behind the same
  balance guard as a charge) — that's the act of committing them.
- The worker (`src/workers/budget-job-pipeline.ts`) stewards the subtree one
  claim per tick: pending claims, and the 'deferred' stubs the economic
  brake (#98) held out — the funder is buying exactly that depth. New
  subclaims minted along the way become new targets.
- Spend is metered against real model work (`llm_usage` rows attributed
  with job_id). At the floor the job PAUSES (`paused_budget`) with a
  progress checkpoint and waits for a top-up
  (`POST /budget-jobs/:id/topup`); it never silently dies mid-run.
- Completion and cancellation (`POST /budget-jobs/:id/cancel`) refund the
  unspent remainder (`escrow_refund`).
- `GET /budget-jobs`, `GET /budget-jobs/:id` (live spend + checkpoint — the
  job page polls this).

This budget entity is the substrate grants build on.

## Grants — the granting conversation

People create grants by talking to the **Grantmaker agent**
(`/grant-conversations`, UI at `/account/grants/new`): the best available
model, running with the full constitution, surveys the scope, quotes
expected costs in owls, pushes back where judgment differs, and drafts a
mandate. Funding the draft (`POST /grant-conversations/:id/fund`) escrows
the budget and starts the grant with the mandate as its plan; nothing runs
or is charged before that. The Grantmaker works for the integrity of the
graph and declines mandates that attempt to steer conclusions, at any
budget. Mandate plans mix `assess`, `reassess`, `deepen`, and `ingest`
items. A live mandate executes through the action ledger
(docs/allocation.md): planning runs, its Grantmaker's periodic review
passes, and ingest items are self-funded ledger actions run by the engine
executor (`src/workers/engine-executor.ts`); plan claim items and the
'deepen' policy run direct steward passes (`src/workers/grant-pipeline.ts`);
'cover'/'maintain' mandates spend through their own valuations and daily
allocator. Mandates also fund each other as peers (regrants) and can spawn
new mandates with their own Grantmakers. Direct `POST /grants` (scope +
policy + budget) remains for service/operator tooling.

Every
assessment a mandate produces is stamped with `funded_by_job_id` — disclosed at
the bottom of the claim page as scheduled by "a funded mandate", together
with the explanation that funding buys scheduling, never conclusions or
graph membership. Funder-chosen names never appear on claim surfaces.
Pause/top-up/refund semantics are the budget job's:
`POST /grants/:id/topup`, `POST /grants/:id/cancel`, dashboards on
`GET /grants/:id` (spend, plan, the assessments the grant bought).

**Free tier:** a one-time signup grant of 5 owls (`SIGNUP_GRANT_OWLS`) — "see
a claim you care about, get it assessed" ×5 — plus a 1 owl/month trickle
(`MONTHLY_GRANT_OWLS`). Both are lazy, idempotent ledger grants
(`signup:<user>` / `monthly:<user>:<YYYY-MM>` idempotency keys) written by
whichever entitlement read sees the user first.

**Quota gate** (`src/server/plugins/quota.ts`): agentic endpoints carry
`requireAgenticQuota(op)`:

- a per-caller rate limit (`AGENTIC_RATE_LIMIT_PER_HOUR`, default 30/h,
  in-memory) as a runaway backstop;
- an affordability **check** (balance ≥ the operation's cap) before any
  work — otherwise `402 INSUFFICIENT_OWLS` with the cap, balance, cap
  list, and packs in the body;
- the **charge**, taken only when the operation actually starts (after
  validation, right before the LLM work — `chargeAgenticOp` /
  `withAgenticCharge`), never at request arrival. A failure after the charge
  refunds; an extension-analysis cache hit refunds; an intake REJECTION of a
  charged proposal refunds automatically (good-faith submission is free,
  #71).

Service traffic with no acting user is system work and exempt from pricing.

## The owl ledger

`owl_ledger` is the one spendable balance: every earn and spend is an
explicit signed row in face-value micro-USD, and

```
balance = SUM(owl_ledger.amount_micro_usd)
```

Reasons: `purchase`, `signup_grant`, `monthly_grant`, `contribution_award`,
`charge`, `meter_settlement` (the unused fraction of a charged cap,
returned after the meter ran), `refund`, `escrow_hold`/`escrow_refund`
(budgeted jobs), `admin_adjust`. Charges carry the operation (`op`) and
link to the claim or contribution they paid for, so the account history
reads as "up to 1 owl held for the assessment of claim X, 0.6 returned".
Charges are balance-guarded single-statement inserts; two racing requests
can overshoot by at most one operation each (the same slack the metered
era accepted). Settlements are idempotent per settle key.

**Earning owls (#71):** an accepted contribution awards importance-scaled
points (1–5, the old kudos rule) × `CONTRIBUTION_AWARD_OWL_PER_POINT`
(default 0.25 owl), with a +2-point bonus for acceptances that survive appeal
scrutiny. The leaderboard (`GET /contributors`) ranks **lifetime owls
earned** (`contributors.owls_earned_micro_usd`) — purchases never move it and
spending never lowers it. Audit supersession claws awards back.

## Buying owls (Stripe)

Purchases are enabled when `STRIPE_SECRET_KEY` looks real (`sk_…` or a
restricted `rk_…` — `stripeConfigured()`); a placeholder keeps the deployment
on free grants only. Production should use a restricted key scoped to
Checkout Sessions: Write, the only Stripe API call the integration makes. Owls are sold in fixed packs with bulk discounts (`OWL_PACKS`,
default `5:2000,15:5500,40:14000,125:40000` as owls:cents — $20 face value
up to 20% off at 125 owls):

1. `GET /billing/packs` (public) lists the packs.
2. `POST /billing/checkout` (dashboard-session trust, like key minting)
   takes a `pack_id` and returns the Stripe-hosted payment URL.
3. Stripe calls `POST /billing/webhook` (signature-verified against
   `STRIPE_WEBHOOK_SECRET` over the raw body). A paid
   `checkout.session.completed` / `async_payment_succeeded` credits the
   pack's owls at their $1-of-spend value — a bulk discount is cheaper cash
   for the same owls, not fewer owls — idempotently via the
   `stripe:<session_id>` idempotency key.
4. `GET /billing/ledger` powers the dashboard's owl history; the balance and
   cap list ride on the entitlement in `/users/me` and `/usage`.

Owls are strictly one-way: bought or earned, then spent — never redeemable
for cash. Invoices/receipts stay on Stripe-hosted surfaces. Refunds issued in
the Stripe dashboard are *not* yet synced automatically — record a negative
`owl_ledger` row by hand (reason `admin_adjust`) until a `charge.refunded`
handler lands.

**Turning payments on** (per deployment):

1. Populate `episteme/stripe-secret-key` with the live (or test) secret key.
2. In the Stripe dashboard, add a webhook endpoint for
   `https://<api-host>/billing/webhook` subscribed to
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`;
   populate `episteme/stripe-webhook-secret` with its signing secret.
3. Force a new ECS deployment. A placeholder/missing key keeps everything in
   free-tier mode — the swap is pure configuration.

## Dashboard

`/account` on the web app: profile, owl balance with the caps list, pack
purchase flow (when billing is enabled) and the itemized owl history, key
management (create/name/revoke — plaintext shown exactly once), usage by
day / agent / key (cost observability), and contributor standing including
owls earned. `/signin` lists whichever providers are configured.

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
