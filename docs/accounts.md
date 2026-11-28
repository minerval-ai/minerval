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

## Organizations

An account is a person, an organization, or the platform account
(`contributors.kind`). An organization is an account nobody signs in as:
its external id is `org:<id>`, which no sign-in provider makes, and
`POST /users/provision` refuses it, as it refuses `platform:`. People act
for it as themselves, as its admins or members (`organization_members`),
and every change is a row in `organization_log`, which its members read
and nobody else does. The design, and the phases still to come (connected
deployments, domains, billing), are in [organizations.md](organizations.md).

- **Making one** (`POST /organizations`) costs nothing and gives nothing.
  Its maker is its first admin.
- **People join by invitation**: a single-use link an admin makes
  (`POST /organizations/:id/invitations`), kept only as a hash, open for
  seven days, accepted by the person from their own session.
- **An organization always has an admin.** Demoting, removing or letting
  leave the last one is refused (`LAST_ADMIN`). Changes to one
  organization's members take a lock on its row, so two admins removing
  each other at once cannot both succeed. If every admin's account is
  gone, the operator key makes a person an admin
  (`POST /operator/organizations/:id/admins`), logged as made with it.
- **What each may do as it.** Admins grant members and deployments
  permissions from one list (`organization_grants`; `POST
  /organizations/:id/grants`, `DELETE /organizations/:id/grants/:grant_id`,
  read by every member at `GET /organizations/:id/grants`): for a member
  `spend`, `buy`, `speak`, `propose`, `take_up` and `claim_prizes`; for a
  deployment `read_feed`, `report_usage`, `publish`, `spend`, `speak`,
  `propose` and `take_up`. An admin holds every member permission without
  a grant. A member's grants are withdrawn when they leave or are made an
  admin. Each grant and withdrawal is on the log.
- **Acting as it.** A signed-in member acts as the organization with
  `x-acting-organization: <id>` beside `x-acting-user`. The API checks that
  they are a live member now, and that they hold the permission the route
  needs, from one map for members and deployments
  (`src/server/organization-routes.ts`). A route that writes and is not in
  it refuses the header (`NOT_AN_ORGANIZATION_ACT`), as do a person's own
  routes listed there with their reasons (keys, OAuth, their pages, what
  the Assistant may do without asking, prizes until the rules allow an
  organization), and a
  permission not held answers `PERMISSION_NOT_HELD`, naming it. Reads are
  open to any live member, but for the person's own and the ledger, which
  is admins'. The request is then the organization's, and each write is on
  its log under the person, with how it was made (`detail.how`: page,
  assistant, api_key or mcp_client). The header needs a signed-in session,
  and the web tier cannot name an organization in `x-acting-user`
  (`ORGANIZATION_NOT_ACTABLE`).
- **Credentials made for it.** An API key (`POST /api-keys` with
  `acting_for`) or an MCP client's consent (`POST
  /oauth/requests/:id/approve` with `acting_for`) may be made to act as an
  organization its person may act for (`CANNOT_ACT_AS` otherwise). It acts
  as them acting as it: each request is checked against their standing then
  (`CREDENTIAL_ORGANIZATION_LEFT` once they hold nothing there), the MCP
  server offers only the tools they may use as it, and a refreshed token
  carries the same choice. The organization holds no credential of its
  own. Its members read the live ones (`GET /organizations/:id/credentials`);
  an admin, or the maker, revokes one (`DELETE
  /organizations/:id/credentials/:kind/:credential_id`); and leaving the
  organization revokes what the person made for it.
- **The switch.** On minerval.ai a person switches to acting as an
  organization from their account or the organization's page. The web tier
  keeps the choice in a cookie, checks it against the person's
  organizations on every request (`web/lib/acting-as.ts`), and sends the
  header on the acts of the public graph's pages; the header shows the
  organization's name, and each form says who it is sent as. The person's
  own account pages are always theirs.
- **The Assistant as it.** A conversation started while acting as an
  organization is that organization's (`assistant_conversations.acting_for`):
  found only while its user acts as it, its model calls charged to the
  organization's owls (starting or continuing one needs `spend`), its tools
  only those its user may use as the organization, and it is told whom it
  works for and which tools that leaves out (`organizationNote`,
  llm/permissions-note.ts). Each of its calls is checked again against the
  user's standing then, in the auth plugin for a call dispatched to a route
  and in the MCP server for a hand-written tool.
- **Allowances.** An admin may set an allowance on a grant of spend (`PUT
  /organizations/:id/grants/:grant_id/allowance`): the organization's owls
  that member or deployment may spend in all, with no period, raised only by
  an admin. Every debit of an account runs under its balance lock
  (`withOwlBalanceLock`), and there a debit made as the organization counts
  against the spender's allowance (`services/organization-spending.ts`): one
  that would pass it is rolled back and refused, `402 ALLOWANCE_EXCEEDED`
  with the figures; a metered charge takes no more than is left. What is
  left is on the member's view of the organization, in their Assistant's
  brief, and on the deployment's `GET /organizations/me`. What a debit held
  is what counts; owls returned to the organization later go to its
  balance. An admin spends from the whole balance.
- **No free owls.** The free tier's signup and monthly grants are a
  person's; an organization and the platform account get none.
- **A shared login becomes one in place** (`POST /account-conversion`,
  accepted at `POST /account-conversions/:id/accept` by the person it
  names as first admin). The row keeps its id, so its record, pages, owls
  and API keys stay; its kind and external id change, so the login no
  longer reaches it; its email and avatar are cleared and its OAuth tokens
  revoked. Its old keys are listed for the admins
  (`GET /organizations/:id/old-keys`) until they revoke them.

- **A connected deployment** signs each request with its own key
  (`Authorization: Minerval-Deployment ...`; [organizations.md](organizations.md),
  "Signed requests"). The auth plugin checks the signature over the host,
  method, path, body hash, time, nonce and key id, against the live
  deployment the key id names, and then that the route is one its grants
  open (`src/server/organization-routes.ts`; any other route answers
  `NOT_A_DEPLOYMENT_ROUTE`). A write's nonce is refused if seen with the key
  in the last ten minutes. The request is the organization's, with
  `method: "deployment"`; it is not a session and acts for no person. Each
  write it signed is recorded for the organization's members
  (`deployment_requests`); reads are not. A deployment connects with a code
  an admin approves at `/connect`.

Changes are made from a signed-in session only (`requireSession`), and
none is an MCP tool: each decides who speaks for an organization. The
reads are tools (`list_organizations`, `get_organization`, ...). The pages
are under `/account/organizations`, `/account/convert` and `/join/:token`.

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
| `direct` | | open a mandate and shape it with its Grantmaker, approve its plan, ask a mandate's Correspondent for an update, add sources, among them sets of files they upload, state the organization's own view on a node, release a node's page to readers who do not read its label, end a standing release, hold a page that has not been released ([releasing-a-page.md](releasing-a-page.md)), send the pages a release outside has released to the public graph and write the words a node is proposed there in ([published-pages.md](published-pages.md)), adopt a public request, and, unless the deployment names another permission for it (`PUBLIC_ACTS_BY`), act on the public graph in the organization's name ([outward-acts.md](outward-acts.md)) | edit an assessment or a run's log |
| `consent` | for one party | act at a gate on what rests on that party's material: consent, approve, remove a passage from, hold or delay each part of a page or other item going to readers who do not read its label, and set the gate for that party's material ([the-gate.md](the-gate.md)), consent to the words a node is proposed to the public graph in, and, for the organization's own material, send an agent's report as redacted to Minerval's maintainers ([outward-acts.md](outward-acts.md)) | edit what the agents wrote, or consent for another party |
| `fund` | | put owls behind work: fund a drafted mandate, add to a mandate or a funded job, back a mandate, order or fund work on a node or a request | decide what the work concludes |
| `read` | at one label | read what the agents wrote at that label and at the labels it reads | change anything the agents wrote |
| `read_sources` | at one label | open the sources themselves at that label | change a source |
| `administer` | | grant and remove permissions, define labels and which reads which, add parties, say whose material a source is, save the redaction policy of a boundary, sign the statement that registers the deployment's key to an account on the public graph, connect the deployment to an organization's systems and pick which of their tools agents are offered, register a directory on the deployment's disk as a set of files, set up the General mandate, create owls where the deployment creates its own, read and send the usage reports | act under a permission they have not also been granted, or change who may do what without a log entry |
| `clear_providers` | | choose, for each label besides `public`, which model providers and outside services may be sent the text of work at it, on the labels page, where the deployment's settings (`PROVIDER_LABELS`) do not fix that ([architecture.md](architecture.md), "Providers cleared by label") | read at a label they have not been granted, or clear a provider where the settings fix the clearance |

A request's **standing** is resolved once, when it arrives: the live grants
that reach its account (its own, and those made to a group its latest
sign-in carried), and its **clearance**, the labels it may read: what every
member reads with no grant (`public`, `published` and `members`:
[architecture.md](architecture.md), "The three layers at the bottom"),
each label a `read` grant names, and every label those read, following
`label_reads` to the end. The clearance is on the request's async context
(`currentClearance()` in `src/llm/usage-context.ts`), and where the
deployment holds material at more than one label the database holds every
read of the request to it ([architecture.md](architecture.md), "Labels and
clearance"). A `read_sources` grant opens the sources themselves at its
label ("Opening raw sources", below).

`clear_providers` is a permission of its own because clearing a provider
for a label decides who outside the deployment may read that label's
material: it is not part of administering, and an organization may give it
to fewer people. The first administrator is granted it with every other
permission that has no scope. A deployment whose first administrator was
established before it existed has nobody holding it until an administrator
grants it, and until then nothing new can be cleared from the labels page,
which is the safe side. Defining a label with providers ticked takes both
`administer` and `clear_providers`.

The routes a permission guards, in each mode (`requirePermission` in
`src/server/require-permission.ts`; the list is asserted in
`tests/db/members-only.test.ts`):

| route | open (the public graph) | members-only adds |
|---|---|---|
| `POST /grant-conversations`, `POST /grant-conversations/:id/messages`, `POST /grants/:id/approve`, `POST /correspondents/:id/poke` | an account | `direct` |
| `POST /sources` | any valid key, and the owl charge | `direct` |
| `POST /claims/:claim_id/stated-views` | an account that may contribute | `direct`: stating the organization's own view on a node is part of directing the graph |
| `POST /grant-conversations/:id/fund`, `POST /grants/:id/topup`, `POST /mandates/:id/contribute`, `POST /claims/:claim_id/order`, `POST /claims/:claim_id/contribute`, `POST /claims/:claim_id/decompose`, `POST /requests/:request_id/contribute`, `POST /budget-jobs/:id/topup` | an account, and the owls | `fund` |
| `POST /grants` | a direct service caller | `direct` and `fund` |
| the routes for permissions, parties and labels (below) | not mounted | `administer`, and a signed-in session for every write |
| the routes for connections ([connections.md](connections.md)) | not mounted | `administer`, and a signed-in session for every write |
| the routes for file sets ([file-sets.md](file-sets.md)) | not mounted | `direct` for the reads and for uploading a set; `administer` for registering a directory, which decides what label files already on the deployment's disk get; a set's label within the caller's clearance, and a signed-in session for every write |
| `POST /standing-mandates/:name`, `POST /owls/created`, `GET /usage-reports/outgoing`, `POST /usage-reports/outgoing/send` (below, "Owls a deployment creates for itself") | not mounted | `administer`, and a signed-in session for every write |

Taking money back asks for no permission in either mode: withdrawing from a
mandate, cancelling a grant, a job or an order. A funder may take back
their share at any time (constitution §19), and a permission removed later
must not stand between a person and their own owls. Proposing, contributing
and appealing ask for none either: any member may.

An MCP caller is not offered a tool whose route needs a permission its
account lacks, and is told which and why: the Assistant in its brief
(`src/llm/permissions-note.ts`), an outside client in the server's
instructions.

Both are also told that the deployment is a private one
(`src/llm/deployment-note.ts`, #1120). The Assistant's role, the caller
skills and the server's instructions are one text everywhere and describe
public Minerval, so on a members-only deployment a passage headed "This
deployment" says what differs: that only members read the graph and what is
added stays inside unless a page is released outside, the deployment's own
site, API and MCP addresses in place of minerval.ai and api.claimgraph.io,
that an administrator connects the organization's systems on
`/admin/connections`, and whether a mirror of the public graph is held. The
Assistant has it as a section of its system prompt, with its site named in
place of minerval.ai; an outside client has it in the server's
instructions; and a caller skill read from the deployment
(`minerval://skills/{name}`, `load_skill`) is headed by it, or for the
Assistant by a line pointing to it. It names no label. Until the layer
every member reads has a name of its own (#1203), a conversation at
`public` is also told that the word there means that layer and not the
public graph. On the public graph nothing is added.

### The label a request works at

Reading is held to a clearance, a set of labels. Writing needs one label:
the database lets a request add a row only at the label it works at. Where
a deployment has one label, `public`, nothing below is asked and nothing
changes. Where it has more, every request that writes is given its label
in one of two ways (`src/server/request-labels.ts` has the rule for each
route, with the reason, and a test fails for a writing route that has
none). No agent chooses a label, and a label that is missing is never read
as `public`. Nothing is filed at `public` or `published` by a person or an
agent: the first holds the public graph's own material and the second what
the gate to outside let through. A request that names either is refused
(`LABEL_NOT_FILED_AT`) with the labels it may name, and a request about a
node of the public graph works at `members`, or at a label the person names
that reads it.

- **From what the request is about.** A contribution, an appeal, an order,
  funding, a message in a conversation that already exists: each is about a
  row that already carries a label, and everything the request writes,
  however far down, carries that label. A person who may not read the row
  is told it does not exist.
- **From the person, when they start something new.** A source, a proposed
  node, a granting conversation, a conversation with the Assistant, a page,
  an API key: the request names the label in a `label` field, among the
  labels the person may read. There is no default and nothing is
  preselected. A request that names none answers `400 LABEL_REQUIRED` with
  the labels it may name; one that names a label the person may not read
  answers `403 LABEL_NOT_READABLE`, in the same words whether or not a
  label of that name exists.
- **Work on a node, at a label that reads it.** A node can carry a judgment
  at each label ([architecture.md](architecture.md), "A judgment at each
  label"), so the three routes that start work on a node that is already
  there (`POST /claims/:claim_id/order`, `/contribute` and `/decompose`)
  take an optional `label`. Left out, the work is at the node's own label.
  A signed-in person may instead name a label they hold that reads the
  node's label, and the work is then at that label: an internal assessment
  of a public claim. Its order, its ledger row, its messages and the
  version it records are at the label named and are read only there; the
  node's own judgment and the work at its own label are untouched and do
  not wait on it. A label the person holds that does not read the node's
  answers `400 LABEL_DOES_NOT_READ` with the ones that do.
- **A view stated on a node, the same way.** `POST /claims/:claim_id/stated-views`
  takes the same optional `label`: what an organization holds about a public
  node is its own material, so the statement, its review, the instance it
  becomes and its reasons to the Steward are at the label it was stated at,
  and are read only there. On a node the mirror brought, a view at the
  node's own label is not taken (`409 PUBLIC_GRAPH_NODE`), as a contribution
  is not: name a label that reads it, or state the view on the public graph.

`GET /labels/mine` returns what a page needs to offer the choice: the
labels the person may read, each with its description, what else its
readers read, and who reads it (`who_reads`, in words). A label that reads
one of theirs and that they may not read is counted and not named. It lists
the labels work can be filed at, so not `public` or `published`. `GET /labels`
lists every label with which bottom layer it is (`layer`: `public_graph`,
`published`, `base`, or null for a label the deployment defines), and
`GET /permissions/mine` says which label is which under `label_layers`.

The mandate drafted in a granting conversation takes the conversation's
label, and its Grantmaker runs there. A conversation with the Assistant
runs every turn at its label. Each says which label it is in what the API
returns for it (`label`), and a held action's card says which label it will
write at (`writes_at`). A conversation or a mandate at a label its owner
may no longer read is not served to them.

What a request writes at a label it then reads at that label: while it
runs, it reads what its label and the person's clearance both read. A
request about a node at `members` does not read the person's private labels
while it writes rows there.

**API keys and access tokens** work the other way round, because an agent
holds them. A key works at one label, named by the person when they mint it
(`POST /api-keys` takes `label`, required where there is more than one),
and never changed. An access token works at the label the person named when
they approved the client on the consent page
(`POST /oauth/requests/:request_id/approve` takes `label`), through every
refresh. Every request made with one:

- reads what that label reads, within what the person may read, and not
  the rest of the person's clearance;
- files what it starts new at that label, with no parameter. The MCP tools
  have no `label` input, and a REST request that names another label is
  refused (`400 LABEL_FIXED`);
- changes an existing row only where the row carries that same label. A
  row it can read at another label is refused with `409 LABEL_MISMATCH`
  and the reason;
- may start work on a node its label reads, at its own label: an order,
  funding or a decomposition made with a key at `internal` on a `public`
  node is an internal assessment of that node, written at `internal` and
  nowhere else. It names no label, and what it starts is never at the
  node's label unless that is its own.

So an agent holding a key cannot choose where something is filed, and
cannot read at one label and write into a row at another, whatever text
it has read. The Assistant in one conversation is held the same way, to the
conversation's label. Within a turn it reads with the clearance its user held
when the turn began: the user's standing is resolved once for the turn
(`openAccountTools` in `src/llm/tools/assistant-tools.ts`), so a grant
removed while a turn is running takes effect from the user's next message
and not inside the turn. A turn ends with its reply or when the user stops
it (`POST /assistant/conversations/:id/stop`). A key minted with no label named
works at `members`: it reads and writes what every member reads, and its holder
mints a new key to work at another label (`GET /api-keys` shows each key's
label and says this). A key or a token whose label the person may no longer
read is refused (`403 CREDENTIAL_LABEL_NOT_READABLE`). The MCP endpoint
itself takes a key or a token: a signed-in session has no label of its own
and is refused there.

The operator key names no person and carries no clearance. The routes it
guards work at the deployment's base label, `members`.

### Opening raw sources

`read` at a label covers what the agents wrote there: a node, its
assessment, each instance with the passage it quotes, a reading, an
examination's findings. `read_sources` at a label opens the sources
themselves, and is granted separately, label by label: a grant at one
label does not open the sources of a label it reads. Sources at `public`,
`published` and `members` are open to every member.

The database cannot hold the two apart, since a source's stored text is a
column of the source's own row. The permission is held at each place the
text is returned to a person (`src/raw-sources.ts`):

| where | without the permission |
|---|---|
| `GET /sources/:source_id/document` (MCP: `get_source_document`, and the Assistant's tool) | every segment comes without its text and its heading, and `text_withheld` says so and names the permission and the label. The structure, the length, and every instance the agents recorded from the document are served |
| `GET /sources/:source_id/examinations` (MCP: `get_source_examinations`) | each finding comes without `segment_label`, the heading of the segment it is anchored to, and `headings_withheld` on the examination says so. The finding itself, which the agent wrote, is served |
| `GET /runs/:run_id/steps`, `GET /runs/:run_id/steps/:seq` | the parts of a step that hold a source's text are replaced by the same kind of notice: the opening message of an agent that is handed a document (the Extractor), and the output of a tool that returns one (`provenance_read_source`, `examination_outline`, `get_contribution_details`, a connection's tools, `open_reading`, `run_command`, `open_output`, the Redactor's `get_page_to_redact`). The rest of the step and its hash are served. Which runs a member is served at all is in [run-log.md](run-log.md), "Who reads a log" |
| `GET /connections/:connection_id/writes` (MCP: `list_connection_writes`) | what the system answered to each call (`came_back`) is replaced by the same kind of notice, with its size and SHA-256. What was sent, who made the call and how it ended are served ([connections.md](connections.md), "A tool granted to write") |

A run's log says what its run could have opened, not which source each
step read. So a reader of a run at a label needs `read_sources` at that
label and at each label it reads; a run at `public` read only public
sources.

Read-only SQL returns no source text: no view selects it, and a test fails
if one comes to.

What this does not protect. A passage an agent quoted from a source is text
from the source, and reading at the label shows it. A person without
`read_sources` cannot open a document; they can read every passage the
agents chose to record from it, and what the agents said about it. An
agent's own run is not held to the permission: it reads what its label
reads, sources included.

### Granting, and the log

Mounted only where `READS=members`:

| route | who | |
|---|---|---|
| `GET /permissions` | a member | what each permission covers |
| `GET /permissions/mine` | any signed-in account | what the account holds, its clearance and groups |
| `GET /labels/mine` | a member | the labels the caller may file new material at, and who reads each; for a key or a token, the one label it works at |
| `GET /permissions/log` | a member | every grant, removal and administrative change, newest first, owls created and standing mandates set up included; kept to kinds (`type`), to who acted (`by`) and to a text (`q`) before its limit, and paged back from `next_before` |
| `GET /permissions/grants`, `GET /permissions/accounts`, `GET /labels` | `administer` | who holds what now; the accounts with their groups; the labels |
| `GET /parties` | `administer` or `direct` | the parties: in full for an administrator; for a person who directs, each party's id and name and whether it is the organization itself, since adding a source or a set of files says whose material it is |
| `POST /permissions/grants`, `DELETE /permissions/grants/:grant_id` | `administer`, from a signed-in session | grant; remove |
| `POST /parties`, `PUT /sources/:source_id/party` | `administer`, from a signed-in session | add a party; say whose material a source is |
| `POST /labels`, `POST /labels/:label/reads`, `DELETE /labels/:label/reads/:reads` | `administer`, from a signed-in session; `clear_providers` as well for a label defined with `providers` | define a label, with the providers cleared for it; say or take back that one label reads another |
| `GET /labels/providers` | `administer` or `clear_providers` | every model provider and outside service this deployment knows, with what it would be sent and whether it is set up; each label with the providers cleared for it; and whether the deployment's settings fix that |
| `PUT /labels/:label/providers` | `clear_providers`, from a signed-in session | make exactly the providers named the ones cleared for a label, logged, in force within seconds; refused for `public` and where `PROVIDER_LABELS` is set |
| `POST /operator/administrators` | the operator key | grant `administer` to an account, by its sign-in identity |
| `GET /setup/checklist` | `administer` | what the deployment's setup has done and what is still to do, with the deployment's own checks where the build has them ([deployment.md](deployment.md), "The setup checklist") |

Every write takes a signed-in session, as minting an API key does, so a
leaked key, an access token, or an agent following text it read can never
widen what anyone may read or consent to. For the same reason the writes are
not MCP tools; the reads are.

`permission_grants` is state and log in one. A row is a grant; removing it
marks the same row with who removed it and when; no row is deleted. The
other administrative acts (a label defined, a pair of labels added or
removed, a party added, a source's party set, every change to a
connection or to the tools it offers, a tool granted to write or its
grant revoked, and a file set added, closed or
switched off, whoever's act it was, owls created, a standing
mandate set up) each write a row to
`administrative_events` in the same transaction as the change. The last
live grant of `administer` cannot be removed.

The log is open to every member, because who holds power over a graph is
part of what its readers weigh. People appear by display name. The name of
a label the reader is not cleared for, or of a party that is neither the
organization itself nor one the reader holds `consent` for, is replaced by
`{"withheld": true}`: a deployment may hold material from parties who are
not to learn of each other. A connection's name and its tools' names are
withheld the same way from a reader not cleared for the connection's label,
and so is a file set's name. A source whose party was set is named by its
title only to a reader cleared for the source's label: holding `administer`
is no clearance. That an act happened, who did it, to whom and when is
always shown.

Each entry has a `type`, the kind of act it is: `access`, `labels`,
`parties`, `connections`, `file_sets`, `owls`, `providers`, `mandates`, or
`other` for an event the build does not know. Which event is which kind is
said in one place (`LOG_TYPE_OF` in `src/services/permission-service.ts`),
and the Activity log shows the API's kind rather than working it out. The
log is kept to one or more kinds (`type=access,labels`), to who acted
(`by`: an account's id, which each entry gives as `by_id`, or `operator`,
`first_administrator` or `deployment`) and to a text (`q`), all before its
limit. The text is matched against the entry as the reader is given it, so
a withheld name is never found by searching for it. A search reads at most
20,000 entries of the log in one request, since a person or an agent waits
on it; `next_before` says where to read on from, at the end of a full page
or where that bound stopped the read, and is null when nothing older
matches.

### The first administrator

A deployment that has never had an administrator needs one person to hold
every permission and hand them out. There are two ways to say who.

**The code.** Each time the API starts while the deployment has no
administrator, it prints a one-time code in its log
(`[setup] The first person to sign in ... and give this code becomes the
first administrator: XXXX-XXXX-XXXX`). A person who signs in and holds
nothing is asked for it, and the first to give it is the first
administrator (`POST /setup/first-administrator`,
`src/services/first-administrator-code.ts`). Reading the API's log is
something only whoever runs the machine can do, so the code says what the
setting below says: that the machine's operator chose this person. A code
works once and for a day. Only its hash is kept, in a table that is the
database owner's alone, so each start prints a new one, and every code not
yet used or expired works, since several API tasks may start together.
After twenty wrong codes none works until the API is started again.

**The setting.** For an install that is scripted, set `FIRST_ADMINISTRATOR`
to the sign-in identity of the person setting the deployment up
(`<provider>:<subject>`, for instance `oidc:00u1abcd`). The first time that
person signs in, while the deployment has never had an administrator, they
are made the first administrator.

Either way, the first administrator is granted every permission: `direct`, `fund` and
`administer`, `read` and `read_sources` at each label that exists besides
`public`, and `consent` for each party that exists. The grants are rows
like any other, marked as made by the setting. From then on they hand
permissions out, to themselves included when they define a new label.

The organization itself is a party from that moment. If the deployment has
none, one is made then under the name "This organization", and the first
administrator holds `consent` for it: a part of a released page that rests on
no outside party's material is the organization's to consent to
([releasing-a-page.md](releasing-a-page.md)). Health's first day asks for its
name, which renames the party (`PATCH /parties/:id`, logged with the name it
had; any party can be renamed the same way). Adding a party as the
organization itself (`POST /parties` with `is_own_organization`) while it
still has that name gives it its name too. A deployment whose first administrator was
established before this existed has no such party until an administrator
adds one, and is told so when a page is first asked to be shown.

Each works once. Once any administrator has existed, removed ones
included, neither the code nor the setting does anything, so a person the administrators
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

Two things keep a page from anyone who is not a signed-in member, and only
a members-only build has either:

- **The proxy** (`web/proxy.members.ts`, with its decision in
  `web/lib/gate.ts`) runs before any page or route handler is chosen. A
  request from a signed-in member goes through. Any other request for a page
  is answered with an empty page (`/members-gate`) at the address that was
  asked for, and any other request (a route handler called by a script, an
  image, a feed) with `401`. So the page a visitor asked for is never
  rendered for them. A layout could not do this: Next renders a page's
  content whatever the layout around it shows, and a reader moving between
  pages fetches a page's content without its layout being asked again.
- **The gate** (`web/components/MembersGate.tsx`, in the root layout) stands
  in for whatever page is shown until the visitor is a member, and says why:
  sign in, or signed in and holding nothing, with the identity an
  administrator will know the person by.

**Files only a members-only build has.** `web/next.config.mjs` adds
`members.tsx` and `members.ts` to the page extensions when the build is made
with `READS=members`. A file named `page.members.tsx` is then a page, and
`proxy.members.ts` the proxy; in any other build Next does not see them. So
the public site has none of a private deployment's pages, compiles none of
their code, and runs no proxy in front of its requests
(`tests/unit/web/members-gate.test.ts`). What a private deployment adds to
the site is named this way.

**The pages a members-only build adds.** A sidebar on every page lists
them in sections, kept in one list (`WORK_SECTIONS` in
`web/lib/work-sections.ts`, drawn by `web/components/work/Sidebar.tsx`): at
the top, Inbox (what waits on the person) and Review (what waits at a gate,
for holders of `consent`); Graph (Ask, Claims, Mandates, Findings, Requests,
Docs); Sharing (Releases, and Boundaries, each one gate with its redaction
policy); Material (Sources and File sets for holders of `direct` or
`administer`, Connections for holders of `administer`); Public graph
(Overview, Requests, Replies and Outbox, for holders of `direct` or
`consent`); and Admin (Health, People, Labels, Parties, Budget and Activity
log, for holders of `administer`). The sidebar marks the page being read and
lists only the pages a person can use; a section with none left is not
named. A person who lacks a permission is not shown a control that needs it,
and a page reached directly says which permission it needs.

Where the deployment holds material at more than one label, a page that
starts something new asks which label it is for (`LabelChoice`, from
`GET /labels/mine`): nothing is preselected, and each label the person may
choose is listed with who reads it. A page lists what the person reads, and
says so where an administrator's list leaves rows out.

| page | who | what it is |
|---|---|---|
| `/inbox` | every member | What waits on the person, from every part of the deployment, each with the act that answers it (`web/lib/inbox.ts`); beside it, the deployment's state, its owls, and the newest acts of the log |
| `/admin` | `administer` | Health, the setup checklist and the deployment's home, one page: what needs attention now, each item saying whether the deployment's operator or an administrator puts it right, then everything as it stands, read from `GET /setup/checklist` ([deployment.md](deployment.md), "The setup checklist"). Its words are in `web/lib/admin-words.ts` |
| `/admin/people` | every member; controls for `administer` | What each permission covers and what the reader holds. For administrators: who holds what by person and by group, granting and removing, and the accounts that have signed in and hold nothing |
| `/admin/activity` | every member | The administrative log, newest first: grants and removals, labels, parties, connections, file sets, owls created and standing mandates set up, with a withheld name shown as withheld. Its filters by kind, by who acted and by text are the API's (`type`, `by`, `q` on `GET /permissions/log`), and older entries are read from where a page ends |
| `/admin/labels` | `administer` | The labels and which reads which, with what adding a pair does stated beside the form, and that defining the first label takes about ten seconds; and, as one table of checkboxes, what each label is cleared to be sent to: for a holder of `clear_providers` where `PROVIDER_LABELS` is not set, ticking the model providers and outside services each label may be sent to (none ticked until someone ticks one), also in the form that adds a label, each with what it would be sent; where the setting is set, that it fixes the clearance |
| `/admin/parties` | `administer` | The parties, with the organization's own named here, and who consents for each; whose material a source is, with the sources that have no party yet |
| `/admin/budget` | every member; controls for `administer` | What an owl is here, totals and acts, creating owls, and the General mandate at each label the reader reads where there is more than one; stated prices and unpriced models; and, as its Usage tab for `administer`, docs/usage-report.md, as `GET /usage-reports/outgoing` describes it, with "Prepare and send now". `/admin/owls` and `/admin/usage-report` redirect here, the second to `/admin/budget?tab=usage` |
| `/admin/connections`, `/admin/connections/:id` | `administer` | docs/connections.md: the notice in full, adding a connection at a label the administrator reads, its state, its tools picked one by one with the server's marking as a hint and the terms each is offered on (a write grant with its reason and acknowledgement, whether its calls wait for an administrator, a price), withdrawn tools, the calls the administrator reads with which were kept, and the calls to tools granted to write with what was sent and what came back, where a waiting one is approved or declined. A connection's label is shown and not offered for change |
| `/admin/outside`, `/admin/outside/requests`, `/admin/outside/said-back` | every member; controls by permission | docs/outward-acts.md. Overview: the organization's account on the public graph with its public owls and public mandates, and for those who may act there the drafts not yet funded, each linked to its conversation with the public Grantmaker, as funded mandates are where known; whether and under what the deployment's signing key is registered there (`registration` on `GET /outside/account`), and registering it ("Register key", or "Re-register"), the setting that keeps public versions current, with what it shows outside, and the log of every act there. Requests: public requests adopted and taken up. Replies: what readers said back about published pages. `/admin/outside/reports` redirects to `/outbound?tab=reports` |
| `/sources` | `direct` or `administer` | The sources at labels the reader reads (`GET /sources`), newest first: where each stands, whose material it is, and who added it. "Add source" (`direct`) opens a drawer to add a document or an address (`POST /sources`), at a label the person chooses where there is more than one; `/sources/new` redirects to it |
| `/claims/:id` | every member | The ordinary page of a node. Where the node carries a judgment at more than one label the reader reads (`versions` on `GET /claims/:id`), a tab for each, opening on the one in force; a reader for whom two are in force, at labels that do not read each other, is shown both in full and neither is chosen. Under the tabs: what the assessment was made on, what it was made beside, and whether that has since been replaced; where a label the reader reads examined the node and left another label's assessment standing, that it did, on what date, with the Steward's reasons, and whether that assessment has since been replaced (`left_standing`); and the labels the reader holds at which the node has not been examined at all (`not_examined_at`). A page of the node released to a label the reader reads, or outside, is a further tab drawn by the components of the public site's second tab (`web/lib/inside-node.ts`, `web/components/claim/InsideVersions.tsx`) |
| `/releases`, `/releases/:id`, `/releases/:id/pages/:page_id` | every member, as far as their labels reach; controls by permission | docs/releasing-a-page.md: the releases a reader may see from either side; one release with each node's state, every version, every act, and for a reader of the page's label paying for the redaction or its check (`fund`), holding a page and ending a standing release (`direct`); one version as released, part by part, with who consented to or held each, the fingerprint, and a check that runs in the reader's browser |
| `/releases/new` | `direct` | Release a node's page (`POST /releases`), from the node's page. Nothing is preselected, and each choice says what it releases and to whom |
| `/showings`, `/showings/new`, `/showings/:id`, `/showings/:id/pages/:page_id` | every member | Redirects kept for old links: each to the same address under `/releases`, with its query |
| `/gates` | every member | Boundaries, each one gate and its redaction policy (docs/the-gate.md): one row for each the person can see, with how much waits there toward a label the reader reads, in counts (`GET /gate/backlog`) |
| `/gates/:id` | every member, as far as their labels reach; controls for `administer` and for `consent` | One boundary, in tabs of what the person may see. Waiting: how much waits, by kind, for how long and on whom. Rules: for a person with a say over the gate, its settings by kind of thing, scope and party (`PUT /gates/:gate_id/settings`). Policy: the boundary's redaction policy in full, for a reader of either side, with every version in a rail beside it, each with when and by whom it was saved (`GET /redaction-policies?boundary_id=…&all=true`; `?version=N` opens one, as `?policy=<id>` still does); an administrator who reads the label the pages are written at saves the next version (`PUT /redaction-policies`), with a refusal shown beside the form. Settings: what flows to the gate, whether its backlog is shown and, outside, whether what is released is sent (`GET /gates`, `PUT /gates/:gate_id`) |
| `/redaction-policies`, `/redaction-policies/:id` | every member | Redirects: the first to `/gates`, the second to its boundary's Policy tab (`/gates/:id?tab=policy`, with `&version=N` for a version no longer in force) |
| `/gate` | `consent` | Review: what waits on the person at a gate (`GET /gate/queue`): each waiting part as it would be released, with what is always shown of its item and what the Redactor proposes; for a holder who reads at the item's label, the Redactor's removals struck through in front of their marks and its notes, and for one who does not, the marks alone, except in a part that rests only on the material of an outside party they consent for; the boundary each item crosses and the policy it was redacted under, as the queue gives them; consent, approve, hold, delay, lift, or remove a passage under one of that policy's categories, for many items at once (`POST /gate/decisions`) |
| `/outbound` | every member; controls for `direct` and `consent` | The Outbox. Its Pages tab: docs/published-pages.md, "Inside the deployment": what a send shows outside, each package with its sends and the public graph's answers, sending, taking a package as a file, and the words a node that exists only here is proposed in. Its Reports tab: the agents' reports, with sending one on to Minerval's maintainers |
| `/file-sets`, `/file-sets/:id` | `direct` or `administer` | docs/file-sets.md: the sets at labels the reader reads, adding one by upload (`direct`) or from a directory (`administer`), uploading with each file's progress and hash, a set's files and the commands run against it, switching it off |

These pages link to one another through the sidebar, each link shown to
whoever can use the page. Their words that are not the API's own are in the
pages; the two fixed lists of reasons are the API's, served with
`GET /releases` (`list_releases`) and `GET /gate/queue`. The Outbox (`/outbound`) is for
pages and agents' reports; what else passes between the deployment and the
public graph is under the public graph's Overview (`/admin/outside`,
docs/outward-acts.md), and each page points to the other.

What the pages still cannot be given, because the API does not serve it:

- **The text of a part, to a holder of `consent` who does not read the
  label the page was written at.** The queue says so on each item.
- **Labels a person does not read.** A release, a rule or a policy can
  name a label its author does not read, and the API takes it; no read
  names such a label, so the pages offer the labels the person reads.
- **A receipt for a package carried by hand.** Taking a file is logged;
  nothing records what the public graph then answered.
- **What a redaction or its check is expected to cost.**

**Where more than one judgment is in force for one reader.** A reader who
holds two labels that do not read each other, each with a judgment of a
node, has two in force, and so has a run at a label that reads both. A read
that gives a node one judgment gives the most recently made
(`<table>_in_force`), and says how many there are: `judgments_in_force`,
with one sentence beside it (`judgments_in_force_note`), present only where
it is more than one (`judgmentsInForce` and `markSeveralInForce` in
`src/services/judgment-version-service.ts`). It is on a row of the list and
of a search, a card, a row of a tree and of a node's premises, and a read
of the node, which also lists each judgment under `versions` with its own
`coverage` and `since_assessed`. An argument's evaluation is said the same
way (`argument_evaluations_in_force` on a tree's row; `evaluations_in_force`
and `evaluations` on the argument's own read). The web app shows "N
assessments" on such a row, linking to the node.

**Where a label left a judgment standing.** A Steward at a label, on a
node at a label it reads, records its own judgment or leaves the one it
reads standing ([architecture.md](architecture.md), "A judgment at each
label"). The record that it left one standing is not a judgment. It
changes no view, puts nothing in force and is counted by none of the reads
above: every read that gives a node one judgment, every count of judgments
in force, and every export gives exactly what it would have given without
it. A reader who holds two labels that do not read each other, where one
judged the node and the other left the public judgment standing, has the
first label's judgment in force and no second one, as before. The record
is served where a node's judgments are listed, on a read of the node
(`GET /claims/:id` and `get_claim`), as `left_standing`: for each label the
reader reads that has one, when the node was examined there, by which
run, the Steward's reasoning, the judgments left standing and whether one
has since been replaced (`open_again`). `not_examined_at` lists the labels
the reader reads at which the node has neither a judgment nor such a
record. The Steward at a label is told the same in the note of its node's
versions. Lists, trees, searches and exports do not carry either field.

The other reads that give a node's status, and what each does for such a
reader. For a reader with one judgment in force each is what it was.

| Read | What it does |
| --- | --- |
| Dependents (`GET /claims/:id/dependents`, and the node's own read) | The count and the sentence on each dependent's row |
| Claim links (a node's `related`) | The same, on each counterpart |
| A question's presuppositions, subquestions, listed answers and what depends on it | The same, on each entry |
| A quantity's bases: the claims its readings bear through, and the claims that cut it | The same, on each claim |
| A source's segments (`GET /sources/:id/document`) | The same, on the claim each instance is of |
| Bounties (`GET /prizes`) | The same, on each listing |
| Monitors: performed settling and empty chairs | The same, on each candidate. The candidate is still picked by the most recently made judgment, and now says so |
| The extension's lookups | `judgments_in_force` and the sentence on an annotation's `claim`; the Assistant's call that compares the page with the graph is given the sentence too |
| A session's snapshot (what a paused run is told when it resumes) | One more sentence beside the status: "N judgments of this node are in force for this run, made at labels that do not read each other. The status given here is that of the most recently made, and none replaces another." |
| Citations (`GET /claims/:id/citation`) | Not a count alone. The evidence record carries every assessment in force, whole, under `assessments_in_force` (most recently made first; `assessment` is the first), because a record is read away from the graph and its reader cannot come back for the others. The citation names one assessment by id and version and says how many there are. A premise's status carries the count |
| The nanopublication | The assertion states the pinned assessment; the publication info names every one in force (`mv:assessmentInForce`) |
| The MIRA export | Every assessment in force is a node of its own (`mv:Assessment`, for a claim and for a question), with its label, verdict and reasoning. A neighbour whose status is one of several carries `mv:judgmentsInForce` |
| Findings | No count: one judgment is not chosen at all. A filter by the claim's status finds a finding under the status of either judgment in force, the counts beside the filter count it under each, and a cited assessment is `current` while it is its own label's current one (a judgment at another label does not make it old). `cited_assessments` carries the count |
| Read-only SQL's `assessments` view | One row for each judgment: `is_current` is true for every judgment in force for the session (migration 0159), so a join on it returns a row for each and nothing is chosen by date. The note on the result says so to a reader of more than one label besides `public` |

On the web, the rails (what depends on a node, see also, a question's
rail), the compass and the map count each node once, by the one status its
row carries. Each row that has more than one says "N assessments", and a
summary drawn over several nodes says how many of them have more than one
and that each is counted by the most recently made.

Not reached: the overturn-rate and evidence-monotonicity monitors read a
node's whole history of assessments in order of time, so on a node judged
at two labels they read a change of label as a change of mind. A quantity's
or a question's own page gives the one estimate or answer its read names
and lists the others under `versions`. An analysis of a page that the
extension stored is shared between readers, and its stored verdicts were
made against one judgment.

The account page shows no way to buy owls where `entitlement.owls_created_here`
is true, gives what an owl is there in the API's words
(`entitlement.owls_statement`), and says what the person holds. Every other
page that tells a person their balance cannot cover something (the `/ask`
notice at a balance of 0, the decomposition form, the web app's refusals of
an order, a proposal or a contribution) says "Buy owls" only where owls are
sold. Where they are created it says that an administrator, a holder of
`administer`, creates owls into a person's balance under Admin → Budget,
with a link there for a viewer who holds it and to People for one who does
not (`web/lib/owl-source.ts`).

To run one locally: set `READS=members` and an `API_KEYS` entry on the API
(there is no dev bypass), the same key and `READS=members` on the web app,
and sign in with the development login, whose identities read
`dev:<username>`.

### Owls a deployment creates for itself

On the public graph owls are bought (below, "Buying owls"). A deployment
that pays its own model providers has nobody to buy them from, so it creates
them: `OWLS=created`.

**What they are.** The organization's own unit for budgeting its agents'
work. One owl covers one dollar of metered cost, at the prices the
deployment is configured with. They are created by its administrators, not
bought, and they never convert to or from owls on the public graph. The one
sentence every surface uses is `CREATED_OWLS_STATEMENT` in
`src/services/owl.ts`.

**The setting.** `OWLS` is `sold` (the starting value: the public graph) or
`created`. It says more than payments being off. Payments off leaves a
deployment with no way to get owls at all; `created` gives it one. So
`created`:

- needs `READS=members`, because creating owls is an administrator's act
  and only a members-only deployment has administrators;
- refuses to load beside a Stripe key (`STRIPE_SECRET_KEY`): an owl an
  administrator created and an owl someone paid for would be one balance;
- does not mount `GET /billing/packs`, `POST /billing/checkout` or
  `POST /billing/webhook`, so the `list_owl_packs` tool does not exist
  there. `GET /billing/ledger`, an account's own history, stays.

**Creating.** `POST /owls/created` (`src/routes/owls.ts`,
`src/services/owl-creation-service.ts`), from a signed-in session by a
holder of `administer`, into one of:

- an account's balance (`account_id`): a person who holds `fund` then puts
  the owls behind mandates exactly as on the public graph;
- a mandate's budget (`mandate_id`): the budget grows at once. These owls
  are held in the name of the deployment's own account, the one account
  nobody signs in to, which carries the organization's name. If the mandate
  closes with money unspent, that share returns to this account, as any
  funder's share returns to them. The mandate is one at a label the
  administrator reads, and the request works at the mandate's label
  ("The label a request works at", above): one at another label answers as
  not found.

The ledger reason is `owl_created`. Each act writes a row to
`administrative_events` (`owls_created`) in the same transaction, with the
amount, the recipient and the administrator's note, and appears in
`GET /permissions/log`.

**There is no cap.** It is the organization's own budget, spent at its own
model providers, and a ceiling here would be a number nobody chose. What
stands in its place is visibility: `GET /owls/created` (`get_created_owls`
on MCP), open to every member, says how much has been created, by which
administrator, into accounts and into mandates, how much the deployment's
runs have spent, and lists the acts. The spend is one total over every run,
whatever its label, taken under system clearance
([architecture.md](architecture.md), "System work"): a member who reads one
label is still told what the whole deployment has spent. A mandate at a
label the reader does not read is named in the list by its id alone.

**No free grants.** The signup grant and the monthly owl are the public
graph's offer to a reader who has just arrived. In any members-only
deployment (`READS=members`, whatever `OWLS` says) neither is given unless
the deployment sets it: `SIGNUP_GRANT_OWLS` and `MONTHLY_GRANT_OWLS` have no
default there. Where owls are created (`OWLS=created`) neither can be set:
the deployment refuses to load with either above zero, because every owl
there enters a balance by an administrator's logged act, and a grant by
setting would create owls that no act records.

**The price of an owl.** Cost is metered as everywhere (below, "The
per-token meter"). Three things can price a call: the price catalog (below,
"Where model prices come from"); a provider that reports the cost of each
call itself (OpenRouter, and an endpoint a deployment declares with its
prices); and a price the deployment states, `MODEL_PRICES`:

```
MODEL_PRICES=[{"model":"gpt-oss-120b","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]
```

US dollars per million input and output tokens, for a model the catalog
does not know, or in place of the catalog's price for one it does (a
negotiated rate). `model` is a model ID or the start of one; the longest
match wins, and a stated price wins over the catalog. `cacheReadMultiplier`
and `cacheWriteMultiplier` are optional.

On the public graph a model with no price meters at a conservative fallback
rate. Where owls are created that rate would be a number nobody chose, so a
call to a model with no price is refused before anything is sent, with a
message that says how to state one (`ModelNotPricedError`). `GET
/owls/created` lists the models the deployment is configured to run that
have no price, so the gap can be closed before a run meets it.

**Where model prices come from.** Nobody types in what Anthropic and
OpenAI charge. Neither vendor publishes its prices where a program can read
them, so the deployment reads two public lists that carry both vendors'
list rates, cache rates and long-prompt rates: OpenRouter's model list and
LiteLLM's price file. It reads them every `MODEL_PRICE_REFRESH_HOURS` hours
(6 to start; `0` never) and keeps what it takes in one row of
`platform_flags` (`model_prices`), which every process meters from
(`src/services/model-price-service.ts`). The lists are kept by different
people, so a price already in force changes only when both state the new
one. A model with no price yet, such as a new release, is priced from
either list alone, which is nearer the truth than the fallback rate. Where
the lists disagree, or one states a price that cannot be right (zero, or
above $1,000 per million tokens), the price in force stays, and the refresh
logs what it held and why. A model the lists stop carrying keeps its last
price. A model is priced by its own entry or, for a dated snapshot
(`claude-haiku-4-5-20251001`), its family's, never by a sibling whose name
it starts with. A usage row keeps the cost worked out when its call was
made, so a price change applies to later calls only. The `Model prices`
tab of the budget page shows what each configured model is metered at,
from where, and when the lists were last read.

Before a deployment has read the lists, and where it cannot reach them, it
meters at the snapshot the release carries (`src/llm/price-snapshot.ts`).
`npm run prices:snapshot` writes the snapshot from the same lists by the
same rules, and nobody edits it by hand.

### Asking a label you do not read

A label's administrators may give it a face at a label it reads: a name and
a line saying what can be asked of it (`PUT /labels/:label/face`, with `at`,
`name` and `can_be_asked`; `GET /labels/faces` lists them, `DELETE
/labels/:label/face/:at` withdraws one). `GET /asks/askable` lists the
faces of labels you do not read, with the label of yours each is shown at.
A person who may fund asks with `POST /asks`: the face, whether it is one
piece of work or a mandate, the ask in their own words, and a budget in
owls. The ask is recorded as a request at the label the face is shown at,
which is the asker's record and is read there like any request; the work is
done at the label asked. Whether it was taken up, what it found and what it
cost reach the asker only through that label's gate. What is not spent
returns to the asker's balance.

A label that holds only work asked for this way needs no General mandate:
each piece of its work was paid for by whoever asked.

### The standing mandates, set up in the app

Every deployment needs a General mandate, which pays for upkeep and, since
the Governance mandate was folded into it, for audits: no agent work runs
except by allocation (docs/allocation.md, "Platform mandates"). On the
public graph a seed script creates it with the database's credentials. In a
members-only deployment an administrator does, from a signed-in session:

| route | who | |
|---|---|---|
| `GET /standing-mandates` | a member | the General mandate, and whether it has been set up |
| `POST /standing-mandates/:name` (`general`) | `administer`, from a signed-in session | set it up, with `budget_owls` and `daily_owls`, which sets its pace: at most that many owls committed in any rolling day, or `0` for as needed |

The mandate is the one the seed creates (the same starting operating policy
and lookouts, from one definition in `src/services/standing-mandates.ts`),
worded as the deployment's own and never Minerval's. Where the deployment
creates its own owls, `budget_owls` is created with the mandate and logged.
Where owls are sold, a budget cannot be created: the mandate is set up with
none and funded from a balance like any mandate. More budget is added like
any mandate's: created into it, or contributed.

**One at each label.** A mandate's work runs at its label
([architecture.md](architecture.md), "Labels and clearance"): its
Grantmaker reads what that label reads, and what it pays for is work at
that label. So where a deployment holds material at more than one label,
the request that sets a standing mandate up names the label it is for
(`label`, among the labels the administrator reads), and each label whose
upkeep and audits are to be paid for has its own General mandate. Setting one up at a label says nothing about another label, and
is refused only where that label already has one. `GET /standing-mandates`
then carries `by_label`: for each label the caller reads, the mandate set
up there or none. A label with no General mandate has nobody paying for
its upkeep, which the list shows as that. The lookup is by label
(`getGeneralMandate` in `src/services/allocation-policy-service.ts`):
upkeep wanted at a label is raised to the General mandate at that label,
whose officers work what is raised at it, and a sweep at a label is paid
by that label's General mandate. It is never put in front of the General
mandate of a label it reads.

### What a deployment reports

A members-only deployment on the metered price reports the owls its runs
spent each day privately to Minerval, for billing: one total, and never
which claims the work was for. It is recorded against the organization's
account and not published. docs/usage-report.md.

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
| submit a source (`POST /sources`) | **up to 10 owls** | `CAP_SOURCE_INGEST_OWLS` |
| extension page analysis | up to 1 owl | `CAP_EXTENSION_ANALYSIS_OWLS` |
| MCP text tools (match/extract/assess) | up to 0.1 owl | `CAP_TEXT_ANALYSIS_OWLS` |

A source's cap is a ceiling, not a price: the submitter pays what the
extraction and its Matcher runs actually cost (about half an owl to a few
owls for an article or a paper), up to the cap. It is held from the balance
when the source is submitted, so submitting one needs a balance of the cap.
A mandate's ingest rows are not priced at the cap: they carry the ledger's
own figure for an ingest (the p80 of recent ones, else
`est_ingest_cost_owls`).

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
  as soon as its funded action dispatches (#284), and that pass is the
  node's first (see "Proposing a node").
- The run is attributed to the ordering user (usage context userId +
  jobId=order id), so per-order cost is queryable from `llm_usage`.
- `GET /orders` (optionally `?claim_id=` for the claim page's poll),
  `GET /orders/:id`.

## Proposing a node

A node proposed for a person is assessed as soon as review accepts it.
Proposing and assessing used to read as two acts: the proposal was
accepted, its page said "Not yet assessed" beside a button to buy an
assessment, and the first pass came later or, from some doors, not at all.
Now, by default, wherever the proposal comes from:

- **`POST /claims/propose`** (the claims index's form, the browser
  extension, MCP's `propose_claim`, the Assistant's) charges the
  `claim_proposal` cap when it is made. On acceptance the node gets an
  express-lane order paid by that charge, and the order's pass is the
  node's first: a novel node is not also handed to the claim pipeline,
  whose background pass the order would otherwise wait on or repeat
  (`src/services/intake-service.ts`). A first pass that fails onboards the
  node through the pipeline, as any node is (`src/workers/order-pipeline.ts`).
  An order whose node is mid-pass waits without holding up the orders
  behind it.
- **`assess: false`** proposes without assessing: nothing is charged, the
  proposal counts against the hourly limit on free contributions, and the
  node waits for the graph's own allocation or an order. The form has it
  as a box, ticked by default (`contributions.assess_on_accept`).
- **A mandate's proposal** is assessed from the mandate's escrow: a plan's
  propose item that no assess, reassess or deepen item names gets a
  standard `assess` item for its ref when the plan is stored
  (`withProposalsAssessed`, `src/services/grant-service.ts`). A propose item
  with `assess: false` is filed without one. The funder's own balance is
  never charged for it.

## Contributing to a node

A contribution that asks for a fresh pass on its node (challenge, support,
propose_edit, add_instance, propose_argument, add_estimate, propose_answer)
can pay for that pass when it is made, as a proposal pays for its first
assessment. If it is accepted, the node is reassessed at once on the express
lane; if it is rejected, the charge is refunded, so a good-faith contribution
that does not pass costs nothing (#71). `POST /contributions` and MCP's
`submit_contribution` take `assess`
(`src/server/contribution-pass-charge.ts`):

- **left out** (the default): charged the `assessment` cap when the
  balance covers it, and free otherwise. A person who has never bought owls
  contributes exactly as before.
- **`true`**: charged, or refused with 402 `INSUFFICIENT_OWLS` before
  anything is written.
- **`false`**: nothing is charged.

A paid contribution does not count against the hourly limit on free
contributions; its charge bounds it. A free one does, as before, and on
acceptance the pass it asks for is raised to the General mandate's officers
([allocation.md](allocation.md), "Node inboxes and messages"). The answer
carries `assess_on_accept` and a `message` saying which happened. The
claim page's form has it as a box, ticked by default. Merges, splits and
requests are never charged: the first two are the Curator's, and requests
have their own money.

A node's page says when a pass on it is under way, to every reader:
`GET /claims/:id` carries `assessment_under_way` (`running`, or `queued`
while an order for it waits, anyone's), and the page shows "Being
assessed" in place of the button until the verdict lands.

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
(`/grant-conversations`, UI at `/ask/mandates/new`): the best available
model, running with the full constitution, surveys the scope, quotes
expected costs in owls, pushes back where judgment differs, and drafts a
mandate. Funding the draft (`POST /grant-conversations/:id/fund`) escrows
the budget and starts the grant with the mandate as its plan; nothing runs
or is charged before that. The draft carries the mandate's pace, agreed
with the funder: as needed (the escrow is the only bound, the default) or
steady (at most so many owls allocated to runs in any rolling window), which only
the funder changes afterwards (docs/allocation.md, "Pace and reserve").
The conversation is public from its first message, funded or not
(`GET /grant-conversations/public/:id`), with the funder shown as "a
reader" unless they choose to be named, and the page says so before the
first message is sent: talking to a Grantmaker directs the public graph
(docs/allocation.md, "Directing the public graph is public"). A
conversation held before that rule stays private to its funder.

The Grantmaker replies in the background. Sending a message saves it and
returns at once with the message's place (`message.index`,
`message_count`), the draft's hash (`mandate_sha256`) and
`turn.state: "replying"`, not the transcript (#905); the reply lands in the
conversation when the turn finishes (a drafting turn can take minutes,
streamed so it has the model's full output for the plan). Callers read
`GET /grant-conversations/:id?after=<message_count>&mandate_sha256=<hash>&wait=50`
until the turn is `idle`, or `failed` with `turn.error` (the message stays
saved; a short follow-up asks again). `after` returns only the messages
after those the caller holds; `mandate_sha256` leaves the draft out
(`mandate_unchanged: true`) while it still hashes the same; `wait` holds
the read up to 120 seconds for the turn to end (a drafting turn takes a
minute or two; 50 fits the 60 seconds most MCP clients give a tool call),
well under the load balancer's idle timeout of 300. While the turn runs,
`turn.progress` says which step the Grantmaker is on (how many tools it
has called, and the latest few with what each was about) and
`turn.partial` holds the reply as it writes it. With no parameters the
read is the whole conversation. Every read carries `page_url` (the
conversation's page, or once funded the manager's page for the mandate,
with `mandate_page_url` and `funder_url`). A draft carries `warnings`:
what the funder must read before paying, recorded by the Grantmaker or
implied by the draft (a stake line on a mandate whose funder chose not to
be named is public, and may identify them). Funding a draft with warnings
is refused with `WARNINGS_UNACKNOWLEDGED` and the warnings until the call
carries `acknowledge_warnings` (true, or the ids accepted); the site's
fund card asks the funder to tick that they have read them, and the
Assistant's call that acknowledges them always waits for the user's press. Funding returns the new `grant_id`, and the conversation list
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
`GET /grants/:id` (spend, plan, the assessments the grant bought; a
summary by default, its plan a page at a time, `detail=full` for all of
it). `GET /grants` lists one short row per grant, with `page_url` and
`funder_url`.

**Free tier:** a one-time signup grant of 10 owls (`SIGNUP_GRANT_OWLS`) — "see
a claim you care about, get it assessed": it covers a few capped
assessments, or one source submitted at its 10-owl cap, and the unused
part of each cap settles back — plus a 1 owl/month trickle
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
`cancel`, and in a private deployment `send_outside`, which covers every
act on the public graph in the organization's name: docs/outward-acts.md)
to run without a card, for one conversation or for the account
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
model (`ASSISTANT_TITLE_MODEL`, Claude Haiku 5.5 by default, so a
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

**Privacy.** A conversation is private to its user, and is where they
weigh what they would not publish before anything reaches the graph. Its
runs are logged, private (`AGENT_INPUTS.assistant`), and read whole by
their user and no one else (docs/run-log.md, "Who reads a log"). Deleting a
conversation deletes its text, its held actions and, unless run logs are
kept as a record (`RUN_LOG_MODE=record`), the transcripts of every one of
its runs, those that sent something to the graph included: what they sent
is public on its own. What it cost stays in the owl ledger. A granting
conversation the Assistant holds for its user is not private: talking to a
Grantmaker directs the public graph, so it is public from its first
message, the Assistant's messages in it marked as the Assistant's
(docs/allocation.md, "Directing the public graph is public").

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
The marks themselves are the Assistant's (#1132): when the extension
analyzes a page, one structured call under the Assistant's prompt gives each
matched claim its verdict (`src/llm/agents/page-markup.ts`). That call is
not a turn of any conversation: it has no tools, runs on its own model
(`ASSISTANT_MARKUP_MODEL`), is paid from the page analysis's charge and not
a conversation's bill, and is saved nowhere. The verdict scale it works to
is in the chat's prompt section as well, and `get_page_claims` returns what
the graph holds on the marked nodes in the shape the verdicts are judged
from, so the Assistant in the chat can say why a passage was marked and
whether it would still mark it so. It cannot change a mark.
The extension reads the conversation until the turn is idle, shows what the
reply cost, and can stop it. It holds only an API key, so it cannot release
a held action: the reply says one is waiting and links to the conversation
on minerval.ai, which is the same conversation. Versions of
the extension before 0.4.0 called `POST /extension/chat`, which had its own
flat price and prompt and is gone: their chat tab fails until they update.

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

## Guests

A visitor with no account may use the Assistant at `/ask` on owls Minerval
gives them (`src/services/guest-service.ts`, `web/lib/guest.ts`). The page
says what a guest gets, and the bounds below, before the first message,
and asks them, beside the composer and once their owls are spent, to make
an account: it is free, comes with the signup grant, and keeps their
conversations.

- **The account.** The first message a visitor sends makes a guest
  account (`POST /users/guest`, service-only: the web tier calls it with
  the visitor's address). Its external id is `guest:<uuid>`, which no
  sign-in makes, and the web tier keeps it in an httpOnly cookie signed with
  the sign-in secret. A guest is given `GUEST_ASK_OWLS` (5) as a
  `guest_grant` ledger row, and no signup grant or monthly owl.
- **What a guest can do.** Talk to the Assistant, on the standard model
  alone (`ASSISTANT_STANDARD_MODEL`, Opus): a guest's few owls go further on
  it. The Assistant's tools are every read and three acts, `propose_claim`,
  `submit_contribution` and `order_assessment`, each held for the guest's
  press (`GUEST_TOOLS`, `src/llm/tools/assistant-tools.ts`); a guest cannot
  allow a kind to run without asking. Nothing else that writes is offered,
  and the Assistant is told so and why (`guestSection`,
  `src/llm/prompts/assistant.ts`). A guest's session reaches only the
  Assistant's conversation routes and `GET /users/me`
  (`src/server/plugins/auth.ts`, `GUEST_NOT_ALLOWED`).
- **The bounds.** A guest's balance bounds their own use, as anyone's does.
  The whole day's giving is a sum of owls, `GUEST_ASK_DAILY_OWLS` (100) over
  a rolling 24 hours, because the platform's money is what is at stake.
  `GUEST_ASK_PER_ADDRESS_PER_DAY` (1) is a count of guest accounts one
  address makes in a UTC day, for the reason the anonymous rate limit is a
  count: a visitor has no account or budget of their own, and an address is
  all that tells one from the next. The address is Cloudflare's
  `cf-connecting-ip`. It is never stored: a pass keeps a hash of the
  address and the day, and the hash is cleared after two days. Each refusal
  (`GUEST_ADDRESS_LIMIT`, `GUEST_DAILY_LIMIT`, 429) names the bound it met
  and the way past it, an account. `0` in any setting turns guests off,
  and a members-only deployment has none.
- **Signing in.** When a guest signs in, the web tier names the guest as it
  provisions the account (`guest_external_id` on `POST /users/provision`),
  and their conversations, held actions and pages move to it, once
  (`guest_passes.carried_to_id`). Unspent guest owls do not move; the
  account gets the signup grant.

## The owl ledger

`owl_ledger` is the one spendable balance: every earn and spend is an
explicit signed row in face-value micro-USD, and

```
balance = SUM(owl_ledger.amount_micro_usd)
```

Reasons: `purchase`, `signup_grant`, `monthly_grant`, `contribution_award`,
`charge`, `meter_settlement` (the unused fraction of a charged cap,
returned after the meter ran), `refund`, `escrow_hold`/`escrow_refund`
(budgeted jobs), `admin_adjust`, `prize_award` (a prize paid in owls,
below), and `owl_created` (owls an administrator created, in a deployment
that creates its own; above). Charges carry the operation (`op`) and
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

Not in a deployment that creates its own owls (`OWLS=created`, above):
there these routes are not mounted.

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
  which is the point of keeping it that way. One thing is kept for a short
  while: a text analysis's result (`extract_claims`, `assess_text`) quotes
  the passages it found claims in, and is deleted a day after it finishes
  (`TEXT_ANALYSIS_KEEP_HOURS`, `expireTextAnalyses`, run by the
  trace-retention sweep in every mode). This is true of a deployment
  whose run log is best-effort, as the public graph's is. One that keeps
  its log as a record (`RUN_LOG_MODE=record`) logs that work, privately,
  and keeps the log (docs/run-log.md).
- **Rows keyed to the account** (`contributors.id`), deletable outright:
  `api_keys`, `oauth_tokens`, `oauth_authorization_requests`,
  `grant_conversations` (one begun since grantmaking was made public is
  public, and like a contribution is detached from the account rather than
  deleted), `assessment_orders`, `budget_jobs`, `grants`
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
