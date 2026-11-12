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
   `x-acting-user: <externalId>` to act on behalf of a signed-in user, never
   on behalf of the platform account (`PLATFORM_NOT_ACTABLE`).
   `scope='platform_grantmaking'` keys resolve to the platform account
   (`platform:minerval`) and are accepted only on `/grant-conversations`,
   never on `/fund`. They're minted with the operator key and hold the
   platform's granting conversations (docs/allocation.md, "Platform
   mandates", #529).
2. **Env key** (`API_KEYS` entries) — operator bootstrap keys, service-trusted.
   This is how the web frontend authenticates today.
3. **OAuth access token** (`Authorization: Bearer eoat_…`) — issued by the
   OAuth 2.1 flow for hosted MCP clients (see [mcp.md](mcp.md)); resolves to
   the consenting user, never service-trusted, and only accepted on `/mcp`
   (audience-bound to the surface the consent page describes). MCP's route
   tools reach the REST routes they mirror by in-process dispatch, carrying
   the identity `/mcp` resolved, not the token ([mcp.md](mcp.md)).
4. **Dev bypass** — only when no keys are configured **and** not production.
   Production with no keys fails closed.

Trust levels, enforced by route guards:

| guard | meaning | example routes |
|---|---|---|
| `authenticate` | any valid key | writes (`POST /sources`, `POST /claims/propose`, …) |
| `requireUser` | a resolved account | `GET /users/me`, `GET /usage`, `GET /api-keys` |
| `requireSession` | service caller acting for a signed-in user (the dashboard) | `POST/DELETE /api-keys` — a leaked consumer key can never mint or revoke keys |
| `requireService` | first-party only | `POST /users/provision`, `GET /usage/system` |
| `requireOperator` | the operator key, held outside the web deployment | the prize routes: bounty confirmation, prize-claim sign-off, void, screening, owl grant, check retry, and the operator page (below); and the platform-mandate routes: funding a pinned draft (`POST /operator/platform-mandates/fund`) and minting, listing and revoking platform-grantmaking keys (`/operator/platform-grantmaking-keys`); and the deployment's preflight (`GET /setup/preflight`, docs/deployment.md), which moves no money but reports the deployment's configuration |

Reads (`GET /claims…`, search, trees, jobs) remain open and free.

**The operator key.** The service key is deployed to the web tier and acts
for any user through the acting-user header, so it cannot be the
credential that moves money. Seven routes require a separate operator key
(`MINERVAL_OPERATOR_KEY`), held outside the web deployment and used only
from the operator's own session: the bounty confirmation
(`POST /bounties/:id/confirm`), the prize-claim sign-off
(`POST /prize-claims/:id/sign-off`), the void
(`POST /prize-claims/:id/void`), the sanctions screening
(`POST /prize-claims/:id/screening`), the owl grant
(`POST /prize-claims/:id/pay`), the release of a `check_error` hold
(`POST /prize-claims/:id/retry-check`), and the operator page
(`GET /operator/prizes`). Three further routes act for a winner and
require both the dashboard session and a one-time code bound to the claim,
the account, and the purpose, issued to the owner's own session by
`POST /prize-claims/:id/code` (email delivery is a transport change): the
payee step (`POST /prize-claims/:id/payee`), the tax form
(`POST /prize-claims/:id/attachments`), and the withdrawal of a claim
(`POST /prize-claims/:id/withdraw`), so a leaked consumer key or service
key alone can neither redirect a prize nor abandon a winning claim. Every
call to a writing route among these is written to `audit_log` on the claim
with the credential kind and the acting person (`prize_route:*`). There is
no deposit route: a prize is owls held against the escrow of the mandate
that posted it. A platform mandate's escrow is funded either by the seed
(`scripts/seed-platform-mandates.ts`, for the standing mandates) or by
`POST /operator/platform-mandates/fund`, which the Platform mandates
workflow calls with the operator key (held in GitHub secrets) once a
merged pull request pins the Grantmaker's draft (#529). The service key
alone moves no money.

## Members-only deployments

Everything above describes a deployment anyone may read, which is the public
graph and the starting point of every deployment. One setting changes that:
`READS`. At `open`, its starting value, nothing in this section applies and
no code in it runs. At `members` the deployment is private:

- **Nothing is served to anyone who is not signed in.** One hook
  (`src/server/plugins/members-only.ts`) authenticates every request before
  its route runs, so a route added later is closed without anyone
  remembering to close it. The dev bypass does not exist here, whatever the
  environment.
- **What a signed-in person may do follows from their permissions**, which
  the deployment's own administrators grant (`src/permissions.ts`).
- **A member is an account with at least one live grant.** An account that
  has signed in and holds none is served only who it is (`GET /users/me`)
  and what it holds (`GET /permissions/mine`), which is how the web app
  tells the person they have no access yet and shows the identity an
  administrator will know them by.

What stays reachable without being a signed-in member is written out in
that file and nowhere else:

| who | routes | why |
|---|---|---|
| anyone | `GET /health` | the load balancer's liveness probe |
| anyone | `GET /.well-known/oauth-authorization-server[/mcp]`, `GET /.well-known/oauth-protected-resource[/mcp]`, `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token` | how an MCP client signs in: these have to be reachable before there is a credential. None reads the graph; approving a client still takes a signed-in member on the consent page |
| a credential of the route's own | every route that takes the operator key; `POST /billing/webhook` (Stripe's signature) | each checks its own credential, as before |
| the web tier's service key, nobody named | `POST /users/provision` | creates or refreshes the account when a person signs in |
| any signed-in account | `GET /users/me`, `GET /permissions/mine` | so a person with no grant can be told so |

A CORS preflight is answered, with headers and no content. Everything else,
a request for an address that does not exist included, answers `401
SIGN_IN_REQUIRED` to a request with no credential or with a key that acts
for no person, and `403 NOT_A_MEMBER` to an account that holds no grant.

### Permissions

Six permissions, each granted on its own, to an account or to a group the
identity provider names. One person may hold several, and nothing in the
code decides who should hold which.

| permission | held | lets its holder | never lets anyone |
|---|---|---|---|
| `direct` | | open a mandate and shape it with its Grantmaker, approve its plan, ask a mandate's Correspondent for an update, add sources | edit an assessment or a run's log |
| `release` | for one party | release or hold what would leave the deployment of that party's material (publishing outward is not built; the grant records who holds the gate) | edit what the agents wrote, or release another party's material |
| `fund` | | put owls behind work: fund a drafted mandate, add to a mandate or a funded job, back a mandate, order or fund work on a node or a request | decide what the work concludes |
| `read` | at one label | read what the agents wrote at that label and at the labels it reads | change anything the agents wrote |
| `read_sources` | at one label | open the sources themselves at that label | change a source |
| `administer` | | grant and remove permissions, define labels and which reads which, add parties, say whose material a source is | act under a permission they have not also been granted, or change who may do what without a log entry |

A request's **standing** is resolved once, when it arrives: the live grants
that reach its account (its own, and those made to a group its latest
sign-in carried), and its **clearance**, the labels it may read: `public`,
each label a `read` grant names, and every label those read, following
`label_reads` to the end. The clearance is on the request's async context
(`currentClearance()` in `src/llm/usage-context.ts`). Nothing holds a read
to it yet: that is the database's work and comes separately. Until it does,
`read` and `read_sources` grants are recorded and resolved and change
nothing a member is served.

The routes a permission guards, in each mode (`requirePermission` in
`src/server/require-permission.ts`; the list is asserted in
`tests/db/members-only.test.ts`):

| route | open (the public graph) | members-only adds |
|---|---|---|
| `POST /grant-conversations`, `POST /grant-conversations/:id/messages`, `POST /grants/:id/approve`, `POST /correspondents/:id/poke` | an account | `direct` |
| `POST /sources` | any valid key, and the owl charge | `direct` |
| `POST /grant-conversations/:id/fund`, `POST /grants/:id/topup`, `POST /mandates/:id/contribute`, `POST /claims/:claim_id/order`, `POST /claims/:claim_id/contribute`, `POST /claims/:claim_id/decompose`, `POST /requests/:request_id/contribute`, `POST /budget-jobs/:id/topup` | an account, and the owls | `fund` |
| `POST /grants` | a direct service caller | `direct` and `fund` |
| the routes for permissions, parties and labels (below) | not mounted | `administer`, and a signed-in session for every write |

Taking money back asks for no permission in either mode: withdrawing from a
mandate, cancelling a grant, a job or an order. A funder may take back
their share at any time (constitution §19), and a permission removed later
must not stand between a person and their own owls. Proposing, contributing
and appealing ask for none either: any member may.

An MCP caller is not offered a tool whose route needs a permission its
account lacks, and is told which and why: the Assistant in its brief
(`src/llm/permissions-note.ts`), an outside client in the server's
instructions.

### Granting, and the log

Mounted only where `READS=members`:

| route | who | |
|---|---|---|
| `GET /permissions` | a member | what each permission covers |
| `GET /permissions/mine` | any signed-in account | what the account holds, its clearance and groups |
| `GET /permissions/log` | a member | every grant, removal and administrative change, newest first |
| `GET /permissions/grants`, `GET /permissions/accounts`, `GET /parties`, `GET /labels` | `administer` | who holds what now; the accounts with their groups; the parties; the labels |
| `POST /permissions/grants`, `DELETE /permissions/grants/:grant_id` | `administer`, from a signed-in session | grant; remove |
| `POST /parties`, `PUT /sources/:source_id/party` | `administer`, from a signed-in session | add a party; say whose material a source is |
| `POST /labels`, `POST /labels/:label/reads`, `DELETE /labels/:label/reads/:reads` | `administer`, from a signed-in session | define a label; say or take back that one label reads another |
| `POST /operator/administrators` | the operator key | grant `administer` to an account, by its sign-in identity |

Every write takes a signed-in session, as minting an API key does, so a
leaked key, an access token, or an agent following text it read can never
widen what anyone may read or release. For the same reason the writes are
not MCP tools; the reads are.

`permission_grants` is state and log in one. A row is a grant; removing it
marks the same row with who removed it and when; no row is deleted. The
other administrative acts (a label defined, a pair of labels added or
removed, a party added, a source's party set) each write a row to
`administrative_events` in the same transaction as the change. The last
live grant of `administer` cannot be removed.

The log is open to every member, because who holds power over a graph is
part of what its readers weigh. People appear by display name. The name of
a label the reader is not cleared for, or of a party that is neither the
organization itself nor one the reader holds `release` for, is replaced by
`{"withheld": true}`: a deployment may hold material from parties who are
not to learn of each other. That an act happened, who did it, to whom and
when is always shown.

### The first administrator

Set `FIRST_ADMINISTRATOR` to the sign-in identity of the person setting the
deployment up (`<provider>:<subject>`, for instance `oidc:00u1abcd`). The
first time that person signs in, while the deployment has never had an
administrator, they are granted every permission: `direct`, `fund` and
`administer`, `read` and `read_sources` at each label that exists besides
`public`, and `release` for each party that exists. The grants are rows
like any other, marked as made by the setting. From then on they hand
permissions out, to themselves included when they define a new label.

The setting works once. Once any administrator has existed, removed ones
included, it does nothing whatever it says, so a person the administrators
later removed cannot return by signing in, and a stale setting grants no
one anything. A person does not need to know their identity in advance:
anyone who signs in and holds nothing is shown their own.

If a deployment loses its administrators (the only one can no longer sign
in, or the only grant went to a group nobody is in), the way back is the
operator key: `POST /operator/administrators`. It grants `administer` and
nothing else, and the grant is marked as made with the operator key.

### Single sign-on and groups

The web app signs people in through the organization's own identity
provider, any that speaks OpenID Connect: `AUTH_OIDC_ISSUER`,
`AUTH_OIDC_ID` and `AUTH_OIDC_SECRET` in the web app's environment
(`web/.env.example`), with `<site>/api/auth/callback/oidc` registered at
the provider. The API never talks to the provider. An account's identity
is `oidc:<subject>`, and it is created the first time the person signs in,
holding nothing.

The provider's groups reach the API with the sign-in: the web app reads
them from the ID token (the `groups` claim, or the one
`AUTH_OIDC_GROUPS_CLAIM` names) and passes them when it provisions the
account, where they replace the account's rows in `account_groups`. A grant
made to a group reaches every account whose latest sign-in carried it.

The API learns that a person has left a group only from their next sign-in,
so a sign-in vouches for its groups for a limited time:
`SIGN_IN_VALID_HOURS`, 12 by default. After that the groups count for
nothing until the person signs in again, and the web app ends a session at
the same age, so someone at work is sent back through the provider before
their groups lapse. Grants made to an account directly do not lapse; an
administrator removes them.

### The web app

The web app reads the same setting (`READS=members`, set where it runs and
when it is built). It then asks every visitor to sign in, sends who is
reading on every read (`x-acting-user`), keeps no copy of a read to share
between readers, and never falls back to the design fixtures: a read that
is refused or fails shows nothing. Started as members-only on a build made
without the setting, it serves nothing and its log says why, because pages
prepared at build time would otherwise be served without a sign-in
(`web/instrumentation.ts`). Whatever the web app believes, a read the API
refuses as members-only is never answered from a fixture.

The gate stands in for every page until the visitor is a signed-in member,
and each page is still rendered behind it: what a visitor who is not signed
in receives carries the page's empty frame, with no read behind it
answered. Stopping the render itself needs the web app's pages to sit under
a layout that can turn a visitor away, which comes with the private web
shell.

To run one locally: set `READS=members` and an `API_KEYS` entry on the API
(there is no dev bypass), the same key and `READS=members` on the web app,
and sign in with the development login, whose identities read
`dev:<username>`.

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
requester. Governance work — Steward assessment sweeps, contribution
review — is *system* usage (`user_id IS NULL`): the graph's upkeep belongs
to everyone, and good-faith contribution stays free (#71). Curator
reconciliation and audits are funded ledger actions (#363), so their spend
lands on the mandate that chose to buy them (usually the platform's own
General mandate) rather than on the contributor or on
nobody. The meter is **internal cost observability**;
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
| propose a claim (`POST /claims/propose`) | **up to 2 owls** | `CAP_CLAIM_PROPOSAL_OWLS` |
| order a claim assessment | **up to 2 owls** | `CAP_ASSESSMENT_OWLS` |
| submit a source (`POST /sources`) | up to 0.1 owl | `CAP_SOURCE_INGEST_OWLS` |
| extension page analysis | up to 1 owl | `CAP_EXTENSION_ANALYSIS_OWLS` |
| extension chat exchange | up to 0.1 owl | `CAP_EXTENSION_CHAT_OWLS` |
| MCP text tools (match/extract/assess) | up to 0.1 owl | `CAP_TEXT_ANALYSIS_OWLS` |

A page analysis's cap is above its average run on purpose: it is also the
run's budget, which the Extractor is told and which pays for matching every
claim it records, so it is sized for a long page. A typical page settles back
well under it.

Open-ended operations (deep decomposition, grant mandates) are not capped
per run — they are funded with escrowed owl budgets and metered against
them (see below).

## Assessment orders — immediate paid work

`POST /claims/:id/order` (up to 2 owls) buys a Steward (re)assessment of a
claim. The buyer's cap is not the pass's budget: the Steward works to
`PAID_ASSESSMENT_BUDGET_OWLS` (default 5), and the platform absorbs
whatever the run costs above the cap. A paid order is a purchase, not a request: it fully funds the
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

## Deep decomposition — a mandate on one claim

`POST /claims/:id/decompose` `{budget_owls}` (5 owls or more) funds a
DECOMPOSITION of a claim: a mandate on it, funded and started in one step
(`src/services/claim-mandate-service.ts`; docs/allocation.md, "Deep
decomposition: a mandate on one claim"). The owls escrow at once; its
Grantmaker plans the work, which opens with a fresh pass on the claim and
then buys the claims that bear on it, on the ledger. A tenth of the budget
pays for the Grantmaker's own passes; the rest refunds when the work is
done. The mandate is public and shows its funder as "a reader". A balance
that cannot cover it sends the reader to the owl packs, and checkout brings
them back to the claim (`return_to` on `POST /billing/checkout`).

## Budget jobs — funded open-ended work

Decompositions funded before they became mandates ran as budget jobs, and
any still running finish that way. Open-ended work gets a budget, not a
price:

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
or is charged before that. The draft carries the mandate's pace, agreed
with the funder: as needed (the escrow is the only bound, the default) or
steady (at most so many owls committed in any rolling window), which only
the funder changes afterwards (docs/allocation.md, "Pace and reserve").

The Grantmaker replies in the background. Sending a message saves it and
returns at once with the message's place (`message.index`,
`message_count`), the draft's hash (`mandate_sha256`) and
`turn.state: "replying"`, not the transcript (#905); the reply lands in the
conversation when the turn finishes (a drafting turn can take minutes,
streamed so it has the model's full output for the plan). Callers read
`GET /grant-conversations/:id?after=<message_count>&mandate_sha256=<hash>&wait=25`
until the turn is `idle`, or `failed` with `turn.error` (the message stays
saved; a short follow-up asks again). `after` returns only the messages
after those the caller holds; `mandate_sha256` leaves the draft out
(`mandate_unchanged: true`) while it still hashes the same; `wait` holds
the read up to 25 seconds for the turn to end, well under the load
balancer's idle timeout. With no parameters the read is the whole
conversation. Funding returns the new `grant_id`, and the conversation list
returns one summary per conversation (title, status, message count, turn),
not transcripts.
One turn runs at a time: a message sent meanwhile is refused with
`TURN_IN_PROGRESS` and not saved, and the draft can't be funded until the
turn ends, since it may still revise it. A running turn refreshes a
heartbeat, and one whose process died (a deploy, a crash) reads as `failed`
and can be taken over by the next message. The Grantmaker works for the integrity of the
graph and declines mandates that attempt to steer conclusions, at any
budget. Mandate plans mix `assess`, `reassess`, `deepen`, and `ingest`
items. A live mandate executes through the action ledger
(docs/allocation.md): planning runs, the sittings of its Grantmaker's
session, and ingest items are ledger actions the mandate commissions
itself, run by the engine
executor (`src/workers/engine-executor.ts`); a plan's claim items, and
the nodes a 'deepen' policy mandate's scope holds waiting, are Steward
passes the mandate commissions within its pace and escrow
(`src/services/standing-order-service.ts`), run with every other
commissioned pass; everything else a mandate pays for, its officers and
lookouts commission under its operating policy. Mandates also fund each other as peers (regrants) and can spawn
new mandates with their own Grantmakers. Direct `POST /grants` (scope +
policy + budget) remains for service/operator tooling.

Every
assessment a mandate produces is stamped with `funded_by_job_id` — disclosed at
the bottom of the claim page as paid for by a funded mandate, named by its
title and linked to its page, together with the explanation that funding
buys scheduling, never conclusions or graph membership. The title is the
Grantmaker's, neutral and faithful; the mandate's page says who funds it
and any stake they declared (docs/allocation.md, "Who funds a mandate").
Pause/top-up/refund semantics are the budget job's:
`POST /grants/:id/topup`, `POST /grants/:id/cancel`, dashboards on
`GET /grants/:id` (spend, plan, the assessments the grant bought).

**Free tier:** a one-time signup grant of 5 owls (`SIGNUP_GRANT_OWLS`) — "see
a claim you care about, get it assessed": it covers two capped
assessments, and the unused part of each cap settles back — plus a 1 owl/month trickle
(`MONTHLY_GRANT_OWLS`). Both are lazy, idempotent ledger grants
(`signup:<user>` / `monthly:<user>:<YYYY-MM>` idempotency keys) written by
whichever entitlement read sees the user first.

**Quota gate** (`src/server/plugins/quota.ts`): agentic endpoints carry
`requireAgenticQuota(op)`:

- a per-caller rate limit (`AGENTIC_RATE_LIMIT_PER_HOUR`, default 30/h,
  in-memory) on unpriced traffic only (service calls with no acting user);
  a user's calls are bounded by their owl balance instead;
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

## The Assistant

The **Assistant** (`/assistant/conversations`, UI at `/ask`; #646, #619,
#312) is an agent that works for one signed-in user. It is not an
administrator: it is given the constitution so that it reads the graph as
the graph means to be read, under a heading that says the document does
not bind it (`src/llm/prompts/assistant.ts`). Its tools are the account's
MCP tool list, whole, built in process for the user at the trust of an API
key (`src/llm/tools/assistant-tools.ts`), plus `load_skill` over the caller
skills, `note_progress`, and `delegate`, which hands one self-contained
task to a fresh copy of itself (one level deep, same tools, same bill).

**The bill.** The Assistant has no cap, no reply ceiling and no count of
messages. Each model turn is charged to the user's balance as it finishes
(`chargeMetered`, op `assistant`), the conversation keeps what it has cost
(`spent_micro_usd`), and the running turn reports its cost so far
(`turn.cost_micro_usd`). A run ends when the balance reaches zero or the
user stops it (`POST /assistant/conversations/:id/stop`); what had been
written is kept and marked `stopped`. A message is refused with 402 only
when the balance is zero. docs/allocation.md, "Agents work to a budget
they can see", says why this agent alone has no budget and what it is told
in place of one.

**Held actions.** A tool that spends owls on the graph or publishes under
the user's name (`HELD_TOOLS`) does not run when the Assistant calls it.
The call is saved (`assistant_held_actions`) and shown to the user as a
card; `POST /assistant/conversations/:id/held/:action_id` with
`decision: "run"` performs the same call as the user, and `"decline"`
records the refusal. The Assistant is told the outcome in its next reply.
The user may allow kinds of action (`propose`, `submit`, `assess`, `fund`,
`cancel`) to run without a card, for one conversation or for the account
(`PUT /assistant/allowance`); an allowed call runs at once and leaves the
same row as a receipt. Releasing an action and changing the allowance need
the signed-in session and are not MCP tools, so nothing the Assistant holds
can do either. The gate is a hard limit money cannot serve: the Assistant
reads pages, sources and other people's text while it works, and injected
text must not be able to move a person's money or name.

**Turns** follow the granting conversation's protocol: a message is saved
and returns at once with `turn.state: "replying"`, the reply forms in the
background, and callers read the conversation until the turn is idle.
While it runs the turn reports what it is doing: `turn.activity` (the
latest tool calls, each with what it was pointed at), `turn.note` (the
Assistant's own progress line) and `turn.partial` (the text of the reply
once it starts writing). A reply usually opens with a long run of tool
calls and no text, so the page shows the activity.

That saved state is written about once a second. For a person watching,
`GET /assistant/conversations/:id/stream` is the same turn as an event
stream: `text` events carry the reply as it is written, `activity` and
`note` the steps as they start, and `done` says the turn has ended and is
saved. The process running the turn publishes these as they happen
(`services/assistant-stream.ts`); a stream opened on another process
re-reads the saved state instead and sends it as `state` events. The page
uses the stream and keeps reading the conversation beside it, so a stream
that drops or cannot open costs only the speed.

**Names.** A conversation is named from its first message by a small
model (`ASSISTANT_TITLE_MODEL`, Claude Haiku by default, so a
conversation's text goes to one provider), in the
background while the Assistant starts on the reply: two to six words in
place of the message's opening words, which stand in until the name
arrives and stay if the call fails. The call is untraced while the run log
is best-effort, and a logged run where it is kept as a record
(docs/run-log.md); its cost (a fraction of a cent) is charged with the
conversation's either way.

**The page.** `/ask` is laid out as a chat, not as an article
(`web/app/ask/layout.tsx`): a sidebar of the user's conversations, pages
and mandates, the conversation with its composer pinned at the bottom, and
a right-hand panel that shows a cited node while its citation is pointed
at, or a saved page opened from the conversation.

**Privacy.** A conversation is private to its user. Its runs are logged
like a granting conversation's, with the transcript private to the user
(`AGENT_INPUTS.assistant`). Deleting a conversation deletes its text, its
held actions and, unless run logs are kept as a record
(`RUN_LOG_MODE=record`), the transcripts of its runs. What it cost stays
in the owl ledger.

**The Grantmaker.** The Assistant may hold a granting conversation for
its user. What it writes there is stored with `via: "assistant"` and shown
to the Grantmaker as coming from the funder's assistant, so the Grantmaker
knows which words are the funder's own. Funding the drafted mandate is the
user's act.

**Pages.** `save_page` (`POST /pages`) keeps something for the user as a
page in their account: markdown whose embeds name nodes by id
(`[claim:<uuid>]` inline; `{{node …}}`, `{{nodes …}}` and
`{{decomposition …}}` on a line of their own). The site renders an embed
with its own components from the graph as it stands when the page is
opened, so no agent-written code runs, and the page records what each node
held when it was saved and marks what has moved (`page-service.ts`). Pages
are private to their user, shown at `/ask/pages/:id`, where the user edits,
exports and deletes them. Saving is an MCP tool, so the user's own agent
can make pages too, and the Assistant's call runs without a card (private,
free, earlier text kept). Deleting takes the signed-in session and is not a
tool.

**The extension.** The browser extension's chat tab is the Assistant
(`extension/lib/api.ts`). A question opens a conversation with `page` set:
the address and title of the page being read and the passages the
extension marked on it, which the Assistant is told came from the page,
with a section of the prompt for the narrow panel in place of the site's.
The extension reads the conversation until the turn is idle, shows what the
reply cost, and can stop it. It holds only an API key, so it cannot release
a held action: the reply says one is waiting and links to the conversation
on minerval.ai, which is the same conversation. The older
`POST /extension/chat`, with its own flat price and prompt, is kept for
installed versions of the extension that still call it and can be removed
once they have updated.

**Sharing a page.** A page is private until its user shares it:
`POST /pages/:id/share` gives it a link (`/p/:token`, a random token, not
the page's id) that anyone can read it by, signed in or not, and
`DELETE /pages/:id/share` withdraws it; sharing again makes a new link.
`GET /shared-pages/:token` is the public read: the page and the nodes it
embeds as they stand, and nothing about whose it is. Both writes take the
signed-in session and are not MCP tools, so no agent can publish what the
user keeps. Only a page at the public label can be shared (`src/labels.ts`).

**Other doors.** Node pages and `/mandates` carry an ask box that opens
`/ask` with the question written and, from a node, the node named to the
Assistant. The box sends nothing: the question is sent from the Ask page,
where the bill and the balance are in view.

**Model.** Claude Fable 5.2 by default (`ASSISTANT_MODEL`), with Claude
Opus 5.5 as the cheaper choice per conversation (`ASSISTANT_STANDARD_MODEL`).

## The owl ledger

`owl_ledger` is the one spendable balance: every earn and spend is an
explicit signed row in face-value micro-USD, and

```
balance = SUM(owl_ledger.amount_micro_usd)
```

Reasons: `purchase`, `signup_grant`, `monthly_grant`, `contribution_award`,
`charge`, `meter_settlement` (the unused fraction of a charged cap,
returned after the meter ran), `refund`, `escrow_hold`/`escrow_refund`
(budgeted jobs), `admin_adjust`, and `prize_award` (a prize paid in owls,
below). Charges carry the operation (`op`) and
link to the claim or contribution they paid for, so the account history
reads as "up to 2 owls held for the assessment of claim X, 0.4 returned".
Charges, escrow holds, and allocations are balance-guarded inserts taken
under a per-user lock, so racing requests queue and can never overdraw a
balance. Settlements are idempotent per settle key.

**Earning owls (#71):** an accepted contribution awards importance-scaled
points (1–5, the old kudos rule) × `CONTRIBUTION_AWARD_OWL_PER_POINT`
(default 0.25 owl), with a +2-point bonus for acceptances that survive appeal
scrutiny. The leaderboard (`GET /contributors`) ranks **lifetime owls
earned** (`contributors.owls_earned_micro_usd`) — purchases never move it and
spending never lowers it. Audit supersession claws awards back. Prize owls
are a separate total, `owls_prized_micro_usd`, and never enter the
leaderboard (below).

## Prizes paid in owls

A prize (docs/prizes.md; the mechanism in docs/mathematics.md, section 8)
is stated and paid in owls, the unit of metered work valued at one dollar
of metered cost each, and it reaches the ledger through one path only:
`payPrize`, run after the challenge window has closed, the audit has
passed, any required sign-off is recorded, and the winner's steps below
are complete. The bounty behind it was held against the escrow of the
mandate whose Grantmaker posted it from the day it opened, so every prize
owl is backed by escrow paid for before the offer was made.

- **The `prize_award` reason.** The grant is one `owl_ledger` row with
  reason `prize_award`, positive, net of any required withholding, with
  `claim_id` and `prize_claim_id` set and idempotency key
  `prize:<prize_claim_id>:owls`, written in the same transaction as the
  `prize_payouts` row (`kind = 'owls'`, `provider = 'internal'`). The
  payout row is what consumes the posting mandate's hold: from that row
  onward the mandate's committed money counts the gross amount, the way a
  regrant is counted rather than moved, and the bounty's hold lapses when
  it closes. The ledger says "award" because
  the legal posture depends on prize owls being promotional credit: issued
  without payment, never expiring, never transferable, never redeemable
  for cash, never converted later. A post-payout voiding after fraud is a
  negative `prize_award` row that mirrors `clawbackContributionOwls` and
  may push a balance negative; the payout row is marked `reversed`.
- **`owls_prized_micro_usd`** on `contributors` sits beside
  `owls_earned_micro_usd` and is kept apart from it. Earned owls are the
  importance-scaled award for accepted contributions and are what the
  leaderboard ranks; a prize is a payment for one result, fixed in
  advance, and folding it into the earned total would let a single
  2,500-owl prize outrank years of accepted work. Prize owls are excluded from the
  leaderboard sum, spend like any other owl, and appear on the profile as
  "Prizes" beside, not inside, "owls earned". `GET /contributors/:id` and
  `/users/me` expose `owls_prized` and `open_prize_claims`.
- **The winner's steps.** After the prize claim becomes `payable` the
  winner sees "Your prize" on the account page: the amount, in owls; what
  owls are (metered work on the graph: assessments, deeper passes, mandates
  the winner directs, valued at one dollar of metered cost each); that they
  are non-transferable, non-refundable, and never redeemable for cash; that
  the prize is reported for tax at that value; and three steps to complete
  within `PRIZE_PAYEE_STEPS_DAYS`
  (90). The steps are identity and residency (`POST /prize-claims/:id/payee`,
  dashboard session plus an emailed one-time code, because a leaked
  consumer key must not redirect a prize); a tax form, W-9 for U.S. persons
  or W-8BEN otherwise, uploaded as an attachment of kind `tax_form` with
  visibility `restricted`; and sanctions screening against the OFAC SDN
  and consolidated lists, which the operator records on the payout row.
  The sign-off checklist requires all three before any `prize_award` row
  is written; the owl path is not a way around them. A winner who does not
  complete the steps within the period forfeits (`forfeited`), and the
  bounty's hold on the mandate's escrow lapses with the claim.
- **Tax and screening records.** Prizes are ordinary income at the value
  of the prize, one dollar of metered cost per owl. `prize_payouts` records
  `withholding_micro_usd`,
  `tax_form_kind` (`w9` | `w8ben`), `payee_country`, and
  `screening_result`. A W-9 with a valid TIN means no withholding and a
  1099-MISC at the statutory threshold; a missing TIN means 24 percent
  backup withholding; a W-8BEN means 30 percent withholding by default,
  the withheld amount recorded on the payout row as the platform's own
  remittance (the mandate is consumed for the gross amount it offered) and
  a 1042-S record, pending counsel's view on the source of prize income.
  Persons in comprehensively sanctioned jurisdictions are ineligible by
  rule, and a screening result other than clear is a human sign-off
  condition. Payee details, provider ids, tax forms, and screening results
  never serialize on any public route, and the records are kept at least
  seven years.
- **The daily tranche rule.** A grant above `PRIZE_OWL_TRANCHE_OWLS`
  (2,000 owls) is written in daily tranches of at most that amount, one
  `prize_award` row per day under a per-tranche idempotency key, so no
  single day loads more owls onto one account than the closed-loop
  prepaid-access threshold the owl's legal posture relies on. The largest
  purchase pack (Parliament, $1,000) sits under the same figure.

## Buying owls (Stripe)

Purchases are enabled when `STRIPE_SECRET_KEY` looks real (`sk_…` or a
restricted `rk_…` — `stripeConfigured()`); a placeholder keeps the deployment
on free grants only. Production should use a restricted key scoped to
Checkout Sessions: Write, the only Stripe API call the integration makes. Owls are sold in fixed packs with bulk discounts (`OWL_PACKS`,
default `5:2000:Clutch,25:9000:Perch,100:30000:Wisdom,500:100000:Parliament`
as owls:cents:name: Clutch at the $4 face value, Perch 10% off, Wisdom
25% off, and Parliament 50% off, the mandate-scale pack):

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

`/account` on the web app. Four figures head the page: the owl balance,
what is still held in escrow by running work, the metered cost of the last
30 days, and contributor standing. Under them:

- **Owl history**, read by piece of work: each hold is shown with what was
  returned from it, as one line and its cost, and a day's repeated small
  charges (the Assistant's) as one line. The ledger entry by entry is one
  click away (`/account?history=entries`). The folding is done in the web
  app (`web/lib/owl-history.ts`) from `GET /billing/ledger`, whose returns
  carry `settles_entry_id`, the charge they return part of; it changes no
  amount. Beside the history: pack purchase (when billing is enabled) and
  the caps list.
- **Funded work**: open jobs with spend against budget, by their grant's
  name; ordered assessments by claim, with what each cost (`cost_owls` on
  `GET /orders`: the cap less what the settlement returned).
- **Usage**: cost by day and by agent, drawn (cost observability).
- **API keys**: create/name/revoke (plaintext shown exactly once), each key
  with its calls and cost in the window.
- **Contributions**: recent decisions and standing, including owls earned.

`/signin` lists whichever providers are configured.

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
  `AUTH_SECRET`, and OAuth provider secrets in Vercel.
- Metering never fails a call: `meterLlmUsage` catches and logs. The
  in-memory budget tracker (process circuit breaker) is unchanged and
  independent.
- `MINERVAL_OPERATOR_KEY` is never set on the Vercel project or on the API
  task's environment for the web tier's benefit; it is held by the operator
  and presented only on the operator routes above. A copy lives in the
  repository's GitHub secrets for one purpose: the Platform mandates
  workflow, which presents it only to fund a draft a merged pull request
  pinned (#529). The Lean checker's
  bearer token is a Secrets Manager entry created by the checker stack and
  read by the API task alone (docs/infrastructure.md).

## Deletion

The privacy policy promises to delete an account and its records on
request, by email. No deletion job exists yet; this is the scope one would
have to cover (#356), so the promise stays keepable as tables are added.

- **Nothing to delete, by construction.** Page text and chat from the
  browser extension, and text sent to the MCP's on-demand analysis tools,
  never reach the database: the pipeline runs untraced and keeps its result
  only in an in-memory cache (see the extension section of
  [architecture.md](architecture.md)). Erasure has nothing to find here,
  which is the point of keeping it that way. This is true of a deployment
  whose run log is best-effort, as the public graph's is. One that keeps
  its log as a record (`RUN_LOG_MODE=record`) logs that work, privately,
  and keeps the log (docs/run-log.md).
- **Rows keyed to the account** (`contributors.id`), deletable outright:
  `api_keys`, `oauth_tokens`, `oauth_authorization_requests`,
  `grant_conversations`, `assessment_orders`, `budget_jobs`, `grants`
  (`funder_user_id`), `action_allocations` (`user_id`), `owl_ledger`,
  `jobs` (`user_id`), and the attribution columns on `llm_usage` and
  `agent_runs` (`user_id`, plain uuids with no FK). Transcripts in
  `agent_runs`/`agent_steps` expire on their own within
  `TRACE_RETENTION_DAYS`, except those of runs that wrote to the graph
  (`agent_runs.wrote_to_graph`), which are kept as the record of how the
  graph's public content was made. A request can delete the account's
  transcripts that wrote nothing at once, and clears the account's
  attribution (`user_id`) on the ones that are kept.
- **The prize path** (`prize_claims.claimant_id`, `attachments.owner_id`,
  and the `payee` and tax columns on `prize_claims` and `prize_payouts`):
  the identity, residency, and tax-form records a paid prize requires. A
  claim that was paid stays on the record for the retention its tax
  treatment demands (the prize rules say how long); everything else keyed
  to the claimant is deletable with the account, and an open claim is
  withdrawn first.
- **The public record**: `contributions`, `contribution_reviews`,
  `appeals`, `arbitration_results`, `reputation_events`, and the
  `audit_findings` that cite a contributor. These are the
  graph's exchanges with a contributor, attributed by design (see
  [reputation.md](reputation.md) and the privacy policy's contributor
  standing section). The honest deletion detaches identity, nulling
  `external_id`, `display_name`, `email`, and `avatar_url` so the row
  survives as an anonymous contributor, rather than unpublishing the
  exchange; the same treatment Wikipedia gives a vanished editor.
- **Stated views** (constitution §4). An account that states its view on a
  node publishes a statement under its own name: the source's title and
  author and the instance's speaker carry the name the account had then. The
  form says so before anything is submitted, and that a statement is not
  withdrawn. Deleting the account detaches the `contributions` row like any
  other and leaves the statement standing as a source under the name it was
  made with, the way a signed letter outlives its author's membership.
  `stated_views` holds what was submitted and is keyed to the contribution.
- **The claim layer** carries no account identity: claims, instances, and
  assessments name sources and speakers, never users. Personal detail there
  is a constitutional violation (§2), handled as a correction to the graph,
  not as account erasure.
